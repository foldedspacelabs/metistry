// `metistry connections list | show | add | set | policy | remove | test |
// authorize` — M13 (design-build-plan §2.2, §2.6; T4-8a, T4-10).
//
// `.metistry/connections/<name>.yaml` says where Metistry reaches for the
// owner — hosts, commands, credentials by name, tool modes, the offer
// switch — so it is a §4.7 protected path: every write here goes through
// the reconciler as the owner (`writeProtected`), is edited as a YAML
// document so hand-written comments survive, and is judged by
// `packages/connections` — F-3's schema plus its own rules — BEFORE anything
// is written. A refusal names the field and the reason, never a value.
//
// The console reads the same files (`GET /api/connections(/:name)`) and
// never writes them: a new connection, a changed command or a tool moved to
// Allow is the owner's hand on the Mac, never a route (invariant 10).
//
// **Defaults (the owner's answer to Q15, 2026-09-26).** A tool the provider
// declares keeps its group; one a custom server offers is filed under
// *Changes things* — the server's own `readOnlyHint` is a hint, never a
// control (the MCP spec says so), so it is SHOWN and the owner promotes a
// tool with `policy`. By group: Reads → Allow, Changes things → Ask First,
// Starts an agent → Ask First. Offer to agents: off.
//
// `add` and `test` DIAL: they run the command or reach the URL, through the
// same pool the console will use (packages/connections) — the egress door,
// the closed environment, the origin pin all apply to the owner's own check.
//
// **T4-10.** An API, feed or files connection is written with the tools
// Metistry generates for it, every one at Ask First (the CLAUDE.md default
// for a proxied tool; the owner moves one with `policy`). OAuth is `--auth
// oauth`: a known service's client from its connection type (or the owner's
// own, `--client-id-secret`), a custom one's from `--authorize-url`,
// `--token-url`, `--scope` and the owner's client id — and `authorize` is
// the one door that signs in: a loopback listener on 127.0.0.1 for one
// callback, the browser, the exchange through the egress door, and the
// refresh token into this instance's Keychain. The assistant has no shell
// (invariant 9), and nothing it reaches imports the flow. And `add` writes a
// sync's FIRST `connection:` into `scheduled.yaml` when the provider is read
// by one and nothing names a connection for it yet (ruled 2026-09-27; the
// Scheduled door keeps refusing to set it).

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { parseDocument, stringify } from "yaml";
import {
  CUSTOM_PROVIDER,
  CONNECTION_TYPES,
  DEFAULT_TOOL_MODE,
  SCHEDULED_FILENAME,
  SecretRedactor,
  TOOL_GROUPS,
  parseScheduled,
  parseSecretsFile,
  secretRefsIn,
  variableRefsIn,
  type CheckResult,
  type ConnectionType,
  type ToolGroup,
  type ToolMode,
} from "@foldedspacelabs/metistry-core";
import {
  DEFAULT_OAUTH_FLOW_TIMEOUT_MS,
  authorizeConnection,
  checkConnection,
  connectionGrantee,
  describeConnectionDetail,
  describeConnections,
  generatedToolsFor,
  isGeneratedType,
  judgeConnection,
  oauthClientOf,
  parseConnectionText,
  type AuthorizeResult,
  type ConnectionCatalog,
  type ConnectionDetail,
  type ConnectionRow,
  type InstanceCatalog,
  type UpstreamTool,
} from "@foldedspacelabs/metistry-connections";
import { catalogFor, poolOver, presenceOf, secretsStore, type ConnectionsOptions } from "./connection-check.js";
import { realExec } from "./exec.js";
import { deleteProtected, protectedRel, writeProtected, type ProtectedWrite } from "./protected-write.js";
import { StepFailed, StepRunner } from "./steps.js";

export const CONNECTION_VERBS = ["list", "show", "add", "set", "policy", "remove", "test", "authorize"] as const;
export type ConnectionVerb = (typeof CONNECTION_VERBS)[number];

export function parseConnectionVerb(v: string | undefined): ConnectionVerb | undefined {
  return (CONNECTION_VERBS as readonly string[]).includes(v ?? "list") ? ((v ?? "list") as ConnectionVerb) : undefined;
}

/** The owner's words for a tool's mode (ruled 2026-09-26: Allow · Ask First · Never). The file keeps `on | ask | off`. */
export const TOOL_MODE_LABEL: Readonly<Record<ToolMode, string>> = { on: "Allow", ask: "Ask First", off: "Never" };
/** The groups in words (screen 9 §10.3). */
export const TOOL_GROUP_LABEL: Readonly<Record<ToolGroup, string>> = { reads: "Reads", changes: "Changes things", starts_agent: "Starts an agent" };

/** Q15: a new tool's mode, by its group. The file's own default for a tool with no mode is Ask First (core's DEFAULT_TOOL_MODE). */
export const NEW_TOOL_MODE: Readonly<Record<ToolGroup, ToolMode>> = { reads: "on", changes: "ask", starts_agent: "ask" };

/**
 * A generated tool's mode when a connection is added (T4-10): Ask First,
 * every group — CLAUDE.md's default for a proxied connection tool, taken
 * whole here, because a generated tool reaches a service no one has yet
 * seen answer through Metistry. The owner moves one to Allow with `policy`.
 */
export const GENERATED_TOOL_MODE: ToolMode = DEFAULT_TOOL_MODE;

/** `github-work` → `github_work`: a connection's name as the start of a secret's. */
function snakeOf(name: string): string {
  return name.replaceAll("-", "_");
}

/** `allow | ask | ask-first | never` — the owner's words — and the file's own `on | off`. */
export function parseToolMode(word: string | undefined): ToolMode | undefined {
  switch ((word ?? "").toLowerCase()) {
    case "allow":
    case "on":
      return "on";
    case "ask":
    case "ask-first":
    case "ask_first":
      return "ask";
    case "never":
    case "off":
      return "off";
    default:
      return undefined;
  }
}

const NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;

export type { ConnectionsOptions };

// ---- reading -------------------------------------------------------------------

/** `.metistry/connections/<name>.yaml`, instance-relative, as this instance spells it. */
export function connectionRel(instanceDir: string, name: string): string {
  return `${protectedRel(instanceDir, "connectionsDir")}/${name}.yaml`;
}

/** `connections list`: the rows `GET /api/connections` serves. */
export async function connectionsList(opts: ConnectionsOptions): Promise<ConnectionRow[]> {
  const catalog = await catalogFor(opts);
  return describeConnections(catalog, { presence: presenceOf(opts) });
}

/** `connections show <name>`: the body `GET /api/connections/:name` serves. */
export async function connectionsShow(name: string | undefined, opts: ConnectionsOptions): Promise<ConnectionDetail> {
  if (!name) throw new StepFailed("name the connection: metistry connections show <name>");
  const catalog = await catalogFor(opts);
  const detail = await describeConnectionDetail(name, catalog, connectionRel(opts.instanceDir, name), { presence: presenceOf(opts) });
  if (!detail) throw new StepFailed(`no connection named ${name} — \`metistry connections list\` names them`);
  return detail;
}

const STATUS_MARK: Record<string, string> = { ok: "ok", failed: "FAILED", absent: "absent", degraded: "degraded" };

