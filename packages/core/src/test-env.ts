// Tests never see the operator's instance.
//
// A product checkout's `.env` is a RUNNING install's environment: it carries
// `METISTRY_INSTANCE_DIR`, the reconciler's URL and the reconciler's bridge
// token. A test that loads the whole file and then calls a CLI verb is not
// talking to a fixture — it is talking to the live system, and no amount of
// `--instance <tmpdir>` saves it, because the write path reads the bridge out
// of the environment and POSTs to whatever answers.
//
// That is not hypothetical: on 2026-09-15 a `metistry compute providers add`
// case in packages/cli, pointed at a temp instance directory, reached the
// operator's running reconciler and had it commit `compute.yaml` into their
// private instance repo.
//
// So the rule is enforced here rather than remembered: one loader, an
// allowlist of the only variables a test may inherit (how to reach the
// scratch Postgres), and a guard that fails a test run the moment anything
// else appears. Documented in docs/ops/testing.md.
//
// The second half is the database itself — `testDb()`, at the bottom of this
// file, is the only way a test gets a Postgres connection. Knowing how to
// reach Postgres is not the same as opening the right database in it.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The only `METISTRY_*` variables a test may inherit: how to reach the
 * scratch database (`ops/scripts/test-db.sh`) and which one it is. Nothing
 * that names a directory, a bridge, a token or an origin.
 */
export const TEST_ENV_ALLOWED = /^METISTRY_(DB_[A-Z0-9_]+|TEST_DB_NAME)$/;

/**
 * The two exceptions, and conditional ones. `METISTRY_INSTANCE_DIR` because
 * the CLI writes the resolved instance directory back into `process.env`, so
 * a test that legitimately passed `--instance <temp dir>` will have set it;
 * `METISTRY_PRODUCT_DIR` because pinning it at a sandbox is how a harness
 * stops the CLI resolving the checkout it happens to be running inside.
 * Under `os.tmpdir()` either is a fixture; anywhere else it is the
 * operator's install.
 */
export const TEST_ENV_TEMP_ONLY = ["METISTRY_INSTANCE_DIR", "METISTRY_PRODUCT_DIR"] as const;

/**
 * Where `installDbNames` looks by default: every dotenv file `loadTestEnv`
 * was pointed at in this process, and every `METISTRY_INSTANCE_DIR` a scrub
 * took out of the environment.
 */
const seenEnvFiles = new Set<string>();
const seenInstanceDirs = new Set<string>();

export function isAllowedTestVar(name: string): boolean {
  return TEST_ENV_ALLOWED.test(name);
}

/** `os.tmpdir()` and its realpath — macOS hands out `/var/folders/…` for a `/private/var/…` directory. */
function tmpRoots(tmp: string): string[] {
  const roots = [resolve(tmp)];
  try {
    const real = realpathSync(tmp);
    if (!roots.includes(real)) roots.push(real);
  } catch {
    /* no such directory: the one root stands */
  }
  return roots;
}

/** True when `dir` is inside the temp root — i.e. a fixture rather than a real instance. */
export function isTempPath(dir: string, tmp: string = tmpdir()): boolean {
  const p = resolve(dir);
  return tmpRoots(tmp).some((root) => p === root || p.startsWith(root + sep));
}

/**
 * Delete every `METISTRY_*` variable the allowlist does not name. Returns the
 * names removed, sorted, so a caller can say what it took away.
 */
export function scrubTestEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const removed: string[] = [];
  for (const name of Object.keys(env)) {
    if (!name.startsWith("METISTRY_") || isAllowedTestVar(name)) continue;
    // gone from the environment, but remembered: it is where the install's
    // own .env lives, which is what `testDb` refuses to open (installDbNames)
    if (name === "METISTRY_INSTANCE_DIR" && env[name]) seenInstanceDirs.add(env[name]);
    removed.push(name);
    delete env[name];
  }
  return removed.sort();
}

export interface TestEnvResult {
  /** true when the scratch database is reachable — suites gate on this with `describe.skipIf(!hasDb)` */
  hasDb: boolean;
  /** allowlisted names taken from the dotenv file */
  loaded: string[];
  /** names deleted from the environment because they were not allowlisted */
  removed: string[];
}

