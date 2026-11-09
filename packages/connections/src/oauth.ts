// OAuth for a connection (plan §2.6, C118; T4-10): a PUBLIC client — PKCE and
// a loopback redirect — whose client id ships in the connection type's
// manifest, or is the owner's own (a secret, per instance), or, for a custom
// connection, is always the owner's own beside the client model the
// connection itself carries.
//
// Three pieces, each closed by construction rather than by advice:
//
//   **The flow** (`authorizeConnection`) is the owner's hand: `metistry
//   connections authorize <name>`, run from a terminal or by the Mac app
//   (M13). It opens ONE listener on 127.0.0.1 — a rule, not a default: there
//   is no host parameter — on a port the system picks, for exactly one
//   callback: the first request to the callback path is the answer, whatever
//   it says, and the listener closes behind it (or at the timeout). The
//   `state` it sent is compared in constant time before the code is looked
//   at; a different one is refused and nothing is exchanged. The PKCE
//   verifier never leaves this process until the exchange, which sends it to
//   the token endpoint with the code — the authorization server checks it
//   against the challenge the browser carried (RFC 7636 §4.6). Nothing in the
//   console, the bridge or the engine imports the flow: the assistant cannot
//   start one (a test holds every one of them to it).
//
//   **The exchange and every refresh** go through core's `guardedFetch` with
//   the connection as the grantee, pinned to the token endpoint's origin, no
//   redirect followed: a bring-your-own client id or secret is a
//   `{{ secret.x }}` filled only for a host on its *Sent only to* list, and
//   what comes back is redacted.
//
//   **What is kept**: the refresh token, as the connection's `token` secret
//   (§2.6: "the refresh token is a credential — stored in the Keychain as a
//   secret of the connection; never shown"). An access token is never
//   stored: the process that dials mints one from the refresh token when it
//   needs one, holds it in memory until a minute before it expires, and
//   fills it at the egress door as that same secret — so its *Sent only to*
//   list and its grant decide where the access token may go, exactly as they
//   decide for any other secret. A provider that returns no refresh token is
//   refused rather than kept: a connection that stops working within the
//   hour is not a connection.
//
// `redirect: broker` is modelled (core's `OAUTH_REDIRECTS`) and refused here:
// the token broker is designed, not built (§2.6, §5).

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  CUSTOM_PROVIDER,
  EgressRefused,
  SecretRedactor,
  guardedFetch,
  secretGrant,
  type OAuthRedirect,
  type SecretSource,
  type SecretsFile,
} from "@foldedspacelabs/metistry-core";
import { ConnectionRefused } from "./errors.js";
import type { ConnectionEntry } from "./load.js";

/** The listener binds here and nowhere else. Not a parameter: a flow that listened on every interface would hand its code to the network. */
export const OAUTH_LOOPBACK_HOST = "127.0.0.1";
/** The one path the listener answers. Anything else is 404 and does not count as the callback. */
export const OAUTH_CALLBACK_PATH = "/callback";
/** How long the owner has to finish signing in before the listener closes. The CLI passes its own (`--timeout`). */
export const DEFAULT_OAUTH_FLOW_TIMEOUT_MS = 5 * 60_000; // limit: fixed — the default a sign-in waits for the owner; `connections authorize --timeout` overrides it per run
/** A cached access token is refreshed this long before the provider says it expires. */
const EXPIRY_SKEW_MS = 60_000; // limit: fixed — clock skew between this Mac and the provider, not a policy
/** A token response larger than this is not a token response. */
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024; // limit: fixed — guards a parser against an endless body

/** Why a flow, an exchange or a refresh stopped. A closed set: each a code path with a test (U3). */
export const OAUTH_ERROR_CODES = [
  /** the connection does not sign in with OAuth */
  "not_oauth",
  /** no client id: the type ships none and the owner brought none */
  "no_client",
  /** `redirect: broker` — modelled, not built */
  "broker_not_built",
  /** the callback's `state` is not the one this flow sent — nothing is exchanged */
  "state_mismatch",
  /** the provider answered with `error=` (the owner declined, or the client is misconfigured) */
  "denied",
  /** the callback carried no code */
  "no_code",
  /** nobody came back before the timeout */
  "timeout",
  /** the token endpoint refused the code or the refresh token */
  "exchange_failed",
  /** the token endpoint's answer is not a token response */
  "bad_response",
  /** the provider issued no refresh token, so nothing durable can be kept */
  "no_refresh_token",
] as const;
export type OAuthErrorCode = (typeof OAUTH_ERROR_CODES)[number];

