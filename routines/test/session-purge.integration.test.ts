// session-purge against the real (scratch) database — the session archive's
// retention (T3-9, migration 0030, §4 Q16). What only Postgres can prove:
//
//   * the scheduled purge deletes what is past `expires_at` and what is older
//     than `retention_days`, and nothing else — a fresh unfolded turn stays in
//     the fold's queue, an old unfolded one does not (expiry wins);
//   * Purge Now's preview names the unfolded sessions and deletes nothing;
//   * Purge Now deletes folded and unfolded alike, and with the preview's
//     `as_of` it deletes exactly what was counted — a turn archived after it
//     is kept.
//
// This file owns `session_archive` within the routines package (no other
// file here touches it), so the counts below are exact.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";
import { DEFAULT_RETENTION_DAYS, purgeArchive, purgePreview, retentionDays, run } from "../session-purge/run.js";

const { hasDb } = loadTestEnv(new URL("../../.env", import.meta.url));

describe("retention_days — the routine's Scheduled config", () => {
  it("absent is the ruling's 30 days", () => {
    expect(retentionDays()).toBe(30);
    expect(retentionDays({})).toBe(DEFAULT_RETENTION_DAYS);
  });

  it("a whole number of days from 1 to 30 is taken as written", () => {
    expect(retentionDays({ retention_days: 1 })).toBe(1);
    expect(retentionDays({ retention_days: 7 })).toBe(7);
    expect(retentionDays({ retention_days: 30 })).toBe(30);
  });

  it("anything else is refused with the field named — never clamped, never read as keep-all or keep-none", () => {
    for (const bad of [0, 31, 365, -1, 7.5, "7", null, true]) {
      expect(() => retentionDays({ retention_days: bad }), JSON.stringify(bad)).toThrow(/config\.retention_days .* whole number of days from 1 to 30.*nothing was purged/);
    }
  });
});

describe.skipIf(!hasDb)("session-purge (real db)", () => {
  let pool: pg.Pool;

  /** One archived turn: `age` days old, expiring `expiresIn` days from now (negative = already expired), folded or not. */
  async function turn(session: string, turnId: string, o: { age: number; expiresIn: number; folded?: boolean; thread?: string }): Promise<void> {
    await pool.query(
      `INSERT INTO session_archive (session_id, thread, turn_id, ts, system_prompt, messages, tool_calls, folded_at, expires_at)
       VALUES ($1, $2, $3, now() - make_interval(days => $4::int), 'p', '[]', '[]',
               CASE WHEN $5 THEN now() END, now() + make_interval(days => $6::int))`,
      [session, o.thread ?? "default", turnId, o.age, o.folded === true, o.expiresIn],
    );
  }
  const left = async (): Promise<string[]> => (await pool.query(`SELECT turn_id FROM session_archive ORDER BY turn_id`)).rows.map((r) => r.turn_id);

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
  });
  beforeEach(async () => {
    await pool.query(`DELETE FROM session_archive`);
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM session_archive`);
    await pool.end();
  });

  it("the scheduled run deletes what has expired — unfolded or not — and keeps a fresh unfolded turn in the fold's queue", async () => {
    const a = randomUUID();
    const b = randomUUID();
    await turn(a, "a-expired-unfolded", { age: 31, expiresIn: -1 });
    await turn(a, "a-expired-folded", { age: 31, expiresIn: -1, folded: true });
    await turn(b, "b-fresh-unfolded", { age: 1, expiresIn: 29 });
    await turn(b, "b-fresh-folded", { age: 2, expiresIn: 28, folded: true });

    expect(await run(pool)).toBe(2);
    expect(await left()).toEqual(["b-fresh-folded", "b-fresh-unfolded"]);
    const q = await pool.query(`SELECT turn_id FROM session_archive WHERE folded_at IS NULL`);
    expect(q.rows.map((r) => r.turn_id)).toEqual(["b-fresh-unfolded"]); // still queued for the fold, untouched

    expect(await run(pool)).toBe(0); // silent when there is nothing to do
  });

  it("a shorter retention_days deletes what is older than it, even before expiry — and a bad one deletes nothing", async () => {
    const s = randomUUID();
    await turn(s, "old", { age: 10, expiresIn: 20 });
    await turn(s, "new", { age: 3, expiresIn: 27 });

    await expect(run(pool, { config: { retention_days: 45 } })).rejects.toThrow(/retention_days/);
    expect(await left()).toEqual(["new", "old"]);

    expect(await run(pool, { config: { retention_days: 7 } })).toBe(1);
    expect(await left()).toEqual(["new"]);
  });

  it("Purge Now's preview counts everything, names only the sessions the fold could still read, and deletes nothing", async () => {
    const unfolded = randomUUID();
    const folded = randomUUID();
    const expired = randomUUID();
    await turn(unfolded, "u1", { age: 2, expiresIn: 28, thread: "default" });
    await turn(unfolded, "u2", { age: 1, expiresIn: 29, thread: "default", folded: true });
    await turn(folded, "f1", { age: 1, expiresIn: 29, folded: true });
    await turn(expired, "e1", { age: 31, expiresIn: -1 }); // unfolded, but past saving

    const p = await purgePreview(pool);
    expect(p).toMatchObject({ sessions: 3, turns: 4, sessions_unfolded: 1 });
    expect(p.unfolded).toEqual([
      { session_id: unfolded, thread: "default", turns: 2, unfolded_turns: 1, first_ts: expect.any(String), last_ts: expect.any(String) },
    ]);
    expect(Number.isNaN(Date.parse(p.as_of))).toBe(false);
    expect(await left()).toHaveLength(4);
  });

  it("Purge Now deletes folded and unfolded alike; with the preview's as_of, a turn archived after it is kept", async () => {
    const s = randomUUID();
    await turn(s, "counted-unfolded", { age: 1, expiresIn: 29 });
    await turn(s, "counted-folded", { age: 1, expiresIn: 29, folded: true });
    const p = await purgePreview(pool);
    await pool.query(
      `INSERT INTO session_archive (session_id, thread, turn_id, ts, system_prompt, messages, tool_calls, expires_at)
       VALUES ($1, 'default', 'archived-after-the-preview', $2::timestamptz + interval '1 second', 'p', '[]', '[]', now() + interval '30 days')`,
      [s, p.as_of],
    );

    const gone = await purgeArchive(pool, new Date(p.as_of));
    expect(gone).toEqual({ sessions: 1, turns: 2, sessions_unfolded: 1 });
    expect(await left()).toEqual(["archived-after-the-preview"]);

    // …and with no bound, everything
    expect(await purgeArchive(pool)).toEqual({ sessions: 1, turns: 1, sessions_unfolded: 1 });
    expect(await left()).toEqual([]);
  });
});
