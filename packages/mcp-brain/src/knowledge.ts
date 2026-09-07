// Knowledge under grants (§4.11): tier `none` sees nothing and is told
// "not granted" (never "not found" — absence of permission must not look
// like absence of knowledge); `index` sees titles + one-line descriptions;
// `areas` reads settled notes under its granted Knowledge/ prefixes. Draft
// notes are excluded at every tier by a WHERE clause the tool cannot skip.
//
// The index lives in `knowledge_files` (reconciler-owned). Note CONTENT has
// no read path inside the container until the Phase 6 knowledge module
// lands, so `knowledge_read` degrades to `not_available` unless the host
// injects a reader — no vault mount is invented here.

import type { ErrorCode } from "@foldedspacelabs/metistry-core";
import type { AgentPrincipal, Db } from "./types.js";

export interface KnowledgeHit {
  path: string;
  title: string;
  description: string | null;
}

export type KnowledgeReader = (path: string) => Promise<string | null>;

export type ReadOutcome =
  | { ok: true; path: string; title: string; content: string }
  | { ok: false; code: ErrorCode; message?: string };

// A vault path an agent may name: Knowledge/ plus segments, no traversal,
// no leading slash. Mirrors the grant shape the console validates.
const PATH_RE = /^Knowledge(\/[^/\0]+)+$/;

export function validKnowledgePath(path: string): boolean {
  return path.length <= 500 && PATH_RE.test(path) && !path.split("/").some((seg) => seg === "." || seg === "..");
}

/**
 * Prefix semantics of a grant: the area itself or anything below it. A
 * trailing slash names a directory as a whole — `Knowledge/` is the bare
 * vault grant the console admits for internal principals only.
 */
export function underAreas(path: string, areas: readonly string[]): boolean {
  return areas.some((raw) => {
    const a = raw.endsWith("/") ? raw.slice(0, -1) : raw;
    return path === a || path.startsWith(`${a}/`);
  });
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, "\\$&");
}

/**
 * Titles + descriptions matching `query`, never drafts. Tier `areas` is
 * scoped to its prefixes (an area grant does not imply a global index —
 * titles can be sensitive); tier `index` sees every settled title.
 * The caller has already refused tier `none`.
 */
export async function searchKnowledge(db: Db, principal: AgentPrincipal, query: string, limit: number): Promise<KnowledgeHit[]> {
  const areas = principal.grants.tier === "areas" ? principal.grants.areas : null;
  const { rows } = await db.query(
    `SELECT path, COALESCE(title, regexp_replace(path, '^.*/|\\.md$', '', 'g')) AS title, description
     FROM knowledge_files
     WHERE NOT draft
       AND (path ILIKE $1 ESCAPE '\\' OR title ILIKE $1 ESCAPE '\\' OR description ILIKE $1 ESCAPE '\\')
       AND ($2::text[] IS NULL OR EXISTS (
             SELECT 1 FROM unnest($2::text[]) AS a(raw), LATERAL (SELECT rtrim(a.raw, '/') AS prefix) p
             WHERE path = p.prefix OR left(path, length(p.prefix) + 1) = p.prefix || '/'))
     ORDER BY path
     LIMIT $3`,
    [`%${escapeLike(query)}%`, areas, limit],
  );
  return rows.map((r) => ({ path: String(r.path), title: String(r.title), description: (r.description as string | null) ?? null }));
}

/** Full read of one settled note under a granted prefix. */
export async function readKnowledge(db: Db, principal: AgentPrincipal, path: string, reader: KnowledgeReader | undefined): Promise<ReadOutcome> {
  if (principal.grants.tier !== "areas") return { ok: false, code: "forbidden" };
  if (!validKnowledgePath(path)) return { ok: false, code: "invalid_request", message: "path must be Knowledge/... with no traversal" };
  if (!underAreas(path, principal.grants.areas)) return { ok: false, code: "forbidden" };
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
