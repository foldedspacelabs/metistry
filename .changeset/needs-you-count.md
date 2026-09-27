---
"@foldedspacelabs/metistry-core": minor
"@metistry-apps/console": minor
---

**The Needs You count (T1-7): `GET /api/needs-you/count`.** F-1's frozen row
is served — `{waiting, oldest_ts, as_of}` through the new `pending_count`
named query (`expose: route`), the same pending-and-not-snoozed filter `GET
/api/proposals` applies, so the sidebar row and the Dock badge can never
disagree with the queue's own length. Always exactly one row; a snoozed
proposal (`later`) is not counted, same as the queue it mirrors. Owner reach
only — the capture owner token is refused `403`, not served as if the route
did not exist.
