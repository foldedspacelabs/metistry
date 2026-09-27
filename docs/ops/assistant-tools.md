# Assistant tools — the assistant as the first internal agent

Plan §4.11 rules that internal and external agents use the **same**
`mcp-brain` surface. This page is the operator's view of that for the
instance's own assistant: what it can do now, how to turn it on, how to
grant or narrow it, and where to see what it did.

## What the assistant can do

With tools mounted, every turn the engine runs can call exactly these
mcp-brain tools on the console's `POST /mcp` (`packages/mcp-brain`), and
nothing else — no shell, no filesystem, no git, no web (invariant 9,
enforced in `apps/assistant/src/brain.ts`, locked to the bridge's
manifest by test):

| Family | Tools | What it means for the assistant |
| --- | --- | --- |
| in | `capture`, `requests_create`, `request_access` | Raise anything unsettled into the inbox / your Needs You queue; you approve, revise, or decline. `request_access` is the narrow one: an agent asking for a vault area it was refused (`docs/ops/actions.md`). The assistant may ask too since 2026-09-19 — an approval for it is recorded so the next restart does not undo it; see below. |
| shared work | `tasks_list` (`filter: ready \| mine \| all`), `tasks_claim`, `tasks_renew`, `tasks_update`, `tasks_release`, `tasks_close`, `tasks_create` | Works the same shared list as every other agent — claims, leases, notes, and `tasks_close` to finish one in a single call. |
| rooms | `tasks_comment`, `tasks_thread` | The conversation on a task ([threads.md](threads.md)) — say what you found, read what the last crew left. Nobody is addressed by it, so nothing is woken; use `agents_delegate` when someone has to act. Resolving a room is your hand in the console, not a tool. |
| out | `knowledge_search`, `knowledge_read`, `knowledge_list`, `knowledge_grep` | Reads the knowledge index, page contents, a listing, a page's links (`knowledge_list { links_for }`) and a content regex, within its grant — `knowledge_list`/`knowledge_grep` are filesystem semantics over the same tiers `knowledge_search`/`knowledge_read` already enforce (docs/research/2026-09-stash-review.md item 3). `knowledge_read` returns the page's `sha256`. |
| write | `knowledge_write` | **This is `brain-commit`** (plan §4.7, D5): one page under the vault root (anywhere outside `.metistry/`) → the reconciler's `POST /vault/write` with a commit intent in the assistant's name. Internal principals only; every external agent is told "not granted". No delete, no rename — those stay your hand. |
| artifacts | `artifacts_publish`, `artifacts_get`, `artifacts_list`, `artifacts_comment`, `artifacts_resolve`, `artifacts_review` | Publishes versioned output into `Artifacts/<project>/<slug>/` (one commit per version via the reconciler), comments on exact versions, and sends review bundles to other agents in the same project — a review sent across the project boundary becomes a request for you (§4.21). |
| helper agents | `agents_delegate` | Hands a brief to a helper agent you defined in `agents/<area>/<name>.md` (`docs/ops/crews.md`). Internal principals only; the brief is policy-checked against the helper's scope before a durable work row is written; results come back as the helper's own `requests_create` requests. The `crew` field lists the registered helpers with each manifest's `description:`, so writing one is how you steer the choice. |
| queries | `queries_list`, `queries_run` | Runs a named query from `seed/queries/` or the instance's `queries/` (invariant 3 — the one read path) for anything you'd otherwise have to guess at or ask the user to look up. Internal principals always have this; an external agent needs an explicit `queries: true` grant. Rows cap at 200. A query whose manifest says `expose: route` is **not** served here — it has a scoped door of its own, and asking for it by name gets the refusal an unknown name gets (below). |

### One scope rule for every knowledge read (ruled 2026-09-19)

Every `knowledge_*` tool and every `/api/knowledge/*` route asks the SAME
function — `canSeeUnder(path, areas)` in
`packages/mcp-brain/src/knowledge.ts`, which the console's `canSee` is now a
rename over. Two conditions, both necessary: the path is vault CONTENT (not
`.metistry/`, not `Artifacts/`, nothing inside a dot-directory, no traversal,
not the root `CLAUDE.md` — true for you too, on your own vault), and it falls
under the caller's areas.

The tier decides which question is being asked:

| tier | may be told a page EXISTS (path, title, one-line description) | may read a page, or traverse its links |
| --- | --- | --- |
| `none` | nothing — and is told "not granted", never "not found" | no |
| `index` | anywhere in the vault index | no — told which area would unlock it (below) |
| `areas` | inside its granted prefixes | inside its granted prefixes |

