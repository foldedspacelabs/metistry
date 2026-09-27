---
"@foldedspacelabs/metistry-cli": minor
---

**Doctor for the Services pane (T4-21).** `metistry doctor --json` rows gain
two additive fields for the Mac app's Services pane: an optional `action` —
`run_verb` (argv, never a shell string, and never `--yes`: the app's own
preview-then-confirm still stands between the button and the write),
`open_secrets`, or `open_system_settings` — on the rows where doctor can name
the fix without guessing (a bridge token, `metistry up`, `metistry update`,
`migrate-inbox`/`migrate-layout`/`migrate-scope`/`purge-shared`,
`set-keep-awake`); and `meta.uptime_sec` on every running-process row — a
launchd job (`ps -o etimes=` off the pid `launchctl print` already reported),
a compose container (parsed from `docker compose ps`'s own `Status` text), and
a supervisor child (from its already-tracked `uptimeMs`). Most rows still
carry neither: restart/stop/start/logs per `kind` remains the generic control
every row has, and `action` exists only for the fixes that menu cannot
express. `docs/ops/cli.md` documents the shape.
