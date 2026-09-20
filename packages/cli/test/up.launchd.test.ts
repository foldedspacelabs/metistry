// `metistry up` on the launchd shape (open decision 15): no docker at all,
// a user-space Postgres bootstrapped before its plist is bootstrapped, and
// the console/assistant/db plists rendered from the REAL ops/launchd
// templates in this checkout — so a template edit that breaks rendering
// fails here rather than on someone's machine.
import { statSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EGRESS_PROXY_DEFAULT_PORT } from "@foldedspacelabs/metistry-core";
import { CLT_GIT, realPathish } from "../src/sandbox.js";
import { engineAbsentNote } from "../src/deployment.js";
import { parsePlistTemplate } from "../src/launchd.js";
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
  // This install's compute (C2/C3): `assignments.default` plus the key its
  // provider names is what decides whether there is an assistant child at
  // all, and which secret the engine's env allowlist admits.
  await writeFile(
    join(P, "seed", "compute.yaml"),
    `providers:
  openrouter:
    kind: openai-compatible
    base_url: https://openrouter.ai/api/v1
    locality: off_machine
    auth: { secret: METISTRY_OPENROUTER_API_KEY }
    data_policy: { allow: [Projects], deny_sources: [comms], max_brief_bytes: 65536 }
assignments:
  default: { model: openrouter/anthropic/claude-sonnet-5 }
`,
  );
  return P;
}

const env = (instance: string): NodeJS.ProcessEnv => ({
  METISTRY_INSTANCE_DIR: instance,
  METISTRY_DB_PASSWORD: "pw",
  METISTRY_ORIGIN: "https://studio.ts.net",
  METISTRY_ASSISTANT_TOKEN: "tok",
  METISTRY_OPENROUTER_API_KEY: "sk-or-x",
  METISTRY_EK_URL: "http://host.docker.internal:7811",
  HOME: "/h",
  TMPDIR: "/tmp",
});

/** Every Postgres binary is present; nothing else on the fake filesystem is. */
/** A fake `exists` for the Postgres toolchain — plus, by default, the Command Line Tools' git, which is the one the reconciler's profile names on a Mac with no bundled runtime. */
const pgInstalled = (extra: string[] = [], git = true) => {
  const set = new Set(extra);
  return (p: string) => p.startsWith(PG) || (git && p === CLT_GIT) || set.has(p);
};

const launchd = { shape: "launchd" as const, services: {} };

