import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertScratchDb,
  assertTestEnvIsolated,
  dropScratchDb,
  installDbNames,
  isAllowedTestVar,
  isTempPath,
  loadTestEnv,
  recreateScratchDb,
  scrubTestEnv,
  testDb,
  testDbConfig,
  testDbEnv,
  testEnvViolations,
  TEST_ENV_TEMP_ONLY,
  type TestDbConnection,
} from "../src/test-env.js";

const fresh = () => mkdtemp(join(tmpdir(), "metistry-test-env-"));
const TMP = tmpdir();

describe("the allowlist", () => {
  it("admits how to reach the scratch database and nothing else", () => {
    for (const ok of ["METISTRY_DB_HOST", "METISTRY_DB_PORT", "METISTRY_DB_USER", "METISTRY_DB_PASSWORD", "METISTRY_DB_NAME", "METISTRY_TEST_DB_NAME"]) {
      expect(isAllowedTestVar(ok), ok).toBe(true);
    }
    for (const no of ["METISTRY_INSTANCE_DIR", "METISTRY_RECONCILER_URL", "METISTRY_BRIDGE_TOKEN_RECONCILER", "METISTRY_ASSISTANT_TOKEN", "METISTRY_ORIGIN", "METISTRY_COMPUTE_FILES", "METISTRY_INBOX_DIR", "METISTRY_LOCAL_OWNER_TOKEN"]) {
      expect(isAllowedTestVar(no), no).toBe(false);
    }
  });
});

describe("scrubTestEnv", () => {
  it("deletes every METISTRY_* the allowlist does not name, and leaves everything else alone", () => {
    const env = {
      METISTRY_DB_PASSWORD: "pw",
      METISTRY_TEST_DB_NAME: "metistry_test_x",
      METISTRY_INSTANCE_DIR: "/Users/nobody/instance",
      METISTRY_COMPUTE_FILES: "/Users/nobody/instance/compute.yaml",
      METISTRY_INBOX_DIR: "/Users/nobody/instance/inbox",
      METISTRY_LOCAL_OWNER_TOKEN: "tok",
      HOME: "/Users/nobody",
      PATH: "/usr/bin",
    };
    expect(scrubTestEnv(env)).toEqual(["METISTRY_COMPUTE_FILES", "METISTRY_INBOX_DIR", "METISTRY_INSTANCE_DIR", "METISTRY_LOCAL_OWNER_TOKEN"]);
    expect(env).toEqual({ METISTRY_DB_PASSWORD: "pw", METISTRY_TEST_DB_NAME: "metistry_test_x", HOME: "/Users/nobody", PATH: "/usr/bin" });
  });
});

describe("loadTestEnv", () => {
  it("takes the database lines out of a real dotenv file and refuses the rest of it", async () => {
    const dir = await fresh();
    const file = join(dir, ".env");
    await writeFile(
      file,
      [
        "# a running install's environment",
        "METISTRY_DB_PASSWORD=from-file",
        'METISTRY_DB_HOST="127.0.0.1"',
        "export METISTRY_TEST_DB_NAME=metistry_test_ci",
        "METISTRY_INSTANCE_DIR=/Users/nobody/Development/metistry-instance",
        "METISTRY_RECONCILER_URL=http://127.0.0.1:8788",
        "METISTRY_BRIDGE_TOKEN_RECONCILER=secret",
        "METISTRY_OPENROUTER_API_KEY=also-secret",
      ].join("\n") + "\n",
    );
    const env: NodeJS.ProcessEnv = { METISTRY_ORIGIN: "https://studio.ts.net" };
    const r = loadTestEnv(file, env);
    expect(r.hasDb).toBe(true);
    expect(r.loaded).toEqual(["METISTRY_DB_HOST", "METISTRY_DB_PASSWORD", "METISTRY_TEST_DB_NAME"]);
    expect(r.removed).toEqual(["METISTRY_ORIGIN"]);
    expect(env).toEqual({ METISTRY_DB_HOST: "127.0.0.1", METISTRY_DB_PASSWORD: "from-file", METISTRY_TEST_DB_NAME: "metistry_test_ci" });
  });

  it("never overrides a value the caller already set — CI passes the password in, there is no file", async () => {
    const env: NodeJS.ProcessEnv = { METISTRY_DB_PASSWORD: "ci-only" };
    const r = loadTestEnv(join(await fresh(), "nope", ".env"), env);
    expect(r).toEqual({ hasDb: true, loaded: [], removed: [] });
    expect(env.METISTRY_DB_PASSWORD).toBe("ci-only");
  });

  it("no file, no database: hasDb is false so the suite skips rather than fails", async () => {
    expect(loadTestEnv(join(await fresh(), ".env"), {}).hasDb).toBe(false);
  });
});

