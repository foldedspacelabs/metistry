---
"@foldedspacelabs/metistry-core": minor
"@metistry-apps/console": minor
---

**The Scheduled doors (T3-3).** F-1's eleven Scheduled rows are served:
`GET /api/scheduled` lists every routine and sync with each field's origin
(`default` · `profile` · `yours`), its next and last run, the **default** tag and
why a component is held; `GET …/{routines,syncs}/:name` adds its history (the
`routine_history` query, now covering a sync's `collector_run` rows and marking
Run Now by `trigger`). The owner sets a routine's schedule, pauses and resumes it,
resets it to default, and sets a sync's cadence, pause and raise toggles — each one
edit of `.metistry/scheduled.yaml` through the reconciler as `user`, comments kept,
validated against the closed schema and the component's manifest before it is
written, never a manifest and never an invalid file. A New Routine's actor, task and
read-only per-run grants are reach `local` (`403 local_only` for a passkey session).
Run Now runs one component through the runner under the owner's pause and the
preflight, budget included. The runner now hands each run its resolved config
(`ctx.config`). Core exports `timeOfDayFields`. All eleven fixtures are re-recorded
(a superset of their contract shapes).