describe("metistry up --dry-run, launchd shape", () => {
  it("plans postgres, then every job including console/assistant/db, then the database — and never calls docker", async () => {
    const P = await launchdCheckout();
    const I = await mkdtemp(join(tmpdir(), "mi-" /* short on purpose: the supervisor socket under .metistry/state/run/ has ~103 bytes to live in */));
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
      // cli-shim.test.ts covers the shim itself, including its launchd-shape
      // collision with the supervisor's own `bin/Metistry` symlink.
      cliShim: false,
    });

    if (r.code !== 0) console.error(lines.join('\n'));
    expect(r.code).toBe(0);
    expect(exec.calls).toEqual([]);
    expect(r.commands.join("\n")).not.toContain("docker");
    expect(lines.some((l) => l.includes("shape: launchd"))).toBe(true);
    // --dry-run names the profile each confined child will run under, and
    // the one door their egress goes through — before anything is installed
    const plan = lines.join("\n");
    expect(plan).toContain(`reconciler: confined by ops/sandbox/reconciler.sb`);
    expect(plan).toContain(`${CLT_GIT}`);
    expect(plan).toMatch(/egress: one CONNECT proxy on 127\.0\.0\.1:7814 in the supervisor/);
    expect(plan).toContain("openrouter.ai");
  });

  it("arranges the confined reconciler's push credential: an askpass shim, and a keychain item for the supervisor to fetch", async () => {
    const P = await launchdCheckout();
    const I = await mkdtemp(join(tmpdir(), "mi-"));
    const home = await mkdtemp(join(tmpdir(), "metistry-home-"));
    // an instance repo pointed at a private remote the way `metistry
    // connect-repo` leaves it: an https origin AND the osxkeychain helper
    // that cannot run confined
    await mkdir(join(I, ".git"), { recursive: true });
    await writeFile(
      join(I, ".git", "config"),
      '[remote "origin"]\n\turl = https://github.com/owner/vault.git\n[credential]\n\thelper = osxkeychain\n',
    );
    await mkdir(join(P, "apps", "console", "dist"), { recursive: true });
    const lines: string[] = [];
    const r = await up({
      productDir: P,
      env: env(I),
      exec: fakeExec(),
      out: (l) => lines.push(l),
      platform: "darwin",
      uid: 501,
      home,
      node: NODE,
      deployment: launchd,
      exists: pgInstalled(),
      doctorFn: okDoctor,
    });
    expect(r.code).toBe(0);
    const plan = lines.join("\n");

    // the shim exists, is executable, and carries THIS install's node
    const shim = join(I, ".metistry", "state", "bin", "git-askpass");
    const script = await readFile(shim, "utf8");
    expect(script.split("\n")[0]).toBe(`#!${NODE}`);
    expect(script).toContain("METISTRY_GIT_ASKPASS_TOKEN");
    expect((statSync(shim).mode & 0o777).toString(8)).toBe("755");

    const config = JSON.parse(await readFile(join(I, ".metistry", "state", "supervisor.json"), "utf8"));
    // supervisor.json says WHICH keychain item to fetch, and never what it holds
    expect(config.gitCredentials).toEqual([{ child: "reconciler", host: "github.com" }]);
    expect(JSON.stringify(config)).not.toMatch(/ASKPASS_TOKEN"\s*:/);

    const rec = config.children.find((c: { name: string }) => c.name === "reconciler");
    // the job carries the shim's PATH; the credential itself arrives at spawn
    expect(rec.env.METISTRY_GIT_ASKPASS).toBe(shim);
    expect(rec.env.METISTRY_GIT_ASKPASS_TOKEN).toBeUndefined();
    expect(rec.argv.join(" ")).toContain(`-D 'ASKPASS_BIN=${realPathish(shim)}'`);
    // the engine is confined too and gets none of this
    expect(config.children.find((c: { name: string }) => c.name === "assistant").env.METISTRY_GIT_ASKPASS).toBeUndefined();

    // …and the plan SAYS so, instead of the old warning that the push would break
    expect(plan).toContain("pushes to https://github.com/owner/vault.git with GIT_ASKPASS");
    expect(plan).toContain("reads the login Keychain item for github.com");
    expect(plan).not.toContain("cannot run it");
    // github.com is a push remote, so the egress door admits it
    expect(config.egress.allow).toContain("github.com");
  });

  it("still refuses to pretend about SSH — the one remote shape confinement cannot serve", async () => {
    const P = await launchdCheckout();
    const I = await mkdtemp(join(tmpdir(), "mi-"));
    await mkdir(join(I, ".git"), { recursive: true });
    await writeFile(join(I, ".git", "config"), '[remote "origin"]\n\turl = git@github.com:owner/vault.git\n');
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
      exists: pgInstalled(),
      mintPassword: () => "generated",
      doctorFn: okDoctor,
      cliShim: false,
    });
    expect(r.code).toBe(0);
    const plan = lines.join("\n");
    expect(plan).toContain("cannot push to them");
    expect(plan).toContain("granting the sole committer ~/.ssh");
    // no keychain lookup for an ssh remote: its credential is a key
    expect(plan).not.toContain("with GIT_ASKPASS");
  });

  it("the compose shape confines nothing — the container is the boundary, and there is no proxy to point at", async () => {
    const P = await launchdCheckout();
    const I = await mkdtemp(join(tmpdir(), "mi-"));
    const home = await mkdtemp(join(tmpdir(), "metistry-home-"));
    const lines: string[] = [];
    const r = await up({
      productDir: P,
      env: env(I),
      exec: fakeExec(),
      out: (l) => lines.push(l),
      platform: "darwin",
      uid: 501,
      home,
      node: NODE,
      deployment: { shape: "compose", services: {} },
      exists: pgInstalled(),
      doctorFn: okDoctor,
      compose: false,
    });
    expect(r.code).toBe(0);
    // the reconciler is a host launchd job under BOTH shapes, and under
    // compose it must NOT be pointed at reconciler.sb: there is no egress
    // proxy for its PROXY_TCP rule to reach
    const plist = await readFile(join(home, "Library", "LaunchAgents", "com.foldedspacelabs.metistry.reconciler.plist"), "utf8");
    // the ARGV, not the whole file: the template's comment explains the
    // confined shape whichever profile is in force
    const argv = parsePlistTemplate("r.plist", plist).programArguments.join(" ");
    expect(argv).toContain("ops/sandbox/unconfined.sb");
    expect(argv).not.toContain("ops/sandbox/reconciler.sb");
    expect(lines.join("\n")).toContain("the compose shape's boundary is the container");
  });

  it("declines to confine the reconciler, loudly, when the Mac has no git the profile could name", async () => {
    const P = await launchdCheckout();
    const I = await mkdtemp(join(tmpdir(), "mi-"));
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
      // no bundled runtime, no Command Line Tools: only the xcode-select
      // shim, which dies under a profile
      exists: pgInstalled([], false),
      mintPassword: () => "generated",
      doctorFn: okDoctor,
      cliShim: false,
    });
    expect(r.code).toBe(0);
    const plan = lines.join("\n");
    expect(plan).toContain("reconciler: NOT confined");
    expect(plan).toContain("xcode-select shim");
    expect(plan).toContain("ops/sandbox/unconfined.sb");

    const LA = "/h/Library/LaunchAgents";
    const SUP = "com.foldedspacelabs.metistry";
    expect(r.commands).toEqual([
      `mkdir -p ${I}/.metistry/state/run`,
      `write ${I}/.metistry/state/pg.pwfile  (from generated superuser password (deleted in the next step))`,
      `${PG}/initdb -D ${I}/.metistry/state/pg -U metistry --pwfile=${I}/.metistry/state/pg.pwfile --encoding=UTF8 --locale=C --auth-local=trust --auth-host=scram-sha-256`,
      `/bin/rm -f ${I}/.metistry/state/pg.pwfile`,
      `write ${I}/.metistry/state/pg/postgresql.conf  (from metistry managed block: loopback listen + unix socket)`,
      `mkdir -p ${I}/.metistry/state/assistant`,
      // 1. the pre-supervisor agents go, once: every one of them is a child now
      ...["db", "console", "assistant", "reconciler", "watchdog", "eventkit", "apple-fm", "eventkit-helper"].flatMap((s) => [
        `launchctl bootout gui/501/${SUP}.${s}`,
        `rm -f ${LA}/${SUP}.${s}.plist`,
      ]),
      // 2. the supervisor's plan: the `Metistry` symlink System Settings names
      // the background item after, and the child list
      `mkdir -p ${I}/.metistry/state/bin`,
      `ln -sfn ${NODE} ${I}/.metistry/state/bin/Metistry`,
      `mkdir -p ${I}/.metistry/state/run`,
      // apple-fm is absent on purpose: METISTRY_AFM_URL is unset, so this
      // install has no Apple Intelligence bridge and nothing starts one
      `write ${I}/.metistry/state/supervisor.json  (from 5 child(ren): db, console, reconciler, assistant, eventkit)`,
      `chmod 600 ${I}/.metistry/state/supervisor.json`,
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
      `${PG}/pg_isready -h ${I}/.metistry/state/run -p 5432 -U metistry -d metistry`,
      `${PG}/createdb -h ${I}/.metistry/state/run -p 5432 -U metistry metistry`,
      "metistry doctor",
    ]);
  });

  it("a missing Postgres is a printed remediation, never an install this tool runs", async () => {
    const P = await launchdCheckout();
    const I = await mkdtemp(join(tmpdir(), "mi-" /* short on purpose: the supervisor socket under .metistry/state/run/ has ~103 bytes to live in */));
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
    const I = await mkdtemp(join(tmpdir(), "mi-" /* short on purpose: the supervisor socket under .metistry/state/run/ has ~103 bytes to live in */));
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
      exists: pgInstalled([join(I, ".metistry", "state", "pg", "PG_VERSION")]),
      doctorFn: okDoctor,
    });
    expect(r.commands.filter((c) => c.includes("initdb"))).toEqual([]);
    expect(r.commands.some((c) => c.includes("postgresql.conf"))).toBe(true);
  });
});

