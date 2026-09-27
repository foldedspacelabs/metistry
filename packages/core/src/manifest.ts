// Manifest schema — invariant 5: everything is a directory with a manifest.
// One discriminated union over `type`; CI and `metistry doctor` both
// validate against this, so the schema is the contract.

import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { VAULT_ROOT_AREA } from "./instance-layout.js";
import { dataPolicySchema, knowledgePrefix } from "./data-policy.js";

import { actionTableSchema, AUTONOMY_LEVELS } from "./actions.js";
import { connectionTypeShape, refineConnectionType } from "./connections.js";
import { providerSchema } from "./compute.js";
import { modelRefIssue } from "./model-ref.js";
import { crewModelIssue } from "./crew-model.js";
import { issueMessage, manifestScheduleSchema } from "./schedule.js";
import { EFFORTS } from "./tiers.js";

// A collector's or routine's `schedule:` — §2.5's closed shape (`{days, at,
// tz?}` or `{every}`), or, for one release, a legacy cron string
// (`manifestScheduleSchema`, schedule.ts). The console's runner reads both
// (apps/console/src/runner.ts); `.metistry/scheduled.yaml` may override it.
const schedule = manifestScheduleSchema;

const name = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/, "names are lowercase kebab-case (casing rule: only the vault is TitleCase)");

/**
 * The manifest format version (§2.7, Versioning). Every manifest carries
 * `schema: 1`; an unknown major is refused with the version named, so a unit
 * written for a newer Metistry is skipped with a reason rather than read as
 * something it is not. Optional on the kinds that predate it (their manifests
 * still validate without it); required on `connection-type` and by the
 * registry (registry.ts), which every extension loads through.
 */
export const MANIFEST_SCHEMA_VERSION = 1;

/** What is wrong with a `schema` value, without the key (a zod issue carries its path). */
function versionProblem(value: unknown): string {
  return value === undefined
    ? `missing — every manifest carries schema: ${MANIFEST_SCHEMA_VERSION}`
    : `${JSON.stringify(value)} is not a version this Metistry reads (it reads schema ${MANIFEST_SCHEMA_VERSION})`;
}

const manifestVersion = z.literal(MANIFEST_SCHEMA_VERSION, { error: (iss) => versionProblem(iss.input) });

/** Why a manifest's `schema` value is not one this Metistry reads (`schema: …`), or undefined when it is. */
export function schemaVersionIssue(value: unknown): string | undefined {
  return value === MANIFEST_SCHEMA_VERSION ? undefined : `schema: ${versionProblem(value)}`;
}

const base = z.object({
  name,
  description: z.string().optional(),
  schema: manifestVersion.optional(),
});

