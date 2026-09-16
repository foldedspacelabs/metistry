-- The inbox moved into the vault (2026-09-16): captures live at
-- `Knowledge/Inbox/` so Obsidian — whose vault root is `Knowledge/` — can
-- see, edit and add them, and so git carries them (invariant 1: the inbox
-- now survives a rebuild). `inbox.path` keeps the semantics
-- 0001_init.sql always declared, REPO-RELATIVE, and starts actually holding
-- one: `Knowledge/Inbox/<file>` instead of the bare filename the capture
-- path used to store.
--
-- Additive only. Existing rows are rewritten by `metistry migrate-inbox`
-- (packages/cli/src/migrate-inbox.ts) alongside the files they point at,
-- because moving the files is a git operation in the instance repo and only
-- the reconciler/CLI may do that — a SQL migration must never leave rows
-- pointing at files that did not move. Rollback: drop the index below.

-- One row per inbox file, whoever wrote it. Two writers now reach the same
-- directory — the capture path (console, bridge tool, collectors) and the
-- reconciler's scan, which indexes anything a human or a `git pull` puts
-- there — and this is what makes the second of them refine the first's row
-- instead of creating a duplicate (capture.ts's ON CONFLICT target).
--
-- Partial by design: pre-move rows hold bare filenames and are left alone,
-- so applying this to a live database can never fail on historical data.
CREATE UNIQUE INDEX IF NOT EXISTS inbox_vault_path_uidx
    ON inbox (path) WHERE path LIKE 'Knowledge/Inbox/%';

COMMENT ON COLUMN inbox.path IS
    'File this triage row is about, relative to the instance repo root: Knowledge/Inbox/<file> (docs/ops/inbox.md). Pre-2026-09-16 rows hold a bare filename relative to the old inbox/ directory.';
