# Reply quality, and the loop that acts on it

A 👍/👎 on any reply, and a daily pass that turns new 👎 into **one proposal
you decide on**. Nothing in this loop changes how the assistant behaves on its
own: the routine suggests, you allow, and only then is anything written —
in your name (invariant 2, plan §4.10).

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
| `GET /api/messages` | owner | outbound rows carry `feedback: {rating, note, ts}` |

An owner token (the capture Shortcut, scripts) gets a uniform 403: rating a
reply is the user's own judgement, and least privilege inside the owner class
applies (CRIT-7).

Read it back with the `reply_feedback_summary` named query: `day` rows
(rated/positive/negative per day) plus one `flagged` row per 👎, joined to the
turn that produced the reply (`runs.meta.turn_id`, else `runs.meta.message_id`)
so the prompt, the reply and the tool calls are visible together.

## The loop

`routines/reply-review` runs `@daily` — frequent enough that a busy week
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
`Knowledge/` on top of that).

## Automatic vs. not

| automatic | needs you |
| --- | --- |
| storing the rating | rating a reply at all |
| the daily collection and its counts | allowing or denying the improvement |
| writing the proposal | the wording that ends up in the prompt |
| the overlay write, *after* you allow | restarting the assistant to pick it up |
