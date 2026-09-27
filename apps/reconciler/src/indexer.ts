// The reconcile loop (§4.13): walk the vault (the instance root), hash CONTENT (sync churns
// mtime, so mtime decides nothing), upsert `knowledge_files` +
// `knowledge_links`, detect renames by hash, flag Obsidian/Syncthing
// conflict files exactly once as a `proposals` report, and record one
// `runs` row per cycle. Also the sweep that commits edits made outside the
// bridge (Obsidian on any device) as the `user` principal — the reconciler
// is the sole committer, so nobody else can (PoC-12).
//
// Since P1-4 the same walk also fills `vault_tasks` and `vault_task_refs`
// (docs/product/daily-flow-spec.md §1.5) — every `- [ ] …` line the user
// typed and every `[[note#^mt-…]]` that names one. Same reason the inbox
// pass lives here: this is already the process that walks the tree and
// hashes it, so there is no second watcher, no second holder of the repo
// (D5), and no new component talking to Postgres (invariant 3).

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { finishRun, isVaultPath, nextRecurrence, startRun, taskToday, type RunExecutor, type TaskDateOptions } from "@foldedspacelabs/metistry-core";
import type { Committer } from "./committer.js";
import { EMPTY_SUMMARY, type Embeddings, type EmbedSummary } from "./embeddings.js";
import type { Vault } from "./vault.js";
import {
  areaForPath,
  basenameTitle,
  extractLinks,
  extractTaskRefs,
  extractTasks,
  inboxNoteFor,
  INBOX_PREFIX,
  isConflictFile,
  isInboxPath,
  isMarkdown,
  isTaskPath,
  mimeForPath,
  ownsTaskLines,
  parseFrontmatter,
  parseVaultTaskRef,
  peoplePages,
  projectForPath,
  resolveAssignee,
  resolveLink,
  sha256,
  type NoteLink,
  type NoteMeta,
  type NoteTaskRef,
  type ScannedTask,
} from "./notes.js";

export interface Db extends RunExecutor {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
}

export interface IndexerConfig {
  /** Commit working-tree changes in the vault that arrived outside the bridge (Obsidian sync). */
  commitExternalEdits: boolean;
  /**
   * Where captures live, vault-relative: `Inbox` (the flat layout) or
   * `Knowledge/Inbox` on an instance `metistry migrate-layout` has not
   * carried over yet. It reaches the SQL as well as the path test — the
   * triage rows of a legacy instance are `Knowledge/Inbox/…`, and a cycle
   * that looked for `Inbox/%` would neither find them nor make new ones.
   * Unset = the flat spelling.
   */
  inboxPrefix?: string | undefined;
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
  /** The vault's `- [ ]` lines, as of this cycle (daily-flow-spec §1.5). */
  tasks: TaskSummary;
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

export interface TaskSummary {
  /** notes that hold at least one `- [ ]` line the index keeps */
  files: number;
  /** `vault_tasks` rows the vault says exist, after this cycle */
  rows: number;
  /** keys that were not in the table before this cycle */
  added: number;
  /** keys the table held that the vault no longer does — a deleted note, a re-typed line */
  removed: number;
  /** rows carrying `duplicate_of` — the later-seen half of a §2.3 pair */
  duplicates: number;
  /** rows carrying `parse_warning` — a token the parser would not guess at */
  warnings: number;
  /** `vault_task_refs` rows: `[[note#^mt-…]]` in a note, plus every `work.meta.blocked_by` */
  refs: number;
}

interface Scanned {
  path: string;
  hash: string;
  mtime: Date;
  meta: NoteMeta;
  links: NoteLink[];
  conflict: boolean;
  /** Every `- [ ] …` line, parsed. Empty for a note the task index does not read (§2.1, `ownsTaskLines`). */
  tasks: ScannedTask[];
  /** Every `[[note#^mt-…]]` in the body, from any indexed note — a machine file's transclusion IS a reference, it is only not a second task. */
  refs: NoteTaskRef[];
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

