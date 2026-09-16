# Rooms — conversation on a work row

A **room** is a comment thread hanging on a `work` row instead of on an
artifact version. The task that will carry the work *is* the room.

Origin: `docs/research/2026-09-12-agent-room-review.md` — "skip agent-room as a
dependency, unanchor the thread". This page is phases 1 and 2 of that note's
§"Phased proposal". Phase 3 (`autonomy.level`) is not built and is not decided.

## The one property everything else rests on

**A room cannot address anyone.** There is no `to_agent`, no `@name`, no
addressee column, and no tool argument that names a recipient. Posting a
message wakes nobody: agents are pull-based, and they read a room when they
claim its row.

That is not a convention, it is an absence — the same way invariant 9 works.
Triggering stays where its policy already lives (`agents_delegate`, review
dispatch), so the collaboration rule *("a channel is safe exactly when it
cannot address")* survives by construction. A test asserts that
`tasks_comment`'s schema has exactly three keys and none of them is a
recipient.

## Where it lives

| Piece | File |
| --- | --- |
| The schema | `db/migrations/0016_work_threads.sql` |
| The service | `packages/artifacts/src/service.ts` (`workThread`, `workComment`, `workThreadResolve`) |
| The escalation | `packages/artifacts/src/policy.ts` `pingPongDemotes()` — unchanged, reused |
| The agent tools | `packages/mcp-brain/src/thread-tools.ts` (`tasks_comment`, `tasks_thread`) |
| The console routes | `apps/console/src/artifacts-routes.ts` (`/api/work/:id/thread`, `…/comments`, `…/thread/resolve`) |
| The room list | `seed/queries/rooms.yaml` (`GET /api/q/rooms`) |
| The panel | the **Rooms** tab in `apps/console/web` |
| The prior-work block | `apps/assistant/src/crew-drain.ts` `briefThreadBlock()` |

## The schema, and why it is one table

`artifact_comments` gained a nullable `work_id` and a check constraint —
`(artifact_id IS NOT NULL) <> (work_id IS NOT NULL)`, exactly one parent.
Nothing was rewritten and no second table exists, which is the point: one
table means **one** escalation rule, one resolve semantics, one
`author_kind` label, one console renderer. A `work_threads` table would have
been a second copy of all four, free to drift.

Two more constraints hold the shape:

- `artifact_comments_version_with_artifact` — an artifact thread still names
  an exact version (0010's rule, re-asserted now that the `NOT NULL` is gone).
- `artifact_comments_work_root_uidx` — **one room per work row.** The root is
  unique, so two agents appending in the same instant cannot open two rooms on
  one task; the loser of the race lands as a reply.

A room is therefore flat: a root and its replies, read oldest-first. There is
nothing to sub-thread about before a deliverable exists.

## The escalation — the same one, on a second anchor

`pingPongDemotes()` is unchanged. Ten consecutive **agent** messages, and the
eleventh is *not stored*: the room demotes to a `proposals` row
(`kind = 'review'`, `payload.reason = 'ping_pong_cap'`) carrying the
transcript. A human message resets the run — the owner's turn is the release
valve. Demotion happens once per room while the proposal is pending.

New here: that proposal carries **`work_id` on the row**, not just in the
payload. See "the link the board was missing" below.

## Resolve is the user's hand, and nothing else

There is no `tasks_resolve`. The service refuses any principal but the user,
and the only door is `POST /api/work/:id/thread/resolve` behind the passkey
session. Nothing resolves a room on a timer, and nothing should:

> `commentResolve` releases the oldest queued review bundle under the cap
> (§4.21). A sweep that resolved quiet rooms overnight would silently start
> queued work while nobody was watching.

The work-room resolve path deliberately does **not** call `releaseQueued` at
all — a room has no bundle to address, so there is nothing for it to release.
If auto-close is ever wanted it needs its own state (`stale`, not `resolved`)
or an explicit release path, per the research note's hazard (d).

A resolved room still accepts messages. It is a record, not a gate.

## Scope

The same grant `tasks_*` gets, enforced in the module rather than trusted to
an adapter:

- a work row outside the caller's projects does not exist for it —
  `not_found`, uniform;
- **a row with no project at all is invisible to every agent**, internal
  included (a project is the unit of coordination; a row outside one is the
  user's alone);
- the user and the console see everything.

## The agent surface

| Tool | Shape | Notes |
| --- | --- | --- |
| `tasks_comment` | `{ work_id, body }` | Appends. Past the cap it escalates instead of storing. No recipient field exists. |
| `tasks_thread` | `{ work_id }` | The whole room oldest-first, participants, resolve state, and `agent_tail`/`cap`. |

Both are in the crew tool group **`rooms`** — its own group, not part of
`tasks`. Speaking is a new power, so an existing crew gains it when the user
edits its manifest, never because a release widened a group it already named.

`participants` is who has *spoken*, computed server-side. Nobody is invited to
a room and nobody is a member of one.

## The brief carries the room

*"The brief is the context transfer."* When the runner claims a crew row, the
room on the row it is about (the dispatched `task_id` if there is one, else
the crew row itself) is appended to the brief as a **prior-work block**:

```
--- prior work on #418 (the room on this task; nobody is addressed here) ---
[2026-09-16T09:02:11.000Z] user: does this include the migration?
[2026-09-16T09:04:40.000Z] agent helper-a: it does — I will take the schema
--- end prior work ---
```

- **Budget:** `min(METISTRY_BRIEF_THREAD_BYTES, headroom under the brief cap
  the dispatch passed)`. Default 4096; `0` turns it off. The cap is frozen
  onto the row at dispatch (`meta.max_brief_bytes`) precisely so the block
  cannot smuggle a brief past the size `checkBrief` allowed.
- **Newest wins.** A long room contributes its *last* messages, rendered
  oldest-first the way the thread reads.
- **Recorded.** The `crew_run` row gets `thread_room`, `thread_comments` (the
  ids that were included) and `thread_bytes`, so "what did this crew actually
  see" is answerable from `runs` without re-reading a room that has moved on.
- **`brief_sha` does not change.** It stays the sha of the dispatched brief —
  what policy checked. The block is what the runner added, recorded
  separately.
- **A room is context, never a precondition.** A read that fails leaves the
  block out; it never parks the row.

This composes with the Taskuary review's ADOPT 4 (a prior-work block in the
brief) and the Eve review's ADOPT 3 (an append-only note on open work): a room
on a work row **is** the prior-work record, written by whoever was there, and
the next crew quotes it under a budget.

## The link the board was missing

`docs/ops/board.md` records that no proposal kind carried a work id, so
"which proposal is about this card" had no answer. `proposals.work_id` (0016)
is that answer. It is set **server-side, never as a tool argument**, in two
places:

| Where | Which row |
| --- | --- |
| A room past the ping-pong cap | the work row the room hangs on |
| Anything a crew raised while it held a row (`stampProposalWork`) | the row it held |

The crew case is stamped *after the fact*, from the run's own window (rows by
that crew, raised since it started, not already stamped) — the crew never
passes a work id, because `requests_create` has no such argument. A crew holds
one row at a time (its token is rotated per run), so the window cannot overlap
another of its own runs.

**Hook for the board (PR #155, unmerged at the time of writing):** with this
column, `board.yaml`'s **Needs You** column can join
`proposals p ON p.work_id = w.id AND p.decision = 'pending'`, and a card can
link to the room at `#/rooms/work/<id>`. Neither is wired here — the board
does not exist in this branch. When #155 lands, `board.md`'s paragraph
"**It is not 'a pending decision proposal cites this row.'**" is the paragraph
to revisit.

## The Rooms panel

One tab, one query (`/api/q/rooms`) — invariant 3 holds; the panel calls
nothing else to build its list. Per row: the anchor (artifact or work),
participants, message count, the agent tail against the cap, and — the reason
the panel exists — the **"why this came to you"** line.

`payload.reason` has been stored since the ping-pong cap shipped and was never
rendered as a sentence. Now it is:

> Ten agent turns went by without a human. The next agent message was not
> stored — this is where it came to you. Answer, or resolve the room.

Clicking a work room opens it with a composer (posting as `user`, which resets
the agent-only run) and the single Resolve button. Clicking an artifact thread
goes to the version it was about. Every value on the page came out of the
database and may be agent-authored, so all of it goes through `esc()`; a test
asserts it.

## Verifying it

```sh
pnpm test   # the constraint (exactly one parent), the cap on a room, resolve
            # is user-only, the tools' schemas, the brief block under budget,
            # and the rooms query across both anchors
curl -s --cookie "$SESSION" "$ORIGIN/api/q/rooms?state=open" | jq '.rows[0]'
curl -s --cookie "$SESSION" "$ORIGIN/api/work/418/thread"    | jq '.participants'
```

Rebuilding from the repo (invariant 1): a room is **durable**, like every
other `artifact_comments` row — it is agent- and user-authored state with no
upstream copy, so it joins the nightly dump. `proposals.work_id` is durable
for the same reason the proposal is. The `rooms` query itself is derived and
rebuilds itself.

## What this does not do

- **No presence.** Nothing shows who is "in" a room; the agents are pull-based
  and an agent that is not running is not anywhere. (The research note's
  BORROW-LATER: presence as an explicit state.)
- **No rate or dollar budget per room.** The cap counts consecutive agent
  messages, not messages per hour or dollars per room. A quiet room stays open
  forever, on purpose — see the hazard above.
- **No autonomy levels.** `autonomy.level: observe | propose | act_within_scope`
  is phase 3 of the research note and an open question (its narrowing-only
  property versus "lower the bar per agent as trust grows"). Not built, not
  decided.
