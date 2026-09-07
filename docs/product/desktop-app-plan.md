# Desktop client — planning document (2026-09-07)

> Status: **planning only.** Extends `ios-app-plan.md`: the premium
> native client is one **SwiftUI multiplatform app (macOS + iOS)**, and
> the installed PWA is the desktop client for every other OS. Research
> and rationale in `docs/research/2026-09-codegraff-review.md`.

## Two desktop clients, both real

1. **Installed PWA** (now): Safari "Add to Dock" on macOS 14+, Chrome/Edge
   "Install app" on Windows/Linux. The full management UI in a window,
   today, zero code. Documented in `docs/ops/` as the desktop story for
   non-Apple machines and for anyone who doesn't want the premium app.
2. **Native Apple app** (post-Phase 6, premium candidate — was "iOS
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

## Not doing
- An Electron/Tauri wrapper (a second runtime for what the installed PWA
  plus Swift helpers already give).
- A coding workbench (terminals, worktrees). Claude Code plus the
  `metistry` plugin is the coding tool; Metistry is the operating view.
- ACP as a transport today; recorded as a candidate target transport.
