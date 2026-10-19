---
"@foldedspacelabs/metistry-cli": patch
---

Fix: `metistry doctor` no longer fails a healthy install for racing a job it
has just started (X-122). A bridge, the console or the brain whose probe fails
while its job (for the recorder, its helper) started less than 30 seconds ago
is probed again every second until it answers, and fails only once that grace
is spent; a schedule row that is overdue while the console's runner has not yet
had its first tick reads *pending* instead of *failed*. The grace is
`METISTRY_DOCTOR_START_GRACE_SEC` (and the console's `METISTRY_RUNNER_TICK_MS`
for the schedule rows); a job that was not just started, or whose age nothing
can tell, is still reported failed at once. `up` and `update` tell their
closing doctor which jobs they have just bootstrapped or kickstarted, and
`update` hands the same to its child doctor in `METISTRY_DOCTOR_STARTED`.
