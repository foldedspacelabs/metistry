- 2026-09-17 — **The CLI's `--json` is now a real wire contract, not a
  convention.** The Mac app's Compute pane found several verbs writing their
  own progress notes onto the same stdout stream as the `--json` result, so
  the app had to parse a trailing object out of a run of prose. Every verb
  across `compute`, `instances`, `restart|stop|start`, `doctor`, `identity`
  and `secrets` now writes exactly one JSON document to stdout under
  `--json`, with every human line moved to stderr — enforced in each verb's
  own case, not remembered — so a client (the app, a script, `metistry
  console call`, the new scripting seam behind `console whoami`) can trust
  the whole buffer parses.
