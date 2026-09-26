---
"@foldedspacelabs/metistry-core": minor
---

**The Scheduled model's schema, frozen: `scheduled.yaml`, a closed schedule
shape, field origins, and the next-occurrence signature.** A schedule is
`{days, at, tz?}` or `{every: 5m|15m|1h|6h}` and nothing else — `every`
outside the four, a cron string, `8:00`, a UTC offset and the two forms mixed
are each refused with one line naming the field (`scheduleSchema`). `days`
takes weekdays or two sets that follow the profile, `working_days` and
`eve_of_working_days`, defined once in `resolveDays`; with no working days in
the profile a set resolves to `null`, never to a guessed Monday–Friday.
`scheduledSchema` / `parseScheduled` validate `.metistry/scheduled.yaml`:
routine overrides, New Routine assignments (actor, task, per-run grants that
are vault prefixes an agent may hold, a required schedule, no config) and
syncs. Parsing rewrites nothing, and an invalid file returns `value: null`
— never an empty overlay, which would un-pause a paused routine.
`FIELD_ORIGINS` (`default` · `profile` · `yours`) and `Sourced<T>` carry where
a resolved value came from. `NextOccurrence` is a type only — its body is
T3-1's — and `manifestScheduleSchema` accepts a legacy cron string in a
product manifest for one release. Nothing reads the file yet.
