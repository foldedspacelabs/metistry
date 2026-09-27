// connections_list / connections_call — the proxy's lazy pair (plan §2.6,
// C115; T4-8b). Agents reach the owner's connections through these two
// tools and nothing else: one lists what the caller was lent, the other calls
// one tool of one connection. The upstream's own tool definitions are never
// in this bridge's `tools/list` — they are fetched on demand by
// `connections_list { connection }` — so a connection with forty tools costs
// the eager surface nothing (the "lazy" in the name; docs/research/
// 2026-08-tool-discovery.md).
//
// The bridge owns the gate and the record; the HOST owns the connection.
// `ConnectionsProxy` is injected (Metistry's console hands in
// `@foldedspacelabs/metistry-connections`' pooled client and its listing), so
// this package imports no connection file, no Keychain and no instance
// config (CLAUDE.md's packages rule). What is enforced HERE, at the tool:
//
//   * **Who may reach a connection** is `may(principal, "act", {kind:
//     "connection"})` — core's `mayConnection`: a crew needs its manifest's
//     `connections` group AND a grant; an agent needs the grant; either needs
//     the owner to have offered the connection to agents. A connection the
//     caller cannot reach answers exactly like one that does not exist.
//   * **Which tools run in this release**: a connection's Reads set to Allow
//     (`group: reads`, `mode: on`). Never (`off`) and an unlisted tool are
//     "no such tool" — refused at the proxy and not offered at all (screen
//     09 §3.2). Ask First, and every tool that changes things or starts an
//     agent, is refused here with the sentence saying so: approving a call
//     is preview-then-confirm, which arrives with T4-9. The proxy's own
//     pool refuses the same modes again before it dials (defence in depth).
//   * **The caller's bearer never goes upstream.** It is handed to the proxy
//     only so a call whose arguments carry it is refused; the proxy's
//     transport is built from the connection file and nothing else.
//   * **Every call is one `runs` row of kind `connection_call`** (server.ts's
//     `wrap`), with the connection, the upstream tool and the secret NAMES the
//     call carried — refusals included — read back by the `connection_calls`
//     named query.
//
// Absent a proxy, both tools answer `not_available` (degrades: absent),
// uniform with knowledge_read, artifact_* and queries_*.

import { z } from "zod";
import { EgressRefused, NO_SUCH_CONNECTION, may, type ToolGroup, type ToolMode } from "@foldedspacelabs/metistry-core";
import { done, fail, refuse, type Outcome } from "./outcome.js";
import { principalOf } from "./principal.js";
import type { AgentPrincipal } from "./types.js";

export const CONNECTIONS_TOOL_NAMES = ["connections_list", "connections_call"] as const;
export type ConnectionsToolName = (typeof CONNECTIONS_TOOL_NAMES)[number];

/** The server's registration function, narrowed to these names. */
export type Register = <S extends z.ZodRawShape>(name: ConnectionsToolName, description: string, inputSchema: S, body: (args: z.infer<z.ZodObject<S>>) => Promise<Outcome>) => void;

/** One tool of a connection, as the owner's policy says it (the connection file's `tools:`). */
export interface ProxiedToolPolicy {
  name: string;
  group: ToolGroup;
  mode: ToolMode;
}

/**
 * One connection, as far as the proxy's gate needs it — a structural subset
 * of `@foldedspacelabs/metistry-connections`' `ConnectionRow`, so a host can
 * hand its listing in unchanged. Reading it never dials.
 */
export interface ProxiedConnection {
  name: string;
  type: string | null;
  description: string | null;
  /** `ok` | `failed` | `absent` — the listing's verdict before any call */
  status: string;
  /** the owner's one switch: may agents reach it through the proxy at all */
  offer_to_agents: boolean;
  tools: readonly ProxiedToolPolicy[];
}

/** One upstream tool's definition, fetched on demand — the pool's `ListedTool`. */
export interface ProxiedToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  group: ToolGroup;
  mode: ToolMode;
}

/** What one call returns — the pool's `CallOutcome`: content redacted, secret NAMES only. */
export interface ProxiedCallOutcome {
  content: unknown[];
  structuredContent?: unknown;
  isError: boolean;
  secrets: string[];
}

