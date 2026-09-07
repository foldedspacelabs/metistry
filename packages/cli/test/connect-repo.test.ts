// `metistry connect-repo`: the real git half against a temp bare repo
// (origin set, an existing origin refused, ls-remote verified, one push
// that actually lands), and the credential half with injected fetch and
// exec — where the assertion that matters is negative: the token never
// reaches stdout, stderr, a command line, or .git/config.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { connectRepo, deviceFlow, parseRemote, DEVICE_CODE_URL, DEVICE_TOKEN_URL, DEVICE_GRANT_TYPE } from "../src/connect-repo.js";
import type { Exec, ExecOptions } from "../src/exec.js";

const git = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();

/** An instance repo with one commit, plus a bare repo to push into. */
async function repos(): Promise<{ instance: string; bare: string }> {
  const root = await mkdtemp(join(tmpdir(), "metistry-connect-"));
  const instance = join(root, "instance");
  const bare = join(root, "remote.git");
  await mkdir(instance, { recursive: true });
  git(root, "init", "-q", "--bare", "-b", "main", bare);
  git(instance, "init", "-q", "-b", "main");
  git(instance, "config", "user.name", "Metistry");
  git(instance, "config", "user.email", "metistry@localhost");
  await writeFile(join(instance, "README.md"), "# instance\n");
  git(instance, "add", "-A");
  git(instance, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "Instance created");
  return { instance, bare };
}

interface Call {
  cmd: string;
  args: string[];
  opts: ExecOptions;
}

