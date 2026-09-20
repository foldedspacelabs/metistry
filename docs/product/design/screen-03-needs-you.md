# Screen 3 — Needs You

Round D, third. **Not a screen**: a popover on Mac, a sheet on iOS, and one
real list behind both for when the queue is long. Board: `Needs You`.

Round C drew the request card and the panel and left the list open. The
endpoint settles most of what was open — and shows that the panel header I
specified last round cannot be built.

## 1. The bell

The only badge in the product (P2). No counts on sidebar rows, none on
Activity, none on Work: every other number is something you go and look at,
and this one is the product asking.

| Count | Rendering |
| --- | --- |
| 0 | **no badge** — no zero, no dimmed dot. A count of nothing is not information, and a badge that is always there stops meaning anything |
| 1–99 | the number, `accent` on `on-accent` |
| >99 | `99+`. Past this the number has stopped being a count and become a mood; the list is where you deal with it |

`accent`, not a state colour. These are decisions, not failures — a full queue
is normal and the badge must not read as an alarm.

## 2. The panel (Mac)

400px, opaque `elevated`, elevation 3, anchored under the bell. Unchanged from
round C except the header and two additions.

**Header: "Needs You · 4 waiting".** Round C specified "4 waiting · 1 snoozed".
That cannot be built — see §6 fault 1.

**Grouping.** Cards grouped by type with a small group label, oldest first
within a group. Type chips filter. The group label carries its own count so
the eye can skip a whole type.

**Trust.** Each card's actor now carries its `trust` (§6 fault 3): nothing for
`internal`, an `external` marker in `degraded`, `you` in neutral. Internal is
the default and a marker on everything is a marker on nothing.

**Footer: one link, "Show all 12 →"**, only when the queue outruns the panel.
No batch bar — round C's reasoning, and the wire agrees (§3).

**Empty.** "Nothing needs you." / "Agents are working and nothing is waiting on
a decision." No chips, no footer, no count in the header — an empty queue does
not need a filter.

## 3. The full list — the open item from round C, settled by the endpoint

`POST /api/proposals/batch` takes `BATCH_DECISIONS = ["later", "skip", "deny"]`
and refuses everything else, with a refusal message that explains itself:

> `allow`, `accept_with_changes` and `accept_as_work` each do something per
> kind (a prompt overlay write, a work row), so they stay one at a time

So the selection bar carries **three verbs and never Approve**. Four answers on
a card, three on a selection; the difference is not a simplification, it is the
endpoint's own list quoted back.

This also confirms round C's call on **Skip**: it came off the card as a fifth
button and lives as a batch verb, which is exactly where the wire puts it.

| Verb | In bulk | Notes |
| --- | --- | --- |
| Later | yes | puts rows down for `METISTRY_SNOOZE_HOURS` — config (§6 fault 5) |
| Skip | yes, and **only** in bulk | stores a `deny` whose feedback is `SKIP_FEEDBACK`, firing none of deny's per-kind consequences |
| Decline | yes | a `deny` per row, with one reason given once |
| Approve / Revise / Approve-as-work | **never** | the interface must not offer what the endpoint refuses |

Every row still carries its own four answers. Bulk is the long-queue surface,
not a replacement.

**"Select all on this page"**, said in those words, because `MAX_LIST` is 100
and the queue can be longer (§6 fault 4). An honest label beats a hidden cap.

### 3.1 Partial success is the normal outcome

The batch is all-or-nothing **per row** — each id its own statement, its own
result — and the source says why: *"the alternative is a batch that refuses
everything because one item was answered on the phone thirty seconds ago."*

So the result state is not a toast saying done. It is a band above the list:

> **2 of 3 declined.** One was answered somewhere else while this was open. It
> is still selected — nothing was lost and nothing was re-sent. `[Retry 1]`

The applied rows carry a per-row receipt, the unapplied one keeps its selection
so Retry acts on exactly it, and the colour sits on the **glyph** while the
words stay `text-primary` — colour never carries the outcome alone (§2.1).

## 4. iOS — a sheet

