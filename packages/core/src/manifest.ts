// Manifest schema — invariant 5: everything is a directory with a manifest.
// One discriminated union over `type`; CI and `metistry doctor` both
// validate against this, so the schema is the contract.

import { z } from "zod";

import { actionTableSchema, AUTONOMY_LEVELS } from "./actions.js";
import { EFFORTS } from "./tiers.js";

const cron = z
  .string()
  .regex(
    /^(@(hourly|daily|weekly|monthly)|(\S+\s+){4}\S+)$/,
    "schedule must be a 5-field cron expression or @hourly/@daily/@weekly/@monthly",
  );

const name = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/, "names are lowercase kebab-case (casing rule: only Knowledge/ is TitleCase)");

const base = z.object({
  name,
  description: z.string().optional(),
});

// TCC permissions a bridge may declare. Behavioral probes, not permission
// APIs, verify these at runtime (Phase 0 hard requirement 3).
const tccGrant = z.enum([
  "full_disk_access",
  "automation",
  "calendars",
  "reminders",
  "contacts",
]);

export const bridgeManifest = base.extend({
  type: z.literal("bridge"),
  transport: z.enum(["http", "stdio"]),
  port: z.number().int().min(1).max(65535).optional(),
  runs_on: z.enum(["host", "container"]),
  requires_tcc: z.array(tccGrant).default([]),
  // Default eager (PoC-17: lazy loses on small surfaces); lazy is for
  // bridges past >20 tools / >5k definition tokens.
  discovery: z.enum(["lazy", "eager"]).default("eager"),
  degrades: z.string().default("absent"), // "absent" | <fallback bridge name>
  exposes: z
    .array(
      z.object({
        name: z.string(),
        description: z.string().optional(),
        destructive: z.boolean().default(false),
      }),
    )
    .min(1),
}).superRefine((m, ctx) => {
  // PoC-1: a stdio server spawned by the agent inherits the agent's TCC
  // identity. Any TCC-requiring bridge MUST be its own http host service.
  if (m.requires_tcc.length > 0 && (m.transport !== "http" || m.runs_on !== "host")) {
    ctx.addIssue({
      code: "custom",
      message: "bridges with requires_tcc must be transport: http and runs_on: host (PoC-1)",
    });
  }
  if (m.transport === "http" && m.port === undefined) {
    ctx.addIssue({ code: "custom", message: "http bridges must declare a port" });
  }
});

const envName = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]*$/, "environment variable names are UPPER_SNAKE_CASE");

/**
 * What a scheduled component needs before a run is worth starting
 * (preflight, docs/ops/automation.md): environment variables that must be
 * non-empty, environment variables holding a base URL whose `/check` must
 * answer, and whether the run ends up enqueueing an assistant turn — an
 * install with no engine credential should never spend a window producing
 * one. The manifest already declares what a component needs (invariant 5);
 * this makes that declaration machine-checkable instead of prose.
 */
export const requirementsSchema = z.object({
  env: z.array(envName).default([]),
  reachable: z.array(envName).default([]),
  engine: z.boolean().default(false),
});

export type Requirements = z.infer<typeof requirementsSchema>;

/**
 * `requires` has two forms and the older one still validates: an array of
 * free-text labels (`requires: [aws-credentials]` — documentation only, no
 * preflight) or the structured form above. `requirementsOf` (preflight.ts)
 * normalises both, so no manifest has to be rewritten to keep working.
 */
const requiresField = z.union([z.array(z.string()), requirementsSchema]).default([]);

export const collectorManifest = base.extend({
  type: z.literal("collector"),
  schedule: cron,
  writes: z.array(z.string()).min(1),
  reads: z.array(z.string()).default([]),
  requires: requiresField,
});

export const routineManifest = base.extend({
  type: z.literal("routine"),
  schedule: cron,
  agent: z.string().optional(),
  requires: requiresField,
});

// Secrets are referenced, never written into a manifest: `env:VAR`.
const envRef = z
  .string()
  .regex(/^env:[A-Z][A-Z0-9_]*$/, "must be an environment reference (env:VAR) — never a literal secret");

