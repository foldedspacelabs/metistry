-- 0027_proposal_group_and_source — a request can mirror something that lives
-- somewhere else, and several requests can be one card (plan §2.9, §2.12,
-- ticket T1-8; K15, R7, R12).
--
-- Why: a pull request waiting on the owner's review, an invitation, an issue
-- assigned to them — each is a MIRROR: the thing itself lives at its source,
-- and the request is only the owner's view of it. Two facts follow, and this
-- file makes both true at the database rather than in each sync:
--
--   * One subject, one row. A sync that sees the same PR on every pass, and an
--     agent that raises the same PR through `requests_create`, must not fill
--     the queue with copies. `source` names the subject — {kind, external_ref,
--     person} — and a UNIQUE partial index on (kind, external_ref) over the
--     pending rows refuses the second. `raiseMirror` in
--     packages/core/src/mirrors.ts inserts with ON CONFLICT … DO NOTHING and
--     hands back the first row's id, so two raises for one PR make one row.
--     Partial on `decision = 'pending'` on purpose (0022's reasoning): once the
--     mirror is answered or cleared, the next raise is a NEW question — the PR
--     was pushed again, the invitation re-sent — and gets its own row.
--   * A mirror clears with its source, never with the calendar. The morning
--     brief expires every pending row after 14 days (K15); a mirror is exempt,
--     because the review is still owed while the PR is open. It leaves the
--     queue as `decision = 'resolved_at_source'` when the source changes
--     (`resolveAtSource`). `decision` is free text (0002), so that value needs
--     no DDL.
--
-- `group_id` is the meeting card (R12): note, to-do and transcript rows raised
-- from one session share it and are answered together, one decision per row
-- (Accept All). Free text, minted by whatever raises the group; no table of
-- groups, because a group is nothing but the rows that carry its id.
--
-- The shape CHECK is what makes the index a control and not a hope: a
-- `source` without an `external_ref` would never collide in the unique index
-- (NULLs are distinct) AND would be exempt from expiry — a row that could be
-- raised forever and never leave. So a non-null `source` must be an object
-- with a non-empty string `kind` and `external_ref`, and `person`, when
-- present, a string or null.
--
-- Additive: two nullable columns, one CHECK over a column every existing row
-- holds as NULL (so it validates without touching a row), two partial
-- indexes. Every statement is idempotent, so applying the file twice is a
-- no-op the second time even outside the runner's own bookkeeping.
--
-- Durability (invariant 1, D6): DURABLE. `source` and `group_id` are part of
-- the request row the owner answers; they ride in the nightly dump with the
-- rest of `proposals`. A rebuild's first sync would re-raise the still-open
-- mirrors, but not the history of which were answered and which cleared.
--
-- ROLLBACK NOTE (nothing here is destructive): before rolling back, anything
-- raising mirrors must stop, because without the index a sync raises a copy
-- per pass. Then:
--   DROP INDEX IF EXISTS proposals_group_idx;
--   DROP INDEX IF EXISTS proposals_source_pending_uidx;
--   ALTER TABLE proposals DROP CONSTRAINT IF EXISTS proposals_source_shape;
--   ALTER TABLE proposals DROP COLUMN IF EXISTS group_id, DROP COLUMN IF EXISTS source;
-- and the old morning brief expires open mirrors after 14 days again. Rows
-- already `resolved_at_source` keep that decision: it is a word, not a type.

ALTER TABLE proposals ADD COLUMN IF NOT EXISTS group_id text;   -- durable: the card several rows are answered as (a meeting's session); NULL = its own card
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS source   jsonb;  -- durable: {kind, external_ref, person} — what this request mirrors; NULL = not a mirror, expires after 14 days

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'proposals_source_shape' AND conrelid = 'proposals'::regclass) THEN
    -- coalesce(…, false): a CHECK passes on NULL, and `{}`->'kind' is NULL —
    -- without it the very row this constraint exists to refuse gets in.
    ALTER TABLE proposals ADD CONSTRAINT proposals_source_shape CHECK (
      source IS NULL OR coalesce(
            jsonb_typeof(source) = 'object'
        AND jsonb_typeof(source->'kind') = 'string'         AND btrim(source->>'kind') <> ''
        AND jsonb_typeof(source->'external_ref') = 'string' AND btrim(source->>'external_ref') <> ''
        AND coalesce(jsonb_typeof(source->'person'), 'null') IN ('string', 'null'),
      false)
    );
  END IF;
END
$$;

-- One pending row per mirrored subject — the plan's index, expression for
-- expression, so `ON CONFLICT ((source->>'kind'), (source->>'external_ref'))
-- WHERE decision = 'pending'` infers it. Rows with no source index as NULLs
-- and never collide.
CREATE UNIQUE INDEX IF NOT EXISTS proposals_source_pending_uidx
  ON proposals ((source->>'kind'), (source->>'external_ref'))
  WHERE decision = 'pending';

-- A group's rows, in the order they were raised: the card reads them and
-- Accept All answers them one per row, in order.
CREATE INDEX IF NOT EXISTS proposals_group_idx
  ON proposals (group_id, ts, id)
  WHERE group_id IS NOT NULL;
