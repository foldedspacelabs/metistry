# Structured — a timeline day planner, and what Metistry's Today takes from it (2026-09-28)

Research answering the owner's 2026-09-28 ask: a competitive review of
[Structured](https://structured.app/), a closed-source daily planner that puts
tasks and calendar events on one timeline, for Metistry's Today (T6-1a/b,
screen 5) and the routines that shape a day.

Nothing here is built; this PR adds one document and no product code.

Sources: the site, the help centre, the US App Store listing, Structured's blog,
its public feedback board and changelog, and two third-party reviews (one written
by a competing planner, so used only where the help centre agrees). Vote counts
and statuses were read from the feedback board's page data on 2026-09-28. **The
app was not installed or run**: every behaviour below is described from their
documentation, not from use, and nothing about their code is known. Metistry
claims cite `screen-05-today.md`, `docs/ops/mac-app.md` § Today, the routine
manifests and `design-build-plan.md` at `origin/main` `eb5858e4`.

## 1. What it is, in five lines

1. **A visual day planner**: one vertical timeline per day on which tasks and imported calendar events sit as blocks sized by duration, plus an all-day strip and an undated Inbox.
2. **By unorderly GmbH**, founded in 2020 by one founder; a 15-person remote team as of December 2024 ([blog](https://structured.app/blog/structuredfive)). Closed source; sync through their own Structured Cloud.
3. **Platforms**: iPhone and iPad (iOS 18+), Mac (macOS 15+), Apple Watch and Vision Pro from one App Store purchase; Android since late 2023; a web app since August 2024. Whether the Mac build is Catalyst or SwiftUI is not stated anywhere public.
4. **Pricing**: free core; **Structured Pro** as monthly, yearly or lifetime ($99.99), with the App Store listing several price points ($2.99–$6.99 a month, $9.99–$69.99 a year). Pro gates calendar and Reminders import, recurring tasks, Replan, custom notifications and the AI ([free vs Pro](https://help.structured.app/en/articles/1897986)).
5. **Maturity**: 4.8 stars from about 167K App Store ratings and an Editors' Choice badge; the site claims 15M+ downloads and 500K+ Pro subscribers; 4.0 (January 2025) was a redesign, and 4.6.3 shipped in late September 2026 (Siri task creation, suggested subtasks, an iOS 27 refresh). Actively maintained, with Apple platforms first and Android and web lagging by design.

## 2. The interface and the model, precisely

### 2.1 The day, and the one lane

- **The timeline is the day.** Swipe between days; the week and month views were a 4.0 addition (their third most-voted request, 3,308 votes, completed). On first run the day is framed by two seeded tasks, *Rise and Shine* and *Wind Down*, to be moved to the owner's real times ([getting started](https://help.structured.app/en/articles/380546)).
- **Tasks and events share one lane and one shape.** An imported event renders as a timeline or all-day task, can be checked off like one, and keeps only colour and icon editable: its time, day and notes cannot change ([import](https://help.structured.app/en/articles/329730)).
- **Overlap is the owner's problem.** Blocks at the same time overlap; *side-by-side visualisation for overlapping tasks* is an open request (1,045 votes).
- **Drag is the rescheduling verb**: drag a block to a time (a preview shows the drop time), onto another day, up into the all-day strip, down into the Inbox, or to the corner trash, which the help centre calls irreversible ([drag and drop](https://help.structured.app/en/articles/338306)).

### 2.2 The task object

Title, icon (100+), colour, start time, **duration**, subtasks, notes, alerts,
repeat, and an energy value. Three kinds by placement: **timeline** (a time and a
duration), **all-day** (a date), **Inbox** (neither date nor time, but a
duration). There is no priority field and **no deadline**: *Deadlines in Inbox*
is open at 1,468 votes. Colour and icon carry the category; there are no tags or
projects (*Add Categories* and *Inbox sort / filter / folders*, 1,224 votes, are
requests).

### 2.3 The Inbox

The unscheduled list: a tab on the phone, a split pane on Mac and iPad, and a
quick-add shortcut (⌘⇧N on Mac, `I` on web) ([inbox](https://help.structured.app/en/articles/338178)).
Scheduling from it means dragging a task onto the timeline or giving it a date
and time. Completed items stay until deleted.

### 2.4 A task you didn't do

- **Nothing rolls over by itself.** An unfinished task stays on the day it was planned; the help centre's answer to *can I reschedule unfinished tasks?* lists four manual routes, none automatic ([reschedule](https://help.structured.app/en/articles/1990594)).
- **Replan** (4.2, June 2025; Pro; Apple only) is the review: long-press a past date, or have it offered at a set morning or evening time with an optional notification, then take each unfinished task in turn — **swipe up** reschedule, **left** to Inbox, **right** check off, **down** delete ([blog](https://structured.app/blog/replan), [how to](https://help.structured.app/en/articles/4511874)). It closed the *(Auto-)Move Incomplete Tasks* request (2,513 votes).
- **Running late** is the common complaint: when one block overruns, every later block is moved by hand. *Shift all events by an amount of time* is marked completed (545 votes), yet the help centre's documented way is an AI prompt — *push all following tasks in time* ([AI editing](https://help.structured.app/en/articles/3320002)) — and App Store reviews still ask for auto-bumping. *Update task end time when completed early* is open at 2,252 votes.

### 2.5 Planning tomorrow, and recurring

- **No planning ritual.** Tomorrow is the next page of the timeline; the owner drags Inbox items onto it or asks the AI. Replan's evening prompt is the nearest thing to a close.
- **Recurring** (Pro): daily, weekly or monthly with a start and optional end; editing asks *this task only* or *all future tasks* ([recurring](https://help.structured.app/en/articles/338114)). *Routines* — a saved group of tasks placed together — is their most-voted open request (3,619).

### 2.6 Structured AI

- **Input**: typed text, dictation, or a photo of a paper planner or list; since late 2025, several images. GPT-4o since June 2024 ([blog](https://structured.app/blog/the-new-structured-ai)).
- **Output is a proposal list**: each suggested task, edit or deletion offers **Update · Edit · Discard · Show**, and badges then say what was created, edited, deleted or dismissed. It cannot touch imported events.
- **Presentation**: a sheet from the timeline, not a chat; it keeps no history and cannot export prompts.
- **Cost and data**: Pro only; instructions go to Structured's and OpenAI's servers and may be kept up to 30 days. The same article says OpenAI never has access to calendar entries, tasks or events, while its list of what may be sent includes existing tasks and appointment details ([what is Structured AI](https://help.structured.app/en/articles/1782402)); the two statements are hard to reconcile.

### 2.7 Notifications, calendars, the rest

- **Notifications on by default**: every timeline task alerts **at its start and at its end** (Android adds one an hour before); all-day tasks at 8:00 AM; *time-sensitive* can break through Focus ([notifications](https://help.structured.app/en/articles/1870914)).
- **Calendars are read-only.** Apple devices import anything Apple Calendar can see (Google, Outlook, Exchange); Android and web, Google only. The help centre is explicit: no two-way sync, and tasks cannot be exported to a calendar. **Two-Way Calendar Sync** has 3,127 votes and is still in their inbox.
- **Energy Monitor** (free): tasks carry energy points (drain, neutral, recharge), roughly per 30 minutes; an all-day bar reads *19 of 30 Energy Points* and turns green → orange → red, red suggesting deleting or rescheduling ([energy](https://help.structured.app/en/articles/998530)).
- **Widgets, Live Activities, Apple Watch**, a Pomodoro focus timer, Siri. **VoiceOver** support is claimed on the listing; font scaling fixes appear in the changelog.
- **No sharing**: *you cannot share your entire Structured timeline*; collaboration is *In Progress* (802 votes) ([share](https://help.structured.app/en/articles/338562)).
- **Data**: JSON export on Apple devices; no calendar or printable export. App Store privacy labels: email and user content linked to the account; usage and diagnostics not linked.

## 3. What they got right

1. **The day has a shape before it has content.** Two seeded anchors frame the timeline on first open; an empty day is visibly a span of hours, not an empty list. The owner learns the metaphor without a tutorial.
2. **One lane, one shape.** A meeting and a task are the same kind of block, so the question the screen answers is *what happens next and how long it takes*, not *which list is this in*. Duration drawn as height makes an overfull day visible without a number.
3. **Duration is part of creating a task**, even in the Inbox. The day's arithmetic is only as good as its estimates, and asking at creation is when the owner knows best.
4. **Replan is one decision per task, four ways out, one gesture each.** It is fast because it is exhaustive and ordered: every unfinished task is seen, none is silently carried. The vote count behind it (2,513) says end-of-day triage is wanted, not tolerated.
5. **The AI proposes, the owner disposes.** Every generated change is a row with Update · Edit · Discard, and the badges afterwards are a receipt. It is shown as a sheet over the day, never as a conversation beside it.
6. **Imported events are not editable in Structured.** Read-only import avoids every conflict a planner can create in a shared calendar; they chose restraint over their most-voted request for years.
7. **Low-friction capture into a place without a date.** The Inbox accepts anything and demands only a duration; scheduling is a later, separate act.

## 4. What Metistry's Today takes, adapts and refuses

**Where we already are** (their demand, our design). Their three largest
rescheduling complaints are handled by construction in Today's spine: rows are
**placed, not timed** — each goes in the first gap from `max(now, dayStart)`
with room for its estimate (`today-model.swift`, spine builder), so a meeting
that overruns or a slow task re-flows the rest of the day **with no write and no
drag**, and a row too long for any gap goes under *Doesn't fit* instead of
overlapping. *Locations & Travel Times* (1,095 votes, open) and a review asking
to pull travel time from the calendar are the day bar's **Travel** segment
(screen-05 §14.3, waiting on A1). Replan is Close the Day's **Still Open**
(§15.5). Their energy bar is our capacity meter and day bar, which report and
refuse nothing (§4, §12.6).

| Metistry element | Structured | Take · adapt · refuse |
| --- | --- | --- |
| **The spine and NOW** (§12.2, §14.4) | the timeline; opens at the current day, not the current time; overlaps stack | **Keep ours.** The page opens at now and the morning folds; placement is derived, so the cascade they fight never starts. Pin it with a test (TD-3). |
| **Task minutes** (`task_size_minutes`, S/M/L) | exact duration asked at creation | **Adapt.** Coarse buckets stay (the `~` is honest), but an unsized row should be sizeable where it sits, not only in Obsidian (TD-5). |
| **The Inbox / All** (§8, `where:`) | a separate undated list; drag onto a time to schedule | **Adapt.** Any `- [ ]` line in any note is already capturable and filterable; what is missing is the one-step *put this on today* from All (TD-1). |
| **The day bar** (§14.3, §15.7) | an energy bar tinted green → orange → red, red suggesting deletion | **Refuse the tint-as-verdict.** Segments in the chart ramp, words and an `AXChartDescriptor`; *Doesn't fit* stays hollow at 0m; nothing suggests deleting. |
| **Close the Day** (§15.5, T2-8) | Replan: per task, swipe up/left/right/down, offered at a set time with a notification | **Adapt the pace, refuse the exits.** Take one-key-per-task triage (TD-4); keep Tomorrow · This Week · Someday and **no delete** — a line in the owner's note is never removed by Metistry. The unclosed day gets one line in the brief, not a push (TD-2). |
| **Slipping / Owed** (§15.6, X-14) | none: an unfinished task sits on its past day until replanned | **Keep ours**, and ship X-14 so Slipping is real. The carry chip climbs quietly (never `failed`) — the opposite of a red overdue list. |
| **plan-tomorrow / Morning Brief / Standup** | no ritual; the AI drafts a day on request | **Keep ours.** Model-free plan and standup from the owner's templates; the brief's prose is one labelled wash. Their AI is paid per use; our plan costs nothing to render (invariant 4). |
| **Next Up** (§15.2) | Live Activity and start/end alerts per task | **Refuse the alerts.** Next Up is on the page from T–30 and pushes nothing; **Needs You is the only interruption**. |
| **Capture bar** (screen 11) | text, voice, or a photo of a paper list → proposed tasks | **Adapt later.** Their per-row Update · Edit · Discard is the shape a To-do from the bar should take if it ever proposes several lines; it writes as `user` only on approval. |
| **Calendar help** (§14.5, C90) | read-only; *push following tasks* is an AI prompt | **Keep ours.** A deterministic verb, never a model round trip, for anything the owner does daily; a move with attendees warns and names them. |
| **Invariant 1 — git is the record** | their cloud database; JSON export on Apple only | **Refuse.** Tasks are lines in notes; Postgres is derived; nothing about the day lives only in an app store. |
| **Enforce at the tool** | the AI may delete tasks, gated by a Discard button | **Keep ours.** The assistant's day changes are attributed, diffed and undoable (§13.5, §14.2), and the doors (check, defer) change one field of one line, 409 on drift. |
| **Second-instance wording** | n/a | Nothing here needs it; any public text on another machine's day says *second instance* and nothing more. |

## 5. Other lessons

- **Onboarding frames the day.** Their seeded wake and wind-down anchors do what our *Metistry doesn't know which days you work* absent state does in words. The first-run flow should ask for `working_days` and `working_hours` and write `Me/profile.md` as the owner's own act, so the first Today already has a day bar and a Close the Day window.
- **Notification restraint.** Two alerts per task, on by default, makes a full day a dozen or more interruptions, and *time-sensitive* breaking through Focus is a promise we should not make. Our rule holds: Today and Next Up are pull; the PWA's web-push is for Needs You only.
- **Calendar-write ethics.** Their most-voted unshipped request is writing tasks into the calendar. The cost they are weighing is ours too: a task written as a calendar block is visible to everyone who can see free/busy, and becomes a second copy of a line in a note. Our line — focus blocks with nobody else in them, moves that name the attendees, the calendar sends the update — is the stricter one; Q1 asks whether it should go further.
- **A missing verb bought from a model.** *Push all following tasks* lives in a paid AI prompt. A daily verb delivered by an LLM is slower, costs money and can be wrong; our spine makes that verb unnecessary, and anything similar belongs in the closed action set (invariant 10).
- **Accessibility.** Colour and icon are their only categories, and the energy bar speaks in colour; ours keeps priority as weight, categories uncoloured and every chart spoken (§13.3, mac-app § Today). Their swipe-direction triage needs a VoiceOver equivalent; ours must ship the keys and the named actions together (TD-4).
- **Privacy claims should be checkable.** Their AI page makes two statements about calendar data that are hard to hold at once. Ours: every model call is a `runs` row with its tier, and the private tier keeps a turn on the machine.
- **Positioning.** They are freemium, and Pro holds the daily loop — calendar import, recurring, Replan. Metistry is fully open source with no premium, so none of Today is gated; the story is *your notes are the planner*, not a subscription tier. Their ADHD framing (research partners, low-dopamine design) is theirs; we make no clinical claims.
- **Naming collision.** Their users ask for *Routines* meaning a saved group of tasks; ours are scheduled runs. Public copy that compares the two should say *recurring tasks* for theirs.

## 6. Candidate tickets and open questions

**Tickets** (proposed; none is in the plan):

1. **TD-1 · Today from All** · S — All's rows gain **Today** beside Tomorrow · This Week · Someday, through the Defer door (`do <today>`, T2-5), so an undated line joins the spine in one act; maps T6-1a, T2-7; test: a line already due today is a no-op, 409 on drift.
2. **TD-2 · The day that wasn't closed** · S — on the first open of a working day, if the previous working day has no close, the brief's foot carries one line, *Yesterday wasn't closed · 4 still open · Close It*, opening Close the Day for that day (`POST /api/today/close {day}`) without re-rendering a plan for a day already under way; never a Needs You request or a push; maps T6-1b, T2-8, T3-7.
3. **TD-3 · Running late re-flows, tested** · S — spine tests: gaps start at `max(now, dayStart)`, a meeting that runs over moves the rows after it with no write, a row ticked early frees its minutes on the next open; maps T6-1a.
4. **TD-4 · Close the Day by keyboard** · S — in Still Open and Owed: `j`/`k` move, `t` · `w` · `s` defer to Tomorrow · This Week · Someday, `space` ticks, with VoiceOver actions of the same names; nothing binds to delete; maps T6-1b, screen-05 §9.
5. **TD-5 · Size a row where it sits** · M — an unsized row's reason line offers S · M · L, written by a new closed-set door (`…/size {s|m|l, seen_text}`) that changes the size token and nothing else, 409 on drift; maps T6-1a, T2-5 (sibling door), invariant 10.
6. **TD-6 · Protect a gap** · M — a gap of 90 minutes or more offers **Block This Time**: a calendar event with no attendees, through `POST /events`' preview-then-execute, titled from the rows in it; one of the three predictions, never automatic; maps T2-11, §14.5.

**Open questions for the owner.**

1. **Should a task ever reach the calendar?** Structured's most-voted unshipped request is exactly this. Options: never (tasks stay lines; only TD-6's gap-level focus blocks), or a private block per task written on request and removed when it is ticked — a second copy of the line, with free/busy visible to others.
2. **Should Close the Day offer a drop?** Replan's fourth exit is delete. Ours has Someday as the soft exit and nothing that says *won't do*. A `[-]` cancelled state written by the check door (one byte, Obsidian Tasks' convention) would close a line honestly without deleting it — or does Someday cover it?
3. **Is the unclosed day a line or nothing?** TD-2 puts one line in the brief; the alternative is silence, since `plan-tomorrow` at 23:00 already renders from the day as it stood and the carry chip climbs. Structured answers with a scheduled push; we will not, but should we say anything at all?

## Sources

- Structured site: <https://structured.app/>; blog: [Structured turns five](https://structured.app/blog/structuredfive), [Replan](https://structured.app/blog/replan), [the new Structured AI](https://structured.app/blog/the-new-structured-ai).
- Help centre (<https://help.structured.app/>): [getting started](https://help.structured.app/en/articles/380546), [free vs Pro](https://help.structured.app/en/articles/1897986), [inbox](https://help.structured.app/en/articles/338178), [drag and drop](https://help.structured.app/en/articles/338306), [reschedule unfinished tasks](https://help.structured.app/en/articles/1990594), [how to use Replan](https://help.structured.app/en/articles/4511874), [recurring](https://help.structured.app/en/articles/338114), [what is Structured AI](https://help.structured.app/en/articles/1782402), [editing with AI](https://help.structured.app/en/articles/3320002), [notifications](https://help.structured.app/en/articles/1870914), [import calendars](https://help.structured.app/en/articles/329730), [export](https://help.structured.app/en/articles/333506), [sharing](https://help.structured.app/en/articles/338562), [energy monitor](https://help.structured.app/en/articles/998530).
- App Store listing and ratings: <https://apps.apple.com/us/app/structured-daily-planner-todo/id1499198946> (fetched 2026-09-28).
- Feedback board and changelog: <https://feedback.structured.app/> (sorted by votes), <https://feedback.structured.app/p/two-way-calendar-sync>, <https://feedback.structured.app/changelog>.
- Third-party: [Dave Swift's review](https://daveswift.com/structured/) (April 2024); [Saner.AI's review](https://blog.saner.ai/structured-review/) (a competing product; not relied on alone for any claim).
- Metistry: `docs/product/design/screen-05-today.md` (§4, §8, §9, §12–§15), `screen-11-capture-bar.md`; `docs/ops/mac-app.md` § Today; `apps/macos/sources/kit/today-model.swift` (spine builder); `routines/plan-tomorrow`, `morning-brief`, `standup` manifests; `docs/product/design-build-plan.md` T2-5, T2-7, T2-8, T2-11, T3-7, T6-1a, T6-1b, X-14, §2.9; `docs/product/PRODUCT.md` § Goals.
