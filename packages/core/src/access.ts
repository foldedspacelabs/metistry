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
