# Screen 18 — The PWA on a phone, and in a narrow window

New, 2026-09-24. Boards: `PWA-Shell`, `PWA-Today`, `PWA-NeedsYou`, `PWA-Work`,
`PWA-More`. The PWA is a release feature and the owner's away-from-desk client;
the native iPhone app stays deferred.

**Rulings taken before drawing (2026-09-24):** Today first, then the PWA; phone
(390pt) first, then a narrow window; **a bottom tab bar — Today · Chat · Work ·
Knowledge · More — with the bell and + in the header.**

## 0. What I found in the shipped PWA

`apps/console/web`, read before drawing:

- **The 900px breakpoint already exists** (`style.css:131`) and matches
  app-ux-plan §3.3 — sidebar at ≥900px. Below it the nav is a horizontally
  scrolling strip of eleven buttons with **emoji glyphs** (`style.css:119–128`),
  which is what this design replaces.
- **No offline anything.** `sw.js` handles push display and taps only: *"No
  offline caching yet."* The server side of offline shipped on 2026-09-11
  (idempotent capture, 409 on a settled decision, `since` cursors); the client
  side is §4 below.
- **Web push works**, including the iOS rule that only an installed Home Screen
  app may subscribe (`app.js:442`) — but the flows speak through `window.alert`.
- **The manifest is stale:** `name: "metistry"` (decision 15 says *Metistry*),
  theme and background `#f6f7f9` (the ground is `#f7f4ee`), and one SVG icon —
  which iOS does not honour (C13).
- **Enrolment** is a one-time-code link opened on the device (`#enroll=`), then a
  passkey. Drawn as a wall, not an alert.

## 1. The shell

- **Tabs:** Today · Chat · Work · Knowledge · More. **No tab carries a badge**;
  the bell is still the only one (P2). More holds Activity, Agents, Routines,
  Usage and Settings, in the Mac's order.
- **Header:** a large title that collapses to an inline one on scroll; **+** and
  the **bell** at the right. The usage gauge joins them from 600px; below that
  Usage is under More and arrives as a sheet.
- **Work's children** are a segmented control at the top of the tab — Board ·
  Projects · Artifacts. No Rooms (C89).
- **Sheets** for the bell, Capture, Usage and an artifact's thread; **pushes**
  for a card, a room, an agent and every More row. 44pt rows, 16pt gutters,
  the tokens' type scale, the browser's text size respected.
- **600–899px** keeps the tab bar and the header, caps the content at the
  reading measure, and returns a second column only where the Mac has one
  (Today's rail, from 760px). Board's columns scroll sideways and snap.
  **At 900px the PWA is the Mac layout.**

## 2. Today

One column in the Mac's order: the brief (or its folded line), Next Up, then the
spine, with the time as a line above each item. **The rail comes last** —
Agents, Since You Last Looked — and the Needs You line is dropped, because the
bell is in the header. The brief, Next Up and Close the Day are the Mac's
components at 358pt; their choices wrap under the row.

## 3. Needs You, Chat, Capture

- **The bell opens a sheet** holding the Mac panel's cards, same answers, same
  order (C92). **Select** switches to a compact list where **swipe right
  approves and swipe left declines** — Decline in the neutral surface, never
  red. A card with *Before and after* opens instead of swiping, because its
  consequence needs reading.
- A meeting card pushes to full height from the sheet.
- **Chat** is the same column at 358pt; the reply keeps its 2px rule inside the
  width; the composer floats above the tab bar.
- **+** opens the same Capture sheet from the header, the share sheet or a
  notification.

## 4. Offline — one rule per verb

| Act | Offline |
| --- | --- |
| Reading | the last view, stamped: *Showing 9:04 AM* |
| Capture | **waits**, and sends with its idempotency key |
| Tick a task | **waits** with the line it saw; replays through the 409 check |
| Answer a request | **not offered** — disabled ink, *Decisions need the connection* |
| Send in Chat | **refused** with the reason; the draft stays; Try Again |
| Move a card, Run Now, a mode, a grant | **not offered** |

The principle: anything with a consequence for someone else, or that cannot be
taken back, needs the server's answer before it happens. A note to yourself
does not. A band under the header says *Can't reach Metistry* and what still
works.

## 5. Work, Knowledge, More

- **Board** shows one column, picked by chips with counts. Drag becomes **Move
  to…**, an action sheet listing only moves the service accepts; an illegal one
  is shown disabled with its reason (*only an agent claims a card*).
- **Every tap opens the card** (C84), full-screen; the room is a push from it.
- **An artifact's threads** become counts on their highlighted lines, opening a
  sheet — the margin does not fit.
- **Knowledge** opens on the fold, then Needs Your Eye, then Areas.
- **Agents** are read and granted from the phone; the permissions table becomes
  one row per resource with Read and Write lines. Defining an agent stays on the
  Mac.
- **Settings** is a grouped list. **Secrets and Live Capture are Mac-only.**
- **Compute ▸ Budgets is drawn here first** — the monthly limit and each
  project's daily budget. Both *Raise* buttons (Usage, Projects) land here
  (review 01 R2.6); the Mac pane follows the same content.

## 6. Notifications and install

- **Ask in context**, the first time something reaches Needs You — never on first
  launch. Only Needs You notifies, never activity.
- A notification says the card's type and title and nothing more, and never a
  secret. **Tap opens that card.** No action buttons: iOS web push does not offer
  them, and answering blind is the thing the card exists to prevent.
- **Install on iPhone** is a three-step sheet (Share → Add to Home Screen → open
  it), because Safari has no install prompt and push needs the installed app.
  Chrome and Edge use their own prompt, offered once from More.

## 7. What this asks of the build

1. **The tab bar and header** replacing the eleven-button strip; glyphs, not emoji.
2. **A service worker with an offline shell and an outbox** for captures and
   ticks, replaying with `Idempotency-Key` and the check route's 409.
3. **Manifest:** `name: "Metistry"`, theme and background from the tokens per
   scheme, and PNG icons with `apple-touch-icon` (C13).
4. **Push and enrolment without `alert()`** — the sheets drawn here.
5. **Compute ▸ Budgets** reads and writes the instance and per-project budgets
   (review 01 R2.6).
6. `board` returns `has_thread` and a count per card (screen 16).
