// The actor model (plan §2.4; ruling 4): ONE type for everything that acts —
// the instance's assistant, a crew it delegates to, and an external agent
// that connects in. Chat runs the assistant actor; a routine names an actor
// and a task; a crew run is an actor with a brief; the permissions table
// renders an actor.
//
// Storage does not move. There is no `actors` table and no migration: an
// actor is COMPOSED, by one resolver, from what already exists — the
// `agents` registry row, a crew's manifest, `identity.yaml`, `compute.yaml`.
// The source mapping, field by field, is docs/ops/actors.md.
//
// F-2 froze the SHAPE; T4-6 implements it: `resolveActor` below composes an
// actor from its sources, and `describePermissions()` (beside `describeScope`
// in access.ts) is what fills a `PermissionRow`.
//
// Like the rest of core it imports no Postgres, no vault and no config
// (CLAUDE.md: the dependency arrow points one way). The host loads the
// sources and hands them in, so resolution is pure — the property that lets
// `describeScope` render an agent the CLI read over HTTP and one the console
// read out of Postgres in the same words.

import { describePermissions, type GrantSource, type GrantTier, type Principal, type Role, type Scope } from "./access.js";
import type { ActionAutonomy } from "./actions.js";
import type { Compute } from "./compute.js";
import { crewModelIssue, isLegacyCrewModel, SAME_AS_ASSISTANT } from "./crew-model.js";
import { CREW_TOOL_GROUPS, crewGroupOf, type AgentManifest, type CrewToolGroup } from "./manifest.js";
import { modelRefIssue } from "./model-ref.js";
import type { Effort } from "./tiers.js";

// ---- what an actor is ----------------------------------------------------------

/** The three kinds of thing that act. */
export const ACTOR_KINDS = ["assistant", "crew", "external"] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

/** `agents.kind` as stored — the list migration 0025's CHECK holds the column to (the console's `STORED_AGENT_KINDS`). */
export type AgentRowKind = "external" | "internal" | "crew";

/**
 * **The mapping table**: a registry row's kind → the actor it is, and the
 * role the door decides on. It is the mapping `principalOfRow` (agents.ts)
 * and the console's `principalOf` already make, written down once, so what
 * an actor SAYS it holds and what the door DOES about it start from the same
 * word.
 *
 * `internal` is the instance's own assistant by the column's definition
 * (0025). A stored value outside these three resolves as `external`, the
 * narrowest — `authenticateAgent`'s rule: arriving unknown must never make a
 * row more than it was.
 */
export const ACTOR_OF_AGENT_KIND = Object.freeze({
  internal: { kind: "assistant", role: "assistant" },
  crew: { kind: "crew", role: "crew" },
  external: { kind: "external", role: "agent" },
} as const satisfies Record<AgentRowKind, { readonly kind: ActorKind; readonly role: Role }>);

// ---- the definition: what the owner wrote --------------------------------------

/** One file that defines an actor — what the owner edits, by hand or through `metistry agents define` (M12). */
export interface DefinitionFile {
  /**
   * POSIX and relative, never absolute (invariant 7). An `instance` file is
   * relative to the instance directory (`.metistry/agents/research/scout.md`,
   * `CLAUDE.md`); a `product` file to the release (`seed/agents/example/researcher.md`).
   */
  readonly path: string;
  /**
   * `instance` — the owner's, versioned in their repo. `product` — shipped
   * with the release and read through the D4 overlay because the instance
   * has no file of that name; changing it means writing the instance's own
   * copy, which then wins by name.
   */
  readonly origin: "instance" | "product";
  /** sha256 of the bytes, hex: what a run stamps (crews.ts already does) and what an edit is made against — a hash that moved is the 409. */
  readonly sha256: string;
}

/** `identity.yaml`'s fields a surface shows. The ONLY place the assistant's name lives (CLAUDE.md); code carries it, never spells it. */
export interface AssistantIdentity {
  readonly name: string;
  /** The `@handle` the owner addresses it by; null when the file names none. */
  readonly mention: string | null;
  /** The assistant's mark (C123) — the `icon:` key, which T2-16 kept (`metistry identity set --mark` writes it). Null when unset. */
  readonly mark: string | null;
}

