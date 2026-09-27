---
"@foldedspacelabs/metistry-core": minor
"@metistry-apps/console": minor
"@metistry-apps/routines": minor
"@foldedspacelabs/metistry-cli": patch
"@metistry-apps/watchdog": patch
---

**The scheduler: routines run once, at their time.** Core implements the
next-occurrence function F-4 froze (`nextOccurrence`, hand-rolled over `Intl`,
Temporal's `compatible` rule on both daylight-saving nights) and the runner's
question `dueOccurrence` — the latest slot owed since the last run, so slots
missed while the Mac slept coalesce into one run. A time of day is read in the
schedule's `tz`, then `Me/profile.md`'s `timezone`, then `METISTRY_TZ` — never
`TZ`, which both deployment shapes default to UTC — and with none is refused
`no_timezone`. Manifests now validate `schedule:` against §2.5's closed shape
(cron strings still accepted for one release), and the five routines carry
§2.5's defaults: Morning Brief working days 07:00, Knowledge Fold 21:00,
Tomorrow's Plan `eve_of_working_days` 23:00, Reply Review 23:00, Weekly
Review Sunday 18:00. The console's runner reads each manifest ⊕
`.metistry/scheduled.yaml` on every tick — schedule and pause by name; an
entry it cannot apply, or a file that does not validate, HOLDS what it names
rather than falling back to defaults — reads `timezone` / `working_days` from
`Me/profile.md` through the vault bridge, stamps each run with the slot it is
for (`meta.scheduled_for`, `ctx.scheduledFor`, `ctx.timeZone`), and records a
schedule it cannot place once a day as `skipped:<reason>`. `knowledge-fold`
and `plan-tomorrow` drop their hourly clock gates (`plan-tomorrow` keeps its
working-day guard) and date a late run from its slot. `metistry doctor` and
the watchdog bound a time of day by the widest gap of its week
(`longestGapSeconds`), and doctor reports a refused schedule as `absent` in
the runner's own words.
