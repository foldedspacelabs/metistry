// The launchd shape's Postgres: where the binaries are looked for, what
// initdb is called with, and the managed conf block. Nothing here runs
// Postgres — the planner is pure and the caller executes it through the
// CLI's one exec seam.
import { describe, expect, it } from "vitest";
import {
  applyManagedBlock,
  CONF_BEGIN,
  extensionDirs,
  findPgToolchain,
  managedConfBlock,
  pgCandidates,
  pgDataDir,
  pgIsReady,
  pgSocketDir,
  planPostgresBootstrap,
  planPostgresDatabase,
  pwFilePath,
  socketPathTooLong,
  withEnvLine,
  type PgPlanInput,
  type PgToolchain,
} from "../src/postgres.js";

const P = "/opt/metistry";

describe("finding a Postgres", () => {
  it("looks in METISTRY_PG_BIN, then the bundled runtime, then Homebrew — in that order", () => {
    expect(pgCandidates({ METISTRY_PG_BIN: "/custom/bin/" }, P).map((c) => c.bin)).toEqual([
      "/custom/bin",
      "/opt/metistry/runtime/postgres/bin",
      "/opt/homebrew/opt/postgresql@17/bin",
      "/usr/local/opt/postgresql@17/bin",
    ]);
    expect(pgCandidates({}, P)[0]!.source).toBe("bundled");
  });

  it("a candidate counts only when every binary `up` and `doctor` call is present", () => {
    const partial = new Set(["/opt/metistry/runtime/postgres/bin/postgres", "/opt/metistry/runtime/postgres/bin/initdb"]);
    expect(findPgToolchain(pgCandidates({}, P), (p) => partial.has(p))).toBeUndefined();

    const brew = "/opt/homebrew/opt/postgresql@17/bin";
    const complete = (p: string) => p.startsWith(brew);
    const found = findPgToolchain(pgCandidates({}, P), complete);
    expect(found).toMatchObject({ bin: brew, source: "homebrew", why: "Homebrew postgresql@17" });
  });

  it("reports whether pgvector is installed alongside — migration 0001 needs it", () => {
    const brew = "/opt/homebrew/opt/postgresql@17/bin";
    const withVector = extensionDirs(brew).map((d) => `${d}/vector.control`);
    expect(findPgToolchain(pgCandidates({}, P), (p) => p.startsWith(brew) && !p.endsWith("vector.control"))!.pgvector).toBe(false);
    expect(findPgToolchain(pgCandidates({}, P), (p) => p.startsWith(brew) || withVector.includes(p))!.pgvector).toBe(true);
  });
});

describe("the data directory", () => {
  it("lives under .metistry/state/, outside the vault", () => {
    expect(pgDataDir("/i")).toBe("/i/.metistry/state/pg");
    expect(pgSocketDir("/i")).toBe("/i/.metistry/state/run");
    expect(pwFilePath("/i/.metistry/state/pg")).toBe("/i/.metistry/state/pg.pwfile");
  });

  it("catches a socket path the kernel would silently truncate", () => {
    expect(socketPathTooLong("/i/state/run", 5432)).toBe(false);
    expect(socketPathTooLong(`/Users/someone/${"nested/".repeat(14)}state/run`, 5432)).toBe(true);
  });
});

describe("postgresql.conf", () => {
  const block = managedConfBlock({ port: 5433, socketDir: "/i/state/run" });

  it("touches only listen, port and the socket directory", () => {
    expect(block).toContain("listen_addresses = '127.0.0.1'");
    expect(block).toContain("port = 5433");
    expect(block).toContain("unix_socket_directories = '/i/state/run'");
    expect(block).not.toMatch(/shared_buffers|max_connections/);
  });

  it("is idempotent: appended once, then replaced in place, with everything else untouched", () => {
    const initdb = "# initdb wrote this\nshared_buffers = 128MB\n";
    const once = applyManagedBlock(initdb, block);
    expect(once).toContain("shared_buffers = 128MB");
    expect(once.split(CONF_BEGIN)).toHaveLength(2);

    const twice = applyManagedBlock(once, managedConfBlock({ port: 6000, socketDir: "/i/state/run" }));
    expect(twice.split(CONF_BEGIN)).toHaveLength(2);
    expect(twice).toContain("port = 6000");
    expect(twice).not.toContain("port = 5433");
    expect(twice).toContain("shared_buffers = 128MB");

    // a setting the operator added after the block survives a rewrite
    const withTail = `${once}\nlog_min_duration_statement = 500\n`;
    expect(applyManagedBlock(withTail, block)).toContain("log_min_duration_statement = 500");
  });
});

