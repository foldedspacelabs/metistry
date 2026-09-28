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
//   * **The owner's per-tool policy decides how a tool runs** (CLAUDE.md:
//     Allow · Ask First · Never, defaulting to Ask; T4-9). Never (`off`) and
//     an unlisted tool are "no such tool" — refused at the proxy and not
//     offered at all (screen 09 §3.2). A Read set to Allow runs at once. A
//     tool that changes things or starts an agent, set to Allow, is
//     PREVIEW-THEN-CONFIRM: the first call answers a preview and a confirm
//     token, nothing dialled, and the call runs when the caller presents the
//     token with the same arguments (connection-confirm.ts). Ask First
//     answers a preview too, raises an `action` of kind `connection_call` in
//     Needs You, and runs only on the owner's Approve — which runs the
//     payload this call built and recorded, never one a caller sends later
//     (apps/console/src/actions.ts). The pool refuses Ask First again before
//     it dials unless the console says the owner approved (defence in depth).
//   * **Rate limits come from `runs`**: this caller's dialled calls and its
//     Ask First requests to one connection in the last hour, counted from the
//     rows this bridge writes (the limits are the host's, `ConnectionLimits`).
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
import {
  EgressRefused,
  NO_SUCH_CONNECTION,
  confirmTokenDigest,
  connectionCallDigest,
  describeAction,
  may,
  mintConfirmToken,
  redactSecrets,
  type Action,
  type ToolGroup,
  type ToolMode,
} from "@foldedspacelabs/metistry-core";
import { recentConnectionCalls, recordConfirm, redeemCallerToken, type ConfirmRecord, type RedeemMiss } from "./connection-confirm.js";
import { done, fail, refuse, type Outcome } from "./outcome.js";
import { principalOf, trustOf } from "./principal.js";
import type { AgentPrincipal, Db } from "./types.js";

export const CONNECTIONS_TOOL_NAMES = ["connections_list", "connections_call"] as const;
export type ConnectionsToolName = (typeof CONNECTIONS_TOOL_NAMES)[number];

/** The server's registration function, narrowed to these names. `act.runId` is this call's own `runs` row — where a preview's confirm record is kept. */
export type Register = <S extends z.ZodRawShape>(
  name: ConnectionsToolName,
  description: string,
  inputSchema: S,
  body: (args: z.infer<z.ZodObject<S>>, act: { runId?: number | string | undefined }) => Promise<Outcome>,
) => void;

/** How long a caller-confirmed preview's token redeems (eventkit's and Executor's human scale). The host passes its own (`METISTRY_CONNECTION_CONFIRM_TTL_S`). */
export const DEFAULT_CONNECTION_CONFIRM_TTL_S = 900;
/** Dialled calls one caller may make to one connection in an hour. The host passes its own (`METISTRY_CONNECTION_CALLS_PER_HOUR`). */
export const DEFAULT_CONNECTION_CALLS_PER_HOUR = 120;
/** Ask First requests one caller may raise about one connection in an hour — Needs You is the owner's attention. The host passes its own (`METISTRY_CONNECTION_ASKS_PER_HOUR`). */
export const DEFAULT_CONNECTION_ASKS_PER_HOUR = 20;

/** The host's limits on the proxy, each counted from `runs` (T4-9). */
export interface ConnectionLimits {
  confirmTtlS: number;
  callsPerHour: number;
  asksPerHour: number;
}

export const DEFAULT_CONNECTION_LIMITS: ConnectionLimits = {
  confirmTtlS: DEFAULT_CONNECTION_CONFIRM_TTL_S,
  callsPerHour: DEFAULT_CONNECTION_CALLS_PER_HOUR,
  asksPerHour: DEFAULT_CONNECTION_ASKS_PER_HOUR,
};

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
  /**
   * Call one tool. `caller.bearer` is for refusing a call that carries it —
   * never sent upstream. `approved`: the owner approved THIS call in Needs
   * You (the console's Approve sets it, and nothing on `/mcp` ever does).
   */
  call(req: {
    connection: string;
    tool: string;
    args: Record<string, unknown>;
    caller?: { bearer?: string | undefined } | undefined;
    approved?: boolean | undefined;
  }): Promise<ProxiedCallOutcome>;
}

