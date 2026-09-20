---
"@metistry-apps/reconciler": minor
---

**Every todo in your vault is findable within a reconcile.** The reconciler's
existing walk now fills `vault_tasks` and `vault_task_refs`
(`docs/product/daily-flow-spec.md` §1.5, ticket P1-4): one row per `- [ ] …`
line you typed, one row per `[[note#^mt-…]]` that names one. No new process,
no second watcher, no second holder of the repo — this is already the pass
that walks the tree and hashes it.

**Derived in full, and it writes nothing back.** Drop the database, let one
walk run, and every row returns from the markdown that produced it. The
parser reads loosely — `due friday`, `critical`, `@Jim`, and on read only
Dataview's `[due:: …]` and the Tasks plugin's emoji — and the resolved
values land beside your line rather than in it. The only hand that edits a
task line is yours.

**The identity degrades honestly.** A line carrying an `^mt-…` anchor keeps
it wherever it moves; a line without one is keyed by its text and its
ordinal among identical lines in that file, so editing `due friday` to
`due 2026-09-25` leaves the task alone and re-typing the words starts a new
one with a fresh ageing clock. `first_seen_on` survives a re-walk, a field
edit and a rename.

A row is re-derived when the note's bytes change, which is a correctness
property and not an optimisation: `due friday` is resolved against the day
the walk *read* it, `parsed_on` records which day that was, and a row
re-derived every five minutes would slide a Friday task onto the next Friday
as soon as that one passed. A `[x]` with no date on it is stamped the first
walk that saw it checked and never re-stamped; un-ticking it clears the
stamp rather than leaving a lie.

**A view is never a second task.** `Journal/Plan/…`, `Journal/Fold/…` and
`Journal/Standup/…` render your todos and hold none of them — decided by the
file's own `source:` frontmatter, the same ownership vocabulary
`knowledge_write` already refuses on, so a plan you keep elsewhere is still
indexed and a routine that writes somewhere new is still skipped. Their
transclusions still become references, which is the whole reason the second
table exists. `Templates/` is excluded for the same reason in reverse: a
template describes tasks and has none.

**And a `work` row that waits on you surfaces without ever gating.** A
`meta.blocked_by` naming a human todo becomes a reference row of its own;
`depends_on`, `DEPS_CLOSED` and claimability are untouched, so a typo in a
note can never stall an agent. `work` is read here and never written.

On a 400-note fixture holding 4,000 task lines: a cold walk with every note
dirty costs 1,098 ms end to end against 385 ms for the same vault with no
task lines in it, and a quiet walk 212 ms against 46 ms.
