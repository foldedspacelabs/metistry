// `metistry update` against fakes: the exact --dry-run command list; a
// real run's order (fetch/pull, install/build, migrate through ONE session
// under the advisory lock, compose, kickstart only the host jobs whose code
// changed, lock written through the reconciler as `user`); the refusal
// paths; the no-bridge direct write; release mode; the lock round trip.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { instanceLockPath, parseLock, readLock, serializeLock, type LockFile } from "../src/lock.js";
import { main } from "../src/main.js";
import { MIGRATION_LOCK_KEY, type MigrationSession } from "../src/migrate.js";
import { realExec, type Exec } from "../src/exec.js";
import { hashHostJobs, legacyLayoutRefusal, parseDoctorJson, pastLegacyLayoutSupport, publishedPackages, RECONCILER_READY_TIMEOUT_MS, trackedPathFor, update, waitForReconciler } from "../src/update.js";
import { StepRunner } from "../src/steps.js";
import { supervisorConfig, supervisorConfigPath, writeSupervisorConfig } from "../src/supervisor.js";
import { createServer } from "node:net";
import { loadPlistTemplates } from "../src/launchd.js";
import { checkout, failDoctor, fakeExec, HELPER, okDoctor, put, RECONCILER, shown, SUPERVISOR, WATCHDOG } from "./fixtures.js";

const NOW = new Date("2026-09-07T15:00:00Z");
// Both bearers: the console's (which the CLI no longer uses for a protected
// path) and the OWNER's, which is what `metistry.lock` is written with since
// 2026-09-20. An install that has neither has one minted — its own case below.
const BRIDGE = {
  METISTRY_RECONCILER_URL: "http://host.docker.internal:7812",
  METISTRY_BRIDGE_TOKEN_RECONCILER: "tok",
  METISTRY_BRIDGE_TOKEN_RECONCILER_USER: "owner-tok",
};
// cli-shim.test.ts covers the shim itself; disabled here so the rest of this
// file's exact command lists are not about a feature they are not testing.
const base = (P: string, env: NodeJS.ProcessEnv = {}) => ({ productDir: P, env, platform: "darwin" as const, uid: 501, version: "0.0.9", now: NOW, out: () => {}, cliShim: false });

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

/** compose is pointed at the INSTANCE's .env: its own `./.env` is not this install's environment. */
const envFileArg = (inst: string) => `--env-file ${join(inst, ".metistry", "state", ".env")}`;

