// The migration runner against a real Postgres: its own scratch database
// (`<METISTRY_TEST_DB_NAME>_mig`, made and dropped by the guarded helper, so
// the doctor integration test's schema_migrations is never touched), idempotency, the
// advisory-lock race between two runners on two pools, and a failing file
// that leaves no row and no half-applied objects behind. Skipped without a
// db (no METISTRY_DB_PASSWORD).
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { listMigrationFiles, MIGRATION_LOCK_KEY, openMigrationSession, runMigrations } from "../src/migrate.js";
import { assertScratchDb, dropScratchDb, loadTestEnv, recreateScratchDb, testDb, testDbEnv } from "@foldedspacelabs/metistry-core/test-env";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url)); // METISTRY_DB_* only, and nothing of the operator's install (docs/ops/testing.md)
const OWN = { suffix: "_mig" } as const; // a database of this suite's own: <METISTRY_TEST_DB_NAME>_mig

async function dir(files: Record<string, string>): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "metistry-migrations-"));
  for (const [name, sql] of Object.entries(files)) await writeFile(join(d, name), sql);
  return d;
}

describe.skipIf(!hasDb)("migration runner against a scratch db", () => {
  let DB: string;
  let a: pg.Pool;
  let b: pg.Pool;
  beforeAll(async () => {
    DB = await recreateScratchDb(pg.Pool, OWN);
    a = await testDb(pg.Pool, { ...OWN, max: 1 });
    b = await testDb(pg.Pool, { ...OWN, max: 1 });
  });
  afterAll(async () => {
    await a?.end();
    await b?.end();
    if (DB) await dropScratchDb(pg.Pool, OWN);
  });

  it("applies each file once, in order, in its own transaction; a second run finds nothing to do", async () => {
    const d = await dir({ "0001_a.sql": "CREATE TABLE mig_a (id int);", "0002_b.sql": "CREATE TABLE mig_b (id int);\nINSERT INTO mig_b VALUES (1);", "readme.txt": "ignored" });
    expect(await listMigrationFiles(d)).toEqual(["0001_a.sql", "0002_b.sql"]);
    const s = await a.connect();
    try {
      const log: string[] = [];
      const r1 = await runMigrations(s, d, (l) => log.push(l));
      expect(r1).toEqual({ applied: ["0001_a.sql", "0002_b.sql"], skipped: [], files: ["0001_a.sql", "0002_b.sql"], recorded: ["0001_a.sql", "0002_b.sql"] });
      expect(log).toEqual(["applying 0001_a.sql", "applying 0002_b.sql"]);
      const r2 = await runMigrations(s, d);
      expect(r2).toEqual({ applied: [], skipped: ["0001_a.sql", "0002_b.sql"], files: ["0001_a.sql", "0002_b.sql"], recorded: ["0001_a.sql", "0002_b.sql"] });
    } finally {
      s.release();
    }
    expect((await a.query("SELECT count(*)::int AS n FROM mig_b")).rows[0].n).toBe(1);
    expect((await a.query("SELECT filename, applied_at FROM schema_migrations ORDER BY filename")).rows.map((r) => r.filename)).toEqual(["0001_a.sql", "0002_b.sql"]);
    // this session's own backend, not a cluster-wide count — another
    // process (ops/scripts/migrate.sh, a concurrent worktree) can hold the
    // same MIGRATION_LOCK_KEY on a database of its own at the same moment
    expect((await a.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND objid = $1 AND pid = pg_backend_pid()", [MIGRATION_LOCK_KEY])).rows[0].n).toBe(0);
  });

  it("two runners racing on two pools: one applies, the other waits on the advisory lock and then finds nothing to do", async () => {
    const d = await dir({
      "0010_slow.sql": "SELECT pg_sleep(1.5);\nCREATE TABLE mig_slow (id int);",
      "0011_after.sql": "INSERT INTO mig_slow VALUES (1);",
    });
    const sa = await a.connect();
    const sb = await b.connect();
    const started = Date.now();
    const finished: Record<string, number> = {};
    try {
      const [ra, rb] = await Promise.all([
        runMigrations(sa, d).then((r) => ((finished.a = Date.now()), r)),
        runMigrations(sb, d).then((r) => ((finished.b = Date.now()), r)),
      ]);
      const results = [ra, rb].sort((x, y) => y.applied.length - x.applied.length);
      expect(results[0]!.applied).toEqual(["0010_slow.sql", "0011_after.sql"]);
      expect(results[1]!.applied).toEqual([]);
      expect(results[1]!.skipped).toEqual(["0010_slow.sql", "0011_after.sql"]);
      // the waiter could not have finished before the applier's sleep ended
      const waiter = ra.applied.length === 0 ? "a" : "b";
      expect(finished[waiter]! - started).toBeGreaterThanOrEqual(1400);
    } finally {
      sa.release();
      sb.release();
    }
    expect((await a.query("SELECT count(*)::int AS n FROM mig_slow")).rows[0].n).toBe(1);
    expect((await a.query("SELECT count(*)::int AS n FROM schema_migrations WHERE filename LIKE '001%'")).rows[0].n).toBe(2);
  }, 20_000);

  it("a failing file is rolled back whole, records nothing, stops the run, and releases the lock; fixing it lets the rest proceed", async () => {
    const d = await dir({
      "0020_ok.sql": "CREATE TABLE mig_ok (id int);",
      "0021_bad.sql": "CREATE TABLE mig_bad (id int);\nSELECT nope;",
      "0022_never.sql": "CREATE TABLE mig_never (id int);",
    });
    const s = await a.connect();
    try {
      await expect(runMigrations(s, d)).rejects.toThrow(/migration 0021_bad\.sql failed: column "nope" does not exist — nothing from it was kept/);
      // the session is usable afterwards (no open aborted transaction), and the lock is gone
      expect((await s.query("SELECT 1 AS one")).rows[0].one).toBe(1);
    } finally {
      s.release();
    }
    const recorded = (await a.query("SELECT filename FROM schema_migrations WHERE filename LIKE '002%' ORDER BY filename")).rows.map((r) => r.filename);
    expect(recorded).toEqual(["0020_ok.sql"]);
    expect((await a.query("SELECT to_regclass('mig_bad') AS t")).rows[0].t).toBeNull();
    expect((await a.query("SELECT to_regclass('mig_never') AS t")).rows[0].t).toBeNull();
    // same fix as above: this backend's own lock, not a cluster-wide count
    expect((await a.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND objid = $1 AND pid = pg_backend_pid()", [MIGRATION_LOCK_KEY])).rows[0].n).toBe(0);

    await writeFile(join(d, "0021_bad.sql"), "CREATE TABLE mig_bad (id int);");
    const s2 = await b.connect();
    try {
      expect((await runMigrations(s2, d)).applied).toEqual(["0021_bad.sql", "0022_never.sql"]);
    } finally {
      s2.release();
    }
  });

  it("openMigrationSession: one pg.Client from METISTRY_DB_*; null without a password", async () => {
    expect(await openMigrationSession({})).toBeNull();
    const s = await openMigrationSession(testDbEnv(OWN));
    expect(s).not.toBeNull();
    await assertScratchDb(s!, DB);
    // session-scoped: asked of the session itself (pid = pg_backend_pid()),
    // never a cluster-wide count — another process can hold this same
    // MIGRATION_LOCK_KEY on a database of its own at the same moment
    await s!.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    expect((await s!.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND objid = $1 AND pid = pg_backend_pid()", [MIGRATION_LOCK_KEY])).rows[0].n).toBe(1);
    await s!.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
    await s!.end();
  });
});
