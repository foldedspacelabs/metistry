-- 0036_vault_tasks_someday — the `someday` token on a task line (design-build-
-- plan §2.11, owner ruling K6; ticket T2-5).
--
-- The Defer door writes either `do <date>` or `someday`, and the filter
-- vocabulary gains a `someday` flag so Today and the templates can tell a
-- task the owner deferred to no day from one nobody has looked at. A flag in
-- `where:` compiles to a predicate of `vault_tasks_query`, so the index has to
-- hold the token: this column is that, and nothing more.
--
-- NUMBER: 0036 was a spare in the reserved table (db/migrations/README.md,
-- plan §2.9); T2-5 claims it in the same PR, as the README says to.
--
-- DERIVED (invariant 1). Like every other column of `vault_tasks` (0024), it
-- is a pure projection of the line: the reconciler's walk writes it from
-- `parseTaskLine(...).someday` on every pass, so `docker compose down -v`,
-- rebuild, one walk, and it is exactly what it was. Nothing to back up.
--
-- ADDITIVE: one column with a default, no row rewritten by hand, no existing
-- column touched. `IF NOT EXISTS`, so applying the file twice is a no-op.
-- Until the first walk after the upgrade every row reads `false`, which is
-- what every row was before the token existed.
--
-- ROLLBACK NOTE: `ALTER TABLE vault_tasks DROP COLUMN IF EXISTS someday;` —
-- after reverting the reconciler's write of it and `vault_tasks_query`'s read.
-- No index, constraint or other table references it.

ALTER TABLE vault_tasks
    ADD COLUMN IF NOT EXISTS someday boolean NOT NULL DEFAULT false; -- derived: the `someday` token — deferred by the owner to no day (K6)
