// The drain loop (SHOULD-7's second half): claim status='new' rows one at
// a time (SKIP LOCKED — safe under restarts and future concurrency), run a
// turn on the session for that thread, write the reply, mark done. Every
// turn is a two-phase runs row. Sessions resume by thread via the sessions
// table; a dead/missing SDK session falls back to a fresh one (re-brief is
// Phase 3+ when brain-query exists — for now continuity is the SDK
// transcript, per §4.17 rule 6's fast-path).

import { finishRun, parseDecisionBlock, startRun } from "@foldedspacelabs/metistry-core";
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
    const out = await db.query(
      `INSERT INTO outbound_messages (thread, text, in_reply_to) VALUES ($1, $2, $3) RETURNING id`,
      [msg.thread, result.text, msg.id],
    );
    // A reply that ends with a ```decision block is a blocking question: it
    // becomes a `decision` row in the one queue (D7), answerable from chat,
    // triage or a notification. Parsed at the point the reply is stored —
    // the convention is in the seed prompt, the enforcement is here, and a
    // malformed block simply yields no queue item.
    const ask = parseDecisionBlock(result.text);
    if (ask) {
      await db.query(
        `INSERT INTO proposals (kind, source_agent, trust, payload) VALUES ('decision', 'assistant', 'internal', $1)`,
        [JSON.stringify({ title: ask.title, options: ask.options, message_id: Number(out.rows[0]?.id), thread: msg.thread, in_reply_to: Number(msg.id) })],
      );
    }
    await db.query(`UPDATE inbound_messages SET status = 'done', session_id = $2 WHERE id = $1`, [
      msg.id,
      result.session_id,
    ]);
    // the turn's own tool calls, by name (each call is ALSO its own runs row
    // on the agent — mcp-brain, kind=tool) plus cache read/write tokens from
    // the SDK's usage (cost-optimisation §"Measure": cache_hit_rate is
    // computed from these downstream by the claude-usage collector).
    const meta: Record<string, unknown> = {};
    if (result.tools_used) meta.tools_used = result.tools_used;
    if (result.cache_read !== undefined) meta.cache_read = result.cache_read;
    if (result.cache_write !== undefined) meta.cache_write = result.cache_write;
    await finishRun(db, runId, {
      ok: true,
      ...(result.tokens_in !== undefined ? { tokens_in: result.tokens_in } : {}),
      ...(result.tokens_out !== undefined ? { tokens_out: result.tokens_out } : {}),
      ...(result.cost_usd !== undefined ? { cost_usd: result.cost_usd } : {}),
      ...(Object.keys(meta).length > 0 ? { meta } : {}),
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
