# Design review 00 — the plan, before anything is drawn (2026-09-18)

> **What this is.** The written review `design-brief.md` §8 asks for before the
> first mark: an honest read of the IA, the tokens, the states and the
> principles, the contradictions I found, and the questions I need answered.
> **Nothing is designed here and nothing in the repo is edited** — per
> `CLAUDE.md`, contradictions are logged rather than routed around.
>
> **What I read.** `design-brief.md`, `design-system.md`, `app-ux-plan.md`,
> `ux-direction.md`, `glossary.md`, `docs/product/design/tokens.json` and the
> seventeen wireframes, `docs/ops/board.md`, and the shipping code:
> `apps/macos/sources/{app,kit}` (42 files, 9,886 lines),
> `apps/console/web` (8 files, 3,437 lines), `ops/release/make-app-icon.mjs`
> and `ops/release/build-app.sh`.
>
> **Every claim below names a file, and where I could compute a number I did.**
> Where I disagree with the repo I say so and cite it; where the repo
> disagrees with itself I log it in §7 and change nothing.

---

## 0. The read, in a paragraph

The IA is better than the product it describes, and that is the problem to
manage rather than a fault to fix. Six sections, two global controls and a
Pinned area is a good map — I would ship it — but **three of the six sections
cannot name a data source today**, and the two hardest visual problems in the
brief (the request card, the board) both live in containers the brief has
already sized down: a popover and a six-column grid. Meanwhile the parts that
*are* settled and CI-enforced — the token pipeline, the contrast harness, the
status row — are settled around the wrong grounds in at least one place that
ships failing colour today (§3.4). My recommendation is a small reordering, not
a re-plan: **design Insights before Knowledge** because Insights has five named
queries shipped and Knowledge has no route at all, and **treat the Needs You
panel, not the board, as the hardest layout in the product**. The brand is
unblocked and I can start it the moment §8 is answered.

---

## 1. Where the six-section IA fights the content

### 1.1 Three of the six section names are not the ratified vocabulary

`glossary.md` ratifies eight nouns and says plainly: "The system is assembled
out of collectors, routines, bridges, services, modules, targets, named
queries, reconcilers, folds, principals, grants, runs and crews. Those are
builder words … If one of them reaches a screen, a notification or a brief,
that is a bug."

Against the eight nouns, the six sections land like this:

| Section | The glossary noun it shows | Verdict |
| --- | --- | --- |
| Chat | — (the assistant; "chat" is a verb in the table) | no noun exists; acceptable, it is the platform's word |
| **Feed** | **Activity** — "what has happened. The feed, and the run behind every line of it" | **the noun is `Activity`; `Feed` is the rendering** |
| **Work** ▸ | **Task** — "a row of work on one shared list" | **`work` is the Postgres table name (`seed/queries/board.yaml`, `/api/q/board`). A table name reached a label.** |
| Knowledge ▸ | Knowledge / page | correct, and the only section named for its noun |
| Agents | Agent | correct |
| **Insights** | — | **no noun; proposed, and the owner already flagged it (§7.11)** |

I am not asking to rename all three. I am asking you to decide which rule
wins, because they cannot both hold: either the glossary's nouns name the
sections (Activity · Tasks · …) or the sections are allowed their own words
and `glossary.md`'s "builder word on a screen is a bug" needs a carve-out
written down. **My recommendation: rename Feed → Activity, keep Work, rename
Insights.** `Feed` is pure habit — the noun already exists and is better.
`Work` I would keep despite the table collision, because "Tasks ▸ Board ·
Projects · Artifacts · Rooms" reads as though the last three are kinds of
task, which they are not; but then `glossary.md` should ratify **work** as a
ninth noun meaning "the shared list", so the label stops being an accident.

Question 8.1 and 8.2 below.

### 1.2 "Needs You" names two different objects on the same screen

This is the sharpest IA collision I found, and it is not in any of the logged
contradictions.

- **Needs You is the bell** — the request queue, `proposals` rows,
  `GET /api/proposals`, the six answers (`design-system.md` §3.18, §3.9).
- **Needs You is also a board column** — `docs/ops/board.md:44`: the column
  whose predicate is `status = 'blocked'` on a **`work`** row, "the human-gated
  state … Only your hand."

On Work ▸ Board, both are on screen at once: a column headed **Needs You**
holding tasks, and a bell in the top-right badged **Needs You** holding
requests. They are different tables, different verbs (a task is unblocked; a
request is approved/revised/declined), and a different meaning of "needs".
Two objects wearing one label on one screen is precisely what the glossary
exists to prevent, and no amount of visual design fixes it — I would just be
making the collision prettier.