`index` browsing titles **outside** any area it can read is the point of the
tier, not a leak: an agent has to be able to find out that
`Areas/Health/sleep.md` exists in order to ask you for the area that holds
it. It never sees a byte of one.

**`queries_run` does not route around that.** A `queries: true` grant is a
separate axis from the knowledge tier, and until 2026-09-19 it was a way past
it: the page list and the link graph are named queries, so an agent at tier
`none` could run `queries_run knowledge_pages` and page the whole index.
Both manifests carry `expose: route`, and `queries_run` now refuses a
route-backed query with the unknown-query refusal, byte for byte — so nothing
on that door tells a caller which route-only queries exist. The rows are
still reachable, through the door that filters them: `knowledge_list`, which
runs the same two queries through the same `canSeeUnder`.

### A new read capability is a named query, not a new tool

**The default answer to "the assistant needs to be able to look X up" is a
named query behind `queries_run`, not another tool.** Ruled 2026-09-19
(`docs/research/2026-09-19-code-mode-mcp.md` §4.1); invariant 3 already
requires the query to exist, so a tool would be a second door onto a read
path that has one.

The arithmetic, measured on this checkout: `seed/queries/` holds 20 named
queries, and `queries_list` + `queries_run` front all of them for **284
tokens of always-on definitions** in place of the **2,936** the same 20 would
cost as individual tools — a 90% reduction, with the index itself deferred
behind a call. A 21st query costs **~120 deferred tokens and zero eager
ones**; a 21st tool costs **~180 eager tokens on every turn, forever**, and
lands on a surface already 6 tools past the count line at which the manifest
schema says to consider `discovery: lazy` (`ops/scripts/check-tool-surface.mjs`
prints the headroom on every CI run, and fails on the tool after the number
acknowledged there — `request_access` moved it 25 → 26 on 2026-09-19, with the
reasoning written next to the number).

Write the query, give it `expose: generic`, and the assistant can run it the
day it merges. A new **tool** is for a new *verb* — something the system can
now do — and it arrives with the lazy-discovery decision attached.

**One refusal vocabulary.** Every refusal on this surface says the one
sentence its `reason` says, with the facts substituted and the shape never
(`packages/core/src/access.ts`, and the catalogue in
`packages/core/test/access.golden.json`). So `queries_list` and
`queries_run` refuse in the same words; `knowledge_write` and
`agents_delegate` give the same "belongs to the instance assistant alone"
sentence; a tier miss names the tier this tool needs and the tier you hold,
in the words the console uses for them (`none` / `titles` / `folders`).
Every one of them names what would unlock it and who decides, because a
refusal with no next move leaves a model retrying the same call.

**And one silence.** Two kinds of refusal are deliberately uninformative and
will stay so: a route-only named query (`queries_run` answers exactly what
it answers an unknown name — `no such query: X`) and a row outside your
projects (`not_found`, because it does not exist for you). They carry no
`reason` and no remedy. That is not an oversight to be reported; it is the
answer.

