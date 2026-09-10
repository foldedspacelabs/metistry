-- Additive (CLAUDE.md): collector-owned source metadata on work rows —
-- author, url, review requests — so "PRs waiting on my review" is one
-- query across every repo instead of N tabs. Collectors reconcile it
-- from the source (§4.8); nothing invents it.
ALTER TABLE work ADD COLUMN IF NOT EXISTS meta jsonb NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS work_needs_review_idx ON work ((meta->>'needs_my_review')) WHERE kind = 'pr' AND status <> 'closed';
