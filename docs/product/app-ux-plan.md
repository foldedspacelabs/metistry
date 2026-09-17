# App UX plan — designing the interface across Mac, iOS and the PWA (2026-09-16)

> Status: **a plan for the design work, not the design.** It inventories what
> is on screen today, names the objects the interface has to expose, proposes
> one information architecture in three renderings, and lays out the one
> technical decision that has to be made before a second screen is built.
> Nothing here was a ruling when it was written; §7 is what needed one, and
> **§7 now carries the owner's rulings of 2026-09-17** — the IA, the
> rendering, the scope of the Mac client, the request card's answers, the
> designer, and a sizing for knowledge (§6.1) — **and the second ruling of
> the same day**, made after reading the wireframes those first rulings
> produced: capture is a floating "+", Needs You is a bell, the Mac sidebar
> is flexible and customizable, and System splits into Settings and
> **Insights** (§7.7–§7.11).
>
> Companions: `design-system.md` (tokens and components — normative),
> `ux-direction.md` (what the interaction must feel like), `glossary.md` (the
> eight nouns and the verb set), `desktop-app-plan.md`, `ios-app-plan.md`,
> `docs/ops/mac-app.md`.
>
> The starting complaint, in the owner's words: the Mac app today is "nothing
> but really verbose, hard to understand settings and a status page." That is
> an accurate description of it, and §1 shows why — the app shipped the
> install-and-operate half of the product and none of the *manage* half.

---

## 1. Inventory — what is on screen today

### 1.1 The Mac app (`apps/macos`)

| Surface | File | What it is |
| --- | --- | --- |
| The window | `sources/kit/root-view.swift` | a `NavigationSplitView` whose destination enum has **exactly one case**: `.status` |
| Status | `sources/kit/status-panel.swift` | `metistry doctor --json` rendered to §3.13 — grouped by `kind`, summary line first, `absent` labelled "not configured" |
| Menu bar | `sources/kit/menu-bar-view.swift`, `menu-model.swift` | worst-state glyph, per-component submenu (Restart · Stop · Start · View Log), Restart All, update available |
| Settings | `sources/kit/settings-view.swift` (558 lines), `settings-model.swift` | seven panes: Instance · Services · Connections · Compute · Secrets · Updates · Advanced |
| Compute | `sources/kit/compute-view.swift` (608 lines) | the only pane that writes — every control is one `metistry compute …` verb |
| First run | `sources/kit/wizard-view.swift`, `wizard-step-views.swift` | a sheet over seven steps, each showing its argument array before it runs |
| Logs | `sources/kit/log-window-view.swift` | last 200 lines of one component |

So: **one of the design system's ten destinations exists, and it is the one
that is about the machine rather than about the work.** 2,644 of the kit's 9,763 Swift
lines are settings, the wizard and first-run, and another 1,921 are the compute
pane — which is exactly the shape the complaint describes. Nothing in the app reads a task, a request, an
artifact, a message or a page.

The app has no authenticated data client either. `sources/kit/console-client.swift`
does `health`, `loginOptions`, `enrolmentOptions`, `finishEnrolment` — the
auth ceremony and nothing else. Every fact on screen arrives by shelling a
`metistry` verb through the `CommandRunner` seam.

### 1.2 The console PWA (`apps/console/web`)

Eleven views, in `app.js:10`: `feed · chat · board · dashboard · capture ·
triage · status · devices · agents · artifacts · rooms`. This is the product's
real interface today, and it is further along than the Mac app on every data
surface: the feed with agent/project/kind filters, chat with collapsed tool
activity and the §3.6 composer menu, the Kanban board with HTML5 drags and an
`m`-key equivalent, the artifact viewer with the sandboxed HTML frame, rooms,
request cards with five answers, the doctor list, the spend dashboard.

What is *missing* from the PWA, as a management surface: no Knowledge view of
any kind, no Projects section (the §3.12 header and mode toggle live as rows
inside **Dashboard**, `app.js:932–961`), no compute, no crews, no routines or
collectors beyond their doctor rows, no instance switcher.

### 1.3 iOS (`docs/product/ios-app-plan.md`)

Planning only, post-Phase-6. No target in `apps/macos/Package.swift` — the
iOS platform line there is, in the manifest's own words, "a statement of
intent, not a shipped target", and it exists to keep `MetistryKit` free of
AppKit and `Process`. The plan's phasing (capture companion → chat + status →
HealthKit/widgets → on-phone FM) and the O1–O5 offline rules
(`docs/plan-refresh-2026-09-13.md` §1) are the constraints, not screens.

### 1.4 Where the design system is applied, and where it is not

**Tokens: better than expected.** `ops/scripts/build-design-tokens.mjs` is the
single generator. From `docs/product/design/tokens.json` it writes
`docs/product/design/tokens.css`, `apps/console/web/tokens.css`,
`apps/macos/sources/kit/design-tokens.swift`, and the inlined block in
`preview.html`; `--check` fails on drift **and** re-computes all 74 WCAG pairs.
CI runs it at `.github/workflows/ci.yml:39`. So the "generate a token file for
Swift and CSS from one source" idea in the brief is **already shipped** — the
gaps are narrower and listed below.

