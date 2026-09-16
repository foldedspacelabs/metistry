// `metistry runs export` — the `runs` audit ledger as NDJSON (S5,
// docs/research/2026-09-13-google-sam-review.md ADOPT 5), so two instances'
// timelines merge for the owner.
//
// It goes through the console (`GET /api/runs/export`, the `user`
// principal), never straight to Postgres: invariant 3 says there is one
// read path into state, and the CLI is not it. The console in turn runs the
// named query `runs_export.yaml` page by page and streams the result — the
// reasoning is in apps/console/src/runs-export.ts.
//
// Streaming end to end: this verb writes each line as it arrives rather
// than collecting a year of runs in memory first, and a stream that stops
// mid-line is an ERROR here, not a short export — an aborted chunked body
// is the console saying "this is not the whole thing", and an audit export
// that is quietly incomplete is worse than one that failed.

import { consoleTarget, type ConsoleTarget } from "./console-client.js";
import { realExec, type Exec } from "./exec.js";

export interface RunsExportOptions {
  /** `--since`: a cursor from a previous export's last line, or a bare timestamp. Absent = the whole ledger. */
  since?: string | undefined;
  /** `--until`: a timestamp; rows at or before it. */
  until?: string | undefined;
  /** `--component`: one component's rows (console, reconciler, a collector's name…). */
  component?: string | undefined;
  /** stop after this many lines; absent = everything that matches. */
  limit?: number | undefined;
  instanceDir?: string | undefined;
  instanceId?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  platform?: NodeJS.Platform | undefined;
  exec?: Exec | undefined;
  fetchFn?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
  /** where the NDJSON goes — stdout in the real verb, a buffer in tests. */
  write: (chunk: string) => void;
}

export interface RunsExportResult {
  url: string;
  lines: number;
  /** the last line's cursor — what `--since` takes to resume. Null when nothing matched. */
  cursor: string | null;
}

/** An export is legitimately long; the ceiling is here so a hung console does not hang the shell forever. */
export const EXPORT_TIMEOUT_MS = 300_000;  // limit: fixed — a wall-clock guard on a streaming export; the `since` cursor is how a longer export continues, not a longer timeout

function redact(text: unknown, token: string): string {
  const s = text instanceof Error ? (text.message ?? String(text)) : String(text);
  return token ? s.split(token).join("[redacted]") : s;
}

function queryString(opts: RunsExportOptions): string {
  const q = new URLSearchParams();
  if (opts.since) q.set("since", opts.since);
  if (opts.until) q.set("until", opts.until);
  if (opts.component) q.set("component", opts.component);
  if (opts.limit !== undefined) q.set("limit", String(opts.limit));
  const s = q.toString();
  return s === "" ? "" : `?${s}`;
}

export async function runsExport(opts: RunsExportOptions): Promise<RunsExportResult> {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const exec = opts.exec ?? realExec;
  const target: ConsoleTarget = await consoleTarget({ env, platform, exec, ...(opts.instanceId ? { instanceId: opts.instanceId } : {}) });
  const fetchFn = opts.fetchFn ?? fetch;
  const url = `${target.url}/api/runs/export${queryString(opts)}`;

  let res: Response;
  try {
    res = await fetchFn(url, {
      headers: { authorization: `Bearer ${target.token}` },
      signal: AbortSignal.timeout(opts.timeoutMs ?? EXPORT_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`console unreachable at ${target.url}: ${redact((err as { cause?: { message?: string } })?.cause?.message ?? err, target.token)}`);
  }
  if (res.status === 401) {
    throw new Error(
      `${target.url} refused the owner token (401) — \`metistry console whoami\` is the check for that door (docs/ops/auth.md); the export is the "user" principal's, which a capture token is not.`,
    );
  }
  if (res.status === 403) throw new Error(`${target.url} answered 403: the credential in use is capture-only (CRIT-7), not the local owner token`);
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      if (body?.error) detail = `${body.error.code ?? res.status}: ${body.error.message ?? ""}`.trim();
    } catch {
      /* no envelope */
    }
    throw new Error(`GET /api/runs/export answered ${detail}`);
  }
  if (!res.body) throw new Error(`${url} answered without a body`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let lines = 0;
  let lastLine = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const parts = pending.split("\n");
      pending = parts.pop() ?? "";
      if (parts.length === 0) continue;
      for (const line of parts) {
        if (line === "") continue;
        lines++;
        lastLine = line;
      }
      opts.write(`${parts.filter((l) => l !== "").join("\n")}\n`);
    }
  } catch (err) {
    throw new Error(
      `the export stopped after ${lines} line(s): ${redact(err, target.token)} — the console aborted the stream, so this is NOT a complete export. ${lastCursor(lastLine) ? `Resume with --since ${lastCursor(lastLine)}` : "Rerun it"}.`,
    );
  }
  if (pending.trim() !== "") {
    throw new Error(`the export ended mid-line after ${lines} complete line(s) — NOT a complete export. ${lastCursor(lastLine) ? `Resume with --since ${lastCursor(lastLine)}` : "Rerun it"}.`);
  }
  return { url: target.url, lines, cursor: lastCursor(lastLine) };
}

/** The `cursor` on a line, if it parses. Only the LAST line is ever parsed — the rest are bytes this verb passes through. */
function lastCursor(line: string): string | null {
  if (line === "") return null;
  try {
    const v = (JSON.parse(line) as { cursor?: unknown }).cursor;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

/** The one-line summary, on stderr so stdout stays pure NDJSON a pipe can eat. */
export function renderRunsExport(r: RunsExportResult): string {
  return r.lines === 0
    ? `no runs matched (${r.url})`
    : `${r.lines} run(s) exported from ${r.url}; resume with --since ${r.cursor}`;
}
