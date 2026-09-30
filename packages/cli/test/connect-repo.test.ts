// `metistry connect-repo`: the real git half against a temp bare repo
// (origin set, an existing origin refused, ls-remote verified, one push
// that actually lands), and the credential half with injected fetch and
// exec — where the assertion that matters is negative: the token never
// reaches stdout, stderr, a command line, or .git/config.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { connectRepo, deviceFlow, parseRemote, DEVICE_CODE_URL, DEVICE_TOKEN_URL, DEVICE_GRANT_TYPE } from "../src/connect-repo.js";
import { DEFAULT_GITHUB_OAUTH_CLIENT_ID } from "../src/connect-repo.js";
import { realExec, type Exec, type ExecOptions } from "../src/exec.js";
import { resolveGitBin } from "../src/sandbox.js";
import { startHttpsGitServer, type HttpsGitServer } from "./https-git-server.js";

const REPO = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");
const GIT_BIN = resolveGitBin({ productDir: REPO, path: process.env.PATH ?? "" });

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
  shim?: string;
}

/** Records every subprocess; answers the ones connect-repo needs on the credential path. */
function fakeExec(): { exec: Exec; calls: Call[] } {
  const calls: Call[] = [];
  const exec: Exec = async (cmd, args, opts = {}) => {
    // the askpass shim, as it was on disk while git could have run it
    const askpass = opts.env?.GIT_ASKPASS;
    calls.push({ cmd, args, opts, ...(askpass && existsSync(askpass) ? { shim: readFileSync(askpass, "utf8") } : {}) });
    if (cmd === "security" && args[0] === "delete-internet-password") return { code: 44, stdout: "", stderr: "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain." };
    const sub = args.filter((a, i) => a !== "-c" && args[i - 1] !== "-c")[0];
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
    expect(shown).toContain("git -c commit.gpgsign=false -c credential.helper= ls-remote origin");
    expect(shown).toContain("git -c commit.gpgsign=false -c credential.helper= push -u origin main");

    // the keychain item is git-credential-osxkeychain's shape, and the value came down stdin
    const kc = calls.find((c) => c.cmd === "security" && c.args[0] === "-i");
    expect(kc?.opts.stdin).toBe(`"add-internet-password" "-a" "octocat" "-s" "github.com" "-r" "htps" "-A" "-w" "${TOKEN}"\n`);

    // the negative assertion this test exists for
    for (const c of calls) for (const a of c.args) expect(a).not.toContain(TOKEN);
    for (const l of lines) expect(l).not.toContain(TOKEN);
  });

  it("files the item (delete, then add -A) BEFORE anything reaches the remote, and reaches it without the osxkeychain helper", async () => {
    // 2026-09-29: a push through the helper let git-credential-osxkeychain
    // create the item with an ACL trusting only itself; the supervisor's
    // background read was refused from then on.
    const { fetchFn } = fakeGitHub();
    const { exec, calls } = fakeExec();
    await connectRepo({
      url: "https://github.com/octocat/instance.git",
      instanceDir: "/tmp/instance",
      auth: "device",
      out: () => {},
      exec,
      fetchFn,
      env: { METISTRY_GITHUB_OAUTH_CLIENT_ID: CLIENT_ID },
      platform: "darwin",
      sleep: async () => {},
      nodeBin: "/opt/node/bin/node",
    });

    const idx = (pred: (c: Call) => boolean) => calls.findIndex(pred);
    const del = idx((c) => c.cmd === "security" && c.args[0] === "delete-internet-password");
    const add = idx((c) => c.cmd === "security" && c.args[0] === "-i");
    const lsRemote = idx((c) => c.cmd === "git" && c.args.includes("ls-remote"));
    const push = idx((c) => c.cmd === "git" && c.args.includes("push"));
    expect(calls[del]!.args).toEqual(["delete-internet-password", "-a", "octocat", "-s", "github.com", "-r", "htps"]);
    expect(del).toBeGreaterThanOrEqual(0);
    expect(add).toBeGreaterThan(del);
    expect(lsRemote).toBeGreaterThan(add);
    expect(push).toBeGreaterThan(add);

    for (const i of [lsRemote, push]) {
      const c = calls[i]!;
      // the helper list is reset for this call, so no helper can file or erase an item
      expect(c.args.slice(0, 4)).toEqual(["-c", "commit.gpgsign=false", "-c", "credential.helper="]);
      // …and git asks the askpass shim, which answers from the environment
      expect(c.opts.env?.GIT_ASKPASS).toMatch(/metistry-askpass-.*\/git-askpass$/);
      expect(c.opts.env?.GIT_TERMINAL_PROMPT).toBe("0");
      expect(c.opts.env?.METISTRY_GIT_ASKPASS_USER).toBe("octocat");
      expect(c.opts.env?.METISTRY_GIT_ASKPASS_TOKEN).toBe(TOKEN);
      // the shim is the reconciler's own, on disk while git ran — and holds no token
      expect(c.shim).toMatch(/^#!\/opt\/node\/bin\/node\n/);
      expect(c.shim).not.toContain(TOKEN);
    }
    // and it does not outlive the command
    expect(existsSync(calls[push]!.opts.env!.GIT_ASKPASS!)).toBe(false);
    // the non-network git calls are untouched
    expect(calls.filter((c) => c.cmd === "git" && !c.args.includes("push") && !c.args.includes("ls-remote")).every((c) => c.opts.env === undefined)).toBe(true);
  });

  it("with no token to hand over (a local remote), git finds credentials as it always did", async () => {
    const { exec, calls } = fakeExec();
    await connectRepo({ url: "/srv/git/instance.git", instanceDir: "/tmp/instance", out: () => {}, exec, env: {}, platform: "darwin" });
    const push = calls.find((c) => c.cmd === "git" && c.args.includes("push"))!;
    expect(push.args).toEqual(["-c", "commit.gpgsign=false", "push", "-u", "origin", "main"]);
    expect(push.opts.env).toBeUndefined();
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
    expect(calls.find((c) => c.cmd === "security" && c.args[0] === "-i")?.opts.stdin).toBe(`"add-internet-password" "-a" "octocat" "-s" "github.com" "-r" "htps" "-A" "-w" "${PAT}"\n`);
    for (const l of lines) expect(l).not.toContain(PAT);

    await expect(
      connectRepo({ url: "https://github.com/octocat/x.git", instanceDir: "/tmp/instance", auth: "token", out: () => {}, exec: fakeExec().exec, fetchFn, env: {}, platform: "darwin", readSecret: async () => "  " }),
    ).rejects.toThrow(/no token on stdin/);
  });

  it("uses the product's OAuth App when no client id is configured, and prints the Linux remediation instead of a Keychain", async () => {
    const { exec } = fakeExec();
    let seen = "";
    const fetchFn = (async (_url: string, init?: { body?: string }) => { seen = String(init?.body ?? ""); throw new Error("stop-here"); }) as unknown as typeof fetch;
    await expect(
      connectRepo({ url: "https://github.com/octocat/x.git", instanceDir: "/tmp/instance", auth: "device", out: () => {}, exec, env: {}, platform: "darwin", fetchFn }),
    ).rejects.toThrow(/stop-here/);
    expect(seen).toContain(DEFAULT_GITHUB_OAUTH_CLIENT_ID);

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

describe.skipIf(process.platform !== "darwin" || !GIT_BIN || !existsSync("/usr/bin/openssl"))("metistry connect-repo over real HTTPS (macOS)", () => {
  // The whole path for real — ls-remote and push against an HTTPS remote that
  // demands Basic auth — with `security` stubbed (the owner's login Keychain
  // is never touched) and the repo's credential helper swapped for a recorder,
  // so "the push did not go through the helper" is observed, not inferred.
  const USER = "octocat";
  const TOKEN = "tok-connect-repo-e2e-only";
  let server: HttpsGitServer | undefined;

  afterAll(async () => {
    await server?.close();
  });

  it("stores first, then authenticates ls-remote and the push through askpass — the helper never runs", async () => {
    const { instance } = await repos();
    const root = join(instance, "..");
    await mkdir(join(root, "remotes"), { recursive: true });
    execFileSync(GIT_BIN!, ["init", "-q", "--bare", "-b", "main", join(root, "remotes", "instance.git")]);
    server = await startHttpsGitServer({ projectRoot: join(root, "remotes"), gitBin: GIT_BIN!, certDir: join(root, "certs"), user: USER, token: TOKEN });

    const helperLog = join(root, "helper-ran");
    const recorder = join(root, "recording-helper");
    await writeFile(recorder, `#!/bin/sh\necho "$@" >> '${helperLog}'\n`, { mode: 0o755 });

    const order: string[] = [];
    const exec: Exec = async (cmd, args, opts = {}) => {
      if (cmd === "security") {
        order.push(`security ${args[0]}`);
        return args[0] === "delete-internet-password" ? { code: 44, stdout: "", stderr: "" } : { code: 0, stdout: "", stderr: "" };
      }
      // the helper connect-repo configures, pointed at a recorder instead of the real Keychain
      const a = args.join(" ") === "-c commit.gpgsign=false config credential.helper osxkeychain" ? ["-c", "commit.gpgsign=false", "config", "credential.helper", recorder] : args;
      const sub = a.filter((x, i) => x !== "-c" && a[i - 1] !== "-c")[0] ?? "";
      order.push(`git ${sub}`);
      // no system or global config: nothing but the repo's own helper could run
      return realExec(cmd, a, { ...opts, env: { ...(opts.env ?? process.env), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_SSL_CAINFO: server!.caFile, GIT_TERMINAL_PROMPT: "0" } });
    };

    const url = server.url("instance").replace("https://", `https://${USER}@`);
    const r = await connectRepo({ url, instanceDir: instance, auth: "token", readSecret: async () => TOKEN, out: () => {}, exec, env: {}, platform: "darwin", fetchFn: (async () => { throw new Error("no network"); }) as unknown as typeof fetch });

    expect(r.pushed).toBe(true);
    expect(order.indexOf("security -i")).toBeLessThan(order.indexOf("git ls-remote"));
    expect(order.indexOf("security -i")).toBeLessThan(order.indexOf("git push"));
    // the push landed, authenticated with the token askpass supplied
    expect(git(join(root, "remotes", "instance.git"), "rev-parse", "main")).toBe(git(instance, "rev-parse", "HEAD"));
    expect(server.seen).toContain("Basic " + Buffer.from(`${USER}:${TOKEN}`).toString("base64"));
    // the repo still names a helper for the owner's own git…
    expect(git(instance, "config", "credential.helper")).toBe(recorder);
    // …but this command never ran it: no get, no store, no erase
    expect(existsSync(helperLog)).toBe(false);
    // and the token is nowhere in .git/config
    expect(readFileSync(join(instance, ".git", "config"), "utf8")).not.toContain(TOKEN);
  }, 120_000);
});
