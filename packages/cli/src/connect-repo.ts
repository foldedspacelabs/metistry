// `metistry connect-repo <url>` — point the instance repo at a private
// remote and leave credentials the reconciler can use unattended
// (docs/product/desktop-app-plan.md step 3; the Mac app runs this verb
// behind its "Connect a GitHub repository" button, never a second
// implementation of it).
//
// What "unattended" forces:
//   * The token lands in the login Keychain as an internet password for
//     the host, in `git-credential-osxkeychain`'s shape, and git is
//     pointed at that helper AT THE REPO LEVEL. No token in `.env`, no
//     token in a URL, none on a command line, none in this process's
//     output — assert that last one in the tests, not in a comment.
//   * The device-authorization flow, so nothing has to paste a PAT into a
//     browser-less machine. The client id is a PUBLIC OAuth App id from
//     `METISTRY_GITHUB_OAUTH_CLIENT_ID`; a device-flow app has no secret,
//     which is why this can ship in open source at all.
//
// Every git call is an argument array through the exec seam (invariant:
// no shell, so no URL fragment is ever interpreted). The instance repo is
// the reconciler's working tree (D5), so the queue is flushed through the
// bridge before this command's own push.

import { realExec, type Exec, type ExecResult } from "./exec.js";
import { Keychain } from "./keychain.js";

/** Folded Space Labs' GitHub OAuth App (device flow enabled). Public by design. */
export const DEFAULT_GITHUB_OAUTH_CLIENT_ID = "Ov23lid9DItZlts5e5GV";

export type AuthMode = "device" | "token" | "ssh";
export const AUTH_MODES: AuthMode[] = ["device", "token", "ssh"];

/** GitHub's device-flow endpoints (docs.github.com → Authorizing OAuth apps → device flow). */
export const DEVICE_CODE_URL = "https://github.com/login/device/code";
export const DEVICE_TOKEN_URL = "https://github.com/login/oauth/access_token";
export const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
/** `repo` is the narrowest scope that can push to a PRIVATE repository. */
export const DEVICE_SCOPE = "repo";
/** GitHub's documented `slow_down` penalty: add five seconds to the polling interval. */
export const SLOW_DOWN_STEP_SEC = 5;

export type RemoteKind = "https" | "ssh" | "local";

export interface ParsedRemote {
  kind: RemoteKind;
  /** host for https/ssh; undefined for a local path */
  host?: string | undefined;
  /** userinfo from an https URL, or the ssh login — the account git will ask the credential helper for */
  user?: string | undefined;
}

/** Classify a remote without a URL parser that would accept things git will not (and without ever putting it in a shell). */
export function parseRemote(url: string): ParsedRemote {
  if (/^https?:\/\//i.test(url)) {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new Error(`${url} is not a URL`);
    }
    if (u.protocol === "http:") throw new Error("refusing an http:// remote — a credential would cross the network in clear text; use https://");
    if (u.password) throw new Error("refusing a remote URL with a password in it — the token belongs in the Keychain, not in .git/config");
    return { kind: "https", host: u.hostname, ...(u.username ? { user: u.username } : {}) };
  }
  if (/^ssh:\/\//i.test(url)) {
    const u = new URL(url);
    return { kind: "ssh", host: u.hostname, ...(u.username ? { user: u.username } : {}) };
  }
  const scp = /^([^/@]+)@([^/:]+):(.+)$/.exec(url);
  if (scp) return { kind: "ssh", host: scp[2]!, user: scp[1]! };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) throw new Error(`unsupported remote scheme in ${url} — connect-repo handles https://, ssh:// and local paths`);
  return { kind: "local" };
}

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export interface DeviceFlowOptions {
  clientId: string;
  fetchFn: typeof fetch;
  out: (line: string) => void;
  /** injected so the tests do not sleep; called with the poll interval in ms */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  scope?: string | undefined;
  now?: (() => number) | undefined;
}

async function postForm(fetchFn: typeof fetch, url: string, body: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetchFn(url, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new Error(`${url} answered ${res.status} with a body that is not JSON`);
  }
  if (!json || typeof json !== "object") throw new Error(`${url} answered ${res.status} with ${typeof json}, not an object`);
  return json as Record<string, unknown>;
}

/**
 * The device-authorization flow, start to token. Prints the user code and
 * the verification URL (both are meant to be read aloud); prints NOTHING
 * else — not the device code, not the access token.
 */
