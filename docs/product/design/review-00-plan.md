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
| **C16** | ~~`ux-direction.md` says the working state is “a **word**, not a spinner” and that nothing “spins or pulses”; a word that never changes is indistinguishable from a stuck one.~~ **RATIFIED 2026-09-22.** The amendment carries and `ux-direction.md`'s sentence is narrowed rather than kept as written: **motion is allowed only where it carries information the reader cannot otherwise get, and it stops the moment that information is available in words.** Everything falls out of that one sentence — the three waiting dots exist only while there is nothing to say and are *replaced*, not supplemented, the instant a tool name can be printed; under `prefers-reduced-motion` the dots hold flat and the elapsed count carries liveness alone, because a number is content. This was **the only looping animation the product is permitted** until C75 admitted a second; the list is closed at two | `ux-direction.md`; `design-system.md` §3.4; `screen-01-chat.md` §5.1; ruled 2026-09-22 |
| **C17** | `design-system.md` §3.2's kind inventory omits `capture`, but `activity_feed.yaml`'s first branch is captures and `apps/console/web/app.js` has shipped a `capture` icon since ADOPT 1. The doc is behind the code | `design-system.md` §3.2; `seed/queries/activity_feed.yaml`; `apps/console/web/app.js` |
| **C18** | `work_history` is in the title-case allow-list in both §3.2 and `app.js`, but its subject is `w.title` — authored text. "Migrate the settings pane to tokens" renders as "Migrate The Settings Pane To Tokens", which is the exact failure the rule exists to prevent | `design-system.md` §3.2; `apps/console/web/app.js` |
| **C19** | §3.2 says a failed row takes `failed` on its glyph, but `activity_feed` never returns `ok` — failure exists only as English inside `detail`. The state §3.2 specifies cannot be drawn from the data the query returns | `design-system.md` §3.2; `seed/queries/activity_feed.yaml` |
| **C20** | `runs.ok` is `NOT NULL` in `db/migrations/0001_init.sql` and nullable in `packages/tasks/sql/schema.sql` — two schemas for one table, and the difference is exactly where an in-flight run would live | `db/migrations/0001_init.sql:21`; `packages/tasks/sql/schema.sql:71` |
| **C21** | `components-01-states-and-request.md` §2.6 specifies the panel header “Needs You · 4 waiting · 1 snoozed”, but `GET /api/proposals` without a cursor excludes snoozed rows by its WHERE clause — the count cannot be obtained. **My own spec, not the repo's** | `docs/product/design/components-01-states-and-request.md` §2.6; `apps/console/src/server.ts:777` |
| **C22** | `proposals.trust` (`internal \| external \| user`) is returned on every queue row and no design surface has ever rendered it, though P1 turns on exactly that distinction | `db/migrations/0002_review_decisions.sql:26`; `apps/console/src/server.ts:777` |
| **C23** | `design-system.md` §3.8 specifies the receipt “captured → inbox #418 · classified `note` on-device”, but `POST /capture` returns only `{id, path, sha256}` — classification happens later in the `*/5` drain, and §3.8's own **Never** forbids waiting for it. One paragraph contradicts itself | `design-system.md` §3.8; `apps/console/src/server.ts:428` |
| **C24** | `POST /capture` honours `Idempotency-Key` and replays the original response with `idempotency-replayed: true` — the mechanism that keeps §3.8's “never drops” from becoming “sometimes captures twice”. No design document mentions it | `apps/console/src/server.ts:435`; `design-system.md` §3.8 |
| **C25** | `POST /capture` hardcodes `source: "http"`, and `inbox.source` (`imessage \| share \| http \| obsidian \| cli`) has no value for the apps themselves — so the owner's own capture is indistinguishable from any HTTP caller on Activity | `apps/console/src/server.ts:454`; `db/migrations/0001_init.sql:33` |
| **C26** | The four design documents the brief names as canon — `design-brief.md`, `design-system.md`, `app-ux-plan.md`, `ux-direction.md` — were **not** updated for v0.11.0 and still describe Work with four children and no task/work split. `daily-flow-spec.md`, `PRODUCT.md` and `glossary.md` are the current authority. Every later screen has to know which document wins | `docs/product/design-brief.md`; `docs/product/daily-flow-spec.md` |
| **C27** | P1 (“agent text is data, never looks like a control”) inverts on Work ▸ Today, where the task line is the owner's own writing and must look actionable. §2 states P1 unconditionally | `design-system.md` §2; `docs/product/design/screen-05-today.md` §1 |
| **C28** | §3.15 ratifies four states — empty, absent, failed, stale. A row with `vault_tasks.parse_warning` is none of them: the task is fine and one token is unreadable. A fifth shape, **partial**, is needed | `design-system.md` §3.15; `daily-flow-spec.md` §6.4 **An instance exists as of 2026-09-22:** `knowledge_files.status = 'conflict'` is a row whose *path* is a fact and whose *title and mtime are not yet* — not `failed` (nothing broke), not `absent` (the file is there), not `stale` (not about age). Recommended for ratification on that basis; drawn on `Knowledge` |
| **C29** | §10.1 requires the user's drag order on Today to be stored and authoritative, and nothing specifies where. It cannot live in the markdown — that is the user's file and a reorder is not a task edit | `daily-flow-spec.md` §10 |
| **C30** | P6 and `app-ux-plan.md` ratify **six sections, same order, same names on every platform**. Today becomes a seventh, second under Chat, because it stopped being a view of Work — it holds meetings, artifacts, requests and agent status, none of which Work owns. P6's force (same rows, same order, same names everywhere) survives; the number does not | `design-system.md` P6; `app-ux-plan.md`; `docs/product/design/screen-05-today.md` §13.1 |
| **C31** | The design system has no facet vocabulary, so priority, due dates, people and links have been styled per screen. A five-rung ladder with a two-chip cap is proposed in `screen-05-today.md` §13.3 and wants to live in §3 | `design-system.md` §3; `docs/product/design/screen-05-today.md` §13.3 |
| **C32** | The design system has no typeface distinction for agent-written prose. P1 relies on containers and attribution alone, which do not survive a copy-paste out of the app. `ui-serif` for agent prose is proposed in `facets-and-colour.md` §5 — a system face, so P7 holds | `design-system.md` §2 P1, P7; `docs/product/design/facets-and-colour.md` §5 |
| **C33** | 👍/👎 exists only on `outbound_messages` in Chat, though agent prose now appears on Today, on meeting briefings and in revision explanations. One feedback signal, keyed by a `prose_id`, is request B7 | `docs/ops/reply-feedback.md`; `docs/product/design/today-hub-requests.md` B7 |
| **C34** | A stacked bar of five touching segments cannot be built from the `chart-*` ramp: it is spaced evenly by luminance for line marks, so consecutive steps sit ~1.31:1 apart and two dark steps 1.25:1. The day bar separates its segments with a track gap instead; §3.x should say that touching marks need a gap or a non-consecutive selection | `docs/product/design/tokens.json` chart-1..5; `docs/product/design/screen-05-today.md` §14.3 |
| **C35** | `ui-serif` resolves to Times outside Apple platforms, so the agent-prose face specified in `facets-and-colour.md` §5 rendered as Times in every browser. The stack now names its faces and stops at Georgia | `docs/product/design/tokens.json` `type.$meta.serif` |
| **C36** | `docs/ops/board.md` specifies “the red number” for escalation counts and “a red chip says why”, but a lapsed lease, an overdue card and a blocked row are all **degraded** in the ratified state vocabulary. `failed` means <i>this broke</i>; red for escalation makes a busy board a red board | `docs/ops/board.md:102`, `:76`; `design-system.md` §2.1 |
| **C37** | `daily-flow-spec.md` §3 says `board.yaml` gains `blocked_by_task` and `blocked_by_task_open`; neither column exists. Today and the Board both already draw the string they would carry | `seed/queries/board.yaml`; `daily-flow-spec.md` §3 |
| **C38** | ~~The board column is labelled “Addressed To” while its wire value is `assigned`.~~ **CLOSED 2026-09-20** by the owner: the column is now **Assigned**, matching the value. A label that disagrees with its own value is a bug waiting for someone to fix the wrong side of it | `docs/ops/board.md:34` |
| **C39** | Two owner rulings edit `docs/ops/board.md`: the column reverts to **Assigned** (reversing the 2026-09-17 label ruling), and **Reported folds into Done** as a card facet — which `board.md` already half-argues, since Done-vs-Reported “is not on the row, it is reconstructed”. The board is five columns | `docs/ops/board.md:34`, `:44` |
| **C15** | `design-system.md` §3.1's own body says the Mac sidebar rows carry "an optional count badge — shown only when the count is *actionable*", which contradicts the "only badge" rule three paragraphs later | `design-system.md:500` (§3.1) |
| **C40** | `accept_with_changes` on an `access_request` validates only that the revised area is a *valid grant shape*, not that it sits at or below the area that was asked for — so the wire would apply a **widening** through the Revise gesture. Ruled 2026-09-20: the control can only grant less, and the endpoint should refuse more | `apps/console/src/server.ts:1389`; `docs/product/design/screen-03-needs-you.md` §9.3 |
| **C41** | `widenedGrants` sets tier `folders` unconditionally, so approving an area for an agent at tier `titles` is a **loss as well as a gain**: it stops browsing every title in the vault and sees titles only inside its prefixes. The grant model has one tier, so "browse everything plus read one area" is not expressible. Nothing in the payload flags the trade; the card derives it from `current_scope` | `apps/console/src/agents.ts:616`; `packages/core/src/access.ts:1038` |
| **C42** | The escalation ladder's third rung is enforced at the tool: after two declines `request_access` refuses outright, so an agent that has hit the ceiling produces **no row the owner ever sees**. Same shape as the invisible successful collector pass — it belongs on Agents, not in the queue | `packages/mcp-brain/src/access.ts` `MAX_DECLINES`; `screen-02-activity.md` §6.5 |
| **C43** | `plan-tomorrow` records a `routine_run` row and writes `Journal/Plan/<date>.md`, and `activity_feed`'s runs branch admits seven kinds plus failed `collector_run` — **`routine_run` is not among them**, and there is no artifacts or vault-write branch, so the day's plan and the standup draft are invisible on Activity. Ruled 2026-09-20: `routine_run` joins the union with its own `routine` group and an eighth chip | `seed/queries/activity_feed.yaml`; `routines/plan-tomorrow/run.ts:71` |
| **C44** | `lib.py` defines `OB_L`/`OB_D` twice (1121, 1753) and `sidebar8` twice (1520, 1829). The later definition silently wins, so an edit to the earlier one has no effect — a trap for the next session, not a rendering fault | `docs/product/design/boards/lib.py` |
| **C45** | **A failed consequential operation leaves the request pending**, and nothing in the design system says so. An `action` that throws writes `payload.error` and the row stays pending — *"one action is one service call, so nothing is half-applied"*, with deliberately no retry — and an access refusal does the same. Drawn twice as if it were a per-screen detail; it is a rule about how this product fails and belongs in §2 beside the four states | `docs/ops/actions.md` "Routes and record"; `apps/console/src/server.ts:1380`; `screen-07-agents.md` §7 |
| **C46** | The **effective** autonomy table exists in `packages/core` and nowhere in the interface. `metistry agents autonomy` resolves it; the console has no notion of it, so a console showing `agents.autonomy.actions` would disagree with the CLI about what an agent may do — and the console would be wrong | `packages/core/src/actions.ts` `effectiveActions`; `docs/ops/actions.md` |
| **C47** | `effectiveActions` returns the resolved mode and **drops the reason**, so every surface recomputes *defaulted* (from `ACTION_DEFAULTS`) versus *clamped* (from `LEVEL_CEILING`) to tell the owner which one they are looking at. Those two must not read alike: clamped is the only case where the owner's own setting is being overridden. One return-type change would stop three surfaces guessing | `packages/core/src/actions.ts`; `screen-07-agents.md` §3.2 |
| **C48** | **Round C's `stale` is drawable on no existing query, four rounds after it was specified.** *Is `github-state` still current* needs a per-collector last-ok time: `agent_presence` has no collector notion, and `activity_feed` takes `collector_run` only `WHERE ok = false`, so a healthy collector is invisible in both. It was parked on Knowledge and Agents; Agents cannot answer it either | `seed/queries/agent_presence.yaml`; `seed/queries/activity_feed.yaml`; `screen-02-activity.md` §6.5 |
| **C49** | **Only one of the three border tokens clears 3:1, and it is not the one whose name says so.** Measured against all four grounds in both themes: `border-control` **3.00–3.91:1** everywhere; `border` **1.12–1.51:1**; `border-strong` **1.60–2.08:1**. So `border-strong` can never outline a control or carry a mark, though its name implies it is the heavier, more visible one — it is a heavier *divider* only. Four faults in this engagement come from that misreading, two of them in round E alone (a presence dot at 1.75:1, a model chip at 1.32:1), both caught by the contrast pass rather than by the eye. The rule the system is missing, and it is mechanical: **`border` divides, `border-control` outlines a control, and a mark that carries meaning takes an ink token — never any border token.** Renaming `border-strong` to say what it is would end the fault class | computed, `docs/product/design/tokens.json`; `boards/lib.py` `presdot`, `modepip`, `chatcomposer` |
| **C50** | **The nav is eight rows.** C30 ratified seven (Today · Chat · Activity · Work ▸ · Knowledge ▸ · Agents, then Pinned) on the argument that Today stopped being a view of Work. **Routines** is the same argument again: scheduled compute is not a kind of agent, it is an assignment *of* one, and *"what is Metistry running for me every day"* is a daily question a child row would bury. Ruled 2026-09-21. P6's force — same rows, same order, same names on every platform — survives; the number does not, for the second time. **See C57: it has since happened a third time** | `design-system.md` P6; `review-00-plan.md` C30; ruled 2026-09-21 |
| **C51** | ~~The canvas shows two different navs — `Today.dc.html` renders the five-row sidebar from round D.~~ **CLOSED 2026-09-22** by removing the mock rather than updating it. That window was the only thing on the board `Today-Hub` did not already supersede, and the board&rsquo;s lasting value is the vocabulary it settled — two row origins, promotion, completing, the five absences, one filter language. `lib.py` still defines `sidebar()` and `sidebar7()`, now reachable from nothing | `docs/product/design/boards/today_vocab.py` |
| **C52** | **Metis is described as an agent holding a grant that happens to cover everything.** `ASSISTANT_DEFAULT_AREAS = [VAULT_ROOT_AREA]` — the whole vault — yet `describeScope` renders it as role `assistant` with `folders: <root>`, which is the same sentence shape a delegate gets. Ruled 2026-09-21: **Metis represents the user and is unscoped because it *is* the user**; it delegates narrower work to agents that are scoped. So its reach is not a grant and must not be drawn as one — a grant implies it could be less. The asking mechanism (`request_access` for `internal` rows, `agent_grant_overrides`, migration 0023) stays meaningful only for an operator who deliberately configured it narrower | `apps/console/src/agents.ts:104`, `:424`; `packages/core/src/access.ts` `ROLE_LABEL`; ruled 2026-09-21 |
| **C53** | **The four action kinds are verbs on domain models, and nothing says so.** `dispatch`, `task_update`, `comment` and `capture` are drawn everywhere as four flat strings, when each is a verb on a model the product already names — and `comment` is one kind reaching **two** models, because `commentArgs` takes either `work_id` (a task's room) or `artifact_id` + `version_id` (a version's thread), exactly one of them. Said as **Model · Action · May**, knowledge joins the same table instead of needing a section of its own, and the confusing part disappears. The owner's user-facing words: **Allow · Ask First · Never** | `packages/core/src/actions.ts` `actionSchema`, `commentArgs`; `screen-07-agents.md` §4 |
| **C54** | **The agent hue and the neutral ink cannot be told apart in dark mode.** `#b9a2f5` against `#8b96a1` separates at **14.3 ΔE** normal-vision, under the hard floor of 15 — so any two-series mark that relies on those two inks fails for full-colour readers, not only for CVD. Found by running the palette validator on the schedule grid rather than eyeballing it. The fix generalises: **when two marks must be distinguished, use the weight channel, not two inks** — which is what the presence dots, the permission pips and now the grid all do | computed, `dataviz/scripts/validate_palette.js`; `docs/product/design/tokens.json` `agent`, `text-tertiary` |
| **C55** | **A routine's name is its directory name.** `routines/<name>/manifest.yaml` has `name` and nothing else, so what the owner reads on a schedule they check every morning is a slug chosen by whoever wrote the code. Agents already separate `id` from `display_name`; routines need the same, and the id stays the stable handle (request D10) | `routines/*/manifest.yaml`; `screen-08-routines.md` §4 |
| **C56** | **External MCP servers proxied by Metistry have no model yet, and the shape they need already exists.** The owner's intent (2026-09-22): Metistry holds credentials for servers a remote agent cannot reach, and mediates. Structurally that is a **Model** in the permissions table with one new provenance, *Through Metistry* — no new primitive. Two things the design must hold: the agent never holds the credential, so that table is the only control; and reading the owner's own vault is not the same risk as acting in a system other people watch, so a per-server grant cannot be one switch. `CLAUDE.md`'s bridge contract already supplies the behaviour — lazy tool discovery, **preview-then-confirm on destructive tools**, secret redaction by default | `CLAUDE.md` Packages; `screen-07-agents.md` §10; ruled 2026-09-22 |
| **C57** | **The nav is eight rows, and the seven-row rule has been broken twice.** Today &middot; Chat &middot; Activity &middot; Work &#9656; &middot; Knowledge &#9656; &middot; Agents &middot; Routines. C30 justified the seventh (Today stopped being a view of Work) and C50 the eighth (a routine is an assignment of an agent, not a kind of one). **Resources was briefly a ninth and moved to Settings** on 2026-09-22 — the test it failed is whether the owner goes there often, and a connection is configured once and then read from the permissions tables that grant it. Agents sits above Routines, because the reader meets the noun before the assignment. The warning stands in weaker form: two breaks used the same argument, so **a third should move something out rather than add a row** | `design-system.md` P6; C30, C50; ruled 2026-09-22 |
| **C58** | **A permissions control per cell was the wrong shape, and absence is the right one.** The Model &middot; Action &middot; May table gave every verb a row and a state control, so `Knowledge` appeared twice and most of it was furniture. One line per resource with **Read** and **Write** columns says the same thing, and **anything not listed is not granted** — which removes the state control entirely and is the honest shape, since the list of what an agent *cannot* do is infinite. The only state left is one glyph for a verb that waits for the owner | `screen-07-agents.md` §4.1; ruled 2026-09-22 |
| **C59** | **An approval that blocks cannot happen inside an unattended run.** A tool set to *Ask* is a request in Needs You, delivered by web push (`NOTIFICATION_TITLE` already maps `alert` to "Needs You"; `web-push` is already a dependency). But a routine at 6:02 AM that needs approval to comment on an issue has no one to ask: blocking leaves it half-done for hours, failing throws away work over a step that was never urgent. **The run finishes without it and reports what it skipped** — the same discipline as `later` not blocking and a failed action leaving its row pending. So *Ask* means **pause** on an agent the owner is talking to and **defer** on a routine, and a destructive tool **defaults** to *Ask* rather than being forbidden as *On* — corrected 2026-09-22: the first draft had the design overriding a deliberate choice, and the wire already shows the right shape, since `dispatch` defaults to `propose` rather than being refused | `apps/console/src/push.ts`; `screen-09-resources.md` §4; ruled 2026-09-22 |
| **C60** | **Chat may not belong in the sidebar at all.** Raised by the owner 2026-09-22 as a direction, not a decision: if Metis is the user's own reach and everything else on the nav is something it delegates to, then Chat is not a peer of Work and Knowledge — it is the surface the product *is*, and a destination you navigate away from is the wrong shape for it. A persistent pane or rail would take one row off the sidebar and change what the other rows mean. Recorded so it is not rediscovered | ruled as a direction 2026-09-22; `design-system.md` P6 |
| **C61** | **Preview-then-confirm was drawn twice and contradicted itself.** A proxied tool carried a *Previews first* mark beside its On/Ask/Off control, so a tool the owner had deliberately set to **On** still claimed it would preview. Preview-then-confirm **is** what *Ask* means — the middle state of the control, not a second marker beside it. Ruled 2026-09-22: **the owner&rsquo;s choice is the whole control.** What a tool does belongs in its description, which informs the choice instead of second-guessing it | `screen-09-resources.md` §3.2; `CLAUDE.md` Packages; ruled 2026-09-22 |
| **C62** | **Settings is a fixed, non-resizable window and Resources now lives in it.** C5 logged the conflict between that window and §6&rsquo;s Dynamic Type requirement; putting a proxied server&rsquo;s tool table there makes it concrete — a table of tool names, descriptions and a three-state control does not survive `accessibilityExtraExtraExtraLarge` in a window that cannot grow. Either Settings becomes resizable or Resources is not a Settings pane. **CLOSED 2026-09-23** by a third way: the window stays **fixed**, at 840 × 600 set by the widest pane, and **every pane scrolls vertically**, so larger text lengthens a pane and never clips it (`screen-15-settings.md`) | `apps/macos/sources/kit/settings-view.swift:47`; C5; `screen-09-resources.md` |
| **C63** | **Opacity dimming silently defeats the contrast tokens.** A read-only checkbox drawn at `opacity: 0.55` composites to **1.86:1** against `surface` — a mark carrying meaning (this row cannot be ticked) at well under 3:1, while every token in it was chosen correctly. This is the **third distinct mechanism** by which contrast has failed in this engagement: the wrong token (C49), two inks that cannot be told apart (C54), and now a correct token made incorrect by compositing. The rule: **a disabled or recessive mark takes a dimmer ink at full opacity, never a dimmed strong one** — and the contrast checker must be fed the composited value, not the token | computed; `docs/product/design/boards/today_vocab.py` |
| **C64** | **Knowledge cannot answer the question it exists to answer, and it is the fourth surface to say so.** *Is this current* needs a per-collector last-ok time. `agent_presence` has no collector notion, `activity_feed` takes `collector_run` only `WHERE ok = false` so a healthy collector is invisible, Agents sent the question here, and Knowledge owns it and still has nothing to read. Request C1 is now four rounds old. **A failed source needs two timestamps** — *failed 2 hours ago* invites the reader to think the data is two hours old, when *last succeeded 2 days ago · token expired* is what is true | `seed/queries/knowledge_pages.yaml`; C48; `screen-10-knowledge.md` §2 |
| **C65** | **The nightly digest already exists and no surface shows it.** `routines/knowledge-fold/run.ts` writes `Journal/Fold/<date>.md` from `Templates/Fold.md` — prose, in the assistant&rsquo;s own voice, as its own commit, and the one template where `{{ prose }}` is legal (D14). It is the best thing the product writes, and the only way to read it is to open Obsidian. Nothing serves it: no query returns the latest fold, and the fold&rsquo;s own wikilinks — the closest thing to *what mattered yesterday* the system has — are visible to no surface. **Request:** a named query returning the newest `Journal/Fold/` file&rsquo;s body and its outgoing links | `routines/knowledge-fold/run.ts`; `Templates/Fold.md`; D14; `screen-10-knowledge.md` §2 |
| **C66** | **An exclusion that protects one reader was applied to every reader, including the only one who can act.** `knowledge_pages` drops `status: draft` rows using the same `WHERE` clause `mcp-brain` applies, &ldquo;so the owner&rsquo;s list and an agent&rsquo;s index cannot disagree about what a draft is.&rdquo; The intent is sound — **a draft is never served to an agent** — but the owner is not an agent, and hiding a draft from them hides it from the one person who can settle it. Round E&rsquo;s first Knowledge pass repeated the query&rsquo;s logic as if it were product intent and printed *a draft is invisible to you too, and that is deliberate*; **corrected 2026-09-22**. The rule: **an exclusion must name the reader it protects**, and a query that serves the owner is not the query that serves an agent. **Request:** a drafts-for-the-owner read, or an owner flag on the existing one | `seed/queries/knowledge_pages.yaml`; `db/migrations/0009_brain.sql`; corrected 2026-09-22 |
| **C67** | **Seven of twelve canvas boards overflowed their declared frame, and it took a measurement to see it.** Each board declares `$preview` width and height and fills a fixed-size div; content taller than the declaration spills past the frame the canvas lays out to. Measured in a headless browser with metric-compatible fonts: `Request` +714, `Routines` +1283, `Today-Hub` +668, `NeedsYou` +610, `Knowledge` +539, `Agents` +465, `Chat` +376, `Activity` +56. The five boards that fit matched their declaration exactly, which is what makes the overflow readable rather than a rendering artefact. Two rounds of rationale panels were reviewed at the bottom of boards that could not show them. **The rule: a frame is measured, never estimated** — and the check belongs in the build, since a declared height is the one number in a board module that nothing else verifies | computed 2026-09-22; `docs/product/design/boards/*.py` `CW,CH`; `boards/lib.py` `wrap`, `page` |
| **C68** | **An area has no written summary anywhere, and a file count is not an answer.** Knowledge&rsquo;s browse surface asks *what is in here, roughly*, which wants one sentence per area — *Drey, the business setup, and the vendor thread you are in now*. The wire offers `knowledge_pages` grouped by derived area, i.e. a count, which answers *how much* and not *what*. The routine that can write it already exists and already writes prose (C65). **Request:** the fold, or a sibling routine, writes one line per area into the area&rsquo;s own index, and a query returns it | `seed/queries/knowledge_pages.yaml`; `routines/knowledge-fold/run.ts`; `screen-10-knowledge.md` §5 |
| **C69** | **A reply body takes a 2px `agent` rule in the gutter, and the `agent-quiet` wash stays outside the transcript.** Ruled 2026-09-22, closing the P1 deviation `screen-01-chat.md` §2.1 left open. A quote rule is the oldest mark for *these are not my words*, so **P1's “visibly quoted” is satisfied without a fill** — and it survives what a wash cannot: a reply containing a table, a diff or a card, where a nested fill on a fill stops reading as quotation at all. **The rule hangs in the gutter rather than inside the measure**: the turn's width is the measure plus the rule and its 16px padding, pulled back by the same 18px, so the prose begins on the user turn's own left edge and `--mt-reply-measure` governs the text and not the text minus a rule — verified by measurement, prose box 620px at the same x as the user bubble. The wash keeps its job everywhere agent text appears outside a transcript (a feed row, a card title, tool output, an artifact comment), which is where being mistaken for the interface costs something | `screen-01-chat.md` §2.1; `design-system.md` P1, §3.4; ruled 2026-09-22 |
| **C70** | **Translucency is the fourth way contrast has failed here, and the bar needs a measured floor.** §4.4 says “nothing here depends on a translucent ground” and C4 logged that no declared pair holds on a vibrant material — and the owner wants the floating bar to read as the OS does. Measured by compositing each ink over the scrim at every opacity against five backdrops (white, black, mid grey, deep blue, bright yellow) and taking the worst: `text-primary` needs **0.51** light / **0.65** dark, `text-secondary` **0.78 / 0.83** — the binding case — `text-tertiary` **0.77 / 0.81**, `accent` **0.66 / 0.68**, `agent` **0.71 / 0.72**. **The rule: a glass surface's scrim is never below 0.85, and the blur is decoration on top of it.** *(Refined by C74: 0.86 under text, 0.75 under marks only.)* All four failures are one lesson — wrong token (C49), two inks too close (C54), opacity on the ink (C63), translucency under it — **check the composite, never the token** | computed 2026-09-22; `design-system.md` §4.4; C4; `screen-11-capture-bar.md` §7 |
| **C71** | **A capability claim is a state claim, and the screen grant cannot support one.** PR 253 found that `SCContentSharingPicker` is a *selection* UI while `kTCCServiceScreenCapture` stays global to the binary; the brief assumed the picker was a capability fence. The design consequence is P5's, not the research's: **state is reported, never inferred**, so the bar may not draw a crossed-out eye meaning *Metis cannot see* — only *no stream is running*. Audio is the opposite: a Core Audio process tap yields only the named processes' audio (`CATapDescription.processes`, `.bundleIDs` on macOS 26), so *the system enforces this list* is a fact. **Two senses with different guarantees may not be drawn as sibling switches**, which is why hearing and seeing are separate acts with differently worded sheets, and why the resting bar shows one word instead of three negative icons (C58 again) | `docs/research/2026-09-21-live-capture-bar.md` §2.2, §7.1; `design-system.md` P5; `screen-11-capture-bar.md` §6 |
| **C72** | **The measure has a second value, and the bar is where it happens.** §2 of `screen-01-chat.md` promises the column is capped and centred so resizing never rewraps a line; the floating bar cannot hold 620px beside a meeting and runs at **328px**. Ruled 2026-09-22 rather than fudged: the promise is about **the window**, the bar shows **the tail** of the same conversation, and any reply over four lines carries **Open in Chat**. The bar is where you ask; the window is where you read. The thing to avoid is a third value appearing by accident — two is a decision, three is a drift | `screen-01-chat.md` §2; `screen-11-capture-bar.md` §4; ruled 2026-09-22 |
| **C73** | **A tint plate behind a glyph of the same hue is the C54 fault in a new costume.** The bar's first sense indicators were an `agent` microphone on an `agent` tint at 0.20 — measured **2.69:1 light / 2.60:1 dark** against their own plate, under the 3:1 a mark that carries meaning needs. Dropping the plate puts the same glyph at **3.36 / 3.43** on the thin rail glass and **4.46 / 5.07** on a panel. The rule: **a mark and the ground it sits on may not come from one hue** — either the ground is neutral or the mark sits on the surface itself. Fifth contrast mechanism found here, and the second from tinted grounds | computed 2026-09-22; `boards/lib.py` `sensepip`; C54, C70 |
| **C74** | **The glass floor follows the ink, not the object, and that is what buys transparency.** C70 set one number (0.85) for every glass surface. Measured per ink, a surface carrying only marks in `ts`, `agent` or `accent` holds at **0.75**, while text still needs **0.86** — and **`text-tertiary` needs 0.81, so it is not allowed on thin glass at all**. So the owner's *make it more transparent* is satisfiable, at a price stated in the system's own terms: **a thin surface may carry no faint ink and no small text.** That measurement, not taste, is why the resting rail is two marks and no words | computed 2026-09-22; C70; `screen-11-capture-bar.md` §7 |
| **C75** | **Motion is now a closed list of two, and the second one was admitted by C16's own test.** A recording indicator on a 30px rail cannot carry its state by numeral — at across-the-room distance neither a 14px mark nor a mono digit resolves, while **a 2.6s expanding halo is detectable in peripheral vision**. That is information the reader cannot otherwise get, so the breath is ratified *under* C16 rather than as an exception to it. Two constraints came with it: **the filled mark carries the state at all times**, so the animation is never the sole carrier and holds still under `prefers-reduced-motion`; and **the halo is exempt from 3:1** (1.68:1 at mid-frame) precisely because it is redundancy rather than meaning — the distinction C63 implies and had not yet had to state. **The list is closed at two:** a third candidate displaces one rather than joining them | ruled 2026-09-22; C16, C63; `screen-11-capture-bar.md` §3.1 |
| **C76** | **The owner's definition of a meeting inverts PR 253's phase order.** The research recommended audio first and screen *not at all for now*, because audio is the part with kernel-enforced scoping. Ruled 2026-09-22: **a meeting is a window and its sound plus your own voice**, so the headline act needs the grant with the weaker scope story (C71). Two things follow. **The build gets simpler:** `SCStreamConfiguration.capturesAudio` (macOS 13) yields the audio of whatever the filter covers, so the sound is scoped exactly as the picture is — one selection, one scope, no Core Audio tap for this case — and `captureMicrophone` (macOS 15) puts the owner's voice in the same stream, with a second session as the fallback below 15 against a 14.0 floor. **The scope story gets weaker:** *Audio only* remains the one genuinely per-process route, which is why it stays on the sheet. The sequencing is the owner's and is now a real question | `docs/research/2026-09-21-live-capture-bar.md` §2.3, §6; ruled 2026-09-22; `screen-11-capture-bar.md` §5.2 |
| **C77** | **A jot made during a session has nowhere to anchor yet.** The owner takes notes and adds to-dos while a meeting runs, and each one must end up beside what was being said when he wrote it. But `source: meeting:<path>` names a file that **does not exist until the session ends and the proposal is approved** — so at write time the only stable anchor is **the session id plus the offset in seconds**, and the proposal has to rewrite those anchors to the vault path when the file lands. Nothing in the daily-flow vocabulary covers a source that is promoted from a session to a path. The design draws it as one arrival in Needs You — draft, transcript and jots together — which is also the moment the rewrite can happen | `docs/product/daily-flow-spec.md:140,247`; `screen-11-capture-bar.md` §5.1 |
| **C78** | **The transcript is deliberately a cache, and the owner needs it to be a record.** `apps/assistant/src/sessions.ts`: *“Deliberately not a transcript archive: the row is what the next turn replays, trimmed to a cap”*; the system prompt is excluded; `rollSession` ends it at task boundaries so *“a task boundary must not leave a replayable transcript behind.”* `runs` stores measures, and its tool-call join carries name, ok, error and duration — no arguments, no results. Ruled 2026-09-22: sessions are kept so Metistry can fold them into knowledge and learn the owner's preferences. **The two are reconcilable:** cost decision 3 forbids *replay*, and an archive the engine only ever reads does not replay. Build ask: a read-only session archive, every session including chat, with the system prompt as sent and each tool call's arguments and result; retention **30 days** (ruled 2026-09-22), outside git — where is the developer's call, the owner leaning to a file cache under `.metistry` — and the fold must run before a session expires. `shadow_transcript` already proves the shape for shadowed turns | `apps/assistant/src/sessions.ts:1-14`; `packages/core/src/session-roll.ts`; `seed/queries/run_detail.yaml`; ruled 2026-09-22 |
| **C79** | **What Metis learns about the owner changes how Metis behaves, so it is always a proposal.** `Me/Working Style.md` is included word for word into prompts and `Me/profile.md` gates the daily-flow routines; both are `source: user` and both say *“Metistry discovers these facts from you”* — and nothing does the discovering. The session fold is that mechanism, and invariant 2 decides its shape: a learned preference, profile fact or lesson arrives in Needs You, and accepting writes the owner's words into the owner's file. One writer per file holds because Metis never writes either file; the owner's approval does | `seed/vault/Me/profile.md`; `seed/vault/Me/Working Style.md`; `CLAUDE.md` invariant 2; `screen-12-run-detail.md` §2 |
| **C80** | **`action` is shown to the owner as *note*.** `pending_requests.yaml` (and `requestType` in `routines/morning-brief/run.ts`) maps `action` — an agent asking to dispatch, update a task or comment (C53) — onto *note*. An agent asking to act is not a note. Ruled 2026-09-22: **action** becomes the seventh word the owner reads (question · access · action · improvement · note · report · review); the query, the brief's mapping and `docs/product/glossary.md` change together so all three keep saying the same word | `seed/queries/pending_requests.yaml:72-81`; `routines/morning-brief/run.ts:72`; ruled 2026-09-22 |
| **C81** | **Proposals have no group, and a meeting is several decisions that arrive together.** Notes, extracted to-dos and the transcript land as unrelated rows. Design: one card per meeting; **Accept All sends one approval per item in order**, never a batch, because `POST /api/proposals/batch` refuses Approve on purpose (each approval has a per-kind consequence) and a sequence of single approvals keeps every consequence and every receipt. Build ask: a group id per session on `proposals`, which is also where C77's session-time anchors are promoted to the note's path. The owner's own jots are not proposals — they are his words and skip the queue | `apps/console/src/server.ts` `BATCH_DECISIONS`; C77; `screen-03-needs-you.md` §10.3 |
| **C82** | **Two things are called Projects.** `projects_overview` is a per-**area** rollup of `work.area` that feeds the dashboard's *Projects* panel and the morning brief's *Projects* section; `projects_rollup` reads the `projects` table (0011), which has a mode, a budget, a cap and members. Same word, two groupings, and only one of them has controls. Recommendation: the area rollup and its surfaces are renamed **Areas** | `seed/queries/projects_overview.yaml`; `seed/queries/projects_rollup.yaml`; `db/migrations/0011_projects.sql` |
| **C83** | **Review mode is coloured as a fault even when the owner chose it.** `design-system.md` §3.12 gives `review` the `presence-blocked` colour in every case. A mode the owner switched on is a decision, not a failure, so it takes the **weight** channel (a heavier outline); only review **forced by the budget** is a fault and takes the tint. Needs the rollup to return *why* a project is in review | `design-system.md` §3.12; amendments §1.1; `screen-13-projects.md` §1 |
| **C84** | **The same click went to two places.** `screen-06-board.md` §3 opened a card's room when `has_thread` and a detail popover otherwise, so one gesture landed in different places depending on a flag the card did not show. Ruled 2026-09-22: **every click opens the popover**, and the thread is a section inside it with *Open room* | `screen-06-board.md` §3; `screen-14-card-detail.md`; ruled 2026-09-22 |
| **C85** | **A work row has no description.** `work` carries a title, status, owner, due, lease, `depends_on`, `meta` and an append-only `history`, but nowhere to say what the task is about, so context ends up crammed into titles. A markdown task has its note around it; a work row has nothing. Ruled 2026-09-22: work rows gain a short description, set by whoever creates the row and editable by the owner | `db/migrations/0001_init.sql` `work`; `screen-14-card-detail.md` §1; ruled 2026-09-22 |
| **C86** | **The Resources board drew a Settings window that does not exist.** Its section list — General, Compute, Knowledge, Resources, Notifications, Advanced — was invented; the app has Instance, Services, Connections, Compute, Secrets, Updates, Advanced (`SettingsModel.Section`). Found while drawing the window itself and corrected on every board that draws Settings. Also ruled: *Connections* becomes **Account**, because it held sign-in and the instance repository and read as a sibling of Resources | `apps/macos/sources/kit/settings-model.swift:55-89`; `screen-15-settings.md` §1 |
| **C87** | **The light chart ramp reads nearly gray.** Run through the dataviz validator against `elevated`, every light step of `chart-1`…`chart-5` sits under the 0.10 OKLCH chroma floor (0.069–0.089); the dark steps pass. Contrast passes in both modes, so a single series is legal, and the tokens say the ramp is never for identity — but a light-mode chart will look muted beside the rest of the palette. Recommendation for the token owner: raise light-ramp chroma toward 0.10 keeping lightness monotonic | computed 2026-09-23, `dataviz/scripts/validate_palette.js`; `tokens.json` `chart-1`…`chart-5` |
| **C88** | **The assistant had five names on screen.** `ASSISTANT` (Chat, Today), `METIS` (Run detail), `METIS WROTE THIS` (Activity, Knowledge), `METIS SUGGESTS` (Routines), and actor chips flipping between `metis` and `assistant` on one board. Ruled 2026-09-23: **every label that attributes words or acts to the assistant shows the name the owner configures**, default *Metis*; *assistant* stays the role in the glossary and never appears as a label. Build ask: the name is an instance setting (Settings ▸ Instance), served with the session so every surface reads one value | review-01 R1, ruling 1; ruled 2026-09-23 |
| **C89** | **Round E drew Rooms as a Work child, against ratified ruling 4.** Ruled 2026-09-23: **ruling 4 stands.** There is no Rooms list and no Rooms row. A thread lives where its subject lives — card detail (C84) and the artifact margin — and Board gains a **Has Thread** filter. *Open Room* from a card opens the thread as a pane over Board, with Board still selected in the sidebar | review-00 Ratified #4; `screen-16-artifacts-and-rooms.md` §2; ruled 2026-09-23 |
| **C90** | **Metis may move a meeting that has other people in it, and warns first.** `screen-05` §14.5 said it stops one step short; the Today board offered *Move The Vendor Sync* outright. Ruled 2026-09-23: the move is allowed, **behind a confirmation that names who will be told and the new time** — neutral, not tinted, because moving a meeting is not a fault. A meeting with only the owner in it moves without the warning. **The calendar sends the update, not Metistry**, so `ACTION_KINDS` still sends nothing. Build ask: a calendar-move action whose preview returns the attendees | `screen-05-today.md` §14.5; Today-Hub board; ruled 2026-09-23 |
| **C91** | **A meeting transcript had two retentions.** Live Capture said *90 minutes, then gone*; the meeting card and C78 said 30 days. Ruled 2026-09-23: **30 days from the end of the session**, the same as every session | `screen-11-capture-bar.md`; C78; ruled 2026-09-23 |
| **C92** | **Needs You spoke louder than failures do.** Filled green Approve and filled red Decline on every card, while amendments §1.1 gives red to *failed*. Ruled 2026-09-23: **Approve is the one accent-filled button; Revise and Decline are outlined; a filled destructive button appears only for an act that cannot be undone.** Supersedes round B's *Approve is affirmative green*. Order, everywhere a request or proposal is answered: **Approve · Revise · Decline**, then *Later*; *Skip* only in bulk (closes the four-way disagreement across components-01 §2.4, screen-03 §10.1, glossary and design-system §3.9) | `components-01-states-and-request.md` §2.4; `screen-03-needs-you.md` §10.1; ruled 2026-09-23 |
| **C93** | **Permissions had three vocabularies.** *Allow · Ask First · Never* (C53, amendments §4), *On · Ask · Off* (Resources, C61), *Asks you first* (table legends). Ruled 2026-09-23: **On · Ask · Off** everywhere a permission is set or shown. C53's model is unchanged; only its words | amendments §1.1, §4; `screen-07-agents.md` §10; ruled 2026-09-23 |
| **C94** | **Project modes had two names.** Glossary *Auto / Supervised*; screen 13 and C83 *Autonomous / Review*. Ruled 2026-09-23: **Autonomous / Review**. The glossary is updated; `PRODUCT.md`, `design-brief.md`, `app-ux-plan.md` and `design-system.md` §3.17 still say Auto / Supervised — the owner's files, flagged here, not edited | `glossary.md`; `screen-13-projects.md`; ruled 2026-09-23 |
| **C95** | **An expired credential was red on two screens and amber on two.** Ruled 2026-09-23: it is **`failed`** — nothing that depends on it works — and it always carries both timestamps (*last succeeded 2 days ago · token expired*, C64) | Activity, Knowledge, Resources, Settings; ruled 2026-09-23 |
| **C96** | **Events that need the owner never reached the one place he looks.** A budget stopping compute, an expired credential, a failed routine and a knowledge conflict each showed only on its own screen. Ruled 2026-09-23: **each becomes a Needs You request** — budget stop and failed routine as `report`, expired credential as `access`, knowledge conflict as `review` — and the screen it came from keeps showing it too. P2 is unchanged: still one badge | `screen-10` §3, `screen-17` §2, `screen-09`; ruled 2026-09-23 |
| **C97** | **By 7am there were four machine documents under three names.** *Tomorrow's Plan*, *Standup Draft*, *Morning Digest* and *Morning brief*, contradicting each other. Ruled 2026-09-23: **one morning brief, and it is Today at first open** — the plan and the standup are its sections, the message links there, and the brief writes a machine-owned file, never the owner's daily note | Routines, Today-Hub, RunDetail, Activity boards; ruled 2026-09-23 |
| **C98** | **A task list you cannot tick is only ever read.** Every Today checkbox was read-only in phase 1, sending the owner to Obsidian for the first act of the day. Ruled 2026-09-23 as **a key feature**: the check route (daily-flow P2-3) moves into phase 1, and a checkbox on Today, Board and card detail ticks the task in its own file | `daily-flow-spec.md` §11; Today board; ruled 2026-09-23 |
| **C99** | **Ticking a task asks for no confirmation — ratified 2026-09-25.** `screen-05-today.md` §5 put a confirm dialog in front of the check route because it writes the owner's file. With C98 making the tick a key daily act, the dialog guards nothing: the route changes two bytes, Undo is a second mechanical write, and a line edited meanwhile is refused (409). Drawn as **one click, a receipt naming the file, Undo** | `screen-05-today.md` §5, §15.4; C98 |
| **C100** | **A module constant silently shadowed another and turned the day bar grey for two rounds.** The Usage popover declared `CHART_L`/`CHART_D` as single hexes after the day bar's four-step ramps of the same names; the day bar then indexed a string. Nothing failed — the bar rendered as an empty track. Renamed to `USAGE_L`/`USAGE_D`. **A board library is one namespace: grep a name before declaring it** | `boards/lib.py`; found 2026-09-24 |
| **C101** | **Close the Day writes into the vault, not app state — ruled 2026-09-25, closing B4.** B4 offered app state keyed by `task_key` so no markdown was touched. The owner ruled the choices persist to **the daily note, the next day's plan and knowledge**, with **no separate close file** (a `Journal/Close/` file was drawn and withdrawn the same day). Writes: the daily note's Metistry section (C102); `⏳ <date>` or `#someday` on each deferred line by a **schedule route** (one field, 409-guarded, the check route's sibling); `Journal/Plan/<tomorrow>.md` by `plan-tomorrow`, now triggered by the close; the fold's proposals to people pages. Build asks: the schedule route, the section writer, a close trigger on `plan-tomorrow` | `today-hub-requests.md` B4; `screen-05-today.md` §15.5.1; ruled 2026-09-25 |
| **C102** | **Metistry now writes into the owner's daily note — inside a fenced section only. Ruled 2026-09-25, reversing a rule held since round D.** R1.9, C97 and amendments §8.5 all said Metis never writes the daily note. The owner wants the note kept up to date instead of a second file. One writer per file becomes **one writer per region**: Metistry owns the text between `<!-- metistry:day -->` markers and nothing else; the owner owns the rest. Broken markers stop the write and raise a request rather than guessing. Also ruled: **owed-to-people items are tasks**, tickable, with a person facet — not a separate list | `screen-05-today.md` §15.5–15.5.1; `CLAUDE.md` one writer per file; ruled 2026-09-25 |
| **C103** | **Generated prose is allowed outside fold templates — ruled 2026-09-25, closing A5.** §6.2 of the daily flow limited `prose` to fold templates. The Morning Brief, Next Up's one line and calendar help all generate prose on Today. It stays inside the agent container, attributed, marked *written, not retrieved*, and rateable (B7); its cost appears in Usage like any turn | `today-hub-requests.md` A5; `daily-flow-spec.md` §6.2; ruled 2026-09-25 |
| **C104** | **`decision` means two things.** It is the proposals kind for a blocking question (`decision-block.ts`, `drain.ts`, `budgets.ts`) and one of `requests_create`'s four report kinds (`finding · decision · gotcha · progress`), where it means *a decision was made*. A word that names both *asking* and *having decided* will be misread by the first agent that uses it. Recommendation: the report kind becomes `decided` | `packages/mcp-brain/src/report.ts:11`; `packages/core/src/decision-block.ts` |
| **C105** | **A question's options are the only answers the server accepts — but the owner wants to answer in his own words.** `decision-block.ts`: *"the options are the ONLY answers the server will later accept."* Chat already settles a question with free text (`server.ts:630`), so the rule holds in one surface and not the other. Ruled 2026-09-25 by design: every question ends in *Something else…* and every request has Revise, both free text, stored as such. The safety the rule bought — a model cannot plant an executable answer — is kept, because no answer is executable either way | `decision-block.ts`; `server.ts:630`; `screen-03` §12.3 |
| **C106** | **Pull requests are collected but never asked, and threads are not collected at all.** `github-state` marks `needs_my_review` and `prs_for_review` returns it; nothing raises a request, no agent can ask for a review, and review comments never leave GitHub. Build ask: a `pull_request` request kind from both sources, and thread collection | `collectors/github-state/run.ts`; `seed/queries/prs_for_review.yaml` |
| **C107** | **Reviewing in Metistry needs a write token the collector deliberately lacks.** `github-state` uses a *fine-grained read-only PAT*. Ruled 2026-09-25: approve, request changes, comment and reply happen in Metistry and post as the owner — so a **separate** write credential is held in Resources and used only by owner-only routes, each checking the head SHA the card showed. The collector keeps its read-only token; no agent gains a GitHub verb | `collectors/github-state/run.ts:1-6`; `screen-03` §12.4; ruled 2026-09-25 |
| **C108** | **Collectors "never invent" — and now they raise requests.** `github-state`'s manifest: *"collectors reconcile status from the source; nothing invents it."* Ruled 2026-09-25 that Needs You is the hub for what collectors pick up too. Reconciled rather than contradicted: a collector raises a request **only when the source itself names the owner** (requested reviewer, invitee, assignee), and the request **mirrors** that state — it clears when the source clears. Anything inferred (an email that seems to want a reply) is raised by Metis, as Metis, and says it is inferred. Build ask: a needs-you rule per collector manifest, `source {kind, external_ref, person}` on requests, dedupe on `external_ref` | `collectors/github-state/manifest.yaml`; `screen-03` §12.7; ruled 2026-09-25 |
| **C109** | **The Needs You panel ran out of room, and the fix is a view, not a bigger panel.** Ruling 13 (2026-09-18) made Needs You an opaque 400px panel; §3.18 and screen 3 built on it. By v4 it held questions, diffs, threads and meetings, and the owner found it *cramped and too vertical*. Ruled 2026-09-25: **the bell toggles a full list-and-detail view in the main area**, with no sidebar row (the eight rows stand) — the bell shows pressed, the sidebar shows no selection, and the title bar leads back to where you were. Questions step one at a time. Supersedes ruling 13 on the Mac; the phone keeps its sheet | review-00 Ratified #13; `screen-03-needs-you.md` §13; ruled 2026-09-25 |
| **C110** | **Needs You is a conditional sidebar row — ruled 2026-09-25, revising C109 the same day.** The toggle left the sidebar with nothing selected. Ruled: a **Needs You** row with the bell, **above Today, present only while something is waiting**, carrying the count as the one badge; the Mac toolbar loses its bell. The eight-row rule (C57) holds in its empty state and is broken only while there is something to do — which is the one time a ninth row earns its place. Build: the sidebar observes the pending count; the row is removed on the next navigation after it reaches zero, never while the owner is on it | `screen-03-needs-you.md` §13.3; C57, C109; ruled 2026-09-25 |
| **C111** | **Standup and Tomorrow's Plan are routines of their own — ruled 2026-09-25, revising C97.** C97 folded both into the one Morning Brief as sections, and screen 8 §5.5 hid the defaults as *built-in*. Ruled: **Standup** is an ordinary routine (working days 6:00 AM, before the brief), writing `Journal/Standup/<date>.md`; **Tomorrow's Plan** likewise. The brief still is the one morning surface — it *presents* the standup's file in its Standup section with Copy, and never drafts it. The routines Metistry ships with are attributed to **Metis**, tagged **default**, fully editable, and carry **Reset to Default**; *built-in* is retired as a label. Build: a `standup` routine in the instance's `routines/` with its task and `Templates/Standup.md`; the brief reads that file | `screen-08-routines.md` §10; C97, C55; ruled 2026-09-25 |
| **C112** | **Every scheduled thing is visible and editable — ruled 2026-09-25.** Collectors ran on schedules the owner could not see (`github-state` every 15 min, `devin-sessions` every 5, `aws-costs` every 6 hours). Ruled: Routines has two tabs, **Routines** and **Sources**; a source shows what it reads, its cadence (5 min · 15 min · hour · 6 hours), when it last succeeded, and **what may reach Needs You** as toggles (C108). Pause and Check Now on each. Sources read and never write notes; credentials stay in Settings › Resources. Build: collector cadence and raise-rules move from code to instance config the app can write | `screen-08-routines.md` §10.3; C96, C108; ruled 2026-09-25 |
| **C113** | **Scheduled, with Routines and Syncs — ruled 2026-09-25, revising C112 the same day.** *Sources* mixed three ideas (a service, its key, and a schedule). Ruled: the sidebar row **Routines** is renamed **Scheduled**, with two tabs. **Routines** is work Metis or an agent does. **Syncs** are scheduled reads from one connection; a sync never writes back and holds no key — it names its connection and that connection's secret. The housekeeping collectors (`inbox-drain`, `claude-usage`) read no connection, so they are **default routines** (Inbox Sort, Usage Rollup) in a *Throughout the day* band. Open: the capture picker also labels the do-date facet *Scheduled* (`lib.picker`); propose **Do Date** there, so one word means one thing (§8) | `screen-08-routines.md` §11; C111, C112; ruled 2026-09-25 |
| **C114** | **Connection is the one noun for anything outside Metistry — ruled 2026-09-25.** Resources (MCP servers), targets (`devin-sessions`, `github-issues`, `local-crew`) and the services collectors hit were three names for one thing. Ruled: a **connection** has a type — **MCP server · Agent (A2A, ACP) · API · Feed · Files** — and may speak more than one (Devin is MCP and API). What it may do is set **per tool**, grouped **Reads · Changes things · Starts an agent**, each On · Ask · Off, because a type does not say (Devin's MCP starts sessions). *Resource*, *target* and *source* are retired as UI words. Settings › Resources becomes **Settings › Connections**. Build: seed the group from MCP tool annotations (`readOnlyHint` → Reads; otherwise Changes things); *Starts an agent* is set by the connection's definition or the owner | `screen-09-resources.md` §10; C56, C57; ruled 2026-09-25 |
| **C115** | **Any connection can be offered to agents through Metistry's MCP proxy — ruled 2026-09-25.** A resource was a proxied MCP server. Ruled: **Offer to agents through Metistry** is one switch on every connection. The proxy speaks MCP to agents and each connection's own protocol behind it; an API, a feed or a folder gets **tools Metistry generates** (a feed: `list_items`, `get_item`, `search_items`). Each call is checked against the agent's grant, has its secrets filled in, and is logged in Activity; the agent never reaches the service or holds its key. Off, only Metistry uses the connection (Metis, syncs) | `screen-09-resources.md` §10.3; C114; ruled 2026-09-25 |
| **C116** | **Secrets are a Settings pane, per instance, referenced as `{{ secret.name }}` — ruled 2026-09-25.** Keys were environment variables with two scopes (This Mac, This instance) the owner had to understand. Ruled: **Settings › Secrets**, stored in the Keychain, **per instance only**, a value never shown after save. Each secret lists **Sent only to** (hosts it may reach) and **Who may use it** (On · Ask · Off per connection and agent). A model never sees a value: Metistry fills it in on the way out. **An agent that runs on this Mac gets a granted secret as an environment variable**, and its transcript shows the name, not the value. A failed or expired secret raises **one** Needs You request naming everything it stopped. Metistry's own secrets (database, bridges, owner door) are listed, rotate-only. Build: `SECRET_SCOPES`' user scope collapses into instance; manifests' `env:NAME` becomes `{{ secret.name }}` | `screen-19-secrets-variables.md`; C95, C96; ruled 2026-09-25 |
| **C117** | **Variables are shared plain values, `{{ variable.name }}`, usable anywhere — ruled 2026-09-25.** Ruled: **Settings › Variables** holds values reused across routines, syncs, connections and agents (`standup_time`, `work_repos`, `devin_org`, `timezone`). They may appear in an agent's instructions, which secrets may not. A value that looks like a key is caught at save with **Store as Secret** | `screen-19-secrets-variables.md`; C116; ruled 2026-09-25 |
| **C118** | **A known service asks for names; anything else is configured by how Metistry reaches it — ruled 2026-09-25.** Key and Organization fit services Metistry understands, not an arbitrary server. Ruled: a **known service** (GitHub, Devin, Jira, Linear, Sentry…) shows only its named fields, plus a closed **Extra headers and parameters**. A **custom** connection is configured by how it is reached. **HTTP** (MCP, A2A, API, Feed, a web page): URL, query parameters, authentication (None · Bearer · Basic · API Key · OAuth — a shortcut that writes the header), headers, and timeout, certificates, network. **Command** (MCP, ACP): command, arguments, folder, environment, runs on this Mac or in a container. **Path** (Files): folder or file, include and skip patterns, watch. Every value takes text, `{{ secret.x }}` and `{{ variable.x }}`; names are plain. **What it sends** previews the resolved request with secrets masked. A secret headed for a host outside its *Sent only to* list is flagged on its row and blocked in the preview until that host is allowed; a secret typed into a URL is flagged, because URLs end up in logs. Build: bridges' `transport: http | stdio` and `runs_on: host | container` are the HTTP and Command forms | `screen-09-resources.md` §10.5; C114, C116; ruled 2026-09-25 |

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
| Logged 39 contradictions (C1–C39), none edited | `CLAUDE.md`: "Report contradictions, don't route around them" |
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
C13, C14, C15, C16, C17, C18, C19, C20, C21, C22, C23, C24, C25, C26, C27, C28, C29, C30, C31, C32, C33, C34, C35, C36, C37 and C39 remain open; **C38 is closed**** and are build-side fixes, not design ones. *(Status as of 2026-09-18. Rows ruled or closed since say so in the row itself — C16, C62, C69, C72, C75, C76, C78, C80, C84, C85 and C88–C98 among them; C99–C112 are ruled in their rows.)*

---

## Ratified — 2026-09-23 (review 01)

All eleven of `review-01-holistic.md` §1 answered by the owner; logged as
**C88–C98**. Every improvement in review 01 §5 was adopted. **The iPhone and PWA
designs are deferred** by the owner; R2.1 waits for him.

| # | Decision | Row |
| --- | --- | --- |
| 1 | The assistant is labelled with **the name the owner configures** (default Metis) | C88 |
| 2 | Ruling 4 stands — **no Rooms list**; Has Thread filter; thread pane from the card | C89 |
| 3 | Metis may move meetings with others in them, **warning first** | C90 |
| 4 | Transcripts kept **30 days** from session end | C91 |
| 5 | **Approve accent-filled, Revise and Decline outlined**; order Approve · Revise · Decline | C92 |
| 6 | Permissions read **On · Ask · Off** | C93 |
| 7 | Project modes **Autonomous / Review** | C94 |
| 8 | An expired credential is **failed** | C95 |
| 9 | Owner-relevant events **become Needs You requests** | C96 |
| 10 | **One morning brief**, on Today | C97 |
| 11 | **Ticking tasks in the app** in phase 1 — a key feature | C98 |
