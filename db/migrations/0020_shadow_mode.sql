-- 0020_shadow_mode — stage-2 shadow mode: what the candidate model would have
-- answered, beside what the assignment actually answered
-- (docs/plan-refresh-2026-09-13.md §3.7 stage 2, docs/ops/compute.md
-- "Shadow mode").
--
-- Additive only: every column is nullable and every row written before this
-- migration keeps its meaning — a turn with no shadow simply has NULLs, which
-- is also how "shadow mode is not configured" reads.
--
-- The shadow's own SPEND is not here. It is an ordinary `runs` row of
-- kind = 'shadow' carrying the shadow provider's name and cost_usd, so the
-- `spend` named query and every budget window count it against the provider
-- that actually served it, with no change to the query at all. The
-- `shadow_cost_usd` column below is the same number denormalised onto the turn
-- for the agreement report — reading it as spend would double-count.
--
-- Rollback: `ALTER TABLE runs DROP COLUMN shadow_provider, DROP COLUMN
-- shadow_model, DROP COLUMN shadow_transcript, DROP COLUMN shadow_agreement,
-- DROP COLUMN shadow_cost_usd; DROP INDEX runs_shadow_ts_idx;` — nothing
-- else references them, and Postgres is derived (invariant 1), so a rebuild
-- loses only the trend line the weekly review reports.

ALTER TABLE runs
    ADD COLUMN IF NOT EXISTS shadow_provider   text,           -- compute.yaml provider NAME that served the shadow
    ADD COLUMN IF NOT EXISTS shadow_model      text,           -- the candidate model id, as the provider knows it
    ADD COLUMN IF NOT EXISTS shadow_transcript jsonb,          -- BOTH transcripts + the agreement measure: { shadow: {…}, real: {…}, agreement: {…} }
    ADD COLUMN IF NOT EXISTS shadow_agreement  numeric(4, 3),  -- 0..1, the deterministic measure (tool-call sequence + token Jaccard); the rubric score is packages/eval's and is not this
    ADD COLUMN IF NOT EXISTS shadow_cost_usd   numeric(10, 6); -- what the shadow cost, denormalised for the report (the kind='shadow' row is what budgets read)

-- "shadow agreement over the last N runs" is the weekly review's question
-- (seed/queries/shadow_agreement.yaml). Partial, because a shadowed turn is a
-- sampled minority of the ledger by design.
CREATE INDEX IF NOT EXISTS runs_shadow_ts_idx ON runs (ts DESC) WHERE shadow_model IS NOT NULL;
