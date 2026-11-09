// The drain loop (SHOULD-7's second half): claim status='new' rows one at
// a time (SKIP LOCKED — safe under restarts and future concurrency), run a
// turn on the session for that thread, write the reply, mark done. Every
// turn is a two-phase runs row. Sessions resume by thread via the sessions
// table; a dead/missing SDK session falls back to a fresh one (re-brief is
// Phase 3+ when brain-query exists — for now continuity is the SDK
// transcript, per §4.17 rule 6's fast-path).

import { DEFAULT_CACHING, emptyCompute, finishRun, parseDecisionBlock, parseOperation, PRIVATE_TIER, PrivateTierUnavailable, rollSession, startRun, v1Options, type Compute, type RouteOperation, type TierMap } from "@foldedspacelabs/metistry-core";
import { isBudgetRefusal, offerBudgetWindow, BudgetRefusal } from "./budgets.js";
import { recordShadow } from "./shadow.js";
import { captureSessionInScope, resolveTurnFor, type PolicyCaps, type ResolvedTurn } from "./tiers.js";
import type { Engine, TurnSpec } from "./engine.js";
import { newTurnId } from "./brain.js";
import { deferredCalls, skippedMeta, skippedReport } from "./deferred.js";
import { holdTurn, pausedFor, probeDue, providerRecovered, providerRefusal, raiseRefusal, releaseHeld } from "./provider-refusal.js";

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
  /** Test seam: how long a paused provider waits between probes (default `PROVIDER_PROBE_MS`). */
  probeMs?: number | undefined;
  /**
   * `rules.yaml` `policy.caps` from THIS process's copy of the file (tiers.ts
   * `loadTiers`). A turn the router's policy served is built from its route
   * and bound by these; absent = no policy block here, and such a turn takes
   * the rules' default (docs/ops/dynamic-router.md §6).
   */
  policyCaps?: PolicyCaps | undefined;
}

/** What a policy-served turn runs as, on top of its tier: the operation and all four limits the engine enforces (docs/ops/dynamic-router.md §1, §3). */
export interface PolicyTurn {
  operation: RouteOperation;
  maxToolCalls: number;
  maxTokens: number;
  maxCostUsd: number;
  row?: string;
}

/**
 * A row's route → the turn the policy chose, or why it cannot be served as
 * one (docs/ops/dynamic-router.md §6, §7.3). `null` = the rules routed this
 * message, and it runs as it always has.
 *
 * The OPERATION and the row's `tool_calls` come from the route; the CAPS come
 * from this process's own `rules.yaml`, and the turn takes the smaller of the
 * row's `tool_calls` and the file's — a row cannot grant itself more than the
 * owner's file allows. A route this cannot read (no caps here, an operation
 * outside the vocabulary, a fast path that reached the drain) is not guessed
 * at: it is the rules' default, and the reason is recorded.
 */
