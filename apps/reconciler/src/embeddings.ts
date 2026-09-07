// Embedding the vault (Phase 6, §6 decision 8). The reconciler already owns
// the index (§4.13) — it holds the only working tree and the only content
// hashes — so it owns the vectors too. Nothing else writes `embeddings`.
//
// Three properties this file exists to guarantee:
//
// 1. **It degrades.** Ollama down is not an outage. The reconcile cycle
//    finishes, the index is correct, `check()` says `degraded` with the
//    remediation, and the vectors catch up on a later cycle.
// 2. **It self-heals.** A note is behind when its `embedded_hash` is not its
//    current `content_hash`, or its `embedded_model` is not the configured
//    model. A cycle interrupted halfway leaves the marker unset, so the next
//    cycle retries exactly that note — no full rebuild, no silent half-index.
// 3. **It is deterministic.** Same content + same model → same chunks, same
//    content hashes, same rows. `rebuild()` is therefore a no-op on content
//    that has not changed, and a full re-embed after a model change.

import { EmbedUnavailableError, chunkMarkdown, vectorLiteral, type Chunk, type EmbedClient } from "@foldedspacelabs/metistry-core";
import type { Db } from "./indexer.js";
import { isMarkdown, parseFrontmatter, sha256 } from "./notes.js";

/** Reads a vault-relative path's raw bytes as text; null when it is gone. */
export type NoteReader = (path: string) => Promise<string | null>;

export interface EmbeddingsConfig {
  /** Notes embedded per cycle. The rest wait for the next one (self-healing makes that safe). */
  maxFilesPerCycle?: number | undefined;
  targetChars?: number | undefined;
  overlapChars?: number | undefined;
}

export interface EmbedSummary {
  /** Notes whose vectors were brought up to date this cycle. */
  files: number;
  /** Chunk vectors written (embedded, then upserted). */
  chunks: number;
  /** Chunks whose stored content hash already matched — not re-embedded. */
  reused: number;
  /** Rows deleted: removed notes, and chunks a shortened note no longer has. */
  deleted: number;
  /** Notes still behind when the cycle ended (cap reached, or the embedder went away). */
  pending: number;
  /** Why embedding stopped, if it did. Null on a clean cycle. */
  degraded: string | null;
}

export const EMPTY_SUMMARY: EmbedSummary = { files: 0, chunks: 0, reused: 0, deleted: 0, pending: 0, degraded: null };

export interface EmbedStatus {
  model: string;
  dim: number;
  /** Rows stored for the configured model. */
  rows: number;
  /** Notes whose vectors are behind the vault right now. */
  behind: number;
  /** Distinct (model, dim) actually stored, whatever the configuration says. */
  stored: Array<{ model: string; dim: number; rows: number }>;
  /** True when rows exist for some other model/dim — decision 8's rebuild. */
  rebuild_required: boolean;
  /** Last cycle's outcome, for `check()`. */
  last: EmbedSummary | null;
  degraded: string | null;
}

// Settled markdown under Knowledge/: drafts and conflict copies are excluded
// in SQL, not after, so no caller can forget.
const BEHIND_SQL = `
  SELECT path FROM knowledge_files
  WHERE NOT draft AND status <> 'conflict' AND path ILIKE 'Knowledge/%.md'
    AND (embedded_model IS DISTINCT FROM $1 OR embedded_hash IS DISTINCT FROM content_hash)
  ORDER BY path`;

// Vectors exist only for notes the index still serves. One sweep covers
// deletions, notes that turned into drafts, and conflict copies.
const ORPHAN_SQL = `
  DELETE FROM embeddings e
  WHERE NOT EXISTS (SELECT 1 FROM knowledge_files k WHERE k.path = e.path AND NOT k.draft AND k.status <> 'conflict')`;

export class Embeddings {
  public last: EmbedSummary | null = null;
  private degraded: string | null = null;
  private readonly maxFiles: number;

  constructor(
    private readonly db: Db,
    private readonly client: EmbedClient,
    private readonly read: NoteReader,
    private readonly cfg: EmbeddingsConfig = {},
  ) {
    this.maxFiles = Math.max(1, cfg.maxFilesPerCycle ?? 200);
  }

  get model(): string {
    return this.client.model;
  }

  /** Chunk a note exactly the way the stored rows were chunked. */
  private chunk(text: string): Chunk[] {
    return chunkMarkdown(text, { targetChars: this.cfg.targetChars, overlapChars: this.cfg.overlapChars });
  }

  /** Bring every behind note up to date, up to the per-cycle cap. */
  async sync(limit = this.maxFiles): Promise<EmbedSummary> {
    const orphans = await this.db.query(ORPHAN_SQL);
    const { rows } = await this.db.query(BEHIND_SQL, [this.client.model]);
    const behind = rows.map((r) => String(r.path));
    const summary: EmbedSummary = { ...EMPTY_SUMMARY, deleted: rowCount(orphans), pending: behind.length };
    const take = behind.slice(0, limit);
    for (const path of take) {
      try {
        const one = await this.embedNote(path);
        summary.files += one.files;
        summary.chunks += one.chunks;
        summary.reused += one.reused;
        summary.deleted += one.deleted;
        summary.pending -= 1;
      } catch (err) {
        if (!(err instanceof EmbedUnavailableError)) throw err;
        summary.degraded = err.message;
        break;
      }
    }
    this.degraded = summary.degraded;
    this.last = summary;
    return summary;
  }