// TCC permissions a bridge may declare. Behavioral probes, not permission
// APIs, verify these at runtime (Phase 0 hard requirement 3). The enum stays
// closed: `screen_recording`, `microphone`, `audio_capture` join it for the
// live-capture bridge (§2.15, Q6) — every TCC-requiring bridge, this one
// included, is still held to PoC-1 (transport: http, runs_on: host) below.
const tccGrant = z.enum([
  "full_disk_access",
  "automation",
  "calendars",
  "reminders",
  "contacts",
  "screen_recording",
  "microphone",
  "audio_capture",
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

/**
 * The ONE model a collector may call, written as the same pinned
 * `<provider>/<model-id>` string `compute.yaml` uses everywhere else.
 *
 * Why a model reference and not a bare provider name: the cost rule is about
 * the provider, but invariant 4 is about the model — "no model decides which
 * model runs" is not satisfied by naming a server and taking whatever
 * `/v1/models` happens to list first. One field says both, checked by the
 * same `modelRefIssue` the compute file uses, so the two cannot drift.
 *
 * Absent — the default, and what every collector but `inbox-drain` is — means
 * this collector calls nothing at all.
 *
 * What makes it SAFE is not this field but what reads it: CI refuses a
 * reference whose provider is billable, and `completeJson()` refuses again at
 * the call (`collectorProviderIssue`, compute.ts). Declaring it here is how
 * the refusal becomes mechanical instead of a rule to remember.
 */
const usesModel = z.string().superRefine((v, ctx) => {
  const why = modelRefIssue(v);
  if (why) ctx.addIssue({ code: "custom", message: `uses_model ${why}` });
});

// ---- what Scheduled reads off a routine or collector (plan §2.5, T3-2) -------
//
// A manifest is the first of Scheduled's three layers: the default schedule,
// the name a person reads, the config a routine takes and the Needs You rules
// a sync may raise. `.metistry/scheduled.yaml` may change a value; it may
// never add a key the manifest does not declare — `scheduled.ts` checks every
// entry against these declarations, and an entry that names an undeclared key
// holds its component rather than being ignored (a change nothing applies).

/** What a person reads for a component: `Morning Brief`, not `morning-brief`. The `name` stays the stable handle (C55). */
const displayName = z
  .string()
  .min(1, "a name a person reads cannot be empty")
  .max(60, "a name a person reads is at most 60 characters")
  .refine((s) => s === s.trim() && !/[\x00-\x1f\x7f]/.test(s), "a name a person reads has no leading or trailing space and no control characters");

/** A declared key: snake_case, the spelling `scheduled.yaml` uses (`skip_without_calendar_event`, `review_requested`). */
const declaredKey = z.string().regex(/^[a-z][a-z0-9_]*$/, "a config key or Needs You rule is lowercase snake_case");

/**
 * The closed vocabulary of a routine's config fields. `path` is a vault path
 * with a TitleCase first segment (`Templates/Standup.md`) — never
 * `.metistry/`, `Artifacts/` or a traversal. A new kind is a product change,
 * never a manifest line.
 */
export const CONFIG_FIELD_KINDS = ["text", "path", "number", "boolean", "choice"] as const;
export type ConfigFieldKind = (typeof CONFIG_FIELD_KINDS)[number];

const MAX_CONFIG_TEXT = 500; // limit: fixed — a config value is a setting, not a document; the task prompt has its own ceiling (scheduled.ts MAX_TASK_CHARS)

/** Why `value` is not a valid value for a field of `kind` (with these `options`), or undefined when it is. The ONE check, for a manifest's default and for the owner's `scheduled.yaml` alike. */
export function configValueIssue(field: { readonly kind: ConfigFieldKind; readonly options?: readonly string[] | undefined }, value: unknown): string | undefined {
  switch (field.kind) {
    case "boolean":
      return typeof value === "boolean" ? undefined : "is true or false";
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? undefined : "is a number";
    case "text":
      return typeof value === "string" && value.length <= MAX_CONFIG_TEXT ? undefined : `is text, at most ${MAX_CONFIG_TEXT} characters`;
    case "path":
      return knowledgePrefix.safeParse(value).success
        ? undefined
        : "is a vault path with a TitleCase first segment (Templates/Standup.md) — never .metistry/, Artifacts/ or a traversal";
    case "choice":
      return typeof value === "string" && (field.options ?? []).includes(value) ? undefined : `is one of ${(field.options ?? []).join(", ")}`;
  }
}

/** One config field a routine takes: its kind, the label a person reads, and its default — the value in force until the owner changes it. */
export const configFieldSchema = z
  .object({
    kind: z.enum(CONFIG_FIELD_KINDS, { error: () => `kind is one of ${CONFIG_FIELD_KINDS.join(", ")}` }),
    label: displayName,
    description: z.string().optional(),
    default: z.union([z.string(), z.number(), z.boolean()]),
    /** `choice` only: the values it may take. */
    options: z.array(z.string().min(1)).min(2, "a choice has at least two options").optional(),
  })
  .strict()
  .superRefine((f, ctx) => {
    if (f.kind === "choice" && f.options === undefined) ctx.addIssue({ code: "custom", path: ["options"], message: "a choice lists its options" });
    if (f.kind !== "choice" && f.options !== undefined) ctx.addIssue({ code: "custom", path: ["options"], message: "only a choice has options" });
    const issue = configValueIssue(f, f.default);
    if (issue) ctx.addIssue({ code: "custom", path: ["default"], message: `the default ${issue}` });
  });

export type ConfigField = z.infer<typeof configFieldSchema>;

/**
 * One Needs You rule a collector may raise (§2.7: "declared `needs_you` raise
 * rules"): the label a person reads beside its toggle, and whether it is on
 * until the owner says otherwise. `scheduled.yaml`'s `syncs.<name>.raise`
 * switches a declared rule; it cannot name one that is not here.
 */
export const raiseRuleSchema = z
  .object({
    label: displayName,
    description: z.string().optional(),
    default: z.boolean({ error: () => "a Needs You rule's default is true or false" }),
  })
  .strict();

export type RaiseRule = z.infer<typeof raiseRuleSchema>;

/**
 * Where a collector appears under Scheduled (§2.5): a **sync** (the default —
 * it reads a connection, on an interval) or a **routine** (housekeeping with
 * no connection: Inbox Sort, Usage Rollup). It decides which section of
 * `scheduled.yaml` holds its changes — `routines.<name>` or `syncs.<name>`.
 */
export const PRESENTS_AS = ["sync", "routine"] as const;
export type PresentsAs = (typeof PRESENTS_AS)[number];

const configDeclarations = z.record(declaredKey, configFieldSchema);

export const collectorManifest = base.extend({
  type: z.literal("collector"),
  schedule,
  writes: z.array(z.string()).min(1),
  reads: z.array(z.string()).default([]),
  requires: requiresField,
  uses_model: usesModel.optional(),
  display_name: displayName.optional(),
  presents_as: z.enum(PRESENTS_AS, { error: () => `presents_as is ${PRESENTS_AS.join(" or ")}` }).optional(),
  config: configDeclarations.optional(),
  needs_you: z.record(declaredKey, raiseRuleSchema).optional(),
});

export const routineManifest = base.extend({
  type: z.literal("routine"),
  schedule,
  agent: z.string().optional(),
  requires: requiresField,
  display_name: displayName.optional(),
  config: configDeclarations.optional(),
});

// Secrets are referenced, never written into a manifest: `env:VAR`.
const envRef = z
  .string()
  .regex(/^env:[A-Z][A-Z0-9_]*$/, "must be an environment reference (env:VAR) — never a literal secret");

// `knowledgePrefix` and `dataPolicySchema` live in data-policy.ts so that
// compute.ts (a provider's data policy) and this file (a target's, and the
// `provider` manifest kind) can both use them without importing each other.
export { dataPolicySchema, type DataPolicy } from "./data-policy.js";

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
 * crews — the assistant decides what leaves the brain), the named-query
 * tools (queries_list, queries_run) — a named query is not filtered by a
 * crew's scope/projects the way every other group here is, so handing it to
 * a crew would leak past the boundary `uses` is meant to hold — and
 * `request_access`, because a crew's scope is THIS file: `scope:` in
 * `agents/<area>/<name>.md`, re-synced onto its registry row on every crew
 * sync (apps/console/src/crews.ts). An approved ask would be undone by that
 * sync, so widening a crew is an edit to its manifest, in the user's hand,
 * and the console refuses the widening as well (docs/ops/actions.md).
 */
export const CREW_NEVER_TOOLS = ["knowledge_write", "agents_delegate", "queries_list", "queries_run", "request_access"] as const;

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

// The crew `model:` forms live in `crew-model.ts` (compute.ts needs them and
// this module imports compute.ts); re-exported so callers keep one import.
export { CREW_MODELS, SAME_AS_ASSISTANT, crewModelIssue, isLegacyCrewModel, type CrewModelAlias } from "./crew-model.js";

const crewModel = z.string().superRefine((v, ctx) => {
  const why = crewModelIssue(v);
  if (why) ctx.addIssue({ code: "custom", message: why });
});

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
    /**
     * `<provider>/<model-id>` (a model from Your Models, pinned to where it
     * runs — C128, C132), `same_as_assistant`, or a legacy alias read for one
     * release (`crewModelIssue`). What a run resolves it to is
     * `resolveCrewAssignment` (compute.ts); what the actor says it is,
     * `crewCompute` (actor.ts) — one rule, two readers.
     */
    model: crewModel,
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
    /** Read-tier areas (§4.11 scoped escape hatch): vault prefixes below the root. The console's grant validator holds the exact (TitleCase) shape; here: never the bare vault, never traversal. */
    scope: z.array(knowledgePrefix.refine((p) => p !== VAULT_ROOT_AREA, "scope entries must name an area of the vault — the bare vault is not a crew scope")).default([]),
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

// --- a crew's definition FILE ------------------------------------------------
//
// `agents/<area>/<name>.md`: YAML frontmatter (the manifest above), then the
// operating prompt. Parsed here — not in the console that loads it — because
// two hands write and read the same file: the console's crew registry, and
// `metistry agents define` (M12), which must refuse exactly what the console
// would refuse BEFORE it writes, or the owner's edit would land and then be
// dropped at the next sync with a log line nobody reads.

/** Frontmatter, then the body. */
export const CREW_FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/;
/** The longest operating prompt a crew file may carry. */
export const MAX_CREW_PROMPT_CHARS = 32_000; // limit: fixed — a crew manifest longer than this is a malformed file; refusing it whole is the point

export interface ParsedCrewDefinition {
  readonly manifest: AgentManifest;
  /** The body below the frontmatter, trimmed: the crew's operating prompt. */
  readonly prompt: string;
}

/**
 * Parse one crew definition file. Throws with `where:` on any miss — a
 * malformed manifest is refused whole, never partially read. `expected`
 * (from the path) must agree with the frontmatter: the name IS the filename,
 * and an `area` key, when present, IS the directory (absent, it is filled
 * from the directory).
 */
export function parseCrewDefinition(text: string, where: string, expected?: { readonly name: string; readonly area: string }): ParsedCrewDefinition {
  const m = CREW_FRONTMATTER.exec(text);
  if (!m) throw new Error(`${where}: expected YAML frontmatter (--- … ---) followed by the operating prompt`);
  let raw: unknown;
  try {
    raw = parseYaml(m[1]!);
  } catch (err) {
    throw new Error(`${where}: frontmatter is not YAML: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${where}: frontmatter must be a mapping`);
  const withArea = expected && (raw as { area?: unknown }).area === undefined ? { ...(raw as object), area: expected.area } : raw;
  const r = validateManifest(withArea);
  if (!r.ok) throw new Error(`${where}: invalid manifest: ${r.errors.join("; ")}`);
  if (r.manifest.type !== "agent") throw new Error(`${where}: type must be agent (got ${r.manifest.type})`);
  const manifest = r.manifest;
  if (expected) {
    if (manifest.name !== expected.name) throw new Error(`${where}: manifest name "${manifest.name}" must match the filename "${expected.name}"`);
    if (manifest.area !== expected.area) throw new Error(`${where}: manifest area "${manifest.area}" must match the directory "${expected.area}"`);
  }
  const prompt = m[2]!.trim();
  if (!prompt) throw new Error(`${where}: the body below the frontmatter is the crew's operating prompt and may not be empty`);
  if (prompt.length > MAX_CREW_PROMPT_CHARS) throw new Error(`${where}: operating prompt exceeds ${MAX_CREW_PROMPT_CHARS} characters`);
  return { manifest, prompt };
}

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

// --- connection types (§2.6, §2.7) -------------------------------------------
//
// A provider of a connection type: Google Calendar, CalDAV, IMAP, Linear, a
// known MCP service. Its `type` is `connection-type` — the kind marker every
// manifest carries — and `provides` names the connection type it provides,
// because `agent` is both a manifest type and a connection type and one key
// cannot mean both. The vocabularies it names values from are closed and live
// in connections.ts; `strict`, because a typo'd key in a unit that declares
// what an integration may do must fail loudly.

export const connectionTypeManifest = base
  .extend({
    type: z.literal("connection-type"),
    schema: manifestVersion,
    ...connectionTypeShape,
  })
  .strict()
  .superRefine(refineConnectionType);

export type ConnectionTypeManifest = z.infer<typeof connectionTypeManifest>;

// --- compute provider templates (§2.7) --------------------------------------
//
// A provider template: a `compute.yaml` provider block with a name, which
// `metistry compute providers add --from <name>` copies into the instance's
// compute.yaml. The product's ship in `seed/compute-templates/<name>/`; an
// owner's own is an extension (`.metistry/extensions/<name>/`), loaded
// through the same registry. The block IS `providerSchema`, so a template can
// never say anything a provider written into compute.yaml could not — and a
// new kind of provider (a new `kind`, a new locality) stays a product change.
// A new kind, so `schema: 1` is required and unknown keys are refused.

export const providerManifest = base
  .extend({
    type: z.literal("provider"),
    schema: manifestVersion,
    /** The block `providers add --from` writes under `providers.<name>` in compute.yaml. */
    provider: providerSchema,
  })
  .strict();

export type ProviderManifest = z.infer<typeof providerManifest>;

export const manifestSchema = z.discriminatedUnion("type", [
  bridgeManifest,
  collectorManifest,
  agentManifest,
  routineManifest,
  targetManifest,
  serviceManifest,
  connectionTypeManifest,
  providerManifest,
]);

/** Every manifest kind — the `type` values `manifestSchema` discriminates on. */
export type ManifestType = Manifest["type"];

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
    // a record's bad key is reported by what the key rule says, not zod's "Invalid key in record"
    errors: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${issueMessage(i)}`),
  };
}