| Claim | Reality | Evidence |
| --- | --- | --- |
| `design-tokens.swift` matches §2 | yes for colour, type, space, size, radius — generated, CI-checked | `build-design-tokens.mjs:164–318` |
| …completely | **no**: the Swift emit skips `reply` (§4), `elevation` (§2.5), `motion` (§2.6) and `z`. A native chat would have to invent reply typography | same file — `stat()` emits all four to CSS, the Swift block emits four groups of nine |
| the PWA's CSS uses the tokens | yes, overwhelmingly — 356 `--mt-*` references in `style.css` | `apps/console/web/style.css` |
| …with no literals | **no**: `gap: 2px` ×4, `padding: 3px`, `height: 6px`, `border-radius: 3px`, `border-left: 3px`, `min-height: 96px` — the file's own header promises none of these | `style.css:102, 156, 274, 619–620, 698, 773, 801` |
| §3.1 navigation | **drifted**: eleven flat buttons in a horizontally scrolling strip, not five + a "more" disclosure; and the order is not P6's | `index.html:22–33`, `style.css:78–92` |
| §3.17 destructive confirmation | **not applied**: four `window.confirm()` calls where the spec says `<dialog>`, destructive-styled affirmative, `autofocus` on Cancel | `app.js:682, 767, 774, 959` |
| §3.7 model & effort picker | **built nowhere.** The tier is *shown* on a turn, never chosen; `/deep` is the only path | `app.js:96–101` |
| §3.9 request card | built, with **six** (Approve · Revise · Decline · Later · Skip, plus Approve as Work where the row carries `suggested_work`); §3.9 said three until the 2026-09-17 amendment (§7.4) | `index.html:131–141`, `app.js:493–502, 644–653` |
| §3.2–3.6, 3.8, 3.10–3.16 | built in the PWA, in HTML/CSS only | `apps/console/web/` |
| the same components in SwiftUI | **only §3.13.** Sixteen of seventeen components have no Swift implementation | `apps/macos/sources/kit/` |
| mockups track the tokens | not checked — the SVGs carry literal hexes (`#2b5fd0`, `#6a4bbd`) that no `--check` verifies | `docs/product/design/*.svg` |

**Two P6 violations worth naming separately**, because they are about the
architecture and not the styling:

1. **Compute can only be managed on the Mac.** `Settings → Compute` drives nine
   `metistry compute` verbs; the console exposes **no** `/api/compute` route
   (`apps/console/src/compute.ts` is a read-only watcher over `compute.yaml`).
   P6 says nothing exists on one platform with no home on the others.
2. **Knowledge is not one of the ten destinations at all** — yet it is the
   glossary's first noun and the thing the product is *for*. Captures go in
   (`POST /capture` → `Knowledge/Inbox/`) and nothing comes back out to any
   client: there is no console route that lists, reads or searches the vault.
   `knowledge_files`, `knowledge_links` and `embeddings` exist in Postgres
   (`db/migrations/0001_init.sql`, `0012_knowledge_embedded.sql`) and no named
   query reads them.

---

## 2. The object model the UI must expose

Verbs are the glossary's (`list · get · search · create · update`, plus each
object's own). **Human-only** is invariant 2 as it is actually enforced —
`docs/ops/reconciler.md`'s protected paths, and the `user`-principal routes in
`docs/ops/console-api.md`.

| Object | Verbs the UI must offer | Human-only | Where it lives today |
| --- | --- | --- | --- |
| **capture** | create (≤5s), list, get, edit, file into a page | — | `POST /capture`, `inbox` rows, `Knowledge/Inbox/` |
| **knowledge page** | list, get, search (keyword/semantic), write, follow links/backlinks, revert | write to a protected path is the user's hand; the vault itself is shared | `knowledge_files`, `knowledge_links`, vault via the reconciler bridge — **no client read path** |
| **request** | list, get, approve · revise · decline (· later · skip) | **yes, entirely** — it is the definition of the queue | `proposals`, `GET /api/proposals`, `POST /api/proposals/batch` |
| **task** (work) | list, get, create, update, claim · renew · release · close, dispatch, address to a crew, comment | the write routes are `user`-principal only; addressing a card to a crew is human-only by the collaboration rule | `work`, `/api/q/board`, `/api/tasks/*` |
| **artifact** | list, get, publish, version, comment · resolve, send for review | — | `artifacts`, `/api/artifacts` |
| **room** (thread) | list, get, comment, resolve | — (and **nothing** may address anyone) | `/api/q/rooms`, `artifact_comments` |
| **project** | list, get, set mode (Auto/Supervised), budget, cap, members | **mode, budget, cap** — the kill switch | `projects`, `PUT /api/projects/:id`, `projects_rollup` |
| **agent** | list, get, register, approve, rotate, revoke, set scope/tier, set autonomy, delegate | **register/approve/rotate/revoke and every widening** (`PUT /api/agents/:id/autonomy` is "the one route that may widen") | `agents`, `/api/agents`, `agent_presence` |
| **crew** | list, get, dispatch a brief, read the brief that crossed | **create/edit** — `agents/<area>/<name>.md` is a protected path | `seed/agents/`, `docs/ops/crews.md` |
| **routine / collector** | list, get, run now, read last run + failure streak | **create/edit** — `routines/` is protected | manifests + `runs`, doctor rows |
| **bridge** | list, get, `check()`, enable, mint a token | token minting is the user's hand (Keychain) | manifests, doctor rows, `metistry secrets` |
| **target** | list, get, dispatch to | manifests are files (`targets/`, not in the protected list — see §7) | `GET /api/targets`, `POST /api/dispatches` |
| **compute** | list providers/models, assign per tier, budgets, install a model, pick a tier per turn | provider/API key is the user's hand | `compute.yaml`, `metistry compute …` — **CLI and the Mac only** |
| **activity / run** | list, filter, get, export | — | `activity_feed`, `runs`, `/api/runs/export` |
| **instance** | list peers, switch, name, reachability | `identity.yaml`, `deployment.yaml` are protected | `instances.yaml`, `GET /api/instances`, `GET /api/identity` |
| **device / session** | list, revoke | **yes** | `GET /api/devices`, `POST /auth/logout` |
| **the assistant itself** | chat, pick a tier, tapback, read/propose prompt changes | prompt changes land as `improvement` requests you approve | `POST /message`, `GET /api/messages`, `reply_feedback` |

Two rules the screens inherit from this table: a builder word
(collector, routine, bridge, target, principal, crew, fold) **must not reach a
label** (`glossary.md`), and every human-only verb needs a §3.17 confirmation
that quotes the API's own refusal string (P3/P4).

---

## 3. One information architecture, three renderings

### 3.1 Six sections, two global controls, and Settings

P6 fixed ten flat destinations; the PWA shipped eleven in a different order
(§1.4); this plan proposed **seven**, and they were ruled in on 2026-09-17
(§7.1). Then the owner read the wireframes drawn to those seven and **ruled
again the same day** (§7.7–§7.11): the two entries that were *not* places —
the queue you answer and the note you dash off — stop pretending to be, and
the one entry that was two different questions under one name splits. What
is left is **six sections**, **two global controls** reachable from every one
of them, and **Settings**.

