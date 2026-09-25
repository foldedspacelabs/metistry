# Design system — amendments

**What rounds C–E established, as rules rather than as findings.**

`review-00-plan.md` holds 98 contradictions. That file is a *log*: it records what
disagreed with what, in the order it was found, and it is searched rather than
read. This file is the other half — the **positive statements** those findings
produced, organised by when you need them. Every rule here was paid for by a
specific fault, and the contradiction number is the receipt.

`design-system.md` was not updated for v0.11.0 (C26) and still describes a
six-section sidebar. Where this file and that one disagree, **this one is newer**.

---

## 1. Colour, and the four ways it has gone wrong

### 1.1 The three channels never borrow from each other

| Channel | Carries | And nothing else |
| --- | --- | --- |
| **Hue** | *what kind of thing* this is | never *which one*. No per-agent, per-project or per-series hues |
| **Weight / fill** | *how much it matters*, or how much room it has | priority; permission modes; presence |
| **Tint** | *something is wrong* | the four states, and nothing that is merely notable |

Two consequences that keep coming up:

- **Presence gets colour only where something is wrong.** `agent_presence`
  computes five states; `working`, `queued` and `idle` take none, because none of
  them is a fault. Five colours on a roster is a roster where colour has stopped
  meaning anything.
- **A permission is not a moral position.** `On` / `Ask` / `Off` are
  drawn in weight, never green-for-yes and red-for-no. Red is spoken for by
  `failed`.

### 1.2 The border tokens, settled by measurement (C49)

Against all four grounds, both themes:

| Token | Range | What it may do |
| --- | --- | --- |
| `border-control` | **3.00–3.91:1** | outline a control. The only one that clears 3:1 |
| `border` | 1.12–1.51:1 | divide regions of one surface. Nothing else |
| `border-strong` | 1.60–2.08:1 | a heavier divider. **Not** a control outline, despite the name |

**A mark that carries meaning takes an ink token, never a border token.** Four
faults in this engagement came from reading `border-strong` as "the visible one".
Renaming it would end the class.

### 1.3 Two marks are distinguished by weight, not by two inks (C54)

The agent ink and the neutral ink separate at **14.3 ΔE** in dark mode — under the
hard floor of 15, which means indistinguishable *even with full colour vision*, not
only under CVD. Filled-versus-outlined carries such a distinction instead: the
presence dots, the permission pips and the schedule marks all do it that way.

**Run `dataviz/scripts/validate_palette.js` on any new pair of marks.** It found
this; no amount of looking would have.

### 1.4 Opacity dimming defeats the tokens (C63)

A read-only checkbox at `opacity: 0.55` composites to **1.86:1** against
`surface` — a mark carrying meaning, far under 3:1, with every token in it chosen
correctly. **A disabled or recessive mark takes a dimmer ink at full opacity**, and
the contrast check must be fed the composited value rather than the token.

### 1.5 A glass surface has an opacity floor: 0.86 under text, 0.75 under marks (C70, C74)

Translucency changes the ground under the ink, so a correct token composites to an
incorrect ratio — the same class of fault as dimming the ink (§1.4), from the other
direction. Measured across five backdrops, the binding case is **secondary text in
dark mode at 0.83**, so:

**The floor follows the ink, not the object (C74):**

- **Glass carrying text: 0.86.** Secondary ink in dark mode binds it at 0.83.
- **Glass carrying only marks in `text-secondary`, `agent` or `accent`: 0.75.**
- **`text-tertiary` needs 0.81 and is therefore not allowed on thin glass at all.**

So a surface may be made more transparent by giving up its faintest ink — which is
the honest price, stated in the system's own terms. This is the only sanctioned
exception to §4.4's "nothing here depends on a translucent ground", and it exists
because the floating bar must read as part of macOS.

**A mark and its ground may not come from one hue (C73).** An `agent` glyph on an
`agent` tint measured 2.69:1 against its own plate; the same glyph on the surface
itself clears 3.36:1. Either the ground is neutral or the mark sits on the surface.

Five mechanisms have now defeated the tokens: the wrong token (C49), two inks too
close (C54), opacity on the ink (C63), translucency under it (C70), a tint plate
behind a same-hue mark (C73). One lesson: **check the composite, never the token.**

### 1.6 The thinnest margin in the system

`text-tertiary` on `sunken` is **4.53:1** light. It is used for every section
label, band header and column head. It passes, and it fails the moment either
token moves. Anything that changes those two values needs a full re-check, not a
spot one.

