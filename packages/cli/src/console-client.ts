// `metistry console whoami` / `console call` — ask the console who it
// thinks you are, or make one authenticated request against it, with the
// local owner token (docs/ops/auth.md).
//
// `whoami` is the verb the Mac app calls to render "signed in as owner"
// without a passkey ceremony, and the one an operator runs to prove the door
// works before blaming the app. `call` is the scripting seam behind it — the
// same door, any method and path, for the app and the second-instance guide.
// Both are deliberately the whole client: one request, one header, no
// state. The token is never printed and never reaches argv — it goes into
// an Authorization header and nowhere else, and every error message is
// redacted against it before it leaves this file.

import { Keychain, keychainAccount } from "./keychain.js";
import { realExec, type Exec } from "./exec.js";
import { accountFor } from "./secrets.js";

/** Where the console is, from the host's vantage. The watchdog's variable, then the plugin's, then the default. */
export const CONSOLE_URL_VARS = ["METISTRY_CONSOLE_URL", "METISTRY_URL"] as const;
export const DEFAULT_CONSOLE_URL = "http://127.0.0.1:8080";

export interface ConsoleTargetOptions {
  env?: NodeJS.ProcessEnv | undefined;
  /** this instance's `instance_id`: the Keychain account METISTRY_LOCAL_OWNER_TOKEN is filed under */
  instanceId?: string | undefined;
  exec?: Exec | undefined;
  platform?: NodeJS.Platform | undefined;
}

export interface ConsoleTarget {
  url: string;
  token: string;
  /** where the token came from, for the "not set" message and `--json` — never the value */
  tokenFrom: "env" | "keychain";
}

function normalizeUrl(v: string): string {
  return v.trim().replace(/\/+$/, "");
}

/**
 * The console's URL and this install's owner token. The environment (which
 * is `<instance>/state/.env`, already loaded) comes first; the login
 * Keychain is the fallback, under the account the scope table files
 * METISTRY_LOCAL_OWNER_TOKEN under — the instance's, with the per-user account
 * behind it for an item that has not been migrated yet.
 */
export async function consoleTarget(opts: ConsoleTargetOptions = {}): Promise<ConsoleTarget> {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const url = normalizeUrl(CONSOLE_URL_VARS.map((v) => env[v]).find((v) => (v ?? "").trim() !== "") ?? DEFAULT_CONSOLE_URL);
  let token = (env.METISTRY_LOCAL_OWNER_TOKEN ?? "").trim();
  let tokenFrom: ConsoleTarget["tokenFrom"] = "env";
  if (!token && platform === "darwin") {
    const exec = opts.exec ?? realExec;
    const user = keychainAccount(env);
    const account = accountFor("METISTRY_LOCAL_OWNER_TOKEN", { user, ...(opts.instanceId ? { instance: opts.instanceId } : {}) });
    token = (await new Keychain(exec, account).getSecret("METISTRY_LOCAL_OWNER_TOKEN"))?.trim() ?? "";
    if (!token && account !== user) token = (await new Keychain(exec, user).getSecret("METISTRY_LOCAL_OWNER_TOKEN"))?.trim() ?? "";
    tokenFrom = "keychain";
  }
  if (!token) {
    throw new Error(
      "METISTRY_LOCAL_OWNER_TOKEN is not set (env, <instance>/state/.env, or the login Keychain) — `metistry secrets sync --to env` mints one for an install that predates it, then restart the console",
    );
  }
  return { url, token, tokenFrom };
}

/** Redact before printing: the token must not reach stdout, a log, or an error message. */
function redact(text: unknown, token: string): string {
  const s = text instanceof Error ? (text.message ?? String(text)) : String(text);
  return token ? s.split(token).join("[redacted]") : s;
}

export interface Whoami {
  url: string;
  /** `user` (a passkey session or the local owner token) or `owner_token` (a capture token) */
  principal: string;
  /** how it was proved: `local_owner_token` | `passkey_session` | `owner_token` */
  via: string;
  /** may this credential reach the management surface (devices, agents, projects)? */
  management: boolean;
  /** the console's canonical origin, so a mismatch with the browser's is visible here */
  origin?: string;
  as_of?: string;
}

export interface WhoamiOptions extends ConsoleTargetOptions {
  fetchFn?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
}

/**
 * GET /api/whoami with the owner token. A 401 here is the interesting case
 * and gets the whole diagnosis: either the token in this environment is not
 * the one the console was started with, or the request did not arrive from
 * this machine (which, under compose, is a NAT question — see
 * METISTRY_TRUSTED_LOOPBACK_PROXY).
 */