describe("the guard", () => {
  it("passes on an environment that names only the scratch database", () => {
    expect(testEnvViolations({ METISTRY_DB_PASSWORD: "pw", HOME: "/Users/nobody" }, TMP)).toEqual([]);
    expect(() => assertTestEnvIsolated({ METISTRY_DB_PASSWORD: "pw" }, TMP)).not.toThrow();
  });

  it("allows the two path variables under os.tmpdir() and refuses them anywhere else", () => {
    for (const name of TEST_ENV_TEMP_ONLY) {
      expect(testEnvViolations({ [name]: join(TMP, "metistry-fixture") }, TMP)).toEqual([]);
      const bad = testEnvViolations({ [name]: "/Users/nobody/Development/metistry-instance" }, TMP);
      expect(bad).toHaveLength(1);
      expect(bad[0]!.name).toBe(name);
      expect(bad[0]!.why).toContain("not a fixture");
    }
  });

  it("names every offending variable, and redacts the secret-shaped ones", () => {
    let message = "";
    try {
      assertTestEnvIsolated({ METISTRY_RECONCILER_URL: "http://127.0.0.1:8788", METISTRY_BRIDGE_TOKEN_RECONCILER: "would-have-committed", METISTRY_ASSISTANT_TOKEN: "t" }, TMP);
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toContain("not isolated");
    expect(message).toContain("METISTRY_RECONCILER_URL=http://127.0.0.1:8788");
    expect(message).toContain("METISTRY_BRIDGE_TOKEN_RECONCILER=<redacted>");
    expect(message).toContain("METISTRY_ASSISTANT_TOKEN=<redacted>");
    expect(message).not.toContain("would-have-committed");
    expect(message).toContain("--product-dir");
  });

  it("isTempPath: the temp root and below, never a sibling that merely starts with the same letters", () => {
    expect(isTempPath(TMP, TMP)).toBe(true);
    expect(isTempPath(join(TMP, "a", "b"), TMP)).toBe(true);
    expect(isTempPath(`${TMP}-not-really`, TMP)).toBe(false);
    expect(isTempPath("/Users/nobody", TMP)).toBe(false);
  });
});

// ---- the scratch database: every refusal, with a fake env and no database ----

const SCRATCH = "metistry_test_unit";
/** An env that names a scratch database and a password, and no install to collide with unless a test adds one. */
const dbEnv = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ METISTRY_TEST_DB_NAME: SCRATCH, METISTRY_DB_PASSWORD: "pw", ...over });
const NO_INSTALL = { installNames: [] } as const;

const refusalOf = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  return "(no refusal)";
};

/** A stand-in for `pg.Pool`: records what it was built with, what it was asked, and whether it was ended. */
function fakePg(currentDatabase: (config: TestDbConnection) => string = (c) => c.database) {
  const made: { config: TestDbConnection; sql: string[]; ended: boolean }[] = [];
  class FakePool {
    readonly rec: { config: TestDbConnection; sql: string[]; ended: boolean };
    constructor(config: TestDbConnection) {
      this.rec = { config, sql: [], ended: false };
      made.push(this.rec);
    }
    async query(text: string) {
      this.rec.sql.push(text);
      return { rows: /current_database\(\)/.test(text) ? [{ db: currentDatabase(this.rec.config) }] : [] };
    }
    async end() {
      this.rec.ended = true;
    }
  }
  return { Pool: FakePool, made };
}

