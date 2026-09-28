---
"@foldedspacelabs/metistry-connections": minor
"@foldedspacelabs/metistry-cli": minor
"@metistry-apps/collectors": minor
"@metistry-apps/console": patch
---

T4-13: CalDAV with replies. A `caldav` calendar connection type, with iCloud
(`icloud-calendar`) and Fastmail (`fastmail-calendar`) as known services that
name their servers, signed in with an app password: read (the
`caldav-calendar` sync writes the owner's two weeks into `calendar_events`,
the owner's own answer as `self_status`), `rsvp` (only the owner's own
ATTENDEE line changes — its PARTSTAT — and the RFC 6638 server delivers the
REPLY) and `write_own` (events nobody else is in). Every change previews
first and is confirmed against the event's ETag with `If-Match`. A Google
address is refused: Google needs sign-in with Google. `openSyncHttp` sends
Basic sign-in — `Basic {{ secret.x }}`, encoded and filled at the egress
door — and `metistry connections add|set` take `--auth basic --username`.
The WebDAV XML subset is hand-rolled (no dependency; a DOCTYPE is refused).
