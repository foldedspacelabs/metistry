// The brain bridge (§4.11 one knowledge interface for ALL agents, §4.19
// hub tools, §4.20 adapters adapt one service and add nothing). One MCP
// surface over Streamable HTTP, stateless: every request authenticates to
// a principal, gets a fresh McpServer whose tools are closed over that
// principal, and is answered in one round trip.
//
// Trust rules enforced here, not by prompting:
// - identity comes from the credential (the host's `authenticate`), never
//   from a tool argument — no tool even has an "agent" parameter;
// - tasks_* are scoped to the principal's projects (scope.ts — an internal
//   principal with no list is in every project): a task outside them is
//   `not_found`, never listed, never claimable, never a dependency;
// - knowledge_* are gated by the grant tier: `none` → `forbidden` ("not
//   granted"), drafts invisible at every tier;
// - knowledge_write (the assistant's `brain-commit`, knowledge-write.ts) is
//   for `kind: internal` principals only — one writer (§4.11); everyone
//   else is `forbidden`, and the vault bridge's protected paths hold behind;
// - every string that came out of the database passes the §4.20 sanitizer
//   before it is rendered to an agent, and every call is one `runs` row.

import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import {
  errorEnvelope,
  finishRun,
  may,
  redactSecrets,
  runCheck,
  sanitizeForAgent,
  startRun,
  statusFor,
  type CheckResult,
  type ErrorCode,
} from "@foldedspacelabs/metistry-core";
import { TasksError, type Result as TaskResult, type Task, type TasksService } from "@foldedspacelabs/metistry-tasks";
import type { ArtifactsService } from "@foldedspacelabs/metistry-artifacts";
import type { QueryStore } from "@foldedspacelabs/metistry-queries";
import { ALIAS_NAMES, resolveAliasCall } from "./aliases.js";
import { ARTIFACTS_TOOL_NAMES, registerArtifactTools } from "./artifacts-tools.js";
import { CREW_TOOL_NAMES, registerCrewTools, type CrewDispatcher } from "./crew-tools.js";
import { THREAD_TOOL_NAMES, registerThreadTools } from "./thread-tools.js";
import { QUERIES_TOOL_NAMES, registerQueriesTools } from "./queries-tools.js";
import { ACTION_TOOL_NAMES, registerActionTools, type ActionExecutor } from "./action-tools.js";
import { requestAccess } from "./access.js";
import { KNOWLEDGE_FS_TOOL_NAMES, registerKnowledgeFsTools, type KnowledgeLister, type KnowledgeVaultSearcher } from "./knowledge-fs.js";
import { registerKnowledgeResources } from "./knowledge-resources.js";
import { captureToInbox, type CaptureSink } from "./capture.js";
import { KNOWLEDGE_MODES, knowledgeScope, readKnowledge, searchKnowledge, type KnowledgeReader, type QueryEmbedder } from "./knowledge.js";
import { sha256Text, writeKnowledge, type KnowledgeWriter } from "./knowledge-write.js";
import { computeNudge } from "./nudge.js";
import { principalOf } from "./principal.js";
import { done, fail, refuse, type Outcome } from "./outcome.js";
import { REPORT_KINDS, submitReport } from "./report.js";
import { allProjects, memberOf } from "./scope.js";
import { liftTurnId, turnIdFrom } from "./turn-id.js";
import type { AgentPrincipal, Db } from "./types.js";

