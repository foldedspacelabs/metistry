# Today as a hub — what it needs that does not exist

Nine requests, from the redesign on the `Today — the day as a spine` board.
**A1 and A2 decide whether the design is buildable at all**; the rest improve
something that already works. **A5 needs a ruling, not a ticket.**

Ordered by what blocks the most.

---

### A1 · Calendar events carry only `title`, `start`, `end` — blocking

`packages/mcp-eventkit/helper/ek-helper.swift` returns three fields per event,
and `GET /events` passes them through. Everything the schedule depends on —
**who is in the room**, what the invite says, where it is, which calendar it
came from — is already on EventKit's own objects and simply is not read.

Without it a meeting card is a coloured bar with a title, and none of the
preparation the hub exists to give you is possible.

**Add:** `id`, `attendees[]` (name, email, participation status), `notes`,
`location`, `organizer`, `calendar`. Pass through `GET /events` unchanged in
shape — `{ events, as_of }` already fits.

**Note the privacy consequence deliberately:** invite bodies can carry dial-in
credentials and confidential agendas. `notes` should be returned, and the
design shows it only inside the card, never in a summary line and never to an
agent — it is owner-session data like everything else behind `/api/`.

---

### A2 · Metistry may not create the meeting note — blocking, but solved

`Journal/Meetings/<date>-<topic>.md` is the **user's** file (§5.1, one writer),
and `ownershipRefusal` (`packages/mcp-brain/src/knowledge-write.ts:262-268`)
enforces it at the tool. "Auto-created meeting notes" is refused by design, and
the design is right.

**The recurring-task precedent solves it without touching ownership.** §4
resolves exactly this shape: an instance is "written by the same action, in the
same hand, in the same second as the note it lands in — the user's own template
action." So:

```
POST /api/meetings/:event_id/note        (console, owner session only)
  → render Templates/Meeting.md          (already seeded)
  → POST /vault/write  intent: { principal: "user",
                                 message: 'open notes for "1:1 with Jim"' }
  → 200 { path }   |   200 { path, existing: true }  if one already exists
```

Same shape as `POST /api/vault-tasks/:task_key/check`: owner-only, one outcome,
incapable of anything else, not in `ACTION_KINDS` and therefore never
agent-reachable. The user's tap is the authorship. Nothing about the
five-file split changes.

---

### A3 · Nothing links a meeting to its note

So "Open notes" cannot tell whether it is opening the note or making a second
one, and "last time" has nothing to search.

**Add:** `event_id` in the meeting note's frontmatter, and a derived
`vault_meeting_refs` beside `vault_task_refs` — the same additive pattern, for
the same reason (`knowledge_links` strips `#`/`^` and its primary key cannot
widen without a destructive migration).

---

### A4 · An attendee is an email; a person is a page

Nothing maps one to the other, so a card cannot reach `People/Jim Fallon.md`
from an invite.

**Add:** `email:` in People/ frontmatter, indexed. Unmatched attendees render
as plain names — **never** as a guessed page. A wrong person page on a briefing
is worse than no person page.

---

### A5 · Generated prep prose has nowhere legal to come from — needs a ruling

§6.2 makes `prose` **fold-templates only**, deliberately, and the assistant's
two lines on a meeting card are exactly a `prose` directive outside a fold
template.

Two ways out:

1. a named template class permitted to call `prose` with its own budget; or
2. **Today gets one assistant turn a day, with a declared cost.**

**I prefer (2).** It is one turn, it is visible in Insights like every other
turn, and it does not widen a rule that is load-bearing in several other
places. It also bounds the thing that would otherwise grow: a hub that may call
a model per card will call a model per card.

Whichever is chosen, the output stays inside the `agent` container, attributed,
and marked *written, not retrieved* — see the design's §on retrieval.

---

### A6 · Predicted actions have no source — and must not gain a power

Nothing produces them today. The constraint matters more than the feature:
`ACTION_KINDS` is `["dispatch","task_update","comment","capture"]` and its own
comment says the list deliberately excludes sending anything.

**Add:** a read-only `suggestions` source returning
`{ verb, target, reason, evidence[] }` where `verb` is **an existing route**.
Prediction chooses what to *offer*, never what is *possible*. `ACTION_KINDS`
stays closed; nothing here proposes widening it.

---

### A7 · Nothing refreshes between the morning brief and the fold

"Situational awareness through the day" has no runner — the routines are the
eve, the morning and the evening.

**Add:** Today refreshes **on window focus** and on the reconciler's tick,
rather than a new intraday routine. It is free, it happens exactly when you
look, and it cannot churn a page nobody is watching.

---

### A8 · `daily_capacity_min` does not say what it counts — a sentence, not code

240 total working minutes, or 240 minutes of *task* time on top of meetings?
Three hours of meetings against 240 is either a normal day or a disaster, and
the meter cannot be honest until someone decides.

**Declare it total working minutes**, and let the meter subtract committed
time. That is what the three-segment bar draws: committed · fits the gaps ·
does not fit.

---

### A9 · "Since you last looked" needs a last-looked — and no schema

There is no per-user timestamp for when Today was last read.

**Client-side is enough** for one owner on his own machines, and it should
stay that way. This is the one item here that deliberately asks for **no**
schema change.

---

