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

import { isVaultPath, VAULT_ROOT_AREA } from "./instance-layout.js";

/**
 * Read tiers (§4.11): default-deny, user-granted, attached to the token
 * server-side. Named `GrantTier` rather than `Tier` because `core` already
 * exports a COMPUTE tier (tiers.ts) and one word for two things is how the
 * grant model got hard to read in the first place (§2.8).
 */
export type GrantTier = "none" | "index" | "areas";

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
 */
export function scopeRequired(path: string): { message: string; expose: { reason: string; grantedScope: string } } {
  const area = areaOf(path);
  return {
    message:
      `you can see that this page exists, but reading it needs the \`${area}\` grant — ` +
      `ask for it: \`request_access\` with area \`${area}\` and why; the owner approves it in Needs You.`,
    expose: { reason: SCOPE_REQUIRED, grantedScope: area },
  };
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

import { admitsAnyAction, effectiveActions, type ActionAutonomy, type ActionKind, type ActionMode } from "./actions.js";
import { INSTANCE_LAYOUT } from "./instance-layout.js";
import { crewToolsFor } from "./manifest.js";
import type { ErrorCode } from "./errors.js";

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
  | "not_in_uses";

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
}

/**
 * `code` is on the refusal because P1's whole rule is that a door answers
 * with the same envelope it answered with before, and the code is half of
 * it: a project-scope miss is `not_found` (§3.1's `tell: "hide"`) while a
 * tier miss is `forbidden`. `message` is `""` where the door says nothing
 * today — silence is a decision here rather than an accident at a call site.
 * `expose` is the additive wire slot the console's `render` already merges
 * (mcp-brain's `Outcome.expose`); `scope_required` is still its only user.
 */
