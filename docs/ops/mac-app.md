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
- **Settings**, in the `Settings` scene: ⌘, and the app menu, six panes —
  Instance, Services, Connections, Secrets, Updates, Advanced. Every value on
  them is one of three things and the pane says which: a pointer the app
  remembers, a read-through of a file or a verb the CLI owns, or a labelled
  "not yet". The table below is the whole contract.
- **The first-launch wizard.** A sheet over the plan's seven steps, shown when
  no instance is selected and re-enterable from **Settings → Instance → Set up
  again…**. Back/Continue/Skip; each choice carries what it gets you and what it
  costs; every step shows the exact argument array *before* running the verb and
  streams the CLI's own output. Steps 1–5 are real — locate the runtime;
  `metistry init` (or adopt a folder that already holds an `identity.yaml`, which
  runs nothing); `metistry connect-repo --auth device|ssh` (the GitHub device
  code is parsed out of the CLI's stream and shown as a card with a link, while
  connect-repo keeps polling); `metistry secrets sync`, plus a
  `metistry secrets mint METISTRY_BRIDGE_TOKEN_<NAME>` per bridge you enable;
  `metistry up`.
- **The menu-bar item.** Its glyph is the worst *fault* across components.
  `absent` never drives it — a bridge that was never configured is not a fault,
  which is the same rule that keeps `absent` out of doctor's exit code. The menu
  groups every component by doctor's own `kind` (Services, Bridges, Launchd
  Jobs, Containers, …) with a status dot and a submenu: Restart, Stop, Start,
  View Log. Above them: Restart All, Stop All, and "Update Available: x.y.z"
  when Sparkle has found one.
- **Sparkle auto-update.** Pinned to 2.9.6 — the same version
  `ops/release/runtime-versions.env` pins the signing tools to. The feed is
  `https://github.com/foldedspacelabs/metistry/releases/latest/download/appcast.xml`
  and the public EdDSA key is `SUPublicEDKey` in `Info.plist`; both are read by
  Sparkle itself, so the app cannot disagree with the workflow that signs the
  feed. Sparkle also owns its own preferences — the Updates pane's
  automatic-checks toggle writes Sparkle's `automaticallyChecksForUpdates`, not
  a key of ours.

**Not yet, and labelled as such on screen:**

| | why | what to do today |
| --- | --- | --- |
| Wizard step 6, **passkey** | needs `ASAuthorization` against the console's local origin *and* a `metistry` verb to register the credential; neither exists | enrol from the console in a browser |
| Wizard step 7, **Claude token** | `claude setup-token` is an interactive terminal flow; driving it needs a pty, and the token needs its own `metistry secrets` path | `claude setup-token`, then `metistry secrets mint CLAUDE_CODE_OAUTH_TOKEN` |
| `connect-repo --auth token` | it reads the PAT from **stdin**, and the app gives every child an empty stdin on purpose so no verb can hang a progress view waiting for a paste | the wizard shows the option, disabled, with that reason; run it in a terminal |
| **Writing `deployment.yaml`** | the shape is `deployment.yaml`'s to state, and that is a §4.7 protected path — the user's own hand, invariant 2 — and no `metistry` verb writes it either | the wizard explains both shapes and previews the other one (`up --dry-run` with `METISTRY_DEPLOYMENT_SHAPE`); the one-line edit stays yours |
| **Start at login** (`SMAppService`) | step 5 registers launchd jobs the way the terminal does — `metistry up` writing `~/Library/LaunchAgents`. `SMAppService` (macOS 13+) is the sanctioned way an app installs its own agents, with one approval in System Settings and no plist to edit; it needs a `metistry up` that hands the app its job set rather than installing it, so it is a CLI change first | nothing; the current shape works. The Services pane shows the toggle disabled, with that reason |
| **An instance id** | there is none in the product: `identity.yaml` carries name · mention · voice · icon, and neither `metistry.lock` nor `doctor` reports one | the Instance pane shows the folder path and the product pin, and says so |
| **The other eight destinations** | Feed, Chat, Agents, Projects, Artifacts, Capture, Needs You, Devices (design-system P6) | the PWA — "Add to Dock" in Safari |
| **An iOS target** | `MetistryKit` is already free of AppKit and of `Process` so it can be shared; there is no iOS target in `Package.swift` | — |

An empty destination is not listed as a greyed-out placeholder. §3.15's
distinction holds throughout: *empty* (nothing has happened) and *absent* (never
configured) are different states, and neither is a failure.

## Settings: persisted vs read-through

**The rule (owner direction 2026-09-09):** every setting is a front for a file
the CLI owns. The app persists three POINTERS and no configuration.

| The app persists | Key | Why it is a pointer, not a setting |
| --- | --- | --- |
| Active instance | `activeInstance` | Which install the app is looking at. Reaches every verb as `METISTRY_INSTANCE_DIR`. |
| Recents | `recentInstances` | The eight it looked at before, most recent first. |
| Developer runtime override | `developerProductDirectory` | A product checkout, for a build with no runtime bundled inside it. Settings → Advanced only. |

