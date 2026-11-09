// Weekly review against the real (scratch) database. The fake-db unit tests
// prove the rendering; only Postgres can prove the SQL — FILTER clauses,
// the jsonb history unnest, to_char on a date, the CTE unions. Skipped
// without a db.
//
// Unlike most integration suites, this one cannot isolate itself with a
// marker: the review is a WHOLE-DATABASE aggregate, and two of its sections
// rank (top 10 agents by activity, top projects). A sibling suite's rows —
// written at the real `now()`, which is inside this fixture's unbounded
// `ts > since` window — simply outrank the fixture and push it off the end
// of the list.
//
// Until X-25 the suite answered that by TRUNCATE-ing the eight tables the
// review reads. Under vitest's default file parallelism that emptied them
// out from under every sibling file in this package mid-test — reply-review's
// `reply_feedback` insert found its `outbound_messages` row gone (the
// `reply_feedback_outbound_message_id_fkey` violation), recording-retention's
// proposals vanished before its pass counted them, morning-brief's and
// plan-tomorrow's `runs` rows disappeared between a write and the read that
// asserted on them. So the suite now SHADOWS the tables instead (docs/ops/testing.md,
// "shadow the table"): one connection of its own, with a TEMP copy of each
// table the review reads (`LIKE public.<t> INCLUDING ALL`: columns, defaults,
// checks, indexes — no foreign keys, no triggers). An unqualified table name
// on that connection is the shadow; the review runs on that connection, so
// it sees exactly this fixture and nothing a sibling wrote, and no shared
// table is read, written or emptied. The shadows go when the connection does.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { run as weeklyReview } from "../weekly-review/run.js";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";

const { hasDb } = loadTestEnv(new URL("../../.env", import.meta.url)); // METISTRY_DB_* only, and nothing of the operator's install (docs/ops/testing.md)

// Local Sep 6 noon: inside the monthly gate, so the run covers Aug 30–Sep 6
// and adds August. Age-sensitive fixtures sit at UTC midnight so a whole
// day count comes out the same in any zone the test machine is in.
const now = new Date(2026, 8, 6, 12, 0, 0);