describe("the rendered plists", () => {
  it("leave no placeholder, keep secrets out of ProgramArguments, and confine the engine", async () => {
    const P = await launchdCheckout();
    const I = await mkdtemp(join(tmpdir(), "mi-" /* short on purpose: the supervisor socket under .metistry/state/run/ has ~103 bytes to live in */));
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
    const config = JSON.parse(await readFile(join(I, ".metistry", "state", "supervisor.json"), "utf8"));
    expect(config.label).toBe("com.foldedspacelabs.metistry");
    expect(config.socket).toBe(join(I, ".metistry", "state", "run", "supervisor.sock"));
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
      METISTRY_INBOX_DIR: `${I}/Inbox`,
    });

    const assistant = child("assistant");
    expect(JSON.stringify(assistant)).not.toMatch(/__[A-Z][A-Z0-9_]*__/);
    expect(assistant.argv[0]).toBe("/usr/bin/sandbox-exec");
    expect(assistant.argv).toContain(`${P}/ops/sandbox/assistant.sb`);
    expect(assistant.argv).toContain("CONSOLE_TCP=localhost:8080");
    // the sandbox's path parameters are REAL paths (/var/folders → /private/var/folders)
    expect(assistant.argv).toContain(`STATE_DIR=${realPathish(join(I, ".metistry", "state", "assistant"))}`);
    expect(assistant.argv).toContain(`PRODUCT_DIR=${realPathish(P)}`);
    expect(assistant.env.HOME).toBe(`${I}/.metistry/state/assistant`);
    expect(assistant.env.METISTRY_OPENROUTER_API_KEY).toBe("sk-or-x"); // named by compute.yaml, not by a fixed variable
    // where this install's config is — without these the engine resolved
    // every overlay against its working directory (the PRODUCT checkout)
    // and answered as the seed identity (#198)
    expect(assistant.env.METISTRY_INSTANCE_DIR).toBe(I);
    expect(assistant.env.METISTRY_SEED_DIR).toBe(`${P}/seed`);
    // …and the sandbox lets it open the four files it will find there, by
    // name: the vault beside them stays denied (D5)
    expect(assistant.argv).toContain(`CONFIG_IDENTITY=${realPathish(join(I, ".metistry", "identity.yaml"))}`);
    expect(assistant.argv).toContain(`CONFIG_ASSISTANT_PROMPT=${realPathish(join(I, ".metistry", "assistant-prompt.md"))}`);
    expect(assistant.argv).toContain(`CONFIG_RULES=${realPathish(join(I, ".metistry", "rules.yaml"))}`);
    expect(assistant.argv).toContain(`CONFIG_COMPUTE=${realPathish(join(I, ".metistry", "compute.yaml"))}`);
    // the engine's environment is still an ALLOWLIST, and a child's
    // environment is the spec's whole: the supervisor's own never leaks in
    expect(assistant.env.METISTRY_ORIGIN).toBeUndefined();
    expect(Object.keys(assistant.env).sort()).toEqual(
      [
        "METISTRY_OPENROUTER_API_KEY",
        "HOME",
        "METISTRY_ASSISTANT_TOKEN",
        "METISTRY_BRAIN_URL",
        "METISTRY_DB_HOST",
        "METISTRY_DB_PASSWORD",
        "METISTRY_DB_PORT",
        "METISTRY_INSTANCE_DIR",
        "METISTRY_SEED_DIR",
        "PATH",
        "TMPDIR",
        // the egress door — five variables, and the fifth is why the other
        // four work: Node's global fetch ignores HTTPS_PROXY without
        // NODE_USE_ENV_PROXY (core/egress.ts)
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "NODE_USE_ENV_PROXY",
      ].sort(),
    );
    // the engine's egress is the proxy and nothing else: the profile allows
    // exactly this port, the proxy allows exactly the hosts compute.yaml
    // named, and loopback bypasses it
    expect(assistant.argv).toContain(`PROXY_TCP=localhost:${EGRESS_PROXY_DEFAULT_PORT}`);
    expect(assistant.env.HTTPS_PROXY).toMatch(new RegExp(`^http://assistant:[0-9a-f]{64}@127\\.0\\.0\\.1:${EGRESS_PROXY_DEFAULT_PORT}$`));
    expect(assistant.env.NO_PROXY).toBe("localhost,127.0.0.1,::1");
    expect(assistant.env.NODE_USE_ENV_PROXY).toBe("1");

    expect(child("db").argv).toEqual([`${PG}/postgres`, "-D", `${I}/.metistry/state/pg`]);

    // the jobs that exist in BOTH shapes still source a dotenv file with
    // sh -c — but the INSTANCE's, not the checkout's (self-contained instances)
    // The sole committer, CONFINED. The shell still sources the instance's
    // dotenv (it runs outside the sandbox and execs itself away, which is
    // why the profile needs no /bin/sh rule) and what it execs is
    // sandbox-exec, so git and all its helpers inherit the confinement.
    const rec = child("reconciler");
    expect(JSON.stringify(rec)).not.toMatch(/__[A-Z][A-Z0-9_]*__/);
    const shell = rec.argv.join(" ");
    expect(shell).toContain(`set -a; . '${I}/.metistry/state/.env'; set +a; exec '/usr/bin/sandbox-exec'`);
    expect(shell).toContain(`-f '${P}/ops/sandbox/reconciler.sb'`);
    expect(shell).toContain(`-D 'INSTANCE_DIR=${realPathish(I)}'`);
    expect(shell).toContain(`-D 'PROXY_TCP=localhost:${EGRESS_PROXY_DEFAULT_PORT}'`);
    expect(shell).toContain(`'${NODE}' '${P}/apps/reconciler/dist/main.js'`);
    // git's own environment is a deliberate allowlist, so the proxy reaches
    // it as an explicit variable the reconciler turns into `-c http.proxy`
    expect(rec.env.METISTRY_GIT_HTTP_PROXY).toMatch(new RegExp(`^http://reconciler:[0-9a-f]{64}@127\\.0\\.0\\.1:${EGRESS_PROXY_DEFAULT_PORT}$`));
    expect(rec.log).toBe("/tmp/metistry-reconciler.log");

    // …and supervisor.json carries the door itself: the port, the allowlist
    // and a bearer per confined child, where no child can rewrite it
    const cfg = JSON.parse(await readFile(join(I, ".metistry", "state", "supervisor.json"), "utf8"));
    expect(cfg.egress.port).toBe(EGRESS_PROXY_DEFAULT_PORT);
    expect(Object.keys(cfg.egress.tokens).sort()).toEqual(["assistant", "reconciler"]);
    expect(cfg.egress.allow).toContain("openrouter.ai");

    // the supervisor's own plist: 0600, because its dict carries the db password
    const sup = await read("");
    expect(sup).not.toMatch(/__[A-Z][A-Z0-9_]*__/);
    expect(sup).toContain(`<string>${I}/.metistry/state/bin/Metistry</string>`);
    expect(sup).toContain(`<string>${P}/apps/watchdog/dist/main.js</string>`);
    expect(sup).toContain(`<string>${I}/.metistry/state/supervisor.json</string>`);
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
    const I = await mkdtemp(join(tmpdir(), "mi-" /* short on purpose: the supervisor socket under .metistry/state/run/ has ~103 bytes to live in */));
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
    const config = JSON.parse(await readFile(join(I, ".metistry", "state", "supervisor.json"), "utf8"));
    const assistant = config.children.find((c: { name: string }) => c.name === "assistant");
    expect(assistant.argv).toContain(bundled);
    // the sandbox may exec node — THIS node. A Homebrew prefix in the profile
    // would grant /opt/homebrew and deny the runtime the jobs actually use.
    expect(assistant.argv).toContain(`NODE_PREFIX=${realPathish(join(P, "runtime", "node"))}`);
    expect(JSON.stringify(assistant)).not.toContain("/opt/homebrew");
    // and the supervisor's own program is a symlink to it, named `Metistry`
    expect(await readFile(join(home, "Library", "LaunchAgents", "com.foldedspacelabs.metistry.plist"), "utf8")).toContain(`<string>${I}/.metistry/state/bin/Metistry</string>`);
  });
});

