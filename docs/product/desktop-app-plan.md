# Desktop client — planning document (2026-09-07)

> Status: **planning only.** Extends `ios-app-plan.md`: the free
> native client is one **SwiftUI multiplatform app (macOS + iOS)**, and
> the installed PWA is the desktop client for every other OS. Research
> and rationale in `docs/research/2026-09-codegraff-review.md`.

## Two desktop clients, both real

1. **Installed PWA** (now): Safari "Add to Dock" on macOS 14+, Chrome/Edge
   "Install app" on Windows/Linux. The full management UI in a window,
   today, zero code. Documented in `docs/ops/` as the desktop story for
   non-Apple machines and for anyone who doesn't want the app.
2. **Native Apple app** (post-Phase 6, free, THE distribution channel — was "iOS
   app"): one codebase, macOS and iOS targets, same open management API
   and `/mcp`, **no private endpoints** (ratified). Adds what only
   native can: menu-bar status with `doctor` at a glance, global capture
   hotkey and drag-drop capture, local notifications with actions (no
   push needed on the host machine), APNs on the phone, Keychain-held
   tokens, native passkeys, Shortcuts/App Intents, widgets on both.

## The window (single pane of glass) — panels, in priority order

| Panel | Backed by (all existing) | Notes |
| --- | --- | --- |
| **Activity feed** (home) | new seed query `activity_feed`: `runs` (tool, turn, crew_run, dispatch, task_op, agent_admin) ∪ `proposals` ∪ `work.history` ∪ `outbound_messages` | Time-ordered "what happened"; filter by agent / project / kind; the weekly review is this feed summarised |
| **Agents** | `agents`, `work` claims/leases, delivery-evidence tier, `runs` spend | Presence chips: working / queued / idle / blocked / over-cap / interrupted (lease expired). Drag a task or bundle onto an agent = dispatch; a refused drop shows the boundary reason |
| **Chat** | `/message`, `/api/messages`, `runs kind=tool` | Tool activity collapsed under each reply; per-turn model/effort picker in the toolbar; explicit turn state |
| **Projects** | `projects`, `projects_rollup` | Mode toggle (autonomous/review), budget, caps, members |
| **Artifacts + Vault** | artifacts, versions, comments; reconciler `log`/`diff` | What the assistant wrote to knowledge, with one-click attributed revert |
| **Capture / Triage** | inbox, proposals | Existing tabs; desktop adds hotkey + drop target + local-file link (host co-location only) |
| **Dashboard / Status** | existing queries; `doctor` | Menu-bar item mirrors `doctor` |

## Design rules carried over
- Same design language as web and iOS (ux-direction): buttons and menus
  over memorised syntax, question-answer flows, actionable notifications,
  visible model selection; slash commands stay as the power layer.
- Every agent-authored string is data: output-encoded, sanitised, never
  an instruction. Native views inherit CRIT-7 exactly as the PWA does.
- Nothing in the app talks to Postgres or the vault directly — the
  management API, `/mcp`, and the reconciler bridge are the only paths
  (invariants 3, 7, 9 apply to clients too).

## Sequencing
1. Now: document the installed PWA; add the `activity_feed` seed query
   and a feed panel to the PWA (cheap, and it is the desktop app's data).
2. With the UX pass (frontend designer, per owner): agent presence
   chips, collapsed tool activity, drag-to-dispatch — in the PWA first,
   so the native app copies a settled interaction rather than inventing.
3. Post-Phase 6: the SwiftUI multiplatform app, macOS target first if
   the work install lands before the phone matters, iOS first otherwise.
4. **Next for the macOS target** — the 2026-09-09 list is done. It read:
   `metistry restart|stop|start|logs`, then the read verbs that delete the
   app's file readers (`identity --json`, `--version`,
   `secrets list --json`), then the pty that unblocks step 7 and
   `--auth token`, then `SMAppService`. All of it landed except the pty,
   which turned out to unblock only `--auth token` — step 7 is real without
   one (2026-09-10 below). What is left, in this order: a `metistry enroll`
   so the app stops printing a `scripts/enroll.mjs` command; the pty for
   `--auth token`; then the other eight destinations, still behind the UX
   pass at step 2.

### What shipped (2026-09-09) — `apps/macos`, the first buildable scaffold

The macOS target exists: a SwiftPM package (no Xcode project), assembled
into a signed `Metistry.app` by `ops/release/build-app.sh` and shipped as a
notarized DMG plus an EdDSA-signed `appcast.xml` by `release.yml`. Full
account: `docs/ops/mac-app.md`.

**Real:** the menu-bar item and one window; the **Status** panel rendering
`metistry doctor --json` to the design system's §3.13 (tokens generated
from `tokens.json` into Swift by the same script that emits `tokens.css`);
**first-run steps 1–5** as real screens, each showing the exact argument
array before it runs the verb and streaming the CLI's own output — runtime
location, `init`, `connect-repo --auth device` (device code parsed out of
the stream and shown as a card), `secrets sync`, `up`; Sparkle 2.9.6
against the release feed. `MetistryKit`, which holds every model and view,
is free of AppKit and of `Process`, so an iOS target shares it unchanged.

