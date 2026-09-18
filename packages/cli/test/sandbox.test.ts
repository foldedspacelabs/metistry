// Misuse tests for the assistant's host confinement (invariant 8: every
// boundary testable, misuse tests ship with the interface).
//
// The container was the engine's isolation under the compose shape. Under
// launchd, ops/sandbox/assistant.sb is. So these tests do not read the
// profile and agree with it — they LAUNCH a trivial node script under the
// real profile with the real parameters `metistry up` computes, and prove
// the four things the profile claims:
//
//   1. reading a ~/Documents-style path outside the allowed subpaths fails
//   2. writing outside the state dir fails
//   3. writing inside the state dir succeeds
//   4. connecting to the console's port and to Postgres' succeeds; any
//      other loopback port does not
//   5. the four instance config files it is granted BY NAME are readable —
//      and a note sitting right beside them is not. That pair is the whole
//      argument for four literals over one grant on the directory that
//      holds them (which on an unmigrated instance is the vault root).
//
// Darwin only: sandbox-exec is a macOS binary, and CI runs on Linux.

import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { instanceFile } from "@foldedspacelabs/metistry-core";
import { configParamName, engineConfigParams, ENGINE_CONFIG_KEYS, nodePrefixFor, sandboxArgv, sandboxParams, SANDBOX_EXEC, sandboxProfilePath, assistantStateDir, tmpDirOf } from "../src/sandbox.js";

const run = promisify(execFile);
const REPO = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");

describe("sandbox parameters", () => {
  it("a Homebrew node's self-contained root is the brew prefix, not the Cellar version dir", () => {
    // narrower and the engine will not start: node links against dylibs in
    // sibling formulae (/opt/homebrew/opt/libuv/…)
    expect(nodePrefixFor("/opt/homebrew/bin/node", () => "/opt/homebrew/Cellar/node@22/22.23.1/bin/node")).toBe("/opt/homebrew");
  });

  it("a bundled runtime IS self-contained, so its own prefix is enough", () => {
    const bundled = "/Applications/Metistry.app/Contents/Resources/metistry/runtime/node/bin/node";
    expect(nodePrefixFor(bundled, (p) => p)).toBe("/Applications/Metistry.app/Contents/Resources/metistry/runtime/node");
  });

  it("the state dir is beside the Postgres data dir, outside the vault", () => {
    expect(assistantStateDir({ instanceDir: "/i", productDir: "/p" })).toBe("/i/.metistry/state/assistant");
    expect(assistantStateDir({ productDir: "/p" })).toBe("/p/.metistry/state/assistant");
    expect(tmpDirOf({ TMPDIR: "/var/folders/xy/T/" })).toBe("/var/folders/xy/T");
  });

  it("renders sandbox-exec as an argument array — never a shell string", () => {
    const params = sandboxParams({ productDir: "/p", nodeBin: "/n/bin/node", stateDir: "/s", consolePort: 8080, dbPort: 5432, tmpDir: "/tmp", realpath: (p) => p });
    expect(params.CONSOLE_TCP).toBe("localhost:8080");
    expect(params.DB_TCP).toBe("localhost:5432");
    expect(sandboxArgv("/p/ops/sandbox/assistant.sb", params, ["/n/bin/node", "/p/main.js"])).toEqual([
      SANDBOX_EXEC,
      "-f",
      "/p/ops/sandbox/assistant.sb",
      "-D",
      "NODE_BIN=/n/bin/node",
      "-D",
      "NODE_PREFIX=/n",
      "-D",
      "PRODUCT_DIR=/p",
      "-D",
      "STATE_DIR=/s",
      "-D",
      "TMP_DIR=/tmp",
      "-D",
      "CONSOLE_TCP=localhost:8080",
      "-D",
      "DB_TCP=localhost:5432",
      // the four config files, by name — no instance dir, so each is the
      // product's own seed copy and the grant changes nothing
      "-D",
      "CONFIG_IDENTITY=/p/seed/identity.yaml",
      "-D",
      "CONFIG_ASSISTANT_PROMPT=/p/seed/assistant-prompt.md",
      "-D",
      "CONFIG_RULES=/p/seed/rules.yaml",
      "-D",
      "CONFIG_COMPUTE=/p/seed/compute.yaml",
      "/n/bin/node",
      "/p/main.js",
    ]);
  });

  it("with an instance, each CONFIG_* is that instance's own file — as THAT instance spells it", () => {
    const flat = { instanceDir: "/i", productDir: "/p", realpath: (p: string) => p, exists: (p: string) => p === "/i/.metistry/identity.yaml" };
    expect(engineConfigParams(flat)).toEqual({
      CONFIG_IDENTITY: "/i/.metistry/identity.yaml",
      CONFIG_ASSISTANT_PROMPT: "/i/.metistry/assistant-prompt.md",
      CONFIG_RULES: "/i/.metistry/rules.yaml",
      CONFIG_COMPUTE: "/i/.metistry/compute.yaml",
    });
    // a legacy instance keeps them at the vault root; the `Knowledge/` beside
    // them is why this is four literals and not one subpath
    const legacy = engineConfigParams({ instanceDir: "/l", productDir: "/p", realpath: (p) => p, exists: (p) => p === "/l/identity.yaml" });
    expect(legacy).toEqual({
      CONFIG_IDENTITY: "/l/identity.yaml",
      CONFIG_ASSISTANT_PROMPT: "/l/assistant-prompt.md",
      CONFIG_RULES: "/l/rules.yaml",
      CONFIG_COMPUTE: "/l/compute.yaml",
    });
    expect(Object.keys(legacy)).toEqual(ENGINE_CONFIG_KEYS.map(configParamName));
  });

  it("every parameter the profile declares is one `up` supplies, and every one `up` supplies is declared", () => {
    const profile = readFileSync(sandboxProfilePath(REPO), "utf8");
    const declared = new Set([...profile.matchAll(/\(param "([A-Z0-9_]+)"\)/g)].map((m) => m[1]!));
    const supplied = new Set(Object.keys(sandboxParams({ productDir: "/p", nodeBin: "/n/bin/node", stateDir: "/s", consolePort: 1, dbPort: 2, tmpDir: "/tmp", realpath: (p) => p })));
    // a parameter the profile reads and `up` does not pass is a job that
    // fails to launch at all; one passed and never read is a grant that
    // silently is not there
    expect([...declared].sort()).toEqual([...supplied].sort());
  });
});

