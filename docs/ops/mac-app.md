# The Mac app — `apps/macos`

The SwiftUI front end for the `metistry` CLI. It is the way the plan expects
most people to get Metistry (`docs/product/desktop-app-plan.md`, "Distribution:
the app as the installer", strategy ratified 2026-09-07): download a signed,
notarized DMG from GitHub Releases, open it, and never touch a terminal.

**The design rule that makes it safe:** the app is a front end for the CLI,
never a second implementation. Every install step is a `metistry` verb the app
runs with a progress view. It opens no database connection (invariant 3), runs
no git of its own, and has no private endpoints. The terminal path stays
first-class and identical, so open-source users and app users share one tested
path.

## What it does today, and what it does not

**Real:**

- **Status.** Runs `metistry doctor --json` and renders the rows to the design
  system's §3.13 — grouped by doctor's own `kind`, `absent` shown in absent
  grey and labelled "not configured", a summary line first ("26 ok · 1 degraded
  · 1 not configured") so the panel answers before it is read. The remediation
  replaces the probe on any row that is not `ok`.
- **The menu-bar item.** Its glyph is the worst *fault* across components.
  `absent` never drives it — a bridge that was never configured is not a fault,
  which is the same rule that keeps `absent` out of doctor's exit code. The menu
  lists the rows and offers "Check Again".
- **First run, steps 1–5.** Locate the runtime; `metistry init`;
  `metistry connect-repo --auth device` (the GitHub device code is parsed out of
  the CLI's stream and shown as a card with a link, while connect-repo keeps
  polling); `metistry secrets sync`; `metistry up`. Every step shows the exact
  argument array *before* running it and streams the CLI's own output.
- **Sparkle auto-update.** Pinned to 2.9.6 — the same version
  `ops/release/runtime-versions.env` pins the signing tools to. The feed is
  `https://github.com/foldedspacelabs/metistry/releases/latest/download/appcast.xml`
  and the public EdDSA key is `SUPublicEDKey` in `Info.plist`; both are read by
  Sparkle itself, so the app cannot disagree with the workflow that signs the
  feed.

**Not yet, and labelled as such on screen:**

| | why | what to do today |
| --- | --- | --- |
| First-run step 6, **passkey** | needs `ASAuthorization` against the console's local origin *and* a `metistry` verb to register the credential; neither exists | enrol from the console in a browser |
| First-run step 7, **Claude token** | `claude setup-token` is an interactive terminal flow; driving it needs a pty, and the token needs its own `metistry secrets` path | `claude setup-token`, then `metistry secrets mint CLAUDE_CODE_OAUTH_TOKEN` |
| **SMAppService** | step 5 registers launchd jobs the way the terminal does — `metistry up` writing `~/Library/LaunchAgents`. `SMAppService` (macOS 13+) is the sanctioned way an app installs its own agents, with one approval in System Settings and no plist to edit | nothing; the current shape works |
| **The other eight destinations** | Feed, Chat, Agents, Projects, Artifacts, Capture, Needs You, Devices (design-system P6) | the PWA — "Add to Dock" in Safari |
| **An iOS target** | `MetistryKit` is already free of AppKit and of `Process` so it can be shared; there is no iOS target in `Package.swift` | — |

An empty destination is not listed as a greyed-out placeholder. §3.15's
distinction holds throughout: *empty* (nothing has happened) and *absent* (never
configured) are different states, and neither is a failure.

## Layout

```
apps/macos/
  Package.swift        SwiftPM manifest — no Xcode project
  Package.resolved     the Sparkle pin; tracked, and CI builds with
                       --disable-automatic-resolution so a stale one fails
  sources/kit/         MetistryKit: the model and the views.
                       No AppKit, no Process — an iOS target shares it as is.
  sources/app/         the Metistry executable: @main, MenuBarExtra, Sparkle,
                       and the Process-backed CommandRunner
  tests/kit/           swift-testing unit tests over the kit
  resources/           Info.plist template + the entitlements file
```

Paths are lowercase, so every target names its own `path:` rather than taking
SwiftPM's default `Sources/<TargetName>/`. `Package.swift` and
`Package.resolved` are the two names SwiftPM will not let us rename; they are
the only entries `ops/scripts/check-path-case.sh` allowlists under `apps/macos`.

`sources/kit/design-tokens.swift` is **generated** from
`docs/product/design/tokens.json` by `ops/scripts/build-design-tokens.mjs`,
alongside `tokens.css`. Edit the JSON, run the script, never edit the Swift —
CI's `--check` fails on drift.

## Build and run it

```sh
swift build --package-path apps/macos      # compile
swift test  --package-path apps/macos      # the kit's unit tests
```

`swift build` alone gives you an executable, not an app: no `Info.plist`, so no
bundle identifier, no menu-bar item and no Sparkle feed. To get a real
`Metistry.app`:

```sh
ops/release/build-app.sh --no-dmg          # -> dist-app/Metistry.app
open dist-app/Metistry.app
```

Add the DMG by dropping `--no-dmg`. Other flags:

| flag | |
| --- | --- |
| `--version <x.y.z>` | default: the root `package.json`'s version |
| `--runtime <tar.gz\|dir>` | embed a runtime pack (`ops/release/pack-runtime.sh`) |
| `--runtime-deps <tar.gz\|dir>` | embed the bundled runtime (`ops/release/build-runtime-deps.sh`) |
| `--out <dir>` | default `dist-app/` |
| `--skip-build` | reuse `.build/release/Metistry` for fast iteration |

### Pointing a local build at an install

Without an embedded runtime the app has to be told where a product checkout is,
which is first-run step 1. Choose the folder in the app (**First Run → 1.
Runtime → Product checkout → Choose…**); it is remembered across launches. The
same value can be set from a terminal, which is what the app itself writes:

```sh
defaults write com.foldedspacelabs.metistry productDirectory -string ~/src/metistry
```

The checkout needs `packages/cli/dist/main.js` built (`pnpm -r build`) and a
`.env`. The app also honours `METISTRY_PRODUCT_DIR` when the process happens to
have one — a Finder-launched app does not, which is why the folder picker
exists.

**How step 1 resolves, in order.** Each rejection is shown on the screen with
its reason, so "not found" is never a shrug:

1. **bundled** — `Metistry.app/Contents/Resources/metistry/`, needing both
   `runtime/node/bin/node` and `…/packages/cli/dist/main.js`. It prefers the
   `current` symlink when there is one, because that is exactly how
   `metistry update` lays out a release install.
2. **checkout** — the folder chosen in the app, or `METISTRY_PRODUCT_DIR`. Uses
   the checkout's own `runtime/node/bin/node` when it has one (the node
   `metistry up` renders into the launchd plists), else a `node` from
   `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`.
3. **path** — a `metistry` in those same directories.

Every verb is invoked with an explicit `--product-dir`: a GUI process has no
meaningful working directory to fall back on.

## Signing locally

`ops/release/build-app.sh` signs with `METISTRY_SIGN_IDENTITY` when it is set,
otherwise with the first installed **Developer ID Application** identity,
otherwise not at all.

```sh
METISTRY_SIGN_IDENTITY=none ops/release/build-app.sh --no-dmg   # force unsigned
```

An unsigned app runs perfectly well on the machine that built it, which is all a
local build needs. It is *notarization* that requires a real identity, and
`ops/release/notarize.sh` refuses an unsigned artifact up front rather than
letting Apple reject it five minutes later.

Auto-detection resolves the identity's **SHA-1 hash**, not its display name. A
Mac holding two valid Developer ID certs for one team — a renewal, typically —
has two byte-identical names, and `codesign -s "<name>"` fails with `ambiguous
(matches …)`. `security find-identity -v -p codesigning` shows both.

What the script signs, and in what order:

1. any Mach-O inside `Contents/Resources/metistry/` that arrived **unsigned**.
   `build-runtime-deps.sh` signs everything it produces and the TCC helpers are
   signed by their own build scripts, so those are left exactly as they are —
   re-signing a helper without its `--identifier` would change the bundle ID TCC
   keys its grant on (`docs/ops/apple-signing.md` §3).
2. Sparkle inside-out: its XPC services, `Updater.app`, `Autoupdate`, then
   `Sparkle.framework`.
3. the app, with `--options runtime --timestamp` and the entitlements file.
4. the DMG (`--timestamp`, no `--options runtime` — the hardened runtime is a
   property of an executable, and a disk image has none).

**The entitlements file is deliberately empty**, and
`apps/macos/resources/metistry.entitlements` explains why at length: under the
hardened runtime an entitlement is an *exception*, and this app needs none. It
touches no TCC-protected resource itself (Calendars and Reminders go through the
EventKit helper, its own signed bundle with its own grant), spawning `metistry`
is not restricted, and the one framework it loads is signed with the same
identity so library validation is satisfied. `com.apple.security.app-sandbox`
stays absent: the app drives an installer.

## Notarizing locally

One-time setup is `docs/ops/apple-signing.md` §4 — an App Store Connect API key
stored as the `metistry-notary` keychain profile. Then:

```sh
ops/release/build-app.sh                      # produces dist-app/Metistry-<version>.dmg
ops/release/notarize.sh dist-app/Metistry-<version>.dmg
```

It submits, waits, staples the ticket to the DMG and validates. In CI it uses
`APPLE_API_KEY_P8` / `APPLE_API_KEY_ID` / `APPLE_API_ISSUER_ID` instead of the
profile; the decoded `.p8` goes to a `0600` temp file and is deleted on exit.

## In CI

- **`ci.yml` → `macos-app`** (macos-15): `swift build` and `swift test` on every
  PR, cached on `Package.resolved`. No signing, no bundle, no DMG — this exists
  so the app cannot rot silently, and it is kept small on purpose.
- **`release.yml` → `macos-app`** (macos-15): imports the Developer ID cert into
  a temporary keychain, embeds the runtime pack and the bundled runtime this
  same run built, signs, notarizes, staples, and uploads the DMG.
- **`release.yml` → `appcast`** (macos-14 — it compiles nothing): signs that DMG
  with Sparkle's `sign_update` and renders `appcast.xml` through
  `ops/release/appcast.mjs`.

**Why macos-15 for the two jobs that compile.** The macos-14 image's default
Xcode is 15.4, whose Swift is 5.10, and it refuses the package before doing
anything:

```
error: 'macos': package 'macos' is using Swift tools version 6.0.0 but the installed version is 5.10.0
```

The app still *targets* macOS 14 — `Package.swift`'s `platforms:` puts `minos
14.0` in the binary, which `otool -l` confirms. The runner image is the
toolchain that builds it, not the floor it runs on.

Both release jobs **skip cleanly** when their secrets are absent, the same way
the `images` job does for a fork without `packages:write`: the run logs a
`::notice::` and the release still gets every other asset. `publish` gathers
whatever exists and covers all of it in `checksums.txt`.

## The icon is a placeholder

`ops/release/make-app-icon.mjs` draws it — a rounded square in the design
system's `accent` with a white M — and `build-app.sh` runs it through `sips` and
`iconutil` at build time. Generated rather than committed on purpose: a binary
blob nobody remembers is the kind of placeholder that ships forever. Replacing
it means saving a real 1024pt master and pointing `build-app.sh` at it instead.

## Open, and worth settling before launch

**Where a bundled install's writable product dir lives.** The bundle embeds the
runtime under `Contents/Resources/metistry/`, and a signed bundle's Resources
cannot be written to — but `metistry update` in release mode has to write
`releases/<version>/`, flip `current`, and unpack a new `runtime/`. So either the
app copies the embedded tree to a writable location on first run (and the bundle
is a seed), or the bundled runtime is only ever replaced by a Sparkle update of
the whole app (and `metistry update` is a no-op for app installs). The scaffold
locates the runtime either way; it does not decide this.

**Whether the app gets a `manifest.yaml`.** Invariant 5 enumerates bridges,
collectors, agents, routines, targets and services — a client app is none of
those, and `core`'s manifest union has no type for one. `apps/macos` therefore
ships without a manifest and `metistry doctor` skips it, following the precedent
`packages/cli` already set: "the CLI ships no `manifest.yaml`: `core`'s schema
has no type for a command-line tool and inventing one is worse than the gap"
(`docs/ops/cli.md`, "Not yet"). Adding a `client` type is a schema change with
its own blast radius; worth doing deliberately or not at all.
