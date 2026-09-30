// A sync reading its connection (plan §2.5, §2.6; T4-24).
//
// A `calendar`, `mail` or `tracker` connection is not dialled as MCP (the
// pool refuses it `not_built`): its provider is product code — a connection
// type whose `implementation` is `builtin` — and a sync (a collector unit,
// named by the type's `sync:`) reads it on an interval. This module is what
// that sync opens: which connection it reads, and a `fetch` that can reach
// that connection's service and nowhere else.
//
// **Which connection.** `scheduled.yaml`'s `syncs.<sync>.connection` when the
// owner names one; otherwise the one `ok` connection whose provider declares
// `sync: <sync>` — so adding a Linear connection is enough for the Linear
// sync to read it. Two such connections and no entry is refused rather than
// one of them silently winning: the owner names one.
//
// **Where it may go** — enforced here, not asked of the provider:
//
//   * the connection's URL must be the provider's own origin (the provider
//     passes it: `https://api.linear.app` for Linear). A file that points
//     the connection elsewhere is refused before anything is sent. A
//     provider with no origin of its own — an ICS feed can live anywhere
//     (T4-12) — passes none, and the pin is the connection's own URL's
//     origin: the owner's file says where it goes, and a secret still goes
//     only to its listed hosts;
//   * the returned `fetch` refuses a request to any other origin, and a
//     redirect is never followed — both `other_host`;
//   * every request goes through core's `guardedFetch` with the connection
//     as the grantee: a `{{ secret.x }}` in a header is filled only for a
//     host on that secret's *Sent only to* list, over https, and only when
//     the owner granted it to `connection:<name>`; everything that comes
//     back is redacted. Basic sign-in (`auth: basic`, an app password —
//     CalDAV, T4-13) is the same reference: `Basic {{ secret.x }}`, encoded
//     with the file's username inside the door (`basicSource`).
//
// **Where a value comes from.** A sync runs inside the console, which never
// reads the Keychain. A secret reaches it the way a provider key reaches the
// engine (T4-18): `metistry secrets sync --to env` writes the delivery line
// (`METISTRY_SECRET_<NAME>`, core's `secretDeliveryVar`) into the instance's
// `.env` for every secret a sync-read connection lists (`syncSecretNames`),
// and `envSecretSource` reads it back. Unlike the engine's provider key,
// the value is never put on a request by the caller: it is filled by the
// door, for the listed host, or not at all.
//
// **OAuth sign-in** (`auth: oauth`, Google Calendar — T4-14). The delivered
// secret is the REFRESH token; what the door fills into
// `Bearer {{ secret.<token> }}` is an access token minted from it at the
// token endpoint (`oauth.ts`: `OAuthTokens`, `oauthSource` — through its own
// guarded request, pinned to that endpoint, no redirect) and held in this
// process's memory until a minute before it expires. The opener keeps one
// per connection across runs (`OAuthCache`). A sync that knows its
// provider's hosts passes them (`tokenHosts`), and the token secret's *Sent
// only to* list must be EXACTLY those — the access token and the refresh
// token go to nothing else, even if the owner's list says more.

import {
  SecretRedactor,
  connectionTypeSyncs,
  guardedFetch,
  parseSecretsFile,
  secretDeliveryVar,
  type AgentDispatch,
  type ConnectionFile,
  type ConnectionTypeManifest,
  type RegistryUnit,
  type Scheduled,
  type SecretSource,
  type SecretsFile,
} from "@foldedspacelabs/metistry-core";
import { loadInstanceCatalog, type CatalogRoots, type ConnectionCatalog } from "./catalog.js";
import { ConnectionRefused } from "./errors.js";
import type { ConnectionEntry } from "./load.js";
import { basicSource, connectionGrantee } from "./door.js";
import { OAuthError, OAuthTokens, oauthClientOf, oauthSource, type OAuthClientPlan, type TokenDoor } from "./oauth.js";

/**
 * A `SecretSource` over an environment: `{{ secret.x }}` is
 * `METISTRY_SECRET_X`. For a service process that holds delivered secrets —
 * never the Keychain. An empty line is no value.
 */
export function envSecretSource(env: NodeJS.ProcessEnv): SecretSource {
  return {
    async value(name) {
      let key: string;
      try {
        key = secretDeliveryVar(name);
      } catch {
        return undefined;
      }
      const v = env[key];
      return v === undefined || v.trim() === "" ? undefined : v.trim();
    },
  };
}

