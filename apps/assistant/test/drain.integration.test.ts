// Drain loop against the real db with a fake engine (the SDK is smoked
// manually — this proves claim/reply/session/runs mechanics).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { drainOne } from "../src/drain.js";
import type { Engine } from "../src/engine.js";
import { parseCompute, type TierMap } from "@foldedspacelabs/metistry-core";
import { makeOpenAiEngine } from "../src/engine-openai.js";
import { memorySessionStore } from "../src/sessions.js";
import { NO_TOOLS } from "../src/tools.js";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";

// The tier map the drain resolves against — (model, effort) pairs, as
// seed/rules.yaml ships them.
const tiers: TierMap = {
  default: { model: "haiku", effort: "medium" },
  deep: { model: "opus", effort: "high" },
  routine: { model: "haiku", effort: "low" },
};

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url)); // METISTRY_DB_* only, and nothing of the operator's install (docs/ops/testing.md)

describe.skipIf(!hasDb)("assistant drain", () => {
  let pool: pg.Pool;
  const thread = `t-${Date.now()}`;
  const sdkSession = randomUUID();

  const fakeEngine: Engine = async (prompt, spec) => ({
    text: `echo(${spec.model}/${spec.effort}${spec.resume ? ",resumed" : ""}): ${prompt}`,
    session_id: sdkSession,
    tokens_in: 10,
    tokens_out: 5,
    cache_read: 40,
    cache_write: 6,
    cost_usd: 0.001,
    tools_used: { mcp__brain__capture: 1 },
  });

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
    // park other suites' leftovers so this suite drains only its own rows
    await pool.query(`UPDATE inbound_messages SET status = 'done' WHERE status = 'new'`);
  });
  afterAll(async () => pool.end());

  async function enqueue(text: string, meta: unknown = {}) {
    const { rows } = await pool.query(
      `INSERT INTO inbound_messages (thread, text, meta) VALUES ($1, $2, $3) RETURNING id`,
      [thread, text, JSON.stringify(meta)],
    );
    return rows[0].id;
  }

  it("claims, replies, records the session, marks done, logs a two-phase run", async () => {
    const id = await enqueue("hello", { route: { kind: "model", tier: "default", model: "haiku", text: "hello", routed_by: "rule" } });
    expect(await drainOne(pool, fakeEngine, tiers)).toBe(true);
    const inb = await pool.query(`SELECT status, session_id FROM inbound_messages WHERE id = $1`, [id]);
    expect(inb.rows[0]).toEqual({ status: "done", session_id: sdkSession });
    const out = await pool.query(`SELECT text FROM outbound_messages WHERE in_reply_to = $1`, [id]);
    expect(out.rows[0].text).toContain("echo(haiku");
    const sess = await pool.query(`SELECT thread FROM sessions WHERE id = $1`, [sdkSession]);
    expect(sess.rows[0].thread).toBe(thread);
    const run = await pool.query(
      `SELECT ok, tokens_in, tokens_out, cost_usd::float8 AS cost_usd, meta->'tools_used' AS tools_used,
              (meta->>'cache_read')::int AS cache_read, (meta->>'cache_write')::int AS cache_write,
              meta->>'thread' AS thread, finished_at IS NOT NULL AS finished FROM runs
       WHERE component='assistant' AND kind='turn' AND (meta->>'message_id')::bigint = $1`,
      [id],
    );
    // the turn row keeps tokens/cost AND names the tools it called (each call is also its own runs row via mcp-brain), plus cache read/write for the cache-hit-rate rollup
    expect(run.rows[0]).toMatchObject({ ok: true, tokens_in: 10, tokens_out: 5, cost_usd: 0.001, tools_used: { mcp__brain__capture: 1 }, cache_read: 40, cache_write: 6, thread, finished: true });
  });

  it("the turn row carries the turn handle the engine was given, from the in-flight insert on, and the session it ran in — the session archive's two keys (T3-9)", async () => {
    const id = await enqueue("which handle?", { route: { kind: "model", tier: "default", model: "haiku", text: "which handle?", routed_by: "rule" } });
    const specs: string[] = [];
    let inFlight: string | undefined;
    const engine: Engine = async (prompt, spec) => {
      specs.push(String(spec.turnId));
      // the row exists before the engine answers, and already names the turn
      const r = await pool.query(`SELECT meta->>'turn_id' AS turn_id FROM runs WHERE component='assistant' AND kind='turn' AND (meta->>'message_id')::bigint = $1`, [id]);
      inFlight = r.rows[0]?.turn_id;
      return fakeEngine(prompt, spec);
    };
    expect(await drainOne(pool, engine, tiers)).toBe(true);
    const run = await pool.query(`SELECT meta->>'turn_id' AS turn_id, meta->>'session_id' AS session_id FROM runs WHERE component='assistant' AND kind='turn' AND (meta->>'message_id')::bigint = $1`, [id]);
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(inFlight).toBe(specs[0]);
    expect(run.rows[0]).toEqual({ turn_id: specs[0], session_id: sdkSession });
  });

  it("second turn on the thread resumes the session", async () => {
    const id = await enqueue("again");
    await drainOne(pool, fakeEngine, tiers);
    const out = await pool.query(`SELECT text FROM outbound_messages WHERE in_reply_to = $1`, [id]);
    expect(out.rows[0].text).toContain("resumed");
    const sess = await pool.query(`SELECT turns FROM sessions WHERE id = $1`, [sdkSession]);
    expect(Number(sess.rows[0].turns)).toBeGreaterThanOrEqual(2);
  });

  it("engine failure marks failed, alerts the thread, logs the error", async () => {
    const id = await enqueue("boom");
    const failing: Engine = async () => { throw new Error("engine exploded"); };
    await drainOne(pool, failing, tiers);
    const inb = await pool.query(`SELECT status FROM inbound_messages WHERE id = $1`, [id]);
    expect(inb.rows[0].status).toBe("failed");
    const out = await pool.query(`SELECT kind FROM outbound_messages WHERE in_reply_to = $1`, [id]);
    expect(out.rows[0].kind).toBe("alert");
  });

  it("returns false when the queue is empty", async () => {
    while (await drainOne(pool, fakeEngine, tiers)) {} // clear other tests' rows
    expect(await drainOne(pool, fakeEngine, tiers)).toBe(false);
  });

  // §4.21 prompt cards: a reply that ENDS with a ```decision block is a
  // blocking question, and lands in the one queue as a `decision` proposal.
  it("turns a trailing decision block into a proposals row, and leaves an ordinary reply alone", async () => {
    const asking: Engine = async () => ({
      text: "either repo works. which one?\n\n```decision\ntitle: Which repo?\noptions:\n- metistry\n- metistry-instance\n```",
      session_id: sdkSession,
    });
    const id = await enqueue("where should this land?");
    expect(await drainOne(pool, asking, tiers)).toBe(true);
    const out = await pool.query(`SELECT id FROM outbound_messages WHERE in_reply_to = $1`, [id]);
    const { rows } = await pool.query(
      `SELECT kind, source_agent, trust, decision, payload FROM proposals WHERE payload->>'thread' = $1`,
      [thread],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "decision", source_agent: "assistant", trust: "internal", decision: "pending" });
    expect(rows[0].payload).toMatchObject({
      title: "Which repo?",
      // v2's record, and — for one pick-one question — v1's options beside it for a client that predates v2
      questions: [{ prompt: "Which repo?", options: ["metistry", "metistry-instance"], multi: false, allow_other: true }],
      options: ["metistry", "metistry-instance"],
      message_id: Number(out.rows[0].id),
      in_reply_to: Number(id),
    });

    // an ordinary reply adds nothing to the queue
    await enqueue("thanks");
    expect(await drainOne(pool, fakeEngine, tiers)).toBe(true);
    const after = await pool.query(`SELECT count(*)::int AS n FROM proposals WHERE payload->>'thread' = $1`, [thread]);
    expect(after.rows[0].n).toBe(1);
    await pool.query(`DELETE FROM proposals WHERE payload->>'thread' = $1`, [thread]);
  });

  it("a v2 block asks several questions in one request — and carries no v1 options, which could answer only one", async () => {
    const asking: Engine = async () => ({
      text: "two things first.\n\n```decision\ntitle: Two things first\nquestion: Which repo?\n- metistry\n- metistry-instance\nquestion: Which labels?\npick: any\nother: no\n- bug\n- docs\n```",
      session_id: sdkSession,
    });
    await enqueue("file it");
    expect(await drainOne(pool, asking, tiers)).toBe(true);
    const { rows } = await pool.query(`SELECT kind, payload FROM proposals WHERE payload->>'thread' = $1`, [thread]);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("decision");
    expect(rows[0].payload.title).toBe("Two things first");
    expect(rows[0].payload.questions).toEqual([
      { prompt: "Which repo?", options: ["metistry", "metistry-instance"], multi: false, allow_other: true },
      { prompt: "Which labels?", options: ["bug", "docs"], multi: true, allow_other: false },
    ]);
    expect(rows[0].payload).not.toHaveProperty("options");
    await pool.query(`DELETE FROM proposals WHERE payload->>'thread' = $1`, [thread]);
  });

  // --- tiers are (model, effort) pairs; the drain is where a NAME becomes one ---

  it("resolves the route's tier through the tier map — model AND effort — and records both on the run row", async () => {
    const id = await enqueue("think hard", { route: { kind: "model", tier: "deep", text: "think hard", routed_by: "override" } });
    expect(await drainOne(pool, fakeEngine, tiers)).toBe(true);
    const out = await pool.query(`SELECT text FROM outbound_messages WHERE in_reply_to = $1`, [id]);
    expect(out.rows[0].text).toContain("echo(opus/high");
    const run = await pool.query(
      `SELECT model, meta->>'tier' AS tier, meta->>'effort' AS effort, meta->>'routed_by' AS routed_by, (meta->>'session_turns')::int AS session_turns
       FROM runs WHERE component='assistant' AND kind='turn' AND (meta->>'message_id')::bigint = $1`,
      [id],
    );
    expect(run.rows[0]).toMatchObject({ model: "opus", tier: "deep", effort: "high", routed_by: "override" });
    expect(run.rows[0].session_turns).toBeGreaterThanOrEqual(1); // per-session turn count, recorded per turn
  });

  it("an unknown tier name lands on default — never on an invented model", async () => {
    const id = await enqueue("hi", { route: { kind: "model", tier: "gpt99", text: "hi", routed_by: "rule" } });
    await drainOne(pool, fakeEngine, tiers);
    const run = await pool.query(
      `SELECT model, meta->>'tier' AS tier, meta->>'effort' AS effort FROM runs WHERE component='assistant' AND kind='turn' AND (meta->>'message_id')::bigint = $1`,
      [id],
    );
    expect(run.rows[0]).toMatchObject({ model: "haiku", tier: "default", effort: "medium" });
  });

  // --- fresh sessions at task boundaries (cost research decision 3) ---

  it("a routine-enqueued turn (meta.tier routine + fresh_session) runs cheap and NEVER resumes", async () => {
    const foldThread = `fold-${Date.now()}`;
    const priorSession = randomUUID();
    await pool.query(`INSERT INTO sessions (id, thread, turns) VALUES ($1, $2, 4)`, [priorSession, foldThread]);
    const { rows } = await pool.query(
      `INSERT INTO inbound_messages (thread, text, meta) VALUES ($1, $2, $3) RETURNING id`,
      [foldThread, "fold it", JSON.stringify({ kind: "fold", tier: "routine", fresh_session: true })],
    );
    const foldSession = randomUUID();
    const engine: Engine = async (prompt, spec) => ({ text: `echo(${spec.model}/${spec.effort}${spec.resume ? ",resumed" : ""}): ${prompt}`, session_id: foldSession });
    expect(await drainOne(pool, engine, tiers)).toBe(true);
    const out = await pool.query(`SELECT text FROM outbound_messages WHERE in_reply_to = $1`, [rows[0].id]);
    expect(out.rows[0].text).toContain("echo(haiku/low");
    expect(out.rows[0].text).not.toContain("resumed"); // the prior session on the thread is left where it was
    const run = await pool.query(
      `SELECT meta->>'tier' AS tier, meta->>'effort' AS effort, (meta->>'fresh_session')::boolean AS fresh FROM runs
       WHERE component='assistant' AND kind='turn' AND (meta->>'message_id')::bigint = $1`,
      [rows[0].id],
    );
    expect(run.rows[0]).toMatchObject({ tier: "routine", effort: "low", fresh: true });
  });

  it("closing a task the assistant held rolls the thread's session, logs a session_roll run, and the NEXT turn starts fresh", async () => {
    const taskThread = `task-${Date.now()}`;
    const first = randomUUID();
    const { rows: workRows } = await pool.query(
      `INSERT INTO work (title, kind, status, claimed_by) VALUES ('a task the assistant held', 'task', 'in_progress', 'assistant') RETURNING id`,
    );
    const taskId = Number(workRows[0].id);
    await pool.query(`INSERT INTO inbound_messages (thread, text) VALUES ($1, 'close it')`, [taskThread]);
    // the turn closes it the way `tasks_update` does: status, closed_at, and an
    // append to `history` naming the agent — which is the evidence the drain reads
    const closer: Engine = async () => {
      await pool.query(
        `UPDATE work SET status = 'closed', closed_at = now(), claimed_by = NULL,
           history = history || jsonb_build_array(jsonb_build_object('ts', now(), 'agent', 'assistant', 'op', 'update', 'status', 'closed'))
         WHERE id = $1`,
        [taskId],
      );
      return { text: "closed it", session_id: first, tools_used: { mcp__brain__tasks_update: 1 } };
    };
    expect(await drainOne(pool, closer, tiers)).toBe(true);

    const sess = await pool.query(`SELECT status FROM sessions WHERE id = $1`, [first]);
    expect(sess.rows[0].status).toBe("rolled");
    const roll = await pool.query(
      `SELECT meta->>'reason' AS reason, (meta->>'turns')::int AS turns FROM runs
       WHERE kind = 'session_roll' AND meta->>'thread' = $1`,
      [taskThread],
    );
    expect(roll.rows).toHaveLength(1);
    expect(roll.rows[0].reason).toBe(`task_closed:#${taskId}`);
    expect(roll.rows[0].turns).toBe(1); // the per-session turn count, recorded on the way out

    // the next turn finds nothing active to resume
    await pool.query(`INSERT INTO inbound_messages (thread, text) VALUES ($1, 'and now?')`, [taskThread]);
    const second = randomUUID();
    let sawResume: string | undefined = "unset";
    const next: Engine = async (_p, spec) => { sawResume = spec.resume; return { text: "fresh", session_id: second }; };
    expect(await drainOne(pool, next, tiers)).toBe(true);
    expect(sawResume).toBeUndefined();
  });
});

