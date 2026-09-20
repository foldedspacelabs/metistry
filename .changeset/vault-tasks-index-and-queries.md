---
"@metistry-apps/console": patch
---

**The tasks in your notes become readable state, and nothing about them is
stored.** The first two tickets of the daily flow's Phase 1
(`docs/product/daily-flow-spec.md` §1.5, §6.2, P1-3 and P1-5): the index the
reconciler will fill, and the five named queries everything downstream reads
it through.

**Migration 0024, and every column in it is derived.** `vault_tasks` and
`vault_task_refs` hold one row per `- [ ] …` line and per block-anchored
reference to one. Drop the database, let one walk run, and both come back
from the markdown that produced them — which is the point: a todo lives on
the line you typed it on, and this is a projection of that line, never a
second copy of it with its own opinion. The spec numbers the file 0023;
0023 had gone to `agent_grant_overrides` while the spec was being written,
so it is 0024 and nothing else changes. Additive throughout, and the
rollback is two `DROP TABLE`s.

Two constraints are deliberately **not** there, and the reason is the same
one: a derived table that can refuse to be rebuilt is not derived. There is
no unique index on `task_key` or `anchor` — without an anchor a key is
per-file by construction, so the same sentence in two notes is the same key
in both, which is a duplicate the index must hold two rows for rather than
fail on — and no foreign key on `work_id`, because a vanished work row must
not be able to fail the walk that rebuilds your own tasks.

**One filter vocabulary, one query.** `vault_tasks_query` is what the
template directive's `where:`/`order:`, the app's filter chips and the
plugin's suggester all compile into — as bind parameters, never as SQL text.
Inclusive date bounds per field, priority bounds, exact slugs, one
comma-separated flag set, and `combine` for how the clauses join. Where the
fixed shape cannot express a predicate — one that mixes "and" and "or" at
different depths — the parser refuses it with a visible note rather than
quietly returning an approximation, because a wrong list is worse than a
warning. Beside it: `vault_tasks_recurring` (the rule lines, which are never
themselves tasks), `day_work` (work for a day with a `blocked_by` human todo
resolved beside each row — it surfaces and never gates, so no agent is ever
stalled by a typo in a note), `pending_requests` (the Needs You queue as a
read path, honouring a `later` and returning handles rather than payloads),
and `task_ageing` (the measure).

**Four of the five are route-only, and the fifth is generic on purpose.**
Their rows carry vault paths and the text of lines you typed, so they are
reachable only through an endpoint that filters every row through the
caller's scope — the generic query door and the assistant's `queries_run`
answer their names with the same refusal an unknown name gets. `task_ageing`
is counts only: it groups by source *kind* so a `meeting:<path>` can never
put a path into an aggregate, and it takes no caller-supplied filter to
probe the tree with. That is what lets the assistant read the measure
without a new tool — the brain bridge stays at 26, exactly where it was.
