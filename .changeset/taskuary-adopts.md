---
"@metistry-apps/console": minor
"@foldedspacelabs/metistry-core": patch
"@metistry-apps/collectors": patch
"@metistry-apps/routines": patch
---

**The Feed is a timeline, and a capture is on it the instant it lands.** The
`activity_feed` query gains an `inbox` branch, so a note taken on the phone
shows up immediately wearing its own status (`new` = still waiting on the
drain) rather than appearing five minutes later as a proposal — the loop's one
accidental latency. Every row now carries a coarse `group` (capture, proposal,
decision, run, work, message) decided in the SQL, which the panel renders as
filter chips; `since` pulls only what is new, and a decision event says what
you answered, not just that something was answered. Still read-only.

**Approve as Work.** A `knowledge` or `report` proposal whose payload carries
`suggested_work` shows one extra answer, and the click inserts the `work` row,
links it as `proposals.work_id` and allows the proposal. `inbox-drain` sets the
suggestion deterministically — frontmatter `kind: todo|task`, a leading
`@task` / `todo:` / `- [ ]`, or the `todo` verdict its rules already reached;
**no model**, and the Apple FM tier's `has_action` is deliberately not an
input. Nothing auto-creates: §4.12 holds because a human clicked. The row is
born owner-less and unclaimed, so any agent may take it, and the insert is
keyed on the proposal id so a double-tap cannot make two.

**A decision is an answer to the row you were shown.** `POST
/api/proposals/:id` accepts `if_unchanged: {seen_at}`; if the proposal moved
after that — payload rewritten, its linked work row touched, a message in that
row's room — nothing is decided and a `409` comes back carrying
`reason: "stale"` and the current row, in the same envelope `already decided`
already used.

**Later and Skip** (migration `0019`, one nullable `snoozed_until`). *Later* is
a snooze: the row stays pending, leaves Needs You and the morning brief, and
comes back on its own (`METISTRY_SNOOZE_HOURS`, default 3) — it never ends a
proposal. *Skip* declines with nothing to say and fires none of Decline's
per-kind consequences: skipping an enrolment request does **not** revoke the
agent, and its fixed `skipped` marker is excluded from every path that carries
a decline's words anywhere. `POST /api/proposals/batch` applies `later`, `skip`
or `deny` to many rows, all-or-nothing **per row** with a result for each; the
queue gains multi-select and the keys `l` and `s`.
