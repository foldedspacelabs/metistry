# Screen 6 — Work ▸ Board

Round D, sixth. Board: `Work ▸ Board`. The brief calls board density the
hardest layout in the product; §1 is the answer.

## 1. Five columns, and four of them are the board

**Reported is not a column.** `board.md` argues this itself: Done-vs-Reported
"is not on the row — it is reconstructed" from a join between `work` and
`runs.meta.work_id`. It was never a *status*; it was the fact that something
came back. That is a property of the card, so it is **a chip on the card** — a
note glyph and what the report said.

The query need not change: `last_report_at` keeps arriving and the panel stops
using it to choose a column. Whether `'reported'` leaves the `CASE` is the
build's call; the design only needs it to stop being a place.

**The column is `Assigned`, not "Addressed To".** That reverts the 2026-09-17
label ruling. The reason to take it is that the wire value has always been
`assigned` — every drop and every `runs` row carries it — and a label that
disagrees with its own value is a bug waiting for someone to "fix" the wrong
side of it. This **closes C38** rather than documenting it.

**Four live columns and one finished one.** Backlog, Assigned, In Progress and
Needs You share the width; Done is fixed at **168px with compact rows** and
collapses to a strip at a narrow window. The density fix is easier at five
columns than it was at six.

The ordering rule is untouched: the columns are still a **decision order**,
first match wins.

## 2. Each column shows the facet that column is about

| Column | The question it answers | What the card shows |
| --- | --- | --- |
| Backlog | how long has nobody taken this? | `2d in backlog` |
| Assigned | whose name is on it? | the owner chip |
| In Progress | how much lease is left? | `4m left`, or the lapse |
| Blocked | what would unblock it? | the one-line reason, as a chip (ruling 3; the column was drawn as *Needs You* until 2026-09-23) |
| Done | when did it close — and did anything come back? | `closed 2h ago`, plus a report chip where there is one |

**The way out of a crowded card is not a smaller card — it is fewer facets.**
A Backlog card has a null owner and no lease; a Done card has an age nobody
cares about. Each column renders **one** column-specific facet plus whatever is
exceptional, so the card gets quiet without getting small.

Everything else is a **mark**, not a chip: a speech bubble when the card has a
room (`has_thread`, already on the wire so the board never asks a second
endpoint), a note glyph in `entity-note` when it was promoted from the vault
(`external_ref`). Two glyphs, no words, both clickable.

## 3. Reading the board

- **Column headers count every card**, not the rendered ones; `limit` is per
  column, and a capped column says `showing N of M`.
- **The escalation count** sits beside the total in `degraded` — see §5 fault 1.
- **Ordering** is board order, then most recently touched.
- **The project filter** comes from `board_projects`, so it only offers
  projects that have cards. `[` and `]` step it.
- **Clicking a card** always opens the detail popover (screen 14; ruled
  2026-09-22, C84). A thread is a section inside it with **Open room**.
- **Polls every 10s** while visible. `cache_ttl: 0` — a board that lags lies
  about who holds a lease.

## 4. Drags

**The board offers no drop the service would refuse.** A target is drawn only
where a statement in `packages/tasks` would succeed, and when the two disagree
the **statement wins**: the card snaps back carrying the server's own sentence,
never one the interface invented.

**Each drop is exactly one route.** Anything needing two calls is not a drop —
hence no "assign and claim" gesture. A closed card gets no grab cursor at all,
because `update()` refuses a closed row, and with Reported folded into Done
there is no longer a column that only a report could fill.

Two absences are deliberate and worth drawing attention to: **nobody drags a
card onto another agent's lease** (In Progress is entered by claiming, and a
claim is always your own), and **assignment has no agent surface** — `owner`
exists on `PATCH` and nowhere else, so a human may address a card to any crew
and an agent cannot address one. Enforced by absence rather than by a check.

**Keyboard is the same routes**: focus a card, `m`, choose a column. Same
targets, same refusals. `Esc` closes a picker, `Enter` opens the card.

**Optimistic, then authoritative**: the card moves, the route runs, the board
refetches either way. The server owns the columns.

## 5. What this screen found

1. **Nothing on this board is red, and the ops doc says it should be.**
   `board.md` calls for "the red number" beside a count and "a red chip says
   why". But a lapsed lease, an overdue card and a blocked row are all
   **`degraded`** in the ratified vocabulary — attention, not failure. `failed`
   means *this broke*; if escalation is red then a busy board is a red board
   and red stops meaning anything. Drawn in `degraded` throughout. (C36)
2. **`escalated` is a boolean and the card has to say why.** `board.md` is
   explicit that the panel re-derives the label — *lease lapsed* / *blocked* /
   *overdue* — from `lease_expires_at`, `status` and `due`, while the
   **decision** stays in the query. Worth restating, because the obvious
   shortcut is a second boolean per reason, and then two places decide what
   escalated means.
3. **`blocked_by_task` is not in `board.yaml`.** `daily-flow-spec.md` §3 says
   the board gains `blocked_by_task` and `blocked_by_task_open` so a card can
   read *waiting on you: Call the dentist*. The columns are not there, and
   Today already draws that string on its work rows — **two screens now waiting
   on the same two columns**. (C37)
4. **The label and the wire value now agree, and Reported is not a column.**
   "Addressed To" goes back to **Assigned**, matching the value every drop and
   every `runs` row already carries — **C38 closes** rather than being
   documented. And Reported folds into Done, which `board.md` half-argues for
   already. Both are edits to `docs/ops/board.md`. (C39)
5. **A review card names an artifact and the board cannot show it.**
   `artifact` (`meta.bundle.artifact`, a handle, never a payload) comes back on
   every row and there is nowhere sensible for it on a card this size. It lives
   in the detail popover. Recorded so it is not later read as an omission.

## 6. Data sources

| Element | Source |
| --- | --- |
| every card | `board` — `column, id, title, kind, project, owner, claimed_by, lease_expires_at, age_hours, last_report_at, escalated, external_ref, artifact, has_thread, status, due, updated_at` |
| the six columns | the query's `CASE`, first match wins |
| column totals and escalation counts | `board_projects` — one row per project × column |
| the project filter | `board_projects`, so only projects with cards |
| the room a card opens | `has_thread` |
| promoted-from-note mark | `external_ref` beginning `vault:` |
| "waiting on you: …" | **nothing** — §5 fault 3 |
| every drop | one route each, per `board.md`'s table |

## 7. Open items

- The two `blocked_by_task` columns (fault 3), wanted by two screens now.
- Whether `escalated` should ever gain a fourth clause. `board.md` rules that
  it needs its own sentence and its own decision; nothing here asks for one.
- Card detail popover: drawn as screen 14.

## Corrected 2026-09-23 (review 01)

- The fourth column is **Blocked** (ruling 3), and its card chip is the one-line
  reason — *Waiting on #417 to merge* — not the word *Blocked* again.
- The filter row gains **Has Thread** (C89); a card's thread and note marks open
  the card's detail like every other click (C84).
- *Release to Assigned*, not *Addressed To* (C38).