/** The syncs a connection's provider declares (`sync`, then `also_read_by`), when its provider is product code a sync reads. */
function declaredSyncs(entry: ConnectionEntry): string[] {
  const m = entry.provider?.manifest;
  return m && m.implementation.kind === "builtin" ? connectionTypeSyncs(m) : [];
}

/** What a sync reads, or why it reads nothing. */
export type SyncTarget =
  | { ok: true; entry: ConnectionEntry & { connection: ConnectionFile; provider: RegistryUnit<ConnectionTypeManifest> } }
  | { ok: false; status: "absent" | "failed"; why: string };

/**
 * Which connection the sync `sync` reads. Pure over a loaded catalog.
 * `absent`: nothing to read (no such connection yet, or the named one is
 * absent). `failed`: the owner's choice cannot be read (the named connection
 * is failed, or belongs to another sync, or two connections qualify and none
 * is named).
 */
export function syncTarget(catalog: Pick<ConnectionCatalog, "entries" | "scheduled">, sync: string): SyncTarget {
  const named = catalog.scheduled?.syncs && Object.hasOwn(catalog.scheduled.syncs, sync) ? catalog.scheduled.syncs[sync]?.connection : undefined;
  if (named !== undefined) {
    const entry = catalog.entries.find((e) => e.name === named);
    if (!entry) return { ok: false, status: "absent", why: `scheduled.yaml names connection ${named} for ${sync}, and there is no .metistry/connections/${named}.yaml` };
    if (entry.status !== "ok" || !entry.connection || !entry.provider) {
      return { ok: false, status: entry.status === "absent" ? "absent" : "failed", why: `connection ${named} is ${entry.status}: ${entry.issues.join("; ") || "not ready"}` };
    }
    if (!declaredSyncs(entry).includes(sync)) {
      return { ok: false, status: "failed", why: `scheduled.yaml names connection ${named} for ${sync}, but its provider ${entry.provider.name} is read by ${declaredSyncs(entry).join(", ") || "no sync"}` };
    }
    return { ok: true, entry: entry as Extract<SyncTarget, { ok: true }>["entry"] };
  }
  const mine = catalog.entries.filter((e) => e.status === "ok" && e.connection && declaredSyncs(e).includes(sync));
  if (mine.length === 1) return { ok: true, entry: mine[0] as Extract<SyncTarget, { ok: true }>["entry"] };
  if (mine.length > 1) {
    return {
      ok: false,
      status: "failed",
      why: `${mine.length} connections are read by ${sync} (${mine.map((e) => e.name).join(", ")}) — name one in scheduled.yaml (syncs.${sync}.connection)`,
    };
  }
  return { ok: false, status: "absent", why: `no connection is read by ${sync} yet` };
}

/**
 * Every connection each sync reads, by the rule `syncTarget` applies — for a
 * listing's *used by*. A connection named by a `scheduled.yaml` entry is read
 * by that sync whatever its provider says (the entry is refused at run time,
 * and saying who names it is the honest answer).
 */
export function syncReaders(catalog: Pick<ConnectionCatalog, "entries" | "scheduled">): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (connection: string, sync: string) => out.set(connection, [...new Set([...(out.get(connection) ?? []), sync])].sort());
  for (const [sync, entry] of Object.entries(catalog.scheduled?.syncs ?? {})) add(entry.connection, sync);
  const syncs = new Set(catalog.entries.flatMap(declaredSyncs));
  for (const sync of syncs) {
    if (catalog.scheduled?.syncs && Object.hasOwn(catalog.scheduled.syncs, sync)) continue;
    const t = syncTarget(catalog, sync);
    if (t.ok) add(t.entry.name, sync);
  }
  return out;
}

/**
 * The secrets every sync-read connection lists — what `metistry secrets sync
 * --to env` delivers so the console's syncs can be filled at the door. Only
 * `ok` connections whose provider is product code a sync reads.
 */
export function syncSecretNames(catalog: Pick<ConnectionCatalog, "entries">): string[] {
  const out = new Set<string>();
  for (const e of catalog.entries) if (e.status === "ok" && e.connection && declaredSyncs(e).length > 0) for (const s of e.connection.secrets) out.add(s);
  return [...out].sort();
}

/**
 * Every secret the console fills (T4-10): a sync's (above); because the
 * console holds the pool the proxy dials through, every `ok` MCP, API, feed
 * or files connection's — its headers, a command's environment, an OAuth
 * sign-in's refresh token and the owner's own client; and, because dispatch
 * sends a brief through one (T4-11), every `ok` agent connection's whose
 * type says how it is dispatched to. What `metistry secrets sync --to env`
 * delivers as `METISTRY_SECRET_<NAME>`. A calendar, mail or tracker
 * connection nothing syncs and a bridge's are not the console's to fill, and
 * are not delivered.
 */
