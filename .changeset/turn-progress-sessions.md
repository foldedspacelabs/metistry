---
"@foldedspacelabs/metistry-core": minor
"@metistry-apps/console": minor
---

**Turn progress and sessions (T2-17): `GET /api/turns/:turn_id/progress`,
`GET /api/sessions/:id`.** F-1's two frozen rows are served. The first reads
`turn_progress` — every tool call one assistant turn has made so far, oldest
first; a blank or unknown `turn_id` is `calls: []`, never a refusal. The
second reads `session_detail` — one row per turn of an archived session,
oldest first, narrowed to one turn with `?turn_id=`; a session that has
never existed, expired, or been purged answers `404`. Both fixtures
(`get-api-turns-turn_id-progress.json`, `get-api-sessions-id.json`) are
re-recorded from their hand-written contract shape.
