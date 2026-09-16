-- 0015_compute_engine — cost is a first-class row, and the engine owns its
-- own message history (docs/plan-refresh-2026-09-13.md C12 and §4 PR 3).
--
-- Additive only, as every migration must be: new columns are nullable and
-- every row written before this one keeps its meaning. `runs` already had
-- `model`, `tokens_in`, `tokens_out` and `cost_usd` (0001_init); what it did
-- not have is WHO served the call and what the provider's cache did, both of
-- which the budget and the weekly review now read as columns rather than
-- digging them out of `meta`.
--
-- Rollback: `ALTER TABLE runs DROP COLUMN provider, DROP COLUMN
-- cache_read_tokens, DROP COLUMN cache_write_tokens; DROP TABLE
-- assistant_sessions;` — nothing else references them, and Postgres is
-- derived (invariant 1), so a rebuild loses only trend lines.

ALTER TABLE runs
    ADD COLUMN IF NOT EXISTS provider           text,     -- compute.yaml provider NAME (the first segment of <provider>/<id>)
    ADD COLUMN IF NOT EXISTS cache_read_tokens  integer,  -- prompt tokens served from the provider's cache
    ADD COLUMN IF NOT EXISTS cache_write_tokens integer;  -- prompt tokens written to it, where the provider reports both

-- "what has this provider cost me today" is the budget's question, asked
-- before every call: the index is the one that makes it cheap.
CREATE INDEX IF NOT EXISTS runs_provider_ts_idx ON runs (provider, ts DESC) WHERE provider IS NOT NULL;

-- The OpenAI-compatible engine has no server-side session to resume: the
-- message history IS the session, and it lives here (one row per session,
-- keyed by the same id `sessions` uses, so one thread has one session id
-- across both tables and `rollSession` ends it in both).
--
-- Not a foreign key on purpose: the engine writes this row while the turn is
-- running and the drain upserts `sessions` only after the turn succeeds, so
-- a constraint would order two writes that have no reason to be ordered.
CREATE TABLE IF NOT EXISTS assistant_sessions (
    id             uuid        PRIMARY KEY,               -- the session id, minted by the engine; matches sessions.id
    thread         text        NOT NULL,
    provider       text        NOT NULL,                  -- the provider this history was built against …
    model          text        NOT NULL,                  -- … and the model, so a reassignment starts a fresh session
    messages       jsonb       NOT NULL DEFAULT '[]',     -- the OpenAI-shaped message array, system prompt excluded
    turns          integer     NOT NULL DEFAULT 0,
    created_at     timestamptz NOT NULL DEFAULT now(),
    last_active_at timestamptz NOT NULL DEFAULT now(),
    rolled_at      timestamptz                            -- set by rollSession; a rolled session is never resumed
);
CREATE INDEX IF NOT EXISTS assistant_sessions_thread_idx
    ON assistant_sessions (thread, last_active_at DESC) WHERE rolled_at IS NULL;