// A vault-relative path prefix the brief may reference (plan §4.15: scopes
// are prefix matches, so `Knowledge/Areas/fsl` covers every sub-area).
const knowledgePrefix = z
  .string()
  .regex(/^Knowledge(\/[A-Za-z0-9_.-]+)*$/, "allow entries are Knowledge/... path prefixes (no '..', no trailing slash)")
  .refine((p) => !p.split("/").includes(".."), "allow entries may not contain '..'");

// What a brief bound for this target may carry (§4.18.B). Every field is
// required so the policy is a declaration, not a default nobody chose. The
// dispatch tool enforces it — a manifest is the contract, the tool is the
// control.
export const dataPolicySchema = z.object({
  /** Knowledge path prefixes a brief may reference; empty = no vault references at all. */
  allow: z.array(knowledgePrefix),
  /** Provenance classes that may never leave the machine via this target, e.g. `comms` (§4.12). */
  deny_sources: z.array(z.string().regex(/^[a-z][a-z0-9_-]*$/, "source names are lowercase kebab-case")),
  max_brief_bytes: z.number().int().positive(),
});

export type DataPolicy = z.infer<typeof dataPolicySchema>;

// --- agents (crews) -----------------------------------------------------------
//
// A crew (plan §4.11, Phase 5 "crew definitions with their own toolsets") is
// a sub-agent defined by `agents/<area>/<name>.md` in the instance repo: this
// frontmatter, then its operating prompt. Its toolset is named in GROUPS of
// mcp-brain tools, never tool by tool, so the one rule that matters —
// sub-agents never write knowledge — is a property of the table below, not
// of a review.

/** mcp-brain tool groups a crew may name in `uses`. `brain-read` / `brain-report` / `report` are older spellings, still accepted (§4.11). */
export const CREW_TOOL_GROUPS = {
  /** Read the vault under the crew's `scope` (grant tier `areas`): the title index, one note's content, a directory listing, or a content regex — all the same grant. */
  knowledge: ["knowledge_search", "knowledge_read", "knowledge_list", "knowledge_grep"],
  /** Findings, decisions, gotchas, progress — as requests in the Needs You queue the assistant folds later. */
  requests: ["requests_create"],
  /** Notes and files into the inbox as proposals. */
  capture: ["capture"],
  /** The shared task list, within the crew's `projects`. */
  tasks: ["tasks_list", "tasks_claim", "tasks_renew", "tasks_update", "tasks_release", "tasks_close", "tasks_create"],
  /**
   * The room on a task (0016, docs/ops/threads.md): read what was said, add
   * to it. Its OWN group rather than part of `tasks` on purpose — speaking
   * is a new power, so an existing crew gains it only when the user edits
   * the manifest, never by a release. A crew still READS the last of the
   * room without this group: the brief carries it (the prior-work block),
   * and the brief is not a tool.
   */
  rooms: ["tasks_comment", "tasks_thread"],
  /**
   * Ask the console to DO one of four things (docs/ops/actions.md): dispatch
   * a work row, patch a task, comment, capture. Its own group for the same
   * reason `rooms` is — acting is a new power, so a crew gains it only when
   * the user edits the manifest — and holding the tool is only half the gate:
   * the agent's `autonomy` record decides whether each kind is refused,
   * proposed, or run on the spot.
   */
  actions: ["propose_action"],
  /** Versioned output into the crew's projects (§4.21). */
  artifacts: ["artifacts_publish", "artifacts_get", "artifacts_list", "artifacts_comment", "artifacts_resolve", "artifacts_review"],
} as const;
export type CrewToolGroup = keyof typeof CREW_TOOL_GROUPS;

/** Plan-spelled and pre-2026-09-09 aliases → group. */
export const CREW_GROUP_ALIASES: Readonly<Record<string, CrewToolGroup>> = { "brain-read": "knowledge", "brain-report": "requests", report: "requests" };

