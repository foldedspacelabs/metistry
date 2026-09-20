---
"@foldedspacelabs/metistry-core": minor
"@foldedspacelabs/metistry-cli": minor
"@metistry-apps/watchdog": minor
"@metistry-apps/reconciler": minor
---

The sole committer runs confined, and every confined child's egress passes
one allowlisting door.

**`ops/sandbox/reconciler.sb`.** Under the `launchd` shape the reconciler —
the only process that holds the instance repo's working tree and the only
place git runs (D5) — now runs under a Seatbelt profile, as the job's root
process, so git and all 172 of its helpers inherit it. It writes the
instance repo and tmp and nothing else; reads the product checkout, the node
runtime, a real git's prefix and `~/.gitconfig` by name; execs node and that
git and **no shell**; dials the console, Postgres, the on-machine embedder
and the egress proxy, and binds only its own bridge port. D5 was a design
intention; it is now a kernel rule. `metistry up` (and `--dry-run`) prints
the profile each child will run under, and `metistry doctor` gains a
`sandbox` row that reads the answer back out of `supervisor.json`'s argv.
`METISTRY_RECONCILER_SANDBOX=0` swaps in `ops/sandbox/unconfined.sb`, a real
file that says `(allow default)`, so "not confined" is never invisible.

**`/usr/bin/git` is not a git** — it links against `libxcselect.dylib` and
is the xcode-select shim, which dies under a profile. `up` resolves a real
git by absolute path (bundled runtime, then a non-shim git on `PATH`, then
the Command Line Tools) and declines to confine the job when it finds none.

**The egress door.** `sandbox-exec` filters outbound by port and cannot name
a host, so `assistant.sb` carried `(remote tcp "*:443")` with an honest note
that its host list was documentation rather than enforcement. Both profiles
now allow exactly one loopback port, and a CONNECT proxy in the supervisor
listens there: an allowlist derived from this install's `compute.yaml`
providers and its instance repo's git remotes, exact host and port matching
(no wildcards), a 256-bit bearer per child so a refusal can name who asked,
a `runs` row per refusal, and no TLS interception whatsoever — CONNECT only,
so it learns a host name and never a byte of the tunnel. Children reach it
through `HTTPS_PROXY` + `NODE_USE_ENV_PROXY=1`; git reaches it through
`METISTRY_GIT_HTTP_PROXY` → `-c http.proxy`. `supervisor.json` gains an
`egress` block, read before any child is spawned, so no child can widen it.

**Two measured costs, documented rather than papered over.** A confined
reconciler cannot run a git credential helper (git runs every helper through
`/bin/sh`, including the built-in `osxkeychain`), and cannot push to an SSH
remote (granting `ssh` would mean granting the sole committer `~/.ssh`).
`up` warns when an install has either, and `docs/ops/reconciler.md` gives
three ways to push anyway.