describe("testDbConfig: the refusals", () => {
  it("refuses without METISTRY_TEST_DB_NAME — there is no default name to fall back to", () => {
    const msg = refusalOf(() => testDbConfig({ env: { METISTRY_DB_PASSWORD: "pw" }, ...NO_INSTALL }));
    expect(msg).toContain("testDb refused");
    expect(msg).toContain("METISTRY_TEST_DB_NAME is not set");
    expect(msg).toContain("pnpm test");
  });

  it("refuses without METISTRY_DB_PASSWORD", () => {
    expect(refusalOf(() => testDbConfig({ env: { METISTRY_TEST_DB_NAME: SCRATCH }, ...NO_INSTALL }))).toContain("METISTRY_DB_PASSWORD is not set");
  });

  it("refuses any name that is not metistry_test_<lowercase, digits, _> — the install's default among them", () => {
    for (const name of ["metistry", "metistry_test", "postgres", "template1", "metistry_ns", "Metistry_test_x", "metistry_test_X", "metistry_test_a-b", 'metistry_test_x"; DROP DATABASE metistry; --', "xmetistry_test_a"]) {
      const msg = refusalOf(() => testDbConfig({ env: dbEnv({ METISTRY_TEST_DB_NAME: name }), ...NO_INSTALL }));
      expect(msg, name).toContain("is not a scratch database name");
    }
  });

  it("refuses a name Postgres would truncate into a different one", () => {
    expect(refusalOf(() => testDbConfig({ env: dbEnv({ METISTRY_TEST_DB_NAME: `metistry_test_${"a".repeat(60)}` }), ...NO_INSTALL }))).toContain("Postgres keeps 63");
    expect(refusalOf(() => testDbConfig({ env: dbEnv({ METISTRY_TEST_DB_NAME: `metistry_test_${"a".repeat(46)}` }), suffix: "_mig", ...NO_INSTALL }))).toContain("Postgres keeps 63");
  });

  it("refuses the database an install on this machine is configured with, naming the file that says so", () => {
    const installNames = [{ name: SCRATCH, source: "/somewhere/instance/.metistry/state/.env" }];
    const msg = refusalOf(() => testDbConfig({ env: dbEnv(), installNames }));
    expect(msg).toContain(`${SCRATCH} is the database /somewhere/instance/.metistry/state/.env configures for an install`);
    // a suite's own derived database is refused too if the base is the install's…
    expect(refusalOf(() => testDbConfig({ env: dbEnv(), suffix: "_mig", installNames }))).toContain("configures for an install");
    // …and the derived name is checked on its own
    expect(refusalOf(() => testDbConfig({ env: dbEnv(), suffix: "_mig", installNames: [{ name: `${SCRATCH}_mig`, source: "x/.env" }] }))).toContain("configures for an install");
  });

  it("refuses a suffix that could make the name anything but scratch", () => {
    for (const suffix of ["mig", "_MIG", "_a-b", '"; DROP', " _x"]) {
      expect(refusalOf(() => testDbConfig({ env: dbEnv(), suffix, ...NO_INSTALL })), suffix).toContain("suffix");
    }
  });

  it("refuses a METISTRY_DB_PORT that is not a port", () => {
    for (const port of ["abc", "0", "70000", "54 32", "-1"]) {
      expect(refusalOf(() => testDbConfig({ env: dbEnv({ METISTRY_DB_PORT: port }), ...NO_INSTALL })), port).toContain("is not a port");
    }
  });
});

describe("testDbConfig: what it hands over", () => {
  it("host, port, user and password come from METISTRY_DB_* — never left for the driver to find in PG* variables", () => {
    const env = dbEnv({ PGPORT: "5433", PGHOST: "db.elsewhere", PGDATABASE: "metistry", PGUSER: "postgres" });
    expect(testDbConfig({ env, ...NO_INSTALL })).toEqual({ host: "127.0.0.1", port: 5432, user: "metistry", password: "pw", database: SCRATCH });
    expect(testDbConfig({ env: dbEnv({ METISTRY_DB_HOST: "10.0.0.2", METISTRY_DB_PORT: "55432", METISTRY_DB_USER: "u" }), max: 3, ...NO_INSTALL })).toEqual({
      host: "10.0.0.2",
      port: 55432,
      user: "u",
      password: "pw",
      database: SCRATCH,
      max: 3,
    });
  });

  it("the install's METISTRY_DB_NAME in the environment is ignored — the database is the scratch one or nothing", () => {
    expect(testDbConfig({ env: dbEnv({ METISTRY_DB_NAME: "metistry" }), ...NO_INSTALL }).database).toBe(SCRATCH);
  });

  it("a suffix derives a database of the suite's own", () => {
    expect(testDbConfig({ env: dbEnv(), suffix: "_mig", ...NO_INSTALL }).database).toBe(`${SCRATCH}_mig`);
  });

  it("testDbEnv: the same connection as METISTRY_DB_*, for code under test that reads them", () => {
    expect(testDbEnv({ env: dbEnv({ METISTRY_DB_NAME: "metistry" }), suffix: "_mig", ...NO_INSTALL })).toEqual({
      METISTRY_DB_HOST: "127.0.0.1",
      METISTRY_DB_PORT: "5432",
      METISTRY_DB_USER: "metistry",
      METISTRY_DB_PASSWORD: "pw",
      METISTRY_DB_NAME: `${SCRATCH}_mig`,
    });
    expect(refusalOf(() => testDbEnv({ env: { METISTRY_DB_PASSWORD: "pw" }, ...NO_INSTALL }))).toContain("METISTRY_TEST_DB_NAME is not set");
  });
});

