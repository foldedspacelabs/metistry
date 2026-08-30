-- 0003_auth_enrollment — one-time passkey enrollment codes (§4.2 bootstrap).
-- Minted host-side (metistry enroll / init), single-use, minutes-lived.
-- Stored hashed like every other credential: a DB read yields nothing usable.
-- POST /message lands here BEFORE the 202 (SHOULD-7): a message sent
-- during an assistant restart is never lost. The assistant drains
-- status='new'; the drain step also hosts the deterministic pre-check.
CREATE TABLE inbound_messages (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ts         timestamptz NOT NULL DEFAULT now(),
    thread     text        NOT NULL DEFAULT 'default',
    text       text        NOT NULL,
    status     text        NOT NULL DEFAULT 'new', -- new | processing | done | failed
    session_id uuid,                               -- filled when a session picks it up
    meta       jsonb       NOT NULL DEFAULT '{}'
);
CREATE INDEX inbound_messages_drain_idx ON inbound_messages (status, ts);

CREATE TABLE auth_enrollment_codes (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code_hash  text        NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    used_at    timestamptz
);
