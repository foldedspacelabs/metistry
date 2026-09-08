// The reconcile loop (§4.13): walk `Knowledge/`, hash CONTENT (sync churns
// mtime, so mtime decides nothing), upsert `knowledge_files` +
// `knowledge_links`, detect renames by hash, flag Obsidian/Syncthing
// conflict files exactly once as a `proposals` report, and record one
// `runs` row per cycle. Also the sweep that commits edits made outside the
// bridge (Obsidian on any device) as the `user` principal — the reconciler
// is the sole committer, so nobody else can (PoC-12).

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { finishRun, startRun, type RunExecutor } from "@foldedspacelabs/metistry-core";
import type { Committer } from "./committer.js";
import { EMPTY_SUMMARY, type Embeddings, type EmbedSummary } from "./embeddings.js";
import type { Vault } from "./vault.js";
import { basenameTitle, extractLinks, isConflictFile, isMarkdown, parseFrontmatter, resolveLink, sha256, type NoteLink, type NoteMeta } from "./notes.js";

export interface Db extends RunExecutor {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
}

export interface IndexerConfig {
  /** Commit working-tree changes under Knowledge/ that arrived outside the bridge (Obsidian sync). */
  commitExternalEdits: boolean;
}

export interface ReconcileSummary {
  run_id: number;
  files: number;
  added: number;
  changed: number;
  renamed: number;
  removed: number;
  conflicts: number; // conflict files present this cycle
  conflicts_new: number; // newly proposed this cycle
  links: number;
  external_edits: number; // paths swept into a `user` commit intent
  /** Phase 6: vectors brought up to date this cycle. Absent when no embedder is configured. */
  embeddings?: EmbedSummary;
  duration_ms: number;
}

interface Scanned {
  path: string;
  hash: string;
  mtime: Date;
  meta: NoteMeta;
  links: NoteLink[];
  conflict: boolean;
}

export class Indexer {
  private running: Promise<ReconcileSummary> | null = null;
  public last: ReconcileSummary | null = null;

  constructor(
    private readonly db: Db,
    private readonly vault: Vault,
    private readonly committer: Committer,
    private readonly cfg: IndexerConfig,
    /** Absent → the index is built, no vectors are (Phase 6 is optional at run time). */
    private readonly embeddings?: Embeddings | undefined,
  ) {}

  /** Coalesce: a reconcile requested while one runs joins it. */
  reconcile(trigger: string): Promise<ReconcileSummary> {
    if (this.running) return this.running;
    this.running = this.reconcileNow(trigger).finally(() => (this.running = null));
    return this.running;
  }