### 1.7 Check against the ground it actually sits on

Almost every colour fault in this engagement was a token used against a ground it
was never computed against. `tokens.json` plus
`ops/scripts/build-design-tokens.mjs --check` covers 144 declared pairs; round E
checked a further ~330 undeclared ones by hand. The undeclared ones are the risk.

---

## 2. States

### 2.1 Four states, and a fifth with an instance

`empty` · `absent` · `failed` · `stale`, plus **`partial`** — proposed in C28 and
given its first real instance in round E: `knowledge_files.status = 'conflict'` is
a row whose *path* is a fact and whose *title and mtime are not yet*. Not `failed`
(nothing broke), not `absent` (the file is there), not `stale` (not about age).

**Recommended for ratification** on that basis.

### 2.2 Stale annotates; it never replaces

The three others replace the content, because nothing true can be shown in its
place. `stale` shows the last true value with its age beside it. Hiding a number
because it is old is the lie.

### 2.3 A failed thing needs two timestamps

*Failed 2 hours ago* invites the reader to believe the data is two hours old.
*Last succeeded 2 days ago · token expired* is what is true. One timestamp is a
quieter lie. (C64)

### 2.4 A failed consequential operation leaves the request pending (C45)

An `action` that throws writes `payload.error` and the row **stays pending** —
*"one action is one service call, so nothing is half-applied"* — and there is
deliberately no retry. An access refusal does the same, before the row is settled.
This is how the product fails, everywhere, and a screen must not draw a refusal as
a decision.

### 2.5 Nothing-to-do is a first-class outcome

Four of the five shipped routines are deliberately silent when there is nothing to
act on. A blank cell reads as a fault; *wrote an empty table — nothing had
changed* reads as the truth. And a tick that did nothing gets **no row at all** —
the schedule working is not an event.

---

## 3. Permissions and provenance

### 3.1 One table, everywhere permissions appear (C58)

**Resource × Read × Write**, one line per resource, on a local agent, a connected
agent and a routine alike.

**Anything not listed is not granted.** There is no Allow/Never control, because
absence is the same information in none of the space — and it is the honest shape:
the list of what an agent *cannot* do is infinite. One glyph marks a verb that
waits for the owner; **Edit** sits on the section, not in every cell.

Underneath, the wire's four action kinds are verbs on models (C53) — which is why
`comment` appears against **two** resources, Work and Artifacts: its schema takes
either a `work_id` or an `artifact_id` + `version_id`.

### 3.2 Access always shows its provenance

| How it got there | Marked |
| --- | --- |
| base configuration | nothing. A marker on everything is a marker on nothing |
| approved in a queue | *Approved in Needs You · #311* |
| granted by a routine | *during \<routine\> only* |
| reached through a proxy | *Through Metistry* |

The argument is not consistency. A routine-granted permission is the most
forgettable access in the system — granted inside a setup months ago, invisible on
the agent's own page — and the marker is the only thing between the owner and it.

### 3.3 Effective is the value, and it carries its reason (C46, C47)

`effectiveActions` clamps each entry to the level's ceiling, so stored and
effective differ. The **effective** mode is the answer, matching the CLI. A cell
that is not `allow` says *which* of two reasons applies: **defaulted** (you set
nothing) or **clamped** (you set more than the level permits). Blurring them hides
the only case where the owner's own setting is being overridden.

### 3.4 The owner's choice is the whole control (C61)

A proxied tool once carried a *Previews first* mark beside its On/Ask/Off setting,
so a tool deliberately set to **On** still claimed it would preview.
Preview-then-confirm **is** what *Ask* means — the middle state of the control, not
a second marker beside it.

Where a choice is consequential, **set a default, do not forbid the choice**. The
wire already shows the shape: `dispatch` defaults to `propose` rather than being
refused.

### 3.5 An approval that blocks cannot happen in an unattended run (C59)

*Ask* means **pause** for an agent the owner is talking to, and **defer** for a
routine at 6 AM. The run finishes without the step and reports what it skipped —
the same discipline as `later` not blocking.

---

## 4. Language

- **Attribute names are Title Case; a value is verbatim, always.** A value is
  usually something the owner or an agent wrote, and P1 says data is not
  case-corrected.
