# Hermes Agent (Nous Research) — the Kanban board, and what it teaches us

Fetched 2026-09-12. Prompted by the owner: *"the Kanban view and primitives
vs delegates was an interesting read. That's a great way to visualize
pending, assigned, and completed work in a project. Or potentially across
multiple projects. Even if their kanban primitive isn't right for us, it
would be nice to see a UX like that for our agent tasks."*

Short answer: **skip Hermes as a dependency, adopt the view.** We already made
every architectural choice their kanban makes — durable rows, leases, peer
coordination, per-attempt history. Missing: one named query and one panel.

## 1. What Hermes is

`NousResearch/hermes-agent` — MIT, **Python-first** (77.7 MB Python / 26.3 MB
TypeScript by GitHub's language bytes), 244,868 stars, **42,280 open issues**,
created 2025-07-22, pushed 2026-09-12, release `v2026.9.11`, not archived.

A **product**, not a library: a personal-agent runtime with a CLI, TUI,
desktop app, a long-lived "gateway" process, ~30 messaging adapters, skills,
memory, cron, browser automation, voice. Kanban is one bundled dashboard
plugin (`plugins/kanban/`, ~700 lines of FastAPI + a React SPA) over SQLite.

## 2. The kanban feature

**Board model.** A board is "a standalone queue of tasks with its own SQLite
DB, workspaces directory, and dispatcher loop." Columns are the status enum:
`triage | todo | ready | running | blocked | review | done | archived`. A card
is a **task row** in `~/.hermes/kanban.db`: title, body, one assignee (a
*profile* name), status, tenant, idempotency key, priority, skills, model
override, workspace kind, PR completion contract.

**Cards vs runs.** "A task is a logical unit of work; a run is one attempt to
execute it." Attempts live in `task_runs` (`tasks.current_run_id` points at the
live one), closed with an outcome (`completed | blocked | crashed | timed_out |
spawn_failed | reclaimed`). Structured handoff (`summary`, `metadata`) lands on
the **run**, not the task; children read each parent's last completed run.

**Who moves cards.** Both, through one code path. Humans use `hermes kanban
…`, a `/kanban` slash command, or the dashboard (HTML5 drag → `PATCH
/api/plugins/kanban/tasks/:id`). Agents use a `kanban_*` toolset (`show, list,
complete, request_review, request_changes, block, heartbeat, comment, attach,
create, link, unblock`). "Both surfaces route through the same `kanban_db`
layer, so reads see a consistent view and writes can't drift." Dragging a
running card off Running closes its run as `reclaimed`, never orphaned.

**Assignment.** One assignee per card, a named profile. A **dispatcher** loop
(in the gateway, 60 s tick) reclaims stale claims and crashed workers (PID
gone), promotes `todo → ready` when parent links are done, atomically claims,
and spawns the assignee as a **full OS process**. Liveness: `kanban_heartbeat`.

**Cross-project views: Hermes cannot do this.** Boards are the isolation unit
and "per-board isolation is absolute" — separate SQLite file, separate
workspaces, workers pinned by env var, and "linking tasks across boards is not
allowed." The dashboard has a board *switcher*, not a cross-board board. The
owner's "across multiple projects" is what their model forbids and ours gets free.

**Persistence / UI / API.** SQLite (WAL) + an append-only `task_events` table
a WebSocket tails; single-host. React SPA, HTML5 drag-drop, lanes inside
Running, bulk actions, a card drawer (editable fields, dependency chips,
status actions, run history, comments), filters. REST under
`/api/plugins/kanban/`: `GET /board` (grouped by column + filter
vocabularies), `GET|PATCH|POST /tasks…`, `/bulk`, `/specify`, `/decompose`,
`/links`, `/dispatch`, `WS /events`. **Security note:** "The dashboard's HTTP
auth middleware explicitly skips `/api/plugins/` — plugin routes are
unauthenticated by design." Contradicts our invariant 8.

## 3. "Primitives vs delegates" — what the docs actually say

There is no page with that title. The passage is the kanban page's **"Kanban
vs. `delegate_task`"**, opening *"They look similar; they are not the same
primitive."* Its closing line is the definition:

> `delegate_task` is a function call; Kanban is a work queue where every
> handoff is a row any profile (or human) can see and edit.

