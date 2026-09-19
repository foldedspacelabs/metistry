// Knowledge under grants (§4.11): tier `none` sees nothing and is told
// "not granted" (never "not found" — absence of permission must not look
// like absence of knowledge); `index` sees titles + one-line descriptions;
// `areas` reads settled notes under its granted vault prefixes. Draft
// notes are excluded at every tier by a WHERE clause the tool cannot skip.
//
// The index lives in `knowledge_files` (reconciler-owned). Note CONTENT has
// no read path inside the container until the Phase 6 knowledge module
// lands, so `knowledge_read` degrades to `not_available` unless the host
// injects a reader — no vault mount is invented here.

import { EmbedUnavailableError, isVaultPath, vectorLiteral, VAULT_ROOT_AREA, type ErrorCode } from "@foldedspacelabs/metistry-core";
import type { AgentPrincipal, Db, Tier } from "./types.js";

export interface KnowledgeHit {
  path: string;
  title: string;
  description: string | null;
  /** Rank score in the mode that produced it: RRF (hybrid), cosine similarity (semantic), rank decay (keyword). */
  score: number;
}

export const KNOWLEDGE_MODES = ["keyword", "semantic", "hybrid"] as const;
export type KnowledgeMode = (typeof KNOWLEDGE_MODES)[number];

/** Anything that can embed one query with a named model — core's EmbedClient fits. */
export interface QueryEmbedder {
  readonly model: string;
  embedOne(text: string): Promise<number[]>;
}

export interface KnowledgeSearchResult {
  /** The mode actually served, which is not always the one asked for. */
  mode: KnowledgeMode;
  hits: KnowledgeHit[];
  /** Set when the requested mode could not be served (no embedder, no vectors, embedder down). */
  degraded?: string;
}

export type KnowledgeReader = (path: string) => Promise<string | null>;

export type ReadOutcome =
  | { ok: true; path: string; title: string; content: string }
  | { ok: false; code: ErrorCode; message?: string; expose?: Record<string, unknown> };

/**
 * A vault path an agent may name. Since the 2026-09-17 layout the vault root
 * IS the instance directory, so there is no prefix to anchor on — the rule is
 * core's `isVaultPath`: no traversal, no leading slash, nothing inside a
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
 * the console's routes, and it is tier `index` here when the question is a
 * TITLE rather than content (ruled 2026-09-19: an agent discovers what
 * knowledge exists so it can ask for the area that holds it). It is never
 * tier `none`, which is refused before this is reached: the caller decides
 * the TIER, this decides the PATH, and keeping those two apart is what lets
 * one function serve a console route and an MCP tool.
 *
 * It lives here, beside `underAreas`, because that is the prefix rule and
 * `isVaultPath` is core's — `apps/console/src/knowledge-routes.ts`'s `canSee`
 * calls straight through to it, so the console's four doors and this bridge's
 * tools are ONE implementation rather than two that agree today. The
 * dependency arrow is unchanged: apps → packages, never the reverse.
 */
export function canSeeUnder(path: string, areas: readonly string[] | null): boolean {
  if (!validKnowledgePath(path)) return false;
  return areas === null || underAreas(path, areas);
}

/**
 * The one filtering decision every knowledge_* surface (search, read, list,
 * grep, resources) derives from, so tier logic can never drift between
 * them. `prefixes` is what a caller passes into `areaFilter`/a vault-bridge
 * call (null = tier `index`'s unrestricted browse); `canRead` is the single
 * "may this principal see this path's CONTENT" test — the same one that
 * gates knowledge_read/knowledge_grep/resources, and doubles as the check
 * for a caller-supplied prefix argument (a prefix is just a path).
 *
 * `canList` is the same question asked about a TITLE, and it is deliberately
 * wider: tier `index` may see that a page exists — path, title, one-line
 * description — anywhere in the vault index, and may read none of them. Tier
 * `areas` lists exactly what it may read, because a grant of an area is
 * already the answer to "may I know this is here". Tier `none` is false for
 * both: it is not a narrower grant, it is no grant.
 */
export interface KnowledgeScope {
  readonly tier: Tier;
  readonly prefixes: readonly string[] | null;
  /** Tier `index`: paths/titles only, never content. */
  readonly visibleTitlesOnly: boolean;
  /** Always true — drafts are invisible at every tier; named so a misuse test can assert it is never bypassed. */
  readonly excludeDrafts: true;
  canRead(path: string): boolean;
  /** May this principal be told this path EXISTS (path + title + description, never content)? */
  canList(path: string): boolean;
}

export function knowledgeScope(principal: AgentPrincipal): KnowledgeScope {
  const { tier, areas } = principal.grants;
  return {
    tier,
    prefixes: tier === "areas" ? areas : null,
    visibleTitlesOnly: tier === "index",
    excludeDrafts: true,
    canRead: (path) => tier === "areas" && canSeeUnder(path, areas),
    canList: (path) => tier !== "none" && canSeeUnder(path, tier === "areas" ? areas : null),
  };
}

