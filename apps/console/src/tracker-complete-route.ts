// Close in Linear — `POST /api/trackers/:connection/issues/:key/complete`
// (design-build-plan §2.1, §2.3, §2.6; T4-26) — and the other way round,
// *Done in Linear* on a Today row.
//
// **Metistry → Linear.** Ticking a `linear:` task offers *Close <KEY> in
// Linear*. The setting is the connection's tool mode for `complete_issue`
// (Ask First · Allow · Never; unset is Ask First): Ask First, the client
// offers it and the owner's press is this call; Allow — *always* — the
// client makes this call itself right after the tick, the second call; Never,
// this door refuses `403` and nothing is sent. The Tick door writes the note
// and nothing else; this door changes Linear and nothing in the vault. The
// service is `collectors/linear/complete.ts`; this module is the door: the
// path's two names, an empty body, the answer, the audit row.
//
// **Linear → Metistry.** An issue closed in Linear closes its `work` row
// (the sync, every 15 minutes). `GET /api/today` then names each OPEN task
// line of the day whose `linear:` ref is such an issue — `tracker_closed`
// in its answer, through the named query of the same name — and the client
// shows *Done in Linear* with a one-click Tick. **The sync never writes the
// owner's note**: the line stays open until the owner ticks it.
//
// Reached only by the `user` principal: server.ts's management gate runs
// first, so an agent bearer and the capture owner token get the uniform 403.

import type { IncomingMessage, ServerResponse } from "node:http";
import { SECRET_USE_META_KEY, errorEnvelope, statusFor, type ErrorCode } from "@foldedspacelabs/metistry-core";
import type { QueryStore } from "@foldedspacelabs/metistry-queries";
import { LinearCompleteRefused, completeLinearIssue, type LinearCompleteRefusalCode, type TrackerOpener } from "@metistry-apps/collectors";
import type { Db } from "./auth-store.js";
import { readBody, sendJson } from "./http-util.js";
import { validConnectionName } from "./connections-route.js";

/** `POST /api/trackers/:connection/issues/:key/complete` */
export const TRACKER_COMPLETE_ROUTE = /^POST \/api\/trackers\/([^/]+)\/issues\/([^/]+)\/complete$/;

/** The named query Today asks which of its lines' tracker refs are closed at the source (seed/queries/tracker_closed.yaml). */
export const TRACKER_CLOSED_QUERY = "tracker_closed";

/** The schemes Today asks about — the trackers whose closing this door and its sync understand. Linear first. */
const TRACKER_REF_RE = /^linear:[A-Z][A-Z0-9]{0,9}-[1-9][0-9]{0,8}$/;

export const TRACKERS_NOT_AVAILABLE =
  "tracker connections are not readable from this deployment — the console needs METISTRY_INSTANCE_DIR pointing at the instance repo whose `.metistry/connections/` holds the Linear connection (docs/ops/connections.md, Linear)";

type Audit = (kind: string, tool: string, ok: boolean, meta: Record<string, unknown>) => Promise<void>;

export interface TrackerCompleteDeps {
  db: Db;
  audit: Audit;
  /** Opens a tracker connection by name (`linearTrackerOpener`). Absent → `503`: no instance directory here. */
  open?: TrackerOpener | undefined;
}

export function isTrackerCompleteRoute(key: string): boolean {
  return TRACKER_COMPLETE_ROUTE.test(key);
}

/** Each refusal's HTTP answer. A code path each (U3); the service's message says why. */
const STATUS_OF: Readonly<Record<LinearCompleteRefusalCode, ErrorCode>> = {
  bad_key: "invalid_request",
  no_connection: "not_found",
  not_tracker: "not_found",
  no_capability: "forbidden",
  tool_off: "forbidden",
  connection_failed: "not_available",
  not_found: "not_found",
  linear: "not_available",
};

const refuse = (res: ServerResponse, code: ErrorCode, message: string, extra: Record<string, unknown> = {}) => sendJson(res, statusFor(code), { ...errorEnvelope(code, message), ...extra });

