# Oh My Subagents — lessons for unblocked, completing agent teams (2026-09-22)

Research commissioned by the owner the same day: *"Let's do a review of Oh My
Subagents (https://github.com/ringlochid/oh-my-subagents). I don't think this
approach will work for remotely connected agents, but it might for local and
remotely controlled agents that Metistry coordinates. Let's get lessons learned
from this and see if there are things we should adopt to ensure teams of agents
remain functional, not blocked, and complete their assigned tasks."*

Nothing here is built. The OMS repo was cloned read-only at `fcc4398`
(2026-09-14, branch `main`) and read **on disk** — the 71,179 lines of Python
under `src/`, not the rendered README — so paths below are theirs; every claim
about Metistry cites a file and a line in **this checkout**. **The owner's
instance was not read** — no vault, no database, no live queue. OMS is Python;
the repo's no-Python rule applies to the product, so nothing here proposes
vendoring any of it. Every lesson is a shape, restated in TypeScript terms.

## The short version

1. **The owner's instinct is right, and the reason is structural, not
   incidental.** OMS has **no work queue, no claim and no lease**. An
   Assignment is created already bound to a named child Member
   (`persistence/models/runtime/assignment/execution.py:41-62`, unique on
   `(task_id, assignment_id, member_id)`, foreign-keyed to `members`); a parent
   *pushes*, a child never *pulls*. Our collaboration rule is the exact
   inverse — *"a non-Claude agent claims unassigned work, is never pushed to
   by name"*
   (`docs/plan-refresh-2026-09-13.md:450-451`; enforced by the absence of a
   tool, `docs/ops/devin.md:93-96`). There is no version of OMS's coordination
   model that reaches a connected Cursor or a cloud Devin, because the model
   begins by naming the recipient. **For local crews it maps almost exactly**
   (§2.4).
2. **Their single best mechanism is one function, and we should copy it.** A
   Manager's `green` Checkpoint is *refused* unless every current direct child
   has an accepted green return — `checkpoint/persistence.py:68` calling
   `:269-302`, which raises `BOUNDARY_PRECONDITION_FAILED` naming the missing
   children. Not a prompt, not a reviewer: a precondition inside the commit
   that writes the result. That is "enforce at the tool, never by prompting" in
   someone else's codebase, and it is the single thing most directly answering
   *"complete their assigned tasks"* (§4.2, §3 row 1).
3. **Every wait in OMS is a row with exactly one typed reason, and a deadline.**
   `attempt_waits` carries a CHECK constraint that exactly one of
   `delegation_wave_id` / `human_request_id` / `command_run_id` is non-null
   (`persistence/models/runtime/waiting.py:46-54`), and an attempt has at most
   one (`UniqueConstraint("attempt_id")`, `:34`). A blocked agent in OMS is
   never "blocked, somehow" — the row says what on. Our `work.status =
   'blocked'` is a single flag with the reason, when there is one, in free text
   in `history` or in `meta.blocked_by` (§2.5). **This is the cheapest thing in
   this document** (§3 row 3).
4. **Their liveness probe is an inactivity deadline on the provider turn, not a
   lease on the task**, and it is fenced with an optimistic-concurrency token.
   `calculate_watchdog_due_at` is `max(adapter_started_at,
   last_node_activity_at) + inactivity_timeout` (`watchdog/deadline.py:100-112`;
   default 2700 s, `config.py:112`); firing replaces the dispatch, increments
   `watchdog_replacement_count`, and after 2 replacements
   (`config.py:113`) pauses the task with `runtime_recovery_exhausted`
   (`watchdog/recovery.py:90-102`). We have the lease half
   (`packages/tasks/src/index.ts:157`) and none of the activity half: our lease
   can be renewed by a heartbeat from a process that is making no progress
   (§4.1).
5. **The watchdog refuses to fire while the agent is legitimately waiting on a
   human.** `dispatch_has_no_external_source()` (`watchdog/predicates.py:89-92`)
   excludes any dispatch that has an open Human Request or Command Run. The
   deadline for *that* lives on the request itself: `due_at` plus a
   `default_behavior` the agent declares when it asks
   (`contracts/human_requests.py:103-126`), expiring to a `TIMED_OUT`
   resolution that is fed back into the continuation
   (`human_request/deadline.py:94-109`). **Our Needs You queue has `later`
   (a snooze) and no deadline at all** — nothing expires, and nothing tells the
   asker (§4.1, §3 row 7).
6. **What they explicitly did not build is as instructive as what they did.**
   *"Oh My Subagents does not create a branch, checkout, or write-isolated
   directory per Member. Managers must sequence overlapping writes or divide
   ownership into credibly disjoint paths"*
   (`docs/concepts/workspace-and-files.md`, and again in
   `docs-internal/architecture/workspace-files-and-prompt.md:25`). Conflict
   avoidance between parallel agents is delegated **to a model, in prose**.
   Claude Code ships `isolation: worktree` per subagent, and this repo's own
   practice is a worktree per agent. Reject this one in writing (§3 row 21).
7. **Their control API has no authentication.** The product HTTP surface is
   gated on loopback peer + exact `Host` + exact `Origin`
   (`interfaces/http/local_admission.py:26-80`) and nothing else; only the
   agent-facing MCP endpoint has a bearer, and that one is excellent — a
   per-dispatch credential with an `exposure_ceiling` of legal operations,
   revoked when the dispatch closes (`runtime/node_mcp/bindings.py:52-113`).
   That per-dispatch bearer is the same idea as our per-run minted-and-burned
   crew token (`apps/assistant/src/crew-drain.ts:7-12`). The unauthenticated
   half is invariant 8's named failure mode, in a system that got the other half
   right (§1.7).
8. **Recommendation: adopt four things now (a typed `blocked_by`, a
   `work_stalls` named query, a doctor/watchdog stall probe, and a
   request deadline), PoC two (an acceptance gate on a work row, and
   activity-anchored leases), reject three in writing (push-by-name to external
   agents, model-decided conflict avoidance, an unauthenticated control
   surface)** — §6. Six open questions; Q1 decides whether §6.2's first phase is
   three items or five.

---

## 1. What Oh My Subagents is

### 1.1 The shape

| | |
| --- | --- |
| repo | `ringlochid/oh-my-subagents`, created **2026-07-20**, last push **2026-09-14** |
| scale | **121 stars**, 10 forks, **0 open issues**, 1 watcher, **1 contributor** (144 commits) — GitHub API, 2026-09-22 |
| language | **Python ≥ 3.12** (`pyproject.toml:19`); 71,179 lines under `src/`, plus a React console |
| licence | **MIT** (`LICENSE`, "Copyright (c) 2026 Yunan Zhang") |
| version | **v0.3.2** (2026-08-30), on PyPI as `oh-my-subagents`; renamed from **Banksia** in August (ADR-0018, ADR-0019) |
| deps | `fastapi`, `uvicorn`, `sqlalchemy[asyncio]`, `pydantic`, `click`, `mcp`, plus **`openai-codex==0.144.4` and `claude-agent-sdk==0.2.128` pinned exactly** |
| storage | **SQLite by default**, Postgres optional (`[postgres]` extra) |
| install | `pipx install oh-my-subagents && oms init && oms service install`; a local web console on `127.0.0.1:18125` |
| issue history | 3 issues ever, one of them a real bug (`#4`, a macOS ACL error); 6 merged PRs, all by the author |

Positioning, from the README: *"Turn ad-hoc subagents into durable,
accountable AI teams… Local subagent orchestration for Codex and Claude, with
persistent task state, reusable teams, and interruption recovery."*

**It is not a framework and it is not a set of agent definitions.** It is a
controller: a long-running local service that owns a database, starts Codex and
Claude Code provider processes itself through their vendor SDKs, hands each one
an MCP server over loopback, and treats everything the provider says as
evidence rather than truth. The nearest thing we have is `apps/console` +
`apps/assistant`'s crew drain, together.

Maturity, stated plainly: **one author, four months, 121 stars, no external
contributors and no issue traffic.** Nothing here should be adopted because OMS
does it; the mechanisms below are worth taking because they are correct, and
several of them are better-specified than anything in the larger frameworks.

### 1.2 The coordination model — a tree, a wave, and a local join

The vocabulary (`docs/concepts/runtime-and-results.md`, cross-checked against
the models):

- **Workflow** — a published, immutable, versioned tree of *responsibilities*
  (not steps, not a DAG). A Task pins one revision at start.
- **Member** — a node in that tree: title, description, instruction, model,
  effort, requested capabilities.
- **Task** — one run of a Workflow against one prompt. Status is
  `pending | running | blocked | paused | succeeded | cancelled`
  (`runtime/contracts/primitives.py:13-19`).
- **Assignment** — one immutable, complete work request for one Member.
  Materially changed scope requires a *fresh* Assignment, never an edit.
- **Attempt** — one try at an Assignment. A semantic `retry` replaces it, budget
  permitting.
- **Dispatch** — one provider turn inside an Attempt.
- **Checkpoint** — the durable teammate-facing report. Outcome absent = progress;
  outcome present = terminal.

The lead starts; every other Member exists structurally but is idle. A Manager
delegates a **Wave**: one to eight fresh Assignments to unique available direct
children, committed **atomically with the parent's wait**, with the provider
processes started only *after* commit (`delegation/fan_out.py:32-39`,
*"Atomically fan out one ordered set of direct-child Assignments"*; the tool's
own description at `node_operations/catalog.py:76-79`). The parent's turn then *ends* — there is no
polling loop and no wait-for-wave verb:

> *"Successful delegation transfers authority, closes the provider turn, and
> lets the controller open the exact continuation when the join settles."*

The join is local and recursive. The parent resumes **once**, after every Wave
member has returned a terminal `green` or `blocked`; blocked members do not
cancel siblings; results are returned in **delegation order, not completion
order**; a child `retry` does not settle its position
(`delegation/settlement.py:42-76`, `:116-141`).

Three things this model does *not* have, all of which we do:

- **no shared board** — nothing enumerates outstanding work across tasks;
- **no claim and no lease** — the recipient is chosen at creation, and the row
  is bound to it;
- **no message channel between siblings** — a child can only speak to its parent,
  once, at the end, through its Checkpoint. (Claude Code's `SendMessage` and our
  rooms both exist; OMS deliberately has neither.)

Sizing and parallelism are three configured integers
(`config.py:105-107`): `max_child_assignments_per_assignment: 20`,
`max_retries_per_assignment: 1`, `max_wave_members: 8`. They are snapshotted
onto the assignment at creation (`runtime/assignment/budget.py:14-26`), so a
config change mid-task cannot retroactively widen an in-flight budget.

**Invariant 4 is not violated by this, and the distinction is worth getting
right.** The *Manager model* decides which children run and in what shape; it
does not decide which model runs. Each Member's provider, model and effort come
from its pinned configuration (`resolve_member_provider_route(session, task_id,
member_configuration_id, …)`, `checkpoint/semantic_retry.py:131-137`), authored
in the Workflow and narrowed by the controller
(`narrow_provider_capabilities`, `:138-142`). Tier selection is deterministic
and authored; *routing between authored roles* is the model's. Our router rule
constrains the first, not the second.

### 1.3 The wait is a row, and exactly one kind of thing

`attempt_waits` (`persistence/models/runtime/waiting.py`) is the cleanest single
idea in the codebase:

```
UniqueConstraint("attempt_id")                     # :34  — at most one wait per attempt
CheckConstraint(                                   # :46-54
  "(delegation_wave_id IS NOT NULL AND human_request_id IS NULL AND command_run_id IS NULL) OR "
  "(delegation_wave_id IS NULL AND human_request_id IS NOT NULL AND command_run_id IS NULL) OR "
  "(delegation_wave_id IS NULL AND human_request_id IS NULL AND command_run_id IS NOT NULL)",
  name="ck_attempt_waits_exactly_one_source")
```

The docstring is *"One exact typed suspension source selected by its owning
Attempt"* (`:30`). Three kinds of blocked exist and no fourth can be invented:
waiting on children, waiting on a person, waiting on a command. Each has its own
terminal path, its own deadline, and its own continuation. Opening a Human
Request or a Command Run **closes the current dispatch** — the provider must
stop, and unrelated lanes keep running (`node_operations/catalog.py:116-141`).

### 1.4 Not blocked: an inactivity watchdog on the turn, capped

`calculate_watchdog_due_at` (`watchdog/deadline.py:100-112`):

```python
adapter_anchor = _as_utc(adapter_started_at)
activity_anchor = _as_utc(last_node_activity_at) if last_node_activity_at is not None else adapter_anchor
return max(adapter_anchor, activity_anchor) + timedelta(seconds=inactivity_timeout_seconds)
```

The anchor is the **last time the agent called a controller operation**, not the
last time a process reported alive. The deadline is registered with the
`node_activity_revision` it was computed from, and the registration is discarded
if that revision moved (`:76-88`) — so a busy agent silently re-arms its own
deadline, and a stale timer cannot fire against a newer state.

When it does fire (`watchdog/recovery.py:66-139`), recovery is a *conditional
replacement*, not a kill: read a snapshot; if `watchdog_replacement_count >=
watchdog_same_attempt_replacement_limit` pause the whole task with
`pause_reason="runtime_recovery_exhausted"`; otherwise prepare a replacement
dispatch from the *stored* request, then commit four guarded statements in one
transaction — claim the task row, close the source dispatch
(`closed_reason="watchdog_superseded"`), increment the replacement count, stage
the new dispatch. Every one of those `UPDATE`s carries the whole world in its
`WHERE` clause (`watchdog/predicates.py:22-74` checks task status, team
revision, control revision, member configuration, branch basis, attempt status,
dispatch status and workspace binding) and returns zero rows if anything moved.
This is exactly our own stated primitive — *"Every state change is ONE atomic
statement whose WHERE clause carries the policy… Never read-then-write"*
(`packages/tasks/src/index.ts:11-14`) — applied to eight predicates instead of
three.

Two exclusions make it honest:

- `dispatch_has_no_external_source(dispatch_id)` (`predicates.py:89-92`) — never
  reap a dispatch that opened a Human Request or a Command Run. Waiting on a
  person is not a stall.
- `dispatch_has_no_successor(dispatch_id)` (`:95-97`) — never reap something a
  continuation already replaced.

And the human wait has its own clock: `HumanRequestTimeout {due_at,
default_behavior}` (`contracts/human_requests.py:103-126`), with a model
validator refusing a `default_behavior` without a `due_at` and a database CHECK
saying the same thing (`persistence/models/runtime/human_requests.py:68`). On
expiry the request resolves `TIMED_OUT` with
`resolved_by_surface=CONTROLLER` (`human_request/deadline.py:94-109`), and the
continuation prompt carries the original request *and* the timeout resolution
back to the agent (`human_request/continuation.py:200-230`).

**Be precise about what half of that is machinery.** The *deadline* is
enforced — a scheduled signal writes a terminal resolution whether anyone is
watching or not. The *`default_behavior`* is free text handed back to the model
in the continuation prompt. Under this repo's closing principle that second half
is not a control; it is a well-placed hint. Adopt the deadline; do not adopt the
belief that declaring a fallback enforces one.

### 1.5 Complete: `green` is gated on the children, in the transaction

`CheckpointOutcome` is a three-value enum (`contracts/primitives.py:22-25`):

| outcome | closes | consequence |
| --- | --- | --- |
| `green` | Dispatch, Attempt, Assignment | completed; settles a Wave member or the root |
| `blocked` | Dispatch, Attempt, Assignment | cannot complete in its boundary; **still settles** |
| `retry` | Dispatch, Attempt | fresh Attempt if budget remains; settles nothing, becomes no Result |

`commit_checkpoint` opens with (`checkpoint/persistence.py:66-68`):

```python
outcome = request.outcome.value if request.outcome is not None else None
if outcome == "green":
    await _require_current_direct_child_participation(session, authority)
```

and `_require_current_direct_child_participation` (`:269-302`) walks the current
team revision's direct children, asks `read_accepted_green_participation` for
each (`team/participation.py:13-27` — a join from `accepted_boundaries` to the
authoring dispatch's `(task, member, configuration, branch_basis)`), and raises:

```
"green requires an accepted green Checkpoint from every current direct child; missing: <ids>"
```

A blocked child settles the Wave but does **not** satisfy participation; a retry
satisfies neither. To take a child's work over yourself you must first *remove*
the child, which is a replan and closes your dispatch. There is no path by which
a lead reports success over children that did not succeed.

The Result is then defined by exclusion: *"The accepted terminal `green` or
`blocked` Checkpoint from the Task lead's root Assignment is the exact
user-visible Result… Oh My Subagents does not ask another model to paraphrase
it or fall back to ordinary provider prose."* Provider exit code zero completes
nothing.

What is **not** there: no acceptance criteria on an Assignment, no verification
step, no deterministic check. "Done" means *a named agent asserted green and its
children asserted green* — a structural guarantee about **who agreed**, never a
factual one about **what is true**. The independent-verification pattern is a
Workflow the author writes by hand (`docs/guides/multi-agent-code-review.md`),
not a controller feature. That gap is where §4.2's recommendation lives.

Retry budgets are real and small: one semantic retry per Assignment by default,
snapshotted at creation; two watchdog replacements per Attempt; exhaustion
*pauses* rather than fabricates. *"Exhaustion or infrastructure failure remains
visible controller state; it is never rewritten into successful work."* And a
line worth stealing verbatim into our own crew docs: *"Ordinary review-driven
repair is not retry. It is fresh work with the concrete findings in a new
Assignment."*

### 1.6 Functional: capabilities deny by default, and the workspace does not

Capabilities are default-deny and **do not inherit** from a parent
(`runtime/capabilities.py:52-57`, "*Resolve one Member's default-deny request
with controller narrowing only*"). Every `HumanRequestCapabilitySet` field
defaults to `DENY` (`contracts/capabilities.py:43-49`), `command_run` defaults
to `DENY` (`:76-79`), and the controller may only narrow, never widen. The tool
catalog the agent is offered is then filtered per dispatch by `(has_direct_team,
capability, state-legality)` (`node_operations/catalog.py:163-190`,
`node_operations/state_legality.py:107-137`) — so a Contributor with no children
is never shown `delegate`, and an agent denied human requests never sees
`open_human_request`. That is our `uses` groups plus our `autonomy` table, in
one mechanism.

The workspace is the opposite, and they say so:

> *"Every Task has one selected provider-visible workspace. All Members work in
> that same native filesystem… Oh My Subagents does not create a branch,
> checkout, or write-isolated directory per Member. Managers must sequence
> overlapping writes or divide ownership into credibly disjoint paths."*
> (`docs/concepts/workspace-and-files.md`)

The only concurrency control in the repo is an in-process `asyncio.Lock` per
workspace path, held during *task admission* only
(`runtime/workspace/coordination.py:16-32`). `worktree` appears nowhere in the
Python (`grep -rn worktree src/` → nothing; the one architecture note says
per-member worktrees, path leases and merge automation are all deliberately
out). Coordination between parallel writers is a sentence in a system prompt.

Message passing between Members: **none**. A child's only channel to its parent
is its terminal Checkpoint plus `FileReference`s — `{path, description}`,
validated at the boundary against a strict grammar (workspace-relative,
slash-separated, no absolute paths, no `..`, no globs, no symlink components, no
duplicates, must exist and be a regular file). A reference *proves what existed
at the boundary* and nothing more: it copies no bytes, freezes no content and
grants no access. The user gets `.oms/t_<id>/notes/` and `artifacts/` as
conventions, explicitly *not* managed resources ("*despite the directory name,
Oh My Subagents has no managed Artifact resource*"). Our `artifacts` package,
with versions and a resolve state, is a strictly stronger answer to the same
question.

There is one live steering channel: the user may deliver *"bounded new context
to one exact active Member"* mid-run, recorded in Activity with the exact
message and carried into later Dispatches for that Assignment. It does not
replace the Assignment or grant authority.

### 1.7 Authentication, and the invariant-8 comparison

Two surfaces, two answers.

**The agent-facing MCP endpoint is well done.** `DispatchMcpBindingRegistry`
(`runtime/node_mcp/bindings.py:45-113`) issues a random credential per dispatch,
stores only its digest, compares with `hmac.compare_digest`, carries an
`exposure_ceiling: frozenset[str]` of legal operations on the binding itself,
and revokes on dispatch close. The middleware requires a loopback peer *and* a
valid bearer, 401s with `WWW-Authenticate` otherwise
(`interfaces/mcp/node/http_admission.py:30-63`). This is the same shape as our
crew runner minting a token per run and burning it in `finally`
(`apps/assistant/src/crew-drain.ts:7-12`) — arrived at independently, which is
mild evidence it is the right shape.

**The product control API is not.** `LocalHttpAdmission`
(`interfaces/http/local_admission.py:26-80`) checks loopback peer, exact `Host`
authority, exact `Origin` — and there is no credential at any point. Anything
running as the user on that machine can start a Task, answer a Human Request,
cancel a run, or read every Result. That is invariant 8's stated failure mode
(*"the network is not a boundary… every request authenticates as if
internet-exposed"*) and it is the reason our console has a passkey session, our
`/mcp` requires an agent bearer even on loopback, and `metistry connect devin`
still mints one for a URL that is `127.0.0.1`
(`docs/ops/devin.md:66-68`).

### 1.8 Failure modes, in their own words

There are effectively no external bug reports to mine — 3 issues ever, 0 open.
So the honest source is their own recovery documentation, which is unusually
candid. `docs/concepts/runtime-and-results.md` lists what recovery does **not**
promise: deterministic model output; exactly-once external effects; replay of
provider-native shell or network activity; reconstruction of changed loose file
bytes; distributed failover; success without an accepted terminal Checkpoint.
`docs/guides/recover-interrupted-agents.md` adds: *"A command may have written
files before it was interrupted. Inspect the current files and relevant
application state before repeating work that could have effects twice."* And
`runtime-and-results.md` on command ownership: *"A Command Run whose process
ownership cannot be proved is terminalized honestly rather than launched again
blindly."*

The named failure surface, then, is: **side effects outside the database**.
Everything inside it is transactional; everything the provider did to the
filesystem, the network or another service is not, and OMS declines to pretend
otherwise. That is exactly our invariant 1 restated from the other side.

Two structural fragilities I would flag if this were our code, neither reported
by anyone:

- **The watchdog's currentness predicate is eight `EXISTS` subqueries deep.**
  Any schema evolution that adds a dimension to a dispatch's identity must be
  added there or recovery silently stops firing (it fails *closed*, which is the
  safe direction, but invisibly).
- **Conflict avoidance is prompt-only** (§1.6) and the default wave is up to 8
  parallel agents on one working tree. The first serious multi-agent code change
  in a shared repo is where that bill arrives.

---

## 2. What Metistry has today

### 2.1 The work queue

`work` (`db/migrations/0001_init.sql:65`) gained the coordination columns in
`0002_review_decisions.sql:37-40`:

```sql
ALTER TABLE work ADD COLUMN claimed_by       text;
ALTER TABLE work ADD COLUMN lease_expires_at timestamptz;
ALTER TABLE work ADD COLUMN depends_on       bigint[] NOT NULL DEFAULT '{}';
CREATE INDEX work_ready_idx ON work (status, lease_expires_at);
```

`packages/tasks/src/index.ts` is the service, and its three SQL fragments are
the whole policy:

- `DEPS_CLOSED` (`:152-155`) — *"Every id in depends_on is closed. A dangling id
  (deleted row) blocks rather than silently unblocks — a typo must not release
  work."*
- `UNCLAIMED` (`:157`) — `claimed_by IS NULL OR lease_expires_at < now()`
- `CLAIMABLE` (`:164`) — kind ∈ `{task, review}` only; collected issues/PRs/events
  are visible and never handed to an agent.

`listReady` (`:297`), `claim` (`:317`), `heartbeat` (`:361`), `release` (`:478`)
are each one atomic `UPDATE` whose `WHERE` carries the gate; the loser of a race
sees zero rows and gets a reason from a *diagnostic* read that is explicitly
*"never a decision input"* (`:336`). Default lease 900 s (`:224`). Heartbeat is
holder-only and refuses to renew an expired lease — `lease_expired` is its own
failure reason (`:126`). Every mutation is a two-phase `runs` row
(`:229-240`, using `startRun`/`finishRun` from `packages/core/src/runs.ts:39,48`).

`status` is `open | in_progress | blocked | closed`. **`blocked` is the state
nothing but a human leaves**: the unblock is `update({status: 'open'})`, legal
from `blocked` only, on the *board arm* which requires no claim
(`:84-95`, `:456-459`).

`work.meta.blocked_by` is the newest addition and its rule is strict:
`"vault:Journal/2026-09-18.md#^mt-7x2k"` names a **human todo**, the reconciler
turns it into a `vault_task_refs` row (`apps/reconciler/src/indexer.ts:457-459`),
`day_work.yaml:104-113` resolves it into `blocked_by_path`, `blocked_by_task`
and `blocked_by_task_open`, and — stated four times in four files — **it
surfaces and never gates**: *"`depends_on`, `DEPS_CLOSED` and claimability are
untouched, so a typo in a note can never stall an agent"*
(`docs/ops/reconciler.md:51`, `docs/product/daily-flow-spec.md:420`).

### 2.2 Crews

A crew is `.metistry/agents/<area>/<name>.md` — frontmatter validated by core's
manifest schema, body is the operating prompt (`docs/ops/crews.md`). The
manifest fields that matter here: `model` + `effort` (the tier), `uses` (tool
**groups**, never single tools), `scope` (vault read tier), `projects`,
`manages`, `max_turns`, `budget_usd_per_run`, and optional `autonomy`.

`CREW_TOOL_GROUPS` is seven groups in `packages/core/src/manifest.ts:183-211`;
`CREW_NEVER_TOOLS` is `["knowledge_write", "agents_delegate", "queries_list",
"queries_run", "request_access"]` at `:231`. **A crew never dispatches a crew**
— the tree is one level deep by construction, where OMS admits **256 Members
and 12 levels** (`workflows/ingest.py:24-25`). Since 2026-09-20 `uses` is
enforced *at the door*: the console resolves it from the
loaded manifest, attaches it to the principal at authentication, and `/mcp`
refuses every call outside it before the tool body runs; the runner's
client-side `allowedTools` is *"defence in depth, not the control"*
(`docs/ops/crews.md`).

Dispatch: `agents_delegate {crew, brief, task_id?}` → `checkBrief` against the
crew's `scope` ∩ the `local-crew` target's `allow` → a `work` row with
`kind: task`, `owner: crew:<name>`, `project: NULL` (invisible to every agent's
`tasks_*` view) and a *snapshot* of the manifest in `meta`. The drain loop
(`apps/assistant/src/crew-drain.ts`) claims the oldest runnable row, mints a
per-run token, runs one query with `maxTurns` and `maxBudgetUsd`, and burns the
token in `finally`.

The outcome table is already close to OMS's:

| what happened | `runs` row | `work` row |
| --- | --- | --- |
| finished | `ok = true`, `meta.outcome = ok` | `closed` |
| past budget / max_turns | `ok = false` | **`blocked` — final; retrying would spend again for the same brief** |
| the SDK itself failed | `ok = false` | claim kept, lease = `METISTRY_CREW_RETRY_S`, re-picked on lapse up to `METISTRY_CREW_MAX_ATTEMPTS` (3), then `blocked` |
| the row cannot be honoured | none | `blocked` with the reason in history; no token minted |

That distinction — *semantic* failure is terminal, *infrastructure* failure
retries — is the same one OMS draws between a `retry` Checkpoint (budgeted,
semantic) and a watchdog replacement (capped, infrastructural). Two systems,
the same distinction, arrived at separately.

### 2.3 Targets and dispatch

A target is `targets/<name>/manifest.yaml` (invariant 5), and
`apps/console/src/dispatch.ts` is *"the only path a brief takes off the
machine"* (`docs/ops/targets.md:5-10`). `checkBrief()` (`dispatch.ts:79`)
returns **every** violation: `brief_too_large`, `denied_source`,
`path_outside_allow`. A refusal is a `runs` row with `meta.violations`; no work
row is written.

Three shipped targets: `github-issues` (transport `github`, status-only return
via the `github-state` collector), `local-crew` (transport `local`, the crew
queue), `devin-sessions` (transport `http`, `submit.kind: devin-session`,
`dispatch.ts:139`). Devin's return path is a **poll, because there is no
webhook** — `collectors/devin-sessions` every 5 minutes — and its verdict table
is the most complete "is it blocked" mapping we own
(`docs/ops/devin.md`, "The return path"):

| session status | verdict | work row |
| --- | --- | --- |
| `exit` **with** `structured_output` | answered | **closed** |
| `exit` without it | failed | **blocked** |
| `error`, `suspended` (incl. `out_of_credits`, `inactivity`) | failed | **blocked** |
| `running` + **`waiting_for_user` / `waiting_for_approval`** | failed | **blocked** — *"this return path does not answer sessions"* |
| `new`, `claimed`, `running`, `resuming` | pending | unchanged; `meta.devin` records status and ACUs |
| any of the above past `METISTRY_DEVIN_SESSION_TIMEOUT_HOURS` | failed | **blocked** |

The last two rows are already OMS's watchdog, in a collector: a deadline, and a
stall that resolves to a visible terminal state rather than an invisible hang.

### 2.4 The owner's three classes, precisely

| | **connected** | **local crew** | **remotely controlled** |
| --- | --- | --- | --- |
| examples | Cursor, Devin surface 1, Claude Code, OpenCode — `metistry connect <tool>` (`docs/ops/cli.md:15`) | `.metistry/agents/**.md` via `agents_delegate` | Devin sessions via `targets/devin-sessions` (W6) |
| registry | `agents.kind = 'external'` | `agents.kind = 'crew'` | no agent row — the *target* has a manifest |
| who starts it | **the user, in the other tool** | our drain loop | our console, over HTTP |
| credential | a long-lived bearer, minted once, rotatable | **minted per run, burned in `finally`** | our outbound `cog_` key |
| how work arrives | **it claims** from `tasks_list` / `tasks_claim` | pushed by name into its own queue row | pushed by us as a session |
| can we stop it | no | yes (turn cap, budget cap, kill the container) | cancel via Devin's API only |
| can we see progress | only `runs` rows from its own tool calls | `runs` rows + turn count + cost | a 5-minute poll of one status field |
| deadline today | **none** | lease + `max_turns` + `budget_usd_per_run` | `METISTRY_DEVIN_SESSION_TIMEOUT_HOURS` |
| "complete" means | it closed the row it claimed | the drain loop closed the row | `exit` **with** valid structured output |

The rule that separates them is one sentence, and it is the reason OMS's model
cannot cross: **a non-Claude agent claims unassigned work and is never pushed to
by name.** It is enforced twice by construction
(`docs/ops/devin.md:320-335`): `POST /api/tasks/:id/dispatch` is the
`user` principal only (an owner token and an agent token both get `403`), and
`agents_delegate` dispatches `transport: local` and nothing else — *"There is no
tool for a Claude turn to push to Devin with."* Rooms carry the same property as
an absence: *"A room cannot address anyone. There is no `to_agent`, no `@name`,
no addressee column"* (`docs/ops/threads.md:12-14`).

OMS's coordination model is push-by-name from the first line. **It maps onto
column 2 and partially onto column 3; it cannot map onto column 1 at all.**

### 2.5 The blocked vocabulary we already have

Four distinct things currently share one word:

1. `depends_on` + `DEPS_CLOSED` — a hard gate; the row is not `listReady` and
   `claim` refuses with `dependencies_open` (`packages/tasks/src/index.ts:152`,
   `:348`).
2. `status = 'blocked'` — set by a holder who is stuck, or by the crew drain on
   budget exhaustion; **only a human leaves it** (the board-arm unblock).
3. `meta.blocked_by` — a human todo in the vault; surfaces, never gates (§2.1).
4. A *pending proposal* — the agent asked (`requests_create`,
   `request_access`, `propose_action` at `propose`) and is not waiting: the run
   already ended.

OMS's `attempt_waits` would call (1) a delegation wave, (2) infrastructure
exhaustion, (3) and (4) human requests. We have no column that says which.

### 2.6 Liveness today: nine probes, none about work

`apps/watchdog/src/probes.ts` — model-free by construction, direct database
access as the *named invariant-3 exception*:

| probe | what it catches |
| --- | --- |
| `db`, `console` | the obvious |
| `assistant-drain` (`:107`) | inbound messages stuck `new`/`processing` past a threshold |
| `runs-inflight` (`:134`) | two-phase `runs` rows with `finished_at IS NULL` older than N minutes — *"the exact runaway two-phase rows exist to catch"* |
| `hourly-cost` | spend runaway |
| `push-reachability` | nowhere to send an alert |
| `silent-collector` (`:164`) | a scheduled collector/routine with no `runs` row inside `factor × interval` |
| `bridge-degraded`, `fm-tier-never-fires` | bridge health, and a bridge that is healthy but never reached |

`runs-inflight` is the closest thing we have to an inactivity watchdog, and it
is about *calls*, not *work*. **Nothing probes `work`.** A claimed row whose
lease lapsed, a `blocked` row nobody has looked at for a week, a crew row that
has been `in_progress` for six hours — all are invisible to the watchdog today.

`seed/queries/agent_presence.yaml` already computes half the answer per agent:
`current_claims`, `interrupted_claims` (`:16`, expired lease still holding
`claimed_by`), `blocked_bundles`, `spend_today_usd`, and a `state` of
`working | queued | interrupted | over-cap | idle` (`:43`). It is per-agent and
capped at 100 rows; it is not a per-work-row stall list and does not know about
`blocked_by`, dependency age, or pending proposals.

### 2.7 Asking, answering, and autonomy

The Needs You queue is `proposals`; `decision` is
`pending | allow | deny | accept_with_changes | expired`
(`db/migrations/0002_review_decisions.sql:28`), and the answer verbs are six:
`allow`, `accept_with_changes`, `accept_as_work`, `deny`, plus the two that are
*not answers* — `later` (a snooze, `SNOOZE_HOURS` default 3) and `skip` (stores
a `deny` whose feedback is exactly `SKIP_FEEDBACK`, firing none of `deny`'s
per-kind consequences) — `apps/console/src/server.ts:225-240`. Batch answers are
`later | skip | deny` only (`:240`).

`request_access {area, reason}` (2026-09-19) writes one `proposals` row of kind
`access_request` and **grants nothing**; it is named in the `scope_required`
refusal that turned the agent away (`packages/core/src/access.ts:575-579`). It
is a `CREW_NEVER_TOOL` — a crew's scope is its manifest file, in the owner's
hand.

Autonomy is `observe | propose | act_within_scope`
(`packages/core/src/actions.ts:42`) as a **ceiling**, with a per-kind table over
four action kinds; the effective mode is the lower of the two, and `dispatch`
stays `propose` even at the top level (`:160`). `effectiveActionsDetailed`
(C46/C47, PR #259) answers *why* each cell is what it is — `set`, `defaulted`,
or `clamped` — so the CLI, `GET /api/agents` and MetistryKit read one function
instead of three copies (`packages/core/src/access.ts:1073`, `:1142`).

Two design rulings bear directly on the owner's question, and both are currently
about the *connector* path rather than the *agent team* path:

- **C45 — a failed action leaves the request pending.** *"If the upstream
  throws… one action is one service call, so nothing is half-applied"* — the
  console's action executor writes `payload.error` and leaves the row `pending`
  (`docs/ops/actions.md`, "Execution is the human route's own call"). A refusal
  must not be drawn as a decision.
- **C59 — Ask defers and reports when unattended.** The run *"finishes without
  it and says so"* — **and the request still lands in Needs You**
  (`docs/research/2026-09-22-connectors-mcp-gateway.md:1463`).

C59 is the same shape as OMS's `default_behavior` + `due_at`, arrived at from
the opposite direction: OMS lets the *agent* declare the fallback and gives the
*request* a deadline; C59 makes the fallback a property of the *run's
attendedness* and gives the request no deadline at all. **Both halves are
needed** (§4.1).

### 2.8 Rooms, as the message channel

A room is a comment thread on a `work` row (`docs/ops/threads.md`), and its
governing property is an absence: *"A room cannot address anyone… Posting a
message wakes nobody: agents are pull-based, and they read a room when they
claim its row."* One room per work row is a unique index
(`artifact_comments_work_root_uidx`). Ten consecutive agent messages and the
eleventh is not stored — the room demotes to a `proposals` row carrying the
transcript (`pingPongDemotes()`), and a human message resets the run. Resolve is
the user's hand only; nothing resolves on a timer, deliberately.

The crew runner appends the room to the brief as a **prior-work block**
(`briefThreadBlock()`, `METISTRY_BRIEF_THREAD_BYTES` default 4096). That is
strictly more than OMS has: their children cannot see each other's work at all
except through file references a parent chose to forward.

---

## 3. Lessons

Applicability: **C** = connected, **L** = local crew, **R** = remotely
controlled. "Conflicts" names the invariant or ruling that constrains the
adoption, not necessarily one that forbids it.

| # | Mechanism (source) | C | L | R | Maps onto | Conflicts | Cost |
| --- | --- | :-: | :-: | :-: | --- | --- | --- |
| 1 | **Green gated on every child's accepted green** (`checkpoint/persistence.py:68`, `:269-302`) | — | ✅ | ~ | An **acceptance gate** on a `work` row: `meta.acceptance` checked inside the same statement that sets `status='closed'` | None — it *is* "enforce at the tool". A crew tree is one level, so today's version is "every `depends_on` closed", which `DEPS_CLOSED` already computes | **M** (1.5–2 d) |
| 2 | **Terminal outcome trichotomy** `green`/`blocked`/`retry` (`contracts/primitives.py:22-25`) | ~ | ✅ | ✅ | We have it split across `work.status` + the crew outcome table (§2.2). Name it once in `history` as `outcome` | None | **S** (0.5 d) |
| 3 | **Exactly one typed wait per unit of work** (`waiting.py:34-54`) | ✅ | ✅ | ✅ | `work.meta.blocked_reason` as a closed enum `{deps, human, budget, infra, external}` + a CHECK-equivalent validator in `packages/tasks` | None. Must **surface, never gate** like `blocked_by` — naming a reason must never become a new way to stall | **S** (1 d) |
| 4 | **Inactivity deadline anchored to last tool call, not last heartbeat** (`watchdog/deadline.py:100-112`) | ~ | ✅ | ✅ | A `work_stalls` named query joining `work.lease_expires_at` to `max(runs.ts) WHERE component = claimed_by`; later, a watchdog probe | Invariant 3 — reads go through a named query, not new SQL in a component. The watchdog is the one exception and may use it | **M** (1–1.5 d) |
| 5 | **Replacement cap → pause, not loop** (`recovery.py:90-102`, limit 2) | — | ✅ | — | We have it: `METISTRY_CREW_MAX_ATTEMPTS` (3) then `blocked` | None — already shipped | — |
| 6 | **Never reap something legitimately waiting on a human** (`predicates.py:89-92`) | ✅ | ✅ | ✅ | The `work_stalls` query must exclude rows whose pending proposal is unanswered — and count *that* as its own, louder, stall class | None | included in 4 |
| 7 | **A human request carries a deadline** (`human_requests.py:103-126`; expiry → `TIMED_OUT`, `deadline.py:94-109`) | ✅ | ✅ | ✅ | `proposals.due_at` + an `expired` decision that already exists in the enum (`0002:28`) but nothing writes | **Invariant 2**: expiry must never *act*. It may only mark the row and tell the asker. C59 says the run reports and the request still lands | **M** (1–1.5 d) |
| 8 | **The agent declares a fallback when it asks** (`default_behavior`) | ✅ | ✅ | ✅ | A `reason`-adjacent free-text field on `requests_create`. **Prompt-grade only** — see §1.4 | Directly tests "enforce at the tool": do not let it read as enforcement | **S**, and low value alone |
| 9 | **Commit intent, then start the effect** (wave + parent wait commit atomically; provider starts after) | — | ✅ | ✅ | Already ours: `agents_delegate` writes the `work` row before anything runs; `dispatch()` writes the `runs` row and `external_ref` | None — converged | — |
| 10 | **Per-dispatch bearer with an exposure ceiling, revoked on close** (`bindings.py:52-113`) | — | ✅ | — | Already ours: mint-per-run, burn in `finally` (`crew-drain.ts:7-12`), `uses` enforced at `/mcp` | None — converged, and we go further (the console authenticates too) | — |
| 11 | **Capabilities deny by default and never inherit** (`capabilities.py:52-57`) | ✅ | ✅ | ✅ | Already ours: `uses`, `scope`, `projects`, `autonomy` absent = `observe` = nothing | None — converged | — |
| 12 | **Budgets snapshotted onto the unit at creation** (`budget.py:14-26`) | — | ✅ | ✅ | Already ours: the manifest **snapshot** in `work.meta` (`docs/ops/crews.md` step 3), and Devin's `max_acu` written to the dispatch `runs` row | None — converged | — |
| 13 | **Advisory work plan: ≤9 steps, exactly one `in_progress`** | ~ | ✅ | ~ | `work.meta.plan`, or rooms. Explicitly *not* scheduling authority | Would be new surface on `tasks_*`; rooms may already be enough | **M**, low value |
| 14 | **Steering: bounded new context to one exact active member** | — | ~ | — | A room message is read at claim time; steering mid-run is not possible because a crew run is one query | Conflicts with the fresh-session-per-crew-run ruling | **reject** |
| 15 | **Replan closes the turn and reopens a continuation** | — | ~ | — | Our equivalent is a new brief and a new row; an immutable brief is already our rule | None, but no need | — |
| 16 | **"Review-driven repair is not retry — it is fresh work with the findings in a new Assignment"** | ✅ | ✅ | ✅ | One sentence in `docs/ops/crews.md`; it is already how review bundles behave | None | **free** |
| 17 | **Result = the lead's accepted terminal checkpoint, never a paraphrase** | ~ | ✅ | ✅ | Already ours, harder: a crew's final text is **discarded**; only what it *reported* survives (`docs/ops/crews.md`) | None — converged | — |
| 18 | **Startup reconciliation from committed state** | — | ✅ | ✅ | Already ours by lease lapse; the Devin poll is the R-column version | None — converged | — |
| 19 | **File references validated at the boundary** (no `..`, no symlink component, must exist) | ✅ | ✅ | ✅ | Our `checkBrief` path rules + `artifacts` versions are stronger | None — converged | — |
| 20 | **Per-subagent worktree isolation** — Claude Code `isolation: worktree`; *this repo's own practice* | — | ✅ | — | A crew that could write would need one. **Crews cannot write today** (`knowledge_write` is a never-tool), so the need is hypothetical until a writing crew exists | Would be new machinery; do not build ahead of it | **defer** |
| 21 | **Conflict avoidance delegated to a model in prose** (OMS's `workspace-and-files.md`) | — | — | — | Nothing | **Directly contradicts** "enforce at the tool, never by prompting" | **reject, in writing** |
| 22 | **Unauthenticated loopback control API** (`local_admission.py:26-80`) | — | — | — | Nothing | **Invariant 8** | **reject, in writing** |
| 23 | **Push work to a named recipient** (assignments bound to `member_id` at creation) | ❌ | ✅ | ✅ | Already how crews and targets work; already forbidden for external agents | **The collaboration rule.** There is no tool to violate it with, and there must not be | **reject for C** |
| 24 | **Max 20 concurrent subagents, excess *fails immediately*, no queue** (Claude Code docs, 2026-09-22) | — | ✅ | — | A per-target concurrency cap in the target manifest, enforced in the drain loop. **Our queue is durable, so ours should park, not fail** | None — it is a manifest field | **S** (0.5 d) |
| 25 | **Spawn depth limit (3) enforced by withholding the `Agent` tool** (Claude Code) | — | ✅ | — | Already ours and stricter: `agents_delegate` is a `CREW_NEVER_TOOL`, so depth is 1 | None — converged | — |
| 26 | **Sibling roster + `SendMessage`** (Claude Code) | — | ~ | — | Rooms, minus addressing. Keep the absence | Conflicts with the room rule *"a channel is safe exactly when it cannot address"* | **reject** |
| 27 | **Handoff as a tool call; receiver inherits full history unless filtered** (OpenAI Agents SDK, 2026-09-22) | — | ~ | — | Our brief *is* the filter, and it is a reviewable artifact. No durable state, retry or timeout is documented on their side | None; we are ahead | — |
| 28 | **Supervisor-as-a-model, in-process** (CrewAI / AutoGen / LangGraph) | — | — | — | Nothing. Every one of them loses the run when the process dies | Invariant 1 (git is the record) and the durable-queue design | — |
| 29 | **"Don't use multi-agent when agents share context or have many dependencies"** (Anthropic, multi-agent research system) | ✅ | ✅ | ✅ | A sizing rule for `manages:` and for how many crews a brief fans out to. Their figure: **~15× the tokens of a chat** | None; it argues *against* growing crew trees | **free** |
| 30 | **"Without detailed descriptions, agents duplicate work or misinterpret tasks"** (same) | ✅ | ✅ | ✅ | Exactly *"the brief is the context transfer"*; and `reports: 0` on a run row is the measurable symptom we already record | None — converged | — |
| 31 | **Durable execution: persist intent before effect; resume from committed state** (Temporal-shaped; OMS hand-rolls it) | — | ✅ | ✅ | Already ours in the crew queue and the dispatch path. A workflow engine would be a dependency we do not need | Ask-before-adding-a-dependency; hand-rolled is the shipped answer | **reject the engine, keep the discipline** |

---

## 4. The three owner goals, concretely

### 4.1 Not blocked

**What a stall actually is, in six shapes.** Today only the first is detectable
and only per-agent.

| shape | detectable today | signal |
| --- | --- | --- |
| lease lapsed, claim still held | ✅ `agent_presence.yaml:16` (`interrupted_claims`) | `claimed_by IS NOT NULL AND lease_expires_at <= now()` |
| claimed, lease live, **no tool call in N minutes** | ❌ | `max(runs.ts) WHERE component = w.claimed_by` |
| `status='blocked'` and nobody has looked | ❌ | `updated_at` age on a blocked row |
| waiting on a pending proposal nobody answered | ❌ | `proposals.decision='pending'` joined on `work_id` |
| waiting on a human todo (`meta.blocked_by`) still open | partly — `day_work.yaml` shows it for *today* | `blocked_by_task_open` |
| a dependency that will never close | ❌ | `depends_on` element whose own row is stalled |

**The named query.** Invariant 3 says a new read is a named query, not new SQL
in a component — so this is `seed/queries/work_stalls.yaml`, `expose: route`
(every row carries a title, which is the owner's prose; `knowledge_pages.yaml`
and `day_work.yaml` set the precedent — `agent_presence.yaml` does not, and that
inconsistency is worth a one-line ruling). Sketch, against the real schema:

```sql
WITH last_activity AS (
  SELECT component, max(ts) AS at FROM runs GROUP BY component
)
SELECT w.id, w.title, w.project, w.status, w.claimed_by, w.owner,
       w.lease_expires_at, la.at AS last_agent_run_at,
       CASE
         WHEN w.status = 'blocked' AND p.n > 0                       THEN 'waiting_on_you'
         WHEN w.status = 'blocked'                                   THEN 'blocked_unattended'
         WHEN w.claimed_by IS NOT NULL
              AND w.lease_expires_at <= now()                        THEN 'lease_lapsed'
         WHEN w.claimed_by IS NOT NULL
              AND la.at < now() - make_interval(mins => :quiet_min)  THEN 'claimed_but_quiet'
         WHEN w.status = 'open' AND NOT (:deps_closed)               THEN 'waiting_on_deps'
       END AS stall_kind,
       greatest(now() - w.updated_at, now() - coalesce(la.at, w.updated_at)) AS stalled_for
FROM work w
LEFT JOIN last_activity la ON la.component = w.claimed_by
LEFT JOIN LATERAL (SELECT count(*) AS n FROM proposals p
                   WHERE p.work_id = w.id AND p.decision = 'pending'
                     AND (p.snoozed_until IS NULL OR p.snoozed_until <= now())) p ON true
WHERE w.status <> 'closed'
ORDER BY stalled_for DESC
```

Two rules the query must obey, both borrowed from OMS's predicates:

- **A row with an unanswered pending proposal is `waiting_on_you`, not
  `stalled`** — `dispatch_has_no_external_source` (`predicates.py:89-92`). It is
  louder, and it is aimed at the owner rather than at the agent.
- **A snoozed proposal does not count** — `later` is an answer of a kind, and
  the queue already excludes snoozed rows from the pending list
  (`apps/console/src/server.ts:983`).

**The probe and the doctor row.** One probe in `apps/watchdog/src/probes.ts`,
`work-stalls`, in the shape every other probe uses: `failed` with a remediation
naming *what* is wrong and never a changing number (counts ride in `meta`,
`probes.ts:7-9`). It is the invariant-3 exception the watchdog already holds. A
doctor row and an Agents-panel row read the same named query, so the three
cannot disagree — the `effectiveActionsDetailed` lesson from PR #259 applied to
liveness.

**Unblock policies, ranked by how little they assume.**

1. **Auto-reassign after lease expiry — already built and already correct.**
   `UNCLAIMED` is `claimed_by IS NULL OR lease_expires_at < now()`
   (`packages/tasks/src/index.ts:157`), so an expired lease makes a row
   claimable again with no sweeper at all. The holder keeps its authority until
   someone else claims, *"so late work can still land"* (`:388`). Nothing to
   add; something to **document**, because it is currently only discoverable
   from the SQL.
2. **Escalate to Needs You with the reason.** One `proposals` row per stalled
   row per 24 h (the `autonomy_widened` alert's cadence is the precedent), kind
   `report`, carrying `stall_kind` and `stalled_for`. Cheap, and it is the only
   remedy that works for a **connected** agent — which we cannot drive, only
   notice.
3. **Skip-and-report, per C59.** A routine that finds a `claimed_but_quiet` row
   should *report*, not release: releasing a row an agent is slowly working is
   how you get two agents on one task. C59's own phrasing — the run *"finishes
   without it and says so"*, and the request still lands — is the right shape.
4. **Split a blocked task.** Reject for now. It requires a model to decide what
   the halves are, on a row a human already marked blocked, and `blocked` is the
   one state *"nothing but a human leaves"* (`docs/ops/board.md` via
   `packages/tasks/src/index.ts:84-95`). If it ever ships it is an `action`
   kind, proposed, never auto.

**Give the ask a deadline.** `proposals.due_at`, defaulting to null (nothing
changes for existing rows), plus a routine that flips a lapsed pending row to
the **already-existing** `expired` decision and writes one report. Constraints
from our side, not OMS's: expiry **must not act** — invariant 2 makes anything
that defines behaviour a human change — and the asker must be told, which for a
crew means the next brief and for a connected agent means the `runs` row it can
read back.

### 4.2 Complete assigned tasks

**What "complete" means today, per class:** for a **local crew**, the drain loop
closed the row (`meta.outcome = ok`) and the run produced `reports: N`; for a
**remotely controlled** Devin session, `exit` **with** valid structured output
against a Draft-7 schema — the one place we already have a *machine-checkable*
definition of done; for a **connected** agent, it called `tasks_update {status:
'closed'}` and nothing checked anything. Column 1 is the weak one, and it is
weak for a reason we should not try to engineer around: **we cannot drive a
connected agent**, so "complete" for it can only ever mean "it asserted
complete, and here is the audit trail".

**The acceptance gate (lesson 1), stated for us.** An optional
`meta.acceptance` on a `work` row — a small list of checks the closer must
satisfy — enforced **inside the same atomic `UPDATE` that sets
`status='closed'`**, exactly where `DEPS_CLOSED` already lives. Three kinds,
in increasing cost:

- **`deps`** — every `depends_on` closed. This is `DEPS_CLOSED` and it is
  already computed; today it gates *claim*, not *close*. Gating close as well is
  a one-line change to one `WHERE` clause and is the direct analogue of OMS's
  child-participation rule.
- **`reports`** — the closing run produced at least one `requests_create`. We
  already record `reports: 0` on the run row and already observe that *"the
  brief probably did not say what to report"* (`docs/ops/crews.md`). Promoting
  that observation to a precondition is small.
- **`verified_by`** — a second `work` row of `kind: review`, closed green,
  naming this one. The review-bundle machinery exists (`§4.21`, `work.meta.bundle`,
  the over-cap queue); this is a use of it, not new machinery.

The refusal must read like every other refusal in `packages/tasks` — a
`ClaimFailure`-shaped reason (`acceptance_unmet`) with the unmet checks named,
because OMS's own message (*"missing: <ids>"*) is what makes the gate usable
rather than mysterious.

**A verification step run by a second crew.** Possible today with no new
machinery: the brief names the artifact, the reviewing crew has `artifacts` in
`uses`, and the bundle lands. What is missing is only the *link* — the reviewed
row does not know it is waiting on the review. `depends_on` is that link and is
already an array of work ids. So: dispatch the review as a `work` row, add its
id to the reviewed row's `depends_on`, and `DEPS_CLOSED` does the rest.

**A deterministic check** is the better half of the same idea and needs an
`action` kind we do not have (`command_run`, in OMS's vocabulary). That is a new
door on the console's closed enum — invariant 10 territory, the owner's ruling,
and deliberately out of scope here. Note only that `github-issues` +
`github-state` already gives a crude version: a dispatched issue closes when CI
and a human say so.

**Retry budget and re-dispatch.** Already right (§2.2), and the OMS comparison
confirms the shape. One addition worth its cost: record the attempt count where
a human can see it. `work.meta.attempts` is written today and surfaced only by
the hand-written SQL in `docs/ops/crews.md`; it belongs in `work_stalls`.

### 4.3 Functional teams

**Parallelism limits per target.** A `max_concurrent` field on the target
manifest, defaulted per target, enforced in the drain loop's claim step. Claude
Code caps at 20 and *fails the spawn*; our queue is durable, so the right
behaviour is to **leave the row open and claim it next tick** — which the loop
already does for free if it simply counts live claims before claiming. This is
the cheapest item in §4.3 and the one that most directly prevents a runaway
fan-out from eating the hourly cost line the watchdog already guards.

**File and worktree conflict avoidance.** Reject OMS's answer outright (§3
row 21). The honest statement of our position: **crews cannot write to the
vault at all** (`knowledge_write` is a `CREW_NEVER_TOOL`, `manifest.ts:231`)
and cannot reach a shell or a filesystem, so there is no conflict to avoid
today. The day a writing crew is proposed, the design begins at per-agent
isolation — this repo's own practice for Claude sessions, and a first-class
Claude Code subagent field (`isolation: worktree`) — and not at a paragraph
asking a model to sequence its writes. Write that down now, while it is free.

**Message passing.** Rooms are the channel and the absence of addressing is the
feature (§2.8). OMS has nothing here and Claude Code's `SendMessage` is the
thing we deliberately do not want. The one improvement worth considering is not
a new channel but a better *read*: the prior-work block is capped at 4096 bytes
by default and takes the tail. For a long room, the tail is the least useful
part. A "first message + last N" shape would cost a few lines in
`briefThreadBlock()` — flagged, not recommended, because nobody has reported the
symptom.

**Role sizing.** Anthropic's own number is the argument against enthusiasm:
multi-agent systems use **~15× the tokens of a chat**, and the pattern
underperforms *"for domains requiring all agents to share the same context or
involve many dependencies between agents"*. Our crews are single-level, one
query each, cheap-model-by-default extraction workers — which is the shape that
survives that finding. `manages:` exists in the manifest and is currently the
only place a hierarchy could grow. **Leave it flat.**

---

## 5. What OMS gets right that we should say out loud

Three sentences worth borrowing into our own docs verbatim, each of which we
half-believe already and nowhere write down:

1. *"Provider terminal success does not complete any of these records. Only an
   accepted controller operation can record progress, open a wait, delegate
   work, or finish an execution."*
2. *"Ordinary review-driven repair is not retry. It is fresh work with the
   concrete findings in a new Assignment."*
3. *"Exhaustion or infrastructure failure remains visible controller state; it
   is never rewritten into successful work."*

---

## 6. Recommendation

### 6.1 The decision table

| | Decision | Why | Effort |
| --- | --- | --- | --- |
| **`work_stalls` named query + a `work-stalls` watchdog probe + a doctor row** | **Yes — first** | It is the owner's first goal, it is one YAML file and one probe in the shape the other nine already use, and `agent_presence.yaml` proves the SQL. Nothing today notices a stalled `work` row | ~1.5 d |
| **A closed `meta.blocked_reason` enum, surfaced by `work_stalls`** | **Yes** | Four different things share the word `blocked` (§2.5). OMS's CHECK-constrained single typed wait is the cheapest idea in their codebase. Must **surface, never gate**, exactly like `blocked_by` | ~1 d |
| **Document that lease expiry *is* the auto-reassign** | **Yes** | It is built, correct, and discoverable only from `UNCLAIMED` in the SQL. One paragraph in `docs/ops/crews.md` and `docs/ops/board.md` | free |
| **Write down the two refusals** (model-decided conflict avoidance; push-by-name to an external agent) | **Yes** | Both are the obvious next proposal from anyone who reads OMS, and both are already decided by existing rules. Free now, expensive to re-litigate | one paragraph each |
| **`proposals.due_at` + expiry to the existing `expired` decision + one report** | **Yes, after the stall query** | The one class of block nothing can currently notice. The enum value already exists; expiry marks and reports, never acts (invariant 2 / C59) | ~1.5 d |
| **`max_concurrent` on a target manifest, enforced at claim** | **Yes** | One manifest field, one count in the drain loop; caps a fan-out before it reaches the hourly-cost probe. Our queue parks rather than fails, which is better than Claude Code's answer | ~0.5 d |
| **`meta.acceptance` gate inside the close statement** | **PoC, `deps` arm first** | §3 row 1, and the strongest answer to goal (b). Start with the arm that needs no new data: every `depends_on` closed gates *close* as well as *claim* | ~1.5 d, then measure |
| **Activity-anchored staleness (`claimed_but_quiet`)** | **PoC inside the stall query, before any enforcement** | OMS's best idea, but a lease renewed by a *heartbeat* and a lease renewed by *progress* are different contracts, and ours is the former. Observe the class for a fortnight before anything acts on it | included above |
| **Attempt count surfaced on the stall row** | **Yes, with the query** | `meta.attempts` is written and readable only from hand-written SQL today | trivial |
| **`work.meta.plan` / advisory work plans** | **No** | Rooms plus `history` already carry progress, and this adds tool surface against a ceiling we are actively defending | — |
| **Steering a running crew** | **No** | A crew run is one query with a fresh session by construction; there is no mid-run boundary to steer at | — |
| **Sibling addressing (`SendMessage`-shaped)** | **No, in writing** | *"A channel is safe exactly when it cannot address"* — the room design's own load-bearing absence | — |
| **Per-member worktrees** | **Defer, not reject** | Crews cannot write; the need is hypothetical. But record *now* that the answer, when needed, is isolation — not a prompt | — |
| **Model-decided conflict avoidance** (OMS's shipped answer) | **No, in writing** | Contradicts "enforce at the tool, never by prompting" as directly as anything in this document | — |
| **Push work to a named external agent** (OMS's whole coordination model) | **No, in writing** | The collaboration rule; enforced twice by the absence of a tool. This is the owner's own hypothesis, confirmed | — |
| **An unauthenticated loopback control API** | **No, in writing** | Invariant 8 | — |
| **A durable-execution dependency** (Temporal or similar) | **No** | The discipline is already ours — commit intent, then effect; resume from committed state. OMS hand-rolls it too, in 71k lines we do not need to import | — |
| **Vendoring or wrapping OMS** | **No** | Python, one author, 121 stars, and a coordination model that begins by naming the recipient | — |

### 6.2 Phasing

- **Now (~4 days, no new dependency, no new tool, no new action kind):** the
  stall query, the probe, the doctor row, `meta.blocked_reason`,
  `max_concurrent`, and the four paragraphs. Every one is a named query, a
  manifest field, a `meta` key or a document.
- **Then (~1.5 days):** `proposals.due_at` and expiry-to-report. Gated on Q3,
  because "how long is too long to wait for the owner" is not a number this
  document can pick.
- **Then, measured:** the `meta.acceptance` gate, `deps` arm first, adopted only
  if the stall query shows rows closing with open dependencies — if that number
  is zero, the gate is ceremony and should not ship.
- **Never, in writing:** push-by-name to an external agent; conflict avoidance
  by prompt; an unauthenticated control surface.

### 6.3 What needs the owner

- **Q1** below, which decides whether the first phase is three items or five.
- **Q3**, the deadline numbers. Both the stall threshold and the proposal
  deadline are opinions about a working day, in the same way `SNOOZE_HOURS` is
  (`apps/console/src/server.ts:242`).
- A ruling on `expose:` for work-carrying queries — `day_work.yaml` and
  `knowledge_pages.yaml` say `route`, `agent_presence.yaml` says nothing and
  therefore `generic`, and both carry `work.title`. Reported, not fixed:
  changing a shipped query's exposure is a policy change.

---

## 7. Open questions (the owner's)

1. **Should a stall ever *act*, or only ever *report*?** §4.1 recommends report-
   only for everything except lease expiry (which is already an automatic
   re-claim and has been since `0002`). The alternative — a routine that
   releases a quiet claim — is one line and is how most queues work, and it is
   also how you get two agents on one task. **The first phase is three items if
   the answer is "report only" and five if any auto-release is admitted.**
2. **Is `meta.acceptance` the right home for a definition of done, or should
   "done" stay entirely in the brief?** The gate is the strongest lesson in this
   document and it is also the first time a `work` row would carry a *contract*
   rather than a description. The cheaper alternative is to change nothing and
   rely on `depends_on` + review bundles, which already compose into the same
   thing without a new field.
3. **What are the two numbers?** How long may a claimed row make no tool call
   before it is a stall, and how long may a Needs You request sit before it
   expires. `METISTRY_CREW_LEASE_S` is 1800 and `SNOOZE_HOURS` is 3, so there
   are precedents in both directions; neither is an answer.
4. **Does an expired request tell the agent, and how?** For a crew the answer is
   easy (the next brief). For a **connected** agent there is no push channel by
   design — it would have to notice on its next `tasks_list`. That may be an
   argument for the expiry report being a `work` row rather than only a
   proposal.
5. **Do we want `manages:` at all?** It is in the crew manifest schema, nothing
   reads it as a hierarchy, `agents_delegate` is a `CREW_NEVER_TOOL`, and
   Anthropic's own finding argues against deep trees for exactly our workloads.
   Keeping an unimplemented hierarchy field is cheap; it is also the field
   someone will one day try to make real.
6. **Is a writing crew ever going to exist?** The whole worktree question is
   contingent on it. If the answer is a firm no, lesson 20 becomes an invariant
   and `knowledge_write` stays a never-tool forever, which simplifies several
   things. If it is "eventually", the isolation design wants a paragraph now
   rather than a scramble later.

---

## Sources

Read on 2026-09-22 unless noted; dates are the publishers'.

- [ringlochid/oh-my-subagents](https://github.com/ringlochid/oh-my-subagents) —
  cloned at `fcc4398` (2026-09-14, branch `main`) and read on disk. MIT
  (`LICENSE`, "Copyright (c) 2026 Yunan Zhang"); Python ≥ 3.12; created
  2026-07-20; **121 stars / 10 forks / 0 open issues / 1 contributor** (GitHub
  API, 2026-09-22); v0.3.2 on PyPI (2026-08-30); renamed from Banksia in August.
  Files cited in text: `pyproject.toml`, `config.py`,
  `runtime/contracts/{primitives,capabilities,human_requests}.py`,
  `runtime/{capabilities,steering}.py`,
  `runtime/watchdog/{deadline,predicates,recovery,context}.py`,
  `runtime/checkpoint/{persistence,semantic_retry}.py`,
  `runtime/delegation/settlement.py`,
  `runtime/human_request/{deadline,continuation}.py`,
  `runtime/node_operations/{catalog,state_legality}.py`,
  `runtime/node_mcp/bindings.py`, `runtime/team/participation.py`,
  `runtime/assignment/budget.py`, `runtime/workspace/coordination.py`,
  `persistence/models/runtime/{waiting,human_requests}.py`,
  `persistence/models/runtime/assignment/execution.py`,
  `interfaces/http/local_admission.py`,
  `interfaces/mcp/node/http_admission.py`,
  `docs/concepts/{runtime-and-results,workspace-and-files}.md`,
  `docs/guides/recover-interrupted-agents.md`, `docs/help/troubleshooting.md`,
  `docs-internal/architecture/workspace-files-and-prompt.md`,
  `docs-internal/adr/ADR-0013-banksia-target-and-clean-break.md`.
- [Claude Code docs, "Subagents"](https://code.claude.com/docs/en/sub-agents) —
  YAML frontmatter + markdown in `.claude/agents/`; `tools` /
  `disallowedTools` / `maxTurns` / `model` / `permissionMode` / `memory` /
  **`isolation: worktree`**; fresh isolated context per invocation; nesting to
  **3 layers** (`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`), enforced by withholding
  the `Agent` tool at the limit; **max 20 concurrent**
  (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`), *"spawning beyond 20 fails with
  Concurrent subagent limit reached"*, **no queue**; sibling roster +
  `SendMessage`.
- [Anthropic, "How we built our multi-agent research
  system"](https://www.anthropic.com/engineering/multi-agent-research-system) —
  orchestrator-worker; each subagent gets *"an objective, an output format,
  guidance on the tools and sources to use, and clear task boundaries"*;
  ~**15× the tokens of a chat**; named failure modes include duplicated work
  from vague task descriptions and agents continuing past sufficiency;
  *"multi-agent architecture underperforms for domains requiring all agents to
  share the same context or involve many dependencies between agents"*.
- [OpenAI Agents SDK, "Handoffs"](https://openai.github.io/openai-agents-python/handoffs/)
  — handoffs are tools (`transfer_to_<agent>`); the receiver sees the full prior
  history by default; input filters (`remove_all_tools`, custom) reshape it. The
  documentation specifies **no durable state, retry or timeout**.

Repo facts cite the file and line in this checkout. Prior art this builds on
rather than repeats: `docs/research/2026-08-agent-coordination.md` (the atomic
claim/lease primitive), `docs/research/2026-09-12-agent-room-review.md` (the
unanchored thread, and why a channel must not address),
`docs/research/2026-09-12-hermes-agent-review.md` (`listReady`'s `DEPS_CLOSED` /
`UNCLAIMED` fragments, and the heartbeat note),
`docs/research/2026-09-15-devin-cursor-integration.md` (the connected-agent
surfaces), `docs/research/2026-09-16-taskuary-review.md` (`later` and `skip`),
`docs/research/2026-09-22-connectors-mcp-gateway.md` (C45 and C59),
`docs/ops/{crews,targets,devin,threads,actions,board}.md`.