export interface AssistantDefinition {
  readonly kind: "assistant";
  readonly identity: AssistantIdentity;
  /**
   * The files that exist, in composition order: `identity.yaml`, the root
   * `CLAUDE.md` (the owner's operating instructions — absent until written),
   * `.metistry/assistant-prompt.md`. The first and last go through the D4
   * overlay, so either may be `product`.
   */
  readonly files: readonly DefinitionFile[];
}

export interface CrewActorDefinition {
  readonly kind: "crew";
  /** `.metistry/agents/<area>/` — grouping only. */
  readonly area: string;
  /** The manifest's `description:` — the assistant's roster line. Null when absent. */
  readonly description: string | null;
  /** The operating prompt: the body below the frontmatter, trimmed. What a routine's runner composes with a task — appended, never replaced (§2.5). */
  readonly prompt: string;
  /** Exactly one: the manifest, frontmatter and prompt together. */
  readonly files: readonly [DefinitionFile];
}

/** An external agent has none: it is someone else's code. */
export type ActorDefinition = AssistantDefinition | CrewActorDefinition;

// ---- compute and limits ---------------------------------------------------------

/** `<provider>/<model-id>` (model-ref.ts). The template refuses a bare `haiku | sonnet | opus` at compile time; `modelRefIssue` is the runtime half. */
export type ModelRefString = `${string}/${string}`;

export type ActorCompute =
  /** The assistant: the dynamic router over `compute.yaml`'s assignments and `rules.yaml`'s tiers (§2.8). */
  | { readonly kind: "router" }
  /** A crew's own model and effort, from its definition (C128). */
  | { readonly kind: "model"; readonly ref: ModelRefString; readonly effort: Effort }
  /** "Same as" the assistant: its DEFAULT TIER — `assignments.default`, model and effort — never the router (§4 Q14). */
  | { readonly kind: "same_as_assistant" };

/** Per-run limits a definition sets: the manifest's `max_turns` and `budget_usd_per_run`. */
export interface ActorLimits {
  readonly maxTurns: number;
  /** USD; the run stops past it. */
  readonly budgetUsdPerRun: number;
}

// ---- permissions: Resource × Read × Write ----------------------------------------

/**
 * The table's rows (screen 7 §4.1), a closed list. Connections are the open
 * end: one row per connection the actor may reach, `{ kind: "connection" }`.
 * `queries` and `agents` are here because the table's legend is "anything
 * not listed is not granted", and a held power with no row would make it lie.
 */
export const PERMISSION_RESOURCES = ["knowledge", "work", "artifacts", "inbox", "queries", "agents"] as const;
export type PermissionResourceKind = (typeof PERMISSION_RESOURCES)[number];

export type PermissionResource = { readonly kind: PermissionResourceKind } | { readonly kind: "connection"; readonly name: string };

/** How a line arrived. The marker in the cell; `base` carries none — a marker on everything is a marker on nothing. */
export type PermissionProvenance =
  /** How the actor holds it by default. `source` is the row's: `environment` (the assistant's configuration — never a grant, C52), `registry` (the owner's hand) or a crew's manifest. */
  | { readonly kind: "base"; readonly source: GrantSource }
  /** Approved in Needs You. `proposalId` links the request; null only for a hand-written override (0023). */
  | { readonly kind: "approved"; readonly proposalId: number | null }
  /** Held only while this routine runs — a per-run grant (§2.5, T3-8). */
  | { readonly kind: "routine"; readonly routine: string };

/** One thing in a cell: an area, a project, a verb, a connection tool. */
export interface PermissionEntry {
  /** What a client matches on, never shown: `Areas/Ops`, a project slug, `update`, a tool name. */
  readonly key: string;
  /** The words every surface prints — the CLI, the console and MetistryKit print this, not their own. */
  readonly label: string;
  /** ⏱ — the owner answers first: an action at `propose`, a connection tool at `ask`. */
  readonly asks: boolean;
  readonly provenance: PermissionProvenance;
}

/** One line per resource. An empty cell renders `—`: absence is the denial. */
export interface PermissionRow {
  readonly resource: PermissionResource;
  /** The resource in words ("Knowledge", or the connection's name). The ⧉ glyph is the renderer's, from `resource.kind`. */
  readonly label: string;
  readonly read: readonly PermissionEntry[];
  readonly write: readonly PermissionEntry[];
}

type RowOf<K extends PermissionResourceKind> = PermissionRow & { readonly resource: { readonly kind: K } };
type ConnectionRow = PermissionRow & { readonly resource: { readonly kind: "connection"; readonly name: string } };
/** Knowledge, read-only: the write cell is the empty tuple, so an entry there does not compile. */
type KnowledgeReadOnlyRow = RowOf<"knowledge"> & { readonly write: readonly [] };