describe("keep_awake reaches the holder", () => {
  /** The supervisor is the holder, so the answer has to be in ITS environment — through the same passthrough every other METISTRY_* variable takes, not a second channel. */
  const supervisorEnv = async (keepAwake?: "never" | "allow_sleep_on_battery" | "always" | "always_lid_closed") => {
    const P = await launchdCheckout();
    const I = await mkdtemp(join(tmpdir(), "mi-"));
    const home = await mkdtemp(join(tmpdir(), "metistry-home-"));
    const lines: string[] = [];
    const r = await up({
      productDir: P,
      env: env(I),
      exec: fakeExec(),
      out: (l) => lines.push(l),
      platform: "darwin",
      uid: 501,
      home,
      node: NODE,
      deployment: { ...launchd, ...(keepAwake ? { keep_awake: keepAwake } : {}) },
      exists: pgInstalled(),
      doctorFn: okDoctor,
    });
    expect(r.code).toBe(0);
    const config = JSON.parse(await readFile(join(I, ".metistry", "state", "supervisor.json"), "utf8"));
    const plist = await readFile(join(home, "Library", "LaunchAgents", "com.foldedspacelabs.metistry.plist"), "utf8");
    return { env: config.env as Record<string, string>, plist, lines };
  };

  it("deployment.yaml's answer is rendered into supervisor.json and the agent's dict", async () => {
    const { env: e, plist, lines } = await supervisorEnv("allow_sleep_on_battery");
    expect(e.METISTRY_KEEP_AWAKE).toBe("allow_sleep_on_battery");
    expect(plist).toContain("<key>METISTRY_KEEP_AWAKE</key><string>allow_sleep_on_battery</string>");
    expect(lines.some((l) => l.includes("keep-awake: allow_sleep_on_battery"))).toBe(true);
  });

  it("an install that never answered the question carries `never`, and `up` says the Mac may sleep", async () => {
    const { env: e, lines } = await supervisorEnv();
    expect(e.METISTRY_KEEP_AWAKE).toBe("never");
    expect(lines.some((l) => l.includes("keep-awake: never"))).toBe(true);
  });
});