/**
 * Tools NO crew may ever hold, whatever `uses` says: the assistant's own
 * write path (one writer, §4.11), the dispatch tool (a crew never dispatches
 * crews — the assistant decides what leaves the brain), and the named-query
 * tools (queries_list, queries_run) — a named query is not filtered by a
 * crew's scope/projects the way every other group here is, so handing it to
 * a crew would leak past the boundary `uses` is meant to hold.
 */
export const CREW_NEVER_TOOLS = ["knowledge_write", "agents_delegate", "queries_list", "queries_run"] as const;

/** Resolve a `uses` entry to its group; undefined when it names nothing known. */
export function crewGroupOf(entry: string): CrewToolGroup | undefined {
  if (Object.hasOwn(CREW_TOOL_GROUPS, entry)) return entry as CrewToolGroup;
  return Object.hasOwn(CREW_GROUP_ALIASES, entry) ? CREW_GROUP_ALIASES[entry] : undefined;
}

/** The exact mcp-brain tool names a `uses` list grants, in group order, deduplicated. Unknown entries contribute nothing (the schema refuses them first). */
export function crewToolsFor(uses: readonly string[]): string[] {
  const out: string[] = [];
  for (const group of Object.keys(CREW_TOOL_GROUPS) as CrewToolGroup[]) {
    if (!uses.some((u) => crewGroupOf(u) === group)) continue;
    for (const t of CREW_TOOL_GROUPS[group]) if (!out.includes(t)) out.push(t);
  }
  return out;
}

const crewUse = z.string().superRefine((u, ctx) => {
  if (crewGroupOf(u)) return;
  const never = (CREW_NEVER_TOOLS as readonly string[]).includes(u);
  ctx.addIssue({
    code: "custom",
    message: never
      ? `${u} is never available to a crew (sub-agents never write knowledge or dispatch crews)`
      : `unknown tool group "${u}" — one of ${Object.keys(CREW_TOOL_GROUPS).join(", ")} (aliases: ${Object.keys(CREW_GROUP_ALIASES).join(", ")})`,
  });
});

export const CREW_MODELS = ["haiku", "sonnet", "opus"] as const;

// An agent id, agent-manifest-side: same shape the console's registry uses
// for `agents.id` (AGENT_ID_RE) — a crew name, or another agent this one may
// name in `autonomy`.
const autonomyAgentRef = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,39}$/, "must be an agent id (lowercase kebab-case, at most 40 characters)");

/**
 * §4.21 optional narrowing below the project default — never widening.
 * Absent keys mean "project members" / the default cap. This is the
 * manifest-side shape of `apps/console/src/agents.ts`'s `Autonomy` (the
 * registry's own validator, `validateAutonomy`, re-normalizes it at sync —
 * two callers, one shape, checked identically here at the schema boundary).
 * `strictObject`: a typo'd key must fail loudly, never silently mean "no
 * narrowing" — the whole point of the block.
 */
export const autonomySchema = z.strictObject({
  may_dispatch_to: z.array(autonomyAgentRef).optional(),
  /** agent ids and/or the literal "user" */
  accept_from: z.array(z.union([autonomyAgentRef, z.literal("user")])).optional(),
  max_open_bundles: z.number().int().min(1).optional(),
  /**
   * A3 (docs/ops/actions.md): how much room this crew has with an `action`
   * proposal. The one key here that can WIDEN — `agents/` is a §4.7 protected
   * path, so a manifest that raises it is the owner's own hand, and the
   * registry sync records and alerts the raise exactly as the console route
   * does. Absent = `observe`: nothing.
   */
  level: z.enum(AUTONOMY_LEVELS).optional(),
  /** Per-kind override, clamped by `level` (never past it). Absent kinds take the level's default. */
  actions: actionTableSchema.optional(),
});

export type AgentAutonomy = z.infer<typeof autonomySchema>;

