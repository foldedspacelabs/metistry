// **One place for the access rules.** Who may see which knowledge path, and
// what a refusal says — moved here from `packages/mcp-brain/src/knowledge.ts`
// and `apps/console/src/knowledge-routes.ts` (P0 of
// docs/research/2026-09-19-grants-and-access-simplified.md §4), unchanged.
//
// `core` is the right home for three reasons the research document states
// (§2.9, §3.4): the console's authorization rules were being served out of one
// BRIDGE's package, so a second bridge would have had to import a sibling
// bridge to get them; `core` already holds `actions.ts`, `manifest.ts` and
// `instance-layout.ts`, which these call; and it imports no pg, no config and
// no vault, so a rule here cannot quietly start reading state. The dependency
// arrow is unchanged — apps → packages, never the reverse.
//
// Nothing in this file writes. It decides, and every widening still goes
// through the console's `writeGrants`, one validator, one audit row
// (invariant 2).

import { INSTANCE_LAYOUT, isUserOwnedPath, isVaultPath, validAgentAreaGrant, VAULT_ROOT_AREA } from "./instance-layout.js";

/**
 * Read tiers (§4.11): default-deny, user-granted, attached to the token
 * server-side. Named `GrantTier` rather than `Tier` because `core` already
 * exports a COMPUTE tier (tiers.ts) and one word for two things is how the
 * grant model got hard to read in the first place (§2.8).
 */
export type GrantTier = "none" | "index" | "areas";

/** How a `none`/`index`/`areas` tier is SAID — one set of words, everywhere (§2.10: the console had three, the CLI had none). */
export const TIER_LABEL: Readonly<Record<GrantTier, string>> = Object.freeze({ none: "none", index: "titles", areas: "folders" });

// ===========================================================================
// classify() — what a path IS, which is not what anybody may do with it
// ===========================================================================

/**
 * The four things an instance-relative path can be.
 *
 * - `knowledge` — vault CONTENT: what the reconciler walks, indexes and
 *   embeds, and the only thing a knowledge door serves.
 * - `artifact` — under `Artifacts/`. The owner's own bytes; nothing indexes
 *   them, and the artifacts service is the door that has them.
 * - `machinery` — `.metistry/`, a dot-directory, the root `CLAUDE.md` /
 *   `README.md`, the legacy machinery roots: how the instance is configured,
 *   served by no door as a page.
 * - `outside` — not a path in this vault at all: traversal, an empty
 *   segment, a leading slash.
 */
export type ResourceClass = "knowledge" | "artifact" | "machinery" | "outside";

export const RESOURCE_CLASSES: readonly ResourceClass[] = ["knowledge", "artifact", "machinery", "outside"];

/**
 * **Classification is not permission** (§3.3 — P4's single conceptual
 * change, and the one thing that lets "the owner has everything" be stated
 * with no exception clause).
 *
 * `isVaultPath` was doing two jobs: saying what counts as knowledge (for the
 * indexer, correctly) and narrowing the OWNER at the knowledge door (§2.6,
 * accidentally). This splits them. `classify(p) === "knowledge"` is
 * `isVaultPath(p)` **by construction** — the first line asks it, so the
 * indexer's behaviour cannot drift from this — and everything else gets a
 * name saying which door DOES serve it, rather than a refusal implying
 * nobody may.
 *
 * It judges the path's SHAPE and nothing else: no principal, no filesystem,
 * no index. A `knowledge` answer does not mean the page exists, and an
 * `artifact` answer is not permission to read one.
 *
 * Traversal wins over the `Artifacts/` prefix: `Artifacts/../.metistry/x` is
 * `outside`, never an artifact, because a path that escapes is a malformed
 * path before it is anything else.
 */
export function classify(rel: string): ResourceClass {
  if (typeof rel !== "string" || rel === "") return "outside";
  if (isVaultPath(rel)) return "knowledge";
  const segments = rel.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) return "outside";
  return segments[0] === INSTANCE_LAYOUT.artifactsDir ? "artifact" : "machinery";
}

/**
 * A vault path an agent may name. Since the 2026-09-17 layout the vault root
 * IS the instance directory, so there is no prefix to anchor on — the rule is
 * `isVaultPath`: no traversal, no leading slash, nothing inside a
 * dot-directory (`.metistry/` is the machinery, and an agent may not read it
 * here any more than it may write it), and not `Artifacts/`, which is not
 * knowledge. Mirrors the grant shape the console validates.
 */
export function validKnowledgePath(path: string): boolean {
  return typeof path === "string" && path.length <= 500 && !/[\0\\]/.test(path) && isVaultPath(path);
}

/**
 * Prefix semantics of a grant: the area itself or anything below it. A
 * trailing slash names a directory as a whole, and the bare vault — every
 * path, root notes included — is spelled `/`, which rtrims to the empty
 * prefix. The console admits that spelling for internal principals only.
 */
export function underAreas(path: string, areas: readonly string[]): boolean {
  return areas.some((raw) => {
    const a = raw.endsWith("/") ? raw.slice(0, -1) : raw;
    return a === "" || path === a || path.startsWith(`${a}/`);
  });
}

/**
 * **One scope rule for every knowledge read, on both doors.** May a caller
 * whose grant covers `areas` see this path at all? Two conditions, both
 * necessary: it is vault CONTENT (`validKnowledgePath` — so `.metistry/`,
 * `Artifacts/`, a dot-directory, a traversal and the root `CLAUDE.md` are out
 * for every caller, the owner included), and it falls under the areas.
 *
 * `null` is "no prefix restriction" — every vault path. That is the OWNER on
 * the console's routes, and it is tier `index` when the question is a TITLE
 * rather than content (ruled 2026-09-19: an agent discovers what knowledge
 * exists so it can ask for the area that holds it). It is never tier `none`,
 * which is refused before this is reached: the caller decides the TIER, this
 * decides the PATH, and keeping those two apart is what lets one function
 * serve a console route and an MCP tool.
 *
 * That the owner is narrowed here at all is §2.6's finding and P4's job —
 * `classify()` will make the refusal a statement about the RESOURCE ("that is
 * not knowledge") rather than about the owner's permission. P0 moves the rule
 * and changes nothing.
 */
export function canSeeUnder(path: string, areas: readonly string[] | null): boolean {
  if (!validKnowledgePath(path)) return false;
  return areas === null || underAreas(path, areas);
}

/**
 * The areas a principal may see. `null` is "every vault path" — the owner,
 * whose own vault this is.
 *
 * It is a SCOPE rather than a boolean because `canSee` below is the one place
 * any surface decides whether a path may be shown, and the narrowed form is
 * what a grant looks like: `grantedScope` derives it from an agent's grants.
 */
export interface KnowledgeScope {
  readonly areas: readonly string[] | null;
}

/** The whole owner's vault. */
export const OWNER_SCOPE: KnowledgeScope = { areas: null };

/** Nothing at all: `canSee` is false for every path against an empty area list. The fail-closed answer for a credential that is neither the owner nor a holder of grants. */
export const NO_SCOPE: KnowledgeScope = { areas: [] };

/**
 * The scope a principal's GRANTS come to — one derivation, so a console route
 * and an MCP tool cannot come to different answers about the same credential.
 *
 * It reproduces the bridge's `knowledgeScope(principal).canRead`, which is
 * `tier === "areas" && canSeeUnder(path, areas)`. What it deliberately does
 * NOT do is take that function's return value and rename a field: that shape
 * carries a tier, and its `prefixes` is `null` for tiers `none` and `index`
 * meaning "no prefix restriction on the TITLES those tiers may browse". `null`
 * here means every vault path's CONTENT, so the rename would hand the two
 * tiers that may not read a page the owner's own scope. A tier below `areas`
 * comes to the empty list instead — `NO_SCOPE`. (§2.8: one field, two
 * meanings, kept apart by prose. They are still two shapes; they are now at
 * least in one file.)
 *
 * The bare vault grant (`/`, internal principals only) needs no case of its
 * own: `underAreas` rtrims it to the empty prefix, which matches every path.
 * The areas are COPIED, so a scope already handed to a request cannot widen
 * because the registry row behind it was rewritten while the request ran.
 */
export function grantedScope(principal: { grants: { tier: string; areas: readonly string[] } }): KnowledgeScope {
  const { tier, areas } = principal.grants;
  return { areas: tier === "areas" ? [...areas] : [] };
}

/**
 * May this principal see this path's content? Two conditions, both
 * necessary: it is vault CONTENT at all (so `.metistry/`, `Artifacts/`, a
 * dot-directory, a traversal and the root `CLAUDE.md` are out for every
 * principal, the owner included), and it falls under the scope's areas.
 *
 * A rename over `canSeeUnder` rather than a second copy (ruled 2026-09-19:
 * the same rule on both doors).
 */
export function canSee(path: string, scope: KnowledgeScope): boolean {
  return canSeeUnder(path, scope.areas);
}

/**
 * Hits the scope does not cover are DROPPED, never returned with a flag: a
 * path is the sensitive part of a hit, and a filtered list must not be a
 * directory listing of what was filtered.
 *
 * Generic over the hit shape so the console's search hit and any other
 * `{ path }` row are filtered by the identical predicate.
 */
export function filterHits<T extends { path: string }>(hits: readonly T[], scope: KnowledgeScope): T[] {
  return hits.filter((h) => canSee(h.path, scope));
}

/**
 * The same drop for a named query's ROWS — the page list, and the link list,
 * whose `path` is the other end of each edge. One predicate over one column,
 * so the two lists cannot be filtered unevenly.
 *
 * Rows travel unprojected — an instance may overlay `knowledge_pages.yaml` or
 * `knowledge_page_links.yaml` with columns of its own (D4), and a projection
 * here would silently swallow them — so the one thing this insists on is a
 * `path` it can judge. A row without one is dropped rather than passed: a list
 * entry whose scope cannot be decided is not a list entry.
 */
export function filterPages(rows: readonly Record<string, unknown>[], scope: KnowledgeScope): Record<string, unknown>[] {
  return rows.filter((r) => typeof r.path === "string" && canSee(r.path, scope));
}

/**
 * Owner ruling 2026-09-19 (judgement call B on PR #216): a caller who may
 * see a page's TITLE but not its CONTENT is told WHICH grant would unlock it,
 * rather than the uniform "not granted" — it already knows the page is there,
 * so naming the area is not a new leak. `SCOPE_REQUIRED` is that refusal's
 * stable machine-readable half, carried in the wire envelope's additive slot
 * (never `error.code`, which stays the ordinary `forbidden` every other
 * refusal on this surface uses — invariant 8's envelope is unchanged).
 */
export const SCOPE_REQUIRED = "scope_required";

