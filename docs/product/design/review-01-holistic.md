# Review 01 — the whole product, read as one

2026-09-23. Written after the last undrawn screen (Usage) landed, so every surface
in the product exists at least once. The job: find where the screens disagree with
each other, where they disagree with what was decided, what breaks in real use, and
what would make Metistry something the owner opens every day because it is better
than the alternative, not because he has to.

**How it was done.** All 24 boards were rendered and screenshotted in slices, and all
28 design and product documents were read. Four independent passes each took one
lens: cross-screen consistency, alignment with ratified decisions, flaws and
missing states, and daily use and beauty. Every high-severity claim was then checked
against the source by hand before it went in here. Several of the faults are mine,
from this round; they are marked **(round E)** so none of them reads as inherited.

Findings are numbered **R1.x** so they can be cited without adding forty rows to
the contradiction log. Anything that becomes a ruling gets a C-number when it is ruled.

---

## 0. The read, in a paragraph

The shell is solid: the eight-row sidebar, the `+ · bell · gauge` top bar, the
permissions table, light/dark parity and the measured contrast work are consistent
on every current board, and three surfaces — the floating bar, Chat, and the
meeting card — are genuinely good. The drift is in the parts that carry meaning:
the assistant has five labels, a request is answered with three verb sets, agent
text breaks C69 in both directions, and colour is tinted onto things that are not
wrong. Underneath that, the design record itself disagrees: `design-system.md`,
`glossary.md` and `daily-flow-spec.md` still state a dozen superseded rules, and
HANDOFF names two of them as the winning authority. The biggest product gaps are at
the two ends of the day — four overlapping morning documents and no evening moment
at all — plus three things never designed anywhere: the phone, being offline, and
events that need the owner but never reach Needs You.

---

## 1. Rulings the owner owes

These change what gets drawn. Each has a recommendation; most are a yes or no.

| # | Question | Recommendation | Evidence |
| --- | --- | --- | --- |
| 1 | **What is the assistant called on screen?** Five labels today: `ASSISTANT` (Chat, Today), `METIS` (Run detail), `METIS WROTE THIS` (Activity, Knowledge), `METIS SUGGESTS` (Routines); actor chips flip between `metis` and `assistant` on one board. | **Metis**, everywhere Metis wrote something; *assistant* stays a glossary role. Changes the ratified agent-prose component (HANDOFF §3). | Chat_00, Today-Hub_00, RunDetail_00, NeedsYou_00/01 |
| 2 | **Rooms: a Work child, or ruling 4's filter-plus-thread?** Ruling 4 (2026-09-18) demoted Rooms; round E drew a Rooms list under Work and nothing reversed the ruling. | **Keep ruling 4.** The thread lives in card detail and the artifact margin; a *Has thread* filter on Board replaces the list. One less place to look. | review-00 Ratified #4; screen-16 §2 |
| 3 | **Can Metis move a meeting with other people in it?** *(Ruled: yes, warning first.)* The Today board offers *Move The Vendor Sync* and "meetings Metis may move: any"; screen-05 §14.5 says it stops one step short. | **Stop short**, as the spec says: *Draft the move*, never the move. Other people's calendars are not the owner's to act on silently. | Today-Hub_01; screen-05 §14.5 |
| 4 | **One retention for a meeting transcript.** Live Capture says *90 minutes, then gone*; the meeting card says *kept 30 days*; C78 ruled 30 days. 90 minutes is shorter than a long meeting. | **30 days, counted from when the session ends**, like every other session. | CaptureBar_02, Settings_01, NeedsYou_01; C78 **(round E)** |
| 5 | **Needs You's buttons: calm or loud?** Every card carries filled green Approve and filled red Decline; amendments §1.1 says red is spoken for by *failed*, and the bell says "decisions, not failures". | **Approve is the one accent-filled button; Revise and Decline are outlines; filled red only for the irreversible.** Changes round B's "Approve is affirmative green". | NeedsYou_00, Request_00; amendments §1.1 |
| 6 | **One vocabulary for permissions.** *Allow · Ask First · Never* (C53, amendments §4) vs *On · Ask · Off* (Resources, C61) vs *Asks you first* (table legends). | **On · Ask · Off** — the newest, the shortest, and the one the owner chose in C61. Annotate C53. | amendments §1.1, §4; screen-07 §10; screen-09 §3.2 |
| 7 | **Project mode names.** Glossary: *Auto / Supervised*. Screen 13 and C83: *Autonomous / Review*. | **Autonomous / Review** — it reads better and matches the toggle label. Update the glossary. | glossary.md:60–61; screen-13 |
| 8 | **Is an expired credential `failed` or `degraded`?** Red on Activity and Knowledge, amber on Resources and Settings. | **`failed`**, with the two-timestamp line (*last succeeded 2 days ago · token expired*). Nothing works until it is fixed. | Activity_00, Settings_00; screen-09 §2 vs screen-10 §6 |
| 9 | **Where do owner-relevant events go that aren't requests?** A budget stopping compute, an expired token, a failed routine, a knowledge conflict — each shows only on its own screen, and P2 leaves no other channel. | **Each becomes a Needs You row** (kind `report` or `action`) — the owner only has to look in one place. | screen-10 §3, screen-17 §2, screen-09, Agents_01 |
| 10 | **One morning, or four?** By 7am there are *Tomorrow's Plan*, *Standup Draft*, *Morning Digest* and *Morning brief*, under drifting names and with contradictory contents. | **One morning brief, and it is Today** at first open: the plan and standup are sections of it; the message links there. | Routines_00, Today-Hub_00, RunDetail_00, Activity_00 |
| 11 | **Tick a task in the app in phase 1?** Every Today checkbox is read-only in phase 1, so the first thing he does each day sends him to Obsidian. | **Yes** — pull the check route (daily-flow P2-3) into phase 1. A task list you cannot tick is only ever read. | Today_00; daily-flow §11 |

