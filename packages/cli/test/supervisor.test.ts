// The CLI's half of the supervisor: turning a rendered plist into a child
// spec, the paths, the launcher file the Mac app's bundled agent reads, and
// `up --register-via app` — which installs everything EXCEPT the supervisor's
// own agent, because the app registers its bundled copy through SMAppService.
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseSupervisorConfig } from "@foldedspacelabs/metistry-core";
import { parsePlistTemplate } from "../src/launchd.js";
import { childFromRenderedPlist, launchdBaseEnv, mintControlToken, serializeLauncherEnv, supervisorBinPath, supervisorConfigPath, supervisorLauncherEnvPath, supervisorSocketPath } from "../src/supervisor.js";
import { up } from "../src/up.js";
import { checkout, fakeExec, okDoctor } from "./fixtures.js";

const REPO = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");
const NODE = "/usr/local/bin/node";

describe("paths", () => {
  it("all three hang off the instance's state dir — the config beside the socket, the socket beside Postgres'", () => {
    expect(supervisorConfigPath("/i")).toBe("/i/state/supervisor.json");
    expect(supervisorSocketPath("/i")).toBe("/i/state/run/supervisor.sock");
    // the program name is the whole point: System Settings names the
    // background item after it, and `node` is not a name a user can act on
    expect(supervisorBinPath("/i")).toBe("/i/state/bin/Metistry");
    expect(mintControlToken()).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("a rendered plist becomes a child spec", () => {
  it("same argv, same directory, same log file — and the environment the plist's dict held", () => {
    const rendered =
      '<plist><dict><key>Label</key><string>com.foldedspacelabs.metistry.console</string>' +
      "<key>ProgramArguments</key><array><string>/n/node</string><string>/p/apps/console/dist/main.js</string></array>" +
      "<key>WorkingDirectory</key><string>/p</string>" +
      "<key>EnvironmentVariables</key><dict><key>METISTRY_DB_PASSWORD</key><string>pw</string></dict>" +
      "<key>StandardOutPath</key><string>/tmp/metistry-console.log</string></dict></plist>";
    const t = parsePlistTemplate("com.foldedspacelabs.metistry.console.plist", rendered);
    const spec = childFromRenderedPlist(t, rendered, { PATH: "/usr/bin:/bin", HOME: "/h" }, { kind: "tcp", port: 8080 });
    expect(spec).toEqual({
      name: "console",
      argv: ["/n/node", "/p/apps/console/dist/main.js"],
      cwd: "/p",
      // launchd's own defaults first, the plist's dict over them
      env: { PATH: "/usr/bin:/bin", HOME: "/h", METISTRY_DB_PASSWORD: "pw" },
      log: "/tmp/metistry-console.log",
      ready: { kind: "tcp", port: 8080 },
    });
    expect(parseSupervisorConfig({ schema: 1, label: "com.foldedspacelabs.metistry", socket: "/i/state/run/s.sock", token: "t".repeat(32), children: [spec] }).children[0]!.stopTimeoutMs).toBe(10_000);
  });

  it("refuses a job with no log path rather than dropping its output on the floor", () => {
    const rendered = '<plist><dict><key>Label</key><string>com.foldedspacelabs.metistry.console</string><key>ProgramArguments</key><array><string>/n</string></array></dict></plist>';
    const t = parsePlistTemplate("com.foldedspacelabs.metistry.console.plist", rendered);
    expect(() => childFromRenderedPlist(t, rendered, {})).toThrow(/has no StandardOutPath/);
  });

  it("launchdBaseEnv is what a plist with no dict of its own used to be handed", () => {
    expect(launchdBaseEnv({ HOME: "/h", TMPDIR: "/tmp", USER: "o", SECRET: "x" })).toEqual({ PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: "/h", TMPDIR: "/tmp", USER: "o" });
  });
});

describe("the app's launcher file", () => {
  it("quotes every path — the app's own default location has a space in it — and refuses one that would escape the quoting", () => {
    const text = serializeLauncherEnv({
      bin: "/Users/o/Library/Application Support/Metistry/inst/state/bin/Metistry",
      main: "/Users/o/Library/Application Support/Metistry/product/current/apps/watchdog/dist/main.js",
      config: "/Users/o/Library/Application Support/Metistry/inst/state/supervisor.json",
    });
    expect(text).toContain("METISTRY_SUPERVISOR_BIN='/Users/o/Library/Application Support/Metistry/inst/state/bin/Metistry'");
    expect(text).toContain("METISTRY_SUPERVISOR_CONFIG='/Users/o/Library/Application Support/Metistry/inst/state/supervisor.json'");
    expect(() => serializeLauncherEnv({ bin: "/Users/o'brien/m", main: "/m", config: "/c" })).toThrow(/single quote/);
  });

  it("names the same file the bundled MetistrySupervisor script reads", async () => {
    expect(supervisorLauncherEnvPath("/Users/o")).toBe("/Users/o/Library/Application Support/Metistry/supervisor.env");
    const script = await readFile(join(REPO, "apps", "macos", "resources", "launchd", "MetistrySupervisor"), "utf8");
    expect(script).toContain('conf="$HOME/Library/Application Support/Metistry/supervisor.env"');
    for (const v of ["METISTRY_SUPERVISOR_BIN", "METISTRY_SUPERVISOR_MAIN", "METISTRY_SUPERVISOR_CONFIG"]) expect(script).toContain(v);
    // and the plist the app registers names that script, bundle-relative
    const plist = await readFile(join(REPO, "apps", "macos", "resources", "launchd", "com.foldedspacelabs.metistry.plist"), "utf8");
    expect(plist).toContain("<key>BundleProgram</key><string>Contents/MacOS/MetistrySupervisor</string>");
    expect(plist).toContain("<key>Label</key><string>com.foldedspacelabs.metistry</string>");
  });
});

describe("metistry up --register-via app", () => {
  it("writes the config and the launcher file, and installs every agent EXCEPT the supervisor's", async () => {
    const P = await checkout();
    const I = await mkdtemp(join(tmpdir(), "metistry-inst-"));
    const home = await mkdtemp(join(tmpdir(), "metistry-home-"));
    await mkdir(join(I, "state"), { recursive: true });
    await writeFile(join(I, "state", ".env"), "METISTRY_ORIGIN=https://x.test\n");
    const lines: string[] = [];
    const r = await up({
      productDir: P,
      env: { METISTRY_INSTANCE_DIR: I, METISTRY_DB_PASSWORD: "pw", METISTRY_EK_URL: "http://127.0.0.1:7811", HOME: home, TMPDIR: "/tmp" },
      exec: fakeExec(),
      out: (l) => lines.push(l),
      platform: "darwin",
      uid: 501,
      home,
      node: NODE,
      registerVia: "app",
      deployment: { shape: "launchd", services: {} },
      exists: (p: string) => p.startsWith("/opt/homebrew/opt/postgresql@17/bin") || existsSync(p),
      doctorFn: okDoctor,
    });
    expect(r.code).toBe(0);

    // the config is there, and so is the file the bundled launcher reads
    const config = parseSupervisorConfig(JSON.parse(await readFile(join(I, "state", "supervisor.json"), "utf8")));
    expect(config.children.map((c) => c.name)).toEqual(["reconciler"]);
    const launcher = await readFile(join(home, "Library", "Application Support", "Metistry", "supervisor.env"), "utf8");
    expect(launcher).toContain(`METISTRY_SUPERVISOR_BIN='${join(I, "state", "bin", "Metistry")}'`);
    expect(launcher).toContain(`METISTRY_SUPERVISOR_MAIN='${join(P, "apps", "watchdog", "dist", "main.js")}'`);
    expect(launcher).toContain(`METISTRY_SUPERVISOR_CONFIG='${join(I, "state", "supervisor.json")}'`);

    // the supervisor's agent is the app's to register — this run installed none
    expect(existsSync(join(home, "Library", "LaunchAgents", "com.foldedspacelabs.metistry.plist"))).toBe(false);
    expect(r.commands.some((c) => c === "launchctl bootstrap gui/501 " + join(home, "Library", "LaunchAgents", "com.foldedspacelabs.metistry.plist"))).toBe(false);
    expect(lines.join("\n")).toMatch(/SMAppService\.agent\(plistName:\)/);
    // the TCC helper is NOT the app's: it is still a launchd agent of the install's
    expect(existsSync(join(home, "Library", "LaunchAgents", "com.foldedspacelabs.metistry.calendar.plist"))).toBe(true);
  });
});