- **Rename the wire's enums for the reader, once, and everywhere.** `index` /
  `areas` read as **Titles** / **Folders**; `allow` / `propose` / `deny` read as
  **On** / **Ask** / **Off** (C93, ruled 2026-09-23; was *Allow / Ask First / Never*).
- **One idea, one term.** *Schedule* and *Recurrence*, not "when it acts" and
  "ticks". A second word for one idea is a second thing to learn.
- **Never name the runner's internals.** "Silent" described how the scheduler
  works. It is gone; what replaced it says what happened.
- **Compose a shared sentence once.** `describeScope`'s triple is rendered
  verbatim in the CLI, the Agents roster and the Needs You card. A surface that
  composes its own version creates a second record.

---

## 5. Structure

- **Metis is unscoped because it *is* the user.** It holds the owner's reach and
  delegates narrower work. So Metis is not on Agents, and its reach is never drawn
  as a grant — a grant implies it could be less. (C52)
- **Agents is what Metis delegates to, and what connects in.** Everything on it is
  scoped, because none of it is the owner. That sentence is why permissions live
  there.
- **An agent is a capability; a routine is an assignment.** The agent's definition
  says *how it behaves*; the routine's task prompt says *what to do this occasion*
  and is **appended**, never a replacement. Reach layers the same way.
- **A routine's schedule is not when it acts.** `plan-tomorrow` is `@hourly` and
  acts once an evening. Rows say when it acts; the cron expression is mechanism,
  shown once.
- **Two detail shapes beat one that fits neither.** Forcing a connected agent and
  a local agent through one layout gave the first an empty Definition section and
  the second an action matrix it does not use.
- **The nav rule (C57).** Eight rows. The seven-row rule has been broken twice, both
  times with the same argument — *this is not a property of the thing it sits
  under*. **A third break should move something out rather than add a row.**

### 5.1 Design the question, not the data's shape

The rejected first Agents pass is the lesson. It was organised around
`agents.grants` and `agents.autonomy`, which is the shape the wire hands you, and
it produced a permissions matrix with a disclosure triangle. Its own spec opened by
saying it was not a permissions matrix.

The owner arrives with a question. On Agents it is *who works for me and what may
they touch*; on Routines, *what is this running for me every day*; on Knowledge,
*what did it learn, and does anything need me*.

**The qualifier, learned by breaking it (C66, and the Knowledge rework).** The
first form of this rule ended *put the question the wire cannot answer first,
because it is what makes the rest trustworthy* — and on Knowledge that produced a
status page with a file list under it. The correction: **lead with what the owner
came for; lead with the unanswerable question only when trust in the data is what
they came for.** On Agents *may this thing touch my vault* is the visit. On
Knowledge *is the collector current* is plumbing — a source that is working should
be ignorable, and the machinery goes to the bottom in one line that expands itself
when something is wrong.

### 5.2 Relevance is provenance, not a rank

*Show me what is most relevant* is a request for a ranking, and a ranking is
inferred, unexplainable and cannot be argued with — P5 forbids it. Answer it with
**facts that are reasons**: *changed by you 2 hours ago*, *named by last night's
fold*, *behind work #418*, *linked from 6 pages*. Each is a row value, a file's own
link, a join, or a count. Same job, no invention, and when one is wrong the owner
can see **why** it is wrong, which a score never permits.

### 5.3 The teaching layer sits in situ, and says the architectural reason

Where the product's shape is unusual, the surface that depends on it carries one
sentence naming the **rule**, not a usage tip: *a folder is a permission boundary,
because a grant names a path prefix* — never *folders help you stay organised*. One
line, tertiary ink, at the foot of the section it governs, non-dismissible: a rule
that can be turned off stops being one, and it costs a line. This is the same habit
the four states already have — **say your own reason** — applied to architecture
rather than to a missing value.

---

## 6. Motion, and agent text (ratified 2026-09-22)

### 6.1 One sentence governs motion (C16), and the list is closed at two (C75)

**Motion is allowed only where it carries information the reader cannot
otherwise get, and it stops the moment that information is available in words.**

This narrows `ux-direction.md`'s "the working state is a **word**, not a spinner,
and nothing auto-scrolls, parallaxes, spins or pulses" rather than keeping it as
written, because a word that never changes looks exactly like a word that is
stuck, and the reader has no other way to tell working from broken.

What falls out of it, with no further rules needed:

