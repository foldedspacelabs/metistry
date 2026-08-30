-- 0002_review_decisions — the calcify-now schema from the 2026-08-29 review
-- (docs/plan-review-2026-08-29.md): unified proposals (D7), two-phase runs
-- (CRIT-8), hub claim/lease/dependency columns (reserved for Phase 5), and
-- the owner-auth tables (§4.2 passkeys design). Additive-first per CLAUDE.md.

-- Two-phase runs: insert at start, update at completion, so a hung or
-- crashed call is visible in flight rather than absent (CRIT-8). `ok` is
-- unknown until completion, so it loosens to nullable; a row with
-- finished_at IS NULL is in flight.
ALTER TABLE runs ALTER COLUMN ok DROP NOT NULL;
ALTER TABLE runs ADD COLUMN started_at  timestamptz;
ALTER TABLE runs ADD COLUMN finished_at timestamptz;
UPDATE runs SET started_at = ts, finished_at = ts WHERE started_at IS NULL;
CREATE INDEX runs_inflight_idx ON runs (started_at) WHERE finished_at IS NULL;

-- One proposals table for the five queues that were one shape (D7):
-- inbox knowledge proposals, agent reports, draft-note settlement, grant
-- elevations, suggested actions. One triage endpoint, one push path, one
-- brief section. A note's `status: draft` frontmatter marks the same row
-- vault-side.
CREATE TABLE proposals (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ts           timestamptz NOT NULL DEFAULT now(),
    kind         text        NOT NULL,  -- knowledge | report | draft_settle | grant_elevation | action
    source_agent text        NOT NULL,  -- server-side identity, never self-declared (§4.19)
    trust        text        NOT NULL,  -- internal | external | user
    payload      jsonb       NOT NULL,  -- post-redaction content + provenance (source session, machine, refs)
    decision     text        NOT NULL DEFAULT 'pending', -- pending | allow | deny | accept_with_changes | expired
    feedback     text,                  -- routes back to the source agent's inbox on deny/changes
    decided_at   timestamptz
);
CREATE INDEX proposals_pending_idx ON proposals (decision, ts DESC);
CREATE INDEX proposals_source_idx  ON proposals (source_agent, ts DESC);

-- Coordination-hub columns on work (§4.19) — reserved now so Phase 5 needs
-- no rewrite of every emit site. work.claim is atomic over these three.
ALTER TABLE work ADD COLUMN claimed_by       text;
ALTER TABLE work ADD COLUMN lease_expires_at timestamptz;
ALTER TABLE work ADD COLUMN depends_on       bigint[] NOT NULL DEFAULT '{}';
CREATE INDEX work_ready_idx ON work (status, lease_expires_at);

-- Owner auth (§4.2, decided 2026-08-29): passkeys only. Public keys are
-- not secrets; session/owner tokens are stored ONLY as SHA-256 hashes —
-- a database read never yields a usable credential.
CREATE TABLE passkeys (
    id            text        PRIMARY KEY,           -- WebAuthn credential id (base64url)
    public_key    bytea       NOT NULL,
    sign_count    bigint      NOT NULL DEFAULT 0,
    transports    text[]      NOT NULL DEFAULT '{}',
    rp_origin     text        NOT NULL,               -- canonical HTTPS origin it was enrolled on
    label         text        NOT NULL,               -- "Matt's iPhone" — user-facing device list
    created_at    timestamptz NOT NULL DEFAULT now(),
    last_used_at  timestamptz
);

-- Device sessions (named to avoid the assistant's `sessions` table).
-- Lifetime policy (30d idle / 1y absolute, instance-configurable) is
-- enforced server-side per request; the cookie is a pointer, never the
-- authority. Revocation kills the push subscription with the session.
CREATE TABLE auth_sessions (
    id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    token_hash          text        NOT NULL UNIQUE,  -- SHA-256 of the cookie value
    passkey_id          text        NOT NULL REFERENCES passkeys (id) ON DELETE CASCADE,
    created_at          timestamptz NOT NULL DEFAULT now(),
    last_seen_at        timestamptz NOT NULL DEFAULT now(),
    absolute_expires_at timestamptz NOT NULL,
    revoked_at          timestamptz,
    push_subscription   jsonb                          -- web-push sub bound to this device session
);
CREATE INDEX auth_sessions_passkey_idx ON auth_sessions (passkey_id);

-- Host-minted owner access tokens for non-browser callers (§4.2: the
-- capture Shortcut, CLI, scripts — WebAuthn ceremonies don't fit there).
-- Structurally distinct from agent tokens, which get their own table when
-- the agent registry lands (Phase 4/5).
CREATE TABLE owner_tokens (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    token_hash   text        NOT NULL UNIQUE,
    label        text        NOT NULL,                -- "capture shortcut"
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz,
    revoked_at   timestamptz
);