/**
 * The smallest folder grant that would cover `path` — its immediate parent
 * directory, the same granularity a directory-prefix grant already is
 * (`underAreas`). A root-level note (no parent — `now.md`) needs the bare
 * vault grant, spelled the way an internal principal's own grant already is
 * (`VAULT_ROOT_AREA`); an external agent is not offered that one, but it is
 * still the true answer to "what prefix contains this path".
 */
export function areaOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? VAULT_ROOT_AREA : path.slice(0, i);
}

/**
 * The scope_required refusal, built once so `knowledge_read` and
 * `knowledge_list`'s `links_for` say the identical thing for the identical
 * reason. `message` replaces the bare "not granted" string; `expose` is what
 * the console's `render` merges onto the wire envelope alongside `error`
 * (mcp-brain's `Outcome.expose`, never `meta`, which is audit-only). It names
 * the mechanism — `request_access` since 2026-09-19 — and where the ask lands,
 * so the agent knows the owner, not it, decides. A refusal without that
 * sentence is a dead end: a model told only "no" has no next move but to try
 * the same path again.
 *
 * **P3 wording**: the sentence is now the one `REFUSAL.scope_required` gives
 * on every door (`ONE VOCABULARY` below). What it lost is the opening clause
 * "you can see that this page exists, but" — true only of the case ruling B
 * was about, and a claim the same sentence could not make honestly anywhere
 * else. What decides whether this sentence is given AT ALL is unchanged and
 * is still the ruling: `may` speaks it only for a path the caller may
 * already list (`mayKnowledge`), and hides behind the uniform refusal
 * otherwise, so no area is ever named for a page the caller could not
 * already see.
 */
export function scopeRequired(path: string): { message: string; expose: { reason: string; grantedScope: string } } {
  const area = areaOf(path);
  return { message: REFUSAL.scope_required(path, area), expose: { reason: SCOPE_REQUIRED, grantedScope: area } };
}

// ===========================================================================
// may() — ONE decision function
// ===========================================================================
//
// P1 of docs/research/2026-09-19-grants-and-access-simplified.md §4. Every
// door in §1.4 asks this and nothing else; each check it used to make itself
// is now a case below that returns **the same code and the same message it
// returned before** (§4's rule: "none by construction", held by
// `packages/core/test/access.golden.json`).
//
// So this file reads as a catalogue of dialects rather than a clean policy,
// and that is the point of P1: the five vocabularies §2.5 found are now five
// cases in one table instead of fourteen strings in eleven files. Unifying
// them is P3, and it will be one reviewable diff here.
//
// **Three rules hold for everything below.**
//
// 1. `may` DECIDES; it never writes, never reads state, never awaits. Every
//    widening still goes through the console's `writeGrants` — one validator,
//    one audit row (invariant 2). Facts about the world that a decision needs
//    (does this page exist?) arrive on the `Resource`, fetched by the door.
// 2. **`needs` is produced here, never by a tool body.** A tool that
//    hand-writes a remedy sentence is the thing this replaces. It is added
//    only where a remedy already existed in prose, so P1 invents no new
//    advice.
// 3. **Fail closed.** Every `(role, verb, resource)` is decided; an
//    unhandled one is a refusal, and the enumeration test in
//    `packages/mcp-brain/test/may-surface.test.ts` makes an unhandled pair a
//    test failure rather than a default.
//
// The table is CODE, reviewed in a PR. If it ever becomes loadable from a
// file, a new permission arrives by config line, which is exactly what
// invariant 10 forbids (§5).

import {
  ACTION_KINDS,
  admitsAnyAction,
  effectiveActions,
  effectiveActionsDetailed,
  DEFAULT_AUTONOMY_LEVEL,
  AUTONOMY_LEVELS,
  type ActionAutonomy,
  type ActionKind,
  type ActionMode,
  type AutonomyLevel,
  type EffectiveActionEntry,
} from "./actions.js";
import { crewToolsFor } from "./manifest.js";
import type { ActorGrantHistory, PermissionEntry, PermissionProvenance, PermissionResourceKind, PermissionRow } from "./actor.js";
import type { ToolGroup, ToolMode } from "./connections.js";
import { errorEnvelope, type ErrorCode } from "./errors.js";

/**
 * Who is asking. Derived from the CREDENTIAL by a mapping function per host
 * (mcp-brain's `principalOf`, the console's `principalOf`) — never from a
 * request body or a tool argument (§4.19).
 *
 * All five have a producer since P2: `authenticateAgent` reads the registry
 * row's `kind` without collapsing it, so a crew is its own role rather than
 * an external agent that happens to have been dispatched (§2.3), and the
 * `uses` allowlist its manifest declares rides on the principal into
 * `mayToolset` below.
 */
export type Role = "owner" | "assistant" | "agent" | "crew" | "tool";

/** Every role, for the enumeration test. */
export const ROLES = ["owner", "assistant", "agent", "crew", "tool"] as const;

export type Verb = "list" | "read" | "write" | "propose" | "act";

/** Where a principal's scope came from, so no door re-derives it from the role in prose (§2.7). Unused by the rules below; carried so P3's one renderer has it. */
export type GrantSource = "registry" | "environment" | { readonly manifest: string };

/**
 * What this credential holds. One shape, so the two representations §2.8
 * found are at least in one type: `areas: null` is **every knowledge path**
 * and belongs to the owner alone; a tier below `areas` is not a narrower
 * read scope, it is none (`readableAreas` below).
 */
export interface Scope {
  readonly tier: GrantTier;
  readonly areas: readonly string[] | null;
  readonly queries: boolean;
  /** `null` = every project (the internal rule: hub assistant, empty list). */
  readonly projects: readonly string[] | null;
  readonly autonomy?: ActionAutonomy | undefined;
  /**
   * **The connections this credential is granted**, by name (§2.6, T4-8b):
   * what an agent or a crew may reach through the proxy (`connections_list`,
   * `connections_call`), beside its other grants and resolved by the host at
   * authentication — never from a request. Absent is the empty list: a grant
   * is something the owner wrote down. The assistant needs none (C115: a
   * connection that is not offered to agents is the assistant's and the
   * syncs'), and the owner has everything.
   */
  readonly connections?: readonly string[] | undefined;
}

export interface Principal {
  readonly id: string;
  readonly role: Role;
  readonly scope: Scope;
  readonly source: GrantSource;
  /**
   * **A crew's own toolset**: the `uses` GROUPS its manifest declares
   * (`CREW_TOOL_GROUPS`), resolved from the loaded manifest by the host at
   * authentication and never from the request. Expanded to tool names by
   * `allowedTools` below, which is what `mayToolset` decides on.
   *
   * Absent on every other role — they carry no allowlist, and `allowedTools`
   * answers `null` for them, which is "no allowlist" and not "an empty one".
   * Absent on a CREW is the empty list: a crew whose manifest this console
   * cannot see holds NO tools (fail closed), never all of them.
   */
  readonly uses?: readonly string[] | undefined;
}

/**
 * The closed enum §3.2 names, plus the two that enumerating the doors turned
 * up and the sketch did not:
 *
 * - `not_exposed` — the route-only named query. §3.1's "there is nothing to
 *   tell you" case: it renders as the door's uniform `not_found` with no
 *   message, because a distinguishable refusal is an oracle for which
 *   route-backed queries exist.
 * - `not_knowledge` — the path is not vault CONTENT at all. A statement about
 *   the RESOURCE, not about the caller's permission, which is why the owner
 *   gets it too (§2.6). P4's `classify()` is where this stops being a
 *   refusal and becomes a routing fact (§3.3).
 * - `not_in_uses` (P2) — the tool is outside this run's own allowlist. Its
 *   own reason rather than `role_required` because the two have different
 *   remedies and `reason` is the machine-readable half of what would unlock
 *   a refusal (§3.2): `role_required` is "your kind of principal may never
 *   do this", while this one is "the manifest that defines this crew did not
 *   name the group", which the user changes by editing that file.
 * - `connection_required` (T4-8b) — a connection this credential was not
 *   granted, or one the owner has not offered to agents (§2.6). It HIDES:
 *   the answer is the door's own "no such connection", because a refusal
 *   that could be told from absence would say which connections the owner
 *   holds to a caller that was never lent them.
 */
export type Reason =
  | "scope_required"
  | "tier_required"
  | "queries_required"
  | "role_required"
  | "autonomy_required"
  | "membership_required"
  | "not_member"
  | "not_exposed"
  | "not_knowledge"
  | "not_in_uses"
  | "connection_required";

export const REASONS: readonly Reason[] = [
  "scope_required",
  "tier_required",
  "queries_required",
  "role_required",
  "autonomy_required",
  "membership_required",
  "not_member",
  "not_exposed",
  "not_knowledge",
  "not_in_uses",
  "connection_required",
];

/**
 * The machine-readable form of what would unlock a refusal — exactly what
 * `request_access` takes as input and what the console's Approve applies. It
 * GRANTS nothing, the same way `request_access` grants nothing.
 *
 * Only the two remedies that already existed in prose are here: P1 adds no
 * advice that was not being given.
 */
export interface Needs {
  /** `scope_required`: the smallest folder grant that would cover the path. */
  readonly grant?: { readonly tier: GrantTier; readonly area: string };
  /** `autonomy_required`: the entry the user would raise, and to what. */
  readonly autonomy?: { readonly action: ActionKind; readonly mode: ActionMode };
  /**
   * `not_knowledge` (P4): the door that DOES serve this resource, because
   * the refusal is a statement about the resource rather than about the
   * caller. `GET /api/artifacts` for an artifact; `the file itself` for the
   * machinery, which no door serves as a page and which is read where it
   * lives — on disk, and in git.
   *
   * Also `knowledge_write`'s `Me/` / user-journal refusal (`isUserOwnedPath`):
   * `requests_create` is the door that DOES take this — propose the change,
   * the owner applies it — because no grant ever makes `knowledge_write` the
   * right one for a page that is always the owner's.
   */
  readonly door?: string;
}

/**
 * **Whether a refusal may speak at all** (§3.1's second property).
 *
 * - `refuse` — a statement about the CALLER's grant. It says the one
 *   sentence this `reason` says (`REFUSAL` below), and `reason`/`needs`
 *   reach the wire.
 * - `hide` — the answer is deliberately identical to "there is nothing
 *   here". The message is the DOOR's own absence answer, `needs` is absent,
 *   and `formatRefusal` drops `reason` on the way out: a refusal that is
 *   distinguishable from absence is an oracle, and the type is what stops a
 *   future contributor making one of these chatty by accident.
 *
 * Four things hide, and each was already hiding before this type existed:
 * the project-scope miss (a row outside your projects does not exist for
 * you), the route-only named query (which would otherwise publish the
 * route-only set), the console's own uniform 403 (CRIT-7: an agent bearer
 * gets one answer on every management route, never a 403 here and a 404
 * there), and a knowledge path the caller may not even LIST — the 2026-09-19
 * ruling's boundary: an area is named only for a page whose existence the
 * caller can already see.
 */
