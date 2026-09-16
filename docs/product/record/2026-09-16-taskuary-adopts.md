- 2026-09-16 — **A thing you captured is visible the moment you capture it, a
  task you meant to make is one click away, and "not now" is finally an
  answer.** Four findings from `docs/research/2026-09-16-taskuary-review.md`,
  which compared the loop against a fast-moving product that puts its one human
  gate at the *exit* rather than at capture. The **timeline**: `activity_feed`
  unions `inbox`, so a note taken on the phone appears immediately wearing its
  own status instead of surfacing five minutes later as a proposal — the review
  found this to be the loop's only accidental latency, and it cost nothing to
  close because the row already existed. Every row carries a coarse `group`
  decided in SQL, which the panel reads as filter chips; one vocabulary, not one
  copy per surface. **Approve as Work** answers the sharper finding — that there
  was no capture → `work` path *at all*, so a todo captured on the phone ended
  the night as a vault page and nothing else. The honest middle was not a
  `draft` row written by the collector (that is auto-creation whatever the
  status column says); it was making the click do the thing. A `todo`-shaped
  capture — matched deterministically, **no model**, the on-device classifier's
  `has_action` deliberately not an input — carries a suggestion, and accepting
  it inserts the task, owner-less so any agent may claim it. §4.12 is intact
  because a human clicked, and nothing that goes unclicked ever becomes
  anything. **Decide-time staleness**: a decision now carries the timestamp of
  the row the client painted, and if the row moved after that — payload
  rewritten, its linked task touched, a message in that task's room — the answer
  is refused with the current row rather than applied to a question that
  changed. **`later` and `skip`** fix the queue's one failure mode, an item you
  cannot answer yet and cannot put down: `later` is a snooze that never ends a
  proposal (it leaves Needs You *and* the 07:00 brief, or the verb would be a
  lie), `skip` declines with nothing to say and fires none of Decline's per-kind
  consequences — skipping an enrolment request does not revoke the agent, and
  its marker is excluded by value from every path that carries a decline's
  words. Multi-select applies them to many rows, all-or-nothing **per row**, so
  one item answered on the phone thirty seconds ago does not refuse the other
  nine. Not adopted: executable action proposals, which would widen the
  console's mutating surface and are the owner's ruling to make, not a PR's.
