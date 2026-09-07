// The migrations check against a real database: the per-checkout scratch db
// `pnpm test` prepares (ops/scripts/test-db.sh) has every db/migrations file
// applied, so doctor must report ok with applied == files. Skipped without a db.
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { dbRows, openDbFromEnv, type Db } from "../src/doctor.js";

try {
  for (const line of readFileSync(new URL("../../../.env", import.meta.url), "utf8").split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m && m[1] && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {}

const hasDb = !!process.env.METISTRY_DB_PASSWORD;
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

describe.skipIf(!hasDb)("doctor: db + migrations against the scratch db", () => {
  let pool: pg.Pool;
  let db: Db;
  beforeAll(() => {
    pool = new pg.Pool({
      host: process.env.METISTRY_DB_HOST ?? "127.0.0.1",
      port: Number(process.env.METISTRY_DB_PORT ?? 5432),
      database: process.env.METISTRY_TEST_DB_NAME ?? "metistry_test",
      user: process.env.METISTRY_DB_USER ?? "metistry",
      password: process.env.METISTRY_DB_PASSWORD,
      max: 1,
    });
    db = { query: (t, v) => pool.query(t, v as any[]) };
  });
  afterAll(async () => {
    await pool.end();
  });

  it("SELECT 1 round-trips and every migration file on disk is applied", async () => {
    const files = (await readdir(join(repoRoot, "db", "migrations"))).filter((f) => f.endsWith(".sql"));
    const [dbRow, migRow] = await dbRows(db, repoRoot);
    expect(dbRow).toMatchObject({ name: "db", kind: "db", status: "ok" });
    expect(migRow).toMatchObject({ name: "migrations", status: "ok", meta: { applied: files.length, files: files.length, pending: [], unknown: [] } });
    expect(migRow!.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it("openDbFromEnv builds a working pool from METISTRY_DB_* (and none without a password)", async () => {
    expect(await openDbFromEnv({})).toBeNull();
    const opened = await openDbFromEnv({ ...process.env, METISTRY_DB_NAME: process.env.METISTRY_TEST_DB_NAME ?? "metistry_test" });
    expect(opened).not.toBeNull();
    const { rows } = await opened!.query("SELECT count(*)::int AS n FROM schema_migrations");
    expect(rows[0].n).toBeGreaterThan(0);
    await opened!.end?.();
  });
});
