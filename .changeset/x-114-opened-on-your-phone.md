---
"@foldedspacelabs/metistry-core": minor
"@foldedspacelabs/metistry-cli": minor
"@metistry-apps/console": minor
"@metistry-apps/macos": minor
---

Add a Phone sees the phone arrive (design-build-plan §2.23 step 7, X-114). Migration `0040` gives `auth_enrollment_codes` `opened_at` and `opened_via`: `POST /auth/enroll/start` with a live code now stamps which console listener answered it — `proxy` (the one a provider is pointed at, so the request came from outside) or `main` (loopback) — audited once as `auth` · `enroll_opened`. A `proxy` stamp replaces a `main` one and nothing replaces `proxy`; stamping never spends the code, and an unknown, used, expired or cancelled code stamps nothing. `metistry enroll --status <code_id> [--json]` reads it back (read-only; the id, never the code). The Mac's Add a Phone sheet polls it and turns to *Opened on your phone* — "Your phone reached this Mac through <provider>" — between *Ready* and *Added* for `proxy` only, and an expiry without it says the phone did not reach the origin and what to try on the phone. The poll is bounded: it runs only while the event stream is down and stops when the sheet closes; and the sheet now cancels a live code when its window is closed from under it, not only when Done is pressed.
