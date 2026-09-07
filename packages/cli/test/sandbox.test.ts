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
//   4. connecting to the console's port succeeds; any other port does not
//
// Darwin only: sandbox-exec is a macOS binary, and CI runs on Linux.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nodePrefixFor, sandboxArgv, sandboxParams, SANDBOX_EXEC, sandboxProfilePath, assistantStateDir, tmpDirOf } from "../src/sandbox.js";

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
    expect(assistantStateDir({ instanceDir: "/i", productDir: "/p" })).toBe("/i/state/assistant");
    expect(assistantStateDir({ productDir: "/p" })).toBe("/p/state/assistant");
    expect(tmpDirOf({ TMPDIR: "/var/folders/xy/T/" })).toBe("/var/folders/xy/T");
  });

  it("renders sandbox-exec as an argument array — never a shell string", () => {
    const params = sandboxParams({ productDir: "/p", nodeBin: "/n/bin/node", stateDir: "/s", consolePort: 8080, tmpDir: "/tmp", realpath: (p) => p });
    expect(params.CONSOLE_TCP).toBe("localhost:8080");
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
      "/n/bin/node",
      "/p/main.js",
    ]);
  });
});

// `describe.skipIf` keeps the Linux CI run honest: skipped, never silently passing.
describe.skipIf(process.platform !== "darwin" || !existsSync(SANDBOX_EXEC))("ops/sandbox/assistant.sb confines a real process (macOS)", () => {
  let root = "";
  let servers: net.Server[] = [];
  let consolePort = 0;
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
const [, , stateDir, outsideRead, outsideWrite, okPort, badPort] = process.argv;
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
  connect_other: await connect(badPort),
}));
`,
    );
    servers = [await listen(), await listen()];
    consolePort = (servers[0]!.address() as net.AddressInfo).port;
    otherPort = (servers[1]!.address() as net.AddressInfo).port;
  }, 30_000);

  afterAll(() => {
    for (const s of servers) s.close();
  });

  it("denies the vault, denies every write but its state dir, and reaches the console and nothing else", async () => {
    const params = sandboxParams({
      productDir: join(root, "app"),
      nodeBin: process.execPath,
      stateDir: join(root, "state"),
      consolePort,
      tmpDir: join(root, "tmp"),
    });
    const argv = sandboxArgv(sandboxProfilePath(REPO), params, [
      process.execPath,
      join(root, "app", "probe.mjs"),
      join(root, "state"),
      join(root, "documents", "private.md"),
      join(root, "documents", "written.txt"),
      String(consolePort),
      String(otherPort),
    ]);
    const { stdout } = await run(argv[0]!, argv.slice(1), { timeout: 60_000 });
    expect(JSON.parse(stdout.trim())).toEqual({
      read_outside: "denied:EPERM",
      write_outside: "denied:EPERM",
      write_state: "allowed",
      read_own_code: "allowed",
      connect_console: "allowed",
      connect_other: "denied:EPERM",
    });
  }, 90_000);
});
