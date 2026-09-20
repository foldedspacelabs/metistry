# Screen 5 — Work ▸ Today

Round D, fifth. Drawn against **v0.11.0** and `daily-flow-spec.md` §10.
Board: `Work ▸ Today`. Work's fifth child; the global task view is a **mode**
of it, not a sixth.

## 1. Why this screen is different from every other one

Everywhere else in Metistry you read what an agent did, or answer what one
asked. Today is a list of things **you** will do, pulled from your own notes.

That inverts P1. P1 exists because agent-written text must never look like a
control — but here the task line is *the owner's own handwriting*, and it must
look actionable, because it is. What P1 governs on this screen is everything
**around** the line: the reason, the ordering, the capacity number. All of
those are Metistry's opinion about someone's day, and none of them may read as
fact. (§7 fault 1 — this belongs in §2 of the design system, not rediscovered
per screen.)

## 2. The row

`[grip] [lead] title  ⟨chips⟩` with a reason line beneath.

**Two origins, told apart by the affordance itself** (§10.2):

| | markdown task | `work` row |
| --- | --- | --- |
| lead | a **checkbox** — you tick it | the **board glyph** in `agent`, and **no checkbox**, because there is nothing here for you to tick |
| lives in | a line in your note, path shown | a row on the Board, owner and lease shown |
| verbs | Complete · Open in Obsidian · Hand to an agent | Open on the Board — it is not yours to finish |
| source | `vault_tasks` | `work` + `meta.blocked_by` |

The difference is carried by **what you can do to it**, not by a tint. That
survives greyscale and a colour-blind reader, and it cannot be misread the way
two shades of one chip can (§2.1).

**The reason line** is `due Wed · P1 · ~45m · blocking work #418` — the fields
the row already has, in `text-secondary`, never styled as a control.

**Drag to reorder**, and the order you leave it in is stored and authoritative.

## 3. The chips

| Chip | From | Rule |
| --- | --- | --- |
| carry-over | `first_seen_on` | nothing at 1 · neutral at 2 · `degraded-quiet` at 3–4 · `degraded` with a glyph at 5+. **Never `failed`** (§7 fault 3) |
| "2 places" | `duplicate_of` | collapses the group, opens to both paths. Copy never implies a merge — nothing merges, nothing deletes |
| parse warning | `parse_warning` | the row renders normally with a `degraded` note naming the token: *couldn't read `every weekdy` — the rest of the line is fine* |
| blocking | `work_id` / `meta.blocked_by` | both directions: "blocking work #418" on a task, "waiting on you: Call the dentist" on a work row |

## 4. The capacity meter

Minutes planned against `daily_capacity_min` (240). Under capacity the bar is
`accent`; over, the overflow segment is `degraded` and the label reads
`285 of 240 min planned · 45 over`.

**It refuses nothing.** No block, no modal, no warning. It reports a number and
stops.

Minutes are `task_size_minutes` (`S`=15, `M`=45, `L`=90) from `Me/profile.md`,
never a literal in code — so every figure is three coarse buckets added up, and
the tilde on `~45m` is load-bearing (§7 fault 2). The total says **planned**,
never *remaining*.

## 5. Completing, and the phase where it is not possible

**Phase 1 is read-only** and that is not a placeholder. Anchors have not
shipped, so nothing can find the line again safely and therefore must not try.
The checkbox is drawn and **not interactive**; the affordance is *Open in
Obsidian* (`obsidian://open?vault=…&file=…`).

**Phase 2** adds the write, and it is a confirmed, undoable gesture because it
writes the user's own file:

1. **Confirm**, showing the exact line about to be written.
2. `POST /api/vault-tasks/:task_key/check` — two byte changes and no others:
   `[ ]` → `[x]`, and ` done <today>` appended. The route takes a `task_key`,
   not a patch; it is incapable of anything else.
3. **Done**, collapsed to a receipt naming the file, with **Undo**.
4. **Undo is a second mechanical write, not a revert** — it flips the box back
   and removes the stamp. There is no history to roll back to and the design
   does not pretend otherwise.

**409 — the line moved under you.** The route compares the line's text against
what the client was shown and refuses rather than writing over an edit made in
Obsidian thirty seconds ago. Rendered in `stale`, with the current line shown
beneath: *"This line changed in your note since it was shown. Nothing was
written."* This is the **same envelope the request card already uses** — one
stale pattern in the product, not two.

## 6. Promotion, the standup block, and the stamp