**My recommendation:** keep the bell as **Needs You** (it is the shipped
product's promise and `ux-direction.md` named it) and rename the board column
to **Blocked**, which is its predicate, its wire value, and a word the owner
already uses in `escalationLabel` (`apps/console/web/app.js:1536`). That is a
one-word change in `board.yaml`'s presentation layer and `board.md`.

Question 8.3.

### 1.3 Work as an expandable group of four: right, with one exception

The group is right and §7.10's reasoning holds: four views of one object graph,
each one click from the sidebar, and the second-level segmented control deleted.
I would not change it. Two notes:

- **Rooms is the odd child.** Board, Projects and Artifacts are *collections
  you browse*. A **room** is not — it is "a comment thread that, by
  construction, cannot address anyone", and it belongs to a task or an
  artifact. A top-level Rooms list is a list of conversations detached from the
  things they are about, which is the one shape a room is defined not to be.
  Every room I can reach from Board or Artifacts, I can reach in context;
  what a Rooms list adds is "threads I have not read", which is a *queue*, and
  the product already ruled that queues hang off the bell.
  **I would propose demoting Rooms** from a sidebar child to a filter on
  Board plus the thread pane inside task and artifact detail — and, if you
  want "unread threads", that is a request type, not a section child.
  This is a proposal, not a finding; `/api/q/rooms` ships and the PWA has the
  surface, so keeping it costs nothing but a sidebar row. Question 8.4.
- **Four children plus six sections plus Pinned is a nine-to-eleven-row
  sidebar** at 248px with both groups expanded. That is fine on a Studio
  Display and tight at `accessibilityExtraExtraExtraLarge`, where
  `design-system.md` §6 requires the layout to survive. I will draw that state
  explicitly rather than assume it (§4, row "Dynamic Type XXXL").

### 1.4 Knowledge is undesigned, and it is also unsourced — those are different problems

Knowledge is the right section and the right bet; `app-ux-plan.md` §6.1 sizes
it honestly at ≈7.5 agent-days. But for the review gate the brief sets — *"a
screen whose spec cannot name its data source does not pass"* — Knowledge is
the only section where **no child can name one today**:

| Child | Data source | Status |
| --- | --- | --- |
| Pages | `knowledge_pages` named query | **does not exist** (`seed/queries/` has 17 files; not this one) |
| Search | `GET /api/knowledge/search` proxying the reconciler | **no route** — the console wires the searcher only into `mcp-brain` |
| Inbox | `Knowledge/Inbox/` via the same absent route | **no route** |

So if I design Knowledge next, I am designing against a described API rather
than a served one, and the gate you set exists precisely to stop that. Two
honest options, and I want you to pick:

- **(a) Design Knowledge from the spec anyway**, accepting that the screens
  are drawn against `app-ux-plan.md` §6.1's contract and may move when the
  routes land. Fine for Search (the bridge's `{q, mode, hits[], degraded?}`
  shape is shipped and concrete); risky for Pages (the query's columns are
  proposed, not written).
- **(b) Design the ≈3-day slice first** — Search with full results and the
  page view — because that slice needs no named query and no migration, and
  is the half you emphasised in §7.6. Pages, Inbox and the link graph come
  after the query exists.

**I recommend (b)**, and I recommend it moves *later* in the §3.2 order — see
1.6.

### 1.5 "Insights" — the name is the smallest problem with it

The name: it is a category, not a noun, and it is the only section label that
would be at home in an enterprise dashboard, which `design-brief.md` §5 lists
under what to avoid. Candidates that are nouns and are true:

| Candidate | For | Against |
| --- | --- | --- |
| **Activity** | it is the glossary's eighth noun and covers "runs, turns, collector passes" | collides with Feed unless Feed is renamed too (1.1) |
| **Meter** | precise: this is the instrument panel — cost, tokens, latency, agreement | not a glossary noun; slightly cute |
| **Spend** | honest about what you will actually open it for | too narrow: run metrics and shadow agreement are not spend |
| **Insights** | already in the docs | the ad-tech word |

**My recommendation: `Meter`** if you are willing to ratify a ninth noun, and
**`Spend`** if you are not — narrowing the section to what it is mostly for
is better than a wide word that means nothing. But the naming is the small
problem. The bigger one:

**Insights is the best-sourced section in the product and it is scheduled
last.** Five of its tiles have shipped named queries today —
`spend.yaml`, `claude_usage_daily.yaml`, `aws_costs_daily.yaml`,
`aws_costs_recent.yaml`, `runs_summary.yaml` — plus `shadow_agreement.yaml`,
which is the one thing in the brief I could not otherwise have believed was
real. Exactly one tile has no source: **run detail / "token and latency
trends"**, which `app-ux-plan.md` §6 phase B also flags as needing a `runs`
query.

### 1.6 What I would change about the order, and nothing else

`design-brief.md` §3.2 runs Chat → Feed → Needs You → Capture → Work →
Knowledge → Agents → Insights → Settings → sidebar. I would keep it except
for one swap:

**Move Insights ahead of Knowledge.** Insights is small (the owner's own
sizing: **S**), fully sourced, and it is the section that proves the design
language on *dense numeric content*, which nothing before it does. Knowledge
is **L**, unsourced, and is the section most likely to move under me. Doing
Insights first means that when Knowledge is drawn, the type scale, the tile
and the sparkline have already been reviewed by you once.

Everything else about the order I agree with, including starting at Chat:
Chat is where P1, P8 and P9 all meet, and if the design language cannot hold
those three it does not matter what the board looks like.

---

## 2. The one thing each screen is for, and what makes calm hard there

The brief asks this per screen. Answering it now, briefly, is how I will open
each round's spec.

| Screen | The one thing | What makes P2 (calm) hard here |
| --- | --- | --- |
| Chat · Conversation | read the last reply, answer it | Tool activity, tier, cost, turn state and tapbacks all want to be visible at once; four of the five are chrome around one piece of prose. The temptation is a status bar per turn. |
| Feed · Activity | answer "what happened while I was away" | Every row is *recent* and none is urgent. P2 forbids colouring for recency, so the only hierarchy left is the glyph and the actor chip — which means the glyph set has to carry more weight here than anywhere else. |
| Feed · Run detail | find why one run failed | The failing call must be the first thing on screen without the row above it being styled as an alarm. |
| **Needs You panel** | answer one thing and get back | **Hardest in the product** (§4.1). Six answers, a diff preview, grouping, a batch bar and a count that must not decrement early — in a popover. |
| Capture popover | get it out of my head in five seconds | Calm is easy; *speed* is hard. Every affordance added costs the promise. |
| Work · Board | see what is stuck | Six columns, per-column counts, an escalation flag and a drag target. This is where a second badge tries to be born (§7, C1). |
| Work · Task detail | decide what happens to this task | The room thread is agent text (P1) inside a detail pane that is chrome. |
| Work · Artifact | read the thing and say something about it | The sandboxed HTML band must read as a boundary without reading as an error. |
| Work · Project | flip the kill switch, or decide not to | The one destructive control in the product that is *routine*. |
| Knowledge · Pages/Page/Search | find the note | Search has a `degraded` mode (keyword only) that is a fact, not a failure — P5's hardest case. |
| Agents | see who is doing what, and revoke if not | Six presence colours on one screen is the most colour the product ever shows at once. |
| Insights | see what it cost and whether it worked | Charts. Every chart wants a palette the product does not have (§3.5). |
| Settings (6 panes) | change one thing and leave | Pointer vs read-through vs "not yet" is three kinds of value in one list (§4.3). |
| Wizard (7 steps) | get to a working instance | It is a progress log with a command in it; the calm rule and the "show the exact argv" rule pull opposite ways. |
| Mac sidebar | get somewhere | Eleven rows, two disclosure states, a pin that may be dangling. |

---

## 3. Tokens — load-bearing, habit, and what is missing

The short answer to §8's question: **the pipeline and the role names are
load-bearing and I will not touch them; roughly half the values are habit and
I would repoint them; and the set has four holes that the repo has already
worked around three times in ways that ship failing colour.**

### 3.1 Load-bearing — I keep these unchanged

- **The 27 semantic role names**, and `$meta.note`'s rule that no token names
  a hue, a screen or a component. This is the single best decision in the file
  and it is why a brand pass is cheap: I repoint values, nothing renames.
- **The four-state vocabulary** `ok · degraded · failed · absent`, and
  `absent` being first-class. It is in the wire (`CheckStatus` in
  `apps/macos/sources/kit/doctor-report.swift:17`), in the CLI, and in the
  menu-bar rule that `absent` never drives the glyph. Untouchable.
- **`agent` / `agent-quiet`.** P1 is the product's spine and these two are the
  only tokens that carry it. I will change the hue; the roles stay.
- **The six presence roles.** Exhaustive, derived from lease liveness, each
  with a label and a glyph. Keep.
- **The reply group (`--mt-reply-*`, §4).** The reasoning in §4.1 is the best
  writing in the design system and the numbers are right. I would change one
  value (`--mt-reply-measure`, see 3.3) and nothing else.
- **The 4pt grid and the target sizes.** Keep.
- **The generator and `--check`.** Keep, and extend (3.4).

### 3.2 Habit — I would repoint these, and here is what it buys

| Token(s) | Why I call it habit | What repointing buys |
| --- | --- | --- |
| `accent` `#2b5fd0` / `#7ea9ff` | It is macOS default blue's neighbourhood. An app whose one interactive colour is the system accent looks like an app nobody styled — and `make-app-icon.mjs` reads `color.accent.light` for the icon, so **the placeholder icon's colour is the product's only brand decision to date**. | A brand. This is the highest-leverage token in the file: it is the icon, the focus ring, the selected row, the pill and the wordmark at once. |
| `agent` `#6a4bbd` (systemPurple) | Purple-for-AI is the most-used convention of the last three years, and it is one accent-setting away from colliding with `accent` (§7, C11). | A tint that cannot be confused with the interactive colour under any user accent setting — which is what P1 actually requires. |
| The 12-step type scale | Twelve steps, of which `style.css` consumes nine and the Swift uses twelve names for eleven Apple styles. `large-title` and `title-1` appear nowhere in either client. | Little. **I would keep all twelve** — they map to Dynamic Type, which is the point, and an unused step costs nothing. Listing it here as habit I examined and am *not* changing. |
| Six radii (`xs`…`pill`) | `xs 6` and `sm 8` are 2px apart and the PWA uses `xs` three times. | One less decision per component. I would propose five, folding `xs` into `sm`, but only if you want it — this is preference, and preferences lose (§1's own rule). |
| `elevation` 0–3 | Correct in principle ("dark raises by getting lighter"), but **not emitted to Swift at all**: `design-tokens.swift` declares five enums — `MetistryColorRole`, `MetistryTextStyle`, `MetistrySpace`, `MetistrySize`, `MetistryRadius` — and the strings `elevation`, `motion`, `reply` and `z` appear in it zero times. So the Mac app has no elevation, no motion and no reply typography, and `metistryCard` draws a 1px border and nothing else (`apps/macos/sources/kit/palette.swift`). | Nothing until the Swift emit is fixed. That fix is `app-ux-plan.md` §5's hole 1 and it blocks both my component round and any native chat. |
| `scrim` | An rgba string in a set that is otherwise hex, which is why `design-tokens.swift` emits component tuples instead of hex (its own comment says so). | Nothing. Keep. |

### 3.3 The one reply-token change I would make

`--mt-reply-measure: 38em`. At the reply size this is ~66 characters, which
is right for a document. It is one notch wide for a **transcript**, where the
eye returns on every line and the previous turn must stay on screen. I would
take it to **34em** (~60 characters) and show you both in round B. Small, and
I would not raise it except that §4.1 says the measure is "wide layouts only"
and the Mac is the wide layout this engagement starts with.

### 3.4 The hole that ships failing colour today

`design-system.md` §2.2 checks **`presence-working` on `surface`** and gets
5.36:1. But no presence chip is ever drawn on `surface`. It is drawn on a
14% tint of itself, because there is **no token for a state fill** —
`apps/console/web/style.css:292–297` invents one with `color-mix()`.

Computing the shipped pairs with the repo's own formula
(`ops/scripts/build-design-tokens.mjs`'s WCAG 2.1 relative luminance), on the
ground that is actually painted:

| Chip (light mode) | fill | contrast on the fill | CI checks (on `surface`) |
| --- | --- | ---: | ---: |
| `presence-working` | 14% | **4.41:1** | 5.36:1 |
| `presence-idle` | 14% | **4.39:1** | 5.26:1 |
| `.chip.autonomous` (`ok`) | 14% | **4.41:1** | 5.36:1 |
| `presence-queued` | 14% | 4.86:1 | 5.93:1 |
| `presence-over-cap` | 14% | 4.87:1 | 5.97:1 |
| `presence-blocked` | 14% | 5.11:1 | 6.26:1 |
| `presence-interrupted` | 14% | 5.19:1 | 6.54:1 |
| `.chip.failed` (`failed`) | 10% | 5.54:1 | 6.54:1 |

Dark mode passes throughout (worst 4.62:1, `presence-idle`).

So **three chips ship below the 4.5:1 bar in light mode**, and §2.2's own
sentence — "chips render at 13px/500 and so are *not* large text and get no
exemption" — is the reason it matters. CI passes because the declared ground
is not the painted ground. Three further facts make this a token problem
rather than a CSS bug:

1. The spec says **~12%** (`design-system.md` §3.3); the code ships **14%**
   for presence and **10%** for `failed` (`style.css:224`). Three numbers.
2. `color-mix()` has **no Swift equivalent** in `design-tokens.swift`, which
   emits colour and nothing else — so the first native presence chip has to
   invent its fill, and it will not match the web's.
3. The wireframes already needed these fills and invented six more hexes that
   are in no token: `#c6d6f7`, `#e2d9f7`, `#faf1de`, `#fbe6e5`, `#fbeade`,
   `#e3f5ea`, across nine SVGs including `mac-work-board.svg` and
   `mac-agents.svg`.

**What I propose:** add explicit quiet fills as roles —
`ok-quiet`, `degraded-quiet`, `failed-quiet`, `absent-quiet` and one per
presence state — computed once, declared in `tokens.json`, and added to the
`contrast` arrays so CI checks the ground that is painted. That is nine new
tokens, no new concept (the file already has `accent-quiet` and `agent-quiet`
doing exactly this), and it deletes `color-mix()` from the PWA, gives Swift a
chip it can draw, and gives the wireframes their six missing hexes.

It also, separately, gives the **Decline button** a token. Today it is an
inline literal — `apps/console/web/app.js:504`,
`style="background:#7a3b3b"` — because there is no destructive-fill role in a
set where `failed` is a foreground colour. That is the ninth literal
`app-ux-plan.md` §1.4 counts, and it is the only one that is a *missing
token* rather than a *lazy call site*.

Question 8.5.

### 3.5 Two more holes, smaller

- **No chart palette.** Insights is spend over time, token and latency trends
  and shadow agreement — at least three series on one axis. The only colours
  available are one accent, four states and six presence values, and every one
  of them already means something. A line coloured `degraded` because it is
  the second series would be a lie under P2's "colour buys three things".
  I will propose a sequential ramp derived from the brand accent plus one
  neutral, declared as tokens, checked against `surface`, and used **nowhere
  but charts**.
- **No "stale" role.** §4 below says no surface renders staleness; there is
  also no token for it. `degraded` is the obvious reach and it is wrong —
  degraded is "answering, not healthy"; stale is "not answering, and this is
  the last thing it said". Question 8.6.

---

## 4. States and screens with no visual answer

The brief asks which states here have no visual answer. These, and the first
four are the ones I would fix before drawing anything.

### 4.1 Stale — the state the product talks about most and draws nowhere

It appears in five places in the specs and zero in the code:

- `design-system.md` §3.9: a request card's `stale` state, `409 reason:
  "stale"`, `if_unchanged: {seen_at}` — the PWA implements the *refusal*
  (`app.js`, the `seenAt` map and the 409 repaint) and renders no *state*.
- §3.18: the bell "keeps the last count and the panel says the count is
  stale" when unreachable — nothing draws this.
- §3.13 / the Mac status panel: `status-model.swift` records `lastRunAt` and
  the panel prints `report.asOf`. **A timestamp is not a state.** There is no
  threshold, no chip, and nothing that says "this is forty minutes old" —
  which is exactly what P5 ("state is reported, never inferred") asks for,
  because a reader inferring freshness from a timestamp is the inference P5
  forbids.
- Knowledge search's `degraded` (keyword only, embedder down) — a distinct
  third thing, and also undrawn.
- Insights: every tile is a collector's last pass. A spend tile from a
  collector that last ran three days ago looks identical to a fresh one.

**This is the single biggest gap in the brief.** `empty vs absent vs failed vs
stale` is your own four-way distinction and the fourth has no token, no glyph,
no copy pattern and no example. I would answer it first, in the component
round, as one pattern used everywhere: a `footnote` age line that becomes a
chip past a per-source threshold, plus the `stale` role from 3.5.

### 4.2 Unreachable, and the disabled decision

`ios-app-plan.md`'s O3 — "decision controls are *disabled* while the instance
is unreachable, never queued" — is a rule with no rendering. A disabled
Approve button that is disabled *for a good reason the user should be able to
read* is P4's territory ("refusals are explained where they happen"), and a
plain greyed button explains nothing. Needed: one pattern for "this control
is off because of a fact about the system", distinct from "this control is off
because you have not selected anything".

### 4.3 The three kinds of Settings value

`design-brief.md` §3.3 names it as a real design ask and it has no answer yet:
every value is a **pointer** the app remembers, a **read-through** of a CLI
verb, or a labelled **"not yet"**. Today the code carries the distinction in
its phase enums (`ReadPhase { idle, reading, read, unavailable }`,
`NotYetCard`, `UnavailableCard` in `cli-cards.swift`) and on screen it reads
as three kinds of grey. Making it legible is one of the two places I expect to
spend real time.

### 4.4 The menu-bar glyph carrying four states without colour

`design-brief.md` §5 asks for a template image — monochrome plus alpha — that
reads `ok / degraded / failed / absent` at 16pt in both menu-bar appearances.
Today this is not an asset at all: it is four SF Symbols swapped at render
(`apps/macos/sources/app/metistry-app.swift:116`), which is a legitimate
answer and may be the right one. A single mark that mutates across four states
in one weight of one colour at 16px is the hardest drawing in the brand kit,
and it is worth deciding up front whether you want it, or whether you want
SF Symbols to keep doing it and the brand mark to stay out of the menu bar.
Question 8.7.

### 4.5 Dynamic Type at XXXL, against a fixed window

`design-system.md` §6 requires layouts to survive
`accessibilityExtraExtraExtraLarge` and says "no row is a fixed height".
`apps/macos/sources/kit/settings-view.swift:47` is
`.frame(width: 640, height: 520)` — a fixed, non-resizable Settings window
over a seven-tab `TabView`. At XXXL that window cannot show its content and
the user cannot resize it. This is C5 in §7; I raise it here because the
Settings redesign has to answer it, and the answer is probably the modern
macOS Settings shape (a `NavigationSplitView` of panes in a resizable window)
rather than a bigger fixed frame.

### 4.6 Everything else with no answer

| State / surface | Where it is specified | Why it is undrawn |
| --- | --- | --- |
| Dangling pin | §3.19 | "dimmed, `text-tertiary`, says what it pointed at" — no example, and it is the only row in the sidebar that is broken rather than empty |
| Panel-count threshold | §3.18 | "over 6 cards it becomes a resizable panel" — a container that changes type by count is a transition nobody has drawn, and P2 says the surface should not surprise you |
| Empty *section* vs empty *row* | §3.15 | The copy exists for lists. A whole section that is absent (Knowledge with no bridge configured) has no pattern |
| `escalated` reason on a card | `board.md:76`; `app.js:1536` (`escalationLabel`), rendered at `app.js:1552` | Ships as `<span class="chip failed">lease lapsed</span>` — a `failed`-tinted chip on a card that has not failed |
| Turn state `interrupted` | §3.4 | Named; no rendering anywhere in either client |
| Notification `expired-before-action` | §3.14 | "the app shows what the default was" — undrawn |
| Artifact `superseded` (the 503) | §3.11 | Named; undrawn |

---

## 5. P1–P10 for a native Mac app: four objections and one amendment

I honour all ten. Four I think are wrong, or under-specified, *for a native
Mac app specifically*.

### 5.1 P7 and the accent are in direct conflict, and CI is on the losing side

`tokens.json` maps `accent` → `controlAccentColor` and §2.1 says "SwiftUI
should prefer the system colour where the mapping is exact". **`controlAccentColor`
is user-settable** — System Settings ▸ Appearance ▸ Accent colour, eight values
plus Multicolour. So:

- If the Mac app honours it (P7, native), then the product's one interactive
  colour is whatever the user picked, **none of the 74 CI-checked pairs
  describe the shipped app**, and `accent` on `accent-quiet` at 4.90:1 — the
  tightest pair in the table — is a coin flip.
- If the Mac app pins `#2b5fd0` (verifiable), it is the one app on the user's
  Mac that ignores their accent, which P7 exists to prevent.
- And if the user picks **purple**, `accent` and `agent` collide, and P1 —
  "agent text is visibly not chrome" — is carried by a tint indistinguishable
  from the interactive colour. That is the failure mode that matters, because
  P1 is the principle the brief says a good-looking mockup is most likely to
  break.

There is a third way and I think it is the right one: **pin `accent` as the
brand colour, and let `controlAccentColor` drive only the system controls that
Apple draws itself** (checkbox fills, the focus ring, text selection), which
is what most well-made Mac apps with a brand do. Then the contrast table is
honest for everything we draw, and the app still feels native where the
platform actually has an opinion. **`agent` must then be pinned and chosen to
survive every one of the eight system accents**, which is a real constraint on
the brand palette and one I want before I choose hues. Question 8.8.

### 5.2 P8 is a phone rule applied to a 1000pt-wide detail pane

"Bubbles, each aligned to its sender (yours trailing … the assistant's
leading)" is right on iPhone and wrong at Mac width. In a
`NavigationSplitView` detail pane the transcript is already inside a column
with a sidebar and possibly a list beside it; alternating alignment across
that width throws the reader's eye from edge to edge on every turn, and §4's
own `--mt-reply-measure` exists because unbounded width is bad for reading.
Every Mac chat client that is not a port of a phone app (Mail, Messages *on
Mac* above a certain width, every code assistant) ends up with a single
left-aligned column and the sender distinguished by attribution and ground
rather than by side.

I am not asking to overturn P8 — its reasoning ("the fastest interface to
learn is one already learned") is sound and it is written down so decisions
have somewhere to appeal. I am invoking that appeal: **P8 should say bubbles
and sender-distinction, and leave alignment to the layout**, so the phone
alternates and the Mac does not. Question 8.9.

### 5.3 P10's table contradicts itself on buttons

`design-system.md` §1 P10's **sentence case** row reads: "body copy, helper
text, placeholders, empty-state prose, receipts, error messages, and buttons —
verb-first per the HIG ("Send", "Approve", "Revise", "Decline" are control
labels and take Title Case; …)". It lists buttons under sentence case and then
says buttons take Title Case. `design-brief.md` §4's restatement says Title
Case for "button labels" with no ambiguity.

The brief is right and the HIG agrees (macOS uses title-style capitalisation
for controls and menu items). The table needs the word "buttons" deleted from
the sentence-case row. Logged as C3; not edited.

### 5.4 P2's "only badge" is already false on the board, and macOS adds two more doors

C1 in §7: `board.md:107` ships a red escalation number on every column header.
Beyond that, a native Mac app has two badge surfaces the PWA does not — the
**Dock tile** (`NSApp.dockTile.badgeLabel`) and the **menu-bar extra**, which
already changes glyph on the worst fault. P2 needs to say whether "only badge"
means "only *in-window* badge" (in which case the Dock may carry the same
count, and I think it should — it is the one place a count is useful with the
app hidden) or "one count in the whole product, and the Dock stays clean".
Question 8.10.

### 5.5 One amendment I would propose to P5

P5 says state is reported, never inferred. I would add: **and its age is
reported too.** The whole of §4.1 follows from the missing half-sentence — a
reported state with no freshness is an invitation to infer, which is the thing
P5 forbids. This is a one-line amendment and it is the only change I want to
the principles.

---

## 6. Vocabulary — words I needed and could not find

Per the brief: a word I needed and cannot find in `glossary.md` is a finding.
Five.

1. **A word for the queue itself.** A **request** is the row. The list is
   "Needs You", which is a sentence, not a noun — you cannot say "three
   requests are in the ___". The bell makes this worse, because the queue now
   has no place and therefore needs a name more, not less.
2. **Stale.** Used in §3.9, §3.18 and O3; not a ratified state. It is not
   `degraded` (see 3.5) and the product needs it in at least five surfaces.
3. **Unreachable.** Same: it names a fact about the instance, is the condition
   behind O3's disabled controls, and is in `ConsoleSignIn`'s five answers
   (`kit/console-sign-in.swift`) without being in the vocabulary.
4. **Shadow agreement.** `design-brief.md` §3.1 puts it on an Insights screen
   as a label. There is a query (`seed/queries/shadow_agreement.yaml`) and a
   record fragment, and there is no glossary entry — so by the glossary's own
   rule, a word from the build has reached a screen. It needs either a
   ratified user-facing name (my suggestion: **"local vs cloud agreement"** as
   the tile title, "shadow" nowhere) or a glossary entry.
5. **Room**, **board**, **escalated**, **pinned**, **insights**, **work** —
   all reach labels; none is among the eight nouns. Some are obviously fine
   (pinned is furniture); `escalated` is not, because it surfaces to the user
   as `lease lapsed`/`blocked`/`overdue` chips and those three are a state
   vocabulary nobody ratified.

---

## 7. Contradictions found in the repo, logged

Per `CLAUDE.md`. None edited. The ones the owner already logged in
`app-ux-plan.md` §7 are not repeated, except where I found them still open.

| # | Contradiction | Evidence |
| --- | --- | --- |
| **C1** | P2/§3.18 "Needs You is the product's **only** badge" vs a red escalation count on every board column header | `design-system.md` P2, §3.18; `docs/ops/board.md:107` |
| **C2** | "Needs You" names both the request queue (bell) and the board column for `status='blocked'` tasks — two objects, one label, one screen | `design-system.md` §3.18; `docs/ops/board.md:44` |
| **C3** | P10's table lists buttons under sentence case and then says control labels take Title Case; the brief says Title Case | `design-system.md` §1 P10; `design-brief.md` §4 |
| **C4** | §4.4 "Nothing here depends on a translucent ground" vs §3.6/§3.18 specifying a macOS `.popover` for the actions menu and the Needs You panel — a macOS popover's background **is** a vibrant system material, on which no declared contrast pair holds | `design-system.md` §4.4, §3.6, §3.18 |
| **C5** | §6 "layouts must survive `accessibilityExtraExtraExtraLarge`… no row is a fixed height" vs a fixed, non-resizable Settings window | `design-system.md` §6; `apps/macos/sources/kit/settings-view.swift:47` |
| **C6** | §3.3 specifies a presence fill at **~12%**; the shipped fills are **14%** (presence, `.chip.review`, `.chip.autonomous`) and **10%** (`failed`) | `design-system.md` §3.3; `apps/console/web/style.css:224, 285–297` |
| **C7** | Three presence/state chips fail WCAG AA in light mode on the ground actually painted (4.39–4.41:1), while CI passes them by checking a ground never used | computed above, §3.4; `design-system.md` §2.2 |
| **C8** | Nine wireframes carry six hexes that are in no token (`#c6d6f7`, `#e2d9f7`, `#faf1de`, `#fbe6e5`, `#fbeade`, `#e3f5ea`) — the generic form of this is logged in the brief; these are the specific values | `docs/product/design/*.svg`; `tokens.json` |
| **C9** | `make-app-icon.mjs`'s header instructs a replacement to "point `ops/release/build-app.sh`'s `ICON_PNG` at it" — **`build-app.sh` has no `ICON_PNG` variable**; the generator call is hardcoded at line 130 | `ops/release/make-app-icon.mjs`; `ops/release/build-app.sh:130` |
| **C10** | The PWA's status list collapses `degraded` and `absent` into `failed` — `c.status === "ok" ? "ok" : "failed"` — a live P5 violation, and the four-state vocabulary's only shipping counter-example | `apps/console/web/app.js:431` |
| **C11** | `tokens.json` maps `accent` → `controlAccentColor` (user-settable) while CI checks a fixed hex; if the user's accent is purple it collides with `agent` and P1's tint stops distinguishing anything | `tokens.json`; `design-system.md` §2.1, P1 |
| **C12** | The two placeholder marks still disagree with each other and with the tokens: the app icon is `on-accent` on `accent`; `apps/console/web/icon.svg` is `#7ea9ff` (the **dark**-mode accent) on `#0e1216` (the **dark**-mode canvas), used in both appearances | `ops/release/make-app-icon.mjs`; `apps/console/web/icon.svg` |
| **C13** | `index.html:17` sets `apple-touch-icon` to an SVG, which iOS does not honour — so the installed PWA has no home-screen icon on iPhone today | `apps/console/web/index.html:17`; `manifest.webmanifest` |
| **C14** | `glossary.md` still says requests take "the same three answers" and the brief/§3.9 say six; the owner logged this on 2026-09-17 and it is **still open** | `glossary.md`; `design-system.md` §3.9 |
| **C16** | `ux-direction.md` says the working state is "a **word**, not a spinner" and that nothing "spins or pulses"; the owner asked on 2026-09-19 for an animated indicator, because a word that never changes is indistinguishable from a stuck one. Proposed amendment in `screen-01-chat.md` §5.1 — *motion only where it carries information the reader cannot otherwise get, stopping the moment that information is available in words* — **awaiting a ruling** | `ux-direction.md`; `design-system.md` §3.4 |
| **C15** | `design-system.md` §3.1's own body says the Mac sidebar rows carry "an optional count badge — shown only when the count is *actionable*", which contradicts the "only badge" rule three paragraphs later | `design-system.md:500` (§3.1) |

Minor, not worth a row each: the PWA's `rooms` nav item is the one view with
no glyph rule and falls back to `•` (`style.css:119–128`);
`MetistryLogs.conventionalDirectory` is `"/tmp"`
(`settings-view.swift:553`) while Settings ▸ Advanced presents it to the user
as "Log folder" with an Open in Finder button (`:535`, `:539`).

---

## 8. Questions — answer these and I start

Grouped, numbered, each with the recommendation so you can mostly say yes.
**8.5, 8.8 and 8.11 block the brand round; the rest block a screen round.**

**Naming and vocabulary**

1. **Feed or Activity?** The glossary noun is *Activity*. Rename?
   *My recommendation: rename to Activity.*
2. **Work — ratify it as a ninth noun, or rename the section to Tasks?**
   *My recommendation: ratify `work`; "Tasks ▸ Artifacts" reads wrong.*
3. **Rename the board's `Needs You` column to `Blocked`?** (C2)
   *My recommendation: yes. One word, and it ends a real collision.*
4. **Rooms: sidebar child, or a filter on Board plus the thread pane in
   detail?** *My recommendation: demote it. Not a strong view.*
5. **Insights → `Meter` (ratify a noun) or `Spend` (narrow it honestly)?**
   *My recommendation: `Meter` if you will ratify, `Spend` if not.*

**Tokens — these block the colour system**

6. **Add the nine quiet-fill roles** (`ok-quiet`, `failed-quiet`,
   `degraded-quiet`, `absent-quiet`, six `presence-*-quiet`) **plus a
   destructive fill, and add them to the `contrast` arrays** so CI checks the
   ground that is painted? This fixes C6, C7, C8 and the `#7a3b3b` literal in
   one change. *My recommendation: yes — it is the first token change I want
   to make and it is a bug fix, not a style preference.*
7. **A `stale` role and an age-reporting pattern** — one, used on the status
   panel, the bell's count, Insights tiles and search results? *Recommendation:
   yes, plus the one-line P5 amendment in 5.5.*
8. **Accent: pin the brand colour and let `controlAccentColor` drive only
   Apple's own controls?** (C11) Or honour the system accent everywhere and
   accept that the contrast table describes a default nobody has? *My
   recommendation: pin. And tell me now, because it decides whether the brand
   palette has to survive eight system accents.*
9. **A chart palette** — a sequential ramp from the accent plus one neutral,
   tokenised, used nowhere but Insights? *Recommendation: yes; Insights is
   undrawable without it.*

**Principles**

10. **P8: bubbles and sender-distinction on both platforms, but alignment left
    to the layout** — alternating on iPhone, single column on Mac? (5.2)
    *Recommendation: yes.*
11. **P2: does "only badge" permit the Dock tile carrying the same Needs You
    count?** (5.4) *Recommendation: yes for the Dock, no for anything else —
    and C1's board escalation numbers become a `footnote` count with the
    escalation glyph, not a red badge.*
12. **P10: delete "buttons" from the sentence-case row?** (C3)
    *Recommendation: yes.*
13. **C4: what is behind the Needs You panel on macOS** — a vibrant
    `.popover` (native, and the contrast table does not describe it) or an
    opaque `elevated` panel (checkable, slightly less Mac)? *Recommendation:
    opaque, because the panel holds a diff and a destructive action; keep
    vibrancy for the composer's `+` menu, which holds no decision.*

**Brand**

14. **Menu-bar glyph: a drawn template mark, or keep the four SF Symbols?**
    (4.4) *Recommendation: keep SF Symbols for the state and do not put the
    brand mark in the menu bar. It is the one place a custom mark costs
    legibility and buys recognition nobody needs — the user knows which app it
    is.* If you want the mark there, say so and I will draw it to the
    four-state constraint.
15. **Wordmark case: "Metistry" or "metistry"?** The CLI is lowercase, the
    product is Title Case, and the two appear side by side in the wizard.
16. **May I add an `ICON_PNG` variable to `build-app.sh`** so a committed
    master replaces the generated placeholder the way `make-app-icon.mjs`'s
    own header says it should? (C9) *This is a build change, so I am asking
    rather than doing.*

**Process**

17. **Order: Insights before Knowledge?** (1.6)
18. **Knowledge: design the ≈3-day search slice first** (option b, 1.4), or
    the full section against the described API?
19. **Do you want the `--check` extension** (contrast on painted grounds, plus
    `app-ux-plan.md` §5's hole 3: every SVG hex must be in `tokens.json`) as
    part of my token PR, or as a separate change by Claude Code?

---

## 9. What I do first, once answered

1. **Round A — brand.** Wordmark, app icon master (1024, macOS grid, squircle
   mask), iOS light/dark/tinted, PWA favicon + 180 + 512 + maskable, and the
   menu-bar decision from 8.14. Light and dark. Plus the one-page do/don't.
2. **Round B — design language and tokens.** `tokens.json` matching the
   existing schema exactly — top-level `color · type · reply · space · size ·
   radius · elevation · motion · z`, every entry keeping `role`, `light`,
   `dark`, `apple` and `contrast` — so `build-design-tokens.mjs` rebuilds
   `tokens.css`, `apps/console/web/tokens.css`, `design-tokens.swift` and
   `preview.html` unchanged. Semantic role names preserved; the new roles from
   8.6, 8.7 and 8.9 added.
3. **Round C — components**, starting with the four states (empty · absent ·
   failed · stale) as one pattern, then the request card, because it is the
   hardest thing in the product and everything else is easier once it is
   settled.
4. **Round D — screens**, Mac first, §3.2 order with the 1.6 swap, one at a
   time, light and dark, each with its data source named.

---

## Changelog — round 00

| What | Why |
| --- | --- |
| Added this review | `design-brief.md` §8 asks for it before anything is drawn |
| Logged 16 contradictions (C1–C16), none edited | `CLAUDE.md`: "Report contradictions, don't route around them" |
| Computed the shipped presence-chip contrast on the ground actually painted | §2.2 checks `presence-* on surface`; nothing is drawn on `surface`. Three chips are below AA in light mode |
| Proposed no token values yet | The accent decision (8.8) determines the palette, and it is unanswered |
| Proposed one reordering (Insights before Knowledge) and one demotion (Rooms) | Data sources, and what a section is for |
| Proposed one amendment to the principles (P5, 5.5) | The four-way state distinction has no fourth state without it |

---

## Ratified — 2026-09-18

All nineteen answered by the owner. Two new nouns for `glossary.md` (**work**,
**usage**); the Mac sidebar reads **Chat · Activity · Work ▸ · Knowledge ▸ ·
Agents · Usage**.

| # | Decision |
| --- | --- |
| 1 | Feed → **Activity** |
| 2 | **work** ratified as a noun; the section stays Work |
| 3 | The board column becomes **Blocked** |
| 4 | Rooms demoted — a filter on Board plus the thread pane in task and artifact detail |
| 5 | Insights → **Usage**. The idea is tracking usage, spend and performance. **"Insights" is reserved** for a later feature (ideas the assistant has from knowledge, actionable intelligence), so the word is not spent on the meter |
| 6 | Quiet-fill roles and a destructive fill added; CI checks the painted ground |
| 7 | A `stale` role, an age-reporting pattern, and the P5 amendment |
| 8 | **Accent pinned** as the brand colour; `controlAccentColor` drives only Apple's own controls |
| 9 | A chart palette, tokenised, charts only |
| 10 | P8 amended: bubbles and sender-distinction on both platforms, alignment left to the layout |
| 11 | The Dock may carry the Needs You count; board escalations become a `footnote` count with a glyph |
| 12 | "buttons" deleted from P10's sentence-case row |
| 13 | The Needs You panel is an opaque `elevated` panel, not a vibrant popover |
| 14 | The menu bar keeps its four SF Symbols; the brand mark stays out of it |
| 15 | **Metistry** for the name and title; `metistry` for the binary, CLI and packages |
| 16 | `ICON_PNG` may be added to `build-app.sh` |
| 17 | **Usage stays at the bottom of the navigation**, with a live case for moving it into Settings entirely |
| 18 | Knowledge: the ≈3-day search slice first |
| 19 | The `--check` extension ships in the token PR |

### Two things decision 17 leaves open

**Which screen is designed first.** Q17 as written was about drawing order, not
sidebar position; the answer settles the navigation and not the schedule. Usage
sitting last is compatible with drawing it early, and it remains the only
section whose queries all ship.

**Whether Usage is a section at all.** If it moves into Settings the fixed
sidebar is five rows, not six, and P6's "same six sections, same order" changes
wording on three surfaces. Better decided once the Usage screen exists and it
is visible whether it reads as somewhere you visit or something you configure.
It will be drawn as a section with the Settings-pane version beside it.

### Effect on this review

Nothing is retracted. §6's recommendations are now decisions; §1.5's naming
options are closed by **Usage**; C2 and C3 are resolved by decisions 3 and 12;
C6, C7 and C8 by decision 6; C11 by decision 8. **C1, C4, C5, C9, C10, C12,
C13, C14, C15 and C16 remain open** and are build-side fixes, not design ones.