export interface BrainConfig {
  db: Db;
  /** Credential → principal. Null means 401; the bridge never sees the token. */
  authenticate(req: IncomingMessage): Promise<AgentPrincipal | null>;
  tasks: TasksService;
  /** Where `capture` writes files when no sink is injected — a plain directory (the standalone shape). */
  inboxDir: string;
  /** Where captures go in Metistry: the vault inbox over the reconciler's bridge (`vaultSink`). Absent → `dirSink(inboxDir)`. */
  inbox?: CaptureSink | undefined;
  /** Vault read path for `knowledge_read`. Absent → the tool answers `not_available`. */
  readKnowledge?: KnowledgeReader | undefined;
  /** Query embedder for `knowledge_search` mode=semantic|hybrid (core's EmbedClient). Absent → every mode serves keyword. */
  embedder?: QueryEmbedder | undefined;
  /** Vault write path for `knowledge_write` (the reconciler's bridge; `vaultBridgeWriter`). Absent → the tool answers `not_available`. */
  writeKnowledge?: KnowledgeWriter | undefined;
  /** Vault listing for `knowledge_list` (the reconciler's `GET /vault/list`; `vaultBridgeLister`). Absent → the tool answers `not_available`. Also `knowledge_grep`'s fallback candidate source when no literal seed or searcher is available. */
  listKnowledge?: KnowledgeLister | undefined;
  /** Keyword-mode content search for `knowledge_grep`'s candidate pre-filter (the reconciler's `GET /vault/search?mode=keyword`; `vaultBridgeSearcher`). Absent → grep falls back to `listKnowledge` for candidates. */
  searchVaultKeyword?: KnowledgeVaultSearcher | undefined;
  /** The artifacts module (§4.21) for artifact_*. Absent → those tools answer `not_available`. */
  artifacts?: ArtifactsService | undefined;
  /** The host's crew dispatcher (registry + policy + durable enqueue) for agents_delegate. Absent → `not_available`. Internal principals only either way. */
  crews?: CrewDispatcher | undefined;
  /** The one read path into state (invariant 3) for queries_list/queries_run. Absent → `not_available`. Internal principals always; external agents need grants.queries = true. */
  queries?: QueryStore | undefined;
  /** The host's action executor for `propose_action` at mode `allow` (apps/console/src/actions.ts). Absent → an allowed action answers `not_available`; the tool itself is offered only to a credential the owner has given room (docs/ops/actions.md). */
  actions?: ActionExecutor | undefined;
  /** Nudge when a held lease has this many seconds or fewer left (default 120). */
  leaseWarningSeconds?: number | undefined;
  /** Reported to MCP clients as the server version. */
  version?: string | undefined;
}

export interface BrainServer {
  /** Mount at one path (the console uses POST /mcp). Handles auth, the envelope, and the MCP exchange. */
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
  /** Behavioral probe for `metistry doctor`. */
  check(): Promise<CheckResult>;
  readonly tools: readonly string[];
}

/**
 * The declared surface (§4.3 default 1): 27 tools, no meta-tool indirection.
 * 26 of them are EAGER — every principal sees them — and `propose_action` is
 * the one that is not: it is registered only for a credential whose autonomy
 * table admits an action (docs/ops/actions.md), which is nobody until the
 * owner sets a level. So the eager definition budget measured below is
 * unchanged for everyone who has not opted in, and an admitted principal
 * pays for what it bought.
 * Order = manifest order. One noun per thing, one verb set per object
 * (docs/product/glossary.md): folding tasks_list_ready + tasks_mine into
 * `tasks_list {filter}` paid for knowledge_list/knowledge_grep. This still
 * sits over PoC-17's documented >20-tools guidance for switching to
 * `discovery: lazy` on tool COUNT — noted, not acted on, because the
 * guidance's other axis (definition tokens, measured by test/brain.test.ts's
 * "definition size" test) is what actually gates lazy.
 * Deprecated spellings live in aliases.ts and resolve at call time — they are
 * NOT listed here, so neither the count nor the token budget grows for them.
 *
 * 2026-09-19, twice. First `turn_id` came out of every schema and moved to
 * the call's `_meta` (turn-id.ts) — 944 tokens, 19% of the surface, for a
 * field that was never a parameter, taking the measurement from ~5.0k to
 * ~4.0k. Then `request_access` (access.ts) spent 189 of that on the 26th
 * eager tool, by the owner's ruling and with the count ceiling in
 * `ops/scripts/check-tool-surface.mjs` moved 25 → 26 to say so out loud.
 * The rule it did NOT bend: a new READ capability is a named query behind
 * `queries_run` (docs/ops/assistant-tools.md). A new tool is a new VERB —
 * here, "ask the owner for the area you were refused" — and it arrives with
 * the discovery decision attached rather than fitting under the line
 * quietly. The tool after this one fails that check again.
 */