export function consoleSecretNames(catalog: Pick<ConnectionCatalog, "entries">): string[] {
  const out = new Set(syncSecretNames(catalog));
  for (const e of catalog.entries) {
    if (e.status !== "ok" || !e.connection) continue;
    const impl = e.provider?.manifest.implementation.kind ?? "native";
    const dialled = impl === "native" && (e.connection.type === "mcp" || e.connection.type === "api" || e.connection.type === "feed" || e.connection.type === "files");
    const dispatched = e.connection.type === "agent" && e.provider?.manifest.dispatch !== undefined;
    if (dialled || dispatched) for (const s of e.connection.secrets) out.add(s);
  }
  return [...out].sort();
}

/** What a sync holds while it reads its connection. Carries references and names — never a value. */
export interface SyncHttp {
  /** the connection's name */
  connection: string;
  /** its provider's connection-type name */
  provider: string;
  /** the connection's URL, variables filled */
  url: string;
  /** the only origin `fetch` reaches */
  origin: string;
  /** headers to send, lowercased: an auth shortcut becomes a `{{ secret.x }}` reference, filled only at the door */
  headers: Readonly<Record<string, string>>;
  /** the door: pinned to `origin`, no redirect followed, secrets filled for listed hosts only, everything that comes back redacted */
  fetch: typeof fetch;
  /** what its provider declares it can do (`read`, `create`, …) — a door that changes the service checks its capability here before anything is sent */
  capabilities: readonly string[];
  /** the owner's Needs You switches for this sync from `scheduled.yaml` (`syncs.<sync>.raise`) — only what the file says; the manifest's defaults are the sync's */
  raise: Readonly<Record<string, boolean>>;
  /** the connection's text config values (`config.<field>`), as the file writes them — never a secret (a secret or oauth field is left out) */
  config: Readonly<Record<string, string>>;
  /** the secret names the calls so far carried — for the run's `meta.secrets` */
  secretsUsed(): string[];
}

export type OpenedSync = { ok: true; sync: SyncHttp } | { ok: false; status: "absent" | "failed"; why: string };

export interface OpenSyncOptions {
  catalog: Pick<ConnectionCatalog, "entries" | "scheduled" | "secrets">;
  /** the sync (collector unit) opening its connection */
  sync: string;
  /** the provider's own origin (`https://api.linear.app`): the connection's URL must be it, and nothing else is reached. Absent (a provider that lives anywhere, like an ICS feed): the connection's own URL's origin is the only one reached */
  origin?: string | undefined;
  /** further origins the provider's code reaches for the same service (Devin's wikis at `https://mcp.devin.ai`) — named by product code, never by the file; a secret still goes only to its listed hosts */
  alsoOrigins?: readonly string[] | undefined;
  /** the builtin module that must implement the connection's provider (`linear`) */
  module: string;
  /** where a value comes from — `envSecretSource(process.env)` in the console */
  secrets: SecretSource;
  redactor?: SecretRedactor | undefined;
  /** the base fetch under the door (a test's fake; default global fetch) */
  fetch?: typeof fetch | undefined;
  /**
   * An OAuth connection: the exact hosts its token secret's *Sent only to*
   * list must be — the token endpoint's and the service's (Google:
   * `GOOGLE_TOKEN_HOSTS`). Absent: the list is the owner's, held by the door.
   */
  tokenHosts?: readonly string[] | undefined;
  /** where an OAuth connection's access token is kept between runs (the opener's); absent = minted afresh on each open */
  oauth?: OAuthCache | undefined;
}

/** One process's OAuth access tokens, by connection — kept while the sign-in's plan is the same, so a run every 15 minutes mints one an hour, not one a run. */
export type OAuthCache = Map<string, { key: string; tokens: OAuthTokens; door: { current: TokenDoor } }>;