**Ruled 2026-09-23** (C88–C98): 1 — the name the owner configures, default Metis ·
2 — yes · 3 — **allowed, warning first** · 4 — 30 days · 5 — agreed · 6 — On · Ask ·
Off · 7 — Autonomous / Review · 8 — failed · 9 — Needs You · 10 — one · 11 — yes, a
key feature. Every §5 opportunity adopted. **iPhone and PWA deferred** (R2.1).

---

## 2. Fix before build — no ruling needed

Faults against rules already made. These are cleanup, mostly mine, and I can do them
next without further input.

### 2.1 The design record contradicts itself

- **R1.1 `design-system.md` still states a dozen superseded rules** and calls itself
  normative: six sections and two global controls (P6, §3.1); "nothing spins or
  pulses" (§2.6); P1's wash with no transcript exception; §3.18's "1 snoozed";
  §3.12's review colour; §3.10's `border-strong` drop target; §3.11's 60% opacity
  dimming. Fix: a superseded banner pointing to the amendments, and each item struck
  in place.
- **R1.2 HANDOFF §2 names `daily-flow-spec.md` and `glossary.md` as the winning
  authority, and both are stale.** daily-flow says six rows, "Feed", Today as Work's
  fifth child (D19, §10, §14.4). Glossary lists *routines* and *folds* as words
  absent from the interface, makes the assistant an agent role, still has the
  none/titles/folders access tiers, calls Needs You and Capture "tabs", and says six
  answers per request. Fix: update the glossary; mark the daily-flow passages
  superseded; HANDOFF §2 names the amendments and the C-log as the winning source.
- **R1.3 The request answer set is stated four ways.** components-01 §2.4 (four,
  *Approve · Decline · Revise*), screen-03 §10.1 (three, *Approve · Revise ·
  Decline*), glossary (six), design-system §3.9 (six). The board order also flips
  between the Mac panel and the iOS sheet. Fix: log it; **Approve · Revise ·
  Decline**, then Later; Skip in bulk only.
- **R1.4 Superseded statuses never updated.** "The only loop in the product" still
  appears in HANDOFF §3, C16 and screen-01 §5.1 (C75 made it two); C70's 0.85 floor
  and the amendments §1.5 heading (C74 made it 0.86); review-00's "remain open" list
  and HANDOFF §5's open rulings (C16 and C62 are closed); contradiction counts of 64
  and 75 (there are 87). Today is "second, not first" in screen-05 §13.1, C30 and
  today-hub-requests B6.
