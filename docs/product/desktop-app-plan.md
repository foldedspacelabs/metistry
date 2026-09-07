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

## Not doing
- An Electron/Tauri wrapper (a second runtime for what the installed PWA
  plus Swift helpers already give).
- A coding workbench (terminals, worktrees). Claude Code plus the
  `metistry` plugin is the coding tool; Metistry is the operating view.
- ACP as a transport today; recorded as a candidate target transport.
