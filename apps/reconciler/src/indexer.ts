// The reconcile loop (§4.13): walk the vault (the instance root), hash CONTENT (sync churns
// mtime, so mtime decides nothing), upsert `knowledge_files` +
// `knowledge_links`, detect renames by hash, flag Obsidian/Syncthing
// conflict files exactly once as a `proposals` report, and record one
// `runs` row per cycle. Also the sweep that commits edits made outside the
// bridge (Obsidian on any device) as the `user` principal — the reconciler
// is the sole committer, so nobody else can (PoC-12).

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { finishRun, isVaultPath, startRun, type RunExecutor } from "@foldedspacelabs/metistry-core";
import type { Committer } from "./committer.js";
import { EMPTY_SUMMARY, type Embeddings, type EmbedSummary } from "./embeddings.js";
import type { Vault } from "./vault.js";
import { basenameTitle, extractLinks, inboxNoteFor, INBOX_PREFIX, isConflictFile, isInboxPath, isMarkdown, mimeForPath, parseFrontmatter, resolveLink, sha256, type NoteLink, type NoteMeta } from "./notes.js";

export interface Db extends RunExecutor {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
}

export interface IndexerConfig {
  /** Commit working-tree changes in the vault that arrived outside the bridge (Obsidian sync). */
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
  /** `Inbox/` rows brought up to date this cycle (docs/ops/inbox.md). */
  inbox: InboxSummary;
  /** Phase 6: vectors brought up to date this cycle. Absent when no embedder is configured. */
  embeddings?: EmbedSummary;
  duration_ms: number;
}

export interface InboxSummary {
  /** files under `Inbox/` that had no triage row — a human's note, a `git pull` */
  added: number;
  /** rows whose file changed under them (re-triaged when they had already been classified) */
  changed: number;
  /** rows whose file is gone */
  archived: number;
}

interface Scanned {
  path: string;
  hash: string;
  mtime: Date;
  meta: NoteMeta;
  links: NoteLink[];
  conflict: boolean;
  /** kept only for `Inbox/` files, where the triage row wants a one-line note */
  bytes?: Buffer;
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
    const paths = await this.vault.walkVault();
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
      scanned.set(p, { path: p, hash: sha256(bytes), mtime: st.mtime, meta, links, conflict, ...(isInboxPath(p) ? { bytes } : {}) });
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

    // the vault inbox: a file that appears or changes under
    // `Inbox/` without a capture call is triage material too
    const inbox = await this.syncInbox(scanned);

    // external edits: Obsidian (any device) writes straight to the tree;
    // nothing else can commit them. Paths with a pending bridge intent are
    // that principal's; conflict copies are flagged, not committed.
    let externalEdits = 0;
    if (this.cfg.commitExternalEdits) {
      const pending = this.committer.pendingPaths();
      // the whole working tree, filtered to vault paths: `.metistry/` is
      // the user's hand (invariant 2) and must never ride along in a sweep
      // commit, and `Artifacts/` is not knowledge
      const entries = await this.vault.git.status(["."]);
      const touched = new Set<string>();
      for (const e of entries) {
        if (e.code === "!!") continue;
        for (const p of [e.path, e.from]) {
          if (p && isVaultPath(p) && !pending.has(p) && !isConflictFile(p)) touched.add(p);
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
      inbox,
      ...(embeddings ? { embeddings } : {}),
      duration_ms: Date.now() - started,
    };
  }

  /**
   * `Inbox/` is ordinary vault content — Obsidian adds to it, an
   * editor refines it, a `git pull` brings someone else's capture in — and
   * the triage queue has to see all of that, not only what came through
   * `POST /capture` (docs/ops/inbox.md). This is that reconciliation, and it
   * lives here because this is already the process that walks the tree and
   * hashes it: no second watcher, no second holder of the repo (D5), and no
   * new component talking to Postgres (invariant 3).
   *
   * - a file with no row → one `source: 'vault'` row, hashed and titled;
   * - a row whose file changed → the new hash, and back to `new` when it had
   *   already been classified or accepted: a human refinement is new
   *   information, so the drain looks again. A `rejected` row stays
   *   rejected — the user said no, and editing a file is not an appeal;
   * - a row whose file is gone → `archived`, never deleted.
   *
   * `Inbox/.large/` (and any other dot-directory) is invisible to
   * `walkVault`, so rows pointing into it are left alone rather than
   * archived the moment they are written.
   */
  private async syncInbox(scanned: Map<string, Scanned>): Promise<InboxSummary> {
    const files = [...scanned.values()].filter((s) => isInboxPath(s.path) && !s.conflict);
    const { rows } = await this.db.query(`SELECT id, path, sha256, status FROM inbox WHERE path LIKE $1`, [`${INBOX_PREFIX}/%`]);
    const existing = new Map(rows.map((r) => [String(r.path), { id: Number(r.id), sha256: (r.sha256 as string | null) ?? null, status: String(r.status) }]));
    const summary: InboxSummary = { added: 0, changed: 0, archived: 0 };

    for (const f of files) {
      const row = existing.get(f.path);
      const note = f.bytes ? inboxNoteFor(f.path, f.bytes) : null;
      if (!row) {
        // ON CONFLICT: the capture path may have written this file a
        // millisecond ago and be inserting its own (better) row right now.
        const ins = await this.db.query(
          `INSERT INTO inbox (source, path, mime, note, sha256) VALUES ('vault', $1, $2, $3, $4)
           ON CONFLICT (path) WHERE path LIKE '${INBOX_PREFIX}/%' DO NOTHING RETURNING id`,
          [f.path, mimeForPath(f.path), note, f.hash],
        );
        if (ins.rows[0]) summary.added++;
        continue;
      }
      if (row.sha256 === f.hash && row.status !== "archived") continue;
      const reopen = row.status === "classified" || row.status === "accepted" || row.status === "archived";
      await this.db.query(
        `UPDATE inbox SET sha256 = $2, note = COALESCE($3, note), mime = COALESCE(mime, $4)${reopen ? ", status = 'new', proposal = NULL, triaged_at = NULL" : ""} WHERE id = $1`,
        [row.id, f.hash, note, mimeForPath(f.path)],
      );
      summary.changed++;
    }

    const present = new Set(files.map((f) => f.path));
    const gone = [...existing.entries()]
      .filter(([p, r]) => !present.has(p) && r.status !== "archived" && !p.slice(INBOX_PREFIX.length + 1).startsWith("."))
      .map(([p]) => p);
    if (gone.length > 0) {
      await this.db.query(`UPDATE inbox SET status = 'archived', triaged_at = now() WHERE path = ANY($1::text[])`, [gone]);
      summary.archived = gone.length;
    }
    return summary;
  }
}