`delegate_task` spawns child `AIAgent` instances — anonymous subagents,
isolated context, inherited toolsets, own terminal session; only the final
summary re-enters the parent. They are **sub-agents (child agent loops), not
single model calls**. Leaf children cannot nest; `role="orchestrator"` ones
can, bounded by `max_spawn_depth`. The human watches via one append-only log
per delegation, a TUI `/agents` overlay, `interrupt_subagent`/`steer_subagent`.

| | `delegate_task` | Kanban |
| --- | --- | --- |
| Shape | RPC call (fork → join) | durable message queue + state machine |
| Parent | blocks until child returns | fire-and-forget after create |
| Child identity | anonymous subagent | named profile with persistent memory |
| Resumability | none — failed = failed | block → unblock → re-run; crash → reclaim |
| Human in the loop | not supported | comment / unblock at any point |
| Agents per task | one call = one subagent | N agents over the task's life |
| Audit trail | lost on context compression | durable rows in SQLite forever |
| Coordination | hierarchical (caller → callee) | peer — any profile reads/writes any task |

Handoff back is `kanban_complete(summary, metadata)`; failure is
`kanban_block(reason, kind=dependency|needs_input|capability|transient)`, and
repeated re-blocks for the same cause escalate to `triage` after
`BLOCK_RECURRENCE_LIMIT` (default 2) — "a deterministic DB guard, not an LLM
judgment call." **Also worth a line:** per-task model override with a stated
"frontier orchestrator, inexpensive workers" cost split; an LLM
`decompose`/`specify` pair on triage; PR completion contracts that read
GitHub required checks before a card may close.

## 4. Mapping the board onto Metistry's `work` rows

`work` today (`0001`, `0002`, `0005`, `0006`, `0008`): `id, title, area, kind,
status, external_ref, owner, due, created_at, updated_at, claimed_by,
lease_expires_at, depends_on, meta, project, idempotency_key, history,
created_by, closed_at`. Status is four values — **`open | in_progress |
blocked | closed`** (`packages/tasks/src/index.ts`). Claimable kinds: `task`,
`review`; collected rows (`issue|pr|event`) are visible, never claimable.

**Every Hermes column is already derivable — no migration, no new status.**

| Board column | Predicate over `work` | Hermes name |
| --- | --- | --- |
| Waiting on deps | `status='open'` AND some `depends_on` not closed | `todo` |
| Ready | `status='open'`, unclaimed/lapsed, deps closed, `owner IS NULL` | `ready` |
| Assigned | same, but `owner IS NOT NULL` | (no equivalent) |
| Working | `status='in_progress'` AND `lease_expires_at > now()` | `running` |
| Interrupted | `status='in_progress'` AND `lease_expires_at <= now()` | reclaim-pending |
| Needs you | `status='blocked'` AND a pending `proposals` row references it (payload shape unverified) | `blocked` (needs_input) |
| Blocked | `status='blocked'` otherwise | `blocked` |
| Done | `status='closed'` | `done` |

`listReady()`'s `DEPS_CLOSED` / `UNCLAIMED` fragments already encode the first
three; `agent_presence.yaml` already computes `interrupted`. **The "assigned
but not started" column the owner wants exists in the data today** — it is
`owner IS NOT NULL AND claimed_by IS NULL`.

**Genuinely missing, and small:**

1. **No route back to `open`.** `UpdateInput.status` is
   `Exclude<TaskStatus,'open'>`, so *unblock* is unreachable today. Our gap,
   not a Hermes import.
2. **`owner` cannot be set after create.** Assign/reassign is the most
   ordinary board gesture and `UpdateInput` has no field for it.
3. **`tasks_renew` carries no note.** `kanban_heartbeat(note=…)` is what makes
   a Working card informative; one optional `note` into `history` closes this.
4. **No cancellation.** Releasing a lease does not stop the crew's in-flight
   SDK query in the assistant container. They have `interrupt_subagent` and a
   dispatcher that reclaims on a dead PID; we have neither.
5. **"Done" vs "reported"** is not on the row — reconstructible from
   `runs.meta.reports` and `proposals` of kind `report`, but a card should
   show it without a join the panel invents.

## 5. Primitives vs delegates, in our terms