export type Tell = "refuse" | "hide";

/**
 * `code` is on the refusal because P1's whole rule is that a door answers
 * with the same envelope it answered with before, and the code is half of
 * it: a project-scope miss is `not_found` (`tell: "hide"`) while a tier miss
 * is `forbidden`. `message` is `""` where the door says nothing — the
 * canonical message for the code is what a caller reads (`errorEnvelope`),
 * so `""` and a hand-written "not granted" were always the same bytes, and
 * since P3 there is one spelling of the silence. `expose` is the additive
 * wire slot the console's `render` already merges (mcp-brain's
 * `Outcome.expose`); `scope_required` is still its only user.
 */
export interface Refusal {
  readonly ok: false;
  readonly code: ErrorCode;
  readonly reason: Reason;
  readonly tell: Tell;
  readonly needs?: Needs;
  readonly message: string;
  readonly expose?: Record<string, unknown>;
}

export type Decision = { readonly ok: true } | Refusal;

/** Which surface asked. It selects TODAY'S wording for a refusal and NOTHING else — never what is decided. P3 collapses these to one vocabulary. */
export type KnowledgeDoor = "read" | "list" | "grep" | "links" | "write" | "resources" | "console_page";
export type QueryDoor = "queries_run" | "console_query";
export type ProjectDoor = "task" | "task_create";
export type ConsoleDoor = "console_agent" | "console_management";
/** The proxy's two doors (§2.6's lazy pair on `/mcp`). */
export type ConnectionDoor = "connections_list" | "connections_call";

export type Resource =
  /**
   * May this principal use this tool AT ALL, before any argument is read —
   * the argument-free half of every gate. `propose_action`'s conditional
   * registration already works this way (SEP-1881's scope-filtered
   * discovery); this makes the same question askable of every tool, which
   * is what the enumeration test in `packages/mcp-brain` walks.
   */
  | { readonly kind: "tool"; readonly name: string }
  /**
   * **This run's own allowlist**, asked at the door on EVERY tool call
   * before the body runs (mcp-brain's `wrap`). A crew holds exactly the
   * groups its manifest's `uses` names and nothing else; every other role
   * carries no allowlist and is admitted here, so the gate decides nothing
   * for them — what a tool costs THEM is the `{kind:"tool"}` rule above,
   * which each body already asks.
   *
   * Separate from `{kind:"tool"}` so that moving this enforcement to the
   * door changed exactly one thing (§4's P2 row): the crew's own refusal.
   * `mayUseTool` consults the same allowlist first, so the two can never
   * answer differently about the same (principal, tool).
   */
  | { readonly kind: "toolset"; readonly name: string }
  /** `settled`: does a non-draft row for this path exist in the index? The one fact `may` cannot know; the door looks it up, and only when the caller may already see the TITLE. */
  | { readonly kind: "knowledge"; readonly door: KnowledgeDoor; readonly path: string; readonly settled?: boolean }
  | { readonly kind: "query"; readonly door: QueryDoor; readonly name: string; readonly exposure: "generic" | "route" }
  | { readonly kind: "project"; readonly door: ProjectDoor; readonly slug: string | null }
  | { readonly kind: "action"; readonly door: "propose_action"; readonly action: ActionKind }
  | { readonly kind: "console"; readonly door: ConsoleDoor; readonly route: string }
  /**
   * **One connection, through the proxy** (§2.6, C115; T4-8b). `offered` is
   * the connection file's `offer_to_agents` — the owner's one switch — and,
   * like `settled`, the one fact `may` cannot know: the door reads it from
   * the file and passes it in. An agent or a crew reaches a connection only
   * when it is offered AND named in the credential's `scope.connections`; a
   * crew must also hold the `connections` group. What a single TOOL of the
   * connection may do (Allow · Ask First · Never, and its group) is the
   * connection file's per-tool policy, held by the proxy itself.
   */
  | { readonly kind: "connection"; readonly door: ConnectionDoor; readonly name: string; readonly offered: boolean };

const OK: Decision = { ok: true };

/** A refusal that SPEAKS: one sentence per reason, `reason` and `needs` on the wire. */
function no(code: ErrorCode, reason: Reason, message: string, needs?: Needs, expose?: Record<string, unknown>): Refusal {
  return { ok: false, code, reason, tell: "refuse", message, ...(needs ? { needs } : {}), ...(expose ? { expose } : {}) };
}

/**
 * A refusal that HIDES: the door's own answer for "there is nothing here",
 * with no `needs` and — after `formatRefusal` — no `reason` either. The
 * `reason` is still recorded, because the audit row and the golden file both
 * want to know WHY a door went quiet; it simply does not cross the wire.
 *
 * `message` defaults to `""`, which `errorEnvelope` renders as the code's
 * canonical message ("not granted" for `forbidden`, "not found" for
 * `not_found`) — the uniform answer every one of these doors already gave.
 * The two that pass a message pass the sentence their door gives for a thing
 * that is not there, byte for byte, so the refusal cannot be told from it.
 */
function hidden(code: ErrorCode, reason: Reason, message = ""): Refusal {
  return { ok: false, code, reason, tell: "hide", message };
}

/**
 * **The console knowledge door's one answer for "there is no page here"** —
 * whatever the real reason. Out of scope, a draft, machinery, an artifact,
 * a path that was never written: one sentence, so the route is not an oracle
 * for what exists where the caller cannot look. Unchanged since P1, byte for
 * byte, because every non-owner refusal on that door is still this.
 */
export const NO_SUCH_PAGE =
  "no such page — a path must be vault CONTENT: not .metistry/, not Artifacts/, not the root CLAUDE.md, no leading slash and no traversal (docs/ops/instance-layout.md)";

/**
 * **ONE VOCABULARY.** One sentence per `reason`, built here and nowhere
 * else — §2.5's finding was five dialects across fourteen sites (an empty
 * message, a bare "not granted", a sentence naming an env var, a sentence
 * naming an HTTP route AND a CLI command, and one machine-readable pair),
 * and §3.4's answer is one renderer.
 *
 * The SHAPE is one per reason; the FACTS in it are substituted. That is the
 * distinction that matters: a caller (or a model) learns one sentence per
 * kind of refusal and reads the nouns out of it, instead of learning
 * fourteen. Every one of them names what would unlock it and who decides,
 * because a refusal with no next move is how a model ends up retrying the
 * same call.
 *
 * `not_member`, `not_exposed` and the console's own 403 are not here: they
 * are `tell: "hide"` and have no sentence of their own by design.
 */
export const REFUSAL = {
  /** The read tier is below what this needs. No path is involved, so there is nothing to hide. */
  tier_required: (held: GrantTier, needed: GrantTier): string =>
    `not granted — this needs the \`${needed}\` tier (${TIER_LABEL[needed]}) and you hold \`${held}\` (${TIER_LABEL[held]}); ask with \`request_access\`: an area and why, and the owner answers in Needs You.`,

  /** A path the caller may already LIST, outside the folders they may read. Spoken only there (see `scopeRequired`). */
  scope_required: (path: string, area: string): string =>
    `not granted — \`${path}\` is outside your folders; reading it needs the \`${area}\` grant. Ask for it with \`request_access\` (area \`${area}\`, and why); the owner answers in Needs You.`,

  /** The `queries` axis is a switch on the grant, not a tier, so the remedy is the owner's own hand rather than an ask. */
  queries_required: (id: string): string =>
    `not granted — named queries need the \`queries\` grant and ${id} does not hold it; the owner turns it on in the console's Agents panel (PUT /api/agents/${id}/grants).`,

  /** A capability that belongs to one kind of principal. No grant widens a role, which is the whole sentence. */
  role_required: (what: string, who: string): string =>
    `not granted — \`${what}\` belongs to ${who} alone; no grant widens a role. Report what you needed with \`requests_create\` instead of retrying.`,

  /** Unchanged from P1: it already named the route, the CLI command and who may run them. */
  autonomy_required: (id: string, action: ActionKind | null): string =>
    `autonomy.actions${action ? `.${action}` : ""} is deny for ${id} — the user raises it (PUT /api/agents/${id}/autonomy, or \`metistry agents autonomy ${id}${action ? ` --allow ${action}` : ""}\`); nothing else can (docs/ops/actions.md)`,

  /** Project membership on a row you named yourself — not an existence question, so it speaks. */
  membership_required: (id: string, slug: string): string =>
    `not granted — ${id} is not a member of project \`${slug}\`; the owner adds it (PUT /api/agents/${id}/projects, or the console's Agents panel).`,

  /** Unchanged from P2: it names the toolset the crew DOES hold and the file that declares it. */
  not_in_uses: (id: string, name: string, uses: readonly string[]): string =>
    `${name} is not in this crew's toolset — ${id} holds ${uses.length === 0 ? "no tool groups" : uses.join(", ")} (\`uses:\` in its manifest, a protected path in the user's hand: docs/ops/crews.md). Report what you needed instead of retrying.`,

  /**
   * **Not a permission refusal at all** (§3.3): a statement about the
   * RESOURCE, which is why the owner gets it too and why it carries
   * `needs.door` rather than `needs.grant`. One sentence, the class and the
   * door substituted.
   */
  not_knowledge: (path: string, cls: ResourceClass): string =>
    `\`${path}\` is ${CLASS_NOUN[cls]}, not knowledge — this door serves vault pages only; ${CLASS_WHERE[cls]} (docs/ops/instance-layout.md).`,
} as const;

/** What each class IS, in the one word every surface uses for it. */
const CLASS_NOUN: Readonly<Record<ResourceClass, string>> = Object.freeze({
  knowledge: "a vault page",
  artifact: "an artifact",
  machinery: "machinery",
  outside: "outside the vault",
});

/** And which door has it. `needs.door` is the machine-readable half of the same fact. */
const CLASS_WHERE: Readonly<Record<ResourceClass, string>> = Object.freeze({
  knowledge: "it is served here",
  artifact: "your artifacts are GET /api/artifacts, and in the vault they are files, on disk and in git",
  machinery: "the machinery is the file itself, on disk and in git — no door serves it as a page",
  outside: "a vault path is TitleCase folders from the vault root, with no leading slash and no traversal",
});

/** `needs.door` for a classification answer: the door that has the bytes, or none. */
const CLASS_DOOR: Readonly<Record<ResourceClass, string | null>> = Object.freeze({
  knowledge: null,
  artifact: "GET /api/artifacts",
  machinery: "the file itself",
  outside: null,
});