/**
 * A row an EXTERNAL agent may hold. Never a Knowledge write (one writer,
 * §4.11 — `knowledge_write` is the assistant's alone at the door) and never
 * the Agents row (`agents_delegate` is the assistant's alone). Unrepresentable
 * rather than merely untested: an actor whose lines carry either does not compile.
 */
export type ExternalPermissionRow = KnowledgeReadOnlyRow | RowOf<"work" | "artifacts" | "inbox" | "queries"> | ConnectionRow;

/** A row a CREW may hold: an external agent's, less Queries — `queries_*` are in `CREW_NEVER_TOOLS`, since no crew scope filters a named query. */
export type CrewPermissionRow = KnowledgeReadOnlyRow | RowOf<"work" | "artifacts" | "inbox"> | ConnectionRow;

export interface ActorPermissions<R extends Role, Row extends PermissionRow> {
  /** The role the door decides on — `ACTOR_OF_AGENT_KIND[kind].role`. */
  readonly role: R;
  /** The registry row's grants as `may()` reads them (`principalOfRow`'s derivation). The BASE: a routine's per-run grant is not in it. */
  readonly scope: Scope;
  /** The action half of `agents.autonomy` — the same record as `scope.autonomy`, surfaced because the triple names it. */
  readonly autonomy: ActionAutonomy;
  /** Where the base came from: the Principal's `source`, so an actor is the Principal the door decides on without a second lookup. */
  readonly source: GrantSource;
  /** `describePermissions()`: Resource × Read × Write, provenance per entry. */
  readonly lines: readonly Row[];
}

// ---- tools ------------------------------------------------------------------------

export interface ActorTools<G extends readonly CrewToolGroup[] | null> {
  /**
   * A crew's allowlist: its manifest's `uses`, aliases resolved, in
   * `CREW_TOOL_GROUPS` order. `null` on the assistant and an external agent —
   * they carry NO allowlist (`allowedTools`), which is not `[]`: `[]` is a
   * crew that holds no tools.
   */
  readonly groups: G;
  /** Connections this actor may reach through the proxy (§2.6; F-3, T4-8). `[]` until those land. */
  readonly connections: readonly string[];
}

// ---- the actor ---------------------------------------------------------------------

interface ActorCommon {
  /** `agents.id` — a slug (`AGENT_ID_RE`), never the assistant's name. */
  readonly id: string;
  /** The assistant: `identity.yaml`'s `name`. A crew: its manifest `name`. An external agent: the `display_name` it was registered under. */
  readonly displayName: string;
}

export interface AssistantActor extends ActorCommon {
  readonly kind: "assistant";
  readonly definition: AssistantDefinition;
  readonly permissions: ActorPermissions<"assistant", PermissionRow>;
  readonly tools: ActorTools<null>;
  readonly compute: Extract<ActorCompute, { kind: "router" }>;
  /** None of its own: the engine's defaults and `compute.yaml`'s budgets apply. */
  readonly limits: null;
}

export interface CrewActor extends ActorCommon {
  readonly kind: "crew";
  readonly definition: CrewActorDefinition;
  readonly permissions: ActorPermissions<"crew", CrewPermissionRow>;
  readonly tools: ActorTools<readonly CrewToolGroup[]>;
  readonly compute: Exclude<ActorCompute, { kind: "router" }>;
  readonly limits: ActorLimits;
}

export interface ExternalActor extends ActorCommon {
  readonly kind: "external";
  /** Someone else's code: nothing here to read or write. */
  readonly definition: null;
  readonly permissions: ActorPermissions<"agent", ExternalPermissionRow>;
  readonly tools: ActorTools<null>;
  /** It runs elsewhere. */
  readonly compute: null;
  readonly limits: null;
}

/** Everything that acts (plan §2.4). Discriminated on `kind`, so the fields a kind cannot have are absent from its type rather than null by convention. */
export type Actor = AssistantActor | CrewActor | ExternalActor;

// ---- resolution: the sources, and the signature T4-6 implements -----------------