# B — the second pass: items, artifacts-for-a-moment, and revision

### B1 · An artifact needs a `for` — a binding to an occasion — blocking the pattern

The standup draft is not a copy button. It is **an artifact a scheduled run
produced, bound to an obligation on the calendar**, and once that is the shape
it generalises: an agenda before a meeting, a pre-read before a review, a
weekly summary before Friday.

Nothing expresses that binding today. `artifacts` has no relation to a time or
an event.

**Add:** `for` on an artifact — `{ kind: "event" | "time", ref, at }` — where
`ref` is an `event_id` (A1/A3) or a routine's declared slot. It is what lets
the card say "for: Standup · 09:15 · recurring" and what lets the spine place
it at 09:15 rather than in a list.

### B2 · Freshness *relative to the occasion*, which is not the usual staleness

Everywhere else in the product, stale means *the screen is behind the data*.
Here it means **the artifact is behind its own occasion**: a standup written at
06:02 for a 09:15 standup, where two things changed at 08:40, is wrong in a way
that matters in twenty-five minutes.

**Add:** the count of relevant changes since `made_at`, scoped to whatever the
artifact drew on. Cheap version: the artifact records the named queries and
params it used, and the count is those queries re-run and diffed. Without this
the card can say when it was made and not whether that still means anything.

### B3 · Recurrence, and the previous instance

The meeting card should say what came out of *last time* — action items
created in the previous instance of a recurring meeting, and a link to its
note.

`vault_tasks.source` already supports `meeting:<path>`, so the tasks half is
free **once A3 exists**. The missing half is recurrence: EventKit has the
series, `ek-helper.swift` does not return it.

**Add:** `series_id` and `recurrence` to the event payload (part of A1), and
resolve "the previous instance" through `vault_meeting_refs` (A3).

### B4 · Where a revised day is stored, and under whose hand — needs a ruling

§10.1 says the user's drag order is authoritative and stored (C29, still open).
This design adds a second writer to that same state: **you tell the assistant
to reorder your day, and it does.**

That is a genuine invariant question, not a ticket:

- the ordering is the user's, and the user asked for the change — so it is the
  owner's intent, like completing a task from a mirror (§2.2);
- but unlike the check route, this one is **not a single mechanical byte
  change**; it is the assistant composing an arrangement;
- and it must not become an agent-reachable action — `ACTION_KINDS` stays
  closed.

**My reading**, offered for the owner to accept or reject: the day's
arrangement is **app state, not vault state**, keyed by `task_key` and
`event_id`, written by an owner-only route, with every assistant-made change
**attributed, explained and undoable on the page**. It never touches markdown,
so no ownership rule is stretched, and the worst case is a bad ordering you
press Undo on.

### B5 · A `suggestions` source must carry evidence, not just a verb

Extends A6. For a predicted action to say *why* it is there — which is rule 1
of three — the reason has to be retrieved, not generated.

**Add:** `evidence[]` on each suggestion: the rows it was derived from, so the
card can render "you have 3 open items with Jim" as a fact with a link behind
it rather than a sentence a model wrote.

### B6 · Today as a top-level section

Not a schema change — a navigation one, and it breaks a ratified rule, so it
is written down here too. Today moves out of Work to the **second row** in the
sidebar; Work returns to four children. See C30 and `screen-05-today.md` §13.

### B7 · Agent prose needs a stable id, so any of it can be rated

Chat has 👍/👎 on an `outbound_messages` row. Extending that to **every** piece
of agent prose — a meeting briefing, a plan rationale, a revision explanation —
needs each piece to be addressable.

**Add:** a `prose_id` on generated content wherever it is produced, and widen
`reply_feedback` (or add a sibling) keyed by it rather than by
`outbound_message_id`. One feedback signal beats three, and the weekly
model-free pass in `docs/ops/reply-feedback.md` already knows what to do with
it.

### B8 · The plugin must compute entity fills from the live theme

Our three entity quiets are solved against **our** `bg`. Obsidian themes vary
wildly, and a quiet computed against cream can fall below 4.5:1 on someone's
midnight purple.

**Do:** ship the entity **hues** and the geometry, and derive the quiet fill at
render time — a `color-mix()` against `--background-primary` — rather than
shipping six hex values. The chip then adapts to any theme and keeps its
contrast.

### B9 · Travel time needs `location`, and a way to measure between two of them

The day bar treats travel as first-class. That needs `location` on the event
(part of A1) and a distance between consecutive locations.

**Do the cheap version first:** a per-location default in `Me/profile.md`
(`travel_minutes: { "Ann Arbor office": 25 }`), which needs no network, no map
provider and no new dependency, and is right often enough for a day plan. A
routing API can come later and is not worth the egress surface today.

### B10 · Calendar writes: two tiers, enforced

`POST /events` exists with a preview-then-execute shape. The design splits
calendar changes by a single test — **does anyone else feel this?**

**Add:** the console route distinguishes an event with **no other attendees**
(creatable and deletable by Metis within autonomy) from one **with**
attendees, which it may only prepare. The second tier must be incapable of
writing, not merely discouraged — the same shape as the vault-task check route,
enforced at the tool rather than in a prompt.

`ACTION_KINDS` stays closed: Metistry never notifies attendees, so it never
moves a meeting they have not been told about.
