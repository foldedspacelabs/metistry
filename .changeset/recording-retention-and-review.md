---
"@foldedspacelabs/metistry-mcp-live-capture": minor
"@foldedspacelabs/metistry-core": minor
"@foldedspacelabs/metistry-mcp-brain": minor
"@metistry-apps/console": minor
"@metistry-apps/routines": minor
"@metistry-apps/collectors": patch
---

**A recording's retention and re-review (T8-4).** The recorder helper keeps a session's audio (and frames) until its transcript is ingested plus 7 days, never more than 30 days after it ended, and deletes this Mac's transcript copy at 30 days once delivered — on its own hourly clock, so the ceiling needs no console. The bridge gains `recording_review` (`GET /recording/review`, its third tool): a span of kept audio re-transcribed at the careful setting, answered as text with timestamps rebuilt field by field, never audio; after deletion it says when and why, and that the transcript remains. It joins core's `CREW_NEVER_TOOLS`. `POST /recording/retention` (bridge token, not a tool) takes the console's ingestion report, clamped to the delivery and to now; `POST /recording/purge` is Purge Now on the control credential. A Window / Screen session's frames (`screen.mp4`) go with its audio, and a span after a sleep is read from the file that holds it (`app-2.m4a`…), placed by when it was created.

**Transcripts are filed at `Journal/Transcripts/<date>-<session>.md`** (Q29, X-73 folded in): an owner credential's transcript capture is placed there, create-only, in the owner's name, and records its `capture_sessions` row (migration 0033). `Journal/Transcripts/` is outside every default read grant — core's `underAreas` and mcp-brain's SQL `areaFilter` say the same thing. A capture can be placed at an exact path (`captureToInbox`'s `place`). The console serves `GET /api/recordings/:id` (owner reach) through the route-only `recording_state` query, and the hourly `recording-retention` routine rebuilds rows from the vault, records ingestion from the transcript's proposals, reports it to the Mac, and deletes a transcript on its 30th day as a commit in the owner's name, clearing its words from the inbox row and proposal. The crashed-recording report says where the transcript is saved.
