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
  streams the CLI's own output. **All seven act:**
  1. `metistry runtime install --from <bundle> --to <product dir>` when this
     build is running out of its own read-only bundle (below).
  2. `metistry init`, or adopt a folder that already holds an `identity.yaml`,
     which runs nothing.
  3. `metistry connect-repo --auth device|ssh` — the GitHub device code is
     parsed out of the CLI's stream and shown as a card with a link, while
     connect-repo keeps polling.
  4. `metistry secrets sync`, plus a
     `metistry secrets mint METISTRY_BRIDGE_TOKEN_<NAME>` per bridge you enable.
  5. `metistry up`, preceded by the shape: preview the other one
     (`up --dry-run` with `METISTRY_DEPLOYMENT_SHAPE`), then
     `metistry deployment set-shape <shape> --yes`. **"Set the Shape" stays
     disabled until the preview has been on screen** — preview-then-confirm is
     the rule the CLI holds destructive verbs to, and a `--yes` reachable
     without the preview would be the app confirming on the user's behalf.
  6. The door — **optional, and usually already done**: it opens with this
     Mac's sign-in state (`metistry console whoami --json`, "Signing in" below)
     and offers the console's enrolment code for a browser or a phone. The
     `ASAuthorization` path is still written and still runs the moment an
     install qualifies; the probe that measures why none does yet moved to
     Settings → Advanced.
  7. `claude setup-token` in a terminal the app opens, then a watch on
     `metistry secrets list --json` for `CLAUDE_CODE_OAUTH_TOKEN`.

  Steps 6 and 7 are the two that are **not** a `metistry` verb, so they own
  their own screens rather than being forced through the generic run row
  (`FirstRunStep.hasOwnScreen`, pinned by a test).
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
| **Any authenticated console call except `whoami`** | the app asks the CLI rather than holding the token, and the CLI has exactly one verb that speaks to the console: `metistry console whoami`. There is no `metistry console call <METHOD> <path>`, and no verb that prints a bearer to the calling process alone — so devices, agents, projects, proposals and dispatch are unreachable from the app. It is a CLI change first, deliberately ("Signing in" below) | the PWA — "Add to Dock" in Safari |
| **A native passkey** (wizard step 6) | measured, not assumed — see "What ASAuthorization actually says" below. `ASAuthorization` refuses *every* relying party from a Developer ID build, because an application identifier comes from an embedded provisioning profile and a DMG from GitHub Releases has none. **This stopped being step 6's problem on 2026-09-10**: this Mac needs no passkey at all | for a browser or a phone, the step's enrolment code — open the link here, or type it on the phone. Same `passkeys` row either way. The probe is under Settings → Advanced |
| `connect-repo --auth token` | it reads the PAT from **stdin**, and the app gives every child an empty stdin on purpose so no verb can hang a progress view waiting for a paste | the wizard shows the option, disabled, with that reason; run it in a terminal |
| **Minting an enrolment code** | there is no HTTP route that mints one, deliberately — whoever can run the host command already controls Postgres and the vault, so shell access is the root of trust for a first passkey (plan §4.2) — and `metistry enroll` is on the CLI's own "not yet" list | step 6 shows the exact `scripts/enroll.mjs` command and takes the code you paste back |
| **A QR code** for the phone | nothing in this product renders one yet; `apps/console/scripts/enroll.mjs` says the same about itself ("QR rendering arrives with `packages/cli`"), and an encoder is a dependency nobody has asked for | step 6 shows the enrolment URL, selectable, to type or hand over |
| **Registering the launchd agents through `SMAppService`** | **"Start at login" is real now** — but it registers *this app*, `SMAppService.mainApp`, which is a different thing from the install's jobs. See "Start at login" below for what moving those would take and why it is not this PR | nothing; `metistry up` owns those jobs and they already start at login |
| **The other eight destinations** | Feed, Chat, Agents, Projects, Artifacts, Capture, Needs You, Devices (design-system P6) | the PWA — "Add to Dock" in Safari |
| **An iOS target** | `MetistryKit` is already free of AppKit and of `Process` so it can be shared; there is no iOS target in `Package.swift` | — |