describe("the bootstrap plan", () => {
  const toolchain: PgToolchain = { bin: "/pg/bin", source: "homebrew", why: "Homebrew postgresql@17", pgvector: true };
  const base: PgPlanInput = {
    toolchain,
    dataDir: "/i/state/pg",
    socketDir: "/i/state/run",
    port: 5432,
    user: "metistry",
    database: "metistry",
    password: "s3cret",
    initialised: false,
  };

  it("writes the password to a file, initdbs with it, deletes it, then writes the conf block", () => {
    const steps = planPostgresBootstrap(base);
    expect(steps.map((s) => s.kind)).toEqual(["write", "run", "run", "conf"]);
    expect(steps[0]).toMatchObject({ kind: "write", path: "/i/state/pg.pwfile", content: "s3cret\n" });
    expect(steps[1]).toMatchObject({
      kind: "run",
      cmd: "/pg/bin/initdb",
      args: ["-D", "/i/state/pg", "-U", "metistry", "--pwfile=/i/state/pg.pwfile", "--encoding=UTF8", "--locale=C", "--auth-local=trust", "--auth-host=scram-sha-256"],
    });
    // the password is never an argument — it would be visible in `ps`
    expect(JSON.stringify(steps[1])).not.toContain("s3cret");
    expect(steps[2]).toMatchObject({ kind: "run", cmd: "/bin/rm", args: ["-f", "/i/state/pg.pwfile"] });
    expect(steps[3]).toMatchObject({ kind: "conf", path: "/i/state/pg/postgresql.conf" });
  });

  it("an initialised data directory is never re-initdb'd — only the conf block is rewritten", () => {
    const steps = planPostgresBootstrap({ ...base, initialised: true });
    expect(steps.map((s) => s.kind)).toEqual(["conf"]);
  });

  it("creates the database compose got from POSTGRES_DB, over the unix socket, tolerating 'already exists'", () => {
    expect(planPostgresDatabase(base)).toEqual([
      { kind: "run", cmd: "/pg/bin/createdb", args: ["-h", "/i/state/run", "-p", "5432", "-U", "metistry", "metistry"], tolerateFailure: true, comment: expect.any(String) },
    ]);
    expect(pgIsReady(base)).toEqual({ cmd: "/pg/bin/pg_isready", args: ["-h", "/i/state/run", "-p", "5432", "-U", "metistry", "-d", "metistry"] });
  });
});

describe("the generated password reaches .env once", () => {
  it("appends when the key is absent", () => {
    const next = withEnvLine("METISTRY_ORIGIN=https://x\n", "METISTRY_DB_PASSWORD", "abc");
    expect(next).toContain("METISTRY_ORIGIN=https://x");
    expect(next!.trimEnd().endsWith("METISTRY_DB_PASSWORD=abc")).toBe(true);
  });

  it("never overwrites one the operator already set (including `export` form)", () => {
    expect(withEnvLine("METISTRY_DB_PASSWORD=mine\n", "METISTRY_DB_PASSWORD", "abc")).toBeUndefined();
    expect(withEnvLine("export METISTRY_DB_PASSWORD=mine\n", "METISTRY_DB_PASSWORD", "abc")).toBeUndefined();
    // a DIFFERENT variable whose name merely contains the key is not a match
    expect(withEnvLine("OTHER_METISTRY_DB_PASSWORD=mine\n", "METISTRY_DB_PASSWORD", "abc")).toBeDefined();
  });
});
