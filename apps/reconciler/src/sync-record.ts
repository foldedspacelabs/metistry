// What a vault sync leaves in Postgres (§2.21, §2.20): one `runs` row of
// kind `vault_sync` per act — `meta.state` is `pull`, `push` or `conflict`,
// the `vault.sync {state}` event's source — and, for a conflict, ONE Needs
// You `report` per episode.
//
// "One" is the partial unique index from migration 0009 on
// `(source_agent, payload->>'idempotency_key') WHERE kind = 'report'`: the
// key is the commit where the two histories last agreed, which does not
// move while the conflict stands, so every later attempt that finds the
// same conflict — this hour, next hour, after a restart — inserts nothing,
// and a report the owner has dismissed stays dismissed. A later, different
// conflict has a different base and is a new report.
//
// The report is an EXCERPT with no act: it is resolved in Obsidian or a
// terminal, and the next clean sync clears `vault.state` (check(), and
// `GET /api/vault/status` once T10-2 serves it). Dismiss is its answer.

import { finishRun, startRun } from "@foldedspacelabs/metistry-core";
import { conflictSummary, type SyncConflict, type SyncHooks, type SyncRecord } from "./committer.js";
import type { Db } from "./indexer.js";

export const SYNC_COMPONENT = "reconciler";
export const SYNC_RUN_KIND = "vault_sync";

/** The report's key: the episode is the fork point it stopped at. */
export function conflictKey(c: Pick<SyncConflict, "reason" | "base" | "remote">): string {
  return `vault-sync-conflict:${c.base || `unrelated:${c.remote.sha}`}`;
}

/** The Needs You row's payload: the paths, the two sides, and how it is resolved. */
export function conflictReport(c: SyncConflict, runId: number | null): Record<string, unknown> {
  const where = `${c.remote_name}/${c.branch}`;
  const n = c.path_count;
  const title =
    c.reason === "unrelated"
      ? `Vault sync stopped: ${where} shares no history with this vault`
      : c.reason === "local_changes"
        ? `Vault sync stopped: uncommitted edits are in the way (${n} file${n === 1 ? "" : "s"})`
        : `Vault sync stopped: ${n} file${n === 1 ? "" : "s"} changed here and on ${where}`;
  const fix =
    c.reason === "unrelated"
      ? `Check the remote with \`git remote -v\` in the instance directory — it may be a different repository.`
      : c.reason === "local_changes"
        ? `These edits are on disk and nobody has committed them${c.paths.some((p) => p.startsWith(".metistry/")) ? " — a `.metistry/` file is yours to commit, and is never swept" : ""}. Commit or undo them in a terminal, and the next sync picks up where it stopped.`
        : `Resolve it in a terminal in the instance directory (\`git pull\`, fix the files, commit), or make these notes match ${where} in Obsidian. The next sync that integrates cleanly clears this.`;
  const body = [
    `${conflictSummary(c)}.`,
    `Nothing was pushed and nothing was overwritten; writes keep committing here in the meantime.`,
    fix,
  ].join(" ");
  return {
    title,
    body,
    kind: "vault_conflict",
    refs: c.paths,
    reason: c.reason,
    paths: c.paths,
    path_count: c.path_count,
    sides: {
      local: { ref: c.branch, sha: c.local.sha, commits: c.local.ahead },
      remote: { ref: where, sha: c.remote.sha, commits: c.remote.behind },
      base: c.base || null,
      by_path: c.sides,
    },
    since: c.since,
    idempotency_key: conflictKey(c),
    provenance: { component: SYNC_COMPONENT, ...(runId !== null ? { run_id: runId } : {}) },
  };
}

/** Record one sync act; for a conflict, raise the one report. Returns the runs id and whether a NEW report was raised. */
export async function recordSync(db: Db, e: SyncRecord): Promise<{ runId: number; reported: boolean }> {
  const runId = await startRun(db, { component: SYNC_COMPONENT, kind: SYNC_RUN_KIND, meta: { state: e.state, remote: e.remote, branch: e.branch } });
  await finishRun(db, runId, { ok: e.ok, ...(e.error ? { error: e.error } : {}), meta: e.meta });
  if (e.state !== "conflict" || !e.conflict) return { runId, reported: false };
  const ins = await db.query(
    `INSERT INTO proposals (kind, source_agent, trust, payload) VALUES ('report', $1, 'internal', $2::jsonb)
     ON CONFLICT (source_agent, (payload->>'idempotency_key')) WHERE kind = 'report' AND payload->>'idempotency_key' IS NOT NULL DO NOTHING
     RETURNING id`,
    [SYNC_COMPONENT, JSON.stringify(conflictReport(e.conflict, runId))],
  );
  return { runId, reported: ins.rows.length > 0 };
}

/** The committer's `hooks.record`, over a database. */
export function syncRecorder(db: Db): NonNullable<SyncHooks["record"]> {
  return async (e) => {
    await recordSync(db, e);
  };
}