**Then (2026-09-09, second pass — owner direction): Settings, a wizard,
and a menu bar worth opening.**

- **Settings in the usual spot** — the `Settings` scene, ⌘, and the app
  menu. Six panes (Instance · Services · Connections · Secrets · Updates ·
  Advanced), and the rule that shapes all of them: **every setting is a
  front for a file the CLI owns, never app-private state.** The app
  persists three POINTERS — active instance, recents, and a developer
  runtime override — and nothing else; a unit test asserts the whole
  defaults domain so a fourth key cannot appear quietly. The scaffold's
  *product-directory preference is removed*: a shipped app's product is
  the runtime inside its own bundle, so there is nothing to ask, and the
  override that a developer build still needs moved to Advanced.
- **A first-launch wizard** replacing the "First run" tab group: a sheet
  over the same seven steps, Back/Continue/Skip, shown when no instance is
  selected and re-enterable from Settings → Instance. Each choice carries
  what it gets you and what it costs — new instance vs. an existing
  folder, connect a repository now vs. later, device flow vs. SSH vs. a
  pasted token, compose vs. launchd, which bridges to enable.
- **A menu bar that is actually useful**: every component grouped by
  doctor's own `kind` with a status dot and a submenu (Restart · Stop ·
  Start · View Log), plus Restart All, Stop All and "Update Available:
  x.y.z". Doctor is re-run on open and every 30s while the menu is open;
  the watchdog feed is the intended faster source once the app has a read
  path to it.

**Explicit follow-ups**, each labelled "not yet" in the app itself rather
than faked:

- **`connect-repo --auth token` from the app.** It reads the PAT from
  stdin, and the app hands every child an empty stdin on purpose so no
  verb can hang a progress view waiting for a paste. The wizard shows the
  option disabled with that reason; a pty would lift it.
- **The other eight destinations** (Feed, Chat, Agents, Projects,
  Artifacts, Capture, Needs You, Devices — P6). The PWA is the answer until
  the UX pass settles them, per sequencing step 2.
- **The iOS target.** Not in `Package.swift` yet; the kit is ready for it.

### Then (2026-09-10, third pass): all seven steps act

Full account: `docs/ops/mac-app.md`. What changed, and the two decisions it
forced.

- **The app holds no parser for a file the CLI owns.** `identity --json`,
  `version --json` and `secrets list --json` replaced the YAML scalar
  reader, the `metistry.lock` reader, the `package.json` read and the
  `secrets list` table parser — the last of which had already gone stale
  when `secrets list` grew a `scope` column. The Instance pane shows the
  **instance id** it previously had to report did not exist.
- **Step 5 sets the shape.** `metistry deployment set-shape --yes`, after
  the preview, with the confirm button disabled until the preview has been
  on screen. The invariant moved to where it belongs — the tool — and the
  app still writes no file.
- **Step 7 is real without a pty.** `claude setup-token` opens in a
  `.command` file the user's own terminal handles (AppleScript would mean
  an Apple Events TCC prompt this app otherwise needs none of), and the app
  then polls `secrets list --json` for the token's *name*. It never handles
  the value. The pty is still what `--auth token` needs; step 7 no longer
  waits on it.
- **`SMAppService` shipped, for the app only.** `SMAppService.mainApp` is
  one call and one approval, with `requiresApproval` reported as
  registered-and-waiting rather than off. The old follow-up had conflated
  that with the install's launchd agents. **Moving those** would put their
  plists inside `Contents/Library/LaunchAgents` — signed, unwritable, so
  every path in them bundle-relative — and would make the jobs the *app's*
  rather than the install's, so one app could not serve several instance
  directories, and a terminal `metistry up` and the app would install
  different job sets. It stays a CLI change first.

