---
"@foldedspacelabs/metistry-cli": patch
"@metistry-apps/macos": patch
---

**`metistry up` (and `update`) now writes a `metistry` shim, so there is
finally something to run `metistry` BY NAME against.** A release install has
no Homebrew formula and no npm global, so nothing ever put `metistry` on
`PATH` — the only way to run one was the owner's own hand-written wrapper.
`up`/`update` write a small, idempotent POSIX script to
`<instance>/.metistry/state/bin/metistry` (mode `0755`) that already knows
this install's product dir and instance dir, and re-resolves which of
`current/` (a release) or the bare product dir holds the CLI, and which
`node` to run it with, on every invocation — so a release flip or a freshly
bundled runtime needs no re-write.

`up` never puts it on `PATH` itself (invariant 2 — that is the operator's
own hand): it prints the one `ln -s … ~/.local/bin/metistry` line that
would, and `metistry doctor` gains an informational `cli on PATH` row
(`ok`/`absent`, never a finding that fails the exit code) carrying the same
line as its remediation.

The Mac app's `RuntimeLocator` now also searches `~/.local/bin` and the
active instance's own `.metistry/state/bin` when looking for a `metistry` on
`PATH`, so it finds an install even before anyone has linked anything.

One known limitation, under the launchd shape only: `<instance>/.metistry/state/bin/Metistry`
(capital M) is the supervisor's own program-identity symlink, and macOS's
default case-insensitive volume makes that the same directory entry as the
shim's path. `up` checks before writing and leaves a symlink alone rather
than risk turning the supervisor's program into a shell script — so on that
shape the cli shim is, for now, simply not written (`docs/ops/cli.md` has
the detail; a merge of the two names is tracked as follow-up work).
