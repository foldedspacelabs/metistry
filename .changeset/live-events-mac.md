---
"@metistry-apps/macos": minor
"@foldedspacelabs/metistry-cli": patch
---

**Live events on the Mac (T5-7).** The app holds one subscription to `GET /api/events` per instance (`ConsoleSession.events`, `LiveEvents`) over the `console session` child, and hands each event to the readers of the store it names — the catalogue's "the client refetches" column as `EventTopic`s. A `SectionModel` built with topics is marked due by exactly its events; `needs_you.changed`'s count drives the Needs You row, the badge and the Dock directly (announced once per change). While the stream is live those readers stop polling on their clocks (a five-minute check stays, for a snooze coming due); while it is down they poll as before, and it reopens on a 3 s → 1 min backoff with `Last-Event-ID`. A `resync`, an unreadable frame or a subscription with nothing to resume from marks every reader due. `metistry console session --stdio` now passes on the console's cursor — the id-only frame a fresh subscriber gets first — as `{id, event: {id}}`; it was dropped, so a stream that was quiet from the start could not resume.