**Decision 1 — where a bundled install's writable product dir lives:
`~/Library/Application Support/Metistry/product`.** The bundle is a **seed**
(the first of the two options above, which "Two channels, both signed" below
already read as); the copy is `metistry runtime install --from <bundle> --to
<dir>`, a CLI verb the wizard's step 1 runs. Application Support rather than
the instance directory because the product is *code* and one copy serves every
instance — "what lives where" above already puts `releases/`, `runtime/` and
`current` in the install dir. An app that laid out a release install itself
would be a second implementation of `metistry update`.

**Decision 2 — native passkeys need a provisioned build, not a better
origin.** Measured, not assumed: an `ASAuthorization` registration request from
a Developer ID build signed with this project's own identity is refused
identically for `127.0.0.1`, `localhost` and a tailnet name —
`AuthorizationError 1004: the calling process does not have an application
identifier` — and hand-signing the entitlement gets the process killed at
launch. An application identifier comes from an embedded provisioning profile.
**Correction (owner review, 2026-09-10): a Developer ID DMG *can* carry one.**
Apple issues *Developer ID* provisioning profiles for exactly this — an App ID
with the Associated Domains capability, embedded as
`Contents/embedded.provisionprofile` and signed with the application-identifier
and associated-domains entitlements; it is how Developer ID apps get iCloud,
push and associated domains outside the App Store. So the profile is a build
step, not a channel limit. Even with a provisioned build the origin would still have to be a plain
`https://<domain>` on 443 whose AASA Apple's CDN can fetch, because
`ASAuthorization` synthesizes the ceremony origin as `https://<rpID>` with no
port and the console compares it to `METISTRY_ORIGIN` verbatim. So the ios-app
plan's "**zero server change**" line does not hold for a ported or loopback
origin — flagged rather than routed around. **Step 6 therefore falls back to
the console's own enrolment code**, opened here or typed on the phone, with the
reason on screen and an "Ask macOS" button that runs the request against a
local challenge so the claim is checkable. The native path is written, not
stubbed, and runs the moment an install qualifies.

### Then (2026-09-10, fourth pass): the Mac is signed in, not enrolled