describe("an instance with no engine (W1)", () => {
  /** The same install, minus the provider key compute.yaml names. */
  const noEngine = (instance: string): NodeJS.ProcessEnv => {
    const e = env(instance);
    delete e.METISTRY_OPENROUTER_API_KEY;
    return e;
  };

  /** The line an operator has to be able to read without knowing the code. */
  const ABSENT_LINE =
    "assistant: absent — assignments.default runs on openrouter/anthropic/claude-sonnet-5, and providers.openrouter.auth.secret names METISTRY_OPENROUTER_API_KEY, which is unset here; " +
    "captures, tasks, search and the console run; fold turns wait (docs/ops/assistant-tools.md). " +
    "Fix: metistry compute providers add --from <template> --name openrouter --secret METISTRY_OPENROUTER_API_KEY, then metistry secrets sync --to env";

  it("is not written into the supervisor's children, and `up` says why in one line", async () => {
    const P = await launchdCheckout();
    const I = await mkdtemp(join(tmpdir(), "mi-" /* short on purpose: the supervisor socket under .metistry/state/run/ has ~103 bytes to live in */));
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

    expect(lines.map((l) => l.trim())).toContain(ABSENT_LINE);
    // the child list: everything model-free, and no assistant that could
    // only crash-loop on `requireEnv`
    expect(r.commands).toContain(`write ${I}/.metistry/state/supervisor.json  (from 4 child(ren): db, console, reconciler, eventkit)`);
  });

  it("and comes back on the next `up` once the key exists — the config is rewritten whole, so it is idempotent", async () => {
    const P = await launchdCheckout();
    const I = await mkdtemp(join(tmpdir(), "mi-" /* short on purpose: the supervisor socket under .metistry/state/run/ has ~103 bytes to live in */));
    const home = await mkdtemp(join(tmpdir(), "metistry-home-"));
    const opts = { productDir: P, exec: fakeExec(), out: () => {}, platform: "darwin" as const, uid: 501, home, node: NODE, deployment: launchd, exists: pgInstalled(), doctorFn: okDoctor };
    const children = async () => {
      const c = JSON.parse(await readFile(join(I, ".metistry", "state", "supervisor.json"), "utf8"));
      return { names: c.children.map((x: { name: string }) => x.name) as string[], token: c.token as string };
    };

    expect((await up({ ...opts, env: noEngine(I) })).code).toBe(0);
    const before = await children();
    expect(before.names).toEqual(["db", "console", "reconciler", "eventkit"]);

    // `metistry compute providers add` + `metistry secrets sync` happened; the next `up` is the only step needed
    expect((await up({ ...opts, env: env(I) })).code).toBe(0);
    const after = await children();
    expect(after.names).toEqual(["db", "console", "reconciler", "assistant", "eventkit"]);
    // the control socket's secret survives, as it does on any re-run
    expect(after.token).toBe(before.token);

    // and taking it away again removes the child, without hand-editing anything
    expect((await up({ ...opts, env: noEngine(I) })).code).toBe(0);
    expect((await children()).names).toEqual(["db", "console", "reconciler", "eventkit"]);
  });

  it("assigning nothing at all is the other half of the same absence, and says which verb writes the line", async () => {
    const P = await launchdCheckout();
    await writeFile(join(P, "seed", "compute.yaml"), "providers: {}\n");
    const I = await mkdtemp(join(tmpdir(), "mi-" /* short on purpose: the supervisor socket under .metistry/state/run/ has ~103 bytes to live in */));
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
      exists: pgInstalled(),
      mintPassword: () => "generated",
      doctorFn: okDoctor,
    });
    expect(r.code).toBe(0);
    const text = lines.join("\n");
    expect(text).toContain("no assignments.default in compute.yaml");
    expect(text).toContain("metistry compute assign default <provider/model>");
    expect(r.commands).toContain(`write ${I}/.metistry/state/supervisor.json  (from 4 child(ren): db, console, reconciler, eventkit)`);
  });

  it("under the compose shape the note is the same one — the file's own interpolation is not what decides any more", async () => {
    const P = await launchdCheckout();
    const I = await mkdtemp(join(tmpdir(), "mi-" /* short on purpose: the supervisor socket under .metistry/state/run/ has ~103 bytes to live in */));
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
    expect(lines.join("\n")).toContain(ABSENT_LINE);
  });

  it("the note is built from the seam's own words, so `up` and doctor cannot drift", () => {
    expect(engineAbsentNote("why not", "do this")).toBe("assistant: absent — why not; captures, tasks, search and the console run; fold turns wait (docs/ops/assistant-tools.md). Fix: do this");
  });
});
