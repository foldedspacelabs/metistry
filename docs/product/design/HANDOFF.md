# Design engagement — handoff

**You are the designer for Metistry.** This file is everything a new session
needs. Read it, then **`design-system-amendments.md`** — the rules rounds C–E
established, as rules rather than as findings, and the shortest path into how this
product is drawn. Then `review-00-plan.md`'s ratified section and the screen spec
for whatever you are about to touch. Do not read the whole `docs/product/design/`
tree up front — it is large, and the specs are written to be read one at a time.

Branch: `design/round-0-plan-review`, merged onto v0.11.0.
Tokens: **2.6.2**, 144 declared contrast pairs green, plus 56 undeclared pairs
checked by hand in round E. The thinnest margin in the system is
`text-tertiary` on `sunken` at **4.53:1** light — it passes, it is used for every
section label and band header, and it will fail the moment either token moves.

## 0. Where the drawings are

**The canvas — every artboard:**
<https://claude.ai/artifact/Ld6h7R8CVer4TncfNeLXNb> — *Metistry — design canvas*,
a Design-type artifact. Read it with the Artifact tool (`action: "read"`, and
`scope: "files"` on it to list the boards); do not web-fetch it. **Laid out
2026-09-24 in labelled rows, top to bottom:**

| Row | Boards |
| --- | --- |
| **Mac — the day** | `Today-Hub` (**Today v7**, screen 5 §15), `Chat`, `NeedsYou` (v3 cards), **`NeedsYou-v4`** (the request pattern, questions, pull requests, the hub — screen 3 §12), **`NeedsYou-v5`** (where it lives: a conditional sidebar row and a full view; questions stepped — §13), `Activity`, `CaptureBar`, `Capture` (its window still has the old sidebar) |
| **Mac — Work** | `Board`, `CardDetail`, `Projects`, `Artifacts` (screen 16; a task's room, no Rooms list) |
| **Mac — Knowledge, Agents, Scheduled** | `Knowledge`, `Agents`, `Scheduled`, `RunDetail` |
| **Mac — Settings and Usage** | `Settings`, `Connections`, `Secrets`, `Usage` |
| **PWA — phone and narrow window** | `PWA-Shell`, `PWA-Today`, `PWA-NeedsYou`, `PWA-Work`, `PWA-More` (screen 18, new 2026-09-24) |
| **The system** | `States`, `Request`, `Facets`, `Voice` |
| **Brand** | `Direction-C` (chosen), `Wordmark`, `Icon-App`, `Icon-Web`, `Colour`, `Kit` |
| **The Obsidian plugin** | `Plugin` |
| **Archive — superseded** | `Main` and `Direction-B` (brand directions not taken), `Theme` (round-B nav), `Today` (the v5 vocabulary; v7 supersedes it), `Item-Model` |

A new board goes in its section's row, 80px after the last one; a row's title is
a `title1` note 300px above it. Rows are 420px apart below the tallest board.

`Facets`, `Plugin`, `Voice` and `Item-Model` are **not yet modules** in
`boards/` — they were built from earlier snapshots of the library. Every *screen*
board is now a module. Port each the
next time it changes. Everything else is a module: round E ported `States`,
`Request`, `Chat`, `Activity` and `NeedsYou`, and added `Agents`.

**The assembly of a board is not recoverable from lib.py.** The generator landed
in one commit holding only `lib.py`, `today.py` and `board.py`; the five round-C
and round-D boards had their *components* in `lib.py` and their page assembly
nowhere — not on disk, not in git history. Round E re-derived three of them from
the published `.dc.html` on the canvas (read it with the Artifact tool, then
grep the section labels out locally). Do the same for `Chat` and `Request`
rather than re-imagining them: their decisions are committed in their specs, and
the labels are the index to which decision sits where.

**The round-00 review, as a page:**
<https://claude.ai/artifact/LiSuLrq2PQjfds8DM3Tp4Z> — the same content as
`review-00-plan.md`, which is the version to edit.

Three other Design-System artifacts exist on this account (*Folded Space Labs*,
*Drey*, *Matt Colf*). **None of them governs Metistry** — Metistry's system is
`tokens.json` plus the specs in this directory.

---

## 1. The terms of the engagement

The owner's brief is `docs/product/design-brief.md`. What it asks for, still
binding:

- **Apple HIG and native controls on Mac**; keyboard-first; **no third-party
  font is ever loaded** (P7, stated in four places); no marketing site; the PWA
  is not an app in a web view.
- **Agent-written text is data and never looks like a control** (P1).
- **Silence is the default** so the surface stays calm (P2). **Needs You is the
  product's only badge.**
- **Refusals are explained inline where they happen.**
- **State is reported, never inferred** (P5).
- **The transcript never moves under the reader** (P9).
- Output is Markdown + SVG/HTML under `docs/product/design/`, tokens as JSON,
  reference repo files by path when disagreeing, and **log contradictions rather
  than routing around them**.
- Work in the worktree, commit there, never to `main`. The owner pushes and
  merges; there are no git credentials in this environment.
- **Designing ahead of the surface is allowed** (ruled 2026-09-20). A screen may
  be drawn against wire that does not exist yet; the developer adapts afterwards.
  This does not relax the naming: every gap still gets logged as a contradiction
  or a numbered request, because that list is what the developer works from. What
  it replaces is the older rule that an unsourced screen does not pass.

**Public-text rule:** never refer to the owner's employment. Say *second
instance*.

## 2. Which documents win

**`design-system-amendments.md` is newer than `design-system.md`** and says so at
the top. It holds what rounds C–E established: the colour channels and the four
ways colour has gone wrong, the states, permissions and provenance, the language
rules, and the structural rulings. `review-00-plan.md` remains the log — searched,
not read; the amendments file is the one to read.

`design-brief.md`, `design-system.md`, `app-ux-plan.md` and `ux-direction.md`
were **not updated for v0.11.0** and still describe a six-section sidebar.
`design-system.md` now carries a banner listing every superseded passage, and a
note at each. **The winning sources, newest first: the ratified rows of
`review-00-plan.md` (C-numbers), `design-system-amendments.md`, the screen
specs, then `glossary.md`** (updated 2026-09-23). `daily-flow-spec.md` and
`PRODUCT.md` still govern behaviour and data; where they describe navigation or
naming they are older than the rulings (daily-flow §10 is marked). When sources
disagree, the newer wins and the disagreement gets logged.

## 3. What is ratified — do not re-litigate

**Motion** (C16, ruled 2026-09-22). Motion only where it carries information the
reader cannot otherwise get, stopping the moment that information is in words.
Two loops, a closed list (C75): the chat's three waiting dots and the recording breath.

**The floating bar** (ruled 2026-09-22). A second, additive interface: always
present while the capture bridge is installed, minimal at rest, louder while a
session runs, on a screen edge the owner picks (never top or bottom), and **its
chat is the same conversation as the window's**. Glass is allowed here and
nowhere else, and **the floor follows the ink**: 0.86 under text, 0.75 under marks,
and `text-tertiary` not at all (C70, C74). The recording breath is the product's
**second and last** animation (C75). The rail is a **toolbar — Ask · Note · To-do ·
Record, one click each**. Record is a target (Screen · Window · Audio only) and
**two toggles, audio and microphone, both on by default** (C76). Jots take the
session's timestamp (C77).

**Agent prose in a transcript** (C69, ruled 2026-09-22). A 2px `agent` rule in
the gutter, no wash; `agent-quiet` still governs agent text outside a
transcript. `screen-01-chat.md` §2.1 is closed.

**Navigation.** **Eight** rows as of 2026-09-22 — see C57. Resources was briefly
a ninth and moved to Settings, so the standing rule is: **a third break should
move something out rather than add a row.** **Today · Chat · Activity ·
Work ▸ · Knowledge ▸ · Agents · Routines**, then **Pinned**. Routines went
top-level for C30's own reason — it is not a kind of agent, and a child row
would bury a daily question (C50). Today is first and top-level (C30) — it holds
meetings, artifacts, requests and agent status, none of which Work owns. Work's
children are Board · Projects · Artifacts · Rooms.

**Metis is not on Agents** (C52). It is unscoped because it *is* the user — it
holds their reach and delegates narrower work. **Agents is what Metis delegates
to, and what connects in; everything on it is scoped because none of it is you.**
That sentence is why permissions live there and nowhere else.

**An agent is a capability; a routine is an assignment.** The agent's definition
(`agents/<area>/<id>.md`, the user's hand only — Metis may never write it) says
*how it behaves*; the routine's task prompt says *what to do this occasion* and is
**appended**, never a replacement. Reach layers the same way: base on the agent,
plus what a routine grants for one task.

**Permissions are one table, everywhere they appear** — a local agent, a connected
agent, a routine. **One line per resource**, Read and Write as columns, and
**anything not listed is not granted** (C58): there is no Allow/Never control, one
glyph marks a verb that asks first, and Edit sits on the section. Underneath they
are still verbs on models, which is why Work and Artifacts both list Comment
(C53). A proxied MCP server is one more resource row, marked *Through Metistry*;
the server itself is defined on **Resources** (C56, `screen-09-resources.md`).

**Access always shows its provenance** — base configuration (unmarked), approved
in Needs You (*#311*), or granted by a routine (*during \<routine\> only*). A
routine-granted permission is the most forgettable access in the system, and the
marker is the only thing standing between the owner and it.

**A routine's schedule is not when it acts.** `plan-tomorrow` is `@hourly` and
acts once an evening. Rows say when it *acts*, in words; the tick is mechanism,
shown in detail. *Nothing to do* is a first-class outcome, because four of the
five shipped routines are deliberately silent.

**The three colour channels, and they never borrow from each other:**

| Channel | Carries | Vocabulary |
| --- | --- | --- |
| Hue | *what kind of thing* a chip points at | `entity-person` · `entity-note` · `entity-project` · `agent` · neutral |
| Weight/fill | *how much it matters* | priority, and nothing else |
| Tint | *something is wrong* | `degraded` · `failed` · `stale` · `ok` |

**Priority** is one badge with four steps: P1 filled (`text-primary` on `bg`),
P2–P4 outlined in `border-control` with the ink stepping down. **Never red** —
it collides with `failed`, and in a personal system everything becomes P1 within
a month.

**Facet order, everywhere a task is drawn:** priority · due · estimate · people
· links · state. `trow3()` in `boards/lib.py` enforces it.

**Due and estimate** are glyph-prefixed values, not pills. Overdue escalates
into the tinted chip.

**Capitalisation:** an attribute name is Title Case; **a value is verbatim,
always** — it is usually something the owner or an agent wrote, and P1 says data
is not case-corrected.

**The spark** is Metis's mark, always in `agent` purple, even inside a
secondary or ghost button. On a button: *Metis can do this*. On content: *Metis
wrote this*. It appears only where the offer is real.

**Agent prose** is one component everywhere — spark, `ASSISTANT`, timestamp,
👍/👎, serif body, `agent-quiet` ground. The serif stack is
`Charter, Sitka, "Sitka Text", Constantia, Georgia, serif`. **Not `ui-serif`** —
it is a generic family that falls through to Times in a browser, which is what
made the prose read as unformatted (C35). Native apps get New York free via
SwiftUI's `.serif`.

**The four states** are empty · absent · failed · stale, and a fifth shape —
**partial** — is proposed for a row whose data parsed with one bad token (C28).

**Times are 12-hour with AM/PM.**

## 4. What is drawn

| Screen | Spec | State |
| --- | --- | --- |
| Chat | `screen-01-chat.md` | done — waiting states, preview pane, model picker |
| Activity | `screen-02-activity.md` | done — **routines and the eighth chip §12** |
| Needs You | `screen-03-needs-you.md` | done — bell, panel, full list, **`access_request` §9** |
| Capture | `screen-04-capture.md` | done |
| Today | `screen-05-today.md` | done, v6 — the spine, the day bar, calendar help |
| Board | `screen-06-board.md` | done — five columns |
| Agents | `screen-07-agents.md` | **rewritten 2026-09-21** — roster, a local agent, a connected agent |
| Scheduled | `screen-08-routines.md` | v3 — routines and syncs (§11) |
| Settings ▸ Connections | `screen-09-resources.md` | v2 — typed connections, the proxy (§10) |
| Settings ▸ Secrets, Variables | `screen-19-secrets-variables.md` | new |
| Knowledge | `screen-10-knowledge.md` | **rebuilt 2026-09-22** — digest-led; sources folded to one line |
| Usage | `screen-17-usage.md` | **new 2026-09-23** — the gauge's popover, three budget states |
| Artifacts & Rooms | `screen-16-artifacts-and-rooms.md` | **new 2026-09-23** — list, artifact, compare, rooms, a room |
| Settings | `screen-15-settings.md` | **new 2026-09-23** — sidebar, grouped, fixed 840 × 600 |
| Card detail | `screen-14-card-detail.md` | **new 2026-09-22** — one popover, work row and markdown task |
| Projects | `screen-13-projects.md` | **new 2026-09-22** — list, a project, over budget, confirmations |
| Run detail | `screen-12-run-detail.md` | **new 2026-09-22** — the session, the run, what Metis took from it |
| The floating bar | `screen-11-capture-bar.md` | **new 2026-09-22, third pass** — one-click toolbar, record sheet, Settings |
| Facets & colour | `facets-and-colour.md` | the system itself |
| Build-side preview | `dev-preview-round-e.md` | **draft 2026-09-22** — what the developer needs, in one file; keep it current as rounds land |

**Review 01 (2026-09-23): read `review-01-holistic.md` before drawing anything.** A
holistic pass over all 24 boards and 28 documents. **All eleven rulings are made
(C88–C98)** and written as rules in `design-system-amendments.md` §8; **the §2
cleanup is done** (status in review 01 §8); **every §5 opportunity was adopted**;
**the iPhone and PWA designs are deferred** by the owner.

**Done 2026-09-24:** **Today v7** (screen 5 §15 — Morning Brief, Next Up, Close
the Day, ticking tasks, Slipping) and **the PWA** (screen 18 — phone and narrow
window, the offline rule per verb, install, enrollment, notifications, and
Compute ▸ Budgets drawn first). The owner reopened the PWA as a release feature;
the native iPhone app stays deferred.

**Needs You v4 is drawn (2026-09-25, screen 3 §12, board `NeedsYou-v4`):** one
request pattern (header · ask · context · body · answers) with a closed set of
bodies; **questions** with several multiple-choice answers, context and free text;
**pull requests** reviewed and answered in Metistry, posted to GitHub as the
owner; the C96 events and the meeting-at-Stop as instances. **Needs You is the hub for everything that needs the owner** — Metis, agents, and sources the collectors read (§12.7, C108): source requests mirror the source and clear themselves. Twelve request types. **v5 (same day, board `NeedsYou-v5`, §13, C109):** Needs You opens a full list-and-detail view instead of the 400px panel, reached from **a sidebar row above Today that exists only while something is waiting** (C110; the Mac toolbar bell is gone); questions step one at a time.

**Routines v2 (2026-09-25, board `Routines-v2`, screen 8 §10, C111/C112):** Standup is its own routine and the brief presents it; every scheduled thing is shown and editable — routines (defaults tagged, Reset to Default) and a **Sources** tab for the collectors with cadence and Needs You rules. A run opens to its steps; Metis's suggestions arrive as improvement requests.

**Connections, Secrets, Variables (2026-09-25, C113–C117):** the sidebar row is **Scheduled** (Routines · Syncs). Resources, targets and sources are one noun, **Connection**, typed MCP · Agent · API · Feed · Files, any of which can be offered to agents through Metistry's MCP proxy. **Secrets** (Keychain, per instance, `{{ secret.name }}`, never seen by a model) and **Variables** (`{{ variable.name }}`, usable in instructions) are Settings panes. Boards `Scheduled`, `Connections`, `Secrets`; `Routines-v2` and `Resources` archived. **C118:** known services ask for named fields; custom connections are configured by how they are reached — HTTP (URL, parameters, auth, headers), Command (arguments, environment) or Path — with a masked preview of what is sent.

**Keyboard and VoiceOver (2026-09-25, C119–C122, boards `Keyboard`, `VoiceOver`, `components-02-keyboard-voiceover.md`):** Mac only; every shortcut a menu item (Go ⌘0–⌘7, Capture, Item); shortcuts in any app off by default with conflict checks, Start and Stop Recording separate; a Spoken table and rules for VoiceOver; Reduce Motion and largest text.

**Settings panes (2026-09-25, C123–C127, board `Settings-Panes`, screen 15 §5):** Instance names the assistant and lists linked instances; Services leads with Doctor and has per-service controls; Compute is one column — Metis, Providers (switch, tags, credential), Your Models (memory and disk, on this Mac and from the cloud, one search grouped by model with a line per place), Spending limits — and agents pick a model then where it runs (C128, C130, C131); Keep Awake has two sub-switches (C129); Updates updates and rolls back the runtime; Keyboard is one switch; Advanced holds the runtime source.

**Next round, in order:** (1)
**States for screens 10–17** and the §3.3 flows, including the Mac's Compute
pane from the PWA's. Ruled 2026-09-25: C99 (no confirm on a tick); C101/C102 (Close the Day updates
the daily note's Metistry section, dates each deferred line and writes
tomorrow's plan — no close file; owed items are tasks); C103 (prose allowed
outside a fold).

**Sample data comes from `boards/fixture.py`** (amendments §8.4). Put a number
there before drawing it on a second board.

**Not drawn:** the Obsidian plugin's remaining surfaces.

**Run detail is drawn (screen 12, 2026-09-22).** What follows was the state before it: `seed/queries/run_detail.yaml`
and `GET /api/runs/:id` both exist (commit `3456aab`) — the handoff was stale on
this. The query is *richer* than `screen-02-activity.md` §7 asked for: provider,
cache read/write tokens, an exact tool-call join on `meta.turn_id` /
`meta.message_id` (never a time window), and shadow-mode columns — candidate
provider and model, a deterministic agreement score, the shadow's cost. §7's two
open questions stand: whether `meta` is safe to render verbatim (it is
agent-written, so P1 says it is data), and whether a run's *input* is
recoverable at all — today it is not, so Run detail can show what a run cost and
not what it was asked.

## 5. Debts, in priority order

**Back-patch pass — round E did most of it.** Both pieces of real design work
are drawn: the `access_request` card (`screen-03-needs-you.md` §9, board
`NeedsYou`) and the routine row with its eighth chip
(`screen-02-activity.md` §12, board `Activity`). `States` was ported unchanged.

**The back-patch is complete.** `Chat` and `Request` were ported in round E
along with `States`, `Activity`, `NeedsYou` and the new `Agents`. Every board on
the canvas is now generated from a module in `boards/` except `Facets`, `Plugin`,
`Voice` and `Item-Model`. `bellpanel()` is gone — it drew the *"1 snoozed"*
header C21 killed; `panel2()` is the panel.

**131 contradictions** are logged in `review-00-plan.md`. C38, C51 and C62 are closed. C40–C87 are
round E's; C88–C98 are review 01's rulings. Two of them are rules the system is missing rather than faults in a
file: **C45** (a failed consequential operation leaves the request pending) and
**C49** (a mark that carries meaning takes an ink token, never a border token —
`border-strong` fails 3:1 against every ground). **C67** is a process fault
worth reading before you draw: seven of twelve boards overflowed their declared
frame, so **measure the frame, never estimate it** — the recipe is in
`design-system-amendments.md` §6. The ones
that block drawing:
- **C37** — `blocked_by_task` / `blocked_by_task_open` are specified in
  `daily-flow-spec.md` §3 and absent from `board.yaml`. Two screens draw the
  string they would carry.
- **C19** — `activity_feed` never returns `ok`, so the failed-glyph state §3.2
  specifies cannot be drawn from the data.
- **C23** — §3.8 specifies a capture receipt the endpoint cannot produce, and
  its own *Never* forbids waiting for it.

**Two request lists for the developer**, both in `today-hub-requests.md`:
A1–A9 (calendar fields, the meeting-note route, prose budget, suggestions,
capacity semantics) and B1–B11 (the artifact `for` binding, freshness,
recurrence, where a revised day is stored, feedback ids, plugin theming, travel,
calendar tiers). **A1** (events return only title/start/end) and **A2**
(Metistry may not write the meeting note) block the most. **A5** and **B4** need
a ruling from the owner, not a ticket.

**Open rulings the owner owes:** none outstanding from review 01 or the Today
requests (A5 → C103, B4 → C101 on 2026-09-25; C16 on 2026-09-22).

**Requests from screen 7** (`screen-07-agents.md` §12): **C1** a
`collector_health` query, without which `stale` is undrawable anywhere; **C2**
`effectiveActions` returning its reason per cell; **C3** a per-agent spend cap or
a ruling that spend on that screen is context-free; **C4** whether the
escalation ceiling should write a row at all.

## 6. How to work

**The canvas generator is on disk** — `docs/product/design/boards/`. Read its
README. Edit `lib.py` or a board module; **never paste a generator into the
conversation**, which is what made the first pass expensive.

```
METISTRY_CANVAS=<canvas dir> python3 build.py [board]
```

**The border tokens, settled by measurement (C49).** `border-control` is the
only one that clears 3:1 — it does so against all four grounds in both themes
(3.00–3.91:1). `border` clears 1.12–1.51:1 and `border-strong` 1.60–2.08:1, so
**neither may outline a control or carry a mark**, whatever `border-strong`'s
name suggests. A mark that carries meaning takes an ink token. Four faults in
this engagement came from ignoring that; two were in round E.

**Two marks are distinguished by weight, not by two inks.** The agent hue and the
neutral ink separate at 14.3 ΔE in dark mode — under the hard floor of 15, so
indistinguishable even with full colour vision (C54). The presence dots, the
permission pips and the schedule grid all use filled-versus-outlined for this
reason. `dataviz/scripts/validate_palette.js` is what catches it; run it on any
new pair of marks.

**Before publishing anything, check contrast** on every new colour pair against
*the ground it actually sits on*. Almost every fault found in this engagement
was a token used against a ground it was never computed against — `text-tertiary`
on a tint, `border-strong` as a control outline, `chart-5` on `sunken`, two dark
chart steps 1.25:1 apart. `node ops/scripts/build-design-tokens.mjs --check`
covers the declared pairs; the undeclared ones are on you.

**Traps that have already cost a round each:**
- `device_commit_files` **refuses any path under `.claude/`** — the worktree is
  there. Commit to a staging folder in the repo root and `mv` it into place.
- Git in the connected folder could not delete its own lock files until deletion
  was granted; it is granted now for this repo.
- A quoted family name inside a double-quoted inline `style` attribute
  terminates it early and silently drops the `color` after it. 123 attributes
  broke this way. Use `MONO` / `SERIF` from `lib.py`.
- Chrome on macOS does not expose New York to CSS, so a board preview is not a
  fair test of an Apple-only face.

**Keep it cheap.** Batch build + verify + publish + commit into one turn. Read
targeted line ranges, not whole files. The fixed cost of a turn is ~56k tokens,
so fewer, larger turns is the main lever.
