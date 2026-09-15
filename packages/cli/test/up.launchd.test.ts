// `metistry up` on the launchd shape (open decision 15): no docker at all,
// a user-space Postgres bootstrapped before its plist is bootstrapped, and
// the console/assistant/db plists rendered from the REAL ops/launchd
// templates in this checkout — so a template edit that breaks rendering
// fails here rather than on someone's machine.
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { realPathish } from "../src/sandbox.js";
import { ENGINE_ABSENT_NOTE } from "../src/deployment.js";
import { nodeFor, up } from "../src/up.js";
import { checkout, fakeExec, okDoctor, shown } from "./fixtures.js";

const REPO = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");
const NODE = "/usr/local/bin/node";
const PG = "/opt/homebrew/opt/postgresql@17/bin";

/** A synthetic checkout carrying this repo's real plists and sandbox profile. */
async function launchdCheckout(): Promise<string> {
  const P = await checkout();
  await cp(join(REPO, "ops", "launchd"), join(P, "ops", "launchd"), { recursive: true });
  await cp(join(REPO, "ops", "sandbox"), join(P, "ops", "sandbox"), { recursive: true });
  await writeFile(join(P, ".env"), "METISTRY_ORIGIN=https://studio.ts.net\n");
  return P;
}

const env = (instance: string): NodeJS.ProcessEnv => ({
  METISTRY_INSTANCE_DIR: instance,
  METISTRY_DB_PASSWORD: "pw",
  METISTRY_ORIGIN: "https://studio.ts.net",
  METISTRY_ASSISTANT_TOKEN: "tok",
  CLAUDE_CODE_OAUTH_TOKEN: "oauth",
  METISTRY_EK_URL: "http://host.docker.internal:7811",
  HOME: "/h",
  TMPDIR: "/tmp",
});

/** Every Postgres binary is present; nothing else on the fake filesystem is. */
const pgInstalled = (extra: string[] = []) => {
  const set = new Set(extra);
  return (p: string) => p.startsWith(PG) || set.has(p);
};

const launchd = { shape: "launchd" as const, services: {} };