  private async reconcileNow(trigger: string): Promise<ReconcileSummary> {
    const started = Date.now();
    const runId = await startRun(this.db, { component: "reconciler", kind: "collector_run", meta: { trigger } });
    try {
      const summary = await this.cycle(runId, started);
      await finishRun(this.db, runId, { ok: true, meta: { ...summary } });
      this.last = summary;
      return summary;
    } catch (err) {
      await finishRun(this.db, runId, { ok: false, error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }

  private async cycle(runId: number, started: number): Promise<ReconcileSummary> {
    const paths = await this.vault.walkKnowledge();
    const scanned = new Map<string, Scanned>();
    for (const p of paths) {
      const abs = join(this.vault.root, p);
      const bytes = await readFile(abs);
      const st = await stat(abs);
      const conflict = isConflictFile(p);
      let meta: NoteMeta = { title: null, description: null, draft: false };
      let links: NoteLink[] = [];
      if (isMarkdown(p) && !conflict) {
        const parsed = parseFrontmatter(bytes.toString("utf8"));
        meta = parsed.meta;
        links = extractLinks(parsed.body);
      }
      scanned.set(p, { path: p, hash: sha256(bytes), mtime: st.mtime, meta, links, conflict });
    }

    const { rows } = await this.db.query(`SELECT path, content_hash FROM knowledge_files`);
    const existing = new Map<string, string | null>(rows.map((r) => [String(r.path), (r.content_hash as string | null) ?? null]));

    // renames: a vanished path whose hash reappears under a new path
    const vanished = [...existing.keys()].filter((p) => !scanned.has(p));
    const added = [...scanned.keys()].filter((p) => !existing.has(p));
    const byHash = new Map<string, string[]>();
    for (const p of vanished) {
      const h = existing.get(p);
      if (h) byHash.set(h, [...(byHash.get(h) ?? []), p]);
    }
    let renamed = 0;
    const consumed = new Set<string>();
    for (const p of added) {
      const cands = byHash.get(scanned.get(p)!.hash);
      const old = cands?.find((c) => !consumed.has(c));
      if (!old) continue;
      consumed.add(old);
      await this.db.query(`UPDATE knowledge_files SET path = $2, mtime = $3, indexed_at = now() WHERE path = $1`, [old, p, scanned.get(p)!.mtime]);
      await this.db.query(`UPDATE knowledge_links SET from_path = $2 WHERE from_path = $1`, [old, p]);
      // same bytes under a new name: re-key the vectors, never re-embed them
      await this.embeddings?.rekey(old, p);
      existing.set(p, existing.get(old) ?? null);
      existing.delete(old);
      renamed++;
    }
    const removed = vanished.filter((p) => !consumed.has(p));
    if (removed.length) {
      await this.db.query(`DELETE FROM knowledge_links WHERE from_path = ANY($1::text[])`, [removed]);
      await this.db.query(`DELETE FROM knowledge_files WHERE path = ANY($1::text[])`, [removed]);
    }

    // upsert changed/new rows
    let changed = 0;
    let addedCount = 0;
    const pathSet = new Set(scanned.keys());
    const byBasename = new Map<string, string[]>();
    for (const p of pathSet) {
      const b = p.replace(/^.*\//, "").toLowerCase();
      byBasename.set(b, [...(byBasename.get(b) ?? []), p]);
    }
    const shapeChanged = renamed > 0 || removed.length > 0 || added.length > consumed.size;
    let links = 0;
    for (const s of scanned.values()) {
      const prev = existing.get(s.path);
      const isNew = prev === undefined;
      const dirty = isNew || prev !== s.hash;
      if (dirty) {
        if (isNew) addedCount++;
        else changed++;
        await this.db.query(
          `INSERT INTO knowledge_files (path, mtime, content_hash, indexed_at, status, title, description, draft)
           VALUES ($1, $2, $3, now(), $4, $5, $6, $7)
           ON CONFLICT (path) DO UPDATE SET mtime = EXCLUDED.mtime, content_hash = EXCLUDED.content_hash, indexed_at = now(),
             status = EXCLUDED.status, title = EXCLUDED.title, description = EXCLUDED.description, draft = EXCLUDED.draft`,
          [s.path, s.mtime, s.hash, s.conflict ? "conflict" : "clean", s.meta.title ?? basenameTitle(s.path), s.meta.description, s.meta.draft || s.conflict],
        );
      }
      // links: re-resolve for dirty notes, and for every note when the path set moved (targets may resolve differently)
      if (isMarkdown(s.path) && !s.conflict && (dirty || shapeChanged)) {
        await this.db.query(`DELETE FROM knowledge_links WHERE from_path = $1`, [s.path]);
        const seen = new Set<string>();
        for (const l of s.links) {
          const to = resolveLink(s.path, l.target, pathSet, byBasename);
          const key = `${to}\0${l.kind}`;
          if (seen.has(key)) continue;
          seen.add(key);
          await this.db.query(`INSERT INTO knowledge_links (from_path, to_path, kind) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [s.path, to, l.kind]);
          links++;
        }
      }
    }

    // conflict files: one proposal per file, ever (idempotency key = the path)
    let conflicts = 0;
    let conflictsNew = 0;
    for (const s of scanned.values()) {
      if (!s.conflict) continue;
      conflicts++;
      const payload = {
        title: `Conflict file: ${s.path.replace(/^.*\//, "")}`,
        body: `A sync conflict copy exists at ${s.path}. It is not indexed and not served to agents. Merge what matters into the original note, then delete this file.`,
        kind: "conflict_file",
        refs: [s.path],
        idempotency_key: `conflict:${s.path}`,
        provenance: { component: "reconciler", run_id: runId, sha256: s.hash },
      };
      const ins = await this.db.query(
        `INSERT INTO proposals (kind, source_agent, trust, payload) VALUES ('report', 'reconciler', 'internal', $1::jsonb)
         ON CONFLICT (source_agent, (payload->>'idempotency_key')) WHERE kind = 'report' AND payload->>'idempotency_key' IS NOT NULL DO NOTHING
         RETURNING id`,
        [JSON.stringify(payload)],
      );
      if (ins.rows[0]) conflictsNew++;
    }

    // external edits: Obsidian (any device) writes straight to the tree;
    // nothing else can commit them. Paths with a pending bridge intent are
    // that principal's; conflict copies are flagged, not committed.
    let externalEdits = 0;
    if (this.cfg.commitExternalEdits) {
      const pending = this.committer.pendingPaths();
      const entries = await this.vault.git.status(["Knowledge"]);
      const touched = new Set<string>();
      for (const e of entries) {
        if (e.code === "!!") continue;
        for (const p of [e.path, e.from]) {
          if (p && !pending.has(p) && !isConflictFile(p)) touched.add(p);
        }
      }
      if (touched.size > 0) {
        const paths = [...touched].sort();
        externalEdits = paths.length;
        this.committer.enqueue({ paths, principal: "user", group: "sync", message: `Vault edits from sync (${paths.length} file${paths.length === 1 ? "" : "s"})` });
      }
    }

    // Vectors last: they read the index this cycle just settled, and nothing
    // about them may cost us the index (§6 decision 8 — embedding degrades).
    let embeddings: EmbedSummary | undefined;
    if (this.embeddings) {
      try {
        embeddings = await this.embeddings.sync();
      } catch (err) {
        embeddings = { ...EMPTY_SUMMARY, degraded: err instanceof Error ? err.message : String(err) };
        console.error("reconciler: embedding failed (index is still current):", embeddings.degraded);
      }
    }

    return {
      run_id: runId,
      files: scanned.size,
      added: addedCount,
      changed,
      renamed,
      removed: removed.length,
      conflicts,
      conflicts_new: conflictsNew,
      links,
      external_edits: externalEdits,
      ...(embeddings ? { embeddings } : {}),
      duration_ms: Date.now() - started,
    };
  }
}