**Four things left this table on 2026-09-10**, and it is worth saying what
replaced them rather than letting them vanish: wizard step 7 (a terminal the app
opens plus a watch on the secret's *name*); writing `deployment.yaml` (the CLI
grew `deployment set-shape`, so the invariant is enforced at the tool where it
belongs and the app still writes no file); "Start at login" (`SMAppService.mainApp`,
which needed no CLI change at all — the old entry had conflated it with the
launchd agents); and "an instance id" (`metistry init` mints one into
`identity.yaml`, and `metistry identity --json` reports it).

An empty destination is not listed as a greyed-out placeholder. §3.15's
distinction holds throughout: *empty* (nothing has happened) and *absent* (never
configured) are different states, and neither is a failure.

## Signing in: this Mac is the owner, and it never sees the token

**The decision (owner, 2026-09-10).** The app is the same package as the CLI,
on the same machine, running as the same person. It therefore authenticates to
the **local** console *implicitly* — by a token only the logged-in user can
read — and never by a passkey ceremony. Passkeys stay exactly as they were, for
browsers, the phone, and every remote client. `docs/ops/auth.md` is the
console's side of this; what follows is the app's.

**The one call, and it is not HTTP.** On launch and on every instance switch
the app runs

```
metistry console whoami --json
```

and renders what came back. It does **not** read the login Keychain from Swift,
does **not** open `<instance>/state/.env`, and sends **no `Authorization`
header** anywhere. The CLI is the one place that knows where
`METISTRY_LOCAL_OWNER_TOKEN` lives, and it presents it over loopback without the
value ever reaching this process — `ConsoleWhoami` has no field a token could
land in. `apps/macos/tests/kit/console-sign-in-tests.swift` walks
`apps/macos/sources` and asserts all of that: one file uses `URLSession`, no
file sets a header other than `content-type`/`cookie`, no file names a Keychain
API, and no file opens a file at all.

**The five states, and what each says on screen.** Told apart by the CLI's exit
code and by three phrases in its own message — never by the variable's name,
which is being renamed and must not be load-bearing.

