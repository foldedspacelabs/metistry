-- 0007_agents — the external-agent registry (§4.2 management surface,
-- §4.11 read tiers, §4.19 trust rules). Per-agent bearer tokens, stored
-- ONLY as SHA-256 hashes like every other credential; grants attach to
-- the token server-side and are never asserted by the agent. Additive.
--
-- DURABLE (invariant 1 / D6): unlike the collector-derived tables, nothing
-- here can be rebuilt from the repo — a token hash is the only proof an
-- agent holds a credential, and grants are user decisions. Back it up.
CREATE TABLE IF NOT EXISTS agents (
    id           text        PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9-]{0,39}$'), -- durable: slug, stamped on every proposal
    display_name text        NOT NULL,                                          -- durable
    kind         text        NOT NULL DEFAULT 'external',                       -- durable: external | internal
    token_hash   text        NOT NULL UNIQUE,                                   -- durable: SHA-256 of the bearer; never plaintext
    grants       jsonb       NOT NULL DEFAULT '{"tier":"none","areas":[]}',     -- durable: {tier: none|index|areas, areas: [Knowledge/... prefixes]}
    projects     text[]      NOT NULL DEFAULT '{}',                             -- durable: §4.19 project membership
    created_at   timestamptz NOT NULL DEFAULT now(),                            -- durable
    last_seen_at timestamptz,                                                   -- durable: bumped on every authenticated call
    revoked_at   timestamptz                                                    -- durable: a revoked token never authenticates again
);

-- Capture provenance (§4.11): a capture made with an agent token records
-- WHICH agent, from the credential — never from the body. `source` keeps
-- its transport meaning (http | note | ...); identity gets its own column
-- so inbox-drain can stamp the proposal's source_agent/trust from it.
ALTER TABLE inbox ADD COLUMN IF NOT EXISTS source_agent text; -- references agents.id; NULL = the owner
