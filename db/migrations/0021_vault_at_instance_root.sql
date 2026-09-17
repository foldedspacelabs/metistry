-- 0021_vault_at_instance_root — the instance directory IS the Obsidian vault
-- (owner's ruling 2026-09-17). Vault content moves from `Knowledge/…` to the
-- instance root, so captures live at `Inbox/<file>` and notes at
-- `Areas/…`, `Journal/…`, `now.md`.
--
-- Additive only, and deliberately so. `inbox.path` and `knowledge_files.path`
-- are strings; nothing here rewrites a single row. Rewriting them is the
-- MIGRATION VERB's job (a follow-up PR), for the same reason 0015 gave: the
-- files move in the instance repo through git, only the reconciler/CLI may do
-- that, and a SQL migration must never leave rows pointing at files that did
-- not move. A legacy instance keeps working unchanged until the verb runs.
--
-- What this file adds is the one thing the code cannot do without: a partial
-- unique index matching capture.ts's new ON CONFLICT target. Postgres infers
-- a conflict target from an index, so the predicate in the statement and the
-- predicate here must be the same string.
--
-- Rollback: `DROP INDEX inbox_root_inbox_path_uidx;`. The pre-existing
-- `inbox_vault_path_uidx` is untouched and still covers legacy rows.

CREATE UNIQUE INDEX IF NOT EXISTS inbox_root_inbox_path_uidx
    ON inbox (path) WHERE path LIKE 'Inbox/%';

COMMENT ON COLUMN inbox.path IS
    'File this triage row is about, relative to the instance directory (which is the vault): Inbox/<file> (docs/ops/inbox.md). Rows written before 2026-09-17 hold Knowledge/Inbox/<file>; rows before 2026-09-16 hold a bare filename.';