/** A refusal. The message names connections, secrets, hosts and the provider's error CODE — never a token, a code or a verifier. */
export class OAuthError extends Error {
  override readonly name = "OAuthError";
  constructor(
    readonly code: OAuthErrorCode,
    message: string,
  ) {
    super(`oauth (${code}): ${message}`);
  }
}

/** A client id: the one a connection type ships (public, in the manifest), or a secret the owner brought. */
export type OAuthClientId = { kind: "shipped"; value: string } | { kind: "secret"; name: string };

/** Everything a flow or a refresh needs to know about one connection's client. Names and public values only — never a secret's value. */
export interface OAuthClientPlan {
  connection: string;
  /** where the client model came from: the connection type's `oauth` field, or the custom connection itself (C118) */
  from: "manifest" | "custom";
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  redirect: OAuthRedirect;
  pkce: boolean;
  clientId: OAuthClientId;
  /** a bring-your-own client secret's NAME, where the provider needs one */
  clientSecret: string | undefined;
  /** the secret the refresh token is kept in */
  tokenSecret: string;
  /**
   * What the connection type says about signing in with its SHIPPED client —
   * the oauth field's `help` (Google Calendar: *Google hasn't verified this
   * app* while that is true). Said before the browser opens; undefined for
   * the owner's own client and for a custom connection.
   */
  notice?: string | undefined;
}

const SOLE_SECRET = /^\{\{\s*secret\.([a-z][a-z0-9_]*)\s*\}\}$/;
function secretNameOf(v: string | undefined): string | undefined {
  return v === undefined ? undefined : SOLE_SECRET.exec(v)?.[1];
}

/**
 * The OAuth client a connection signs in with, or the refusal that says why
 * it cannot. A typed connection: its type's `oauth` field (the one `auth.field`
 * names, or the only one) and the field's value on the connection — the
 * bring-your-own client id overrides the shipped one. A custom connection:
 * the client model on its auth shortcut, and always the owner's client id.
 */
export function oauthClientOf(entry: ConnectionEntry): OAuthClientPlan {
  const c = entry.connection;
  if (!c || entry.status !== "ok") throw new ConnectionRefused("not_ready", entry.name, entry.issues.join("; ") || "the connection is not ready");
  const auth = c.reach.http?.auth;
  if (auth?.scheme !== "oauth") throw new OAuthError("not_oauth", `${c.name} does not sign in with OAuth (its auth is ${auth?.scheme ?? "not over http"})`);

  let plan: Omit<OAuthClientPlan, "redirect" | "pkce"> & { redirect: OAuthRedirect; pkce: boolean };
  if (c.provider === CUSTOM_PROVIDER) {
    const client = auth.client;
    const token = secretNameOf(auth.token);
    const clientId = secretNameOf(auth.client_id);
    // the schema refuses a custom OAuth connection without these; said again rather than trusted
    if (!client || !token || !clientId) throw new OAuthError("no_client", `${c.name} is a custom OAuth connection without its client, token or client id (C118)`);
    plan = {
      connection: c.name,
      from: "custom",
      authorizeUrl: client.authorize_url,
      tokenUrl: client.token_url,
      scopes: [...client.scopes],
      redirect: client.redirect,
      pkce: client.pkce,
      clientId: { kind: "secret", name: clientId },
      clientSecret: secretNameOf(auth.client_secret),
      tokenSecret: token,
    };
  } else {
    const fields = (entry.provider?.manifest.fields ?? []).filter((f) => f.kind === "oauth");
    const field = auth.field !== undefined ? fields.find((f) => f.key === auth.field) : fields.length === 1 ? fields[0] : undefined;
    if (!field || field.kind !== "oauth") throw new OAuthError("not_oauth", `${c.name}: its connection type has no oauth field to sign in with`);
    const value = c.config[field.key];
    const refs = typeof value === "object" ? value : undefined;
    const token = secretNameOf(refs?.token);
    if (!token) throw new OAuthError("no_client", `${c.name}: config.${field.key}.token names no secret to keep the sign-in in`);
    const own = secretNameOf(refs?.client_id);
    const shipped = field.oauth.client_id;
    if (!own && !shipped) {
      throw new OAuthError(
        "no_client",
        `${c.name}: ${entry.provider!.name} ships no client id, so this connection signs in with your own — \`metistry secrets set <name>\` holds it, and \`metistry connections set ${c.name} --client-id-secret <name>\` names it`,
      );
    }
    plan = {
      connection: c.name,
      from: "manifest",
      authorizeUrl: field.oauth.authorize_url,
      tokenUrl: field.oauth.token_url,
      scopes: [...field.oauth.scopes],
      redirect: field.oauth.redirect,
      pkce: field.oauth.pkce,
      clientId: own ? { kind: "secret", name: own } : { kind: "shipped", value: shipped! },
      clientSecret: secretNameOf(refs?.client_secret),
      tokenSecret: token,
      ...(!own && field.help !== undefined ? { notice: field.help } : {}),
    };
  }
  if (plan.redirect === "broker") {
    throw new OAuthError("broker_not_built", `${c.name} signs in through the token broker (redirect: broker), which is designed and not built yet (plan §2.6, §5) — bring your own client with a loopback redirect instead`);
  }
  // the schemas refuse a loopback client without PKCE; a public client without it is an interceptable code
  if (!plan.pkce) throw new OAuthError("no_client", `${c.name}: a loopback sign-in without PKCE is refused`);
  return plan;
}

