---
"@foldedspacelabs/metistry-cli": minor
---

**`--json` is now pure.** The Mac app's Compute pane (#174) found several
`metistry compute`/`instances`/`restart|stop|start` verbs writing their own
progress notes — a stored-secret notice, a download's byte count, a step
runner's `== title`/`$ command` lines — onto the same stdout stream as the
`--json` result, so the app had to parse a trailing object out of a run of
prose (`JSONValue.parseTrailing`). Under `--json`, every verb across
`compute`, `local-models` (through `compute models …`), `connect`,
`instances`, `runs export`, `restart`/`stop`/`start`, `doctor`, `identity`
and `secrets` now writes exactly one JSON document to stdout; every human
line goes to stderr instead. Non-`--json` output is unchanged.

**`metistry console call <METHOD> <path> [--body @file|-] [--json]`** — a
thin scripting seam behind `console whoami`: one authenticated request
against the instance's console, as the same `user` principal (the local
owner token, loopback-only by design — a non-loopback
`METISTRY_CONSOLE_URL`/`METISTRY_URL` is refused before the token ever
leaves this process). Prints the response body, pretty unless `--json`
(which prints the console's own bytes verbatim), and exits non-zero on a
`>=400` answer naming the error envelope's `code`/`message` (and `field`,
when present) on stderr. `docs/ops/second-instance.md`'s first Devin
dispatch uses it in place of a pasted session cookie.