/**
 * The classification answer, built once so every door that serves knowledge
 * says the same thing about a path that is not.
 *
 * `invalid_request`, never `forbidden` and never `not_found`: the caller
 * named a path this door does not serve, which is a fact about their
 * request. A door that answered 404 here would be pretending the resource is
 * not there — it is, behind `needs.door` — and a door that answered 403
 * would be claiming a permission question that was never asked (§3.3).
 */
export function notKnowledge(path: string): Refusal {
  const cls = classify(path);
  const door = CLASS_DOOR[cls];
  return no("invalid_request", "not_knowledge", REFUSAL.not_knowledge(path, cls), door === null ? undefined : { door });
}

/**
 * The prefixes whose CONTENT this scope may read. A tier below `areas` comes
 * to the empty list, never to `null` — `null` is the owner's "every vault
 * path", and handing it to a tier that may not read a page would be the
 * §2.8 rename this model exists to prevent.
 */
export function readableAreas(scope: Scope): readonly string[] | null {
  return scope.tier === "areas" ? scope.areas : [];
}

/** May this scope see this path's CONTENT? (`knowledgeScope(...).canRead`.) */
export function mayReadPath(scope: Scope, path: string): boolean {
  return scope.tier === "areas" && canSeeUnder(path, scope.areas);
}

/**
 * May this scope be told this path EXISTS — path, title, one-line description,
 * never content? Deliberately wider than `mayReadPath`: tier `index` may see
 * that a page exists anywhere in the index and may read none of them.
 */
export function mayListPath(scope: Scope, path: string): boolean {
  return scope.tier !== "none" && canSeeUnder(path, scope.tier === "areas" ? scope.areas : null);
}

/**
 * The prefixes a caller passes into a SQL area filter or a vault-bridge call.
 *
 * `null` HERE is "no prefix restriction on the TITLES this tier may browse"
 * (tier `index`), which is the OPPOSITE of `readableAreas`'s `null`. Two
 * functions rather than one field with two meanings — §2.8's finding, given a
 * type instead of an eleven-line comment.
 */
export function titlePrefixes(scope: Scope): readonly string[] | null {
  return scope.tier === "areas" ? scope.areas : null;
}

/** Tier `index`: paths/titles only, never content. */
export function titlesOnly(scope: Scope): boolean {
  return scope.tier === "index";
}

/** Membership: `null` projects is every project (the internal rule); a row with no project belongs to the user alone. */
export function memberOfProject(scope: Scope, slug: string | null): boolean {
  if (slug === null) return false;
  return scope.projects === null || scope.projects.includes(slug);
}

// ===========================================================================
// Project grants, inherited (T4-7) — a member's reach is its own ∪ its projects'
// ===========================================================================
//
// A project may hold its own read grant (0032, `PUT /api/projects/:slug`),
// and every agent IN the project inherits it (D13, ruled 2026-09-22; screen
// 13). The union is computed where the credential is resolved — never
// written into the member's own row — so the member's `agents.grants` stays
// the owner's hand on THAT agent, and leaving the project is the whole of
// taking the inherited reach away: the next request resolves without it.

/** One project's own read grant, as a member inherits it. `grants` is the stored jsonb, re-checked here rather than trusted. */
export interface ProjectGrant {
  readonly project: string;
  readonly grants: unknown;
}

/**
 * Reach a member holds only through a project: an area, the `titles` of a
 * tier-`index` grant, or `queries`. The first project (by the order given)
 * that supplies it is its provenance — *via project* on every surface.
 */
export interface InheritedReach {
  readonly key: string;
  readonly project: string;
}

/** The keys of `InheritedReach` that are not an area. Neither is a valid area prefix, so the two can never collide with one. */
export const INHERITED_TITLES = "titles";
export const INHERITED_QUERIES = "queries";

/** A grant envelope, as a member's own row and a project's row both store it. */
export interface GrantEnvelope {
  readonly tier: GrantTier;
  readonly areas: readonly string[];
  readonly queries?: boolean | undefined;
}

const TIER_RANK: Readonly<Record<GrantTier, number>> = Object.freeze({ none: 0, index: 1, areas: 2 });

/**
 * A project's stored grant, read back fail-closed: an unknown tier is
 * `none`, and each area must still be one an agent may be granted
 * (`validAgentAreaGrant` — so the bare vault, `.metistry/`, `Artifacts/…`
 * or a traversal written into the row by hand is dropped, never inherited).
 * An `areas` tier left with no area is `none`: an empty folder list is no
 * grant, and must not become one by arriving malformed.
 */
function projectEnvelope(raw: unknown): GrantEnvelope {
  const g = (raw ?? {}) as { tier?: unknown; areas?: unknown; queries?: unknown };
  const tier: GrantTier = g.tier === "index" || g.tier === "areas" ? g.tier : "none";
  const areas = tier === "areas" && Array.isArray(g.areas) ? g.areas.filter((a): a is string => validAgentAreaGrant(a)) : [];
  return { tier: tier === "areas" && areas.length === 0 ? "none" : tier, areas, queries: g.queries === true };
}

/**
 * **A member's effective grant: its own ∪ its projects'** (T4-7), with the
 * provenance of everything the projects added.
 *
 * Only the projects in `member` count — a project grant reaches the agents
 * IN the project and nobody else, so a slug dropped from `member` takes its
 * reach with it (the ticket's bold test). Per field:
 *
 * - **tier** — the widest held (`none` < `index` < `areas`).
 * - **areas** — the member's own first, verbatim, then each project's area
 *   that the areas already held do not cover (`underAreas`), in project
 *   order. An area the member holds itself is its own, never *via project*.
 * - **queries** — held if the member or any of its projects holds it.
 *
 * One corner the single-tier `Scope` cannot say both halves of: `index`
 * (titles everywhere, no content) beside `areas` (content under some
 * folders). The union comes to `areas` — the content — exactly as an
 * approval on top of an `index` grant does (`mergeGrantOverrides` in the
 * console, ruled 2026-09-19 B); the titles outside those folders are not
 * drawn and not served.
 *
 * Pure, like everything in this file: the host reads the rows and hands
 * them in, and the console's door and the permissions table call this one
 * function, so the table cannot draw a reach the door does not grant.
 */
export function inheritGrants(own: GrantEnvelope, member: readonly string[], projects: readonly ProjectGrant[]): { grants: GrantEnvelope; via: InheritedReach[] } {
  const held = projects.filter((p) => member.includes(p.project)).map((p) => ({ project: p.project, grants: projectEnvelope(p.grants) }));
  let tier: GrantTier = own.tier;
  for (const p of held) if (TIER_RANK[p.grants.tier] > TIER_RANK[tier]) tier = p.grants.tier;

  const via: InheritedReach[] = [];
  const areas = own.tier === "areas" ? [...own.areas] : [];
  if (tier === "areas") {
    for (const p of held) {
      for (const area of p.grants.areas) {
        if (areas.includes(area) || underAreas(area, areas)) continue;
        areas.push(area);
        via.push({ key: area, project: p.project });
      }
    }
  } else if (tier === "index" && own.tier !== "index") {
    via.push({ key: INHERITED_TITLES, project: held.find((p) => p.grants.tier === "index")!.project });
  }

  const ownQueries = own.queries === true;
  const queriesFrom = ownQueries ? undefined : held.find((p) => p.grants.queries === true);
  if (queriesFrom) via.push({ key: INHERITED_QUERIES, project: queriesFrom.project });
  const queries = ownQueries || queriesFrom !== undefined;

  if (via.length === 0) return { grants: own, via };
  return { grants: { tier, areas: tier === "areas" ? areas : [], ...(queries ? { queries: true } : {}) }, via };
}

/**
 * **The one decision function.**
 *
 * @param p    who is asking, derived from the credential
 * @param verb what they are trying to do
 * @param r    what they are trying to do it to
 */
export function may(p: Principal, verb: Verb, r: Resource): Decision {
  // ---- the owner's sentence, made arithmetic (P4, §3.1) -----------------
  //
  // "The owner should always have access to everything" (ruled 2026-09-19).
  // Every door admits the owner for every verb on every resource that door
  // serves, with no exception clause anywhere below — which is only safe
  // BECAUSE `Resource` is a closed union and `classify()` exists: the
  // machinery and `Artifacts/` are not knowledge paths, so the rule never
  // has to be weakened to keep an agent out of the machinery.
  //
  // The one thing this is NOT is a door that serves everything. A knowledge
  // door handed something that is not knowledge still answers — with a
  // CLASSIFICATION (`notKnowledge`, naming the door that has the bytes),
  // never with a permission refusal and never with a 404 pretending the
  // thing is not there. That is the owner's ruling and the research
  // document's open question 3 taken together: keep one door per resource
  // class, make the reason classification rather than permission.
  if (p.role === "owner") {
    if (r.kind === "knowledge") return classify(r.path) === "knowledge" ? OK : notKnowledge(r.path);
    // A name nothing in this build registers is not a permission question,
    // for the owner either: the fail-closed default stands, so `may` never
    // answers "yes" about a tool that does not exist. (`RULED_TOOLS` is
    // pinned against the bridge's own `TOOL_NAMES` by the enumeration test.)
    if (r.kind === "tool" && !RULED_TOOLS.has(r.name)) return hidden("forbidden", "role_required");
    return OK;
  }

  switch (r.kind) {
    case "tool":
      return mayUseTool(p, r.name);
    case "toolset":
      return mayToolset(p, r.name);
    case "knowledge":
      return mayKnowledge(p, r.door, r.path, r.settled === true);
    case "query":
      return mayQuery(p, r.door, r.name, r.exposure);
    case "project":
      if (memberOfProject(p.scope, r.slug)) return OK;
      // A row outside your projects does not exist for you — the
      // collaboration boundary, uniform with artifacts.
      if (r.door === "task") return hidden("not_found", "not_member");
      // `task_create` is the one project check that is `forbidden` rather
      // than `not_found`: you NAMED the project, so it is not a row you
      // cannot see, it is a room you are not in — and a room you named is
      // not an existence question, so this one speaks. A create with no
      // project names nothing, so there is nothing to say.
      return r.slug === null ? hidden("forbidden", "membership_required") : no("forbidden", "membership_required", REFUSAL.membership_required(p.id, r.slug));
    case "action": {
      const mode = effectiveActions(p.scope.autonomy)[r.action];
      if (mode !== "deny") return OK;
      return no("forbidden", "autonomy_required", REFUSAL.autonomy_required(p.id, r.action), { autonomy: { action: r.action, mode: "propose" } });
    }
    case "connection":
      return mayConnection(p, r.door, r.name, r.offered);
    case "console":
      // Door B, and both halves HIDE: the console's answer to a credential
      // outside the owner surface is uniform across every route it covers
      // (CRIT-7), because a 403 that explained itself on some paths and a
      // 404 on others would say which spellings this build knows.
      // `console_agent` is the agent bearer's uniform 403 on everything
      // outside /capture and /mcp; `console_management` is the `isUser`
      // gate, which excludes the capture owner token by name.
      if (r.door === "console_agent" && p.role === "tool") return OK;
      return hidden("forbidden", "role_required");
  }
  // Unreachable while `Resource` is a closed union; kept so a new variant
  // fails CLOSED rather than falling through to a default allow.
  return hidden("forbidden", "role_required");
}