function reachLine(r: ConnectionRow["reach"]): string {
  if (!r) return "-";
  if (r.class === "http") return `${r.url}${r.auth !== "none" ? ` (${r.auth})` : ""}`;
  if (r.class === "command") return `${[r.command, ...r.args].join(" ")}${r.runs_on === "container" ? " (in a container)" : ""}`;
  if (r.class === "imap") return `imap${r.security === "tls" ? "s" : ""}://${r.host}:${r.port}${r.security === "plain" ? " (no TLS: this Mac only)" : ""}`;
  return r.path;
}

function toolCounts(r: ConnectionRow): string {
  if (r.tools.length === 0) return "no tools";
  const n = (m: ToolMode) => r.tools.filter((t) => t.mode === m).length;
  return [`${n("on")} Allow`, `${n("ask")} Ask First`, `${n("off")} Never`].join(" · ");
}

export function renderConnections(rows: ConnectionRow[]): string {
  if (rows.length === 0) return "No connections yet. `metistry connections add <name> --type mcp -- <command…>` (or `--url <url>`) adds one (docs/ops/connections.md).";
  const out: string[] = [];
  for (const r of rows) {
    out.push(`${r.name}  ${STATUS_MARK[r.status] ?? r.status}${r.type ? `  ${r.type}${r.provider && r.provider !== CUSTOM_PROVIDER ? ` · ${r.provider}` : ""}` : ""}${r.offer_to_agents ? "  offered to agents" : ""}`);
    if (r.reach) out.push(`    reaches  ${reachLine(r.reach)}`);
    if (r.reach) out.push(`    tools    ${toolCounts(r)}`);
    out.push(`    used by  ${r.used_by.length ? r.used_by.map((u) => `${u.kind} ${u.name}`).join(", ") : "nobody yet"}`);
    for (const i of r.issues) out.push(`    ! ${i}`);
  }
  return out.join("\n");
}

export function renderConnectionDetail(d: ConnectionDetail): string {
  const out = [renderConnections([d]), `    file     ${d.file}`];
  if (d.description) out.push(`    about    ${d.description}`);
  if (d.reach?.class === "http" && (d.reach.headers.length || d.reach.query.length)) out.push(`    sends    ${[...d.reach.headers.map((h) => `header ${h}`), ...d.reach.query.map((q) => `query ${q}`)].join(", ")}`);
  if (d.reach?.class === "command" && d.reach.env.length) out.push(`    env      ${d.reach.env.join(", ")} (given to this command only; never written to disk)`);
  if (d.secrets.length) out.push(`    secrets  ${d.secrets.join(", ")}`);
  if (d.variables.length) out.push(`    vars     ${d.variables.join(", ")}`);
  out.push(renderPolicy(d));
  return out.join("\n");
}

/** The tool table: by group, each tool with its mode in the owner's words. */
export function renderPolicy(r: Pick<ConnectionRow, "name" | "tools" | "offer_to_agents">): string {
  const out = [`  ${r.name}: offer to agents ${r.offer_to_agents ? "on" : "off"}`];
  if (r.tools.length === 0) return [...out, "  no tools listed — nothing may be called. `metistry connections test <name>` shows what the server offers."].join("\n");
  const width = Math.max(...r.tools.map((t) => t.name.length));
  for (const g of TOOL_GROUPS) {
    const tools = r.tools.filter((t) => t.group === g);
    if (tools.length === 0) continue;
    out.push(`  ${TOOL_GROUP_LABEL[g]}`);
    for (const t of tools) out.push(`    ${t.name.padEnd(width)}  ${TOOL_MODE_LABEL[t.mode]}`);
  }
  return out.join("\n");
}

// ---- dialling: test, and add's discovery ---------------------------------------------

/** `connections test <name>`: dial it, list its tools, compare with the file (check()). */
export async function connectionsTest(name: string | undefined, opts: ConnectionsOptions): Promise<CheckResult> {
  if (!name) throw new StepFailed("name the connection: metistry connections test <name>");
  const catalog = await catalogFor(opts);
  if (!catalog.entries.some((e) => e.name === name)) throw new StepFailed(`no connection named ${name} — \`metistry connections list\` names them`);
  const pool = poolOver(opts, async () => catalog);
  try {
    return await checkConnection(pool, catalog, name);
  } finally {
    await pool.close();
  }
}

export function renderCheck(r: CheckResult): string {
  const meta = (r.meta ?? {}) as { missing?: string[]; unlisted?: string[]; read_only_hint?: string[] };
  const out = [`${r.name}  ${r.status}  (${r.latency_ms} ms)`, `    ${r.probe}`];
  if (r.remediation) out.push(`    ! ${r.remediation}`);
  if (meta.unlisted?.length) out.push(`    offered and not listed (refused until you list one): ${meta.unlisted.join(", ")}`);
  if (meta.read_only_hint?.length) out.push(`    the server marks read-only (a hint, not a control): ${meta.read_only_hint.join(", ")}`);
  return out.join("\n");
}

// ---- writing ----------------------------------------------------------------------

const HEADER = [
  "# A connection (docs/ops/connections.md): where Metistry reaches for you, and",
  "# what it may call there. Secrets and variables are NAMES — {{ secret.x }},",
  "# {{ variable.x }} — never values. Written by `metistry connections`; a §4.7",
  "# protected path, so only you change it.",
];

async function commit(opts: ConnectionsOptions, name: string, content: string, message: string): Promise<ProtectedWrite> {
  const r = new StepRunner({ dryRun: opts.dryRun === true, out: opts.out, exec: opts.exec ?? realExec, env: opts.env });
  return writeProtected(r, connectionRel(opts.instanceDir, name), content, message, {
    env: opts.env,
    platform: opts.platform,
    uid: opts.uid,
    fetchFn: opts.fetchFn ?? fetch,
    instanceDir: opts.instanceDir,
  });
}

/** Judge what would be written exactly as the reader will, or refuse — naming fields, never values. */
function judged(name: string, content: string, catalog: InstanceCatalog): void {
  const parsed = parseConnectionText(content);
  if (!parsed.ok) throw new StepFailed(`refusing to write ${name}.yaml: ${parsed.issue}`);
  const entry = judgeConnection(name, `${catalog.dir}/${name}.yaml`, parsed.input, catalog.types);
  if (entry.status === "failed") throw new StepFailed(`refusing to write ${name}.yaml — ${entry.issues.join("; ")}`);
  if (entry.status === "absent") throw new StepFailed(`${entry.issues.join("; ")} — install its connection type first (\`metistry extensions add <dir>\`)`);
}

/** Add every secret and variable a value names to the file's lists, which are what the grant check and the egress guard read. */
function referencedNames(obj: { reach: unknown; config?: unknown; secrets: string[]; variables: string[] }, auth?: { secret?: string | undefined }): void {
  const text = JSON.stringify([obj.reach, obj.config ?? {}]);
  for (const n of secretRefsIn(text).names) if (!obj.secrets.includes(n)) obj.secrets.push(n);
  for (const n of variableRefsIn(text).names) if (!obj.variables.includes(n)) obj.variables.push(n);
  if (auth?.secret && !obj.secrets.includes(auth.secret)) obj.secrets.push(auth.secret);
}

