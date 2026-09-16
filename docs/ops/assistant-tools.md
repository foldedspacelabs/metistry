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
| in | `capture`, `requests_create` | Raise anything unsettled into the inbox / your Needs You queue; you approve, revise, or decline. |
| shared work | `tasks_list` (`filter: ready \| mine \| all`), `tasks_claim`, `tasks_renew`, `tasks_update`, `tasks_release`, `tasks_close`, `tasks_create` | Works the same shared list as every other agent — claims, leases, notes, and `tasks_close` to finish one in a single call. |
| rooms | `tasks_comment`, `tasks_thread` | The conversation on a task ([threads.md](threads.md)) — say what you found, read what the last crew left. Nobody is addressed by it, so nothing is woken; use `agents_delegate` when someone has to act. Resolving a room is your hand in the console, not a tool. |
| out | `knowledge_search`, `knowledge_read`, `knowledge_list`, `knowledge_grep` | Reads the knowledge index, page contents, a directory listing, and a content regex (all via the reconciler's vault bridge), within its grant — `knowledge_list`/`knowledge_grep` are filesystem semantics over the same tiers `knowledge_search`/`knowledge_read` already enforce (docs/research/2026-09-stash-review.md item 3). `knowledge_read` returns the page's `sha256`. |
| write | `knowledge_write` | **This is `brain-commit`** (plan §4.7, D5): one page under `Knowledge/` → the reconciler's `POST /vault/write` with a commit intent in the assistant's name. Internal principals only; every external agent is told "not granted". No delete, no rename — those stay your hand. |
| artifacts | `artifacts_publish`, `artifacts_get`, `artifacts_list`, `artifacts_comment`, `artifacts_resolve`, `artifacts_review` | Publishes versioned output into `Artifacts/<project>/<slug>/` (one commit per version via the reconciler), comments on exact versions, and sends review bundles to other agents in the same project — a review sent across the project boundary becomes a request for you (§4.21). |
| helper agents | `agents_delegate` | Hands a brief to a helper agent you defined in `agents/<area>/<name>.md` (`docs/ops/crews.md`). Internal principals only; the brief is policy-checked against the helper's scope before a durable work row is written; results come back as the helper's own `requests_create` requests. |
| queries | `queries_list`, `queries_run` | Runs a named query from `seed/queries/` or the instance's `queries/` (invariant 3 — the one read path) for anything you'd otherwise have to guess at or ask the user to look up. Internal principals always have this; an external agent needs an explicit `queries: true` grant. Rows cap at 200. |

**Deprecated spellings, one release.** The 2026-09-09 vocabulary
simplification renamed eleven of these (`docs/product/glossary.md`). The old
names still work — `report`, `tasks_list_ready`, `tasks_mine`,
`tasks_heartbeat`, `artifact_*`, `crew_dispatch` — but they are resolved at
call time and are **not** in `tools/list`, so the surface an agent discovers is
the twenty-three above. An alias call is audited under the primary name with the old
spelling in `runs.meta.alias`:

```sh
psql -c "SELECT meta->>'alias' AS old, tool AS now, count(*) FROM runs
         WHERE meta ? 'alias' GROUP BY 1, 2 ORDER BY 3 DESC"
```

An empty result is the signal that the aliases can come out.

Every call also takes an optional `turn_id` (`seed/assistant-prompt.md`
tells the assistant to make one up per reply and reuse it on every call
within that reply); it lands in the `runs` row's `meta.turn_id`, and the
`activity_feed` query surfaces it so one reply's calls group together.

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
| `METISTRY_ASSISTANT_AREAS` | console | Comma-separated `Knowledge/` prefixes for the grant. Default `Knowledge/` — the whole vault, root notes included (below). |
| `METISTRY_RECONCILER_URL`, `METISTRY_BRIDGE_TOKEN_RECONCILER` | console | The reconciler's vault bridge (`docs/ops/reconciler.md`). `knowledge_read`, `knowledge_write`, `knowledge_list`, and `knowledge_grep` all go through it; unset → all answer `not_available` and the brain's `check()` is `degraded`. |
| `METISTRY_IDENTITY_FILES`, `METISTRY_PROMPT_FILES` | assistant | D4 overlays for `identity.yaml` and the seed system prompt (`seed/assistant-prompt.md`); last existing file wins. |
| `METISTRY_RULES_FILES` | console + assistant | D4 overlay for `rules.yaml` (default `seed/rules.yaml:rules.yaml`). The console reads the fast paths and the tier menu; the assistant reads the **same `tiers:` block** to resolve a tier name to (model, effort). Unreadable by the assistant → one tier, `METISTRY_MODEL_DEFAULT` at medium effort. |
| `METISTRY_MAX_TURNS` | assistant | Agentic turns per message (default 12 with tools, 4 without). |

Startup logs to look for: console `internal agent 'assistant' registered`
(or `re-synced`); assistant `tools: 23 via http://console:8080/mcp (...)` (the count tracks `packages/mcp-brain/manifest.yaml`)
and `identity: <name>`.

**Rotate** by changing the value in `.env` and restarting both containers:
the console re-keys the row, the old token dies at once. The console's
`/api/agents` list shows the row (`assistant · internal`) with no hash,
ever.

### Running without an engine

An install with **no engine credential** is a supported shape, not a broken
one. Under the launchd shape `metistry up` leaves the assistant out of the
supervisor's children rather than starting a process that can only
crash-loop, and prints one line:

```
assistant: absent — no engine credential (CLAUDE_CODE_OAUTH_TOKEN); captures, tasks, search and the console run; fold turns wait (docs/ops/assistant-tools.md)
```

`metistry doctor` reports `assistant  service  absent` with the same
remediation, and it is **not** a failure — exit 0. Everything model-free
keeps working: captures land, `inbox-drain` classifies them deterministically
into proposals, tasks and search and the console and the reconciler all run.
What waits is the engine's queue — the evening fold's turn sits in
`inbound_messages` until there is a model — and the watchdog knows it:
`assistant-drain` reports `absent` (no alert) while the assistant is not a
child, instead of paging you every minute about a queue nobody is draining.

Add the credential and re-run `metistry up`: the supervisor's config is
rewritten whole each time, so the child is simply back — and taking the
credential away again removes it, with nothing to hand-edit either way.

```sh
claude setup-token                      # → CLAUDE_CODE_OAUTH_TOKEN
# put it in <instance>/state/.env, then file it in the login Keychain:
metistry secrets sync --to keychain
metistry up
```

The **compose shape still needs it**: `docker-compose.yml` interpolates
`CLAUDE_CODE_OAUTH_TOKEN` as a required variable, so `docker compose up`
refuses the whole file without one. An install that wants to run engine-less
today runs the launchd shape (`docs/ops/deployment-shapes.md`).

## Tiers: (model, effort) pairs

A **tier** is a model *and* an effort level, chosen together — a stronger
model at low effort is often cheaper than a weaker one working hard
(`docs/research/2026-09-cost-optimization.md`, decision 2). Tiers live in
`rules.yaml`, so an instance overlay (D4) moves them:

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
instruction.** One SDK query per turn, its options built once from that turn's
tier and never mutated mid-stream (`buildQueryOptions`). Two consecutive turns
on one session at one tier produce byte-identical options, which is the point:
changing model, effort, tools or system prompt mid-session invalidates the
cached prompt prefix, and a break costs up to 50x the cache-read price per
token. There is a test for exactly that (`apps/assistant/test/brain.test.ts`).

Startup log: `tiers from seed/rules.yaml: fast=haiku/low default=haiku/medium
deep=opus/high routine=haiku/low`. No rules file at all → one tier, the
`METISTRY_MODEL_DEFAULT` model at medium, and a warning.

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

**Grant width — the internal rule.** `validateGrants` refuses bare
`Knowledge/` for an external agent (an area grant is a prefix; "everything"
is not an area) and requires TitleCase segments. For a `kind: internal`
row — and only there — the bare vault is admitted, spelled `Knowledge/`
(`Knowledge` normalizes to it), and it is the default. That is what lets
the assistant read root notes such as `Knowledge/now.md`, which sit under
no area prefix (the gap reported when the tools shipped is closed; the
integration test that proves it is `apps/console/test/brain.integration.test.ts`).
The management API keys the rule on the *row's* kind, never on the
request, so an external agent can never be granted the bare vault by a
typo in the UI.

**Narrow it** with `METISTRY_ASSISTANT_AREAS=Knowledge/Areas/Fsl` and/or
`METISTRY_ASSISTANT_PROJECTS=drey,fsl-2026`; both are validated exactly as
the management API validates them, and a bad value fails console startup
loudly rather than landing a partial grant. Narrowing the areas narrows
writes too: `knowledge_write` refuses any path outside the grant.

## What a write is

`knowledge_write {path, content, message, expected_sha256?}` is a
whole-file replace that lands on the reconciler's working tree at once
and is committed on its next flush (~30 s), author `Metistry assistant`,
`Brain-Source: assistant` trailer, one commit per agent per flush window
(the intent's group is the agent id — a turn id is not on the wire).
Layers, honest about which carry the load:

1. **Who.** Only a `kind: internal` principal reaches the write at all;
   `requests_create`/`capture` remain the door for everyone else (§4.11 one writer).
2. **Where.** The bridge accepts `Knowledge/...` only, inside the grant;
   behind it the reconciler refuses the §4.7 protected set
   (`identity.yaml`, `rules.yaml`, `sources.yaml`, `deployment.yaml`,
   `CLAUDE.md`, `queries/`, `agents/`, `routines/`, `extensions/`,
   `instance-migrations/`) for every principal but `user`, plus
   traversal, `.git`, symlinks and `knowledge/` casing slips. Two
   independent refusals; the assistant cannot touch how the system
   behaves.
3. **Provenance.** A markdown write gets `source: assistant` and
   `updated: <today>` merged into its frontmatter — replaced if present,
   appended if not, every other line kept byte for byte, nothing else
   invented. `source` is the credential, so a note claiming another
   author is corrected, not trusted. A block that is not a YAML mapping
   is refused, not guessed at.
4. **No lost updates.** `knowledge_read` returns the note's `sha256`; the
   assistant passes it back as `expected_sha256`. A concurrent edit (yours
   in Obsidian, say) turns the write into `conflict` carrying the current
   hash, and the prompt tells it to re-read and redo the edit. `""` means
   create-only.
5. **Audit.** Every call — refusals included — is a `runs` row (below),
   and every landed write is a commit in the instance repo's history.

TODO: folding *approved requests* into pages is the evening routine's
job and is not built yet; until then the assistant folds them by hand
when you ask (the prompt says when).

## What the prompt says (and does not control)

`seed/assistant-prompt.md` is templated with the name and voice from
`identity.yaml` (the only place the assistant is named — CLAUDE.md) and
tells the assistant what each tool is *for*: `capture`/`requests_create` for
anything unsettled, `knowledge_write` for settled facts (`now.md`
updates, folding an approved request, correcting a page you corrected)
with read-then-CAS and one logical change per write, `tasks_*` is the
shared list (claim, heartbeat, release), knowledge reads are logged, the
`nudge:` line is system-computed. None of that is a control — the surface
is enforced in code — it is a seed so the first turns are sensible.
Operating instructions proper still land in `Knowledge/CLAUDE.md` later.

## Prompt hygiene (docs/research/2026-09-cost-optimization.md)

Anthropic's prompt cache pays off only when the prefix — system prompt,
tools, prior turns — is byte-identical across a session's turns; anything
volatile ahead of it (today's date, a note's contents, a count, presence
info) forces a full re-cache at 1.25x the read price every single turn.
Two rules, enforced rather than just documented:

- **Nothing volatile in the system prompt, ever.** `loadSystemPrompt`
  (`apps/assistant/src/prompt.ts`) reads only `identity.yaml` and the seed
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
  `claude-usage` collector rolls the cache fields into
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
`GET /vault/log?path=Knowledge/now.md` on the bridge) is the write
history; a wrong write is a revert.

What lands where: `capture` → an `inbox` row (`source = 'mcp',
source_agent = 'assistant'`) and, after `inbox-drain`, a proposal at
`external` trust; `requests_create` → a `proposals` row, kind `report`; `tasks_*`
→ the `work` table with the assistant as `claimed_by` / `created_by` and
history entries naming it; `knowledge_write` → the file on the
reconciler's working tree, then a commit. Proposals flow through the same
Needs You gate as every other agent's writes; a knowledge write is audited,
not gated (§4.7 "review is an audit, not a gate").
