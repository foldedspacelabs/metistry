---
"@foldedspacelabs/metistry-connections": minor
"@metistry-apps/collectors": minor
"@metistry-apps/console": patch
---

T4-12: an `ics` calendar connection type and its `ics-calendar` sync. A public
iCalendar feed is read through the egress door — pinned to the feed's own
origin, no redirect followed, https only, capped at 10 MB — and its events
(RRULE, RDATE, EXDATE and RECURRENCE-ID overrides; IANA and VTIMEZONE zones,
DST-correct; all-day dates in the owner's `METISTRY_TZ`) are written into
`calendar_events` beside the eventkit sync's, so Today reads one table for
every source. The invite body is never read. A feed address carrying a token
is refused at the connection file as a key; private feeds wait on a ruling.
`openSyncHttp` accepts a provider with no origin of its own (the pin is then
the connection's own URL), and collectors receive the owner's zone as
`ownerTimeZone`.
