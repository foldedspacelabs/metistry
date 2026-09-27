-- 0030_session_archive — the working conversation itself, kept so Metistry
-- can fold sessions into knowledge, learn preferences and build the profile
-- (docs/product/design/screen-12-run-detail.md §5, owner's ruling
-- 2026-09-22). Every session — chat included — is archived one row per turn:
-- the system prompt as sent, the messages, and the tool calls with arguments
-- and results (redacted through `core/redact.ts` — T3-9, the writer).
--
-- `turn_id` is the same id the assistant stamps on every brain tool call it
-- makes while answering one message (`meta.turn_id`, docs/ops/assistant-tools.md)
-- — the same key `run_detail` (0020) joins tool calls on — so a session's
-- turn can be lined up against its `runs` rows with no time-window guessing.
-- `thread` is the conversation thread name (`default`, …), same vocabulary as
-- `inbox`/`outbound_messages`. `folded_at` is set once the session fold
-- (T3-10) has read the turn; NULL means "not yet folded", which is also how
-- the fold finds its own queue (before expiry).
--
-- Durability: EPHEMERAL (invariant 1) — a 30-day cache in Postgres only,
-- never the record. `docker compose down -v` loses every row here and nothing
-- else notices: the fold (T3-10) turns what matters into knowledge, lessons
-- and profile facts BEFORE a session expires, and those land in git through
-- the vault bridge like everything durable does. §4 Q16 is explicit that the
-- transcript itself is not worth backing up — it is raw material, not the
-- record.
--
-- Additive-first (CLAUDE.md): one new table, nothing rewritten.
--
-- ROLLBACK: `DROP TABLE IF EXISTS session_archive;` — safe unconditionally.
-- Nothing else references this table (no foreign key points at it), and
-- losing it loses only the 30-day transcript cache, which is the same loss
-- `down -v` already causes by design.

CREATE TABLE IF NOT EXISTS session_archive (
    id            bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    session_id    uuid        NOT NULL,               -- runs.session_id — one archived session
    thread        text        NOT NULL,               -- the conversation thread ('default', …)
    turn_id       text        NOT NULL,               -- meta.turn_id — the run_detail join key
    ts            timestamptz NOT NULL DEFAULT now(),
    system_prompt text        NOT NULL,               -- exactly as sent for this turn
    messages      jsonb       NOT NULL,                -- this turn's messages
    tool_calls    jsonb       NOT NULL DEFAULT '[]',   -- {tool, args, result} — redacted before it lands here
    folded_at     timestamptz,                        -- set once the session fold (T3-10) has read this turn; NULL = not yet folded
    expires_at    timestamptz NOT NULL                -- set by the writer (T3-9), 30 days out
);

COMMENT ON TABLE session_archive IS
  'Ephemeral — a 30-day cache of every session''s working conversation, one row per turn (§4 Q16). Lost on docker compose down -v; nothing durable depends on it, because the session fold (T3-10) must turn what matters into knowledge before a row expires.';

-- session_detail's read path (seed/queries/session_detail.yaml): every turn
-- of one session, oldest first.
CREATE INDEX IF NOT EXISTS session_archive_session_idx ON session_archive (session_id, ts);

-- One row per turn, so a retried append (the writer crashing after the
-- insert but before it could tell the engine) cannot duplicate a turn.
CREATE UNIQUE INDEX IF NOT EXISTS session_archive_turn_uidx ON session_archive (session_id, turn_id);

-- The purge routine's (T3-9) and session_detail's own "expired rows are not
-- returned" filter — both scan by expiry.
CREATE INDEX IF NOT EXISTS session_archive_expires_idx ON session_archive (expires_at);

-- The session fold's (T3-10) queue: sessions not yet folded, before expiry.
CREATE INDEX IF NOT EXISTS session_archive_unfolded_idx ON session_archive (ts) WHERE folded_at IS NULL;
