# App UX plan — designing the interface across Mac, iOS and the PWA (2026-09-16)

> Status: **a plan for the design work, not the design.** It inventories what
> is on screen today, names the objects the interface has to expose, proposes
> one information architecture in three renderings, and lays out the one
> technical decision that has to be made before a second screen is built.
> Nothing here is a ruling; §7 is what needs one.
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
| §3.9 request card | built, but with **five** answers (Approve · Revise · Decline · Later · Skip), where §3.9 says three | `index.html:131–141` |
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

### 3.1 Seven sections, not ten destinations

P6 fixes ten flat destinations; the PWA shipped eleven in a different order
(§1.4); this plan proposes **seven**, with Capture demoted to a global action
and Knowledge promoted to a section. **This contradicts P6 and needs the
owner's ruling before any screen is drawn** — it is open question 1, and
§7 says what the amendment would be.

| Section | Contains | Why it is one section |
| --- | --- | --- |
| **Chat** | the conversation, tier picker, tapbacks | P8/P9 give it its own rules; it is the most-touched surface |
| **Feed** | activity, filters, run detail | the desktop plan's centrepiece; "what happened" is one question |
| **Needs You** | requests, grouped by type | P2's only badge. It must never be a tab inside something else |
| **Work** | Board · Tasks · Artifacts · Rooms · Projects | four views of **one** object graph: a task has a room, produces an artifact, belongs to a project. Four tabs made the reader do that join |
| **Knowledge** | Pages · Search · Inbox · Links | the product's first noun, currently homeless |
| **Agents** | agents, presence, scope/autonomy, crews, targets | one question: who may do what, and what are they doing |
| **System** | Status · Compute · Spend · Devices · Instances · Setup | "the instance as a machine" — today's Settings, Dashboard, Status and Devices are all this |

**Capture stops being a destination.** A tab you navigate to contradicts its
own five-second promise. It becomes: `⌘N`/global hotkey and a drop target on
Mac, the share extension and a medium-detent sheet on iOS, the composer's `+`
and a sheet in the PWA — with the *list* of captures living in Knowledge →
Inbox. (Also a P6 contradiction: Capture is one of the ten.)

### 3.2 Screens, and the components each uses

