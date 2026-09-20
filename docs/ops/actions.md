# Actions — the request that does something when you allow it

## The design

**Approve** was inert for every kind but `improvement`, and `action` was a word
in the console's view map nothing emitted (`2026-09-16-taskuary-review.md` ADOPT
6, ruled 2026-09-16) — built here with the autonomy levels that decide who may
use it (A3 / OPEN-2: **widening is allowed, by the owner's hand**).

**The enum is closed and it is data.** An `action` proposal carries
`payload.action = {kind, args}`; `kind` is one of exactly four, held in
`packages/core/src/actions.ts` as a list plus a zod schema per kind. An unknown
kind — or an argument the schema does not admit — is a `400` naming the field:

| `kind` | `args` | Runs, on allow |
| --- | --- | --- |
| `dispatch` | `{work_id, target, brief}` | `dispatch()` — what `POST /api/tasks/:id/dispatch` calls |
| `task_update` | `{work_id, patch}` | `TasksService.update()` — what the board's drag calls |
| `comment` | `{work_id, body}` or `{artifact_id, version_id, body}` | `workComment()` / `commentCreate()` |
| `capture` | `{note, filename?}` | `captureToInbox()` |

What is *not* on it is the point: no email, no message, no git, no shell, no
grant. Every kind is something the console can already do through an existing
service with an existing audit row — an action adds a **door**, never a power.
Invariant 9 constrains the *engine*; this widens the *console's* surface.

**The gate is one record per agent**, not a second file: `agents.autonomy`
gains `{level: observe | propose | act_within_scope, actions: {<kind>: allow |
propose | deny}}` beside the §4.21 narrowing it already holds. **The level is a
ceiling** and the per-kind entry the value; the effective mode is the lower of
the two, so `allow` can only come out of `act_within_scope`. `dispatch` stays
`propose` unless set (off-machine is a human decision by default) and an absent
level is `observe`, so this release widens nobody. With no per-kind entry:

| | `dispatch` | `task_update` | `comment` | `capture` |
| --- | --- | --- | --- | --- |
| `observe` (**and an absent level**) | deny | deny | deny | deny |
| `propose` | propose | propose | propose | propose |
| `act_within_scope` | **propose** | allow | allow | allow |

**What each mode does**, by the table and never by a prompt: `deny` — refused
at `/mcp` naming `autonomy.actions.<kind>`, and an agent with nothing but
denials is not offered the tool at all. `propose` — the row lands `pending` and
waits for you. `allow` — it runs **immediately on emit**, and the proposal row
is still written, decided `auto`, carrying the result: the timeline shows what
happened without you having to have been there.

**Execution is the human route's own call** — the same service the owner's own
click goes through, as the deciding principal (`user`; `owner` where that
service spells it so), with `source_agent` recorded as `on_behalf_of` in the
payload and the audit row and the result (`runs` id, ids created) written back
to `payload.result`. A failure writes `payload.error` and **leaves the row
pending**: one action is one service call, so nothing is half-applied.
`act_within_scope` buys no new reach — grants, areas, projects, the dispatch
data policy and the board's WHERE clauses all still hold.

**Widening takes the owner's hand.** `validateAutonomy` still refuses unknown
keys; new is that a change *raising* the level or any effective mode is admitted
**only** through the `user`-principal route (`PUT /api/agents/:id/autonomy`) and
`metistry agents autonomy` — every caller reached with an agent credential stays
narrowing-only. Each widening writes a `runs` row `agent_admin` /
`autonomy_widened` and one Needs You alert per change per 24h.

## The agent's side

`propose_action {kind, args, reason}` in mcp-brain. Its own grant group,
`actions`, so a crew gains it when you edit its manifest and never because a
release widened `tasks` — the same rule `rooms` follows. It answers
`{status: "executed", proposal_id, result}` or `{status: "pending",
proposal_id}`; a denied kind comes back as a `forbidden` error envelope naming
the field that would permit it, which is what every other refusal in this
bridge is.

**Discovery is lazy for this group, by credential.** The bridge's eager surface
was measured at ~4.9k definition tokens of the 5k line that gates
`discovery: lazy` (`docs/research/2026-08-tool-discovery.md`), so the next tool
registered had to force that decision. `propose_action` is registered **only
for a principal whose table admits at least one kind** — which is nobody until
the owner sets a level. The default surface is unchanged by it; an admitted
principal carries one tool more and pays for it knowingly. (The eager number
itself moved 25 → 26 on 2026-09-19 for `request_access` below — a separate
decision, taken in the open, with the ceiling in
`ops/scripts/check-tool-surface.mjs` moved to record it.) Deferring by
credential rather than by a meta-tool index is the cheaper half of that
research's own advice: it costs zero extra turns, where the `tool_index` /
`execute` / `batch` pattern cost +1 turn and +34% prompt tokens on a surface
this size.

## Access requests — the other row this file describes

An agent that can see a page's TITLE and not its content used to have no next
move. Since 2026-09-19 it has one: **`request_access {area, reason}`** on
`/mcp` (`packages/mcp-brain/src/access.ts`), which is named in the
`scope_required` refusal that turned it away
(`docs/ops/assistant-tools.md`).

**It grants nothing.** It writes one `proposals` row, kind `access_request`,
`trust: external`, `source_agent` from the credential:

```json
{ "title": "devin asks to read Areas/Health", "area": "Areas/Health",
  "reason": "knowledge_read pointed me here",
  "current_tier": "index", "current_areas": [],
  "provenance": { "agent": "devin", "via": "mcp-brain", "submitted_at": "…" } }
```

- **Every tier may ask**, `none` included: an agent that can be refused is an
  agent that may ask. An **internal** principal may not — the assistant's scope
  is configuration in the user's hand (`METISTRY_ASSISTANT_AREAS`), and an
  approved ask would silently revert at the next restart, so the tool refuses
  it and says where its scope actually lives.
- **The area is validated at the tool**, with the same rule the grants
  validator uses (core's `validAreaPrefix`): TitleCase segments, no traversal,
  no `.metistry/`, no `Artifacts/`, not the bare vault. Nothing can be asked
  for that could not be granted.
- **Deduplicated on `(agent, area)` while pending** — a partial unique index,
  migration 0022, so a retry storm is one row. The existing id comes back with
  `replayed: true`. Once you have answered it, asking again is a new question
  and gets a new row.

### Your three answers, and what each one does

| Answer | Wire | What it does |
| --- | --- | --- |
| **Approve** | `allow` | Widens the agent's grant by the area it asked for — **through `writeGrants`, the same call `PUT /api/agents/:id/grants` makes**, with the same validator and the same `agent_admin` audit row (`via: triage`, `proposal: <id>`). |
| **Revise** | `accept_with_changes` + `{"area": "…"}` | The same widening with **your** prefix instead — usually narrower. Without an `area` it is a `400`: there is nothing to grant. |
| **Decline** | `deny` | Records the refusal on the row. **Nothing moves.** |
| **Later / Skip** | `later` / `skip` | As everywhere: Later snoozes and settles nothing, Skip declines quietly. Neither grants. |

**Approve is not a pure widening.** Tier `index` may be told a page exists
anywhere in the vault and read none of them; tier `areas` sees titles only
inside its prefixes. Granting an `index` agent one folder therefore trades its
vault-wide title browse for the read — the grant model has one tier, and that
trade is the decision you are making. Decline leaves it exactly as it was.

What Approve will **not** do: widen `queries` (a separate axis — invariant 3's
read path — carried across untouched), add an area beside the one asked for,
add a prefix a grant it already holds covers, or grant anything at all to a
**revoked** agent: revoking settles its pending asks as `deny`, and a row that
predates that is refused with a `404` and left pending for you to close. The
payload is re-validated at the decision too, so a row written by hand with a
crafted area is a `400` rather than a grant.

**Where you see it.** In Needs You beside every other request (the brief and
the console both call it *access*, like a `grant_elevation`), and in the Agents
panel next to the grant it is about — `GET /api/agents` answers
`access_requests: [{proposal_id, agent, area, reason, ts}]`. The panel is a
view: the answer is still given in the queue, through the one triage route.

## Routes and record

- `POST /api/proposals/:id {"decision":"allow"}` on an `action` row executes it
  and answers `{ok: true, action: {...}}`; `if_unchanged` works as it does
  everywhere (the row is linked to its `work_id`, so a comment in that row's
  room makes the decision stale).
- `PUT /api/agents/:id/autonomy` takes `{may_dispatch_to?, accept_from?,
  max_open_bundles?, level?, actions?}` and **replaces** the record. A
  concurrent change answers `409` rather than overwriting it.
- `metistry agents autonomy <id>` shows the effective table;
  `--level <l>`, `--allow/--propose/--deny <kind>` change it (read, merge, PUT).
- `POST /api/proposals/:id {"decision":"allow"}` on an `access_request` row
  widens the grant and answers `{ok: true, granted: {agent, area, grants}}`;
  `{"decision":"accept_with_changes","area":"…"}` grants that area instead.
- Every path lands in `runs`: `console/tool/propose_action` (the emit),
  `console/triage/action:<kind>` (the decision), `console/action/<kind>` (the
  execution, plus whatever the service itself records), and
  `console/agent_admin/autonomy_widened`.

## Verifying it

```bash
# what an agent may do right now
metistry agents autonomy researcher

# give it room to comment without asking, and keep dispatch human
metistry agents autonomy researcher --level act_within_scope --deny dispatch

# the widening, as the record shows it
psql -c "select tool, meta from runs where kind='agent_admin' and tool='autonomy_widened' order by ts desc limit 3"
psql -c "select kind, decision, payload->'action'->>'kind', payload->'result' from proposals where kind='action' order by ts desc limit 5"

# who is asking for what, and what you granted
psql -c "select source_agent, payload->>'area', decision, payload->'granted'->>'area' from proposals where kind='access_request' order by ts desc limit 10"
psql -c "select meta from runs where kind='agent_admin' and tool='grant' and meta->>'via'='triage' order by ts desc limit 5"
```

## What this does not do

No new outbound surface: nothing here sends a message, touches git, runs a
shell or changes a credential. No new console VERB either — an access request
is answered with the three answers every request already takes, and Approve is
a door onto the grants service that already existed (invariant 10). No batching — `allow` on an action stays one at
a time, for the same reason `improvement` does. No retry: a failed action's row
stays pending and you decide again, so a flapping target cannot spend twice on
one click.