mcp-brain's tools are the **primitives** (invariant 9: "`brain-commit` plus
allowlisted bridges are the assistant's entire mutating/outbound surface");
crews (`targets/local-crew`) and compute targets (`targets/github-issues`) are
the **delegates**. The finding worth the owner's attention: **we already sit on
the Kanban side of §3's table on every axis and deliberately never built the
`delegate_task` side.** `agents_delegate` is not fork/join — it writes one
`work` row, `crew-drain.ts` claims it under a lease, results return only as
`requests_create` → `proposals`, `capture`, artifacts: durable queue,
fire-and-forget, named crew, re-picked on lease lapse, human in the loop via
Needs You, N agents over a row's life, `runs` + `work.history` as audit, peer
coordination. The one axis where theirs is richer is *child identity* — their
profiles carry memory; ours are memoryless ("the brief is the context transfer").

Their split therefore suggests three absences, not a new abstraction:
**progress on a card** (§4.3), **partial reports** (a run with `reports: 0`
looks identical to a crashed one), **cancellation** (§4.4) — delegate
properties a board makes visible, which is the argument for building the
board first and letting it name the gaps.

## 6. Proposal — a board panel for the console

### 6a. The named queries (invariant 3)

`seed/queries/board.yaml` — params `project` (blank = all), `include_closed`,
`closed_hours` (168), `limit`. One row per card, bucketed server-side:

```
project, id, title, kind, area, due, owner, claimed_by, lease_expires_at,
column,      -- the CASE over §4's table; the panel never derives it
age_seconds, idle_seconds, lease_seconds_left, deps_open,
last_note, last_op, last_agent, last_op_at,  -- history[-1]
attempts,    -- count(runs) where meta->>'work_id' = id::text
reported,    -- any proposals row of kind 'report' citing it
escalate     -- interrupted | blocked w/ pending proposal | overdue | idle >24h
```

`seed/queries/board_projects.yaml` — the cross-project variant: one row per
`project × column` with `cards`, `escalations`, `oldest_age_seconds`,
`last_activity`. The view Hermes structurally cannot produce, and a `GROUP BY`
on a table we have. `cache_ttl: 0` like `projects_rollup.yaml`.

### 6b. The panel (vanilla JS, `apps/console/web/app.js`)

