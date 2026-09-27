# Reply quality, and the loop that acts on it

A 👍/👎 on any reply, and a daily pass that turns new 👎 into **one proposal
you decide on**. Nothing in this loop changes how the assistant behaves on its
own: the routine suggests, you allow, and only then is anything written —
in your name (invariant 2, plan §4.10).

## The Needs You queue's answer set

Every item in Needs You is a **request**, and a request has one of seven types
(`glossary.md`). Whatever its type, one table decides what your press sends
over the wire (plan §2.12):

| You press | Wire |
| --- | --- |
| Approve | `allow`, or `accept_as_work` where `payload.suggested_work` exists — see [below](#approve-as-work--the-click-is-what-creates-the-row) |
| Revise | `accept_with_changes` + your reason. An empty reason cancels rather than sends — the assistant has nothing to change without one. |
| Decline | `deny`, **always** — never a different wire per kind, though its consequences are per-kind (below) |
| Later | `snoozed_until` is set. The row stays `pending`, leaves the queue, and comes back by itself (`METISTRY_SNOOZE_HOURS`, default 3). |
| Skip | `deny` + `feedback = 'skipped'` (the fixed marker `SKIP_FEEDBACK`, `packages/core`) — the bulk list only, ≤ 100 rows "on this page" |
| an option, *Something else…* | the option itself, or `other` + text |
| *(the source cleared it)* | `resolved_at_source` — mirrors only |
| *(14 days pass)* | `expired` — rows without a `source` |

Approve, Revise and Decline are the three answers to the request itself.
Later and Skip are not answers at all — Needs You once had only Approve,
Revise and Decline, with no way to say *not now* for one row or *nothing to
say* for many, and an item you can neither answer nor put down stays at the
top of the queue forever
(`docs/research/2026-09-16-taskuary-review.md` ADOPT 5).

**Approve is the verb with per-kind consequences**: an `improvement` writes
the prompt overlay — or, when it carries an edit to a file under `Me/`
(*Tidy Me/profile.md*), writes exactly the "after" you were shown, as you, and
is refused `stale` if the file changed since (`client-api.md`) — an enrolment
lets the agent in, an **`action` runs**
([actions.md](actions.md)), everything else is recorded and read by the
evening fold.

**An `action` is the second kind whose Approve *does* something**
([actions.md](actions.md)): the console runs it through the same service call
your own click would, and if that service refuses, the row stays pending
carrying the error rather than settling a decision that did nothing. Only one
at a time, for the same reason `improvement` is — see the batch note below.

**Decline is always `deny`.** The wire never varies by kind — only the
consequences do: declining an enrolment **revokes** the agent's token, and
your reason is kept either way.

**Skip is not Decline.** The difference is what travels afterwards, and why
Skip lives only in the bulk list:

- For a **`decision`** request that is an enrolment, Decline revokes the
  agent's token. Skip does not — it settles the queue item and leaves the
  registry exactly as it was. "Not this, and I have nothing to say about it"
  must not be a way to lock someone out by accident.
- For an **`improvement`**, Decline keeps your wording, and that wording is the
  one thing in this loop that carries a judgement anywhere — today the weekly
  review's *"top reasons you declined or revised"* line, and any future path
  that hands a reason back to the source agent. Skip writes the fixed marker
  `SKIP_FEEDBACK` (`packages/core`) instead of your words, and every such path
  excludes it *by that value*. A skip is you putting something down; it is not
  feedback, and nothing may read it as feedback.

**Later never ends a proposal.** `decision` stays `pending` and `decided_at`
stays null, so the fold, the weekly review and the auto-expiry see exactly what
they saw before. The only thing that brings a snoozed row back is the clock —
there is no un-snooze verb, because a queue you can pull items back into has
two orders in it. It is hidden from the console's Needs You list **and** from
the morning brief, which is the point: a `later` that still pushes at 07:00 is
a lie. (A snoozed row still ages toward the brief's auto-expiry; a three-hour
snooze does not outlive a fourteen-day clock.)

**Multi-select is where Skip lives.** Tick rows, up to 100 "on this page,"
and apply one verb to all of them (`POST /api/proposals/batch`); `l` and `s`
are the keys. Only `later`, `skip` and `deny` may be batched — the verbs that
need nothing from the individual row. Approve, Revise and Approve as Work
each *do* something per kind, so they stay one at a time (an `action` most of
all: a batched allow would dispatch five briefs on one gesture). The batch is
**all-or-nothing per row**: each id is its own statement with its own result,
so one item answered on the phone thirty seconds ago does not refuse the
other nine.

## Approve as Work — the click is what creates the row

A `knowledge` or `report` proposal whose payload carries
`suggested_work: {title, project?, kind?}` shows one extra answer. Accepting
inserts the `work` row, links it as `proposals.work_id`, and decides the
proposal `allow` — one gesture instead of "allow it, then go and type the task
out again". Before this, a todo captured on the phone ended the night as a
vault page and nothing else: there was no capture → `work` path at all.

- **Who suggests.** `inbox-drain` sets the field **deterministically** —
  frontmatter `kind: todo|task`, a leading `@task …` / `todo: …` / `- [ ] …` on
  the first body line, or the `todo` verdict its rules already reached. No
  model is consulted; the Apple FM tier's `has_action` is deliberately **not**
  an input, because a model must not be what puts an extra button under a
  proposal (invariant 4). Crews may set the same field on a report.
- **§4.12 is intact.** Nothing auto-creates. A suggestion nobody accepts stays
  a suggestion forever; the drain still emits only proposals.
- **The row is owner-less and unclaimed.** Any agent may take it (collaboration
  rule 4) — addressing it to someone would be a second decision nobody made.
- **Exactly one.** The insert is keyed on `proposal:<id>`, so a double-tap or a
  retried request returns the same row rather than making a second. It happens
  *before* the proposal is settled, for the same reason the overlay write does:
  a refused insert leaves the item in the queue.

## Deciding against a row that moved

Every decision the console sends carries `if_unchanged: {seen_at}` — the `ts`
of the row it painted. If the proposal changed after that (its payload was
rewritten, the `work` row it came from moved, a message landed in that row's
room) the answer is refused with a `409` carrying `reason: "stale"` and the row
as it stands, and the PWA repaints it. Approving a thing is approving *that*
thing; if the question changed, the answer was to a different question.
`docs/ops/console-api.md` has the envelope.

## What the user sees

- Two tapbacks under every reply in chat. 👎 asks for an optional one-line
  note ("guessed instead of looking it up"). Tapping the lit one clears it.
- Daily, if anything was flagged since the last pass: one item in **Needs
  You** titled *"Reply quality: N replies flagged 👎"*.
- One line in the weekly review: `• reply quality: 9 rated, 2 👎 — 1
  improvement proposal awaiting you`.

## The record

`reply_feedback` (migration `0013`) — one row per outbound message, `rating`
∈ {−1, 1}, an optional `note`, its own timestamp. Its own table on purpose:
`outbound_messages` is the record of what was said and stays immutable; the
rating is a later, revisable judgement. **Durable** — the user's hand, not
derived state; a rebuild from collectors cannot reconstruct it.

| route | who | effect |
| --- | --- | --- |
| `POST /api/messages/:id/feedback` `{rating, note?}` | passkey session only | upsert (one judgement per message); `runs` row kind `feedback`, tool `up`/`down` |
| `DELETE /api/messages/:id/feedback` | passkey session only | clears it; `runs` row tool `clear` |
| `GET /api/messages` | owner | outbound rows carry `feedback: {rating, note, ts}`; `?since=<cursor>` replays changes forward, and a rating moves its row (`docs/ops/console-api.md`) |

An owner token (the capture Shortcut, scripts) gets a uniform 403: rating a
reply is the user's own judgement, and least privilege inside the owner class
applies (CRIT-7).

Read it back with the `reply_feedback_summary` named query: `day` rows
(rated/positive/negative per day) plus one `flagged` row per 👎, joined to the
turn that produced the reply (`runs.meta.turn_id`, else `runs.meta.message_id`)
so the prompt, the reply and the tool calls are visible together.

## The loop

`routines/reply-review` runs every day at 23:00 — frequent enough that a busy week
doesn't sit on a backlog of 👎 until the weekend:

1. Collects the 👎 since the last `improvement` proposal it emitted (or the
   last 7 days, if it has never emitted one), with the note, the prompt, the
   reply, the model and that turn's tool calls.
2. Counts patterns — how many answered with no tool call, how many ran long,
   how many came from one thread, which tool recurs. **Counts, not
   interpretation.**
3. Writes **one** `proposals` row, kind `improvement`, source `reply-review`,
   trust `internal`, whose payload carries a *suggested* section for the
   assistant prompt overlay: the flagged cases verbatim, the counts, and a
   placeholder line to be rewritten.
4. Stops. It never writes a prompt, a note, or a message.

**No model runs in the routine** (invariant 4 — routines never call one). The
"suggested edit" is a deterministic template, and it says so in its own text.
If you want better wording, ask the assistant for it from Needs You — that is a
separate, visible step.

The routine is silent when there is no new 👎 since its last proposal. It
needs no separate dedup check to stay honest: each pass's window starts where
the last emitted proposal's timestamp left off, so a pass that finds nothing
new writes nothing, and a case already reported never appears in a later
proposal.

## What happens when you allow it

Allowing an `improvement` proposal is the one self-modification path in the
system:

- The console reads `assistant-prompt.md` through the reconciler's vault
  bridge, appends the suggested section, and writes it back **as principal
  `user`** — a commit in your name in the instance repo, reviewable and
  revertable like any other.
- The write happens *before* the proposal is marked decided, so a refused
  write leaves the item in the queue rather than dropping the change.
- The assistant picks the new overlay up **on its next restart**
  (`METISTRY_PROMPT_FILES`). Nothing hot-patches a running assistant (§4.10).
- Denying it writes nothing at all.

The prompt overlay **replaces** the seed prompt rather than merging with it
(D4: last existing file wins). So the first apply, when no overlay exists yet,
seeds it from the shipped `seed/assistant-prompt.md` and appends the section —
which also pins that seed at that moment. You see exactly this in the diff.

`assistant-prompt.md` is a §4.7 **protected path**: the vault bridge refuses a
write to it from any principal but `user`, so the assistant cannot reach its
own prompt even through a bug elsewhere (its `knowledge_write` is confined to
the vault root on top of that).

## Automatic vs. not

| automatic | needs you |
| --- | --- |
| storing the rating | rating a reply at all |
| the daily collection and its counts | allowing or denying the improvement |
| writing the proposal | the wording that ends up in the prompt |
| the overlay write, *after* you allow | restarting the assistant to pick it up |
