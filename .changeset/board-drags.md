---
"@metistry-apps/console": minor
"@foldedspacelabs/metistry-tasks": minor
---

**The board moves things now** — phase 3 of
`docs/research/2026-09-12-hermes-agent-review.md`, built on the rule that
keeps invariant 8 honest: *the board offers no drop the service would refuse.*

- **`packages/tasks` — the three gaps the note found, closed additively.**
  `UpdateInput.status` was `Exclude<TaskStatus, 'open'>`, so **unblock was
  unreachable by anything in the system**; it now accepts `open` from
  `blocked` only, and hands the row back the way `release()` does. `owner`
  can be set and cleared after create (with `title` and `project`, the other
  two fields a card carries but could not change). `heartbeat` takes a
  `note` that lands on `history` — and a renew *without* one appends nothing,
  so a lease ticking every few minutes never buries the row's record.
  `update` now has **two arms, and the fields pick the arm**: the holder arm
  (`in_progress | blocked | closed`, or a bare note) is claim-gated exactly
  as before; the board arm (`owner`, `title`, `project`, the unblock) is not,
  because addressing a card is a gesture on a row nobody need hold and the
  unblock is by definition a row whose holder is stuck. Mixing the two in one
  call is refused naming both fields — the looser gate must never carry the
  stricter arm's write. New refusal reason: `not_blocked`.
- **The console's task routes** (`apps/console/src/task-routes.ts`):
  `PATCH /api/tasks/:id {status?, owner?, project?, title?}`,
  `POST /api/tasks/:id/{claim,release,renew}`. Until now
  `POST /api/tasks/:id/dispatch` was the *only* task route the console had.
  A thin adapter and nothing more: every refusal comes out of a `WHERE`
  clause in `packages/tasks`, and the route only turns it into a sentence
  that names what would permit it. `user` principal only — an agent token
  and a capture owner token both get the canonical `403` — and one `runs`
  row per request records the door beside the service's own row for the op.
- **The drags** in the Board tab: HTML5 drag-and-drop, no library, four
  handlers. Each drop maps to exactly one route, `reported` is never a
  target, a closed card is not draggable, and a refused drop snaps back
  carrying the server's message. `m` on a focused card is the keyboard
  alternative. Clicking a card opens its room when one exists — `board.yaml`
  gained `has_thread`, so the panel never asks a second endpoint — and its
  detail popover when it does not.

**Assignment stays the human's alone, by absence rather than by a check:**
`owner` exists on `PATCH` and on no agent surface, because `tasks_update`'s
schema has no `owner` key and its status enum has no `open`. That is
collaboration rule 4 without a rule to run.

`docs/ops/board.md` gained the **Drags** table; `docs/ops/console-api.md`
gained the routes.