/**
 * Load the allowlisted half of a dotenv file and scrub the rest of the
 * environment. Absent file, unreadable file, malformed line: all fine, the
 * scrub still happens. `file` is a path or a `new URL("…/.env",
 * import.meta.url)`.
 */
export function loadTestEnv(file: string | URL, env: NodeJS.ProcessEnv = process.env): TestEnvResult {
  const removed = scrubTestEnv(env);
  const loaded: string[] = [];
  const path = typeof file === "string" ? file : fileURLToPath(file);
  seenEnvFiles.add(resolve(path));
  for (const [name, value] of readDotenv(path) ?? []) {
    if (!isAllowedTestVar(name) || env[name] !== undefined) continue;
    env[name] = value;
    loaded.push(name);
  }
  return { hasDb: !!env.METISTRY_DB_PASSWORD, loaded: loaded.sort(), removed };
}

/** dotenv text → its assignments, in order: `export` allowed, one layer of matching quotes stripped, comments and junk skipped. */
function parseDotenv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m?.[1]) continue;
    let v = (m[2] ?? "").trim();
    if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) v = v.slice(1, -1);
    out.set(m[1], v);
  }
  return out;
}

/** A dotenv file's assignments, or null when it is absent or unreadable — either way the caller carries on. */
function readDotenv(path: string): Map<string, string> | null {
  try {
    return existsSync(path) ? parseDotenv(readFileSync(path, "utf8")) : null;
  } catch {
    return null;
  }
}

export interface TestEnvViolation {
  name: string;
  /** the value, unless it is secret-shaped — a violation report must not become a secret leak */
  value: string;
  why: string;
}

