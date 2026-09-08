// reply-review against the real (scratch) database: only Postgres can prove
// the LATERAL join from a 👎 back to the turn that produced the reply, and the
// idempotency check that reads its own proposal's payload. The fake-db suite
// proves the rendering; the weekly review's new line is asserted there too.
// Every row carries an `itest-reply` marker and is removed again.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { run as replyReview } from "../reply-review/run.js";

try {
  for (const line of readFileSync(new URL("../../.env", import.meta.url), "utf8").split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m && m[1] && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {}

const hasDb = !!process.env.METISTRY_DB_PASSWORD;
const now = new Date(2026, 8, 8, 12, 0, 0);
const THREAD = "itest-reply";

describe.skipIf(!hasDb)("reply-review (real db)", () => {
  let pool: pg.Pool;
  const cleanup = async () => {
    await pool.query(`DELETE FROM proposals WHERE source_agent = 'reply-review' AND payload->>'window_end' = '2026-09-08'`);
    await pool.query(`DELETE FROM runs WHERE component = 'itest-reply-assistant'`);
    await pool.query(`DELETE FROM outbound_messages WHERE thread = $1`, [THREAD]);
    await pool.query(`DELETE FROM inbound_messages WHERE thread = $1`, [THREAD]);
  };
  beforeAll(async () => {
    pool = new pg.Pool({
      host: process.env.METISTRY_DB_HOST ?? "127.0.0.1",
      port: Number(process.env.METISTRY_DB_PORT ?? 5432),
      user: process.env.METISTRY_DB_USER ?? "metistry",
      database: process.env.METISTRY_TEST_DB_NAME ?? "metistry_test",
      password: process.env.METISTRY_DB_PASSWORD,
    });
    await cleanup();
  });
  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it("joins a 👎 to its prompt and its turn's tool calls, and emits exactly one proposal", async () => {
    const inb = await pool.query(
      `INSERT INTO inbound_messages (thread, text, status, ts) VALUES ($1, 'what is open on drey?', 'done', '2026-09-05T10:00:00Z') RETURNING id`,
      [THREAD],
    );
    const inId = inb.rows[0].id;
    const out = await pool.query(
      `INSERT INTO outbound_messages (thread, text, in_reply_to, ts) VALUES ($1, 'probably a few things', $2, '2026-09-05T10:00:05Z') RETURNING id`,
      [THREAD, inId],
    );
    const outId = out.rows[0].id;
    // the turn behind that reply: the assistant stamps message_id, tools_used
    await pool.query(
      `INSERT INTO runs (component, kind, model, ok, ts, started_at, finished_at, meta)
       VALUES ('itest-reply-assistant', 'turn', 'haiku', true, '2026-09-05T10:00:05Z', '2026-09-05T10:00:00Z', '2026-09-05T10:00:05Z', $1)`,
      [JSON.stringify({ message_id: inId, thread: THREAD, tools_used: { mcp__brain__knowledge_search: 2 } })],
    );
    // an unrated reply and a 👍 must not appear in the proposal
    const fine = await pool.query(
      `INSERT INTO outbound_messages (thread, text, ts) VALUES ($1, 'a good one', '2026-09-05T11:00:00Z') RETURNING id`,
      [THREAD],
    );
    await pool.query(`INSERT INTO reply_feedback (outbound_message_id, rating, ts) VALUES ($1, 1, '2026-09-05T11:01:00Z')`, [fine.rows[0].id]);
    await pool.query(
      `INSERT INTO reply_feedback (outbound_message_id, rating, note, ts) VALUES ($1, -1, 'guessed instead of looking it up', '2026-09-05T10:01:00Z')`,
      [outId],
    );

    expect(await replyReview(pool, { now })).toBe(1);
    const { rows } = await pool.query(
      `SELECT kind, source_agent, trust, decision, payload FROM proposals
       WHERE source_agent = 'reply-review' AND payload->>'window_end' = '2026-09-08'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "improvement", trust: "internal", decision: "pending" });
    const p = rows[0].payload;
    expect(p.flagged).toHaveLength(1);
    expect(p.flagged[0]).toMatchObject({
      message_id: Number(outId),
      prompt: "what is open on drey?",
      reply: "probably a few things",
      model: "haiku",
      note: "guessed instead of looking it up",
      tools: ["mcp__brain__knowledge_search"],
    });
    expect(p.suggested_edit.path).toBe("assistant-prompt.md");
    expect(p.suggested_edit.content).toContain("guessed instead of looking it up");

    // a second pass adds nothing — the pending proposal for this window already exists
    expect(await replyReview(pool, { now })).toBe(0);
    const again = await pool.query(
      `SELECT count(*)::int AS n FROM proposals WHERE source_agent = 'reply-review' AND payload->>'window_end' = '2026-09-08'`,
    );
    expect(again.rows[0].n).toBe(1);
  });

});
