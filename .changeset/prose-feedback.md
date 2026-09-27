---
"@foldedspacelabs/metistry-core": minor
"@metistry-apps/console": minor
---

**Prose feedback (T1-12; B7 of `today-hub-requests.md`).** A 👍/👎 on any
piece of generated prose that is not a chat reply — a meeting briefing, Next
Up's one line, a revision explanation. `POST|DELETE /api/prose/:id/feedback`
(session · local_owner only, exactly like a reply's rating) keys `:id` on a
`runs.id` rather than minting a second id scheme: every model turn already
logs one row there, so it is the one id already stable wherever prose is
produced. `prose_feedback` (migration `0031_prose_feedback.sql`) is a sibling
of `reply_feedback`, not a widening of it — one upsert per `runs` row,
revisable, deletable, durable. `reply_feedback` and
`POST|DELETE /api/messages/:id/feedback` are unchanged.
