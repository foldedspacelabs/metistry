# CodeGraff review — lessons for a Metistry desktop app (2026-09-07)

Owner prompt: Metistry has a PWA and a planned iOS app but no desktop
app; in the second context the owner will mostly be at a desktop, likely
with Metistry hosted on the same machine, and uses the Claude desktop app
more than the CLI even for Claude Code. Review [justrach/codegraff](https://github.com/justrach/codegraff)
for the "single pane of glass" and multi-agent overlap, then plan a
desktop client. Companion: `docs/product/ios-app-plan.md`,
`docs/product/ux-direction.md`; outcome in `docs/product/desktop-app-plan.md`.

## What CodeGraff is

An **agentic coding harness with its own engine** (Zig, ~3.7 MB binary,
zero runtime deps) plus a desktop app: Electron/Chromium shell with
**native SwiftUI panels** on macOS (activity, computer-use). macOS 14+
Apple Silicon, Linux, Windows; notarized. React front end, TypeScript and
Python SDKs. 229★, ~1.9k commits, v0.0.291, auto-updating. **Modified
AGPL-3.0**: network use triggers §13 and the two authors reserve
proprietary/hosted rights — inspiration only, nothing borrowed as code.

Its shape:

| Area | CodeGraff | Metistry equivalent today |
| --- | --- | --- |
| Engine | its own harness, 13+ providers, `/plan` `/strict` `/yolo` modes | Claude Agent SDK engine in a container; deterministic router; tiers |
| Multi-agent | spawns parallel sub-agents; **Agents panel**: local peers, published tasks, activity, recent messages; queued message delivery and task **handoffs** between sessions | `tasks` module (claim/lease), crews (#62), review bundles (#58), `agents` registry, per-agent `runs` |
| Changes | **Changes panel**: staged/unstaged diffs, worktrees, recent commits, draggable review divider | artifacts versions + `vault/diff` + `vault/log` (reconciler) |
| Chat | tool activity **collapsed** inline; searchable model picker; effort/fast controls; explicit **working / finished / interrupted** state | chat tab; `runs kind=tool` rows per turn; ux-direction (model selection, question-answer flows); delivery-evidence tiers |
| Protocols | **ACP** (Agent Client Protocol, Zed) for editor integration; MCP for custom tools; `graff serve` to embed | MCP is the one door (`/mcp`); targets registry (§4.18) |
| Cost | recomputed from token counts at list rates | `claude-usage` collector, same approach |
| State | `.harness/settings.json`; chat/session/workspace persist across restarts | Postgres + instance repo; sessions table |
| Principle | "stable context, small programs, focused results keep useful context in the harness" | §4.11 "the brief is the context transfer"; handles not payloads |

## Where it agrees, where it doesn't

The overlap is real but shallow: both put agents, tasks, activity and
diffs in one window. The difference is what the window is *for*.
CodeGraff is a coding tool whose window is the workbench for one
developer's coding sessions; its multi-agent story is parallel
sub-agents of its own harness. Metistry's window is the **operating
view of a persistent assistant and its crews** — knowledge, capture,
triage, projects, spend — and its agents are heterogeneous, from any
vendor, coordinated through the hub. So: lift the *presentation*
lessons, not the architecture.

**Don't lift:** a second engine (the Agent SDK is the engine; invariant
9 keeps it shell-less and git-less), an Electron shell (below), the
AGPL code, or coding-workbench features (terminals, worktrees) that
belong in the user's coding tool — Claude Code with the `metistry`
plugin already is that tool.

## Lessons to lift

1. **The Agents panel is the right home page.** Peers with presence,
   published tasks, an activity feed, and messages/handoffs in one
   place. Metistry has every row for it already: `agents` (last_seen,
   kind, projects), `work` (ready/claimed/blocked, bundles), `runs`
   (tool calls, crew runs, spend), `proposals`. What is missing is the
   *feed* — a single time-ordered stream of "what every agent did" —
   which is one named query over `runs` + `proposals` + `work.history`.
   That feed is the desktop app's centerpiece and, incidentally, what
   the weekly review already summarises.
2. **Explicit agent state, not inferred.** Working / finished /
   interrupted as first-class chips. Ours: the delivery-evidence tiers
   (§4.21) plus lease liveness give `working`, `queued`, `idle`,
   `blocked`, `over-cap`, `interrupted` (lease expired mid-claim) for
   free. Show them; never dress a mailbox agent as working.
3. **Collapsed tool activity in chat.** Every assistant turn's tool
   calls (`runs kind=tool`, `meta.tools_used`) as a collapsed block
   under the reply, expandable to the call/result. This is the
   transparency the UX direction wants and needs no new data.
4. **Handoffs as a first-class gesture.** CodeGraff's "hand this task
   to that peer" maps to our review-bundle dispatch and `crew_dispatch`;
   the desktop should expose both as drag-a-task-onto-an-agent, with the
   autonomy boundary (project membership, `mode: review`) shown as the
   reason when a drop turns into a proposal instead.
5. **The Changes panel becomes the Artifacts + Vault panel.** Versions,
   diffs, comments, plus the reconciler's commit log — the one place
   the owner sees what the assistant wrote to knowledge this week and
   can revert (a `vault/write` with the previous content, attributed).
6. **Model/effort controls are per-turn, visible, searchable.** Already
   in ux-direction; desktop makes it a toolbar.
7. **ACP is worth watching, not adopting.** Agent Client Protocol
   (Zed) standardises editor↔agent sessions. If it gains adoption it is a
   candidate *target transport* (§4.18: "an external platform earns a
   target by exposing MCP or a webhook contract") for driving a live
   coding agent from a task — the `native` delivery tier without a
   bespoke bridge. Record; revisit when a second agent speaks it.

## The stack question — recommendation

Three ways to get a desktop app:

| Option | Cost | What it buys | Verdict |
| --- | --- | --- | --- |
| **PWA installed as an app** (Safari "Add to Dock" on macOS 14+, Chrome/Edge "Install app" everywhere) | zero — the PWA already exists | a windowed, dock-resident app with the full management UI on every OS today | **Do now.** Document it; it is the desktop story for Linux/Windows users permanently |
| **Electron / Tauri wrapper** around the PWA | low–medium; a second build pipeline, signing, updates | native notifications, menu bar, global hotkey, file drops; the same JS twice | Not worth a second runtime for what the installed PWA plus a few Swift helpers already give |
| **SwiftUI multiplatform app** — one Apple codebase, macOS + iOS targets | the iOS app's cost, plus ~20% for macOS-specific surfaces | everything native on both devices from one codebase: share extension + Quick Action, APNs + local notifications, menu-bar status, global capture hotkey, Keychain, native passkeys via `ASAuthorization`, drag-and-drop handoffs, widgets on both, HealthKit on the phone | **The plan.** The iOS app was already the premium candidate; making it a multiplatform Apple app changes the target list, not the design |

Why Apple-native rather than cross-platform for the *premium* client:
the product's native surface is already Apple-only by invariant 6 (TCC
bridges are Swift), the iOS app is planned in Swift, and one SwiftUI
codebase serving both devices is cheaper than Swift-for-iOS plus
anything-else-for-desktop. Windows and Linux desktops get the installed
PWA, which is a complete client, not a demo. "One design language across
web and iOS" (ux-direction) becomes **web + Apple**.

## Hosted-on-the-same-machine

In the second context the console will run on the desktop itself. Nothing
changes in the API: the origin is `https://localhost:8080`-class or a tailnet
name; WebAuthn works on `localhost` as a secure context, and the native app's
`ASAuthorization` passkey flow hits the same RP. One consequence worth
designing for: **local-file linking** (Artifact Server's ADR 0023 — a
file that stays on disk, live for the owner, snapshotted for everyone
else) is only ever sensible on the machine that owns the vault. It is a
desktop-app feature, gated on `runs_on: host` co-location, not a
console feature.
