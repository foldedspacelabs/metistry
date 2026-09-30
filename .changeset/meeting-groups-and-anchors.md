---
"@foldedspacelabs/metistry-core": minor
"@metistry-apps/collectors": patch
"@metistry-apps/console": patch
---

A recording is one card in Needs You, and the jots made during it find their place (T8-7; C77, C81). Core gains `meeting-group.ts`: `meetingGroupId(session)` (`meeting:<session id>`), `recordedSessionOf` (a transcript's session, from its frontmatter), `jotAnchorOf` and `promoteJotAnchor` (a jot's `capture_session` line rewritten to `source: "meeting:<transcript path>"`, only into `Journal/Transcripts/`, proved by parsing its own output) and `pickMeetingEvent` (the timed, not-declined calendar event a recording overlapped the most). The inbox drain opens the card from an owner credential's transcript — `group_id` plus `payload.meeting`, named from the calendar through `day_events` — and settles the owner's `kind: jot` captures with their anchor and no proposal; an agent's capture that claims either is an ordinary capture. The console serves `group_id` on `GET /api/proposals`, and Approve of a meeting's transcript promotes that session's jots through the vault bridge as `user`, compare-and-swap, before the row is settled, answering and keeping an `anchored` receipt. Accept All stays one `allow` per row.