/** Every reason this environment is not isolated. Empty means it is. */
export function testEnvViolations(env: NodeJS.ProcessEnv = process.env, tmp: string = tmpdir()): TestEnvViolation[] {
  const out: TestEnvViolation[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith("METISTRY_") || isAllowedTestVar(name)) continue;
    const shown = /TOKEN|SECRET|KEY|PASSWORD/.test(name) ? "<redacted>" : (value ?? "");
    if ((TEST_ENV_TEMP_ONLY as readonly string[]).includes(name)) {
      if (isTempPath(value ?? "", tmp)) continue;
      out.push({ name, value: shown, why: `resolves outside ${tmp} — that is a real directory on this machine, not a fixture` });
      continue;
    }
    out.push({ name, value: shown, why: "not on the test allowlist (only METISTRY_DB_* and METISTRY_TEST_DB_NAME are)" });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Throw when the environment a test just ran in could have reached the
 * operator's install. The message names every variable and what to do, since
 * "something leaked" is not actionable at 2am.
 */
export function assertTestEnvIsolated(env: NodeJS.ProcessEnv = process.env, tmp: string = tmpdir()): void {
  const violations = testEnvViolations(env, tmp);
  if (violations.length === 0) return;
  const lines = violations.map((v) => `  ${v.name}=${v.value} — ${v.why}`);
  throw new Error(
    [
      "test environment is not isolated — a verb run here could reach the operator's install:",
      ...lines,
      "",
      "Most often this is a test passing the real checkout as --product-dir: the CLI then reads that checkout's .env,",
      "which is a running install's environment. Point --product-dir at a temp directory instead (docs/ops/testing.md).",
    ].join("\n"),
  );
}

// ---- the scratch database ---------------------------------------------------
//
// The allowlist above says a test may KNOW how to reach Postgres. It says
// nothing about which database the test then opens, and until 2026-09-26 that
// was every suite's own business: each built its own pool, most without a
// port, all with `METISTRY_TEST_DB_NAME ?? "metistry_test"`. On a Mac whose
// live install listens on 5432, a shell with METISTRY_DB_PASSWORD set and
// nothing else sent a suite straight at the install's Postgres. It failed on
// authentication — which was luck, not a control.
//
// So a test gets a connection one way, `testDb(pg.Pool)`, and it refuses —
// throws, before a socket opens — unless the scratch database is named, is
// unmistakably scratch, and is not a name any install on this machine is
// configured with. Once connected it asks the server which database it is
// really in. `ops/scripts/check-test-db.mjs` fails CI on a test file that
// builds a pool of its own. Core does not import `pg`: the caller passes the
// constructor in, so the published package stays driver-free.

/** Every scratch database name starts with this — what `pnpm test` derives per checkout, and what `ops/scripts/test-db.sh` creates. */
export const TEST_DB_PREFIX = "metistry_test_";
const SCRATCH_DB = /^metistry_test_[a-z0-9_]+$/;
const SCRATCH_SUFFIX = /^_[a-z0-9_]+$/;
const PG_IDENT_MAX = 63; // limit: fixed — Postgres NAMEDATALEN - 1; a longer name is silently truncated to a different one

/** What a test is handed: `pg.Pool`'s own config shape, with nothing left to a default the driver would pick. */
export interface TestDbConnection {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  max?: number;
}

/** What `testDb` needs of a connection. `pg.Pool` and `pg.Client` both satisfy it. */
export interface TestDbQueryable {
  query(text: string): Promise<{ rows: unknown[] }>;
}

export interface TestDbPool extends TestDbQueryable {
  end(): Promise<void>;
}

/** `pg.Pool`, passed in by the caller. */
export type TestDbPoolConstructor<P extends TestDbPool> = new (config: TestDbConnection) => P;

export interface TestDbOptions {
  /** default `process.env` */
  env?: NodeJS.ProcessEnv;
  /**
   * A database of the suite's own, `<METISTRY_TEST_DB_NAME><suffix>` — for the
   * rare suite whose subject is a whole database (packages/cli's migration
   * runner). `_` then lowercase letters, digits, underscores.
   */
  suffix?: string;
  /** pool size, passed through */
  max?: number;
  /** the install databases to refuse; default: `installDbNames()` — every one this process can see */
  installNames?: readonly InstallDbName[];
}

/** One database an install on this machine is configured with, and the file that says so. */
export interface InstallDbName {
  name: string;
  source: string;
}

export interface InstallDbNamesOptions {
  /** dotenv files to read; default: every one `loadTestEnv` was given, plus the checkout's own `.env` (found walking up from `cwd`) */
  files?: readonly string[];
  /** instance directories whose `.metistry/state/.env` to read, on top of any `METISTRY_INSTANCE_DIR` the files name; default: every one a scrub removed, plus `env`'s */
  instanceDirs?: readonly string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

function refusal(why: string, fix: string): Error {
  return new Error(`testDb refused: ${why}\n${fix}\n(docs/ops/testing.md — "Which database am I about to touch")`);
}

/** The checkout's `.env`: walk up from `from` to the directory holding `pnpm-workspace.yaml`. */
function checkoutEnvFile(from: string): string[] {
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return [join(dir, ".env")];
    if (dirname(dir) === dir) return [];
  }
}

const expandHome = (p: string): string => (p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

/**
 * Every `METISTRY_DB_NAME` an install on this machine is configured with, from
 * every `.env` this process can see: the checkout's own, whatever
 * `loadTestEnv` read, and the install's `.metistry/state/.env` (or the
 * pre-2026-09-17 `state/.env`) under any `METISTRY_INSTANCE_DIR` those name or
 * the environment held before a scrub. The same file `ops/scripts/test-db.sh`
 * refuses to drop the database of. Read for the name only; absent or
 * unreadable files are skipped.
 */
export function installDbNames(opts: InstallDbNamesOptions = {}): InstallDbName[] {
  const env = opts.env ?? process.env;
  const files = new Set((opts.files ?? [...seenEnvFiles, ...checkoutEnvFile(opts.cwd ?? process.cwd())]).map((f) => resolve(f)));
  const dirs = new Set<string>(opts.instanceDirs ?? [...seenInstanceDirs]);
  if (!opts.instanceDirs && env.METISTRY_INSTANCE_DIR) dirs.add(env.METISTRY_INSTANCE_DIR);
  const out: InstallDbName[] = [];
  for (const file of files) {
    const vars = readDotenv(file);
    const name = vars?.get("METISTRY_DB_NAME");
    if (name) out.push({ name, source: file });
    const dir = vars?.get("METISTRY_INSTANCE_DIR");
    if (dir) dirs.add(resolve(dirname(file), expandHome(dir)));
  }
  for (const dir of dirs) {
    for (const rel of [join(".metistry", "state", ".env"), join("state", ".env")]) {
      const file = resolve(expandHome(dir), rel);
      const name = readDotenv(file)?.get("METISTRY_DB_NAME");
      if (name) out.push({ name, source: file });
    }
  }
  return out;
}

/**
 * The connection a test may open, or a refusal. Pure given `env` and
 * `installNames`, and it never connects — `testDb` does that. Refuses when:
 *
 *   - `METISTRY_TEST_DB_NAME` is unset (there is no default name to fall back
 *     to — falling back is how a suite ends up somewhere it did not choose);
 *   - `METISTRY_DB_PASSWORD` is unset;
 *   - the name (with any suffix) is not `metistry_test_[a-z0-9_]+`, or is
 *     longer than Postgres keeps;
 *   - the name is one an install on this machine is configured with;
 *   - `METISTRY_DB_PORT` is not a port.
 *
 * Host, port and user always come from `METISTRY_DB_*` (defaults
 * `127.0.0.1`, `5432`, `metistry` — the same as `ops/scripts/test-db.sh`), so
 * the suite opens the server test-db.sh built the scratch database on, never
 * one the driver found through `PG*` variables.
 */
export function testDbConfig(opts: TestDbOptions = {}): TestDbConnection {
  const env = opts.env ?? process.env;
  const scratch = env.METISTRY_TEST_DB_NAME;
  if (!scratch) {
    throw refusal(
      "METISTRY_TEST_DB_NAME is not set, so there is no scratch database to open — and a test never falls back to a default name.",
      "Run the suite through `pnpm test`, which names one per checkout and builds it with ops/scripts/test-db.sh; or export METISTRY_TEST_DB_NAME=metistry_test_<name> and run test-db.sh with it first.",
    );
  }
  const password = env.METISTRY_DB_PASSWORD;
  if (!password) throw refusal("METISTRY_DB_PASSWORD is not set.", "Gate the suite on loadTestEnv()'s hasDb, which is false without one.");
  const suffix = opts.suffix ?? "";
  if (suffix !== "" && !SCRATCH_SUFFIX.test(suffix)) {
    throw refusal(`suffix ${JSON.stringify(suffix)} is not one testDb accepts.`, "A suffix is `_` followed by lowercase letters, digits and underscores, e.g. `_mig`.");
  }
  const database = scratch + suffix;
  const names = suffix === "" ? [scratch] : [scratch, database];
  for (const name of names) {
    if (!SCRATCH_DB.test(name)) {
      throw refusal(
        `${JSON.stringify(name)} is not a scratch database name.`,
        `A scratch name is ${TEST_DB_PREFIX} followed by lowercase letters, digits and underscores — what \`pnpm test\` derives and ops/scripts/test-db.sh creates. An install's database never looks like that.`,
      );
    }
    if (name.length > PG_IDENT_MAX) {
      throw refusal(`${name} is ${name.length} characters; Postgres keeps ${PG_IDENT_MAX}, so it would open a truncated name, not this one.`, "Shorten METISTRY_TEST_DB_NAME.");
    }
  }
  const installs = opts.installNames ?? installDbNames({ env });
  for (const name of names) {
    const hit = installs.find((i) => i.name === name);
    if (hit) {
      throw refusal(`${name} is the database ${hit.source} configures for an install on this machine.`, "Point METISTRY_TEST_DB_NAME at a scratch name no install runs on.");
    }
  }
  const portText = env.METISTRY_DB_PORT || "5432";
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || port < 1 || port > 65535) throw refusal(`METISTRY_DB_PORT=${portText} is not a port.`, "Set it to the port ops/scripts/test-db.sh created the scratch database on.");
  return {
    host: env.METISTRY_DB_HOST || "127.0.0.1",
    port,
    user: env.METISTRY_DB_USER || "metistry",
    password,
    database,
    ...(opts.max === undefined ? {} : { max: opts.max }),
  };
}

/**
 * The same connection as `METISTRY_DB_*` variables, for a test whose subject
 * is code that reads them (`openDbFromEnv`, `openMigrationSession`): the
 * function under test gets the scratch database and nothing else of the
 * environment. Follow it with `assertScratchDb` on what that code opened.
 */
export function testDbEnv(opts: Omit<TestDbOptions, "max"> = {}): Record<"METISTRY_DB_HOST" | "METISTRY_DB_PORT" | "METISTRY_DB_USER" | "METISTRY_DB_PASSWORD" | "METISTRY_DB_NAME", string> {
  const c = testDbConfig(opts);
  return { METISTRY_DB_HOST: c.host, METISTRY_DB_PORT: String(c.port), METISTRY_DB_USER: c.user, METISTRY_DB_PASSWORD: c.password, METISTRY_DB_NAME: c.database };
}

/** Ask the server which database this connection is really in, and throw unless it is `expected`. */
export async function assertScratchDb(db: TestDbQueryable, expected: string): Promise<void> {
  const { rows } = await db.query("SELECT current_database() AS db");
  const got = (rows[0] as { db?: unknown } | undefined)?.db;
  if (got === expected) return;
  throw refusal(
    `connected, but the server says current_database() is ${JSON.stringify(got)}, not the scratch database ${expected}.`,
    "Something between the config and the server chose another database — refusing to hand this connection to a test.",
  );
}

/**
 * The only way a test gets a Postgres connection: `await testDb(pg.Pool)`.
 * Validates with `testDbConfig` (so a refusal never opens a socket), builds
 * the pool from exactly that config, then checks `current_database()` before
 * returning it. On a mismatch the pool is ended, not handed over.
 */
export async function testDb<P extends TestDbPool>(Pool: TestDbPoolConstructor<P>, opts: TestDbOptions = {}): Promise<P> {
  const config = testDbConfig(opts);
  const pool = new Pool(config);
  try {
    await assertScratchDb(pool, config.database);
  } catch (e) {
    await pool.end().catch(() => {});
    throw e;
  }
  return pool;
}

/**
 * Drop and create `<METISTRY_TEST_DB_NAME><suffix>`, fresh — for a suite that
 * needs a whole database of its own. Returns its name. The maintenance
 * connection to `postgres` this takes never leaves the function, the name is
 * validated exactly as `testDb`'s is, and a suffix is required: the shared
 * scratch database every other suite is using is out of reach.
 */
export async function recreateScratchDb<P extends TestDbPool>(Pool: TestDbPoolConstructor<P>, opts: TestDbOptions & { suffix: string }): Promise<string> {
  return onMaintenanceDb(Pool, opts, (name) => [`DROP DATABASE IF EXISTS "${name}"`, `CREATE DATABASE "${name}"`]);
}

/** Drop what `recreateScratchDb` made. Same rules. */
export async function dropScratchDb<P extends TestDbPool>(Pool: TestDbPoolConstructor<P>, opts: TestDbOptions & { suffix: string }): Promise<void> {
  await onMaintenanceDb(Pool, opts, (name) => [`DROP DATABASE IF EXISTS "${name}"`]);
}

async function onMaintenanceDb<P extends TestDbPool>(Pool: TestDbPoolConstructor<P>, opts: TestDbOptions & { suffix: string }, statements: (name: string) => string[]): Promise<string> {
  if (!opts.suffix) {
    throw refusal(
      "a suite may create or drop only a database of its own — <METISTRY_TEST_DB_NAME><suffix> — never the shared scratch database the other suites are using.",
      'Pass a suffix, e.g. { suffix: "_mig" }.',
    );
  }
  const config = testDbConfig(opts);
  const admin = new Pool({ ...config, database: "postgres", max: 1 });
  try {
    for (const sql of statements(config.database)) await admin.query(sql);
  } finally {
    await admin.end();
  }
  return config.database;
}