/** A registry row, as much of it as an actor needs. The console's `AgentRow` is assignable to it. */
export interface ActorRegistryRow {
  readonly id: string;
  /** As stored. Outside `AgentRowKind` it resolves as `external` (see `ACTOR_OF_AGENT_KIND`). */
  readonly kind: string;
  readonly display_name: string;
  readonly grants: { readonly tier: GrantTier; readonly areas: readonly string[]; readonly queries?: boolean | undefined };
  readonly projects: readonly string[];
  readonly autonomy: ActionAutonomy;
  /** 0025's column; null reads as `registry`. */
  readonly grant_source: "registry" | "environment" | "manifest" | null;
  readonly revoked: boolean;
  /** S2: remote and not yet approved. Still an actor — the owner deciding whether to let it in sees what it would hold. */
  readonly pending: boolean;
}

/** A crew manifest the host loaded (the console's `CrewRegistry`), with its path made relative. */
export interface ActorCrewSource {
  readonly manifest: AgentManifest;
  /** The body below the frontmatter, trimmed. */
  readonly prompt: string;
  readonly file: DefinitionFile;
}

/** What the registry row does not say about where a line came from. */
export interface ActorGrantHistory {
  /** Areas approved in Needs You: 0023's `agent_grant_overrides` for an internal row; the approved `access_request` proposals' `payload.granted` for an external one. A crew has none — `request_access` is refused to it. */
  readonly approved: readonly { readonly area: string; readonly proposalId: number | null }[];
  /** Per-run read grants routines give this actor (§2.5, T3-8). `[]` until T3-8. */
  readonly routines: readonly { readonly routine: string; readonly areas: readonly string[] }[];
}

/** Everything `ResolveActor` reads, loaded by the host. Lookups are synchronous: the host has already read what it passes. */
export interface ActorSources {
  /** The instance's own assistant, whatever its credential is doing. */
  readonly assistant: {
    /** Its registry id — the console's `INTERNAL_ASSISTANT_ID`. Never the configured name. */
    readonly id: string;
    readonly identity: AssistantIdentity;
    /** As `AssistantDefinition.files`. */
    readonly files: readonly DefinitionFile[];
  };
  /** One `agents` row by id — the row the door reads, which is why every kind's permissions come from here. */
  readonly registry: (id: string) => ActorRegistryRow | undefined;
  /** A loaded crew manifest by id. */
  readonly crew: (id: string) => ActorCrewSource | undefined;
  /** `compute.yaml`, parsed — for a legacy crew `model:`'s `assignments.crews` (one release). */
  readonly compute: Compute;
  /** Connections granted to this actor (F-3, T4-8). `() => []` until they exist. */
  readonly connections: (id: string) => readonly string[];
  readonly grantHistory: (id: string) => ActorGrantHistory;
}

/**
 * **The resolver's signature** — `resolveActor(id, sources)`, implemented in
 * T4-6 as `export const resolveActor: ResolveActor`. Pure: no I/O, no clock.
 * `null` means this id is not an actor now — no row, a revoked row, or a
 * crew row whose manifest is not loaded. The assistant's id always resolves:
 * chat runs it with or without a credential. docs/ops/actors.md is the rule
 * for every field.
 */
export type ResolveActor = (id: string, sources: ActorSources) => Actor | null;

// ---- the resolver (T4-6) -------------------------------------------------------------

/**
 * The instance's own assistant's registry id — `agents.id` for the row
 * `ensureInternalAgent` writes (the console's `INTERNAL_ASSISTANT_ID`). A
 * slug, never the configured name (CLAUDE.md naming).
 */
export const ASSISTANT_AGENT_ID = "assistant";

/** The scope of an assistant whose credential is off: nothing it does reaches a door (docs/ops/actors.md, rule 1). */
export const EMPTY_SCOPE: Scope = Object.freeze({ tier: "none", areas: Object.freeze([]) as readonly string[], queries: false, projects: Object.freeze([]) as readonly string[] });

/** A stored `agents.kind` → the actor it is. Outside the three, `external`: arriving unknown never makes a row more than it was. */
export function actorKindOf(rowKind: string): ActorKind {
  return Object.hasOwn(ACTOR_OF_AGENT_KIND, rowKind) ? ACTOR_OF_AGENT_KIND[rowKind as AgentRowKind].kind : "external";
}

/**
 * **A registry row's scope, as `may()` reads it** — `principalOfRow`'s
 * derivation (apps/console/src/agents.ts), written once here so the console's
 * door and an actor cannot derive it differently: the grant's tier and areas
 * (copied), `queries` only when it is literally `true`, the projects — where
 * an `internal` row's empty list is `null`, every project — and the row's
 * autonomy record.
 */
