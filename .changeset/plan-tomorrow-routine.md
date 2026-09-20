---
"@metistry-apps/routines": minor
"@metistry-apps/console": patch
---

**Tomorrow's plan is written for you, from your own template.** The daily
flow's `plan-tomorrow` (`docs/product/daily-flow-spec.md` §5.1, §7; ticket
P1-7): once an evening, the routine renders `Templates/Plan.md` — a markdown
file in your vault, which you edit in Obsidian like any other note — into
`Journal/Plan/<tomorrow>.md`, written through the reconciler's bridge as
`principal: plan-tomorrow`. Tomorrow's events, the tasks the template asked
for in the order it asked for, what an agent is waiting on you for, what is
waiting in your queue, and your own prioritisation prose included verbatim.

**No model is in it, at any tier.** The ordering is a field list in the
template; your prioritisation *rule* is prose the plan includes for you to
read, not something a model is asked to apply (invariant 4). The manifest
declares no engine, so the runner never even asks whether one is configured.

**It writes exactly one file, and never a note you own** (§5.1's one writer
per file). A plan file whose frontmatter `source:` is not this routine's —
including one with no `source:` at all, which is yours — is left exactly as it
is and the run says so. A recurring rule is *listed* for tomorrow
(`- Water the plants — every week, due 2026-09-22`) with no checkbox and no
`^mt-` anchor: no routine writes a task line into a note you own (D4), which
the engine enforces from the render's `source` and the routine refuses again
before writing. Re-running an evening replaces the same file under
compare-and-swap; nothing is appended, and there is never a second one.

**The gate is `Me/`, and it degrades honestly.** `@hourly` with the decision
in the routine, for the reason the fold gives — the runner has no time of day.
It plans after the day end `Me/profile.md` states (`working_hours:`), on the
eve of a day `working_days:` names, once per target day. No `working_days` and
**nothing is written at all**: the run records `no_working_days` rather than
guessing Monday-to-Friday. No `working_hours` and the plan is written from
19:00 local *and says so*, in one visible line, because a default nobody chose
should not be invisible. No calendar bridge, no query store, a `where:` the
filter vocabulary refuses — each renders one `> ⚠️ metistry: …` line naming
the template and the line number, and the plan still lands: a day with no plan
because the calendar was down is the worst possible outcome.

One `runs` row per target date carries what happened — `wrote`,
`no_working_days`, `not_a_working_day`, `template_missing`,
`template_unreadable` or `user_owned` — so `metistry doctor`, the morning
brief and `docs/ops/automation.md`'s SQL all read the same ledger, and an
hourly routine still files one row a night.

The console now hands routines the named-query store and the vault bridge it
already built for the server, so every row the plan shows arrives through a
named query and no component grows a second read path into Postgres
(invariant 3).
