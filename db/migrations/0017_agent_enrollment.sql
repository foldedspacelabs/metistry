-- 0017_agent_enrollment — approve-before-enroll for REMOTE agents (S2,
-- docs/research/2026-09-13-google-sam-review.md ADOPT 2).
--
-- SAM's `join` leaves an enrollment PENDING until an administrator
-- approves; the credential surface staying in the user's hand is invariant
-- 2, so the same rule belongs here. A row minted with `remote = true`
-- holds a real token that authenticates NOTHING until the owner approves
-- it: `authenticateAgent` refuses it, so `/mcp` and `/capture` answer the
-- same uniform 401 an unknown token gets.
--
-- Additive, and the default is the behaviour every existing row already
-- has: `remote` defaults false, so nothing minted before this migration
-- becomes pending, and a loopback-only tool (`metistry connect cursor`
-- without --remote) stays immediate.
--
-- DURABLE (invariant 1 / D6): both columns are user decisions about a
-- credential — the same durability class as `grants` and `revoked_at`.
ALTER TABLE agents
    ADD COLUMN IF NOT EXISTS remote      boolean     NOT NULL DEFAULT false, -- durable: the token will be presented from off this machine
    ADD COLUMN IF NOT EXISTS approved_at timestamptz;                        -- durable: when the owner let it in; NULL + remote = pending

-- Pending rows are the enrollment queue; the index keeps the registry list
-- and the approve verb cheap without a scan as the crew list grows.
CREATE INDEX IF NOT EXISTS agents_pending_idx
    ON agents (created_at DESC) WHERE remote AND approved_at IS NULL AND revoked_at IS NULL;
