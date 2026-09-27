- 2026-09-27 — **An update's fixes land in the update that installs them.**
  The owner's move to 0.14.1 took three runs: the `metistry` shim runs the
  release an update is leaving, so every step after the switch — migrations,
  restart, the owner bearer, the lock — was the old code, and a fix to any of
  them waited for the next update. `metistry update` now hands everything
  after the switch to the release it just installed (a re-exec of that
  release's own CLI, same flags and environment), so from 0.14.2 on one run
  is enough. Safe to leave running because every edge is a refusal with a
  test: an environment marker refuses a second hand-over, a release whose CLI
  predates it is never handed to, and a new CLI that cannot start is told
  apart from one that failed by a handshake file — the old code then
  finishes the update, exit 1, with the exact rollback command.
