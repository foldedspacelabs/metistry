// Mirrors against the real (scratch) database — migration 0027, T1-8. The
// fake-executor tests in packages/core/test/mirrors.test.ts prove what is
// sent; only Postgres can prove the unique index, the CHECK, and the morning
// brief's expiry actually skipping a row with a `source`.
//
// ISOLATION. The weekly review's suite TRUNCATEs `proposals` when it starts,
// and the morning brief's expiry is a whole-table UPDATE, so neither this
// suite's rows nor its brief may be visible to a sibling running beside it.
// Every case therefore runs on ONE client inside a transaction that is
// ROLLED BACK — the rows exist only for the statements that assert on them —
// including the in-flight raise, which uses two connections and rolls both
// back.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { RESOLVED_AT_SOURCE, raiseMirror, resolveAtSource, type MirrorRaise } from "@foldedspacelabs/metistry-core";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";
import { run as morningBrief } from "../morning-brief/run.js";

const { hasDb } = loadTestEnv(new URL("../../.env", import.meta.url)); // METISTRY_DB_* only, and nothing of the operator's install (docs/ops/testing.md)

const SEED = fileURLToPath(new URL("../../seed/", import.meta.url));
const TAG = `itest-mirrors-${process.pid}-${Date.now()}`;
const pr = (n: number) => ({ kind: "github", external_ref: `gh:itest/${TAG}#${n}`, person: "owner" });
const raise = (n: number, o: Partial<MirrorRaise> = {}): MirrorRaise => ({
  kind: "pull_request",
  source_agent: TAG,
  trust: "internal",
  payload: { title: `PR ${n}` },
  source: pr(n),
  ...o,
});