export async function whoami(opts: WhoamiOptions = {}): Promise<Whoami> {
  const target = await consoleTarget(opts);
  const fetchFn = opts.fetchFn ?? fetch;
  let res: Response;
  try {
    res = await fetchFn(`${target.url}/api/whoami`, {
      headers: { authorization: `Bearer ${target.token}` },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
  } catch (err) {
    throw new Error(`console unreachable at ${target.url}: ${redact((err as { cause?: { message?: string } })?.cause?.message ?? err, target.token)}`);
  }
  if (res.status === 401) {
    throw new Error(
      `${target.url} refused the owner token (401). Either METISTRY_LOCAL_OWNER_TOKEN here is not the one the console was started with (restart it after a \`metistry secrets sync --to env\`), or the request did not reach it from this machine — under compose the console needs METISTRY_TRUSTED_LOOPBACK_PROXY (docs/ops/auth.md).`,
    );
  }
  if (!res.ok) throw new Error(`${target.url}/api/whoami returned HTTP ${res.status}`);
  const body = (await res.json()) as Partial<Whoami>;
  return {
    url: target.url,
    principal: String(body.principal ?? "unknown"),
    via: String(body.via ?? "unknown"),
    management: body.management === true,
    ...(body.origin ? { origin: body.origin } : {}),
    ...(body.as_of ? { as_of: body.as_of } : {}),
  };
}

export function renderWhoami(w: Whoami): string {
  return [
    `console    ${w.url}`,
    `principal  ${w.principal}`,
    `via        ${w.via}`,
    `management ${w.management ? "yes" : "no"}`,
    ...(w.origin ? [`origin     ${w.origin}`] : []),
  ].join("\n");
}

/**
 * True for the hostnames the local owner token is actually good for. It is
 * minted for THIS machine's loopback (docs/ops/auth.md) — a console reached
 * any other way is not the door this token opens, and `console call` refuses
 * before it ever puts the token in a header aimed at one.
 */
export function isLoopbackConsoleUrl(url: string): boolean {
  try {
    // Node's URL keeps an IPv6 host bracketed (`[::1]`); strip the brackets
    // before comparing rather than special-casing the bracketed spelling.
    const h = new URL(url).hostname.replace(/^\[|\]$/g, "");
    return h === "127.0.0.1" || h === "::1" || h === "localhost";
  } catch {
    return false;
  }
}

export interface ConsoleCallOptions extends ConsoleTargetOptions {
  method: string;
  /** must start with `/` — this is a path on the console, not a whole URL */
  path: string;
  /** raw bytes, sent as-is (this verb does not parse or reshape a request body) */
  body?: string | undefined;
  fetchFn?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
}

export interface ConsoleCallResult {
  status: number;
  /** the response, parsed — the raw text when it does not parse as JSON, so a non-JSON answer is not swallowed */
  body: unknown;
  /** exactly what the console sent back, byte for byte — what `--json` prints */
  raw: string;
}

/**
 * One authenticated request against the instance's console, as the `user`
 * principal — the same owner token `console whoami` presents, over the same
 * loopback door. It is the scripting seam: no shape of its own, no retries,
 * no interpretation of the response beyond "does it parse as JSON" — the
 * caller (a script, the app, a person at a terminal) decides what the answer
 * means.
 */
export async function consoleCall(opts: ConsoleCallOptions): Promise<ConsoleCallResult> {
  const target = await consoleTarget(opts);
  if (!isLoopbackConsoleUrl(target.url)) {
    throw new Error(
      `${target.url} is not loopback — the local owner token this verb presents is minted for THIS machine only (docs/ops/auth.md) and \`console call\` refuses to send it anywhere else. Point METISTRY_CONSOLE_URL/METISTRY_URL at a loopback address, or use a passkey session for a remote console.`,
    );
  }
  const fetchFn = opts.fetchFn ?? fetch;
  let res: Response;
  try {
    res = await fetchFn(`${target.url}${opts.path}`, {
      method: opts.method,
      headers: { authorization: `Bearer ${target.token}`, ...(opts.body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(opts.body !== undefined ? { body: opts.body } : {}),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    });
  } catch (err) {
    throw new Error(`console unreachable at ${target.url}: ${redact((err as { cause?: { message?: string } })?.cause?.message ?? err, target.token)}`);
  }
  const raw = await res.text();
  let body: unknown = raw;
  if (raw !== "") {
    try {
      body = JSON.parse(raw);
    } catch {
      /* not JSON: raw text stands */
    }
  } else {
    body = null;
  }
  return { status: res.status, body, raw };
}

/** The error envelope's `code`/`message` (and `field`, when the response carries one), for a non-2xx `console call`. */
export function renderConsoleCallError(r: ConsoleCallResult): string {
  const envelope = r.body && typeof r.body === "object" ? (r.body as Record<string, unknown>).error : undefined;
  const e = envelope && typeof envelope === "object" ? (envelope as { code?: unknown; message?: unknown; field?: unknown }) : undefined;
  const field = e?.field ?? (r.body && typeof r.body === "object" ? (r.body as Record<string, unknown>).field : undefined);
  return [`HTTP ${r.status}`, e?.code ? String(e.code) : undefined, e?.message ? String(e.message) : undefined, field ? `(field: ${String(field)})` : undefined]
    .filter((s): s is string => s !== undefined)
    .join(" — ");
}