/** The secret NAMES a connection's OAuth sign-in reads: the refresh token and any client of the owner's own. */
export function oauthSecretNames(plan: OAuthClientPlan): string[] {
  return [plan.tokenSecret, ...(plan.clientId.kind === "secret" ? [plan.clientId.name] : []), ...(plan.clientSecret ? [plan.clientSecret] : [])].sort();
}

// ---- PKCE (RFC 7636) and state ------------------------------------------------------

function base64url(b: Buffer): string {
  return b.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** A verifier of 32 random bytes (43 characters, §4.1) and its S256 challenge (§4.2). */
export function pkcePair(random: (n: number) => Buffer = randomBytes): { verifier: string; challenge: string; method: "S256" } {
  const verifier = base64url(random(32));
  return { verifier, challenge: pkceChallenge(verifier), method: "S256" };
}

/** `BASE64URL(SHA256(verifier))` — what an authorization server compares the verifier against. */
export function pkceChallenge(verifier: string): string {
  return base64url(createHash("sha256").update(verifier, "ascii").digest());
}

/** 32 random bytes: the value the callback must carry back. */
export function newState(random: (n: number) => Buffer = randomBytes): string {
  return base64url(random(32));
}

/** Constant-time: a `state` that differs is refused without saying where. */
export function sameState(expected: string, got: string | null | undefined): boolean {
  if (typeof got !== "string") return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(got, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The address the owner's browser opens: the provider's authorize endpoint with the client, the loopback, the scopes, the state and the challenge. */
export function authorizationUrl(plan: OAuthClientPlan, p: { clientId: string; redirectUri: string; state: string; challenge: string }): string {
  const u = new URL(plan.authorizeUrl);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", p.clientId);
  u.searchParams.set("redirect_uri", p.redirectUri);
  u.searchParams.set("scope", plan.scopes.join(" "));
  u.searchParams.set("state", p.state);
  u.searchParams.set("code_challenge", p.challenge);
  u.searchParams.set("code_challenge_method", "S256");
  return u.href;
}

// ---- the loopback listener -------------------------------------------------------

/** One open listener, waiting for its one callback. */
export interface Loopback {
  /** `http://127.0.0.1:<port>/callback` — what the authorize request names as its redirect */
  redirectUri: string;
  /** what the listener bound, as the socket reports it */
  address: string;
  port: number;
  /** the code, once the one callback arrived with this flow's state — or the refusal. The listener is closed either way */
  callback: Promise<{ code: string }>;
  /** close now (idempotent) */
  close(): Promise<void>;
  /** true once the listener has stopped accepting */
  readonly closed: boolean;
}

const PAGE = (title: string, line: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body style="font:16px -apple-system,system-ui,sans-serif;margin:3em"><h1 style="font-size:20px">${title}</h1><p>${line}</p></body></html>`;

/** An error code a provider sent back, kept only if it is one — `access_denied`, never free text. */
function providerCode(v: string | null): string {
  return v !== null && /^[a-z0-9_.-]{1,64}$/i.test(v) ? v : "error";
}

/**
 * Listen on 127.0.0.1, on a port the system picks, for exactly one callback.
 * The first GET to `/callback` IS the callback: the listener stops accepting
 * before it answers, whatever the answer. Its `state` is checked first
 * (constant time); then the provider's `error`; then the code. A request to
 * any other path is 404 and changes nothing (a browser's favicon, a probe).
 */
export async function openLoopback(opts: { state: string; timeoutMs?: number | undefined }): Promise<Loopback> {
  let settle!: { resolve: (v: { code: string }) => void; reject: (e: Error) => void };
  const callback = new Promise<{ code: string }>((resolve, reject) => (settle = { resolve, reject }));
  callback.catch(() => undefined); // a caller that closes early does not see an unhandled rejection
  let done = false;
  let closed = false;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${OAUTH_LOOPBACK_HOST}`);
    if (url.pathname !== OAUTH_CALLBACK_PATH || req.method !== "GET" || done) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }).end("not here\n");
      return;
    }
    done = true;
    // one callback: stop accepting before answering, so a second one finds nothing listening
    void close();
    const answer = (status: number, title: string, line: string) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", connection: "close" }).end(PAGE(title, line));
    };
    if (!sameState(opts.state, url.searchParams.get("state"))) {
      answer(400, "Sign-in refused", "This answer is not the one Metistry asked for, so nothing was kept. Start again from Metistry.");
      settle.reject(new OAuthError("state_mismatch", "the callback's state is not the one this sign-in sent — nothing was exchanged"));
      return;
    }
    const error = url.searchParams.get("error");
    if (error !== null) {
      answer(400, "Sign-in did not finish", "The provider said no. Nothing was kept; you can close this tab.");
      settle.reject(new OAuthError("denied", `the provider answered ${providerCode(error)} — nothing was kept`));
      return;
    }
    const code = url.searchParams.get("code");
    if (!code) {
      answer(400, "Sign-in did not finish", "The provider sent no code. Nothing was kept; you can close this tab.");
      settle.reject(new OAuthError("no_code", "the callback carried no authorization code"));
      return;
    }
    answer(200, "Signed in", "Metistry has what it needs. You can close this tab.");
    settle.resolve({ code });
  });
  const timer = setTimeout(() => {
    if (done) return;
    done = true;
    settle.reject(new OAuthError("timeout", "nobody came back from the provider in time — the listener is closed; run the sign-in again"));
    void close();
  }, opts.timeoutMs ?? DEFAULT_OAUTH_FLOW_TIMEOUT_MS);
  timer.unref();

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    if (!done) {
      done = true;
      settle.reject(new OAuthError("timeout", "the sign-in was closed before the provider answered"));
    }
    await new Promise<void>((r) => {
      server.close(() => r());
      // the answer is written with Connection: close; anything idle goes now
      server.closeIdleConnections();
    });
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, OAUTH_LOOPBACK_HOST, () => resolve());
  });
  const addr = server.address() as AddressInfo;
  return {
    redirectUri: `http://${OAUTH_LOOPBACK_HOST}:${addr.port}${OAUTH_CALLBACK_PATH}`,
    address: addr.address,
    port: addr.port,
    callback,
    close,
    get closed() {
      return closed;
    },
  };
}