- The three waiting dots run only while there is genuinely nothing to report,
  and are **replaced** — not supplemented — the instant a tool name can be
  printed. They were the only looping animation until C75 admitted the recording
  breath; the list is closed at two.
- Streaming prose is its own motion; the strip collapses to one line.
- At 60s the product reports what it knows (*nothing back for 62 seconds*),
  which is a fact, not a state change: `degraded`, never `failed`.
- Under `prefers-reduced-motion` the dots hold flat and the elapsed count
  carries liveness alone — **a number is content, not motion**, which is why the
  count is load-bearing rather than decoration.
- **The floating bar's recording breath** (C75), admitted by the same test: on a
  30px rail at across-the-room distance neither the mark nor a numeral resolves,
  and a 2.6s expanding halo does. Two conditions come with it — **the static mark
  carries the state at all times**, so motion is never the sole carrier, and **the
  halo is exempt from 3:1 because it is redundancy rather than meaning**.

**The list is closed at two.** A third candidate must displace one of these rather
than join them, and must show what information it carries that words cannot.

### 6.2 Agent prose in a transcript takes a rule; the wash is for everywhere else (C69)

**A reply body carries a 2px `agent` rule at its left and no fill.** A quote rule
is the oldest mark for *these are not my words*, so P1's "visibly quoted" is
satisfied without a wash — and unlike a wash it survives a reply containing a
table, a diff or a card, where a fill inside a fill stops reading as quotation.

**The rule hangs in the gutter, never inside the measure.** Width = measure +
rule + padding, pulled back by the same amount, so the prose starts on the user
turn's own left edge and one number still governs the column.

`agent-quiet` keeps its full job **outside** a transcript — feed rows, card
titles, tool output, artifact comments — which is where agent text can actually
be mistaken for the interface. P1 is unamended; only its implementation inside a
transcript is settled.

---

### 6.3 A capability claim is a state claim (C71)

P5 — state reported, never inferred — governs what a control may say about the
machine, not only what a row may say about a value. A mark meaning *this cannot
happen* is only allowed where something enforces it. The floating bar may say *no
stream is running* and may not say *Metis cannot see*, because the screen grant is
global to the binary; it **may** name the scope of an audio session, because a Core
Audio process tap enforces it.

The corollary, and the part easy to get wrong: **two things with different
guarantees may not be drawn as siblings.** Two identical switches make the weaker
one a lie by association.

---

## 7. Working in this repo

- **A board's assembly is not recoverable from `lib.py`.** The library holds
  components; the page that arranges them lives in a board module or nowhere. Five
  boards lost theirs. Re-derive from the published `.dc.html` on the canvas, not
  from imagination.
- **Module-level order matters.** `lib.py`'s panels are built at import time, so a
  constant or icon defined later in the file does not exist when they render. This
  has bitten twice.
- **Run the checkers.** The token check, the palette validator, and a hand pass on
  every pair the token file does not declare.
- **A frame is measured, never estimated (C67).** A board declares its own height
  and nothing verifies it; seven of twelve overflowed, one by 1283px, and two rounds
  of rationale panels were reviewed at the bottom of boards that could not show
  them. Render each board headless, compare `scrollHeight` to the declared height,
  and raise the declaration until they are equal. Fonts matter: alias the system
  stacks to metric-compatible faces (Liberation Sans, Bitstream Charter, Liberation
  Mono) or every number is inflated.
- **Log the contradiction; do not route around it.** 75 of them, and the ones that
  became rules are in this file.

---

## 8. One term, one component (review 01, ruled 2026-09-23)

The holistic review found the same idea drawn and worded several ways across
seventeen screens. These are the winners; a screen that disagrees is wrong.

### 8.1 Names and words

- **The assistant is called by the name the owner gives it (C88)**, default
  *Metis*, in every label that attributes words or acts to it: the transcript
  attribution, *Metis wrote this*, actor chips, *Metis suggests*. *Assistant* is
  the role in the glossary and never a label.
- **Requests and proposals are answered Approve · Revise · Decline, then Later
  (C92).** *Skip* exists only in bulk. The same three verbs wherever the owner
  settles something an agent proposed — Knowledge drafts, Routines suggestions,
  a meeting card (*Accept All* stays the meeting card's bulk verb, beside Revise
  and *Decline All*). Not *Accept*, *Discard*, *Dismiss*, *Edit First* or
  *Not Today* on a request.