describe("metistry update", () => {
  it("--dry-run prints the exact command list and touches nothing: no subprocess, no db, no bridge, no doctor", async () => {
    const P = await checkout({ git: true });
    const inst = await mkdtemp(join(tmpdir(), "mi-" /* short on purpose: the supervisor socket under .metistry/state/run/ has ~103 bytes to live in */));
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
      `(cd ${P} && docker compose ${envFileArg(inst)} up -d --build)`,
      `launchctl kickstart -k gui/501/${HELPER}`,
      `launchctl kickstart -k gui/501/${RECONCILER}`,
      `launchctl kickstart -k gui/501/${WATCHDOG}`,
      `POST http://127.0.0.1:7812/vault/write .metistry/metistry.lock (principal user, "metistry update → 0.0.9")`,
      "metistry doctor",
    ]);
    expect(r.lock).toEqual({ product: { version: "0.0.9", commit: "<HEAD after pull>", source: "git" }, updated_at: NOW.toISOString(), migrations_applied: [] });
    expect(existsSync(join(inst, ".metistry", "metistry.lock"))).toBe(false);
  });

  it("fast-forwards, builds, migrates in one session under the lock, kickstarts only the changed host job, pins the lock through the reconciler as user", async () => {
    const P = await checkout({ git: true });
    const inst = await mkdtemp(join(tmpdir(), "mi-" /* short on purpose: the supervisor socket under .metistry/state/run/ has ~103 bytes to live in */));
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
      `docker compose ${envFileArg(inst)} up -d --build`,
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

    // the lock: through the bridge, on the OWNER bearer (the console's `tok`
    // is not a fallback for a §4.7 path), principal user, the documented
    // message, the documented shape
    expect(f.calls.length).toBe(1);
    expect(f.calls[0]!.url).toBe("http://127.0.0.1:7812/vault/write");
    expect((f.calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer owner-tok");
    const body = JSON.parse(String(f.calls[0]!.init.body)) as { path: string; content: string; intent: unknown };
    expect(body.path).toBe(".metistry/metistry.lock");
    expect(body.intent).toEqual({ principal: "user", message: "metistry update → 0.0.9" });
    expect(parseLock(body.content)).toEqual(r.lock);
    expect(r.lock).toEqual({
      product: { version: "0.0.9", commit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", source: "git" },
      updated_at: NOW.toISOString(),
      migrations_applied: ["0001_a.sql", "0002_b.sql"],
    });
    expect(existsSync(join(inst, ".metistry", "metistry.lock"))).toBe(false); // never written behind the reconciler
    expect(lines.join("\n")).toContain("migrations: 2 applied, 2 total");
  });

  it("a kickstart that fails is tolerated but never reported as kickstarted", async () => {
    const P = await checkout({ git: true });
    const inst = await mkdtemp(join(tmpdir(), "mi-"));
    const exec = fakeExec({
      git: (args) => (args[0] === "rev-parse" ? { stdout: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n" } : undefined),
      pnpm: async (args) => {
        if (args[0] === "-r") await put(P, "apps/watchdog/dist/lib/util.js", "v2");
      },
      launchctl: (args) => (args[0] === "kickstart" ? { code: 5, stderr: "Could not find service" } : undefined),
    });
    const lines: string[] = [];
    const r = await update({ ...base(P, { METISTRY_INSTANCE_DIR: inst, ...BRIDGE }), out: (l) => lines.push(l), exec, fetchFn: fakeFetch().fn, openSession: async () => fakeSession(), doctorFn: okDoctor });
    expect(r.code).toBe(0);
    expect(exec.calls.map(shown)).toContain(`launchctl kickstart -k gui/501/${WATCHDOG}`);
    expect(r.restarted).toEqual([]);
    const text = lines.join("\n");
    expect(text).toContain(`${WATCHDOG}: kickstart exited 5 — not restarted`);
    expect(text).not.toContain("job(s) kickstarted");
    // W1 checkpoint D3: a job whose code changed and whose kickstart failed is not "nothing changed"
    expect(text).not.toContain("no host job's code changed");
    expect(text).toContain(`nothing kickstarted — kickstart of ${WATCHDOG} failed (exit 5)`);
    expect(text).toContain("nothing kickstarted, 1 kickstart(s) failed");
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
    // the summary says the restart never began, not that nothing needed one
    expect(r.restart.reached).toBe(false);
    expect(lines.at(-1)).toContain("nothing restarted — the update stopped before its restart step");
    expect(lines.at(-1)).not.toContain("nothing kickstarted");
  });

  it("the bridge refusing the write fails the update with the envelope's message; a URL without a token is refused before any call", async () => {
    const P = await checkout({ git: true });
    const refused = fakeFetch(403, { error: { code: "forbidden", message: "principal may not write metistry.lock" } });
    const lines: string[] = [];
    const r = await update({ ...base(P, BRIDGE), out: (l) => lines.push(l), exec: fakeExec(), skipBuild: true, skipMigrate: true, fetchFn: refused.fn, doctorFn: okDoctor });
    expect(r.code).toBe(1);
    expect(lines.join("\n")).toContain("reconciler refused the .metistry/metistry.lock write (forbidden: principal may not write metistry.lock)");

    const down = { fn: (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch };
    const r2 = await update({ ...base(P, BRIDGE), out: (l) => lines.push(l), exec: fakeExec(), skipBuild: true, skipMigrate: true, fetchFn: down.fn, doctorFn: okDoctor });
    expect(r2.code).toBe(1);
    expect(lines.join("\n")).toContain(`did not answer (fetch failed) — start it (launchctl kickstart -k gui/501/${RECONCILER})`);

    // A URL, the console's bearer, and no owner bearer: the lock is a §4.7
    // protected path, so the console's bearer is not a fallback — the CLI
    // mints an owner one first (there is a .env to mint it into) and the POST
    // carries THAT. This is the migration, and it is why an install that
    // predates the split needs to be told nothing.
    const minted = fakeFetch();
    const noOwner = { METISTRY_RECONCILER_URL: BRIDGE.METISTRY_RECONCILER_URL, METISTRY_BRIDGE_TOKEN_RECONCILER: "tok" };
    const r3 = await update({ ...base(P, noOwner), out: (l) => lines.push(l), exec: fakeExec(), skipBuild: true, skipMigrate: true, fetchFn: minted.fn, mintOwnerToken: () => "fresh-owner", doctorFn: okDoctor });
    expect(r3.code).toBe(0);
    // (after waiting for the reconciler it kickstarted to answer on /check)
    const lockPost = minted.calls.find((c) => c.url.endsWith("/vault/write"))!;
    expect((lockPost.init.headers as Record<string, string>).authorization).toBe("Bearer fresh-owner");
    expect(lines.join("\n")).toContain("METISTRY_BRIDGE_TOKEN_RECONCILER_USER minted");
    // …and the reconciler is kickstarted for it, because a bearer it has not
    // read is not a bearer
    expect(lines.join("\n")).toContain("so it reads the freshly minted METISTRY_BRIDGE_TOKEN_RECONCILER_USER");
  });

  // Rehearsed 0.12.0 → 0.14.x: the kickstart returns before the restarted
  // reconciler listens, and the lock POST that followed at once was refused
  // with "did not answer (fetch failed)".
  it("waits for a reconciler it just restarted to answer before writing the lock through it", async () => {
    const P = await checkout({ git: true });
    const calls: string[] = [];
    let down = 3;
    const fetchFn = (async (url: string | URL | Request) => {
      calls.push(String(url));
      if (String(url).endsWith("/check") && down-- > 0) throw new TypeError("fetch failed");
      return new Response(JSON.stringify({ queued: true }), { status: 201 });
    }) as unknown as typeof fetch;
    const lines: string[] = [];
    // a fresh object each run: update writes the bearer it mints back into the env it was handed
    const noOwner = (): NodeJS.ProcessEnv => ({ METISTRY_RECONCILER_URL: BRIDGE.METISTRY_RECONCILER_URL, METISTRY_BRIDGE_TOKEN_RECONCILER: "tok" });
    const r = await update({ ...base(P, noOwner()), out: (l) => lines.push(l), exec: fakeExec(), skipBuild: true, skipMigrate: true, fetchFn, mintOwnerToken: () => "fresh-owner", doctorFn: okDoctor, reconcilerReady: { intervalMs: 1, timeoutMs: 5_000 } });
    expect(r.code).toBe(0);
    expect(r.restarted).toEqual([RECONCILER]);
    expect(calls).toEqual([...Array(4).fill("http://127.0.0.1:7812/check"), "http://127.0.0.1:7812/vault/write"]);
    expect(lines.join("\n")).toContain("reconciler: answering again at http://127.0.0.1:7812 after its restart");

    // one that never comes back (the owner's 0.14.1 run gave up at 60 s,
    // then failed the whole update on a write that could only fail): the
    // lock is DEFERRED — not tried — and the rest of the update still runs
    const never = (async (url: string | URL | Request) => {
      calls2.push(String(url));
      throw new TypeError(`fetch failed ${String(url)}`);
    }) as unknown as typeof fetch;
    const calls2: string[] = [];
    const lines2: string[] = [];
    const r2 = await update({ ...base(P, noOwner()), out: (l) => lines2.push(l), exec: fakeExec(), skipBuild: true, skipMigrate: true, fetchFn: never, mintOwnerToken: () => "fresh-owner", doctorFn: okDoctor, reconcilerReady: { intervalMs: 1, timeoutMs: 20 } });
    expect(r2.code).toBe(1);
    const text2 = lines2.join("\n");
    expect(text2).toContain("reconciler: not answering at http://127.0.0.1:7812 0s after its restart (METISTRY_RECONCILER_READY_TIMEOUT_MS) — the lock write is deferred");
    expect(calls2.filter((u) => u.endsWith("/vault/write"))).toEqual([]);
    expect(r2.deferred).toEqual([{ what: ".metistry/metistry.lock", why: expect.stringContaining("the reconciler did not answer at http://127.0.0.1:7812 after its restart"), fix: ["metistry update"] }]);
    expect(r2.lock?.product.source).toBe("git"); // the lock it WOULD have written is still the result's
    expect(text2).toContain("update incomplete");
    expect(text2).not.toContain("did not answer (fetch failed http://127.0.0.1:7812/vault/write)");
  });

  // The owner's 0.14.1 run: after minting the owner bearer, update ran
  // `launchctl kickstart -k gui/501/com.foldedspacelabs.metistry` — the
  // SUPERVISOR — and the console, the reconciler and both bridges went down
  // mid-update, for a bearer only the reconciler reads.
  it("launchd shape: a new owner bearer restarts ONLY the reconciler, through the supervisor's control socket — never the supervisor's agent", async () => {
    const P = await checkout({ git: true });
    await put(P, "seed/deployment.yaml", "shape: launchd\nservices: {}\n");
    const inst = await mkdtemp(join(tmpdir(), "mi-"));
    await mkdir(join(inst, ".metistry"), { recursive: true }); // a self-contained instance, so its state is under .metistry/
    const socket = join(inst, "s.sock");
    const requests: Array<Record<string, unknown>> = [];
    const server = createServer((c) => {
      c.once("data", (d) => {
        requests.push(JSON.parse(d.toString("utf8").trim()) as Record<string, unknown>);
        c.end(JSON.stringify({ ok: true, children: [{ name: "reconciler", state: "running", pid: 4242 }] }) + "\n");
      });
    });
    await new Promise<void>((res) => server.listen(socket, res));
    try {
      await writeSupervisorConfig(supervisorConfigPath(inst), supervisorConfig({ label: SUPERVISOR, socket, token: "sup-tok-0123456789abcdef", env: {}, children: [] }));
      const exec = fakeExec({ security: (args) => (args[0] === "find-generic-password" ? { code: 44, stderr: "could not be found" } : undefined) });
      const f = fakeFetch();
      const lines: string[] = [];
      const env = (): NodeJS.ProcessEnv => ({ METISTRY_INSTANCE_DIR: inst, METISTRY_RECONCILER_URL: BRIDGE.METISTRY_RECONCILER_URL, METISTRY_BRIDGE_TOKEN_RECONCILER: "tok" });
      const r = await update({ ...base(P, env()), out: (l) => lines.push(l), exec, skipBuild: true, skipMigrate: true, fetchFn: f.fn, mintOwnerToken: () => "fresh-owner", doctorFn: okDoctor, reconcilerReady: { intervalMs: 1, timeoutMs: 1_000 } });

      expect(r.code).toBe(0);
      expect(requests).toEqual([{ op: "restart", token: "sup-tok-0123456789abcdef", service: "reconciler" }]);
      expect(exec.calls.filter((c) => c.cmd === "launchctl" && c.args[0] === "kickstart")).toEqual([]);
      expect(r.restarted).toEqual([RECONCILER]);
      expect(lines.join("\n")).toContain("reconciler: restarted through the supervisor (supervisor restart reconciler → running (pid 4242)) so it reads the freshly minted METISTRY_BRIDGE_TOKEN_RECONCILER_USER — nothing else was touched");
      // and the lock waited for it, then went through it with the new bearer
      expect((f.calls.find((c) => c.url.endsWith("/vault/write"))!.init.headers as Record<string, string>).authorization).toBe("Bearer fresh-owner");

      // no supervisor config (it was never `up`ed): still never the agent — the one command instead
      const bare = await mkdtemp(join(tmpdir(), "mi-"));
      const lines2: string[] = [];
      const exec2 = fakeExec({ security: (args) => (args[0] === "find-generic-password" ? { code: 44, stderr: "could not be found" } : undefined) });
      const r2 = await update({ ...base(P, { ...env(), METISTRY_INSTANCE_DIR: bare }), out: (l) => lines2.push(l), exec: exec2, skipBuild: true, skipMigrate: true, fetchFn: fakeFetch().fn, mintOwnerToken: () => "fresh-owner", doctorFn: okDoctor });
      expect(exec2.calls.filter((c) => c.cmd === "launchctl" && c.args[0] === "kickstart")).toEqual([]);
      expect(r2.restarted).toEqual([]);
      expect(lines2.join("\n")).toContain("reconciler: not restarted (no supervisor config for this install — metistry up first");
      expect(lines2.join("\n")).toContain("`metistry restart reconciler`");
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });

  it("the wait backs off: from every intervalMs, doubling, never past maxIntervalMs", async () => {
    const r = new StepRunner({ dryRun: false, out: () => {}, exec: fakeExec(), env: {} });
    const at: number[] = [];
    const t0 = Date.now();
    const fetchFn = (async () => {
      at.push(Date.now() - t0);
      if (at.length < 6) throw new TypeError("fetch failed");
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    expect(await waitForReconciler(r, { url: "http://127.0.0.1:7812", fetchFn, timeoutMs: 10_000, intervalMs: 10, maxIntervalMs: 40 })).toBe(true);
    const gaps = at.slice(1).map((v, i) => v - at[i]!);
    // 10, 20, 40, 40, 40 — timers are at-least, so only the floor is asserted, and the cap from above with slack
    expect(gaps.map((g, i) => g >= [10, 20, 40, 40, 40][i]! - 2)).toEqual([true, true, true, true, true]);
    expect(Math.max(...gaps)).toBeLessThan(40 + 60);
    expect(RECONCILER_READY_TIMEOUT_MS).toBe(180_000);
  });

  // The 0.12.0 → 0.14.0 upgrade: the mint failed, the step threw, and every
  // job whose code changed stayed on the release the update had just left.
  it("a Keychain that refuses the mint does not stop the restart: every changed job is kickstarted, the lock waits for the bearer, and only the exit code says so", async () => {
    const P = await checkout({ git: true });
    const inst = await mkdtemp(join(tmpdir(), "mi-"));
    const exec = fakeExec({
      git: (args) => (args[0] === "rev-parse" ? { stdout: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n" } : undefined),
      pnpm: async (args) => {
        if (args[0] === "-r") await put(P, "apps/watchdog/dist/lib/util.js", "v2");
      },
      // nothing in this instance's Keychain, and a write that fails the way the
      // owner's did: exit 1, nothing on stderr
      security: (args) => (args[0] === "find-generic-password" ? { code: 44, stderr: "The specified item could not be found in the keychain." } : { code: 1, stderr: "" }),
    });
    const f = fakeFetch();
    const lines: string[] = [];
    const env: NodeJS.ProcessEnv = { METISTRY_INSTANCE_DIR: inst, METISTRY_RECONCILER_URL: BRIDGE.METISTRY_RECONCILER_URL, METISTRY_BRIDGE_TOKEN_RECONCILER: "tok" };
    const r = await update({ ...base(P, env), out: (l) => lines.push(l), exec, fetchFn: f.fn, openSession: async () => fakeSession(), doctorFn: okDoctor });
    const text = lines.join("\n");

    expect(r.code).toBe(1);
    expect(r.restart).toEqual({ reached: true, completed: true, owed: [WATCHDOG] });
    expect(r.restarted).toEqual([WATCHDOG]);
    expect(text).toContain("could not mint METISTRY_BRIDGE_TOKEN_RECONCILER_USER (security add-generic-password metistry:METISTRY_BRIDGE_TOKEN_RECONCILER_USER failed (1): no message — a locked keychain, or a timeout)");
    expect(text).toContain("— the restart goes on without it");
    expect(text).not.toContain("metistry update: could not mint"); // not a step failure
    expect(env.METISTRY_BRIDGE_TOKEN_RECONCILER_USER).toBeUndefined();
    // the lock is a protected path: no POST on a bearer the bridge would refuse…
    expect(f.calls).toEqual([]);
    expect(text).toContain(".metistry/metistry.lock NOT written");
    // …and the steps after it that do not need the bearer still ran
    expect(r.seededTemplates).toBeDefined();
    expect(text).toContain("== secrets");
    // what is left, with the commands in the order they must run, once each
    expect(r.deferred.map((d) => d.what)).toEqual(["METISTRY_BRIDGE_TOKEN_RECONCILER_USER", ".metistry/metistry.lock"]);
    const block = text.slice(text.indexOf("not done"));
    const at = (c: string) => block.indexOf(`    ${c}\n`);
    expect(at("metistry secrets mint METISTRY_BRIDGE_TOKEN_RECONCILER_USER")).toBeGreaterThan(-1);
    expect(at("metistry secrets mint METISTRY_BRIDGE_TOKEN_RECONCILER_USER")).toBeLessThan(at("metistry restart reconciler"));
    expect(at("metistry restart reconciler")).toBeLessThan(block.lastIndexOf("    metistry update"));
    expect(lines.at(-1)).toContain("update incomplete");
    expect(lines.at(-1)).toContain("1 job(s) kickstarted");
    expect(lines.at(-1)).toContain("not done: METISTRY_BRIDGE_TOKEN_RECONCILER_USER, .metistry/metistry.lock");
  });

  it("an owner bearer this instance's Keychain already holds is copied into .env, not minted — and the reconciler is restarted to read it", async () => {
    const P = await checkout({ git: true });
    const inst = await mkdtemp(join(tmpdir(), "mi-"));
    const exec = fakeExec({
      git: (args) => (args[0] === "rev-parse" ? { stdout: "abc\n" } : undefined),
      security: (args) =>
        args[0] === "find-generic-password" && args.includes("metistry:METISTRY_BRIDGE_TOKEN_RECONCILER_USER")
          ? { stdout: "from-the-keychain\n" }
          : args[0] === "-i"
            ? { code: 99, stderr: "a write — there must not be one" }
            : undefined,
    });
    const f = fakeFetch();
    const lines: string[] = [];
    const r = await update({
      ...base(P, { METISTRY_INSTANCE_DIR: inst, METISTRY_RECONCILER_URL: BRIDGE.METISTRY_RECONCILER_URL, METISTRY_BRIDGE_TOKEN_RECONCILER: "tok" }),
      out: (l) => lines.push(l),
      exec,
      skipBuild: true,
      skipMigrate: true,
      fetchFn: f.fn,
      doctorFn: okDoctor,
    });
    expect(r.code).toBe(0);
    expect(exec.calls.filter((c) => c.cmd === "security" && c.args[0] === "-i")).toEqual([]);
    expect(readFileSync(join(inst, ".metistry", "state", ".env"), "utf8")).toMatch(/^METISTRY_BRIDGE_TOKEN_RECONCILER_USER=from-the-keychain$/m);
    expect((f.calls.find((c) => c.url.endsWith("/vault/write"))!.init.headers as Record<string, string>).authorization).toBe("Bearer from-the-keychain");
    expect(r.restarted).toEqual([RECONCILER]);
    const text = lines.join("\n");
    expect(text).toContain("copied from this instance's Keychain item into .env");
    expect(text).toContain("so it reads the newly written METISTRY_BRIDGE_TOKEN_RECONCILER_USER");
    expect(text).not.toContain("from-the-keychain");
  });

  it("a restart that stops part-way says which changed jobs it never reached — never \"nothing kickstarted\"", async () => {
    const P = await checkout({ git: true });
    const inst = await mkdtemp(join(tmpdir(), "mi-"));
    const exec = fakeExec({
      pnpm: async (args) => {
        if (args[0] === "-r") await put(P, "apps/watchdog/dist/lib/util.js", "v2");
      },
      docker: () => ({ code: 1, stderr: "Cannot connect to the Docker daemon" }),
    });
    const lines: string[] = [];
    const r = await update({ ...base(P, { METISTRY_INSTANCE_DIR: inst, ...BRIDGE }), out: (l) => lines.push(l), exec, fetchFn: fakeFetch().fn, openSession: async () => fakeSession(), doctorFn: okDoctor });
    expect(r.code).toBe(1);
    expect(r.restart).toEqual({ reached: true, completed: false, owed: [WATCHDOG] });
    const summary = lines.at(-1)!;
    expect(summary).toContain(`restart interrupted — none kickstarted; NOT kickstarted (code changed): ${WATCHDOG}`);
    expect(summary).not.toContain("nothing kickstarted");
  });

  it("names what only the product checkout's .env still has, and the verb that retires it — never a value, never a move", async () => {
    const P = await checkout({ git: true });
    const inst = await mkdtemp(join(tmpdir(), "mi-"));
    await writeFile(join(P, ".env"), "METISTRY_BRIDGE_TOKEN_EVENTKIT=legacy-only-value\nMETISTRY_DB_PORT=5432\n");
    await mkdir(join(inst, ".metistry", "state"), { recursive: true });
    await writeFile(join(inst, ".metistry", "state", ".env"), "METISTRY_DB_PORT=55432\n");
    const lines: string[] = [];
    const r = await update({ ...base(P, { METISTRY_INSTANCE_DIR: inst, ...BRIDGE }), out: (l) => lines.push(l), exec: fakeExec(), skipBuild: true, skipMigrate: true, fetchFn: fakeFetch().fn, doctorFn: okDoctor });
    expect(r.code).toBe(0);
    const text = lines.join("\n");
    expect(text).toContain(`legacy .env: ${join(P, ".env")} is still read as a fallback, and only it has METISTRY_BRIDGE_TOKEN_EVENTKIT — \`metistry secrets retire-legacy-env\` previews moving them`);
    expect(text).not.toContain("legacy-only-value");
    expect(existsSync(join(P, ".env"))).toBe(true);
    expect(readFileSync(join(inst, ".metistry", "state", ".env"), "utf8")).toBe("METISTRY_DB_PORT=55432\n");
  });

  it("without a bridge: a local instance dir gets the lock written directly (and read back); a running reconciler with no URL is refused; no instance dir writes nothing", async () => {
    const P = await checkout({ git: true });
    const inst = await mkdtemp(join(tmpdir(), "mi-" /* short on purpose: the supervisor socket under .metistry/state/run/ has ~103 bytes to live in */));
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
    expect(lines.join("\n")).toContain("no METISTRY_INSTANCE_DIR — .metistry/metistry.lock not written");
  });

  it("release mode --dry-run: the download plan, the pinned pull, never a build; the prior lock's commit is kept", async () => {
    const P = await checkout({ git: true });
    const inst = await mkdtemp(join(tmpdir(), "mi-" /* short on purpose: the supervisor socket under .metistry/state/run/ has ~103 bytes to live in */));
    const prior: LockFile = { product: { version: "0.0.8", commit: "rel-commit", source: "release" }, updated_at: "2026-09-01T00:00:00.000Z", migrations_applied: ["0001_a.sql"] };
    await mkdir(join(inst, ".metistry"), { recursive: true });
    await writeFile(join(inst, ".metistry", "metistry.lock"), serializeLock(prior));
    const r = await update({ ...base(P, { METISTRY_INSTANCE_DIR: inst, ...BRIDGE }), exec: fakeExec(), dryRun: true, fetchFn: fakeFetch().fn });
    expect(r.source).toBe("release");
    expect(r.commands[0]).toContain("resolve release <latest> of foldedspacelabs/metistry");
    expect(r.commands[1]).toContain(`unpack to ${P}/releases/<latest>/ and point current at it`);
    expect(r.commands.join("\n")).not.toContain("pnpm");
    expect(r.commands.join("\n")).not.toContain("git ");
    // no `current` yet in this checkout-shaped dir, so the plan still names the product dir
    expect(r.commands).toContain(`(cd ${P} && docker compose ${envFileArg(inst)} pull)`);
    expect(r.commands).toContain(`(cd ${P} && docker compose ${envFileArg(inst)} up -d --no-build)`);
    expect(r.lock).toEqual({ product: { version: "0.0.9", commit: "rel-commit", source: "release" }, updated_at: NOW.toISOString(), migrations_applied: ["0001_a.sql"] });
    expect(await publishedPackages(P)).toEqual(["@foldedspacelabs/metistry-cli", "@foldedspacelabs/metistry-core"]);
  });

  it("hashHostJobs tracks each job's dist tree (or helper .app bundle) and only that", async () => {
    const P = await checkout();
    const templates = await loadPlistTemplates(P);
    expect(templates.map((t) => t.repoPaths)).toEqual([["packages/mcp-eventkit/helper/ek-helper.app/Contents/MacOS/ek-helper"], ["apps/reconciler/dist/main.js"], ["apps/watchdog/dist/main.js"]]);
    expect(trackedPathFor("apps/watchdog/dist/main.js")).toBe("apps/watchdog/dist");
    expect(trackedPathFor("packages/mcp-eventkit/helper/ek-helper.app/Contents/MacOS/ek-helper")).toBe("packages/mcp-eventkit/helper/ek-helper.app");
    const a = await hashHostJobs(P, templates);
    expect(Object.keys(a).sort()).toEqual([HELPER, RECONCILER, WATCHDOG].sort());
    await put(P, "apps/watchdog/dist/new.js", "added");
    const b = await hashHostJobs(P, templates);
    expect(b[WATCHDOG]).not.toBe(a[WATCHDOG]);
    expect(b[RECONCILER]).toBe(a[RECONCILER]);
    expect(b[HELPER]).toBe(a[HELPER]);
    await put(P, "apps/watchdog/src/main.ts", "source, not dist");
    expect((await hashHostJobs(P, templates))[WATCHDOG]).toBe(b[WATCHDOG]);
    await put(P, "packages/mcp-eventkit/helper/ek-helper.app/Contents/MacOS/ek-helper", "rebuilt binary");
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
    const inst = await mkdtemp(join(tmpdir(), "mi-" /* short on purpose: the supervisor socket under .metistry/state/run/ has ~103 bytes to live in */));
    expect(await readLock(join(inst, ".metistry", "metistry.lock"))).toBeUndefined();
    await mkdir(join(inst, ".metistry"), { recursive: true });
    await writeFile(join(inst, ".metistry", "metistry.lock"), text);
    expect(await readLock(join(inst, ".metistry", "metistry.lock"))).toEqual(lock);

    // the first by-hand instance's shape (init before 2026-09-07)
    expect(parseLock("version: 0.0.1\ncreated: 2026-09-06\n")).toEqual({ product: { version: "0.0.1", commit: "unknown", source: "git" }, updated_at: "2026-09-06T00:00:00.000Z", migrations_applied: [] });

    for (const bad of ["", "product: 1\n", "product: {version: x, commit: y, source: svn}\nupdated_at: 2026-01-01T00:00:00Z\nmigrations_applied: []\n", "product: {version: x, commit: y, source: git}\nupdated_at: yesterday\nmigrations_applied: []\n", "product: {version: x, commit: y, source: git}\nupdated_at: 2026-01-01T00:00:00Z\nmigrations_applied: 3\n"]) {
      expect(() => parseLock(bad), JSON.stringify(bad)).toThrow(/metistry\.lock:/);
    }
    expect(instanceLockPath({ METISTRY_INSTANCE_DIR: "/x/inst/" })).toBe("/x/inst/.metistry/metistry.lock");
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

  // #198's "not fixed here" #2: `--version` was a boolean flag, so the value
  // never reached `update` and the documented `--version <x.y.z>` installed
  // whatever was latest.
  it("main: `update --version 0.2.0 --channel release` asks for THAT release, not the latest", async () => {
    const P = await checkout({ git: true });
    const lines: string[] = [];
    expect(await main(["update", "--version", "0.2.0", "--channel", "release", "--dry-run", "--product-dir", P], { out: (l) => lines.push(l), err: () => {}, exec: fakeExec() })).toBe(0);
    const text = lines.join("\n");
    expect(text).toContain("resolve release 0.2.0 of");
    expect(text).toContain("metistry-runtime-0.2.0-");
    expect(text).not.toContain("<latest>");
  });

  // …and #3: in git mode the version was read BEFORE the pull, so a checkout
  // that fast-forwarded onto a new release pinned the old number.
  it("git mode pins the version the checkout has AFTER the pull, not the one this process was built from", async () => {
    const P = await checkout({ git: true });
    const inst = await mkdtemp(join(tmpdir(), "mi-"));
    // the pull is what brings the new package.json onto disk
    const exec = fakeExec({
      git: (args) => {
        if (args[0] === "pull") writeFileSync(join(P, "package.json"), JSON.stringify({ name: "metistry", version: "0.8.2" }));
        if (args[0] === "rev-parse") return { stdout: "feedfacefeedfacefeedfacefeedfacefeedface\n" };
        return undefined;
      },
    });
    const lines: string[] = [];
    const r = await update({ ...base(P, { METISTRY_INSTANCE_DIR: inst, ...BRIDGE }), out: (l) => lines.push(l), exec, fetchFn: fakeFetch().fn, skipBuild: true, skipMigrate: true, doctorFn: okDoctor });
    // `version: "0.0.9"` is what base() passes — the pre-pull code's own
    expect(r.lock?.product.version).toBe("0.8.2");
    expect(lines.join("\n")).toContain("version: 0.0.9 → 0.8.2");
    expect(lines.join("\n")).toContain("metistry update → 0.8.2");
  });
});

// ---- the legacy-layout gate --------------------------------------------------
//
// An instance that has not run `metistry migrate-layout` is readable on the
// 0.8.x line and nothing past it. The refusal lands BEFORE the fetch, so a
// refused update leaves the checkout exactly where it was.

describe("the legacy instance layout", () => {
  it("knows which versions are past the line", () => {
    for (const v of ["0.8.0", "0.8.1", "0.8.12", "0.7.0", "v0.8.3"]) expect(pastLegacyLayoutSupport(v), v).toBe(false);
    for (const v of ["0.9.0", "0.10.0", "1.0.0", "v1.2.3"]) expect(pastLegacyLayoutSupport(v), v).toBe(true);
    // a tag, a hash, `<latest>`: unparseable is never "past" — a refusal has to be sure
    for (const v of ["<latest>", "main", "abc1234", ""]) expect(pastLegacyLayoutSupport(v), v).toBe(false);
  });

  it("refuses only a legacy instance, only past the line, and only without --allow-legacy", () => {
    const at = (o: Partial<Parameters<typeof legacyLayoutRefusal>[0]>) => legacyLayoutRefusal({ shape: "legacy", instanceDir: "/i", version: "0.9.0", ...o });
    expect(at({})).toContain("metistry migrate-layout");
    expect(at({})).toContain("--allow-legacy");
    expect(at({ allowLegacy: true })).toBeNull();
    expect(at({ version: "0.8.2" })).toBeNull();
    expect(at({ shape: "flat" })).toBeNull();
    expect(at({ shape: "unknown" })).toBeNull();
  });

  it("stops `update` before it fetches, and says which instance and which version", async () => {
    const P = await checkout({ git: true });
    const I = await mkdtemp(join(tmpdir(), "metistry-legacy-"));
    await mkdir(join(I, "Knowledge"), { recursive: true });
    await writeFile(join(I, "identity.yaml"), "name: X\n");
    const exec = fakeExec();
    const lines: string[] = [];
    const r = await update({ ...base(P, { METISTRY_INSTANCE_DIR: I }), version: "0.9.0", exec, out: (l) => lines.push(l), doctorFn: okDoctor, openSession: async () => null });
    expect(r.code).not.toBe(0);
    expect(exec.calls.map((c) => c.cmd)).toEqual([]); // nothing fetched, nothing built, nothing migrated
    const said = lines.join("\n");
    expect(said).toContain(I);
    expect(said).toContain("0.9.0");
    expect(said).toContain("metistry migrate-layout");
    expect(r.lock).toBeUndefined();
  });

  it("lets it through on the same instance with --allow-legacy", async () => {
    const P = await checkout({ git: true });
    const I = await mkdtemp(join(tmpdir(), "metistry-legacy-"));
    await mkdir(join(I, "Knowledge"), { recursive: true });
    await writeFile(join(I, "identity.yaml"), "name: X\n");
    const exec = fakeExec();
    await update({ ...base(P, { METISTRY_INSTANCE_DIR: I, ...BRIDGE }), version: "0.9.0", allowLegacy: true, exec, fetchFn: fakeFetch().fn, out: () => {}, doctorFn: okDoctor, openSession: async () => fakeSession() });
    expect(exec.calls.map((c) => c.cmd)).toContain("git"); // it got as far as the fetch
  });

  it("asks again after the pull, where git mode first learns the new version", async () => {
    const P = await checkout({ git: true });
    const I = await mkdtemp(join(tmpdir(), "metistry-legacy-"));
    await mkdir(join(I, "Knowledge"), { recursive: true });
    await writeFile(join(I, "identity.yaml"), "name: X\n");
    // the pre-pull version is on the supported line, so the first gate lets it
    // through; the pull brings the checkout's own package.json past it
    const exec = fakeExec({ git: (args) => (args[0] === "pull" ? (writeFileSync(join(P, "package.json"), JSON.stringify({ name: "metistry", version: "0.9.0" })), undefined) : undefined) });
    const lines: string[] = [];
    // the running CLI is pinned to the supported line explicitly: the default is
    // this package's own version, which moves past 0.8.x on release and would
    // make the first gate refuse before the fetch
    const r = await update({ ...base(P, { METISTRY_INSTANCE_DIR: I }), version: "0.8.1", exec, out: (l) => lines.push(l), doctorFn: okDoctor, openSession: async () => null });
    expect(r.code).not.toBe(0);
    // it pulled, and then stopped: nothing installed, nothing built, nothing migrated
    expect(exec.calls.map((c) => c.args[0])).toEqual(["fetch", "pull"]);
    expect(lines.join("\n")).toContain("metistry migrate-layout");
    expect(r.lock).toBeUndefined();
  });

  it("says nothing on a flat instance", async () => {
    const P = await checkout({ git: true });
    const I = await mkdtemp(join(tmpdir(), "metistry-flat-"));
    await mkdir(join(I, ".metistry"), { recursive: true });
    await writeFile(join(I, ".metistry", "identity.yaml"), "name: X\n");
    const lines: string[] = [];
    const r = await update({ ...base(P, { METISTRY_INSTANCE_DIR: I, ...BRIDGE }), version: "0.9.0", exec: fakeExec(), fetchFn: fakeFetch().fn, out: (l) => lines.push(l), doctorFn: okDoctor, openSession: async () => fakeSession() });
    expect(r.code).toBe(0);
    expect(lines.join("\n")).not.toContain("migrate-layout");
  });
});

// W1 checkpoint D1: an update that changes the manifest schema must not be
// judged by the pre-update code's schema. The closing doctor is the UPDATED
// CLI's, run as a child; these tests stand a fake CLI where the new build
// would be and run it for real.
describe("update's closing doctor runs the updated CLI", () => {
  /** A fake `packages/cli/dist/main.js`: prints a report naming its own argv, exits like doctor does. */
  const fakeCli = async (P: string, body: string) => {
    await mkdir(join(P, "packages", "cli", "dist"), { recursive: true });
    await writeFile(join(P, "packages", "cli", "dist", "main.js"), body);
  };
  const reporting = (ok: boolean) =>
    `const report = { as_of: "now", product_dir: "x", shape: "compose", ok: ${ok}, rows: [{ kind: "manifest", name: "new-schema", status: "${ok ? "ok" : "failed"}", latency_ms: 0, probe: process.argv.slice(2).join(" "), remediation: "from the child" }] };\n` +
    `process.stdout.write(JSON.stringify(report, null, 2) + "\\n");\nprocess.exit(report.ok ? 0 : 1);\n`;
  /** Every other subprocess stays fake; only the fake CLI really runs. */
  const hybrid = (): Exec & { calls: ReturnType<typeof fakeExec>["calls"] } => {
    const fake = fakeExec();
    const exec = (async (cmd, args, o) => (args[0]?.endsWith("dist/main.js") ? (fake.calls.push({ cmd, args, cwd: o?.cwd }), realExec(cmd, args, o)) : fake(cmd, args, o))) as Exec & { calls: typeof fake.calls };
    exec.calls = fake.calls;
    return exec;
  };
  /** `fallbackOk`: what the in-process (pre-update) doctor would say, were it asked */
  const run = async (P: string, extra: Partial<Parameters<typeof update>[0]> = {}, fallbackOk = false) => {
    const lines: string[] = [];
    let inProcess = false;
    const r = await update({
      ...base(P, BRIDGE),
      out: (l) => lines.push(l),
      exec: hybrid(),
      skipBuild: true,
      skipMigrate: true,
      fetchFn: fakeFetch().fn,
      closingDoctor: "child",
      doctorFn: async (d) => ((inProcess = true), fallbackOk ? okDoctor(d) : failDoctor(d)),
      ...extra,
    });
    return { r, text: lines.join("\n"), inProcess: () => inProcess };
  };

  it("runs `node <run-dir>/packages/cli/dist/main.js doctor --json` and takes ITS verdict, not this process's", async () => {
    const P = await checkout({ git: true });
    await fakeCli(P, reporting(true));
    const { r, text, inProcess } = await run(P);
    expect(inProcess()).toBe(false); // the in-process doctor would have said FAILED
    expect(r.code).toBe(0);
    expect(r.commands.some((c) => c.endsWith(`${join(P, "packages", "cli", "dist", "main.js")} doctor --json --product-dir ${P}`))).toBe(true);
    expect(text).toContain("new-schema");
    expect(text).toContain("update ok");
  });

  it("a child that is not happy keeps the same exit semantics: 1, and the summary says so", async () => {
    const P = await checkout({ git: true });
    await fakeCli(P, reporting(false));
    const { r, text, inProcess } = await run(P, {}, true);
    expect(inProcess()).toBe(false);
    expect(r.code).toBe(1);
    expect(text).toContain("from the child");
    expect(text).toContain("updated, and doctor is not happy");
  });

  it("passes --env-file through, so the child reads the same environment", async () => {
    const P = await checkout({ git: true });
    await fakeCli(P, reporting(true));
    const { r } = await run(P, { envFile: join(P, "custom.env") });
    expect(r.commands.some((c) => c.endsWith(`doctor --json --product-dir ${P} --env-file ${join(P, "custom.env")}`))).toBe(true);
  });

  it("no updated CLI on disk: falls back to the in-process doctor, and says the answer is the pre-update code's", async () => {
    const P = await checkout({ git: true });
    const { r, text, inProcess } = await run(P);
    expect(inProcess()).toBe(true);
    expect(r.code).toBe(1);
    expect(text).toContain(`closing doctor: no updated CLI at ${join(P, "packages", "cli", "dist", "main.js")} — running this process's doctor instead`);
    expect(text).toContain("a standalone `metistry doctor` is the truth");
  });

  it("a child that crashes without a report: falls back, naming its exit code and last line", async () => {
    const P = await checkout({ git: true });
    await fakeCli(P, `process.stderr.write("SyntaxError: the new build is broken\\n");\nprocess.exit(3);\n`);
    const { r, text, inProcess } = await run(P, {}, true);
    expect(r.code).toBe(0); // the fallback's verdict
    expect(inProcess()).toBe(true);
    expect(text).toContain("closing doctor: the updated CLI's doctor exited 3 without a report (SyntaxError: the new build is broken)");
  });

  it("a dry run spawns nothing and lists the doctor as before", async () => {
    const P = await checkout({ git: true });
    await fakeCli(P, reporting(true));
    const exec = hybrid();
    const r = await update({ ...base(P, BRIDGE), exec, dryRun: true, fetchFn: fakeFetch().fn, closingDoctor: "child" });
    expect(exec.calls).toEqual([]);
    expect(r.commands.at(-1)).toBe("metistry doctor");
  });

  it("parseDoctorJson takes a report and nothing else", () => {
    expect(parseDoctorJson('{"ok":true,"rows":[],"as_of":"x","product_dir":"p","shape":"compose"}')?.ok).toBe(true);
    for (const bad of ["", "not json", "null", '{"ok":"yes","rows":[]}', '{"ok":true}', '{"ok":true,"rows":[]'] as const) expect(parseDoctorJson(bad)).toBeUndefined();
  });
});
