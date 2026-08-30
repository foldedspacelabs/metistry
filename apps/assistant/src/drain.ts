// The drain loop (SHOULD-7's second half): claim status='new' rows one at
// a time (SKIP LOCKED — safe under restarts and future concurrency), run a
// turn on the session for that thread, write the reply, mark done. Every
// turn is a two-phase runs row. Sessions resume by thread via the sessions
// table; a dead/missing SDK session falls back to a fresh one (re-brief is
// Phase 3+ when brain-query exists — for now continuity is the SDK
// transcript, per §4.17 rule 6's fast-path).

import { finishRun, startRun } from "@foldedspacelabs/metistry-core";
import type { Engine } from "./engine.js";

export interface Db {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

interface Claimed {
  id: number;
  thread: string;
  text: string;
  meta: any;
}

export async function drainOne(db: Db, engine: Engine, defaultModel: string): Promise<boolean> {
  const { rows } = await db.query(
    `UPDATE inbound_messages SET status = 'processing'
     WHERE id = (SELECT id FROM inbound_messages WHERE status = 'new'
                 ORDER BY ts LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING id, thread, text, meta`,
  );
  const msg: Claimed | undefined = rows[0];
  if (!msg) return false;

  const routeMeta = msg.meta?.route ?? {};
  const model = routeMeta.kind === "model" ? (routeMeta.model ?? defaultModel) : defaultModel;
  const prompt = routeMeta.kind === "model" ? routeMeta.text : msg.text;

  // resume the thread's session if one exists
  const sess = await db.query(
    `SELECT id FROM sessions WHERE thread = $1 AND status = 'active' ORDER BY last_active_at DESC LIMIT 1`,
    [msg.thread],
  );
  const resume: string | undefined = sess.rows[0]?.id;

  const runId = await startRun(db, {
    component: "assistant",
    kind: "turn",
    model,
    meta: { message_id: msg.id, thread: msg.thread, routed_by: routeMeta.routed_by ?? "rule", tier: routeMeta.tier ?? "default" },
  });
  try {
    let result;
    try {
      result = await engine(prompt, model, resume);
    } catch (err) {
      if (!resume) throw err;
      result = await engine(prompt, model); // stale session: fresh start
    }
    await db.query(
      `INSERT INTO sessions (id, thread, turns) VALUES ($1, $2, 1)
       ON CONFLICT (id) DO UPDATE SET last_active_at = now(), turns = sessions.turns + 1`,
      [result.session_id, msg.thread],
    );
    await db.query(`INSERT INTO outbound_messages (thread, text, in_reply_to) VALUES ($1, $2, $3)`, [
      msg.thread,
      result.text,
      msg.id,
    ]);
    await db.query(`UPDATE inbound_messages SET status = 'done', session_id = $2 WHERE id = $1`, [
      msg.id,
      result.session_id,
    ]);
    await finishRun(db, runId, {
      ok: true,
      ...(result.tokens_in !== undefined ? { tokens_in: result.tokens_in } : {}),
      ...(result.tokens_out !== undefined ? { tokens_out: result.tokens_out } : {}),
      ...(result.cost_usd !== undefined ? { cost_usd: result.cost_usd } : {}),
    });
  } catch (err) {
    await db.query(`UPDATE inbound_messages SET status = 'failed' WHERE id = $1`, [msg.id]);
    await db.query(`INSERT INTO outbound_messages (thread, text, in_reply_to, kind) VALUES ($1, $2, $3, 'alert')`, [
      msg.thread,
      "that turn failed — it's logged; try again or check the status page",
      msg.id,
    ]);
    await finishRun(db, runId, { ok: false, error: err instanceof Error ? err.message : String(err) });
  }
  return true;
}