// ---- a provider that refuses the account (402 / 401 / 403) -------------------
//
// The 0.14.2 owner report, as a fixture: OpenRouter answered 402 "requires
// more credits", and the turn was tried again, failed quietly and left
// nothing that said what to do. A fake OpenAI-compatible server stands in for
// the provider; the engine is the real in-house loop.

const REFUSING_FILE = `
providers:
  openrouter:
    kind: openai-compatible
    base_url: https://openrouter.ai/api/v1
    locality: off_machine
    auth: { secret: METISTRY_OPENROUTER_API_KEY }
    zdr: true
    data_policy: { allow: [Projects], deny_sources: [], max_brief_bytes: 4096 }
assignments:
  default: { model: openrouter/anthropic/claude-sonnet-5, effort: medium, max_output_tokens: 4096 }
`;

const CREDITS_402 = {
  status: 402,
  body: { error: { code: 402, message: "This request requires more credits, or fewer max_tokens. You requested up to 65536 tokens, but can only afford 3999." } },
};

describe.skipIf(!hasDb)("assistant drain — a provider that refused the account", () => {
  let pool: pg.Pool;
  const thread = `refused-${Date.now()}`;
  const compute = parseCompute(REFUSING_FILE);
  /** Every request the fake provider saw, and what it answers next (the last entry repeats). */
  let answers: Array<{ status: number; body: unknown }> = [];
  const seen: any[] = [];
  const fetchFn = (async (_url: unknown, init: any) => {
    seen.push(JSON.parse(String(init.body)));
    const next = answers.length > 1 ? answers.shift()! : answers[0]!;
    return {
      ok: next.status < 400,
      status: next.status,
      headers: new Headers(),
      json: async () => next.body,
      text: async () => JSON.stringify(next.body),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  const engine = makeOpenAiEngine({
    tools: () => NO_TOOLS,
    sessions: memorySessionStore(),
    env: { METISTRY_OPENROUTER_API_KEY: "sk-test" },
    fetchFn,
    sleep: async () => {},
  });
  const LONG = 60 * 60_000; // no probe falls due inside a test
  /** Reports from earlier runs of this suite on the same scratch db are not this run's. */
  let since = 0;
  const drain = (probeMs = LONG) => drainOne(pool, engine, tiers, { compute: () => compute, probeMs });
  const reports = async () =>
    (
      await pool.query(
        `SELECT id, decision, payload FROM proposals WHERE id > $1 AND kind = 'report' AND source->>'kind' = 'metistry' AND source->>'external_ref' = 'provider-refused:openrouter#credits' ORDER BY id`,
        [since],
      )
    ).rows;
  const status = async (id: number) => (await pool.query(`SELECT status FROM inbound_messages WHERE id = $1`, [id])).rows[0].status;
  const enqueue = async (text: string) =>
    Number((await pool.query(`INSERT INTO inbound_messages (thread, text, meta) VALUES ($1, $2, '{}') RETURNING id`, [thread, text])).rows[0].id);

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
    await pool.query(`UPDATE inbound_messages SET status = 'done' WHERE status IN ('new', 'held')`);
    await pool.query(`UPDATE proposals SET decision = 'skip' WHERE decision = 'pending' AND source->>'external_ref' LIKE 'provider-refused:%'`);
    since = Number((await pool.query(`SELECT coalesce(max(id), 0) AS id FROM proposals`)).rows[0].id);
  });
  afterAll(async () => pool.end());

  it("a 402 is tried ONCE — not again on a fresh session — fails the message with the provider's words, and raises ONE report", async () => {
    answers = [CREDITS_402];
    seen.length = 0;
    // an active session on the thread: the stale-session fallback would have
    // been the second attempt
    await pool.query(`INSERT INTO sessions (id, thread) VALUES ($1, $2)`, [randomUUID(), thread]);
    const id = await enqueue("what's on today?");
    expect(await drain()).toBe(true);

    expect(seen).toHaveLength(1);
    expect(seen[0].max_tokens).toBe(4096); // the tier's ceiling, never the model's 65536
    expect(await status(id)).toBe("failed");
    const runs = await pool.query(`SELECT ok, error FROM runs WHERE component = 'assistant' AND kind = 'turn' AND (meta->>'message_id')::bigint = $1`, [id]);
    expect(runs.rows).toHaveLength(1);
    expect(runs.rows[0].ok).toBe(false);
    expect(runs.rows[0].error).toMatch(/returned 402/);
    const reply = await pool.query(`SELECT text, kind FROM outbound_messages WHERE in_reply_to = $1`, [id]);
    expect(reply.rows).toHaveLength(1);
    expect(reply.rows[0].kind).toBe("alert");
    expect(reply.rows[0].text).toContain("requires more credits");
    expect(reply.rows[0].text).not.toContain("that turn failed");

    const [report, ...more] = await reports();
    expect(more).toEqual([]);
    expect(report.decision).toBe("pending");
    expect(report.payload).toMatchObject({ event: "provider_refused", provider: "openrouter", status: 402, error_class: "credits", top_up: "https://openrouter.ai/settings/credits", waiting: 0 });
    expect(report.payload.title).toBe("openrouter: out of credits — top up at https://openrouter.ai/settings/credits; 0 turns waiting");
    expect(report.payload.body).toContain("can only afford 3999");
  });

  it("while the report waits, turns for that provider are HELD — never sent — and counted on the one report", async () => {
    seen.length = 0;
    const a = await enqueue("and tomorrow?");
    const b = await enqueue("hello?");
    expect(await drain()).toBe(true);
    expect(await drain()).toBe(true);
    expect(await drain()).toBe(false); // nothing left to claim: held is not new

    expect(seen).toHaveLength(0);
    expect(await status(a)).toBe("held");
    expect(await status(b)).toBe("held");
    const rows = await reports();
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.waiting).toBe(2);
    expect(rows[0].payload.title).toMatch(/; 2 turns waiting$/);
  });

  it("the probe: once due, the oldest held turn is tried alone; refused again, it goes back to waiting and no second report is raised", async () => {
    seen.length = 0;
    const [a] = (await pool.query(`SELECT id FROM inbound_messages WHERE status = 'held' ORDER BY ts LIMIT 1`)).rows.map((r) => Number(r.id));
    expect(await drain(0)).toBe(true);
    expect(seen).toHaveLength(1);
    expect(await status(a!)).toBe("held");
    const rows = await reports();
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.waiting).toBe(2);
    // no alert per probe: the report is the one place it is said
    const alerts = await pool.query(`SELECT 1 FROM outbound_messages WHERE in_reply_to = $1`, [a]);
    expect(alerts.rows).toHaveLength(0);
  });

  it("a later turn that gets through clears the report at its source, and every held turn is released and answered", async () => {
    seen.length = 0;
    answers = [{ status: 200, body: { choices: [{ message: { role: "assistant", content: "topped up, here you go" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } } }];
    const held = (await pool.query(`SELECT id FROM inbound_messages WHERE status = 'held' ORDER BY ts`)).rows.map((r) => Number(r.id));
    expect(held).toHaveLength(2);
    expect(await drain(0)).toBe(true); // the probe, which succeeds
    const rows = await reports();
    expect(rows[0].decision).toBe("resolved_at_source");
    while (await drain()) {} // the rest were released on the next pass
    for (const id of held) expect(await status(id)).toBe("done");
    expect(seen).toHaveLength(2);
  });

  it("dismissing the report releases the held turns too", async () => {
    answers = [CREDITS_402];
    await enqueue("first after the top-up ran out again");
    expect(await drain()).toBe(true);
    const waiting = await enqueue("second");
    expect(await drain()).toBe(true);
    expect(await status(waiting)).toBe("held");
    const [, report] = await reports();
    expect(report.decision).toBe("pending");
    await pool.query(`UPDATE proposals SET decision = 'skip', decided_at = now() WHERE id = $1`, [report.id]);

    answers = [{ status: 200, body: { choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } } }];
    expect(await drain()).toBe(true);
    expect(await status(waiting)).toBe("done");
  });

  it("a 401 is its own report — the key, not the credits — and is not retried either", async () => {
    seen.length = 0;
    answers = [{ status: 401, body: { error: { message: "No auth credentials found" } } }];
    const id = await enqueue("key?");
    expect(await drain()).toBe(true);
    expect(seen).toHaveLength(1);
    expect(await status(id)).toBe("failed");
    const r = await pool.query(`SELECT payload FROM proposals WHERE id > $1 AND decision = 'pending' AND source->>'external_ref' = 'provider-refused:openrouter#credential'`, [since]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].payload.title).toBe("openrouter: the key was refused (HTTP 401) — replace it in Settings › Secrets; 0 turns waiting");
    await pool.query(`UPDATE proposals SET decision = 'skip' WHERE decision = 'pending' AND source->>'external_ref' LIKE 'provider-refused:%'`);
  });
});
