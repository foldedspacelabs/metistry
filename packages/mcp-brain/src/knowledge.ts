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

import { EmbedUnavailableError, isVaultPath, vectorLiteral, type ErrorCode } from "@foldedspacelabs/metistry-core";
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
  | { ok: false; code: ErrorCode; message?: string };

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
 * The one filtering decision every knowledge_* surface (search, read, list,
 * grep, resources) derives from, so tier logic can never drift between
 * them. `prefixes` is what a caller passes into `areaFilter`/a vault-bridge
 * call (null = tier `index`'s unrestricted browse); `canRead` is the single
 * "may this principal see this path's CONTENT" test — the same one that
 * gates knowledge_read/knowledge_grep/resources, and doubles as the check
 * for a caller-supplied prefix argument (a prefix is just a path).
 */
export interface KnowledgeScope {
  readonly tier: Tier;
  readonly prefixes: readonly string[] | null;
  /** Tier `index`: paths/titles only, never content. */
  readonly visibleTitlesOnly: boolean;
  /** Always true — drafts are invisible at every tier; named so a misuse test can assert it is never bypassed. */
  readonly excludeDrafts: true;
  canRead(path: string): boolean;
}

export function knowledgeScope(principal: AgentPrincipal): KnowledgeScope {
  const { tier, areas } = principal.grants;
  return {
    tier,
    prefixes: tier === "areas" ? areas : null,
    visibleTitlesOnly: tier === "index",
    excludeDrafts: true,
    canRead: (path) => tier === "areas" && underAreas(path, areas),
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
  if (scope.tier !== "areas") return { ok: false, code: "forbidden" };
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
