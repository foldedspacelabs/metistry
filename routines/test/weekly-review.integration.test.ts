// Weekly review against the real (scratch) database. The fake-db unit tests
// prove the rendering; only Postgres can prove the SQL — FILTER clauses,
// the jsonb history unnest, to_char on a date, the CTE unions. Skipped
// without a db. Every row inserted here carries an `itest-` marker and is
// removed again, since other suites assert exact contents of the same tables.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { run as weeklyReview } from "../weekly-review/run.js";

try {
  for (const line of readFileSync(new URL("../../.env", import.meta.url), "utf8").split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m && m[1] && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {}

const hasDb = !!process.env.METISTRY_DB_PASSWORD;

// Local Sep 6 noon: inside the monthly gate, so the run covers Aug 30–Sep 6
// and adds August. Age-sensitive fixtures sit at UTC midnight so a whole
// day count comes out the same in any zone the test machine is in.
const now = new Date(2026, 8, 6, 12, 0, 0);

describe.skipIf(!hasDb)("weekly review (real db)", () => {
  let pool: pg.Pool;
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
    pool = new pg.Pool({
      host: process.env.METISTRY_DB_HOST ?? "127.0.0.1",
      port: Number(process.env.METISTRY_DB_PORT ?? 5432),
      user: process.env.METISTRY_DB_USER ?? "metistry",
      database: process.env.METISTRY_TEST_DB_NAME ?? "metistry_test", // scratch db (ops/scripts/test-db.sh)
      password: process.env.METISTRY_DB_PASSWORD,
    });
    await cleanup();
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
    expect(text).toMatch(/• \d+ decided: .*\b\d+ allowed/);
    expect(text).toMatch(/• \d+ decided: .*\b\d+ denied/);
    expect(text).toContain('"itest duplicate" (1)');
    expect(text).toMatch(/• \d+ waiting, oldest \d+d — open triage/);
    expect(text).toContain("• itest-agent (Integration Agent): 1 report, 1 proposal, 1 task claimed, 1 closed, 1 tool call, 0.25 USD — last seen 1d ago");
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
