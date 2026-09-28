---
"@metistry-apps/console": patch
---

**`GET /api/messages` carries `turn_id` (ruled 2026-09-27, X-18).** An
outbound row now names the `turn_id` of the `runs` row that produced it —
joined exactly on `runs.meta.message_id` to the reply's own `in_reply_to`,
the same key `run_detail` already joins tool calls on — or `null` where its
turn left none. Additive; `api_version` stays 1. This lets a client hand an
older reply straight to `GET /api/turns/:turn_id/progress` for its tool
strip, without needing it to fall inside a recent-activity window first.

Migration `0037_runs_turn_message_id_idx.sql` adds the partial expression
index the join needed — `runs ((meta ->> 'message_id')) WHERE kind = 'turn'`
— so this route's join is an index scan against `runs`, not a sequential
one over the whole (unbounded) ledger.
