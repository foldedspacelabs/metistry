---
"@foldedspacelabs/metistry-core": minor
"@metistry-apps/console": minor
---

Stale requests (T2-14). A card never acts on something the owner didn't see:
every row `GET /api/proposals` serves carries `subject` — `{basis,
fingerprint}` of what the request is about as it stands (a pull request's head
SHA, a task's line text, the work row's `updated_at`; core's
`requestSubjectOf`) — and `POST /api/proposals/:id` with
`if_unchanged.subject` refuses an answer whose subject has moved: `409 stale`,
before any consequence runs, nothing written on the row, the row repainted in
the body. Opt-in like `seen_at`; the PWA sends it on every single-row answer.
With a subject, `seen_at` no longer counts the work row, so a render's `ts` is
not refused forever once the work row has moved since the row was raised.
