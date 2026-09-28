# Crews — sub-agents with their own toolsets

A **crew** (plan §4.11, Phase 5 "crew definitions with their own toolsets")
is a sub-agent the instance's own assistant can hand a brief to. It is one
markdown file in your instance repo — `.metistry/agents/<area>/<name>.md`: YAML
frontmatter (validated by core's `agent` manifest schema), then the crew's
operating prompt — and nothing else: no code, no container, no credential
in your `.env`. The assistant dispatches it with one tool, the console
checks the brief before anything runs, the assistant container runs it
locally with a scoped, single-run credential, and whatever the crew wants
kept comes back through the same Needs You queue every agent uses.

**The brief is the context transfer** (§4.11). A crew has no memory between
runs and no access beyond its `scope`; what the assistant writes in the
brief is what the crew knows, and the brief is a reviewable artifact
showing exactly what context crossed.

## Write a crew manifest

Start from the shipped example, `seed/agents/example/researcher.md`, and put
your copy under `.metistry/agents/<area>/<name>.md` in the instance repo (a protected
path — §4.7 — changed by your hand only; the assistant cannot write it).

```yaml
---
name: researcher            # = the filename, lowercase kebab-case
type: agent
area: example               # = the directory (optional; filled from the path)
model: lmstudio/gemma       # <provider>/<model-id>, or same_as_assistant
effort: low                 # low | medium | high (default low) — the other half of the tier
description: Reads the granted notes and reports what it finds   # the assistant's roster line (H8)
uses: [knowledge, requests]        # tool GROUPS, see below
skills: []                  # recorded now; binds once skills/ exists (§4.4)
scope: [Projects, Resources]   # read tier: TitleCase vault-root prefixes
projects: []                # shared-list membership (§4.19); empty = none
manages: []                 # hierarchy lives here, not in directory depth
max_turns: 10               # agentic turns per run
budget_usd_per_run: 0.25    # the run stops past this
autonomy:                   # optional (§4.21); absent = defaults apply, never widens
  may_dispatch_to: []       # agent ids this crew may hand work to
  accept_from: []           # agent ids and/or the literal "user"
  max_open_bundles: 3       # integer ≥ 1
---

You are a researcher working for {{name}}, this instance's assistant. …
```

`model` names what the crew runs on, in its own definition (C128, T4-6): a
model from `compute.yaml`'s providers as `<provider>/<model-id>` — the same
pinned reference `compute.yaml` uses everywhere — or `same_as_assistant`, the
assistant's **default tier** (`assignments.default`, its model and its effort;
never the router). The pre-C128 aliases `haiku | sonnet | opus` still load for
one release: they run on `assignments.crews.<name>` when that is set, and on
the default tier when it is not — exactly where they ran before. After that
release doctor warns. `metistry agents define <name> --model …` edits it
([cli.md](cli.md)); what each form resolves to is [actors.md](actors.md),
*Crew compute*.

`model` and `effort` together are the crew's **tier** — the same (model,
effort) pair the router picks for a chat turn (`docs/ops/assistant-tools.md`).
`effort` is optional and defaults to **low**, because the crew shape that pays
is extraction: absorb a lot of context on a cheap model and return one report,
while the assistant does the thinking. Raise it deliberately, per crew, and
expect the cost to follow — low to max is roughly 3.5x on the research's
figures (`docs/research/2026-09-cost-optimization.md`, decision 2). An older
manifest with no `effort` keeps working, cheaply; an invalid value is refused
whole like any other schema miss.

A crew run is **one query**, so its effort is fixed for the whole run by
construction — there is no mid-run boundary to change it at, and nothing in
the runner can. For the same reason a crew run **never resumes an SDK
session** (decision 3: fresh session per crew run): `buildCrewOptions` has no
`resume` to set and the runner touches no `sessions` row. The `crew_run` row
records `fresh_session: true` so the fact is visible where cost is read.