**Decision 3 — the app authenticates to the LOCAL console implicitly, by a
token only the logged-in user can read, and never by a passkey ceremony.**
Owner ruling, 2026-09-10. The Mac app is the **same package as the CLI, on
the same machine, running as the same person, with that person's filesystem
access**. Asking it to perform a WebAuthn ceremony against a local origin is
theatre: anything that could impersonate it could also read the passkey's own
storage. So the console accepts `METISTRY_LOCAL_OWNER_TOKEN` over loopback as
the `user` principal — the same principal a passkey session yields, through
the same predicate — and the app is signed in the moment the install has one
(`docs/ops/auth.md`; the CLI side shipped in PR #119).

It is **not weaker than a passkey on this machine**: possession of the token
means being able to read this login Keychain, which on macOS is the logged-in
user — the same claim a platform passkey makes. What the loopback rule adds is
that a token which leaks into a log or a screenshot still cannot be replayed
from off the machine. **Passkeys are unchanged** and remain the door for
browsers, the phone, and every remote client; nothing about enrolment or login
moved.

Three consequences for the app, all of them shipped:

- **The app never touches the token.** It does not read the login Keychain
  from Swift, does not open `<instance>/state/.env`, and sends no
  `Authorization` header anywhere. It runs `metistry console whoami --json`
  and renders the answer — the CLI is the one place that knows where the
  token lives. A test walks `apps/macos/sources` and asserts all of that
  rather than trusting the comment above it.
- **Wizard step 6 is optional and reframed**, from "enrol a passkey against
  the local origin" to "your Mac is signed in automatically; enrol a passkey
  only for browsers and your phone". The enrolment-code path is kept intact
  for exactly those. The "Ask macOS" `ASAuthorization` probe left the main
  flow for **Settings → Advanced** — it is real measured behaviour and worth
  being able to check, but it is a diagnostic, not a setup step.
- **The app cannot yet make any OTHER authenticated console call.** PR #119
  added `console whoami` and nothing else: there is no verb that performs an
  arbitrary authenticated request on the app's behalf, and none that prints a
  bearer to the calling process alone. Devices, agents, projects, proposals
  and dispatch are therefore unreachable from the app, and the PWA remains
  the answer for them. **The follow-up is a CLI change first** — a
  `metistry console call <METHOD> <path>` is the shape that keeps the rule
  ("the app is a front end for the CLI") intact; a token-printing verb keeps
  the token out of argv but puts it in the app's memory, which is the weaker
  of the two. Not decided here.

### The bundle is a seed (ratified 2026-09-10)

**The decision: a signed bundle's `Contents/Resources/metistry/` is the
SEED. The writable product dir is
`~/Library/Application Support/Metistry/product/`, and everything —
plists, `metistry update`, `--rollback` — points there.**

A signed bundle's `Resources` cannot be written to, and `metistry update`
in release mode must write `releases/<version>/`, flip `current`, and
unpack a new `runtime/`. So on first run the seed is copied out:

```
~/Library/Application Support/Metistry/product/
  releases/<version>/      the runtime pack, exactly as `update` unpacks it
  current -> releases/<version>
  runtime/                 Node, Postgres + pgvector, git — BESIDE releases/
  .metistry-install.json   what was copied, from where, and its digests
```

The copy is a **CLI verb**, not app code, for the same reason every other
first-run step is (§4.20: the app is a front end for the CLI, never a
second implementation):

```sh
metistry runtime install --from /Applications/Metistry.app [--to <dir>] [--force]
```

Idempotent and verified. The seed's own `releases/<v>/metistry-runtime.json`
(from `pack-runtime.sh`) and `runtime/manifest.json` (from
`build-runtime-deps.sh`) are read and cross-checked against the `current`
symlink **before a byte is copied** — a hand-assembled bundle is refused
rather than half-installed — and their sha256s go into
`.metistry-install.json`, so running it again with the same seed does
nothing. A Sparkle update of the app ships a NEWER seed, and the next
launch copies it forward; the previous `releases/<v>` stays on disk, so
`--rollback` still works. `docs/ops/mac-app.md` has the layout.

**Rejected: Sparkle-only updates, with `metistry update` a no-op for app
installs.** Three counts. The product could then only move when the whole
app did, so a migration fix would need a notarized build. The terminal and
app paths would stop being one tested path. And `releases/`, `current` and
`--rollback` would exist for checkout installs only — two update stories
for one product.

Trialled end to end on 2026-09-10 (below).

## Distribution: the app as the installer (owner direction 2026-09-07)

The question: can the whole install, setup, and update live inside the
app — one click, no terminal — install the tooling, lay out the local
filesystem, pull updates from the product repo, and connect the instance
directory to the user's GitHub repo for versioning? **Yes, and it is the
app's strongest reason to exist.** The design rule that makes it
safe: **the app is a front end for the CLI, never a second
implementation.** Every step below is a `metistry` verb the app runs
(bundled) with a progress view; the terminal path stays first-class and
identical, so open-source users and the app share one tested path
(§4.20: adapters adapt one service).

**First run, in the app:**
1. *Runtime.* The app bundles a Node runtime and the built product
   release as resources (`Metistry.app/Contents/Resources/metistry/`),
   signed and notarized together — no Homebrew, no `pnpm install`. That
   bundle is a **seed**: `metistry runtime install` copies it once to
   `~/Library/Application Support/Metistry/product`, which is where
   `metistry update` can write (ratified 2026-09-10, below).
2. *Instance.* Pick a folder → `metistry init` (vault, identity, name
   the assistant on-screen — the only place the name lives).
3. *Versioning.* "Connect a GitHub repository": device-flow OAuth in the
   app (or paste an existing private repo URL); the token goes to the
   Keychain and reaches git through the standard `osxkeychain`
   credential helper, so the reconciler pushes without a plaintext
   secret anywhere (`metistry connect-repo` — **built 2026-09-07**, with
   `--auth device|token|ssh`; the app calls the same verb the terminal
   does. `docs/ops/cli.md`).
4. *Secrets.* Bridge tokens, the assistant token, VAPID keys: minted by
   the app into the Keychain; `.env` is written by the app from the
   Keychain at service start (`metistry secrets sync` — **built
   2026-09-07**, with `mint` and a values-free `list`; the Keychain is the
   canonical store under `metistry:<VAR>`) and is never edited by hand.
   Since 2026-09-09 the app passes `--instance <dir>`: that `.env` is
   written to `<instance>/state/.env` and instance-scoped items are filed
   under the instance's `instance_id` ("Instance directories are
   self-contained" below).
5. *Services.* `metistry up`, preceded by `metistry deployment set-shape`
   after a preview of what the other shape would do. `doctor` becomes the
   app's status view and menu-bar item. **`SMAppService` registers the APP**
   as a login item (built 2026-09-10); the install's launchd agents stay
   `metistry up`'s, and moving them is a CLI change first — see below.
6. *Door.* **Optional, and usually already done** (owner decision
   2026-09-10, "Decision 3" below): this Mac is signed in to the local
   console implicitly, by `METISTRY_LOCAL_OWNER_TOKEN` over loopback, so the
   step leads with that state and asks nothing. Enrolling a passkey is what a
   **browser or a phone** needs, and the console's existing enrolment-code
   flow is kept for them. Native `ASAuthorization` against a local origin is
   still not possible from a Developer ID build (measured 2026-09-10, below);
   the probe that proves it moved to Settings → Advanced.
7. *Claude.* `claude setup-token` guided in-app — opened in a real terminal
   because it is interactive — and the app watches `secrets list --json`
   for the token's name. It never handles the value.

**Updates.** Two channels, both signed: the app updates itself
(Sparkle-style appcast, or the App Store if that route is ever taken);
the product runtime updates through `metistry update` — release mode
(§4.16: pinned artifacts, never git merges), migrations under the
advisory lock, `metistry.lock` written into the instance repo through
the reconciler. The app shows the changelog and a "restart services"
button; nothing else changes.

**The one architectural decision this forces — open decision #15,
Docker-free macOS shape.** Today Postgres, the console, and the assistant
run in Docker; Docker Desktop is the largest first-run hurdle (and the
source of the lock-ups diagnosed 2026-08-31). A one-click install needs a
deployment shape where the app runs **everything under launchd**: a
bundled Postgres + pgvector server (as Postgres.app and DBngin do), and
the console, assistant, reconciler, watchdog as Node services. The code
is already portable (invariant 7; nothing assumes a shared filesystem or
Docker), so this is a `deployment.yaml` shape, not a rewrite; Docker
compose remains the shape for Linux and cloud. What it costs: the
assistant container was defense in depth behind invariant 9's allowlist.
On the host the engine process must be confined another way — an App
Sandbox-style profile for the assistant process (deny filesystem outside
its own state dir, allow network to the console only), tested by misuse
tests like every other boundary. That mitigation is part of the
decision, not an afterthought.

**#15 is proven (2026-09-10).** Trialled end to end on the Studio: the
v0.4.0 release packs seeded into
`~/Library/Application Support/Metistry/product/` by `metistry runtime
install`, a scratch instance at
`~/Library/Application Support/Metistry/trial-instance`, `shape: launchd`,
and the production compose install left running beside it on its own labels
and ports. Bundled Postgres 17.11 + pgvector 0.8.6 initdb'd under
`<instance>/state/pg`, 13 migrations applied under the advisory lock,
console/assistant/reconciler/watchdog as launchd agents on the bundled
Node, `doctor` **23 ok / 0 failed / 2 absent — healthy**, the console
answering `/health` on its own port while production answered on 8080, a
`metistry update --channel release --version 0.4.0` no-op round trip whose
lock the reconciler committed, and the sandbox verified live: the vault
denied, a write outside the state dir denied, the state dir writable, the
instance's own console and db reachable and *the production install's
ports not*. **No Docker was involved at any point.** Five real defects
came out of it, all fixed in the same PR — a space in
`~/Library/Application Support` broke every `sh -c` job, the sandbox had
no rule for Postgres, `launchctl bootout` races the following
`bootstrap`, and a namespaced instance's ports reached neither the
dotenv-sourcing jobs nor `metistry update`'s migration runner (which
would have migrated the wrong database). `docs/ops/deployment-shapes.md`
carries the status and what remains.

