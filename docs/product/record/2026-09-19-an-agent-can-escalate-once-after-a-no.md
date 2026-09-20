- 2026-09-19 — **An agent that is told "no" can say why it matters, once.**
  The access-request loop shipped with one answer per ask and no way to read
  the answer: a declined agent could only file the same row again. It now
  gets the decision back at the tool — declined, when, the owner's note — and
  exactly one escalation, `escalate: true` with a fuller reason, which arrives
  in Needs You flagged *asked again after a decline*. A second decline closes
  the area at the tool; what is left is a report in words. The ladder is three
  rungs and enforced in code, so "don't nag" is a property of the mechanism
  rather than a line in a prompt — and the same change let the owner's own
  assistant onto the loop, with each approval recorded so the next restart
  cannot quietly undo it.