/**
 * The argument-free half of every gate: would this tool ever answer this
 * principal? One case per name in mcp-brain's `TOOL_NAMES`. `core` already
 * names those tools (`CREW_TOOL_GROUPS`, `CREW_NEVER_TOOLS` in manifest.ts),
 * so this is not a new coupling.
 *
 * A tool whose gate depends on its ARGUMENTS (`knowledge_read`'s path,
 * `queries_run`'s name, `tasks_*`'s project) asks the matching resource door
 * as well; the entry here is the part that holds whatever the argument is.
 */
/**
 * The tools this principal's run may call at all, or `null` when it holds no
 * allowlist and every tool's own rule is the whole gate.
 *
 * Only a crew has one. It is the manifest's `uses` GROUPS expanded through
 * `CREW_TOOL_GROUPS` — the same table and the same function the assistant's
 * runner builds its client-side list from (`crewToolsFor`), so the door and
 * the caller cannot disagree about what a group contains. Groups rather than
 * tool names is what makes the rule that matters a property of the table:
 * `CREW_NEVER_TOOLS` are in no group, so no `uses` list can reach them.
 */
export function allowedTools(p: Principal): readonly string[] | null {
  return p.role === "crew" ? crewToolsFor(p.uses ?? []) : null;
}

/**
 * P2's one behaviour change (§2.2, §4): a crew's toolset is decided HERE, at
 * the door, rather than by the filter in the process that dispatched it.
 *
 * Until now `uses` was enforced only by `apps/assistant/src/tools.ts`, which
 * is a process boundary — real, since the run's bearer is minted per run and
 * held by that process alone, but not the tool. Five of the eight groups
 * were also gated server-side for other reasons; `rooms`, `artifacts`,
 * `tasks`, `capture` and `requests` were not. CLAUDE.md's rule over all the
 * others is "enforce at the tool, never by prompting" — a filter in the
 * caller is neither.
 *
 * The refusal names the toolset the crew DOES hold and where it is declared,
 * because widening it is an edit to a §4.7 protected path in the user's own
 * hand: the crew cannot ask for this one, and a model told only "no" retries.
 */
function mayToolset(p: Principal, name: string): Decision {
  const allowed = allowedTools(p);
  if (allowed === null || allowed.includes(name)) return OK;
  return no("forbidden", "not_in_uses", REFUSAL.not_in_uses(p.id, name, p.uses ?? []));
}

/**
 * Every tool name the admission table below has a rule for.
 *
 * It exists so that "the owner may use every tool" cannot quietly become
 * "the owner may use any STRING": an unknown name fails closed for every
 * role. `packages/mcp-brain/test/may-surface.test.ts` asserts this set is
 * exactly that bridge's `TOOL_NAMES`, so the two cannot drift — a tool added
 * there without a rule here is a test failure, which is the same guarantee
 * the switch's own `default:` gives every other role.
 */
export const RULED_TOOLS: ReadonlySet<string> = new Set([
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
  "tasks_comment",
  "tasks_thread",
  "knowledge_search",
  "knowledge_read",
  "knowledge_list",
  "knowledge_grep",
  "knowledge_write",
  "artifacts_publish",
  "artifacts_get",
  "artifacts_list",
  "artifacts_comment",
  "artifacts_resolve",
  "artifacts_review",
  "agents_delegate",
  "queries_list",
  "queries_run",
  "connections_list",
  "connections_call",
  "propose_action",
]);

// ===========================================================================
// The permissions table's cells — where each ruled tool lands (T4-6)
// ===========================================================================
//
// docs/ops/actors.md's *Tool or action → Row · column* table, as data, beside
// the set it has to cover. Every name in `RULED_TOOLS` and every action kind
// has exactly ONE placement here — an enumeration test holds this record to
// that set and to the document's table — so a tool added later cannot be
// missing from the permissions table by accident: it fails CI until someone
// decides which cell it fills, or says why it fills none.
//
// A placement says WHERE a power is drawn and never WHETHER it is held. That
// is `may()`'s answer, asked by `describePermissions` below for every tool,
// so the table cannot say something the door does not do.

/** A column of the table: Resource × Read × Write. */
export type PermissionColumn = "read" | "write";

/**
 * What an admitted tool puts in its cell:
 *
 * - `areas` — one entry per knowledge area the scope holds (tier `index`:
 *   *Titles only*; the bare vault: *The whole vault*).
 * - `projects` — one entry per project slug the scope holds; every project
 *   (`null`) is one `*` entry.
 * - a verb — one fixed entry, `{ key, label }`.
 */
export type PermissionCellEntries = "areas" | "projects" | { readonly key: string; readonly label: string };

export interface PermissionCell {
  readonly resource: PermissionResourceKind;
  readonly column: PermissionColumn;
  readonly entries: PermissionCellEntries;
}

/** Where one ruled tool is drawn. */
export type ToolPlacement =
  /**
   * One cell. `projectScoped`: the tool reaches rows by project membership
   * decided per row (`access.ts`: "sees the tools and finds nothing"), so it
   * is drawn only when the scope holds a project at all.
   */
  | { readonly placement: "cell"; readonly cell: PermissionCell; readonly projectScoped: boolean }
  /** `propose_action`: no cell of its own — it gates the action kinds (`ACTION_PERMISSION_CELLS`). */
  | { readonly placement: "actions" }
  /** Deliberately in no cell, and why. */
  | { readonly placement: "none"; readonly why: string };

const verb = (key: string, label: string): PermissionCellEntries => Object.freeze({ key, label });
const V = Object.freeze({
  create: verb("create", "Create"),
  update: verb("update", "Update"),
  comment: verb("comment", "Comment"),
  publish: verb("publish", "Publish"),
  review: verb("review", "Review"),
  capture: verb("capture", "Capture"),
  named: verb("named", "Named queries"),
  delegate: verb("delegate", "Delegate"),
  dispatch: verb("dispatch", "Dispatch"),
});
const cell = (resource: PermissionResourceKind, column: PermissionColumn, entries: PermissionCellEntries): PermissionCell => Object.freeze({ resource, column, entries });
const at = (resource: PermissionResourceKind, column: PermissionColumn, entries: PermissionCellEntries, projectScoped = false): ToolPlacement =>
  Object.freeze({ placement: "cell" as const, cell: cell(resource, column, entries), projectScoped });
const ASKING_IS_NOT_A_POWER = "asking is not a power: every credential may ask, and asking grants nothing (mayUseTool)";
const A_CONNECTION_IS_ITS_OWN_ROW = "a connection is drawn as its own row, one per connection the actor reaches, its tools by group and mode (describePermissions' connection rows) — the proxy's two tools are the door, not a power of their own";

/**
 * **Every ruled tool → its one placement**, in docs/ops/actors.md's order.
 * Keys are exactly `RULED_TOOLS` (the enumeration test in
 * `packages/core/test/permissions.test.ts`).
 */
export const TOOL_PERMISSION_CELLS: Readonly<Record<string, ToolPlacement>> = Object.freeze({
  knowledge_search: at("knowledge", "read", "areas"),
  knowledge_list: at("knowledge", "read", "areas"),
  knowledge_read: at("knowledge", "read", "areas"),
  knowledge_grep: at("knowledge", "read", "areas"),
  // "writes never exceed reads": the same area entries. Only the assistant reaches it.
  knowledge_write: at("knowledge", "write", "areas"),
  tasks_list: at("work", "read", "projects", true),
  tasks_thread: at("work", "read", "projects", true),
  tasks_create: at("work", "write", V.create, true),
  tasks_claim: at("work", "write", V.update, true),
  tasks_renew: at("work", "write", V.update, true),
  tasks_release: at("work", "write", V.update, true),
  tasks_update: at("work", "write", V.update, true),
  tasks_close: at("work", "write", V.update, true),
  tasks_comment: at("work", "write", V.comment, true),
  artifacts_get: at("artifacts", "read", "projects", true),
  artifacts_list: at("artifacts", "read", "projects", true),
  artifacts_publish: at("artifacts", "write", V.publish, true),
  artifacts_comment: at("artifacts", "write", V.comment, true),
  artifacts_resolve: at("artifacts", "write", V.comment, true),
  artifacts_review: at("artifacts", "write", V.review, true),
  capture: at("inbox", "write", V.capture),
  queries_list: at("queries", "read", V.named),
  queries_run: at("queries", "read", V.named),
  agents_delegate: at("agents", "write", V.delegate),
  connections_list: Object.freeze({ placement: "none" as const, why: A_CONNECTION_IS_ITS_OWN_ROW }),
  connections_call: Object.freeze({ placement: "none" as const, why: A_CONNECTION_IS_ITS_OWN_ROW }),
  propose_action: Object.freeze({ placement: "actions" as const }),
  requests_create: Object.freeze({ placement: "none" as const, why: ASKING_IS_NOT_A_POWER }),
  request_access: Object.freeze({ placement: "none" as const, why: ASKING_IS_NOT_A_POWER }),
});

/**
 * **Every action kind → the cells it fills** when `propose_action` is
 * admitted and the kind is not `deny`. An action runs as the owner's own
 * click (apps/console/src/actions.ts), so the proposer's project scope is not
 * its gate — autonomy is. `comment` fills two cells: its schema takes a
 * `work_id` or an `artifact_id` (C53).
 */
export const ACTION_PERMISSION_CELLS: Readonly<Record<ActionKind, readonly PermissionCell[]>> = Object.freeze({
  dispatch: Object.freeze([cell("work", "write", V.dispatch)]),
  task_update: Object.freeze([cell("work", "write", V.update)]),
  comment: Object.freeze([cell("work", "write", V.comment), cell("artifacts", "write", V.comment)]),
  capture: Object.freeze([cell("inbox", "write", V.capture)]),
  // A connection is its own row (describePermissions' connection rows), where
  // an Ask First tool already carries the ⏱ — so the action that approves one
  // fills no cell of the six.
  connection_call: Object.freeze([]),
});