**Promotion** is one control with one confirmation and it is one-way: *"This
becomes a row on the Board that an agent can claim. It cannot be handed back."*
There is no *return to note* verb anywhere, and a promoted line renders from
then on as a `work` row with its origin named. `work.external_ref` has a
partial unique index, so a second promotion is a no-op — which is why the
confirmation can honestly say it is safe to press twice.

It is the **only** destructive-shaped control on Today, so it gets the only
irreversibility warning. Complete is confirmed too, but for a different reason:
it asks because it writes *your file*, not because it cannot be undone.

**The standup block** has one **Copy** button and nothing that resembles a
send control — no paper-plane glyph, no channel picker, no "post". It carries
the sentence *"Metistry does not post this. Copy it and paste it yourself."*
That sentence earns its place: the absence of a send button is a promise, and a
promise is worth stating once. It appears on `standup_days` at `standup_time`.

**The staleness stamp** reads *as of 2 min ago*, because a box ticked in
Obsidian is up to `METISTRY_RECONCILE_INTERVAL_SEC` (300s) old. It is not
decoration — it is the honest bound on what this screen knows. Past roughly
twice the interval the stamp itself takes `stale` (§7 fault 4).

## 7. States — four absences and one empty

| | Copy | Action |
| --- | --- | --- |
| **empty** | "Nothing scheduled for today." + *that means nothing is due or planned — not that you are finished* | Open today's note |
| absent · calendar | "No calendar connected." + *the list below is complete; only the schedule beside it is missing* | Connect a calendar |
| absent · working days | "Metistry doesn't know which days you work." + *`Me/profile.md` has no `working_days`, so the plan and the standup draft wrote nothing rather than guessing* | Set your working days |
| absent · template | "There's no plan template, so no plan was written." + *`Templates/Plan.md` is missing — a configuration fact, not a failure* | Create it from the default |

Each names what is missing, what therefore did not happen, and the one thing
that fixes it. None says *something went wrong*, because in all four cases
nothing did: the system declined to guess, which is what §6.4 asks for.

The **empty** state is the one needing the extra sentence, because an empty
Today looks identical to a finished day.

## 8. The All mode

Segmented `Today / All` where the section title would sit. The sidebar never
gains a row.

**The chips emit the template language, visibly.** §10 calls one filter
vocabulary "the single highest-leverage decision", and it is invisible unless
the design makes it so — so the compiled `where:` is **shown, selectable and
copyable** directly beneath the chips that built it:

```
due <= +7d and priority >= p2 or overdue   order priority, due
```

A view assembled by clicking can be pasted into `Templates/Plan.md`; a `where:`
written in a template loads back into these chips; a saved view stores the
string. It is also the honest answer for a filter the chips cannot express: the
grammar has seven fields and seven flags, the chips cover the common pairs, and
anything else is typed into the same box in the same language. The advanced
case is not a second interface — it is the line the simple case was writing all
along.

## 9. Keyboard

`j`/`k` move · `space` completes (phase 2; phase 1 opens in Obsidian) · `⌘Z`
undoes the last completion · `⌥↑`/`⌥↓` reorder · `o` opens in Obsidian ·
`⌘⇧P` hands to an agent · `⌘⌥T` toggles Today / All · `/` focuses the `where:`
box · `⌘C` on the standup block copies it.

## 10. Data sources

| Element | Source |
| --- | --- |
| every markdown row | `vault_tasks` via a named query — `text`, `due`, `scheduled_for`, `priority`, `size`, `assigned`, `project`, `work_id`, `duplicate_of`, `parse_warning`, `waiting`, `first_seen_on` |
| the work row | `work` + `meta.blocked_by`; the Board's `blocked_by_task` / `blocked_by_task_open` columns |
| minutes and capacity | `task_size_minutes`, `daily_capacity_min` — `Me/profile.md` |
| carry-over count | `first_seen_on` |
| the staleness stamp | `last_seen_at` against `METISTRY_RECONCILE_INTERVAL_SEC` |
| completing | `POST /api/vault-tasks/:task_key/check`, owner session only |
| promotion | `work.external_ref = 'vault:<path>#^mt-…'` |
| the standup draft | `Journal/Standup/<date>.md`, machine-written from `Templates/Standup.md` |
| the `where:` string | `packages/core/src/task-filter.ts` — one parser, three consumers |

## 11. Open items

- **`partial` is a fifth state** (§7 fault 5) and §3.15 has four. Worth adding
  there rather than inventing it again on the next screen that parses
  something.