- **R1.5 Stale nav on boards.** The Resources board says "the nav is nine rows…
  Routines · Resources · Agents" (Resources_01); screen-07 §10 and the Agents board
  say Resources is "a new top-level row"; the Capture board's window has the old
  three-row sidebar and two global controls; the Theme board is the round-B
  five-row nav, and HANDOFF §0 still points to it as the current light and dark.
  C51 fixed this once, on Today only.

### 2.2 The boards break their own rules (round E)

- **R1.6 The meeting card's notes use the transcript rule outside a transcript**
  (NeedsYou_01, screen-03 §10.3). C69: outside a transcript, agent text takes the
  wash. The same fault in reverse on artifact margin comments, a routine's *What it
  wrote*, and Run detail's *What Metis took from this*, which have neither; room
  turns are sans rather than serif.
- **R1.7 The floating bar fades to 55% by opacity when idle** — the mechanism C63
  forbids, on glass already at the C74 floor. Fix: fade the glass, never the ink,
  and measure it.
- **R1.8 The bar's text glass ends at 0.85**, under C74's 0.86 floor (a gradient
  0.88 → 0.85). Still above the measured 0.83, but against its own rule. Fix: the
  bottom stop becomes 0.86.
- **R1.9 Metis writes into the owner's daily note.** Run detail shows the morning
  brief "written to Journal/2026-09-22.md", and card detail shows a to-do in that
  file with history "metis · added from the Vendor review meeting". Knowledge's own
  teach line: "Your own daily note is never touched — one writer per file." Fix: the
  brief writes a machine-owned file; accepted meeting to-dos go to the meeting note.
- **R1.10 Knowledge says "4 sources, all current"** by default, which the system
  cannot know until the per-collector last-ok time exists (C1, C64) — an inferred
  *ok*, against P5. Fix: *freshness unknown*, neutral, until it can be answered.
- **R1.11 Run detail's `failed` pill is drawn in the `degraded` ink**, while the
  caption says "red" and States draws failed in `failed`.
- **R1.12 Smaller faults:** a doubled **Blocked Blocked** chip on Board_00; "Release
  to Addressed To" survives on Board after C38 closed; Board's room and note glyphs
  still bypass the popover (C84); the reduced-motion halo holds at 1.32, not "its
  widest" as specified; screen-11 says grant dates are trivia, then asks for them.

### 2.3 One term, one component

| Concept | Variants found | Winner |
| --- | --- | --- |
| Answering a request | Approve / Accept / Allow; Revise / Edit First / Ask for changes / Review; Decline / Discard / Dismiss / Not Today | **Approve · Revise · Decline** wherever a proposals row is answered, including Knowledge's drafts and Routines' suggestions |
| Delegating | *Delegate* + spark (Today, Facets, Plugin); *Hand To An Agent* + people glyph (Card detail) | **Delegate**, with the spark |
| Agent chip | five anatomies: tinted pill, bare mono, grey pill, accent link with chevron, plain mono | **one tinted pill in the agent hue**; the roster row may stay bare; never accent |
| Presence | filled/hollow + `degraded` only (Agents, Projects) vs purple/amber/green dots (Today rail) and five-colour chips (Theme) | **Agents' version** (amendments §1.1, C54) |
| Staleness | neutral `stale` chip (States, Facets) vs amber *2 Things Changed* (Today) | **neutral** |
| Trust provenance | `external` in the warning tint (Needs You) | **neutral or hue** — screen-03 §9.4 says provenance is not the tint's business |
| Control casing | *Open the file* / *Open The File*; *Run now* / *Run Now*; *New agent* / *New Routine*; *Connect A Server*, *Hand To An Agent* | **HIG title style**: small words stay lower — *Open the File, Run Now, Connect a Server* — written into P10 |
| Clock times | *13:02, 13:00, 09:15, 2:41* beside *8:47 AM* | **12-hour with AM/PM**, as ratified; elapsed times say they are durations |
| Glyphs | plug = absent *and* reached through Metistry; clock-arrow = later *and* asks first *and* paused; ⚠ = failed and degraded, told apart by colour alone | **one meaning per glyph**; *failed* gets its own mark so it survives greyscale |
| Retry copy | *Try again* / *Retry*; *Couldn't* / *Could not* | **the States board's copy** |
| Routine names | *Morning Digest* vs *Morning brief* for collator's 6:02 run; one refused run dated 2 and 3 days ago | **one display name per routine (C55), from one fixture** |

