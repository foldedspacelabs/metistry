# Assistant tools — the assistant as the first internal agent

Plan §4.11 rules that internal and external agents use the **same**
`mcp-brain` surface. This page is the operator's view of that for the
instance's own assistant: what it can do now, how to turn it on, how to
grant or narrow it, and where to see what it did.

## What the assistant can do

With tools mounted, every turn the engine runs can call exactly these
eighteen tools on the console's `POST /mcp` (`packages/mcp-brain`), and
nothing else — no shell, no filesystem, no git, no web (invariant 9,
enforced in `apps/assistant/src/brain.ts`, locked to the bridge's
manifest by test):

| Family | Tools | What it means for the assistant |
| --- | --- | --- |
| in | `capture`, `report` | Propose to the inbox / proposal queue for anything unsettled; you triage. |
| shared work | `tasks_list_ready`, `tasks_claim`, `tasks_heartbeat`, `tasks_update`, `tasks_release`, `tasks_create`, `tasks_mine` | Works the same shared list as every other agent — claims, leases, notes. |
| out | `knowledge_search`, `knowledge_read` | Reads the vault index and note contents (via the reconciler's vault bridge), within its grant. `knowledge_read` returns the note's `sha256`. |
| write | `knowledge_write` | **This is `brain-commit`** (plan §4.7, D5): one note under `Knowledge/` → the reconciler's `POST /vault/write` with a commit intent in the assistant's name. Internal principals only; every external agent is told "not granted". No delete, no rename — those stay your hand. |
| artifacts | `artifact_publish`, `artifact_get`, `artifact_list`, `artifact_comment`, `artifact_comment_resolve`, `artifact_dispatch_review` | Publishes versioned output into `Artifacts/<project>/<slug>/` (one commit per version via the reconciler), comments on exact versions, and sends review bundles to other agents in the same project — a dispatch across the project boundary becomes a proposal for you (§4.21). |

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
| `METISTRY_RECONCILER_URL`, `METISTRY_BRIDGE_TOKEN_RECONCILER` | console | The reconciler's vault bridge (`docs/ops/reconciler.md`). Both `knowledge_read` and `knowledge_write` go through it; unset → both answer `not_available` and the brain's `check()` is `degraded`. |
| `METISTRY_IDENTITY_FILES`, `METISTRY_PROMPT_FILES` | assistant | D4 overlays for `identity.yaml` and the seed system prompt (`seed/assistant-prompt.md`); last existing file wins. |
| `METISTRY_MAX_TURNS` | assistant | Agentic turns per message (default 12 with tools, 4 without). |

Startup logs to look for: console `internal agent 'assistant' registered`
(or `re-synced`); assistant `tools: 12 via http://console:8080/mcp (...)`
and `identity: <name>`.

**Rotate** by changing the value in `.env` and restarting both containers:
the console re-keys the row, the old token dies at once. The console's
`/api/agents` list shows the row (`assistant · internal`) with no hash,
ever.

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
   `report`/`capture` remain the door for everyone else (§4.11 one writer).
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

TODO: folding *accepted proposals* into notes is the evening routine's
job and is not built yet; until then the assistant folds them by hand
when you ask (the prompt says when).

## What the prompt says (and does not control)

`seed/assistant-prompt.md` is templated with the name and voice from
`identity.yaml` (the only place the assistant is named — CLAUDE.md) and
tells the assistant what each tool is *for*: `capture`/`report` for
anything unsettled, `knowledge_write` for settled facts (`now.md`
updates, folding an accepted proposal, correcting a note you corrected)
with read-then-CAS and one logical change per write, `tasks_*` is the
shared list (claim, heartbeat, release), knowledge reads are logged, the
`nudge:` line is system-computed. None of that is a control — the surface
is enforced in code — it is a seed so the first turns are sensible.
Operating instructions proper still land in `Knowledge/CLAUDE.md` later.

## See what it did

Two kinds of `runs` rows, joined by time and thread:

- **The turn** — `component = 'assistant', kind = 'turn'`: tokens, cost,
  and `meta.tools_used` (`{"mcp__brain__capture": 1, ...}`) from the SDK
  result. The dashboard's runs tile counts these as turns; spend rolls
  into `runs_summary`.
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
`external` trust; `report` → a `proposals` row, kind `report`; `tasks_*`
→ the `work` table with the assistant as `claimed_by` / `created_by` and
history entries naming it; `knowledge_write` → the file on the
reconciler's working tree, then a commit. Proposals flow through the same
triage gate as every other agent's writes; a knowledge write is audited,
not gated (§4.7 "review is an audit, not a gate").