export interface Refusal {
  readonly ok: false;
  readonly code: ErrorCode;
  readonly reason: Reason;
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

export type Resource =
  /**
   * May this principal use this tool AT ALL, before any argument is read —
   * the argument-free half of every gate. `propose_action`'s conditional
   * registration already works this way (SEP-1881's scope-filtered
   * discovery); this makes the same question askable of all 27 tools, which
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
  | { readonly kind: "console"; readonly door: ConsoleDoor; readonly route: string };

const OK: Decision = { ok: true };

function no(code: ErrorCode, reason: Reason, message: string, needs?: Needs, expose?: Record<string, unknown>): Refusal {
  return { ok: false, code, reason, message, ...(needs ? { needs } : {}), ...(expose ? { expose } : {}) };
}

/** Refusal wording for the tier gates on `knowledge_list`/`knowledge_grep`/`agents_delegate` — deliberately not "not found": absence of permission must not look like absence of knowledge. */
const NOT_GRANTED = "not granted";

/** `knowledge_read`'s and `knowledge_write`'s shape refusal. */
export const NOT_A_VAULT_PATH = "path must be a vault path — TitleCase folders, no traversal, nothing under .metistry/ or Artifacts/";

/** The refusal every console knowledge door gives for a path that is not vault content. Shared so the two routes cannot drift. */
export const NOT_KNOWLEDGE =
  "no such page — a path must be vault CONTENT: not .metistry/, not Artifacts/, not the root CLAUDE.md, no leading slash and no traversal (docs/ops/instance-layout.md)";

/** The owner asking this door for one of their own `Artifacts/`: theirs, but not knowledge, and the artifacts service is the door that has the bytes (ruled 2026-09-19 D). */
export const ARTIFACTS_SIGNPOST =
  "Artifacts/ is yours but it is not knowledge — nothing indexes it, so this door has no page for it. Your artifacts are GET /api/artifacts (docs/ops/console-api.md); in the vault they are just files, on disk and in git.";

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

/**
 * A console `KnowledgeScope` as a decision principal.
 *
 * The console derives a caller's scope from the credential ONCE, at the top
 * of the request (`knowledgeScopeOf`), and hands THAT to `/api/knowledge/*`.
 * `may()` wants the principal it came from, and the trip back is lossless for
 * what that door decides: `areas: null` is precisely "the owner" in this
 * shape — it is what `OWNER_SCOPE` means — and every other scope is a holder
 * of grants. Nothing else about the credential bears on whether a PATH is
 * knowledge.
 *
 * It is a round trip, and P4 is where it stops being one: `classify()` moves
 * this door's refusal off the principal entirely, and the routes take the
 * principal rather than a scope.
 */
export function scopeAsPrincipal(scope: KnowledgeScope): Principal {
  return {
    id: "",
    role: scope.areas === null ? "owner" : "agent",
    scope: { tier: "areas", areas: scope.areas, queries: false, projects: [] },
    source: "registry",
  };
}

const ARTIFACTS_ROOT = INSTANCE_LAYOUT.artifactsDir;

/**
 * **The one decision function.**
 *
 * @param p    who is asking, derived from the credential
 * @param verb what they are trying to do
 * @param r    what they are trying to do it to
 *
 * The owner is NOT short-circuited here. §3.1's first property — `role:
 * "owner"` answers `{ok:true}` for every verb and every resource — is P4,
 * and it needs `classify()` in front of it so "the owner has everything"
 * never has to be weakened to keep an agent out of the machinery. Until
 * then the owner is decided by the rules below, exactly as they are today,
 * including the two places §2.6 found where that narrows them.
 */
export function may(p: Principal, verb: Verb, r: Resource): Decision {
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
      return memberOfProject(p.scope, r.slug)
        ? OK
        : r.door === "task"
          ? // A row outside your projects does not exist for you — the
            // collaboration boundary, uniform with artifacts (§2.5: one of
            // the two refusals that must stay uninformative).
            no("not_found", "not_member", "")
          : no("forbidden", "membership_required", "");
    case "action": {
      const mode = effectiveActions(p.scope.autonomy)[r.action];
      if (mode !== "deny") return OK;
      return no(
        "forbidden",
        "autonomy_required",
        `autonomy.actions.${r.action} is deny for ${p.id} — the user raises it (PUT /api/agents/${p.id}/autonomy, or \`metistry agents autonomy ${p.id} --allow ${r.action}\`); nothing else can (docs/ops/actions.md)`,
        { autonomy: { action: r.action, mode: "propose" } },
      );
    }
    case "console":
      // Door B. `console_agent` is the uniform 403 an agent bearer gets on
      // everything outside /capture and /mcp; `console_management` is the
      // `isUser` gate, which excludes the capture owner token by name.
      if (r.door === "console_agent") {
        return p.role === "owner" || p.role === "tool" ? OK : no("forbidden", "role_required", "");
      }
      return p.role === "owner" ? OK : no("forbidden", "role_required", "");
  }
  // Unreachable while `Resource` is a closed union; kept so a new variant
  // fails CLOSED rather than falling through to a default allow.
  return no("forbidden", "role_required", "");
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
  const held = (p.uses ?? []).join(", ");
  return no(
    "forbidden",
    "not_in_uses",
    `${name} is not in this crew's toolset — ${p.id} holds ${held === "" ? "no tool groups" : held} (\`uses:\` in its manifest, a protected path in the user's hand: docs/ops/crews.md). Report what you needed instead of retrying.`,
  );
}

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

    case "knowledge_search":
      // `fail("forbidden", undefined, { tier })` — silent, the tier rides in
      // the audit row.
      return tier === "none" ? no("forbidden", "tier_required", "") : OK;
    case "knowledge_read":
      // Weaker than the `read` door below, which also judges the PATH; tier
      // `none` can never get past either, and both answer with silence.
      return tier === "none" ? no("forbidden", "tier_required", "") : OK;
    case "knowledge_list":
      return tier === "none" ? no("forbidden", "tier_required", NOT_GRANTED) : OK;
    case "knowledge_grep":
      // Content, like `knowledge_read` — tier `index` browses titles and may
      // not grep them.
      return tier !== "areas" ? no("forbidden", "tier_required", NOT_GRANTED) : OK;

    case "knowledge_write":
      // §4.11: one writer. Silent — the tool's DESCRIPTION carries the why.
      return p.role === "assistant" ? OK : no("forbidden", "role_required", "");
    case "agents_delegate":
      // A crew never dispatches crews; the assistant decides what leaves the
      // brain. Named in the tool's description ("Instance assistant only").
      return p.role === "assistant" ? OK : no("forbidden", "role_required", NOT_GRANTED);

    case "queries_list":
    case "queries_run":
      // Internal principals always; others only with an explicit `queries`
      // grant. Silent today.
      return p.role === "assistant" || queries ? OK : no("forbidden", "queries_required", "");

    case "propose_action":
      // Lazy by credential: nothing to offer, nothing listed. The door uses
      // `.ok` to decide whether to REGISTER, so this refusal is never
      // rendered — an agent given no room does not learn the tool exists.
      return admitsAnyAction(p.scope.autonomy) ? OK : no("forbidden", "autonomy_required", "");

    default:
      // An unknown name fails closed. The enumeration test walks TOOL_NAMES,
      // so a tool added without a rule here is a test failure.
      return no("forbidden", "role_required", "");
  }
}

