// `metistry console whoami` — ask the console who it thinks you are, with
// the local owner token (docs/ops/auth.md).
//
// This is the verb the Mac app calls to render "signed in as owner" without
// a passkey ceremony, and the one an operator runs to prove the door works
// before blaming the app. It is deliberately the whole client: one GET, one
// header, no state. The token is never printed and never reaches argv — it
// goes into an Authorization header and nowhere else, and every error
// message is redacted against it before it leaves this file.

import { Keychain, keychainAccount } from "./keychain.js";
import { realExec, type Exec } from "./exec.js";
import { accountFor } from "./secrets.js";

/** Where the console is, from the host's vantage. The watchdog's variable, then the plugin's, then the default. */
export const CONSOLE_URL_VARS = ["METISTRY_CONSOLE_URL", "METISTRY_URL"] as const;
export const DEFAULT_CONSOLE_URL = "http://127.0.0.1:8080";

export interface ConsoleTargetOptions {
  env?: NodeJS.ProcessEnv | undefined;
  /** this instance's `instance_id`: the Keychain account METISTRY_OWNER_TOKEN is filed under */
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
 * METISTRY_OWNER_TOKEN under — the instance's, with the per-user account
 * behind it for an item that has not been migrated yet.
 */
export async function consoleTarget(opts: ConsoleTargetOptions = {}): Promise<ConsoleTarget> {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const url = normalizeUrl(CONSOLE_URL_VARS.map((v) => env[v]).find((v) => (v ?? "").trim() !== "") ?? DEFAULT_CONSOLE_URL);
  let token = (env.METISTRY_OWNER_TOKEN ?? "").trim();
  let tokenFrom: ConsoleTarget["tokenFrom"] = "env";
  if (!token && platform === "darwin") {
    const exec = opts.exec ?? realExec;
    const user = keychainAccount(env);
    const account = accountFor("METISTRY_OWNER_TOKEN", { user, ...(opts.instanceId ? { instance: opts.instanceId } : {}) });
    token = (await new Keychain(exec, account).getSecret("METISTRY_OWNER_TOKEN"))?.trim() ?? "";
    if (!token && account !== user) token = (await new Keychain(exec, user).getSecret("METISTRY_OWNER_TOKEN"))?.trim() ?? "";
    tokenFrom = "keychain";
  }
  if (!token) {
    throw new Error(
      "METISTRY_OWNER_TOKEN is not set (env, <instance>/state/.env, or the login Keychain) — `metistry secrets sync --to env` mints one for an install that predates it, then restart the console",
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
      `${target.url} refused the owner token (401). Either METISTRY_OWNER_TOKEN here is not the one the console was started with (restart it after a \`metistry secrets sync --to env\`), or the request did not reach it from this machine — under compose the console needs METISTRY_TRUSTED_LOOPBACK_PROXY (docs/ops/auth.md).`,
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
