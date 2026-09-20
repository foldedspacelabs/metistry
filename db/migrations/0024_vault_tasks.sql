-- 0024_vault_tasks — the index over the `- [ ]` lines the user typed
-- (docs/product/daily-flow-spec.md §1.5, ticket P1-3; ruled 2026-09-19 R1:
-- "markdown is the source of truth" for a human todo, `work` stays canonical
-- for what an agent may claim).
--
-- NUMBERED 0024, NOT 0023. The spec names `0023_vault_tasks.sql`; while it
-- was being written, 0023 was taken by `0023_agent_grant_overrides.sql`
-- (#235, merged). Migrations apply in filename order and each is recorded
-- once, so the number is a position in that order and nothing else — this is
-- the same file at the next free one. §1.5's SQL is otherwise followed
-- column for column.
--
-- DERIVED IN FULL (invariant 1; D7). Every row here comes back from the
-- markdown that produced it: the reconciler's existing walk parses every
-- note on every pass (P1-4), so `docker compose down -v`, rebuild from the
-- repo, let one walk run, and both tables are exactly what they were. Nothing
-- here is backed up and nothing here needs to be. `first_seen_on` is the one
-- column that is not a pure projection of the current bytes — it is
-- recoverable from git (`GET /vault/log`, apps/reconciler/src/server.ts) and
-- a rebuild that resets it loses a nudge, not a task.
--
-- ADDITIVE (CLAUDE.md, migrations are additive-first): two new tables, no
-- column rewritten, no existing row touched. Every statement is
-- `IF NOT EXISTS`, so applying the file twice is a no-op the second time
-- even outside the runner's own bookkeeping.
--
-- ROLLBACK NOTE: `DROP TABLE vault_task_refs, vault_tasks;`. Nothing
-- references them — deliberately, see the two foreign keys NOT declared
-- below — and the next walk rebuilds them from the vault.
--
-- INVARIANT 3, stated rather than waved through (spec §13.5). The reconciler
-- already writes `knowledge_files`, `knowledge_links`, `embeddings`,
-- `proposals` and `inbox` directly; these are the sixth and seventh. The
-- invariant's force is on the READ path, and every read of these tables is a
-- named query in `seed/queries/` executed by `packages/queries`.

CREATE TABLE IF NOT EXISTS vault_tasks (
    path             text        NOT NULL,                      -- derived: vault-relative path of the note the line lives in
    task_key         text        NOT NULL,                      -- derived: the anchor when present, else 'h:'||sha256(text_norm)||':'||ordinal
    anchor           text,                                      -- derived: the ^mt-… block id, without the caret; NULL before the plugin (§1.2)
    line_no          integer     NOT NULL,                      -- derived: 1-based line number in the note as walked
    text             text        NOT NULL,                      -- derived: the line minus its trailing field run and anchor, verbatim
    text_norm        text        NOT NULL,                      -- derived: lowercased, whitespace-collapsed, punctuation-stripped — the dedupe key
    checked          boolean     NOT NULL,                      -- derived: the line is `- [x]`
    dropped          boolean     NOT NULL DEFAULT false,        -- derived: the line is `- [-]`
    waiting          boolean     NOT NULL DEFAULT false,        -- derived: the `waiting` token — open, but not the user's move
    due              date,                                      -- derived: `due …`, a hard date the user set; nothing ever moves it
    scheduled_for    date,                                      -- derived: `do …`, the day the user means to do it
    start_on         date,                                      -- derived: `start …`; not actionable before this
    done_on          date,                                      -- derived: `done …`, else the first day the index saw it checked
    done_on_observed boolean     NOT NULL DEFAULT false,        -- derived: done_on came from the index, not from the line (§1.3 — honest, and it is what makes yesterday's standup work before the plugin exists)
    priority         smallint,                                  -- derived: 1..4 (D5); NULL sorts as 3, so every read is coalesce(priority, 3)
    size             char(1),                                   -- derived: S | M | L — rough effort; the minutes map is Me/profile.md's, never a literal here
    type             text,                                      -- derived: free lowercase slug, no enum (D6) — adding "errand" must not be a product change
    assigned         text,                                      -- derived: vault path of the person page `@Jim` / `@[[Jim Fallon]]` resolved to; stored as written when it resolves to nothing
    project          text,                                      -- derived: slug, from `+drey` or from the note's location
    area             text,                                      -- derived: the note's frontmatter `area:` or its path prefix; never typed on the line
    recur_rule       text,                                      -- derived: the `every …` clause, verbatim (§4)
    recur_next       date,                                      -- derived: the next occurrence the rule computes to
    recur_parent     text,                                      -- derived: task_key of the rule line this instance was materialised from
    source           text,                                      -- derived: meeting:… | mail:… | agent:… | template:recurring; a hand-typed line has none
    ext_refs         text[]      NOT NULL DEFAULT '{}',         -- derived: linear:ABC-123, gh:owner/repo#418 — one-way references a collector can join on
    work_id          bigint,                                    -- derived: from a `work:418` token on the line (§3). NOT a foreign key on purpose: `work` is durable and this table is derived, so a FK would let a vanished work row fail the walk that rebuilds the vault's own tasks
    duplicate_of     text,                                      -- derived: task_key of the earlier-seen twin, when text_norm matches and both are open (§2.3)
    parse_warning    text,                                      -- derived: the token that could not be read; a field Metistry cannot read is never guessed (§1.4)
    parsed_on        date        NOT NULL,                      -- derived: the date a relative token (`due friday`) was resolved against, so it is not silently re-read as another date tomorrow
    first_seen_on    date        NOT NULL,                      -- derived (recoverable from git log): the ageing clock
    last_seen_at     timestamptz NOT NULL,                      -- derived: the walk that last saw this line
    PRIMARY KEY (path, task_key)
);

COMMENT ON TABLE vault_tasks IS
  'Derived in full: one row per `- [ ] …` line in the vault, rebuilt by the reconciler''s walk from the markdown that is the record (daily-flow-spec §1.5). Never backed up, never written by hand, never the place a task''s status is authored — the checkbox on disk is.';

-- IDENTITY. The primary key is (path, task_key) and not task_key alone, and
-- there is deliberately NO unique index on `task_key` or on `anchor`:
--
--   * without an anchor, task_key is `h:<sha256 of text_norm>:<ordinal among
--     identical lines IN THAT FILE>` (§1.5), so the same sentence typed in
--     two notes produces the SAME key in both — which is exactly §2.3's
--     duplicate, a thing the index must hold two rows for rather than refuse;
--   * with an anchor, the key is globally unique in practice because the
--     plugin mints each one once — but "in practice" is not a constraint to
--     enforce here. A user who copy-pastes a line, anchor and all, into a
--     second note must not be able to make the reconciler's walk fail. A
--     derived index that can refuse to be rebuilt is not derived.
--
-- So both get a plain lookup index and the reader resolves the collision.

-- The open set, keyed the way the day is read: what is scheduled, then what
-- is owed. Partial on open, so the index is the size of the backlog rather
-- than of every task ever ticked.
CREATE INDEX IF NOT EXISTS vault_tasks_open_idx   ON vault_tasks (scheduled_for, due) WHERE NOT checked AND NOT dropped;
-- `due` on its own: overdue and due-today, the two reads Today and the plan
-- open with, which cannot use the composite above (its leading column is
-- scheduled_for).
CREATE INDEX IF NOT EXISTS vault_tasks_due_idx    ON vault_tasks (due)                WHERE NOT checked AND NOT dropped AND due IS NOT NULL;
-- The person view: `@[[Jim Fallon]]`'s open, waiting and overdue (§2.1).
CREATE INDEX IF NOT EXISTS vault_tasks_person_idx ON vault_tasks (assigned)           WHERE NOT checked AND NOT dropped;
-- The dedupe key (§2.3): the same task typed twice, linked by duplicate_of.
CREATE INDEX IF NOT EXISTS vault_tasks_dupe_idx   ON vault_tasks (text_norm)          WHERE NOT checked AND NOT dropped;
-- The promotion pointer (§3): a task line carrying `work:418`.
CREATE INDEX IF NOT EXISTS vault_tasks_work_idx   ON vault_tasks (work_id)            WHERE work_id IS NOT NULL;
-- What closed, and when: yesterday's standup, the fold's "closed today", the
-- weekly completion rate.
CREATE INDEX IF NOT EXISTS vault_tasks_done_idx   ON vault_tasks (done_on)            WHERE done_on IS NOT NULL;
-- Path prefix and note order, in BYTE order. `COLLATE "C"` is not a detail
-- and the lesson is the page list's (seed/queries/knowledge_pages.yaml): a
-- locale collation ignores punctuation at the primary level, so `Journal/`
-- sorts differently on a macOS cluster and a Linux one, and a prefix scan or
-- an `offset` window would silently differ between them. The primary key
-- indexes `path` in the cluster's own collation; this is the one that serves
-- `ORDER BY path COLLATE "C"` and `left(path, n) = prefix`, and (path, line_no)
-- is also "every task in this note, in the order they appear".
CREATE INDEX IF NOT EXISTS vault_tasks_path_idx   ON vault_tasks (path COLLATE "C", line_no);
-- task_key without a path: what `POST /api/vault-tasks/:task_key/check`
-- (P2-3) is handed, and what `duplicate_of` and `recur_parent` point at.
CREATE INDEX IF NOT EXISTS vault_tasks_key_idx    ON vault_tasks (task_key);
-- The anchor a `![[note#^mt-7x2k]]` names, resolved without knowing the note.
CREATE INDEX IF NOT EXISTS vault_tasks_anchor_idx ON vault_tasks (anchor)             WHERE anchor IS NOT NULL;
-- The rule lines (§4), which are never themselves tasks: `vault_tasks_recurring`
-- reads them by what falls due next.
CREATE INDEX IF NOT EXISTS vault_tasks_recur_idx  ON vault_tasks (recur_next)         WHERE recur_rule IS NOT NULL;
-- "One open instance per rule, ever" (§4): the `recurring` directive asks
-- whether this rule's previous instance is still unchecked before it renders
-- another.
CREATE INDEX IF NOT EXISTS vault_tasks_recur_parent_idx ON vault_tasks (recur_parent) WHERE recur_parent IS NOT NULL;

-- Block-anchored references, because `knowledge_links` cannot hold them:
-- `extractLinks` strips `#` and `^` from every target
-- (apps/reconciler/src/notes.ts) and `knowledge_links`' primary key is
-- (from_path, to_path, kind), so widening it would be a destructive
-- migration and this repo's migrations are additive-first. A second derived
-- table is additive, and it is derived on exactly the same terms as the
-- first: the walk parses these out of the note bodies on every pass.
CREATE TABLE IF NOT EXISTS vault_task_refs (
    from_path text NOT NULL,   -- derived: the note doing the referring
    to_path   text NOT NULL,   -- derived: the note holding the task
    anchor    text NOT NULL,   -- derived: the ^mt-… it names, without the caret
    kind      text NOT NULL,   -- derived: wikilink | embed
    PRIMARY KEY (from_path, to_path, anchor, kind)
);

COMMENT ON TABLE vault_task_refs IS
  'Derived in full: one row per block-anchored reference to a task line (`[[note#^mt-…]]`, `![[note#^mt-…]]`), which knowledge_links cannot represent because extractLinks strips the anchor. Rebuilt by the reconciler''s walk.';

-- "Which notes point at the tasks in this one" — the Pages strip (§10) and
-- the plan's transclusions. The (from_path, …) direction is the primary key's.
CREATE INDEX IF NOT EXISTS vault_task_refs_to_idx ON vault_task_refs (to_path, anchor);