A `board` view beside `feed/chat/dashboard/…` in the `views` array, loaded
through the existing `dashQuery("board", …)` → `GET /api/q/board` path and
rendered with `esc()` on every server value exactly as `renderProjectRows`
does. Columns are `<ul>`s with counts in the header; cards show id, title,
owner or lease holder, age, attempts, `last_note`, and a `failed`-class chip
when `escalate`. Filters: project `<select>` from `GET /api/projects` (the
feed filter's pattern), text filter, "show closed (7d)". Keyboard: `j/k`,
`Enter` opens history, `/` filters, `Esc` clears. No framework, no drag
library — HTML5 `draggable` is four handlers.

### 6c. Which route each drag maps to

There is **no HTTP task-mutation surface today** — `server.ts` exposes only
`POST /api/tasks/:id/dispatch`; every other mutation is an mcp-brain tool. The
drags need a thin console adapter over `TasksService` ("Adapters … adapt this
and add nothing"), behind the same session auth as `/api/projects`:

| Drag | Route | Service call | Allowed for |
| --- | --- | --- | --- |
| Ready → Assigned | `PATCH /api/tasks/:id {owner}` | **new** `assign()` | human: any crew. Agent: Claude-kind crews only — a directed push to a named non-Claude crew is refused (collaboration rule 4) |
| Assigned/Ready → Working | — | `claim()` | **no one drags this.** Only the claiming agent enters Working; the column is owned by the lease |
| Working → Ready | `POST /api/tasks/:id/release` | `release()` | human and holder. This is Hermes's `reclaimed` outcome, which we already have |
| Working/Ready → Blocked | `POST /api/tasks/:id/update {status:'blocked',note}` | `update()` | holder today; a human override needs an owner-principal path — **owner's call** |
| Blocked → Ready | `POST /api/tasks/:id/reopen` | **new** `reopen()` | human. Not reachable at all today (§4.1) |
| Any → Done | `POST /api/tasks/:id/close` | `close()` | human; agents keep using `tasks_close` |
| Card → a target lane | `POST /api/tasks/:id/dispatch` | existing | human only; `checkBrief` unchanged |

The rule that keeps invariant 8 honest: **the board offers no drop the
service would refuse.** Every refusal above is enforced in `packages/tasks` /
`apps/console/src/crews.ts`; the UI only declines to draw the target.

### 6d. Mac/iOS

MetistryKit reads named queries, so the app renders `board.yaml` with no new
server work — sections per column on iPhone, lanes on Mac/iPad;
`board_projects.yaml` is the Mac sidebar's counts. Writes use 6c.

## 7. Verdict and lessons

**Hermes as a dependency: skip.** Five independent reasons, any one
sufficient. (i) Python-first, and CLAUDE.md's stack rules "no Python
anywhere". (ii) Its board is a second source of truth for tasks — a SQLite
file beside our `work` table — breaking invariants 1 and 3 at once. (iii) Its
dispatcher spawns OS processes, duplicating `crew-drain.ts` and handing the
assistant a shell (invariant 9). (iv) `/api/plugins/` is unauthenticated by
design (invariant 8). (v) 42k open issues on a repo pushed daily is no
dependency for a solo maintainer, for a view we can write in one query.
*(Rejected: vendoring `kanban_db` — Python, and its value is the schema.)*

**ADOPT** (no dependency, all cheap): the board view as a named query;
per-attempt history on the card (already in `runs.meta.work_id`); a `note` on
`tasks_renew`; "drag out of Working = release, never orphan"; and their
orchestrator rule — *decide before you fan out; workers cannot see sibling
cards* — in the assistant's seed prompt for `agents_delegate`.

**BORROW-LATER:** a per-task comment thread (extend `artifact_comments`
rather than invent a shape); multi-select + bulk actions; per-card model
override once `compute.yaml` lands; their block-recurrence breaker.

**SKIP:** boards as hard isolation (our `project` column gives the
cross-project view Hermes forbids); tenants; auto-decompose on triage;
WebSocket live updates (poll — it is indexed counts).

## 8. Phased proposal — for the owner, not started

**PR-1 — `board.yaml` + `board_projects.yaml`, read-only.** Two seed queries
and their tests. *Proves:* every column the owner asked for is derivable from
today's schema with no migration and no fifth status value, and the
cross-project board — what Hermes structurally cannot do — is a `GROUP BY`.

**PR-2 — the board panel, read-only.** The `board` view in `app.js`, nav
entry, filters, keyboard. *Proves:* the UX is worth having before any write
path exists, and forces the query's column set to be right. If the panel is
not useful read-only, PR-3 should not be written.

**PR-3 — the drags.** Close the three service gaps (`reopen()`, `assign()`, a
`note` on renew), add the thin console adapter, wire §6c's policy. *Proves:*
enforce-at-the-tool survives a direct-manipulation UI — a human may assign to
any crew, an agent may not name a non-Claude one, nobody drags into Working.
Ships with the misuse tests invariant 8 requires.

## 9. Contradictions and things I could not verify

- **A note this brief cited does not exist.** I was pointed at
  `docs/research/2026-09-12-agent-room-review.md` ("threads on tasks, autonomy
  levels"); the only 2026-09-12 note in the repo is
  `2026-09-12-rivet-agentos-review.md`. That proposal is not reflected here.
- **`work.owner` is documented as informational** — "Who the row is addressed
  to …; claims are still first-come" (`packages/tasks`). An Assigned column
  makes it look authoritative. Either the board says "addressed to" or `owner`
  gains meaning. Owner's call.
- **Auto-decompose brushes invariant 4.** Their default has an LLM choose which
  profile each child card goes to; invariant 4 is about model selection, so not
  a violation — flagged rather than assumed.
- **Not read:** `docs/hermes-kanban-v1-spec.pdf` (their repo; design
  rationale, concurrency proofs, comparison against Cline Kanban / Paperclip
  / NanoClaw), `kanban-tutorial`, `kanban-worker-lanes`, the CLI reference.
- **Nothing was run.** Hermes was never installed; every claim is from their
  docs and the GitHub API, and no board query was executed against a live
  database — §4's predicates are read off the schema and `packages/tasks`.

## Sources (all fetched 2026-09-12)

All HTTP 200; no fetch failed. Base `https://hermes-agent.nousresearch.com/docs/`.

- `user-guide/features/kanban` — Kanban (Multi-Agent Board)
- `user-guide/features/delegation` — Subagent Delegation
- `guides/delegation-patterns`, `user-guide/features/overview`, `sitemap.xml`
- `gh api repos/NousResearch/hermes-agent`, `/languages`, `/releases/latest`