describe("installDbNames: every .env this process can see", () => {
  it("reads the checkout's .env and the install's .metistry/state/.env (and the legacy state/.env) it points at", async () => {
    const root = await fresh();
    const inst = join(root, "instance");
    const legacy = join(root, "legacy");
    await mkdir(join(inst, ".metistry", "state"), { recursive: true });
    await mkdir(join(legacy, "state"), { recursive: true });
    await writeFile(join(root, ".env"), `METISTRY_DB_NAME=metistry_test_checkout\nMETISTRY_INSTANCE_DIR="${inst}"\n`);
    await writeFile(join(inst, ".metistry", "state", ".env"), "METISTRY_DB_PASSWORD=secret\nexport METISTRY_DB_NAME='metistry_test_live'\n");
    await writeFile(join(legacy, "state", ".env"), "METISTRY_DB_NAME=metistry_test_legacy\n");
    const names = installDbNames({ files: [join(root, ".env")], instanceDirs: [legacy], env: {} });
    expect(names).toEqual([
      { name: "metistry_test_checkout", source: join(root, ".env") },
      { name: "metistry_test_legacy", source: join(legacy, "state", ".env") },
      { name: "metistry_test_live", source: join(inst, ".metistry", "state", ".env") },
    ]);
    // and testDbConfig refuses each of them
    for (const { name } of names) {
      expect(refusalOf(() => testDbConfig({ env: dbEnv({ METISTRY_TEST_DB_NAME: name }), installNames: names })), name).toContain("configures for an install");
    }
  });

  it("finds the checkout's .env by walking up to pnpm-workspace.yaml", async () => {
    const root = await fresh();
    await writeFile(join(root, "pnpm-workspace.yaml"), "packages: []\n");
    await writeFile(join(root, ".env"), "METISTRY_DB_NAME=metistry_test_walked\n");
    await mkdir(join(root, "packages", "x", "test"), { recursive: true });
    expect(installDbNames({ env: {}, cwd: join(root, "packages", "x", "test") })).toContainEqual({ name: "metistry_test_walked", source: join(root, ".env") });
  });

  it("remembers what a scrub took away: the file loadTestEnv read, and the METISTRY_INSTANCE_DIR it removed", async () => {
    const root = await fresh();
    const inst = join(root, "inst");
    await mkdir(join(inst, ".metistry", "state"), { recursive: true });
    await writeFile(join(inst, ".metistry", "state", ".env"), "METISTRY_DB_NAME=metistry_test_scrubbed\n");
    await writeFile(join(root, ".env"), "METISTRY_DB_NAME=metistry_test_loaded\n");
    const env: NodeJS.ProcessEnv = { METISTRY_INSTANCE_DIR: inst };
    loadTestEnv(join(root, ".env"), env);
    expect(env.METISTRY_INSTANCE_DIR).toBeUndefined();
    const seen = installDbNames({ env: {}, cwd: root });
    expect(seen).toContainEqual({ name: "metistry_test_loaded", source: join(root, ".env") });
    expect(seen).toContainEqual({ name: "metistry_test_scrubbed", source: join(inst, ".metistry", "state", ".env") });
    // the default discovery is what testDbConfig uses when no list is passed
    expect(refusalOf(() => testDbConfig({ env: dbEnv({ METISTRY_TEST_DB_NAME: "metistry_test_scrubbed" }) }))).toContain("configures for an install");
  });
});