export function policyTurnOf(route: any, caps: PolicyCaps | undefined): PolicyTurn | { fallback: "no_caps" | "operation" } | null {
  if (route?.kind !== "model" || route?.routed_by !== "policy") return null;
  if (!caps) return { fallback: "no_caps" };
  const op = parseOperation(route.operation);
  if (!op || op.form === "fast_path:<query>") return { fallback: "operation" };
  const asked = typeof route.tool_calls === "number" && Number.isInteger(route.tool_calls) && route.tool_calls >= 0 ? route.tool_calls : caps.tool_calls;
  return {
    operation: route.operation as RouteOperation,
    maxToolCalls: op.form === "answer" ? 0 : Math.min(asked, caps.tool_calls),
    maxTokens: caps.tokens,
    maxCostUsd: caps.cost_usd,
    ...(typeof route.policy_row === "string" ? { row: route.policy_row } : {}),
  };
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
  // Turns held behind a provider that refused the account go back to `new`
  // once it is no longer paused — or one at a time, as the probe
  // (provider-refusal.ts). Before the claim, so a released turn keeps its
  // place in the queue.
  await releaseHeld(db, opts.probeMs);
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
  // A capture session in scope moves the turn to the private tier before
  // anything else is decided (plan §2.15): what a recording heard is answered
  // on this Mac or not at all. With nowhere private to run it, the turn is
  // REFUSED — recorded and said — never answered on another tier.
  const captureSession = captureSessionInScope(msg.meta);
  // A turn the router's policy served (T9-4) carries its operation on the
  // route; one this process cannot build from it takes the rules' default
  // tier and today's turn, and says why on its row.
  const policyRead = policyTurnOf(routeMeta, opts.policyCaps);
  let policy: PolicyTurn | null = policyRead !== null && "operation" in policyRead ? policyRead : null;
  let routeFallback: { from: string; reason: string } | undefined =
    policyRead !== null && "fallback" in policyRead ? { from: String(routeMeta.tier), reason: policyRead.fallback } : undefined;
  let turn: ResolvedTurn;
  try {
    turn = resolveTurnFor(compute, tiers, routeFallback ? undefined : routeMeta.kind === "model" ? routeMeta.tier : msg.meta?.tier, { captureSession });
  } catch (err) {
    if (!(err instanceof PrivateTierUnavailable)) throw err;
    const runId = await startRun(db, {
      component: "assistant",
      kind: "turn",
      meta: { message_id: msg.id, thread: msg.thread, routed_by: routeMeta.routed_by ?? "rule", tier: PRIVATE_TIER, capture_session: true, refused: "private_tier_unavailable" },
    });
    await finishRun(db, runId, { ok: false, error: err.message });
    await db.query(`UPDATE inbound_messages SET status = 'failed' WHERE id = $1`, [msg.id]);
    await db.query(`INSERT INTO outbound_messages (thread, text, in_reply_to, kind) VALUES ($1, $2, $3, 'alert')`, [msg.thread, `not answered: ${err.message}`, msg.id]);
    return true;
  }
  let { tier, model, effort, assignment } = turn;

  // A provider that refused the account (402 out of credits, 401/403 a key
  // it does not accept) is PAUSED while its report waits: the turn is held,
  // not sent — the same refusal again would buy nothing. The probe is the
  // one exception, so a top-up is noticed on its own.
  if (assignment && (await pausedFor(db, assignment.provider)) && !(await probeDue(db, assignment.provider, opts.probeMs))) {
    await holdTurn(db, msg.id, assignment.provider);
    return true;
  }

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

  // The turn handle, minted before the call so the in-flight row carries it:
  // the reply's tool calls stamp it (tools.ts), the archive keys the turn by
  // it (archive.ts), and `run_detail` joins the calls to this row on it.
  const turnId = newTurnId();
  // Whether the owner is there (C59): a chat turn is, a routine's turn (the
  // fold, a prose slot) is not. Every call of the turn says so in `_meta`, so
  // an Ask First call pauses in chat and is deferred — skipped, reported,
  // still raised in Needs You — when nobody is waiting on the reply.
  const interactive = isChatTurn(msg.meta);

  const runId = await startRun(db, {
    component: "assistant",
    kind: "turn",
    ...(assignment ? { provider: assignment.provider } : {}),
    model,
    meta: {
      message_id: msg.id,
      thread: msg.thread,
      turn_id: turnId,
      routed_by: routeMeta.routed_by ?? "rule",
      tier,
      effort,
      // the reason the tier is `private`, when it is: recorded, not inferred
      ...(captureSession ? { capture_session: true } : {}),
      // `caching:` as it stood FOR THIS TURN. `compute.yaml` is hot-reloaded,
      // so the file cannot answer later what was in force earlier — and a
      // turn taken while caching was off must not be read by the
      // cache-report as a prefix that failed to cache (OPEN-6).
      ...(assignment ? { engine: assignment.config.kind, model_ref: assignment.ref, caching: assignment.config.caching ?? DEFAULT_CACHING } : {}),
      ...(fresh ? { fresh_session: true } : {}),
      ...(interactive ? {} : { unattended: true }),
      // a policy-served turn: what it was built from (docs/ops/dynamic-router.md §6)
      ...(policy ? { operation: policy.operation, tool_calls: policy.maxToolCalls, ...(policy.row ? { policy_row: policy.row } : {}) } : {}),
      ...(routeFallback ? { route_fallback: routeFallback } : {}),
    },
  });
  try {
    // The spec for one attempt: the tier's model and effort, and — for a
    // policy-served turn — its operation and the four caps the engine enforces.
    const specFor = (p: PolicyTurn | null): TurnSpec => ({
      model,
      effort,
      assignment,
      thread: msg.thread,
      tier,
      turnId,
      interactive,
      ...(p ? { operation: p.operation, maxToolCalls: p.maxToolCalls, maxTokens: p.maxTokens, maxCostUsd: p.maxCostUsd } : {}),
    });
    const attempt = async (p: PolicyTurn | null) => {
      try {
        return await engine(prompt, { ...specFor(p), resume });
      } catch (err) {
        // A budget refusal is not a stale session: retrying it would only spend
        // the check again and land in the same place. Nor is a provider
        // refusing the account — a 402 retried is the same 402.
        if (!resume || isBudgetRefusal(err) || providerRefusal(err)) throw err;
        return await engine(prompt, specFor(p)); // stale session: fresh start
      }
    };
    let result;
    try {
      result = await attempt(policy);
    } catch (err) {
      // THE BUDGET FALLBACK (docs/ops/dynamic-router.md §5): the guard ran on
      // the tier the POLICY chose and refused it. The turn is re-resolved
      // ONCE to the rules' default — today's route, today's turn — and asked
      // again, so under `critical_only` the owner's message is answered
      // exactly as it would have been with no policy. Never twice: a refusal
      // of the default is the refusal, handled below as it always was.
      if (!policy || !isBudgetRefusal(err)) throw err;
      routeFallback = { from: tier, reason: "budget" };
      policy = null;
      ({ tier, model, effort, assignment } = resolveTurnFor(compute, tiers, undefined, { captureSession }));
      await db.query(`UPDATE runs SET provider = $2, model = $3, meta = meta || $4::jsonb WHERE id = $1`, [
        runId,
        assignment?.provider ?? null,
        model,
        JSON.stringify({
          tier,
          effort,
          route_fallback: routeFallback,
          ...(assignment ? { engine: assignment.config.kind, model_ref: assignment.ref, caching: assignment.config.caching ?? DEFAULT_CACHING } : {}),
        }),
      ]);
      result = await attempt(null);
    }
    const upsert = await db.query(
      `INSERT INTO sessions (id, thread, turns) VALUES ($1, $2, 1)
       ON CONFLICT (id) DO UPDATE SET last_active_at = now(), turns = sessions.turns + 1
       RETURNING turns`,
      [result.session_id, msg.thread],
    );
    const sessionTurns = Number(upsert.rows[0]?.turns ?? 1);
    // An unattended turn reports what it skipped (C59): read from the rows
    // the bridge wrote for this turn's deferred calls, never from the reply,
    // and put at the foot of the output — after the reply, so a block the
    // reply ends with is still parsed from the reply alone below.
    const skipped = interactive ? [] : await deferredCalls(db, { component: ASSISTANT_AGENT, runId, turnId });
    const report = skippedReport(skipped);
    const out = await db.query(
      `INSERT INTO outbound_messages (thread, text, in_reply_to) VALUES ($1, $2, $3) RETURNING id`,
      [msg.thread, report ? `${result.text}\n\n${report}` : result.text, msg.id],
    );
    // A reply that ends with a ```decision block is a blocking question: it
    // becomes a `decision` row in the one queue (D7), answerable from chat,
    // triage or a notification. Parsed at the point the reply is stored —
    // the convention is in the seed prompt, the enforcement is here, and a
    // malformed block simply yields no queue item. `questions` is the record
    // (v2, T2-3); one pick-one question also carries v1's `options`, so a
    // client that predates v2 can still answer it with the option itself.
    const ask = parseDecisionBlock(result.text);
    if (ask) {
      await db.query(
        `INSERT INTO proposals (kind, source_agent, trust, payload) VALUES ('decision', 'assistant', 'internal', $1)`,
        [JSON.stringify({ title: ask.title, questions: ask.questions, ...v1Options(ask.questions), message_id: Number(out.rows[0]?.id), thread: msg.thread, in_reply_to: Number(msg.id) })],
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
    // `session_id` is the archive's other key: with `turn_id` it names this
    // turn's row in `session_archive` (Run detail's conversation).
    const meta: Record<string, unknown> = { session_id: result.session_id, session_turns: sessionTurns };
    if (result.tools_used) meta.tools_used = result.tools_used;
    if (result.cache_read !== undefined) meta.cache_read = result.cache_read;
    if (result.cache_write !== undefined) meta.cache_write = result.cache_write;
    if (result.cost_source !== undefined) meta.cost_source = result.cost_source;
    if (result.turns !== undefined) meta.engine_turns = result.turns;
    if (result.stopped) meta.stopped = result.stopped;
    if (result.notes?.length) meta.notes = result.notes;
    if (rolled.length > 0) meta.rolled_sessions = rolled;
    Object.assign(meta, skippedMeta(skipped));
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
        await recordShadow(db, runId, result.shadow, { tier, caching: compute.providers[result.shadow.shadow.provider]?.caching ?? DEFAULT_CACHING });
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
    // It got through: whatever report said this provider refused is cleared
    // at its source, and the turns held behind it go on the next pass.
    if (assignment) await providerRecovered(db, assignment.provider);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const refused = assignment ? providerRefusal(err) : undefined;
    if (refused && assignment) {
      // ONE report per (provider, error class) while one waits (C96). The
      // turn that raised it fails with the provider's own words; a turn that
      // found one already waiting — the probe — goes back to waiting.
      await finishRun(db, runId, { ok: false, error: message, meta: { provider_refused: refused.status } });
      const report = await raiseRefusal(db, { provider: assignment.provider, config: assignment.config, refusal: refused, messageId: Number(msg.id), runId, thread: msg.thread });
      if (!report.raised) {
        await holdTurn(db, msg.id, assignment.provider);
        return true;
      }
      await db.query(`UPDATE inbound_messages SET status = 'failed' WHERE id = $1`, [msg.id]);
      await db.query(`INSERT INTO outbound_messages (thread, text, in_reply_to, kind) VALUES ($1, $2, $3, 'alert')`, [
        msg.thread,
        `${assignment.provider} refused this turn (HTTP ${refused.status}): ${refused.message} — it is in Needs You; turns for ${assignment.provider} wait until it is fixed`,
        msg.id,
      ]);
      return true;
    }
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