Sparkle's own preferences (`SUEnableAutomaticChecks`, `SULastCheckTime`) and
AppKit's window frames live in the same domain and are *theirs*: the app keeps no
copy. `apps/macos/tests/kit/settings-model-tests.swift` drives the models through
a fresh defaults suite and asserts exactly those three keys reach disk, so a
fourth one fails CI rather than appearing quietly.

| Pane | Value | Read through |
| --- | --- | --- |
| Instance | active directory, recents, Open in Finder | the persisted pointers above |
| Instance | assistant name, mention, icon | `<instance>/identity.yaml`, **read only** — a §4.7 protected path, so there is no field to edit it |
| Instance | Set up again… | re-enters the wizard |
| Services | shape, and which file it came from | `doctor --json` → the `deployment` row's `meta` (the CLI resolved the D4 overlay) |
| Services | the service list with status | the same `meta`'s service plan, matched against doctor's `service` rows |
| Services | Start at login | disabled, labelled "not yet" (above) |
| Connections | instance repo status, HEAD, queue depth | `doctor --json` → the `reconciler` row's `meta`. The reconciler is the sole committer, so the app runs no git of its own |
| Connections | Claude token set / not set | `metistry secrets list` — never a value |
| Connections | bridges | `doctor --json` → the `bridge` rows |
| Secrets | names and scope | `metistry secrets list` — names only; the verb has no code path that can print a value, and neither has the pane |
| Updates | version, channel, feed, automatic checks, Check Now | Sparkle, which owns those preferences itself |
| Updates | instance pin | `<instance>/metistry.lock` |
| Advanced | resolved runtime, product directory | the runtime locator (below) |
| Advanced | product runtime version | the located checkout's `package.json` — the same value `productVersion()` reads. There is no `metistry --version` to ask |
| Advanced | developer runtime override | the persisted pointer |
| Advanced | Run doctor | `metistry doctor --json` |
| Advanced | log folder | the launchd plists' `StandardOutPath` convention (`/tmp/metistry-<name>.log`), labelled as a convention. The menu's **View Log** uses `metistry logs <name> --lines 200` instead, because a container's or a systemd unit's log is not a file here |

**Two file reads, and why they are not a second implementation.**
`identity.yaml` and `metistry.lock` are read directly, by a ~60-line scalar
reader in `sources/kit/instance-files.swift` — not a YAML parser: top-level and
one-level-nested scalars, block scalars skipped, sequences counted. Nothing in
the CLI reports the assistant's name (no verb, and not `doctor --json`), so the
alternative is a Swift YAML dependency for two files with a fixed,
seed-generated shape. **A `metistry identity --json` would delete that reader**,
and is the right fix when the CLI next has a reason to grow one.

## The menu bar

Grouped by doctor's own `kind`, so a new component kind appears without a change
here (invariant 5). The per-row submenu maps the row to the **component name**
the lifecycle verbs take — `compose:console` → `console`,
`launchd:com.foldedspacelabs.metistry.watchdog` → `watchdog` — and a launchd
label that is not ours keeps its full name rather than being guessed at
(`sources/kit/component-control.swift`, pinned by tests).

Only kinds with a process behind them (`service`, `bridge`, `launchd`,
`container`) offer Restart/Stop/Start; a manifest that validates, a migration
count and the resolved shape are checks, not processes, and the menu does not
invent a control the CLI has no verb for.

**Refresh:** doctor is re-run when the menu opens and every 30s while it stays
open — never continuously. `doctor --json` is a full sweep (every bridge over
HTTP, `docker compose ps`), far too heavy to poll; the watchdog already keeps a
liveness view of the same components, and its feed is the intended faster source
once the app has a read path to it (a management-API query, not a database
connection — invariant 3).

**`restart` / `stop` / `start` / `logs` are new verbs.** A CLI that predates them
answers `unknown command: restart` with exit 2, and the app says "this CLI has no
`restart` verb yet — update it" rather than reporting a failed restart.

## Layout

```
apps/macos/
  Package.swift        SwiftPM manifest — no Xcode project
  Package.resolved     the Sparkle pin; tracked, and CI builds with
                       --disable-automatic-resolution so a stale one fails
  sources/kit/         MetistryKit: the models and the views — Settings, the
                       wizard, the menu bar, the Status panel, the log window.
                       No AppKit, no Process — an iOS target shares it as is.
  sources/app/         the Metistry executable: @main and the four scenes
                       (window, Settings, log window, MenuBarExtra), Sparkle,
                       the Process-backed CommandRunner, and the only three
                       AppKit calls in the app (reveal in Finder, quit,
                       Sparkle's own UI)
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

### The install layout: the bundle is a seed

A signed bundle's `Contents/Resources/metistry/` cannot be written to, and
`metistry update --channel release` must write `releases/<version>/`, flip
`current` and unpack a new `runtime/`. So the bundle **seeds** a writable
product directory, once, and the CLI owns it from then on — identically to
a checkout install (decision ratified 2026-09-10,
`docs/product/desktop-app-plan.md`).

```sh
metistry runtime install --from /Applications/Metistry.app
```

```
/Applications/Metistry.app/Contents/Resources/metistry/   the SEED (read-only, signed)
  releases/<version>/ · current -> releases/<version> · runtime/

