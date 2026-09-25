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
NOTES     ┃ Kessler confirmed net-45 …      [Accept] [Revise]
TO-DOS · 4  ☐ Send Kessler the revised …     ✓ ✎ ✕
YOURS     2 notes, 1 to-do — already saved, and included in the notes.
▸ Transcript                                 42 min · kept 30 days
[Accept All] [Revise] [Decline All]          Open the session →
```

- **Accept All sends one approval per item**, in order, each with its own
  receipt. It is not a batch — the endpoint refuses batch Approve because each
  approval has a per-kind consequence — so every part keeps its consequence, and
  a part already answered elsewhere reads as a partial result (§3.1): *4 of 5
  accepted. One was already answered on your phone.*
- **The owner's own jots are not asked about.** They are his words, saved when
  typed, and go into the notes as his.
- **Revise sits beside Accept All and on the notes** (ruled 2026-09-22), so a
  mistake is corrected before anything is accepted — the same verb every other
  request uses, not a separate Edit.
- **Every to-do can be accepted, revised or declined on its own.**
- **It needs a group id on proposals (C81)**, and that group is where C77's
  session-time anchors get promoted to the note's path.

## 11. Corrected 2026-09-23 (review 01)

- **Buttons (C92):** Approve is the one accent-filled button; Revise and Decline
  are outlined, in that order. *Decline All* is outlined too. A filled
  destructive button appears only for an act that cannot be undone.
- **The meeting card's notes take the `agent-quiet` wash**, not the 2px rule —
  the rule belongs to transcripts (C69). A note is answered **Approve · Revise**;
  the collapsed card's second button is **Open**.
- **An action card shows its payload.** *Comment on #418* shows the comment, on
  the wash, above its answers — approving something unseen is not a decision.
- **Provenance is neutral:** *external* is a grey chip, not the warning tint.
- **The agent chip is the one tinted pill** (amendments §8.3), here as everywhere.
- **Events that are not questions arrive here too (C96)** — a budget stop and a
  failed routine as `report`, an expired credential as `access`, a knowledge
  conflict as `review`. Drawn next round with the calmer panel.

---

## 12. v4 — everything an agent needs from you, one pattern (2026-09-25)

Board: `NeedsYou-v4`. The owner's framing: **Needs You is where everything an agent
needs from the owner arrives**, and more types will come. So the work is a
pattern first and two new types second.

**Rulings taken before drawing (2026-09-25):** several multiple-choice questions
per card; pull requests are reviewed and answered **in Metistry**, posting to
GitHub as the owner; PR requests arrive **from agents and from GitHub's own
review requests**.

### 12.1 What I found first

- **Questions exist, narrowly.** `decision` rows come only from Metis ending a
  reply with a ` ```decision ` block — one title, 2–8 options of ≤80 chars —
  and *"the options are the ONLY answers the server will later accept"*
  (`packages/core/src/decision-block.ts`). Chat already settles one with free
  text (`server.ts:630`). No context, one question, one choice; **other agents
  cannot ask at all** — `requests_create` files reports, and one of its report
  kinds is also called `decision` (C104).
- **PRs are collected, never asked.** `github-state` reconciles PRs with a
  **read-only** token and marks `needs_my_review`; `prs_for_review` exists and the
  morning brief lists them. Nothing reaches Needs You, no agent can ask for a
  review, and review comments are not collected (C106).

### 12.2 The pattern — five parts, a closed set of bodies

1. **Header** — type · who asked (an agent chip, or a person when GitHub asked)
   · provenance · age.
2. **The ask** — one line.
3. **Context** — the agent's words on the wash, then the **retrieved** things
   they rest on as chips (a task, a file, a ruling). Generated and retrieved never
   mix, so the owner can check the premise before answering.
4. **Body** — exactly one block from a closed set: **choices · diff · thread ·
   before and after · preview · to-dos · excerpt**.
5. **Answers** — the type's primary verb, the one filled button · **Revise** ·
   Decline · Later · `?`.

| Type | Body | Primary | Revise | Decline |
| --- | --- | --- | --- | --- |
| question | choices | Send Answers | Revise | Decline |
| pull request | diff · thread | Approve · Reply | Request Changes | — |
| access | before and after | Approve | Revise (narrow it) | Decline |
| action | preview | Approve | Revise | Decline |
| meeting | to-dos | Accept All | Revise | Decline All |
| review | before and after · preview | Approve · Keep Mine | Revise · Take the Other | Decline |
| note · improvement | preview · before and after | Approve | Revise | Decline |
| report | excerpt | its one act (Try Again, Reconnect) | — | Dismiss |