describe("metistry up --dry-run, launchd shape", () => {
  it("plans postgres, then every job including console/assistant/db, then the database — and never calls docker", async () => {
    const P = await launchdCheckout();
    const I = await mkdtemp(join(tmpdir(), "metistry-inst-"));
    const exec = fakeExec();
    const lines: string[] = [];
    const r = await up({
      productDir: P,
      env: env(I),
      exec,
      out: (l) => lines.push(l),
      dryRun: true,
      platform: "darwin",
      uid: 501,
      home: "/h",
      node: NODE,
      deployment: launchd,
      exists: pgInstalled(),
      mintPassword: () => "generated",
      doctorFn: okDoctor,
    });

    expect(r.code).toBe(0);
    expect(exec.calls).toEqual([]);
    expect(r.commands.join("\n")).not.toContain("docker");
    expect(lines.some((l) => l.includes("shape: launchd"))).toBe(true);

    const LA = "/h/Library/LaunchAgents";
    const SUP = "com.foldedspacelabs.metistry";
    expect(r.commands).toEqual([
      `mkdir -p ${I}/state/run`,
      `write ${I}/state/pg.pwfile  (from generated superuser password (deleted in the next step))`,
      `${PG}/initdb -D ${I}/state/pg -U metistry --pwfile=${I}/state/pg.pwfile --encoding=UTF8 --locale=C --auth-local=trust --auth-host=scram-sha-256`,
      `/bin/rm -f ${I}/state/pg.pwfile`,
      `write ${I}/state/pg/postgresql.conf  (from metistry managed block: loopback listen + unix socket)`,
      `mkdir -p ${I}/state/assistant`,
      // 1. the pre-supervisor agents go, once: every one of them is a child now
      ...["db", "console", "assistant", "reconciler", "watchdog", "eventkit", "apple-fm", "eventkit-helper"].flatMap((s) => [
        `launchctl bootout gui/501/${SUP}.${s}`,
        `rm -f ${LA}/${SUP}.${s}.plist`,
      ]),
      // 2. the supervisor's plan: the `Metistry` symlink System Settings names
      // the background item after, and the child list
      `mkdir -p ${I}/state/bin`,
      `ln -sfn ${NODE} ${I}/state/bin/Metistry`,
      `mkdir -p ${I}/state/run`,
      // apple-fm is absent on purpose: METISTRY_AFM_URL is unset, so this
      // install has no Apple Intelligence bridge and nothing starts one
      `write ${I}/state/supervisor.json  (from 5 child(ren): db, console, reconciler, assistant, eventkit)`,
      `chmod 600 ${I}/state/supervisor.json`,
      // 3. ONE agent for the core…
      expect.stringContaining(`write ${LA}/${SUP}.plist`),
      // 4. …plus the TCC helper, which must be its own binary for the grant —
      // both written before either is bootstrapped, so the TCC pin
      // (tcc-pin.ts) runs against what is actually on disk before launchd
      // loads any of it
      expect.stringContaining(`write ${LA}/${SUP}.calendar.plist`),
      `launchctl bootout gui/501/${SUP}`,
      `launchctl bootstrap gui/501 ${LA}/${SUP}.plist`,
      `launchctl kickstart -k gui/501/${SUP}`,
      `launchctl bootout gui/501/${SUP}.calendar`,
      `launchctl bootstrap gui/501 ${LA}/${SUP}.calendar.plist`,
      `launchctl kickstart -k gui/501/${SUP}.calendar`,
      `${PG}/pg_isready -h ${I}/state/run -p 5432 -U metistry -d metistry`,
      `${PG}/createdb -h ${I}/state/run -p 5432 -U metistry metistry`,
      "metistry doctor",
    ]);
  });

  it("a missing Postgres is a printed remediation, never an install this tool runs", async () => {
    const P = await launchdCheckout();
    const I = await mkdtemp(join(tmpdir(), "metistry-inst-"));
    const lines: string[] = [];
    const r = await up({
      productDir: P,
      env: env(I),
      exec: fakeExec(),
      out: (l) => lines.push(l),
      dryRun: true,
      platform: "darwin",
      uid: 501,
      home: "/h",
      node: NODE,
      deployment: launchd,
      exists: () => false,
      doctorFn: okDoctor,
    });
    expect(r.code).toBe(1);
    const text = lines.join("\n");
    expect(text).toMatch(/brew install postgresql@17 pgvector/);
    expect(text).toMatch(/Nothing is installed for you/);
    expect(r.commands).toEqual(["metistry doctor"]); // it stopped before touching anything
  });

  it("an initialised data directory is never re-initdb'd", async () => {
    const P = await launchdCheckout();
    const I = await mkdtemp(join(tmpdir(), "metistry-inst-"));
    const r = await up({
      productDir: P,
      env: env(I),
      exec: fakeExec(),
      out: () => {},
      dryRun: true,
      platform: "darwin",
      uid: 501,
      home: "/h",
      node: NODE,
      deployment: launchd,
      exists: pgInstalled([join(I, "state", "pg", "PG_VERSION")]),
      doctorFn: okDoctor,
    });
    expect(r.commands.filter((c) => c.includes("initdb"))).toEqual([]);
    expect(r.commands.some((c) => c.includes("postgresql.conf"))).toBe(true);
  });
});

