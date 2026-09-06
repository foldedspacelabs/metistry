// The brain bridge (§4.11 one knowledge interface for ALL agents, §4.19
// hub tools, §4.20 adapters adapt one service and add nothing). One MCP
// surface over Streamable HTTP, stateless: every request authenticates to
// a principal, gets a fresh McpServer whose tools are closed over that
// principal, and is answered in one round trip.
//
// Trust rules enforced here, not by prompting:
// - identity comes from the credential (the host's `authenticate`), never
//   from a tool argument — no tool even has an "agent" parameter;
// - tasks_* are scoped to the principal's projects: a task outside them is
//   `not_found`, never listed, never claimable, never a dependency;
// - knowledge_* are gated by the grant tier: `none` → `forbidden` ("not
//   granted"), drafts invisible at every tier;
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
import { captureToInbox } from "./capture.js";
import { readKnowledge, searchKnowledge, type KnowledgeReader } from "./knowledge.js";
import { computeNudge } from "./nudge.js";
import { REPORT_KINDS, submitReport } from "./report.js";
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

/** The eager surface (§4.3 default 1): 11 tools, no meta-tool indirection. Order = manifest order. */
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
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/** What a tool body returns; the wrapper turns it into a CallToolResult + runs row + nudge. */
type Outcome =
  | { ok: true; result: unknown; meta?: Record<string, unknown> }
  | { ok: false; code: ErrorCode; message?: string | undefined; meta?: Record<string, unknown> };

const fail = (code: ErrorCode, message?: string, meta?: Record<string, unknown>): Outcome => ({ ok: false, code, message, ...(meta ? { meta } : {}) });
const done = (result: unknown, meta?: Record<string, unknown>): Outcome => ({ ok: true, result, ...(meta ? { meta } : {}) });

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
    if (k === "content_base64" || k === "body") {
      if (typeof v === "string") out[k] = `<${v.length} chars>`;
    } else if (typeof v === "string") out[k] = v.length > 120 ? `${v.slice(0, 120)}…` : v;
    else if (typeof v === "number" || typeof v === "boolean" || v === null) out[k] = v;
    else if (Array.isArray(v)) out[k] = v.slice(0, 20);
  }
  return redactSecrets(out);
}

const id = z.number().int().positive();
const lease = z.number().int().min(1).max(86_400).optional();

export function createBrainServer(cfg: BrainConfig): BrainServer {
  const { db, tasks } = cfg;
  const leaseWarningSeconds = cfg.leaseWarningSeconds ?? 120;
  const version = cfg.version ?? "0.0.1";

  // --- project scope --------------------------------------------------------

  function visible(principal: AgentPrincipal, task: Task | null): task is Task {
    return task !== null && task.project !== null && principal.projects.includes(task.project);
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
        const runId = await startRun(db, { component: principal.id, kind: "tool", tool: name, meta: { via: "mcp-brain", args: summarizeArgs(args) } });
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

    const reg = <S extends z.ZodRawShape>(name: ToolName, description: string, inputSchema: S, body: (args: z.infer<z.ZodObject<S>>) => Promise<Outcome>) =>
      server.registerTool(name, { description, inputSchema }, wrap(name, body) as never);

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
          if (!principal.projects.includes(a.project)) return fail("not_found");
          return done({ tasks: await tasks.listReady({ project: a.project, limit }) });
        }
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
        if (!principal.projects.includes(a.project)) return fail("forbidden");
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
      "Search the knowledge index — titles and one-line descriptions — within your grant. Tier `index` sees every settled title; tier `areas` only its granted Knowledge/ prefixes. Draft notes never appear.",
      { query: z.string().min(1).max(200), limit: z.number().int().min(1).max(100).optional() },
      async (a) => {
        const { tier, areas } = principal.grants;
        if (tier === "none") return fail("forbidden", undefined, { tier });
        const hits = await searchKnowledge(db, principal, a.query, a.limit ?? 20);
        return done({ tier, hits }, { tier, areas, hits: hits.length });
      },
    );

    reg(
      "knowledge_read",
      "Read one settled note by vault path (Knowledge/...). Requires an `areas` grant covering the path.",
      { path: z.string().min(1).max(500) },
      async (a) => {
        const { tier, areas } = principal.grants;
        const r = await readKnowledge(db, principal, a.path, cfg.readKnowledge);
        if (!r.ok) return fail(r.code, r.message, { tier, areas, path: a.path });
        return done({ path: r.path, title: r.title, content: r.content }, { tier, areas, path: a.path, bytes: r.content.length });
      },
    );

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
        const meta = { tools: [...TOOL_NAMES], knowledge_read: cfg.readKnowledge ? "available" : "not_available" };
        return cfg.readKnowledge
          ? { meta }
          : { status: "degraded" as const, meta, remediation: "knowledge_read answers not_available until a vault read path is configured (knowledge module)" };
      });
    },
  };
}