/** The exact-hosts rule for an OAuth sign-in's token secret, or why it is broken. Names hosts and secrets, never a value. */
function tokenHostsIssue(name: string, plan: OAuthClientPlan, secrets: SecretsFile, want: readonly string[]): string | undefined {
  const expected = [...new Set(want)].sort();
  const tokenHost = new URL(plan.tokenUrl).host;
  if (!expected.includes(tokenHost)) return `connection ${name}: its sign-in's token endpoint (${tokenHost}) is not one of the hosts this sync signs in at (${expected.join(", ")})`;
  const policy = Object.hasOwn(secrets.secrets, plan.tokenSecret) ? secrets.secrets[plan.tokenSecret] : undefined;
  const listed = [...new Set(policy?.hosts ?? [])].sort();
  if (listed.length === expected.length && listed.every((h, i) => h === expected[i])) return undefined;
  return `connection ${name}: its sign-in (${plan.tokenSecret}) is sent to exactly ${expected.join(" and ")} — its *Sent only to* list is ${listed.length ? listed.join(", ") : "empty"}, so nothing is sent (\`metistry secrets hosts ${plan.tokenSecret} ${expected.join(" ")}\`)`;
}

function urlOf(input: Parameters<typeof fetch>[0]): string {
  return input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
}

/**
 * Open the connection a sync reads, or say why there is none. Never dials:
 * the first request is the sync's own. Refusals that are the file's fault
 * (another host, an auth this sync does not send, a provider this sync does
 * not implement) are `failed`, so the run says so rather than passing
 * silently.
 */
export function openSyncHttp(opts: OpenSyncOptions): OpenedSync {
  const target = syncTarget(opts.catalog, opts.sync);
  if (!target.ok) return target;
  const { entry } = target;
  const impl = entry.provider.manifest.implementation;
  if (impl.kind !== "builtin" || impl.module !== opts.module) {
    return { ok: false, status: "failed", why: `connection ${entry.connection.name}: provider ${entry.provider.name} is not implemented by ${opts.module}` };
  }
  const scheduled: Scheduled | null | undefined = opts.catalog.scheduled;
  const raise = scheduled?.syncs && Object.hasOwn(scheduled.syncs, opts.sync) ? { ...(scheduled.syncs[opts.sync]?.raise ?? {}) } : {};
  return connectionHttp(entry, opts.sync, { ...opts, raise });
}

type ReadyEntry = ConnectionEntry & { connection: ConnectionFile; provider: RegistryUnit<ConnectionTypeManifest> };

/** What a connection's HTTP door is built from — a sync's options, or dispatch's. */
interface HttpDoorOptions extends Pick<OpenSyncOptions, "origin" | "alsoOrigins" | "secrets" | "redactor" | "fetch" | "tokenHosts" | "oauth"> {
  catalog: Pick<ConnectionCatalog, "secrets">;
  raise: Record<string, boolean>;
}

/**
 * One `ok` connection's HTTP door, for `who` (a sync, or dispatch): its URL
 * and headers with every sign-in shortcut written as a `{{ secret.x }}`
 * reference, and a `fetch` pinned to its origin (and any origin the
 * product's code names beside it), through core's `guardedFetch` with the
 * connection as the grantee, following no redirect.
 */