**Running a second instance is no longer a follow-up.** `metistry up
--namespace` allocates an instance its own launchd label suffix (from
`instance_id`) and an 8-port block, recorded once in
`<instance>/state/ports.yaml`; that file's presence is what namespaces an
install, and `up`, `doctor`, `restart|stop|start` and `logs` all read it.
That is what made the trial safe to run beside a live install, and it is
how the app will hold several test instances at once.

**Strategy (ratified 2026-09-07).** Fully open source, everything free,
no hosted plan. The Mac app is the *primary* way people get Metistry:
same code, same repos, same API as the terminal path, plus the
zero-terminal experience — install, connect, update, native window.
**Distribution:** GitHub Releases — a signed, notarized DMG (Developer ID,
hardened runtime) plus the runtime pack and npm packages as release
assets; **auto-update** via Sparkle (or an equivalent EdDSA-signed
appcast) whose feed is generated from the GitHub release itself, so the
app updates without any FSL-run server. The iOS app goes through
TestFlight/App Store because Apple leaves no other route. Requirements
this creates now: a Developer ID certificate on the Studio (also fixes
the ad-hoc-signed TCC helpers — memory), a release workflow that builds,
signs, notarizes, staples, and publishes assets with a changelog, and a
`metistry update` release mode that consumes exactly those assets.