export const TOOL_NAMES = [
  "capture",
  "requests_create",
  "request_access",
  "tasks_list",
  "tasks_claim",
  "tasks_renew",
  "tasks_update",
  "tasks_release",
  "tasks_close",
  "tasks_create",
  ...THREAD_TOOL_NAMES,
  "knowledge_search",
  "knowledge_read",
  ...KNOWLEDGE_FS_TOOL_NAMES,
  "knowledge_write",
  ...ARTIFACTS_TOOL_NAMES,
  ...CREW_TOOL_NAMES,
  ...QUERIES_TOOL_NAMES,
  ...ACTION_TOOL_NAMES,
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/**
 * What EVERY principal sees in `tools/list` — the declared surface minus the
 * groups that are registered per credential. Today that is exactly
 * `propose_action` (docs/ops/actions.md): an agent the owner has given no room
 * is not shown a tool it could only be refused by. This is the list the
 * definition-token budget is measured against, and the one a bake-off
 * presents.
 *
 * `request_access` and `agents_delegate` are NOT deferred this way, in
 * opposite directions and for the same reason: the principal each one
 * refuses (internal, external) is told so by the tool, in a sentence that
 * names what to do instead. A refusal an agent can read once is worth more
 * than a tool it never learns exists — deferral is for a capability nobody
 * has bought yet, not for a rule.
 */
export const EAGER_TOOL_NAMES: readonly ToolName[] = TOOL_NAMES.filter((n) => !(ACTION_TOOL_NAMES as readonly string[]).includes(n));

// --- text boundary --------------------------------------------------------

/** Sanitize every string in a result tree; dates become ISO strings. */
export function sanitizeDeep(value: unknown): unknown {
  if (typeof value === "string") return sanitizeForAgent(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(sanitizeDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = sanitizeDeep(v);
    return out;
  }
  return value;
}

/** Args as they land in the audit row: scalars only, clipped, secrets redacted, bodies dropped. */
function summarizeArgs(args: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (args === null || typeof args !== "object") return out;
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (k === "content_base64" || k === "body" || k === "content") {
      if (typeof v === "string") out[k] = `<${v.length} chars>`;
    } else if (typeof v === "string") out[k] = v.length > 120 ? `${v.slice(0, 120)}…` : v;
    else if (typeof v === "number" || typeof v === "boolean" || v === null) out[k] = v;
    else if (Array.isArray(v)) out[k] = v.slice(0, 20);
  }
  return redactSecrets(out);
}

const id = z.number().int().positive();
const lease = z.number().int().min(1).max(86_400).optional();

/** tasks_list's one axis: claimable, held by you, or both. */
export const TASK_FILTERS = ["ready", "mine", "all"] as const;
export type TaskFilter = (typeof TASK_FILTERS)[number];

/**
 * What a tool handler is handed besides its arguments: the SDK's request
 * context, narrowed to the two fields this bridge reads — the JSON-RPC id
 * (which the deprecated-name rewriter keys its note by) and the call's
 * `_meta` (which carries the turn handle; turn-id.ts).
 */
interface ToolCallExtra {
  requestId?: string | number;
  _meta?: Record<string, unknown> | undefined;
}

export function createBrainServer(cfg: BrainConfig): BrainServer {
  const { db, tasks } = cfg;
  const leaseWarningSeconds = cfg.leaseWarningSeconds ?? 120;
  const version = cfg.version ?? "0.0.1";

  // --- project scope --------------------------------------------------------

  function visible(principal: AgentPrincipal, task: Task | null): task is Task {
    return task !== null && memberOf(principal, task.project);
  }

  /** A task outside the principal's projects does not exist for it. */
  async function scoped(principal: AgentPrincipal, taskId: number): Promise<Task | null> {
    const task = await tasks.get(taskId);
    return visible(principal, task) ? task : null;
  }

  /** The claimable set, project-scoped. null = the named project is outside the principal's scope (not_found, uniform). */
  async function readyFor(principal: AgentPrincipal, project: string | undefined, limit: number): Promise<Task[] | null> {
    if (project !== undefined) {
      if (!memberOf(principal, project)) return null;
      return tasks.listReady({ project, limit });
    }
    // every project (the internal rule): one unfiltered read, then the same visibility filter as everywhere else
    if (allProjects(principal)) return (await tasks.listReady({ limit: 500 })).filter((t) => visible(principal, t)).slice(0, limit);
    const all: Task[] = [];
    for (const p of principal.projects) all.push(...(await tasks.listReady({ project: p, limit })));
    all.sort((x, y) => (x.due ?? "￿").localeCompare(y.due ?? "￿") || x.created_at.getTime() - y.created_at.getTime() || x.id - y.id);
    return all.slice(0, limit);
  }

  /** Map a TasksService Result to an outcome: not_found is uniform with the scope miss; other refusals are data. */
  function fromResult(r: TaskResult): Outcome {
    if (!r.ok && r.reason === "not_found") return fail("not_found");
    return done(r.ok ? { ok: true, task: r.task } : { ok: false, reason: r.reason, ...(r.task ? { task: r.task } : {}) });
  }

  // --- per-request server ---------------------------------------------------

  /** aliasByRequestId: filled by handle()'s alias rewriter, read by `wrap` so the runs row names the deprecated spelling that was used. */
  function buildServer(principal: AgentPrincipal, aliasByRequestId: Map<string, string>): McpServer {
    const server = new McpServer({ name: "metistry-brain", version }, { capabilities: { tools: {} } });

    /** Every tool call: one two-phase runs row (component = agent id), sanitizer, nudge. */
    function wrap<A>(name: ToolName, body: (args: A) => Promise<Outcome>): (args: A, extra?: ToolCallExtra) => Promise<CallToolResult> {
      return async (args: A, extra?: ToolCallExtra) => {
        // The turn handle rides in the call's `_meta`, never in a schema
        // (turn-id.ts): one place to find it, joinable by activity_feed, and
        // 938 tokens the model never reads. A legacy `arguments.turn_id` was
        // already lifted there by `handle` below.
        const turn_id = turnIdFrom(extra?._meta);
        // a call that came in under a deprecated name is recorded under the primary
        // one, with the old spelling in meta.alias — so the stragglers are countable.
        const alias = extra?.requestId !== undefined ? aliasByRequestId.get(String(extra.requestId)) : undefined;
        const runMeta = { via: "mcp-brain", args: summarizeArgs(args), ...(turn_id !== undefined ? { turn_id } : {}), ...(alias ? { alias } : {}) };
        const runId = await startRun(db, { component: principal.id, kind: "tool", tool: name, meta: runMeta });
        let outcome: Outcome;
        // **The run's own allowlist, at the door** (P2 of
        // docs/research/2026-09-19-grants-and-access-simplified.md §2.2): a
        // crew holds exactly the tool groups its manifest's `uses` names, and
        // this is where that is enforced — before the body, for every tool,
        // on the same audited path every other refusal takes. Until now it
        // was a filter in the process that dispatched the run
        // (apps/assistant/src/tools.ts), which is a process boundary rather
        // than the tool; that filter stays as defence in depth and is no
        // longer the control. Every other role carries no allowlist, so this
        // decides nothing for them and their refusals are unchanged.
        const admitted = may(principalOf(principal), "act", { kind: "toolset", name });
        if (!admitted.ok) {
          // The refusal is a `runs` row like any other, carrying the groups
          // the crew does hold, so "it tried X" is answerable from the audit.
          const meta = { uses: principal.uses ?? [], reason: admitted.reason };
          await finishRun(db, runId, { ok: false, error: admitted.code, meta });
          return render(refuse(admitted, meta), await nudge(principal));
        }
        try {
          outcome = await body(args);
        } catch (err) {
          if (err instanceof TasksError) {
            outcome = fail(err.code === "conflict" ? "conflict" : "invalid_request", err.message);
          } else {
            await finishRun(db, runId, { ok: false, error: err instanceof Error ? err.message : String(err) });
            return render(fail("internal"), await nudge(principal));
          }
        }
        await finishRun(db, runId, outcome.ok ? { ok: true, meta: outcome.meta ?? {} } : { ok: false, error: outcome.code, meta: outcome.meta ?? {} });
        return render(outcome, await nudge(principal));
      };
    }

    // One registration point, so a tool file declares its own parameters and
    // nothing else. Nothing is merged into a schema here any more: the turn
    // handle used to be, and at 938 tokens across 25 tools it was 18.8% of the
    // whole advertised surface for a field that is not a parameter
    // (turn-id.ts, docs/research/2026-09-19-code-mode-mcp.md §2.4).
    const reg = <S extends z.ZodRawShape>(name: ToolName, description: string, inputSchema: S, body: (args: z.infer<z.ZodObject<S>>) => Promise<Outcome>) =>
      server.registerTool(name, { description, inputSchema }, wrap(name, body) as never);

    reg(
      "capture",
      "Drop a note or file into the inbox as a triage proposal; nothing is written to knowledge directly.",
      {
        note: z.string().max(200_000).optional().describe("Markdown text; becomes the file if content_base64 is absent."),
        filename: z.string().max(200).optional().describe("Suggested filename (sanitized server-side)."),
        content_base64: z.string().max(40_000_000).optional().describe("Binary content, base64; note then travels as the triage note."),
        mime: z.string().max(100).optional(),
      },
      async (a) => {
        if (a.note === undefined && a.content_base64 === undefined) return fail("invalid_request", "note or content_base64 is required");
        const bytes = a.content_base64 !== undefined ? Buffer.from(a.content_base64, "base64") : Buffer.from(a.note ?? "", "utf8");
        const mime = a.mime ?? (a.content_base64 !== undefined ? "application/octet-stream" : "text/markdown");
        const filename = a.filename ?? (a.content_base64 !== undefined ? `capture-${Date.now()}.bin` : `note-${Date.now()}.md`);
        const r = await captureToInbox(db, cfg.inbox ?? cfg.inboxDir, { bytes, filename, mime, note: a.note ?? null, source: "mcp", sourceAgent: principal.id });
        return done(r, { inbox_id: r.id, bytes: bytes.length });
      },
    );

    reg(
      "requests_create",
      "Raise a request — a finding, decision, gotcha, or progress note — for the user's Needs You queue; they fold what they approve into knowledge, you never write it directly. Same idempotency_key, or the same title within 24h, returns the existing id.",
      {
        title: z.string().min(1).max(200),
        body: z.string().min(1).max(50_000),
        kind: z.enum(REPORT_KINDS).optional(),
        refs: z.array(z.string().max(500)).max(50).optional().describe("Handles, not payloads: issue urls, task ids, note paths."),
        idempotency_key: z.string().min(1).max(200).optional(),
      },
      async (a) => {
        const r = await submitReport(db, principal.id, a);
        return done(r, { proposal_id: r.id, deduplicated: r.deduplicated });
      },
    );

    // Grants nothing: one row in the owner's queue, and they widen the grant
    // themselves (access.ts). Deliberately offered at EVERY tier, tier `none`
    // included — an agent that can be refused is an agent that may ask — and
    // to every principal since the 2026-09-19 ruling, the assistant included.
    // The ladder (decline → escalate once → ask in words) is enforced in
    // access.ts, so the description states it rather than pleading for it.
    reg(
      "request_access",
      "Ask the owner for read access to one vault area (TitleCase prefix, e.g. Areas/Health) and say why. Grants nothing: it raises one request in their Needs You queue to approve, narrow or decline. A repeat ask returns the pending one; after an approval the read simply works; after a decline you are told so, and may ask once more with escalate.",
      {
        area: z.string().min(1).max(200).describe("The vault prefix you need, e.g. Areas/Health."),
        reason: z.string().min(1).max(1000).describe("Why you need it — what you were doing when you were refused."),
        escalate: z.boolean().optional().describe("Only after a decline: ask again, flagged, with a fuller reason."),
      },
      async (a) => {
        const r = await requestAccess(db, principal, a);
        return r.ok
          ? done(
              { id: r.id, area: r.area, ...(r.replayed ? { replayed: true } : {}), ...(r.escalated ? { escalated: true } : {}), decided_by: "the owner, in Needs You" },
              { proposal_id: r.id, area: r.area, replayed: r.replayed, escalated: r.escalated },
            )
          : fail(r.code, r.message, { area: a.area, ...(a.escalate ? { escalate: true } : {}) }, r.expose);
      },
    );

    reg(
      "tasks_list",
      "Tasks across your projects (or one). `ready` (the default) is unblocked, unclaimed work, due date then oldest first; `mine` is what you hold, soonest lease first; `all` is both.",
      {
        filter: z.enum(TASK_FILTERS).optional().describe("ready (claimable — the default) | mine (held by you) | all (both)"),
        project: z.string().max(200).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
      async (a) => {
        const limit = a.limit ?? 50;
        const filter = a.filter ?? "ready";
        const mine = filter === "ready" ? [] : (await tasks.listForAgent(principal.id)).filter((t) => visible(principal, t)).filter((t) => a.project === undefined || t.project === a.project);
        if (filter === "mine") return done({ filter, tasks: mine.slice(0, limit) });
        const ready = await readyFor(principal, a.project, limit);
        if (ready === null) return fail("not_found");
        if (filter === "ready") return done({ filter, tasks: ready });
        // all = ready ∪ held by you, held first (a lease is the more urgent fact), deduplicated by id
        const seen = new Set(mine.map((t) => t.id));
        return done({ filter, tasks: [...mine, ...ready.filter((t) => !seen.has(t.id))].slice(0, limit) });
      },
    );

    reg(
      "tasks_claim",
      "Claim a task atomically — assignee, status, and lease in one step; heartbeat before the lease lapses.",
      { id, lease_seconds: lease },
      async (a) => {
        if (!(await scoped(principal, a.id))) return fail("not_found");
        return fromResult(await tasks.claim(a.id, principal.id, a.lease_seconds));
      },
    );

    reg(
      "tasks_renew",
      "Renew the lease on a task you hold; refused once lapsed — claim it again instead.",
      { id, lease_seconds: lease },
      async (a) => {
        if (!(await scoped(principal, a.id))) return fail("not_found");
        return fromResult(await tasks.heartbeat(a.id, principal.id, a.lease_seconds));
      },
    );

    reg(
      "tasks_update",
      "Change status (in_progress/blocked) and/or append a note on a task you hold; use tasks_close to finish one instead of passing status: closed here.",
      { id, status: z.enum(["in_progress", "blocked", "closed"]).optional(), note: z.string().max(4000).optional() },
      async (a) => {
        if (!(await scoped(principal, a.id))) return fail("not_found");
        return fromResult(await tasks.update(a.id, principal.id, { ...(a.status ? { status: a.status } : {}), ...(a.note !== undefined ? { note: a.note } : {}) }));
      },
    );

    reg(
      "tasks_release",
      "Return a task you hold to the list — status open, claim cleared; use tasks_close instead when the work is actually done.",
      { id, note: z.string().max(4000).optional() },
      async (a) => {
        if (!(await scoped(principal, a.id))) return fail("not_found");
        return fromResult(await tasks.release(a.id, principal.id, a.note));
      },
    );

    reg(
      "tasks_close",
      "Finish a task you hold in one step — status closed, claim released; append a closing note if you have one. The same tasks_update path, just the one call a closer actually wants.",
      { id, note: z.string().max(4000).optional() },
      async (a) => {
        if (!(await scoped(principal, a.id))) return fail("not_found");
        return fromResult(await tasks.update(a.id, principal.id, { status: "closed", ...(a.note !== undefined ? { note: a.note } : {}) }));
      },
    );

    reg(
      "tasks_create",
      "Create a task in one of your projects; same idempotency_key returns the existing task.",
      {
        title: z.string().min(1).max(500),
        project: z.string().max(200),
        area: z.string().max(200).optional(),
        depends_on: z.array(id).max(50).optional(),
        due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        idempotency_key: z.string().min(1).max(200).optional(),
      },
      async (a) => {
        // The one project check that is `forbidden` rather than `not_found`:
        // you named the project, so it is not a row you cannot see — it is a
        // room you are not in (uniform with artifacts_publish).
        const admitted = may(principalOf(principal), "write", { kind: "project", door: "task_create", slug: a.project });
        if (!admitted.ok) return refuse(admitted);
        for (const dep of a.depends_on ?? []) if (!(await scoped(principal, dep))) return fail("not_found", `depends_on task ${dep} not found`);
        const task = await tasks.create(
          {
            title: a.title,
            project: a.project,
            ...(a.area !== undefined ? { area: a.area } : {}),
            ...(a.depends_on !== undefined ? { depends_on: a.depends_on } : {}),
            ...(a.due !== undefined ? { due: a.due } : {}),
            ...(a.idempotency_key !== undefined ? { idempotency_key: a.idempotency_key } : {}),
          },
          principal.id,
        );
        return done({ task }, { task_id: task.id });
      },
    );

    // tasks_comment / tasks_thread (0016): the room on a work row. Registered
    // here, beside the rest of tasks_*, because that is the grant they ride
    // and the order the manifest lists. The service is the artifacts one —
    // same table, same escalation — so an unconfigured deployment answers
    // not_available like artifact_* does.
    registerThreadTools(reg, cfg.artifacts, principal);

    reg(
      "knowledge_search",
      "Search the knowledge index (titles + one-line descriptions) within your grant; drafts never appear. `mode` (keyword/semantic/hybrid) only reorders results, never what you can see.",
      {
        query: z.string().min(1).max(200),
        limit: z.number().int().min(1).max(100).optional(),
        mode: z.enum(KNOWLEDGE_MODES).optional().describe("keyword | semantic | hybrid; omit for hybrid when available, else keyword."),
      },
      async (a) => {
        const scope = knowledgeScope(principal);
        const admitted = may(principalOf(principal), "act", { kind: "tool", name: "knowledge_search" });
        if (!admitted.ok) return refuse(admitted, { tier: scope.tier });
        const r = await searchKnowledge(db, principal, a.query, a.limit ?? 20, { mode: a.mode ?? null, embedder: cfg.embedder });
        return done(
          { tier: scope.tier, mode: r.mode, hits: r.hits, ...(r.degraded ? { degraded: r.degraded } : {}) },
          { tier: scope.tier, areas: scope.prefixes ?? [], mode: r.mode, requested: a.mode ?? null, hits: r.hits.length },
        );
      },
    );

    reg(
      "knowledge_read",
      "Read one settled note by vault path; requires an `areas` grant covering it. Returned sha256 feeds knowledge_write's expected_sha256.",
      { path: z.string().min(1).max(500) },
      async (a) => {
        const scope = knowledgeScope(principal);
        const r = await readKnowledge(db, principal, a.path, cfg.readKnowledge);
        if (!r.ok) return fail(r.code, r.message, { tier: scope.tier, areas: scope.prefixes ?? [], path: a.path }, r.expose);
        return done({ path: r.path, title: r.title, content: r.content, sha256: sha256Text(r.content) }, { tier: scope.tier, areas: scope.prefixes ?? [], path: a.path, bytes: r.content.length });
      },
    );

    // knowledge_list / knowledge_grep (docs/research/2026-09-stash-review.md
    // item 3): filesystem semantics over the same grant tiers, one
    // registration point like every other adapter here.
    // `queries` rides along because the page list and the link graph are
    // DERIVED state: `knowledge_list` runs the same two `expose: route`
    // named queries the console's `/api/knowledge/pages` and `/links` run,
    // through the same driver and the same `canSeeUnder` filter (ruled
    // 2026-09-19: one scope rule for every knowledge read, on both doors).
    registerKnowledgeFsTools(reg, { db, list: cfg.listKnowledge, search: cfg.searchVaultKeyword, read: cfg.readKnowledge, queries: cfg.queries }, principal);

    // The assistant's write path (knowledge-write.ts): internal principals only.
    reg(
      "knowledge_write",
      "Write one note in the vault as a commit in your name (internal assistant only; others get `not granted` — use requests_create). Whole-file replace; frontmatter gets `source`/`updated` stamped. " +
        'To CHANGE a note: knowledge_read it and pass its sha256 back as expected_sha256. Omitting it means create-only, so an existing note answers `conflict` with the current hash rather than being overwritten unseen. ' +
        "A note whose `source` is someone else's is refused — report instead; notes you or the fold wrote are yours. Protected paths are refused; deletes/renames are not available.",
      {
        path: z.string().min(1).max(500).describe("Vault path, relative to the vault root, TitleCase folders, e.g. Areas/Fsl/Drey.md."),
        content: z.string().max(2_000_000).describe("The full new content of the file (UTF-8)."),
        message: z.string().min(1).max(2000).describe("Commit message; first line is the subject (≤ 200 chars)."),
        expected_sha256: z
          .string()
          .regex(/^(?:[0-9a-f]{64})?$/)
          .optional()
          .describe('Current sha256 from knowledge_read; "" or omitted = the note must not exist yet (create only).'),
      },
      async (a) => {
        const r = await writeKnowledge(principal, a, cfg.writeKnowledge, new Date(), cfg.readKnowledge);
        return r.ok ? done(r.result, r.meta) : fail(r.code, r.message, r.meta);
      },
    );

    // artifact_* (§4.21): the one registration point for the artifacts adapter
    registerArtifactTools(reg, cfg.artifacts, principal);

    // agents_delegate (Phase 5 crews): the one registration point for the host's crew dispatcher; internal principals only
    registerCrewTools(reg, cfg.crews, principal);

    // queries_list / queries_run (invariant 3's one read path, out to agents): internal always, external with grants.queries = true
    registerQueriesTools(reg, cfg.queries, principal);

    // propose_action (docs/ops/actions.md): registered ONLY when this
    // credential's autonomy table admits something — nobody, until the owner
    // sets a level. That is this group's "lazy": the definition does not ride
    // in a tools/list it could never be called from.
    registerActionTools(reg, db, principal, cfg.actions);

    // Vault notes as MCP resources (metistry://<vault path>), same tier
    // rule as knowledge_read throughout — not a tool, so no runs row.
    registerKnowledgeResources(server, principal, db, cfg.readKnowledge);

    return server;
  }

  async function nudge(principal: AgentPrincipal): Promise<string | null> {
    try {
      return await computeNudge(tasks, principal, { leaseWarningSeconds });
    } catch {
      return null; // a nudge is a courtesy; never fail the tool over it
    }
  }

  function render(outcome: Outcome, nudgeLine: string | null): CallToolResult {
    // `outcome.expose` (never `meta`, which is `runs`-only) is merged onto
    // the envelope for a refusal that opts in — e.g. knowledge.ts's
    // scope_required — so the uniform `{ error }` shape every other tool
    // returns is untouched unless a tool body explicitly asked for more.
    const body = outcome.ok ? sanitizeDeep(outcome.result) : { ...errorEnvelope(outcome.code, outcome.message), ...(outcome.expose ?? {}) };
    const text = JSON.stringify(body) + (nudgeLine ? `\n${nudgeLine}` : "");
    return { content: [{ type: "text", text }], ...(outcome.ok ? {} : { isError: true }) };
  }

  function sendEnvelope(res: ServerResponse, code: ErrorCode): void {
    const text = JSON.stringify(errorEnvelope(code));
    const headers: Record<string, string | number> = { "content-type": "application/json", "content-length": Buffer.byteLength(text) };
    if (code === "unauthenticated") headers["www-authenticate"] = 'Bearer realm="metistry-brain"';
    res.writeHead(statusFor(code), headers);
    res.end(text);
  }

  return {
    tools: TOOL_NAMES,

    async handle(req, res) {
      const principal = await cfg.authenticate(req); // the credential decides; nothing in the body is identity
      if (!principal) return sendEnvelope(res, "unauthenticated");
      const aliasByRequestId = new Map<string, string>();
      const server = buildServer(principal, aliasByRequestId);
      // No sessionIdGenerator = stateless: no session header, no server-side state between requests.
      const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      // The SDK's class types its optional handlers as `| undefined`, which exactOptionalPropertyTypes rejects; same object at runtime.
      await server.connect(transport as unknown as Transport);
      // Two rewrites on the way in, after connect installed the real handler,
      // and both are one release of compatibility with nothing added to the
      // listed surface: deprecated names (aliases.ts) become their primary
      // spelling, and a legacy `arguments.turn_id` moves to the call's `_meta`
      // (turn-id.ts) before any schema could strip it.
      const deliver = transport.onmessage;
      if (deliver) {
        transport.onmessage = (message, extra) => {
          const hit = resolveAliasCall(message);
          if (hit?.id !== undefined) aliasByRequestId.set(String(hit.id), hit.alias);
          liftTurnId(message);
          deliver(message, extra);
        };
      }
      await transport.handleRequest(req, res);
    },

    check() {
      return runCheck("brain", "select the inbox/proposals/knowledge_files columns the tools use; tasks.check()", async () => {
        await db.query(`SELECT id, source, path, mime, note, sha256, source_agent FROM inbox WHERE false`);
        await db.query(`SELECT id, ts, kind, source_agent, trust, payload, decision, feedback FROM proposals WHERE false`);
        await db.query(`SELECT path, title, description, draft FROM knowledge_files WHERE false`);
        const t = await tasks.check();
        if (t.status !== "ok") throw new Error(`tasks: ${t.remediation ?? t.status}`);
        const meta = {
          tools: [...TOOL_NAMES],
          deprecated_aliases: ALIAS_NAMES,
          knowledge_read: cfg.readKnowledge ? "available" : "not_available",
          knowledge_write: cfg.writeKnowledge ? "available" : "not_available",
          knowledge_list: cfg.listKnowledge ? "available" : "not_available",
          artifacts: cfg.artifacts ? "available" : "not_available",
          crews: cfg.crews ? cfg.crews.crews().map((c) => c.name) : "not_available",
          queries: cfg.queries ? "available" : "not_available",
          // Phase 6: semantic ranking is additive — without an embedder every mode still answers, in keyword.
          knowledge_search_modes: cfg.embedder ? ["keyword", "semantic", "hybrid"] : ["keyword"],
        };
        const gaps = [
          ...(cfg.readKnowledge ? [] : ["knowledge_read"]),
          ...(cfg.writeKnowledge ? [] : ["knowledge_write"]),
          ...(cfg.listKnowledge ? [] : ["knowledge_list"]),
          ...(cfg.artifacts ? [] : ["artifact_*"]),
        ];
        return gaps.length === 0
          ? { meta }
          : { status: "degraded" as const, meta, remediation: `${gaps.join(" + ")} answer not_available until the vault bridge is configured (METISTRY_RECONCILER_URL + METISTRY_BRIDGE_TOKEN_RECONCILER)` };
      });
    },
  };
}