// ---- the token endpoint, through the door ---------------------------------------------

/** What the token endpoint answered, parsed. Held in memory only; the refresh token is the one thing stored. */
export interface TokenGrant {
  accessToken: string;
  refreshToken: string | undefined;
  /** epoch ms; undefined when the provider said nothing */
  expiresAt: number | undefined;
}

/** The door a token request goes through: the connection's grants, its store, the shared redactor. */
export interface TokenDoor {
  secrets: SecretsFile;
  source: SecretSource;
  redactor: SecretRedactor;
  /** the base fetch under the egress guard (a test's fixture server; default global fetch) */
  fetch?: typeof fetch | undefined;
  now?: (() => number) | undefined;
  /** told the secret NAMES a request carried */
  onUse?: ((names: string[]) => void) | undefined;
}

/**
 * A source that form-encodes what it fills (`application/x-www-form-urlencoded`)
 * — a client secret with a `+` or `&` in it arrives as itself — and teaches
 * the redactor the raw value too.
 */
function formSource(source: SecretSource, redactor: SecretRedactor): SecretSource {
  return {
    async value(name) {
      const v = await source.value(name);
      if (v === undefined) return undefined;
      redactor.learn(name, v);
      return encodeURIComponent(v);
    },
  };
}

function formPart(key: string, value: string | { secret: string }): string {
  return `${key}=${typeof value === "string" ? encodeURIComponent(value) : `{{ secret.${value.secret} }}`}`;
}