## Instance directories are self-contained (ratified 2026-09-09)

**The decision: an instance directory is self-contained. Nothing about an
instance may persist outside its directory except per-user secrets.** The
app will be pointed at different instance directories — several test
instances in different states on one machine — so anything an instance
leaves elsewhere is a leak that makes the next instance behave oddly for
reasons nobody can see.

### What lives where

| | Where | Why |
| --- | --- | --- |
| Vault, `identity.yaml`, `rules.yaml`, `queries/`, `agents/`, `routines/`, `extensions/`, `instance-migrations/`, `metistry.lock` | the instance repo, tracked | the record (invariant 1); `metistry init` stamps them |
| `inbox/` | the instance dir, gitignored | captures in flight |
| `state/pg` | the instance dir, gitignored | the launchd shape's Postgres data — derived |
| `state/assistant` | the instance dir, gitignored | the engine's `HOME`, its SDK transcripts |
| **`state/.env`** | the instance dir, gitignored, `0600` | **the install's whole environment.** It used to live in the product checkout, which tied one checkout to one instance |
| **`instance_id`** in `identity.yaml` | the instance repo, tracked | a v4 UUID minted by `metistry init` — this directory's stable identity, and the Keychain account its own secrets are filed under |
| Instance-scoped secrets | the login Keychain, account = `instance_id` | see below |
| User-scoped secrets | the login Keychain, account = `metistry` | deliberately shared by every instance on the Mac |
| The product runtime, `releases/`, `runtime/`, `current` | the install/product dir | code, not instance data — one copy serves every instance |

The product checkout's `.env` is still **read** as a deprecated fallback,
so no running install breaks; `metistry secrets sync --to env` carries
every line of it into `<instance>/state/.env` and leaves the old file
alone. `--instance <dir>` (the app passes it on first-run steps 4 and 5)
and `--env-file <path>` are the explicit overrides.

### The two Keychain scopes

A secret is either the instance's or the person's, and one table in
`packages/cli/src/secrets.ts` (`SECRET_SCOPES`) decides which, so
`sync`, `mint`, `list`, `purge` and the app cannot disagree.

- **instance** — account = `instance_id`: `METISTRY_DB_PASSWORD`, every
  `METISTRY_BRIDGE_TOKEN_*`, `METISTRY_ASSISTANT_TOKEN`,
  `METISTRY_VAPID_*`, `METISTRY_GITHUB_*` (a PAT is scoped to the repos
  *this* instance watches). **Unlisted secret-shaped names default here:**
  self-containment is the rule, user-scope the enumerated exception.
- **user** — account = `metistry` (or `METISTRY_KEYCHAIN_ACCOUNT`):
  `CLAUDE_CODE_OAUTH_TOKEN` (one Claude login per Mac) and
  `METISTRY_AWS_SECRET_ACCESS_KEY` / `_SESSION_TOKEN` (the person's own
  AWS account, for the aws-costs collector).

`METISTRY_SIGN_IDENTITY` and `METISTRY_GITHUB_OAUTH_CLIENT_ID` are not
secrets and stay plain config. Migration is automatic and additive:
`sync --to env` resolves the instance account first, falls back to the
user account, and **copies** what it finds there into the instance's,
never deleting the original. `metistry secrets purge --instance <dir>`
deletes one instance's items — preview-then-confirm, `--yes` to act — and
is structurally incapable of touching the user account.

