-- 0042_connection_answers — the whole of a folded upstream answer, kept for
-- the caller that asked (plan §2.6; X-132, the Context Mode review's CM-6,
-- allowed by the owner 2026-10-04).
--
-- `connections_call` folds an upstream answer over the proxy's threshold —
-- a listing to its first items, its last and a count; a log to its lines
-- and counts; anything else to a head and a tail
-- (packages/mcp-brain/src/connection-fold.ts) — and writes the answer itself
-- here, keyed by the call's own `runs` row. That id is the HANDLE the caller
-- is told, and `connections_call { page: "<handle>/<n>" }` reads the answer
-- back one page at a time (connection-answers.ts). `principal` is the caller
-- that made the call, and the read is `WHERE run_id = … AND principal = …`:
-- another principal presenting the handle matches nothing — the row's own
-- guard, in SQL, not a sentence in a prompt.
--
-- `run_id` is `runs.id` by convention and NOT a foreign key: `runs` is the
-- ledger and is pruned on its own terms; a stored answer that outlives its
-- row is still readable until it expires, and one whose row is gone first is
-- just a row nobody asks for.
--
-- Durability: DERIVED, EPHEMERAL (invariant 1) — a cache of what an upstream
-- said, readable for `METISTRY_CONNECTION_ANSWER_KEEP_HOURS` (default 24).
-- Every write deletes the expired rows first, so the table purges itself on
-- use. `docker compose down -v` loses every row and nothing notices: the
-- call's record is its `runs` row (`bytes_in`, `bytes_out`, the handle), the
-- upstream still has the answer, and a caller asks again.
--
-- Additive-first (CLAUDE.md): one new table, nothing rewritten. Idempotent:
-- `IF NOT EXISTS` throughout, so `metistry update` can apply it twice under
-- its advisory lock.
--
-- ROLLBACK: `DROP TABLE IF EXISTS connection_answers;` — safe unconditionally.
-- Nothing references this table, and losing it loses only pages a caller
-- could re-dial.

CREATE TABLE IF NOT EXISTS connection_answers (
    run_id      bigint      PRIMARY KEY,                -- runs.id of the connection_call that dialled — the handle
    principal   text        NOT NULL,                   -- runs.component: the only caller that may read it back
    connection  text        NOT NULL,                   -- the connection and the upstream tool the answer came from…
    tool        text        NOT NULL,                   -- …so a page read names them too, and a mismatch is not_found
    answer      jsonb       NOT NULL,                   -- {content, structuredContent?} — REDACTED by the pool before it lands here
    bytes       integer     NOT NULL,                   -- the answer's bytes on the wire, whole
    created_at  timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL                    -- set by the writer: now() + METISTRY_CONNECTION_ANSWER_KEEP_HOURS
);

COMMENT ON TABLE connection_answers IS
  'Ephemeral — the whole of an upstream answer connections_call folded, keyed by the call''s runs row and readable by page only by the principal that made it (X-132). Expired rows are deleted on the next write; lost on docker compose down -v and missed by nothing.';

-- The writer's purge and the reader's "unexpired" filter both scan by expiry.
CREATE INDEX IF NOT EXISTS connection_answers_expires_idx ON connection_answers (expires_at);
