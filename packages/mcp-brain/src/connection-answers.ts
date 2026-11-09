// The whole of a folded answer, kept for the caller that asked (X-132).
//
// When `connections_call` folds an upstream answer (connection-fold.ts), the
// answer itself is not thrown away: it is written to `connection_answers`,
// keyed by the call's own `runs` row — the HANDLE the caller is told — and
// read back one page at a time through `connections_call { page: "<handle>/<n>" }`.
// No new tool (X-49).
//
// What is enforced HERE, in SQL rather than a sentence:
//
//   * **Readable only by the same principal.** The row carries the principal
//     that made the call, and the read is `WHERE run_id = $1 AND principal =
//     $2`: another caller presenting the handle — guessed, or copied from a
//     transcript — matches nothing and hears the same `not_found` an unknown
//     handle does. The run's own `runs` row names the handle in `meta`, where
//     `runs_export` serves it to a principal with `queries`; that is a number,
//     not a read.
//   * **Short-lived.** Every row expires (`keepHours`, configuration), the
//     read refuses an expired row, and every write first deletes what has
//     expired — so the table purges itself on use and needs no routine.
//
// Durability: DERIVED, EPHEMERAL (invariant 1; `db/migrations/0042_connection_answers.sql`).
// The record of the call is its `runs` row; this is a cache of what the
// upstream said, and `down -v` loses nothing anyone would back up — the
// upstream still has the answer, and the caller can ask again.

import type { AnswerLike } from "./connection-fold.js";
import type { Db } from "./types.js";

export interface StoredAnswer {
  connection: string;
  tool: string;
  answer: AnswerLike;
  /** the answer's bytes on the wire, whole */
  bytes: number;
}

/**
 * Keep one dialled answer for its caller. `ON CONFLICT DO NOTHING`: a `runs`
 * row dials at most once, so a second write under one id is a retry, never a
 * different answer.
 */
export async function storeAnswer(db: Db, a: { runId: number; principal: string; connection: string; tool: string; answer: AnswerLike; bytes: number; keepHours: number }): Promise<void> {
  const answer = { content: a.answer.content, ...(a.answer.structuredContent !== undefined ? { structuredContent: a.answer.structuredContent } : {}) };
  await db.query(
    `WITH gone AS (DELETE FROM connection_answers WHERE expires_at <= now())
     INSERT INTO connection_answers (run_id, principal, connection, tool, answer, bytes, expires_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, now() + ($7::double precision * interval '1 hour'))
     ON CONFLICT (run_id) DO NOTHING`,
    [a.runId, a.principal, a.connection, a.tool, JSON.stringify(answer), a.bytes, a.keepHours],
  );
}

/** The stored answer for THIS principal, unexpired — or nothing, whatever the reason. */
export async function readAnswer(db: Db, q: { runId: number; principal: string }): Promise<StoredAnswer | undefined> {
  const { rows } = await db.query(`SELECT connection, tool, answer, bytes FROM connection_answers WHERE run_id = $1 AND principal = $2 AND expires_at > now()`, [q.runId, q.principal]);
  const r = rows[0];
  if (!r) return undefined;
  const answer = (typeof r.answer === "string" ? JSON.parse(r.answer) : r.answer) as AnswerLike;
  return { connection: String(r.connection), tool: String(r.tool), answer: { content: Array.isArray(answer.content) ? answer.content : [], ...(answer.structuredContent !== undefined ? { structuredContent: answer.structuredContent } : {}) }, bytes: Number(r.bytes) };
}
