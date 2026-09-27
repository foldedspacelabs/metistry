---
"@foldedspacelabs/metistry-core": minor
"@foldedspacelabs/metistry-cli": minor
"@metistry-apps/console": minor
"@metistry-apps/routines": patch
---

**Profile facts and the standup move (T3-4).** `Me/profile.md` is read in one place: core's `profileFacts` (the two facts a schedule follows), `profileFrontmatter` and `profileWeekdays`, which `plan-tomorrow`'s guard now uses too; `resolveScheduleDays` gives a schedule's days with their origin, and a profile with no working days is refused `no_working_days`, never guessed. `standup_days`/`standup_time` move to the Standup routine: the console reads them once into `routines.standup.schedule` in `.metistry/scheduled.yaml` (as `user`; refused until the console holds that authority, T3-2) and raises one *Tidy Me/profile.md* request with the before and after. Approving it writes exactly the "after" as `user`, and is refused `409 stale` if the file changed since; Decline leaves the lines, ignored, and `metistry doctor` names them in one info line (an ok row may now carry `meta.info`). `lastMirror` (core) says whether a subject was ever raised. The seeded profile drops the two keys.
