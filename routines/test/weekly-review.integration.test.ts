// Weekly review against the real (scratch) database. The fake-db unit tests
// prove the rendering; only Postgres can prove the SQL — FILTER clauses,
// the jsonb history unnest, to_char on a date, the CTE unions. Skipped
// without a db.
//
// Unlike every other integration suite, this one cannot isolate itself with a
// marker: the review is a WHOLE-DATABASE aggregate, and two of its sections
// rank (top 10 agents by activity, top projects). A sibling suite's leftover
// `runs` rows — written at the real `now()`, which is inside this fixture's
// unbounded `ts > since` window — simply outrank the fixture and push it off
// the end of the list. That is what made the suite pass on a freshly created
// scratch db and fail on the second run against the same one.
//
// So this suite takes the database for the length of its run: `isolate()`
// empties the eight tables the review reads, and refuses to do it unless the
// database it is connected to really is the scratch one.
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
  /** The tables `weekly-review/run.ts` reads. reply_feedback references outbound_messages, so both go together and no CASCADE is needed. */
  const REVIEW_TABLES = ["agents", "inbox", "metrics", "outbound_messages", "proposals", "reply_feedback", "runs", "work"];
  const LOCK_TIMEOUT_MS = 200; // limit: fixed — must stay well under Postgres's 1s deadlock_timeout; see the retry note below
  const ISOLATE_ATTEMPTS = 40; // limit: fixed — 40 × (200ms wait + backoff) is longer than any sibling statement, and still bounded
  /**
   * Empty them — after proving this is the scratch database and not somebody's
   * install (docs/ops/testing.md), and without ever becoming a deadlock.
   *
   * TRUNCATE takes ACCESS EXCLUSIVE on all eight tables, left to right. A
   * sibling file's `DELETE FROM work …` takes `work` first and `proposals`
   * second — the 0018 foreign key's referential check — and a sibling's
   * `INSERT INTO proposals …` takes them the other way round, so no ordering
   * of this list is safe: whichever way they are listed, some sibling
   * statement holds the second lock and wants the first. Postgres then kills
   * one of the two, and the victim it picked in the repro was the SIBLING's
   * DELETE, not this reset — a failure in a file that did nothing wrong:
   *
   *   ERROR:  deadlock detected
   *   DETAIL: Process A waits for RowShareLock on relation … (proposals); blocked by process B.
   *           Process B waits for AccessExclusiveLock on relation … (work); blocked by process A.
   *
   * So the reset refuses to wait. `lock_timeout` well under the server's 1s
   * `deadlock_timeout` means the cycle is never around long enough to BE a
   * deadlock: this statement lets go, the sibling's statement finishes in the
   * milliseconds it needs, and the next attempt walks straight through.
   */
  const isolate = async () => {
    const want = process.env.METISTRY_TEST_DB_NAME ?? "metistry_test";
    const { rows } = await pool.query<{ db: string }>(`SELECT current_database() AS db`);
    const db = rows[0]!.db;
    if (db !== want || !/^metistry_test/.test(db)) {
      throw new Error(`refusing to empty ${db}: the weekly review suite only runs against the scratch db (METISTRY_TEST_DB_NAME=${want}, ops/scripts/test-db.sh)`);
    }
    for (let attempt = 1; ; attempt++) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT_MS}ms'`);
        await client.query(`TRUNCATE ${REVIEW_TABLES.join(", ")} RESTART IDENTITY CASCADE`); // CASCADE: artifact_comments and proposals now reference work (0018), and any future dependent must not break this reset
        await client.query("COMMIT");
        return;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        const code = (err as { code?: string }).code;
        // 55P03 lock_not_available (the timeout above), 40P01 deadlock_detected
        // (a cycle the server saw first): both mean a sibling is mid-statement,
        // and both are answered by letting go and asking again.
        if ((code !== "55P03" && code !== "40P01") || attempt >= ISOLATE_ATTEMPTS) throw err;
        await new Promise((r) => setTimeout(r, 25 + Math.round(Math.random() * 75)));
      } finally {
        client.release();
      }
    }
  };
  const cleanup = async () => {
    await pool.query(`DELETE FROM work WHERE project = 'itest-weekly'`);
    await pool.query(`DELETE FROM proposals WHERE source_agent = 'itest-agent'`);
    await pool.query(`DELETE FROM runs WHERE component IN ('itest-agent', 'itest-collector', 'itest-silent')`);
    await pool.query(`DELETE FROM agents WHERE id = 'itest-agent'`);
    await pool.query(`DELETE FROM metrics WHERE labels->>'model' LIKE 'itest-%' OR labels->>'service' LIKE 'itest-%'`);
    await pool.query(`DELETE FROM outbound_messages WHERE text LIKE 'itest alert%' OR (kind = 'review' AND text LIKE '%itest-weekly%')`);
    await pool.query(`DELETE FROM inbox WHERE source = 'itest-weekly'`);
  };
  beforeAll(async () => {
    pool = await testDb(pg.Pool);
    await isolate();
  });
  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it("renders every section from real rows and emits one 'review' outbound message", async () => {
    // projects: a task created + closed this week (closed by the agent), a PR opened, a blocked item from August, one due next week
    await pool.query(
      `INSERT INTO work (title, project, kind, status, external_ref, due, created_at, updated_at, closed_at, history) VALUES
         ('itest-weekly task', 'itest-weekly', 'task', 'closed', NULL, NULL, '2026-09-02T10:00:00Z', '2026-09-04T10:00:00Z', '2026-09-04T10:00:00Z',
          '[{"ts":"2026-09-04T10:00:00Z","agent":"itest-agent","op":"update","status":"closed"}]'),
         ('itest-weekly pr', 'itest-weekly', 'pr', 'open', 'gh:itest/weekly#1', NULL, '2026-09-02T10:00:00Z', '2026-09-02T10:00:00Z', NULL, '[]'),
         ('itest-weekly stuck', 'itest-weekly', 'task', 'blocked', NULL, NULL, '2026-08-01T00:00:00Z', '2026-08-25T00:00:00Z', NULL, '[]'),
         ('itest-weekly due soon', 'itest-weekly', 'task', 'open', NULL, '2026-09-10', '2026-09-02T10:00:00Z', '2026-09-02T10:00:00Z', NULL, '[]')`,
    );
    // agent + its proposals: a report, a denied knowledge proposal with feedback, one still pending (older than the window)
    await pool.query(
      `INSERT INTO agents (id, display_name, token_hash, last_seen_at) VALUES ('itest-agent', 'Integration Agent', 'itest-weekly-hash', '2026-09-05T00:00:00Z')`,
    );
    await pool.query(
      `INSERT INTO proposals (ts, kind, source_agent, trust, payload, decision, feedback, decided_at) VALUES
         ('2026-09-03T10:00:00Z', 'report', 'itest-agent', 'external', '{}', 'allow', NULL, '2026-09-03T10:00:00Z'),
         ('2026-09-03T10:00:00Z', 'knowledge', 'itest-agent', 'external', '{}', 'deny', 'itest duplicate', '2026-09-03T10:00:00Z'),
         ('2026-08-28T10:00:00Z', 'knowledge', 'itest-agent', 'external', '{}', 'pending', NULL, NULL)`,
    );
    // runs: the agent claimed a task; a collector failed once; another collector went silent in August
    await pool.query(
      `INSERT INTO runs (ts, component, kind, ok, meta, cost_usd) VALUES
         ('2026-09-03T10:00:00Z', 'itest-agent', 'task_op', true, '{"op":"claim","id":1}', 0.25),
         ('2026-09-03T10:00:00Z', 'itest-collector', 'collector_run', true, '{}', NULL),
         ('2026-09-03T10:00:00Z', 'itest-collector', 'collector_run', false, '{}', NULL),
         ('2026-08-20T00:00:00Z', 'itest-silent', 'collector_run', true, '{}', NULL)`,
    );
    // spend: this week and last month, assistant by model and AWS by service
    await pool.query(
      `INSERT INTO metrics (ts, name, value, labels) VALUES
         ('2026-09-03', 'claude.cost_usd', 0.40, '{"model":"itest-sonnet"}'),
         ('2026-09-03', 'aws.cost_usd', 5.00, '{"service":"itest-ec2"}'),
         ('2026-08-15', 'claude.cost_usd', 9.00, '{"model":"itest-opus"}'),
         ('2026-08-15', 'aws.cost_usd', 30.00, '{"service":"itest-s3"}')`,
    );
    await pool.query(`INSERT INTO outbound_messages (ts, thread, text, kind) VALUES ('2026-09-04T10:00:00Z', 'default', 'itest alert: probe failed', 'alert')`);
    await pool.query(`INSERT INTO inbox (ts, source, path, status) VALUES ('2026-08-30T00:00:00Z', 'itest-weekly', 'inbox/itest-weekly.md', 'new')`);

    expect(await weeklyReview(pool, { now })).toBe(1);
    const { rows } = await pool.query(`SELECT text, kind FROM outbound_messages WHERE kind = 'review' ORDER BY id DESC LIMIT 1`);
    const text = String(rows[0]!.text);
    expect(rows[0]!.kind).toBe("review");

    expect(text).toContain("📋 weekly review — Aug 30 to Sep 6");
    expect(text).toContain("• itest-weekly: 2 tasks created, 1 closed; 1 PR opened, 0 closed; 1 blocked\n    blocked: itest-weekly stuck (12d)");
    // other suites may leave decided rows in the window, so assert per outcome rather than exact totals
    expect(text).toMatch(/• \d+ decided: .*\b\d+ approved/);
    expect(text).toMatch(/• \d+ decided: .*\b\d+ declined/);
    expect(text).toContain('"itest duplicate" (1)');
    expect(text).toMatch(/• \d+ waiting, oldest \d+d — open Needs You/);
    expect(text).toContain("• itest-agent (Integration Agent): 1 report, 1 request, 1 task claimed, 1 closed, 1 tool call, 0.25 USD — last seen 1d ago");
    expect(text).toMatch(/• assistant \(API-equivalent\): .*itest-sonnet 0\.40/);
    expect(text).toMatch(/• AWS: .*itest-ec2 5\.00/);
    expect(text).toContain("itest-collector 1 ok ⚠ 1 failed");
    expect(text).toContain("itest-silent ⚠ silent 17d");
    expect(text).toContain('"itest alert: probe failed" ×1');
    expect(text).toMatch(/• inbox: \d+ untriaged, oldest \d+d/);
    expect(text).toContain("• 2026-09-10 itest-weekly due soon");
    expect(text).toContain("📅 Last month (August 2026):");
    const monthly = text.split("📅 Last month")[1]!;
    expect(monthly).toMatch(/itest-opus 9\.00/);
    expect(monthly).toMatch(/itest-s3 30\.00/);
    expect(monthly).not.toContain("itest-sonnet");
  });
});
