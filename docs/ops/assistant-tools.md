# Assistant tools — the assistant as the first internal agent

Plan §4.11 rules that internal and external agents use the **same**
`mcp-brain` surface. This page is the operator's view of that for the
instance's own assistant: what it can do now, how to turn it on, how to
grant or narrow it, and where to see what it did.

## What the assistant can do

With tools mounted, every turn the engine runs can call exactly these
eleven tools on the console's `POST /mcp` (`packages/mcp-brain`), and
nothing else — no shell, no filesystem, no git, no web (invariant 9,
enforced in `apps/assistant/src/brain.ts`, locked to the bridge's
manifest by test):

| Family | Tools | What it means for the assistant |
| --- | --- | --- |
| in | `capture`, `report` | Propose to the inbox / proposal queue. It never writes knowledge; you triage. |
| shared work | `tasks_list_ready`, `tasks_claim`, `tasks_heartbeat`, `tasks_update`, `tasks_release`, `tasks_create`, `tasks_mine` | Works the same shared list as every other agent — claims, leases, notes. |
| out | `knowledge_search`, `knowledge_read` | Reads the vault index and (once the knowledge module lands a read path) note contents, within its grant. |

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
| `METISTRY_ASSISTANT_AREAS` | console | Comma-separated TitleCase `Knowledge/` prefixes for the read grant. Default: the widest the validator admits (below). |
| `METISTRY_IDENTITY_FILES`, `METISTRY_PROMPT_FILES` | assistant | D4 overlays for `identity.yaml` and the seed system prompt (`seed/assistant-prompt.md`); last existing file wins. |
| `METISTRY_MAX_TURNS` | assistant | Agentic turns per message (default 12 with tools, 4 without). |

Startup logs to look for: console `internal agent 'assistant' registered`
(or `re-synced`); assistant `tools: 11 via http://console:8080/mcp (...)`
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

**Grant width.** `validateGrants` refuses bare `Knowledge` on purpose (an
area grant is a prefix; "everything" is not an area) and requires
TitleCase segments. The widest *valid* grant is therefore the union of
the note-bearing top-level folders of plan §4.15:
`Knowledge/Areas, Knowledge/Projects, Knowledge/Resources,
Knowledge/Techniques, Knowledge/Journal, Knowledge/People, Knowledge/Me`
— the default. Known gap: root-level notes such as `Knowledge/now.md`
are under none of these prefixes, so the assistant cannot search or read
them through `knowledge_*`. That is reported, not routed around; widening
the validator is a plan decision.

**Narrow it** with `METISTRY_ASSISTANT_AREAS=Knowledge/Areas/Fsl` and/or
`METISTRY_ASSISTANT_PROJECTS=drey,fsl-2026`; both are validated exactly as
the management API validates them, and a bad value fails console startup
loudly rather than landing a partial grant.

## What the prompt says (and does not control)

`seed/assistant-prompt.md` is templated with the name and voice from
`identity.yaml` (the only place the assistant is named — CLAUDE.md) and
tells the assistant what each tool is *for*: `capture` for things that
came from you, `report` for things it concluded, `tasks_*` is the shared
list (claim, heartbeat, release), knowledge reads are logged, the `nudge:`
line is system-computed. None of that is a control — the surface is
enforced in code — it is a seed so the first turns are sensible.
Operating instructions proper still land in `Knowledge/CLAUDE.md` later.

## See what it did

Two kinds of `runs` rows, joined by time and thread:

- **The turn** — `component = 'assistant', kind = 'turn'`: tokens, cost,
  and `meta.tools_used` (`{"mcp__brain__capture": 1, ...}`) from the SDK
  result. The dashboard's runs tile counts these as turns; spend rolls
  into `runs_summary`.
- **Each tool call** — `component = 'assistant', kind = 'tool',
  tool = <name>`, written by mcp-brain with clipped arguments, and for
  knowledge calls the tier and areas it was judged under. Refusals are
  rows too (`ok = false, error = 'forbidden' | 'not_found' | ...`).

Useful reads (named queries are the read path — invariant 3 — so add one
to your instance `queries/` if you want it on the dashboard):

```sql
-- what the assistant called in the last day, with outcomes
SELECT ts, tool, ok, error, meta->'args' AS args
FROM runs WHERE component = 'assistant' AND kind = 'tool' AND ts > now() - interval '1 day'
ORDER BY ts DESC;

-- turns that used tools, and which
SELECT ts, tokens_in, tokens_out, cost_usd, meta->'tools_used' AS tools_used
FROM runs WHERE component = 'assistant' AND kind = 'turn' AND meta ? 'tools_used'
ORDER BY ts DESC;
```

What lands where: `capture` → an `inbox` row (`source = 'mcp',
source_agent = 'assistant'`) and, after `inbox-drain`, a proposal at
`external` trust; `report` → a `proposals` row, kind `report`; `tasks_*`
→ the `work` table with the assistant as `claimed_by` / `created_by` and
history entries naming it. All of it flows through the same triage gate
as every other agent's writes.