function segment(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

export async function trackerCompleteRoute(req: IncomingMessage, res: ServerResponse, key: string, deps: TrackerCompleteDeps): Promise<void> {
  const m = TRACKER_COMPLETE_ROUTE.exec(key);
  const connection = m ? segment(m[1]!) : null;
  const issueKey = m ? segment(m[2]!) : null;
  if (connection === null || !validConnectionName(connection)) return refuse(res, "invalid_request", "a connection is named by its name — lowercase kebab-case, as `metistry connections list` shows it");
  if (issueKey === null) return refuse(res, "invalid_request", "a Linear issue is named by its key (TEAM-123)");

  // the body is `{}` or nothing: the path names everything, and a field is a
  // client that thinks it can say more than which issue
  const raw = (await readBody(req)).toString("utf8").trim();
  if (raw !== "") {
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return refuse(res, "invalid_request", "request body is not JSON");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return refuse(res, "invalid_request", "the body is {} — the path names the connection and the issue");
    const fields = Object.keys(body);
    if (fields.length > 0) return refuse(res, "invalid_request", `unknown field${fields.length > 1 ? "s" : ""} ${fields.join(", ")} — the body is {}; the path names the connection and the issue`);
  }
  if (!deps.open) return refuse(res, "not_available", TRACKERS_NOT_AVAILABLE);

  try {
    const r = await completeLinearIssue(deps.db, deps.open, { connection, key: issueKey });
    await deps.audit("tracker", "complete_issue", true, {
      connection: r.connection,
      key: r.key,
      outcome: r.changed ? "closed" : "already_closed",
      ...(r.secrets.length > 0 ? { [SECRET_USE_META_KEY]: r.secrets } : {}),
    });
    return sendJson(res, 200, { ok: true, connection: r.connection, key: r.key, ref: r.ref, url: r.url, state: r.state, changed: r.changed });
  } catch (err) {
    if (err instanceof LinearCompleteRefused) {
      await deps.audit("tracker", "complete_issue", false, { connection, key: issueKey.slice(0, 40), refused: err.code, ...(err.linear ? { linear: err.linear } : {}) });
      const code = err.linear === "rate_limited" ? "rate_limited" : STATUS_OF[err.code];
      return refuse(res, code, err.message, { reason: err.code });
    }
    throw err;
  }
}

/** One of the day's task rows, as `vault_tasks_query` serves it — the fields this module reads. */
interface TaskRow {
  task_key?: unknown;
  checked?: unknown;
  dropped?: unknown;
  ext_refs?: unknown;
}

/** One entry of `GET /api/today`'s `tracker_closed`: an open line whose tracker issue the source closed. */
export interface TrackerClosed {
  task_key: string;
  ref: string;
  connection: string | null;
  key: string | null;
  /** `done` (completed in the tracker) or `canceled` */
  state: "done" | "canceled";
  url: string | null;
}

/**
 * The day's open task lines whose `linear:` ref names an issue closed at the
 * source — what Today marks *Done in Linear*. A read: one named query over
 * `work`, and nothing written anywhere.
 */
export async function trackerClosedForDay(tasks: readonly TaskRow[], queries: QueryStore): Promise<TrackerClosed[]> {
  const open = tasks.filter((t) => t.checked !== true && t.dropped !== true && Array.isArray(t.ext_refs));
  const refs = [...new Set(open.flatMap((t) => (t.ext_refs as unknown[]).filter((r): r is string => typeof r === "string" && TRACKER_REF_RE.test(r))))].sort();
  if (refs.length === 0) return [];
  const { rows } = await queries.run(TRACKER_CLOSED_QUERY, { refs: refs.join(",") });
  const closed = new Map(rows.map((r) => [String(r.ref), r]));
  const out: TrackerClosed[] = [];
  for (const t of open) {
    for (const ref of t.ext_refs as unknown[]) {
      const w = typeof ref === "string" ? closed.get(ref) : undefined;
      if (!w) continue;
      out.push({
        task_key: String(t.task_key),
        ref: ref as string,
        connection: typeof w.connection === "string" ? w.connection : null,
        key: typeof w.key === "string" ? w.key : null,
        state: w.closed_reason === "completed" ? "done" : "canceled",
        url: typeof w.url === "string" ? w.url : null,
      });
    }
  }
  return out;
}