const NOT_AVAILABLE = "connections are not configured in this deployment (the console serves the instance's .metistry/connections/ through its pooled client)";

/** Whether a tool is offered through the proxy at all: listed, and not at Never. */
export function offeredTool(t: { mode: ToolMode }): boolean {
  return t.mode !== "off";
}

/** How a tool the caller is offered runs: at once, after the caller's confirm, or after the owner's Approve. */
export type ToolRuns = "now" | "confirm" | "owner";
export function howToolRuns(t: { group: ToolGroup; mode: ToolMode }): ToolRuns {
  if (t.mode === "ask") return "owner";
  return t.group === "reads" ? "now" : "confirm";
}

/** The one answer for a tool the caller will not be offered — unlisted, or at Never — whatever the reason. */
export const NO_SUCH_TOOL = (connection: string, tool: string): string => `no such tool: ${connection}/${tool}`;

/** The one sentence for a confirm token that redeems nothing — spent, expired, or never this caller's. What happened is the audit row's (`meta.refusal`). */
const TOKEN_REFUSED = (connection: string, tool: string): string =>
  `this confirm_token does not run ${tool} on ${connection}: a token runs once, within its time, for exactly the arguments it previewed — call again without one for a fresh preview`;

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
        return fail("forbidden", `${tool ?? ""} on ${connection} is set to Ask First — it runs only when the owner approves it in Needs You`, meta);
      case "caller_credential":
        return fail("invalid_request", "the arguments carry your own credential — it is never sent upstream; remove it and call again", meta);
      default:
        return fail("not_available", `${connection} cannot be reached right now (${err.code}) — the owner sees why in Connections`, meta);
    }
  }
  if (err instanceof EgressRefused) return fail("not_available", `${connection} cannot be reached right now (${err.code}) — the owner sees why in Connections`, { ...detail, refusal: err.code });
  return fail("not_available", `${connection} did not answer — the owner sees why in Connections`, detail);
}

export interface ConnectionsToolOptions {
  /** Where the runs rows are: the rate limits are counted there, and a preview's confirm record is kept on its own row. */
  db: Db;
  limits?: ConnectionLimits | undefined;
}