describe.skipIf(!hasDb)("weekly review (real db)", () => {
  let pool: pg.Pool;
  /** The connection whose unqualified table names are this suite's shadows; every statement below runs on it. */
  let db: pg.PoolClient;
  /** The tables `weekly-review/run.ts` reads — and therefore the ones shadowed. A table the review reads but this list misses would be the shared one. */
  const REVIEW_TABLES = ["agents", "inbox", "metrics", "outbound_messages", "proposals", "reply_feedback", "runs", "work"];
  beforeAll(async () => {
    pool = await testDb(pg.Pool);
    db = await pool.connect();
    try {
      for (const t of REVIEW_TABLES) await db.query(`CREATE TEMP TABLE ${t} (LIKE public.${t} INCLUDING ALL)`);
    } catch (e) {
      db.release(true); // a half-shadowed connection must not go back to the pool
      throw e;
    }
  });
  afterAll(async () => {
    try {
      for (const t of REVIEW_TABLES) await db.query(`DROP TABLE pg_temp.${t}`);
      db.release();
    } catch {
      db.release(true); // drop the connection, and the shadows with it
    }
    await pool.end();
  });

  it("renders every section from real rows and emits one 'review' outbound message", async () => {
    // projects: a task created + closed this week (closed by the agent), a PR opened, a blocked item from August, one due next week
    await db.query(
      `INSERT INTO work (title, project, kind, status, external_ref, due, created_at, updated_at, closed_at, history) VALUES
         ('itest-weekly task', 'itest-weekly', 'task', 'closed', NULL, NULL, '2026-09-02T10:00:00Z', '2026-09-04T10:00:00Z', '2026-09-04T10:00:00Z',
          '[{"ts":"2026-09-04T10:00:00Z","agent":"itest-agent","op":"update","status":"closed"}]'),
         ('itest-weekly pr', 'itest-weekly', 'pr', 'open', 'gh:itest/weekly#1', NULL, '2026-09-02T10:00:00Z', '2026-09-02T10:00:00Z', NULL, '[]'),
         ('itest-weekly stuck', 'itest-weekly', 'task', 'blocked', NULL, NULL, '2026-08-01T00:00:00Z', '2026-08-25T00:00:00Z', NULL, '[]'),
         ('itest-weekly due soon', 'itest-weekly', 'task', 'open', NULL, '2026-09-10', '2026-09-02T10:00:00Z', '2026-09-02T10:00:00Z', NULL, '[]')`,
    );
    // agent + its proposals: a report, a denied knowledge proposal with feedback, one still pending (older than the window)
    await db.query(
      `INSERT INTO agents (id, display_name, token_hash, last_seen_at) VALUES ('itest-agent', 'Integration Agent', 'itest-weekly-hash', '2026-09-05T00:00:00Z')`,
    );
    await db.query(
      `INSERT INTO proposals (ts, kind, source_agent, trust, payload, decision, feedback, decided_at) VALUES
         ('2026-09-03T10:00:00Z', 'report', 'itest-agent', 'external', '{}', 'allow', NULL, '2026-09-03T10:00:00Z'),
         ('2026-09-03T10:00:00Z', 'knowledge', 'itest-agent', 'external', '{}', 'deny', 'itest duplicate', '2026-09-03T10:00:00Z'),
         ('2026-08-28T10:00:00Z', 'knowledge', 'itest-agent', 'external', '{}', 'pending', NULL, NULL)`,
    );
    // runs: the agent claimed a task; a collector failed once; another collector went silent in August
    await db.query(
      `INSERT INTO runs (ts, component, kind, ok, meta, cost_usd) VALUES
         ('2026-09-03T10:00:00Z', 'itest-agent', 'task_op', true, '{"op":"claim","id":1}', 0.25),
         ('2026-09-03T10:00:00Z', 'itest-collector', 'collector_run', true, '{}', NULL),
         ('2026-09-03T10:00:00Z', 'itest-collector', 'collector_run', false, '{}', NULL),
         ('2026-08-20T00:00:00Z', 'itest-silent', 'collector_run', true, '{}', NULL)`,
    );
    // spend: this week and last month, assistant by model and AWS by service
    await db.query(
      `INSERT INTO metrics (ts, name, value, labels) VALUES
         ('2026-09-03', 'claude.cost_usd', 0.40, '{"model":"itest-sonnet"}'),
         ('2026-09-03', 'aws.cost_usd', 5.00, '{"service":"itest-ec2"}'),
         ('2026-08-15', 'claude.cost_usd', 9.00, '{"model":"itest-opus"}'),
         ('2026-08-15', 'aws.cost_usd', 30.00, '{"service":"itest-s3"}')`,
    );
    await db.query(`INSERT INTO outbound_messages (ts, thread, text, kind) VALUES ('2026-09-04T10:00:00Z', 'default', 'itest alert: probe failed', 'alert')`);
    await db.query(`INSERT INTO inbox (ts, source, path, status) VALUES ('2026-08-30T00:00:00Z', 'itest-weekly', 'inbox/itest-weekly.md', 'new')`);

    expect(await weeklyReview(db, { now })).toBe(1);
    const { rows } = await db.query(`SELECT text, kind FROM outbound_messages WHERE kind = 'review' ORDER BY id DESC LIMIT 1`);
    const text = String(rows[0]!.text);
    expect(rows[0]!.kind).toBe("review");

    expect(text).toContain("📋 weekly review — Aug 30 to Sep 6");
    expect(text).toContain("• itest-weekly: 2 tasks created, 1 closed; 1 PR opened, 0 closed; 1 blocked\n    blocked: itest-weekly stuck (12d)");
    // the shadows hold this fixture alone, so the totals are exact — no sibling's decided rows in the window
    expect(text).toContain("• 2 decided: 1 approved, 1 declined");
    expect(text).toContain('"itest duplicate" (1)');
    expect(text).toContain("• 1 waiting, oldest 9d — open Needs You");
    expect(text).toContain("• itest-agent (Integration Agent): 1 report, 1 request, 1 task claimed, 1 closed, 1 tool call, 0.25 USD — last seen 1d ago");
    expect(text).toContain("• assistant (API-equivalent): 0.40 USD — itest-sonnet 0.40");
    expect(text).toContain("• AWS: 5.00 USD — itest-ec2 5.00");
    expect(text).toContain("itest-collector 1 ok ⚠ 1 failed");
    expect(text).toContain("itest-silent ⚠ silent 17d");
    expect(text).toContain('"itest alert: probe failed" ×1');
    expect(text).toContain("• inbox: 1 untriaged, oldest 7d");
    expect(text).toContain("• 2026-09-10 itest-weekly due soon");
    expect(text).toContain("📅 Last month (August 2026):");
    const monthly = text.split("📅 Last month")[1]!;
    expect(monthly).toContain("• assistant (API-equivalent): 9.00 USD — itest-opus 9.00");
    expect(monthly).toContain("• AWS: 30.00 USD — itest-s3 30.00");
    expect(monthly).not.toContain("itest-sonnet");
  });
});
