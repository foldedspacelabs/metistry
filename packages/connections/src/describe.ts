// The listing: `GET /api/connections(/:name)` and `metistry connections
// list|show` render these rows, so the Mac, the phone and the terminal say one
// thing about a connection.
//
// A row is built field by field from a file that passed every rule, and it
// carries NAMES: a header's, an environment variable's, a secret's — never a
// value, and never a header or environment value at all (a template is safe,
// but a name is all a list needs). A file that failed its rules shows its
// name, its status and why, and nothing else: the rule it broke may be a key
// pasted in the wrong place, and repeating the file would repeat the key.
//
// Beyond the file's own verdict (`load.ts`), the row adds what only the
// caller can know, so the owner sees a call's refusal before any call is made:
//
//   absent   a variable it uses is not set; a secret it uses has no item in
//            this instance's Keychain (asked through a presence probe, which
//            cannot read a value);
//   failed   `secrets.yaml` does not grant a secret to this connection, or
//            does not list this connection's host as one it may be sent to —
//            exactly what the egress door would refuse, said ahead of time.
//
// *Used by* is everything that reads it: the syncs in `scheduled.yaml` that
// name it, and the agents and crews granted it (`DescribeOptions.granted`,
// which the host fills from its registry — this package holds no agent list)
// when the owner has offered it to agents, the one rule core's `mayConnection`
// applies. Nothing else uses one, and an empty list is the true answer
// (screen 9: *Nobody yet* is a real value).
//
// *Last checked* is the time and verdict of the newest check anyone ran
// (`stamps.ts`) — null until one has been.

import {
  egressDestination,
  secretGrant,
  secretRefsIn,
  socketDestination,
  variableRefsIn,
  type AuthScheme,
  type ConnectionField,
  type ConnectionType,
  type ConnectionTypeManifest,
  type FieldKind,
  type ReachClass,
  type Registry,
  type RegistryUnit,
  type Scheduled,
  type SecretPresence,
  type ToolGroup,
  type ToolMode,
  type UnitOrigin,
} from "@foldedspacelabs/metistry-core";
import type { ConnectionCatalog } from "./catalog.js";
import { ConnectionRefused } from "./errors.js";
import { typedValues, type ConnectionEntry, type ConnectionStatus } from "./load.js";
import { connectionGrantee } from "./door.js";
import { isGeneratedType } from "./generated.js";
import { oauthClientOf, oauthSecretNames } from "./oauth.js";
import { planHttp } from "./plan.js";
import { readCheckStamps, type LastChecked } from "./stamps.js";
import { syncReaders } from "./sync.js";

export type { LastChecked } from "./stamps.js";

/**
 * Who reads a connection: a sync that names it, or an agent or a crew granted
 * it through the lazy pair (T4-8b). The assistant reaches every connection
 * and is not listed against each.
 */
export interface ConnectionUser {
  kind: "sync" | "agent" | "crew";
  /** the sync's name, or the agent's or crew's id */
  name: string;
}

/** One header an HTTP connection sends, with the secrets its value names — names, never the value or the template around it. */
export interface HeaderSecrets {
  header: string;
  secrets: string[];
}

/** How Metistry reaches it — names only for headers, query parameters and environment variables. */
export type ReachSummary =
  | { class: "http"; url: string; auth: AuthScheme; headers: string[]; header_secrets: HeaderSecrets[]; query: string[]; timeout_s: number | null }
  | { class: "command"; command: string; args: string[]; cwd: string | null; env: string[]; runs_on: "host" | "container" }
  | { class: "path"; path: string; include: string[]; skip: string[]; watch: boolean }
  /** an IMAP mailbox (T4-15): where it goes and how — never the username or the password */
  | { class: "imap"; host: string; port: number; security: "tls" | "plain"; auth: "basic" };

export interface ConnectionToolRow {
  name: string;
  group: ToolGroup;
  mode: ToolMode;
}