export function registerConnectionsTools(reg: Register, proxy: ConnectionsProxy | undefined, principal: AgentPrincipal, callerBearer: string | undefined, opts: ConnectionsToolOptions): void {
  const p = principalOf(principal);
  const { db } = opts;
  const limits = opts.limits ?? DEFAULT_CONNECTION_LIMITS;

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

  /** The caller's own bearer in the arguments is refused before anything is recorded or dialled — the pool's `caller_credential`, asked here too because a preview dials nothing. */
  function carriesBearer(args: Record<string, unknown>): boolean {
    return callerBearer !== undefined && callerBearer.length >= 8 && JSON.stringify(args).includes(callerBearer);
  }

  /** Dial one call through the pool, after its gate has held. `meta.dialled` is what the calls limit counts. */
  async function dial(connection: string, tool: string, args: Record<string, unknown>, meta: Record<string, unknown>): Promise<Outcome> {
    let out: ProxiedCallOutcome;
    try {
      out = await proxy!.call({ connection, tool, args, ...(callerBearer ? { caller: { bearer: callerBearer } } : {}) });
    } catch (err) {
      const o = fromProxyError(connection, tool, err);
      // a refusal decided before dialling reached no upstream, so it spends none of the hour
      const dialled = !isConnectionRefused(err) && !(err instanceof EgressRefused);
      return o.ok ? o : { ...o, meta: { ...meta, ...(o.meta ?? {}), ...(dialled ? { dialled: true } : {}) } };
    }
    return done(
      { connection, tool, content: out.content, ...(out.structuredContent !== undefined ? { structuredContent: out.structuredContent } : {}), ...(out.isError ? { isError: true } : {}) },
      { ...meta, dialled: true, is_error: out.isError, secrets: [...out.secrets] },
    );
  }

  /** `rate_limited` when this caller has used its hour on this connection, else null. */
  async function overLimit(connection: string, which: "calls" | "asks", meta: Record<string, unknown>): Promise<Outcome | null> {
    const used = await recentConnectionCalls(db, principal.id, connection);
    const [n, limit, env, what] =
      which === "calls"
        ? [used.dialled, limits.callsPerHour, "METISTRY_CONNECTION_CALLS_PER_HOUR", "calls"]
        : [used.asked, limits.asksPerHour, "METISTRY_CONNECTION_ASKS_PER_HOUR", "Ask First requests"];
    if (n < limit) return null;
    return fail("rate_limited", `${n} ${what} to ${connection} in the last hour — the limit is ${limit} an hour for each caller (${env}); try again later`, {
      ...meta,
      refusal: "rate_limited",
      limit,
      used: n,
    });
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
          tools: c.tools.filter(offeredTool).map((t) => ({ name: t.name, runs: howToolRuns(t) })),
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
      const tools = defs.filter(offeredTool).map((t) => ({ name: t.name, runs: howToolRuns(t), description: t.description, inputSchema: t.inputSchema }));
      return done({ connection: a.connection, tools }, { connection: a.connection, tools: tools.length });
    },
  );

  reg(
    "connections_call",
    "Call one tool of a lent connection. A change previews first; resend it with its confirm_token.",
    {
      connection: z.string().min(1).max(64),
      tool: z.string().min(1).max(128),
      arguments: z.record(z.string(), z.unknown()).optional(),
      confirm_token: z.string().optional(), // any string: only a token this server minted redeems (connection-confirm.ts)
    },
    async (a, act) => {
      const meta: Record<string, unknown> = { connection: a.connection, connection_tool: a.tool };
      const admitted = may(p, "act", { kind: "tool", name: "connections_call" });
      if (!admitted.ok) return refuse(admitted, meta);
      if (!proxy) return fail("not_available", NOT_AVAILABLE, meta);
      const r = await reachable("connections_call", a.connection);
      if (!r.ok) return r.outcome;
      const policy = r.connection.tools.find((t) => t.name === a.tool);
      if (!policy || !offeredTool(policy)) return fail("not_found", NO_SUCH_TOOL(a.connection, a.tool), meta);
      // `tool_mode` is the owner's policy; `mode` (set below) is what this call did: call · preview · ask · confirmed
      Object.assign(meta, { group: policy.group, tool_mode: policy.mode });
      const args = a.arguments ?? {};
      const runs = howToolRuns(policy);
      const runId = Number(act.runId); // this call's own runs row (server.ts's wrap), where a preview keeps its confirm record

      // ---- a Read set to Allow: at once ------------------------------------
      if (runs === "now") {
        const limited = await overLimit(a.connection, "calls", meta);
        if (limited) return limited;
        return dial(a.connection, a.tool, args, { ...meta, mode: "call" });
      }

      // Everything else is previewed first: nothing is dialled until a
      // confirm — the caller's, or the owner's — names exactly this payload.
      if (carriesBearer(args)) {
        return fail("invalid_request", "the arguments carry your own credential — it is never sent upstream; remove it and call again", { ...meta, refusal: "caller_credential" });
      }
      const payload = { principal: principal.id, connection: a.connection, tool: a.tool, args };

      // ---- Ask First: the owner's Approve, in Needs You --------------------
      if (runs === "owner") {
        if (a.confirm_token !== undefined) {
          return fail("forbidden", `${a.tool} on ${a.connection} is set to Ask First — only the owner's Approve in Needs You runs it, never a confirm_token. Call it without one to ask.`, { ...meta, refusal: "ask_only" });
        }
        // the owner may have turned this agent's asking off (autonomy.actions.connection_call: deny)
        const asking = may(p, "propose", { kind: "action", door: "propose_action", action: "connection_call" });
        if (!asking.ok) return refuse(asking, meta);
        const limited = await overLimit(a.connection, "asks", meta);
        if (limited) return limited;
        const token = mintConfirmToken();
        const action: Action = { kind: "connection_call", args: { connection: a.connection, tool: a.tool, args, confirm_token: token } };
        const proposalId = await insertConnectionCallRequest(db, principal, action, runId, { digest: confirmTokenDigest(token), payload: connectionCallDigest(payload), mode: "ask" });
        return done(
          {
            status: "pending",
            proposal_id: proposalId,
            connection: a.connection,
            tool: a.tool,
            arguments: args,
            preview: describeAction(action),
            note: "Nothing has run. It waits for the owner in Needs You and runs only on their Approve — do not call it again.",
          },
          { ...meta, mode: "ask", proposal_id: proposalId },
        );
      }

      // ---- Changes things / Starts an agent, set to Allow: the caller's confirm
      if (a.confirm_token === undefined) {
        const token = mintConfirmToken();
        const expires = new Date(Date.now() + limits.confirmTtlS * 1000);
        await recordConfirm(db, runId, { digest: confirmTokenDigest(token), payload: connectionCallDigest(payload), mode: "on", expires_at: expires.toISOString() });
        return done(
          {
            status: "preview",
            connection: a.connection,
            tool: a.tool,
            arguments: args,
            preview: `call ${a.tool} on ${a.connection}`,
            confirm_token: token,
            expires_in_sec: limits.confirmTtlS,
            note: "Nothing has run. Call connections_call again with the same connection, tool and arguments and this confirm_token to run it.",
          },
          { ...meta, mode: "preview" },
        );
      }
      const limited = await overLimit(a.connection, "calls", meta);
      if (limited) return limited;
      const redeemed = await redeemCallerToken(db, principal.id, confirmTokenDigest(a.confirm_token), limits.confirmTtlS);
      if (!redeemed.ok) return tokenRefused(a.connection, a.tool, redeemed.miss, meta);
      // The token is spent now, whatever follows: a mismatch is refused and
      // never retried with the same token (eventkit's rule).
      if (redeemed.payload !== connectionCallDigest(payload)) return tokenRefused(a.connection, a.tool, "other_payload", { ...meta, preview_run: redeemed.runId });
      return dial(a.connection, a.tool, args, { ...meta, mode: "confirmed", preview_run: redeemed.runId });
    },
  );
}

