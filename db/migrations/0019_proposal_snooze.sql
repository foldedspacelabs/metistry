-- 0019 — "not now" is a state, not a dismissal
-- (docs/research/2026-09-16-taskuary-review.md ADOPT 5, docs/ops/reply-feedback.md).
--
-- Why: Needs You had three answers — Approve, Revise, Decline — and no way
-- to say *not yet*. An item you cannot answer at 07:00 and cannot put down
-- is the queue's only failure mode: it stays at the top, you scroll past it
-- every pull, and the queue stops meaning "these need you".
--
-- `later` gives it an `until` instead of an answer. The row stays
-- `decision = 'pending'` — a snooze NEVER ends a proposal, so nothing
-- downstream (the fold, the weekly review, the auto-expiry) sees a decision
-- that was not made. It is hidden from the pending lists while the clock
-- runs and comes back on its own.
--
-- Additive: one nullable column and one partial index. Nothing is rewritten,
-- no existing row is touched, and every query that does not mention
-- `snoozed_until` behaves exactly as it did.
--
-- Durability (D6): DURABLE. It is the user's hand — "I saw this and it can
-- wait" — and a rebuild from collectors cannot reconstruct it. It joins the
-- nightly dump with the rest of the `proposals` row.
--
-- Rollback note (CLAUDE.md): nothing here is destructive. To reverse, drop
-- the index and then the column; the queue returns to showing every pending
-- row, which is what it did before this file.

ALTER TABLE proposals ADD COLUMN IF NOT EXISTS snoozed_until timestamptz;  -- durable: `later` until this instant; NULL = not snoozed

-- The pending queue's read path, now that "pending" and "showing" are two
-- different questions. Partial on the answer nobody has given yet, so the
-- index stays the size of the queue rather than the size of the history.
CREATE INDEX IF NOT EXISTS proposals_snoozed_idx ON proposals (snoozed_until) WHERE decision = 'pending' AND snoozed_until IS NOT NULL;