// `describe.skipIf` keeps the Linux CI run honest: skipped, never silently passing.
describe.skipIf(process.platform !== "darwin" || !existsSync(SANDBOX_EXEC))("ops/sandbox/assistant.sb confines a real process (macOS)", () => {
  let root = "";
  let servers: net.Server[] = [];
  let consolePort = 0;
  let dbPort = 0;
  let otherPort = 0;

  const listen = () =>
    new Promise<net.Server>((res, rej) => {
      const s = net.createServer((c) => c.end());
      s.once("error", rej);
      s.listen(0, "127.0.0.1", () => res(s));
    });

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "metistry-sb-"));
    await mkdir(join(root, "app"), { recursive: true });
    await mkdir(join(root, "state"), { recursive: true });
    await mkdir(join(root, "documents"), { recursive: true });
    // the probe's TMP_DIR is a directory of its own rather than the system
    // one: the "outside" paths below live in the same temp tree, and a
    // TMP_DIR of $TMPDIR would legitimately cover them
    await mkdir(join(root, "tmp"), { recursive: true });
    await writeFile(join(root, "documents", "private.md"), "a note the engine must not be able to read");
    // the probe: the trivial node script the profile is applied to
    await writeFile(
      join(root, "app", "probe.mjs"),
      `import { readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
const [, , stateDir, outsideRead, outsideWrite, okPort, dbPort, badPort] = process.argv;
const attempt = (fn) => { try { fn(); return "allowed"; } catch (e) { return "denied:" + (e.code ?? e.message); } };
const connect = (port) => new Promise((res) => {
  const s = net.connect({ host: "127.0.0.1", port: Number(port) });
  const done = (v) => { s.destroy(); res(v); };
  s.on("connect", () => done("allowed"));
  s.on("error", (e) => done("denied:" + e.code));
  setTimeout(() => done("timeout"), 3000);
});
console.log(JSON.stringify({
  read_outside: attempt(() => readFileSync(outsideRead, "utf8")),
  write_outside: attempt(() => writeFileSync(outsideWrite, "x")),
  write_state: attempt(() => writeFileSync(stateDir + "/probe.txt", "x")),
  read_own_code: attempt(() => readFileSync(process.argv[1], "utf8")),
  connect_console: await connect(okPort),
  connect_db: await connect(dbPort),
  connect_other: await connect(badPort),
}));
`,
    );
    servers = [await listen(), await listen(), await listen()];
    consolePort = (servers[0]!.address() as net.AddressInfo).port;
    dbPort = (servers[1]!.address() as net.AddressInfo).port;
    otherPort = (servers[2]!.address() as net.AddressInfo).port;
  }, 30_000);

  afterAll(() => {
    for (const s of servers) s.close();
  });

  it("denies the vault, denies every write but its state dir, and reaches the console and the db and nothing else", async () => {
    const params = sandboxParams({
      productDir: join(root, "app"),
      nodeBin: process.execPath,
      stateDir: join(root, "state"),
      consolePort,
      dbPort,
      tmpDir: join(root, "tmp"),
    });
    const argv = sandboxArgv(sandboxProfilePath(REPO), params, [
      process.execPath,
      join(root, "app", "probe.mjs"),
      join(root, "state"),
      join(root, "documents", "private.md"),
      join(root, "documents", "written.txt"),
      String(consolePort),
      String(dbPort),
      String(otherPort),
    ]);
    const { stdout } = await run(argv[0]!, argv.slice(1), { timeout: 60_000 });
    expect(JSON.parse(stdout.trim())).toEqual({
      read_outside: "denied:EPERM",
      write_outside: "denied:EPERM",
      write_state: "allowed",
      read_own_code: "allowed",
      connect_console: "allowed",
      // the engine holds its own pg pool, and under launchd the db is a
      // loopback port like any other — without this rule it dies at startup
      connect_db: "allowed",
      // and a THIRD loopback port is still denied: this is two named
      // endpoints, not "loopback is fine"
      connect_other: "denied:EPERM",
    });
  }, 90_000);

  // The engine's own config, in BOTH layouts. The four files are granted by
  // name; the note beside them is the control, and on the legacy fixture it
  // sits in the same directory as the config — which is why a grant on that
  // directory was refused.
  it.each(["flat", "legacy"] as const)("reads a %s instance's four config files and nothing else in it", async (shape) => {
    const inst = join(root, `instance-${shape}`);
    const config = shape === "flat" ? join(inst, ".metistry") : inst;
    const vault = shape === "flat" ? inst : join(inst, "Knowledge");
    await mkdir(config, { recursive: true });
    await mkdir(vault, { recursive: true });
    await writeFile(join(config, "identity.yaml"), "name: Testname\n");
    await writeFile(join(config, "assistant-prompt.md"), "You are {{name}}.\n");
    await writeFile(join(config, "rules.yaml"), "tiers: {}\n");
    await writeFile(join(config, "compute.yaml"), "providers: {}\n");
    await writeFile(join(vault, "private.md"), "a note the engine must not be able to read");
    await writeFile(
      join(root, "app", "config-probe.mjs"),
      `import { readFileSync } from "node:fs";
const attempt = (p) => { try { return readFileSync(p, "utf8").trim() || "allowed:empty"; } catch (e) { return "denied:" + (e.code ?? e.message); } };
console.log(JSON.stringify(Object.fromEntries(process.argv.slice(2).map((p) => [p, attempt(p)]))));
`,
    );

    const params = sandboxParams({ productDir: join(root, "app"), nodeBin: process.execPath, stateDir: join(root, "state"), instanceDir: inst, consolePort, dbPort, tmpDir: join(root, "tmp") });
    // the grant follows the layout: flat → `.metistry/`, legacy → the root
    expect(params.CONFIG_IDENTITY).toBe(realpathSync(instanceFile(inst, "identity")));
    const probed = [join(config, "identity.yaml"), join(config, "assistant-prompt.md"), join(config, "rules.yaml"), join(config, "compute.yaml"), join(vault, "private.md")];
    const argv = sandboxArgv(sandboxProfilePath(REPO), params, [process.execPath, join(root, "app", "config-probe.mjs"), ...probed]);
    const { stdout } = await run(argv[0]!, argv.slice(1), { timeout: 60_000 });
    expect(JSON.parse(stdout.trim())).toEqual({
      [join(config, "identity.yaml")]: "name: Testname",
      [join(config, "assistant-prompt.md")]: "You are {{name}}.",
      [join(config, "rules.yaml")]: "tiers: {}",
      [join(config, "compute.yaml")]: "providers: {}",
      // D5, still: knowledge reaches the engine through the brain bridge
      // over HTTP or not at all
      [join(vault, "private.md")]: "denied:EPERM",
    });
  }, 90_000);
});
