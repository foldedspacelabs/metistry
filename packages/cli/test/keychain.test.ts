// How a value reaches the Keychain: `security -i` with ONE quoted command
// line on stdin (keychain.ts). The unit half pins the wire format and its
// refusals against a fake; the macOS half runs the REAL `security` against a
// scratch keychain FILE — never the login keychain — to prove its tokenizer
// reads back exactly what `interactiveLine` writes, and that a controlling
// terminal changes nothing (the 0.12.0 → 0.14.0 upgrade: `add-generic-password
// … -w` read the value with getpass(3), which prefers /dev/tty over the pipe,
// so `metistry update` in Terminal hung on "password data for new item:").
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { realExec, type Exec, type ExecOptions } from "../src/exec.js";
import { interactiveLine, Keychain, SECURITY_LINE_MAX, securityKeychain, securityQuote } from "../src/keychain.js";
import { decodeSecurity, splitSecurityLine } from "./fake-security.js";

const SECRET = "s3cr3t with space, \"quotes\", 'apostrophes', back\\slash and $HOME";

function recorder(result = { code: 0, stdout: "", stderr: "" }) {
  const calls: Array<{ cmd: string; argv: string[]; opts: ExecOptions }> = [];
  const exec: Exec = async (cmd, argv, opts = {}) => {
    calls.push({ cmd, argv, opts });
    return result;
  };
  return { exec, calls };
}

describe("a Keychain write is `security -i` with the command on stdin", () => {
  it("argv is `-i` and nothing else; the value is on the stdin line, quoted so the tool reads it back whole", async () => {
    const { exec, calls } = recorder();
    await securityKeychain(exec).set("metistry:METISTRY_X_TOKEN", "acct-1", SECRET);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe("security");
    expect(calls[0]!.argv).toEqual(["-i"]);
    for (const a of calls[0]!.argv) expect(a).not.toContain("s3cr3t");
    const line = String(calls[0]!.opts.stdin);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.split("\n").filter(Boolean)).toHaveLength(1);
    // read back by the same rules as security(1)'s split_line
    expect(splitSecurityLine(line.trimEnd())).toEqual(["add-generic-password", "-U", "-a", "acct-1", "-s", "metistry:METISTRY_X_TOKEN", "-w", SECRET]);
    expect(decodeSecurity(calls[0]!.argv, calls[0]!.opts).value).toBe(SECRET);
  });

  it("the git credential goes the same way", async () => {
    const { exec, calls } = recorder();
    await new Keychain(exec).setGitCredential("github.com", "octocat", "ghp_TOKEN");
    expect(calls[0]!.argv).toEqual(["-i"]);
    expect(calls[0]!.opts.stdin).toBe('"add-internet-password" "-U" "-a" "octocat" "-s" "github.com" "-r" "htps" "-A" "-w" "ghp_TOKEN"\n');
  });

  it("a value longer than getpass(3)'s 128 characters is carried whole — the prompt form kept only the first 128", async () => {
    const { exec, calls } = recorder();
    const long = "k".repeat(300);
    await securityKeychain(exec).set("svc", "acct", long);
    expect(decodeSecurity(calls[0]!.argv, calls[0]!.opts).value).toBe(long);
  });

  it("refuses what the tool cannot carry — a newline, a NUL, a line it would split — and never names the value", async () => {
    const { exec, calls } = recorder();
    const kc = securityKeychain(exec);
    await expect(kc.set("svc", "acct", "two\nlines")).rejects.toThrow(/newline/);
    await expect(kc.set("svc", "acct", "nul\0byte")).rejects.toThrow(/newline/);
    const huge = `TAIL-${"x".repeat(SECURITY_LINE_MAX)}`;
    const err = await kc.set("svc", "acct", huge).catch((e: Error) => e);
    expect(String(err)).toMatch(/too long for the Keychain's command line/);
    expect(String(err)).not.toContain("TAIL-");
    expect(calls).toEqual([]); // nothing reached `security` at all
  });

  it("a failed write says what `security` said, not its `returned <status>` trailer", async () => {
    const { exec } = recorder({ code: 45, stdout: "", stderr: "security: SecKeychainItemCreateFromContent (<default>): User interaction is not allowed.\nadd-generic-password: returned -25308\n" });
    await expect(securityKeychain(exec).set("metistry:V_TOKEN", "acct", "v")).rejects.toThrow("security add-generic-password metistry:V_TOKEN failed (45): security: SecKeychainItemCreateFromContent (<default>): User interaction is not allowed.");
    const silent = recorder({ code: 1, stdout: "", stderr: "" });
    await expect(securityKeychain(silent.exec).set("s", "a", "v")).rejects.toThrow(/no message — a locked keychain, or a timeout/);
  });

  it("securityQuote escapes exactly the two characters the tokenizer treats specially inside double quotes", () => {
    expect(securityQuote(`a"b\\c 'd' $e`)).toBe(`"a\\"b\\\\c 'd' $e"`);
    expect(splitSecurityLine(securityQuote(`a"b\\c 'd' $e`))).toEqual([`a"b\\c 'd' $e`]);
    expect(interactiveLine(["x", ""])).toBe('"x" ""\n');
  });
});

