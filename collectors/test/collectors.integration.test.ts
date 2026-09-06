// Collectors against the real (scratch) database. The fake-db unit tests
// prove control flow; only Postgres can prove the SQL — a partial unique
// index needs its predicate repeated in ON CONFLICT, and the fake happily
// accepted the statement Postgres rejected. Skipped without a db.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { run as githubState } from "../github-state/run.js";
import { run as claudeUsage } from "../claude-usage/run.js";

try {
  for (const line of readFileSync(new URL("../../.env", import.meta.url), "utf8").split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m && m[1] && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {}

const hasDb = !!process.env.METISTRY_DB_PASSWORD;

describe.skipIf(!hasDb)("collectors (real db)", () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = new pg.Pool({
      host: process.env.METISTRY_DB_HOST ?? "127.0.0.1",
      port: Number(process.env.METISTRY_DB_PORT ?? 5432),
      user: process.env.METISTRY_DB_USER ?? "metistry",
      database: process.env.METISTRY_TEST_DB_NAME ?? "metistry_test", // scratch db (ops/scripts/test-db.sh)
      password: process.env.METISTRY_DB_PASSWORD,
    });
    await pool.query(`DELETE FROM work WHERE external_ref LIKE 'gh:itest/%'`);
    await pool.query(`DELETE FROM runs WHERE component = 'assistant' AND kind = 'turn'`); // scratch db: other suites' drain turns would land in the window
    await pool.query(`DELETE FROM metrics WHERE name LIKE 'claude.%'`);
  });
  afterAll(async () => pool.end());

  it("github-state upserts through the partial unique index, then closes what vanished", async () => {
    const page = (items: any[]) => (async () => ({ ok: true, json: async () => items })) as unknown as typeof fetch;
    const ctx = { githubToken: "t", githubRepos: ["itest/repo"] };
    const base = { state: "open", html_url: "", updated_at: "2026-09-01T00:00:00Z" };
    await githubState(pool, { ...ctx, fetchFn: page([{ number: 1, title: "one", ...base }, { number: 2, title: "two", pull_request: {}, ...base }]) });
    await githubState(pool, { ...ctx, fetchFn: page([{ number: 1, title: "one (renamed)", ...base }]) }); // rerun: upsert, not duplicate
    const { rows } = await pool.query(`SELECT external_ref, title, status, kind FROM work WHERE external_ref LIKE 'gh:itest/%' ORDER BY external_ref`);
    expect(rows).toEqual([
      { external_ref: "gh:itest/repo#1", title: "one (renamed)", status: "open", kind: "issue" },
      { external_ref: "gh:itest/repo#2", title: "two", status: "closed", kind: "pr" },
    ]);
  });

  it("claude-usage rolls assistant turns into per-model daily metrics, idempotently", async () => {
    const turn = (model: string, tin: number, tout: number, cost: number, ts: string) =>
      pool.query(
        `INSERT INTO runs (ts, component, kind, model, tokens_in, tokens_out, cost_usd, ok, meta, started_at, finished_at)
         VALUES ($1, 'assistant', 'turn', $2, $3, $4, $5, true, '{"itest":"1"}', $1, $1)`,
        [ts, model, tin, tout, cost],
      );
    await turn("haiku", 100, 400, 0.01, "2026-09-05T10:00:00Z");
    await turn("haiku", 50, 100, 0.005, "2026-09-05T22:00:00Z");
    await turn("sonnet", 2000, 300, 0.09, "2026-09-05T23:30:00Z");
    const ctx = { now: new Date("2026-09-06T12:00:00Z") };
    expect(await claudeUsage(pool, ctx)).toBe(6);
    expect(await claudeUsage(pool, ctx)).toBe(6); // rerun replaces, never accumulates
    const { rows } = await pool.query(
      `SELECT ts::date::text AS day, labels->>'model' AS model, name, value::float AS value
       FROM metrics WHERE name LIKE 'claude.%' ORDER BY model, name`,
    );
    expect(rows).toEqual([
      { day: "2026-09-05", model: "haiku", name: "claude.cost_usd", value: 0.015 },
      { day: "2026-09-05", model: "haiku", name: "claude.tokens_in", value: 150 },
      { day: "2026-09-05", model: "haiku", name: "claude.tokens_out", value: 500 },
      { day: "2026-09-05", model: "sonnet", name: "claude.cost_usd", value: 0.09 },
      { day: "2026-09-05", model: "sonnet", name: "claude.tokens_in", value: 2000 },
      { day: "2026-09-05", model: "sonnet", name: "claude.tokens_out", value: 300 },
    ]);
  });
});