  /**
   * Decision 8's deterministic rebuild: forget every vector for every model,
   * then embed the vault again from the working tree. Content that has not
   * changed produces byte-identical chunks and content hashes.
   */
  async rebuild(): Promise<EmbedSummary> {
    const del = await this.db.query(`DELETE FROM embeddings`);
    await this.db.query(`UPDATE knowledge_files SET embedded_hash = NULL, embedded_model = NULL`);
    const s = await this.sync(Number.MAX_SAFE_INTEGER); // explicit and synchronous: no per-cycle cap
    return { ...s, deleted: s.deleted + rowCount(del) };
  }

  /** A renamed note keeps its vectors: re-key, never re-embed (the content is identical). */
  async rekey(from: string, to: string): Promise<void> {
    await this.db.query(`DELETE FROM embeddings WHERE path = $1`, [to]);
    await this.db.query(`UPDATE embeddings SET path = $2 WHERE path = $1`, [from, to]);
  }

  /** A note left the vault (deleted, or became a draft): its vectors go with it. */
  async remove(paths: readonly string[]): Promise<number> {
    if (!paths.length) return 0;
    const r = await this.db.query(`DELETE FROM embeddings WHERE path = ANY($1::text[])`, [paths]);
    return rowCount(r);
  }

  async status(): Promise<EmbedStatus> {
    const [{ rows: stored }, { rows: behind }] = await Promise.all([
      this.db.query(`SELECT model, dim, count(*)::int AS rows FROM embeddings GROUP BY model, dim ORDER BY model`),
      this.db.query(`SELECT count(*)::int AS n FROM (${BEHIND_SQL}) q`, [this.client.model]),
    ]);
    const parsed = stored.map((r) => ({ model: String(r.model), dim: Number(r.dim), rows: Number(r.rows) }));
    const mine = parsed.find((s) => s.model === this.client.model && s.dim === this.client.dim);
    return {
      model: this.client.model,
      dim: this.client.dim,
      rows: mine?.rows ?? 0,
      behind: Number(behind[0]?.n ?? 0),
      stored: parsed,
      rebuild_required: parsed.some((s) => s.model !== this.client.model || s.dim !== this.client.dim),
      last: this.last,
      degraded: this.degraded,
    };
  }

  /** True once at least one vector exists for the configured model. */
  async hasVectors(): Promise<boolean> {
    const { rows } = await this.db.query(`SELECT 1 FROM embeddings WHERE model = $1 LIMIT 1`, [this.client.model]);
    return rows.length > 0;
  }

  private async embedNote(path: string): Promise<{ files: number; chunks: number; reused: number; deleted: number }> {
    const raw = isMarkdown(path) ? await this.read(path) : null;
    if (raw === null) {
      // vanished between the scan and now, or unreadable: drop stale rows and stop tracking it
      return { files: 0, chunks: 0, reused: 0, deleted: await this.remove([path]) };
    }
    const { meta, body } = parseFrontmatter(raw);
    const chunks = meta.draft ? [] : this.chunk(body);
    const model = this.client.model;

    const { rows: existing } = await this.db.query(`SELECT chunk_index, content_hash FROM embeddings WHERE path = $1 AND model = $2`, [path, model]);
    const have = new Map<number, string>(existing.map((r) => [Number(r.chunk_index), String(r.content_hash)]));

    const todo: Chunk[] = [];
    let reused = 0;
    for (const c of chunks) {
      if (have.get(c.index) === sha256(c.text)) reused++;
      else todo.push(c);
    }

    let written = 0;
    for (let i = 0; i < todo.length; i += this.client.batch) {
      const slice = todo.slice(i, i + this.client.batch);
      const vectors = await this.client.embed(slice.map((c) => c.text));
      for (const [j, c] of slice.entries()) {
        await this.db.query(
          `INSERT INTO embeddings (path, chunk_index, content, model, dim, embedding, content_hash)
           VALUES ($1, $2, $3, $4, $5, $6::vector, $7)
           ON CONFLICT (path, chunk_index, model) DO UPDATE
             SET content = EXCLUDED.content, dim = EXCLUDED.dim, embedding = EXCLUDED.embedding,
                 content_hash = EXCLUDED.content_hash, created_at = now()`,
          [path, c.index, c.text, model, this.client.dim, vectorLiteral(vectors[j]!), sha256(c.text)],
        );
        written++;
      }
    }

    // a shortened (or now-draft) note leaves orphan chunks behind
    const pruned = await this.db.query(`DELETE FROM embeddings WHERE path = $1 AND chunk_index >= $2`, [path, chunks.length]);

    // only now is the note's marker current: an interrupted note is retried next cycle
    await this.db.query(`UPDATE knowledge_files SET embedded_hash = content_hash, embedded_model = $2 WHERE path = $1`, [path, model]);
    return { files: 1, chunks: written, reused, deleted: rowCount(pruned) };
  }
}

function rowCount(r: { rowCount?: number | null }): number {
  return typeof r.rowCount === "number" ? r.rowCount : 0;
}
