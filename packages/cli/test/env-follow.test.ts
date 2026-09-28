// The launchd jobs follow `.env` (env-follow.ts), and doctor says when they
// do not. The owner's 0.14.2 instance: `secrets sync --to env`,
// `migrate-scope` and `update` rewrote `.env` — new bridge tokens, the
// provider key — and nothing re-rendered the supervisor's plist or
// supervisor.json, so the watchdog and the console ran on stale tokens and
// there was no assistant child while doctor said "assistant ok".
//
// Everything here runs against a temp instance and a temp HOME; `up` is a
// fake exec. Nothing touches launchd.
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  driftedNames,
  envDrift,
  expectedFromDotenv,
  followEnvFile,
  freshEnvFor,
  launchdEnvDrift,
  parsePlistEnv,
  xmlUnescape,
} from "../src/env-follow.js";
import { assistantChildOutcome, launchdEnvRow, type SupervisorSnapshot } from "../src/doctor.js";
import type { Exec, ExecOptions } from "../src/exec.js";
import { launchAgentsDir, renderEnvDict, SUPERVISOR_PLIST_FILE } from "../src/launchd.js";
import { serializeSupervisorConfig, supervisorConfig, supervisorConfigPath } from "../src/supervisor.js";

const plistWith = (env: Record<string, string>) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n  <key>Label</key><string>com.foldedspacelabs.metistry</string>\n  <key>EnvironmentVariables</key>\n  <dict>\n${renderEnvDict(env)}\n  </dict>\n  <key>KeepAlive</key><true/>\n</dict>\n</plist>\n`;

const envText = (env: Record<string, string>) => Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";

/** A temp instance brought up under the launchd shape: `.env`, supervisor.json and the supervisor's plist, all rendered from `rendered`. */
async function installed(rendered: Record<string, string>, dotenv: Record<string, string> = rendered, opts: { plist?: boolean; config?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "metistry-follow-"));
  const instance = join(root, "instance");
  const home = join(root, "home");
  const product = join(root, "product");
  await mkdir(join(instance, ".metistry", "state"), { recursive: true });
  await mkdir(product, { recursive: true });
  const envFile = join(instance, ".metistry", "state", ".env");
  await writeFile(envFile, envText(dotenv));
  const writeJobs = async (env: Record<string, string>) => {
    if (opts.config !== false) {
      await writeFile(
        supervisorConfigPath(instance),
        serializeSupervisorConfig(supervisorConfig({ label: "com.foldedspacelabs.metistry", socket: join(instance, "s.sock"), token: "t".repeat(32), env, children: [{ name: "console", argv: ["/n", "main.js"], env, log: "/tmp/x.log" }] })),
      );
    }
    if (opts.plist !== false) {
      await mkdir(launchAgentsDir(home), { recursive: true });
      await writeFile(join(launchAgentsDir(home), SUPERVISOR_PLIST_FILE), plistWith(env));
    }
  };
  await writeJobs(rendered);
  const main = join(product, "main.js");
  await writeFile(main, "// the CLI");
  return { root, instance, home, product, envFile, main, writeJobs };
}

describe("reading the installed environment", () => {
  it("a plist's EnvironmentVariables round-trips through renderEnvDict, escaping included", () => {
    const env = { METISTRY_DB_PASSWORD: "a&b<c>d", METISTRY_EMPTY: "", PATH: "/usr/bin:/bin" };
    expect(parsePlistEnv(plistWith(env))).toEqual(env);
    expect(parsePlistEnv("<plist><dict><key>Label</key><string>x</string></dict></plist>")).toBeUndefined();
    expect(xmlUnescape("&amp;lt;")).toBe("&lt;");
  });

  it("compares only what the supervisor passes through from .env: METISTRY_*, minus the owner bearer and the names the job sets itself", () => {
    const expected = expectedFromDotenv({
      METISTRY_BRIDGE_TOKEN_EVENTKIT: "tok",
      METISTRY_BRIDGE_TOKEN_RECONCILER_USER: "owner", // the console is never given it
      METISTRY_DB_HOST: "db", // replaced with loopback by consoleEnv
      METISTRY_INSTANCE_DIR: "/i",
      METISTRY_RECONCILER_URL: "http://host.docker.internal:7812", // resolved for a host process
      HOMEBREW_PREFIX: "/opt/homebrew",
    });
    expect(Object.keys(expected).sort()).toEqual(["METISTRY_BRIDGE_TOKEN_EVENTKIT", "METISTRY_RECONCILER_URL"]);
    expect(expected.METISTRY_RECONCILER_URL).toBe("http://127.0.0.1:7812");
  });

  it("drift names what differs and what is missing, and its hashes never carry a value", () => {
    const d = envDrift("x.plist", { METISTRY_A: "new", METISTRY_B: "same", METISTRY_SECRET_OPENROUTER: "sk-or-secret" }, { METISTRY_A: "old", METISTRY_B: "same" });
    expect(d.differs).toEqual(["METISTRY_A"]);
    expect(d.missing).toEqual(["METISTRY_SECRET_OPENROUTER"]);
    expect(d.hash.job).not.toBe(d.hash.env);
    expect(JSON.stringify(d)).not.toContain("sk-or-secret");
    expect(JSON.stringify(d)).not.toContain("new");
  });

  it("the gate is THIS instance's supervisor.json: a plist in the shared LaunchAgents directory alone is not an install to follow", async () => {
    const t = await installed({ METISTRY_A: "1" }, { METISTRY_A: "2" }, { config: false });
    const r = await launchdEnvDrift({ stateRoot: t.instance, home: t.home, envFiles: [t.envFile] });
    expect(r).toEqual({ installed: false, drift: [] });
  });

  it("finds a stale token in both installed copies", async () => {
    const t = await installed({ METISTRY_BRIDGE_TOKEN_EVENTKIT: "old" }, { METISTRY_BRIDGE_TOKEN_EVENTKIT: "new", METISTRY_SECRET_OPENROUTER: "k" });
    const r = await launchdEnvDrift({ stateRoot: t.instance, home: t.home, envFiles: [t.envFile] });
    expect(r.installed).toBe(true);
    expect(r.drift.map((d) => d.source)).toEqual([join(launchAgentsDir(t.home), SUPERVISOR_PLIST_FILE), supervisorConfigPath(t.instance)]);
    expect(driftedNames(r.drift)).toEqual(["METISTRY_BRIDGE_TOKEN_EVENTKIT", "METISTRY_SECRET_OPENROUTER"]);
  });
});

describe("followEnvFile: a writer of .env ends by re-rendering the jobs", () => {
  const calls: { cmd: string; args: string[]; opts?: ExecOptions }[] = [];
  const recording =
    (then?: () => Promise<void>, code = 0): Exec =>
    async (cmd, args, opts) => {
      calls.push({ cmd, args, ...(opts ? { opts } : {}) });
      await then?.();
      return { code, stdout: "", stderr: code ? "up: something failed" : "" };
    };

  it("drifted → runs `metistry up` with THIS CLI, and a child environment that must read .env afresh", async () => {
    calls.length = 0;
    const fresh = { METISTRY_BRIDGE_TOKEN_EVENTKIT: "new", METISTRY_SECRET_OPENROUTER: "k" };
    const t = await installed({ METISTRY_BRIDGE_TOKEN_EVENTKIT: "old" }, fresh);
    const lines: string[] = [];
    const r = await followEnvFile({
      productDir: t.product,
      envFiles: [t.envFile],
      instanceDir: t.instance,
      home: t.home,
      platform: "darwin",
      // this process loaded the OLD value at start, before the verb rewrote .env
      env: { PATH: "/usr/bin", METISTRY_BRIDGE_TOKEN_EVENTKIT: "old", METISTRY_SECRET_OPENROUTER: "stale" },
      // the fake `up`: renders the jobs from .env, as the real one does
      exec: recording(() => t.writeJobs(fresh)),
      out: (l) => lines.push(l),
      cli: { node: "/n/bin/node", main: t.main },
    });
    expect(r.action).toBe("rerendered");
    expect(r.drifted).toEqual(["METISTRY_BRIDGE_TOKEN_EVENTKIT", "METISTRY_SECRET_OPENROUTER"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe("/n/bin/node");
    expect(calls[0]!.args).toEqual([t.main, "up", "--no-compose", "--product-dir", t.product]);
    // the stale values are GONE from the child's environment, so it reads .env's
    expect(calls[0]!.opts?.env?.METISTRY_BRIDGE_TOKEN_EVENTKIT).toBeUndefined();
    expect(calls[0]!.opts?.env?.METISTRY_SECRET_OPENROUTER).toBeUndefined();
    expect(calls[0]!.opts?.env?.PATH).toBe("/usr/bin");
    expect(calls[0]!.opts?.env?.METISTRY_INSTANCE_DIR).toBe(t.instance);
    expect(lines.join("\n")).toContain("re-rendered from .env");
    // names only, never a value
    expect(lines.join("\n")).not.toContain("new");
  });

  it("an `up` that did not re-render leaves ONE exact instruction", async () => {
    calls.length = 0;
    const t = await installed({ METISTRY_A: "old" }, { METISTRY_A: "new" });
    const lines: string[] = [];
    const r = await followEnvFile({ productDir: t.product, envFiles: [t.envFile], instanceDir: t.instance, home: t.home, platform: "darwin", env: {}, exec: recording(undefined, 1), out: (l) => lines.push(l), cli: { node: "/n", main: t.main } });
    expect(r.action).toBe("instruction");
    expect(lines[lines.length - 1]).toMatch(/still do not carry METISTRY_A .* — run `metistry up`$/);
  });

  it("no drift → nothing is run; a dry run and a missing CLI say the command instead of running it", async () => {
    calls.length = 0;
    const same = await installed({ METISTRY_A: "1" });
    const lines: string[] = [];
    const base = { productDir: same.product, envFiles: [same.envFile], instanceDir: same.instance, home: same.home, platform: "darwin" as const, env: {}, exec: recording(), out: (l: string) => lines.push(l) };
    expect((await followEnvFile({ ...base, cli: { node: "/n", main: same.main } })).action).toBe("none");
    const t = await installed({ METISTRY_A: "old" }, { METISTRY_A: "new" });
    const drifted = { ...base, envFiles: [t.envFile], instanceDir: t.instance, home: t.home, productDir: t.product };
    expect((await followEnvFile({ ...drifted, cli: { node: "/n", main: t.main }, dryRun: true })).action).toBe("instruction");
    expect((await followEnvFile({ ...drifted, cli: { node: "/n", main: join(t.root, "nope.js") } })).detail).toContain("run `metistry up`");
    expect(calls).toHaveLength(0);
  });

  it("is a no-op off macOS and on an instance never brought up under launchd", async () => {
    calls.length = 0;
    const t = await installed({ METISTRY_A: "old" }, { METISTRY_A: "new" });
    const o = { productDir: t.product, envFiles: [t.envFile], instanceDir: t.instance, home: t.home, env: {}, exec: recording(), out: () => {}, cli: { node: "/n", main: t.main } };
    expect((await followEnvFile({ ...o, platform: "linux" })).action).toBe("none");
    const none = await installed({ METISTRY_A: "old" }, { METISTRY_A: "new" }, { config: false });
    expect((await followEnvFile({ ...o, instanceDir: none.instance, envFiles: [none.envFile], platform: "darwin" })).action).toBe("none");
    expect(calls).toHaveLength(0);
  });

  it("freshEnvFor removes every .env name and keeps the rest of the shell", () => {
    expect(freshEnvFor({ A: "1", METISTRY_X: "2", PATH: "/p" }, ["METISTRY_X", "A"], "/inst")).toEqual({ PATH: "/p", METISTRY_INSTANCE_DIR: "/inst" });
  });
});

describe("doctor: `launchd env`", () => {
  it("degraded, with the drifted names, the file that holds them, and `metistry up` as the one fix — never a value", async () => {
    const t = await installed({ METISTRY_BRIDGE_TOKEN_EVENTKIT: "old-value" }, { METISTRY_BRIDGE_TOKEN_EVENTKIT: "new-value" });
    const row = await launchdEnvRow({ stateRoot: t.instance, home: t.home, envFiles: [t.envFile] });
    expect(row.name).toBe("launchd env");
    expect(row.status).toBe("degraded");
    expect(row.remediation).toContain("METISTRY_BRIDGE_TOKEN_EVENTKIT");
    expect(row.remediation).toContain("`metistry up` re-renders them from .env");
    expect(row.action).toEqual({ kind: "run_verb", command: ["metistry", "up"], label: "Re-render from .env" });
    expect(JSON.stringify(row)).not.toContain("old-value");
    expect(JSON.stringify(row)).not.toContain("new-value");
  });

  it("ok when both copies carry .env, absent when this instance has no supervisor.json", async () => {
    const t = await installed({ METISTRY_A: "1" });
    expect((await launchdEnvRow({ stateRoot: t.instance, home: t.home, envFiles: [t.envFile] })).status).toBe("ok");
    const n = await installed({ METISTRY_A: "1" }, { METISTRY_A: "1" }, { config: false });
    expect((await launchdEnvRow({ stateRoot: n.instance, home: n.home, envFiles: [n.envFile] })).status).toBe("absent");
    // the fixture's .env is untouched by a read-only row
    expect(await readFile(t.envFile, "utf8")).toBe("METISTRY_A=1\n");
  });
});

describe("doctor: `assistant` is the RUNNING child, not the config", () => {
  const config = (children: string[]) =>
    ({ schema: 1, label: "l", socket: "/s", token: "t".repeat(32), env: {}, children: children.map((name) => ({ name, argv: ["/x"], env: {}, log: `/tmp/${name}.log`, stopTimeoutMs: 1 })) }) as unknown as NonNullable<SupervisorSnapshot["config"]>;

  it("no assistant child → failed, naming why (no engine when `up` rendered) and `metistry up`", () => {
    const o = assistantChildOutcome({ configPath: "/i/.metistry/state/supervisor.json", config: config(["db", "console", "reconciler"]), children: [] });
    expect(o.status).toBe("failed");
    expect(o.remediation).toContain("not started");
    expect(o.remediation).toContain("no engine");
    expect(o.remediation).toContain("`metistry up`");
  });

  it("a child that is not running → failed with its state and last exit; running → ok with its pid", () => {
    const snap = (state: "running" | "crash-looping"): SupervisorSnapshot => ({
      configPath: "/c",
      config: config(["assistant"]),
      children: [{ name: "assistant", state, restarts: 5, log: "/tmp/metistry-assistant.log", ...(state === "running" ? { pid: 42 } : { lastExit: { code: 1, signal: null, at: "2026-09-28T00:00:00Z" } }) }],
    });
    const bad = assistantChildOutcome(snap("crash-looping"));
    expect(bad.status).toBe("failed");
    expect(bad.remediation).toContain("state = crash-looping (last exit code 1");
    const good = assistantChildOutcome(snap("running"));
    expect(good.status).toBeUndefined(); // runCheck's default: ok
    expect(good.meta).toMatchObject({ child: "running", pid: 42 });
  });

  it("a supervisor that does not answer, or no supervisor.json, is failed — nothing confirms the engine runs", () => {
    expect(assistantChildOutcome({ configPath: "/c", config: config(["assistant"]), error: "ECONNREFUSED" }).remediation).toContain("did not answer (ECONNREFUSED)");
    expect(assistantChildOutcome({ configPath: "/c" }).status).toBe("failed");
  });
});