export async function deviceFlow(opts: DeviceFlowOptions): Promise<string> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const start = (await postForm(opts.fetchFn, DEVICE_CODE_URL, { client_id: opts.clientId, scope: opts.scope ?? DEVICE_SCOPE })) as unknown as DeviceCodeResponse & {
    error?: string;
    error_description?: string;
  };
  if (start.error) throw new Error(`GitHub refused the device request: ${start.error}${start.error_description ? ` — ${start.error_description}` : ""}`);
  if (typeof start.user_code !== "string" || typeof start.device_code !== "string" || typeof start.verification_uri !== "string") {
    throw new Error("GitHub's device response had no user_code/device_code/verification_uri");
  }
  opts.out("");
  opts.out(`   Open ${start.verification_uri} and enter this code:   ${start.user_code}`);
  opts.out(`   (valid for ${Math.round((Number(start.expires_in) || 900) / 60)} minutes; waiting…)`);
  opts.out("");

  let intervalSec = Number(start.interval) > 0 ? Number(start.interval) : 5;
  const deadline = (opts.now ?? Date.now)() + (Number(start.expires_in) || 900) * 1000;
  for (;;) {
    await sleep(intervalSec * 1000);
    const r = await postForm(opts.fetchFn, DEVICE_TOKEN_URL, { client_id: opts.clientId, device_code: start.device_code, grant_type: DEVICE_GRANT_TYPE });
    if (typeof r.access_token === "string" && r.access_token !== "") return r.access_token;
    const error = typeof r.error === "string" ? r.error : "";
    if (error === "authorization_pending") {
      // the person has not finished in the browser yet — keep the same interval
    } else if (error === "slow_down") {
      intervalSec = Number(r.interval) > 0 ? Number(r.interval) : intervalSec + SLOW_DOWN_STEP_SEC;
    } else if (error === "expired_token") {
      throw new Error("the device code expired before it was entered — run `metistry connect-repo` again");
    } else if (error === "access_denied") {
      throw new Error("authorization was cancelled in the browser");
    } else if (error === "device_flow_disabled") {
      throw new Error("the OAuth App in METISTRY_GITHUB_OAUTH_CLIENT_ID does not have device flow enabled (GitHub → the app's settings → Enable Device Flow)");
    } else if (error !== "") {
      throw new Error(`GitHub refused the device token request: ${error}`);
    } else {
      throw new Error("GitHub answered the device token request with neither an access_token nor an error");
    }
    if ((opts.now ?? Date.now)() > deadline) throw new Error("gave up waiting for the device code to be entered");
  }
}

/** The GitHub login the token belongs to — the account name the credential item is filed under. Never sends the token anywhere but GitHub. */
export async function tokenLogin(fetchFn: typeof fetch, host: string, token: string): Promise<string | undefined> {
  const api = host === "github.com" ? "https://api.github.com/user" : `https://${host}/api/v3/user`;
  try {
    const res = await fetchFn(api, { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "metistry-cli" } });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { login?: unknown };
    return typeof body.login === "string" && body.login !== "" ? body.login : undefined;
  } catch {
    return undefined;
  }
}

export interface ConnectRepoOptions {
  url: string;
  /** The instance repo (the reconciler's working tree). */
  instanceDir: string;
  auth?: AuthMode | undefined;
  force?: boolean | undefined;
  out: (line: string) => void;
  exec?: Exec | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  platform?: NodeJS.Platform | undefined;
  fetchFn?: typeof fetch | undefined;
  /** `--auth token` reads the PAT here — stdin, so it is never in argv or shell history. */
  readSecret?: (() => Promise<string>) | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

export interface ConnectRepoResult {
  remote: ParsedRemote;
  branch: string;
  /** the auth path actually taken; "none" for a local/ssh remote that needed no credential written */
  credential: "device" | "token" | "none";
  pushed: boolean;
  flushed: boolean;
}

/** Read a whole stream (the PAT for `--auth token`). Trimmed: a trailing newline from a paste is not part of the token. */
export async function readStdin(stream: NodeJS.ReadStream = process.stdin): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c as Buffer));
  return Buffer.concat(chunks).toString("utf8").trim();
}