function mayUseTool(p: Principal, name: string): Decision {
  const { tier, queries } = p.scope;
  // The run's allowlist first: a tool outside it is refused whatever the
  // grant says, and the door asks the same question (`{kind:"toolset"}`)
  // before any body runs, so the two cannot answer differently.
  const inToolset = mayToolset(p, name);
  if (!inToolset.ok) return inToolset;
  switch (name) {
    // No gate beyond authentication (§1.4): the inbox and the queue are open
    // to every credential that got this far, and asking is not a capability.
    case "capture":
    case "requests_create":
    case "request_access":
      return OK;

    // Project membership decides these, per row — there is no tool-level
    // gate, so a principal with no projects sees the tools and finds nothing.
    case "tasks_list":
    case "tasks_claim":
    case "tasks_renew":
    case "tasks_update":
    case "tasks_release":
    case "tasks_close":
    case "tasks_create":
    case "tasks_comment":
    case "tasks_thread":
    case "artifacts_publish":
    case "artifacts_get":
    case "artifacts_list":
    case "artifacts_comment":
    case "artifacts_resolve":
    case "artifacts_review":
      return OK;

    // The TIER gates. No path is involved in any of them — the caller has
    // not named anything yet — so there is nothing an answer could confirm
    // the existence of, and all four say which tier this TOOL needs and
    // which one the credential holds. `index` for the three that a
    // discovery tier may reach at all (`knowledge_read` among them: tier
    // `index` gets as far as the scope_required answer for a page whose
    // title it can already see); `areas` for the one that is content.
    case "knowledge_search":
    case "knowledge_read":
    case "knowledge_list":
      return tier === "none" ? no("forbidden", "tier_required", REFUSAL.tier_required(tier, "index")) : OK;
    case "knowledge_grep":
      // Content, like `knowledge_read` — tier `index` browses titles and may
      // not grep them.
      return tier !== "areas" ? no("forbidden", "tier_required", REFUSAL.tier_required(tier, "areas")) : OK;

    case "knowledge_write":
      // §4.11: one writer. The refusal carries the why now, which is what
      // let the tool's DESCRIPTION stop carrying it (P3).
      return p.role === "assistant" ? OK : no("forbidden", "role_required", REFUSAL.role_required(name, "the instance assistant"));
    case "agents_delegate":
      // A crew never dispatches crews; the assistant decides what leaves the
      // brain.
      return p.role === "assistant" ? OK : no("forbidden", "role_required", REFUSAL.role_required(name, "the instance assistant"));

    case "queries_list":
    case "queries_run":
      // Internal principals always; others only with an explicit `queries`
      // grant.
      return p.role === "assistant" || queries ? OK : no("forbidden", "queries_required", REFUSAL.queries_required(p.id));

    // The proxy's lazy pair (§2.6, T4-8b). No tool-level gate, like the
    // task tools: which connections a credential reaches is decided per
    // connection (`mayConnection`), so a principal granted none sees the two
    // tools and finds nothing behind them. A crew still needs the
    // `connections` group — `mayToolset` above has already asked.
    case "connections_list":
    case "connections_call":
      return OK;

    case "propose_action":
      // Lazy by credential: nothing to offer, nothing listed. The door uses
      // `.ok` to decide whether to REGISTER, so this refusal is never
      // rendered on the wire — an agent given no room does not learn the
      // tool exists. It still carries the vocabulary's sentence, because the
      // audit row is read by a person.
      return admitsAnyAction(p.scope.autonomy) ? OK : no("forbidden", "autonomy_required", REFUSAL.autonomy_required(p.id, null));

    default:
      // An unknown name fails closed, and says nothing: a tool this build
      // does not have is not a permission question. The enumeration test
      // walks TOOL_NAMES, so a tool added without a rule here is a failure.
      return hidden("forbidden", "role_required");
  }
}

/**
 * **May this principal reach this connection through the proxy?** (§2.6,
 * C115; T4-8b.) Three things, in order, each a rule rather than a sentence:
 *
 * 1. **The run's own allowlist.** A crew holds the lazy pair only when its
 *    manifest's `uses` names the `connections` group — asked here as well as
 *    at the door, so the answer cannot depend on which question was asked.
 * 2. **The assistant reaches every connection.** C115: with the offer
 *    switch off, "only Metistry uses the connection (Metis, syncs)" — so the
 *    switch is about lending, and the assistant is not borrowing.
 * 3. **Everyone else needs two things the owner wrote down**: the
 *    connection offered to agents (`offer_to_agents`, the file) AND its name
 *    in this credential's `scope.connections` (the grant). Either missing is
 *    the same answer as a connection that does not exist — it HIDES, because
 *    which connections the owner holds is not a borrower's to learn.
 *
 * The capture token is not an agent and reaches none.
 */
function mayConnection(p: Principal, door: ConnectionDoor, name: string, offered: boolean): Decision {
  const inToolset = mayToolset(p, door);
  if (!inToolset.ok) return inToolset;
  if (p.role === "assistant") return OK;
  if (p.role === "tool") return hidden("forbidden", "role_required");
  if (offered && (p.scope.connections ?? []).includes(name)) return OK;
  return hidden("not_found", "connection_required", NO_SUCH_CONNECTION(name));
}

/** The proxy's one answer for a connection the caller cannot reach — whatever the reason, and the same as a name that was never configured. */
export const NO_SUCH_CONNECTION = (name: string): string => `no such connection: ${name}`;

/**
 * **The one rule about naming an area** (ruled 2026-09-19 B, and the
 * boundary P3's vocabulary is held to): a refusal names the grant that would
 * unlock a path only when the caller may ALREADY list that path and the page
 * is really there. It already knows the page exists, so naming its folder is
 * not a new leak — and for everything else, naming one would turn a refusal
 * into an oracle for what exists where the caller cannot look.
 *
 * So `scope_required` has two renderings, and exactly one of them speaks.
 * They are here, together, rather than at six call sites deciding
 * separately.
 */
function scopeMiss(scope: Scope, path: string, settled: boolean, reason: Reason = "scope_required"): Refusal {
  if (!(settled && mayListPath(scope, path))) return hidden("forbidden", reason);
  const sr = scopeRequired(path);
  return no("forbidden", "scope_required", sr.message, { grant: { tier: "areas", area: areaOf(path) } }, sr.expose);
}

function mayKnowledge(p: Principal, door: KnowledgeDoor, path: string, settled: boolean): Decision {
  const { scope } = p;
  /** A path refused under a grant that could cover it vs. a tier that never could. Same answer on the wire; the reason says which. */
  const missed: Reason = scope.tier === "areas" ? "scope_required" : "tier_required";

  switch (door) {
    case "read":
      if (scope.tier !== "areas") return scopeMiss(scope, path, settled, "tier_required");
      if (!validKnowledgePath(path)) return notKnowledge(path);
      return canSeeUnder(path, scope.areas) ? OK : scopeMiss(scope, path, settled);

    case "links":
      // A page's edges are content, so the read rule applies — with the same
      // scope_required upgrade for a page whose title is already visible.
      if (mayReadPath(scope, path)) return OK;
      return scopeMiss(scope, path, settled, missed);

    case "list":
      // The PREFIX argument. An omitted one aggregates over the grant and is
      // never refused; tier `index` has no prefix restriction at all (it
      // browses every title). Tier `none` is refused at the tool.
      if (path === "" || scope.tier !== "areas") return OK;
      // A prefix outside the grant names no page, so there is no title the
      // caller can already see and nothing that may be said about it.
      return canSeeUnder(path, scope.areas) ? OK : hidden("forbidden", "scope_required");

    case "grep":
      if (scope.tier !== "areas") return hidden("forbidden", "tier_required");
      if (path === "") return OK;
      return canSeeUnder(path, scope.areas) ? OK : hidden("forbidden", "scope_required");

    case "write":
      // Writes never exceed reads, and both halves hide: the writer's own
      // narrowing is `METISTRY_ASSISTANT_AREAS`, not a page it could ask
      // about. `underAreas` rather than `canSeeUnder` because the door has
      // already answered a non-vault path with the classification by here.
      if (p.role !== "assistant") return no("forbidden", "role_required", REFUSAL.role_required("knowledge_write", "the instance assistant"));
      if (scope.tier !== "areas") return hidden("forbidden", "scope_required");
      // `Me/` and the user's own journal (`isUserOwnedPath`): discovered,
      // never assumed (daily-flow-spec §6.6), one writer and it is not this
      // one (§5.1 D10) — a statement about the PATH, ahead of the area fence,
      // so a bare-vault grant (`areas: null`, the assistant's own default)
      // cannot reach it either. It SPEAKS, because no grant will ever unlock
      // it: the remedy is `requests_create`, not `request_access`.
      if (isUserOwnedPath(path)) return no("forbidden", "role_required", REFUSAL.role_required(path, "the owner"), { door: "requests_create" });
      return scope.areas === null || underAreas(path, scope.areas) ? OK : hidden("forbidden", "scope_required");

    case "resources":
      // MCP resources/list. The door renders this as an EMPTY LIST, not as a
      // refusal — only `.ok` is read — because a resource collection that is
      // empty for you is the honest answer and a 403 on a listing is not.
      return scope.tier === "areas" ? OK : hidden("forbidden", "tier_required");

    case "console_page":
      // Door D, for a credential that is not the owner. Refused and NOT
      // FOUND are the same answer on purpose and with the same sentence: a
      // path outside the scope must not be distinguishable from a path that
      // is not there, from machinery, or from an artifact. The OWNER never
      // reaches this — `may` answered them above, with a classification
      // where this door has no page (P4).
      return canSeeUnder(path, readableAreas(scope)) ? OK : hidden("not_found", validKnowledgePath(path) ? missed : "not_knowledge", NO_SUCH_PAGE);
  }
}

function mayQuery(p: Principal, door: QueryDoor, name: string, exposure: "generic" | "route"): Decision {
  if (exposure === "generic") return OK;
  // A query marked `expose: route` is served by an endpoint that does
  // something the generic door cannot — `knowledge_pages` filters every row
  // through the caller's scope — so answering it here would be that filter
  // undone. The refusal HIDES: it is each door's own UNKNOWN-QUERY answer,
  // byte for byte, so neither door is an oracle for which route-only queries
  // exist. `/mcp` names the query back (that is what its unknown-query
  // refusal does); the console's names nothing (nor does its).
  //
  // The owner is not here at all since P4: they get the query. The rule
  // exists so an agent cannot page the vault index unscoped, and the owner
  // was only ever collateral (§2.6).
  return door === "queries_run" ? hidden("not_found", "not_exposed", `no such query: ${name}`) : hidden("not_found", "not_exposed");
}

// ===========================================================================
// describeScope() / formatRefusal() — ONE renderer
// ===========================================================================
//
// P3 of docs/research/2026-09-19-grants-and-access-simplified.md §4. §2.10's
// finding was four vocabularies for one record — the console's
// `ACCESS_LABEL`, the Needs You card's hand-written trade-off note, the tool
// descriptions' English, and a CLI that rendered grants not at all — so
// every surface below renders THIS and nothing of its own:
// `metistry agents list`, the console's Agents panel, the Needs You
// `access_request` card, and the wire envelope every door answers with.

