# Devin and Cursor as Metistry surfaces (2026-09-15)

The owner is standing up a second instance for a separate context. Knowledge is arriving that needs organising;
three agents (Devin, Claude Code, Cursor) need access to it; Devin is already
connected to almost everything in that context and holds context on the code, culture,
process and tech that Metistry will need. Devin is currently organising the
docs by hand, which is the thing to replace.

This note verifies what Devin and Cursor actually expose (official docs,
fetched 2026-09-15) and then proposes — **proposal, not decision** — how each
maps onto primitives Metistry already has. Nothing here is built.

The short version: **three of the four integrations need no product code at
all**, because Devin can be an external agent at the console's `/mcp` and
Cursor can mount `/mcp` from a config file. The two that need code are a
collector (Devin knowledge → inbox) and a dispatcher (a work row → a Devin
session). None of it depends on the compute pivot's PR 1.

## 1. Devin — verified

**(a) Sessions API.** `POST https://api.devin.ai/v3/organizations/{org_id}/sessions`,
`Authorization: Bearer cog_…`. Only `prompt` is required; the useful optional
fields are `title`, `tags`, `repos`, `playbook_id`, `knowledge_ids`,
`max_acu_limit`, `attachment_urls`, `create_as_user_id`,
`structured_output_schema` (Draft-7, max 64 KB, self-contained) and
`structured_output_required` (default **true** — "the agent MUST call
`provide_structured_output` with `is_final=true` before its turn ends").
Also get, list, list/send messages, attachments, tags, terminate, archive and
per-session ACU consumption. Two token types, both `cog_`: **service-user keys**
(org or enterprise scope, RBAC'd, Settings → Service users) and **personal
access tokens** (act as you, `X-Org-Id` per request). Legacy `apk_` keys work on
v1/v2 but are deprecated and **rejected by the Devin MCP server**. No published
rate limits — `429` is in the status-code table only.

**(b) Custom MCP — yes, and this is the key finding.** Devin takes custom
servers on **STDIO, SSE or HTTP (Streamable HTTP)** at **personal,
organization or enterprise** scope, from Customize → MCPs. For remote servers
the auth method is `None`, `Auth Header` or `OAuth`; Auth Header defaults the
key to `Authorization` and takes a value like `Bearer <token>`:

```json
{ "transport": "HTTP", "url": "https://mcp.internal-service.example.com/mcp",
  "auth_method": "auth_header",
  "headers": { "Authorization": "Bearer your-api-token" } }
```

"HTTP (Streamable HTTP) is recommended for new integrations." A **Test listing
tools** button spins up an isolated environment and does tool discovery — a free
conformance check against `core`'s wire contract. Personal scope needs no admin.

**(c) Knowledge sources.** Three, all real:
- **DeepWiki MCP**, `https://mcp.deepwiki.com/mcp` — free, no auth, **public
  repos only**: `read_wiki_structure`, `read_wiki_contents`, `ask_question`.
- **Devin MCP**, `https://mcp.devin.ai/mcp` — authenticated (`cog_` only),
  **public and private** repos, and far more than wikis: the four wiki/search
  tools plus `list_available_repos`, `devin_session_create|search|interact|
  events|gather`, `devin_playbook_manage`, `devin_knowledge_manage` (full CRUD
  on knowledge notes, plus folders and pending suggestions),
  `devin_schedule_manage`, `devin_list_integrations`.
- **REST**, for a collector: v3 `…/knowledge/notes` (full CRUD) and
  `…/knowledge/folders` (tree with per-folder counts); v1 equivalents under
  `/v1/knowledge`. Playbooks have the same shape. So the reverse direction —
  vault note → Devin Knowledge — **is** possible. Items carry a trigger
  description, an optional `!macro`, and a folder.

**(d) No outbound completion event.** Automations are **inbound** only
(Slack / GitHub / GitLab / Linear / Jira / PagerDuty / schedule / incoming
webhook → start session, message session, triage, **email notification**). There
is no "session finished" webhook to a URL you own, so a result path is **poll**
`GET …/sessions/{id}` or have the session **report back itself** over MCP.
Automations carry a per-session max-ACU and an invocation cap — the right
precedent for a dispatch budget.

**(e) Data policy, and it matters.** From `admin/security.md`: "By default, we
may use your data for model training purposes… If you're on a paid plan, you
can opt out at any time on the Data Controls settings page. After you opt out,
your data will not be used for training and Zero Data Retention will be enabled
with our model providers. **On the Teams plan, only an administrator can
exercise the opt-out.**" Enterprise: never without written consent. SOC 2 Type
II. Separately, **Security Profiles** can restrict a session's **MCP allowlist**
("sessions governed by the profile can only use the listed servers"), force
**Devin MCP read-only**, and intersect when layered — "no organization,
automation, or session can widen access beyond the enterprise policy".
Usefully, "MCP access is managed independently of the network policy: you do
**not** need to add an MCP server's address to the network allowlist."

## 2. Cursor — verified

**(a) MCP.** `.cursor/mcp.json` (project) and `~/.cursor/mcp.json` (global);
transports stdio, SSE and Streamable HTTP; remote servers take `url` +
`headers`. Static OAuth client credentials are supported for providers without
dynamic registration. Decisively for us, **config interpolation** resolves
`${env:NAME}` (and `${userHome}`, `${workspaceFolder}`) in `command`, `args`,
`env`, **`url` and `headers`** — so the agent token never has to be written to
disk.

**(b) Hooks — yes, and richer than Claude Code's.** `hooks.json` at
`<project>/.cursor/hooks.json` or `~/.cursor/hooks.json`, `"version": 1`,
command-based, **JSON over stdio in both directions**, per-hook `timeout`
(seconds) and `failClosed`. `sessionEnd` exists: "Called when a composer
conversation ends. This is a fire-and-forget hook useful for logging,
analytics, or cleanup tasks." Its input is `session_id`, `reason`
(`completed|aborted|error|window_close|user_close`), `duration_ms`,
`is_background_agent`, `final_status`, `error_message` — plus the fields
**every** hook receives: `conversation_id`, `generation_id`, `model`,
`hook_event_name`, `cursor_version`, `workspace_roots`, `user_email`, and
**`transcript_path`** ("null if transcripts disabled").

And: **Cursor loads Claude Code hooks.** With "Include third-party Plugins,
Skills, and other configs" enabled, it reads `~/.claude/settings.json` and
`.claude/settings.json`, maps `SessionEnd` → `sessionEnd`, accepts both the
nested `hookSpecificOutput` and flat response formats, and honours exit code 2
as a block. Note the caveat in the same page: "The feature must be enabled for
your account."

**(c) Cloud Agents / CLI as a compute target.** `POST https://api.cursor.com/v1/agents`
(Bearer or Basic; user key or service-account key), then runs, `GET …/runs/{id}`,
a **stream** endpoint, artifacts and usage. `agentId` (`bc-<uuid>`) makes create
idempotent — re-POSTing returns `409 agent_id_conflict`. **"Webhooks are coming
soon"**; only the legacy v0 API has them. Public beta. Separately the local CLI
(`agent`, install via `curl https://cursor.com/install -fsS | bash`) has a
print mode `agent -p "…" --output-format text` for scripts, and cloud agents run
**project** hooks from `.cursor/hooks.json` (not user-level ones).

**(d) Rules.** `.cursor/rules/*.mdc` — frontmatter `description`, `globs`,
`alwaysApply`; `alwaysApply: true` is always injected, `false` + a
`description` means "Agent reads the description and pulls the rule in when
relevant". A plain `.md` in that directory is **ignored**. `AGENTS.md` in the
project root (and, now, nested in subdirectories) is the frontmatter-free
alternative. Precedence: Team → Project → User.

## 3. Claude Code — unchanged

Nothing found changes `plugins/claude-code`'s shape. Its `SessionEnd` hook,
dependency-free `.mjs`, `POST /capture` with an `idempotency_key`, and the
`session-parity.test.ts` lock against `packages/core/src/session-summary.ts`
all stand. Cursor's third-party loading is a bonus, not a constraint: it reads
our config, we do not have to write theirs. One thing to *not* do — do not move
the hook's payload handling toward Cursor's shape to serve both; see §7.

## 4. Proposal A — Devin as an external agent at `/mcp`

Devin's custom-MCP support (§1b) and the console's external-agent registry meet
exactly. Mint a row, hand Devin the token, and Devin gets the same 20-tool
surface any external principal gets, governed server-side.

```
POST /api/agents        {"id":"devin","display_name":"Devin (work)","kind":"external"}
  → 201 {"id":"devin","token":"…"}        # the ONE time the token crosses the wire
PUT  /api/agents/devin/grants    {"tier":"areas","areas":["Knowledge/Areas/…"]}
PUT  /api/agents/devin/projects  ["new-job-onboarding"]
```

**Correction to the framing this note was commissioned under.** There is no
per-tool grant list to write. `validateGrants` (`apps/console/src/agents.ts`)
takes `{tier: none|index|areas, areas: [TitleCase Knowledge/…], queries: bool}`
— nothing else. Tool availability is decided by **principal kind** at the
bridge: an external agent already cannot reach `knowledge_write` or
`agents_delegate` ("not granted"), and `queries_*` needs the `queries` grant.
So "no `knowledge_write` by default" is not something to configure — it is
true by construction. Likewise **`autonomy: propose` does not exist yet**:
today's `validateAutonomy` accepts only `may_dispatch_to`, `accept_from` and
`max_open_bundles`. `autonomy.level: observe|propose|act_within_scope` is adopt
**A3**, blocked on OPEN-2. Until it lands, "propose" is the *de facto*
behaviour: everything Devin returns arrives as a `proposals` row for the owner
to triage.

What Devin can then do: `knowledge_search` / `knowledge_read` /
`knowledge_list` / `knowledge_grep` within its areas, `capture` into the inbox,
`requests_create` to raise a finding into Needs You, and `tasks_*` /
`artifacts_*` inside its projects. The collaboration rule holds by absence —
**C7**: a Claude turn may create *unassigned* work Devin discovers with
`tasks_list` and takes with `tasks_claim`; a *directed* push to a named
non-Claude agent is refused at the console with a `runs` row. There is no tool
to violate it with.

Two gates, both outside the code. The Metistry origin must be **reachable from
Devin's cloud** — a tailnet address will not do, which is invariant 8's "the
network is not a boundary" arriving as a bill rather than a principle; the
example.com gateway is the candidate. And a mandatory **Security Profile**
MCP allowlist (§1e) can make this impossible without an admin.

## 5. Proposal B — Devin as a compute target

`targets/devin-sessions/manifest.yaml`, for "Devin for debugging and research":
a work row the owner (or the assistant) dispatches, the answer landing as a
report to triage.

```yaml
name: devin-sessions
type: target
description: Dispatch a task to a Devin session — debugging and research
transport: http
submit:
  url: https://api.devin.ai/v3/organizations/{org}/sessions   # org from env
  # proposed additions, see below: max_acu, structured_output_schema
result:
  via: report_queue
  status_via: devin-sessions        # a poller; Devin has no completion webhook
auth: env:METISTRY_DEVIN_API_KEY    # user scope in the Keychain (C6)
cost: { per_run_estimate_usd: 0 }   # real cost is ACUs, read back per session
data_policy:
  allow: [Knowledge/Areas/<that instance's areas>, Knowledge/Projects]
  deny_sources: [comms]
  max_brief_bytes: 16384
```

`checkBrief` in `apps/console/src/dispatch.ts` already enforces all three
policy fields before anything leaves the machine, and a refusal is a `runs` row
with `meta.violations`. That part is free.

**What this needs that `github-issues` does not have.** Four things, and the
first is a hard blocker:

1. **A dispatcher for `transport: http`.** Today only `github` and `local` have
   one; `dispatch()` refuses every other transport with `invalid_request`
   ("a registered target is never a silent no-op"). This is the only real code
   in proposal B.
2. **A content return path, not just a status one.** `github-issues` carries an
   explicit `TODO(report-queue)`: `github-state` closes the work row when the
   issue closes but never fetches comments, so *status* returns and *content*
   does not. Devin has the same gap and no webhook to close it. **The cheapest
   fix is to compose B with A**: the brief tells Devin to call `requests_create`
   on Metistry's `/mcp` with the task id, so the report arrives through the queue
   every agent already uses, authenticated as `devin`, and the poller only moves
   the work row's status. That is a new pattern worth naming — *the same
   external system is both a target and a principal*.
3. **A per-dispatch budget field.** `cost.per_run_estimate_usd` is a static
   estimate written to `runs.cost_usd`, not a cap. Devin takes `max_acu_limit`
   per session, so the manifest wants something like `submit.max_acu` that the
   dispatcher passes through. This is the same shape as C5's budgets but it is
   the *target's* ceiling, not the engine's, so it does not wait on PR 1.
4. **A structured-output contract.** `structured_output_required` defaults to
   **true**, so a dispatch that sends no schema is asking for an unvalidated
   blob. Sending a small Draft-7 schema (finding, evidence, files, confidence)
   makes the return machine-checkable before it becomes a proposal — strictly
   better than an issue comment, and worth stating as the reason to prefer this
   target over `github-issues` for research.

Idempotency: v1 has an `idempotent` boolean; the v3 create endpoint documents
no `Idempotency-Key` header. Until confirmed, dedupe on our side by tagging the
session with the work row id and searching tags before creating.

## 6. Proposal C — Devin as a knowledge source: a collector, not a bridge

The question this note was asked to settle — `collectors/devin-knowledge` or
`packages/mcp-deepwiki`? — is settled by the repo, not by Devin's API. **The
assistant mounts exactly one MCP server.** `brainOptions` in
`apps/assistant/src/brain.ts:86` sets `mcpServers: { [BRAIN_SERVER]: server }`
with `strictMcpConfig`, and `crews.md` states the same for crews: "foreign MCP
config is ignored — invariant 9 holds for a crew exactly as for the
assistant." So there is no seat for `mcp.devin.ai` in Metis's toolset, and a
first-party `packages/mcp-deepwiki` would be a package with no caller inside
Metistry. **Ruling: a collector.** (`mcp.devin.ai` is still the right thing to
hand to *Claude Code and Cursor* — see §8 — just not to Metis.)

`collectors/devin-knowledge`, TypeScript like every other collector, exporting
`check()` so `metistry doctor` stays generic, reading `METISTRY_DEVIN_API_KEY`:

- **Devin Knowledge notes** — list `…/knowledge/notes` and `…/knowledge/folders`,
  and for each new-or-changed note `POST /capture` one file with frontmatter
  `source: devin`, `devin_note_id`, `devin_folder`, `devin_trigger`,
  `captured_at`, and an `idempotency_key` derived from note id + content hash so
  a re-run is a no-op. The fold then organises them into the vault. This is the
  direct answer to "Devin has a ton of context Metistry will need".
- **Repository wikis** — `read_wiki_structure` then `read_wiki_contents` per
  repo the owner lists (over REST or the MCP server as a plain HTTP client from
  the collector, which is not the assistant and so not bound by the one-server
  rule). One capture per wiki page, `source: devin`, `devin_repo`. This is
  "learn my new team's repositories", and it is the piece that pays off fastest.
- **Do not** pull `ask_question` output on a schedule; it spends and it is
  synthesis, not source. If the owner wants a question answered, that is a
  dispatch (proposal B), not a collector.

**A safety point that needs a decision.** `source: devin` would be a new
provenance class, and `checkBrief`'s `denied_source` scanner keys on exactly
these markers. Devin-derived notes are *work-internal* by nature, so the
moment they are in the vault they are citable in a brief to any target whose
`allow` list covers their area. Either add `devin` to `deny_sources` on the
outbound targets, or accept that that instance's knowledge can be re-exported to the
system it came from (which is harmless) and to others (which is not). The
conservative default is to add it.

**The reverse direction** (vault → Devin Knowledge) is possible —
`devin_knowledge_manage` create/update, or `POST/PUT …/knowledge/notes` — and
should **not** ship by default. Invariant 9: an outbound mutation needs an
allowlisted bridge, and this one pushes the owner's own notes into a
third-party cloud whose default is "we may train on your data" (§1e). If it is
wanted later it is a bridge with preview-then-confirm, not a collector flag.

## 7. Proposal D — Cursor as a dev tool

Two halves, and unlike OpenCode (C17) **both** are available, because Cursor has
`sessionEnd`.

**MCP, today, no code.** `metistry connect cursor` writes `~/.cursor/mcp.json`
(or `.cursor/mcp.json` with `--project`):

```json
{ "mcpServers": { "metistry": {
    "url": "https://<origin>/mcp",
    "headers": { "Authorization": "Bearer ${env:METISTRY_AGENT_TOKEN}" } } } }
```

`${env:…}` resolving inside `headers` (§2a) means the file is safe to commit if
the owner ever wants a project-level one — an improvement on the OpenCode
snippet's ergonomics, same idea.

**Capture, `plugins/cursor`, gated on one spike.** Mirror the Claude Code
plugin exactly: `.cursor/hooks.json` with `sessionEnd` → a dependency-free
`.mjs`, inert unless `METISTRY_CAPTURE_ON_STOP=1`, 8 s cap, exit 0 on every
path, `cwd` taken from `workspace_roots[0]` (Cursor sends no `cwd` at session
end), summary built from `transcript_path`, and a `fromCursor()` in
`packages/core/src/session-summary.ts` locked by a parity test on one fixture.

The spike first, because **the transcript file format is undocumented**. Today's
`summarizeTranscript` parses Claude Code's JSONL. Cursor's third-party loading
(§2b) means the *existing* plugin's hook will already be invoked by Cursor —
but `buildSummary` will read a transcript it cannot parse, fall through to
`input.last_assistant_message` (which Cursor does not send), return `null`, and
capture nothing. That is a **silent no-op, not a failure** — acceptable, and
worth saying out loud so nobody debugs it twice. Ten minutes on the owner's
machine (`echo` the payload, `head` the transcript) decides whether
`plugins/cursor` is an afternoon or a week. If the format turns out to be
opaque, the honest fallback is "MCP only, no capture" plus a note in the doc —
Cursor sessions would still reach the vault, they just would not record
themselves.

**Rules from the vault.** `metistry rules export --for cursor` writes
`.cursor/rules/metistry.mdc` with `alwaysApply: false` and a `description`, so
the agent pulls it in when relevant rather than paying for it every turn; the
body is generated from the project's vault notes. `--for claude` writes
`AGENTS.md` instead, which Cursor also reads — one generator, two shapes. Note
that a plain `.md` under `.cursor/rules/` is silently ignored, so the `.mdc`
extension and the frontmatter are not optional.

I could not find a distinct **"Memories"** feature in the current Cursor docs;
the rules page frames rules as the answer to "LLMs don't retain memory between
completions". Treat Memories as either renamed or retired until seen.

**Cursor as a compute target** is deferrable: the Cloud Agent API would give a
second `targets/cursor-agents` with the same missing-`http`-dispatcher problem
as §5, and with webhooks still "coming soon" it inherits the same polling
return path. Same shape, no new lessons — do Devin first.

## 8. Proposal E — one token per tool, one `connect` verb

The owner is explicitly unsure whether they will settle on Cursor or Claude
Code. The answer to that is not to pick: **one agent row per tool**, identical
grants schema (§4), independently revocable, so switching tools is minting a
token and running one command. A tool that stops being used gets its row
revoked and nothing else changes.

| tool | what `metistry connect <tool>` writes | shape |
|---|---|---|
| `claude-code` | `~/.claude/settings.json` → `env` (`METISTRY_URL`, `METISTRY_OWNER_TOKEN`, optional `METISTRY_CAPTURE_ON_STOP`); plugin installed separately | JSON, `env` block |
| `cursor` | `~/.cursor/mcp.json` (+ `.cursor/hooks.json` once `plugins/cursor` exists) | `mcpServers.metistry` with `url` + `headers`, `${env:…}` |
| `opencode` | `opencode.json` → `mcp.metistry` (C17, already specified) | `type: remote`, `url`, `headers` |
| `devin` | **nothing — no config file exists** | prints the HTTP-transport JSON and the Customize → MCPs path |

Devin is the honest exception to "one verb writes the native config": its MCP
servers are registered in a web UI, so `metistry connect devin` should mint the
token, print the exact JSON and UI path, and then **verify** by calling
`tools/list` against `/mcp` with that token so the owner knows the token works
before pasting it. Devin's own **Test listing tools** button closes the loop
from the other side.

Not in scope but adjacent: this is four rows whose tokens are all bearer
strings minted by `POST /api/agents`. **S3** (`agent:<name>@<instance_id>`) and
**S2** (approve-before-enroll) both land on exactly this surface, and S4's
resource registry is the general form of this table. Worth sequencing with
them rather than against them.

## 9. Proposal F — phasing, for "usable on the second instance ASAP"

**None of this depends on the compute pivot's PR 1.** The second instance can run
today's release with an owner token and a Devin API key; nothing here touches
the engine, `compute.yaml`, or the provider path. The one adjacency is B's
`submit.max_acu`, which is a target ceiling and not an engine budget.

| # | Contents | Code? | Depends on |
|---|---|---|---|
| **1** | `docs/ops/devin.md` + `docs/ops/cursor.md`; `metistry agents mint <id>` and `metistry connect <tool>` (cursor, claude-code, devin) | verb only | a publicly reachable origin |
| **2** | `plugins/cursor` + `fromCursor()` + parity test | yes | the transcript-format spike (§7) |
| **3** | `collectors/devin-knowledge` (notes + wikis → inbox), `check()`, `source: devin` provenance | yes | a `cog_` key; the `deny_sources` ruling (§6) |
| **4** | `targets/devin-sessions` + the `http` dispatcher + status poller | yes | PR 1 (for the report-back token) |
| **5** | `metistry rules export --for cursor\|claude` | yes | nothing |

PR 1 is the whole of A and D's useful half, and it is docs plus one verb. That
is the smallest thing that makes work better this week: Devin and Cursor both
searching and capturing into the work vault, Claude Code already doing so.

`metistry connect` does not exist today — only `connect-repo` (`packages/cli/src/`).
Neither does `metistry agents mint`; agents are minted through
`POST /api/agents` on an owner session, and `apps/console/scripts/enroll.mjs`
mints *owner* tokens only. So PR 1 is a genuinely new verb, not a rename —
and it is the verb C17's `metistry connect opencode` already assumes, so
building it generically now makes compute PR 5 smaller.

## 10. What could not be verified, and what to watch

**Could not verify from docs:**
- **ACU price per unit** and any **published API rate limit**. `429` is in the
  status table; `admin/billing/overview.md` 404s. Pricing lives on the
  marketing site, not the docs. Any cost estimate for B is unfounded until the
  owner reads their own plan.
- **Cursor's transcript file format** at `transcript_path`. Undocumented.
  Gates PR 2 (§7).
- Whether Cursor still has a **"Memories"** feature distinct from rules.
- Whether v3 `POST …/sessions` honours an **`Idempotency-Key`** header.

**Depends on the owner's plan tier or admin rights — check before promising:**
- **A `cog_` key at all.** Service-user keys are created in Settings → Service
  users (org admin). PATs are the no-admin path, but "for enterprise accounts,
  PATs are governed by an enterprise-wide policy (**disabled by default**) that
  enterprise admins configure — including an approval workflow and mandatory
  token expiration". This is the single biggest risk to B and C.
- **A mandatory Security Profile MCP allowlist** can block proposal A outright,
  and **Devin MCP read-only** would block the write half of any knowledge sync.
- **The training opt-out** (§1e): paid plan, Data Controls page, and **on Teams
  only an admin can exercise it**. A brief that cites internal docs may be
  trained on until that is done. This is precisely C13's non-ZDR case, so the
  existing rule applies — warn on the dispatch, never block — but the owner
  should know which side of the opt-out they are on before the first brief.
- `create_as_user_id` needs the `ImpersonateOrgSessions` permission.
- Cursor third-party hook loading "must be enabled for your account".
- Cursor Cloud Agents API is **public beta**; its webhooks are "coming soon".

**Contradiction to flag, not route around:** this note was commissioned asking
for a token "with grants (knowledge_search/read, capture, tasks_*, report — no
knowledge_write by default), autonomy `propose`". Neither exists in that form
(§4): grants are a read tier plus areas plus a `queries` boolean, tool access
follows principal kind, and `autonomy.level` is adopt A3, blocked on OPEN-2.
The *effect* asked for is already the default. Leaving it here for the owner
rather than quietly designing to the wrong schema.

## 11. Sources

All fetched **2026-09-15** with `curl` against the docs' own `.md` endpoints
(`docs.devin.ai/llms.txt` and `cursor.com/docs/llms.txt` as indexes). No fetch
failed except `https://docs.devin.ai/admin/billing/overview.md` (404).

Devin — `docs.devin.ai`: `/api-reference/overview`, `/api-reference/authentication`,
`/api-reference/_llms/en/api` (302-page index), `/api-reference/v3/sessions/post-organizations-sessions`
(v3 OpenAPI), `/api-reference/v1/sessions/create-a-new-devin-session`,
`/work-with-devin/mcp`, `/work-with-devin/devin-mcp`, `/work-with-devin/deepwiki-mcp`,
`/work-with-devin/deepwiki`, `/work-with-devin/devin-cli`, `/product-guides/knowledge`,
`/product-guides/automations`, `/product-guides/security-profiles`, `/admin/security`.

Cursor — `cursor.com/docs`: `/mcp`, `/hooks`, `/rules`, `/reference/third-party-hooks`,
`/cli/overview`, `/cli/using`, `/cloud-agent/api/endpoints`.

Metistry — `docs/ops/claude-code-plugin.md`, `docs/ops/crews.md`,
`docs/ops/targets.md`, `docs/ops/cli.md`, `docs/plan-refresh-2026-09-13.md`
(§1 C7/C17, §4 queue, S1–S6), `docs/research/2026-09-11-local-models-openrouter-opencode.md`
("OpenCode as a dev tool"), `apps/console/src/agents.ts`,
`apps/console/src/dispatch.ts`, `apps/assistant/src/brain.ts`,
`packages/mcp-brain/manifest.yaml`, `targets/github-issues/manifest.yaml`,
`plugins/claude-code/scripts/session-end.mjs`, `packages/cli/src/`.
