---
"@foldedspacelabs/metistry-cli": patch
---

`metistry up` now pins the calendar and apple-fm TCC bridge jobs at their
signed helper bundles on every run, not only `migrate-shape`. A release
carries no built helper `.app` (`pack-runtime.sh` ships the sources, not
the gitignored build output), so a release install's `up` used to
re-render the calendar plist and rewrite `supervisor.json` pointing at a
bundle the release does not have — silently un-pinning both bridges the
next time `up` ran after `migrate-shape launchd` had pinned them. The pin
(`TCC_HELPERS`, `pinTccHelpers`, `pinSupervisorChild`) moved to its own
module, `packages/cli/src/tcc-pin.ts`, so `up` can call it right after
writing the calendar plist and `supervisor.json` and before bootstrapping
either — no extra kickstart. `migrate-shape` keeps calling it too, after
its own restore, idempotently.
