---
"@metistry-apps/console": minor
---

T3-11: routine suggestions. A suggestion about a routine is an `improvement`
request carrying one `.metistry/scheduled.yaml` entry before and after — a
routine's schedule or pause, a sync's cadence, pause or raise toggles, never
what runs or a sync's connection. Nothing is written until the owner
Approves; Approve writes exactly the "after" through the Scheduled door as
`user`, refused `409 stale` when the entry changed since. Revise, Decline and
Later write nothing.
