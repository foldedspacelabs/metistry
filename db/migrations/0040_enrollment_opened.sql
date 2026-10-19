-- 0040_enrollment_opened — the phone reached the Mac with this code, and through
-- which listener (design-build-plan §2.23 *Set Up Remote Access* step 7; ticket
-- X-114; ruled 2026-09-30).
--
-- `POST /auth/enroll/start` with a LIVE code stamps the row: `opened_at` is when
-- the phone's request arrived and `opened_via` names the console listener that
-- answered it — `proxy` (the listener a provider is pointed at, so the request
-- came from outside) or `main` (loopback, so it did not). Add a Phone's sheet
-- reads them (`metistry enroll --status <code_id>`) and shows *Opened on your
-- phone* only for `proxy`: the proof from outside that the phone reached this
-- Mac. A request through `main` is recorded and never offered as that proof.
--
-- STAMPING IS NOT USING. `used_at` is untouched; the code is still single-use,
-- still dies at `expires_at`, and a second `start` neither consumes it nor
-- weakens it. A `proxy` stamp replaces a `main` one (the owner opening the link
-- on the Mac first must not hide the phone arriving), and nothing replaces a
-- `proxy` stamp.
--
-- NULL on both columns reads as "nothing has opened this code yet" — every row
-- minted before this migration, and every code a phone has not reached.
--
-- DURABLE, like `used_at` (invariant 1): a fact about a credential's life that
-- lives in no other place. The row dies in ten minutes in any case.
--
-- ADDITIVE: two nullable columns, no default, no existing column touched, no
-- row rewritten. `IF NOT EXISTS`, so `metistry update` can apply this twice
-- under its advisory lock and the second pass is a no-op.
--
-- ROLLBACK NOTE: `ALTER TABLE auth_enrollment_codes DROP COLUMN IF EXISTS
-- opened_at, DROP COLUMN IF EXISTS opened_via;` — after reverting apps/console
-- (server.ts), core's `enrollment-codes.ts` and the CLI's `enroll --status`.
-- Nothing indexes or references them. The sheet then never reaches *Opened on
-- your phone*; enrolment itself is unaffected.

ALTER TABLE auth_enrollment_codes
    ADD COLUMN IF NOT EXISTS opened_at  timestamptz, -- durable: when the phone's start arrived; NULL = not yet opened
    ADD COLUMN IF NOT EXISTS opened_via text;        -- durable: 'proxy' | 'main' — the listener that answered it