- **A new type is a row, not a card.** It picks a body block and names its
  primary verb; the panel, the full window and the phone sheet render it.
- **Revise is always free text, always back to whoever asked** — the course
  correction when the agent didn't get it quite right.
- **When an answer posts to another system, the button uses that system's
  word.** *Request Changes* is GitHub's review state, so it is Revise's name on a
  pull request. (Amends amendments §8.1's one verb set.)
- Filters show only the types present, with counts. The bell is still the only
  badge.

### 12.3 Question

- **Any number of questions per card**, each **pick one** or **pick any**, and
  every one ends in **Something else…** — an answer in the owner's words, sent as
  that question's answer (C105).
- **Send Answers** fills only when every question has an answer; the count above
  it says how many are left.
- **Revise answers none of them** — it tells the agent the questions are the
  wrong questions, in free text.
- After sending: the answers as a list, *not read yet*, and **Change** until the
  agent reads them.
- The **budget stop** is already a question in the code (`budgets.ts`, two
  options) and is drawn as one.

### 12.4 Pull request

- **Two sources.** An agent that opened a PR asks with context (*"that's the file
  to read"*); or GitHub's own review request arrives from the collector,
  attributed to **the person** who asked — neutral provenance, *via GitHub*.
- **The card:** repo#number, the branch into its base, `+214 −38 · 6 files`, the
  top three files with counts, checks. **Approve · Request Changes · Comment**,
  and **Review Changes →** to the full window.
- **Approve** takes an optional comment; **Request Changes** requires words. Both
  say they post *as @mattcolf*.
- **A thread reply** is the same type with the **thread** body: the code lines,
  the conversation, a reply box, **Reply** and **Resolve Conversation**.
- **Stale:** commits pushed while the card was open turn it `stale`; nothing is
  sent, and it now shows the new head. **A card never approves a head the owner
  didn't see.**
- **A failing check** is shown with its name and line, not blocking.
- **No write token:** *absent*, not failed — *Metistry can read this PR but can't
  post to GitHub* — with **Connect GitHub** and **Open on GitHub**.
- **The full window:** the queue on the left; the PR at reading width with the
  agent's note, files and the diff; line comments gather as drafts and go with the
  review; **Open on GitHub** always one click away. On a phone it pushes the file
  list, then one file's diff, wrapped.
- These are **the owner's acts**, through owner-only routes and a credential in
  Resources — not an agent action, so `ACTION_KINDS` is unchanged (C107).

### 12.5 The rest of the queue, as instances

- **Budget stop** → question (choices). **Routine failed** → report (excerpt,
  two timestamps, *Try Again*). **Token expired** → access (*Reconnect*).
  **Knowledge conflict** → review (both versions, *Keep Mine · Take the Fold's*,
  Merge in Obsidian). These are C96's events.
- **The meeting card arrives at Stop**, not at the evening fold: notes on the
  wash, to-dos with **proposed** due dates and people (tasks, owed facets
  included — C102), and **Draft Follow-up** to Kessler, drafted and never sent.

### 12.6 What this asks of the build

1. **`requests_ask`** (or `requests_create` kind `question`) for every agent:
   `questions[] {prompt, options[], multi, allow_other}`, `context {prose,
   refs[]}`. The ` ```decision ` block grows to the same shape; answers are
   stored per question, with free text accepted as *other* and as Revise (C105).
2. **Rename the report kind `decision`** → `decided` so the word means one thing
   (C104).
3. **A `pull_request` request kind**, raised by an agent (`repo`, `number`,
   `note`, `focus_files[]`) and by `github-state` for each PR marked
   `needs_my_review`, cleared when the review lands.
4. **`github-state` collects review threads** addressed to the owner and raises a
   thread request on a reply (C106).
5. **A GitHub write token held in Resources**, and owner-only routes: approve,
   request changes, comment, line comments, reply, resolve — each checks the head
   SHA the card was shown and refuses on a mismatch (C107).
6. Every request payload carries `body.kind` from the closed set, so a new type
   renders without new UI.

### 12.7 One hub — Metis, agents, and what the collectors pick up (2026-09-25)

The owner's framing, stated after v4 was drawn: **Needs You is the hub for
everything that needs him** — from Metis, from agents, and from incoming data
the collectors read (GitHub, Calendar, Mail, Linear…). The pattern already
carries it; these are the rules that make a third kind of asker safe.

- **Three kinds of asker.** The header names Metis, an agent, or **a source**
  (a badge: GitHub, Calendar, Mail, Linear), then the person there if any.
- **A source must name you.** A collector raises a request only when the source
  itself says it needs the owner — a review requested of him, an invitation to
  him, an issue assigned to him. Activity that merely mentions him stays in
  Activity (P2).
- **Mirrors clear themselves.** A source request mirrors the source: answer here
  and it posts there; answer there and the card clears here with a receipt
  naming where (*Accepted in Calendar · cleared here*). The source is the truth,
  which is how a collector raises a request without inventing state (C108).
- **Metis may infer, and says so.** Where the source doesn't ask — an email that
  seems to want a reply — Metis may raise it **as Metis**, with its reason and
  *Metis thinks this needs you — Mail didn't say so*. Inferred and reported never
  look alike (P5).
- **One subject, one card.** An agent's review ask and GitHub's review request
  for the same PR merge, with both askers on it.
- **Write-back uses the source's word; no write-back means a draft or Open
  in …** Mail is read-only (daily-flow §8.2), so a reply is **drafted in Mail,
  never sent**.
- **Filters:** by type, and by **From** — Everyone · Metis · Agents · GitHub ·
  Calendar · Mail · Linear — each showing only what is present.

Three new rows in §12.2's table, drawn:

| Type | From | Body | Primary | Revise | Decline |
| --- | --- | --- | --- | --- | --- |
| invitation | Calendar | preview (who, where, overlaps, travel) | Accept | Maybe | Decline |
| task | Linear (or any tracker) | excerpt | Add to Today | — | — (Delegate) |
| message | Metis, from Mail | excerpt + Metis's reason | Draft Reply | — | Not Mine |

**Build asks:** each collector declares its *needs-you rule* in its manifest
(which source states raise a request, which clear it); requests carry
`source {kind, external_ref, person}` and dedupe on the subject's
`external_ref`; a source-state change resolves the mirror with
`decision = 'resolved_at_source'` and a receipt; calendar RSVP is an owner-only
write through the EventKit bridge (B10's tiers); Mail stays read-only and
*Draft Reply* opens a draft in Mail.

---

## 13. v5 — the bell opens a view; questions come one at a time (2026-09-25)

Board: `NeedsYou-v5`. The owner: the 400px panel made Needs You *cramped and too
vertical*. Of the five placements offered he leaned to **a full view in the main
area**, and ruled that it is reached by **the bell as a toggle, with no sidebar
row** — the eight rows stand (C57).

### 13.1 Where it lives

- **The bell is a toggle.** Pressed, it fills with the accent (the count rides
  along, outlined) and the main area becomes Needs You. Pressed again, or Esc,
  returns you.
- **The sidebar shows no selection** — you are not in a section.
- **The title bar leads back:** *‹ Today* names where you came from and returns
  you there, scrolled where you left it.
- **Every way in lands here** with the request that brought you selected: the
  bell, Today's *N waiting*, a notification.
- **List and detail.** One line per request (type, title, who's asking, age),
  grouped Today and Earlier, filtered by type and by **From**; the selected
  request at reading width on the right. The §12 pattern is unchanged — only its
  container is.
- **The 400px panel is retired on the Mac.** The phone keeps its sheet; the
  narrow PWA window (600–899px) shows list, then pushes detail.
- **Keyboard:** ↑↓ move · ↵ the primary · R Revise · L Later · ⌘↵ send · Esc back.
- **Empty:** *Nothing needs you* with **Back to Today**.

### 13.2 A question, one step at a time

- **One question fills the card**, with a segmented bar and *Question 2 of 3*.
  Number keys choose; **Next** slides it away and brings the next; **Back** is
  always there.
- The last step, **Your Answers**, lists each answer with **Edit**, and **Send
  Answers** (⌘↵) sends them together — one reply to the agent, not three.
- **Revise and Decline sit under every step**, so *these are the wrong
  questions* is never more than a click away.
- **A single-question request skips the summary:** choosing sends.
- After sending: the answers, *not read yet*, **Change**.
- The same steps run in the phone's sheet.

§12.3's all-at-once card remains the fallback for a narrow place that can only
show one card (a notification's expanded view), and is otherwise superseded.
