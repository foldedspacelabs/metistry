---
"@foldedspacelabs/metistry-core": minor
"@foldedspacelabs/metistry-cli": minor
"@metistry-apps/watchdog": minor
---

Metistry can keep your Mac awake while it runs, and asks you first.
`deployment.yaml` gains `keep_awake`: `never`, `allow_sleep_on_battery`
(held on wall power, released on battery and on a UPS), `always`, or
`always_lid_closed`. `metistry init` asks the question once on a terminal,
printing what each choice costs, and writes your answer; `--keep-awake
<value>` answers it without one, and an install that was never asked holds
nothing — a power assertion overrides your own sleep setting, so it is never
taken on your behalf. Under the `launchd` shape the supervisor holds
`caffeinate -i -w <its own pid>`: the display still sleeps, your own
keep-awake app is untouched, and nothing survives the supervisor. `metistry
doctor` grows one macOS-only `keep-awake` row (`degraded` at worst) that
cross-checks our pid against `pmset -g assertions`, reads a release on
battery as success rather than a fault, and reports when the Mac slept
anyway — with the repair. `always_lid_closed` is accepted and honest: no
process can keep a Mac awake with the lid shut, so doctor says it needs an
administrator change you make yourself. Change it later with `metistry
deployment set-keep-awake <value> --yes`.
