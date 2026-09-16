// Session rolls at task boundaries — docs/research/2026-09-cost-optimization.md
// decision 3, which closes the open half of plan §6 decision 3 ("no fixed
// cadence") with a measurable rule instead of a cadence.
//
// Pruning context at a TASK BOUNDARY beats editing it mid-task: after a
// boundary the next turn re-caches once and reads cheaply from there, where
// mid-task edits invalidate the prefix over and over. So a roll is an event,
// never a timer, and never a model's judgement about its own coherence:
//
//   - a `decision` the assistant was blocked on is answered  → roll
//   - a task the assistant had claimed closes                 → roll
//
// The roll itself is deliberately dumb: mark the thread's active sessions
// `rolled`, so the NEXT turn finds none to resume and starts a fresh SDK
// session (apps/assistant/src/drain.ts). Nothing is deleted — the rows stay
// for the re-brief path (§4.16 rule 6), and the turn count each session
// reached is recorded on the way out, which is the number "cache hit rate per
// session" is later divided by.

import type { RunExecutor } from "./runs.js";

export interface RollResult {
  /** Session ids marked `rolled` (usually one; more only if a thread somehow had two active). */
  rolled: string[];
  /** Turns those sessions reached, summed — recorded so per-session turn counts are queryable without joining. */
  turns: number;
}

/**
 * Roll a thread's session. Idempotent: a thread with no active session rolls
 * nothing and writes no row, so a repeated boundary event is not a repeated
 * roll.
 */
export async function rollSession(db: RunExecutor, thread: string, reason: string): Promise<RollResult> {
  const { rows } = await db.query(
    `UPDATE sessions SET status = 'rolled' WHERE thread = $1 AND status = 'active' RETURNING id, turns`,
    [thread],
  );
  if (rows.length === 0) return { rolled: [], turns: 0 };

  const rolled = rows.map((r) => String(r.id));
  const turns = rows.reduce((n, r) => n + Number(r.turns ?? 0), 0);
  // The OpenAI-compatible engine keeps its message history in
  // `assistant_sessions` under the SAME id (0016_compute_engine). One roll
  // path, both tables: a boundary that ends the session must also end the
  // history the in-house loop would otherwise replay.
  await db.query(`UPDATE assistant_sessions SET rolled_at = now() WHERE id = ANY($1::uuid[]) AND rolled_at IS NULL`, [rolled]);
  // One `runs` row per roll, kind `session_roll`: what rolled, on which
  // thread, why, and how far the session got. The dashboard reads `runs`;
  // this needs no new table and no new mechanism (§4.18.D).
  await db.query(
    `INSERT INTO runs (component, kind, ok, started_at, finished_at, session_id, meta)
     VALUES ('assistant', 'session_roll', true, now(), now(), $1, $2)`,
    [rolled[0] ?? null, JSON.stringify({ thread, reason, sessions: rolled, turns })],
  );
  return { rolled, turns };
}