`autonomy` is validated **strictly** — an unknown key inside the block, or
anywhere else at the manifest's top level, is refused with the reason
instead of being silently stripped (a typo must not read as "validated,
narrowed to nothing"). The registry sync maps it onto `agents.autonomy`
through the same normalizer `PUT /api/agents/:id/autonomy` uses
(`apps/console/src/agents.ts`'s `validateAutonomy`), so a manifest-set block
and a hand-set one land in the row identically.

The body is the operating prompt. `{{name}}` is the primary assistant's
name from `.metistry/identity.yaml` (templated by the runner — the seed never names
it, so a renamed instance is a clone, not a rewrite). Two rules the file
must obey, both enforced at load: **the name is the filename** and, when
`area` is present, **the area is the directory**. Anything that fails the
schema is refused whole and logged (`crews: refused …` in the console log);
a refused manifest is treated as absent.

### Tool groups (`uses`)

A crew names groups, never single tools. The groups are the table in
`packages/core/src/manifest.ts` (`CREW_TOOL_GROUPS`), locked to mcp-brain's
manifest by test so the two cannot drift:

| group | tools | plan spelling |
| --- | --- | --- |
| `knowledge` | `knowledge_search`, `knowledge_read` — under `scope` | `brain-read` |
| `requests` | `requests_create` — a request in the Needs You queue the assistant folds later | `brain-report`, `report` |
| `capture` | `capture` — notes/files into the inbox as captures | |
| `tasks` | `tasks_list`, `tasks_claim`, `tasks_renew`, `tasks_update`, `tasks_release`, `tasks_close`, `tasks_create` — within `projects` | |
| `artifacts` | `artifacts_publish`, `artifacts_get`, `artifacts_list`, `artifacts_comment`, `artifacts_resolve`, `artifacts_review` — within `projects` | |
| `rooms` | `tasks_comment`, `tasks_thread` — the room on a task, within `projects` ([threads.md](threads.md)). Its own group, not part of `tasks`: speaking is a new power, so a crew gains it when you edit its manifest, never because a release widened `tasks`. A crew still *reads* the last of a room without this group — the brief carries it. | |
| `connections` | `connections_list`, `connections_call` — the owner's services through Metistry's proxy (plan §2.6, T4-8b). Its own group, like `rooms`: reaching outside Metistry is a new power. **Holding the tools is only half the gate** — a connection is reached only when the owner has offered it to agents **and** granted it to this crew (`grants.connections` on its principal), so naming this group alone reaches nothing, and a grant without the group is refused at the door. | |
| `actions` | `propose_action` — ask the console to dispatch a work row, patch a task, comment, or capture ([actions.md](actions.md)). Same rule as `rooms`, and **holding the tool is only half the gate**: the crew's `autonomy` record decides whether each kind is refused, proposed, or run on the spot, and with no `level` the answer is "refused" — so naming this group alone changes nothing. | |

`knowledge_write`, `agents_delegate`, `queries_list` and `queries_run` are
**not groups**. Naming any of them in `uses` is refused by the schema with
the reason ("never available to a crew"): sub-agents never write knowledge
(§4.11 — one writer), a crew never dispatches crews, and a named query is
not filtered by a crew's `scope`/`projects` the way every other tool group
here is — handing it out would leak past the boundary `uses` exists to
hold. The runner's `allowedTools` is built from the same table
(`apps/assistant/src/crew.ts`), built-in tools are off, and foreign MCP
config is ignored — invariant 9 holds for a crew exactly as for the
assistant.

### Where `uses` is enforced: at the door

The console resolves a crew's `uses` from the manifest it loaded, attaches
it to the principal at authentication, and **`/mcp` refuses every call
outside it** before the tool body runs:

```json
{ "error": { "code": "forbidden",
             "message": "tasks_comment is not in this crew's toolset — writer holds knowledge, requests (`uses:` in its manifest, a protected path in the user's hand: docs/ops/crews.md). Report what you needed instead of retrying." } }
```

One `runs` row on the crew's own id, the same uniform envelope every other
refusal on that surface uses. The runner still builds its client-side list
from the same table, so the model is not offered a tool it cannot use — but
that filter is **defence in depth, not the control**. Until 2026-09-20 it
was the control, which meant `uses` was a property of the process that
dispatched the run rather than of the tool; five of the eight groups
(`rooms`, `artifacts`, `tasks`, `capture`, `requests`) had no server-side
gate at all. "Enforce at the tool, never by prompting" (CLAUDE.md) — a
filter in the caller is neither.

Two consequences worth knowing:

- **The door follows the manifest as loaded now**, not the snapshot frozen
  into the run's work row. Edit a manifest mid-run and the door answers from
  the edited file at the next call.
- **A crew this console has no manifest for holds no tools.** A revoked
  crew, a file that failed to parse, a console started without `agents/`:
  the toolset resolves to empty, never to everything.

Widening a crew is still an edit to `agents/<area>/<name>.md`, in your own
hand. A crew cannot ask: `request_access` is a never-tool, and the
console refuses the widening at triage as well, because the next crew sync
would undo it.

## What a crew can and cannot do

**Can:** read settled notes under its `scope` (drafts are invisible at
every tier); search their titles; report findings, decisions, gotchas and
progress; capture; work the shared task list and publish artifacts inside
its `projects`; with the `rooms` group, read and add to the room on a task
([threads.md](threads.md)); with the `actions` group **and** an `autonomy`
level you set, ask for — or, within that table, carry out — one of four
actions ([actions.md](actions.md)). Every call is one `runs` row on the crew's
own id.

**Cannot:** write knowledge; dispatch crews; touch any protected path; reach
a shell, the filesystem, the web, or a second MCP server; read outside its
scope (the grant is on the registry row, server-side — nothing in the
brief widens it); keep a credential (below); spend past
`budget_usd_per_run` or run past `max_turns`; return a reply — the final
text is discarded, only what it *reported* survives.

The registry row is `agents.kind = 'crew'`, with grants from `scope`
through the **same validator external agents face** (`validateGrants`,
external shape: TitleCase areas, the bare vault refused — a crew is not
the assistant), `grant_source = 'manifest'`, and `projects` from the
manifest. At the bridge a crew authenticates **as a crew** — its own role
since 2026-09-20, not a foreign agent it used to be indistinguishable from
(migration 0025's CHECK writes the three stored kinds down). `knowledge_write`
and `agents_delegate` are refused, project membership is exactly its list,
and the toolset is exactly its `uses`.

### Autonomy in the manifest

`autonomy` may carry `level: observe | propose | act_within_scope` and an
`actions: {<kind>: allow | propose | deny}` table beside the §4.21 narrowing
keys ([actions.md](actions.md)). This is the one key in a crew manifest that
can *widen* rather than narrow — which is admissible because `.metistry/agents/` is a
protected path (§4.7) that only your hand writes. The registry sync treats it
exactly as the console route does: the raise lands in `runs` as
`agent_admin` / `autonomy_widened` and puts one alert in Needs You. Absent =
`observe` = nothing.

## How dispatch works

```
assistant ──agents_delegate{crew, brief, task_id?}──▶ console (mcp-brain)
   │  internal principal only                      │ registry lookup
   │                                                │ checkBrief(scope ∩ local-crew.allow)   ← refused? no row, runs row ok=false
   │                                                ▼
   │                                          work row: kind task, owner crew:<name>,
   │                                          meta {brief, brief_sha, crew snapshot, task_id}
   ▼                                                │
assistant container drain loop ◀── claim (SKIP LOCKED, lease) ──┘
   │ mint a token for THIS run → agents.token_hash
   │ SDK query: crew model + effort, prompt + trailer, brief, ONE mcp server (/mcp + run token),
   │            allowedTools = groups, maxTurns, maxBudgetUsd
   │ brief += the prior-work block: the last of the room on the row, budgeted (threads.md)
   │ crew calls requests_create / tasks_* / capture → requests, work, inbox (its own runs rows)
   │ runs row: component = <crew>, kind = crew_run (cost, tokens, tools_used, brief_sha)
   │ burn the token; stamp proposals.work_id on whatever it raised; close the row (or park it)
```

1. **The tool.** `agents_delegate` is the nineteenth mcp-brain tool and is for
   `kind: internal` principals only — every other agent is told "not
   granted". The assistant's seed prompt says when to use it; the bridge
   decides whether it may. The `crew` field's own description carries the
   **roster**: every registered crew's name and the `description:` its
   manifest wrote, so the assistant chooses from what each crew says it does
   rather than learning the registry by refusal (H8, 2026-09-17). It is read
   off the registry each time the tool is registered — the brain builds one
   server per request — so an edited manifest shows up on the next call.
   Capped at 20 crews and 120 characters each: the roster is spent out of the
   same definition-token budget the whole surface is measured against.
2. **The policy, at the tool.** The console (`apps/console/src/crews.ts`)
   checks the brief with the *existing* dispatch enforcement
   (`checkBrief`, `docs/ops/targets.md`) against the crew's `scope` ∩ the
   `local-crew` target's `allow` list, plus the target's `deny_sources` and
   `max_brief_bytes`. A brief citing `Me/…` for a crew scoped to
   `Projects` is refused with the violations in the error message
   (so the assistant sees which path to remove) and as a `runs` row
   (`kind = dispatch`, `tool = local-crew`, `ok = false`,
   `meta.violations`). **No work row is written on a refusal.**
3. **Durable enqueue.** A clean brief becomes one `work` row through the
   tasks module: `kind = task`, `owner = crew:<name>`, `project` NULL (the
   row is the runner's queue entry, not shared work — no agent's `tasks_*`
   view sees it), `created_by` = the assistant, `meta` = the brief, its
   sha, the related `task_id` handle, and a **snapshot** of the manifest
   (fields + prompt + file sha). The assistant container has no vault; the
   snapshot is what it runs. Edit a manifest and already-queued rows keep
   the old one; new dispatches pick up the new one on the next sync.
   `idempotency_key` makes a retried dispatch return the same row.
4. **The runner** (`apps/assistant/src/crew-drain.ts`, `crew.ts`). The same
   loop that drains inbound messages then drains the crew queue: claim the
   oldest runnable row (open, or `in_progress` with a lapsed lease — a run
   that died with the container is re-picked), re-validate the snapshot
   through core's schema, **mint a token for this run** (the crew row's
   hash is replaced; the plaintext goes into the SDK's MCP server header
   and nowhere else), run, record, **burn the token** (hash replaced again
   with one nobody holds — in `finally`, so a crash burns it too).
5. **Results.** Only through the crew's own tools — `requests_create` lands as
   `proposals` rows (kind `report`, `source_agent` = the crew) for you to
   approve, revise or decline and the assistant to fold; `tasks_update` notes, `capture`,
   artifacts likewise. The runner writes one `runs` row per run on the
   **crew's id**: `kind = crew_run`, `model`, `tokens_in/out`, `cost_usd`
   (the SDK's estimate), `meta = {work_id, brief_sha, task_id, attempt,
   effort, fresh_session, crew_sha, outcome, num_turns, tools_used,
   reports}`.

### Outcomes and retries

| what happened | run row | work row |
| --- | --- | --- |
| finished | `ok = true`, `meta.outcome = ok` | `closed`, history note `crew run #N: ok, T turns, R reports, $c` |
| past `budget_usd_per_run` / `max_turns` | `ok = false`, `error = crew run max_budget` / `max_turns` | `blocked` — final; retrying would spend again for the same brief |
| the SDK itself failed | `ok = false`, the error | claim kept, lease = `METISTRY_CREW_RETRY_S`; re-picked when it lapses, up to `METISTRY_CREW_MAX_ATTEMPTS`, then `blocked` |
| the row cannot be honoured (no snapshot, a write tool in it, crew revoked, no brain URL) | none | `blocked` with the reason in history; no token minted |

A crew whose run produced zero `requests_create` calls is visible as `reports: 0` on
the run row — the brief probably did not say what to report.

## The other way in: a New Routine

A crew row is also enqueued by the console's runner when a **New Routine**
(`docs/ops/scheduled.md`) names the crew as its actor: the same row shape —
`owner = crew:<name>`, the manifest snapshot, the task as the brief,
`created_by = runner` — plus `meta.routine`, the run's **read-only** per-run
grant. The owner wrote the task, so there is no `checkBrief`; the grant is
held only by the bearer the drain mints for that run, while it runs, and never
touches the crew's registry row (`authenticateAgent`, `crew-drain.ts`).

## The registry sync

The console loads manifests from `METISTRY_AGENTS_DIRS`
(default `seed/agents:agents`, D4 overlay, later entries win by name) at
startup and every `METISTRY_CREWS_SYNC_S` (default 300 s). An entry that is
a directory on disk is read there; one that is not (the instance repo's
`.metistry/agents/`, which no container mounts) is read through the reconciler's
vault bridge (`GET /vault/list?prefix=agents&depth=2` + `/vault/read`) when
`METISTRY_RECONCILER_URL` + `METISTRY_BRIDGE_TOKEN_RECONCILER` are set —
that is the one way a protected path reaches the console, read-only. No
bridge and no disk dir → the entry is absent and the seed example is all
there is.

Sync is idempotent and quiet: a row is written — and an `agent_admin` runs
row (`tool = crew_sync`, `meta.op = register | resync | revoke |
conflict`) logged — only when a crew is new, changed (grants/projects), or
gone. Token hashes are never touched by sync; registration stores the hash
of a token discarded on the spot, so **no valid crew credential exists
between runs**. A manifest that disappears (or stops validating) revokes
its row; a name that collides with a non-crew row (the assistant, an
external agent) is a `conflict` — never overwritten, and not dispatchable.

Startup log: `crews: researcher [registered 1, resynced 0, revoked 0] sources
{"seed/agents":"disk","agents":"vault"}`. `GET /api/agents` lists crews
like any agent (`kind: crew`), hashes never included. The management API's
grant/project edits on a crew hold until the next sync; the manifest is the
source of truth — edit the file.

## Watch it

Everything is `runs`, keyed by the crew's name as `component`:

```sql
-- runs by component: what each crew did, at what cost
SELECT component, kind, count(*), sum(cost_usd), max(ts)
FROM runs WHERE component IN (SELECT id FROM agents WHERE kind = 'crew')
GROUP BY 1, 2 ORDER BY 1, 2;

-- one run, then its tool calls (same component, kind = tool)
SELECT ts, kind, tool, ok, error, cost_usd, meta FROM runs
WHERE component = 'researcher' ORDER BY id DESC LIMIT 20;

-- refused dispatches, with why
SELECT ts, error, meta->'violations' FROM runs
WHERE kind = 'dispatch' AND tool = 'local-crew' AND NOT ok ORDER BY id DESC;

-- the queue
SELECT id, status, claimed_by, lease_expires_at, meta->>'attempts' AS attempts, title
FROM work WHERE owner LIKE 'crew:%' AND status <> 'closed';
```

On the dashboard the 24 h "runs" tile counts crew runs among the failures
and the spend; Needs You shows what they reported. A per-component
panel is a named query away (`seed/queries/`), not new machinery (§4.18.D).

## Configuration

| variable | read by | meaning |
| --- | --- | --- |
| `METISTRY_AGENTS_DIRS` | console | Manifest dirs, colon-separated; default `seed/agents:agents`. Not-on-disk entries go through the vault bridge. |
| `METISTRY_CREWS_SYNC_S` | console | Re-read + re-sync interval (default 300). |
| `METISTRY_TARGETS_DIRS` | console | Must include a dir with `local-crew/manifest.yaml` (the product `targets/` does). Overlay it per instance to widen `allow`. |
| `METISTRY_BRAIN_URL` | assistant | The console's `/mcp`; crews run against it with their own per-run token. Unset → queued rows park as blocked. |
| `METISTRY_CREW_LEASE_S` | assistant | Claim lease per run (default 1800). Longer than any sane run; a dead runner's row is re-picked after it. |
| `METISTRY_CREW_MAX_ATTEMPTS` | assistant | Infrastructure-failure retries before `blocked` (default 3). |
| `METISTRY_CREW_RETRY_S` | assistant | Backoff between retries (default 300). |
| `METISTRY_BRIEF_THREAD_BYTES` | assistant | Bytes of the task's room appended to the brief as the prior-work block (default 4096, `0` = off). Clipped again by the target's `max_brief_bytes`. See [threads.md](threads.md). |

No new secret: the crew credential is minted and burned by the runner
against the database both containers already share.

## The local-crew target

`targets/local-crew/manifest.yaml` — `transport: local`, `submit.via:
work_queue`, `result.via: report_queue`, `cost.per_run_estimate_usd: 0`
(the real cost lands on the `crew_run` row). Its `data_policy.allow` is the
**widest** any crew's scope may reach: `Areas`, `Projects`,
`Resources`, `Techniques`. Personal roots (`Journal`,
`People`, `Me`, `Decisions`) are absent on purpose; a crew scoped to them
gets an empty effective allow list and can cite no path. Widen in an
instance overlay dir, never in the product default. `deny_sources: [comms]`
keeps comms-derived text out of briefs even locally — the assistant can
read the thread itself; the brief is the reviewable record of what crossed.

## Tests

- `packages/core/test/crew-manifest.test.ts` — schema good/bad; `uses`
  refuses write tools; groups never contain a never-tool.
- `apps/console/test/crews.test.ts` — file parsing; every shipped
  `seed/agents/**/*.md` validates (CI gate); vault-bridge loader against an
  in-memory vault; scope ∩ allow; dispatch refusal with violations and no
  row (fakes).
- `apps/console/test/crews.integration.test.ts` — registry sync idempotent
  (second sync writes nothing, hash untouched), resync/revoke/conflict;
  `agents_delegate` over the live `/mcp`: external → not granted, refused
  brief → no work row + audited, clean brief → one durable row, idempotent;
  and a per-run crew bearer refused a tool outside `uses` at the door, with
  no client filter in the loop.
- `packages/mcp-brain/test/crew-uses.test.ts` — the toolset gate itself:
  every group the manifest did not name refused with the uniform envelope,
  the ones it did named past it, an unresolvable manifest holding nothing,
  the body never running, and nothing in a call able to widen it.
- `apps/assistant/test/crew.test.ts` — allowlist exhaustive against
  mcp-brain's manifest; option builder (model, **effort**, bearer, tools,
  turns, budget, and no `resume`); `effort` defaulting to low and refusing a
  bad value; runner outcomes with a fake SDK.
- `apps/assistant/test/crew-drain.integration.test.ts` — claim/run/close
  with a fake runner; the token authenticates only during the run and a
  second run gets a different one; retry → blocked; budget → blocked;
  refused rows never mint.
