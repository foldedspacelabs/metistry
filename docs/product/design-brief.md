# Design brief — Metistry (2026-09-17)

> **For** an AI designer (Claude Design) taking on the visual and interaction
> design of Metistry, written so a reader who has never seen the product can
> design for it without reading the rest of the repo. **Settled vs yours:** the
> ten principles P1–P10 in `docs/product/design-system.md` §1 are
> **constraints**, restated for a designer in §4; that file's **tokens**
> (`docs/product/design/tokens.json`) are a **starting point you may replace**,
> provided the replacement keeps the semantic role names and passes the contrast
> check CI runs (§6); the six-section IA in §3 is ruled. The look of the thing,
> the brand and the icon are the work. **Every fact here names a file**; where
> this brief and the repo disagree, the repo wins and we want to hear about it.

**Rulings that shape it (2026-09-17, both of that day's rulings).** Native
SwiftUI Mac app first, iOS later, the PWA for non-Apple machines; one design
language across all three; the **six-section** IA of §3, with capture as a
floating "+" and Needs You as a **bell**, a customizable Mac sidebar, and
System split into Settings and **Insights**; requests take six answers; the
Mac app is a client of the **local** instance only; settings and the setup
wizard are in scope.

---

## 1. What Metistry is, in a page

A **personal AI operating system you own entirely**: a persistent assistant plus
a knowledge graph, Apache-2.0, run by one person on their own machines. Agents
are disposable; context is durable — Markdown in your git (what you know) and
Postgres (what is happening), in formats that outlive any session, agent or
vendor (`README.md`). Each install is a private *instance* with its own repo.

**The assistant.** One persistent assistant with memory across sessions. Its
**name is per-instance** — it lives only in that instance's `identity.yaml`
and nowhere else in the code, schema or any label (`CLAUDE.md`, "Naming").
**Call it "the assistant" in every artboard, label and brand asset**; a design
that hardcodes a name is a bug. **Knowledge** is everything it keeps for you:
plain Markdown in git, opened in Obsidian or any editor, forever. One file is
a **page**; areas are folders (`docs/product/glossary.md`) — Obsidian is the
editor and we do not replace it. **Capture** is the thing you drop in without
sorting it — share sheet, Shortcut, hotkey, an agent's `capture` call — one
door, under five seconds, landing in `Knowledge/Inbox/` inside the vault
(`docs/ops/inbox.md`).
**Requests** are anything that needs *you*: one list, **Needs You** — reached
from the bell rather than from a tab — with seven types (note · report · review · question · access · improvement ·
action) and six answers (§3.6). **Work** is one shared task list you and every
agent work from; a task is claimed with a lease, renewed, released, closed.
The **Board** is a view over it in six columns — Backlog · Addressed to · In
Progress · Needs You · Done · Reported — computed server-side, plus an
`escalated` flag saying *why* (lease lapsed / blocked / overdue)
(`docs/ops/board.md`). Each task carries a **room**: a comment thread that, by
construction, cannot address anyone — posting wakes nobody
(`docs/ops/threads.md`).

**Agents are peers, not features.** Each has a role chip (assistant · helper ·
external), an access tier (none · titles · folders) and a live presence state
(working · queued · idle · interrupted · over-cap · blocked). External agents
— Claude Code, Cursor, Devin, any MCP client — work through a token you minted
and can revoke. **Projects** group agents, tasks, artifacts and spend, and
carry the kill switch: mode **Auto** or **Supervised**, one tap. **Routines**
run the cadence with no model in the loop — `morning-brief`,
`knowledge-fold` (the evening fold), `reply-review`, `weekly-review`
(`routines/`); **collectors** pull outside state in (`collectors/`:
`github-state`, `aws-costs`, `claude-usage`, …); **activity** is the record —
every tool call, turn and collector pass is one readable row. **Compute** is
where turns run: `compute.yaml` names providers (cloud on your own key, or a
local server), assignments per tier, and budgets enforced **before** the call
rather than reported after (`docs/ops/compute.md`). The router that picks a
tier is deterministic — *no model decides which model runs*; a person may
override it, and the UI must say the router chose first.

**Who the user is.** One person, technical — they read the CLI output and will
notice a lie. They intend to run this for years, so every dependency is a
maintenance obligation and nothing decorative survives. They run it on **two
Macs** (`plan-refresh-2026-09-13.md` W2: "the second Mac installs signed packs
+ helpers via the Mac app") and may run a **second instance** — a separate
install with its own repo and vault — so nothing may assume exactly one. **The promise the design carries:** the system is quiet
unless something needs a person, and says what and why when it does.

---

## 2. The surfaces, in order

**2.1 Mac app — first, native SwiftUI (`apps/macos`).** A SwiftPM package, no
Xcode project. `MetistryKit` (`sources/kit/`) holds every model and view and is
free of AppKit and of `Process`, so an iOS target shares it unchanged;
`sources/app/` holds the executable and the platform seams. Shipped as a signed,
notarized DMG through GitHub Releases, Sparkle auto-update.
*What you see today, honestly:* a window whose `NavigationSplitView`
destination enum has **exactly one case**: `.status`
(`sources/kit/root-view.swift`), so the sidebar has one row. The content pane
is `metistry doctor --json` as a grouped list — a summary line ("26 ok · 1
degraded · 1 not configured"), then rows of `[dot] component · probe … state ·
latency`, grouped by kind, `absent` in grey labelled "not configured". A
menu-bar item whose glyph is the worst *fault* across components, opening the
same components with Restart / Stop / Start / View Log submenus. A Settings
window of seven tabbed panes, a first-launch sheet of seven steps, and a log
window showing 200 lines of one component. **Nothing in the app reads a task,
a request, an artifact, a message or a page** (`docs/product/app-ux-plan.md`
§1.1). Of the kit's 9,763 Swift lines, 2,644 are settings/wizard/first-run and
1,921 the compute pane. The owner's own summary: "nothing but really verbose,
hard to understand settings and a status page." That is this brief's centre of
gravity — the app shipped the *install-and-operate* half of the product and
none of the *manage* half.

**2.2 PWA — exists today, the most complete surface (`apps/console/web`).**
Plain HTML/CSS/JS, no framework, no webfont; installed via Safari "Add to Dock"
or Chrome "Install app". Eleven views in one horizontally scrolling strip of
buttons: Feed · Chat · Board · Dashboard · Capture · Needs You · Status ·
Devices · Agents · Artifacts · Rooms (`index.html:22–33`). In words: a
time-ordered activity feed with agent/project/kind filters; chat with
iMessage-shaped bubbles, a collapsed tool-activity disclosure under each reply
and a `+` composer menu; a Kanban board with HTML5 drags and an `m`-key
equivalent; an artifact viewer with a sandboxed HTML frame; rooms; request
cards; a doctor list; a spend dashboard. It uses the tokens heavily (356
`--mt-*` references in `style.css`) with nine literals that should not be there.
**Missing as a management surface:** no Knowledge view, no Projects section, no
compute, no instance switcher. The PWA is the desktop client for every
non-Apple machine and is not going away on any path; it is the design's second
target, not its first.

**2.3 iOS — later, native, offline capture (`docs/product/ios-app-plan.md`).**
Planning only: there is **no iOS target** in `apps/macos/Package.swift` yet —
that platform line is "a statement of intent, not a shipped target." What
native buys, and so what the design must serve: a share extension with an
**offline outbox** (captures and 👍/👎 queue; decision controls are *disabled*
while the instance is unreachable, never queued), actionable APNs
notifications, widgets, App Intents, HealthKit, and a **per-instance switcher,
never a unified inbox** — a merged feed cannot say which half is stale.

---

## 3. The information architecture, and every screen

### 3.1 Six sections, two global controls (ruled 2026-09-17, second ruling)

| Section | Contains | Why it is one section |
| --- | --- | --- |
| **Chat** | the conversation, tier picker, tapbacks | most-touched surface; has its own rules (P8, P9) |
| **Feed** | activity, filters, run detail | "what happened" is one question |
| **Work** ▸ | Board · Projects · Artifacts · Rooms, **expandable in the sidebar** | four views of one object graph — each one click away, not two |
| **Knowledge** ▸ | Pages · Search · Inbox, likewise | the product's first noun |
| **Agents** | agents, presence, scope/autonomy, crews, targets | who may do what, and what are they doing |
| **Insights** | cost, spend over time, run metrics, shadow agreement, token and latency trends | what the instance did, measured. Proposed name; the owner may rename it |

**Two global controls, on every screen, and they are a real part of this ask:**

- **Capture is a floating "+"** — bottom-right on iOS, the toolbar and
  sidebar footer plus `⌘N` and a global hotkey on Mac, the header on the web.
  It opens the capture composer as a **popover/panel** (Mac) or a
  **medium-detent sheet** (iOS). **There is no Capture tab and no Capture
  screen**; the *list* of captures lives in Knowledge → Inbox. A destination
  you navigate to contradicts the five-second promise.
- **Needs You is a bell** — top-right on iOS and Mac with an unread count
  (the product's **only** badge), opening the request queue as a
  panel/popover (Mac) or a sheet (iOS) holding the six-answer cards. The
  actionable notification is the same queue surfaced by the OS: one surface,
  two front doors.

**Settings** holds Status, Compute (providers · models · assignments ·
budgets) and Devices & Instances beside today's panes; on Mac it is the app
menu and `⌘,`, on iOS and the web it sits under **More**. **Setup is an
app-menu item** (Metistry → "Set up…" / "Run setup again"), not a section.

**The Mac sidebar is customizable below the six.** A **Pinned** area the
owner fills — a project or board, a knowledge page or saved search, an agent
— drag to reorder, unpin from the context menu. The six are fixed; the pins
are not. **iOS is four tabs plus More** (Chat · Feed · Work · Knowledge ·
More → Agents, Insights, Settings): five items, maximum.

Identical on all three surfaces: section order, names, the vocabulary of
states, and where a refusal appears. Only layout differs — three columns
(nav · list · detail) on Mac and wide PWA, one column with push navigation on
phone and narrow PWA.

### 3.2 Screens to design

| Section | Screen | Notes |
| --- | --- | --- |
| Chat | Conversation | bubbles, collapsed tool activity, prompt cards, composer `+` menu, ⌘K palette, model/effort picker, "↓ New Reply" pill |
| Feed | Activity · Run detail | row = kind glyph · actor chip · subject · detail · relative time |
| **global** | **Needs You panel** (the bell) | the bell with its count, and the panel/sheet behind it: the request card and its six answers, grouped by type, oldest first. **Not a screen — a popover on Mac, a sheet on iOS** |
| **global** | **Capture popover** (the "+") | the floating button and the composer it opens. Never blocks, never asks a question, never waits on the model |
| Work | Board · Task detail · Artifact · Project | board density is the hardest layout in the product |
| Knowledge | Pages · Page · Search · Inbox | **entirely undesigned; no client read path exists yet** |
| Agents | Agents · Agent detail · Crews/Targets | presence chips, scope and autonomy controls, destructive confirmations |
| Insights | Spend · Runs & models | cost over time, run counts and failure streaks, shadow agreement, token and latency trends. The spend tiles exist in the PWA; nothing else is designed |
> *Superseded by `design/screen-15-settings.md` (2026-09-25): Instance · Services · Compute · Updates; Account · Connections · Secrets · Variables; Live Capture · Sessions; Keyboard · Advanced.*
| Settings | General · Status · Compute · Connections · Devices · Advanced | §3.3. Status and Compute are the two that exist in Swift today |
| *chrome* | **Mac sidebar** | six rows, Work and Knowledge expandable, then **Pinned** — the one part of the navigation the user composes |

### 3.3 Settings (Mac, `⌘,` — in scope, and it grew)

**Six panes**, regrouped from today's seven and then given three more by the
second ruling: **General · Status · Compute · Connections · Devices ·
Advanced**. Status absorbs today's *Services* pane, because a service row
already *is* a doctor row with Restart / Stop / Start / View Log on it;
Compute keeps everything the compute pane does today and is now the canonical
home of compute configuration; Devices holds devices and instances, with
revoke and an honest reachability chip. **Setup left Settings for the app
menu.** The table below is today's seven panes, which is what exists in Swift
— read it as the inventory, and §3.1 as the destination.

The rule that shapes all of them (unchanged). The
rule that shapes all of them: **every setting is a front for a file the CLI
owns**; the app persists three pointers and no configuration. Every value is one
of exactly three things and the pane says which — a **pointer** the app
remembers, a **read-through** of a CLI verb, or a labelled **"not yet"** — and
making that distinction legible is a real design ask. Full contract: the table
in `docs/ops/mac-app.md`, "Settings: persisted vs read-through".

| Pane | What is on it |
| --- | --- |
| **Instance** | active instance directory · recents · Open in Finder · instance id, assistant name, mention (read-only — a protected path) · ~~Set Up Again…~~ — now Metistry → "Run setup again" |
| **Services** | deployment shape and the file it came from · the service list with status · Start at Login · Run Metistry in the Background |
| **Connections** | console sign-in (who this Mac is, and how) · instance repo status, HEAD, queue depth · which provider keys are set (names, never values) · bridges |
| **Compute** | providers (base URL, locality, ZDR claim, key present?) · Add Provider… · Test / Remove · assignments per tier · budgets, daily and monthly · local model servers · install / load / unload a model · RAM headroom, labelled an estimate |
| **Secrets** | secret **names** and scope only; no code path can print a value |
| **Updates** | app version, channel, feed, automatic checks, Check Now · the instance's product pin |
| **Advanced** | resolved runtime · product and runtime versions · developer runtime override · Run Doctor · passkey diagnostic ("Ask macOS") · log folder |

### 3.4 The setup wizard (in scope)

A **sheet** over seven steps, shown when no instance is selected and
re-enterable from the **app menu** — Metistry → "Set up…" / "Run setup
again" (second ruling, 2026-09-17; it used to be Settings → Instance).
Back · Continue · Skip; only steps 1 and 2 are required. Two rules baked in and worth keeping: **every choice
carries both a pro and a con** (a choice offered without a cost is one the app
already made for you — `WizardOption` in `wizard-model.swift` makes both
non-optional), and **every step shows the exact argument array before it
runs**, then streams the CLI's own output. An unavailable option is shown
**disabled with its reason**, never hidden. Every step carries the line "You
can change all of this later in Settings."

| # | Step | What it does (`first-run-model.swift`) |
| --- | --- | --- |
| 1 | **Runtime** | find the `metistry` CLI — bundled, a checkout, or on `PATH` |
| 2 | **Instance** | create the instance repo and **name the assistant** — the one screen where that name is set |
| 3 | **Versioning** | connect a private GitHub repo: device flow, SSH, or a token (token disabled, with the reason on screen) |
| 4 | **Secrets** | make the login Keychain the canonical store; mint bridge tokens |
| 5 | **Services** | preview the other deployment shape, set the shape, bring services up. Confirm stays disabled until the preview has been on screen |
| 6 | **Door** | "your Mac is signed in automatically" — enrol a passkey only for browsers and the phone |
| 7 | **Compute** | pick a provider template, paste a key into a secure field, name a model. "Skip: no engine yet" is a real choice, with its consequence on screen |

Steps 2 and 7 are the product's first impression, and are currently a progress
log with a command in it. Setup is **not** a section and not a Settings pane:
it is the one thing you do once, so it lives where macOS puts once-only
things.

### 3.5 The menu bar and the app menu (Mac only)

**The app menu** (Metistry → About · **Set up… / Run setup again** ·
Settings… `⌘,` · Check for Updates… · Quit) is now load-bearing: it is where
setup lives and where settings are reached, so neither needs a row in the
sidebar. It is a standard menu and needs no design beyond getting the item
names right.

A `MenuBarExtra` whose glyph is the **worst fault** across components —
`absent` never drives it, because a bridge nobody configured is not a fault.
The menu groups components by kind (Services · Bridges · Launchd Jobs ·
Containers), each with a status dot and a Restart / Stop / Start / View Log
submenu, plus Restart All, Stop All and "Update Available: x.y.z"; doctor
re-runs on open and every 30s while open, never continuously. It needs a **template
glyph** legible at 16pt in both menu-bar appearances, carrying four states
without colour alone.

### 3.6 The six answers on a request (ruled 2026-09-17)

One card shape for all seven request types, because the answers are the same
whatever the type (`docs/ops/reply-feedback.md`). **It lives in the bell's
panel/sheet** (§3.1), not in a section — so it is designed for a popover's
width and a scrolling list, with the batch bar pinned to the bottom edge:

| Answer | What it does | Ends the item? |
| --- | --- | --- |
| **Approve** | yes — and for some types it *runs* something (an action runs; an improvement writes the prompt overlay) | yes |
| **Revise** | nearly; here is what to change. An empty reason cancels rather than sends | yes |
| **Decline** | no, with per-type consequences (declining an enrolment revokes the token). Stays searchable | yes |
| **Approve as Work** | yes, and make a task of it. Offered only where the payload carries a suggested task; the card lands in Backlog | yes |
| **Later** | a snooze. The row stays pending, leaves the queue, comes back by itself | **no** |
| **Skip** | declined with nothing to say. Fires none of Decline's consequences | yes |

Design consequence: six is too many for one row of equal buttons. Approve /
Revise / Decline are the card's three answers; **Approve as Work** appears only
when offered; **Later** and **Skip** are the low-effort pair, and the two that
apply to a multi-selection at once. The card must show **a preview of exactly
what will happen** — the page path a note would be written to, the diff, the
access that would be extended — before it is answered.

---

## 4. Interaction principles you must keep

P1–P10, restated as design rules; the reasoning is in `design-system.md` §1.

| # | The rule | What it means for a design |
| --- | --- | --- |
| **P1** | Agent text is data, never chrome | Anything an agent or the assistant wrote renders visibly *quoted* — its own tint on the attribution, a wash behind the body, never the typography of a control. A well-escaped string styled as a confirm button is a confidence trick. |
| **P2** | Silence is the default, so the surface is calm | No badge counting things nobody must act on, no colour on a row merely because it is recent, no animation on arrival. Colour buys three things only — one accent, state, presence; everything else is neutral. |
| **P3** | Destructive actions confirm, and the confirmation states the reason | In the tool's own words, with the destructive verb as the affirmative button and Cancel as the default. Never "Are you sure?". |
| **P4** | Refusals are explained where they happen | Inline at the point of the gesture, not in a toast that says "failed". A refusal is a fact about the system's shape, and it is a feature. |
| **P5** | State is reported, never inferred | `absent` (never configured) is a first-class state distinct from `failed`. A panel that cannot answer says *unavailable*, and the rest of the page still renders. |
| **P6** | One information architecture, three renderings | Same sections, order and names on Mac, iOS and web; only the navigation chrome changes. Nothing exists on one platform with no home on the others. |
| **P7** | Native where the platform has an opinion | SF Symbols, Dynamic Type, `NavigationSplitView`, `TabView`, `.confirmationDialog`, `UNNotificationAction` on Apple; the system font stack, `prefers-color-scheme`, `prefers-reduced-motion` and real `<button>`/`<dialog>` on the web. **No webfont is ever loaded.** |
| **P8** | The chat is modelled on iMessage, deliberately | Bubbles aligned to sender, timestamps on demand, a single-line composer that grows, one `+` button, tapbacks as the feedback affordance. *Not* borrowed: read receipts, typing indicators, anything that animates on arrival. Described, never copied — no Apple asset, string or name. |
| **P9** | The transcript never moves under you | A list scrolls only when the reader is already at the bottom; an arriving message appends silently and raises a "↓ New Reply" pill. A poll is a repaint, not a navigation. |
| **P10** | Title Case names things; sentence case says things | Title Case for screen titles, navigation labels, column headers, card titles and button labels; sentence case for body copy, helper text, placeholders, empty states and errors; identifiers (agent ids, paths, tool names, `mode:` values) in mono, as-is, never case-corrected. |

**Plus the themes from `docs/product/ux-direction.md`:** *discoverable over
memorised* — slash commands, `@agent` and tiers stay as the power layer, but
each gets a tappable surface, and everything in the menu **inserts itself at
the caret** rather than sending; *rich question–answer prompts* — when the
assistant needs input it asks with a structured card (question, options, a
marked default, a free-text escape) instead of expecting the user to phrase a
reply correctly; *actionable notifications* offering the identical choices the
card does; *a door, not a dead end* — deep links and one-tap targeted actions
("summarize this", "what's the latest on X") on anything surfaced; and *calm*
— the working state is a **word**, not a spinner, and nothing auto-scrolls,
parallaxes, spins or pulses.

---

## 5. The brand identity ask

**Name.** Metistry — the project, repo, CLI command and app. The assistant is
named per-instance and is never named in the brand. **Meaning, and the
register:** the root is the ancient word for *practical*
wisdom — the counselor's gift, which was never knowing everything but turning
what is known into what to *do*. The `-try` suffix reads as a craft or
practice (artistry, chemistry, mastery): **metistry, the craft of counsel and
coordination**. Public copy **hints and never explains** — `README.md` models
the register: "The name is a nod, not an acronym." The myth-literate get the
reference; everyone else gets the ethos.

**Positioning.** A personal AI operating system you own entirely: local-first
in ownership; safety that is structural rather than promised; predictable cost;
coordinates *your other* AI tools rather than replacing them. Infrastructure
for one person — not a consumer app, not an enterprise dashboard. **Tone
words:** calm · precise · candid · durable · quietly technical. Explicitly not
playful, magical, futuristic, corporate or "AI-glow".

**What exists today — two placeholders that do not even agree with each
other.** The **Mac app icon** is *generated at build time* by
`ops/release/make-app-icon.mjs`: a rounded square filled with the `accent`
role (`#2b5fd0`) and a white capital **M** of four thick strokes, inset ~9.8%
with a corner radius ~18.5% of a 1024pt master, run through `sips` and
`iconutil` into `AppIcon.icns` (`ops/release/build-app.sh:127–138`) —
generated rather than committed on purpose, because "a binary blob nobody
remembers is the kind of placeholder that ships forever." The **PWA favicon**
(`apps/console/web/icon.svg`) is a *different* mark: a near-black rounded
square (`#0e1216`) with a light-blue (`#7ea9ff`) **M** drawn as a polyline
and, beside it, a dot-and-stem forming an **i**.

| Asset needed | Requirement |
| --- | --- |
| Wordmark | "Metistry"; one horizontal lockup, one stacked |
| App icon master | 1024×1024, drawn **inside the macOS icon grid** (art inset from the canvas) and for the **squircle mask** — never draw your own rounded rectangle for iOS |
| macOS `.icns` set | renders from the master at 16, 32, 64, 128, 256, 512, 1024 px; **it must still read at 16 px**, which is the real constraint |
| iOS variants | light, **dark** and **tinted** (monochrome, mask-driven); assume iOS 18+ appearance modes |
| Menu-bar glyph | a **template** image: monochrome + alpha, ~16–18pt, legible in both menu-bar appearances, able to carry ok / degraded / failed / absent **without colour** |
| PWA icons | favicon, 180px apple-touch, 512px, and a **maskable** variant with safe-zone padding; the manifest's current background and theme are both `#f6f7f9` |
| Brand kit | the marks, clear-space and minimum sizes, allowed colour pairs, one page of do/don't |

**Avoid:** owls, laurels, columns, helmets, brains, sparkles, robot faces,
glowing orbs, gradient meshes, the letter "M" as the whole idea, anything
needing colour to be legible, anything that reads as corporate SaaS, and any
mark that cannot be drawn in one weight of one colour at 16 px.

---

## 6. Deliverables, precisely

| # | Deliverable | What it must contain |
| --- | --- | --- |
| 1 | **Design language doc** | the idea in a paragraph, then what it means for surfaces, density, hierarchy and voice |
| 2 | **Colour system**, light and dark | **semantic roles**, not hues — the list is `design-system.md` §2.1 (canvas, surface, elevated, sunken, borders, three text levels, the accent set, the **agent** tint, four state colours, six presence colours, focus ring, scrim), because a role may be re-pointed without renaming a call site. Every foreground/background pair must pass **WCAG AA — 4.5:1 text, 3:1 non-text**; we compute this in CI (`ops/scripts/build-design-tokens.mjs --check` checks all 74 declared pairs and fails the build, `design-system.md` §2.2). Chips are not large text and get no exemption. Every state also carries a label and a glyph: **colour is never the only signal** |
| 3 | **Type scale** | mapped to Apple's Dynamic Type styles; **SF Pro** on Apple (`.font(.body)` picks it), the system stack as the web fallback (`-apple-system, BlinkMacSystemFont, system-ui, …`) and `ui-monospace, SFMono-Regular, …` for identifiers and code. **No third-party font, ever.** Reply prose gets its **own** scale tuned for density, not scanning (`design-system.md` §4: 15pt phone / 16pt Mac, 1.45 line, 12px paragraph gap, 38em measure) |
| 4 | **Spacing, radius, elevation, motion** | a 4pt grid; 44pt touch targets, 28pt pointer targets; four elevation levels where **dark mode raises by getting lighter, not by a bigger shadow**; motion that explains a change of state and nothing else, collapsing to ~0 under Reduce Motion |
| 5 | **Component designs** | every component in `design-system.md` §3 plus the two this brief adds: navigation (six rows, two disclosure groups, **Pinned**) · activity feed row · presence chip · chat message with collapsed tool activity · question–answer prompt card · composer actions menu and ⌘K palette · model & effort picker · capture composer **and the floating "+" that opens it** · **request card (six answers)** · **the Needs You bell and its panel (§3.18)** · **pinned sidebar items (§3.19)** · task card and drag-to-dispatch · artifact viewer · project header and mode toggle · status/doctor row · notification with actions · empty states (*empty* and *absent* differ and get different copy) · error envelopes · destructive confirmation · **settings panes** · **wizard steps** |
| 6 | **Per-screen mockups, Mac first** | in the §3.2 order, light and dark. `docs/product/design/*.svg` shows the house style (1000×800 Mac/wide, 390×844 phone, realistic content, numbered callouts, a legend) — match the rigour, not necessarily the look |
| 7 | **Icon set direction** | **SF Symbols first**: name the symbol for each kind, state and destination; propose custom glyphs only where none fits, and say why. `design-system.md` §3.2 already lists a symbol per activity kind — the starting inventory |
| 8 | **The brand kit** | per §5 |

**The format that matters.** Tokens come back as **JSON matching the schema of
`docs/product/design/tokens.json`** — top-level `color`, `type`, `reply`,
`space`, `size`, `radius`, `elevation`, `motion`, `z`, each entry carrying its
`role` prose, its `light`/`dark` values and, for colour, its `apple`
system-colour mapping. That file is the single source:
`ops/scripts/build-design-tokens.mjs` generates `tokens.css`, the PWA's
stylesheet, the Mac app's `design-tokens.swift` and the inlined block in
`preview.html` from it, and `--check` fails CI on drift. **Anything else breaks
the pipeline.** `preview.html` renders every component in light and dark and is
the fastest way to see whether a token change works.

---

## 7. Constraints and non-goals

- **Apple HIG conformance is not optional** — it is where our accessibility
  comes from free: Dynamic Type, VoiceOver, Increase Contrast and Reduce Motion
  all arrive with the standard control. **Dynamic Type at every size:** layouts
  must survive `accessibilityExtraExtraExtraLarge` — chips wrap to their own
  line, the sidebar collapses, action rows stack, no row is a fixed height. No
  fixed point size anywhere; no `px` font size on the web.
- **Keyboard-first on the Mac** (and the wide PWA): full keyboard
  reachability, a visible 2px focus ring never suppressed, ⌘K, ⌘1–⌘9 for
  destinations, `/` to focus the composer, `Esc` to close anything. **Every
  drag gesture needs a menu equivalent** — a gesture that only works with a
  pointer is not a control. **VoiceOver labels are sentences, not tokens**
  ("drey-dev, interrupted, lease expired 4 minutes ago"), and agent text
  carries a spoken "from agent X:" prefix so P1 survives with the screen off.
- **No marketing site**, landing page or launch collateral; the product's own
  interface only. **No chat-bubble gimmicks beyond P8** — nothing borrowed from
  Messages that P8 does not name; no stickers, effects or invented agent
  avatars. **Agent text is data, not chrome** (P1) — the rule most likely to be
  broken by a good-looking mockup.
- **No new dependency to draw something:** no icon font, webfont, animation
  library or CSS framework; and nothing decorative that has to be maintained
  for years by one person. **Not in scope:** the API, wire contracts, named
  queries, and the parts of the design system already settled and CI-enforced
  (the contrast method, the token pipeline, the status row, the vocabulary).

---

## 8. How to work with us

**Iterate per screen, not per phase.** One at a time, in the §3.2 order, Mac
first. For each: the mockup (light and dark), the states it must have —
**empty vs absent vs failed vs stale** — and the refusal copy. We review one
screen and send it back before the next begins; a screen whose spec cannot
name its data source does not pass.

**Questions we want you to ask, early:** which current tokens are load-bearing
and which are habit (say which you would replace and what it buys); for any
screen, what is the one thing the user came here to do and what makes the
calm-surface rule hard to hold there; where the six-section IA fights the
content (Work is four things in one expandable group, Knowledge is undesigned
— both may be wrong; and "Insights" is a name we propose, not one we are
attached to); what is missing from the vocabulary (a word you needed and could not
find in `docs/product/glossary.md` is a finding, not a licence to invent one —
the eight nouns are ratified); and which states here have no visual answer.

**What we send back:** the screen spec (route or named query behind it, every
state, refusal copy, keyboard map, VoiceOver sentence per chip), a yes/no on
the tokens, and honest screenshots of what we built last round.

**Contradictions in the repo, logged rather than routed around** (per
`CLAUDE.md`; none edited in place, and you should not be surprised by them):

- **`design-system.md` P6, §3.1 and §3.9 were amended 2026-09-17 (#188)** to
  the seven sections and the six answers, and **amended again the same day**
  (second ruling) to the six sections, the floating "+", the Needs You bell
  and Insights; §3.18 and §3.19 are new. The struck lines there record the
  old ten destinations, the seven sections and the three answers — read them
  as the trail, not as alternatives. The PWA still ships its older nav and
  follows in a later PR. Capture is one of the glossary's eight nouns: the
  noun stays, the tab goes. **Needs You is still the product's only badge**
  (P2) — it moved onto a bell, it did not multiply.
- **Compute can be managed only on the Mac** (`metistry compute` verbs; the
  console exposes no `/api/compute` route), which P6 forbids. **Knowledge has
  no client read path at all** — captures go in and nothing comes back out to
  any client; it is the largest server ask in `app-ux-plan.md` §6 and is not
  yet committed to. Design both as if they will exist everywhere.
- **The SVG wireframes carry literal hexes** that no `--check` verifies, so
  they may already have drifted from `tokens.json`.

---

## Paste-ready prompt

> You are designing **Metistry**, a personal AI operating system that one
> technical person owns and runs on their own Macs for years: a persistent
> assistant, a Markdown knowledge vault in git and Obsidian, a shared task
> list worked by external AI agents, and one queue of things that need a
> human. Free and open source; there is no marketing site.
>
> Read `docs/product/design-brief.md` first — the full brief: what the product
> is, its surfaces (native SwiftUI Mac app first, iOS later, a PWA for
> non-Apple machines), the **six-section** information architecture (Chat,
> Feed, Work, Knowledge, Agents, Insights) with **two global controls** —
> capture is a floating "+" that opens a composer, and the queue of things
> needing a human hangs off a **bell with an unread count** in the top-right
> of every screen, never a tab — plus a user-filled **Pinned** area in the Mac
> sidebar, Settings (which holds status, compute, devices and instances) and
> a setup wizard in the app menu; every screen, and exactly what we need
> back. Then read `docs/product/design-system.md`:
> its ten principles **P1–P10 are constraints you must honour** — above all,
> agent-written text is data and never looks like a control; silence is the
> default so the surface stays calm; refusals are explained inline where they
> happen; state is reported, never inferred; the transcript never moves under
> the reader. Its **tokens** (`docs/product/design/tokens.json`) are a starting
> point you may replace — keep the semantic role names, keep every pair at WCAG
> AA (we compute contrast in CI), use SF Pro on Apple with the system stack on
> the web, and never load a third-party font.
>
> Start with the brand: a wordmark, an app icon and a menu-bar glyph replacing
> the generated placeholder "M", plus the macOS, iOS and PWA icon variants the
> brief lists. Then the Mac screens, one at a time, light and dark, in the
> brief's order. Return tokens as JSON matching
> `docs/product/design/tokens.json`'s schema so our generator rebuilds
> `tokens.css` and `design-tokens.swift` from it unchanged. Ask us the
> questions in §8 before you draw anything.
