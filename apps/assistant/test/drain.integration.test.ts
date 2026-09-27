// Drain loop against the real db with a fake engine (the SDK is smoked
// manually — this proves claim/reply/session/runs mechanics).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { drainOne } from "../src/drain.js";
import type { Engine } from "../src/engine.js";
import type { TierMap } from "@foldedspacelabs/metistry-core";
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