| Section | Contains | Why it is one section |
| --- | --- | --- |
| **Chat** | the conversation, tier picker, tapbacks | P8/P9 give it its own rules; it is the most-touched surface |
| **Feed** | activity, filters, run detail | the desktop plan's centrepiece; "what happened" is one question |
| **Work** ▸ | Board · Projects · Artifacts · Rooms — **children of the row, not tabs inside it** | four views of **one** object graph: a task has a room, produces an artifact, belongs to a project. Expanding the row is what keeps that true *and* keeps each view one click away (§7.10) |
| **Knowledge** ▸ | Pages · Search · Inbox — likewise | the product's first noun, until now homeless |
| **Agents** | agents, presence, scope/autonomy, crews, targets | one question: who may do what, and what are they doing |
| **Insights** | cost data, spend over time, run metrics, shadow agreement, token and latency trends | what the instance *did*, measured. The name is a proposal and the owner's to change (§7.11) |

**Two global controls, on every screen.**

- **Capture is a floating "+".** Bottom-right on iOS, a button that floats
  over the content clear of the tab bar and the home indicator; on the Mac a
  "+" in the toolbar and in the sidebar footer, plus `⌘N` and the global
  hotkey. It opens the §3.8 capture composer as a **popover or panel** (Mac)
  or a **medium-detent sheet** (iOS) and returns. **There is no Capture tab
  and no Capture screen on any platform**; the *list* of captures is
  Knowledge → Inbox. A destination you navigate to contradicts its own
  five-second promise, and a button that is always in the same corner is the
  shortest version of that promise the platform has.
- **Needs You is a bell, not a section.** Top-right on both iOS and Mac,
  carrying the unread count — still the product's **only** badge (P2).
  Tapping it opens the request queue as a **popover/panel over whatever is on
  screen** (Mac) or a **sheet** (iOS), holding the same §3.9 cards and the
  same six answers. It leaves the sidebar and it leaves the tab bar. The
  actionable notification (`ux-direction.md`) is *this queue surfaced by the
  OS*, so the bell and the notification are one surface with two front doors,
  not two implementations to keep in step.

**Settings, and what moved into it.** Status, compute (providers · models ·
assignments · budgets), and devices and instances are **Settings panes** —
configuration and operation, which you visit on purpose and rarely, not daily
reading. **Compute configuration lives in Settings**, which is where the
`metistry compute` verbs already point. **Setup stops being anywhere in the
navigation**: it is an app-menu item, Metistry → "Set up…" / "Run setup
again". On the Mac, Settings is reached the way macOS reaches settings — the
app menu and `⌘,`, opening the standard `Settings` scene — so it is **not** a
sidebar row (§3.4 below); on iOS it sits under More, because there is no
app menu to put it in.

**Pinned — the Mac sidebar is the user's (§7.10).** Below the six fixed rows,
an area the owner fills: pin a project or a board, a knowledge page or a
saved search, or an agent, and it becomes a one-click row. Drag to reorder;
unpin from the context menu. §3.4 below has the SwiftUI shape and what
persists where.

### 3.2 Screens, and the components each uses