// ---- the real tool, against a scratch keychain file ----------------------------------

const run = promisify(execFile);
const SECURITY = "/usr/bin/security";
const SCRIPT = "/usr/bin/script";

describe.skipIf(process.platform !== "darwin" || !existsSync(SECURITY))("the real `security -i` (macOS, a scratch keychain file — never the login keychain)", () => {
  let dir = "";
  let kc = "";

  // `security add-generic-password … <keychain>` given a keychain path that
  // does not exist falls back to the DEFAULT keychain — the login one — and
  // writes there (seen while writing this test). So every call below first
  // proves the scratch file exists.
  const scratch = (): string => {
    if (!kc || !existsSync(kc)) throw new Error(`scratch keychain ${kc} is missing — refusing to call security, which would fall back to the login keychain`);
    return kc;
  };
  const add = (service: string, value: string) => realExec("security", ["-i"], { stdin: interactiveLine(["add-generic-password", "-U", "-a", "metistry-test", "-s", service, "-w", value, scratch()]) });
  const read = async (service: string): Promise<string | undefined> => {
    const r = await realExec("security", ["find-generic-password", "-a", "metistry-test", "-s", service, "-w", scratch()]);
    return r.code === 0 ? r.stdout.replace(/\n$/, "") : undefined;
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "metistry-kc-"));
    kc = join(dir, "test.keychain-db");
    await run(SECURITY, ["create-keychain", "-p", "scratch", kc]);
    await run(SECURITY, ["unlock-keychain", "-p", "scratch", kc]);
    scratch();
  });
  afterAll(async () => {
    if (kc && existsSync(kc)) await run(SECURITY, ["delete-keychain", kc]).catch(() => {});
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("round-trips every awkward printable value byte for byte, including one past getpass(3)'s 128", async () => {
    const values = ["plain", " leading and trailing ", SECRET, "`tick` ;&|<>*?[]{}()#!~", "-starts-with-a-dash", "", "y".repeat(129), "z".repeat(3000)];
    for (const [i, v] of values.entries()) {
      const r = await add(`metistry-test:rt${i}`, v);
      expect({ i, code: r.code, stderr: r.stderr }).toEqual({ i, code: 0, stderr: "" });
      expect(await read(`metistry-test:rt${i}`)).toBe(v);
    }
  });

  it("-U replaces an existing item; without it the tool refuses — the status is the command's own", async () => {
    expect((await add("metistry-test:replace", "first")).code).toBe(0);
    expect((await add("metistry-test:replace", "second")).code).toBe(0);
    expect(await read("metistry-test:replace")).toBe("second");
    const r = await realExec("security", ["-i"], { stdin: interactiveLine(["add-generic-password", "-a", "metistry-test", "-s", "metistry-test:replace", "-w", "third", scratch()]) });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/already exists/);
    expect(r.stderr).not.toContain("third");
  });

  it.skipIf(!existsSync(SCRIPT))("reads the pipe even with a controlling terminal — the case that hung the owner's update", async () => {
    // script(1) gives the child a pty as its controlling terminal, exactly as
    // Terminal does. The child writes through execFile + stdin, the same
    // mechanism realExec uses; the value is handed over in the environment.
    // (The same harness around the OLD form — a getpass(3) prompt fed on
    // stdin — prints the prompt on the pty and is killed by the timeout with
    // nothing on stderr: the owner's "exited 1 with an empty message".)
    const line = interactiveLine(["add-generic-password", "-U", "-a", "metistry-test", "-s", "metistry-test:tty", "-w", "from-the-pipe-under-a-tty", scratch()]);
    const child = `const { execFile } = require("node:child_process");
process.stdout.write("tty=" + require("node:tty").isatty(0) + "\\n");
const c = execFile("security", ["-i"], { timeout: 10000 }, (err) => { process.stdout.write("security-exit=" + (err ? (err.code ?? "killed") : 0) + "\\n"); });
c.stdin.end(process.env.LINE);`;
    const out = await new Promise<string>((resolve, reject) => {
      const p = spawn(SCRIPT, ["-q", "/dev/null", process.execPath, "-e", child], { env: { ...process.env, LINE: line }, stdio: ["ignore", "pipe", "pipe"] });
      let text = "";
      p.stdout.on("data", (d: Buffer) => (text += d.toString()));
      p.stderr.on("data", (d: Buffer) => (text += d.toString()));
      const t = setTimeout(() => (p.kill("SIGKILL"), reject(new Error(`timed out under a pty: ${text}`))), 20_000);
      p.on("exit", () => (clearTimeout(t), resolve(text)));
    });
    expect(out).toContain("tty=true"); // the harness really had a terminal
    expect(out).toContain("security-exit=0");
    expect(out).not.toContain("password data for new item");
    expect(await read("metistry-test:tty")).toBe("from-the-pipe-under-a-tty");
  }, 30_000);
});
