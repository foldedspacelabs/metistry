---
"@metistry-apps/routines": minor
---

**Tomorrow's Plan after the fold (T3-7).** `plan-tomorrow` now ends with a
`## Tonight's fold` section: a link to tonight's `Journal/Fold/<date>.md` and
its `decisions:` frontmatter as a list, verbatim and model-free (newlines
collapse, a leading `[` is escaped so no decision can become a task line).
The working-day guard records `skipped:not_a_working_eve` (was
`not_a_working_day`) — Sunday to Thursday evenings plan the next working day,
Friday and Saturday are skipped. `PlanCtx.closedDay` is Close the Day's early
render (T2-8): it plans the day after the day closed, never asks whether the
date is settled, and records `meta.trigger: "close"`; every row now carries
`meta.trigger` (`close | schedule | manual`), and only a non-close row settles
a date — so a second close re-renders, the 23:00 run supersedes the early
render under compare-and-swap, and a second scheduled pass stays silent.
The instance zone is `METISTRY_TZ` only (then `Me/profile.md`'s `timezone`),
never `TZ`.