/** `KEY=VALUE` → [KEY, VALUE]; refuses anything else. */
export function parsePair(raw: string, what: string): [string, string] {
  const eq = raw.indexOf("=");
  if (eq <= 0) throw new StepFailed(`${what} takes NAME=VALUE, not ${JSON.stringify(raw.length > 40 ? `${raw.slice(0, 40)}…` : raw)}`);
  return [raw.slice(0, eq), raw.slice(eq + 1)];
}

/**
 * How an HTTP connection signs in: `--auth none|bearer|api_key|basic|oauth`
 * with `--secret` (and `--auth-header` for an API key, `--username` for basic
 * — an app password, T4-13). OAuth (T4-10) takes its client from the
 * connection type, or — a custom connection — from `--authorize-url`,
 * `--token-url` and `--scope`; the owner's own client is `--client-id-secret`
 * (and `--client-secret-secret`), each the NAME of a secret; the sign-in is
 * kept in `--token-secret` (default `<name>_oauth_token`).
 */
export interface AuthFlags {
  auth?: string | undefined;
  secret?: string | undefined;
  authHeader?: string | undefined;
  username?: string | undefined;
  authorizeUrl?: string | undefined;
  tokenUrl?: string | undefined;
  scopes?: string[] | undefined;
  clientIdSecret?: string | undefined;
  clientSecretSecret?: string | undefined;
  tokenSecret?: string | undefined;
}

const SECRET_NAME_RE = /^[a-z][a-z0-9_]*$/;
function secretFlag(flag: string, v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  if (!SECRET_NAME_RE.test(v)) throw new StepFailed(`--${flag} takes the NAME of a secret (lowercase snake_case, stored with \`metistry secrets set <name>\`), never its value`);
  return v;
}
const ref = (name: string) => `{{ secret.${name} }}`;

function authOf(flags: AuthFlags): { scheme: string; secret?: string; header?: string; username?: string } | undefined {
  if (flags.auth === undefined) return undefined;
  switch (flags.auth) {
    case "none":
      return { scheme: "none" };
    case "bearer":
      if (!flags.secret) throw new StepFailed("--auth bearer needs --secret <name> — the secret whose value is sent as the bearer (never the value itself)");
      return { scheme: "bearer", secret: flags.secret };
    case "api_key":
    case "api-key":
      if (!flags.secret || !flags.authHeader) throw new StepFailed("--auth api_key needs --auth-header <Header-Name> and --secret <name>");
      return { scheme: "api_key", header: flags.authHeader, secret: flags.secret };
    case "basic":
      // an app password (CalDAV, T4-13): the username is not secret and is written; the password is a secret, by name
      if (!flags.secret || !flags.username) throw new StepFailed("--auth basic needs --username <user> and --secret <name> — the secret holds the (app) password, never the command line");
      if (flags.username.includes(":")) throw new StepFailed("--username cannot contain a colon — Basic sign-in splits the pair there (RFC 7617)");
      return { scheme: "basic", username: flags.username, secret: flags.secret };
    case "oauth":
      // the client and the references are the connection type's business, or a custom connection's (oauthAuth)
      return { scheme: "oauth" };
    default:
      throw new StepFailed(`--auth takes none, bearer, api_key, basic or oauth, not ${JSON.stringify(flags.auth)}`);
  }
}

/**
 * `--auth oauth`, written out (T4-10). A known service: the reach says `auth:
 * oauth` and the type's oauth field holds the references — the token secret
 * and, when the owner brings one, the client id and secret. A custom
 * connection (C118): the reach carries the client model and the references,
 * and the client id is always the owner's own.
 */
function oauthAuth(name: string, provider: string, flags: AuthFlags, catalog: { types: InstanceCatalog["types"] }): { auth: Record<string, unknown>; config: Record<string, unknown> } {
  const token = secretFlag("token-secret", flags.tokenSecret) ?? `${snakeOf(name)}_oauth_token`;
  const clientId = secretFlag("client-id-secret", flags.clientIdSecret);
  const clientSecret = secretFlag("client-secret-secret", flags.clientSecretSecret);
  if (provider === CUSTOM_PROVIDER) {
    const missing = [!flags.authorizeUrl && "--authorize-url", !flags.tokenUrl && "--token-url", !(flags.scopes && flags.scopes.length) && "--scope", !clientId && "--client-id-secret"].filter(Boolean);
    if (missing.length) {
      throw new StepFailed(`a custom OAuth connection names its client — no connection type supplies one (C118): ${missing.join(", ")}. The client id is your own, stored as a secret (\`metistry secrets set <name>\`)`);
    }
    return {
      auth: {
        scheme: "oauth",
        client: { authorize_url: flags.authorizeUrl, token_url: flags.tokenUrl, scopes: flags.scopes, pkce: true, redirect: "loopback" },
        token: ref(token),
        client_id: ref(clientId!),
        ...(clientSecret ? { client_secret: ref(clientSecret) } : {}),
      },
      config: {},
    };
  }
  if (flags.authorizeUrl || flags.tokenUrl || flags.scopes?.length) {
    throw new StepFailed(`${provider} supplies its OAuth client — --authorize-url, --token-url and --scope are for a custom connection; bring your own client with --client-id-secret`);
  }
  const fields = (catalog.types.get(provider)?.manifest.fields ?? []).filter((f) => f.kind === "oauth");
  if (fields.length !== 1) {
    throw new StepFailed(fields.length === 0 ? `${provider} does not sign in with OAuth` : `${provider} has ${fields.length} OAuth fields (${fields.map((f) => f.key).join(", ")}) — this command writes one; edit the file for the others`);
  }
  return {
    auth: { scheme: "oauth" },
    config: { [fields[0]!.key]: { token: ref(token), ...(clientId ? { client_id: ref(clientId) } : {}), ...(clientSecret ? { client_secret: ref(clientSecret) } : {}) } },
  };
}

/**
 * `--auth basic` only for a provider whose connection type declares it
 * (`auth: [basic]` — CalDAV's app password, T4-13). Refused here, before
 * anything is judged or written; core's `connectionIssues` refuses a
 * hand-written file the same way.
 */
function basicAllowed(auth: { scheme: string } | undefined, provider: string, catalog: { types: InstanceCatalog["types"] }): void {
  if (auth?.scheme !== "basic") return;
  const declared = provider === CUSTOM_PROVIDER ? undefined : catalog.types.get(provider)?.manifest.auth;
  if (!declared?.includes("basic")) {
    throw new StepFailed(
      `--auth basic is accepted only by a connection type that declares it (a CalDAV calendar: --provider caldav, icloud-calendar or fastmail-calendar) — ${provider === CUSTOM_PROVIDER ? "a custom connection" : provider} does not`,
    );
  }
}

export interface AddSpec extends AuthFlags {
  name: string | undefined;
  type: string | undefined;
  provider?: string | undefined;
  url?: string | undefined;
  /** `host[:port]` of an IMAP server (T4-15) — signed in with `--username` and the app password `--secret` names */
  imap?: string | undefined;
  /** reach the IMAP server without TLS — accepted for a server on this Mac only */
  plain?: boolean | undefined;
  /** a files connection's folder or file (T4-10), with its include and skip patterns */
  path?: string | undefined;
  include?: string[] | undefined;
  skip?: string[] | undefined;
  /** argv: the command and its arguments (everything after `--`) */
  command?: string[] | undefined;
  env?: string[] | undefined;
  headers?: string[] | undefined;
  runsOn?: string | undefined;
  description?: string | undefined;
  /** dial it and list what it offers (default); false writes it with no tools, or the provider's declared ones */
  discover?: boolean | undefined;
}

