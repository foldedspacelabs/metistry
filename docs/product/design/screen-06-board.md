# Screen 6 — Work ▸ Board

Round D, sixth. Board: `Work ▸ Board`. The brief calls board density the
hardest layout in the product; §1 is the answer.

## 1. Six columns that are not six equal columns

Four columns are **live** — Backlog, Addressed To, In Progress, Needs You —
and two are **finished**. Finished work does not need a column of cards; it
needs a count and a way in.

So Done and Reported are fixed at **168px with compact rows**, and the four
live columns share everything else. At a narrow window the two collapse into
one strip with a combined count, expanding on click — they are the only two
that can collapse without hiding something you were about to act on.

**Nothing about the model changes.** Same six columns, same order, same
predicates, same `array_position`. Only the width changes, so `docs/ops/board.md`
is untouched — which matters, because the columns are a **decision order**
(first match wins) and merging or reordering them would break the rule the
query depends on.

## 2. Each column shows the facet that column is about

| Column | The question it answers | What the card shows |
| --- | --- | --- |
| Backlog | how long has nobody taken this? | `2d in backlog` |
| Addressed To | whose name is on it? | the owner chip |
| In Progress | how much lease is left? | `4m left`, or the lapse |
| Needs You | why is it stuck? | the state chip |
| Done | when did it close? | `closed 2h ago` |
| Reported | what came back? | the report chip |

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
- **Clicking a card** opens its room when `has_thread`, else a detail popover:
  title, owner, lease, external ref, last activity, and the artifact a review
  bundle was cut from.
- **Polls every 10s** while visible. `cache_ttl: 0` — a board that lags lies
  about who holds a lease.

## 4. Drags

**The board offers no drop the service would refuse.** A target is drawn only
where a statement in `packages/tasks` would succeed, and when the two disagree
the **statement wins**: the card snaps back carrying the server's own sentence,
never one the interface invented.

**Each drop is exactly one route.** Anything needing two calls is not a drop —
hence no "assign and claim" gesture, and **Reported is not a target at all**,
because nothing you can drag makes a report exist. A closed card gets no grab
cursor, because `update()` refuses a closed row.

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
4. **"Addressed To" and `assigned` are one thing with two names.** The label
   was ruled 2026-09-17; the value stays `assigned` because every drop and
   every `runs` row carries it. That is the correct call — renaming a wire
   value to match a label is how you break history — but the glossary should
   carry both, or someone will "fix" one of them. (C38)
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
- Card detail popover is referenced and not yet drawn — it is the next screen
  in this section along with Projects, Artifacts and Rooms.
