// Drain loop against the real db with a fake engine (the SDK is smoked
// manually — this proves claim/reply/session/runs mechanics).
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { drainOne } from "../src/drain.js";
import type { Engine } from "../src/engine.js";

try {
  for (const line of readFileSync(new URL("../../../.env", import.meta.url), "utf8").split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m && m[1] && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {}

const hasDb = !!process.env.METISTRY_DB_PASSWORD;

describe.skipIf(!hasDb)("assistant drain", () => {
  let pool: pg.Pool;
  const thread = `t-${Date.now()}`;
  const sdkSession = randomUUID();

  const fakeEngine: Engine = async (prompt, model, resume) => ({
    text: `echo(${model}${resume ? ",resumed" : ""}): ${prompt}`,
    session_id: sdkSession,
    tokens_in: 10,
    tokens_out: 5,
    cost_usd: 0.001,
    tools_used: { mcp__brain__capture: 1 },
  });

  beforeAll(async () => {
    pool = new pg.Pool({
      host: process.env.METISTRY_DB_HOST ?? "127.0.0.1",
      user: process.env.METISTRY_DB_USER ?? "metistry",
      database: process.env.METISTRY_TEST_DB_NAME ?? "metistry_test", // scratch db (ops/scripts/test-db.sh)
      password: process.env.METISTRY_DB_PASSWORD,
    });
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
    expect(await drainOne(pool, fakeEngine, "haiku")).toBe(true);
    const inb = await pool.query(`SELECT status, session_id FROM inbound_messages WHERE id = $1`, [id]);
    expect(inb.rows[0]).toEqual({ status: "done", session_id: sdkSession });
    const out = await pool.query(`SELECT text FROM outbound_messages WHERE in_reply_to = $1`, [id]);
    expect(out.rows[0].text).toContain("echo(haiku");
    const sess = await pool.query(`SELECT thread FROM sessions WHERE id = $1`, [sdkSession]);
    expect(sess.rows[0].thread).toBe(thread);
    const run = await pool.query(
      `SELECT ok, tokens_in, tokens_out, cost_usd::float8 AS cost_usd, meta->'tools_used' AS tools_used, meta->>'thread' AS thread, finished_at IS NOT NULL AS finished FROM runs
       WHERE component='assistant' AND kind='turn' AND (meta->>'message_id')::bigint = $1`,
      [id],
    );
    // the turn row keeps tokens/cost AND names the tools it called (each call is also its own runs row via mcp-brain)
    expect(run.rows[0]).toMatchObject({ ok: true, tokens_in: 10, tokens_out: 5, cost_usd: 0.001, tools_used: { mcp__brain__capture: 1 }, thread, finished: true });
  });

  it("second turn on the thread resumes the session", async () => {
    const id = await enqueue("again");
    await drainOne(pool, fakeEngine, "haiku");
    const out = await pool.query(`SELECT text FROM outbound_messages WHERE in_reply_to = $1`, [id]);
    expect(out.rows[0].text).toContain("resumed");
    const sess = await pool.query(`SELECT turns FROM sessions WHERE id = $1`, [sdkSession]);
    expect(Number(sess.rows[0].turns)).toBeGreaterThanOrEqual(2);
  });

  it("engine failure marks failed, alerts the thread, logs the error", async () => {
    const id = await enqueue("boom");
    const failing: Engine = async () => { throw new Error("engine exploded"); };
    await drainOne(pool, failing, "haiku");
    const inb = await pool.query(`SELECT status FROM inbound_messages WHERE id = $1`, [id]);
    expect(inb.rows[0].status).toBe("failed");
    const out = await pool.query(`SELECT kind FROM outbound_messages WHERE in_reply_to = $1`, [id]);
    expect(out.rows[0].kind).toBe("alert");
  });

  it("returns false when the queue is empty", async () => {
    while (await drainOne(pool, fakeEngine, "haiku")) {} // clear other tests' rows
    expect(await drainOne(pool, fakeEngine, "haiku")).toBe(false);
  });
});
