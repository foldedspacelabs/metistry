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
import { ARTIFACT_TOOL_NAMES, registerArtifactTools } from "./artifacts-tools.js";
import { CREW_TOOL_NAMES, registerCrewTools, type CrewDispatcher } from "./crew-tools.js";
import { QUERIES_TOOL_NAMES, registerQueriesTools } from "./queries-tools.js";
import { captureToInbox } from "./capture.js";
import { KNOWLEDGE_MODES, readKnowledge, searchKnowledge, type KnowledgeReader, type QueryEmbedder } from "./knowledge.js";
import { sha256Text, writeKnowledge, type KnowledgeWriter } from "./knowledge-write.js";
import { computeNudge } from "./nudge.js";
import { done, fail, type Outcome } from "./outcome.js";
import { REPORT_KINDS, submitReport } from "./report.js";
import { allProjects, memberOf } from "./scope.js";
import type { AgentPrincipal, Db } from "./types.js";

export interface BrainConfig {
  db: Db;
  /** Credential → principal. Null means 401; the bridge never sees the token. */
  authenticate(req: IncomingMessage): Promise<AgentPrincipal | null>;
  tasks: TasksService;
  /** Where `capture` writes files (the same directory the console's POST /capture uses). */
  inboxDir: string;
  /** Vault read path for `knowledge_read`. Absent → the tool answers `not_available`. */
  readKnowledge?: KnowledgeReader | undefined;
  /** Query embedder for `knowledge_search` mode=semantic|hybrid (core's EmbedClient). Absent → every mode serves keyword. */
  embedder?: QueryEmbedder | undefined;
  /** Vault write path for `knowledge_write` (the reconciler's bridge; `vaultBridgeWriter`). Absent → the tool answers `not_available`. */
  writeKnowledge?: KnowledgeWriter | undefined;
  /** The artifacts module (§4.21) for artifact_*. Absent → those tools answer `not_available`. */
  artifacts?: ArtifactsService | undefined;
  /** The host's crew dispatcher (registry + policy + durable enqueue) for crew_dispatch. Absent → `not_available`. Internal principals only either way. */
  crews?: CrewDispatcher | undefined;
  /** The one read path into state (invariant 3) for queries_list/queries_run. Absent → `not_available`. Internal principals always; external agents need grants.queries = true. */
  queries?: QueryStore | undefined;
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
 * The eager surface (§4.3 default 1): 21 tools, no meta-tool indirection.
 * Order = manifest order. This sits one tool over PoC-17's documented
 * >20-tools guidance for switching to `discovery: lazy` — noted, not acted
 * on, in this PR (queries_list/queries_run are two small, cheap-to-describe
 * schemas; revisit if the surface keeps growing).
 */
export const TOOL_NAMES = [
  "capture",
  "report",
  "tasks_list_ready",
  "tasks_claim",
  "tasks_heartbeat",
  "tasks_update",
  "tasks_release",
  "tasks_create",
  "tasks_mine",
  "knowledge_search",
  "knowledge_read",
  "knowledge_write",
  ...ARTIFACT_TOOL_NAMES,
  ...CREW_TOOL_NAMES,
  ...QUERIES_TOOL_NAMES,
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

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

/**
 * Every tool takes this, merged into its schema by `reg` below — a caller
 * (the assistant, a crew, an external agent) that generates one id per
 * reply and passes it on every call in that reply gets its `runs` rows
 * grouped for free (`meta.turn_id`; surfaced in the `activity_feed` query).
 * Not identity, not auth — a caller-supplied correlation handle, so it is
 * validated (shape only) and stored, never trusted for anything else.
 */
const turnId = z
  .string()
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/)
  .optional()
  .describe("Optional: reuse the same value on every brain tool call within one reply so they group in the activity feed.");

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

  /** Map a TasksService Result to an outcome: not_found is uniform with the scope miss; other refusals are data. */
  function fromResult(r: TaskResult): Outcome {
    if (!r.ok && r.reason === "not_found") return fail("not_found");
    return done(r.ok ? { ok: true, task: r.task } : { ok: false, reason: r.reason, ...(r.task ? { task: r.task } : {}) });
  }