| state | header / Connections | dot | what it offers |
| --- | --- | --- | --- |
| **signed in** | "Signed in as owner (local token)", with `via local_owner_token`, `management yes` and the console URL | `ok` | nothing — there is nothing to do |
| **CLI too old** | "Cannot ask — this install's CLI has no `console whoami`" | `degraded` | `metistry update`. The install works; this app's view of it does not |
| **token unset** | "No local owner token on this install", with the CLI's own line | `absent` | `metistry secrets sync --to env`, then `metistry restart console` — both, in that order, because a freshly minted token does nothing until the console is restarted with it |
| **unreachable** | "The console did not answer", with the transport error verbatim | `failed` | nothing. No command this app could name would fix it |
| **401** | "The console refused the token (401)" | `failed` | the same two commands, plus **which cause is likelier**: under `compose` the loopback rule (Docker's NAT means the console sees the bridge gateway, so it needs `METISTRY_TRUSTED_LOOPBACK_PROXY`); under `launchd`, that the value here is not the one the console was *started* with. Shape unknown → both, said as both |

`absent` for an unminted token is the same rule as everywhere else: a thing
nobody configured is a fact, not a fault.

**Where it appears.** One `ConsoleSignInModel` for the whole app, so no two
screens can disagree and the question is asked once per launch rather than four
times: the Status panel's header (under the doctor summary, with `via`),
Settings → Connections (the full card, with the remedy and the exact argument
array), the menu bar (a second dot beside the `console` row, and the headline
inside its submenu — a service being *up* and a service *knowing who you are*
are different questions), and the wizard's step 6, which now leads with it.

**What the app can and cannot call.** It can ask who it is. It cannot make any
other authenticated console call, because PR #119 added `console whoami` and
nothing else — there is no verb that performs an arbitrary authenticated
request on the app's behalf, and none that prints a bearer to the calling
process alone. Everything on the owner surface (devices, agents, projects,
proposals, artifacts, targets, dispatch) is therefore the PWA's job for now.
Adding it is a **CLI change first**: a `metistry console call <METHOD> <path>`
keeps the token out of this process entirely, which a token-printing verb would
not, and keeps the rule that makes this app safe — a front end for the CLI,
never a second implementation.

## What `ASAuthorization` actually says about a local origin

Measured on 2026-09-10, because "passkeys don't work locally" is not an answer
anybody can act on. A probe making the same
`ASAuthorizationPlatformPublicKeyCredentialProvider` registration request the app
makes, in a bundle carrying this project's own identifier and signed with its
Developer ID identity, was pointed at three relying parties in turn:

```
RP 127.0.0.1:    com.apple.AuthenticationServices.AuthorizationError 1004: The operation
                 couldn’t be completed. The calling process does not have an application
                 identifier. Make sure it is properly configured.
RP localhost:    …identical…
RP studio.ts.net: …identical…
```

**The refusal is not about the relying party.** It is about the app.
`ASAuthorization` wants `com.apple.application-identifier`, which comes from an
embedded provisioning profile; a Developer ID build has none. Signing the
entitlement in by hand (`application-identifier` + `associated-domains`, same
identity) does not get further either — AMFI kills the process at launch,
SIGKILL, before `main` runs, because those are restricted entitlements that need
a matching profile.

So native passkeys are blocked by the **distribution channel**, not by the local
origin. The ratified channel is a Developer ID DMG from GitHub Releases
(`docs/product/desktop-app-plan.md`), which cannot carry a profile. It would take
an App Store build, or a Developer ID build provisioned through a profile.

**And even with a provisioned build, the origin would still have to change.**
Four separate reasons, each checked separately in
`sources/kit/passkey-enrolment.swift` and each named on screen, because they have
different fixes:

| | why | fixable by |
| --- | --- | --- |
| an IP-literal relying party | the console's RP ID is `new URL(METISTRY_ORIGIN).hostname` (`apps/console/src/webauthn.ts`), so `http://127.0.0.1:8080` gives `127.0.0.1` — and a WebAuthn relying party must be a domain | setting `METISTRY_ORIGIN` to a name |
| an `http:` origin | `ASAuthorization` presents the ceremony's origin as `https://<rpID>`, and the console compares it to `METISTRY_ORIGIN` with a plain `!==` | https |
| a port in the origin | that synthesized origin carries **no port** — it is exactly `https://<host>` — and the comparison is on the whole string, so `https://host:8443` can never match | serving on 443, or an `expectedOrigin` array server-side |
| no associated domain | macOS gates the RP ID on `webcredentials:<domain>`, which Apple verifies by fetching `https://<domain>/.well-known/apple-app-site-association` **through its own CDN** — unreachable for a loopback, a `.local` or a tailnet name | a publicly resolvable HTTPS domain |

`localhost` is a valid relying party in a *browser*, which is exactly why the
console's own enrolment page works and is the fallback. A browser's loopback
secure-context exemption is not an associated-domain exemption.

**The native path is written, not stubbed.** `sources/kit/console-client.swift`
speaks the real `POST /auth/enroll/start` and `POST /auth/enroll/finish` — the
same request and response shapes `apps/console/web/app.js` posts, field for
field, base64url and all — and `sources/app/passkey-registrar.swift` is the real
`ASAuthorization` call. `PasskeyRouting.decide` returns `.native` the moment an
install's origin and this app's entitlements allow it, and that code runs. Today
none do, and the screen says which reason applies.

The step also carries an **"Ask macOS"** button that runs the registration
request with a locally generated challenge and posts nothing anywhere. It exists
so the reason on screen is *evidence* rather than an assertion: press it and the
system says, in its own words, what it thinks of this relying party. It cannot
enrol anything — there is no console challenge in it.

**One thing to raise server-side.** `apps/console/src/webauthn.ts` compares
`clientDataJSON.origin !== cfg.origin` and lets `verifyRegistrationResponse`
throw, which the top-level handler turns into **HTTP 500**, not 401. So an origin
mismatch from any native client looks like an internal error with no useful body.
`@simplewebauthn/server` v13 accepts an array for `expectedOrigin`; accepting one
would make a native ceremony possible against a ported origin and would turn that
500 into a real answer. Not done here — it is a console change, and this PR is
the app.

## Start at login

**`SMAppService.mainApp`, and only that.** One call, one approval in System
Settings › General › Login Items, nothing written, no CLI change — the old
"not yet" entry had conflated it with something else entirely.

The status mapping lives in `sources/kit/login-item.swift` so it is testable
without a signed bundle to register (`SMAppService.Status` is `Int`-backed;
0 notRegistered, 1 enabled, 2 requiresApproval, 3 notFound, and anything else is
reported as `unknown(n)` rather than rounded to "off"). Two behaviours are worth
naming:

- **`requiresApproval` reads as ON.** It is registered — macOS is holding it,
  waiting for the person — so the toggle stays on and the row explains what is
  outstanding, with a button that opens the right pane. A toggle that flicked
  back off there would look broken when nothing is wrong.
- **The status is always re-read from macOS after a write**, never assumed from
  `register()` returning. `register()` succeeding *and* the status being
  `requiresApproval` is the normal first-time path.

`swift build` alone produces an executable, not a bundle, so `SMAppService.mainApp`
has nothing to register and answers `notFound`. The pane says exactly that and
points at `ops/release/build-app.sh`.

**What moving the launchd agents under `SMAppService` would take**, recorded
because it is the obvious next thought and it is a bigger change than it looks.
`SMAppService.agent(plistName:)` registers a plist that lives **inside the app
bundle**, at `Metistry.app/Contents/Library/LaunchAgents/`. That means:

- the plists are signed with the app and therefore **unwritable**, so every path
  in them has to be bundle-relative or resolved at run time — today `metistry up`
  renders absolute paths for the node binary, the product dir, the instance dir
  and the log files;
- the jobs become **the app's**, not the install's. One app would register one
  job set, so the "several instance directories, switch between them" shape the
  plan already commits to would need the label and port namespacing that is
  already a recorded follow-up;
- `metistry up` from a terminal and the app would install *different* jobs,
  which is precisely the second implementation the whole design forbids.

So it stays a CLI change first: a `metistry up` that can hand over its job set
rather than installing it. `metistry up` owns those jobs today and they already
start at login on their own.

## Step 7: the Claude token, and what the app never touches

`claude setup-token` opens a browser and waits. The app hands every child an
**empty stdin** on purpose (`sources/app/process-command-runner.swift`) so no
verb can hang a progress view waiting for input — which means the app
structurally cannot drive this one. Rather than fake a progress bar over
something it is not driving, it opens the command where the person can answer it.

**A `.command` file, not AppleScript.** Telling Terminal to `do script` is
automation, which means an Apple Events TCC prompt and a permission this app
otherwise needs none of (the entitlements file's whole argument is that it
touches no TCC-protected resource itself). A `.command` file is just a document
macOS opens with whichever terminal the person has set as the handler — no
entitlement, no prompt, their choice honoured. It is written `0700` into the
app's own caches directory and contains one command line the app already shows on
screen.

Then the app polls `metistry secrets list --json` for
`CLAUDE_CODE_OAUTH_TOKEN` — every 4 seconds, 60 times, and it **says so when it
gives up** rather than quietly stopping. `metistry secrets sync --to keychain` is
shown as the exact command that carries the token from where Claude Code left it
into the login Keychain, which is user-scoped: one Claude login per Mac, shared
by every instance (`packages/cli/src/secrets.ts`'s `SECRET_SCOPES`).

**The app never handles the value.** Not in a field, not in a variable, not in a
log line. Everything it knows about that secret is a boolean, and the verb it
asks has no code path that can print one.

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
| Instance | instance id, assistant name, mention, icon | `metistry identity --json`, **read only** — the file behind it is a §4.7 protected path, so there is no field to edit any of it |
| Instance | Set up again… | re-enters the wizard |
| Services | shape, and which file it came from | `doctor --json` → the `deployment` row's `meta` (the CLI resolved the D4 overlay) |
| Services | the service list with status | the same `meta`'s service plan, matched against doctor's `service` rows |
| Services | Start at login | `SMAppService.mainApp` — macOS keeps the registration; the app writes nothing (above) |
| Connections | console sign-in: who this Mac is, with `via`, the remedy, and the argument array | `metistry console whoami --json` — the app never resolves, holds or displays the token ("Signing in" above) |
| Connections | instance repo status, HEAD, queue depth | `doctor --json` → the `reconciler` row's `meta`. The reconciler is the sole committer, so the app runs no git of its own |
| Connections | Claude token set / not set | `metistry secrets list --json` — never a value |
| Connections | bridges | `doctor --json` → the `bridge` rows |
| Secrets | names, scope, and the account each was found under | `metistry secrets list --json` — names only; the verb has no code path that can print a value, and neither has the pane |
| Updates | version, channel, feed, automatic checks, Check Now | Sparkle, which owns those preferences itself |
| Updates | instance pin | `metistry version --json` → its `lock` block |
| Advanced | resolved runtime, product directory | the runtime locator (below) |
| Advanced | product and bundled-runtime versions | `metistry version --json` |
| Advanced | developer runtime override | the persisted pointer |
| Advanced | Run doctor | `metistry doctor --json` |
| Advanced | passkey diagnostic ("Ask macOS") | `ASAuthorization` against the console's relying party with a LOCAL challenge — nothing is sent and nothing can be enrolled. It was wizard step 6 until 2026-09-10; it is a diagnostic, not a setup step |
| Advanced | log folder | the launchd plists' `StandardOutPath` convention (`/tmp/metistry-<name>.log`), labelled as a convention. The menu's **View Log** uses `metistry logs <name> --lines 200` instead, because a container's or a systemd unit's log is not a file here |

**There are no file reads left.** The scaffold read `identity.yaml` and
`metistry.lock` with a ~60-line YAML scalar reader, read the checkout's
`package.json` for a version, and parsed `metistry secrets list`'s table — all
four because the CLI reported none of it. This doc named the first as the thing
`metistry identity --json` would delete. It did, along with the rest:
`identity --json`, `version --json` and `secrets list --json` replaced every one,
and `sources/kit/instance-files.swift` is now a single file-existence test (is
there an `identity.yaml` here?), which is not a parse.

The table parser was worth deleting on its own: `secrets list` grew a `scope`
column when instance directories became self-contained, and the app's
three-column regex had matched nothing since. A parser of somebody else's table
is a bug with a delay on it.

**What a CLI older than this app looks like.** `packages/cli/src/main.ts`'s
default branch answers `unknown command: <verb>` with exit 2, and every read
turns that into one sentence — *"this CLI has no `identity` verb yet — update it
(metistry update, or Check for Updates…)"* — rather than a blank pane or a wrong
"not set". One place decides it (`CLIDegradation` in `sources/kit/cli-facts.swift`),
so the menu bar's lifecycle verbs, the log window and the four read verbs all say
it identically.

**On key spellings.** The CLI's JSON is not internally consistent — `doctor
--json` is snake_case (`as_of`, `latency_ms`), `restart --json` is single words,
and `SecretListing` in `packages/cli/src/secrets.ts` is camelCase (`inKeychain`,
`foundUnder`). The readers accept both spellings of a two-word key rather than
guessing one and blanking a pane over a convention. That is a reader-side
tolerance, not a wire contract: the shape is the CLI's.

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
  package.json         name and version only, private. It ships no JavaScript:
                       it exists so changesets versions the app with the product
                       and gives it a CHANGELOG line (docs/ops/releases.md)
  sources/kit/         MetistryKit: the models and the views — Settings, the
                       wizard, the menu bar, the Status panel, the log window.
                       No AppKit, no Process, no platform frameworks — an iOS
                       target shares it as is.
  sources/app/         the Metistry executable: @main and the four scenes
                       (window, Settings, log window, MenuBarExtra), Sparkle,
                       the Process-backed CommandRunner, and the four platform
                       seams the kit declares and does not have: SMAppService,
                       ASAuthorization, a terminal opener, and the AppKit calls
                       (reveal in Finder, quit, Sparkle's own UI)
  tests/kit/           swift-testing unit tests over the kit
  resources/           Info.plist template + the entitlements file
```

**Every platform framework is behind a protocol the kit declares.**
`CommandRunner` (a subprocess), `LoginItemService` (`SMAppService`),
`PasskeyRegistrar` (`ASAuthorization`, which needs an `NSWindow` as its
presentation anchor) and `TerminalOpener` (`NSWorkspace`). That is what keeps
`MetistryKit` free of AppKit and of `Process` — an iOS target supplies its own
four — and it is also what makes the models testable: every one of those seams
has a fake in `tests/kit/`, so the SMAppService status machine, the passkey route
decision and the token watch are exercised without a signed bundle, a Touch ID
prompt or a terminal window.

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

1. **checkout** — the folder chosen in the app, or `METISTRY_PRODUCT_DIR`. Uses
   the checkout's own `runtime/node/bin/node` when it has one (the node
   `metistry up` renders into the launchd plists), else a `node` from
   `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`.
2. **installed** — `~/Library/Application Support/Metistry/product/`, what
   `metistry runtime install` wrote out of the bundle. **The writable one**, and
   therefore the one `metistry update` can lay a new `releases/<version>/` into.
3. **bundled** — `Metistry.app/Contents/Resources/metistry/`, needing both
   `runtime/node/bin/node` and `…/packages/cli/dist/main.js`. Signed and
   read-only, so it is a **seed**, not the install.
4. **path** — a `metistry` in those same directories.

Both 2 and 3 prefer the `current` symlink when there is one, because that is
exactly how `metistry update` lays out a release install — `releases/<version>/`
with `current` pointing at one and `runtime/` **beside** them, never inside one,
so a version flip never orphans Node.

**Why the checkout moved to the front.** It was third. The new second stage is
something the *app* put there; a developer override is the only pointer in this
app a person sets **by hand**, and an explicit choice has to beat one the app
made for itself — otherwise a stale Application Support copy silently shadows the
checkout somebody is actively working on, which is exactly what happened the
first time this was ordered the other way round. Nothing changes for a shipped
app: it has neither set, so it falls straight through to its own runtime.

Every verb is invoked with an explicit `--product-dir`: a GUI process has no
meaningful working directory to fall back on.

**Where a bundled install's writable product dir lives — settled.** This was the
scaffold's open question: `Contents/Resources/metistry/` is inside a signed
bundle and cannot be written to, but `metistry update` in release mode has to
write `releases/<version>/`, flip `current`, and unpack a new `runtime/`. The
answer is the first of the two options the plan set out — **the bundle is a seed,
copied once to `~/Library/Application Support/Metistry/product`** — which is also
what the plan's own "Two channels, both signed" paragraph already read as.
Application Support rather than the instance directory because the product is
*code*: one copy serves every instance, and the plan's "what lives where" table
already puts `releases/`, `runtime/` and `current` in the install dir.

**The copy is a CLI verb, not something the app does.** Wizard step 1 runs
`metistry runtime install --from <bundle> --to <dir>` and re-resolves when it
succeeds. An app that laid out a release install itself would be a second
implementation of `metistry update`'s release mode, which is the one thing this
design forbids. Until the copy exists the app runs happily out of the seed and
step 1 says what is left to do and why — a read-only runtime is not a fault.

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

**Whether native passkeys are worth a provisioned build.** Measured above: they
are unreachable from a Developer ID DMG whatever the origin is, because
`ASAuthorization` wants an application identifier and that needs an embedded
provisioning profile. Getting one is a build step, not a channel change: Apple
issues Developer ID provisioning profiles (App ID + Associated Domains,
embedded as `Contents/embedded.provisionprofile`, signed with the
application-identifier and associated-domains entitlements) — and it would
*still* need a publicly resolvable HTTPS origin on 443 serving an AASA, which a
loopback install does not have and a tailnet install has only through a
gateway. The console's
enrolment-code flow works today on every install, on this Mac and on the phone.
Worth deciding deliberately rather than drifting into.

**Whether the console should accept an array of expected origins.** One line in
`apps/console/src/webauthn.ts` (`@simplewebauthn/server` v13 supports it) would
let a native ceremony match a ported origin, and would turn today's opaque
HTTP 500 on a mismatch into a real answer. It is a console change, so it is not
in this PR — but it is half of what a provisioned build would need, and the
error-shape half is worth doing on its own.

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