/**
 * Owner ruling 2026-09-19 (judgement call B on PR #216): a caller who may
 * see a page's TITLE (`canList`) but not its CONTENT (`canRead`) is told
 * WHICH grant would unlock it, rather than the uniform "not granted" — it
 * already knows the page is there, so naming the area is not a new leak.
 * `SCOPE_REQUIRED` is that refusal's stable machine-readable half, carried
 * in `Outcome.expose.reason` (never `error.code`, which stays the ordinary
 * `forbidden` every other refusal on this surface uses — invariant 8's
 * envelope is unchanged, this is additive).
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
 * Whether `path` names a settled (non-draft) row in the index — the same
 * existence tier `index` can already see through knowledge_search/
 * knowledge_list. `scopeRequired` below gates on this so the refusal is
 * only ever built for a page an agent could already find: a path it merely
 * guessed the shape of gets no area name, no different from today — nothing
 * about existence leaks for a path that is not real (or is a draft, which
 * is invisible at every tier).
 */
export async function isSettledPage(db: Db, path: string): Promise<boolean> {
  const { rows } = await db.query(`SELECT 1 FROM knowledge_files WHERE path = $1 AND NOT draft`, [path]);
  return rows.length > 0;
}

/**
 * The scope_required refusal, built once so knowledge_read (below) and
 * knowledge_list's `links_for` (knowledge-fs.ts's `listLinks`) say the
 * identical thing for the identical reason. `message` replaces the bare
 * "not granted" string; `expose` is what server.ts's `render` merges onto
 * the wire envelope alongside `error` (Outcome's `expose`, never `meta`,
 * which is audit-only). The mechanism it names is the only one that exists
 * today — there is no `request_access` tool — and it says where the ask
 * lands so the agent knows the owner, not it, decides.
 */
export function scopeRequired(path: string): { message: string; expose: { reason: string; grantedScope: string } } {
  const area = areaOf(path);
  return {
    message:
      `you can see that this page exists, but reading it needs the \`${area}\` grant — ` +
      `ask the owner to widen it: raise a \`requests_create\` report naming \`${area}\` and why; they approve it in Needs You.`,
    expose: { reason: SCOPE_REQUIRED, grantedScope: area },
  };
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, "\\$&");
}

// The grant filter, once, as a SQL fragment — keyword and semantic both
// interpolate it against their own alias so the two paths cannot drift.
// `$n` is the areas array; NULL means "no prefix restriction" (tier index).
// Exported for knowledge-fs.ts's knowledge_list/knowledge_grep, which need
// the identical filter over `knowledge_files` for their own queries.
export const areaFilter = (col: string, n: number) =>
  `($${n}::text[] IS NULL OR EXISTS (
      SELECT 1 FROM unnest($${n}::text[]) AS a(raw), LATERAL (SELECT rtrim(a.raw, '/') AS prefix) p
      WHERE p.prefix = '' OR ${col} = p.prefix OR left(${col}, length(p.prefix) + 1) = p.prefix || '/'))`;

/** Frontmatter title, else the basename. `t` is the table alias (empty for none). Exported for knowledge-fs.ts. */
export const titleSql = (t = "") => `COALESCE(${t}title, regexp_replace(${t}path, '^.*/|\\.md$', '', 'g'))`;

/** RRF's smoothing constant (the standard 60) and the pool each list contributes. */
const RRF_K = 60;
const POOL = 4;

/**
 * Titles + descriptions matching `query`, never drafts. Tier `areas` is
 * scoped to its prefixes (an area grant does not imply a global index —
 * titles can be sensitive); tier `index` sees every settled title. Both
 * restrictions are WHERE clauses, in every mode — nothing is filtered after
 * the fact, so a semantic ranking can never surface a path the grant
 * excludes. The caller has already refused tier `none`.
 *
 * `semantic`/`hybrid` (Phase 6) change the RANKING, not what is returned:
 * an `index` grant still sees titles and one-line descriptions only, never
 * the chunk text that produced the match.
 */
export async function searchKnowledge(
  db: Db,
  principal: AgentPrincipal,
  query: string,
  limit: number,
  opts: { mode?: KnowledgeMode | null | undefined; embedder?: QueryEmbedder | undefined } = {},
): Promise<KnowledgeSearchResult> {
  const areas = knowledgeScope(principal).prefixes;
  const embedder = opts.embedder;
  const requested = opts.mode ?? null;

  if (requested === "keyword" || !embedder) {
    const hits = await keywordHits(db, query, areas, limit);
    if (requested && requested !== "keyword") return { mode: "keyword", hits, degraded: "no embedder configured for this deployment — served keyword" };
    return { mode: "keyword", hits };
  }

  const pool = Math.min(100, Math.max(limit, limit * POOL));
  let semantic: KnowledgeHit[];
  try {
    semantic = await semanticHits(db, embedder, query, areas, pool);
  } catch (err) {
    if (!(err instanceof EmbedUnavailableError)) throw err;
    return { mode: "keyword", hits: await keywordHits(db, query, areas, limit), degraded: `embedder unavailable (${err.message}) — served keyword` };
  }
  if (semantic.length === 0) {
    // Cosine ranks every row, so an empty list means there are no rows for
    // this model within the grant — not "no match". Answer in keyword.
    const hits = await keywordHits(db, query, areas, limit);
    return requested === null ? { mode: "keyword", hits } : { mode: "keyword", hits, degraded: `no embeddings stored for model ${embedder.model} within your grant — served keyword` };
  }
  if (requested === "semantic") return { mode: "semantic", hits: semantic.slice(0, limit) };
  return { mode: "hybrid", hits: fuse(await keywordHits(db, query, areas, pool), semantic).slice(0, limit) };
}

