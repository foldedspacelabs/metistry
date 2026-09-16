- 2026-09-16 — **The board: the state was always durable; what was missing
  was one view onto it.** A read-only Kanban over the task list — Backlog,
  Assigned, In Progress, Needs You, Done, Reported — built with **no
  migration and no fifth status value**, because every column is a `CASE`
  over columns the `work` table already carried. That is the claim worth
  making about the architecture rather than the panel: delegating to agents
  had been producing durable rows for months, and the whole feature is two
  named queries and a page. Two states it makes visible that nothing else
  did: **"assigned but not started"** (a row addressed to an agent nobody has
  claimed — the state a person actually means when they ask "did anything
  pick that up?"), and **Done vs Reported**, so a closed task that produced a
  finding no longer looks identical to one that produced nothing. The
  cross-project board is the differentiator: products that make a board the
  isolation unit — its own queue, its own store, no links across — cannot
  show one at all, while here the project is a column on the shared table and
  the view is a `GROUP BY`. It ships deliberately read-only: every task
  mutation is still a tool call, so the panel has no drag, no drop target and
  no mutating control, and a test asserts that — the rule for when the drags
  do land is that **the board offers no drop the service would refuse**,
  which is enforce-at-the-tool in direct-manipulation form. Holding the
  writes until the read-only view has been lived with is the product
  decision, not an unfinished feature. Worth remembering for how it was
  built: the design note it came from proposed reading "waiting on a human"
  from a pending proposal citing the task, and checking the code showed no
  proposal kind carries a task id at all — so the column was re-grounded in
  the state that is real and the gap written down in `docs/ops/board.md`
  rather than papered over.