| Section | Screen | Components (`design-system.md` §3) | Data |
| --- | --- | --- | --- |
| Chat | Conversation | 3.4 message + collapsed tools, 3.5 prompt card, 3.6 composer menu + palette, **3.7 tier picker (unbuilt)**, §4 reply tokens, 3.14 notifications | `/api/messages`, `POST /message` |
| Feed | Activity | 3.2 feed row, 3.3 presence chip, 3.15 empty, 3.16 errors | `/api/q/activity_feed` |
| Feed | Run detail | 3.4 tool disclosure, 3.16 | `runs` (needs a query — §6) |
| Needs You | Queue | 3.9 request card, 3.5, 3.17, 3.14 | `/api/proposals`, `…/batch` |
| Work | Board | 3.10 task card + drag-to-dispatch (+ keyboard equivalent), 3.12 mode chip | `/api/q/board`, `/api/tasks/*` |
| Work | Task detail | 3.10, room thread (3.11's comment threads), 3.16 | `/api/q/board`, rooms |
| Work | Artifact | 3.11 viewer (sandboxed HTML band), 3.17 on review dispatch | `/api/artifacts` |
| Work | Project | 3.12 header + mode toggle, 3.3, 3.17 | `projects_rollup`, `PUT /api/projects/:id` |
| Knowledge | Pages / Inbox | 3.2-shaped rows, 3.8 capture composer, 3.15 (empty vs absent) | **new** (§6 phase E) |
| Knowledge | Page | 3.11's markdown renderer at `reading-measure`, links/backlinks | **new** |
| Knowledge | Search | 3.6-style suggest, 3.16 (degraded = keyword only, P5) | **new** |
| Agents | Agents | 3.3 presence chip, 3.10 drop target, 3.17 (rotate/revoke/widen) | `/api/agents`, `agent_presence` |
| Agents | Agent detail | scope/tier/autonomy controls, 3.17, 3.4 for its runs | `PUT /api/agents/:id/*` |
| Agents | Crews / Targets | 3.13-shaped rows, read-only + dispatch | manifests, `/api/targets` |
| System | Status | 3.13 doctor row (**built, Mac + PWA**) | `doctor`, `/api/status` |
| System | Compute | 3.13 rows + 3.17, tier assignment | `metistry compute` (**no API — §6**) |
| System | Spend | tiles, 3.15 absent copy | `spend`, `aws_costs_*`, `claude_usage_daily` |
| System | Devices / Instances | 3.13 rows, 3.17 revoke, presence chip for reachability | `/api/devices`, `/api/instances` |
| System | Setup | wizard (Mac), enrolment code (PWA/iOS) | CLI verbs |

### 3.3 Same on all three, and platform-specific (P7)

**Identical** (same rows, same order, same words, same refusal text): Feed,
Needs You, Work in all four screens, Knowledge, Agents, Chat's transcript,
Status, Spend, Devices. These are renderings of the same API response and must
never disagree.

**Layout differs, architecture does not:** three columns (nav · list · detail)
on Mac and wide PWA; one column with push navigation on iPhone and narrow PWA
— which is what §5's wireframes already show.

**Mac only:** menu-bar item, the Settings scene, the first-run wizard, log
windows, Keychain and secrets, TCC bridge permissions, Sparkle updates, login
item, global capture hotkey, drag-drop capture, "reveal in Finder", terminal
hand-off. All of it is *installing and operating*, and none of it is data.

**iOS only:** share extension + offline outbox, APNs categories, widgets and
Live Activities, App Intents/Siri, HealthKit, on-device classification, the
per-instance switcher with the honest presence chip (O1/O2).

**PWA only:** install prompt, web push, the enrolment-code wall.

---

## 4. The central technical decision (not decided here)

How do the **data** views reach the Mac? Three shapes.

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

**Review gates.** (1) IA gate — §7's questions answered before any wireframe.
(2) Wireframe gate — the owner reads the SVG and the spec together; a screen
whose spec cannot name its data source does not pass. (3) Build gate — the
component exists in `preview.html` before it is used in a screen. (4) Ship
gate — CI green, including the token check, and a product-record fragment.

**Where a human designer earns their keep** (`ux-direction.md` already assumes
one): the Work section's list/detail density and the board card; reply
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
| **0** | IA ruling + the four CI checks + the token holes (§5) | **S** | — |
| **A** | **Shell + navigation + Feed.** Seven sections in the sidebar; an authenticated API client and store in `MetistryKit` (local owner token over loopback); §3.2 feed row, §3.3 presence chip, §3.15/§3.16 as shared Swift components. PWA renav to the same IA in the same PR | **M** | none — `/api/q/activity_feed` exists |
| **B** | **Needs You + Chat.** Request cards with the three (five) answers, §3.5 prompt cards, local notifications with actions; the transcript under P9; §3.7 tier picker, built once for both clients | **M** | a `rules.yaml` **commands endpoint** (the PWA's `COMMANDS` array is a labelled placeholder, `index.html:93–103`, `app.js:198`); a `runs` detail query for the feed's drill-down |
| **C** | **Work.** Board + task detail + artifact + project in one list/detail pane, drags with keyboard equivalents, rooms | **L** | none for reads; `PATCH /api/tasks/:id`, `/dispatch`, `PUT /api/projects/:id` exist |
| **D** | **Agents + Compute + System.** Presence, scope/autonomy with §3.17 on every widening, then Compute and Devices/Instances | **M** | **`/api/compute`** (list providers/models, assign, budgets) — otherwise compute stays Mac-only and P6 stays violated |
| **E** | **Knowledge.** Pages, page view, search, Inbox | **L** | **the biggest ask**: a named query over `knowledge_files`/`knowledge_links` (no schema change for paths and the link graph; an *additive* title/description column the reconciler fills if rows need to be readable without fetching content), plus a console route proxying the reconciler's `/vault/read` and `/vault/search` — page content is not derived state, so invariant 3 sends it through the bridge, not a query |
| **F** | **iOS target.** Share extension + outbox, APNs relay, widgets, App Intents | **L** | O1–O5 are shipped (`docs/ops/console-api.md`); the relay is its own project |

Phase A is the one that changes the owner's daily experience, because it turns
the window from a status page into a place where something happened.

---

## 7. Open questions

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

- **P6's ten destinations** vs the PWA's eleven vs this plan's seven (Q1).
- **P6's "nothing on one platform with no home on the others"** vs compute
  being Mac-only and knowledge being nowhere.
- **§3.9's three answers** vs the shipped five (Q4).
- **`ux-direction.md`'s 2026-09-07 "same SwiftUI codebase as the phone"** vs
  the option (b)/(c) tradeoffs this plan is obliged to lay out (Q2).
- **`desktop-app-plan.md`'s "not doing: an Electron/Tauri wrapper"** — it does
  not settle the `WKWebView` question, but it is the nearest ruling to it.
- **`targets/` is not in the reconciler's protected-path list** while
  `agents/`, `routines/`, `queries/` and `extensions/` are, even though a
  target manifest names where work may be sent off the machine. Noticed while
  building §2's human-only column; out of scope here.
