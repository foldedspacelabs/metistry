---
"@foldedspacelabs/metistry-mcp-eventkit": minor
"@foldedspacelabs/metistry-core": patch
"@metistry-apps/collectors": minor
"@metistry-apps/console": minor
---

**Calendar fields and the meeting note (T2-11).** The eventkit helper's
`list_events` now reads each event's participants (name, address, answer, role,
kind, whether it is the owner), organizer, iCalendar UID and recurrence, and
the window it read; the invite body only when a request asks for it, which the
bridge never does. `GET /events` keeps every existing field (`attendees` is
still the list of names) and adds `event_id` — one occurrence: the identifier,
plus the occurrence's original date when the event recurs — `series_id`,
`ical_uid`, `participants`, `organizer`, `self_status` and `window`; it never
carries `notes`, even from a helper that sends them. **The helper's binary
changed: rebuild and re-sign it (`build:helper`), restart the calendar service,
and re-grant Calendar if macOS asks.**

Migration `0034_calendar_events.sql` adds `calendar_events` (one row per
occurrence, every source, no invite-body column) and `sync_state`, both
derived. A new sync, `eventkit-calendar` (every 5 min, today and the next two
weeks, connection `eventkit`), fills it and removes a meeting cancelled inside
the window. Two route-only named queries read it: `day_events` (one day in the
owner's zone, every source, each attendee's one People page or none, the
meeting note) and `calendar_event` (one event by id).
`POST /api/meetings/:event_id/note` is served: it renders the owner's
`Templates/Meeting.md` as `user` into `Journal/Meetings/<date>-<topic>.md` with
`event_id:` in the frontmatter, once per event — every later call answers the
first note's path.