export function scopeOfRegistryRow(row: Pick<ActorRegistryRow, "kind" | "grants" | "projects" | "autonomy">): Scope {
  return {
    tier: row.grants.tier,
    areas: [...row.grants.areas],
    queries: row.grants.queries === true,
    projects: row.kind === "internal" && row.projects.length === 0 ? null : [...row.projects],
    autonomy: row.autonomy,
  };
}

/** The action half of an autonomy record: its level and per-kind table, and nothing of §4.21's narrowing keys. */
function actionAutonomyOf(a: ActionAutonomy | null | undefined): ActionAutonomy {
  return { ...(a?.level !== undefined ? { level: a.level } : {}), ...(a?.actions !== undefined ? { actions: { ...a.actions } } : {}) };
}

/** A manifest's `uses`, aliases resolved, deduplicated, in `CREW_TOOL_GROUPS` order. `[]` is a crew holding no tools — never `null`. */
export function crewToolGroups(uses: readonly string[]): CrewToolGroup[] {
  const held = new Set(uses.map(crewGroupOf).filter((g): g is CrewToolGroup => g !== undefined));
  return (Object.keys(CREW_TOOL_GROUPS) as CrewToolGroup[]).filter((g) => held.has(g));
}

/**
 * **What a crew runs on, said** (docs/ops/actors.md, *Crew compute*): its own
 * `<provider>/<model>` with its own effort; `same_as_assistant`; or — for one
 * release — a legacy alias, through `assignments.crews.<id>` when that is set
 * and as `same_as_assistant` when it is not, which is where an unassigned
 * crew always ran. `resolveCrewAssignment` (compute.ts) is the same rule for
 * the runner; a test holds the two together.
 *
 * Throws on a `model:` the schema would have refused: a loaded manifest has
 * passed it, so reaching here with one is a bug, not a crew to guess about.
 */
export function crewCompute(id: string, manifest: Pick<AgentManifest, "model" | "effort">, compute: Compute): CrewActor["compute"] {
  const model = manifest.model;
  if (model === SAME_AS_ASSISTANT) return { kind: "same_as_assistant" };
  if (isLegacyCrewModel(model)) {
    const crews = compute.assignments?.crews ?? {};
    const a = Object.hasOwn(crews, id) ? crews[id] : undefined;
    if (a && modelRefIssue(a.model) === undefined) return { kind: "model", ref: a.model as ModelRefString, effort: a.effort };
    return { kind: "same_as_assistant" };
  }
  if (modelRefIssue(model) === undefined) return { kind: "model", ref: model as ModelRefString, effort: manifest.effort };
  throw new Error(`crew ${id}: model ${crewModelIssue(model) ?? "is not readable"}`);
}

/**
 * Why a line was refused to an actor — thrown, never filtered (U3). A crew's
 * or an external agent's rows are narrowed through the two checks below; a
 * row the model says such an actor can never hold means `may()` and the
 * types have come apart, and saying nothing about it would draw a power the
 * owner never granted.
 */
export class ActorPermissionRefused extends Error {
  constructor(
    readonly actor: string,
    readonly row: PermissionRow,
    why: string,
  ) {
    super(`${actor}: ${why} — refusing to draw it (docs/ops/actors.md, *Made impossible by the types*)`);
    this.name = "ActorPermissionRefused";
  }
}

/** An external agent's rows: never a Knowledge write, never the Agents row. */
export function externalPermissionRows(actor: string, rows: readonly PermissionRow[]): ExternalPermissionRow[] {
  return rows.map((r) => {
    if (r.resource.kind === "knowledge" && r.write.length > 0) throw new ActorPermissionRefused(actor, r, "Knowledge Write belongs to the instance assistant alone (one writer, §4.11)");
    if (r.resource.kind === "agents") throw new ActorPermissionRefused(actor, r, "delegating is the instance assistant's alone (agents_delegate)");
    return r as ExternalPermissionRow;
  });
}

/** A crew's rows: an external agent's, less Queries (`CREW_NEVER_TOOLS`). */
export function crewPermissionRows(actor: string, rows: readonly PermissionRow[]): CrewPermissionRow[] {
  const external = externalPermissionRows(actor, rows);
  return external.map((r) => {
    if (r.resource.kind === "queries") throw new ActorPermissionRefused(actor, r, "no crew runs a named query (CREW_NEVER_TOOLS)");
    return r as CrewPermissionRow;
  });
}

