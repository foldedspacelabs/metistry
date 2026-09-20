// Misuse tests for the SOLE COMMITTER's host confinement (invariant 8:
// every boundary testable, misuse tests ship with the interface).
//
// The reconciler is the one process that holds the instance repo's working
// tree and the only place git runs (D5). These tests do not read
// ops/sandbox/reconciler.sb and agree with it — they launch a real process
// under the real profile with the real parameters `metistry up` computes,
// and prove what it claims:
//
//   1. it can read and WRITE the instance repo — it is the committer
//   2. it cannot read a `~/Documents`-shaped path outside that repo
//   3. it cannot write the product checkout it runs from
//   4. it cannot exec a shell, and cannot exec ssh
//   5. real `git` works confined: status, add, commit, and a commit's
//      contents are what landed on disk
//   6. git is FATAL without its global config, which is why the profile
//      grants that one file by name
//   7. outbound reaches the egress proxy's port and no other
//
// …plus the finding that shaped the whole profile, asserted rather than
// remembered: `/usr/bin/git` is the xcode-select shim and dies under a
// profile, so `resolveGitBin` must never return it.
//
// Darwin only: sandbox-exec is a macOS binary, and CI runs on Linux.

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { askpassPath, askpassScript } from "../src/askpass.js";
import {
  CLT_GIT,
  gitPrefixFor,
  globalGitConfigPath,
  isXcodeGitShim,
  reconcilerConfined,
  reconcilerSandboxParams,
  reconcilerSandboxProfilePath,
  resolveGitBin,
  sandboxArgv,
  SANDBOX_EXEC,
  UNCONFINED_PROFILE_REL,
} from "../src/sandbox.js";

const run = promisify(execFile);
const REPO = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");

const PARAMS = {
  productDir: "/p",
  nodeBin: "/n/bin/node",
  instanceDir: "/i",
  gitBin: "/g/bin/git",
  gitConfigGlobal: "/h/.gitconfig",
  askpassBin: "/i/.metistry/state/bin/git-askpass",
  reconcilerPort: 7812,
  consolePort: 8080,
  dbPort: 5432,
  embedPort: 11434,
  proxyPort: 7814,
  tmpDir: "/tmp",
  realpath: (p: string) => p,
};