~/Library/Application Support/Metistry/product/           the PRODUCT DIR (writable)
  releases/<version>/      the runtime pack — what every plist's __REPO__ resolves through
  current -> releases/<version>
  runtime/                 Node, Postgres + pgvector, git — BESIDE releases/, so a
                           version flip never orphans the Postgres the db job points at
  .metistry-install.json   {version, release.manifest_sha256, runtime.manifest_sha256, from}
```

`--to <dir>` overrides the destination. It is **idempotent**: the seed's own
`releases/<v>/metistry-runtime.json` and `runtime/manifest.json` are read
and cross-checked against the `current` symlink before a byte is copied,
and their sha256s land in `.metistry-install.json`, so the same seed twice
does nothing (`--force` copies anyway). A bundle whose manifest and
`current` disagree, or that carries no `packages/cli/dist/main.js`, is
refused rather than half-installed. The receipt is written **last**, so an
interrupted run is re-done rather than mistaken for a finished one.

When Sparkle updates the app it ships a newer seed; the next
`metistry runtime install` copies it forward and leaves the previous
`releases/<v>` in place, so `metistry update --rollback` still works.

Two details that are not cosmetic. The copied tree is made **writable**
(`cp` preserves the bundle's `0555` directories, and `update` could not
then delete a release to install the next one over it). And `runtime/` is
copied with its symlinks intact, not through them — `postgres/lib` is
libpq's versioned-name symlink farm, and the pack's `node_modules` is
pnpm's relative-symlink tree, which dereferencing severs.

Instances go elsewhere and are self-contained:
`~/Library/Application Support/Metistry/<name>/` holds the vault,
`identity.yaml`, `state/.env`, `state/pg`, `state/assistant` and — when the
install is namespaced — `state/ports.yaml`.

> **`state/.env` values must be shell-quoted** when they contain a space.
> The reconciler, watchdog and TCC bridge jobs load that file with
> `set -a; . <file>`, which *runs* it. `metistry up` refuses rather than
> installing jobs that respawn forever, but the app should write
> `METISTRY_INSTANCE_DIR="…/Application Support/…"` with the quotes.

### Pointing a local build at an install

Two pointers, and they are different things. The **instance** is the install the
app manages; the **developer runtime override** is where the CLI itself lives,
and a build with an embedded runtime never needs it.

```sh
# which install the app manages — Settings → Instance → Choose…
defaults write com.foldedspacelabs.metistry activeInstance -string ~/Development/metistry-instance
# only for a build with no runtime inside it — Settings → Advanced
defaults write com.foldedspacelabs.metistry developerProductDirectory -string ~/src/metistry
```

The wizard's step 1 offers the override too, but only when no runtime was found —
there is no reason to ask a shipped app where the product is. **The scaffold's
`productDirectory` key is gone**; a value left over from an earlier build is
migrated to `developerProductDirectory` on first launch and removed.

The checkout needs `packages/cli/dist/main.js` built (`pnpm -r build`) and a
`.env`. The app also honours `METISTRY_PRODUCT_DIR` when the process happens to
have one — a Finder-launched app does not, which is why the folder picker
exists. Every verb the app runs is given `METISTRY_INSTANCE_DIR=<activeInstance>`;
an inherited variable wins over the checkout's `.env` (the CLI's loader fills
gaps only), which is what makes the app's instance choice mean something.

**How the runtime resolves, in order.** Each rejection is shown on the screen
with its reason, so "not found" is never a shrug:

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

**~~Where a bundled install's writable product dir lives.~~ Settled
2026-09-10: the bundle is a seed.** The app runs `metistry runtime install
--from <its own bundle>` on first launch, which copies the embedded tree to
`~/Library/Application Support/Metistry/product/`; every plist points there
and `metistry update --channel release` works exactly as it does on a
checkout install. The alternative — Sparkle-only updates, with `update` a
no-op for app installs — was rejected: the product could then only move when
the whole app did, the terminal and app paths would stop being one tested
path, and `releases/`/`current`/`--rollback` would exist for checkout
installs only. "The install layout" above has the shape; the rationale is in
`docs/product/desktop-app-plan.md`.

**What the app still has to do about it.** Run the verb on launch (it is a
no-op when the seed is unchanged, so it is safe every time), and show its
output on a progress screen the way the other first-run steps do. Until then
a developer build points at a checkout instead.

**Whether the app gets a `manifest.yaml`.** Invariant 5 enumerates bridges,
collectors, agents, routines, targets and services — a client app is none of
those, and `core`'s manifest union has no type for one. `apps/macos` therefore
ships without a manifest and `metistry doctor` skips it, following the precedent
`packages/cli` already set: "the CLI ships no `manifest.yaml`: `core`'s schema
has no type for a command-line tool and inventing one is worse than the gap"
(`docs/ops/cli.md`, "Not yet"). Adding a `client` type is a schema change with
its own blast radius; worth doing deliberately or not at all.