**R1.13 One set of sample data.** The boards contradict their own fixtures: *4 waiting*
beside *Show all 12*; Design review at 1:00 PM, 11:00 and 13:00 on one board; project
spend summing to $5.91 against Usage's $1.84 today; a standup and an every-other-Friday
1:1 on a Sunday. Developers will copy these as acceptance data. Fix: one fixture file
that every board draws from, checked by the build.

---

## 3. What was never designed

### 3.1 Three whole-product gaps

- **R2.1 The phone.** *Deferred by the owner 2026-09-23.* Fifteen of seventeen specs say nothing about the PWA, which is
  the owner's away-from-desk client. Today's spine and rail, Board's five columns,
  Artifacts' margin threads, Routines' week axis and Run detail's two columns are
  all wide-window only, and Settings is a Mac window, so budgets and Resources are
  unreachable from a phone. Fix: a one-column rule per screen; draw Today, Needs You
  and Chat at 390pt first.
- **R2.2 Being offline.** Capture queues; decisions must never queue; everything
  else is undefined — a failed chat send, a board drag, *Run Now*, a conflict
  resolution, and Accept All losing the connection after the second of five
  approvals. The bar shows *Noted 13:02* with no failure state at all. Fix: one rule
  per verb (queues / refuses with the reason / not offered) and a window-level
  *can't reach Metistry* band, drawn on Chat, Needs You and Board.
- **R2.3 Keyboard and VoiceOver.** Nine specs have no keyboard section and only two
  specify VoiceOver. The bar's glyph-only rail and the usage gauge have no spoken
  labels; Stop has no shortcut, so ending a recording needs the pointer on a 34px
  rail that may be on another display; ⌘R, ⌘N and ⌘9 collide with the browser.
  Settings' large-text check was 135%, not XXXL. Fix: one keyboard map with
  PWA-safe alternatives, and a VoiceOver section per spec.

### 3.2 States coverage

> **Closed 2026-09-25 by C135–C138** — `components-03-states-and-flows.md`, boards `States-Screens`, `States-Settings`, `Flows`.

✓ designed · ~ partly · ✗ missing · – not applicable

| Screen | empty | absent / loading | failed | stale |
| --- | --- | --- | --- | --- |
| 01 Chat | ✗ | ~ | ~ | ✗ |
| 02 Activity | ✓ | ~ | ✓ | ✗ |
| 03 Needs You | ✓ | ~ | ~ | ✓ |
| 04 Capture | ✓ | ✓ | ✓ | – |
| 05 Today | ✓ | ✓ | ✗ | ✓ |
| 06 Board | ✗ | ✗ | ~ | ✗ |
| 07 Agents | ~ | ~ | ~ | ~ |
| 08 Routines | ~ | ~ | ~ | ✗ |
| 09 Resources | ~ | ~ | ~ | ~ |
| 10 Knowledge | ✗ | ✗ | ~ | ~ |
| 11 Floating bar | – | ~ | ✗ | ✗ |
| 12 Run detail | – | ✗ | ✓ | ✗ |
| 13 Projects | ✗ | ✗ | ✗ | ✗ |
| 14 Card detail | ✗ | ✗ | ✗ | ✗ |
| 15 Settings | – | ~ | ✗ | ✗ |
| 16 Artifacts & Rooms | ✗ | ✗ | ✗ | ✗ |
| 17 Usage | ✗ | ✗ | ✗ | ✗ |

No screen specifies first paint. The four-state rules are well argued and reach four
screens; the newer screens (10–17), mine, carry almost none.

### 3.3 Flows with no defined end

- **R2.4 Recording has no lifecycle.** Pressing Record before the screen grant, or
  after it was denied; the window closing mid-session; the Mac sleeping; the bridge
  crashing; a recording left running for hours.
- **R2.5 Destructive verbs without a confirmation or an outcome:** Esc in the agent
  editor discards unsaved edits (Capture keeps the draft on Esc); Knowledge's *Keep
  Mine* / *Take the Fold's* discard one side of a conflict; *Decline All*; *Purge
  Now*, which can throw away sessions the fold has not read yet; *Sign Out
  Everywhere*.
