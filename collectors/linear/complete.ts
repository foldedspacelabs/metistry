// Close in Linear — completion from Metistry's side (plan §2.1, §2.3, §2.6;
// T4-26). The service behind `POST /api/trackers/:connection/issues/:key/complete`.
//
// Ticking a `linear:` task offers *Close <KEY> in Linear*. Whether it is
// offered, done on every tick, or refused is the owner's setting — the
// connection's tool mode for `complete_issue` (the owner's words Ask First ·
// Allow · Never; the file's `ask · on · off`; unset is Ask, DEFAULT_TOOL_MODE):
//
//   * **ask**  — the client offers it after the tick; the owner's press is
//                this call;
//   * **on**   — *always*: the client makes this call itself after the tick —
//                the second call, never a server-side side effect of the
//                first (the Tick door writes the note and nothing else);
//   * **off**  — *never*: this service refuses before anything is sent
//                (`tool_off`). Enforced here, at the tool — a client that
//                ignores the setting still cannot close the issue.
//
// **What it may reach** is the connection's, never the caller's: the
// connection is opened through `openSyncHttp` — a `fetch` pinned to
// https://api.linear.app that fills the key at the egress door (core's
// `guardedFetch`, grantee `connection:<name>`) for that host only and follows
// no redirect. What leaves is `ISSUE_TO_COMPLETE_QUERY` and, when the issue
// is still open, the one fixed `COMPLETE_ISSUE_MUTATION`
// (packages/connections `completeIssue`); the caller names a connection and a
// key and nothing else.
//
// **Idempotent by nature.** An issue already completed (or canceled) in
// Linear is answered as it stands with `changed: false`, and only the read
// is sent.
//
// **What it writes** is Postgres only: the issue's `work` row closes with
// `meta.closed_reason: completed` (what the sync would record on its next
// pass), and its `task` mirror resolves at source. **No path here writes a
// vault file** — the owner's note is theirs; the tick that preceded this call
// was the Tick door's write, as `user`.

import { DEFAULT_TOOL_MODE, EgressRefused, resolveAtSource, type ToolMode } from "@foldedspacelabs/metistry-core";
import {
  ConnectionRefused,
  LINEAR_COMPLETE_TOOL,
  LINEAR_KEY_RE,
  LINEAR_MODULE,
  LINEAR_ORIGIN,
  LINEAR_SYNC,
  LinearError,
  completeIssue,
  envSecretSource,
  linearRef,
  loadInstanceCatalog,
  openSyncHttp,
  type CatalogRoots,
  type SyncHttp,
} from "@foldedspacelabs/metistry-connections";
import { SOURCE_KIND, type Db } from "./run.js";

/** The capability a tracker provider declares for this door (core's CONNECTION_CAPABILITIES.tracker). */
export const COMPLETE_CAPABILITY = "complete";

/** A connection opened for Close in Linear: its door, and the owner's mode for the tool. */
export type OpenedTracker =
  | { ok: true; sync: Pick<SyncHttp, "connection" | "fetch" | "headers" | "secretsUsed">; mode: ToolMode }
  | { ok: false; status: "absent" | "not_tracker" | "no_capability" | "failed"; why: string };

/** How the door opens a tracker connection by name: the console builds one (`linearTrackerOpener`); a test hands in its own. */
export type TrackerOpener = (connection: string) => Promise<OpenedTracker>;

/**
 * The console's opener: reads the instance's catalog afresh on every call
 * (a `metistry connections policy` lands on the next press, no restart),
 * finds the connection by NAME, and opens it through the same door the
 * `linear` sync reads through — pinned to Linear's origin, the key filled
 * only there. Never dials.
 */
export function linearTrackerOpener(roots: CatalogRoots & { env: NodeJS.ProcessEnv; fetch?: typeof fetch | undefined }): TrackerOpener {
  const secrets = envSecretSource(roots.env);
  return async (connection) => {
    const catalog = await loadInstanceCatalog(roots);
    const entry = catalog.entries.find((e) => e.name === connection);
    if (!entry) return { ok: false, status: "absent", why: `there is no connection named ${connection}` };
    if (entry.status !== "ok" || !entry.connection || !entry.provider) {
      return { ok: false, status: entry.status === "absent" ? "absent" : "failed", why: `connection ${connection} is ${entry.status}: ${entry.issues.join("; ") || "not ready"}` };
    }
    const m = entry.provider.manifest;
    if (m.provides !== "tracker" || m.implementation.kind !== "builtin" || m.implementation.module !== LINEAR_MODULE) {
      return { ok: false, status: "not_tracker", why: `connection ${connection} is not a Linear tracker connection` };
    }
    if (!m.capabilities.includes(COMPLETE_CAPABILITY)) {
      return { ok: false, status: "no_capability", why: `connection ${connection}'s provider ${entry.provider.name} cannot complete an issue` };
    }
    const mode = entry.connection.tools[LINEAR_COMPLETE_TOOL]?.mode ?? DEFAULT_TOOL_MODE;
    // `openSyncHttp` picks the connection a sync reads; naming this one for
    // the linear sync (in a copy of scheduled.yaml that nothing writes) opens
    // exactly the connection the path names, with every check it applies —
    // provider module, origin pin, auth, redirect refusal, the egress door.
    const opened = openSyncHttp({
      catalog: { ...catalog, scheduled: { syncs: { [LINEAR_SYNC]: { connection } } } },
      sync: LINEAR_SYNC,
      origin: LINEAR_ORIGIN,
      module: LINEAR_MODULE,
      secrets,
      ...(roots.fetch ? { fetch: roots.fetch } : {}),
    });
    if (!opened.ok) return { ok: false, status: opened.status === "absent" ? "absent" : "failed", why: opened.why };
    return { ok: true, sync: opened.sync, mode };
  };
}