export interface AddResult {
  name: string;
  file: string;
  tools: Array<{ name: string; group: ToolGroup; mode: ToolMode; read_only_hint: boolean }>;
  delivery?: ProtectedWrite | undefined;
  /** the sync whose first connection this became in `scheduled.yaml`, when it did */
  sync?: { name: string; delivery: ProtectedWrite } | undefined;
}

/**
 * `--imap host[:port] --username <user> --secret <name> [--plain]` → the file's
 * `reach.imap` (T4-15). The username is written; the app password is the
 * secret, by name. Port 993 (implicit TLS) unless given; `--plain` only for a
 * server on this Mac — the file check refuses it anywhere else, and a mail
 * submission port, before anything is written.
 */
function imapReachOf(spec: AddSpec): { host: string; port?: number; security?: "plain"; username: string; secret: string } {
  const m = /^([^:\s/]+)(?::(\d{1,5}))?$/.exec(spec.imap ?? "");
  if (!m) throw new StepFailed(`--imap takes host or host:port (imap.gmail.com:993) — no scheme, no path`);
  if (spec.auth !== undefined && spec.auth !== "basic") throw new StepFailed("an IMAP connection signs in with --username and an app password (--secret) — --auth takes nothing else");
  if (!spec.username || !spec.secret) throw new StepFailed("--imap needs --username <user> and --secret <name> — the secret holds the app password, never the command line");
  const port = m[2] === undefined ? undefined : Number(m[2]);
  return { host: m[1]!.toLowerCase(), ...(port !== undefined && port !== 993 ? { port } : {}), ...(spec.plain ? { security: "plain" as const } : {}), username: spec.username, secret: spec.secret };
}