describe("testDb", () => {
  it("a refusal never builds a pool", async () => {
    const { Pool, made } = fakePg();
    await expect(testDb(Pool, { env: { METISTRY_DB_PASSWORD: "pw" }, ...NO_INSTALL })).rejects.toThrow("METISTRY_TEST_DB_NAME is not set");
    await expect(testDb(Pool, { env: dbEnv({ METISTRY_TEST_DB_NAME: "metistry" }), ...NO_INSTALL })).rejects.toThrow("not a scratch database name");
    await expect(testDb(Pool, { env: dbEnv(), installNames: [{ name: SCRATCH, source: "x/.env" }] })).rejects.toThrow("configures for an install");
    expect(made).toEqual([]);
  });

  it("builds the pool from exactly the validated config, and checks current_database() before handing it over", async () => {
    const { Pool, made } = fakePg();
    const pool = await testDb(Pool, { env: dbEnv({ METISTRY_DB_PORT: "55432" }), max: 2, ...NO_INSTALL });
    expect(made).toHaveLength(1);
    expect(made[0]!.config).toEqual({ host: "127.0.0.1", port: 55432, user: "metistry", password: "pw", database: SCRATCH, max: 2 });
    expect(made[0]!.sql).toEqual(["SELECT current_database() AS db"]);
    expect(made[0]!.ended).toBe(false);
    expect(pool.rec).toBe(made[0]);
  });

  it("belt and braces: connected somewhere else, it ends the pool and throws", async () => {
    const { Pool, made } = fakePg(() => "metistry");
    await expect(testDb(Pool, { env: dbEnv(), ...NO_INSTALL })).rejects.toThrow(`current_database() is "metistry", not the scratch database ${SCRATCH}`);
    expect(made).toHaveLength(1);
    expect(made[0]!.ended).toBe(true);
  });

  it("assertScratchDb on a connection the code under test opened", async () => {
    const { Pool } = fakePg(() => "metistry");
    await expect(assertScratchDb(new Pool(testDbConfig({ env: dbEnv(), ...NO_INSTALL })), SCRATCH)).rejects.toThrow("testDb refused");
    const ok = fakePg();
    await expect(assertScratchDb(new ok.Pool(testDbConfig({ env: dbEnv(), ...NO_INSTALL })), SCRATCH)).resolves.toBeUndefined();
  });
});

describe("recreateScratchDb / dropScratchDb", () => {
  it("refuse without a suffix — the shared scratch database is never a suite's to drop — and build nothing", async () => {
    const { Pool, made } = fakePg();
    await expect(recreateScratchDb(Pool, { env: dbEnv(), suffix: "", ...NO_INSTALL })).rejects.toThrow("never the shared scratch database");
    await expect(dropScratchDb(Pool, { env: dbEnv(), suffix: "", ...NO_INSTALL })).rejects.toThrow("never the shared scratch database");
    await expect(recreateScratchDb(Pool, { env: dbEnv({ METISTRY_TEST_DB_NAME: "metistry" }), suffix: "_mig", ...NO_INSTALL })).rejects.toThrow("not a scratch database name");
    expect(made).toEqual([]);
  });

  it("drop and create only <scratch><suffix>, over a maintenance connection that is ended before returning", async () => {
    const { Pool, made } = fakePg();
    expect(await recreateScratchDb(Pool, { env: dbEnv(), suffix: "_mig", ...NO_INSTALL })).toBe(`${SCRATCH}_mig`);
    await dropScratchDb(Pool, { env: dbEnv(), suffix: "_mig", ...NO_INSTALL });
    expect(made.map((m) => ({ database: m.config.database, max: m.config.max, sql: m.sql, ended: m.ended }))).toEqual([
      { database: "postgres", max: 1, sql: [`DROP DATABASE IF EXISTS "${SCRATCH}_mig"`, `CREATE DATABASE "${SCRATCH}_mig"`], ended: true },
      { database: "postgres", max: 1, sql: [`DROP DATABASE IF EXISTS "${SCRATCH}_mig"`], ended: true },
    ]);
  });
});
