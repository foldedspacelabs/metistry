# Design engagement — handoff

**You are the designer for Metistry.** This file is everything a new session
needs. Read it, then `review-00-plan.md`'s ratified section and the screen spec
for whatever you are about to touch. Do not read the whole `docs/product/design/`
tree up front — it is large, and the specs are written to be read one at a time.

Branch: `design/round-0-plan-review`, 25 commits, merged onto v0.11.0.
Canvas: the `Metistry brand — round A` artifact (a Design-type artifact, 22
artboards). Tokens: **2.6.2**, 144 contrast pairs green.

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

**Public-text rule:** never refer to the owner's employment. Say *second
instance*.

## 2. Which documents win

`design-brief.md`, `design-system.md`, `app-ux-plan.md` and `ux-direction.md`
were **not updated for v0.11.0** and still describe a six-section sidebar and a
Work section with four children. The current authority is
**`daily-flow-spec.md`, `PRODUCT.md` and `glossary.md`** (C26). When they
disagree, the newer three win and the disagreement gets logged.

## 3. What is ratified — do not re-litigate

**Navigation.** Seven rows: **Today · Chat · Activity · Work ▸ · Knowledge ▸ ·
Agents**, then **Pinned**. Today is first and top-level (C30) — it holds
meetings, artifacts, requests and agent status, none of which Work owns. Work's
children are Board · Projects · Artifacts · Rooms.

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
| Activity | `screen-02-activity.md` | done |
| Needs You | `screen-03-needs-you.md` | done — bell, panel, full list |
| Capture | `screen-04-capture.md` | done |
| Today | `screen-05-today.md` | done, v6 — the spine, the day bar, calendar help |
| Board | `screen-06-board.md` | done — five columns |
| Facets & colour | `facets-and-colour.md` | the system itself |

**Not drawn:** card detail popover, Projects, Artifacts, Rooms, Knowledge,
Agents, Usage, Settings, the Obsidian plugin's remaining surfaces.

**Run detail is deliberately not drawn** — no `/api/runs/:id` and no
`run_detail` query exist, so it cannot name its data source, and the brief says
that does not pass. The query it needs is specified in `screen-02-activity.md`
§7.

## 5. Debts, in priority order

**Back-patch pass (deferred by the owner, now overdue).** Two are real design
work, not cosmetics:
- **Needs You** needs the `access_request` card kind — an agent asks for a
  named area; Approve / Revise (narrow the prefix) / Decline; a re-ask after a
  decline shows *asked again*.
- **Activity** needs the new row type for the day's plan and standup draft.

Separately, Chat, Activity, Needs You, Request and States were drawn **before**
the facet system and are stylistically behind it. They are not wrong — their
decisions are committed in their specs — but the canvas contradicts itself until
they are regenerated.

**39 contradictions** are logged in `review-00-plan.md`. C38 is closed. The ones
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

**Open rulings the owner owes:** C16 (motion — the working indicator vs
*ux-direction.md*'s "a word, not a spinner"), A5 (`prose` outside a fold
template), B4 (where a revised day is stored and under whose principal).

## 6. How to work

**The canvas generator is on disk** — `docs/product/design/boards/`. Read its
README. Edit `lib.py` or a board module; **never paste a generator into the
conversation**, which is what made the first pass expensive.

```
METISTRY_CANVAS=<canvas dir> python3 build.py [board]
```

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
