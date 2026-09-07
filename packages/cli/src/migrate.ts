// Migrations under a Postgres advisory lock — ops/scripts/migrate.sh ported
// to the CLI (`metistry update`), with the same table, the same "one
// transaction per file" rule and the SAME lock key, so the shell script
// (the zero-dependency path) and this runner can never interleave: whoever
// gets the lock applies what is pending; the other waits, then finds
// nothing to do. Idempotent by construction (schema_migrations, plan §4.16).
//
// This is the one place the CLI touches Postgres directly — the same
// invariant-3 exception the watchdog's liveness probes hold, because the
// migration runner is what CREATES the tables the named queries read.

import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * pg_advisory_lock key shared with ops/scripts/migrate.sh (0x4d455453,
 * "METS"). Change it in both places or not at all — test/lock-key.test.ts
 * greps for the literal in each.
 */
export const MIGRATION_LOCK_KEY = 1296389203;

/** The table, verbatim from migrate.sh. */
export const SCHEMA_MIGRATIONS_DDL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  filename   text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
)`;

/** ONE session, not a pool: advisory locks are session-scoped, so every statement here must ride the same connection. */
export interface MigrationSession {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

export interface MigrateResult {
  /** files this run applied, in order */
  applied: string[];
  /** files already recorded before this run */
  skipped: string[];
  /** every file in db/migrations */
  files: string[];
  /** schema_migrations after the run (what metistry.lock records) */
  recorded: string[];
}

export async function listMigrationFiles(migrationsDir: string): Promise<string[]> {
  if (!existsSync(migrationsDir)) return [];
  return (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
}

export async function runMigrations(session: MigrationSession, migrationsDir: string, log: (line: string) => void = () => {}): Promise<MigrateResult> {
  const files = await listMigrationFiles(migrationsDir);
  await session.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
  try {
    await session.query(SCHEMA_MIGRATIONS_DDL);
    const already = new Set<string>((await session.query("SELECT filename FROM schema_migrations")).rows.map((r) => String(r.filename)));
    const applied: string[] = [];
    const skipped: string[] = [];
    for (const name of files) {
      if (already.has(name)) {
        skipped.push(name);
        continue;
      }
      log(`applying ${name}`);
      const sql = await readFile(join(migrationsDir, name), "utf8");
      // the migration plus its record, one transaction: a failing file leaves no row behind
      await session.query("BEGIN");
      try {
        await session.query(sql);
        await session.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [name]);
        await session.query("COMMIT");
      } catch (err) {
        await session.query("ROLLBACK").catch(() => {});
        throw new Error(`migration ${name} failed: ${err instanceof Error ? err.message : String(err)} — nothing from it was kept; fix the file and rerun`);
      }
      applied.push(name);
    }
    const recorded = (await session.query("SELECT filename FROM schema_migrations ORDER BY filename")).rows.map((r) => String(r.filename));
    return { applied, skipped, files, recorded };
  } finally {
    await session.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]).catch(() => {});
  }
}

/** A single pg.Client from METISTRY_DB_* (the .env convention); null when no password is configured. */
export async function openMigrationSession(env: NodeJS.ProcessEnv): Promise<(MigrationSession & { end(): Promise<void> }) | null> {
  if (!env.METISTRY_DB_PASSWORD) return null;
  const { default: pg } = await import("pg");
  const client = new pg.Client({
    host: env.METISTRY_DB_HOST || "127.0.0.1",
    port: Number.parseInt(env.METISTRY_DB_PORT || "5432", 10),
    database: env.METISTRY_DB_NAME || "metistry",
    user: env.METISTRY_DB_USER || "metistry",
    password: env.METISTRY_DB_PASSWORD,
    connectionTimeoutMillis: 5000,
  });
  await client.connect();
  return { query: (t, v) => client.query(t, v as any[]), end: () => client.end() };
}
