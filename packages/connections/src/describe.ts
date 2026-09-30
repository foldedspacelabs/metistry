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
// *Used by* is what reads it today: the syncs in `scheduled.yaml` that name
// it. Agents reach a connection through the lazy pair and their grants
// (T4-8b); until then nothing else uses one, and an empty list is the true
// answer (screen 9: *Nobody yet* is a real value).

import {
  egressDestination,
  secretGrant,
  secretRefsIn,
  socketDestination,
  variableRefsIn,
  type AuthScheme,
  type ConnectionType,
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
import { syncReaders } from "./sync.js";

/** Who reads a connection. Syncs today; agents and the assistant once the lazy pair lands (T4-8b). */
export interface ConnectionUser {
  kind: "sync";
  name: string;
}

/** How Metistry reaches it — names only for headers, query parameters and environment variables. */
export type ReachSummary =
  | { class: "http"; url: string; auth: AuthScheme; headers: string[]; query: string[]; timeout_s: number | null }
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
  } | null;
}

export interface DescribeOptions {
  /** asks whether THIS instance's Keychain holds an item — never a value. Absent: presence unknown, and nothing is said about it */
  presence?: SecretPresence | undefined;
  /** `scheduled.yaml`, for *used by*. Default: the catalog's */
  scheduled?: Scheduled | null | undefined;
}

function reachOf(entry: ConnectionEntry): ReachSummary | null {
  const c = entry.connection;
  if (!c) return null;
  const { http, command, path, imap } = c.reach;
  if (imap) return { class: "imap", host: imap.host, port: imap.port, security: imap.security, auth: "basic" };
  if (http) return { class: "http", url: http.url, auth: http.auth.scheme, headers: Object.keys(http.headers).sort(), query: Object.keys(http.query).sort(), timeout_s: http.timeout_s ?? null };
  if (command) return { class: "command", command: command.command, args: [...command.args], cwd: command.cwd ?? null, env: Object.keys(command.env).sort(), runs_on: command.runs_on };
  if (path) return { class: "path", path: path.path, include: [...path.include], skip: [...path.skip], watch: path.watch };
  return null;
}

/** The syncs that read `name`: those `scheduled.yaml` names it for, and the sync its provider declares when that sync reads it (`syncReaders`, the rule the sync itself opens by). */
function usersOf(name: string, scheduled: Scheduled | null | undefined, entries: readonly ConnectionEntry[]): ConnectionUser[] {
  return (syncReaders({ entries, scheduled }).get(name) ?? []).map((sync) => ({ kind: "sync" as const, name: sync }));
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
      used_by: usersOf(entry.name, opts.scheduled ?? catalog.scheduled, catalog.entries),
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
    used_by: usersOf(c.name, opts.scheduled ?? catalog.scheduled, catalog.entries),
  };
}

/** Every row, sorted by name. */
export async function describeConnections(catalog: ConnectionCatalog, opts: DescribeOptions = {}): Promise<ConnectionRow[]> {
  const rows: ConnectionRow[] = [];
  for (const e of [...catalog.entries].sort((a, b) => a.name.localeCompare(b.name))) rows.push(await describeConnection(e, catalog, opts));
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
          }
        : null,
  };
}
