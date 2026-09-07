// Seed queries (seed/queries/*.yaml) are the console's default read path
// (invariant 3, D4 overlay). Two guarantees: every query the PWA calls is
// present and compiles with its defaults (no db needed), and — when a
// scratch db is available (ops/scripts/test-db.sh) — every seed query
// actually executes against the migrated schema, so a column typo fails
// here instead of on the dashboard.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { QueryStore, type SqlExecutor } from "@foldedspacelabs/metistry-queries";

try {
  for (const line of readFileSync(new URL("../../../.env", import.meta.url), "utf8").split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m && m[1] && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {}

const SEED_DIR = fileURLToPath(new URL("../../../seed/queries", import.meta.url));

// what the PWA (app.js) and the routines lean on
const REQUIRED = [
  "open_work",
  "prs_for_review",
  "claude_usage_daily",
  "aws_costs_daily",
  "aws_costs_recent",
  "projects_overview",
  "projects_rollup",
  "runs_summary",
];

describe("seed queries", () => {
  it("load, include every query the console calls, and compile with defaults", async () => {
    const calls: { text: string; values: unknown[] }[] = [];
    const executor: SqlExecutor = {
      async query(text, values) {
        calls.push({ text, values });
        return { rows: [] };
      },
    };
    const store = new QueryStore(executor);
    const n = await store.loadDir(SEED_DIR);
    expect(n).toBeGreaterThanOrEqual(REQUIRED.length);
    for (const name of REQUIRED) expect(store.names()).toContain(name);
    for (const name of store.names()) {
      await store.run(name); // defaults only — every param must have one
      const call = calls.at(-1)!;
      expect(call.text, name).not.toMatch(/(?<![:\w]):[a-z]/); // no leftover :param
      for (const v of call.values) expect(typeof v, `${name} bind`).not.toBe("undefined");
    }
  });
});

const hasDb = !!process.env.METISTRY_DB_PASSWORD;

describe.skipIf(!hasDb)("seed queries against the migrated schema", () => {
  let pool: pg.Pool;
  let store: QueryStore;

  beforeAll(async () => {
    pool = new pg.Pool({
      host: process.env.METISTRY_DB_HOST ?? "127.0.0.1",
      user: process.env.METISTRY_DB_USER ?? "metistry",
      database: process.env.METISTRY_TEST_DB_NAME ?? "metistry_test", // scratch db (ops/scripts/test-db.sh)
      password: process.env.METISTRY_DB_PASSWORD,
    });
    store = new QueryStore(pool);
    await store.loadDir(SEED_DIR);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("every seed query executes with its defaults", async () => {
    for (const name of store.names()) {
      const { rows } = await store.run(name);
      expect(Array.isArray(rows), name).toBe(true);
    }
  });

  it("projects_overview rolls up per area like the brief; runs_summary counts the last 24h", async () => {
    const tag = `seedq-${Date.now()}`;
    await pool.query(
      `INSERT INTO work (title, area, kind, status, external_ref) VALUES
         ($1, $2, 'issue', 'open',        'gh:' || $2 || '#1'),
         ($1, $2, 'issue', 'in_progress', 'gh:' || $2 || '#2'),
         ($1, $2, 'issue', 'blocked',     'gh:' || $2 || '#3'),
         ($1, $2, 'issue', 'closed',      'gh:' || $2 || '#4')`, // external_ref is unique — per-run refs
      [`${tag} title`, tag],
    );
    await pool.query(
      `INSERT INTO runs (component, kind, ok, cost_usd) VALUES
         ($1, 'collector_run', true, NULL), ($1, 'collector_run', false, NULL),
         ($1, 'turn', true, 0.25), ($1, 'capture', true, NULL)`,
      [tag],
    );
    const { rows } = await store.run("projects_overview", { limit: 100 });
    const area = rows.find((r) => r.area === tag)!;
    expect(area).toBeDefined();
    expect(Number(area.open)).toBe(3);
    expect(Number(area.in_progress)).toBe(1);
    expect(Number(area.blocked)).toBe(1);
    expect(Number(area.closed_7d)).toBe(1);
    expect(area.latest).toHaveLength(3);

    const s = (await store.run("runs_summary", { hours: 1 })).rows[0]!;
    expect(Number(s.runs_ok)).toBeGreaterThanOrEqual(1);
    expect(Number(s.runs_failed)).toBeGreaterThanOrEqual(1);
    expect(Number(s.failures)).toBeGreaterThanOrEqual(1);
    expect(Number(s.turns)).toBeGreaterThanOrEqual(1);
    expect(Number(s.captures)).toBeGreaterThanOrEqual(1);
    expect(Number(s.spend_usd)).toBeGreaterThanOrEqual(0.25);
  });
});
