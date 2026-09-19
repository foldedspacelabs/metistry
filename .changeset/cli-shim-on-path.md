---
"@foldedspacelabs/metistry-cli": patch
"@metistry-apps/macos": patch
---

**`metistry up` (and `update`) now writes a `metistry` shim, so there is
finally something to run `metistry` BY NAME against.** A release install has
no Homebrew formula and no npm global, so nothing ever put `metistry` on
`PATH` — the only way to run one was the owner's own hand-written wrapper.
`up`/`update` write a small, idempotent POSIX script to
`<instance>/.metistry/state/cli/metistry` (mode `0755`) that already knows
this install's product dir and instance dir, and re-resolves which of
`current/` (a release) or the bare product dir holds the CLI, and which
`node` to run it with, on every invocation — so a release flip or a freshly
bundled runtime needs no re-write. `state/cli/` rather than `state/bin/`:
the launchd shape's `state/bin/Metistry` is already the supervisor's own
program-identity symlink, and macOS's default case-insensitive volume would
make that the same directory entry as `state/bin/metistry` — a sibling
directory avoids the collision outright. `writeCliShim` also leaves alone
anything already sitting at the path that is not a symlink-free plain file
recognisably its own — a foreign file is noted, never overwritten.

`up` never puts it on `PATH` itself (invariant 2 — that is the operator's
own hand): it prints the one `ln -s … ~/.local/bin/metistry` line that
would, and `metistry doctor` gains an informational `cli on PATH` row
(`ok`/`absent`, never a finding that fails the exit code) carrying the same
line as its remediation.

The Mac app's `RuntimeLocator` now also searches `~/.local/bin` and the
active instance's own `.metistry/state/cli` when looking for a `metistry`
on `PATH`, so it finds an install even before anyone has linked anything.