- The stale threshold on the stamp (§7 fault 4) is a number nobody has chosen.
  My proposal: `2 × METISTRY_RECONCILE_INTERVAL_SEC`.
- Drag order is stored — **where** is not specified anywhere I could find. It
  cannot be the markdown (that is the user's file and reordering is not a task
  edit), so it is app state keyed by `task_key`, and it needs a home.
- Whether the capacity meter should count `work` rows. It does not here: an
  agent's row is not your minutes. But a row *waiting on you* arguably is.

---

# 12. Redesigned — the day as a spine

Board: `Today — the day as a spine`. The board above keeps its job as the row,
chip and state vocabulary, and as **the absent state of this one** (see §12.4).

## 12.1 The critique that drove it

The first pass was a to-do list with a capacity bar. Accurate, and not much use
at 08:40, because it does not answer the question you open it with: *what is
today, and am I ready for it?*

The obvious fix — schedule panel, todo panel, reviews panel, agents panel,
updates panel, a row of predicted buttons — is a **dashboard**, and this
product was written to prevent dashboards. P2 says silence is the default and
the surface stays calm; Needs You is the only badge. Seven panels of live
numbers is precisely what those rules exist to stop.

So the question is not *which sections*. It is **what makes a hub calm**, and
the answer is:

> A hub is calm when it is organised by **when you need something**, not by
> **what kind of thing it is.**

A dashboard sorts by type. A day does not work like that. At 08:40 the only
thing that matters is the 09:30 meeting and whether you are ready. At 11:30 the
only thing that matters is the ninety minutes before the next commitment.

## 12.2 The spine

One time-ordered column. Meetings at their time. **Tasks in the gaps**, because
a gap is when you would actually do one. Standup at 09:15. A `NOW` rule. Past
items collapsed above it — *3 earlier today*.

This settles the hardest of the five asks: **updates through the day land at
their own time, not at the top.** The page never churns and nothing you are
reading moves (P9).

**The rail** is the only exception, and it earns it: two columns because there
are two questions. The spine answers *when*; the rail answers *what is true
right now regardless of the clock* — agents, what changed since you last
looked, and **one line** for Needs You. It does **not** repeat the request
queue; that is the bell's job, and two places for one queue is how a product
starts lying. A request that is about *today* attaches to the task it is about
instead.

## 12.3 Retrieved and generated must not look alike

The meeting card is a briefing: who, what you owe them, what happened last
time, and two lines to jog your memory.

- **Retrieved** — a real page, a real task, a real past note, each a link you
  can open and check. Plain rows.
- **Generated** — the assistant's sentences, in the `agent` container,
  attributed, and labelled *written, not retrieved*.

This is P1 doing the work it was written for, and it is the one rule in the
redesign I would not trade. A briefing is exactly where a confident guess is
indistinguishable from a fact until it costs you a meeting — and **a briefing
you have to double-check is slower than no briefing at all.**

## 12.4 It degrades into the board above

With no calendar there are no meetings and no gaps, so the spine collapses to
the plain list already drawn. **Today-with-a-calendar is Today-without-one plus
structure.** The four absent states, the row, the chips, the completion flow
and the All mode are all unchanged and all still apply.

## 12.5 Predicted actions — three rules

1. **It says why it is there.** "Draft the agenda — *you have 3 open items with
   Jim*." A button with no reason is a guess you must evaluate; with a reason
   it is an argument you can agree with in half a second. The reason is
   retrieved, never generated.
2. **It lives on the thing it is about, never in a tray.** A global row of
   predicted buttons is where prediction becomes noise. One per card, three on
   the page, and the page may have none.
3. **It is a shortcut to a verb you already have, never a new power.**
   `ACTION_KINDS` stays closed. Anything irreversible keeps the confirmation it
   would have had anyway.

A consequence of the three: a wrong prediction costs one glance, because it
sits beside its own justification and did nothing on its own.

## 12.6 The capacity meter, corrected

With meetings on the page the old meter is wrong. Three segments —
**committed · fits the gaps · does not fit** — against total working minutes.
It still refuses nothing. Requires A8.

## 12.7 What this needs that does not exist

Nine items in `today-hub-requests.md`, for the developer. A1 (calendar events
carry three fields) and A2 (Metistry may not write the meeting note) are
blocking; A2 is solved by the recurring-task precedent without touching
ownership. A5 — generated prose outside a fold template — needs a ruling.
