---
"@foldedspacelabs/metistry-core": minor
"@metistry-apps/assistant": minor
"@metistry-apps/routines": minor
"@metistry-apps/console": minor
---

The session archive is written (T3-9). The engine appends every finished turn — chat and machine-enqueued alike — to `session_archive`: the system prompt as sent, the messages that turn added, and each tool call with its arguments and result, all through `core/redact.ts` inside the store itself (`apps/assistant/src/archive.ts`), with `expires_at` 30 days out and `folded_at` NULL (the session fold's queue). The turn handle is minted by the drain before the call, so the in-flight `runs` row, every tool call's `_meta` and the archived row share one `turn_id`; the turn row also carries `meta.session_id`. A failed archive write never fails a turn — it lands in the run's notes. The new `session-purge` routine (daily) deletes what has expired and anything older than its `retention_days` (Scheduled config, 1–30, default 30; anything else is refused with the field named). `POST /api/sessions/purge` (reach `local`, served) is Purge Now: without `confirm: true` it deletes nothing and names the sessions not yet folded; with it, it deletes every archived turn up to the preview's `as_of`, audited.
