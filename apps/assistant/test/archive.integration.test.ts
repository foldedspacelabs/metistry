// The session archive against the real schema (migration 0030; scratch db
// only — docs/ops/testing.md). What only a database can prove about the
// writer (T3-9):
//
//   * a turn lands as one row with `expires_at` 30 days out on the
//     DATABASE's clock and `folded_at` NULL — in the fold's queue on arrival;
//   * what reaches the jsonb columns is already redacted;
//   * a retried append of the same (session, turn) is a no-op, never a
//     second row (the unique index 0030 ships);
//   * `session_detail` — Run detail's read path — returns what was written.
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";
import { REDACTED } from "@foldedspacelabs/metistry-core";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { pgSessionArchive } from "../src/archive.js";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url));
const SEED_QUERIES = fileURLToPath(new URL("../../../seed/queries", import.meta.url));

describe.skipIf(!hasDb)("the session archive against the scratch db", () => {
  let pool: pg.Pool;
  const sessions: string[] = [];

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM session_archive WHERE session_id = ANY($1::uuid[])`, [sessions]);
    await pool.end();
  });

  it("appends one redacted, unfolded row that expires 30 days out — and a retried append is a no-op", async () => {
    const session = randomUUID();
    sessions.push(session);
    const archive = pgSessionArchive(pool);
    const turn = {
      session_id: session,
      thread: "default",
      turn_id: "it-turn-1",
      system_prompt: "you are the instance's assistant",
      messages: [
        { role: "user" as const, content: "what is the wifi password?" },
        { role: "assistant" as const, content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "mcp__brain__knowledge_read", arguments: JSON.stringify({ path: "Areas/Home.md", api_key: "sk-live-abc" }) } }] },
        { role: "tool" as const, tool_call_id: "c1", name: "mcp__brain__knowledge_read", content: JSON.stringify({ text: "…", password: "correct-horse" }) },
        { role: "assistant" as const, content: "It is on the router's label." },
      ],
      tool_calls: [{ id: "c1", tool: "mcp__brain__knowledge_read", args: { path: "Areas/Home.md", api_key: "sk-live-abc" }, result: JSON.stringify({ text: "…", password: "correct-horse" }), is_error: false }],
    };
    await archive.append(turn);
    await archive.append({ ...turn, system_prompt: "a retry must not overwrite the first write" });

    const { rows } = await pool.query(
      `SELECT thread, turn_id, system_prompt, messages, tool_calls, folded_at,
              expires_at - ts AS ttl, extract(epoch FROM (expires_at - now())) / 86400 AS days_left
       FROM session_archive WHERE session_id = $1`,
      [session],
    );
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.system_prompt).toBe("you are the instance's assistant");
    expect(row.folded_at).toBeNull(); // in the fold's queue on arrival
    expect(Number(row.days_left)).toBeGreaterThan(29.99);
    expect(Number(row.days_left)).toBeLessThanOrEqual(30);
    expect(row.tool_calls[0].args).toEqual({ path: "Areas/Home.md", api_key: REDACTED });
    expect(row.tool_calls[0].result).toEqual({ text: "…", password: REDACTED });
    const stored = JSON.stringify([row.messages, row.tool_calls]);
    expect(stored).not.toContain("sk-live-abc");
    expect(stored).not.toContain("correct-horse");
  });

  it("session_detail reads back what the writer wrote, oldest turn first", async () => {
    const session = randomUUID();
    sessions.push(session);
    const archive = pgSessionArchive(pool);
    for (const [i, text] of ["first", "second"].entries()) {
      await archive.append({ session_id: session, thread: "default", turn_id: `it-turn-${i}`, system_prompt: "p", messages: [{ role: "user", content: text }], tool_calls: [] });
    }
    const queries = new QueryStore(pool);
    await queries.loadDir(SEED_QUERIES);
    const got = (await queries.run("session_detail", { session_id: session })).rows;
    expect(got.map((r: any) => r.turn_id)).toEqual(["it-turn-0", "it-turn-1"]);
    expect(got[0].messages).toEqual([{ role: "user", content: "first" }]);
  });
});
