---
"@metistry-apps/macos": minor
"@foldedspacelabs/metistry-cli": patch
---

**The one background item is the app's now, and has a switch.** The Mac app
registers the install's supervisor through `SMAppService.agent(plistName:
"com.foldedspacelabs.metistry.plist")`, from the plist sealed inside
`Contents/Library/LaunchAgents` — so System Settings › General › Login Items
shows **one** row, "Metistry", with the agent nested under the app and
attributed to Folded Space Labs, instead of a background item listed beside it
that only a terminal could turn off. Settings → Services gains **"Run Metistry
in the background"** beside the existing "Start Metistry at login", each with
prose saying which is which: one opens a window, the other runs Postgres, the
console, the reconciler, the assistant and any configured bridge.
`requiresApproval` reads as ON with a button that opens Login Items, the status
is always re-read from macOS after a write, and a `swift build` executable —
which has no bundled agent — says so and points at the terminal path. Wizard
step 5 passes `--register-via app` when the build carries an agent, and
registers it *after* `up` has written the config and launcher file it reads.

**The two registrars can no longer fight.** A terminal install still bootstraps
the same-named agent itself. `metistry up` now asks launchd who owns
`com.foldedspacelabs.metistry` before installing anything — the plist path and
program `launchctl print` reports, which is live state rather than a marker
file that goes stale when the app is deleted — and leaves an app-registered one
alone, in one printed line, while still writing everything else that agent
depends on. `metistry doctor` reports the owner on the supervisor's row
(`meta.registrar`, `meta.registered_from`, and the probe text the app renders).