/** `connections add <name> --type <type> (--url <url> | --imap <host[:port]> | --path <path> | -- <command…>)`. */
export async function connectionsAdd(spec: AddSpec, opts: ConnectionsOptions): Promise<AddResult> {
  const name = spec.name;
  if (!name || !NAME_RE.test(name)) throw new StepFailed(`${JSON.stringify(name ?? "")} is not a connection name — lowercase kebab-case, e.g. github`);
  const type = spec.type as ConnectionType | undefined;
  if (!type || !(CONNECTION_TYPES as readonly string[]).includes(type)) throw new StepFailed(`--type is one of ${CONNECTION_TYPES.join(", ")}`);
  const catalog = await catalogFor(opts);
  if (catalog.entries.some((e) => e.name === name) || existsSync(`${catalog.dir}/${name}.yaml`) || existsSync(`${catalog.dir}/${name}.yml`)) {
    throw new StepFailed(`there is already a connection named ${name} — \`metistry connections set ${name} …\` changes it, \`remove\` deletes it`);
  }
  const hows = [spec.url !== undefined, spec.command !== undefined && spec.command.length > 0, spec.imap !== undefined, spec.path !== undefined].filter(Boolean).length;
  if (hows !== 1) {
    throw new StepFailed("say how it is reached — one of: --url <url>, --imap <host[:port]> (a mailbox), --path <folder or file> (a files connection), or -- <command> [args…] after everything else");
  }
  if (spec.plain && spec.imap === undefined) throw new StepFailed("--plain is for a connection reached by --imap");
  const provider = spec.provider ?? CUSTOM_PROVIDER;
  const imap = spec.imap !== undefined ? imapReachOf(spec) : undefined;
  const auth = imap ? undefined : authOf(spec);
  basicAllowed(auth, provider, catalog);
  const env = Object.fromEntries((spec.env ?? []).map((p) => parsePair(p, "--env")));
  const headers = Object.fromEntries((spec.headers ?? []).map((p) => parsePair(p, "--header")));
  if (spec.url === undefined && (auth || Object.keys(headers).length)) throw new StepFailed("--auth and --header are for a connection reached by --url");
  if ((spec.command === undefined || spec.command.length === 0) && Object.keys(env).length) throw new StepFailed("--env is for a connection reached by a command");
  if (spec.path === undefined && (spec.include?.length || spec.skip?.length)) throw new StepFailed("--include and --skip are for a files connection reached by --path");
  const oauth = auth?.scheme === "oauth" ? oauthAuth(name, provider, spec, catalog) : undefined;
  if (!oauth && (spec.authorizeUrl || spec.tokenUrl || spec.scopes?.length || spec.clientIdSecret || spec.clientSecretSecret || spec.tokenSecret)) {
    throw new StepFailed("--authorize-url, --token-url, --scope, --client-id-secret, --client-secret-secret and --token-secret are for --auth oauth");
  }
  const reach = imap
    ? { imap }
    : spec.url !== undefined
      ? { http: { url: spec.url, ...(oauth ? { auth: oauth.auth } : auth ? { auth } : {}), ...(Object.keys(headers).length ? { headers } : {}) } }
      : spec.path !== undefined
        ? { path: { path: spec.path, ...(spec.include?.length ? { include: spec.include } : {}), ...(spec.skip?.length ? { skip: spec.skip } : {}) } }
        : { command: { command: spec.command![0]!, ...(spec.command!.length > 1 ? { args: spec.command!.slice(1) } : {}), ...(Object.keys(env).length ? { env } : {}), ...(spec.runsOn ? { runs_on: spec.runsOn } : {}) } };
  const obj: {
    name: string;
    type: ConnectionType;
    provider: string;
    description?: string;
    reach: unknown;
    secrets: string[];
    variables: string[];
    config?: Record<string, unknown>;
    tools: Record<string, { group: ToolGroup; mode: ToolMode }>;
    offer_to_agents: boolean;
  } = {
    name,
    type,
    provider,
    ...(spec.description ? { description: spec.description } : {}),
    reach,
    secrets: [],
    variables: [],
    ...(oauth && Object.keys(oauth.config).length ? { config: oauth.config } : {}),
    tools: {},
    offer_to_agents: false,
  };
  referencedNames(obj, auth ?? imap);

  // judge the file with no tools first: a refusal here names the field and dials nothing
  const bare = [...HEADER, stringify(obj)].join("\n");
  judged(name, bare, catalog);
  const unit = provider === CUSTOM_PROVIDER ? undefined : catalog.types.get(provider);
  const declared = unit?.manifest.tools ?? {};
  const generated = isGeneratedType(type) && (!unit || unit.manifest.implementation.kind === "native") ? generatedToolsFor(obj as Parameters<typeof generatedToolsFor>[0]) : [];

  let found: UpstreamTool[] | undefined;
  const signInFirst = oauth !== undefined;
  // a mailbox is not an MCP server — nothing to discover; `connections test` signs in
  if (spec.discover !== false && opts.dryRun !== true && !imap && !signInFirst) {
    const entry = judgeConnection(name, `${catalog.dir}/${name}.yaml`, parseDocument(bare).toJS(), catalog.types);
    // the one dial `add` makes: initialize and tools/list, through the same pool
    // and door as every later call — no tool is called. A generated type has no
    // server to list tools: the service is reached once (a feed read, a GET, the folder)
    const probe: ConnectionCatalog = { ...catalog, entries: [entry] };
    const pool = poolOver(opts, async () => probe);
    try {
      found = await pool.upstreamTools(name);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      throw new StepFailed(`${name} did not answer, so nothing was written — ${why}. Fix it and add again, or pass --no-discover to write it without reaching it`);
    } finally {
      await pool.close();
    }
  }
  const tools: AddResult["tools"] = [];
  if (generated.length > 0) {
    // Metistry's own tools for it — known without reaching it, and every one at Ask First
    for (const t of generated) tools.push({ name: t.name, group: t.group, mode: GENERATED_TOOL_MODE, read_only_hint: false });
  } else if (found) {
    for (const t of found) {
      const group: ToolGroup = Object.hasOwn(declared, t.name) ? declared[t.name]!.group : "changes";
      tools.push({ name: t.name, group, mode: NEW_TOOL_MODE[group], read_only_hint: t.readOnly });
    }
  } else {
    for (const [n, t] of Object.entries(declared)) tools.push({ name: n, group: t.group, mode: NEW_TOOL_MODE[t.group], read_only_hint: false });
  }
  tools.sort((a, b) => a.name.localeCompare(b.name));
  obj.tools = Object.fromEntries(tools.map((t) => [t.name, { group: t.group, mode: t.mode }]));
  const content = [...HEADER, stringify(obj)].join("\n");
  judged(name, content, catalog);

  const how = generated.length > 0 ? ` the tools Metistry generates for a ${type} connection${found ? " (it answered)" : ""}` : found ? " the server offers" : imap ? ` (a mailbox — \`metistry connections test ${name}\` signs in)` : signInFirst ? " (not dialled: sign in first)" : spec.discover === false ? " (not dialled: --no-discover)" : " (not dialled: dry run)";
  opts.out(`add ${name} (${type}${provider !== CUSTOM_PROVIDER ? ` · ${provider}` : ""}): ${tools.length} tool${tools.length === 1 ? "" : "s"}${how}, offer to agents off`);
  for (const t of tools) opts.out(`  ${t.name.padEnd(28)} ${TOOL_GROUP_LABEL[t.group].padEnd(16)} ${TOOL_MODE_LABEL[t.mode]}${t.read_only_hint && t.group !== "reads" ? "   (the server says read-only)" : ""}`);
  const hinted = tools.filter((t) => t.read_only_hint && t.group !== "reads").map((t) => t.name);
  if (hinted.length) opts.out(`the server marks ${hinted.length} tool${hinted.length === 1 ? "" : "s"} read-only — a hint, not a control; \`metistry connections policy ${name} <tool> allow --group reads\` files one under Reads`);
  if (generated.length > 0) opts.out(`every generated tool starts at Ask First — \`metistry connections policy ${name} <tool> allow\` moves one`);
  const hostEntry = imap ? `${imap.host}:${imap.port ?? 993}` : undefined;
  if (obj.secrets.length) {
    opts.out(
      `secrets it uses: ${obj.secrets.join(", ")} — each must be granted to connection:${name} (\`metistry secrets grant <name> connection:${name} on\`)${hostEntry ? ` and list ${hostEntry} (\`metistry secrets hosts <name> ${hostEntry}\`)` : reach && "http" in reach ? " and list its host (`metistry secrets hosts <name> <host>`)" : ""}`,
    );
  }
  if (signInFirst) opts.out(`next: \`metistry connections authorize ${name}\` signs in (the browser opens; the sign-in is kept in this instance's Keychain), then \`metistry connections test ${name}\``);
  const delivery = await commit(opts, name, content, `connections: add ${name}`);
  const sync = await firstSyncConnection(name, unit, catalog, opts);
  return { name, file: connectionRel(opts.instanceDir, name), tools, delivery, ...(sync ? { sync } : {}) };
}

/**
 * A sync's first `connection:` (§2.5, ruled 2026-09-27): when the provider
 * is product code a sync reads (`implementation: builtin`, `sync: <name>`)
 * and `scheduled.yaml` names no connection for that sync yet, `add` writes
 * `syncs.<sync>: { connection: <name> }` — edited as a document, so the
 * owner's comments and every other entry survive — through the reconciler
 * as the owner. An entry that already names one is left as it is: the owner
 * chose, and `metistry connections list` shows who reads what. The Scheduled
 * door keeps refusing to set a connection; this is the one writer of a first.
 */
async function firstSyncConnection(name: string, unit: ReturnType<InstanceCatalog["types"]["get"]>, catalog: InstanceCatalog, opts: ConnectionsOptions): Promise<{ name: string; delivery: ProtectedWrite } | undefined> {
  const m = unit?.manifest;
  const sync = m && m.implementation.kind === "builtin" ? m.sync : undefined;
  if (!sync) return undefined;
  const rel = `${protectedRel(opts.instanceDir, "metistryDir")}/${SCHEDULED_FILENAME}`;
  const path = `${opts.instanceDir.replace(/\/+$/, "")}/${rel}`;
  const text = existsSync(path) ? await readFile(path, "utf8") : "";
  const before = parseScheduled(text);
  if (!before.ok) {
    opts.out(`${rel} does not validate, so ${sync} was not pointed at ${name} — fix the file, then name it under syncs.${sync}.connection (${before.errors[0] ?? ""})`);
    return undefined;
  }
  const named = before.value.syncs && Object.hasOwn(before.value.syncs, sync) ? before.value.syncs[sync]?.connection : undefined;
  if (named !== undefined) {
    if (named !== name) opts.out(`${sync} already reads ${named} (${rel}: syncs.${sync}.connection) — left as it is`);
    return undefined;
  }
  const doc = parseDocument(text === "" ? "" : text);
  if (doc.errors.length > 0) return undefined;
  if (!doc.contents || !doc.has("syncs")) doc.set("syncs", doc.createNode({}));
  doc.setIn(["syncs", sync, "connection"], name);
  const content = String(doc);
  const after = parseScheduled(content);
  if (!after.ok) throw new StepFailed(`refusing to write ${rel}: the result would not validate — ${after.errors.join("; ")}`);
  opts.out(`${sync} reads ${name}: ${rel} syncs.${sync}.connection (its first connection — the Scheduled pane changes its interval and rules, never this)`);
  const r = new StepRunner({ dryRun: opts.dryRun === true, out: opts.out, exec: opts.exec ?? realExec, env: opts.env });
  const delivery = await writeProtected(r, rel, content, `scheduled: ${sync} reads ${name}`, {
    env: opts.env,
    platform: opts.platform,
    uid: opts.uid,
    fetchFn: opts.fetchFn ?? fetch,
    instanceDir: opts.instanceDir,
  });
  return { name: sync, delivery };
}

// ---- set / policy / remove ----------------------------------------------------------

interface Editable {
  path: string;
  doc: ReturnType<typeof parseDocument>;
  catalog: InstanceCatalog;
}

async function openConnection(name: string | undefined, opts: ConnectionsOptions): Promise<Editable & { name: string }> {
  if (!name || !NAME_RE.test(name)) throw new StepFailed(`${JSON.stringify(name ?? "")} is not a connection name — \`metistry connections list\` names them`);
  const catalog = await catalogFor(opts);
  const path = `${catalog.dir}/${name}.yaml`;
  if (!existsSync(path)) throw new StepFailed(`no connection file ${connectionRel(opts.instanceDir, name)} — \`metistry connections list\` names them`);
  const doc = parseDocument(await readFile(path, "utf8"));
  if (doc.errors.length > 0) throw new StepFailed(`${path} is not valid YAML (${doc.errors[0]?.code}) — fix it by hand; refusing to edit a file this command cannot read back`);
  return { name, path, doc, catalog };
}

async function write(e: Editable & { name: string }, opts: ConnectionsOptions, message: string): Promise<ProtectedWrite> {
  const content = String(e.doc);
  judged(e.name, content, e.catalog);
  return commit(opts, e.name, content, message);
}

export interface SetSpec extends AuthFlags {
  url?: string | undefined;
  command?: string[] | undefined;
  env?: string[] | undefined;
  unsetEnv?: string[] | undefined;
  headers?: string[] | undefined;
  unsetHeaders?: string[] | undefined;
  runsOn?: string | undefined;
  description?: string | undefined;
}

/** `connections set <name> …`: change how it is reached or described. Tools and the offer switch are `policy`. */
export async function connectionsSet(name: string | undefined, spec: SetSpec, opts: ConnectionsOptions): Promise<{ name: string; changed: string[]; delivery?: ProtectedWrite | undefined }> {
  const e = await openConnection(name, opts);
  const doc = e.doc;
  const changed: string[] = [];
  const reach = doc.getIn(["reach"]) as unknown;
  const isHttp = doc.hasIn(["reach", "http"]);
  const isCommand = doc.hasIn(["reach", "command"]);
  const reachedBy = isHttp ? "URL" : isCommand ? "a command" : doc.hasIn(["reach", "imap"]) ? "IMAP" : "a path";
  if (!reach) throw new StepFailed(`${e.path} has no reach: — fix it by hand`);
  if (spec.description !== undefined) {
    doc.setIn(["description"], spec.description);
    changed.push("description");
  }
  if (spec.url !== undefined) {
    if (!isHttp) throw new StepFailed(`${e.name} is reached by ${reachedBy}, not a URL — remove it and add it again to change how it is reached`);
    doc.setIn(["reach", "http", "url"], spec.url);
    changed.push("url");
  }
  if (spec.command !== undefined && spec.command.length > 0) {
    if (!isCommand) throw new StepFailed(`${e.name} is reached by ${reachedBy}, not a command — remove it and add it again to change how it is reached`);
    doc.setIn(["reach", "command", "command"], spec.command[0]);
    if (spec.command.length > 1) doc.setIn(["reach", "command", "args"], spec.command.slice(1));
    else doc.deleteIn(["reach", "command", "args"]);
    changed.push("command");
  }
  if (spec.runsOn !== undefined) {
    if (!isCommand) throw new StepFailed("--runs-on is for a connection reached by a command");
    doc.setIn(["reach", "command", "runs_on"], spec.runsOn);
    changed.push("runs_on");
  }
  for (const pair of spec.env ?? []) {
    if (!isCommand) throw new StepFailed("--env is for a connection reached by a command");
    const [k, v] = parsePair(pair, "--env");
    doc.setIn(["reach", "command", "env", k], v);
    changed.push(`env ${k}`);
  }
  for (const k of spec.unsetEnv ?? []) {
    if (!doc.hasIn(["reach", "command", "env", k])) throw new StepFailed(`${e.name} has no env ${k}`);
    doc.deleteIn(["reach", "command", "env", k]);
    changed.push(`env ${k} removed`);
  }
  for (const pair of spec.headers ?? []) {
    if (!isHttp) throw new StepFailed("--header is for a connection reached by --url");
    const [k, v] = parsePair(pair, "--header");
    doc.setIn(["reach", "http", "headers", k], v);
    changed.push(`header ${k}`);
  }
  for (const k of spec.unsetHeaders ?? []) {
    if (!doc.hasIn(["reach", "http", "headers", k])) throw new StepFailed(`${e.name} has no header ${k}`);
    doc.deleteIn(["reach", "http", "headers", k]);
    changed.push(`header ${k} removed`);
  }
  const auth = authOf(spec);
  const provider = String(doc.getIn(["provider"]) ?? CUSTOM_PROVIDER);
  if (auth) {
    if (!isHttp) throw new StepFailed("--auth is for a connection reached by --url");
    basicAllowed(auth, provider, e.catalog);
    if (auth.scheme === "oauth") {
      const o = oauthAuth(e.name, provider, spec, e.catalog);
      doc.setIn(["reach", "http", "auth"], doc.createNode(o.auth));
      for (const [k, v] of Object.entries(o.config)) doc.setIn(["config", k], doc.createNode(v));
    } else {
      doc.setIn(["reach", "http", "auth"], doc.createNode(auth));
    }
    changed.push(`auth ${auth.scheme}`);
  } else if (spec.clientIdSecret !== undefined || spec.clientSecretSecret !== undefined || spec.tokenSecret !== undefined) {
    // bring your own client (§2.6 recommendation 2): the id — and a secret, where the provider needs one — as secrets of this instance
    if (doc.getIn(["reach", "http", "auth", "scheme"]) !== "oauth" && doc.getIn(["reach", "http", "auth"]) !== "oauth") {
      throw new StepFailed(`${e.name} does not sign in with OAuth — --client-id-secret, --client-secret-secret and --token-secret are for one that does`);
    }
    const parts: Array<[string, string | undefined]> = [
      ["client_id", secretFlag("client-id-secret", spec.clientIdSecret)],
      ["client_secret", secretFlag("client-secret-secret", spec.clientSecretSecret)],
      ["token", secretFlag("token-secret", spec.tokenSecret)],
    ];
    let at: (string | number)[];
    if (provider === CUSTOM_PROVIDER) at = ["reach", "http", "auth"];
    else {
      const fields = (e.catalog.types.get(provider)?.manifest.fields ?? []).filter((f) => f.kind === "oauth");
      if (fields.length !== 1) throw new StepFailed(`${provider} has ${fields.length} OAuth fields — edit the file to choose one`);
      at = ["config", fields[0]!.key];
      if (typeof doc.getIn(at) !== "object") doc.setIn(at, doc.createNode({}));
    }
    // `auth: oauth` written as the shorthand: a custom connection's references live beside its client
    if (provider === CUSTOM_PROVIDER && typeof doc.getIn(["reach", "http", "auth"]) === "string") doc.setIn(["reach", "http", "auth"], doc.createNode({ scheme: "oauth" }));
    for (const [part, name] of parts) {
      if (name === undefined) continue;
      doc.setIn([...at, part], ref(name));
      changed.push(part === "client_id" ? `your own client id (${name})` : part === "client_secret" ? `your own client secret (${name})` : `sign-in kept in ${name}`);
    }
  }
  if (changed.length === 0) throw new StepFailed("nothing to change — see `metistry connections --help` for what set takes");
  // every name a value now uses joins the lists the grant check reads
  const js = doc.toJS() as { reach: unknown; config?: unknown; secrets?: string[]; variables?: string[] };
  const lists = { reach: js.reach, config: js.config, secrets: [...(js.secrets ?? [])], variables: [...(js.variables ?? [])] };
  referencedNames(lists, auth);
  if (lists.secrets.length !== (js.secrets ?? []).length) doc.setIn(["secrets"], doc.createNode(lists.secrets, { flow: true }));
  if (lists.variables.length !== (js.variables ?? []).length) doc.setIn(["variables"], doc.createNode(lists.variables, { flow: true }));
  opts.out(`set ${e.name}: ${changed.join(", ")}`);
  const delivery = await write(e, opts, `connections: set ${e.name} (${changed.join(", ")})`);
  return { name: e.name, changed, delivery };
}

export interface PolicySpec {
  tool?: string | undefined;
  mode?: string | undefined;
  group?: string | undefined;
  offer?: string | undefined;
}

/**
 * `connections policy <name>` prints the tool table; `policy <name> <tool>
 * <allow|ask|never> [--group g]` sets one tool's mode (listing it, if it is
 * not yet — its group from the provider, or `--group`); `--offer on|off`
 * sets the offer switch. The owner's hand: nothing else moves a tool to Allow.
 */
export async function connectionsPolicy(name: string | undefined, spec: PolicySpec, opts: ConnectionsOptions): Promise<{ row: ConnectionRow; delivery?: ProtectedWrite | undefined }> {
  const e = await openConnection(name, opts);
  const doc = e.doc;
  const changes: string[] = [];
  if (spec.tool !== undefined) {
    const mode = parseToolMode(spec.mode);
    if (!mode) throw new StepFailed(`say the mode: metistry connections policy ${e.name} ${spec.tool} allow|ask|never`);
    const provider = String(doc.getIn(["provider"]) ?? "");
    const declared = e.catalog.types.get(provider)?.manifest.tools ?? {};
    const current = doc.getIn(["tools", spec.tool]) as unknown;
    let group: ToolGroup | undefined = current ? ((doc.getIn(["tools", spec.tool, "group"]) as ToolGroup | undefined) ?? undefined) : undefined;
    if (spec.group !== undefined) {
      if (!(TOOL_GROUPS as readonly string[]).includes(spec.group)) throw new StepFailed(`--group is one of ${TOOL_GROUPS.join(", ")}`);
      if (Object.hasOwn(declared, spec.tool) && declared[spec.tool]!.group !== spec.group) {
        throw new StepFailed(`${provider} declares ${spec.tool} ${declared[spec.tool]!.group} — a connection cannot relabel it ${spec.group}`);
      }
      group = spec.group as ToolGroup;
    }
    group ??= Object.hasOwn(declared, spec.tool) ? declared[spec.tool]!.group : undefined;
    if (!group) throw new StepFailed(`${spec.tool} is not listed yet — name its group: --group ${TOOL_GROUPS.join("|")} (Reads · Changes things · Starts an agent)`);
    doc.setIn(["tools", spec.tool], doc.createNode({ group, mode }, { flow: true }));
    changes.push(`${spec.tool} → ${TOOL_MODE_LABEL[mode]} (${TOOL_GROUP_LABEL[group]})`);
  }
  if (spec.offer !== undefined) {
    if (spec.offer !== "on" && spec.offer !== "off") throw new StepFailed("--offer takes on or off");
    doc.setIn(["offer_to_agents"], spec.offer === "on");
    changes.push(`offer to agents ${spec.offer}`);
  }
  if (changes.length === 0) {
    const detail = await describeConnectionDetail(e.name, e.catalog, connectionRel(opts.instanceDir, e.name));
    if (!detail) throw new StepFailed(`no connection named ${e.name}`);
    return { row: detail };
  }
  opts.out(`policy ${e.name}: ${changes.join("; ")}`);
  const delivery = await write(e, opts, `connections: policy ${e.name} (${changes.join("; ")})`);
  const after = parseConnectionText(String(doc));
  const entry = judgeConnection(e.name, e.path, after.ok ? after.input : {}, e.catalog.types);
  const [row] = await describeConnections({ ...e.catalog, entries: [entry] });
  return { row: row!, delivery };
}

/** `connections remove <name>`: delete the file. What referred to it is not touched — it turns absent, naming it (§2.7). */
export async function connectionsRemove(name: string | undefined, opts: ConnectionsOptions): Promise<{ name: string; referred_by: string[]; delivery: ProtectedWrite }> {
  const e = await openConnection(name, opts);
  const referredBy: string[] = [];
  for (const [sync, entry] of Object.entries(e.catalog.scheduled?.syncs ?? {})) if (entry.connection === e.name) referredBy.push(`sync ${sync} (scheduled.yaml)`);
  if (e.catalog.secrets.ok) {
    for (const [secret, policy] of Object.entries(e.catalog.secrets.file.secrets)) if (Object.hasOwn(policy.grants, `connection:${e.name}`)) referredBy.push(`secret ${secret}'s grant to connection:${e.name}`);
  }
  if (referredBy.length) opts.out(`still referred to — left as they are, and they name a connection that is gone: ${referredBy.join(", ")}`);
  const r = new StepRunner({ dryRun: opts.dryRun === true, out: opts.out, exec: opts.exec ?? realExec, env: opts.env });
  const delivery = await deleteProtected(r, connectionRel(opts.instanceDir, e.name), `connections: remove ${e.name}`, {
    env: opts.env,
    platform: opts.platform,
    uid: opts.uid,
    fetchFn: opts.fetchFn ?? fetch,
    instanceDir: opts.instanceDir,
  });
  return { name: e.name, referred_by: referredBy, delivery };
}

// ---- authorize (T4-10) -------------------------------------------------------------------

export interface AuthorizeSpec {
  /** open the browser (default); false prints the address instead */
  browser?: boolean | undefined;
  /** seconds the listener waits for the provider (default 300) */
  timeoutS?: number | undefined;
}

export interface AuthorizeCliResult extends AuthorizeResult {
  /** `secrets.yaml`'s line for the token secret, when this sign-in created it */
  policy?: { hosts: string[]; grantee: string; delivery: ProtectedWrite } | undefined;
}

/**
 * `connections authorize <name>`: the one door that signs in (T4-10) — and
 * the owner's alone. A listener on 127.0.0.1, on a port the system picks,
 * for one callback; the browser at the provider (macOS `open`, or the address
 * printed with `--no-browser`); the state checked, the code exchanged with the
 * PKCE verifier through the egress door; the refresh token into this
 * instance's Keychain as the connection's token secret. The first sign-in
 * also writes that secret's policy: sent only to the token endpoint and the
 * service, granted to this connection alone.
 */
export async function connectionsAuthorize(name: string | undefined, spec: AuthorizeSpec, opts: ConnectionsOptions): Promise<AuthorizeCliResult> {
  if (!name || !NAME_RE.test(name)) throw new StepFailed(`${JSON.stringify(name ?? "")} is not a connection name — \`metistry connections list\` names them`);
  const catalog = await catalogFor(opts);
  const entry = catalog.entries.find((x) => x.name === name);
  if (!entry) throw new StepFailed(`no connection named ${name} — \`metistry connections list\` names them`);
  if (entry.status !== "ok" || !entry.connection) throw new StepFailed(`${name} is ${entry.status}: ${entry.issues.join("; ")}`);
  let plan: ReturnType<typeof oauthClientOf>;
  try {
    plan = oauthClientOf(entry);
  } catch (err) {
    throw new StepFailed(err instanceof Error ? err.message : String(err));
  }
  if (!catalog.secrets.ok) throw new StepFailed(`secrets.yaml does not load, so no sign-in can be kept — ${catalog.secrets.message}`);
  const store = secretsStore(opts);
  if (!store) {
    throw new StepFailed(
      opts.instanceId
        ? `a sign-in is kept in the macOS login Keychain, which this host (${opts.platform}) does not have — run this on the Mac that holds the instance`
        : `${opts.instanceDir} has no instance_id in identity.yaml, and a sign-in belongs to exactly one instance — \`metistry up\` mints one`,
    );
  }
  if (opts.dryRun) {
    opts.out(`[dry-run] would listen on 127.0.0.1 for one callback, open ${new URL(plan.authorizeUrl).host} in the browser, and keep the sign-in as ${plan.tokenSecret}`);
    if (plan.notice !== undefined) opts.out(`before you sign in: ${plan.notice}`);
    return { connection: name, stored: plan.tokenSecret, from: plan.from, client: plan.clientId.kind === "shipped" ? "shipped" : "yours", scopes: plan.scopes, ...(plan.notice !== undefined ? { notice: plan.notice } : {}) };
  }
  const timeoutMs = spec.timeoutS !== undefined ? Math.round(spec.timeoutS * 1000) : DEFAULT_OAUTH_FLOW_TIMEOUT_MS;
  opts.out(`signing in ${name} at ${new URL(plan.authorizeUrl).host} with ${plan.clientId.kind === "shipped" ? "Metistry's client for it" : "your own client"} (scopes: ${plan.scopes.join(" ")})`);
  const result = await authorizeConnection(entry, {
    secrets: catalog.secrets.file,
    source: store,
    redactor: new SecretRedactor(),
    ...(opts.dialFetch ? { fetch: opts.dialFetch } : {}),
    store: { set: (n, v) => store.set(n, v) },
    timeoutMs,
    onListening: ({ redirectUri, notice }) => {
      opts.out(`listening for the answer on ${redirectUri} (127.0.0.1 only, one callback, ${Math.round(timeoutMs / 1000)} s)`);
      // the connection type's words about its shipped client (Google: not verified yet) — before the browser opens, never after
      if (notice !== undefined) opts.out(`before you sign in: ${notice}`);
    },
    open: async (url) => {
      if (spec.browser === false || opts.platform !== "darwin") {
        opts.out(`open this address to sign in (it carries the client id, as OAuth does): ${url}`);
        return;
      }
      const r = await (opts.exec ?? realExec)("open", [url], { timeoutMs: 20_000 });
      if (r.code !== 0) opts.out(`the browser did not open (${r.stderr.trim() || `exit ${r.code}`}) — open this address to sign in: ${url}`);
      else opts.out("the browser is open — finish signing in there");
    },
  });
  opts.out(`signed in: ${name} — the sign-in is kept as ${result.stored} in this instance's Keychain; its value is not printed`);
  const policy = await ensureTokenPolicy(name, plan, opts);
  opts.out(`next: \`metistry secrets sync --to env\` delivers it to the console (which dials connections for agents and the assistant), then \`metistry connections test ${name}\``);
  return { ...result, ...(policy ? { policy } : {}) };
}

/**
 * The token secret's line in `secrets.yaml`, written on the first sign-in:
 * sent only to the token endpoint's host and the service's, granted `on` to
 * this connection and nobody else. An existing line is the owner's and is
 * left exactly as it is (the listing says what it would refuse).
 */
async function ensureTokenPolicy(name: string, plan: ReturnType<typeof oauthClientOf>, opts: ConnectionsOptions): Promise<AuthorizeCliResult["policy"]> {
  const path = `${opts.instanceDir.replace(/\/+$/, "")}/${protectedRel(opts.instanceDir, "secrets")}`;
  const text = existsSync(path) ? await readFile(path, "utf8") : "";
  const doc = parseDocument(text === "" ? "secrets: {}\n" : text);
  if (doc.errors.length > 0) return undefined;
  if (doc.hasIn(["secrets", plan.tokenSecret])) return undefined;
  const catalog = await catalogFor(opts);
  const c = catalog.entries.find((e) => e.name === name)?.connection;
  const hostOf = (u: string | undefined) => {
    try {
      const x = new URL(u ?? "");
      return x.port === "" || x.port === "443" ? x.hostname : `${x.hostname}:${x.port}`;
    } catch {
      return undefined;
    }
  };
  const hosts = [...new Set([hostOf(plan.tokenUrl), hostOf(c?.reach.http?.url)].filter((h): h is string => !!h && !h.includes("{{")))];
  const grantee = connectionGrantee(name);
  if (!doc.has("secrets")) doc.set("secrets", doc.createNode({}));
  doc.setIn(["secrets", plan.tokenSecret], doc.createNode({ hosts, grants: { [grantee]: "on" } }));
  const node = doc.getIn(["secrets", plan.tokenSecret, "hosts"], true) as { flow?: boolean } | undefined;
  if (node && typeof node === "object") node.flow = true;
  try {
    parseSecretsFile(String(doc));
  } catch (err) {
    opts.out(`secrets.yaml would not validate with ${plan.tokenSecret}'s line, so it was not written (${err instanceof Error ? err.message : String(err)}) — \`metistry secrets hosts|grant ${plan.tokenSecret}\``);
    return undefined;
  }
  opts.out(`${plan.tokenSecret} is sent only to ${hosts.join(", ")} and granted to ${grantee} — \`metistry secrets hosts|grant ${plan.tokenSecret}\` changes either`);
  const r = new StepRunner({ dryRun: opts.dryRun === true, out: opts.out, exec: opts.exec ?? realExec, env: opts.env });
  const delivery = await writeProtected(r, protectedRel(opts.instanceDir, "secrets"), String(doc), `secrets: ${plan.tokenSecret} for ${grantee} (signed in)`, {
    env: opts.env,
    platform: opts.platform,
    uid: opts.uid,
    fetchFn: opts.fetchFn ?? fetch,
    instanceDir: opts.instanceDir,
  });
  return { hosts, grantee, delivery };
}

/**
 * Every value of a repeatable flag (`--env A=1 --env B=2`), read from the raw
 * argv before `--` — the shared parser keeps the last one only.
 */
export function repeatedFlag(argv: readonly string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") break;
    if (a === `--${flag}` && i + 1 < argv.length && !argv[i + 1]!.startsWith("--")) out.push(argv[++i]!);
    else if (a.startsWith(`--${flag}=`)) out.push(a.slice(flag.length + 3));
  }
  return out;
}

/** Everything after `--`: a command and its arguments. */
export function afterDoubleDash(argv: readonly string[]): string[] | undefined {
  const i = argv.indexOf("--");
  return i === -1 ? undefined : argv.slice(i + 1);
}
