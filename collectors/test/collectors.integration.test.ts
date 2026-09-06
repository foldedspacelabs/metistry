// Collectors against the real (scratch) database. The fake-db unit tests
// prove control flow; only Postgres can prove the SQL — a partial unique
// index needs its predicate repeated in ON CONFLICT, and the fake happily
// accepted the statement Postgres rejected. Skipped without a db.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { run as githubState } from "../github-state/run.js";

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
});
