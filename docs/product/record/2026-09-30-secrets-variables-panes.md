- 2026-09-30 — **Secrets and Variables on the Mac: a value is typed once and
  never seen again.** Settings ▸ Secrets draws a secret as its name, who uses
  it, where it may be sent and when it was last used — rows with no field a
  value could occupy — and the one field a value is typed into hands it to
  `metistry secrets set` on stdin and clears itself before the process
  starts, so it is never on a command line, in a log, or on screen after
  save (a test walks the pane's accessibility tree for it). Deleting a secret
  asks the CLI first what references it and says what stops. Variables refuse
  a key-shaped value before it can reach any command line, offering only
  Store as Secret — the design's *Save as Variable* override was dropped,
  because agents read variables. Every write is an existing CLI verb shown
  with its exact command first; no console route was added.