**Asking for more, named instead of guessed (ruled 2026-09-19, PR #216
judgement call B).** `knowledge_read` and `knowledge_list`'s `links_for` stop
at the bare "not granted" only when the caller could not already see the
page — tier `none`, or a path that fails the vault-path rule. For a page
whose TITLE the caller may already see (tier `index` on any settled page,
never a draft or a path that was merely guessed) the refusal is structured
instead: still `isError: true` with the ordinary `error.code: "forbidden"`
underneath (the envelope invariant 8 promises is unchanged), plus a stable
machine-readable `reason: "scope_required"` and `grantedScope` — the area
(the page's own parent directory) that would unlock it — alongside it.
`error.message` spells out the same thing in a sentence, and names the
mechanism: **`request_access {area, reason}`** (ruled the same day), which
writes one `access_request` row into your Needs You queue and grants nothing.
You answer it with Approve, Revise (grant a narrower folder) or Decline, and
Approve goes through the same grants door and the same audit row your own
click in the Agents panel goes through (`PUT /api/agents/:id/grants`,
`docs/ops/actions.md`). Enforced at the tool, granted by your hand — and a
refusal that names its own remedy is what keeps a scoped agent from retrying
the same path forever.

**A crew you dispatch is held to its manifest's `uses` at the door.** Since
2026-09-20 the console resolves a crew's tool groups from the manifest and
`/mcp` refuses anything outside them — one `runs` row, the uniform
`forbidden` envelope, before the tool body runs. Previously only the runner's
own allowlist refused those calls, which meant a crew's toolset was a
property of the process that ran it rather than of the tool
([crews.md](crews.md)). Nothing changed for your own credential or for an
external agent: neither carries an allowlist, and every refusal they can get
is byte-identical to what it was.

**Every refusal this surface can give is in one file.**
`packages/core/test/access.golden.json` is the committed catalogue: one entry
per door, with the error code, the machine-readable `reason`, the exact
sentence the caller reads, and the `needs` (if any) that says what would
unlock it. Every door asks `may()` in `packages/core/src/access.ts` and
nothing else, so the file is the whole vocabulary rather than a sample of it
— and changing what a tool says to a model is a diff there, reviewed, instead
of a string edited inside a handler (`docs/ops/auth.md`, "One decision
function").

One consequence to know before you Approve: tier `index` browses every title
in the vault and reads none, tier `areas` sees titles only inside its
prefixes — so granting an `index` agent one folder **trades** the browse for
the read. There is one tier, and that trade is the decision.

And one to know before you Decline: the agent is TOLD. A repeat ask for the
same area does not queue a second row — the tool answers it with the decision
you already gave and your note, and offers one escalation (`escalate: true`
with a fuller reason), which arrives flagged *asked again after a decline*.
Decline that and the area is closed at the tool; what is left is a
`requests_create` report in words. Mistakes happen, so the ladder has a
second rung — and exactly one (ruled 2026-09-19).

**Deprecated spellings, one release.** The 2026-09-09 vocabulary
simplification renamed eleven of these (`docs/product/glossary.md`). The old
names still work — `report`, `tasks_list_ready`, `tasks_mine`,
`tasks_heartbeat`, `artifact_*`, `crew_dispatch` — but they are resolved at
call time and are **not** in `tools/list`, so the surface an agent discovers is
exactly the table above. An alias call is audited under the primary name with the old
spelling in `runs.meta.alias`:

```sh
psql -c "SELECT meta->>'alias' AS old, tool AS now, count(*) FROM runs
         WHERE meta ? 'alias' GROUP BY 1, 2 ORDER BY 3 DESC"
```

An empty result is the signal that the aliases can come out.

**The turn handle is the client's, not the model's.** Every call carries a
`turn_id` into the `runs` row's `meta.turn_id`, which the `activity_feed`
query surfaces so one reply's calls group together — but it is **not a tool
parameter**. It rides in the MCP call's `_meta`, under
`com.foldedspacelabs.metistry/turn_id`: the drain mints one per reply before
the call (`apps/assistant/src/drain.ts`), so the turn's own `runs` row carries
it from its in-flight insert, the tool host (`apps/assistant/src/tools.ts`)
stamps it on every call, and the session archive keys the turn by it (T3-9) —
a host given none mints its own. Until 2026-09-19 it was an
optional argument on every tool and the seed prompt asked the model to
invent one and pass it faithfully: ~940 definition tokens, 18.8% of the whole
advertised surface, for a field no model should be reasoning about — and a
convention rather than a control. A client still sending it as an argument is
tolerated for one release: the bridge lifts it into `_meta` at the door
(`packages/mcp-brain/src/turn-id.ts`), so nothing that already works stops
working, and nothing advertises it.

The SDK sees them as `mcp__brain__<tool>`; that fully-qualified list is
the engine's `allowedTools`, built-in tools are disabled (`tools: []`),
and `strictMcpConfig` makes the SDK ignore any `.mcp.json`, user settings
or plugin MCP config. Without the two env vars below the engine runs
tool-less, exactly as before.

## Turn it on

One shared secret, read by both containers:

```sh
openssl rand -hex 32          # → METISTRY_ASSISTANT_TOKEN in .env
docker compose up -d --build   # both services read .env
```

| Variable | Read by | Meaning |
| --- | --- | --- |
| `METISTRY_ASSISTANT_TOKEN` | console + assistant | The bearer. The console stores only its SHA-256 (row `agents.id = 'assistant'`, `kind = 'internal'`); the assistant presents it on every `/mcp` request. **Unset → the console revokes the row at startup and the assistant runs tool-less.** |
| `METISTRY_BRAIN_URL` | assistant | Where `/mcp` is; compose defaults to `http://console:8080/mcp` over the compose network. |
| `METISTRY_ASSISTANT_PROJECTS` | console | Comma-separated project slugs. **Empty = every project** (mcp-brain's internal rule, `packages/mcp-brain/src/scope.ts`); a list narrows it like any external agent. |
| `METISTRY_ASSISTANT_AREAS` | console | Comma-separated vault-root prefixes for the grant (anything outside `.metistry/`). Default is the bare vault — the whole thing, root notes included (below). |
| `METISTRY_RECONCILER_URL`, `METISTRY_BRIDGE_TOKEN_RECONCILER` | console | The reconciler's vault bridge (`docs/ops/reconciler.md`). `knowledge_read`, `knowledge_write`, `knowledge_list`, and `knowledge_grep` all go through it; unset → all answer `not_available` and the brain's `check()` is `degraded`. |
| `METISTRY_INSTANCE_DIR`, `METISTRY_SEED_DIR` | every service | Where this install's config is. **Every `*_FILES` default below resolves its instance half against `METISTRY_INSTANCE_DIR` and its seed half against `METISTRY_SEED_DIR`** — absolute paths, never relative to a working directory, because a launchd job's is the product checkout. `metistry up` sets both. Neither set and no `METISTRY_IDENTITY_FILES` either → **the assistant refuses to start** rather than answer as the product's seed. |
| `METISTRY_IDENTITY_FILES`, `METISTRY_PROMPT_FILES` | assistant | D4 overlays for the instance's `identity.yaml` and the seed system prompt (`seed/assistant-prompt.md`); last existing file wins. Naming them explicitly overrides the resolution above — which is how the compose shape, whose containers mount no instance repo (D5), says "the seed, deliberately". |
| `METISTRY_RULES_FILES` | console + assistant | D4 overlay for the instance's `rules.yaml` (default `<seed>/rules.yaml:<instance>/.metistry/rules.yaml`). The console reads the fast paths and the tier menu; the assistant reads the **same `tiers:` block** to resolve a tier name to (model, effort). Unreadable by the assistant → one tier, `METISTRY_MODEL_DEFAULT` at medium effort. |
| `METISTRY_MAX_TURNS` | assistant | Agentic turns per message (default 12 with tools, 4 without). |

Startup logs to look for: console `internal agent 'assistant' registered`
(or `re-synced`); assistant `tools: 23 via http://console:8080/mcp (...)` (the count tracks `packages/mcp-brain/manifest.yaml`)
and `identity: <name> from <file>` — which file won is in the line, so an
install reading the product's seed instead of its own `identity.yaml` is
visible rather than inferred (the assistant warns on exactly that case).

Under the `launchd` shape the engine runs inside `ops/sandbox/assistant.sb`,
which denies by default. It is granted read on these four files **by name**
(`-D CONFIG_IDENTITY=…` and friends, computed by `metistry up`) and on no
other part of the instance directory: knowledge reaches the engine through
the brain bridge over HTTP or not at all (D5).

**Rotate** by changing the value in `.env` and restarting both containers:
the console re-keys the row, the old token dies at once. The console's
`/api/agents` list shows the row (`assistant · internal`) with no hash,
ever.

### Running without an engine

An install with **no engine** is a supported shape, not a broken one. There
are two ways to have none, and they are the two halves of one answer
(`compute.yaml`, docs/ops/compute.md):

1. **`assignments.default` is not set** — nothing says which provider and
   model a turn runs on.
2. **It is set, but the key its provider names is not** — `providers.<name>.
   auth.secret` names a variable that is unset in this install's environment.

Under the launchd shape `metistry up` leaves the assistant out of the
supervisor's children rather than starting a process that can only
crash-loop, and prints one line naming which half is missing:

```
assistant: absent — no assignments.default in compute.yaml — nothing says which provider and model a turn runs on; captures, tasks, search and the console run; fold turns wait (docs/ops/assistant-tools.md). Fix: metistry compute assign default <provider/model>
```

`metistry doctor` reports `assistant  service  absent` with the same
remediation, and it is **not** a failure — exit 0. Everything model-free
keeps working: captures land, `inbox-drain` classifies them deterministically
into proposals, tasks and search and the console and the reconciler all run.
What waits is the engine's queue — the evening fold's turn sits in
`inbound_messages` until there is a model — and the watchdog knows it:
`assistant-drain` reports `absent` (no alert) while the assistant is not a
child, instead of paging you every minute about a queue nobody is draining.

Give it an engine and re-run `metistry up`: the supervisor's config is
rewritten whole each time, so the child is simply back — and unassigning it
again removes it, with nothing to hand-edit either way.

```sh
metistry compute providers add --from openrouter          # key on stdin → login Keychain
metistry compute assign default openrouter/anthropic/claude-sonnet-5
metistry secrets sync --to env                            # the key into <instance>/.metistry/state/.env
metistry up
```

Both shapes run engine-less: `docker-compose.yml` passes the provider key
through when it is set and does not require it, exactly as the launchd shape
does. One seam decides for all of them — core's `engineStatus` — so `up`,
`doctor`, the routine runner's preflight and the watchdog cannot disagree
about whether this install has a model.

## Tiers: (model, effort) pairs

A **tier** is a model *and* an effort level, chosen together — a stronger
model at low effort is often cheaper than a weaker one working hard
(`docs/research/2026-09-cost-optimization.md`, decision 2).

> **`compute.yaml` is where tiers live now** (`docs/ops/compute.md`). An
> `assignments:` block names a PINNED `<provider>/<model-id>` per tier and
> per crew — which says *where* the turn runs as well as *what* runs it, and
> therefore which engine answers. `rules.yaml`'s `tiers:` below is the
> fallback for the model NAME on an install that has not written an
> `assignments:` block — but with no assignment there is no engine, so those
> turns do not run at all until one exists.
> Precedence, in one function (`resolveTurn`): `compute.yaml` assignments →
> a crew manifest's own pair → `rules.yaml`. An unknown name lands on
> `assignments.default` (or `rules.yaml`'s `default`) at every level.

```yaml
# compute.yaml — where a tier says which provider serves it
assignments:
  default: { model: openrouter/anthropic/claude-sonnet-5, effort: medium }
  tiers:
    routine: { model: lmstudio/google/gemma-3n-e4b, effort: low }
  crews:
    researcher: { model: lmstudio/google/gemma-3n-e4b }
```

Tiers in `rules.yaml`, the fallback, and an instance overlay (D4) moves them:

```yaml
tiers:
  fast:    { model: haiku, effort: low }
  default: { model: haiku, effort: medium }   # bare text lands here; `default` must exist
  deep:    { model: opus,  effort: high }     # /deep, and the composer's picker
  routine: { model: haiku, effort: low }      # machine-enqueued turns (the evening fold)
```

`effort` is `low | medium | high` and defaults to `medium`, so a tier written
the old way (model only) keeps working. Tier names are lowercase kebab-case;
an unknown name resolves to `default` — the resolver never invents a model.

**The router names a tier; the drain resolves it.** Both read the same file
(`METISTRY_RULES_FILES`, default `seed/rules.yaml:rules.yaml`, last existing
file wins), so there is one definition and one place a name becomes a pair
(`packages/core/src/tiers.ts`). Three ways a turn gets its tier:

| source | how |
| --- | --- |
| the router | `/deep`, `/model <tag>`, or the default for bare text (invariant 4: deterministic — no model decides) |
| the composer | `tier` on `POST /message`. Applies only where the default would have: `/note`, a typed command and the fast path all still win, and an unknown name is ignored |
| a routine | `meta.tier` on the `inbound_messages` row. The evening fold writes `routine` |

**Effort changes only at turn boundaries — by construction, not by
instruction.** One request per turn, its options built once from that turn's
tier and never mutated mid-stream (`buildQueryOptions` on the SDK path; the
in-house loop builds the body once per call from the same resolved
assignment). Two consecutive turns
on one session at one tier produce byte-identical options, which is the point:
changing model, effort, tools or system prompt mid-session invalidates the
cached prompt prefix, and a break costs up to 50x the cache-read price per
token. There is a test for exactly that (`apps/assistant/test/brain.test.ts`).

Startup log: `tiers from seed/rules.yaml: fast=haiku/low default=haiku/medium
deep=opus/high routine=haiku/low`, then either `compute.yaml assignments:
default=… routine=…` or `compute.yaml assigns nothing — rules.yaml's tiers:
is the live map and there is no engine`. No rules file at all → one
tier, the `METISTRY_MODEL_DEFAULT` model at medium, and a warning.

## Session rolls: fresh context at task boundaries

Pruning context at a **task boundary** beats editing it mid-task (decision 3,
which closes the open half of plan §6 decision 3 — "no fixed cadence" — with
an event instead of a cadence). Two events roll the chat thread's session, and
two kinds of turn never resume one at all:

| what | effect |
| --- | --- |
| a blocking `decision` is answered in the thread | the thread's active session is marked `rolled` **before** the answering turn is drained, so the answer starts fresh |
| a task the assistant held closes during a turn | the thread rolls after that turn; the next turn starts fresh |
| a fold turn (`meta.kind: fold`, or any row with `meta.fresh_session: true`) | never resumes — the fold is its own task |
| a crew run | never resumes — there is no `resume` for the runner to set (`docs/ops/crews.md`) |

A roll is deliberately dumb: mark the active sessions `rolled` so the next
turn finds none to resume. Nothing is deleted — the rows stay for the
re-brief path (§4.16 rule 6). Each roll writes one `runs` row,
`kind = session_roll`, carrying the thread, the reason
(`decision_answered` | `task_closed:#<id>`) and the **turn count the session
reached**; every turn row also carries `meta.session_turns`, which is the
denominator for per-session cost and cache measures. Rolling a thread with
nothing active writes no row, so a repeated boundary event is not a repeated
roll.

```sql
-- when sessions rolled, why, and how far they got
SELECT ts, meta->>'thread' AS thread, meta->>'reason' AS reason, (meta->>'turns')::int AS turns
FROM runs WHERE kind = 'session_roll' ORDER BY ts DESC;

-- spend by tier over the last week
SELECT meta->>'tier' AS tier, meta->>'effort' AS effort, count(*), sum(cost_usd)
FROM runs WHERE component = 'assistant' AND kind = 'turn' AND ts > now() - interval '7 days'
GROUP BY 1, 2 ORDER BY 4 DESC NULLS LAST;
```

## Why the assistant's scope is configuration, not a grant

External agents get scope from grants you issue in the UI. The assistant
is the *owner's own* assistant — the hub's voice, not a foreign party —
so its scope comes from the environment (a file in your hand, like the
instance repo's protected paths) and is **re-synced on every console
start**: token hash, grants and projects are replaced from `.env`. That
has two consequences worth knowing:

- The registry UI's grant/project edits on `assistant` hold only until
  the next restart. Edit `.env` instead.
- A UI **revoke** likewise holds until restart; the durable off switch is
  unsetting `METISTRY_ASSISTANT_TOKEN`, which revokes the row on the next
  start.
- `request_access` used to refuse an internal principal for exactly that
  reason: an approved ask would widen the stored grants and the next start
  would put them back, which is worse than no mechanism — you would believe
  you had granted it. **Since 2026-09-19 it may ask** (the owner's ruling:
  "the assistant should be able to ask"), because the approval is no longer
  only in `agents.grants`. Approving an `access_request` for an internal row
  also writes `agent_grant_overrides` (migration 0023), and
  `ensureInternalAgent` MERGES those areas on top of the configured ones at
  every start. So:
  - `METISTRY_ASSISTANT_AREAS` is the floor and still narrows everything you
    have not explicitly approved;
  - an approved area survives restarts, and is one row you can read in
    `psql` beside the proposal it came from;
  - revoking the assistant (unsetting `METISTRY_ASSISTANT_TOKEN`) clears its
    approvals, which is also how you take one back.

  A **crew** is still refused at the decision: its scope is `scope:` in a
  manifest the crew sync re-reads, and there is no override table for that —
  edit the file.

**Grant width — the internal rule.** `validateGrants` refuses a bare vault
grant for an external agent (an area grant is a prefix; "everything" is not
an area) and requires TitleCase segments. For a `kind: internal` row — and
only there — the bare vault is admitted, and it is the default (the exact
sentinel spelling, now that the vault root is the instance root itself
rather than a `Knowledge/` subfolder, is a detail of the grant-validation
code updated alongside `metistry migrate-layout`). That is what lets
the assistant read root notes such as `now.md`, which sit under
no area prefix (the gap reported when the tools shipped is closed; the
integration test that proves it is `apps/console/test/brain.integration.test.ts`).
The management API keys the rule on the *row's* kind, never on the
request, so an external agent can never be granted the bare vault by a
typo in the UI.

**Narrow it** with `METISTRY_ASSISTANT_AREAS=Areas/Fsl` and/or
`METISTRY_ASSISTANT_PROJECTS=drey,fsl-2026`; both are validated exactly as
the management API validates them, and a bad value fails console startup
loudly rather than landing a partial grant. Narrowing the areas narrows
writes too: `knowledge_write` refuses any path outside the grant.

## What a write is

`knowledge_write {path, content, message, expected_sha256?}` is a
whole-file replace that lands on the reconciler's working tree at once
and is committed on its next flush (~30 s), author `Metistry assistant`,
`Brain-Source: assistant` trailer, **one commit per reply**: the intent
carries the reply's turn handle and the call's `runs.id`, which become the
commit's act and its `Metistry-Turn:` / `Metistry-Run:` trailers
(docs/ops/reconciler.md, "The committer").
Layers, honest about which carry the load:

1. **Who.** Only a `kind: internal` principal reaches the write at all;
   `requests_create`/`capture` remain the door for everyone else (§4.11 one writer).
2. **Where.** The bridge accepts vault-root paths only, inside the grant;
   behind it the reconciler refuses everything under `.metistry/` (except
   `.metistry/state/`) plus root `CLAUDE.md` — the §4.7 protected set
   (`identity.yaml`, `rules.yaml`, `sources.yaml`, `deployment.yaml`,
   `queries/`, `agents/`, `routines/`, `extensions/`,
   `instance-migrations/`) — for every principal but `user`, plus
   traversal, `.git`, symlinks and casing slips. Two
   independent refusals; the assistant cannot touch how the system
   behaves.
3. **`Me/` and the user's own journal.** `Me/` is discovered, never assumed
   (daily-flow-spec §6.6), and `Journal/<date>.md` / `Journal/Meetings/**`
   are the user's alone, full stop (§5.1 D10 — "I can stay focused on
   `Journal/date.md`, and you can keep a continuous set of edits going in
   `Journal/Plan/*` and `Journal/Fold/*`"). `core`'s `may()` refuses a write
   under either — `forbidden`, "belongs to the owner alone… Report what you
   needed with `requests_create`" — **before** the ownership check below
   ever runs, so a brand-new page is refused exactly like an existing one;
   no area grant, not even the assistant's own default bare-vault one,
   reaches them. `Journal/Plan/`, `Journal/Fold/` and `Journal/Standup/` are
   each a routine's own reserved subdirectory and are untouched by this
   rule. The same check runs a second time at the reconciler's bridge
   (`apps/reconciler/src/paths.ts`'s `writeAllowed`), because a routine's own
   commit (`plan-tomorrow`, the fold's routine half) reaches the vault
   directly and never asks `may()` at all.
4. **Ownership** (one writer, but not one owner — docs/ops/knowledge-fold.md
   "The guardrail at the tool"). An existing markdown note is refused
   (`forbidden`, "owned by \<source\>; propose instead") unless its
   frontmatter `source` is the assistant's own credential id or the evening
   fold's; new notes are always free. A note with **no `source:` at all is
   the user's**, not ownerless — that is exactly what a note you wrote by
   hand in Obsidian looks like, and `knowledge_write`'s whole-file replace
   must not be the thing that quietly overwrites it (2026-09-19; the
   original default read "no source" as "free to write", which was the
   hole). The one exemption is `now.md` at the vault root by exact name, so
   an instance whose seed predates this fix is not locked out of the note
   the assistant is required to keep writing — it disappears the moment
   `now.md` is stamped once. Ownership is read from the note ALREADY ON
   DISK, never from the incoming `content`, so a write cannot claim a note
   it does not already own by forging frontmatter in what it sends.
5. **Provenance.** A markdown write gets `source: assistant` and
   `updated: <today>` merged into its frontmatter — replaced if present,
   appended if not, every other line kept byte for byte, nothing else
   invented. `source` is the credential, so a note claiming another
   author is corrected, not trusted. A block that is not a YAML mapping
   is refused, not guessed at.
6. **No lost updates, and no way to ask for one.** `knowledge_read`
   returns the note's `sha256`; the assistant passes it back as
   `expected_sha256`. A concurrent edit (yours in Obsidian, say) turns the
   write into `conflict` carrying the current hash, and the prompt tells it
   to re-read and redo the edit. **Omitting `expected_sha256` means
   create-only** (the bridge gets `""`): an existing note comes back
   `conflict` instead of being overwritten blind. There is no unconditional
   write — you edit these files by hand, and the assistant has to have seen
   the bytes it replaces (ruled 2026-09-16).
7. **Audit.** Every call — refusals included — is a `runs` row (below),
   and every landed write is a commit in the instance repo's history.

TODO: folding *approved requests* into pages is the evening routine's
job and is not built yet; until then the assistant folds them by hand
when you ask (the prompt says when).

## What the prompt says (and does not control)

`seed/assistant-prompt.md` is templated with the name and voice from
`.metistry/identity.yaml` (the only place the assistant is named — CLAUDE.md) and
tells the assistant what each tool is *for*: `capture`/`requests_create` for
anything unsettled, `knowledge_write` for settled facts (`now.md`
updates, folding an approved request, correcting a page you corrected)
with read-then-CAS and one logical change per write, `tasks_*` is the
shared list (claim, heartbeat, release), knowledge reads are logged, the
`nudge:` line is system-computed. None of that is a control — the surface
is enforced in code — it is a seed so the first turns are sensible.
Operating instructions proper still land in the instance's own root
`CLAUDE.md` later.

## Prompt hygiene (docs/research/2026-09-cost-optimization.md)

A provider's prompt cache pays off only when the prefix — system prompt,
tools, prior turns — is byte-identical across a session's turns; anything
volatile ahead of it (today's date, a note's contents, a count, presence
info) forces a full re-cache at 1.25x the read price every single turn.
Two rules, enforced rather than just documented:

- **Nothing volatile in the system prompt, ever.** `loadSystemPrompt`
  (`apps/assistant/src/prompt.ts`) reads only `.metistry/identity.yaml` and the seed
  prompt file at process startup — no clock, no `now.md`, no query result
  — so the same prompt string serves every turn of every session for the
  life of the process. `apps/assistant/test/prompt.test.ts` builds it
  under two different fake dates and asserts the output is byte-for-byte
  identical; a future change that slips a volatile value in breaks that
  test before it breaks a cache. Anything that genuinely needs to vary
  per turn (today's date, what changed since the last message) belongs in
  the first user message, never the system prompt.
- **`ops/scripts/prompt-lint.mjs`** (no dependencies, wired into CI
  alongside `check-path-case.sh`) scans `seed/assistant-prompt.md`,
  `seed/agents/**/*.md`, `skills/**/SKILL.md` and `plugins/**/SKILL.md`
  for the doc's known anti-patterns — "verify twice", "double-check", "be
  maximally thorough", "think step by step", "use a scratchpad", "never
  forget", `ALWAYS` shouted more than twice in one file, and
  `{{date}}`/`{{now}}`-style placeholders — and exits 1 with `file:line`
  on a hit. These cost 14–36% per task for no accuracy gain and, per
  CLAUDE.md's own rule, a sentence telling the model to be careful is not
  a control anyway.

## See what it did

Two kinds of `runs` rows, joined by time and thread:

- **The turn** — `component = 'assistant', kind = 'turn'`: tokens, cost,
  `meta.tools_used` (`{"mcp__brain__capture": 1, ...}`), and
  `meta.cache_read` / `meta.cache_write` (the SDK usage's
  `cache_read_input_tokens` / `cache_creation_input_tokens`; `tokens_in`
  stays the uncached count) from the SDK result. The dashboard's runs tile
  counts these as turns; spend rolls into `runs_summary`; the
  `claude-usage` collector (a local rollup of `runs`; no credential) rolls the cache fields into
  `claude.cache_read` / `claude.cache_write` metrics, and
  `claude_usage_daily` computes `cache_hit_rate = cache_read /
  (cache_read + tokens_in + cache_write)` per model-day — shown on the
  dashboard's spend panel and in the weekly review's Spend line.
  the `model` it ran on, `meta.tier` / `meta.effort` (the pair that model
  came from) and `meta.routed_by`, `meta.session_turns` (turns this SDK
  session has now taken), `meta.fresh_session` when the turn deliberately
  started a new one, and `meta.tools_used`
  (`{"mcp__brain__capture": 1, ...}`) from the SDK result. The dashboard's
  runs tile counts these as turns; spend rolls into `runs_summary`.
- **A session roll** — `component = 'assistant', kind = 'session_roll'`: see
  "Session rolls" above.
- **Each tool call** — `component = 'assistant', kind = 'tool',
  tool = <name>`, written by mcp-brain with clipped arguments (note
  content is recorded as `<N chars>`, never the text), and for knowledge
  calls the tier and areas it was judged under; a write also records the
  resulting hash, `created`, and the provenance it stamped. Refusals are
  rows too (`ok = false, error = 'forbidden' | 'conflict' | ...`).

Useful reads (named queries are the read path — invariant 3 — so add one
to your instance `queries/` if you want it on the dashboard):

```sql
-- what the assistant called in the last day, with outcomes
SELECT ts, tool, ok, error, meta->'args' AS args
FROM runs WHERE component = 'assistant' AND kind = 'tool' AND ts > now() - interval '1 day'
ORDER BY ts DESC;

-- every note the assistant wrote this week, with the commit message it gave
SELECT ts, meta->>'path' AS path, meta->>'created' AS created, meta->'args'->>'message' AS message, error
FROM runs WHERE component = 'assistant' AND kind = 'tool' AND tool = 'knowledge_write' AND ts > now() - interval '7 days'
ORDER BY ts DESC;

-- turns that used tools, and which
SELECT ts, tokens_in, tokens_out, cost_usd, meta->'tools_used' AS tools_used
FROM runs WHERE component = 'assistant' AND kind = 'turn' AND meta ? 'tools_used'
ORDER BY ts DESC;
```

And in the instance repo: `git log --author="Metistry assistant"` (or
`GET /vault/log?path=now.md` on the bridge) is the write
history; a wrong write is a revert.

What lands where: `capture` → an `inbox` row (`source = 'mcp',
source_agent = 'assistant'`) and, after `inbox-drain`, a proposal at
`external` trust; `requests_create` → a `proposals` row, kind `report`;
`request_access` → a `proposals` row, kind `access_request` (plus, when an
approval widens an internal row, one `agent_grant_overrides` row); `tasks_*`
→ the `work` table with the assistant as `claimed_by` / `created_by` and
history entries naming it; `knowledge_write` → the file on the
reconciler's working tree, then a commit. Proposals flow through the same
Needs You gate as every other agent's writes; a knowledge write is audited,
not gated (§4.7 "review is an audit, not a gate").
