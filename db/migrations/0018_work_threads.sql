-- 0016 — a thread can hang on a `work` row, and a proposal can name the work
-- row it came from (docs/research/2026-09-12-agent-room-review.md phase 2,
-- docs/ops/threads.md). Additive: two nullable columns, three indexes, two
-- check constraints. Nothing is rewritten and no table is dropped.
--
-- Why: every agent-to-agent message today is anchored to an artifact
-- VERSION, so two agents cannot negotiate scope before a deliverable
-- exists. The task that will carry the work is the room. Reusing
-- `artifact_comments` rather than a second table keeps ONE escalation
-- rule (`pingPongDemotes`, cap 10 consecutive agent turns → a proposal for
-- the user), one resolve semantics, and one console renderer.
--
-- The safety property is structural: a work thread has no addressee
-- column, here or in the tool surface, so a message cannot wake a named
-- agent (the collaboration rule — a channel is safe when it cannot
-- address). Agents read the room when they claim the row.
--
-- Durability (D6): `artifact_comments` was already DURABLE (fine-grained
-- mutable state with no upstream copy) and joins the nightly dump.
-- `proposals.work_id` is DURABLE for the same reason the row is.
--
-- Rollback note (CLAUDE.md, "destructive migrations need a rollback
-- note"): nothing here is destructive, but it does LOOSEN two NOT NULLs so
-- a comment can have a work parent instead of an artifact one. To reverse:
-- DELETE the work-anchored rows (work_id IS NOT NULL), drop the two checks
-- and the three indexes, drop both columns, then re-assert
-- `ALTER TABLE artifact_comments ALTER COLUMN artifact_id SET NOT NULL`
-- (and version_id). No pre-0016 row is touched by any statement below.

-- The second anchor. Exactly one parent, enforced below.
ALTER TABLE artifact_comments ADD COLUMN IF NOT EXISTS work_id bigint REFERENCES work (id);  -- durable: the `work` row this thread hangs on; NULL for an artifact thread
ALTER TABLE artifact_comments ALTER COLUMN artifact_id DROP NOT NULL;
ALTER TABLE artifact_comments ALTER COLUMN version_id  DROP NOT NULL;

-- ADD CONSTRAINT has no IF NOT EXISTS; the migration runner applies each
-- file once (schema_migrations), and the guard keeps a hand re-run safe.
DO $$
BEGIN
  -- exactly one parent: an artifact version OR a work row, never both, never neither
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'artifact_comments_one_parent') THEN
    ALTER TABLE artifact_comments
      ADD CONSTRAINT artifact_comments_one_parent
      CHECK ((artifact_id IS NOT NULL) <> (work_id IS NOT NULL));
  END IF;
  -- an artifact thread is still on an EXACT version (0010's rule, kept now that the NOT NULL is gone)
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'artifact_comments_version_with_artifact') THEN
    ALTER TABLE artifact_comments
      ADD CONSTRAINT artifact_comments_version_with_artifact
      CHECK ((artifact_id IS NULL) = (version_id IS NULL));
  END IF;
END
$$;

-- The read path: one room per work row, oldest first (the thread is read newest-last).
CREATE INDEX IF NOT EXISTS artifact_comments_work_idx ON artifact_comments (work_id, created_at) WHERE work_id IS NOT NULL;
-- ONE room per work row: the root is unique, so two agents appending at the
-- same instant cannot open two rooms on one task. The loser of the race
-- retries as a reply (packages/artifacts `workComment`).
CREATE UNIQUE INDEX IF NOT EXISTS artifact_comments_work_root_uidx ON artifact_comments (work_id) WHERE work_id IS NOT NULL AND parent_id IS NULL;

-- The link the board could not make: no proposal kind carried a work id, so
-- "which proposal is about this card" had no answer (docs/ops/board.md).
-- Set server-side wherever a proposal is created FROM a work row — a work
-- thread past the ping-pong cap, and anything a crew run reported while it
-- held the row. Never a tool argument.
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS work_id bigint REFERENCES work (id);  -- durable: the work row this proposal came from; NULL when it came from elsewhere
CREATE INDEX IF NOT EXISTS proposals_work_idx ON proposals (work_id, ts DESC) WHERE work_id IS NOT NULL;