  // --- per-request server ---------------------------------------------------

  function buildServer(principal: AgentPrincipal): McpServer {
    const server = new McpServer({ name: "metistry-brain", version }, { capabilities: { tools: {} } });

    /** Every tool call: one two-phase runs row (component = agent id), sanitizer, nudge. */
    function wrap<A>(name: ToolName, body: (args: A) => Promise<Outcome>): (args: A) => Promise<CallToolResult> {
      return async (args: A) => {
        // turn_id (merged into every schema by `reg`) travels in meta.turn_id, not
        // inside args' own summary — one place to find it, joinable by activity_feed.
        const { turn_id, ...rest } = (args ?? {}) as unknown as Record<string, unknown>;
        const runMeta = { via: "mcp-brain", args: summarizeArgs(rest), ...(typeof turn_id === "string" ? { turn_id } : {}) };
        const runId = await startRun(db, { component: principal.id, kind: "tool", tool: name, meta: runMeta });
        let outcome: Outcome;
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

    // turn_id is merged into every tool's schema here — one place, so no
    // individual tool file has to remember it (§ the join key, not a control).
    const reg = <S extends z.ZodRawShape>(name: ToolName, description: string, inputSchema: S, body: (args: z.infer<z.ZodObject<S>>) => Promise<Outcome>) =>
      server.registerTool(name, { description, inputSchema: { ...inputSchema, turn_id: turnId } }, wrap(name, body) as never);

    reg(
      "capture",
      "Drop a note or a file into the inbox. It lands as a proposal for the user to triage — nothing is written to knowledge. Provenance is stamped from your credential.",
      {
        note: z.string().max(200_000).optional().describe("Markdown text. Becomes the file when content_base64 is absent."),
        filename: z.string().max(200).optional().describe("Suggested filename (sanitized server-side)."),
        content_base64: z.string().max(40_000_000).optional().describe("Binary content, base64. `note` then travels as the triage note."),
        mime: z.string().max(100).optional(),
      },
      async (a) => {
        if (a.note === undefined && a.content_base64 === undefined) return fail("invalid_request", "note or content_base64 is required");
        const bytes = a.content_base64 !== undefined ? Buffer.from(a.content_base64, "base64") : Buffer.from(a.note ?? "", "utf8");
        const mime = a.mime ?? (a.content_base64 !== undefined ? "application/octet-stream" : "text/markdown");
        const filename = a.filename ?? (a.content_base64 !== undefined ? `capture-${Date.now()}.bin` : `note-${Date.now()}.md`);
        const r = await captureToInbox(db, cfg.inboxDir, { bytes, filename, mime, note: a.note ?? null, source: "mcp", sourceAgent: principal.id });
        return done(r, { inbox_id: r.id, bytes: bytes.length });
      },
    );

    reg(
      "report",
      "Submit a finding, decision, gotcha, or progress note as a report proposal. The user folds accepted reports into knowledge later; you never write knowledge directly. Retrying with the same idempotency_key, or re-reporting the same title within 24h, returns the existing id.",
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

    reg(
      "tasks_list_ready",
      "Unblocked, unclaimed tasks you could claim, across your projects (or one of them). Due dates first, then oldest.",
      { project: z.string().max(200).optional(), limit: z.number().int().min(1).max(200).optional() },
      async (a) => {
        const limit = a.limit ?? 50;
        if (a.project !== undefined) {
          if (!memberOf(principal, a.project)) return fail("not_found");
          return done({ tasks: await tasks.listReady({ project: a.project, limit }) });
        }
        // every project (the internal rule): one unfiltered read, then the same visibility filter as everywhere else
        if (allProjects(principal)) return done({ tasks: (await tasks.listReady({ limit: 500 })).filter((t) => visible(principal, t)).slice(0, limit) });
        const all: Task[] = [];
        for (const project of principal.projects) all.push(...(await tasks.listReady({ project, limit })));
        all.sort((x, y) => (x.due ?? "￿").localeCompare(y.due ?? "￿") || x.created_at.getTime() - y.created_at.getTime() || x.id - y.id);
        return done({ tasks: all.slice(0, limit) });
      },
    );

    reg(
      "tasks_claim",
      "Claim a task atomically (assignee + status + lease in one operation). Two agents racing get exactly one winner. Heartbeat before the lease lapses.",
      { id, lease_seconds: lease },
      async (a) => {
        if (!(await scoped(principal, a.id))) return fail("not_found");
        return fromResult(await tasks.claim(a.id, principal.id, a.lease_seconds));
      },
    );

    reg(
      "tasks_heartbeat",
      "Renew the lease on a task you hold. Refused once the lease has lapsed — claim it again instead.",
      { id, lease_seconds: lease },
      async (a) => {
        if (!(await scoped(principal, a.id))) return fail("not_found");
        return fromResult(await tasks.heartbeat(a.id, principal.id, a.lease_seconds));
      },
    );

    reg(
      "tasks_update",
      "Change status (in_progress | blocked | closed) and/or append a note on a task you hold. `closed` releases the claim.",
      { id, status: z.enum(["in_progress", "blocked", "closed"]).optional(), note: z.string().max(4000).optional() },
      async (a) => {
        if (!(await scoped(principal, a.id))) return fail("not_found");
        return fromResult(await tasks.update(a.id, principal.id, { ...(a.status ? { status: a.status } : {}), ...(a.note !== undefined ? { note: a.note } : {}) }));
      },
    );

    reg(
      "tasks_release",
      "Hand a task you hold back to the list (status → open, claim cleared).",
      { id, note: z.string().max(4000).optional() },
      async (a) => {
        if (!(await scoped(principal, a.id))) return fail("not_found");
        return fromResult(await tasks.release(a.id, principal.id, a.note));
      },
    );

    reg(
      "tasks_create",
      "Create a task in one of your projects. Retrying with the same idempotency_key returns the existing task. depends_on ids must be tasks in your projects.",
      {
        title: z.string().min(1).max(500),
        project: z.string().max(200),
        area: z.string().max(200).optional(),
        depends_on: z.array(id).max(50).optional(),
        due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        idempotency_key: z.string().min(1).max(200).optional(),
      },
      async (a) => {
        if (!memberOf(principal, a.project)) return fail("forbidden");
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

    reg("tasks_mine", "Every task you currently hold, soonest lease first.", {}, async () => {
      const held = (await tasks.listForAgent(principal.id)).filter((t) => visible(principal, t));
      return done({ tasks: held });
    });

    reg(
      "knowledge_search",
      "Search the knowledge index — titles and one-line descriptions — within your grant. Tier `index` sees every settled title; tier `areas` only its granted Knowledge/ prefixes. Draft notes never appear. " +
        "`mode` picks the ranking: `keyword` (substring), `semantic` (meaning, over the note embeddings), or `hybrid` (both, rank-fused — the default when embeddings exist). " +
        "The mode changes the ORDER of results, never which notes your grant lets you see; the response says which mode actually ran.",
      {
        query: z.string().min(1).max(200),
        limit: z.number().int().min(1).max(100).optional(),
        mode: z.enum(KNOWLEDGE_MODES).optional().describe("keyword | semantic | hybrid. Omit to let the bridge choose (hybrid when embeddings exist, else keyword)."),
      },
      async (a) => {
        const { tier, areas } = principal.grants;
        if (tier === "none") return fail("forbidden", undefined, { tier });
        const r = await searchKnowledge(db, principal, a.query, a.limit ?? 20, { mode: a.mode ?? null, embedder: cfg.embedder });
        return done(
          { tier, mode: r.mode, hits: r.hits, ...(r.degraded ? { degraded: r.degraded } : {}) },
          { tier, areas, mode: r.mode, requested: a.mode ?? null, hits: r.hits.length },
        );
      },
    );

    reg(
      "knowledge_read",
      "Read one settled note by vault path (Knowledge/...). Requires an `areas` grant covering the path. The returned sha256 is the value to pass as expected_sha256 to knowledge_write.",
      { path: z.string().min(1).max(500) },
      async (a) => {
        const { tier, areas } = principal.grants;
        const r = await readKnowledge(db, principal, a.path, cfg.readKnowledge);
        if (!r.ok) return fail(r.code, r.message, { tier, areas, path: a.path });
        return done({ path: r.path, title: r.title, content: r.content, sha256: sha256Text(r.content) }, { tier, areas, path: a.path, bytes: r.content.length });
      },
    );

    // The assistant's write path (knowledge-write.ts): internal principals only.
    reg(
      "knowledge_write",
      "Write one note under Knowledge/ as a commit in your name (the instance's own assistant only; every other agent gets `not granted` — use report). " +
        "Whole-file replace: pass the full content. Markdown gets `source` (your id) and `updated` (today) stamped into its frontmatter. " +
        'Pass expected_sha256 from knowledge_read so a concurrent edit is never clobbered ("" = create only); a `conflict` carries the current hash — re-read and retry. ' +
        "An existing note whose frontmatter `source` is someone else's (the user's, another agent's) is refused — report the change instead; new notes, and notes you or the fold wrote, are yours to update. " +
        "Protected paths (identity.yaml, rules.yaml, queries/, agents/, …) are refused at the vault. Deletes and renames are not available: they stay the user's hand.",
      {
        path: z.string().min(1).max(500).describe("Vault path, Knowledge/... with TitleCase folders, e.g. Knowledge/Areas/Fsl/Drey.md or Knowledge/now.md."),
        content: z.string().max(2_000_000).describe("The full new content of the file (UTF-8)."),
        message: z.string().min(1).max(2000).describe("Commit message: what changed and why; first line is the subject (≤ 200 chars)."),
        expected_sha256: z
          .string()
          .regex(/^(?:[0-9a-f]{64})?$/)
          .optional()
          .describe('sha256 the note must currently have (from knowledge_read); "" = the note must not exist yet; omit = unconditional.'),
      },
      async (a) => {
        const r = await writeKnowledge(principal, a, cfg.writeKnowledge, new Date(), cfg.readKnowledge);
        return r.ok ? done(r.result, r.meta) : fail(r.code, r.message, r.meta);
      },
    );

    // artifact_* (§4.21): the one registration point for the artifacts adapter
    registerArtifactTools(reg, cfg.artifacts, principal);

    // crew_dispatch (Phase 5 crews): the one registration point for the host's crew dispatcher; internal principals only
    registerCrewTools(reg, cfg.crews, principal);

    // queries_list / queries_run (invariant 3's one read path, out to agents): internal always, external with grants.queries = true
    registerQueriesTools(reg, cfg.queries, principal);

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
    const body = outcome.ok ? sanitizeDeep(outcome.result) : errorEnvelope(outcome.code, outcome.message);
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
      const server = buildServer(principal);
      // No sessionIdGenerator = stateless: no session header, no server-side state between requests.
      const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      // The SDK's class types its optional handlers as `| undefined`, which exactOptionalPropertyTypes rejects; same object at runtime.
      await server.connect(transport as unknown as Transport);
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
          knowledge_read: cfg.readKnowledge ? "available" : "not_available",
          knowledge_write: cfg.writeKnowledge ? "available" : "not_available",
          artifacts: cfg.artifacts ? "available" : "not_available",
          crews: cfg.crews ? cfg.crews.names() : "not_available",
          queries: cfg.queries ? "available" : "not_available",
          // Phase 6: semantic ranking is additive — without an embedder every mode still answers, in keyword.
          knowledge_search_modes: cfg.embedder ? ["keyword", "semantic", "hybrid"] : ["keyword"],
        };
        const gaps = [
          ...(cfg.readKnowledge ? [] : ["knowledge_read"]),
          ...(cfg.writeKnowledge ? [] : ["knowledge_write"]),
          ...(cfg.artifacts ? [] : ["artifact_*"]),
        ];
        return gaps.length === 0
          ? { meta }
          : { status: "degraded" as const, meta, remediation: `${gaps.join(" + ")} answer not_available until the vault bridge is configured (METISTRY_RECONCILER_URL + METISTRY_BRIDGE_TOKEN_RECONCILER)` };
      });
    },
  };
}
