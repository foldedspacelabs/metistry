-- 0008 — tasks module (plan §4.20, first Phase 5 piece). Additive on `work`
-- (CLAUDE.md: additive-first). The claim/lease/dependency columns already
-- landed in 0002; this adds what the shared task list needs on top:
-- project scope, caller-supplied idempotency, an append-only per-task
-- history, attribution, and closure time.
--
-- Durability (open decision D6): each column is marked durable or derived.
-- Everything here is durable — it is agent-authored state with no
-- upstream source to rebuild from.

ALTER TABLE work ADD COLUMN IF NOT EXISTS project text;                          -- durable: collaboration boundary (§4.19); NULL = the user's default project
ALTER TABLE work ADD COLUMN IF NOT EXISTS idempotency_key text;                  -- durable: caller-supplied; a retried create returns the existing row
ALTER TABLE work ADD COLUMN IF NOT EXISTS history jsonb NOT NULL DEFAULT '[]';   -- durable: append-only [{ts, agent, op, note?, status?}] — agent is server-side identity, never self-declared
ALTER TABLE work ADD COLUMN IF NOT EXISTS created_by text;                       -- durable: principal that created the row (server-side identity)
ALTER TABLE work ADD COLUMN IF NOT EXISTS closed_at timestamptz;                 -- durable: set once when status becomes 'closed'

CREATE UNIQUE INDEX IF NOT EXISTS work_idempotency_key_uidx ON work (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS work_project_status_idx ON work (project, status);
