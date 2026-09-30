// From a connection file to what the pool dials — every decision that can be
// made without dialling, made here.
//
// Variables are filled HERE (`{{ variable.x }}`, core's `fillVariableRefs`,
// all or nothing): a variable is plain text agents may read, so filling it
// early is safe, and the dial plan then says exactly where a connection
// goes. Secrets are NOT: a `{{ secret.x }}` stays a reference in the plan,
// and is filled only at the moment it leaves —
//
//   http     by core's `guardedFetch`, per request, only for a host on the
//            secret's *Sent only to* list (the pool's transport fetch);
//   command  into the child's environment at spawn, only when the owner has
//            granted the secret to this connection (`secrets.yaml`), and
//            given to that one command — never to its argv, never to disk.
//
// A plan carries no value, so it is safe to print, compare and log.

import { resolve } from "node:path";
import { fillVariableRefs, type VariablesFile } from "@foldedspacelabs/metistry-core";
import type { Parsed } from "./catalog.js";
import { ConnectionRefused } from "./errors.js";
import type { ConnectionEntry } from "./load.js";
import { OAuthError, oauthClientOf, type OAuthClientPlan } from "./oauth.js";

/** An MCP server over Streamable HTTP. `headers` hold `{{ secret.x }}` references, never values. */
export interface HttpDial {
  kind: "http";
  url: string;
  /** scheme://host[:port] — the only place this connection's requests may go */
  origin: string;
  headers: Record<string, string>;
  /** per request; undefined = the pool's default */
  timeoutMs: number | undefined;
  /** Basic sign-in (a type that declares it): the header holds `Basic {{ secret.x }}`, and the door encodes `username:value` (`basicSource`) */
  basic?: { secret: string; username: string } | undefined;
  /** OAuth sign-in: the header holds `Bearer {{ secret.<token> }}`, and the door fills the ACCESS token minted from the stored refresh token (`oauthSource`) */
  oauth?: OAuthClientPlan | undefined;
}

/** An MCP server over stdio. `env` values hold `{{ secret.x }}` references, filled at spawn. */
export interface CommandDial {
  kind: "command";
  command: string;
  args: string[];
  cwd: string | undefined;
  env: Record<string, string>;
  runsOn: "host" | "container";
}

export type DialPlan = HttpDial | CommandDial;

/** The types that are not dialled as MCP, and what reaches them instead — the refusal names it rather than pretending. */
const NOT_DIALLED: Readonly<Record<string, string>> = {
  agent: "an agent connection is dispatched to, not dialled — a task is sent to it through the owner's dispatch door (POST /api/tasks/:id/dispatch), never by an agent through this proxy",
  api: "an API connection is reached through the tools Metistry generates for it (generated.ts), not dialled as MCP",
  feed: "a feed is reached through the tools Metistry generates for it (generated.ts), not dialled as MCP",
  files: "a files connection is reached through the tools Metistry generates for it (generated.ts), not dialled as MCP",
  calendar: "a calendar is read by its provider's sync (T4-12…T4-14), not dialled as MCP",
  mail: "mail is read by its provider (T4-15), not dialled as MCP",
  tracker: "a tracker is read by its provider's sync (T4-24), not dialled as MCP",
};

/** A value filler for one connection's `{{ variable.x }}` — all or nothing, naming what is missing. */
export function variableFiller(name: string, variables: Parsed<VariablesFile>): (value: string, where: string) => string {
  const vars: VariablesFile = variables.ok ? variables.file : { variables: {} };
  return (value, where) => {
    const r = fillVariableRefs(value, vars);
    if (r.ok) return r.text;
    const why = variables.ok ? r.message : `variables.yaml does not load (${variables.message}), so ${r.missing.map((n) => `{{ variable.${n} }}`).join(", ") || "no variable"} can be filled`;
    throw new ConnectionRefused("variable", name, `${where}: ${why}`);
  };
}

/**
 * An HTTP reach, planned: the URL with its variables and query filled, the
 * headers lowercased, and the auth shortcut written as a REFERENCE the door
 * fills — `Bearer {{ secret.x }}`, the service's own header, `Basic {{
 * secret.x }}` (encoded with the username inside the door), or `Bearer {{
 * secret.<token> }}` for OAuth (filled with an access token minted from the
 * stored refresh token). Used by the MCP dial and by generated tools alike.
 */