export const agentManifest = base
  .extend({
    type: z.literal("agent"),
    /** Grouping only (`agents/<area>/`); hierarchy is `manages`, not depth (plan Terminology). */
    area: name.optional(),
    model: z.enum(CREW_MODELS),
    /**
     * Reasoning effort per run (the SDK's `effort`), the other half of the
     * tier pair (core's `tiers.ts`). Default **low**: the crew shape that
     * pays — absorb bulk context on a cheap model, return one report — is
     * extraction, not deliberation; the assistant does the thinking. Raise it
     * deliberately, per crew, and expect the cost to follow (low→max is ~3.5x
     * on the research's figures).
     */
    effort: z.enum(EFFORTS).default("low"),
    uses: z.array(crewUse).default([]),
    skills: z.array(name).default([]),
    /** Read-tier areas (§4.11 scoped escape hatch): Knowledge/ prefixes below the root. The console's grant validator holds the exact (TitleCase) shape; here: never bare, never traversal. */
    scope: z.array(knowledgePrefix.refine((p) => p !== "Knowledge", "scope entries must name an area below Knowledge/ — the bare vault is not a crew scope")).default([]),
    /** Project membership (§4.19; §4.21 autonomy boundary): slugs. Empty = member of no project. */
    projects: z.array(name).default([]),
    manages: z.array(name).default([]),
    /** Agentic turns per run (the SDK's maxTurns). */
    max_turns: z.number().int().min(1).max(200).default(12),
    /** Cost cap per run in USD; the run aborts past it (the SDK's maxBudgetUsd). */
    budget_usd_per_run: z.number().min(0).max(50).default(0.5),
    /** §4.21 dispatch/accept/bundle narrowing (registry sync maps this onto `agents.autonomy`). Absent = the defaults apply. */
    autonomy: autonomySchema.optional(),
  })
  // unknown top-level keys are a manifest bug, not a silent no-op — refuse
  // whole, like every other miss `parseCrewFile` reports (a typo'd field
  // must not read as "validated, ignored").
  .strict();

export type AgentManifest = z.infer<typeof agentManifest>;

export const targetManifest = base
  .extend({
    type: z.literal("target"),
    transport: z.enum(["mcp", "http", "github", "local"]),
    /** How work goes in — shape depends on transport (github: `repo`). */
    submit: z.record(z.string(), z.unknown()),
    /** How results come back. `via: report_queue` is the only return path (§4.18.B). */
    result: z.looseObject({ via: z.string() }),
    auth: envRef.optional(),
    cost: z.object({ per_run_estimate_usd: z.number().nonnegative() }).optional(),
    data_policy: dataPolicySchema,
  })
  .superRefine((m, ctx) => {
    if (m.transport === "github") {
      const repo = m.submit.repo;
      if (typeof repo !== "string" || !/^(env:[A-Z][A-Z0-9_]*|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/.test(repo)) {
        ctx.addIssue({
          code: "custom",
          path: ["submit", "repo"],
          message: "github targets must declare submit.repo as owner/repo or env:VAR",
        });
      }
      if (m.auth === undefined) {
        ctx.addIssue({ code: "custom", path: ["auth"], message: "github targets must declare auth (env:VAR — a write token)" });
      }
    }
  });

export type TargetManifest = z.infer<typeof targetManifest>;

// Long-running processes doctor must see: reconciler, watchdog, console
// (review SHOULD-14 — the components most likely to die silently).
export const serviceManifest = base.extend({
  type: z.literal("service"),
  runs_on: z.enum(["host", "container"]),
  port: z.number().int().min(1).max(65535).optional(),
});

export const manifestSchema = z.discriminatedUnion("type", [
  bridgeManifest,
  collectorManifest,
  agentManifest,
  routineManifest,
  targetManifest,
  serviceManifest,
]);

export type Manifest = z.infer<typeof manifestSchema>;

export type ManifestResult =
  | { ok: true; manifest: Manifest }
  | { ok: false; errors: string[] };

/** Validate a parsed manifest object. Never throws. */
export function validateManifest(input: unknown): ManifestResult {
  const parsed = manifestSchema.safeParse(input);
  if (parsed.success) return { ok: true, manifest: parsed.data };
  return {
    ok: false,
    errors: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
  };
}