function connectionHttp(entry: ReadyEntry, who: string, opts: HttpDoorOptions): OpenedSync {
  const c = entry.connection;
  const http = c.reach.http;
  if (!http) return { ok: false, status: "failed", why: `connection ${c.name}: ${who} reads it over http — its reach is not http` };
  let url: URL;
  try {
    url = new URL(http.url);
  } catch {
    return { ok: false, status: "failed", why: `connection ${c.name}: reach.http.url is not a URL (a {{ variable }} there is not read by ${who})` };
  }
  if (opts.origin !== undefined && url.origin !== opts.origin) {
    return { ok: false, status: "failed", why: `connection ${c.name}: ${entry.provider.name} is reached at ${opts.origin} and nowhere else — reach.http.url is ${url.origin}` };
  }
  if (Object.keys(http.query).length > 0) return { ok: false, status: "failed", why: `connection ${c.name}: ${who} sends no query parameters` };
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(http.headers)) {
    if (/\{\{\s*variable\./.test(v)) return { ok: false, status: "failed", why: `connection ${c.name}: reach.http.headers.${k}: a {{ variable }} is not read by ${who}` };
    headers[k.toLowerCase()] = v;
  }
  const auth = http.auth;
  let basic: { secret: string; username: string } | undefined;
  let oauth: OAuthClientPlan | undefined;
  if (auth.scheme === "bearer") headers.authorization = `Bearer {{ secret.${auth.secret} }}`;
  else if (auth.scheme === "api_key") headers[auth.header.toLowerCase()] = `{{ secret.${auth.secret} }}`;
  else if (auth.scheme === "basic") {
    // only a provider that declares basic sign-in sends one (core's connectionIssues refuses the file too)
    if (!entry.provider.manifest.auth?.includes("basic")) {
      return { ok: false, status: "failed", why: `connection ${c.name}: ${entry.provider.name} does not accept basic sign-in` };
    }
    // RFC 7617: the user-id cannot contain a colon — the server would split it there
    if (auth.username.includes(":") || /[\u0000-\u001f\u007f]/.test(auth.username)) {
      return { ok: false, status: "failed", why: `connection ${c.name}: reach.http.auth.username cannot contain a colon or a control character (RFC 7617)` };
    }
    headers.authorization = `Basic {{ secret.${auth.secret} }}`;
    basic = { secret: auth.secret, username: auth.username };
  } else if (auth.scheme === "oauth") {
    // the client the owner signed in with — the type's shipped one, or the owner's own (oauth.ts)
    try {
      oauth = oauthClientOf(entry);
    } catch (err) {
      if (err instanceof OAuthError || err instanceof ConnectionRefused) return { ok: false, status: "failed", why: `connection ${c.name}: ${err.message}` };
      throw err;
    }
    if (opts.tokenHosts !== undefined) {
      const why = tokenHostsIssue(c.name, oauth, opts.catalog.secrets.ok ? opts.catalog.secrets.file : parseSecretsFile(""), opts.tokenHosts);
      if (why) return { ok: false, status: "failed", why };
    }
    headers.authorization = `Bearer {{ secret.${oauth.tokenSecret} }}`;
  } // `none`: no sign-in header — every scheme core has is handled above

  const secretsFile: SecretsFile = opts.catalog.secrets.ok ? opts.catalog.secrets.file : parseSecretsFile("");
  const redactor = opts.redactor ?? new SecretRedactor();
  const used = new Set<string>();
  const base = opts.fetch ?? fetch;
  const origin = url.origin;
  const origins = new Set([origin, ...(opts.alsoOrigins ?? [])]);
  const name = c.name;
  const source = basic ? basicSource(opts.secrets, basic, redactor) : oauth ? oauthSourceFor(name, oauth, opts, secretsFile, redactor, used) : opts.secrets;
  const door = guardedFetch(
    {
      secrets: secretsFile,
      grantee: connectionGrantee(name),
      purpose: "service",
      redactor,
      source,
      onUse: ({ names }) => {
        for (const n of names) used.add(n);
      },
    },
    base,
  );
  const pinned: typeof fetch = async (input, init) => {
    const to = urlOf(input);
    let target: URL;
    try {
      target = new URL(to);
    } catch {
      throw new ConnectionRefused("other_host", name, "not a URL");
    }
    if (!origins.has(target.origin)) throw new ConnectionRefused("other_host", name, `a request to ${target.origin} — this connection is ${[...origins].join(", ")}, and it goes nowhere else`);
    const res = await door(to, { ...(init ?? {}), redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => undefined);
      throw new ConnectionRefused("other_host", name, `${target.origin} answered with a redirect (HTTP ${res.status}) — a redirect is not followed`);
    }
    return res;
  };
  const config: Record<string, string> = {};
  const secretFields = new Set(entry.provider.manifest.fields.filter((f) => f.kind === "secret" || f.kind === "oauth").map((f) => f.key));
  for (const [k, v] of Object.entries(c.config)) if (typeof v === "string" && !secretFields.has(k)) config[k] = v;
  return {
    ok: true,
    sync: {
      connection: name,
      provider: entry.provider.name,
      url: url.href,
      origin,
      headers,
      fetch: pinned,
      capabilities: [...entry.provider.manifest.capabilities],
      raise: opts.raise,
      config,
      secretsUsed: () => [...used].sort(),
    },
  };
}

// --- agent connections: what dispatch sends a brief through (T4-11) ------------

/** An agent connection dispatch may send through: its door, and its type's dispatch block. */
export interface AgentHttp extends SyncHttp {
  /** the type's dispatch — dispatcher, data policy, purposes, result, cost */
  dispatch: AgentDispatch;
  /** the connection file's description, when it has one */
  description?: string | undefined;
}

export type OpenedAgent = { ok: true; agent: AgentHttp } | { ok: false; status: "absent" | "failed"; why: string };

/**
 * The agent connections dispatch lists: every file that parses as `type:
 * agent` and is either `ok` with a type that says how it is dispatched to,
 * or not `ok` (so the listing can say why). A file that does not parse at
 * all is the connection listing's to report, not dispatch's.
 */
export function agentConnections(catalog: Pick<ConnectionCatalog, "entries">): ConnectionEntry[] {
  return catalog.entries.filter((e) => e.connection?.type === "agent" && (e.status !== "ok" || e.provider?.manifest.dispatch !== undefined));
}

export interface OpenAgentOptions {
  catalog: Pick<ConnectionCatalog, "entries" | "secrets">;
  /** the connection's name */
  connection: string;
  /** the provider's own origin, when the dispatcher reaches one service and nowhere else (GitHub: `https://api.github.com`) */
  origin?: string | undefined;
  secrets: SecretSource;
  redactor?: SecretRedactor | undefined;
  fetch?: typeof fetch | undefined;
}

/**
 * Open an agent connection for dispatch, or say why it cannot be. Never
 * dials. `absent`: no such connection, or its provider is not installed.
 * `failed`: the file is wrong, it is not an agent connection, or its type
 * says nothing about dispatch.
 */
export function openAgentHttp(opts: OpenAgentOptions): OpenedAgent {
  const entry = opts.catalog.entries.find((e) => e.name === opts.connection);
  if (!entry) return { ok: false, status: "absent", why: `no connection named ${opts.connection}` };
  if (entry.status !== "ok" || !entry.connection || !entry.provider) {
    return { ok: false, status: entry.status === "absent" ? "absent" : "failed", why: `connection ${opts.connection} is ${entry.status}: ${entry.issues.join("; ") || "not ready"}` };
  }
  if (entry.connection.type !== "agent") return { ok: false, status: "failed", why: `connection ${opts.connection} is ${entry.connection.type} — only an agent connection is dispatched to` };
  const dispatch = entry.provider.manifest.dispatch;
  if (!dispatch) return { ok: false, status: "failed", why: `connection ${opts.connection}: its provider ${entry.provider.name} says nothing about how it is dispatched to` };
  const opened = connectionHttp(entry as ReadyEntry, "dispatch", { ...opts, raise: {} });
  if (!opened.ok) return opened;
  return { ok: true, agent: { ...opened.sync, dispatch, ...(entry.connection.description !== undefined ? { description: entry.connection.description } : {}) } };
}

/**
 * An OAuth connection's source: its token secret is the access token, minted
 * from the delivered refresh token (and reused from `opts.oauth` while the
 * plan is the same); a refusal at the token endpoint is the connection's
 * `sign_in`, naming `authorize`.
 */
function oauthSourceFor(name: string, plan: OAuthClientPlan, opts: Pick<OpenSyncOptions, "secrets" | "fetch" | "oauth">, secrets: SecretsFile, redactor: SecretRedactor, used: Set<string>): SecretSource {
  const door: TokenDoor = {
    secrets,
    source: opts.secrets,
    redactor,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    onUse: (names) => names.forEach((n) => used.add(n)),
  };
  const key = JSON.stringify(plan);
  let held = opts.oauth?.get(name);
  if (!held || held.key !== key) {
    const ref = { current: door };
    held = { key, tokens: new OAuthTokens(plan, () => ref.current), door: ref };
    opts.oauth?.set(name, held);
  }
  // this open's grants, redactor and run: a token minted now is told to this run
  held.door.current = door;
  const wrapped = oauthSource(opts.secrets, held.tokens);
  return {
    async value(n) {
      try {
        return await wrapped.value(n);
      } catch (err) {
        if (err instanceof OAuthError) throw new ConnectionRefused("sign_in", name, err.message);
        throw err;
      }
    },
  };
}

/** How a collector opens its connection: the console builds one per process; a test hands in its own. */
export type SyncOpener = (req: { sync: string; origin?: string | undefined; alsoOrigins?: readonly string[] | undefined; module: string; tokenHosts?: readonly string[] | undefined }) => Promise<OpenedSync>;

/**
 * The console's opener: reads the instance's catalog afresh on every open
 * (an edit to a connection, `secrets.yaml` or `scheduled.yaml` lands on the
 * next run with no restart) and fills from the environment's delivered
 * secrets.
 */
export function instanceSyncOpener(roots: CatalogRoots & { env: NodeJS.ProcessEnv; fetch?: typeof fetch | undefined }): SyncOpener {
  const secrets = envSecretSource(roots.env);
  const oauth: OAuthCache = new Map();
  return async (req) => {
    const catalog = await loadInstanceCatalog(roots);
    return openSyncHttp({ catalog, ...req, secrets, oauth, ...(roots.fetch ? { fetch: roots.fetch } : {}) });
  };
}
