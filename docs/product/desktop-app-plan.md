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

**Explicit follow-ups**, each labelled "not yet" in the app itself rather
than faked:

- **`SMAppService`.** Step 5 registers launchd jobs the way the terminal
  does — `metistry up` writing `~/Library/LaunchAgents`. Moving to
  `SMAppService` (macOS 13+) is the sanctioned shape: one approval in
  System Settings, no plist to edit. It needs a `metistry up` that can
  hand the app its job set rather than installing it, so it is a CLI
  change first.
- **Step 6, passkey.** Needs `ASAuthorization` against the console's local
  origin *and* a `metistry` verb to register the credential.
- **Step 7, Claude token.** `claude setup-token` is interactive; driving it
  from the app needs a pty, and the token needs its own `metistry secrets`
  path.
- **The other eight destinations** (Feed, Chat, Agents, Projects,
  Artifacts, Capture, Needs You, Devices — P6). The PWA is the answer until
  the UX pass settles them, per sequencing step 2.
- **The iOS target.** Not in `Package.swift` yet; the kit is ready for it.

**One decision this scaffold surfaced and did not settle: where a bundled
install's *writable* product dir lives.** The app bundles the runtime under
`Contents/Resources/metistry/`, and a signed bundle's `Resources` cannot be
written to — but `metistry update` in release mode must write
`releases/<version>/`, flip `current`, and unpack a new `runtime/`. Either
the app copies the embedded tree to a writable location on first run (the
bundle is a seed), or the bundled runtime is only ever replaced by a
Sparkle update of the whole app (and `metistry update` is a no-op for app
installs). "Two channels, both signed" below reads as the first; nothing
has ratified it.

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
   signed and notarized together — no Homebrew, no `pnpm install`.
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
5. *Services.* `metistry up` — but registered through **`SMAppService`**
   (macOS 13+), the sanctioned way an app installs its launchd agents;
   the user approves once in System Settings, and there is no plist to
   edit. `doctor` becomes the app's status view and menu-bar item.
6. *Door.* Passkey enrollment in-app via `ASAuthorization` against the
   local origin; the phone enrolls from the existing QR/code flow.
7. *Claude.* `claude setup-token` guided in-app; the token to the
   Keychain.

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

### The limit that remains

**One active instance at a time.** launchd labels
(`com.foldedspacelabs.metistry.*`) and ports (console 8080, reconciler
7812, the bridges) are fixed, so bringing a second instance up would fight
the first for both. Several instance directories can exist and be switched
between; only one runs. Running them concurrently is a **follow-up** that
needs label and port namespacing per instance (and a `doctor` that reports
per instance) — not attempted here, because guessing the namespacing
before the app's instance-switching UI exists would be building ahead of
the plan.

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
