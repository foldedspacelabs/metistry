---
"@foldedspacelabs/metistry-core": patch
"@foldedspacelabs/metistry-cli": patch
"@metistry-apps/watchdog": patch
---

Fix: doctor's `sandbox` row reports what the supervisor actually spawned,
not what `supervisor.json` says. The supervisor's `status` now carries an
optional `spawned: {argv, profile}` per child (additive; an older supervisor
omits it), and the row reads that. A confined child can no longer be called
unconfined because the file was re-rendered beside it, and a supervisor that
does not answer, predates the field, or has not spawned the child reads
"could not confirm" rather than either answer. The running process's own argv
cannot be used: `sandbox-exec` execs into its target, so it never names the
profile.
