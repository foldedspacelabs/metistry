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
    expect(r.commands).toEqual([
      `mkdir -p ${I}/state/run`,
      `write ${I}/state/pg.pwfile  (from generated superuser password (deleted in the next step))`,
      `${PG}/initdb -D ${I}/state/pg -U metistry --pwfile=${I}/state/pg.pwfile --encoding=UTF8 --locale=C --auth-local=trust --auth-host=scram-sha-256`,
      `/bin/rm -f ${I}/state/pg.pwfile`,
      `write ${I}/state/pg/postgresql.conf  (from metistry managed block: loopback listen + unix socket)`,
      `mkdir -p ${I}/state/assistant`,
      // ops/launchd file-name order ("-" sorts before "." — eventkit-helper before eventkit)
      ...[
        "com.foldedspacelabs.metistry.apple-fm",
        "com.foldedspacelabs.metistry.assistant",
        "com.foldedspacelabs.metistry.console",
        "com.foldedspacelabs.metistry.db",
        "com.foldedspacelabs.metistry.eventkit-helper",
        "com.foldedspacelabs.metistry.eventkit",
        "com.foldedspacelabs.metistry.reconciler",
        "com.foldedspacelabs.metistry.watchdog",
      ]
        .flatMap((label) => {
          const secret = label.endsWith(".console") || label.endsWith(".assistant");
          return [
            expect.stringContaining(`write ${LA}/${label}.plist`),
            ...(secret ? [`chmod 600 ${LA}/${label}.plist`] : []),
            `launchctl bootout gui/501/${label}`,
            `launchctl bootstrap gui/501 ${LA}/${label}.plist`,
            `launchctl kickstart -k gui/501/${label}`,
          ];
        }),
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
    const read = (label: string) => readFile(join(home, "Library", "LaunchAgents", `com.foldedspacelabs.metistry.${label}.plist`), "utf8");

    const console_ = await read("console");
    expect(console_).not.toMatch(/__[A-Z][A-Z0-9_]*__/);
    expect(console_).toContain(`<string>${NODE}</string>`);
    expect(console_).toContain(`<string>${P}/apps/console/dist/main.js</string>`);
    // env by dict, never `sh -c` with an interpolated .env
    expect(console_).not.toContain("/bin/sh");
    expect(console_).toContain("<key>METISTRY_CONSOLE_HOST</key><string>127.0.0.1</string>");
    expect(console_).toContain("<key>METISTRY_DB_HOST</key><string>127.0.0.1</string>");
    expect(console_).toContain("<key>METISTRY_EK_URL</key><string>http://127.0.0.1:7811</string>");
    expect(console_).toContain(`<key>METISTRY_INBOX_DIR</key><string>${I}/inbox</string>`);

    const assistant = await read("assistant");
    expect(assistant).not.toMatch(/__[A-Z][A-Z0-9_]*__/);
    expect(assistant).toContain("<string>/usr/bin/sandbox-exec</string>");
    expect(assistant).toContain(`<string>${P}/ops/sandbox/assistant.sb</string>`);
    expect(assistant).toContain("<string>CONSOLE_TCP=localhost:8080</string>");
    // the sandbox's path parameters are REAL paths (/var/folders → /private/var/folders)
    expect(assistant).toContain(`<string>STATE_DIR=${realPathish(join(I, "state", "assistant"))}</string>`);
    expect(assistant).toContain(`<string>PRODUCT_DIR=${realPathish(P)}</string>`);
    expect(assistant).toContain(`<key>HOME</key><string>${I}/state/assistant</string>`);
    expect(assistant).toContain("<key>CLAUDE_CODE_OAUTH_TOKEN</key><string>oauth</string>");
    // the console's outbound credentials are not in the engine's environment
    expect(assistant).not.toContain("METISTRY_ORIGIN");

    const db = await read("db");
    expect(db).toContain(`<string>${PG}/postgres</string>`);
    expect(db).toContain(`<string>${I}/state/pg</string>`);

    // the host jobs that exist in BOTH shapes still source a dotenv file with
    // sh -c — but the INSTANCE's, not the checkout's (self-contained instances)
    expect(await read("watchdog")).toContain(`set -a; . '${I}/state/.env'; set +a; exec '${NODE}' '${P}/apps/watchdog/dist/main.js'`);
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
    const assistant = await readFile(join(home, "Library", "LaunchAgents", "com.foldedspacelabs.metistry.assistant.plist"), "utf8");
    expect(assistant).toContain(`<string>${bundled}</string>`);
    // the sandbox may exec node — THIS node. A Homebrew prefix in the profile
    // would grant /opt/homebrew and deny the runtime the jobs actually use.
    expect(assistant).toContain(`<string>NODE_PREFIX=${realPathish(join(P, "runtime", "node"))}</string>`);
    expect(assistant).not.toContain("/opt/homebrew");
  });
});