/** A confirm token that runs nothing: `forbidden` when it was an Ask First token (that is the owner's), `conflict` otherwise. */
function tokenRefused(connection: string, tool: string, miss: RedeemMiss | "other_payload", meta: Record<string, unknown>): Outcome {
  if (miss === "ask_only") {
    return fail("forbidden", `${tool} on ${connection} waits for the owner's Approve in Needs You — a confirm token cannot run it`, { ...meta, refusal: "ask_only" });
  }
  return fail("conflict", TOKEN_REFUSED(connection, tool), { ...meta, refusal: `confirm_${miss}` });
}

/**
 * One pending `action` row of kind `connection_call` — the Needs You request
 * an Ask First call raises. The payload is BUILT HERE, from the call the
 * proxy just gated, and nowhere else: `propose_action` refuses this kind, so
 * no caller writes one. `action` is stored as it will run — redacting its
 * arguments would change the call the owner approves — and every other field
 * is redacted as every queued payload is (§4.3 default 3). `preview_run` is
 * the runs row that holds the confirm record, which the console's Approve
 * redeems.
 *
 * ONE statement writes both the row and the confirm record that names it, so
 * there is no moment when the owner can see a request whose token does not
 * yet redeem.
 */
async function insertConnectionCallRequest(db: Db, principal: AgentPrincipal, action: Action & { kind: "connection_call" }, previewRun: number, confirm: ConfirmRecord): Promise<number> {
  const rest = redactSecrets({
    title: describeAction(action),
    provenance: { agent: principal.id, via: "connections_call", submitted_at: new Date().toISOString() },
  });
  const payload = { ...rest, action, preview_run: previewRun };
  const { rows } = await db.query(
    `WITH p AS (
       INSERT INTO proposals (kind, source_agent, trust, payload) VALUES ('action', $1, $2, $3::jsonb) RETURNING id
     ), c AS (
       UPDATE runs SET meta = meta || jsonb_build_object('confirm', $5::jsonb || jsonb_build_object('proposal_id', (SELECT id FROM p)))
        WHERE id = $4
     )
     SELECT id FROM p`,
    [principal.id, trustOf(principal), JSON.stringify(payload), previewRun, JSON.stringify(confirm)],
  );
  return Number(rows[0]!.id);
}
