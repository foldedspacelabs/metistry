---
"@metistry-apps/console": minor
"@foldedspacelabs/metistry-cli": minor
"@foldedspacelabs/metistry-core": patch
---

**Scheduled work that stops failing quietly.** A collector whose token expired
used to fail every hour forever — one API call each time, one number on a
tile, and nothing that ever said "fix it or retire it". Four additive
behaviours, all derived from the `runs` table with no schema change
(`docs/ops/automation.md`):

- **Failure streak.** Consecutive `ok = false` runs since the last successful
  one. At `METISTRY_RUNNER_MAX_STREAK` (default 5) the runner stops running
  the component: no call, no spend. Each skipped window records exactly one
  `runs` row (`kind: runner`, `tool: skipped_streak`) — one per window, not
  one per 60-second tick. One successful run clears it; there is no state to
  reset by hand.
- **One alert per error signature.** `sha256(component + error with uuids,
  paths, hex ids and digits normalised out)`, first 12 hex, stored on the
  failing run's `meta.error_signature` and carried in the alert as
  `[sig:…]`. One (component, signature) raises one **Needs You** item per
  `METISTRY_ALERT_DEDUPE_H` (default 24h), and speaks again when the
  signature changes or the streak cleared and came back. Alerts are ordinary
  `outbound_messages` rows of kind `alert` — the path the watchdog already
  uses, so there is no new row kind and nothing new for the PWA to render.
- **Preflight before spend.** A collector or routine may declare
  `requires: {env: [NAMES], reachable: [URL_ENV_NAMES], engine: true}`. The
  runner checks it *before* opening a run row and, on a miss, records one
  `preflight_failed` row per window and runs nothing — the message names
  every variable and the manifest file that declares it. `engine: true` asks
  core's one `engineCredentialPresent` seam, moved from `packages/cli` to
  `packages/core` so the console can ask it too (the CLI re-exports it, so
  `up` and `doctor` are unchanged). The legacy `requires: [label]` array
  stays valid and checkless; no shipped manifest declares the structured form
  yet, because every shipped collector degrades absent by design.
- **`metistry doctor` grows a `schedules` section.** One row per schedulable
  manifest: last run and whether it succeeded, open streak, next due,
  `skipped_streak` / `preflight_failed` state. Built from `runs` plus the
  manifests, importing no collector (invariant 5). Actionable states are
  `failed`, so the existing non-zero exit already covers them; `--json`
  carries the shape in `meta`.

Every refusal, skip and remediation names the environment variable or manifest
field that would change it.
