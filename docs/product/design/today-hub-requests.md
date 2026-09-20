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