function mayKnowledge(p: Principal, door: KnowledgeDoor, path: string, settled: boolean): Decision {
  const { scope } = p;
  const askable = (): Refusal => {
    const sr = scopeRequired(path);
    return no("forbidden", "scope_required", sr.message, { grant: { tier: "areas", area: areaOf(path) } }, sr.expose);
  };
  /** A path refused under a grant that could cover it vs. a tier that never could. Same answer on the wire; the reason says which. */
  const missed: Reason = scope.tier === "areas" ? "scope_required" : "tier_required";

  switch (door) {
    case "read":
      if (scope.tier !== "areas") {
        // Ruled 2026-09-19 B: a caller who may already see the TITLE of a
        // page that is really there is told WHICH grant would unlock it.
        if (settled && mayListPath(scope, path)) return askable();
        return no("forbidden", "tier_required", "");
      }
      if (!validKnowledgePath(path)) return no("invalid_request", "not_knowledge", NOT_A_VAULT_PATH);
      return canSeeUnder(path, scope.areas) ? OK : no("forbidden", "scope_required", "");

    case "links":
      if (mayReadPath(scope, path)) return OK;
      // A page's edges are content, so the read rule applies — with the same
      // scope_required upgrade for a page whose title is already visible.
      if (settled && mayListPath(scope, path)) return askable();
      return no("forbidden", missed, NOT_GRANTED);

    case "list":
      // The PREFIX argument. An omitted one aggregates over the grant and is
      // never refused; tier `index` has no prefix restriction at all (it
      // browses every title). Tier `none` is refused at the tool.
      if (path === "" || scope.tier !== "areas") return OK;
      return canSeeUnder(path, scope.areas) ? OK : no("forbidden", "scope_required", NOT_GRANTED);

    case "grep":
      if (scope.tier !== "areas") return no("forbidden", "tier_required", NOT_GRANTED);
      if (path === "") return OK;
      return canSeeUnder(path, scope.areas) ? OK : no("forbidden", "scope_required", NOT_GRANTED);

    case "write":
      // Writes never exceed reads. Silent, like the role gate above it — and
      // `underAreas` rather than `canSeeUnder` because the door has already
      // refused a non-vault path with `invalid_request` by this point.
      if (p.role !== "assistant") return no("forbidden", "role_required", "");
      if (scope.tier !== "areas") return no("forbidden", "scope_required", "");
      return scope.areas === null || underAreas(path, scope.areas) ? OK : no("forbidden", "scope_required", "");

    case "resources":
      // MCP resources/list. The door renders this as an EMPTY LIST, not as a
      // refusal — only `.ok` is read — because a resource collection that is
      // empty for you is the honest answer and a 403 on a listing is not.
      return scope.tier === "areas" ? OK : no("forbidden", "tier_required", "");

    case "console_page":
      // Door D. Refused and NOT FOUND are the same answer on purpose: a path
      // outside the scope must not be distinguishable from a path that is
      // not there. The one exception is the OWNER asking for their own
      // `Artifacts/` — there is no oracle to protect from the person whose
      // vault it is, and "not knowledge, here is the door that has it" is a
      // better answer than "no such page".
      if (canSeeUnder(path, readableAreas(scope))) return OK;
      if (scope.areas === null && (path === ARTIFACTS_ROOT || path.startsWith(`${ARTIFACTS_ROOT}/`))) {
        return no("not_found", "not_knowledge", ARTIFACTS_SIGNPOST);
      }
      return no("not_found", validKnowledgePath(path) ? missed : "not_knowledge", NOT_KNOWLEDGE);
  }
}

function mayQuery(p: Principal, door: QueryDoor, name: string, exposure: "generic" | "route"): Decision {
  if (exposure === "generic") return OK;
  // A query marked `expose: route` is served by an endpoint that does
  // something the generic door cannot — `knowledge_pages` filters every row
  // through the caller's scope — so answering it here would be that filter
  // undone. The refusal is the UNKNOWN-QUERY refusal, byte for byte, so
  // neither door is an oracle for which route-only queries exist.
  return door === "queries_run" ? no("not_found", "not_exposed", `no such query: ${name}`) : no("not_found", "not_exposed", "");
}
