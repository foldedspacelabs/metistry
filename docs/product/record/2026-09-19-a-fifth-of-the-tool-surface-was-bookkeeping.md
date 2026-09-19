- 2026-09-19 — **A fifth of what the assistant reads before every reply was
  bookkeeping.** Every tool it can use is described to it at the start of each
  turn, and one line of that description — an id for grouping a reply's
  actions in your activity feed — was repeated in all twenty-five of them:
  **944 tokens, 19% of the whole list**, for something the assistant should
  never have been thinking about in the first place. It is now attached to
  each call by the software rather than written by the model, which is both
  cheaper (19,914 characters down to 16,140, measured) and more reliable —
  the grouping used to depend on the assistant remembering a convention, and
  now it cannot be forgotten. Nothing it can do changed. The room this frees
  is deliberately not being spent: the tool list is the thing a smaller,
  local model has to hold in its head to pick the right action, so the build
  now measures that list on every change and refuses to let it grow without a
  decision. New things to look up arrive as saved questions, which cost
  nothing until asked.