async function keywordHits(db: Db, query: string, areas: readonly string[] | null, limit: number): Promise<KnowledgeHit[]> {
  const { rows } = await db.query(
    `SELECT path, ${titleSql()} AS title, description
     FROM knowledge_files
     WHERE NOT draft
       AND (path ILIKE $1 ESCAPE '\\' OR title ILIKE $1 ESCAPE '\\' OR description ILIKE $1 ESCAPE '\\')
       AND ${areaFilter("path", 2)}
     ORDER BY path
     LIMIT $3`,
    [`%${escapeLike(query)}%`, areas, limit],
  );
  // keyword order is alphabetical, not relevance: the score is rank decay, and says so
  return rows.map((r, i) => ({ path: String(r.path), title: String(r.title), description: (r.description as string | null) ?? null, score: round(1 / (1 + i)) }));
}

async function semanticHits(db: Db, embedder: QueryEmbedder, query: string, areas: readonly string[] | null, limit: number): Promise<KnowledgeHit[]> {
  const vector = vectorLiteral(await embedder.embedOne(query));
  // best chunk per note; `<=>` is cosine distance, so similarity is 1 - distance
  const { rows } = await db.query(
    `SELECT DISTINCT ON (k.path) k.path, ${titleSql("k.")} AS title,
            k.description, 1 - (e.embedding <=> $1::vector) AS score
       FROM embeddings e
       JOIN knowledge_files k ON k.path = e.path
      WHERE NOT k.draft AND e.model = $2 AND ${areaFilter("k.path", 3)}
      ORDER BY k.path, e.embedding <=> $1::vector
      LIMIT $4`,
    [vector, embedder.model, areas, limit * 4],
  );
  return rows
    .map((r) => ({ path: String(r.path), title: String(r.title), description: (r.description as string | null) ?? null, score: round(Number(r.score)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** Reciprocal-rank fusion: Σ 1/(k + rank), rank 1-based, over both lists. */
function fuse(keyword: KnowledgeHit[], semantic: KnowledgeHit[]): KnowledgeHit[] {
  const acc = new Map<string, KnowledgeHit>();
  for (const list of [keyword, semantic]) {
    list.forEach((h, i) => {
      const contribution = 1 / (RRF_K + i + 1);
      const prev = acc.get(h.path);
      acc.set(h.path, prev ? { ...prev, score: prev.score + contribution } : { ...h, score: contribution });
    });
  }
  return [...acc.values()].map((h) => ({ ...h, score: round(h.score) })).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** Full read of one settled note under a granted prefix. */
export async function readKnowledge(db: Db, principal: AgentPrincipal, path: string, reader: KnowledgeReader | undefined): Promise<ReadOutcome> {
  const scope = knowledgeScope(principal);
  if (scope.tier !== "areas") {
    // Tier `index` (or a grant whose areas do not cover this path) may
    // already see the TITLE — `canList` — but never the content. Name the
    // area that would unlock it only for a page that is really there
    // (`isSettledPage`): a path merely shaped like a vault path gets the
    // same uniform refusal it always has, existence unconfirmed either way.
    if (scope.canList(path) && (await isSettledPage(db, path))) {
      const sr = scopeRequired(path);
      return { ok: false, code: "forbidden", message: sr.message, expose: sr.expose };
    }
    return { ok: false, code: "forbidden" };
  }
  if (!validKnowledgePath(path)) return { ok: false, code: "invalid_request", message: "path must be a vault path — TitleCase folders, no traversal, nothing under .metistry/ or Artifacts/" };
  if (!scope.canRead(path)) return { ok: false, code: "forbidden" };
  const { rows } = await db.query(`SELECT path, title, draft FROM knowledge_files WHERE path = $1`, [path]);
  const row = rows[0];
  if (!row || row.draft === true) return { ok: false, code: "not_found" }; // drafts are unsettled: invisible at every tier
  if (!reader) {
    return {
      ok: false,
      code: "not_available",
      message: "note contents are not readable from this deployment yet (the index is served; the vault read path arrives with the knowledge module)",
    };
  }
  const content = await reader(path);
  if (content === null) return { ok: false, code: "not_found" };
  const title = typeof row.title === "string" && row.title ? row.title : path.replace(/^.*\//, "").replace(/\.md$/, "");
  return { ok: true, path, title, content };
}
