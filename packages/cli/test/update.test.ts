// `metistry update` against fakes: the exact --dry-run command list; a
// real run's order (fetch/pull, install/build, migrate through ONE session
// under the advisory lock, compose, kickstart only the host jobs whose code
// changed, lock written through the reconciler as `user`); the refusal
// paths; the no-bridge direct write; release mode; the lock round trip.
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { instanceLockPath, parseLock, readLock, serializeLock, type LockFile } from "../src/lock.js";
import { main } from "../src/main.js";
import { MIGRATION_LOCK_KEY, type MigrationSession } from "../src/migrate.js";
import { hashHostJobs, publishedPackages, trackedPathFor, update } from "../src/update.js";
import { loadPlistTemplates } from "../src/launchd.js";
import { checkout, failDoctor, fakeExec, HELPER, okDoctor, put, RECONCILER, shown, WATCHDOG } from "./fixtures.js";

const NOW = new Date("2026-09-07T15:00:00Z");
const BRIDGE = { METISTRY_RECONCILER_URL: "http://host.docker.internal:7812", METISTRY_BRIDGE_TOKEN_RECONCILER: "tok" };
const base = (P: string, env: NodeJS.ProcessEnv = {}) => ({ productDir: P, env, platform: "darwin" as const, uid: 501, version: "0.0.9", now: NOW, out: () => {} });

/** An in-memory schema_migrations: enough of a session for the runner to believe it. */
function fakeSession(): MigrationSession & { end(): Promise<void>; queries: string[]; ended: boolean } {
  const applied: string[] = [];
  const s = {
    queries: [] as string[],
    ended: false,
    async query(text: string, values?: unknown[]) {
      s.queries.push(text);
      if (text.startsWith("INSERT INTO schema_migrations")) applied.push(String(values?.[0]));
      if (text.startsWith("SELECT filename")) return { rows: [...applied].sort().map((filename) => ({ filename })) };
      return { rows: [] };
    },
    async end() {
      s.ended = true;
    },
  };
  return s;
}