/**
 * The host's connections, injected. `@foldedspacelabs/metistry-connections`'
 * `ConnectionPool` satisfies `tools` and `call`; `list` is its
 * `describeConnections` over the instance's catalog.
 */
export interface ConnectionsProxy {
  /** Every connection the host holds, with the owner's per-tool policy. Never dials. */
  list(): Promise<readonly ProxiedConnection[]>;
  /** Dial (or reuse) one connection and return its listed, not-Never tools with the upstream's definitions. */
  tools(connection: string): Promise<readonly ProxiedToolDefinition[]>;
  /** Call one tool. `caller.bearer` is for refusing a call that carries it — never sent upstream. */
  call(req: { connection: string; tool: string; args: Record<string, unknown>; caller?: { bearer?: string | undefined } | undefined }): Promise<ProxiedCallOutcome>;
}

const NOT_AVAILABLE = "connections are not configured in this deployment (the console serves the instance's .metistry/connections/ through its pooled client)";

/** Whether this release runs a tool through the proxy: a Read, set to Allow. Everything else waits for preview-then-confirm (T4-9). */
export function servedThisRelease(t: { group: ToolGroup; mode: ToolMode }): boolean {
  return t.group === "reads" && t.mode === "on";
}

/** The one answer for a tool the caller will not be offered — unlisted, or at Never — whatever the reason. */
export const NO_SUCH_TOOL = (connection: string, tool: string): string => `no such tool: ${connection}/${tool}`;

/** The sentence for a tool that exists and is lent, but does not run through the proxy in this release. */
function notServed(connection: string, t: ProxiedToolPolicy): string {
  const why = t.mode === "ask" ? "is set to Ask First" : t.group === "starts_agent" ? "starts an agent" : "changes things";
  return `${t.name} on ${connection} ${why} — this release runs a connection's Reads set to Allow and nothing else; a call the owner approves first arrives with preview-then-confirm. Report what you needed with requests_create instead of retrying.`;
}

/** The pool's refusal, duck-typed so this package need not import the connections package (the codes are its closed set). */
interface RefusalLike {
  name: "ConnectionRefused";
  code: string;
  message: string;
}
function isConnectionRefused(err: unknown): err is RefusalLike {
  return err instanceof Error && err.name === "ConnectionRefused" && typeof (err as { code?: unknown }).code === "string";
}

/** What the audit row keeps of a failure: the redacted message, clipped. The wire gets the code and a sentence with no detail. */
function detailOf(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  return m.length > 500 ? `${m.slice(0, 500)}…` : m;
}

/**
 * A failure from the proxy as this bridge's outcome. Every message on the
 * wire is built here from names the caller already sent — never the pool's
 * own sentence, which names secrets, variables and hosts that are the
 * owner's business, not a borrower's. The pool's sentence goes to the
 * `runs` row (`meta.detail`), where the owner reads it.
 */
function fromProxyError(connection: string, tool: string | undefined, err: unknown): Outcome {
  const detail = { detail: detailOf(err) };
  if (isConnectionRefused(err)) {
    const meta = { ...detail, refusal: err.code };
    switch (err.code) {
      case "unknown_connection":
        return fail("not_found", NO_SUCH_CONNECTION(connection), meta);
      case "tool_not_listed":
      case "tool_off":
        return fail("not_found", NO_SUCH_TOOL(connection, tool ?? ""), meta);
      case "needs_approval":
        return fail("forbidden", notServed(connection, { name: tool ?? "", group: "reads", mode: "ask" }), meta);
      case "caller_credential":
        return fail("invalid_request", "the arguments carry your own credential — it is never sent upstream; remove it and call again", meta);
      default:
        return fail("not_available", `${connection} cannot be reached right now (${err.code}) — the owner sees why in Connections`, meta);
    }
  }
  if (err instanceof EgressRefused) return fail("not_available", `${connection} cannot be reached right now (${err.code}) — the owner sees why in Connections`, { ...detail, refusal: err.code });
  return fail("not_available", `${connection} did not answer — the owner sees why in Connections`, detail);
}