- **R2.6 Actions that lead nowhere:** both *Raise* buttons (Usage, Projects) and
  *Budgets in Settings →* point at the Compute pane, which is undrawn — and a monthly
  instance budget's relationship to per-project daily budgets is unspecified;
  *Run Now* on an agent that has no task; *+ New Agent*; the connected-agent token
  enrollment.
- **R2.7 Run detail is empty for every run before the archive ships** and after 30
  days. It needs an absent state that still shows cost and tool calls.
- **R2.8 Board polls every 10s with no failure state**, so a dropped connection
  keeps counting leases down — the lie screen-06 §3 exists to prevent.
- **R2.9 Routines has no horizon.** A 15-minute routine is 96 rows a day; past
  occurrences show no outcome; *Tomorrow's Plan* is listed as every evening though it
  only runs before a working day.

---

## 4. The day — where it holds and where it breaks

Walked from 7am to the evening across the boards as drawn.

| When | Screen | What happens | Fix |
| --- | --- | --- | --- |
| 7:00 | (message) | Four machine documents under three names, contradicting each other ("nothing is blocked" / "blockers — waiting on the SOW"). | Ruling 10: one brief, on Today. |
| 8:40 | Today | Before the 9:30 meeting: a day bar, an Undo card, *Earlier today*, the standup, three purple Metis cards, six spark buttons, a four-block rail. Checkboxes don't work. **First place he goes back to Obsidian.** | Ruling 11; a **Next up** card (§5.3); cap Metis cards at one open. |
| 9:15 | Today | Standup card is good. Routines also lists a *Standup Notes* routine at 9:00 by a different agent. | One routine, one name. |
| 9:30 | Floating bar | Jotting is excellent: one click, type, Return. Recording asks for a window by title and knows nothing about the calendar event; Ask can't show the meeting's briefing. | Pre-select the current event on Record; during a session, Ask shows that meeting's briefing lines above the chat. |
| 10:00 | Needs You | The meeting card is good, but it arrives in the evening fold, its to-dos have no due date or person, and nothing drafts the follow-up. | Close the loop at Stop (§5.4). |
| Between | Bell, Chat | *Comment on #418* asks for approval without showing the comment. Knowledge's *Needs your eye* repeats the queue. | Action cards show their payload; one place per question (§5.6). |
| Blocked | 7 places | A blocked agent appears on the Today rail, the bell, Board, Activity, Card detail, the plan and Projects — and none says in one line what would unblock it. | Compose the unblock sentence once (amendments §4) and show it on the card. |
| 5:30 | nothing | No screen supports the end of the day; *Tomorrow's Plan* is a silent 10pm file write. **Second place he gives up.** | **Close the day** (§5.5). |

---

## 5. Opportunities, ranked by daily impact

1. **One morning, one name** (ruling 10). The brief becomes Today's state at first
   open — one folded Metis paragraph at the top, plan and standup as its sections —
   and the message links straight there. Everything renamed once.
2. **Tick tasks in the app from day one** (ruling 11).
3. **A Next up card.** A sticky card under Today's header from T–30: who is in the
   meeting, what you owe them, last time, *Open Notes* and *Record*. Today's best idea,
   currently buried below the standup and blocked by today-hub-requests A1, A3, A4 —
   which should be the developer's first tickets.
4. **Close the meeting loop at Stop.** The meeting card is produced when he presses
   Stop, not at the evening fold; its to-dos carry *proposed* due and person chips in
   facet order, editable; and **Draft follow-up** drafts the note to the attendee
   without sending it.
5. **Close the day.** At the end of working hours Today offers a close: done, carried,
   owed to people, drag into tomorrow — rendered with the preview route that already
   exists — and what he leaves becomes plan-tomorrow's input. Needs the B4 ruling.
6. **One place per question.** Today is *what's next and what's owed*; Needs You is
   *decisions*; Activity is *the record*, with model-call rows off by default. The
   window's **+** opens the bar's own field so there is one capture component. A
   blocked card carries its one-line reason.
7. **What's slipping, and what's owed.** A saved *Slipping* view — carried three or
   more times, overdue, owed to or by people — in the existing filter vocabulary.
   The Sunday weekly review becomes a real screen, not only a message.