function clientIdPart(plan: OAuthClientPlan): string | { secret: string } {
  return plan.clientId.kind === "shipped" ? plan.clientId.value : { secret: plan.clientId.name };
}

/** POST a form to the token endpoint: guarded, pinned to its origin, no redirect; the answer parsed or refused. */
async function tokenRequest(plan: OAuthClientPlan, parts: Array<[string, string | { secret: string }]>, door: TokenDoor, what: "exchange" | "refresh"): Promise<TokenGrant> {
  const origin = new URL(plan.tokenUrl).origin;
  const guarded = guardedFetch(
    {
      secrets: door.secrets,
      grantee: `connection:${plan.connection}`,
      purpose: "service",
      redactor: door.redactor,
      source: formSource(door.source, door.redactor),
      onUse: ({ names }) => door.onUse?.(names),
    },
    door.fetch ?? fetch,
  );
  const body = parts.map(([k, v]) => formPart(k, v)).join("&");
  let res: Response;
  try {
    res = await guarded(plan.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body,
      redirect: "manual",
    });
  } catch (err) {
    if (err instanceof EgressRefused) throw err;
    throw new OAuthError("exchange_failed", `the token endpoint (${origin}) could not be reached: ${door.redactor.redactText(err instanceof Error ? err.message : String(err))}`);
  }
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel().catch(() => undefined);
    throw new ConnectionRefused("other_host", plan.connection, `the token endpoint answered with a redirect (HTTP ${res.status}) — a redirect is not followed`);
  }
  const text = await res.text();
  if (text.length > MAX_TOKEN_RESPONSE_BYTES) throw new OAuthError("bad_response", `the token endpoint's answer is ${text.length} bytes — not a token response`);
  let json: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    json = parsed as Record<string, unknown>;
  } catch {
    throw new OAuthError(res.ok ? "bad_response" : "exchange_failed", `the token endpoint answered HTTP ${res.status} with something that is not JSON`);
  }
  if (!res.ok || typeof json.error === "string") {
    const code = typeof json.error === "string" ? providerCode(json.error) : `HTTP ${res.status}`;
    throw new OAuthError("exchange_failed", `the token endpoint refused the ${what === "exchange" ? "code" : "refresh token"} (${code})${code === "invalid_grant" && what === "refresh" ? ` — sign in again: \`metistry connections authorize ${plan.connection}\`` : ""}`);
  }
  const access = json.access_token;
  if (typeof access !== "string" || access === "") throw new OAuthError("bad_response", "the token endpoint's answer has no access_token");
  const type = json.token_type;
  if (type !== undefined && (typeof type !== "string" || type.toLowerCase() !== "bearer")) throw new OAuthError("bad_response", `the token endpoint issued a ${String(type)} token — only bearer tokens are sent`);
  const refresh = typeof json.refresh_token === "string" && json.refresh_token !== "" ? json.refresh_token : undefined;
  const expires = typeof json.expires_in === "number" && Number.isFinite(json.expires_in) && json.expires_in > 0 ? json.expires_in : typeof json.expires_in === "string" && /^\d+$/.test(json.expires_in) ? Number(json.expires_in) : undefined;
  // the values are credentials the moment they arrive: every later answer redacts them
  door.redactor.learn(plan.tokenSecret, access);
  if (refresh) door.redactor.learn(plan.tokenSecret, refresh);
  return { accessToken: access, refreshToken: refresh, expiresAt: expires === undefined ? undefined : (door.now ?? Date.now)() + expires * 1000 };
}

/** RFC 6749 §4.1.3 with RFC 7636 §4.5: the code, the loopback it was sent to, the verifier, and the client. */
export function exchangeCode(plan: OAuthClientPlan, p: { code: string; redirectUri: string; verifier: string }, door: TokenDoor): Promise<TokenGrant> {
  return tokenRequest(
    plan,
    [
      ["grant_type", "authorization_code"],
      ["code", p.code],
      ["redirect_uri", p.redirectUri],
      ["code_verifier", p.verifier],
      ["client_id", clientIdPart(plan)],
      ...(plan.clientSecret ? ([["client_secret", { secret: plan.clientSecret }]] as Array<[string, { secret: string }]>) : []),
    ],
    door,
    "exchange",
  );
}

/** RFC 6749 §6: a fresh access token from the stored refresh token — filled at the door, never read here. */
export function refreshAccess(plan: OAuthClientPlan, door: TokenDoor): Promise<TokenGrant> {
  return tokenRequest(
    plan,
    [
      ["grant_type", "refresh_token"],
      ["refresh_token", { secret: plan.tokenSecret }],
      ["client_id", clientIdPart(plan)],
      ...(plan.clientSecret ? ([["client_secret", { secret: plan.clientSecret }]] as Array<[string, { secret: string }]>) : []),
    ],
    door,
    "refresh",
  );
}

/**
 * One connection's access token, in one process: minted from the refresh
 * token on first use, reused until a minute before it expires, minted again
 * after. A provider that rotates the refresh token hands back a new one; it
 * is held here, in memory, for the life of the process — the process that
 * dials does not write the Keychain — and the stored one is used again after
 * a restart (a provider that revokes a rotated-out token then answers
 * `invalid_grant`, and the owner signs in again).
 */
export class OAuthTokens {
  readonly #plan: OAuthClientPlan;
  readonly #door: () => TokenDoor;
  #current: TokenGrant | undefined;
  #rotated: string | undefined;
  #inflight: Promise<TokenGrant> | undefined;

  constructor(plan: OAuthClientPlan, door: () => TokenDoor) {
    this.#plan = plan;
    this.#door = door;
  }

  get plan(): OAuthClientPlan {
    return this.#plan;
  }

  /** The access token to send now. */
  async access(): Promise<string> {
    const now = (this.#door().now ?? Date.now)();
    const cur = this.#current;
    if (cur && (cur.expiresAt === undefined || cur.expiresAt - EXPIRY_SKEW_MS > now)) return cur.accessToken;
    this.#inflight ??= this.#refresh().finally(() => (this.#inflight = undefined));
    return (await this.#inflight).accessToken;
  }

  async #refresh(): Promise<TokenGrant> {
    const door = this.#door();
    const rotated = this.#rotated;
    const source: SecretSource = rotated
      ? { value: async (n) => (n === this.#plan.tokenSecret ? rotated : door.source.value(n)) }
      : door.source;
    const grant = await refreshAccess(this.#plan, { ...door, source });
    if (grant.refreshToken) this.#rotated = grant.refreshToken;
    this.#current = grant;
    return grant;
  }
}

/**
 * The source an OAuth connection's requests are filled from: its `token`
 * secret is the ACCESS token (minted by `tokens`), everything else reads
 * through. So the header is `Bearer {{ secret.<token> }}`, and the door
 * holds the access token to that secret's *Sent only to* list and grant.
 */
export function oauthSource(base: SecretSource, tokens: OAuthTokens): SecretSource {
  return {
    async value(name) {
      if (name !== tokens.plan.tokenSecret) return base.value(name);
      return tokens.access();
    },
  };
}

// ---- the flow ------------------------------------------------------------------------

/** Where the flow keeps what it was issued: the connection's `token` secret, in this instance's store. */
export interface TokenStore {
  set(name: string, value: string): Promise<void>;
}

export interface AuthorizeOptions extends TokenDoor {
  /** keeps the refresh token — the CLI's instance Keychain */
  store: TokenStore;
  /** shows the owner the address to open — the CLI prints it, and opens the browser unless told not to */
  open: (url: string) => void | Promise<void>;
  timeoutMs?: number | undefined;
  /** told once the listener is up, before the browser opens (a test drives the callback from here) */
  onListening?: ((l: { redirectUri: string; address: string; port: number; authorizationUrl: string; notice: string | undefined }) => void | Promise<void>) | undefined;
  random?: ((n: number) => Buffer) | undefined;
}

export interface AuthorizeResult {
  connection: string;
  /** what the connection type says about its shipped client, said before the browser opened (`OAuthClientPlan.notice`) */
  notice?: string | undefined;
  /** the secret the refresh token was stored in — its name, never its value */
  stored: string;
  from: OAuthClientPlan["from"];
  client: "shipped" | "yours";
  scopes: string[];
}

/**
 * **The one OAuth flow.** The owner's hand only (`metistry connections
 * authorize`): listen on the loopback, send the owner's browser to the
 * provider, take exactly one callback, check its state, exchange the code
 * with the verifier through the egress door, keep the refresh token. The
 * listener is closed on every path out.
 */
export async function authorizeConnection(entry: ConnectionEntry, opts: AuthorizeOptions): Promise<AuthorizeResult> {
  const plan = oauthClientOf(entry);
  const clientId = plan.clientId.kind === "shipped" ? plan.clientId.value : await ownClientId(plan, opts);
  const { verifier, challenge } = pkcePair(opts.random);
  const state = newState(opts.random);
  const loop = await openLoopback({ state, timeoutMs: opts.timeoutMs });
  try {
    const url = authorizationUrl(plan, { clientId, redirectUri: loop.redirectUri, state, challenge });
    await opts.onListening?.({ redirectUri: loop.redirectUri, address: loop.address, port: loop.port, authorizationUrl: url, notice: plan.notice });
    await opts.open(url);
    const { code } = await loop.callback;
    const grant = await exchangeCode(plan, { code, redirectUri: loop.redirectUri, verifier }, opts);
    if (!grant.refreshToken) {
      throw new OAuthError(
        "no_refresh_token",
        `${new URL(plan.tokenUrl).host} issued no refresh token, so the sign-in would stop working within the hour — nothing was kept. The provider may need a scope for offline access (often offline_access)`,
      );
    }
    await opts.store.set(plan.tokenSecret, grant.refreshToken);
    return { connection: plan.connection, stored: plan.tokenSecret, from: plan.from, client: plan.clientId.kind === "shipped" ? "shipped" : "yours", scopes: plan.scopes, ...(plan.notice !== undefined ? { notice: plan.notice } : {}) };
  } finally {
    await loop.close();
  }
}

/**
 * The owner's own client id, read for the authorize address. It goes into a
 * URL the BROWSER opens — OAuth puts it there — so it is held to the same
 * rule a URL-bound secret meets nowhere else: its *Sent only to* list must
 * name the authorize endpoint's host, and the connection must be granted it.
 */
async function ownClientId(plan: OAuthClientPlan, door: TokenDoor): Promise<string> {
  const name = (plan.clientId as { name: string }).name;
  const host = new URL(plan.authorizeUrl).host;
  const policy = Object.hasOwn(door.secrets.secrets, name) ? door.secrets.secrets[name] : undefined;
  if (!policy || !policy.hosts.includes(host)) {
    throw new EgressRefused("host_not_listed", [name], host, `${name} may not be sent to ${host} — the authorize address carries the client id (\`metistry secrets hosts ${name} ${[...(policy?.hosts ?? []), host].join(" ")}\`)`);
  }
  const grant = secretGrant(door.secrets, name, `connection:${plan.connection}`);
  if (grant !== "on") throw new EgressRefused("not_granted", [name], host, `connection:${plan.connection} is not granted ${name} (\`metistry secrets grant ${name} connection:${plan.connection} on\`)`);
  const v = await door.source.value(name);
  if (!v) throw new EgressRefused("missing_secret", [name], host, `no item in this instance for ${name} — \`metistry secrets set ${name}\` stores one; nothing was sent`);
  door.redactor.learn(name, v);
  return v;
}