/** Why Close in Linear refused. Each a code path with a test (U3). */
export const COMPLETE_REFUSAL_CODES = ["bad_key", "no_connection", "not_tracker", "no_capability", "connection_failed", "tool_off", "not_found", "linear"] as const;
export type CompleteRefusalCode = (typeof COMPLETE_REFUSAL_CODES)[number];

export class CompleteRefused extends Error {
  override readonly name = "CompleteRefused";
  constructor(
    readonly code: CompleteRefusalCode,
    message: string,
    /** Linear's own reason, when it was Linear that refused */
    readonly linear?: LinearError["code"] | undefined,
  ) {
    super(message);
  }
}

export interface CompleteResult {
  connection: string;
  key: string;
  /** `linear:<KEY>` — the task line's ref */
  ref: string;
  url: string;
  /** what the issue is now: `done`, or `canceled` when Linear had already canceled it (left as it was) */
  state: "done" | "canceled";
  /** true when this call closed it; false when Linear already had it closed and nothing was changed */
  changed: boolean;
  /** the secret names the calls carried — for the door's audit row; never a value */
  secrets: string[];
}

/** Close one issue in Linear through the named connection (module header). */
export async function completeLinearIssue(db: Db, open: TrackerOpener, req: { connection: string; key: string }): Promise<CompleteResult> {
  if (typeof req.key !== "string" || !LINEAR_KEY_RE.test(req.key)) throw new CompleteRefused("bad_key", "a Linear issue is named by its key (TEAM-123)");
  const opened = await open(req.connection);
  if (!opened.ok) {
    const code: CompleteRefusalCode = opened.status === "absent" ? "no_connection" : opened.status === "failed" ? "connection_failed" : opened.status;
    throw new CompleteRefused(code, opened.why);
  }
  if (opened.mode === "off") {
    throw new CompleteRefused(
      "tool_off",
      `Close in Linear is set to Never for ${req.connection} — nothing was sent (\`metistry connections policy ${req.connection} ${LINEAR_COMPLETE_TOOL} ask\` turns it back on)`,
    );
  }
  const ref = linearRef(req.key);
  // the sync's row names the issue by Linear's own id; a key the sync has not
  // seen (an issue someone else holds, one created a moment ago) is looked up
  // by its key, which Linear's `issue(id:)` also takes
  const { rows } = await db.query(`SELECT id, meta->>'id' AS linear_id FROM work WHERE external_ref = $1 AND kind = 'issue' AND meta->>'connection' = $2`, [ref, opened.sync.connection]);
  const row = rows[0] as { id: number | string; linear_id: string | null } | undefined;
  let done;
  try {
    done = await completeIssue(opened.sync, row?.linear_id || req.key);
  } catch (err) {
    if (err instanceof LinearError) {
      if (err.code === "not_found") throw new CompleteRefused("not_found", `${req.key} is not an issue this connection can see in Linear`, err.code);
      throw new CompleteRefused("linear", err.message, err.code);
    }
    // the door's own refusals — another host, a redirect, a secret it will not
    // fill — name names and hosts, never a value; nothing further was sent
    if (err instanceof EgressRefused || err instanceof ConnectionRefused) throw new CompleteRefused("connection_failed", err.message);
    throw err;
  }
  const closed = done.issue.state.type === "completed" ? "completed" : "canceled";
  if (row) {
    const patch = { closed_reason: closed, state: done.issue.state.name, state_type: done.issue.state.type, url: done.issue.url };
    await db.query(`UPDATE work SET status = 'closed', updated_at = now(), meta = coalesce(meta, '{}'::jsonb) || $2::jsonb WHERE id = $1 AND status <> 'closed'`, [row.id, JSON.stringify(patch)]);
  }
  // its task request, if one waits, is answered by the source — exactly what the sync's next pass would do
  await resolveAtSource(db, { kind: SOURCE_KIND, external_ref: ref });
  return {
    connection: opened.sync.connection,
    key: req.key,
    ref,
    url: done.issue.url,
    state: closed === "completed" ? "done" : "canceled",
    changed: done.changed,
    secrets: opened.sync.secretsUsed(),
  };
}