describe("the rendered plists", () => {
  it("leave no placeholder, keep secrets out of ProgramArguments, and confine the engine", async () => {
    const P = await launchdCheckout();
    const I = await mkdtemp(join(tmpdir(), "metistry-inst-"));
    const home = await mkdtemp(join(tmpdir(), "metistry-home-"));
    await mkdir(join(P, "apps", "console", "dist"), { recursive: true });
    const r = await up({
      productDir: P,
      env: env(I),
      exec: fakeExec(),
      out: () => {},
      platform: "darwin",
      uid: 501,
      home,
      node: NODE,
      deployment: launchd,
      exists: pgInstalled(),
      doctorFn: okDoctor,
    });
    expect(r.code).toBe(0);
    const read = (label: string) => readFile(join(home, "Library", "LaunchAgents", `com.foldedspacelabs.metistry${label ? `.${label}` : ""}.plist`), "utf8");

    // the core is ONE agent now: console/assistant/db have no plist of their
    // own, and what they run lives in the supervisor's config
    const config = JSON.parse(await readFile(join(I, "state", "supervisor.json"), "utf8"));
    expect(config.label).toBe("com.foldedspacelabs.metistry");
    expect(config.socket).toBe(join(I, "state", "run", "supervisor.sock"));
    expect(config.token).toMatch(/^[0-9a-f]{64}$/);
    expect(config.children.map((c: { name: string }) => c.name)).toEqual(["db", "console", "reconciler", "assistant", "eventkit"]);
    const child = (name: string) => config.children.find((c: { name: string }) => c.name === name);

    // ordered start: Postgres answers before the console starts, the console
    // before everything after it
    expect(child("db").ready).toEqual({ kind: "tcp", port: 5432 });
    expect(child("console").ready).toEqual({ kind: "tcp", port: 8080 });
    expect(child("reconciler").ready).toBeUndefined();

    const console_ = JSON.stringify(child("console"));
    expect(console_).not.toMatch(/__[A-Z][A-Z0-9_]*__/);
    expect(child("console").argv).toEqual([NODE, `${P}/apps/console/dist/main.js`]);
    // env by dict, never `sh -c` with an interpolated .env
    expect(child("console").argv[0]).not.toBe("/bin/sh");
    expect(child("console").env).toMatchObject({
      METISTRY_CONSOLE_HOST: "127.0.0.1",
      METISTRY_DB_HOST: "127.0.0.1",
      METISTRY_EK_URL: "http://127.0.0.1:7811",
      METISTRY_INBOX_DIR: `${I}/inbox`,
    });

    const assistant = child("assistant");
    expect(JSON.stringify(assistant)).not.toMatch(/__[A-Z][A-Z0-9_]*__/);
    expect(assistant.argv[0]).toBe("/usr/bin/sandbox-exec");
    expect(assistant.argv).toContain(`${P}/ops/sandbox/assistant.sb`);
    expect(assistant.argv).toContain("CONSOLE_TCP=localhost:8080");
    // the sandbox's path parameters are REAL paths (/var/folders → /private/var/folders)
    expect(assistant.argv).toContain(`STATE_DIR=${realPathish(join(I, "state", "assistant"))}`);
    expect(assistant.argv).toContain(`PRODUCT_DIR=${realPathish(P)}`);
    expect(assistant.env.HOME).toBe(`${I}/state/assistant`);
    expect(assistant.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth");
    // the engine's environment is still an ALLOWLIST, and a child's
    // environment is the spec's whole: the supervisor's own never leaks in
    expect(assistant.env.METISTRY_ORIGIN).toBeUndefined();
    expect(Object.keys(assistant.env).sort()).toEqual(
      ["CLAUDE_CODE_OAUTH_TOKEN", "HOME", "METISTRY_ASSISTANT_TOKEN", "METISTRY_BRAIN_URL", "METISTRY_DB_HOST", "METISTRY_DB_PASSWORD", "METISTRY_DB_PORT", "PATH", "TMPDIR"].sort(),
    );

    expect(child("db").argv).toEqual([`${PG}/postgres`, "-D", `${I}/state/pg`]);

    // the jobs that exist in BOTH shapes still source a dotenv file with
    // sh -c — but the INSTANCE's, not the checkout's (self-contained instances)
    expect(child("reconciler").argv.join(" ")).toContain(`set -a; . '${I}/state/.env'; set +a; exec '${NODE}' '${P}/apps/reconciler/dist/main.js'`);
    expect(child("reconciler").log).toBe("/tmp/metistry-reconciler.log");

    // the supervisor's own plist: 0600, because its dict carries the db password
    const sup = await read("");
    expect(sup).not.toMatch(/__[A-Z][A-Z0-9_]*__/);
    expect(sup).toContain(`<string>${I}/state/bin/Metistry</string>`);
    expect(sup).toContain(`<string>${P}/apps/watchdog/dist/main.js</string>`);
    expect(sup).toContain(`<string>${I}/state/supervisor.json</string>`);
  });

  it("under the compose shape the shaped plists are not installed at all", async () => {
    const P = await launchdCheckout();
    const home = await mkdtemp(join(tmpdir(), "metistry-home-"));
    const exec = fakeExec();
    await up({
      productDir: P,
      env: { HOME: home },
      exec,
      out: () => {},
      platform: "darwin",
      uid: 501,
      home,
      node: NODE,
      deployment: { shape: "compose", services: {} },
      doctorFn: okDoctor,
    });
    const labels = exec.calls.map(shown).filter((c) => c.startsWith("launchctl bootstrap"));
    expect(labels.some((l) => l.includes(".console.plist"))).toBe(false);
    expect(labels.some((l) => l.includes(".assistant.plist"))).toBe(false);
    expect(labels.some((l) => l.includes(".db.plist"))).toBe(false);
    expect(labels.some((l) => l.includes(".watchdog.plist"))).toBe(true);
    expect(exec.calls.map(shown)[0]).toBe("docker compose up -d --build");
  });
});

describe("the node every launchd job execs", () => {
  it("prefers the bundled runtime's node over whatever is on PATH", async () => {
    const P = await launchdCheckout();
    const bundled = join(P, "runtime", "node", "bin", "node");
    // a clean Mac has NO node until Xcode CLT is installed, and a launchd job
    // gets /usr/bin:/bin with no login shell — so a bundled install whose
    // plists exec $(which node) is one Homebrew uninstall away from dead
    expect(nodeFor(P, { PATH: "/opt/homebrew/bin" }, (p) => p === bundled)).toEqual({ node: bundled, why: "bundled runtime/node/bin/node" });
  });

  it("falls back to $(which node) when there is no bundled runtime — a checkout is unchanged", async () => {
    const P = await launchdCheckout();
    expect(nodeFor(P, { PATH: "/opt/homebrew/bin" }, (p) => p === "/opt/homebrew/bin/node")).toEqual({ node: "/opt/homebrew/bin/node", why: "$(which node)" });
  });

  it("`up` renders that node into every plist, and the sandbox grants exec on ITS prefix, not Homebrew's", async () => {
    const P = await launchdCheckout();
    const I = await mkdtemp(join(tmpdir(), "metistry-inst-"));
    const home = await mkdtemp(join(tmpdir(), "metistry-home-"));
    const bundled = join(P, "runtime", "node", "bin", "node");
    await mkdir(join(P, "runtime", "node", "bin"), { recursive: true });
    await writeFile(bundled, "#!/bin/sh\n");
    const lines: string[] = [];
    const r = await up({
      productDir: P,
      env: env(I),
      exec: fakeExec(),
      out: (l) => lines.push(l),
      platform: "darwin",
      uid: 501,
      home,
      deployment: launchd,
      exists: pgInstalled([bundled]),
      doctorFn: okDoctor,
    });
    expect(r.code).toBe(0);
    expect(lines.some((l) => l.includes(`node: ${bundled} (bundled runtime/node/bin/node)`))).toBe(true);
    const config = JSON.parse(await readFile(join(I, "state", "supervisor.json"), "utf8"));
    const assistant = config.children.find((c: { name: string }) => c.name === "assistant");
    expect(assistant.argv).toContain(bundled);
    // the sandbox may exec node — THIS node. A Homebrew prefix in the profile
    // would grant /opt/homebrew and deny the runtime the jobs actually use.
    expect(assistant.argv).toContain(`NODE_PREFIX=${realPathish(join(P, "runtime", "node"))}`);
    expect(JSON.stringify(assistant)).not.toContain("/opt/homebrew");
    // and the supervisor's own program is a symlink to it, named `Metistry`
    expect(await readFile(join(home, "Library", "LaunchAgents", "com.foldedspacelabs.metistry.plist"), "utf8")).toContain(`<string>${I}/state/bin/Metistry</string>`);
  });
});

describe("an instance with no engine credential (W1)", () => {
  /** The same install, minus the one variable the engine cannot start without. */
  const noEngine = (instance: string): NodeJS.ProcessEnv => {
    const e = env(instance);
    delete e.CLAUDE_CODE_OAUTH_TOKEN;
    return e;
  };

  /** The line an operator has to be able to read without knowing the code. */
  const ABSENT_LINE =
    "assistant: absent — no engine credential (CLAUDE_CODE_OAUTH_TOKEN); captures, tasks, search and the console run; fold turns wait (docs/ops/assistant-tools.md)";

  it("is not written into the supervisor's children, and `up` says why in one line", async () => {
    const P = await launchdCheckout();
    const I = await mkdtemp(join(tmpdir(), "metistry-inst-"));
    const lines: string[] = [];
    const r = await up({
      productDir: P,
      env: noEngine(I),
      exec: fakeExec(),
      out: (l) => lines.push(l),
      dryRun: true,
      platform: "darwin",
      uid: 501,
      home: "/h",
      node: NODE,
      deployment: launchd,
      exists: pgInstalled(),
      mintPassword: () => "generated",
      doctorFn: okDoctor,
    });

    // an install with no model is healthy, not broken: nothing failed here
    expect(r.code).toBe(0);
    expect(ENGINE_ABSENT_NOTE).toBe(ABSENT_LINE);
    expect(lines.map((l) => l.trim())).toContain(ABSENT_LINE);
    // the child list: everything model-free, and no assistant that could
    // only crash-loop on `requireEnv`
    expect(r.commands).toContain(`write ${I}/state/supervisor.json  (from 4 child(ren): db, console, reconciler, eventkit)`);
  });

  it("and comes back on the next `up` once the credential exists — the config is rewritten whole, so it is idempotent", async () => {
    const P = await launchdCheckout();
    const I = await mkdtemp(join(tmpdir(), "metistry-inst-"));
    const home = await mkdtemp(join(tmpdir(), "metistry-home-"));
    const opts = { productDir: P, exec: fakeExec(), out: () => {}, platform: "darwin" as const, uid: 501, home, node: NODE, deployment: launchd, exists: pgInstalled(), doctorFn: okDoctor };
    const children = async () => {
      const c = JSON.parse(await readFile(join(I, "state", "supervisor.json"), "utf8"));
      return { names: c.children.map((x: { name: string }) => x.name) as string[], token: c.token as string };
    };

    expect((await up({ ...opts, env: noEngine(I) })).code).toBe(0);
    const before = await children();
    expect(before.names).toEqual(["db", "console", "reconciler", "eventkit"]);

    // `metistry secrets sync` happened; the next `up` is the only step needed
    expect((await up({ ...opts, env: env(I) })).code).toBe(0);
    const after = await children();
    expect(after.names).toEqual(["db", "console", "reconciler", "assistant", "eventkit"]);
    // the control socket's secret survives, as it does on any re-run
    expect(after.token).toBe(before.token);

    // and taking it away again removes the child, without hand-editing anything
    expect((await up({ ...opts, env: noEngine(I) })).code).toBe(0);
    expect((await children()).names).toEqual(["db", "console", "reconciler", "eventkit"]);
  });

  it("under the compose shape it says the file itself refuses to interpolate — that shape needs the credential", async () => {
    const P = await launchdCheckout();
    const I = await mkdtemp(join(tmpdir(), "metistry-inst-"));
    const lines: string[] = [];
    await up({
      productDir: P,
      env: noEngine(I),
      exec: fakeExec(),
      out: (l) => lines.push(l),
      dryRun: true,
      platform: "darwin",
      uid: 501,
      home: "/h",
      node: NODE,
      deployment: { shape: "compose", services: {} },
      doctorFn: okDoctor,
    });
    const text = lines.join("\n");
    expect(text).toContain(ABSENT_LINE);
    expect(text).toMatch(/compose shape: docker-compose\.yml interpolates CLAUDE_CODE_OAUTH_TOKEN as a required variable/);
  });
});
