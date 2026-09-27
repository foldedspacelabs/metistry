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

/** An MCP server over Streamable HTTP. `headers` hold `{{ secret.x }}` references, never values. */
export interface HttpDial {
  kind: "http";
  url: string;
  /** scheme://host[:port] — the only place this connection's requests may go */
  origin: string;
  headers: Record<string, string>;
  /** per request; undefined = the pool's default */
  timeoutMs: number | undefined;
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

/** The types this release dials, and where the others arrive — the refusal names the ticket rather than pretending. */
const NOT_DIALLED: Readonly<Record<string, string>> = {
  agent: "an agent connection is dispatched to, not dialled — targets become agent connections in T4-11",
  api: "tools generated for an API connection arrive with T4-10",
  feed: "tools generated for a feed arrive with T4-10",
  files: "tools generated for a files connection arrive with T4-10",
  calendar: "a calendar is read by its provider's sync (T4-12…T4-14), not dialled as MCP",
  mail: "mail is read by its provider (T4-15), not dialled as MCP",
  tracker: "a tracker is read by its provider's sync (T4-24), not dialled as MCP",
};

/** A connection's plan, or the refusal that stops it before anything is dialled. `entry` must be `ok`. */
export function planDial(entry: ConnectionEntry, variables: Parsed<VariablesFile>, baseDir?: string | undefined): DialPlan {
  const c = entry.connection;
  if (!c || entry.status !== "ok") throw new ConnectionRefused("not_ready", entry.name, entry.issues.join("; ") || "the connection is not ready");
  if (c.type !== "mcp") throw new ConnectionRefused("not_built", c.name, `${c.type}: ${NOT_DIALLED[c.type] ?? "not dialled in this release"}`);
  if (entry.provider?.manifest.implementation.kind === "builtin") {
    throw new ConnectionRefused("not_built", c.name, `provider ${entry.provider.name} is product code (builtin module ${entry.provider.manifest.implementation.module}), not an MCP server`);
  }

  const vars: VariablesFile = variables.ok ? variables.file : { variables: {} };
  const fill = (value: string, where: string): string => {
    const r = fillVariableRefs(value, vars);
    if (r.ok) return r.text;
    const why = variables.ok ? r.message : `variables.yaml does not load (${variables.message}), so ${r.missing.map((n) => `{{ variable.${n} }}`).join(", ") || "no variable"} can be filled`;
    throw new ConnectionRefused("variable", c.name, `${where}: ${why}`);
  };

  const { http, command } = c.reach;
  if (http) {
    const auth = http.auth;
    if (auth.scheme === "basic" || auth.scheme === "oauth") {
      throw new ConnectionRefused("not_built", c.name, `${auth.scheme} sign-in arrives with T4-10 — this release sends none, a bearer, or an API key header`);
    }
    let url: URL;
    try {
      url = new URL(fill(http.url, "reach.http.url"));
    } catch {
      throw new ConnectionRefused("variable", c.name, "reach.http.url: does not fill to a URL");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new ConnectionRefused("variable", c.name, `reach.http.url: ${url.protocol} is not http(s)`);
    if (url.username || url.password) throw new ConnectionRefused("variable", c.name, "reach.http.url: a URL never carries credentials");
    for (const [k, v] of Object.entries(http.query)) url.searchParams.append(k, fill(v, `reach.http.query.${k}`));
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(http.headers)) headers[k.toLowerCase()] = fill(v, `reach.http.headers.${k}`);
    // the shortcuts write a reference, never a value: guardedFetch fills it for a listed host
    if (auth.scheme === "bearer") headers.authorization = `Bearer {{ secret.${auth.secret} }}`;
    if (auth.scheme === "api_key") headers[auth.header.toLowerCase()] = `{{ secret.${auth.secret} }}`;
    return { kind: "http", url: url.href, origin: url.origin, headers, timeoutMs: http.timeout_s !== undefined ? Math.round(http.timeout_s * 1000) : undefined };
  }
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
  throw new ConnectionRefused("not_built", c.name, "a path reach is read by the files connection's generated tools (T4-10), not dialled as MCP");
}

/** A plan's identity: a change to the file (or to what a variable holds) is a different plan, and the pool redials. */
export function planFingerprint(plan: DialPlan, extra: unknown = null): string {
  return JSON.stringify([plan, extra]);
}
