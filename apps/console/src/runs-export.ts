// `GET /api/runs/export` — the `runs` ledger as NDJSON (S5,
// docs/research/2026-09-13-google-sam-review.md ADOPT 5), so two instances'
// timelines merge for the owner. SAM is the reason the gap was visible: it
// has metrics and no audit log at all, and `runs` is the thing Metistry has
// that a mesh does not.
//
// **Invariant 3, decided.** `runs` is special-cased for the watchdog's
// liveness probes and for nothing else, so an export is NOT a second
// licence to open a pg connection somewhere new. Two candidate shapes:
//
//   * a named query — invariant-3-clean, but `packages/queries` buffers a
//     whole result set into `{rows, as_of}` and has no streaming driver, so
//     one query for a year of runs is one enormous array in memory; and
//   * a bespoke route holding a server-side cursor — streams, but puts SQL
//     over `runs` in the console beside the query store, which is the
//     drift invariant 3 exists to prevent.
//
// Taken: the named query `runs_export.yaml` with a cursor param, PAGED, and
// the streaming done here by looping over it. The driver stays the only
// thing that talks to Postgres (the SQL lives in the instance's `queries/`
// where the owner can read and override it, D4), memory is bounded by one
// page, and the client gets bytes as they are produced. The cost is one
// round trip per page instead of one held cursor — for an export that runs
// on the owner's own machine, that is not a cost worth a second read path.
//
// The CLI never talks to Postgres for this (`metistry runs export` is a
// call to this route): the console is the read path, as it is for
// everything else the CLI asks about state.

import type { ServerResponse } from "node:http";
import { qualifyIfPossible, redactSecrets } from "@foldedspacelabs/metistry-core";
import type { QueryStore } from "@foldedspacelabs/metistry-queries";

export const RUNS_EXPORT_QUERY = "runs_export";
/** Rows per round trip. Bounded memory, and small enough that the first bytes reach the client promptly. */
export const EXPORT_PAGE = 500;
export const NDJSON_CONTENT_TYPE = "application/x-ndjson";

/**
 * The same cursor grammar `GET /api/messages` and `/api/proposals` use
 * (docs/ops/console-api.md): Postgres's own text form of a timestamptz —
 * it round-trips microseconds where a JS Date does not — then the row's
 * tiebreaker. A bare timestamp is accepted too, because a person typing
 * `--since 2026-09-01` means the obvious thing; it becomes `<ts>|0`.
 */
const CURSOR_TS = String.raw`\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:[+-]\d{2}(?::?\d{2})?|Z)?`;
const SINCE_RE = new RegExp(`^(${CURSOR_TS})(?:\\|(\\d{1,12}))?$`);
const UNTIL_RE = new RegExp(`^${CURSOR_TS}$`);
const COMPONENT_RE = /^[a-z][a-z0-9_-]{0,63}$/;

export interface ExportParams {
  since_ts: string;
  since_id: number;
  until: string;
  component: string;
}

/** Parse the query string, or say which parameter was wrong. Never a silent full export. */
export function parseExportParams(search: URLSearchParams): { ok: true; params: ExportParams; limit: number | null } | { ok: false; field: string } {
  const since = (search.get("since") ?? "").trim();
  const until = (search.get("until") ?? "").trim();
  const component = (search.get("component") ?? "").trim();
  const rawLimit = (search.get("limit") ?? "").trim();

  let since_ts = "";
  let since_id = 0;
  if (since !== "") {
    const m = SINCE_RE.exec(since);
    if (!m) return { ok: false, field: "since" };
    since_ts = m[1]!;
    since_id = m[2] === undefined ? 0 : Number(m[2]);
  }
  if (until !== "" && !UNTIL_RE.test(until)) return { ok: false, field: "until" };
  if (component !== "" && !COMPONENT_RE.test(component)) return { ok: false, field: "component" };
  let limit: number | null = null;
  if (rawLimit !== "") {
    const n = Number(rawLimit);
    if (!Number.isInteger(n) || n <= 0) return { ok: false, field: "limit" };
    limit = n;
  }
  return { ok: true, params: { since_ts, since_id, until, component }, limit };
}

/**
 * One NDJSON line. `instance_id` and the qualified `source_agent` (S3) are
 * what make a row mean something in a second instance's copy of the
 * ledger: the bare `<name>` in `meta` is only unambiguous at home.
 * Redaction is core's, applied to the whole row — `meta` is agent- and
 * collector-authored, so a secret-named key can be anywhere in it.
 */
export function exportLine(row: Record<string, unknown>, instanceId: string | undefined): Record<string, unknown> {
  const { cursor, meta, ...rest } = row;
  const agent = agentIdIn(meta);
  return redactSecrets({
    ...(instanceId ? { instance_id: instanceId } : {}),
    ...rest,
    meta: meta ?? {},
    ...(agent ? { source_agent: qualifyIfPossible(agent, instanceId) } : {}),
    cursor,
  });
}

/**
 * The agent a run belongs to, where the row names one. `runs` has no
 * `source_agent` column — the agent rides in `meta`, stamped from the
 * credential at the door (§4.19) — so this reads the three keys that carry
 * it and nothing else. `user`/`owner` are principals, not agents: a
 * qualified `agent:user@…` would be a lie.
 */
function agentIdIn(meta: unknown): string | undefined {
  const m = (meta ?? {}) as Record<string, unknown>;
  for (const key of ["agent", "source_agent", "principal"]) {
    const v = m[key];
    if (typeof v === "string" && v !== "user" && v !== "owner" && /^[a-z][a-z0-9-]{0,39}$/.test(v)) return v;
  }
  return undefined;
}

export interface ExportResult {
  lines: number;
  /** The last cursor written — what `--since` takes to resume. Null when nothing matched. */
  cursor: string | null;
}

/** Wait for the socket when the kernel buffer is full: an export is bigger than memory is willing to be. */
function drain(res: ServerResponse): Promise<void> {
  return new Promise((resolve) => res.once("drain", () => resolve()));
}

/**
 * Page through the named query, writing one JSON object per line. The
 * caller has already sent the headers; on failure mid-stream there is no
 * status left to change, so the connection is destroyed — an aborted
 * chunked body is how HTTP says "this is not the whole thing", and the CLI
 * reports a read error rather than writing a truncated export that looks
 * complete.
 */
export async function streamRunsExport(
  queries: QueryStore,
  res: ServerResponse,
  opts: { params: ExportParams; limit: number | null; instanceId?: string | undefined; pageSize?: number | undefined },
): Promise<ExportResult> {
  const pageSize = opts.pageSize ?? EXPORT_PAGE;
  let { since_ts, since_id } = opts.params;
  let lines = 0;
  let cursor: string | null = null;

  for (;;) {
    const remaining = opts.limit === null ? pageSize : Math.min(pageSize, opts.limit - lines);
    if (remaining <= 0) break;
    const { rows } = await queries.run(RUNS_EXPORT_QUERY, {
      since_ts,
      since_id,
      until: opts.params.until,
      component: opts.params.component,
      limit: remaining,
    });
    if (rows.length === 0) break;
    let chunk = "";
    for (const row of rows) {
      chunk += `${JSON.stringify(exportLine(row, opts.instanceId))}\n`;
      lines++;
      cursor = String(row.cursor ?? cursor);
    }
    if (!res.write(chunk)) await drain(res);
    const last = rows[rows.length - 1]!;
    const parts = String(last.cursor ?? "").split("|");
    since_ts = parts[0] ?? since_ts;
    since_id = Number(parts[1] ?? 0);
    if (rows.length < remaining) break; // a short page is the end of the ledger
  }
  return { lines, cursor };
}