| Section | Screen | Components (`design-system.md` §3) | Data |
| --- | --- | --- | --- |
| Chat | Conversation | 3.4 message + collapsed tools, 3.5 prompt card, 3.6 composer menu + palette, **3.7 tier picker (unbuilt)**, §4 reply tokens, 3.14 notifications | `/api/messages`, `POST /message` |
| Feed | Activity | 3.2 feed row, 3.3 presence chip, 3.15 empty, 3.16 errors | `/api/q/activity_feed` |
| Feed | Run detail | 3.4 tool disclosure, 3.16 | `runs` (needs a query — §6) |
| **global** | **Needs You panel** (the bell) | **3.18 bell + panel**, 3.9 request card, 3.5, 3.17, 3.14 | `/api/proposals`, `…/batch` |
| **global** | **Capture popover** (the "+") | 3.8 capture composer, 3.15, 3.16 | `POST /capture` |
| Work | Board | 3.10 task card + drag-to-dispatch (+ keyboard equivalent), 3.12 mode chip | `/api/q/board`, `/api/tasks/*` |
| Work | Task detail | 3.10, room thread (3.11's comment threads), 3.16 | `/api/q/board`, rooms |
| Work | Artifact | 3.11 viewer (sandboxed HTML band), 3.17 on review dispatch | `/api/artifacts` |
| Work | Project | 3.12 header + mode toggle, 3.3, 3.17 | `projects_rollup`, `PUT /api/projects/:id` |
| Knowledge | Pages / Inbox | 3.2-shaped rows, 3.15 (empty vs absent) | **new** (§6 phase E) |
| Knowledge | Page | 3.11's markdown renderer at `reading-measure`, links/backlinks | **new** |
| Knowledge | Search | 3.6-style suggest, 3.16 (degraded = keyword only, P5) | **new** |
| Agents | Agents | 3.3 presence chip, 3.10 drop target, 3.17 (rotate/revoke/widen) | `/api/agents`, `agent_presence` |
| Agents | Agent detail | scope/tier/autonomy controls, 3.17, 3.4 for its runs | `PUT /api/agents/:id/*` |
| Agents | Crews / Targets | 3.13-shaped rows, read-only + dispatch | manifests, `/api/targets` |
| Insights | Spend | tiles, 3.15 absent copy | `spend`, `aws_costs_*`, `claude_usage_daily` |
| Insights | Runs & models | 3.13-shaped rows, sparkline tiles, 3.15 absent copy — run counts and failure streaks, shadow agreement, token and latency trends | `runs`, the shadow rows (needs a query — §6) |
| Settings | Status | 3.13 doctor row (**built, Mac + PWA**) | `doctor`, `/api/status` |
| Settings | Compute | 3.13 rows + 3.17, tier assignment, budgets | `metistry compute` (**no API — §6**) |
| Settings | Devices & Instances | 3.13 rows, 3.17 revoke, presence chip for reachability | `/api/devices`, `/api/instances` |
| *app menu* | Set up… | wizard (Mac), enrolment code (PWA/iOS) | CLI verbs |
| *sidebar* | **Pinned** | **3.19 pinned sidebar items** | whatever the pin points at |

### 3.3 Same on all three, and platform-specific (P7)

**Identical** (same rows, same order, same words, same refusal text): Feed,
the request queue behind the bell, Work in all four screens, Knowledge,
Agents, Chat's transcript, Status, Spend, Devices. These are renderings of the
same API response and must never disagree.

**Layout differs, architecture does not:** three columns (nav · list · detail)
on Mac and wide PWA; one column with push navigation on iPhone and narrow PWA
— which is what §5's wireframes already show. The two global controls differ
in *presentation* and not in content: the bell's queue is a panel on the Mac
and a sheet on the phone; capture is a popover on the Mac and a sheet on the
phone; both hold the same component with the same states.

**Per platform, the navigation chrome (§7.9, §7.10).**

| | Mac | iOS | PWA |
| --- | --- | --- | --- |
| Sections | sidebar: Chat · Feed · **Work ▸** · **Knowledge ▸** · Agents · Insights, then **Pinned** | tab bar, **five items, maximum**: Chat · Feed · Work · Knowledge · **More** | the same `<nav>`: sidebar ≥900px, the five-item tab bar below it |
| Capture | toolbar "+" · sidebar-footer "+" · `⌘N` · global hotkey · window drop | **floating "+", bottom-right** · share extension | header "+" (wide: sidebar footer) |
| Needs You | **bell, top-right**, count badge → popover/panel | **bell, top-right**, count badge → sheet | bell in the header → dialog |
| Settings | **app menu + `⌘,`** (the `Settings` scene) — not a sidebar row | under **More** | under **More** |
| Setup | app menu → "Set up…" / "Run setup again" | enrolment code, in Settings | enrolment code, in Settings |
| Under More | — | Agents, Insights, Settings | Agents, Insights, Settings |

Four sections plus More, not five plus More: the HIG's iPhone tab bar tops
out around five items and a sixth silently becomes a system "More" list you
did not design. Work and Knowledge earn their place over Agents and Insights
because they are the ones you open by habit rather than on purpose.

**Mac only:** menu-bar item, the Settings scene, the first-run wizard, log
windows, Keychain and secrets, TCC bridge permissions, Sparkle updates, login
item, global capture hotkey, drag-drop capture, **the Pinned sidebar area**,
"reveal in Finder", terminal hand-off. All of it is *installing and
operating*, or it is chrome the platform gives us — and none of it is data.

**iOS only:** share extension + offline outbox, APNs categories, widgets and
Live Activities, App Intents/Siri, HealthKit, on-device classification, the
per-instance switcher with the honest presence chip (O1/O2).

**PWA only:** install prompt, web push, the enrolment-code wall.

### 3.4 The Mac sidebar in SwiftUI, and what persists where

The owner's worry was that Work had become too nested — Board is a section, a
segmented control and then a column. The fix is the disclosure group: the
sidebar carries the children, so **Board, Projects, Artifacts and Rooms are
one click from the sidebar**, and the second-level segmented control inside
Work becomes a redundancy to delete rather than a step to take.

```
NavigationSplitView
  sidebar: List(selection: $destination)
    Section {                       // the six, fixed order, not reorderable
      Chat · Feed
      DisclosureGroup("Work")      { Board · Projects · Artifacts · Rooms }
      DisclosureGroup("Knowledge") { Pages · Search · Inbox }
      Agents · Insights
    }
    Section("Pinned") {            // the user's, reorderable, removable
      ForEach(pins) { … }          // .onMove, .contextMenu { Unpin }
    }
    .safeAreaInset(.bottom) { "+" capture }
  detail: the selected destination
.toolbar { bell (badge) · "+" · the view's own controls }
```

Two rules the shape encodes. **The six are not customizable** — P6's "the
same order, the same names" is what stops the owner learning the product
twice, and a sidebar you can rearrange into a different product is not one
architecture in three renderings. **Everything below them is** — a pin is a
shortcut to a destination that already exists, so it can be anything without
touching the map.

**What persists, and where.**

| State | Where | Why |
| --- | --- | --- |
| Pins (kind, id, display name, order) | **app preferences, keyed by instance id** | A pin points at a project, page, saved search or agent *in one instance*; the same app against a second instance must not show the first one's pins |
| Disclosure open/closed, sidebar width, last selection | app preferences, same key | Window state, per machine. Restoring it is the platform's habit, not ours |
| The pinned *object* | nowhere new | The pin holds a reference. The project is in Postgres, the page is in the vault, the agent is in `agents` — the sidebar reads them like any other screen |

Nothing about pinning goes into the instance repo, Postgres or the vault: it
is per-machine client state, it is not derived from anything, and invariant 1
("git is the record; Postgres is derived") does not want a fourth category.
Losing it costs the owner one drag. A pin whose target has gone renders as a
dimmed row that says so and offers Unpin — never a crash, never a silent
disappearance (P5).

---

## 4. The central technical decision — ruled 2026-09-17: **(a)**

> **Ruling (§7.2).** Native SwiftUI for Mac and iOS, and **no PWA embedding
> for application surfaces**. In the owner's words: "a native optimized UI
> that feels fast and native to the OS." §3.11's `WKWebView` for *document*
> rendering stands — the precedent option (c) noticed is kept exactly where
> the design system drew it, at documents, and does not extend to lists and
> controls. Order: **Mac first**, iOS when it is prioritised.
>
> What follows from it. The `WKWebView`/WebAuthn spike in (b) is **not run**:
> §7.3 keeps the app a client of *this* machine over loopback with the local
> owner token, so there is no ceremony to complete. The sixteen unimplemented
> components in (a)'s own "against" column are the real cost, and §6 is how
> they are paid. The PWA stays the desktop client for every non-Apple
> machine, which no option changed. And the owner runs the Mac app on **both**
> instances — each Mac against its own local instance — which is two installs
> of one client, not one client of two instances (§7.3).

How the **data** views reach the Mac was the question. Three shapes were
weighed; they are kept here as the record.

**(a) Native SwiftUI, shared with iOS.** Build the seven sections in
`MetistryKit` against the management API; one codebase, two targets.
*For:* it is the existing ruling (`ux-direction.md`, 2026-09-07: "the desktop
client is the same SwiftUI codebase as the phone"); `MetistryKit` is already
AppKit-free and `Process`-free precisely for this; every iOS-only capability
(share extension, widgets, App Intents) needs the native views anyway; O3's
"decision controls are disabled while unreachable" is natural in a typed model
layer; the board query returns plain scalar columns *so that* a native client
can render them without server work (`docs/ops/board.md`).
*Against:* it is the largest build — sixteen unimplemented components, plus an
authenticated API client, a store, and an offline outbox; and every design fix
then has to be made twice, in CSS and in Swift, forever.

**(b) Embed the PWA in a `WKWebView`; keep native chrome for TCC, Keychain,
setup and the menu bar.** *For:* the data views exist and are ahead of the
Swift; one implementation of every component; a design change ships to all
three surfaces at once; it is a small amount of code.
*Against:* the app becomes a browser for its own product — `desktop-app-plan.md`
rules out "an Electron/Tauri wrapper (a second runtime)", and while a
`WKWebView` is the *system's* runtime and so not literally that, it rhymes
closely enough that the owner should say which side of the line it falls on.
It buys nothing for iOS (a phone wrapping the PWA has no share extension and no
widget). P7 is structurally unreachable — no `NavigationSplitView`, no SF
Symbols, no Dynamic Type, no `.confirmationDialog`. And the auth story is
genuinely unclear: the PWA authenticates with a passkey device-session cookie,
whereas the app authenticates as the local owner over loopback
(`METISTRY_LOCAL_OWNER_TOKEN`, `apps/console/src/local-owner.ts`). **Whether a
`WKWebView` can complete a WebAuthn ceremony against a loopback origin is
unverified and would need a spike** — the alternative, a custom scheme handler
that injects the bearer, means the app proxies every request, which is most of
a client anyway.

**(c) Hybrid, with the split written down.** Native: Status, menu bar,
Settings, wizard, Compute, capture, notifications, and the shell/navigation.
Web-embedded: the long-tail read surfaces where a rich renderer already exists
and a native one is expensive — the artifact viewer (markdown + sandboxed HTML,
which the design system *already* specifies as a `WKWebView` on Apple, §3.11)
and the knowledge page renderer.
*For:* it honours §3.11's existing ruling rather than contradicting it, and it
draws the line at *document rendering* rather than at *application surface*.
*Against:* two token pipelines and two focus/keyboard models inside one
window; "which half am I in" becomes a question the user can ask.

**What (c) reveals:** the design system has already decided this once, for one
component. The live question is whether that precedent extends to lists and
controls, or stops at documents.

Inputs the owner may want to weigh: maintenance by one person over years; the
offline rules O1–O4 (the outbox and the disabled-while-unreachable rule are
client state, and a web view inside the app has no better answer than the PWA
does); and the fact that the PWA is not going away on any path — it is the
desktop client for every non-Apple machine.

---

## 5. The design process

**Per screen, three artifacts.**

1. **An SVG wireframe** in `docs/product/design/`, in the existing style: a
   `1000×800` (Mac/PWA-wide) or `390×844` (phone) `viewBox`, `<title>`/`<desc>`
   for the annotation, a `<style>` block of token values, numbered red callouts
   and a legend — see `design/mac-feed.svg`. Realistic content, never lorem.
2. **A screen spec** (one section appended to this file, or a per-section file
   if this one gets long): the named query or route behind it; the §3 components
   it composes; every state including **empty vs absent vs failed vs stale**;
   the refusal copy, quoted from the API's own reason string; the keyboard map;
   the VoiceOver sentence for each chip; which platforms share it.
3. **Acceptance**, as assertions rather than prose: an entry in
   `preview.html`, a case in `apps/console/test/pwa.integration.test.ts` for
   the PWA rendering, and a `tests/kit/` case for the Swift model if the screen
   is native.

**Review gates.** (1) IA gate — §7's questions answered before any wireframe
(**passed 2026-09-17**).
(2) Wireframe gate — the owner reads the SVG and the spec together; a screen
whose spec cannot name its data source does not pass. (3) Build gate — the
component exists in `preview.html` before it is used in a screen. (4) Ship
gate — CI green, including the token check, and a product-record fragment.

**Where a designer earns their keep** (`ux-direction.md` already assumes
one, and 7.5 engages one — an AI designer, Claude Design, briefed separately
at `docs/product/design-brief.md` for the design language, the colour and
pattern system, consistent UI traits, and a new brand identity including the
logo and app icon that replace the placeholder "M"): the Work section's
list/detail density and the board card; reply
typography at phone sizes (the §4 tokens are declared but have never been read
in anger); empty and first-run states, which are the product's first
impression; the icon set (`docs/ops/mac-app.md`: "the icon is a placeholder");
and one motion/interaction review. They are **not** needed for tokens,
contrast, the status row or the request card — those are settled, and re-opening
them is how a design system dies.

**Keeping `design-system.md` the source of truth.** The generator already is
one (§1.4), so the work is closing four holes, all plain Node scripts in
`ops/scripts/` — no new dependency:

1. Emit `reply`, `elevation`, `motion` and `z` into the Swift, so a native chat
   cannot invent reply typography.
2. **A call-site lint**: fail on a literal colour, radius, or odd-numbered
   px gap in `apps/console/web/style.css` and `apps/macos/sources/**/*.swift`.
   It has nine hits today (§1.4) — fix them in the same PR that adds it.
3. **A mockup check**: every hex in `docs/product/design/*.svg` must appear in
   `tokens.json`.
4. **A vocabulary check**: navigation labels and empty-state copy match the
   glossary's nouns, and no builder word reaches a label —
   `ops/scripts/prompt-lint.mjs` is the precedent for the shape.

---

## 6. Phases, sized, ordered so the app becomes usable early

Each phase ends with something the owner can use on the Mac. "API" is what the
console must gain; everything unmarked exists today.

| # | Phase | Size | Needs from the console API |
| --- | --- | --- | --- |
| **0** | IA ruling (**done — §7.1/§7.2 and the second ruling §7.7–§7.11, 2026-09-17**) + the four CI checks + the token holes (§5) | **S** | — |
| **A** | **Shell + navigation + Feed.** The six sections in the sidebar, Work and Knowledge as `DisclosureGroup`s, the **Pinned** area (§3.4) and the toolbar's **bell** and **"+"**; the capture popover behind the "+" (§3.8 is built, so this is the panel, not the composer); an authenticated API client and store in `MetistryKit` (local owner token over loopback); §3.2 feed row, §3.3 presence chip, §3.15/§3.16 as shared Swift components. The PWA keeps its nav for now — §7.1 renavigates it in a later PR, not this one | **M** | none — `/api/q/activity_feed` exists |
| **B** | **The bell's queue + Chat.** The request queue as a **popover/panel from the toolbar bell** (§3.18), not a section: unread count, cards with the **six** answers (§7.4, `design-system.md` §3.9), §3.5 prompt cards, and local notifications with actions that are the *same* queue surfaced by the OS; the transcript under P9; §3.7 tier picker, built once for both clients | **M** | a `rules.yaml` **commands endpoint** (the PWA's `COMMANDS` array is a labelled placeholder, `index.html:93–103`, `app.js:198`); a `runs` detail query for the feed's drill-down |
| **C** | **Work.** Board + task detail + artifact + project in one list/detail pane, drags with keyboard equivalents, rooms. The sidebar already reaches all four (phase A), so nothing here is a second navigation | **L** | none for reads; `PATCH /api/tasks/:id`, `/dispatch`, `PUT /api/projects/:id` exist |
| **D** | **Agents + Settings + Insights.** Presence, scope/autonomy with §3.17 on every widening. Then **Settings grows**: Status, Compute and Devices & Instances become panes beside today's four, and "Set up…" moves to the app menu — the largest single piece of this phase, because Compute is 1,921 Swift lines that have to be re-homed rather than rewritten. **Insights is small** (**S**): it is the spend tiles and run metrics that already exist, in a section of their own | **M** | **`/api/compute`** (list providers/models, assign, budgets) — otherwise compute stays Mac-only and P6 stays violated |
| **E** | **Knowledge.** Pages, page view, search, Inbox — sized piece by piece in §6.1 (**≈7.5 agent-days**; the cheapest slice that delivers search with full results is **≈3** and needs no query and no migration) | **L** | **the biggest ask, but smaller than it looked**: no migration at all (`0009` already added `title`, `description`, `draft`), one named query over `knowledge_files`/`knowledge_links`, and three console routes proxying the reconciler's `/vault/read` and `/vault/search` — both of which are already served. Page content is not derived state, so invariant 3 sends it through the bridge, not a query |
| **F** | **iOS target.** Share extension + outbox, APNs relay, widgets, App Intents | **L** | O1–O5 are shipped (`docs/ops/console-api.md`); the relay is its own project. **O1–O4 belong to this phase alone** — §7.3 gives the Mac app no instance switcher and no outbox |

Phase A is the one that changes the owner's daily experience, because it turns
the window from a status page into a place where something happened.

### 6.1 Sizing phase E — what a knowledge read path costs, end to end

Asked for by the owner (§7.6), who wants vault browsing and **especially
full-result search** in the app. Sized against what is actually in the repo
today, not against the phase-E line above — which turns out to have
over-estimated the server side and under-estimated the client.

**What "full results" is taken to mean here:** the complete hit list the
bridge will return, each hit carrying its snippet, and one gesture from a hit
to the whole page. Not every note's full text inline — that is one
`/vault/read` per hit, and it is a different (and worse) product.

| Piece | Size | What exists, and what is missing |
| --- | --- | --- |
| **Named query over `knowledge_files` / `knowledge_links`** | **S** | **No migration.** `0009_brain.sql` already added `title`, `description` and `draft`, and `0001` has `path`, `mtime`, `content_hash`, `status`; `knowledge_links` has the edges both ways with an index on `to_path`. So the plan's "an *additive* title/description column if rows need to be readable without fetching content" is **already true**. What is missing is only the YAML: one `knowledge_pages` (prefix, limit; `NOT draft AND status <> 'conflict'`) and one `knowledge_page_links` (links + backlinks for one path), in `seed/queries/`, shaped like `board.yaml` — scalar columns so the client joins nothing |
| **Reconciler `/vault/read`** | **none** | Shipped. `{path, content, sha256, bytes}`, or `content_base64` with `&encoding=base64` |
| **Reconciler `/vault/search`** | **S** | Shipped, and better than the plan assumed: three modes, `{q, mode, hits[], degraded?}`, hits `{path, title, description, snippet, score, source}`. Two limits are the whole of the work: the snippet is capped at 300 chars (`search.ts` `snippetOf`, and keyword's is a ±120-char window around the match), and `limit` **clamps at 100 with no offset and no cursor** (`server.ts`, `clampInt(q.get("limit"), 20, 1, 100)`). Paging past 100 is an additive `offset` — but RRF fuses over a pool of `min(100, limit × 4)`, so an offset re-ranks rather than continues. Either state "top 100, honestly" in the UI or add a cursor; the first is free and the second is the S |
| **Console proxy routes** | **M** | **Nothing is exposed today.** The console holds a vault reader, lister and searcher (`main.ts:144–149`) but wires them only into `mcp-brain`'s tools — there is no `/api/knowledge*` route of any kind. Three are needed: the named query, `GET /api/knowledge/search` and `GET /api/knowledge/page?path=`, on the existing owner/session auth and the existing `not_available` envelope when no bridge is configured. Two wrinkles: `vaultBridgeSearcher` pins `mode=keyword` (`packages/mcp-brain/src/knowledge-fs.ts:101`), so the proxy takes a mode or calls the bridge itself; and the `degraded` string must reach the client rather than being swallowed — P5 |
| **Swift: API client and store** | **not counted** | Phase A's, and a hard prerequisite. `console-client.swift` is 364 lines of health plus the auth ceremony; there is no data client to add a knowledge call to |
| **Swift: Pages list + Inbox** | **S** | §3.2-shaped rows over the named query, §3.15's empty-vs-absent |
| **Swift: page view + renderer** | **M** | The renderer is the cost, not the fetch. §3.11's Apple note routes markdown through `Text(AttributedString(markdown:))` and html through a `WKWebView`; a vault page with wikilinks, embeds and `reading-measure` is the `WKWebView` path — JavaScript disabled, same CSP, the same document boundary §7.2 preserved |
| **Swift: search with full results** | **M** | Field, debounce, the results list, the mode + `degraded` chip (P5: "keyword only — the embedder is down" is a fact, not an error), and the jump into a page |
| **Wireframes + screen specs (§5)** | **S** | Three screens × (SVG + spec + acceptance entry) |

**Total: ≈7.5 agent-days** — 0.5 query, 0.5 bridge, 1 console routes with
their misuse tests (invariant 8: they ship with the interface), 4.5 Swift, 1
design artifacts. **L**, and the L is on the client side, which inverts the
phase table's original guess that this was mostly a server ask.

**The cheapest slice that delivers "search with full results" first: ≈3
agent-days, and it needs no named query and no migration.** `GET
/api/knowledge/search` and `GET /api/knowledge/page` proxying the two bridge
routes, and one Swift screen — a search field, the full hit list, and the page
view opened from a hit. It is entirely the bridge, so it can land the day the
Mac app has an authenticated client, and it delivers the half of §7.6 the
owner emphasised. Pages, Inbox and the link graph — the *browse* half — come
after, because those are the parts that need the derived state.

**Invariant 3, stated once so no screen re-opens it.** The list, the link
graph and anything countable are **derived**: Postgres, through a named query,
through `packages/queries`. The page bytes and the search ranking are **not**:
they are the working tree, through the reconciler's bridge. So a page's
content never arrives from a query, and the console never reads note bodies
from the database — there is no column holding them, which is the schema
enforcing the rule rather than a convention asking for it.

---

## 7. Open questions — answered

### Rulings — 2026-09-17

The owner's answers, numbered to the questions below. Each is applied where
it belongs: the `design-system.md` amendments landed with these rulings, the
build consequences are in §4 and §6.

**7.1 — Yes: the seven-section IA replaces P6's ten destinations.**
`design-system.md` P6 and §3.1 are amended to Chat · Feed · Needs You · Work
· Knowledge · Agents · System, with Capture as a global action and the old
list kept as a struck, dated line. **The PWA is updated to the same IA
later, not in the first PR** — so the Mac app is built to the seven from the
start and the PWA is a known, temporary disagreement rather than a second
architecture.

**7.2 — (a): native SwiftUI for Mac and iOS, no PWA embedding for
application surfaces.** In the owner's words, the goal is "a native optimized
UI that feels fast and native to the OS." §3.11's `WKWebView` for **document
rendering** stands: the line is drawn at documents, not at lists and
controls. Order is **Mac app first, iOS later when it is prioritised**. The
owner will run the Mac app on both instances — each Mac against its own local
instance. §4 carries the consequences, including that the `WKWebView`
WebAuthn spike is not run.

**7.3 — Local instance only.** The Mac app is a client of *this* machine,
over loopback, with the local owner token. Reading a remote instance is a
possible future and is **explicitly avoided now for the complexity it
brings**. So the Mac app has **no instance switcher and no outbox**, and the
O1–O4 offline rules stay reserved for iOS (§6 phase F).

**7.4 — Six answers, not three.** Approve · Revise · Decline · Approve as
Work (only where the row carries `payload.suggested_work`) · Later (a snooze,
which settles nothing) · Skip — as shipped in #165 and documented in
`docs/ops/reply-feedback.md`, which stays the normative account of what each
one does on the wire. `design-system.md` §3.9 is amended to match, including
the batch rule (only Later, Skip and Decline may be applied to many rows) and
the `if_unchanged` staleness envelope.

**7.5 — Yes, a designer is engaged: an AI designer (Claude Design).** Scope:
the design language, the colour and pattern system, consistent UI traits, and
a **new brand identity including a logo and app icon** replacing the current
placeholder "M". A separate brief is being written at
`docs/product/design-brief.md`; it is not written here, and §5's "where a
designer earns their keep" is an input to that brief rather than an answer to
it.

**7.6 — Yes: vault browsing, and especially full-result search, are wanted in
the app.** Sized end to end in **§6.1** — ≈7.5 agent-days total, of which the
cheapest slice that delivers search with full results is ≈3 and needs neither
a named query nor a migration.

### Second ruling — 2026-09-17, after reading the wireframes

The rulings above produced §5's wireframes; reading them, the owner ruled
again the same day. These five change the IA itself, so they are applied
everywhere it is stated: `design-system.md` P6, §3.1, §3.8 and §3.9 carry
dated amendments with the old lines struck, §3.18 and §3.19 are new
components, and `design-brief.md` §3 and its paste-ready prompt are rewritten
to match.

**7.7 — Capture is a floating "+".** Bottom-right on iOS; on the Mac a
toolbar and sidebar-footer "+" plus `⌘N`. It opens a popover or panel holding
the §3.8 capture composer. **No Capture tab and no Capture screen anywhere.**
This hardens §7.1's "a global action" into one drawn control with one
position, which is what the wireframes were missing.

**7.8 — Needs You is a notification pattern, not a section.** A bell
top-right on both iOS and Mac with an unread count; tapping it opens the
request queue as a panel/popover (Mac) or a sheet (iOS), with the six-answer
cards unchanged. It leaves the sidebar and it leaves the tab bar.
**Actionable notifications are the same queue surfaced by the OS**, so there
is one queue with two front doors. The badge is still the only one in the
product (P2) — it moved, it did not multiply.

**7.9 — The iOS tab bar is reduced to five items, maximum.** With Capture and
Needs You gone it is **Chat · Feed · Work · Knowledge · More**, where More
holds Agents, Insights and Settings. **Four plus More, not five plus More:**
the HIG's iPhone bar tops out around five and a sixth becomes a system More
list nobody designed. Work and Knowledge keep their places over Agents and
Insights because they are opened by habit rather than on purpose.

**7.10 — The Mac sidebar is flexible and customizable.** Six fixed rows —
Chat, Feed, **Work ▸**, **Knowledge ▸**, Agents, Insights — with Work and
Knowledge as expandable groups so **Board, Projects, Artifacts and Rooms are
one click from the sidebar**; that expandable group is the answer to the
owner's worry that Work had become too nested. Below them, **Pinned**: an
area the owner fills with a project or board, a knowledge page or search, or
an agent; drag to reorder, unpin from the context menu. §3.4 has the SwiftUI
shape (`NavigationSplitView` sidebar, `List` sections, `DisclosureGroup`,
pins persisted per instance in app preferences) and the table of what
persists where.

**7.11 — System splits into Settings and Insights.** Status, compute
(providers · models · assignments · budgets), and devices and instances
become **Settings** panes — **compute configuration lives in Settings** —
grouped so the pane count grows by three and not by four (today's *Services*
rows are doctor rows, so they fold into **Status**). **Setup** stops being a
destination and becomes an app-menu item: Metistry → "Set up…" / "Run setup
again". What is left of System — cost data, spend over time, run metrics,
shadow agreement, token and latency trends — becomes a section named
**Insights**. The name is proposed here and is the owner's to rename; nothing
but labels and this paragraph depends on it. The Mac sidebar therefore ends
as **Chat · Feed · Work ▸ · Knowledge ▸ · Agents · Insights · Pinned**, and
**Settings is not in it**: macOS puts settings in the app menu under `⌘,` and
a sidebar row would be a second door to the same window, which is the kind of
duplication P6 exists to prevent.

### The questions as they were put

Each is answered by the ruling of the same number above.

1. **Does the seven-section IA replace P6's ten destinations?** If yes,
   `design-system.md` P6 and §3.1 are amended (seven names, Capture as a
   global action, Knowledge added, Board/Rooms/Projects folded into Work), and
   the PWA's nav changes in the same PR. If no, Knowledge and Compute still
   need homes in the ten and the PWA still has one too many.
2. **Which rendering — (a), (b) or (c)?** §4. The 2026-09-07 ruling says (a);
   the PWA's existence and the maintenance-by-one-person argument are what
   would justify revisiting it. Deciding for (a) or (c) also means deciding
   whether the `WKWebView` WebAuthn question is worth a spike at all.
3. **Is the Mac app a client of *this* machine, or of any instance?**
   Loopback + `METISTRY_LOCAL_OWNER_TOKEN` is authenticated today and needs no
   ceremony; a Mac reading a second instance over a tailnet needs a device
   session, and native passkeys are blocked without a provisioned build
   (`docs/ops/mac-app.md`, "Open"). This decides whether the app needs an
   instance switcher and an outbox at all.
4. **Do requests have three answers or five?** §3.9 says three; the PWA ships
   Later and Skip. Whichever is right, the design system and the client must
   say the same thing before the native card is built.
5. **Is a designer engaged for the Work-section density and the icon set**, or
   does the build proceed on the design system alone and accept that those two
   will look like a developer drew them?
6. **Does knowledge get a client read path, or stay Obsidian-and-git only?**
   Phase E is the largest server ask in this plan, and "the vault is edited in
   Obsidian, the app only captures into it" is a legitimate answer that would
   delete it.

---

### Contradictions logged rather than routed around

Per `CLAUDE.md` ("report contradictions, don't route around them"), and none of
these were edited in place:

- **P6's ten destinations** vs the PWA's eleven vs this plan's seven (Q1) —
  **settled 2026-09-17 (7.1): seven**, then **six the same day (7.7–7.11)**,
  once Needs You and Capture became controls rather than places and System
  split. The PWA is the one remaining disagreement, and it is deliberate
  until it renavigates.
- **P2's "Needs You must never be a tab inside something else"** vs 7.8,
  which takes it out of the navigation altogether. These agree in substance —
  the rule was written against *burying* the queue, and a bell with a count
  on every screen is less buried than a row you scroll past — but the
  sentence had to be amended rather than reinterpreted, and it is, in
  `design-system.md` §3.1 and §3.18.
- **`docs/ops/mac-app.md` still says the wizard is "re-enterable from
  Settings → Instance → Set up again"** (`mac-app.md:32`), which 7.11 moves to
  the app menu, and `apps/console/web` still ships the Capture and Needs You
  views as destinations. Noticed while applying 7.7–7.11; neither is edited
  here — the ops doc follows the build, and the PWA renavigates in its own
  PR (7.1).
- **P6's "nothing on one platform with no home on the others"** vs compute
  being Mac-only and knowledge being nowhere.
- **§3.9's three answers** vs the shipped six (Q4) — **settled (7.4): six**,
  and `design-system.md` §3.9 now says so. `glossary.md` still reads "the
  same three answers" and lists seven request types where §3.9 listed six;
  the type count is fixed in §3.9, the answer count in the glossary is
  noticed and not edited here.
- **`ux-direction.md`'s 2026-09-07 "same SwiftUI codebase as the phone"** vs
  the option (b)/(c) tradeoffs this plan is obliged to lay out (Q2) —
  **settled (7.2): the 2026-09-07 ruling stands**, and (b) is rejected for
  application surfaces.
- **`desktop-app-plan.md`'s "not doing: an Electron/Tauri wrapper"** — it did
  not settle the `WKWebView` question; 7.2 does, at the document boundary.
- **`targets/` is not in the reconciler's protected-path list** while
  `agents/`, `routines/`, `queries/` and `extensions/` are, even though a
  target manifest names where work may be sent off the machine. Noticed while
  building §2's human-only column; out of scope here.
