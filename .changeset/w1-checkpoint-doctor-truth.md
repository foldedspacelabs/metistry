---
"@foldedspacelabs/metistry-cli": patch
---

**`metistry update`'s closing doctor runs the updated CLI** (W1 checkpoint
D1). It used to run in-process — in the pre-update code — so an update that
changed the manifest schema validated the new manifests with the old schema
and ended `[!] updated, and doctor is not happy` with exit 1, although a
standalone `metistry doctor` was clean. It now runs `node
<run-dir>/packages/cli/dist/main.js doctor --json` from the product it just
installed (`current/` in release mode) and takes that report's verdict, with
the same exit codes; when that CLI is missing, cannot be spawned or prints no
report, it falls back to the in-process doctor and says so on a
`closing doctor:` line.

**Release note — the 0.12.0 → 0.13.0 update will still say "doctor is not
happy" once.** That hop runs 0.12.0's `update`, which has the old in-process
doctor, so if the release changes the manifest schema you will see
`updated, and doctor is not happy` and exit 1 one last time. Run `metistry
doctor` afterwards: its answer is the truth. Every update after that is
judged by the code it installed.

Doctor and update messages tell the truth (D2–D5):

- **A `no_working_days` skip is history once `Me/profile.md` has
  `working_days`.** Doctor reads the profile now; while the condition holds
  the row is still `absent` with the runner's words, and once it does not the
  row is ok and says it *was skipped … nothing to do until the next run at
  <time>* (or names the refusal that holds instead, such as no timezone).
- **A failed kickstart is not "nothing changed".** `update` said *no host
  job's code changed — nothing kickstarted* right after a changed job's
  kickstart failed; it now says *kickstart of <job> failed (exit N)*, and the
  summary counts failed kickstarts.
- **The shared-scope migration counts what it did** — *copied N secret(s)*,
  or *nothing to copy* — instead of *copied for <dir>* when nothing was.
- **An explicit `keep_awake: never` is configured.** Doctor reports it as
  your choice (ok, no suggestion); only a deployment.yaml that never answered
  the question is *not configured* with the verb that turns it on.