  /** `Inbox`, or the legacy `Knowledge/Inbox` when the config says so. One place, so the SQL and the path test can never disagree. */
  private get inboxPrefix(): string {
    return this.cfg.inboxPrefix ?? INBOX_PREFIX;
  }

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
    // ONE date for the whole cycle, so every relative token on every line
    // (`due friday`) resolves against the same day and `parsed_on` is the
    // same on the first note and the last — a walk that crosses midnight
    // must not answer two different questions (§1.3).
    const taskDates: TaskDateOptions = { now: new Date(started) };
    const today = taskToday(taskDates);
    const scanned = new Map<string, Scanned>();
    for (const p of paths) {
      const abs = join(this.vault.root, p);
      const bytes = await readFile(abs);
      const st = await stat(abs);
      const conflict = isConflictFile(p);
      let meta: NoteMeta = { title: null, description: null, draft: false, source: null, area: null };
      let links: NoteLink[] = [];
      let tasks: ScannedTask[] = [];
      let refs: NoteTaskRef[] = [];
      if (isMarkdown(p) && !conflict) {
        const text = bytes.toString("utf8");
        const parsed = parseFrontmatter(text);
        meta = parsed.meta;
        links = extractLinks(parsed.body);
        refs = extractTaskRefs(parsed.body);
        // Parsed on EVERY cycle, written only when the bytes moved (see
        // `syncTasks`): the parse is in-memory and this is the pass that
        // already holds the text, so knowing what a note's tasks are costs
        // nothing and is what lets the writes be exact.
        if (isTaskPath(p) && ownsTaskLines(meta)) tasks = extractTasks(text, taskDates);
      }
      scanned.set(p, { path: p, hash: sha256(bytes), mtime: st.mtime, meta, links, conflict, tasks, refs, ...(isInboxPath(p, this.inboxPrefix) ? { bytes } : {}) });
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
      // The same lines under a new name are the same lines: carry the task
      // rows across rather than deleting and re-deriving them, so
      // `first_seen_on` — the ageing clock, and the one column that is not a
      // projection of the current bytes — survives the move. The clear
      // first is not defensive decoration: `(path, task_key)` is the primary
      // key, and a walk that can be made to fail by a name the index has
      // seen before is not a derived index. `vault_task_refs` needs neither,
      // since it holds no state to preserve and the pass below rebuilds it
      // whole.
      await this.db.query(`DELETE FROM vault_tasks WHERE path = $1`, [p]);
      await this.db.query(`UPDATE vault_tasks SET path = $2 WHERE path = $1`, [old, p]);
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
    const dirtyPaths = new Set<string>();
    for (const s of scanned.values()) {
      const prev = existing.get(s.path);
      const isNew = prev === undefined;
      const dirty = isNew || prev !== s.hash;
      if (dirty) dirtyPaths.add(s.path);
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

    // the vault's tasks: every `- [ ]` line the user typed, and every
    // block-anchored reference to one
    const tasks = await this.syncTasks(scanned, pathSet, byBasename, dirtyPaths, today, taskDates);

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
        this.committer.enqueueSweep(paths); // one `user` commit whose subject names the files (§2.21)
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
      tasks,
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
    const files = [...scanned.values()].filter((s) => isInboxPath(s.path, this.inboxPrefix) && !s.conflict);
    const { rows } = await this.db.query(`SELECT id, path, sha256, status FROM inbox WHERE path LIKE $1`, [`${this.inboxPrefix}/%`]);
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
           ON CONFLICT (path) WHERE path LIKE '${this.inboxPrefix}/%' DO NOTHING RETURNING id`,
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
      .filter(([p, r]) => !present.has(p) && r.status !== "archived" && !p.slice(this.inboxPrefix.length + 1).startsWith("."))
      .map(([p]) => p);
    if (gone.length > 0) {
      await this.db.query(`UPDATE inbox SET status = 'archived', triaged_at = now() WHERE path = ANY($1::text[])`, [gone]);
      summary.archived = gone.length;
    }
    return summary;
  }

  /**
   * **The vault's tasks** (docs/product/daily-flow-spec.md §1.5, ticket
   * P1-4): one `vault_tasks` row per `- [ ] …` line the user typed, and one
   * `vault_task_refs` row per block-anchored reference to one.
   *
   * **Derived in full, and it owns both tables.** What vanished is the
   * difference between what the tables hold and what the vault says, which
   * is why this reads them whole — the contract `knowledge_files` has had
   * since §4.13. Drop the database, let one walk run, and every row here
   * comes back from the markdown that produced it.
   *
   * **It writes a note's rows when the note's BYTES changed** (or when they
   * disagree with what the table holds, which is how a half-emptied table
   * heals itself). Not on every cycle, and that is a correctness property
   * rather than an optimisation: `due friday` is resolved against the day
   * the walk READ the line, and a row re-derived every five minutes would
   * slide a Friday task onto the next Friday the moment that one passed.
   * §1.3's `due` is "a hard date the user set. Never moved by anything",
   * and `parsed_on` records the day it was read against.
   *
   * **It never writes a note.** The only hand that touches a task line is
   * the user's own (§1.4, D3): the parser reads loosely — `due friday`,
   * `critical`, Dataview, the Tasks plugin's emoji — and the resolved value
   * lands beside the line, never in it.
   *
   * **`work` is read and never written** (§3, D8). A work row may NAME a
   * human todo as `meta.blocked_by`; that reference becomes a ref row here
   * so the board and the plan can show "waiting on you", and `depends_on`,
   * `DEPS_CLOSED` and claimability are untouched by all of it.
   *
   * **Statement order is fixed** and the tables are only ever taken one
   * way — `vault_tasks`, then a SHARED read of `work`, then
   * `vault_task_refs` — with `DELETE` and never `TRUNCATE`. A pass that
   * took two tables in two orders on two paths is the deadlock #207 found
   * between `work` and `proposals`.
   */
  private async syncTasks(
    scanned: Map<string, Scanned>,
    pathSet: ReadonlySet<string>,
    byBasename: ReadonlyMap<string, string[]>,
    dirty: ReadonlySet<string>,
    today: string,
    dates: TaskDateOptions,
  ): Promise<TaskSummary> {
    const seenAt = dates.now ?? new Date();

    // (1) what the index holds — the whole table, because the index owns it
    const held = new Map<string, Set<string>>();
    for (const r of (await this.db.query(`SELECT path, task_key FROM vault_tasks`)).rows) {
      const p = String(r.path);
      const keys = held.get(p) ?? new Set<string>();
      keys.add(String(r.task_key));
      held.set(p, keys);
    }

    // (2) what the vault says. Parsed in the walk above; resolved here,
    // because `@Jim` → `People/Jim Fallon.md` needs the whole path set.
    const people = peoplePages(pathSet);
    const desired = new Map<string, VaultTaskRow[]>();
    const rules: Array<{ path: string; task_key: string; task: ScannedTask }> = [];
    let warnings = 0;
    let rows = 0;
    for (const s of scanned.values()) {
      if (s.tasks.length === 0) continue;
      const built = s.tasks.map((t) => {
        const row = buildTaskRow(s, t, today, seenAt, pathSet, byBasename, people);
        if (row.parse_warning !== null) warnings++;
        if (t.parsed.recurrence !== null) rules.push({ path: s.path, task_key: t.task_key, task: t });
        return row;
      });
      desired.set(s.path, built);
      rows += built.length;
    }

    // (3) rows the vault no longer has: a deleted note, a note that became
    // a machine file, a line whose text was re-typed (its key went with the
    // old text, and `first_seen_on` does not carry — the ageing clock
    // belongs to the line, not to the note).
    const gonePaths: string[] = [];
    const goneKeys: string[] = [];
    for (const [path, keys] of held) {
      const want = new Set((desired.get(path) ?? []).map((r) => r.task_key));
      for (const key of keys) {
        if (want.has(key)) continue;
        gonePaths.push(path);
        goneKeys.push(key);
      }
    }
    if (gonePaths.length > 0) {
      await this.db.query(
        `DELETE FROM vault_tasks v USING unnest($1::text[], $2::text[]) AS g(path, task_key)
          WHERE v.path = g.path AND v.task_key = g.task_key`,
        [gonePaths, goneKeys],
      );
    }

    // (4) the upsert, per note, for the notes whose bytes moved
    let added = 0;
    for (const [path, want] of desired) {
      const have = held.get(path) ?? new Set<string>();
      const missing = want.filter((r) => !have.has(r.task_key)).length;
      added += missing;
      if (!dirty.has(path) && missing === 0) continue; // same bytes, same rows: nothing to say
      for (let i = 0; i < want.length; i += TASK_UPSERT_ROWS) await this.upsertTasks(want.slice(i, i + TASK_UPSERT_ROWS));
    }

    // (5) §2.3's duplicates, over the whole open set: the same text typed in
    // two notes is two lines and markdown is the record, so both rows stay
    // and the later-seen one points at the earlier. Deterministic, no model.
    // "Earlier" is `first_seen_on`, then path and key in BYTE order, so two
    // rows first seen on one day resolve the same way on every cluster.
    await this.db.query(
      `WITH open AS (
         SELECT path, task_key, text_norm, first_seen_on FROM vault_tasks
          WHERE NOT checked AND NOT dropped AND recur_rule IS NULL
       ),
       canon AS (
         SELECT DISTINCT ON (text_norm COLLATE "C") text_norm, path, task_key FROM open
          ORDER BY text_norm COLLATE "C", first_seen_on, path COLLATE "C", task_key COLLATE "C"
       ),
       want AS (
         SELECT v.path, v.task_key,
                CASE WHEN c.task_key IS NULL OR (c.path = v.path AND c.task_key = v.task_key)
                     THEN NULL ELSE c.task_key END AS dup
           FROM vault_tasks v
           LEFT JOIN open o  ON o.path = v.path AND o.task_key = v.task_key
           LEFT JOIN canon c ON c.text_norm = o.text_norm
       )
       UPDATE vault_tasks t SET duplicate_of = w.dup FROM want w
        WHERE t.path = w.path AND t.task_key = w.task_key
          AND t.duplicate_of IS DISTINCT FROM w.dup`,
    );

    // (6) §4's instances: a line the daily-note template materialised from a
    // rule (`source template:recurring`) points back at the rule's key, so
    // the `recurring` directive can ask whether this rule's last instance is
    // still open before it offers another. Matched on `text_norm` — which is
    // what the template renders, the rule's text minus its `every …` clause
    // — and never by a model.
    await this.db.query(
      `WITH rules AS (
         SELECT DISTINCT ON (text_norm COLLATE "C") text_norm, task_key FROM vault_tasks
          WHERE recur_rule IS NOT NULL
          ORDER BY text_norm COLLATE "C", first_seen_on, path COLLATE "C", task_key COLLATE "C"
       ),
       want AS (
         SELECT v.path, v.task_key, r.task_key AS parent
           FROM vault_tasks v
           LEFT JOIN rules r ON v.recur_rule IS NULL AND v.source = $1 AND r.text_norm = v.text_norm
       )
       UPDATE vault_tasks t SET recur_parent = w.parent FROM want w
        WHERE t.path = w.path AND t.task_key = w.task_key
          AND t.recur_parent IS DISTINCT FROM w.parent`,
      [RECURRING_SOURCE],
    );

    // (7) and the rule's own `recur_next` moves past the instances that are
    // DONE — past the closed ones only. A rule whose instance is still open
    // has to keep falling due or §4's carry-over line ("carried, 3rd time")
    // would never render; one whose instance was ticked this morning must
    // not offer another tomorrow. This is the only value here that is a
    // function of other rows rather than of the line, which is why it is a
    // pass of its own rather than a column of the upsert.
    if (rules.length > 0) await this.advanceRecurrence(rules, today);

    // (8) the references — `vault_tasks` first, always (see the head note)
    const refs = await this.syncTaskRefs(scanned, pathSet, byBasename);

    const counted = await this.db.query(`SELECT count(*) FILTER (WHERE duplicate_of IS NOT NULL)::int AS duplicates FROM vault_tasks`);
    return {
      files: desired.size,
      rows,
      added,
      removed: goneKeys.length,
      duplicates: Number(counted.rows[0]?.duplicates ?? 0),
      warnings,
      refs,
    };
  }

  /** One `INSERT … ON CONFLICT` for a batch of one note's task rows. `first_seen_on` is absent from the SET on purpose: the ageing clock belongs to the walk that first saw the line. */
  private async upsertTasks(batch: VaultTaskRow[]): Promise<void> {
    if (batch.length === 0) return;
    const values: unknown[] = [];
    const tuples = batch.map((r) => {
      const cells = TASK_COLUMNS.map((c) => {
        values.push(r[c]);
        return `$${values.length}`;
      });
      return `(${cells.join(", ")})`;
    });
    await this.db.query(
      `INSERT INTO vault_tasks (${TASK_COLUMNS.join(", ")}) VALUES ${tuples.join(", ")}
       ON CONFLICT (path, task_key) DO UPDATE SET
         anchor = EXCLUDED.anchor,
         line_no = EXCLUDED.line_no,
         text = EXCLUDED.text,
         text_norm = EXCLUDED.text_norm,
         checked = EXCLUDED.checked,
         dropped = EXCLUDED.dropped,
         waiting = EXCLUDED.waiting,
         someday = EXCLUDED.someday,
         due = EXCLUDED.due,
         scheduled_for = EXCLUDED.scheduled_for,
         start_on = EXCLUDED.start_on,
         done_on = CASE WHEN EXCLUDED.done_on_observed AND vault_tasks.done_on_observed
                        THEN vault_tasks.done_on ELSE EXCLUDED.done_on END,
         done_on_observed = EXCLUDED.done_on_observed,
         priority = EXCLUDED.priority,
         size = EXCLUDED.size,
         type = EXCLUDED.type,
         assigned = EXCLUDED.assigned,
         project = EXCLUDED.project,
         area = EXCLUDED.area,
         recur_rule = EXCLUDED.recur_rule,
         recur_next = EXCLUDED.recur_next,
         source = EXCLUDED.source,
         ext_refs = EXCLUDED.ext_refs,
         work_id = EXCLUDED.work_id,
         parse_warning = EXCLUDED.parse_warning,
         parsed_on = EXCLUDED.parsed_on,
         last_seen_at = EXCLUDED.last_seen_at`,
      values,
    );
  }

  /** `recur_next`, past every instance a rule has already closed (§4). One read, one batched write, and nothing at all when nothing moved. */
  private async advanceRecurrence(rules: Array<{ path: string; task_key: string; task: ScannedTask }>, today: string): Promise<void> {
    const { rows } = await this.db.query(
      `SELECT recur_parent AS task_key, max(first_seen_on)::text AS closed_on FROM vault_tasks
        WHERE recur_parent IS NOT NULL AND (checked OR dropped) GROUP BY 1`,
    );
    if (rows.length === 0) return;
    const lastClosed = new Map(rows.map((r) => [String(r.task_key), String(r.closed_on)]));
    const paths: string[] = [];
    const keys: string[] = [];
    const nexts: string[] = [];
    for (const r of rules) {
      const closed = lastClosed.get(r.task_key);
      const rule = r.task.parsed.recurrence;
      if (closed === undefined || rule === null) continue;
      const next = nextRecurrence(rule, today, closed);
      if (next === null || next === rule.next) continue;
      paths.push(r.path);
      keys.push(r.task_key);
      nexts.push(next);
    }
    if (paths.length === 0) return;
    await this.db.query(
      `UPDATE vault_tasks t SET recur_next = g.next::date
         FROM unnest($1::text[], $2::text[], $3::text[]) AS g(path, task_key, next)
        WHERE t.path = g.path AND t.task_key = g.task_key AND t.recur_next IS DISTINCT FROM g.next::date`,
      [paths, keys, nexts],
    );
  }

  /**
   * `vault_task_refs`: every `[[note#^mt-…]]` and `![[note#^mt-…]]` in the
   * vault, plus every `work.meta.blocked_by` (§3).
   *
   * A MACHINE FILE'S transclusion is a reference and belongs here — the
   * plan's `![[Journal/2026-09-18#^mt-7x2k]]` is the whole reason the table
   * exists. What a machine file does not get is a `vault_tasks` row: it
   * shows a task, it does not hold one.
   *
   * Rebuilt whole every cycle rather than diffed per note: it holds no
   * state to preserve, so the honest thing and the cheap thing are the same
   * thing.
   */
  private async syncTaskRefs(scanned: Map<string, Scanned>, pathSet: ReadonlySet<string>, byBasename: ReadonlyMap<string, string[]>): Promise<number> {
    const want = new Map<string, [string, string, string, string]>();
    const add = (from: string, to: string, anchor: string, kind: string) => want.set([from, to, anchor, kind].join(REF_SEP), [from, to, anchor, kind]);
    for (const s of scanned.values()) {
      for (const r of s.refs) {
        // `[[#^mt-7x2k]]` — a block in this very note
        const to = r.target === "" ? s.path : resolveLink(s.path, r.target, pathSet, byBasename);
        add(s.path, to, r.anchor, r.kind);
      }
    }
    // §3, read-only: a `work` row that NAMES a human todo. The row itself is
    // never touched here — it surfaces and it never gates.
    for (const w of (await this.db.query(`SELECT id, meta->>'blocked_by' AS blocked_by FROM work WHERE meta->>'blocked_by' IS NOT NULL`)).rows) {
      const ref = parseVaultTaskRef(w.blocked_by);
      if (!ref) continue;
      add(`${WORK_REF_PREFIX}${String(w.id)}`, resolveLink(ref.path, ref.path, pathSet, byBasename), ref.anchor, WORK_REF_KIND);
    }

    const held = new Set<string>();
    for (const r of (await this.db.query(`SELECT from_path, to_path, anchor, kind FROM vault_task_refs`)).rows) {
      held.add([r.from_path, r.to_path, r.anchor, r.kind].map(String).join(REF_SEP));
    }

    const gone = [...held].filter((k) => !want.has(k)).map((k) => k.split(REF_SEP));
    if (gone.length > 0) {
      await this.db.query(
        `DELETE FROM vault_task_refs r USING unnest($1::text[], $2::text[], $3::text[], $4::text[]) AS g(f, t, a, k)
          WHERE r.from_path = g.f AND r.to_path = g.t AND r.anchor = g.a AND r.kind = g.k`,
        [gone.map((g) => g[0]), gone.map((g) => g[1]), gone.map((g) => g[2]), gone.map((g) => g[3])],
      );
    }
    const fresh = [...want.entries()].filter(([k]) => !held.has(k)).map(([, v]) => v);
    for (let i = 0; i < fresh.length; i += TASK_UPSERT_ROWS) {
      const batch = fresh.slice(i, i + TASK_UPSERT_ROWS);
      await this.db.query(
        `INSERT INTO vault_task_refs (from_path, to_path, anchor, kind)
         SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[]) ON CONFLICT DO NOTHING`,
        [batch.map((b) => b[0]), batch.map((b) => b[1]), batch.map((b) => b[2]), batch.map((b) => b[3])],
      );
    }
    return want.size;
  }
}

// ---- the task row (daily-flow-spec §1.5) -----------------------------------

/** The `source` a recurrence INSTANCE carries, written by the daily-note template and by nothing else (§4). */
const RECURRING_SOURCE = "template:recurring";

/** How a `work` row names itself as the FROM side of a reference — the spelling §3 already uses on a task line (`work:418`). */
const WORK_REF_PREFIX = "work:";

/** The third `kind`, beside `wikilink` and `embed`: a `work` row naming the human todo it waits on. It surfaces and never gates (D8). */
const WORK_REF_KIND = "blocked_by";

/** Joins the four columns of a ref into one set key. A tab cannot appear in a path (`parseVaultPath` refuses control characters) or in an anchor. */
const REF_SEP = "\t";

/** Rows per statement. Both tables are derived and a vault is small, so this is about staying well inside Postgres's 65535 bind parameters, not about throughput. */
const TASK_UPSERT_ROWS = 200; // limit: fixed — 200 × 30 bind parameters is under a tenth of the per-statement ceiling

/** `parse_warning` is one column and one rendered line in the day's plan, never a report (§1.4). */
const TASK_WARNING_CHARS = 200; // limit: fixed — the same bound `packages/core`'s parser applies to the warning it produces

/** Every column the walk derives. `duplicate_of` and `recur_parent` are deliberately absent: they are facts about OTHER rows, and each is a pass of its own. */
const TASK_COLUMNS = [
  "path", "task_key", "anchor", "line_no", "text", "text_norm",
  "checked", "dropped", "waiting", "someday",
  "due", "scheduled_for", "start_on", "done_on", "done_on_observed",
  "priority", "size", "type", "assigned", "project", "area",
  "recur_rule", "recur_next", "source", "ext_refs", "work_id",
  "parse_warning", "parsed_on", "first_seen_on", "last_seen_at",
] as const;

type VaultTaskRow = { [K in (typeof TASK_COLUMNS)[number]]: unknown } & { path: string; task_key: string; parse_warning: string | null };

/** One parsed line plus what only the vault knows: the person page behind `@Jim`, the area behind the note's location, the project behind its folder. */
function buildTaskRow(
  s: Scanned,
  t: ScannedTask,
  today: string,
  seenAt: Date,
  pathSet: ReadonlySet<string>,
  byBasename: ReadonlyMap<string, string[]>,
  people: readonly string[],
): VaultTaskRow {
  const p = t.parsed;
  const warnings: string[] = [];
  if (p.parse_warning !== null) warnings.push(p.parse_warning);

  let assigned: string | null = null;
  if (p.assigned !== null) {
    const resolved = resolveAssignee(s.path, p.assigned, pathSet, byBasename, people);
    assigned = resolved.assigned;
    if (resolved.warning !== null) warnings.push(resolved.warning);
  }

  // §1.3: a `[x]` with no `done …` on the line is dated the first walk that
  // saw it checked, and the row SAYS so rather than pretending the user
  // wrote a date they did not write.
  const observed = p.checked && p.done_on === null;
  const warning = warnings.join("; ").slice(0, TASK_WARNING_CHARS);

  return {
    path: s.path,
    task_key: t.task_key,
    anchor: p.anchor,
    line_no: t.line_no,
    text: p.text,
    text_norm: p.text_norm,
    checked: p.checked,
    dropped: p.dropped,
    waiting: p.waiting,
    someday: p.someday,
    due: p.due,
    scheduled_for: p.scheduled_for,
    start_on: p.start_on,
    done_on: p.done_on ?? (p.checked ? today : null),
    done_on_observed: observed,
    priority: p.priority,
    size: p.size === null ? null : p.size.toUpperCase(), // the column's documented domain is S | M | L
    type: p.type,
    assigned,
    project: p.project ?? projectForPath(s.path),
    area: areaForPath(s.path, s.meta),
    recur_rule: p.recurrence?.rule ?? null,
    recur_next: p.recurrence?.next ?? null,
    source: p.source,
    ext_refs: p.ext_refs,
    work_id: p.work_id,
    parse_warning: warning === "" ? null : warning,
    parsed_on: p.parsed_on,
    first_seen_on: today,
    last_seen_at: seenAt,
  };
}