/** One connection in the list. */
export interface ConnectionRow {
  name: string;
  /** what it is — null when the file does not validate */
  type: ConnectionType | null;
  /** the connection-type unit that reaches it, or `custom` — null when the file does not validate */
  provider: string | null;
  description: string | null;
  status: ConnectionStatus;
  /** why it is not `ok` — names, never values */
  issues: string[];
  reach: ReachSummary | null;
  secrets: string[];
  variables: string[];
  /** the owner's per-tool policy, by name */
  tools: ConnectionToolRow[];
  offer_to_agents: boolean;
  used_by: ConnectionUser[];
  /** the newest check anyone ran, or null for never */
  last_checked: LastChecked | null;
}

/**
 * One config field of a connection type, as the app renders it (§2.7: the
 * app renders a known service's form from these — no per-service Swift).
 * KINDS ONLY: an `oauth` field says it is one and nothing of its client; a
 * `secret` field has no default by schema, and a value never has a place here.
 */
export interface ConnectionTypeField {
  key: string;
  kind: FieldKind;
  label: string;
  help: string | null;
  required: boolean;
  /** `text`, `url` and `choice` may carry one — never `secret` (the schema refuses it) */
  default?: string | undefined;
  /** `choice` only */
  choices?: Array<{ value: string; label: string }> | undefined;
}

/**
 * One installed connection type — what *Add Connection* offers once the type
 * is chosen (screen 9 §10.5, T6-13b): the unit's name, a title a person reads,
 * whether it is the product's or the owner's extension, what it provides, how
 * a connection of it is reached and signs in, and its fields. Built from the
 * registry every read path loads, so a type an extension adds or replaces
 * appears here as it does everywhere (§2.7's overlay).
 */
export interface ConnectionTypeSummary {
  name: string;
  /** the manifest's description up to its first dash or full stop, or the name */
  title: string;
  description: string | null;
  origin: UnitOrigin;
  provides: ConnectionType;
  transports: ReachClass[];
  /** the sign-in schemes it declares; null when it declares none (any but `basic`) */
  auth: AuthScheme[] | null;
  capabilities: string[];
  fields: ConnectionTypeField[];
  /** the tools it declares, with the group each keeps */
  tools: Array<{ name: string; group: ToolGroup }>;
}

/** One connection, in full: the row, where its file is, and what its provider's unit declares. */
export interface ConnectionDetail extends ConnectionRow {
  /** instance-relative — `.metistry/connections/<name>.yaml` */
  file: string;
  provider_unit: {
    name: string;
    origin: UnitOrigin;
    provides: ConnectionType;
    capabilities: string[];
    implementation: string;
    sync: string | null;
    /** the tools the type declares, with the group each keeps */
    tools: Array<{ name: string; group: ToolGroup }>;
    /** the same unit as *Add Connection* sees it — its fields, by kind (T6-13b) */
    type: ConnectionTypeSummary;
  } | null;
}

/** A field as the wire carries it: its kind and shape, never a value. */
export function describeConnectionField(f: ConnectionField): ConnectionTypeField {
  const out: ConnectionTypeField = { key: f.key, kind: f.kind, label: f.label, help: f.help ?? null, required: f.required };
  if ((f.kind === "text" || f.kind === "url" || f.kind === "choice") && f.default !== undefined) out.default = f.default;
  if (f.kind === "choice") out.choices = f.options.map((o) => ({ value: o.value, label: o.label }));
  return out;
}

/** `Linear — the issues assigned to you…` → `Linear`; no description → the name. */
export function connectionTypeTitle(m: Pick<ConnectionTypeManifest, "name" | "description">): string {
  const text = (m.description ?? "").trim();
  const cut = text.search(/\s+[—–-]\s+|[.:]\s|[.:]$/);
  const title = (cut === -1 ? text : text.slice(0, cut)).trim();
  return title.length > 0 && title.length <= 80 ? title : m.name;
}

