-- 0038_passkey_revocation — a removed device's passkey never signs in again
-- (design-build-plan §2.22, Devices; X-76).
--
-- A device is a passkey, with its sessions under it. Until now Remove in
-- Devices (`POST /api/devices/:id/revoke`) ended one session row and the
-- passkey stayed valid, so a lost phone could sign straight back in. This
-- column is the revocation: `getPasskey` (apps/console/src/auth-store.ts)
-- refuses a row with `revoked_at` set with the same uniform 401 as an unknown
-- credential, and `checkSession` refuses every session whose passkey is
-- revoked, so a session issued in the instant between a login's lookup and
-- the revoke is dead too. Sign Out Everywhere keeps its meaning — sessions
-- only — and never writes this column.
--
-- Durability: DURABLE (invariant 1), like `auth_sessions.revoked_at` — a
-- revocation the owner made must survive, and git holds no copy of it. It is
-- in the backed-up set because `passkeys` is; a rebuild from the repo without
-- a backup loses every passkey, revoked or not, and the owner enrols again.
--
-- Idempotent: `ADD COLUMN IF NOT EXISTS`, so `metistry update` can apply this
-- twice under its advisory lock and the second pass is a no-op.
--
-- ROLLBACK (loses which devices were removed — every passkey is valid again):
--   ALTER TABLE passkeys DROP COLUMN IF EXISTS revoked_at;

ALTER TABLE passkeys ADD COLUMN IF NOT EXISTS revoked_at timestamptz;

COMMENT ON COLUMN passkeys.revoked_at IS 'set when the device was removed (§2.22); a revoked passkey is refused at login exactly like an unknown one';
