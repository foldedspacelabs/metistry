-- 0014_capture_idempotency — a retried POST /capture returns the row the
-- first attempt made, never a second one (docs/ops/console-api.md).
--
-- The phone's outbox drains opportunistically with no guaranteed wake
-- (docs/research/2026-09-11-multi-instance-and-offline-client.md), so the
-- same capture can arrive twice: once when the response was lost, once on
-- retry. The key is minted by the client before the first attempt and never
-- regenerated. Scoped to the presenting principal so two credentials can
-- never collide on a key, and kept on the inbox row itself — the row IS
-- the stored response (id, path, sha256), and inbox rows are permanent, so
-- the ≥7-day retention the contract promises holds by construction.
-- Additive (columns nullable; every existing door leaves them NULL).
ALTER TABLE inbox
    ADD COLUMN IF NOT EXISTS idempotency_principal text,  -- derived: `user` | `owner_token` | `agent:<id>`
    ADD COLUMN IF NOT EXISTS idempotency_key       text;  -- derived: caller-supplied, ≤200 chars
CREATE UNIQUE INDEX IF NOT EXISTS inbox_idempotency_uidx
    ON inbox (idempotency_principal, idempotency_key) WHERE idempotency_key IS NOT NULL;