export function planHttp(entry: ConnectionEntry, variables: Parsed<VariablesFile>): HttpDial {
  const c = entry.connection;
  if (!c || entry.status !== "ok") throw new ConnectionRefused("not_ready", entry.name, entry.issues.join("; ") || "the connection is not ready");
  const http = c.reach.http;
  if (!http) throw new ConnectionRefused("not_built", c.name, "this connection is not reached over http");
  const fill = variableFiller(c.name, variables);
  const auth = http.auth;
  let url: URL;
  try {
    url = new URL(fill(http.url, "reach.http.url"));
  } catch (err) {
    if (err instanceof ConnectionRefused) throw err;
    throw new ConnectionRefused("variable", c.name, "reach.http.url: does not fill to a URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new ConnectionRefused("variable", c.name, `reach.http.url: ${url.protocol} is not http(s)`);
  if (url.username || url.password) throw new ConnectionRefused("variable", c.name, "reach.http.url: a URL never carries credentials");
  for (const [k, v] of Object.entries(http.query)) url.searchParams.append(k, fill(v, `reach.http.query.${k}`));
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(http.headers)) headers[k.toLowerCase()] = fill(v, `reach.http.headers.${k}`);
  const plan: HttpDial = { kind: "http", url: url.href, origin: url.origin, headers, timeoutMs: http.timeout_s !== undefined ? Math.round(http.timeout_s * 1000) : undefined };
  // the shortcuts write a reference, never a value: guardedFetch fills it for a listed host
  if (auth.scheme === "bearer") headers.authorization = `Bearer {{ secret.${auth.secret} }}`;
  if (auth.scheme === "api_key") headers[auth.header.toLowerCase()] = `{{ secret.${auth.secret} }}`;
  if (auth.scheme === "basic") {
    // only a type that declares basic sign-in reaches here (core's connectionIssues refuses the file otherwise); said again, not trusted
    if (!entry.provider?.manifest.auth?.includes("basic")) throw new ConnectionRefused("not_ready", c.name, "basic sign-in is accepted only by a connection type that declares it (auth: [basic])");
    // RFC 7617: the user-id cannot contain a colon — the server would split it there
    if (auth.username.includes(":") || /[\u0000-\u001f\u007f]/.test(auth.username)) throw new ConnectionRefused("not_ready", c.name, "reach.http.auth.username cannot contain a colon or a control character (RFC 7617)");
    headers.authorization = `Basic {{ secret.${auth.secret} }}`;
    plan.basic = { secret: auth.secret, username: auth.username };
  }
  if (auth.scheme === "oauth") {
    try {
      plan.oauth = oauthClientOf(entry);
    } catch (err) {
      if (err instanceof OAuthError) throw new ConnectionRefused("sign_in", c.name, err.message);
      throw err;
    }
    headers.authorization = `Bearer {{ secret.${plan.oauth.tokenSecret} }}`;
  }
  return plan;
}

/** A connection's MCP dial plan, or the refusal that stops it before anything is dialled. `entry` must be `ok`. */
export function planDial(entry: ConnectionEntry, variables: Parsed<VariablesFile>, baseDir?: string | undefined): DialPlan {
  const c = entry.connection;
  if (!c || entry.status !== "ok") throw new ConnectionRefused("not_ready", entry.name, entry.issues.join("; ") || "the connection is not ready");
  if (c.type !== "mcp") throw new ConnectionRefused("not_built", c.name, `${c.type}: ${NOT_DIALLED[c.type] ?? "not dialled in this release"}`);
  if (entry.provider?.manifest.implementation.kind === "builtin") {
    throw new ConnectionRefused("not_built", c.name, `provider ${entry.provider.name} is product code (builtin module ${entry.provider.manifest.implementation.module}), not an MCP server`);
  }
  const { http, command } = c.reach;
  if (http) return planHttp(entry, variables);
  const fill = variableFiller(c.name, variables);
  if (command) {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(command.env)) env[k] = fill(v, `reach.command.env.${k}`);
    const cwd = command.cwd !== undefined ? fill(command.cwd, "reach.command.cwd") : undefined;
    return {
      kind: "command",
      command: fill(command.command, "reach.command.command"),
      args: command.args.map((a, i) => fill(a, `reach.command.args.${i}`)),
      cwd: cwd !== undefined && baseDir !== undefined ? resolve(baseDir, cwd) : cwd,
      env,
      runsOn: command.runs_on,
    };
  }
  throw new ConnectionRefused("not_built", c.name, "a path reach is read by the files connection's generated tools, not dialled as MCP");
}

/** A plan's identity: a change to the file (or to what a variable holds) is a different plan, and the pool redials. */
export function planFingerprint(plan: DialPlan, extra: unknown = null): string {
  return JSON.stringify([plan, extra]);
}