export function registerConnectionsTools(reg: Register, proxy: ConnectionsProxy | undefined, principal: AgentPrincipal, callerBearer?: string | undefined): void {
  const p = principalOf(principal);

  /** The connections this caller may reach, and the one it named — or the uniform "no such connection". */
  async function reachable(door: "connections_list" | "connections_call", name: string): Promise<{ ok: true; connection: ProxiedConnection } | { ok: false; outcome: Outcome }> {
    const all = await proxy!.list();
    const c = all.find((x) => x.name === name);
    // A name that is not configured asks `may` as a connection nobody
    // offered, so it takes exactly the path a real, un-lent one takes.
    const decided = may(p, "act", { kind: "connection", door, name, offered: c?.offer_to_agents === true });
    if (!decided.ok) return { ok: false, outcome: refuse(decided, { connection: name }) };
    if (!c) return { ok: false, outcome: fail("not_found", NO_SUCH_CONNECTION(name), { connection: name }) };
    return { ok: true, connection: c };
  }

  reg(
    "connections_list",
    "Services the owner lent you through Metistry: each connection, its status and callable tools. With `connection`: those tools' descriptions and schemas, for connections_call.",
    { connection: z.string().min(1).max(64).optional() },
    async (a) => {
      const admitted = may(p, "act", { kind: "tool", name: "connections_list" });
      if (!admitted.ok) return refuse(admitted);
      if (!proxy) return fail("not_available", NOT_AVAILABLE);
      if (a.connection === undefined) {
        const lent = (await proxy.list()).filter((c) => may(p, "act", { kind: "connection", door: "connections_list", name: c.name, offered: c.offer_to_agents }).ok);
        const connections = lent.map((c) => ({
          name: c.name,
          type: c.type,
          ...(c.description ? { description: c.description } : {}),
          status: c.status,
          tools: c.tools.filter(servedThisRelease).map((t) => t.name),
        }));
        return done({ connections }, { count: connections.length });
      }
      const r = await reachable("connections_list", a.connection);
      if (!r.ok) return r.outcome;
      let defs: readonly ProxiedToolDefinition[];
      try {
        defs = await proxy.tools(a.connection);
      } catch (err) {
        return fromProxyError(a.connection, undefined, err);
      }
      const tools = defs.filter(servedThisRelease).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
      return done({ connection: a.connection, tools }, { connection: a.connection, tools: tools.length });
    },
  );

  reg(
    "connections_call",
    "Call one tool of a connection lent to you (see connections_list). Metistry holds the credential.",
    {
      connection: z.string().min(1).max(64),
      tool: z.string().min(1).max(128),
      arguments: z.record(z.string(), z.unknown()).optional(),
    },
    async (a) => {
      const meta = { connection: a.connection, connection_tool: a.tool };
      const admitted = may(p, "act", { kind: "tool", name: "connections_call" });
      if (!admitted.ok) return refuse(admitted, meta);
      if (!proxy) return fail("not_available", NOT_AVAILABLE, meta);
      const r = await reachable("connections_call", a.connection);
      if (!r.ok) return r.outcome;
      const policy = r.connection.tools.find((t) => t.name === a.tool);
      if (!policy || policy.mode === "off") return fail("not_found", NO_SUCH_TOOL(a.connection, a.tool), meta);
      if (!servedThisRelease(policy)) return fail("forbidden", notServed(a.connection, policy), { ...meta, group: policy.group, mode: policy.mode });
      let out: ProxiedCallOutcome;
      try {
        out = await proxy.call({ connection: a.connection, tool: a.tool, args: a.arguments ?? {}, ...(callerBearer ? { caller: { bearer: callerBearer } } : {}) });
      } catch (err) {
        const o = fromProxyError(a.connection, a.tool, err);
        return o.ok ? o : { ...o, meta: { ...meta, ...(o.meta ?? {}) } };
      }
      return done(
        { connection: a.connection, tool: a.tool, content: out.content, ...(out.structuredContent !== undefined ? { structuredContent: out.structuredContent } : {}), ...(out.isError ? { isError: true } : {}) },
        { ...meta, is_error: out.isError, secrets: [...out.secrets] },
      );
    },
  );
}