/** The one shape a scope is SAID in. Every field is presentation; nothing here decides anything. */
export interface ScopeView {
  readonly id: string;
  readonly role: Role;
  /** The role in words, as a person reads it: "the owner", "an agent", … */
  readonly who: string;
  readonly tier: GrantTier;
  /** The tier's one word: `none` | `titles` | `folders`. */
  readonly access: string;
  /** `null` = every vault path — the owner, whose vault it is. */
  readonly areas: readonly string[] | null;
  /** The access half of the triple, areas included: "folders: Areas/Health". */
  readonly scope: string;
  readonly queries: boolean;
  /** `null` = every project. */
  readonly projects: readonly string[] | null;
  /** A crew's tool groups; `null` for every other role, which carries no allowlist. */
  readonly uses: readonly string[] | null;
  readonly autonomy: {
    readonly level: AutonomyLevel;
    readonly actions: Record<ActionKind, ActionMode>;
    /**
     * The same table, with WHY (C46/C47's `effectiveActionsDetailed`): set by
     * the owner, defaulted from the level, or clamped to its ceiling. Carried
     * here so a client of `GET /api/agents` (or an `access_request` payload)
     * never re-derives it — the console, the CLI and MetistryKit all read
     * this one table instead of three copies of the same arithmetic.
     */
    readonly detailed: Record<ActionKind, EffectiveActionEntry>;
  };
  readonly source: GrantSource;
  /** Where the scope came from, in words — "configuration, not a grant" said once rather than reconstructed from `role` at each door (§2.7). */
  readonly from: string;
  /** Everything that is not the tier: queries, projects, uses, autonomy. Each one phrase. */
  readonly extras: readonly string[];
  /** **The triple**: role · access · extras. One line, the same words in the CLI, the console and the queue. */
  readonly line: string;
}

/** The role in words. The CONSOLE's chip and the CLI's column read this, so they cannot disagree about what a crew is called. */
export const ROLE_LABEL: Readonly<Record<Role, string>> = Object.freeze({
  owner: "the owner",
  assistant: "the instance assistant",
  agent: "an agent",
  crew: "a crew",
  tool: "a capture tool",
});

/** Where a scope came from, in words. Three sources, one sentence each (§1.2, §2.7). */
export function sourceLabel(source: GrantSource): string {
  if (source === "environment") return "configuration, not a grant (METISTRY_ASSISTANT_AREAS), plus any area the owner has approved";
  if (source === "registry") return "the registry — the owner's own hand, durable";
  return `its manifest (${source.manifest}) — a protected path, re-read on every sync`;
}

/**
 * **One structure, rendered everywhere.** The triple the research document
 * asks for — role · areas/tier · extras — plus the fields a surface needs to
 * lay it out itself.
 *
 * It is pure: a `Principal` in, words out. No database, no config, no
 * `await`. That is what lets the CLI render an agent it read over HTTP, the
 * console render one it read out of Postgres, and the queue render one that
 * was written into a proposal payload weeks ago, all in the same words.
 */
export function describeScope(p: Principal): ScopeView {
  const { tier, areas, queries, projects } = p.scope;
  const level: AutonomyLevel = AUTONOMY_LEVELS.includes(p.scope.autonomy?.level as AutonomyLevel) ? (p.scope.autonomy!.level as AutonomyLevel) : DEFAULT_AUTONOMY_LEVEL;
  const access = TIER_LABEL[tier];
  // `areas: null` is the owner's whole vault, and it is said as that rather
  // than as an empty list — an empty list is NO grant, and the two must never
  // read the same on a screen.
  const scope = areas === null ? `${access}: the whole vault` : tier === "areas" ? `${access}: ${areas.length > 0 ? areas.join(", ") : "nothing"}` : access;
  const uses = p.role === "crew" ? [...(p.uses ?? [])] : null;
  const extras = [
    ...(queries ? ["queries"] : []),
    ...(projects === null ? ["every project"] : projects.length > 0 ? [`projects: ${projects.join(", ")}`] : []),
    ...(uses !== null ? [`uses: ${uses.length > 0 ? uses.join(", ") : "nothing"}`] : []),
    `autonomy: ${level}`,
  ];
  return {
    id: p.id,
    role: p.role,
    who: ROLE_LABEL[p.role],
    tier,
    access,
    areas: areas === null ? null : [...areas],
    scope,
    queries,
    projects: projects === null ? null : [...projects],
    uses,
    autonomy: { level, actions: effectiveActions(p.scope.autonomy), detailed: effectiveActionsDetailed(p.scope.autonomy) },
    source: p.source,
    from: sourceLabel(p.source),
    extras,
    line: `${ROLE_LABEL[p.role]} · ${scope} · ${extras.join(", ")}`,
  };
}

// ===========================================================================
// describePermissions() — Resource × Read × Write (T4-6)
// ===========================================================================
//
// The permissions table (screen 7 §4.1, C58): one line per resource, an empty
// cell is `—`, and **absence is the denial** — the legend says "anything not
// listed is not granted", so every power a principal holds has a line, and
// nothing without one is held. docs/ops/actors.md is the rule for every cell.
//
// **The table renders `may()`; it never repeats it.** A tool fills its cell
// only when `may(principal, "act", {kind: "tool"})` admits it — which already
// includes a crew's `uses`, the tier gates, the assistant-only tools and
// `CREW_NEVER_TOOLS` — and an action verb only when `may` admits the action.
// Pure, like `describeScope`: the CLI, the console and MetistryKit print the
// rows this returns, in these words.

/** The resource in words — the row label every surface prints. Key order IS the table's row order (a test pins it to `PERMISSION_RESOURCES`). */
export const PERMISSION_RESOURCE_LABEL: Readonly<Record<PermissionResourceKind, string>> = Object.freeze({
  knowledge: "Knowledge",
  work: "Work",
  artifacts: "Artifacts",
  inbox: "Inbox",
  queries: "Queries",
  agents: "Agents",
});

/** Every project, said per resource. */
const PROJECTS_ALL_LABEL: Readonly<Partial<Record<PermissionResourceKind, string>>> = Object.freeze({ work: "All tasks", artifacts: "All" });
/** The bare vault — `areas: null`, or `/` in the list — said as what it is, never as a folder named `/` (C52). */
export const WHOLE_VAULT_LABEL = "The whole vault";
/** Tier `index`: the titles, anywhere, and no content. */
export const TITLES_ONLY_LABEL = "Titles only";

/** A connection this principal may reach, as far as the table needs it (F-3 owns the file). `tools` absent = none known yet. */
export interface PermissionConnection {
  readonly name: string;
  readonly tools?: readonly { readonly name: string; readonly group: ToolGroup; readonly mode: ToolMode }[] | undefined;
  /**
   * The owner's offer switch (C115). Given: the table asks `may()` whether
   * THIS principal reaches the connection — the assistant always, a borrower
   * only when offered and granted — so a host may hand every connection to
   * every actor. Absent: the caller has already decided, and it is drawn.
   */
  readonly offered?: boolean | undefined;
}

/**
 * The connections a principal reaches, of those a host handed it: a name as
 * it is, and a connection that says whether it is offered only when `may()`
 * admits this principal to call it (T4-10) — the proxy's own rule, asked the
 * proxy's way, so the table and the door cannot disagree.
 */
export function reachableConnections(p: Principal, list: readonly (string | PermissionConnection)[]): (string | PermissionConnection)[] {
  return list.filter((c) => typeof c === "string" || c.offered === undefined || may(p, "act", { kind: "connection", door: "connections_call", name: c.name, offered: c.offered }).ok);
}

export interface DescribePermissionsOptions {
  /** Connections reachable through the proxy (§2.6), by name or with their tools. One row each, after the six. */
  readonly connections?: readonly (string | PermissionConnection)[] | undefined;
  /** Where lines came from that the scope does not say: approvals, and per-run routine grants. */
  readonly history?: ActorGrantHistory | undefined;
}

/** Each cell's verb keys, in the order the mapping first names them — so a cell reads the same whichever way its verbs were reached. */
const VERB_ORDER: ReadonlyMap<string, number> = (() => {
  const seen: string[] = [];
  const note = (c: PermissionCell) => {
    if (typeof c.entries !== "object") return;
    const k = `${c.resource}.${c.column}.${c.entries.key}`;
    if (!seen.includes(k)) seen.push(k);
  };
  for (const pl of Object.values(TOOL_PERMISSION_CELLS)) if (pl.placement === "cell") note(pl.cell);
  for (const kind of ACTION_KINDS) for (const c of ACTION_PERMISSION_CELLS[kind]) note(c);
  return new Map(seen.map((k, i) => [k, i]));
})();

/**
 * **One principal's permissions, as the table's rows.** Rows come in
 * `PERMISSION_RESOURCE_LABEL` order, then one per connection by name; a row
 * with both cells empty is left out, so `[]` means the principal holds
 * nothing. Within a cell there is one entry per key, and where a verb is
 * reachable two ways (`tasks_update` directly and the `task_update` action)
 * it `asks` only if every way asks.
 *
 * `null` and `[]` render differently, on purpose: `areas: null` is *The
 * whole vault* and an empty area list is no Knowledge entry; `projects:
 * null` is *All tasks* and `projects: []` is no Work entry.
 */
