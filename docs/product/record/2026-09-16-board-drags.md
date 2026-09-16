- 2026-09-16 — **The board moves work now, and the direct-manipulation UI made
  "enforce at the tool" prove itself.** Dragging a card writes through four new
  console routes (`PATCH /api/tasks/:id`, `claim`, `release`, `renew`) that are
  a thin adapter over the same `TasksService` every agent uses — until now
  `dispatch` was the *only* task route the console had — and the rule the whole
  feature is built on is that **the board offers no drop the service would
  refuse**: the panel draws a target only where a `WHERE` clause in
  `packages/tasks` would succeed, and when the two disagree the statement wins
  and the card snaps back carrying the server's own sentence, never one the UI
  invented. Building it closed the three gaps the Hermes review named, the
  first of which was a real hole: `UpdateInput.status` was
  `Exclude<TaskStatus, 'open'>`, so **a blocked row could not be moved forward
  by anything in the system** — "Needs You" was a state with no exit. `update`
  now has two arms and the *fields* pick which, never a flag a caller passes:
  addressing, renaming and unblocking a card need no lease (nobody holds a card
  that is stuck), while status changes stay claim-gated, and mixing them in one
  call is refused naming both fields so the looser gate can never carry the
  stricter arm's write. The safety property that matters commercially is again
  an absence: a human may address a card to any crew, and **no agent surface
  can address one at all**, because the agents' `tasks_update` schema has no
  `owner` key — collaboration rule 4 holding without a rule to run. Ten
  route-level misuse tests ship with it (agent token → 403, owner token → 403,
  every refusal's sentence asserted), plus one drop mapping per row of the
  table. Cards now open the room hanging on them rather than nothing, which is
  the first place two ideas the board and the threads work landed separately
  compose into one gesture.