8. **Today obeys its own rules.** Three predictions per page (§12.5), not six; *Draft
   the move*, not *Move* (§14.5); the day bar's five segments actually rendered.
9. **Say a fact once.** "Comparables came back 4% under" is regenerated in Chat,
   Today, the fold, Run detail and a lesson; later surfaces should cite the first
   (*from last night's fold*) instead of rewriting it.
10. **Two contexts, one day** *(partly unverified)*. His work calendar and mail live
    on the second instance; every Today mock shows one calendar. Decide app-ux-plan
    Q3; if Today merges both, each meeting names its context in text, not hue.

---

## 6. Beauty

**Needs the most lift:**

1. **Today.** The landing screen is the busiest: three stacked purple cards, six
   spark buttons, dense 12px secondary text, a title barely larger than its rows.
   A clear hero (Next up), one Metis voice at a time and more air between spine
   blocks would lift the whole product's feel more than any other single change.
2. **The Needs You panel.** It reads like forms: mono agent ids, a coloured triad on
   every card, three equal-weight buttons. Ruling 5's calmer buttons would make the
   product's only badge feel like an invitation rather than an alarm.
3. **Activity.** It reads like a developer console: mono actors, cost and token rows,
   timestamps 1,700px from their subject at full width. Cap the measure, keep model
   calls off by default, fold *what it wrote* to one line.

**Already set the bar:** **the floating bar** — measured glass, concentric radii, a
specular edge, one click per act; it looks like part of macOS — and **Chat** — a calm
capped column, the serif voice on its 2px rule, honest waiting states. The Usage
popover and Knowledge's fold are close behind. The next pass on Today, Needs You and
Activity should be held to those two.

---

## 7. Proposed order

1. **Rulings 1–11** (§1). Most are a word.
2. **Record cleanup** (§2.1) and **board fixes** (§2.2–2.3, R1.13) — mechanical, no
   design judgement, one or two sessions. Brings every document and board into line
   with what is already decided.
3. **Today, elevated** — Next up, one morning, close the day, three predictions — as
   the one screen redesign of the next round.
4. **Needs You, calmer**, with the meeting loop closed at Stop.
5. **The three whole-product gaps** (§3.1): phone, offline, keyboard and VoiceOver.
6. **States for screens 10–17** (§3.2) and the flows in §3.3, including the Compute pane.

---

## 8. Status — 2026-09-23, after the rulings

**Done (cleanup, §2):** the rulings are logged as C88–C98 and written as rules in
`design-system-amendments.md` §8. `design-system.md` carries a superseded banner
and a note at each stale passage; the glossary, daily-flow §10, components-01,
HANDOFF and eleven specs are corrected. On the boards: the configured name on
every attribution; Approve accent-filled and Approve · Revise · Decline
everywhere; On · Ask · Off; Morning Brief; 30-day transcripts; *freshness
unknown*; the brief and meeting to-dos out of the owner's daily note; *failed*
with its own mark and ink, the expired credential included; one agent chip;
neutral presence, staleness and provenance; the meeting notes on the wash, room
turns in the serif; no opacity on ink; the glass floor held; the halo at its
widest; HIG title casing; 12-hour clocks; Board's Blocked column, reason chip and
Has Thread filter; no Rooms list; the move warning on Today; `fixture.py`, with
Today's day, counts, times and spend reconciled. Every frame measured.

**Not done, and why:**
- `Capture`, `Theme`, `Facets`, `Plugin`, `Voice` and `Item-Model` are not
  modules, so their stale navs and palettes are flagged in HANDOFF §0 rather than
  redrawn — port each the next time it changes.
- `PRODUCT.md`, `design-brief.md` and `app-ux-plan.md` still say Auto /
  Supervised; they are the owner's files, flagged in C94.
- Routine timeline tick data and a calendar tool's raw output keep 24-hour
  values: the first is never displayed, the second is data shown verbatim (P1).

**Next (adopted, §5):** Today elevated — one Morning Brief as Today's first
state, Next Up, Close the Day, three predictions, live checkboxes (C97, C98);
Needs You calmer, with the meeting loop closed at Stop and the C96 events drawn;
then the offline and keyboard/VoiceOver passes (§3.1, phone deferred) and states
for screens 10–17.

