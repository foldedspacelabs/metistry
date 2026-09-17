// The drain loop (SHOULD-7's second half): claim status='new' rows one at
// a time (SKIP LOCKED — safe under restarts and future concurrency), run a
// turn on the session for that thread, write the reply, mark done. Every
// turn is a two-phase runs row. Sessions resume by thread via the sessions
// table; a dead/missing SDK session falls back to a fresh one (re-brief is
// Phase 3+ when brain-query exists — for now continuity is the SDK
// transcript, per §4.17 rule 6's fast-path).

import { emptyCompute, finishRun, parseDecisionBlock, rollSession, startRun, type Compute, type TierMap } from "@foldedspacelabs/metistry-core";
import { isBudgetRefusal, offerBudgetWindow, BudgetRefusal } from "./budgets.js";
import { recordShadow } from "./shadow.js";
import { resolveTurn } from "./tiers.js";
import type { Engine } from "./engine.js";

/** The assistant's own agent id — the `claimed_by` on any task it holds. Never the assistant's NAME (CLAUDE.md: the name lives in identity.yaml alone). */
export const ASSISTANT_AGENT = "assistant";

export interface Db {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

interface Claimed {
  id: number;
  thread: string;
  text: string;
  meta: any;
}

/**
 * Did this turn close a task the assistant was holding? The evidence is the
 * work row's own history — deterministic, and never a reading of the reply.
 * The turn's own `runs.started_at` bounds it, so BOTH sides of the comparison
 * come from the database's clock (an app-side `new Date()` against Postgres
 * `now()` is a race on any skew); the containment check picks out the
 * assistant's own `closed` entry.
 */
async function closedOwnTask(db: Db, runId: number): Promise<number | null> {
  const { rows } = await db.query(
    `SELECT id FROM work
     WHERE kind = 'task' AND status = 'closed'
       AND closed_at >= (SELECT started_at FROM runs WHERE id = $1)
       AND history @> $2::jsonb
     ORDER BY closed_at DESC LIMIT 1`,
    [runId, JSON.stringify([{ agent: ASSISTANT_AGENT, status: "closed" }])],
  );
  return rows[0] ? Number(rows[0].id) : null;
}

export interface DrainOptions {
  /** `compute.yaml` in force, read per turn because it is hot-reloaded. Absent = nothing assigned, so rules.yaml's tiers: decide and the SDK path runs. */
  compute?: (() => Compute) | undefined;
}

/**
 * Is this turn person-facing? A row the composer wrote carries `meta.route`
 * and no `meta.kind`; a machine-assembled one (the evening fold) carries
 * `meta.kind`. The distinction is what decides how a budget refusal LANDS
 * (the Eve adopt): a chat turn gets one more window offered as a Needs You
 * item, a routine's turn just fails with `budget_exceeded`.
 */
export function isChatTurn(meta: any): boolean {
  return typeof meta?.kind !== "string";
}

export async function drainOne(db: Db, engine: Engine, tiers: TierMap, opts: DrainOptions = {}): Promise<boolean> {
  const { rows } = await db.query(
    `UPDATE inbound_messages SET status = 'processing'
     WHERE id = (SELECT id FROM inbound_messages WHERE status = 'new'
                 ORDER BY ts LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING id, thread, text, meta`,
  );
  const msg: Claimed | undefined = rows[0];
  if (!msg) return false;

  const routeMeta = msg.meta?.route ?? {};
  const prompt = routeMeta.kind === "model" ? routeMeta.text : msg.text;

  // The tier is a NAME on the row: the router's for a chat message, `meta.tier`
  // for a machine-enqueued turn (the fold carries `routine`). It resolves HERE,
  // at the point of the call, through the same `tiers:` block the router read —
  // so there is exactly one place a tier becomes a (model, effort) pair, and an
  // unknown name lands on `default` rather than on an invented model.
  const compute = opts.compute?.() ?? emptyCompute();
  const { tier, model, effort, assignment } = resolveTurn(compute, tiers, routeMeta.kind === "model" ? routeMeta.tier : msg.meta?.tier);

  // Fresh session at a task boundary (cost research decision 3). A fold turn
  // is its own task and never continues the chat; anything else can ask for a
  // fresh session with `meta.fresh_session`. Otherwise resume the thread's
  // active session — a roll (core's `rollSession`) is what ends one, so there
  // is simply nothing active to find after a boundary.
  const fresh = msg.meta?.fresh_session === true || msg.meta?.kind === "fold";
  const sess = fresh
    ? { rows: [] as any[] }
    : await db.query(
        `SELECT id FROM sessions WHERE thread = $1 AND status = 'active' ORDER BY last_active_at DESC LIMIT 1`,
        [msg.thread],
      );
  const resume: string | undefined = sess.rows[0]?.id;

  const runId = await startRun(db, {
    component: "assistant",
    kind: "turn",
    ...(assignment ? { provider: assignment.provider } : {}),
    model,
    meta: {
      message_id: msg.id,
      thread: msg.thread,
      routed_by: routeMeta.routed_by ?? "rule",
      tier,
      effort,
      ...(assignment ? { engine: assignment.config.kind, model_ref: assignment.ref } : {}),
      ...(fresh ? { fresh_session: true } : {}),
    },
  });
  try {
    let result;
    try {
      result = await engine(prompt, { model, effort, resume, assignment, thread: msg.thread, tier });
    } catch (err) {
      // A budget refusal is not a stale session: retrying it would only spend
      // the check again and land in the same place.
      if (!resume || isBudgetRefusal(err)) throw err;
      result = await engine(prompt, { model, effort, assignment, thread: msg.thread, tier }); // stale session: fresh start
    }
    const upsert = await db.query(
      `INSERT INTO sessions (id, thread, turns) VALUES ($1, $2, 1)
       ON CONFLICT (id) DO UPDATE SET last_active_at = now(), turns = sessions.turns + 1
       RETURNING turns`,
      [result.session_id, msg.thread],
    );
    const sessionTurns = Number(upsert.rows[0]?.turns ?? 1);
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
    // A task the assistant held closing is a task boundary: roll the thread so
    // the NEXT turn starts fresh rather than carrying a finished task's context
    // forward (cost research decision 3). Only worth a query when the turn
    // actually touched the task list.
    let rolled: string[] = [];
    if (result.tools_used?.["mcp__brain__tasks_update"]) {
      const taskId = await closedOwnTask(db, runId);
      if (taskId !== null) rolled = (await rollSession(db, msg.thread, `task_closed:#${taskId}`)).rolled;
    }
    // runs.meta: the turn's own tool calls (each call is ALSO its own runs row on
    // the agent — mcp-brain, kind=tool), cache read/write tokens from the SDK's
    // usage (claude-usage derives cache_hit_rate downstream), the session's turn
    // count, and any sessions this turn rolled.
    const meta: Record<string, unknown> = { session_turns: sessionTurns };
    if (result.tools_used) meta.tools_used = result.tools_used;
    if (result.cache_read !== undefined) meta.cache_read = result.cache_read;
    if (result.cache_write !== undefined) meta.cache_write = result.cache_write;
    if (result.cost_source !== undefined) meta.cost_source = result.cost_source;
    if (result.turns !== undefined) meta.engine_turns = result.turns;
    if (result.stopped) meta.stopped = result.stopped;
    if (result.notes?.length) meta.notes = result.notes;
    if (rolled.length > 0) meta.rolled_sessions = rolled;
    // The stage-2 shadow comparison, when this turn was sampled: both
    // transcripts and the agreement onto THIS row (0020), and the candidate's
    // spend as its own `runs` row against its own provider (shadow.ts). The
    // reply above has already been written from `result.text` — the shadow's
    // answer has no path to the user from here.
    //
    // Caught on purpose: the turn SUCCEEDED, and a measurement that failed to
    // store must not turn a delivered reply into a failed message.
    if (result.shadow) {
      meta.shadow_agreement = result.shadow.agreement.score;
      try {
        await recordShadow(db, runId, result.shadow, { tier });
      } catch (err) {
        meta.shadow_not_recorded = err instanceof Error ? err.message : String(err);
      }
    }
    await finishRun(db, runId, {
      ok: true,
      ...(result.tokens_in !== undefined ? { tokens_in: result.tokens_in } : {}),
      ...(result.tokens_out !== undefined ? { tokens_out: result.tokens_out } : {}),
      ...(result.cost_usd !== undefined ? { cost_usd: result.cost_usd } : {}),
      // cache read/write are COLUMNS now (0016): cache hit rate is a cost
      // number, and the budget and the weekly review both read it as one.
      ...(result.cache_read !== undefined ? { cache_read_tokens: result.cache_read } : {}),
      ...(result.cache_write !== undefined ? { cache_write_tokens: result.cache_write } : {}),
      meta,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.query(`UPDATE inbound_messages SET status = 'failed' WHERE id = $1`, [msg.id]);
    // A budget refusal says exactly what stopped and which field would
    // change it — there is no point replacing that with "that turn failed".
    // Person-facing threads also get ONE more window offered as a Needs You
    // item (budgets.ts); a machine-assembled turn just fails.
    const budget = err instanceof BudgetRefusal ? err : undefined;
    if (budget && isChatTurn(msg.meta)) await offerBudgetWindow(db, msg.thread, budget.hit);
    await db.query(`INSERT INTO outbound_messages (thread, text, in_reply_to, kind) VALUES ($1, $2, $3, 'alert')`, [
      msg.thread,
      budget ? message : "that turn failed — it's logged; try again or check the status page",
      msg.id,
    ]);
    await finishRun(db, runId, { ok: false, error: message });
  }
  return true;
}
