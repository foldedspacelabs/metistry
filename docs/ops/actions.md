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
the owner sets a level. The default surface is unchanged at 25 tools; an
admitted principal carries 26 and crosses the line knowingly. Deferring by
credential rather than by a meta-tool index is the cheaper half of that
research's own advice: it costs zero extra turns, where the `tool_index` /
`execute` / `batch` pattern cost +1 turn and +34% prompt tokens on a surface
this size.

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
```

## What this does not do

No new outbound surface: nothing here sends a message, touches git, runs a
shell or changes a credential. No batching — `allow` on an action stays one at
a time, for the same reason `improvement` does. No retry: a failed action's row
stays pending and you decide again, so a flapping target cannot spend twice on
one click.
