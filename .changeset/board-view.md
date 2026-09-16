---
"@metistry-apps/console": minor
---

**The Board — one place to see who is working on what.** A read-only Kanban
over the task list: six columns (Backlog, Assigned, In Progress, Needs You,
Done, Reported), a project filter, per-column counts, and a red chip on
anything that stalled. No migration and no fifth status value — every column
is a `CASE` over columns `work` already carried, so the whole feature is two
named queries (`board`, `board_projects`) and a panel.

Two things it makes visible that nothing else did. **"Assigned but not
started"** — a row addressed to an agent that nobody has claimed — was in the
data all along with no view onto it. And **Done vs Reported**: a closed task
that produced a finding no longer looks identical to one that produced
nothing, reconstructed from the run that claimed it.

`board_projects` is one row per project × column, which is the cross-project
board a per-board isolation model structurally cannot produce; here it is a
`GROUP BY` on a column the table already had.

Read-only on purpose. Every task mutation is still a tool call (invariant 9),
so the panel has no drag, no drop target and no mutating control, and a test
asserts it. Adapted from `docs/research/2026-09-12-hermes-agent-review.md`
(phases 1 and 2). New: `docs/ops/board.md`.