describe("reconciler sandbox parameters", () => {
  it("names a REAL git's prefix — never /usr/bin/git, which is the xcode-select shim", () => {
    // measured 2026-09-19: `otool -L /usr/bin/git` → libxcselect.dylib, and
    // under a profile granting that one literal it dies with
    // `xcrun: error: unable to load libxcrun (… sandbox blocked open())`
    expect(isXcodeGitShim("/usr/bin/git")).toBe(true);
    expect(isXcodeGitShim("/Library/Developer/CommandLineTools/usr/bin/git")).toBe(false);
    // no bundled runtime, and PATH offers only the shim: the Command Line
    // Tools' real git is what the profile names
    expect(resolveGitBin({ productDir: "/p", path: "/usr/bin", exists: (x) => !x.startsWith("/p/") })).toBe(CLT_GIT);
    // a real git on PATH is preferred to the CLT fallback
    expect(resolveGitBin({ productDir: "/p", path: "/usr/bin:/opt/homebrew/bin", exists: (x) => !x.startsWith("/p/") })).toBe("/opt/homebrew/bin/git");
    // and the bundled runtime wins over both: it is what the deps pack ships a git for
    expect(resolveGitBin({ productDir: "/p", path: "/opt/homebrew/bin", exists: () => true })).toBe("/p/runtime/git/bin/git");
    // and a Mac with neither is `undefined` — `up` declines to confine
    // rather than installing a reconciler that cannot commit
    expect(resolveGitBin({ productDir: "/p", path: "/usr/bin", exists: (x) => x === "/usr/bin/git" })).toBeUndefined();
  });

  it("the prefix is two levels up — and the brew prefix for a Homebrew git, which links against sibling formulae", () => {
    expect(gitPrefixFor("/Library/Developer/CommandLineTools/usr/bin/git", (p) => p)).toBe("/Library/Developer/CommandLineTools/usr");
    expect(gitPrefixFor("/opt/homebrew/bin/git", () => "/opt/homebrew/Cellar/git/2.55.0/bin/git")).toBe("/opt/homebrew");
  });

  it("renders sandbox-exec as an argument array, with the instance repo as the one writable tree", () => {
    const p = reconcilerSandboxParams(PARAMS);
    expect(p).toEqual({
      NODE_BIN: "/n/bin/node",
      NODE_PREFIX: "/n",
      PRODUCT_DIR: "/p",
      INSTANCE_DIR: "/i",
      TMP_DIR: "/tmp",
      GIT_PREFIX: "/g",
      GIT_CONFIG_GLOBAL: "/h/.gitconfig",
      ASKPASS_BIN: "/i/.metistry/state/bin/git-askpass",
      RECONCILER_TCP: "localhost:7812",
      CONSOLE_TCP: "localhost:8080",
      DB_TCP: "localhost:5432",
      EMBED_TCP: "localhost:11434",
      PROXY_TCP: "localhost:7814",
    });
    expect(sandboxArgv("/p/ops/sandbox/reconciler.sb", p, ["/n/bin/node", "/p/main.js"])[0]).toBe(SANDBOX_EXEC);
    expect(globalGitConfigPath("/Users/x")).toBe("/Users/x/.gitconfig");
  });

  it("every parameter the profile declares is one `up` supplies, and every one `up` supplies is declared", () => {
    const profile = readFileSync(reconcilerSandboxProfilePath(REPO), "utf8");
    const declared = new Set([...profile.matchAll(/\(param "([A-Z0-9_]+)"\)/g)].map((m) => m[1]!));
    expect([...declared].sort()).toEqual(Object.keys(reconcilerSandboxParams(PARAMS)).sort());
  });

  it("the profile has no shell and no blanket outbound: every exec and every connect names a parameter", () => {
    const rules = readFileSync(reconcilerSandboxProfilePath(REPO), "utf8")
      .split("\n")
      .filter((l) => !l.trimStart().startsWith(";;"))
      .join("\n");
    expect(rules).not.toContain("/bin/sh");
    expect(rules).not.toContain("/bin/bash");
    expect(rules).not.toContain("/usr/bin/ssh");
    expect(rules).not.toMatch(/\(remote tcp "\*:\d+"\)/);
    for (const rule of rules.matchAll(/\(allow network-outbound[^\n]*\n?/g)) {
      expect(rule[0], rule[0]).toMatch(/\(param "(CONSOLE_TCP|DB_TCP|EMBED_TCP|PROXY_TCP)"\)|unix-socket/);
    }
  });

  it("the off switch is a real file that allows everything, and only the documented values flip it", () => {
    expect(reconcilerConfined({})).toBe(true);
    expect(reconcilerConfined({ METISTRY_RECONCILER_SANDBOX: "1" })).toBe(true);
    for (const v of ["0", "false", "off", "no", "OFF"]) expect(reconcilerConfined({ METISTRY_RECONCILER_SANDBOX: v }), v).toBe(false);
    expect(reconcilerSandboxProfilePath("/p", false)).toBe(`/p/${UNCONFINED_PROFILE_REL}`);
    expect(readFileSync(join(REPO, UNCONFINED_PROFILE_REL), "utf8")).toContain("(allow default)");
  });
});

// `describe.skipIf` keeps the Linux CI run honest: skipped, never silently passing.
const GIT = resolveGitBin({ productDir: REPO, path: process.env.PATH ?? "" });
describe.skipIf(process.platform !== "darwin" || !existsSync(SANDBOX_EXEC) || !GIT)("ops/sandbox/reconciler.sb confines a real process (macOS)", () => {
  let root = "";
  let servers: net.Server[] = [];
  let consolePort = 0;
  let dbPort = 0;
  let proxyPort = 0;
  let otherPort = 0;
  let instance = "";
  let home = "";

  const listen = () =>
    new Promise<net.Server>((res, rej) => {
      const s = net.createServer((c) => c.end());
      s.once("error", rej);
      s.listen(0, "127.0.0.1", () => res(s));
    });

  const confine = (argv: string[], extra: Partial<typeof PARAMS> = {}) =>
    sandboxArgv(
      reconcilerSandboxProfilePath(REPO),
      reconcilerSandboxParams({
        productDir: join(root, "product"),
        nodeBin: process.execPath,
        instanceDir: instance,
        gitBin: GIT!,
        gitConfigGlobal: globalGitConfigPath(home),
        askpassBin: askpassPath(instance),
        // a real port: sandbox-exec rejects `localhost:0` in a bind rule
        reconcilerPort: 7812,
        consolePort,
        dbPort,
        embedPort: 11434,
        proxyPort,
        tmpDir: join(root, "tmp"),
        ...extra,
      }),
      argv,
    );

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "metistry-rsb-"));
    instance = join(root, "instance");
    home = join(root, "home");
    await mkdir(join(root, "product"), { recursive: true });
    await mkdir(join(root, "tmp"), { recursive: true });
    await mkdir(join(instance, "Journal"), { recursive: true });
    await mkdir(home, { recursive: true });
    await mkdir(join(root, "documents"), { recursive: true });
    await writeFile(join(root, "documents", "private.md"), "a note the reconciler must not be able to read");
    await writeFile(join(home, ".gitconfig"), "[user]\n\tname = Test\n\temail = t@example.test\n");
    // the askpass shim, exactly as `metistry up` generates it
    await mkdir(join(instance, ".metistry", "state", "bin"), { recursive: true });
    await writeFile(askpassPath(instance), askpassScript(process.execPath), { mode: 0o755 });
    await writeFile(join(instance, "Journal", "2026-09-19.md"), "the vault, which this process may write\n");
    await writeFile(
      join(root, "product", "probe.mjs"),
      `import { readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
const [, , instanceDir, productDir, outsideRead, okPort, dbPort, proxyPort, badPort] = process.argv;
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
  read_vault: attempt(() => readFileSync(instanceDir + "/Journal/2026-09-19.md", "utf8")),
  write_vault: attempt(() => writeFileSync(instanceDir + "/Journal/probe.md", "x")),
  write_git_dir: attempt(() => writeFileSync(instanceDir + "/.git/probe", "x")),
  write_product: attempt(() => writeFileSync(productDir + "/probe.txt", "x")),
  connect_console: await connect(okPort),
  connect_db: await connect(dbPort),
  connect_proxy: await connect(proxyPort),
  connect_other: await connect(badPort),
}));
`,
    );
    servers = [await listen(), await listen(), await listen(), await listen()];
    consolePort = (servers[0]!.address() as net.AddressInfo).port;
    dbPort = (servers[1]!.address() as net.AddressInfo).port;
    proxyPort = (servers[2]!.address() as net.AddressInfo).port;
    otherPort = (servers[3]!.address() as net.AddressInfo).port;
    // a real repo for the git half
    const g = (args: string[]) => run(GIT!, ["-C", instance, ...args], { env: { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1" } });
    await g(["init", "-q", "-b", "main"]);
    await g(["add", "-A"]);
    await g(["commit", "-qm", "seed"]);
  }, 60_000);

  afterAll(() => {
    for (const s of servers) s.close();
  });

  it("writes the instance repo and nothing else, and reaches the console, the db and the egress proxy — and no other port", async () => {
    const argv = confine([
      process.execPath,
      join(root, "product", "probe.mjs"),
      instance,
      join(root, "product"),
      join(root, "documents", "private.md"),
      String(consolePort),
      String(dbPort),
      String(proxyPort),
      String(otherPort),
    ]);
    const { stdout } = await run(argv[0]!, argv.slice(1), { timeout: 60_000, cwd: join(root, "product") });
    expect(JSON.parse(stdout.trim())).toEqual({
      // ~/Documents-shaped: the gap this profile closed
      read_outside: "denied:EPERM",
      // the vault IS its business — it is the sole committer
      read_vault: "allowed",
      write_vault: "allowed",
      write_git_dir: "allowed",
      // …but the product checkout it runs from is read-only
      write_product: "denied:EPERM",
      connect_console: "allowed",
      connect_db: "allowed",
      connect_proxy: "allowed",
      connect_other: "denied:EPERM",
    });
  }, 90_000);

  it("execs the askpass shim, which prints the credential from its own environment and nothing else", async () => {
    // the whole credential path in one assertion: git execs askpass
    // DIRECTLY (no shell), and the shim can reach exactly two variables
    const argv = confine([askpassPath(instance), "Password for 'https://x@example.test': "]);
    const { stdout } = await run(argv[0]!, argv.slice(1), {
      timeout: 30_000,
      cwd: join(root, "product"),
      env: { ...process.env, METISTRY_GIT_ASKPASS_USER: "x-access-token", METISTRY_GIT_ASKPASS_TOKEN: "tok-from-the-keychain" },
    });
    expect(stdout.trim()).toBe("tok-from-the-keychain");
    const user = confine([askpassPath(instance), "Username for 'https://example.test': "]);
    const u = await run(user[0]!, user.slice(1), {
      timeout: 30_000,
      cwd: join(root, "product"),
      env: { ...process.env, METISTRY_GIT_ASKPASS_USER: "x-access-token", METISTRY_GIT_ASKPASS_TOKEN: "tok-from-the-keychain" },
    });
    expect(u.stdout.trim()).toBe("x-access-token");
    // …and with no credential in the environment it refuses loudly rather
    // than printing an empty line git would read as a blank password
    await expect(
      run(argv[0]!, argv.slice(1), { timeout: 30_000, cwd: join(root, "product"), env: { ...process.env, METISTRY_GIT_ASKPASS_USER: "", METISTRY_GIT_ASKPASS_TOKEN: "" } }),
    ).rejects.toThrow(/no credential in this process/);
  }, 60_000);

  it("an askpass OUTSIDE the granted literal is refused — the exec allowlist is the only gate", async () => {
    // the same shim, byte for byte, one directory over: it is the profile's
    // literal that admits it, not its contents
    const elsewhere = join(root, "tmp", "git-askpass");
    await writeFile(elsewhere, askpassScript(process.execPath), { mode: 0o755 });
    const argv = confine([elsewhere, "Password for 'https://x@example.test': "]);
    await expect(
      run(argv[0]!, argv.slice(1), { timeout: 30_000, cwd: join(root, "product"), env: { ...process.env, METISTRY_GIT_ASKPASS_TOKEN: "tok" } }),
    ).rejects.toThrow(/Operation not permitted/);
  }, 60_000);

  it("cannot exec a shell, and cannot exec ssh — which is why SSH remotes are unsupported while confined", async () => {
    for (const bin of ["/bin/sh", "/bin/bash", "/usr/bin/ssh", "/usr/bin/env"]) {
      const argv = confine([bin, "-c", "echo pwned"]);
      await expect(run(argv[0]!, argv.slice(1), { timeout: 30_000, cwd: join(root, "product") }), bin).rejects.toThrow(/Operation not permitted/);
    }
  }, 90_000);

  it("runs real git confined: status, add, commit — and the commit is what landed on disk", async () => {
    const note = join(instance, "Journal", "confined.md");
    await writeFile(note, "written before the confined commit\n");
    const gitEnv = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
    const git = async (args: string[]) => {
      const argv = confine([GIT!, "-C", instance, ...args]);
      return run(argv[0]!, argv.slice(1), { timeout: 60_000, cwd: join(root, "product"), env: gitEnv });
    };
    expect((await git(["status", "--porcelain"])).stdout).toContain("Journal/confined.md");
    await git(["add", "-A"]);
    await git(["commit", "-qm", "confined commit"]);
    const log = await git(["log", "-1", "--format=%s"]);
    expect(log.stdout.trim()).toBe("confined commit");
    expect((await git(["show", "--format=", "--name-only", "HEAD"])).stdout).toContain("Journal/confined.md");
  }, 120_000);

  it("git is FATAL without its global config, which is why the profile grants that one file by name", async () => {
    // GIT_CONFIG_GLOBAL pointed somewhere the profile does not allow: git
    // does not skip an unreadable global config, it refuses to run. Measured
    // 2026-09-19 and the reason for that rule.
    const argv = confine([GIT!, "-C", instance, "status", "--porcelain"], { gitConfigGlobal: join(root, "tmp", "nothing-here") });
    await expect(
      run(argv[0]!, argv.slice(1), { timeout: 60_000, cwd: join(root, "product"), env: { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1" } }),
    ).rejects.toThrow(/unable to access '.*\.gitconfig': Operation not permitted/);
  }, 90_000);

  it("a confined process cannot re-sandbox itself looser", async () => {
    // sandbox(7): one profile per process tree, applied at the root. Proven
    // rather than assumed, because it is what makes "every child inherits
    // the confinement" true for git's 172 helpers.
    const argv = confine([SANDBOX_EXEC, "-p", "(version 1)(allow default)", process.execPath, "-e", "console.log('escaped')"]);
    await expect(run(argv[0]!, argv.slice(1), { timeout: 30_000, cwd: join(root, "product") })).rejects.toThrow(/Operation not permitted/);
  }, 60_000);
});