describe.skipIf(!hasDb)("mirrors (real db, migration 0027)", () => {
  let pool: pg.Pool;

  /** Run `fn` on one client inside a transaction that never commits. */
  const rolledBack = async <T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      return await fn(c);
    } finally {
      await c.query("ROLLBACK").catch(() => {});
      c.release();
    }
  };
  const count = async (c: pg.PoolClient, ref: string, decision = "pending") =>
    Number((await c.query(`SELECT count(*) AS n FROM proposals WHERE source->>'external_ref' = $1 AND decision = $2`, [ref, decision])).rows[0].n);

  beforeAll(async () => {
    pool = await testDb(pg.Pool, { max: 4 });
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM proposals WHERE source_agent = $1`, [TAG]);
    await pool.end();
  });

  it("two raises for one PR make one row", async () => {
    await rolledBack(async (c) => {
      const first = await raiseMirror(c, raise(1));
      const second = await raiseMirror(c, raise(1, { payload: { title: "raised again by the next sync" } }));
      expect(first.raised).toBe(true);
      expect(second).toEqual({ id: first.id, raised: false });
      expect(await count(c, pr(1).external_ref)).toBe(1);
      // the first row is left as it was — the second raise rewrites nothing
      const { rows } = await c.query(`SELECT payload->>'title' AS title, source FROM proposals WHERE id = $1`, [first.id]);
      expect(rows[0]).toEqual({ title: "PR 1", source: pr(1) });
    });
  });

  it("dedupe is the database's: a hand-written second INSERT for the same pending subject is refused", async () => {
    await rolledBack(async (c) => {
      await raiseMirror(c, raise(2));
      await c.query("SAVEPOINT dup");
      await expect(
        c.query(`INSERT INTO proposals (kind, source_agent, trust, payload, source) VALUES ('pull_request', $1, 'internal', '{}', $2::jsonb)`, [TAG, JSON.stringify(pr(2))]),
      ).rejects.toMatchObject({ code: "23505", constraint: "proposals_source_pending_uidx" });
      await c.query("ROLLBACK TO SAVEPOINT dup");
      // the same external_ref from another source system is another subject
      const other = await raiseMirror(c, raise(2, { source: { kind: "linear", external_ref: pr(2).external_ref } }));
      expect(other.raised).toBe(true);
      expect(await count(c, pr(2).external_ref)).toBe(2);
    });
  });

  it("a raise cannot slip past another raise of the same subject still in flight: it waits for it", async () => {
    // Nothing here commits: the weekly review's suite counts every pending
    // row in the database, so a committed fixture — however briefly — is a
    // sibling's flake. What commit-vs-conflict does after the wait is
    // Postgres's ON CONFLICT contract; what this proves is that the unique
    // index makes the second raise WAIT rather than insert a twin.
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      await a.query("BEGIN");
      await b.query("BEGIN");
      const first = await raiseMirror(a, raise(3));
      let settled = false;
      const second = raiseMirror(b, raise(3)).finally(() => (settled = true));
      await new Promise((r) => setTimeout(r, 150));
      expect(settled).toBe(false); // blocked on A's uncommitted index entry
      await a.query("ROLLBACK"); // the first never happened, so the subject is free
      const got = await second;
      expect(got.raised).toBe(true);
      expect(got.id).not.toBe(first.id);
      expect(await count(b, pr(3).external_ref)).toBe(1);
    } finally {
      await a.query("ROLLBACK").catch(() => {});
      await b.query("ROLLBACK").catch(() => {});
      a.release();
      b.release();
    }
  });

  it("the source clearing closes the mirror as resolved_at_source; the next raise is a new question", async () => {
    await rolledBack(async (c) => {
      const first = await raiseMirror(c, raise(4));
      // a request with no source is never matched, whatever its payload says
      const { rows: plain } = await c.query(
        `INSERT INTO proposals (kind, source_agent, trust, payload) VALUES ('report', $1, 'internal', $2::jsonb) RETURNING id`,
        [TAG, JSON.stringify({ external_ref: pr(4).external_ref })],
      );
      expect(await resolveAtSource(c, pr(4))).toEqual([first.id]);
      const { rows } = await c.query(`SELECT id, decision, decided_at FROM proposals WHERE id = ANY($1::bigint[]) ORDER BY id`, [[first.id, plain[0].id]]);
      expect(rows[0]).toMatchObject({ decision: RESOLVED_AT_SOURCE });
      expect(rows[0].decided_at).not.toBeNull();
      expect(rows[1]).toMatchObject({ decision: "pending", decided_at: null });
      expect(await resolveAtSource(c, pr(4))).toEqual([]); // nothing left waiting
      const again = await raiseMirror(c, raise(4));
      expect(again.raised).toBe(true);
      expect(again.id).not.toBe(first.id);
    });
  });

  it("the CHECK refuses a source that could neither dedupe nor expire", async () => {
    await rolledBack(async (c) => {
      for (const [i, bad] of [{}, { kind: "github" }, { kind: "github", external_ref: "" }, { kind: "github", external_ref: 41 }, { kind: "github", external_ref: "gh:x#1", person: 7 }, ["github"]].entries()) {
        await c.query(`SAVEPOINT s${i}`);
        await expect(
          c.query(`INSERT INTO proposals (kind, source_agent, trust, payload, source) VALUES ('pull_request', $1, 'internal', '{}', $2::jsonb)`, [TAG, JSON.stringify(bad)]),
          JSON.stringify(bad),
        ).rejects.toMatchObject({ code: "23514", constraint: "proposals_source_shape" });
        await c.query(`ROLLBACK TO SAVEPOINT s${i}`);
      }
    });
  });

  it("a mirror never expires: the morning brief's 14-day expiry skips every row with a source (K15)", async () => {
    await rolledBack(async (c) => {
      const mirror = await raiseMirror(c, raise(5));
      const { rows } = await c.query(
        `INSERT INTO proposals (kind, source_agent, trust, payload) VALUES ('report', $1, 'internal', '{"title":"an old report"}') RETURNING id`,
        [TAG],
      );
      const plain = Number(rows[0].id);
      await c.query(`UPDATE proposals SET ts = now() - interval '30 days' WHERE id = ANY($1::bigint[])`, [[mirror.id, plain]]);

      await morningBrief(c);

      const after = await c.query(`SELECT id, decision FROM proposals WHERE id = ANY($1::bigint[]) ORDER BY id`, [[mirror.id, plain]]);
      expect(after.rows).toEqual([
        { id: String(mirror.id), decision: "pending" },
        { id: String(plain), decision: "expired" },
      ]);
    });
  });

  it("pending_requests returns what each row mirrors and the group it is answered with", async () => {
    await rolledBack(async (c) => {
      const queries = new QueryStore(c);
      await queries.loadDir(`${SEED}queries`);
      const grouped = await raiseMirror(c, raise(6, { kind: "task", group_id: `meeting:${TAG}` }));
      await c.query(`INSERT INTO proposals (kind, source_agent, trust, payload) VALUES ('report', $1, 'internal', '{}')`, [TAG]);
      const mine = (await queries.run("pending_requests", { limit: 500 })).rows.filter((r) => r.source_agent === TAG);
      expect(mine.map((r) => ({ id: Number(r.id), request_type: r.request_type, source: r.source, group_id: r.group_id }))).toEqual([
        { id: grouped.id, request_type: "task", source: pr(6), group_id: `meeting:${TAG}` },
        { id: expect.any(Number), request_type: "report", source: null, group_id: null },
      ]);
    });
  });
});