export function describePermissions(p: Principal, opts: DescribePermissionsOptions = {}): PermissionRow[] {
  const base: PermissionProvenance = { kind: "base", source: p.source };
  const admits = (name: string): boolean => may(p, "act", { kind: "tool", name }).ok;
  const { scope } = p;
  const projectsHeld = scope.projects === null || scope.projects.length > 0;
  const approved = new Map<string, number | null>();
  for (const a of opts.history?.approved ?? []) if (!approved.has(a.area)) approved.set(a.area, a.proposalId);
  // T4-7: what the scope holds only through a project — an area, the titles, the queries
  const inherited = new Map<string, string>();
  for (const i of opts.history?.projects ?? []) if (!inherited.has(i.key)) inherited.set(i.key, i.project);
  /** Via a project when only a project holds `key`, else the base. */
  const viaProject = (key: string): PermissionProvenance => (inherited.has(key) ? { kind: "project", project: inherited.get(key)! } : base);
  /** An area's provenance: approved in Needs You, else via a project, else the base. */
  const provenanceOf = (key: string): PermissionProvenance => (approved.has(key) ? { kind: "approved", proposalId: approved.get(key)! } : viaProject(key));

  const cells = new Map<string, PermissionEntry[]>();
  const cellOf = (resource: PermissionResourceKind, column: PermissionColumn): PermissionEntry[] => {
    const k = `${resource}.${column}`;
    let c = cells.get(k);
    if (!c) cells.set(k, (c = []));
    return c;
  };
  /** Add, merging the same entry reached a second way (four read tools, a tool and an action): one entry per key, and it asks only if every way asks. */
  const put = (resource: PermissionResourceKind, column: PermissionColumn, e: PermissionEntry): void => {
    const c = cellOf(resource, column);
    const same = c.find((x) => x.key === e.key && JSON.stringify(x.provenance) === JSON.stringify(e.provenance));
    if (same) {
      c[c.indexOf(same)] = { ...same, asks: same.asks && e.asks };
      return;
    }
    c.push(e);
  };

  const areaEntry = (area: string, provenance: PermissionProvenance): PermissionEntry =>
    area === VAULT_ROOT_AREA ? { key: VAULT_ROOT_AREA, label: WHOLE_VAULT_LABEL, asks: false, provenance } : { key: area, label: area, asks: false, provenance };
  /** The areas the scope holds, as entries: the whole vault once, or each area verbatim. Approved areas carry their request. */
  const areaEntries = (): PermissionEntry[] => {
    if (scope.tier === "index") return [{ key: "titles", label: TITLES_ONLY_LABEL, asks: false, provenance: viaProject(INHERITED_TITLES) }];
    if (scope.tier !== "areas") return [];
    if (scope.areas === null || scope.areas.includes(VAULT_ROOT_AREA)) return [areaEntry(VAULT_ROOT_AREA, provenanceOf(VAULT_ROOT_AREA))];
    return scope.areas.map((a) => areaEntry(a, provenanceOf(a)));
  };
  const projectEntries = (resource: PermissionResourceKind): PermissionEntry[] =>
    scope.projects === null
      ? [{ key: "*", label: PROJECTS_ALL_LABEL[resource] ?? "All", asks: false, provenance: base }]
      : scope.projects.map((slug) => ({ key: slug, label: slug, asks: false, provenance: base }));

  // ---- the ruled tools, each through may() ----------------------------------
  for (const [name, pl] of Object.entries(TOOL_PERMISSION_CELLS)) {
    if (pl.placement !== "cell") continue;
    if (pl.projectScoped && !projectsHeld) continue;
    if (!admits(name)) continue;
    const { resource, column, entries } = pl.cell;
    // Knowledge write needs a tier that reaches content at all (the write door's own first gate).
    if (entries === "areas" && column === "write" && scope.tier !== "areas") continue;
    const add =
      entries === "areas"
        ? // writes never exceed reads — and an area the write door refuses outright (`Me/`, the owner's own journal) is not drawn as writable
          column === "write"
          ? areaEntries().filter((e) => may(p, "write", { kind: "knowledge", door: "write", path: e.key === VAULT_ROOT_AREA ? "probe.md" : `${e.key}/probe.md` }).ok)
          : areaEntries()
        : entries === "projects"
          ? projectEntries(resource)
          : // a named query is held by the `queries` flag alone — via a project when only a project holds it
            [{ key: entries.key, label: entries.label, asks: false, provenance: resource === "queries" ? viaProject(INHERITED_QUERIES) : base }];
    for (const e of add) put(resource, column, e);
  }

  // ---- the actions: propose_action admitted, the kind not `deny` --------------
  if (admits("propose_action")) {
    const table = effectiveActions(scope.autonomy);
    for (const kind of ACTION_KINDS) {
      if (!may(p, "act", { kind: "action", door: "propose_action", action: kind }).ok) continue;
      for (const c of ACTION_PERMISSION_CELLS[kind]) {
        if (typeof c.entries !== "object") continue;
        put(c.resource, c.column, { key: c.entries.key, label: c.entries.label, asks: table[kind] === "propose", provenance: base });
      }
    }
  }

  // ---- per-run routine grants: Knowledge · Read, as if applied ------------------
  //
  // Not in the scope (which is the base): each (area, routine) is its own
  // entry, drawn only when the read tools would admit this principal with
  // that grant applied — for a crew, `knowledge` must be in its `uses` — and
  // only where the base does not already cover it.
  for (const r of opts.history?.routines ?? []) {
    for (const area of r.areas) {
      if (scope.tier === "areas" && (scope.areas === null || underAreas(area, scope.areas))) continue;
      const widened: Principal = { ...p, scope: { ...scope, tier: "areas", areas: [...(scope.tier === "areas" ? (scope.areas ?? []) : []), area] } };
      const readable = Object.entries(TOOL_PERMISSION_CELLS).some(
        ([name, pl]) => pl.placement === "cell" && pl.cell.resource === "knowledge" && pl.cell.column === "read" && may(widened, "act", { kind: "tool", name }).ok,
      );
      if (readable) cellOf("knowledge", "read").push(areaEntry(area, { kind: "routine", routine: r.routine }));
    }
  }

  const ordered = (resource: PermissionResourceKind, column: PermissionColumn): PermissionEntry[] => {
    const c = cells.get(`${resource}.${column}`) ?? [];
    const rank = (e: PermissionEntry) => VERB_ORDER.get(`${resource}.${column}.${e.key}`);
    // verbs in the mapping's order; areas and projects as the scope lists them
    return c.every((e) => rank(e) !== undefined) ? [...c].sort((a, b) => rank(a)! - rank(b)!) : c;
  };

  const rows: PermissionRow[] = [];
  for (const kind of Object.keys(PERMISSION_RESOURCE_LABEL) as PermissionResourceKind[]) {
    const read = ordered(kind, "read");
    const write = ordered(kind, "write");
    if (read.length === 0 && write.length === 0) continue;
    rows.push({ resource: { kind }, label: PERMISSION_RESOURCE_LABEL[kind], read, write });
  }

  // ---- connections: one row per name, tools by group and mode -----------------
  //
  // Only those `may()` admits (reachableConnections), each entry marked
  // *Through Metistry* (screen 7 §10): Metistry calls the tool with the
  // owner's credential; the actor never holds it.
  const proxied: PermissionProvenance = { kind: "proxy" };
  const connections = reachableConnections(p, opts.connections ?? []).map((c) => (typeof c === "string" ? { name: c } : c));
  for (const c of [...connections].sort((a, b) => a.name.localeCompare(b.name))) {
    const read: PermissionEntry[] = [];
    const write: PermissionEntry[] = [];
    for (const t of c.tools ?? []) {
      if (t.mode === "off") continue;
      (t.group === "reads" ? read : write).push({ key: t.name, label: t.name, asks: t.mode === "ask", provenance: proxied });
    }
    if (read.length === 0 && write.length === 0) continue;
    rows.push({ resource: { kind: "connection", name: c.name }, label: c.name, read, write });
  }
  return rows;
}

// ---- the table, in words: what the CLI, the console and MetistryKit print ----------------
//
// The rows above are data; these are the ONE way a cell is said. The CLI
// calls them; the PWA (a browser script, which cannot import core) and
// MetistryKit (Swift) each carry a copy that a test holds to these on the
// same recorded rows (apps/console/test/pwa-reads.test.ts,
// apps/macos/tests/kit/permissions-table-tests.swift) — so the three surfaces
// print one table, not three.

/** An empty cell. Absence is the denial, and it is drawn, never left blank. */
export const PERMISSION_EMPTY_CELL = "—";
/** The owner answers first: an action at `propose`, a connection tool at `ask`. */
export const PERMISSION_ASKS_MARK = "⏱";
/** A connection's row (§2.6): the relay glyph, *reached through Metistry*. */
export const PERMISSION_CONNECTION_MARK = "⧉";
/** What the relay glyph says, in a legend and to VoiceOver — the *Through Metistry* provenance, said once per row (MetistryKit's `PermissionWords.relayed`). */
export const PERMISSION_CONNECTION_WORDS = "reached through Metistry";

/**
 * Where an entry came from, in words — nothing for `base`: a marker on
 * everything is a marker on nothing. Nothing for `proxy` either: every entry
 * of a connection row is reached through Metistry, so the row's ⧉ says it
 * once instead of every tool saying it again.
 */
export function permissionProvenanceText(p: PermissionProvenance): string | null {
  if (p.kind === "approved") return p.proposalId === null ? "approved in Needs You" : `approved in Needs You · #${p.proposalId}`;
  if (p.kind === "routine") return `during ${p.routine} only`;
  if (p.kind === "project") return `via project ${p.project}`;
  return null;
}

/** One entry: its label, ⏱ when the owner answers first, and its provenance when it is not the base. */
export function permissionEntryText(e: PermissionEntry): string {
  const why = permissionProvenanceText(e.provenance);
  return `${e.label}${e.asks ? ` ${PERMISSION_ASKS_MARK}` : ""}${why === null ? "" : ` (${why})`}`;
}

/** One cell: its entries, comma-separated, or the dash. */
export function permissionCellText(entries: readonly PermissionEntry[]): string {
  return entries.length === 0 ? PERMISSION_EMPTY_CELL : entries.map(permissionEntryText).join(", ");
}

/** One row as the table prints it: resource · read · write. A connection is marked ⧉. */
export function permissionRowText(row: PermissionRow): readonly [string, string, string] {
  const label = row.resource.kind === "connection" ? `${row.label} ${PERMISSION_CONNECTION_MARK}` : row.label;
  return [label, permissionCellText(row.read), permissionCellText(row.write)];
}

/** The §3.2 envelope: the uniform `error` every surface already answers with, plus the two additive fields. */
export interface RefusalEnvelope {
  readonly error: { readonly code: ErrorCode; readonly message: string };
  readonly reason?: Reason;
  readonly needs?: Needs;
}

/**
 * **The one renderer for a refusal.** `error` is untouched — invariant 8's
 * envelope, the same codes and the same statuses — and `reason` + `needs`
 * ride in the additive slot the console's `render` already merges.
 *
 * Two rules live here and nowhere else:
 *
 * 1. An EMPTY message is the code's canonical one ("not granted", "not
 *    found"), which is what every silent door already answered with. Silence
 *    has one spelling now instead of two.
 * 2. **A `hide` refusal loses its `reason` on the way out.** It keeps it
 *    internally — the audit row and the golden file both want to know why a
 *    door went quiet — but a `reason` on the wire would make a deliberately
 *    uninformative refusal distinguishable from absence, which is the whole
 *    thing it is not allowed to be.
 */
export function formatRefusal(d: Decision): RefusalEnvelope | null {
  if (d.ok) return null;
  return {
    ...errorEnvelope(d.code, d.message === "" ? undefined : d.message),
    ...(d.tell === "hide" ? {} : { reason: d.reason, ...(d.needs ? { needs: d.needs } : {}) }),
  };
}