export async function connectRepo(opts: ConnectRepoOptions): Promise<ConnectRepoResult> {
  const exec = opts.exec ?? realExec;
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const fetchFn = opts.fetchFn ?? fetch;
  const dir = opts.instanceDir;
  const out = opts.out;

  const git = async (args: string[], timeoutMs = 30_000): Promise<ExecResult> => exec("git", ["-c", "commit.gpgsign=false", ...args], { cwd: dir, timeoutMs });
  const gitOk = async (args: string[], timeoutMs?: number): Promise<string> => {
    const r = await git(args, timeoutMs);
    if (r.code !== 0) throw new Error(`git ${args[0]} failed (${r.code}): ${(r.stderr || r.stdout).trim().split("\n").slice(-2).join(" ")}`);
    return r.stdout.trim();
  };

  if ((await git(["rev-parse", "--git-dir"])).code !== 0) {
    throw new Error(`${dir} is not a git repository — run \`metistry init <dir>\` first, or pass --instance <dir> / set METISTRY_INSTANCE_DIR`);
  }
  const remote = parseRemote(opts.url);
  const auth: AuthMode = opts.auth ?? (remote.kind === "ssh" ? "ssh" : "device");
  if (remote.kind === "ssh" && auth !== "ssh") throw new Error(`${opts.url} is an ssh remote, so --auth ${auth} has nothing to store — use --auth ssh (the key is the credential)`);

  // 1. the remote itself — refuse to silently repoint an instance at a different repo
  const existing = (await gitOk(["remote"])).split("\n").map((s) => s.trim()).filter(Boolean);
  if (existing.includes("origin") && !opts.force) {
    const url = await gitOk(["remote", "get-url", "origin"]);
    throw new Error(`${dir} already has an origin (${url}) — pass --force to repoint it`);
  }
  await gitOk(["remote", existing.includes("origin") ? "set-url" : "add", "origin", opts.url]);
  out(`origin ${existing.includes("origin") ? "repointed to" : "set to"} ${opts.url}`);

  // 2. credentials, BEFORE the reachability check — a private repo answers nothing without them
  let credential: ConnectRepoResult["credential"] = "none";
  if (remote.kind === "https") {
    if (platform === "darwin") {
      await gitOk(["config", "credential.helper", "osxkeychain"]);
      out("credential.helper=osxkeychain set on this repo (git and the reconciler both read the login Keychain)");
    } else {
      out(`no Keychain on ${platform}: run \`git -C ${dir} config credential.helper 'store --file ~/.git-credentials'\` and put the token in that file (chmod 600) — the reconciler pushes with whatever git finds.`);
    }
    let token: string | undefined;
    if (auth === "device") {
      // The product ships Folded Space Labs' OAuth App as the default: a
      // device-flow client id is public (no secret exists), and it grants the
      // app nothing — each user approves the `repo` scope on their own
      // account. An instance may override it with its own app in .env.
      const clientId = env.METISTRY_GITHUB_OAUTH_CLIENT_ID || DEFAULT_GITHUB_OAUTH_CLIENT_ID;
      token = await deviceFlow({ clientId, fetchFn, out, ...(opts.sleep ? { sleep: opts.sleep } : {}) });
      credential = "device";
    } else if (auth === "token") {
      out("paste a personal access token with `repo` scope, then Ctrl-D (it is read from stdin and never echoed):");
      token = (await (opts.readSecret ?? readStdin)()).trim();
      if (!token) throw new Error("no token on stdin");
      credential = "token";
    }
    if (token) {
      if (platform !== "darwin") throw new Error(`--auth ${auth} stores the token in the macOS Keychain; on ${platform} use the git-credential-store remediation printed above`);
      const account = remote.user ?? (await tokenLogin(fetchFn, remote.host!, token)) ?? "x-access-token";
      await new Keychain(exec, env.METISTRY_KEYCHAIN_ACCOUNT || "metistry").setGitCredential(remote.host!, account, token);
      out(`token stored in the login Keychain for ${account}@${remote.host} (not printed, not written to .env, not in .git/config)`);
    }
  } else if (remote.kind === "ssh") {
    out("ssh remote: the credential is your key — `git ls-remote` below is the check that the agent or ~/.ssh key works.");
  }

  // 3. reachability, through the same execFile path
  const ls = await git(["ls-remote", "origin"], 60_000);
  if (ls.code !== 0) throw new Error(`git ls-remote origin failed (${ls.code}): ${(ls.stderr || ls.stdout).trim().split("\n").slice(-2).join(" ")}`);
  out(`git ls-remote origin: reachable (${ls.stdout.trim() === "" ? "empty repository" : `${ls.stdout.trim().split("\n").length} ref(s)`})`);

  // 4. the reconciler owns this working tree — let it land its queue before we push
  const flushed = await flushReconciler(env, fetchFn, out);

  // 5. one push, so the remote is proven end to end and the branch is tracking
  const branch = (await git(["symbolic-ref", "--short", "-q", "HEAD"])).stdout.trim() || "main";
  const push = await git(["push", "-u", "origin", branch], 180_000);
  if (push.code !== 0) throw new Error(`git push -u origin ${branch} failed (${push.code}): ${(push.stderr || push.stdout).trim().split("\n").slice(-2).join(" ")}`);
  out(`pushed ${branch} to origin; the reconciler pushes from here on its METISTRY_PUSH_SCHEDULE (docs/ops/reconciler.md)`);

  return { remote, branch, credential, pushed: true, flushed };
}

/** Best-effort: a reconciler that is not running is not an error — its queue is empty by definition. */
async function flushReconciler(env: NodeJS.ProcessEnv, fetchFn: typeof fetch, out: (l: string) => void): Promise<boolean> {
  const url = env.METISTRY_RECONCILER_URL;
  const token = env.METISTRY_BRIDGE_TOKEN_RECONCILER;
  if (!url || !token) return false;
  const base = url.replace(/\/+$/, "").replace("host.docker.internal", "127.0.0.1");
  try {
    const res = await fetchFn(`${base}/flush`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" });
    if (!res.ok) {
      out(`reconciler POST ${base}/flush answered ${res.status} — pushing what is committed now`);
      return false;
    }
    out(`reconciler flushed its commit queue (${base}/flush) before the push`);
    return true;
  } catch {
    out(`reconciler at ${base} did not answer — pushing what is committed now`);
    return false;
  }
}