function fakeFetch(status = 201, body: unknown = { queued: true }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("metistry update", () => {
  it("--dry-run prints the exact command list and touches nothing: no subprocess, no db, no bridge, no doctor", async () => {
    const P = await checkout({ git: true });
    const inst = await mkdtemp(join(tmpdir(), "metistry-inst-"));
    const exec = fakeExec();
    const f = fakeFetch();
    let doctorRan = false;
    const r = await update({
      ...base(P, { METISTRY_INSTANCE_DIR: inst, ...BRIDGE }),
      exec,
      dryRun: true,
      fetchFn: f.fn,
      openSession: async () => {
        throw new Error("dry-run must not open a db session");
      },
      doctorFn: async (d) => ((doctorRan = true), failDoctor(d)),
    });
    expect(exec.calls).toEqual([]);
    expect(f.calls).toEqual([]);
    expect(doctorRan).toBe(false);
    expect(r.code).toBe(0);
    expect(r.commands).toEqual([
      `(cd ${P} && git fetch --quiet)`,
      `(cd ${P} && git pull --ff-only --quiet)`,
      `(cd ${P} && pnpm install --frozen-lockfile)`,
      `(cd ${P} && pnpm -r build)`,
      `apply db/migrations/*.sql not yet in schema_migrations (2 on disk) under pg_advisory_lock(${MIGRATION_LOCK_KEY}), one transaction each`,
      `(cd ${P} && docker compose up -d --build)`,
      `launchctl kickstart -k gui/501/${HELPER}`,
      `launchctl kickstart -k gui/501/${RECONCILER}`,
      `launchctl kickstart -k gui/501/${WATCHDOG}`,
      `POST http://127.0.0.1:7812/vault/write metistry.lock (principal user, "metistry update → 0.0.9")`,
      "metistry doctor",
    ]);
    expect(r.lock).toEqual({ product: { version: "0.0.9", commit: "<HEAD after pull>", source: "git" }, updated_at: NOW.toISOString(), migrations_applied: [] });
    expect(existsSync(join(inst, "metistry.lock"))).toBe(false);
  });

  it("fast-forwards, builds, migrates in one session under the lock, kickstarts only the changed host job, pins the lock through the reconciler as user", async () => {
    const P = await checkout({ git: true });
    const inst = await mkdtemp(join(tmpdir(), "metistry-inst-"));
    const exec = fakeExec({
      git: (args) => (args[0] === "rev-parse" ? { stdout: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n" } : undefined),
      // the build changes the watchdog's dist and nothing else
      pnpm: async (args) => {
        if (args[0] === "-r") await put(P, "apps/watchdog/dist/lib/util.js", "v2");
      },
    });
    const session = fakeSession();
    const f = fakeFetch();
    const lines: string[] = [];
    const r = await update({ ...base(P, { METISTRY_INSTANCE_DIR: inst, ...BRIDGE }), out: (l) => lines.push(l), exec, fetchFn: f.fn, openSession: async () => session, doctorFn: okDoctor });

    expect(r.code).toBe(0);
    expect(exec.calls.map(shown)).toEqual([
      "git fetch --quiet",
      "git pull --ff-only --quiet",
      "pnpm install --frozen-lockfile",
      "pnpm -r build",
      "docker compose up -d --build",
      `launchctl kickstart -k gui/501/${WATCHDOG}`,
      "git rev-parse HEAD",
    ]);
    expect(exec.calls.filter((c) => c.cmd !== "launchctl").every((c) => c.cwd === P)).toBe(true);
    expect(r.restarted).toEqual([WATCHDOG]);

    // the migration runner: lock first, unlock last, one transaction per file, every file recorded
    expect(session.queries[0]).toBe("SELECT pg_advisory_lock($1)");
    expect(session.queries.at(-1)).toBe("SELECT pg_advisory_unlock($1)");
    expect(session.queries.filter((q) => q === "BEGIN").length).toBe(2);
    expect(session.queries.filter((q) => q === "COMMIT").length).toBe(2);
    expect(session.ended).toBe(true);
    expect(r.migrations).toMatchObject({ applied: ["0001_a.sql", "0002_b.sql"], skipped: [], recorded: ["0001_a.sql", "0002_b.sql"] });

    // the lock: through the bridge, principal user, the documented message, the documented shape
    expect(f.calls.length).toBe(1);
    expect(f.calls[0]!.url).toBe("http://127.0.0.1:7812/vault/write");
    expect((f.calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    const body = JSON.parse(String(f.calls[0]!.init.body)) as { path: string; content: string; intent: unknown };
    expect(body.path).toBe("metistry.lock");
    expect(body.intent).toEqual({ principal: "user", message: "metistry update → 0.0.9" });
    expect(parseLock(body.content)).toEqual(r.lock);
    expect(r.lock).toEqual({
      product: { version: "0.0.9", commit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", source: "git" },
      updated_at: NOW.toISOString(),
      migrations_applied: ["0001_a.sql", "0002_b.sql"],
    });
    expect(existsSync(join(inst, "metistry.lock"))).toBe(false); // never written behind the reconciler
    expect(lines.join("\n")).toContain("migrations: 2 applied, 2 total");
  });

  it("a second run finds nothing to migrate and nothing to restart", async () => {
    const P = await checkout({ git: true });
    const session = fakeSession();
    await session.query("INSERT INTO schema_migrations (filename) VALUES ($1)", ["0001_a.sql"]);
    await session.query("INSERT INTO schema_migrations (filename) VALUES ($1)", ["0002_b.sql"]);
    const exec = fakeExec();
    const lines: string[] = [];
    const r = await update({ ...base(P, { ...BRIDGE }), out: (l) => lines.push(l), exec, fetchFn: fakeFetch().fn, openSession: async () => session, doctorFn: okDoctor });
    expect(r.code).toBe(0);
    expect(r.migrations).toMatchObject({ applied: [], skipped: ["0001_a.sql", "0002_b.sql"] });
    expect(r.restarted).toEqual([]);
    expect(exec.calls.map(shown)).not.toContain(expect.stringContaining("kickstart"));
    expect(lines.join("\n")).toContain("no host job's code changed");
  });

  it("a pull that cannot fast-forward stops the update before anything is built, doctor still runs, exit code is git's", async () => {
    const P = await checkout({ git: true });
    const exec = fakeExec({ git: (args) => (args[0] === "pull" ? { code: 128, stderr: "fatal: Not possible to fast-forward, aborting." } : undefined) });
    const lines: string[] = [];
    let doctorRan = false;
    const r = await update({ ...base(P, BRIDGE), out: (l) => lines.push(l), exec, fetchFn: fakeFetch().fn, openSession: async () => fakeSession(), doctorFn: async (d) => ((doctorRan = true), okDoctor(d)) });
    expect(r.code).toBe(128);
    expect(doctorRan).toBe(true);
    expect(exec.calls.map(shown)).toEqual(["git fetch --quiet", "git pull --ff-only --quiet"]);
    expect(lines.join("\n")).toContain("metistry update: git pull exited 128: fatal: Not possible to fast-forward");
  });

  it("a failing migration stops the update: no compose, no lock write", async () => {
    const P = await checkout({ git: true });
    const session = fakeSession();
    const bad = session.query.bind(session);
    session.query = async (text: string, values?: unknown[]) => {
      if (text === "select 2;") throw new Error('syntax error at or near "2"');
      return bad(text, values);
    };
    const exec = fakeExec();
    const f = fakeFetch();
    const lines: string[] = [];
    const r = await update({ ...base(P, BRIDGE), out: (l) => lines.push(l), exec, fetchFn: f.fn, openSession: async () => session, doctorFn: okDoctor });
    expect(r.code).toBe(1);
    expect(lines.join("\n")).toContain("migration 0002_b.sql failed");
    expect(session.queries).toContain("ROLLBACK");
    expect(session.ended).toBe(true);
    expect(exec.calls.map(shown)).not.toContain("docker compose up -d --build");
    expect(f.calls).toEqual([]);
  });

  it("the bridge refusing the write fails the update with the envelope's message; a URL without a token is refused before any call", async () => {
    const P = await checkout({ git: true });
    const refused = fakeFetch(403, { error: { code: "forbidden", message: "principal may not write metistry.lock" } });
    const lines: string[] = [];
    const r = await update({ ...base(P, BRIDGE), out: (l) => lines.push(l), exec: fakeExec(), skipBuild: true, skipMigrate: true, fetchFn: refused.fn, doctorFn: okDoctor });
    expect(r.code).toBe(1);
    expect(lines.join("\n")).toContain("reconciler refused the lock write (forbidden: principal may not write metistry.lock)");

    const down = { fn: (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch };
    const r2 = await update({ ...base(P, BRIDGE), out: (l) => lines.push(l), exec: fakeExec(), skipBuild: true, skipMigrate: true, fetchFn: down.fn, doctorFn: okDoctor });
    expect(r2.code).toBe(1);
    expect(lines.join("\n")).toContain(`did not answer (fetch failed) — start it (launchctl kickstart -k gui/501/${RECONCILER})`);

    const noToken = fakeFetch();
    const r3 = await update({ ...base(P, { METISTRY_RECONCILER_URL: BRIDGE.METISTRY_RECONCILER_URL }), out: (l) => lines.push(l), exec: fakeExec(), skipBuild: true, skipMigrate: true, fetchFn: noToken.fn, doctorFn: okDoctor });
    expect(r3.code).toBe(1);
    expect(noToken.calls).toEqual([]);
    expect(lines.join("\n")).toContain("METISTRY_BRIDGE_TOKEN_RECONCILER is not");
  });

  it("without a bridge: a local instance dir gets the lock written directly (and read back); a running reconciler with no URL is refused; no instance dir writes nothing", async () => {
    const P = await checkout({ git: true });
    const inst = await mkdtemp(join(tmpdir(), "metistry-inst-"));
    const env = { METISTRY_INSTANCE_DIR: inst };
    const exec = fakeExec({ git: () => ({ stdout: "abc123\n" }), launchctl: () => ({ code: 113, stderr: "Could not find service" }) });
    const lines: string[] = [];
    const r = await update({ ...base(P, env), out: (l) => lines.push(l), exec, skipBuild: true, skipMigrate: true, doctorFn: okDoctor });
    expect(r.code).toBe(0);
    expect(exec.calls.map(shown)).toContain(`launchctl print gui/501/${RECONCILER}`); // "is a reconciler running?" before writing behind it
    expect(await readLock(instanceLockPath(env)!)).toEqual(r.lock);
    expect(r.lock!.product.commit).toBe("abc123");
    expect(lines.join("\n")).toContain("written directly (no reconciler configured)");

    // a running reconciler that update cannot reach is a misconfiguration, not something to write around
    const running = fakeExec({ launchctl: () => ({ stdout: "\tstate = running\n\tpid = 42\n" }) });
    const r2 = await update({ ...base(P, env), out: (l) => lines.push(l), exec: running, skipBuild: true, skipMigrate: true, doctorFn: okDoctor });
    expect(r2.code).toBe(1);
    expect(lines.join("\n")).toContain("a reconciler job is running but METISTRY_RECONCILER_URL is unset");

    // no instance dir at all
    const r3 = await update({ ...base(P), out: (l) => lines.push(l), exec: fakeExec(), skipBuild: true, skipMigrate: true, doctorFn: okDoctor });
    expect(r3.code).toBe(0);
    expect(lines.join("\n")).toContain("no METISTRY_INSTANCE_DIR — metistry.lock not written");
  });

  it("release mode --dry-run: the download plan, the pinned pull, never a build; the prior lock's commit is kept", async () => {
    const P = await checkout({ git: true });
    const inst = await mkdtemp(join(tmpdir(), "metistry-inst-"));
    const prior: LockFile = { product: { version: "0.0.8", commit: "rel-commit", source: "release" }, updated_at: "2026-09-01T00:00:00.000Z", migrations_applied: ["0001_a.sql"] };
    await writeFile(join(inst, "metistry.lock"), serializeLock(prior));
    const r = await update({ ...base(P, { METISTRY_INSTANCE_DIR: inst, ...BRIDGE }), exec: fakeExec(), dryRun: true, fetchFn: fakeFetch().fn });
    expect(r.source).toBe("release");
    expect(r.commands[0]).toContain("resolve release <latest> of foldedspacelabs/metistry");
    expect(r.commands[1]).toContain(`unpack to ${P}/releases/<latest>/ and point current at it`);
    expect(r.commands.join("\n")).not.toContain("pnpm");
    expect(r.commands.join("\n")).not.toContain("git ");
    // no `current` yet in this checkout-shaped dir, so the plan still names the product dir
    expect(r.commands).toContain(`(cd ${P} && docker compose pull)`);
    expect(r.commands).toContain(`(cd ${P} && docker compose up -d --no-build)`);
    expect(r.lock).toEqual({ product: { version: "0.0.9", commit: "rel-commit", source: "release" }, updated_at: NOW.toISOString(), migrations_applied: ["0001_a.sql"] });
    expect(await publishedPackages(P)).toEqual(["@foldedspacelabs/metistry-cli", "@foldedspacelabs/metistry-core"]);
  });

  it("hashHostJobs tracks each job's dist tree (or bare binary) and only that", async () => {
    const P = await checkout();
    const templates = await loadPlistTemplates(P);
    expect(templates.map((t) => t.repoPaths)).toEqual([["packages/mcp-eventkit/helper/ek-helper"], ["apps/reconciler/dist/main.js"], ["apps/watchdog/dist/main.js"]]);
    expect(trackedPathFor("apps/watchdog/dist/main.js")).toBe("apps/watchdog/dist");
    expect(trackedPathFor("packages/mcp-eventkit/helper/ek-helper")).toBe("packages/mcp-eventkit/helper/ek-helper");
    const a = await hashHostJobs(P, templates);
    expect(Object.keys(a).sort()).toEqual([HELPER, RECONCILER, WATCHDOG].sort());
    await put(P, "apps/watchdog/dist/new.js", "added");
    const b = await hashHostJobs(P, templates);
    expect(b[WATCHDOG]).not.toBe(a[WATCHDOG]);
    expect(b[RECONCILER]).toBe(a[RECONCILER]);
    expect(b[HELPER]).toBe(a[HELPER]);
    await put(P, "apps/watchdog/src/main.ts", "source, not dist");
    expect((await hashHostJobs(P, templates))[WATCHDOG]).toBe(b[WATCHDOG]);
    await put(P, "packages/mcp-eventkit/helper/ek-helper", "rebuilt binary");
    expect((await hashHostJobs(P, templates))[HELPER]).not.toBe(b[HELPER]);
    expect((await hashHostJobs(P, [{ ...templates[0]!, repoPaths: ["apps/nothing/dist/main.js"] }]))[HELPER]).toBe("missing");
  });

  it("metistry.lock: serialize/parse round trip, the legacy shape is upgraded, malformed files are refused", async () => {
    const lock: LockFile = { product: { version: "1.2.3", commit: "0123abc", source: "git" }, updated_at: "2026-09-07T15:00:00.000Z", migrations_applied: ["0001_init.sql", "0002_x.sql"] };
    const text = serializeLock(lock);
    expect(text).toBe(
      [
        "# metistry.lock — the product release this instance runs (plan §4.16).",
        "# `metistry update` moves the pin; edit by hand only to roll back.",
        "product:",
        '  version: "1.2.3"',
        '  commit: "0123abc"',
        "  source: git",
        'updated_at: "2026-09-07T15:00:00.000Z"',
        "migrations_applied:",
        '  - "0001_init.sql"',
        '  - "0002_x.sql"',
        "",
      ].join("\n"),
    );
    expect(parseLock(text)).toEqual(lock);
    expect(parseLock(serializeLock({ ...lock, migrations_applied: [] }))).toEqual({ ...lock, migrations_applied: [] });
    const inst = await mkdtemp(join(tmpdir(), "metistry-inst-"));
    expect(await readLock(join(inst, "metistry.lock"))).toBeUndefined();
    await writeFile(join(inst, "metistry.lock"), text);
    expect(await readLock(join(inst, "metistry.lock"))).toEqual(lock);

    // the first by-hand instance's shape (init before 2026-09-07)
    expect(parseLock("version: 0.0.1\ncreated: 2026-09-06\n")).toEqual({ product: { version: "0.0.1", commit: "unknown", source: "git" }, updated_at: "2026-09-06T00:00:00.000Z", migrations_applied: [] });

    for (const bad of ["", "product: 1\n", "product: {version: x, commit: y, source: svn}\nupdated_at: 2026-01-01T00:00:00Z\nmigrations_applied: []\n", "product: {version: x, commit: y, source: git}\nupdated_at: yesterday\nmigrations_applied: []\n", "product: {version: x, commit: y, source: git}\nupdated_at: 2026-01-01T00:00:00Z\nmigrations_applied: 3\n"]) {
      expect(() => parseLock(bad), JSON.stringify(bad)).toThrow(/metistry\.lock:/);
    }
    expect(instanceLockPath({ METISTRY_INSTANCE_DIR: "/x/inst/" })).toBe("/x/inst/metistry.lock");
    expect(instanceLockPath({})).toBeUndefined();
  });

  it("main: `update --dry-run --skip-build --skip-migrate` wires the flags and executes nothing", async () => {
    const P = await checkout({ git: true });
    const exec = fakeExec();
    const lines: string[] = [];
    expect(await main(["update", "--dry-run", "--skip-build", "--skip-migrate", "--product-dir", P], { out: (l) => lines.push(l), err: () => {}, exec })).toBe(0);
    expect(exec.calls).toEqual([]);
    const text = lines.join("\n");
    expect(text).toContain("git pull --ff-only --quiet");
    expect(text).toContain("--skip-build");
    expect(text).toContain("--skip-migrate");
    expect(text).not.toContain("pnpm -r build");
    expect(text).not.toContain("pg_advisory_lock");
    expect(text).toContain("[dry-run] metistry doctor");
    expect(existsSync(join(P, "metistry.lock"))).toBe(false);
  });
});