/** The directory a relative definition path sits in — a crew's area when its manifest omits `area:` (the loader fills it from there anyway). */
function areaFromPath(path: string): string {
  const parts = path.split("/");
  return parts.length >= 2 ? parts[parts.length - 2]! : "";
}

/**
 * **One resolver for everything that acts** (plan §2.4). Pure: every source
 * is loaded by the host and handed in. docs/ops/actors.md is the rule for
 * every field; in order:
 *
 * 1. The assistant's id ALWAYS resolves to the assistant — chat runs it with
 *    or without a credential. A live `internal` row supplies its scope; with
 *    none (its token unset, so the row is revoked) the scope is the empty one
 *    and it holds no lines.
 * 2. No row, or a revoked one → `null`: a revoked credential acts as nothing.
 * 3. A pending row (S2) resolves, so the owner deciding sees what it would hold.
 * 4. By the row's kind: `internal` is the assistant; `crew` needs its
 *    manifest loaded (else `null` — the next sync revokes the row); anything
 *    else is external.
 *
 * Permissions come from the ROW for every kind, because the row is what the
 * door reads. The assistant's source is always `environment`: its reach is
 * configuration, never a grant (C52), whatever an old row's column says.
 */
export const resolveActor: ResolveActor = (id, sources) => {
  const row = sources.registry(id);
  const live = row !== undefined && !row.revoked ? row : undefined;
  const history = sources.grantHistory(id);
  const connections = [...sources.connections(id)];

  const assistant = (r: ActorRegistryRow | undefined): AssistantActor => {
    const scope = r ? scopeOfRegistryRow(r) : EMPTY_SCOPE;
    const principal: Principal = { id, role: "assistant", scope, source: "environment" };
    return {
      id,
      kind: "assistant",
      displayName: sources.assistant.identity.name,
      definition: { kind: "assistant", identity: sources.assistant.identity, files: [...sources.assistant.files] },
      permissions: {
        role: "assistant",
        scope,
        autonomy: actionAutonomyOf(r?.autonomy),
        source: "environment",
        lines: r ? describePermissions(principal, { connections, history }) : [],
      },
      tools: { groups: null, connections },
      compute: { kind: "router" },
      limits: null,
    };
  };

  if (id === sources.assistant.id) return assistant(live !== undefined && actorKindOf(live.kind) === "assistant" ? live : undefined);
  if (!live) return null;

  switch (actorKindOf(live.kind)) {
    case "assistant":
      return assistant(live);
    case "crew": {
      const crew = sources.crew(id);
      if (!crew) return null;
      const scope = scopeOfRegistryRow(live);
      const source: GrantSource = { manifest: crew.file.path };
      const groups = crewToolGroups(crew.manifest.uses);
      const principal: Principal = { id, role: "crew", scope, source, uses: [...crew.manifest.uses] };
      return {
        id,
        kind: "crew",
        displayName: crew.manifest.name,
        definition: {
          kind: "crew",
          area: crew.manifest.area ?? areaFromPath(crew.file.path),
          description: crew.manifest.description ?? null,
          prompt: crew.prompt,
          files: [crew.file],
        },
        permissions: {
          role: "crew",
          scope,
          autonomy: actionAutonomyOf(live.autonomy),
          source,
          lines: crewPermissionRows(id, describePermissions(principal, { connections, history })),
        },
        tools: { groups, connections },
        compute: crewCompute(id, crew.manifest, sources.compute),
        limits: { maxTurns: crew.manifest.max_turns, budgetUsdPerRun: crew.manifest.budget_usd_per_run },
      };
    }
    case "external": {
      const scope = scopeOfRegistryRow(live);
      // The registry: the owner's own hand (docs/ops/actors.md's field table).
      const source: GrantSource = "registry";
      const principal: Principal = { id, role: "agent", scope, source };
      return {
        id,
        kind: "external",
        displayName: live.display_name,
        definition: null,
        permissions: {
          role: "agent",
          scope,
          autonomy: actionAutonomyOf(live.autonomy),
          source,
          lines: externalPermissionRows(id, describePermissions(principal, { connections, history })),
        },
        tools: { groups: null, connections },
        compute: null,
        limits: null,
      };
    }
  }
};