### The limit that remains — lifted 2026-09-10

It used to read: *one active instance at a time*, because launchd labels
(`com.foldedspacelabs.metistry.*`) and ports (console 8080, reconciler
7812, the bridges) are fixed. `metistry up --namespace` lifts it, and the
2026-09-10 launchd trial is what forced the issue: proving #15 on this Mac
meant running a second install beside a live one.

**One file is the whole namespace** — `<instance>/state/ports.yaml`,
allocated once and then read by `up`, `doctor`, `restart|stop|start` and
`logs`. Its presence is what namespaces an install; absent, everything
behaves exactly as it did. The label suffix and the port block live
together in it because they must not be able to disagree.

- Labels become `com.foldedspacelabs.metistry.<suffix>.<service>` — the
  suffix goes BETWEEN the prefix and the service, so "the service is the
  last component" stays true and no caller had to learn a new rule. Logs
  become `/tmp/metistry-<suffix>-<service>.log`.
- Ports are one contiguous 8-wide block in 8300-8999: above the console's
  8080, below the ephemeral range, nowhere near 5432 — so a namespaced
  instance cannot collide with an un-namespaced one. The base is derived
  from `instance_id` and stepped past a block that is genuinely in use
  once, at allocation.
- The block fills only environment variables that are UNSET. That is what
  keeps the jobs whose environment `up` renders and the jobs that source
  `<instance>/state/.env` themselves agreeing on which port a service is
  on; an explicit `.env` line still wins.

**What is still missing** for the app's instance-switching UI: `doctor`
reports one instance at a time (whichever `METISTRY_INSTANCE_DIR` names)
rather than every instance on the Mac, and the TCC bridges cannot be
namespaced at all — `eventkit-helper`'s socket path is a hardcoded
`/tmp/metistry-eventkit.sock`, and TCC consent is per signed binary, so
two instances would share one helper. Both are listed in
`docs/ops/deployment-shapes.md`.

## Bundled runtime (ratified 2026-09-09)

Everything the app needs ships inside the bundle except the user's own
accounts and permissions. Download, open, sign in to Claude, name the
assistant, approve two permissions; nothing else is the user's job.

| Shipped inside `Metistry.app/Contents/Resources/metistry/` | Notes |
| --- | --- |
| **Node** | console, assistant, reconciler, watchdog, bridge Node halves |
| **Postgres 17 + pgvector** | relocatable build, every Mach-O signed (hardened runtime), data under the instance's `state/`, loopback + Unix socket, our launchd job starts it — the Postgres.app model. The launchd shape already resolves `runtime/postgres/` before Homebrew; the release workflow produces it. Permissive licences. ~50 MB |
| **git** | a clean Mac has none until Xcode Command Line Tools are installed; the reconciler spawns it. A minimal build, ~30 MB |
| **Claude Code CLI** | arrives with the Agent SDK package; nothing separate |
| **Swift helpers** | EventKit, Apple FM — prebuilt, Developer ID signed, bundled (#84) |
| **The product runtime pack** | the release asset, pinned by `metistry.lock` |

Not required, ever: Docker, Homebrew, pnpm, Xcode, build tools.

**Optional, offered in-app, degrades absent:** **Ollama** for embeddings
(search is keyword-only without it; one-click install from the app;
Apple's on-device `NLEmbedding` behind a Swift bridge is the candidate
no-install default, lower quality than nomic — evaluate before adopting);
**Tailscale** for phone access away from the local network.

**The user's own, unavoidable:** the Claude subscription login (browser),
a GitHub account only if they want the instance repo backed up (local git
works without a remote), Calendars/Reminders and notification
permissions, the passkey.

**Updates** carry new Node, Postgres, or git versions inside the runtime
pack when they change; `metistry update` in release mode swaps the
`current` symlink, runs migrations under the lock, and restarts what
changed. A Postgres major upgrade is the one update that needs a data
migration step; plan it as its own `metistry update --pg-upgrade` when
it first happens, never silently.

## Not doing
- An Electron/Tauri wrapper (a second runtime for what the installed PWA
  plus Swift helpers already give).
- A coding workbench (terminals, worktrees). Claude Code plus the
  `metistry` plugin is the coding tool; Metistry is the operating view.
- ACP as a transport today; recorded as a candidate target transport.
