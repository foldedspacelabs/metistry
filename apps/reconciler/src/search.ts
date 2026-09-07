// `GET /vault/search` in three modes (Phase 6). Keyword has been serving
// recall since Phase 2 and does not go away — semantic is added beside it,
// and the default fuses the two.
//
// - `keyword`  — case-insensitive substring over the working tree (vault.ts).
// - `semantic` — cosine over `embeddings` (pgvector `<=>`), joined to
//   `knowledge_files` so drafts and conflict copies are excluded in SQL.
// - `hybrid`   — reciprocal-rank fusion of both lists. The default whenever
//   vectors exist for the configured model; otherwise the default is
//   `keyword`, and an explicit `semantic`/`hybrid` degrades to keyword
//   rather than failing (the answer is worse, never absent).
//
// Fusion is RRF because the two scores are not comparable: a substring hit
// has no magnitude and a cosine similarity is not a probability. Rank is the
// only thing both lists honestly have.

import { EmbedUnavailableError, vectorLiteral, type EmbedClient } from "@foldedspacelabs/metistry-core";
import type { Db } from "./indexer.js";
import type { Embeddings } from "./embeddings.js";
import type { Vault } from "./vault.js";

export const SEARCH_MODES = ["keyword", "semantic", "hybrid"] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];

export function parseMode(raw: string | null): SearchMode | null | undefined {
  if (raw === null || raw === "") return null; // "choose for me"
  return (SEARCH_MODES as readonly string[]).includes(raw) ? (raw as SearchMode) : undefined; // undefined = invalid
}

export interface SearchHit {
  path: string;
  title: string;
  description: string | null;
  snippet: string;
  /** Rank score in the mode that produced it: RRF (hybrid), cosine similarity (semantic), rank decay (keyword). */
  score: number;
  /** Which list(s) the hit came from — the honest provenance of a fused result. */
  source: "keyword" | "semantic" | "both";
}

export interface SearchResult {
  q: string;
  /** The mode actually used, which is not always the one asked for. */
  mode: SearchMode;
  hits: SearchHit[];
  /** Set when the requested mode could not be served (no vectors, embedder down). */
  degraded?: string;
}

export interface SearchDeps {
  vault: Vault;
  db?: Db | undefined;
  embeddings?: Embeddings | undefined;
  client?: EmbedClient | undefined;
}

/** RRF's smoothing constant: the standard 60, which flattens the top few ranks. */
const RRF_K = 60;
/** Each list contributes this multiple of `limit` before fusion. */
const POOL = 4;

export async function searchVault(deps: SearchDeps, q: string, limit: number, requested: SearchMode | null): Promise<SearchResult> {
  const semanticReady = !!(deps.db && deps.embeddings && deps.client && (await deps.embeddings.hasVectors()));
  const mode: SearchMode = requested ?? (semanticReady ? "hybrid" : "keyword");
  const pool = Math.min(100, Math.max(limit, limit * POOL));

  if (mode === "keyword") return { q, mode, hits: rankKeyword(await keyword(deps, q, limit)) };

  if (!semanticReady) {
    return {
      q,
      mode: "keyword",
      hits: rankKeyword(await keyword(deps, q, limit)),
      degraded: `no embeddings stored for model ${deps.client?.model ?? "(unconfigured)"} — served keyword; run POST /embeddings/rebuild`,
    };
  }

  let sem: SearchHit[];
  try {
    sem = await semantic(deps, q, pool);
  } catch (err) {
    if (!(err instanceof EmbedUnavailableError)) throw err;
    return { q, mode: "keyword", hits: rankKeyword(await keyword(deps, q, limit)), degraded: `embedder unavailable (${err.message}) — served keyword` };
  }

  if (mode === "semantic") return { q, mode, hits: sem.slice(0, limit) };
  return { q, mode: "hybrid", hits: fuse(rankKeyword(await keyword(deps, q, pool)), sem).slice(0, limit) };
}

async function keyword(deps: SearchDeps, q: string, limit: number): Promise<Array<Omit<SearchHit, "score" | "source">>> {
  return deps.vault.search(q, limit);
}

/** Keyword has no magnitude, only order: a decaying score keeps the shape honest. */
function rankKeyword(hits: Array<Omit<SearchHit, "score" | "source">>): SearchHit[] {
  return hits.map((h, i) => ({ ...h, score: round(1 / (1 + i)), source: "keyword" as const }));
}

async function semantic(deps: SearchDeps, q: string, limit: number): Promise<SearchHit[]> {
  const vector = vectorLiteral(await deps.client!.embedOne(q));
  // One row per note: the best-matching chunk speaks for it. `<=>` is cosine
  // distance, so similarity is 1 - distance.
  const { rows } = await deps.db!.query(
    `SELECT DISTINCT ON (e.path) e.path,
            COALESCE(k.title, regexp_replace(e.path, '^.*/|\\.md$', '', 'g')) AS title,
            k.description,
            e.content,
            1 - (e.embedding <=> $1::vector) AS score
       FROM embeddings e
       JOIN knowledge_files k ON k.path = e.path
      WHERE e.model = $2 AND NOT k.draft AND k.status <> 'conflict'
      ORDER BY e.path, e.embedding <=> $1::vector
      LIMIT $3`,
    [vector, deps.client!.model, limit * 4],
  );
  return rows
    .map((r) => ({
      path: String(r.path),
      title: String(r.title),
      description: (r.description as string | null) ?? null,
      snippet: snippetOf(String(r.content)),
      score: round(Number(r.score)),
      source: "semantic" as const,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** Reciprocal-rank fusion: Σ 1/(k + rank), rank 1-based, over both lists. */
function fuse(kw: SearchHit[], sem: SearchHit[]): SearchHit[] {
  const acc = new Map<string, SearchHit>();
  const add = (hits: SearchHit[]) => {
    hits.forEach((h, i) => {
      const contribution = 1 / (RRF_K + i + 1);
      const prev = acc.get(h.path);
      if (!prev) {
        acc.set(h.path, { ...h, score: contribution });
        return;
      }
      // a hit both lists found keeps the richer snippet (semantic carries the chunk)
      acc.set(h.path, {
        ...prev,
        snippet: prev.source === "keyword" && h.source === "semantic" ? prev.snippet : h.snippet || prev.snippet,
        score: prev.score + contribution,
        source: prev.source === h.source ? prev.source : "both",
      });
    });
  };
  add(kw);
  add(sem);
  return [...acc.values()].map((h) => ({ ...h, score: round(h.score) })).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}

function snippetOf(content: string): string {
  return content.replace(/\s+/g, " ").trim().slice(0, 300);
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