Same cards, same order, same four answers. What changes is reach: a sheet rises
from the bottom, so the thumb lands on the **first card** rather than a header
— which is the argument for oldest-first all over again, since the oldest thing
is the one under your thumb.

"Show all" is a full-width row rather than a link: a sheet has no footer chrome
to hang a link on, and at the bottom of a scroll it is where you already are.
It pushes a list, which is a screen. The sheet does not grow into one.

The one thing iOS cannot carry is hover-to-preview: the scope diff is
tap-to-expand and the card grows in place. Nothing here is keyboard-only, so
nothing else is lost.

## 5. Keyboard (Mac)

Panel: `⌘9` toggle · `↑ ↓` between cards · `a` approve · `r` revise · `d`
decline · `l` later · `esc` closes having changed nothing.

List: `space` toggles a row's selection · `⌘A` selects the page · `⇧↑ ↓`
extends · `l` `s` `d` apply the three bulk verbs to the selection · `esc`
clears the selection before it closes the window.

`s` is Skip **in the list only**. It is not bound in the panel, because there
is nothing there for it to do.

## 6. What this round found

1. **The panel header I specified in round C cannot be built.** It read
   "Needs You · 4 waiting · 1 snoozed". `GET /api/proposals` without a cursor
   returns `decision = 'pending' AND (snoozed_until IS NULL OR snoozed_until <=
   now())` — snoozed rows are excluded by the query, so the panel has no way to
   count them. My spec asked for a number the wire does not serve. Dropped to
   "4 waiting". If the count is wanted it is a second call or a new column, and
   I would rather not have it: a snooze is a thing you chose to stop seeing.
   (C21)
2. **Partial success is the normal case, not an error** — §3.1. Worth stating
   because the obvious design (one success toast) is wrong here by
   construction.
3. **`trust` is returned on every row and the design had never used it.**
   `internal | external | user` — the provenance of the request. An external
   agent asking for write access is not the same object as the assistant asking
   to keep a note, and P1 says the difference between our words and someone
   else's has to be visible. Now a marker beside the actor. (C22)
4. **Select-all cannot mean all.** `MAX_LIST` is 100; the batch refuses more.
   The label says "on this page" and means it.
5. **The snooze interval is configuration.** `METISTRY_SNOOZE_HOURS` defaults
   to 3 and is explicitly "an opinion about a working day". No copy may say
   "3 hours": Later reads **later today**, and the receipt names the actual
   return time, which `snoozed_until` gives us.
6. **I broke my own rule from last round.** Round D screen 1 added: *text-tertiary
   never sits on a tinted fill*. The first draft of the list row put
   `text-tertiary` on `accent-quiet` for the type label and the timestamp —
   4.17:1 light, 4.06:1 dark. Same token, same ground, one round later. The fix
   is not another patch: `accent-quiet`'s role now **enumerates the ink that is
   legal on it**, because a selection ground re-inks everything inside it and
   every role that can appear in a row has to be checked against it, not just
   the ones I happen to think of. tokens 2.5.0.

## 7. Data sources

| Piece | Source |
| --- | --- |
| the queue | `GET /api/proposals` — no cursor: pending, minus snoozed-into-the-future |
| what was settled while away | the same endpoint **with** a cursor: changed rows carrying `decision`, `decided_at`, `snoozed_until` |
| the badge count | the queue's length |
| one answer | `POST /api/proposals/{id}` with `if_unchanged: {seen_at}` |
| the selection's verb | `POST /api/proposals/batch` — `later \| skip \| deny`, ≤100 ids, per-row results |
| trust marker | `trust` on the row |
| the snooze interval | `METISTRY_SNOOZE_HOURS` |
| "1 snoozed" | **nothing** — §6 fault 1 |

## 8. Open items

- Whether the snoozed count is worth a second call. My answer is no.
- A cursor reconnect can reveal that rows were decided elsewhere. The panel
  should reconcile silently; whether it should *say* "3 were answered
  elsewhere" on open is undecided, and leans no — it is the past, and the panel
  is a queue.
- `SKIP_FEEDBACK` is a sentinel string in the feedback column. Nothing in the
  design surfaces it, which is correct, but it means a skipped row and a
  declined-with-that-exact-text row are indistinguishable in storage.
