# Screen 3 — Needs You

Round D, third. **Not a screen**: a popover on Mac, a sheet on iOS, and one
real list behind both for when the queue is long. Board: `Needs You`.

Round C drew the request card and the panel and left the list open. The
endpoint settles most of what was open — and shows that the panel header I
specified last round cannot be built.

**Round E adds §9 — the `access_request` card kind.** It is the one request
where answering changes what another principal can see, so it is the one that
has to be honest about what Approve costs.

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

---

## 9. The access request — round E

`request_access` writes one `proposals` row of kind `access_request` and grants
nothing. This is the card that answers it. It is the only kind where Approve
widens another principal's sight, and three things about it are not obvious.

### 9.1 What the card renders, and what it must not compose

| Piece | Source | Rule |
| --- | --- | --- |
| the ask | `payload.area` | **verbatim**, mono. It is a path; a path is a value |
| why it is asking | `payload.reason` | the agent's words — prose treatment, never a control (P1). ≤1000 chars, so it folds |
| what it holds now | `payload.current_scope.line` | **rendered as given.** The triple *role · access · extras*, composed once by `describeScope` and said the same way in the CLI, the Agents panel and here (P3 §3.4). The card never writes this sentence itself |
| the actor | `source_agent` + `trust` | nothing for `internal`, `external` in `degraded`, `you` neutral |
| when | `provenance.submitted_at` | relative |

The tier words the owner reads are the scope view's own — **`none` · `titles` ·
`folders`** — not the grant model's `index` / `areas`. One vocabulary, and it
is the one already shipping.

### 9.2 Approve is not purely additive, and the card says so

`widenedGrants` sets the tier to `folders` unconditionally. For an agent at
`titles` that is **a narrowing on the other axis**: it was browsing every title
in the vault and will now see titles only inside its own folders. The grant
model has one tier, so "browse everything plus read one area" cannot be
expressed — the trade *is* the decision being made.

So the Approve box carries it, in `degraded`, with the words doing the work and
the tint only seconding them. An Approve that quietly removed browsing would be
exactly the surprise P5 exists to prevent. (C41)

### 9.3 Revise can only grant less

The asked prefix is a **ceiling**. Every option on the control is at or below
it, and there is no field that can name something above it.

The reasoning is not squeamishness about widening — it is that granting more
than was asked **is not a revision of this request**. It is a different
decision, about a scope nobody asked for, and it belongs on Agents where the
owner is looking at the whole credential rather than at one sentence from an
agent. The control says so in one line rather than disabling something silently.

The endpoint does not enforce this today (C40): `accept_with_changes` validates
the shape of the area and not its relation to the one asked for. The interface
cannot express a widening; the request list asks for the endpoint to refuse one.

### 9.4 Asked again, and the rung the owner never sees

A re-ask after a decline is a **new row flagged `escalated`**, carrying
`prior_proposal` and `prior_declined_at`. The card shows it as *asked again*,
names when the owner declined, links what they answered, and says the ladder
ends.

**It is neutral, not tinted.** Tint carries *something is wrong* and nothing
here is wrong: a second ask is provenance, which is the hue channel's business
and not the tint channel's. Treating persistence as a fault would also be a
judgement the data does not support.

Two declines close it: the third ask is refused at the tool with *ask the owner
directly*. That refusal produces **no row**, so the owner never learns an agent
hit the ceiling — which is a gap on **Agents**, not here. (C42)

One pending ask per `(agent, area)`, enforced by migration 0022's partial
unique index, so a retrying agent cannot fill the queue with the same sentence.
Nothing had to be designed for that, which is the point.

### 9.5 Four refusals, inline, and the row stays pending

Every access refusal runs **before** the row is settled, so the card is still
there and still answerable. The band says so in those words, because a refusal
that looks like a decision is the lie P5 forbids.

| Refusal | What the card says | Where it points |
| --- | --- | --- |
| `invalid_request` — no area | the request does not name an area this console would grant | Decline |
| `invalid_request` — bad revision | the prefix rule, verbatim | the control |
| `forbidden` — a crew | its scope is configuration, re-synced from its manifest, so approving would be undone at the next sync | `agents/<area>/<id>.md` |
| `not_found` — revoked | there is nothing to widen | Decline or Skip |

### 9.6 Data sources

| Piece | Source |
| --- | --- |
| the ask, the reason, the scope | `proposals.payload` — `area`, `reason`, `current_scope` |
| the re-ask | `payload.escalated`, `prior_proposal`, `prior_declined_at` |
| the actor's provenance | `trust`, `source_agent`, `payload.provenance` |
| Approve | `POST /api/proposals/{id}` `allow` → `widenedGrants` → `writeGrants` |
| Revise | the same, `accept_with_changes` + `{"area": "…"}` |
| durability across a restart | `agent_grant_overrides` (migration 0023) |
| the tier trade | **derived** — nothing flags it (C41) |
| the vault tree under the asked prefix | **nothing** — the control needs one to offer a narrower path |

## 10. Second pass — concise access, seven types, the meeting (2026-09-22)

### 10.1 The access card is what it asks and three answers

Ruled 2026-09-22: the card was far too verbose. Now:

```
🔑 ACCESS                         drey-dev · 12m
Read Areas/Finance
[Approve] [Revise] [Decline]          [later] [?]
▸ Why it's asking
▸ Before and after
```

- **Everything else is a disclosure.** *Why it's asking* (the agent's reason, on
  the agent wash), *Before and after* (now → after, and one line on what stops),
  and *Declined before* on a re-ask.
- **Asked again is a chip**, not a paragraph.
- **The rules live behind `?`** — a help page, not the card.
- **Revising** is the prefix tree and one button, *Approve Vendors*.
- **Can't be granted** is one line — *set in its manifest, not grantable here* —
  with *Edit →* and Decline.

§9's rules stand (C40–C42); only their explanation moved off the card.

### 10.2 Seven types

`action` becomes the seventh word the owner reads (C80): **question · access ·
action · improvement · note · report · review**. Chips show only the types that
are present.

### 10.3 A meeting is one card

```
🎙 MEETING                          metis · 12m
Vendor review
Notes and 4 to-dos · 42 min
NOTES     ┃ Kessler confirmed net-45 …      [Accept] [Edit]
TO-DOS · 4  ☐ Send Kessler the revised …     ✓ ✎ ✕
YOURS     2 notes, 1 to-do — already saved, and included in the notes.
▸ Transcript                                 42 min · kept 30 days
[Accept All] [Decline All]                   Open the session →
```

- **Accept All sends one approval per item**, in order, each with its own
  receipt. It is not a batch — the endpoint refuses batch Approve because each
  approval has a per-kind consequence — so every part keeps its consequence, and
  a part already answered elsewhere reads as a partial result (§3.1): *4 of 5
  accepted. One was already answered on your phone.*
- **The owner's own jots are not asked about.** They are his words, saved when
  typed, and go into the notes as his.
- **Every to-do can be answered on its own.**
- **It needs a group id on proposals (C81)**, and that group is where C77's
  session-time anchors get promoted to the note's path.