/** One installed connection type, as `GET /api/connections` serves it under `types`. */
export function describeConnectionType(unit: RegistryUnit<ConnectionTypeManifest>): ConnectionTypeSummary {
  const m = unit.manifest;
  return {
    name: unit.name,
    title: connectionTypeTitle(m),
    description: m.description ?? null,
    origin: unit.origin,
    provides: m.provides,
    transports: [...m.transports],
    auth: m.auth ? [...m.auth] : null,
    capabilities: [...m.capabilities],
    fields: m.fields.map(describeConnectionField),
    tools: Object.entries(m.tools)
      .map(([n, t]) => ({ name: n, group: t.group }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/** Every installed connection type, sorted by name — seed and extensions through one registry, a skipped manifest absent (its reason is doctor's). */
export function describeConnectionTypes(types: Registry<ConnectionTypeManifest>): ConnectionTypeSummary[] {
  return types.units().map(describeConnectionType);
}

export interface DescribeOptions {
  /** asks whether THIS instance's Keychain holds an item — never a value. Absent: presence unknown, and nothing is said about it */
  presence?: SecretPresence | undefined;
  /** `scheduled.yaml`, for *used by*. Default: the catalog's */
  scheduled?: Scheduled | null | undefined;
  /** connection name → the agents and crews granted it, from the host's registry (revoked and pending rows already left out). Absent: none are known, and none are listed */
  granted?: ReadonlyMap<string, readonly ConnectionUser[]> | undefined;
  /** connection name → its last check. Default: read from the instance's state directory (`stamps.ts`) when the catalog names one */
  checks?: ReadonlyMap<string, LastChecked> | undefined;
}

function reachOf(entry: ConnectionEntry): ReachSummary | null {
  const c = entry.connection;
  if (!c) return null;
  const { http, command, path, imap } = c.reach;
  if (imap) return { class: "imap", host: imap.host, port: imap.port, security: imap.security, auth: "basic" };
  if (http) return { class: "http", url: http.url, auth: http.auth.scheme, headers: Object.keys(http.headers).sort(), header_secrets: headerSecrets(http.headers), query: Object.keys(http.query).sort(), timeout_s: http.timeout_s ?? null };
  if (command) return { class: "command", command: command.command, args: [...command.args], cwd: command.cwd ?? null, env: Object.keys(command.env).sort(), runs_on: command.runs_on };
  if (path) return { class: "path", path: path.path, include: [...path.include], skip: [...path.skip], watch: path.watch };
  return null;
}

/** Each header with the secrets its value names, sorted by header — a header per secret lists one each. */
function headerSecrets(headers: Record<string, string>): HeaderSecrets[] {
  return Object.keys(headers)
    .sort()
    .map((header) => ({ header, secrets: [...secretRefsIn(headers[header]!).names].sort() }));
}

/**
 * Who reads `name`: the syncs `scheduled.yaml` names it for (and the sync its
 * provider declares when that sync reads it — `syncReaders`, the rule the sync
 * itself opens by), then the agents and crews granted it. A grant reaches only
 * a connection the owner has offered to agents (core's `mayConnection`), so an
 * unoffered connection's grants are not "use".
 */
function usersOf(name: string, offered: boolean, scheduled: Scheduled | null | undefined, entries: readonly ConnectionEntry[], granted: DescribeOptions["granted"]): ConnectionUser[] {
  const syncs = (syncReaders({ entries, scheduled }).get(name) ?? []).map((sync) => ({ kind: "sync" as const, name: sync }));
  const holders = offered ? [...(granted?.get(name) ?? [])].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)) : [];
  return [...syncs, ...holders];
}

/** What the caller can add to a file's own verdict: missing variables and secret items (absent), grants and hosts the door would refuse (failed). */
async function runtimeIssues(entry: ConnectionEntry, catalog: ConnectionCatalog, opts: DescribeOptions): Promise<{ absent: string[]; failed: string[] }> {
  const c = entry.connection!;
  const absent: string[] = [];
  const failed: string[] = [];

  const usedVariables = new Set<string>();
  for (const { value } of typedValues(c)) for (const n of variableRefsIn(value).names) usedVariables.add(n);
  for (const n of [...usedVariables].sort()) {
    if (!catalog.variables.ok) absent.push(`variables.yaml does not load, so {{ variable.${n} }} cannot be filled — ${catalog.variables.message}`);
    else if (!Object.hasOwn(catalog.variables.file.variables, n)) absent.push(`variable ${n} is not set — \`metistry variables set ${n} <value>\``);
  }

  if (c.secrets.length > 0 && !catalog.secrets.ok) {
    failed.push(`secrets.yaml does not load, so none of ${c.secrets.join(", ")} may be used — ${catalog.secrets.message}`);
    return { absent, failed };
  }
  const file = catalog.secrets.ok ? catalog.secrets.file : { secrets: {} };
  const grantee = connectionGrantee(c.name);
  const envSecrets = new Set<string>();
  for (const v of Object.values(c.reach.command?.env ?? {})) for (const n of secretRefsIn(v).names) envSecrets.add(n);
  // an OAuth connection's token secret is filled by signing in, not by hand
  let signIn: string | undefined;
  try {
    signIn = c.reach.http?.auth.scheme === "oauth" ? oauthClientOf(entry).tokenSecret : undefined;
  } catch {
    signIn = undefined; // why it cannot sign in is the dial's to say
  }
  for (const n of c.secrets) {
    if (opts.presence && !(await opts.presence.has(n))) {
      absent.push(n === signIn ? `${c.name} is not signed in yet — \`metistry connections authorize ${c.name}\`` : `secret ${n} has no item in this instance's Keychain — \`metistry secrets set ${n}\``);
    }
    const mode = secretGrant(file, n, grantee);
    if (mode === "off") failed.push(`secrets.yaml does not grant ${n} to ${grantee} — \`metistry secrets grant ${n} ${grantee} on\``);
    else if (mode === "ask" && envSecrets.has(n)) failed.push(`${n} is Ask First for ${grantee}, but a command's environment is filled once, when it starts — grant it on`);
  }

  // an HTTP MCP connection, or one reached through generated tools: every secret its
  // requests carry must be allowed to go where it dials — and an OAuth sign-in's to
  // the token endpoint too (and a client id of your own to the authorize page)
  if ((c.type === "mcp" || isGeneratedType(c.type)) && c.reach.http && entry.provider?.manifest.implementation.kind !== "builtin" && absent.length === 0) {
    try {
      const plan = planHttp(entry, catalog.variables);
      const dest = egressDestination(plan.url)?.entry;
      const needs = new Map<string, Set<string>>();
      const need = (n: string, host: string | undefined) => {
        if (host) needs.set(n, new Set([...(needs.get(n) ?? []), host]));
      };
      for (const v of Object.values(plan.headers)) for (const n of secretRefsIn(v).names) need(n, dest);
      if (plan.oauth) {
        const tokenHost = egressDestination(plan.oauth.tokenUrl)?.entry;
        for (const n of oauthSecretNames(plan.oauth)) need(n, tokenHost);
        if (plan.oauth.clientId.kind === "secret") need(plan.oauth.clientId.name, egressDestination(plan.oauth.authorizeUrl)?.entry);
      }
      for (const [n, want] of [...needs].sort(([a], [b]) => a.localeCompare(b))) {
        const hosts = Object.hasOwn(file.secrets, n) ? file.secrets[n]!.hosts : [];
        const missing = [...want].filter((h) => !hosts.includes(h)).sort();
        if (missing.length) failed.push(`${n} may not be sent to ${missing.join(", ")} — it is not on the secret's *Sent only to* list (\`metistry secrets hosts ${n} ${[...hosts, ...missing].join(" ")}\`)`);
      }
    } catch (err) {
      if (err instanceof ConnectionRefused && err.code !== "not_built") failed.push(err.message);
    }
  }
  // a connection a sync reads over HTTP (a builtin provider, T4-24): the same question of its auth and headers
  const http = c.reach.http;
  if (c.type !== "mcp" && http && entry.provider?.manifest.implementation.kind === "builtin" && absent.length === 0) {
    const dest = egressDestination(http.url)?.entry;
    const carried = new Set<string>();
    if ("secret" in http.auth) carried.add(http.auth.secret);
    for (const v of Object.values(http.headers)) for (const n of secretRefsIn(v).names) carried.add(n);
    for (const n of [...carried].sort()) {
      const hosts = Object.hasOwn(file.secrets, n) ? file.secrets[n]!.hosts : [];
      if (dest && !hosts.includes(dest)) failed.push(`${n} may not be sent to ${dest} — it is not on the secret's *Sent only to* list (\`metistry secrets hosts ${n} ${[...hosts, dest].join(" ")}\`)`);
    }
  }
  // an IMAP mailbox (T4-15): the app password must be allowed to go to its exact host:port — what the socket guard refuses, said ahead of time
  const imap = c.reach.imap;
  if (imap && absent.length === 0) {
    const dest = socketDestination(imap.host, imap.port, imap.security === "tls").entry;
    const hosts = Object.hasOwn(file.secrets, imap.secret) ? file.secrets[imap.secret]!.hosts : [];
    if (!hosts.includes(dest)) failed.push(`${imap.secret} may not be sent to ${dest} — it is not on the secret's *Sent only to* list (\`metistry secrets hosts ${imap.secret} ${[...hosts, dest].join(" ")}\`)`);
  }
  return { absent, failed };
}

/** One row. */
export async function describeConnection(entry: ConnectionEntry, catalog: ConnectionCatalog, opts: DescribeOptions = {}): Promise<ConnectionRow> {
  const checks = opts.checks ?? (await readCheckStamps(catalog.baseDir));
  const c = entry.connection;
  if (!c || entry.status === "failed") {
    // the file broke a rule: its name, its status and why — nothing it holds
    return {
      name: entry.name,
      type: null,
      provider: null,
      description: null,
      status: "failed",
      issues: [...entry.issues],
      reach: null,
      secrets: [],
      variables: [],
      tools: [],
      offer_to_agents: false,
      used_by: usersOf(entry.name, false, opts.scheduled ?? catalog.scheduled, catalog.entries, opts.granted),
      last_checked: checks.get(entry.name) ?? null,
    };
  }
  let status: ConnectionStatus = entry.status;
  const issues = [...entry.issues];
  if (entry.status === "ok") {
    const extra = await runtimeIssues(entry, catalog, opts);
    if (extra.failed.length > 0) status = "failed";
    else if (extra.absent.length > 0) status = "absent";
    issues.push(...extra.failed, ...extra.absent);
  }
  return {
    name: c.name,
    type: c.type,
    provider: c.provider,
    description: c.description ?? null,
    status,
    issues,
    reach: reachOf(entry),
    secrets: [...c.secrets],
    variables: [...c.variables],
    tools: Object.entries(c.tools)
      .map(([name, p]) => ({ name, group: p.group, mode: p.mode }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    offer_to_agents: c.offer_to_agents,
    used_by: usersOf(c.name, c.offer_to_agents, opts.scheduled ?? catalog.scheduled, catalog.entries, opts.granted),
    last_checked: checks.get(c.name) ?? null,
  };
}

/** Every row, sorted by name. */
export async function describeConnections(catalog: ConnectionCatalog, opts: DescribeOptions = {}): Promise<ConnectionRow[]> {
  const rows: ConnectionRow[] = [];
  const shared = { ...opts, checks: opts.checks ?? (await readCheckStamps(catalog.baseDir)) };
  for (const e of [...catalog.entries].sort((a, b) => a.name.localeCompare(b.name))) rows.push(await describeConnection(e, catalog, shared));
  return rows;
}

/** One connection in full, or undefined when there is no such file. `relFile` is how the caller spells its path (instance-relative). */
export async function describeConnectionDetail(name: string, catalog: ConnectionCatalog, relFile: string, opts: DescribeOptions = {}): Promise<ConnectionDetail | undefined> {
  const entry = catalog.entries.find((e) => e.name === name);
  if (!entry) return undefined;
  const row = await describeConnection(entry, catalog, opts);
  const unit = row.status !== "failed" || entry.connection ? entry.provider : null;
  return {
    ...row,
    file: relFile,
    provider_unit:
      unit && row.type !== null
        ? {
            name: unit.name,
            origin: unit.origin,
            provides: unit.manifest.provides,
            capabilities: [...unit.manifest.capabilities],
            implementation: unit.manifest.implementation.kind,
            sync: unit.manifest.sync ?? null,
            tools: Object.entries(unit.manifest.tools)
              .map(([n, t]) => ({ name: n, group: t.group }))
              .sort((a, b) => a.name.localeCompare(b.name)),
            type: describeConnectionType(unit),
          }
        : null,
  };
}