- **Delegate**, with the spark, is the one verb for handing work to an agent.
- **Permissions read On · Ask · Off (C93)**; project modes **Autonomous /
  Review (C94)**.
- **Casing is HIG title style.** Controls, titles and column headers are Title
  Case with articles, short conjunctions and short prepositions lower: *Open the
  File*, *Run Now*, *Connect a Server*, *New Agent*. Values stay verbatim.
- **Clock times are 12-hour with AM/PM** (*1:02 PM*). A duration says it is one
  (*4m 12s*, *at 12:40 in*), so it cannot be misread as a time.
- **One display name per routine (C55)**, and the morning's is **Morning Brief**
  (C97).
- **Retry copy** is the States board's: *Try Again*, and *Couldn't …* in prose.

### 8.2 Buttons carry weight, not alarm (C92)

On a request, **Approve is the one accent-filled button**; Revise and Decline
are outlined. A filled destructive button appears only for an act that cannot be
undone, and that act confirms first (P3). Decline keeps its cross glyph so the
pair survives greyscale.

### 8.3 One component per idea

- **Agent chip:** one tinted pill in the `agent` hue, mono id. A roster row may
  show the id bare. Never accent, never grey.
- **Presence:** filled/hollow dot plus `degraded` — the Agents board's version
  (C54). No other presence palette.
- **Staleness is neutral.** A `stale` chip and *2 things changed* are grey; the
  tint is for something wrong (§1.1).
- **Provenance is neutral or hue**, never tint: *external* is a fact about where
  a request came from, not a fault.
- **An expired credential is `failed`** (C95), with both timestamps (§2.3).
- **One glyph, one meaning.** The plug is *absent*; *reached through Metistry* is
  the relay glyph. The clock-arrow is *Later*; *Ask* is its own mark; *paused* is
  the pause bars. *Failed* has its own mark, so it never depends on colour alone
  to differ from *degraded*.

### 8.4 One set of sample data

Every board draws its people, times, amounts and counts from one fixture
(`boards/fixture.py`, started 2026-09-23: the day, the Needs You count, the
meeting times, today's spend and the two file paths). A count on a badge matches
the rows beneath it; a meeting has one time on every board; spend sums. Literals
move into the fixture as boards change — a number drawn on two boards goes there
first. Developers copy board data as
acceptance data, so a board that disagrees with itself ships a bug.

### 8.5 Where things go (C89, C90, C96–C98)

- **A thread lives with its subject.** No Rooms list; *Open Room* from a card
  opens the thread over Board (C89).
- **Metis may move a meeting with other people in it after a warning** that
  names who is told and the new time (C90).
- **Anything that needs the owner is a Needs You request**, even when it is not
  a question: a budget stop, a failed routine, an expired credential, a
  knowledge conflict (C96).
- **One morning brief, shown as Today** (C97). It writes its own file and the
  **Metistry section** of the daily note (C102).
- **One writer per region.** In the owner's daily note Metistry writes only
  between its `metistry:day` markers; the rest is the owner's. Broken markers
  stop the write and raise a request (C102).
- **Owed is a facet, not an object.** Something owed to a person is a task with
  that person on it — tickable wherever it appears (C102).
- **Generated prose may appear outside a fold** — attributed, in the wash, marked
  *written, not retrieved* (C103).
- **A task can be ticked where it is shown** — Today, Board, card detail (C98).

## 9. Requests — one pattern (2026-09-25)

- **Every request is five parts:** header · the ask · context · one body block ·
  answers. A type chooses a body from a closed set — choices, diff, thread,
  before and after, preview, to-dos, excerpt — and names its primary verb. **A new
  type is a row in the table, not a new card** (`screen-03-needs-you.md` §12.2).
- **Context separates the agent's words from what it read**: prose on the wash,
  then retrieved chips.
- **Revise is always free text back to whoever asked.**
- **When an answer posts to another system, the button uses that system's word**
  — *Request Changes* on a pull request. This is the one exception to §8.1's verb
  set, and it exists because the button is naming the state it will create there.
- **A card never acts on something the owner didn't see**: a request whose subject
  changed while open (new commits, an edited line, a moved row) turns `stale` and
  sends nothing.
- **Needs You is the hub for everything that needs the owner** — Metis, agents,
  and sources the collectors read. A source request is a **mirror**: it exists
  only while the source names the owner, and clears when answered there. Metis
  may raise an inferred one, and says it inferred it (C108, screen 3 §12.7).