/** Records every subprocess; answers the ones connect-repo needs on the credential path. */
function fakeExec(): { exec: Exec; calls: Call[] } {
  const calls: Call[] = [];
  const exec: Exec = async (cmd, args, opts = {}) => {
    calls.push({ cmd, args, opts });
    const sub = args.filter((a) => a !== "-c" && a !== "commit.gpgsign=false")[0];
    if (cmd === "git" && sub === "remote" && args[args.length - 1] === "remote") return { code: 0, stdout: "", stderr: "" };
    if (cmd === "git" && sub === "ls-remote") return { code: 0, stdout: "abc\tHEAD\n", stderr: "" };
    if (cmd === "git" && sub === "symbolic-ref") return { code: 0, stdout: "main\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  return { exec, calls };
}

const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;

describe("parseRemote", () => {
  it("classifies the forms git accepts and refuses the ones that would leak a credential", () => {
    expect(parseRemote("https://github.com/me/instance.git")).toEqual({ kind: "https", host: "github.com" });
    expect(parseRemote("https://me@github.example/me/x.git")).toEqual({ kind: "https", host: "github.example", user: "me" });
    expect(parseRemote("git@github.com:me/instance.git")).toEqual({ kind: "ssh", host: "github.com", user: "git" });
    expect(parseRemote("ssh://git@github.com/me/instance.git")).toEqual({ kind: "ssh", host: "github.com", user: "git" });
    expect(parseRemote("/srv/git/instance.git").kind).toBe("local");
    expect(() => parseRemote("http://github.com/me/x.git")).toThrow(/clear text/);
    expect(() => parseRemote("https://me:ghp_secret@github.com/me/x.git")).toThrow(/password in it/);
  });
});

describe("metistry connect-repo (real git)", () => {
  it("sets origin, verifies it with ls-remote and pushes the branch", async () => {
    const { instance, bare } = await repos();
    const lines: string[] = [];
    const r = await connectRepo({ url: bare, instanceDir: instance, out: (l) => lines.push(l), env: {}, platform: "darwin" });

    expect(r.remote.kind).toBe("local");
    expect(r.branch).toBe("main");
    expect(r.credential).toBe("none");
    expect(r.pushed).toBe(true);
    expect(r.flushed).toBe(false);
    expect(git(instance, "remote", "get-url", "origin")).toBe(bare);
    // the push actually landed, and the branch tracks origin
    expect(git(bare, "rev-parse", "main")).toBe(git(instance, "rev-parse", "HEAD"));
    expect(git(instance, "rev-parse", "--abbrev-ref", "main@{upstream}")).toBe("origin/main");
    expect(lines.join("\n")).toMatch(/ls-remote origin: reachable/);
    // a local remote needs no credential helper, so none is configured (git exits 1 when the key is unset)
    expect(readFileSync(join(instance, ".git", "config"), "utf8")).not.toContain("credential");
  });

  it("refuses to repoint an existing origin without --force, and repoints with it", async () => {
    const { instance, bare } = await repos();
    const swallow = () => {};
    await connectRepo({ url: bare, instanceDir: instance, out: swallow, env: {}, platform: "darwin" });

    const other = join(instance, "..", "other.git");
    git(instance, "init", "-q", "--bare", "-b", "main", other);
    await expect(connectRepo({ url: other, instanceDir: instance, out: swallow, env: {}, platform: "darwin" })).rejects.toThrow(/already has an origin/);
    expect(git(instance, "remote", "get-url", "origin")).toBe(bare);

    await connectRepo({ url: other, instanceDir: instance, force: true, out: swallow, env: {}, platform: "darwin" });
    expect(git(instance, "remote", "get-url", "origin")).toBe(other);
  });

  it("refuses a directory that is not a repo", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metistry-connect-bare-"));
    await expect(connectRepo({ url: "/tmp/x.git", instanceDir: dir, out: () => {}, env: {}, platform: "darwin" })).rejects.toThrow(/not a git repository/);
  });
});

describe("device flow", () => {
  const CLIENT_ID = "Iv1.publicclientid";
  const TOKEN = "gho_TESTTOKEN_NEVER_PRINTED";

  /** authorization_pending, then slow_down, then the token — GitHub's documented sequence. */
  function fakeGitHub(): { fetchFn: typeof fetch; posts: Array<Record<string, string>> } {
    const posts: Array<Record<string, string>> = [];
    let polls = 0;
    const fetchFn = (async (url: string, init?: RequestInit) => {
      if (init?.body) posts.push(Object.fromEntries(new URLSearchParams(String(init.body))));
      if (url === DEVICE_CODE_URL) return json({ device_code: "DEVICECODE-secret", user_code: "WDJB-MJHT", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 });
      if (url === DEVICE_TOKEN_URL) {
        polls++;
        if (polls === 1) return json({ error: "authorization_pending" });
        if (polls === 2) return json({ error: "slow_down", interval: 10 });
        return json({ access_token: TOKEN, token_type: "bearer", scope: "repo" });
      }
      if (url === "https://api.github.com/user") return json({ login: "octocat" });
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;
    return { fetchFn, posts };
  }

  it("prints the user code, honours authorization_pending and slow_down, and returns the token without printing it", async () => {
    const { fetchFn, posts } = fakeGitHub();
    const lines: string[] = [];
    const waits: number[] = [];
    const token = await deviceFlow({ clientId: CLIENT_ID, fetchFn, out: (l) => lines.push(l), sleep: async (ms) => void waits.push(ms) });

    expect(token).toBe(TOKEN);
    expect(lines.join("\n")).toContain("WDJB-MJHT");
    expect(lines.join("\n")).toContain("https://github.com/login/device");
    // slow_down widened the interval for the third poll (5s, 5s, then 10s)
    expect(waits).toEqual([5000, 5000, 10000]);
    expect(posts[0]).toEqual({ client_id: CLIENT_ID, scope: "repo" });
    expect(posts[1]).toEqual({ client_id: CLIENT_ID, device_code: "DEVICECODE-secret", grant_type: DEVICE_GRANT_TYPE });
    // neither the token nor the device code is ever printed
    for (const l of lines) {
      expect(l).not.toContain(TOKEN);
      expect(l).not.toContain("DEVICECODE-secret");
    }
  });

  it("adds five seconds when slow_down carries no interval, and reports GitHub's terminal errors", async () => {
    let polls = 0;
    const fetchFn = (async (url: string) => {
      if (url === DEVICE_CODE_URL) return json({ device_code: "d", user_code: "AAAA-BBBB", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 });
      polls++;
      return polls === 1 ? json({ error: "slow_down" }) : json({ error: "access_denied" });
    }) as unknown as typeof fetch;
    const waits: number[] = [];
    await expect(deviceFlow({ clientId: CLIENT_ID, fetchFn, out: () => {}, sleep: async (ms) => void waits.push(ms) })).rejects.toThrow(/cancelled in the browser/);
    expect(waits).toEqual([5000, 10000]);
  });

  it("stores the token in the Keychain over stdin — never in argv, .env or the output", async () => {
    const { fetchFn } = fakeGitHub();
    const { exec, calls } = fakeExec();
    const lines: string[] = [];
    const r = await connectRepo({
      url: "https://github.com/octocat/instance.git",
      instanceDir: "/tmp/instance",
      auth: "device",
      out: (l) => lines.push(l),
      exec,
      fetchFn,
      env: { METISTRY_GITHUB_OAUTH_CLIENT_ID: CLIENT_ID },
      platform: "darwin",
      sleep: async () => {},
    });

    expect(r.credential).toBe("device");
    const shown = calls.map((c) => `${c.cmd} ${c.args.join(" ")}`);
    expect(shown).toContain("git -c commit.gpgsign=false config credential.helper osxkeychain");
    expect(shown).toContain("git -c commit.gpgsign=false remote add origin https://github.com/octocat/instance.git");
    expect(shown.some((s) => s.startsWith("git -c commit.gpgsign=false ls-remote origin"))).toBe(true);
    expect(shown).toContain("git -c commit.gpgsign=false push -u origin main");

    // the keychain item is git-credential-osxkeychain's shape, and the value came down stdin
    const kc = calls.find((c) => c.cmd === "security");
    expect(kc?.args).toEqual(["add-internet-password", "-U", "-a", "octocat", "-s", "github.com", "-r", "htps", "-A", "-w"]);
    expect(kc?.opts.stdin).toBe(`${TOKEN}\n${TOKEN}\n`);

    // the negative assertion this test exists for
    for (const c of calls) for (const a of c.args) expect(a).not.toContain(TOKEN);
    for (const l of lines) expect(l).not.toContain(TOKEN);
  });

  it("reads a PAT from stdin under --auth token and refuses an empty one", async () => {
    const { exec, calls } = fakeExec();
    const lines: string[] = [];
    const PAT = "github_pat_TESTVALUE";
    const fetchFn = (async () => json({ login: "octocat" })) as unknown as typeof fetch;
    await connectRepo({
      url: "https://github.com/octocat/instance.git",
      instanceDir: "/tmp/instance",
      auth: "token",
      out: (l) => lines.push(l),
      exec,
      fetchFn,
      env: {},
      platform: "darwin",
      readSecret: async () => `${PAT}\n`,
    });
    expect(calls.find((c) => c.cmd === "security")?.opts.stdin).toBe(`${PAT}\n${PAT}\n`);
    for (const l of lines) expect(l).not.toContain(PAT);

    await expect(
      connectRepo({ url: "https://github.com/octocat/x.git", instanceDir: "/tmp/instance", auth: "token", out: () => {}, exec: fakeExec().exec, fetchFn, env: {}, platform: "darwin", readSecret: async () => "  " }),
    ).rejects.toThrow(/no token on stdin/);
  });

  it("says what to register when the client id is missing, and prints the Linux remediation instead of a Keychain", async () => {
    const { exec } = fakeExec();
    await expect(
      connectRepo({ url: "https://github.com/octocat/x.git", instanceDir: "/tmp/instance", auth: "device", out: () => {}, exec, env: {}, platform: "darwin" }),
    ).rejects.toThrow(/METISTRY_GITHUB_OAUTH_CLIENT_ID is unset/);

    const lines: string[] = [];
    const linux = fakeExec();
    await connectRepo({ url: "https://github.com/octocat/x.git", instanceDir: "/tmp/instance", auth: "ssh", out: (l) => lines.push(l), exec: linux.exec, env: {}, platform: "linux" });
    expect(lines.join("\n")).toMatch(/git-credentials/);
    expect(linux.calls.some((c) => c.cmd === "security")).toBe(false);
    expect(linux.calls.some((c) => c.args.includes("credential.helper"))).toBe(false);
  });

  it("flushes the reconciler's queue before pushing when one is configured", async () => {
    const { exec } = fakeExec();
    const seen: string[] = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      seen.push(`${init?.method ?? "GET"} ${url}`);
      return json({ ok: true });
    }) as unknown as typeof fetch;
    const r = await connectRepo({
      url: "/srv/git/instance.git",
      instanceDir: "/tmp/instance",
      out: () => {},
      exec,
      fetchFn,
      env: { METISTRY_RECONCILER_URL: "http://host.docker.internal:7812", METISTRY_BRIDGE_TOKEN_RECONCILER: "t" },
      platform: "darwin",
    });
    expect(r.flushed).toBe(true);
    expect(seen).toEqual(["POST http://127.0.0.1:7812/flush"]);
  });
});
