- 2026-09-20 — **One place now decides what anything is allowed to see.**
  Fourteen separate rules, spread across eleven files, used to answer the
  question "may this agent read this note, run this query, touch this task" —
  and a single ordinary read passed through five to seven of them, each
  written out by hand at the place it was needed. They agreed, but only
  because someone had kept them in step; the first one to drift would have
  been a silent hole rather than a bug anyone would notice. They are now one
  function, in one file, that every door asks and no door second-guesses, with
  a test that greps the code to prove no part of the system has quietly grown
  a rule of its own again. Nothing a person or an agent can do changed by a
  single byte — the refusals are asserted word for word against what they said
  before — but two things that were invisible became legible: every refusal
  now carries a machine-readable reason, so an agent that is told "no" can
  tell "you lack the grant" from "that does not exist", and where a remedy
  already existed the refusal carries it in a form a program can act on
  ("ask for this folder", "raise this permission"). And the complete list of
  everything the system can say when it refuses is a single reviewed file, so
  changing the words an assistant reads is now a deliberate edit somebody
  approves rather than a string changed inside a handler nobody opens.
