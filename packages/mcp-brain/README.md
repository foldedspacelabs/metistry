# @foldedspacelabs/metistry-mcp-brain

The one MCP surface an external agent uses to work *with* a Metistry
instance — a standalone Claude session, a coding agent, another vendor's
agent, any MCP client — and the instance's own assistant. Twenty-three tools
over Streamable HTTP, named from one small vocabulary — an object noun plus
one of `list` / `get` / `search` / `create` / `update`
(`docs/product/glossary.md`) — plus vault notes as MCP resources:

- **in:** `capture` (a note or file into the inbox), `requests_create` (a
  finding, a decision made, a gotcha, or a progress note as a request for the
  user — or a question they answer);
- **shared work:** `tasks_list`, `tasks_claim`, `tasks_renew`,
  `tasks_update`, `tasks_release`, `tasks_close`, `tasks_create` — thin
  adapters over [`@foldedspacelabs/metistry-tasks`](../tasks);
- **out, under grants:** `knowledge_search`, `knowledge_read`,
  `knowledge_list`, `knowledge_grep` — the title index, one note's content,
  a listing (and, with `links_for`, one page's links), and a content regex,
  all the same grant tiers. One function decides every path on every one of
  them — `canSeeUnder`, which the console's own `/api/knowledge/*` routes
  call too;
- **the one writer:** `knowledge_write` — `kind: internal` principals only
  (the owner's own assistant); everyone else is told "not granted".

**Resources.** Every settled note an `areas` grant can read is also exposed
as an MCP resource, `metistry://Knowledge/<path>` — `resources/list`
(paginated) and `resources/read` for any client that browses resources
instead of calling tools. Same tier rule as `knowledge_read` throughout;
there is no separate resource grant.

External agents **propose**; they never write knowledge. Everything they
send lands as a row the user triages, with provenance stamped from the
credential. The assistant writes — through the host's vault bridge, as a
commit in its own name, with provenance stamped into the note.

## What the bridge enforces (not what it asks for)

| Rule | Mechanism |
| --- | --- |
| Identity is server-side | No tool has an `agent` argument. The host's `authenticate(req)` turns the bearer into a principal; every row, history entry, and audit run carries that id. |
| Tasks are project-scoped | `tasks_*` only see tasks whose `project` is in the principal's membership. Anything else is `not_found` — never listed, never claimable, never usable as a dependency. Creating in a project you are not in is `forbidden`. **The internal rule** (`scope.ts`): a principal with `kind: "internal"` — the instance's own assistant, whose scope comes from configuration in the user's hand, not from a grant it asked for — and an *empty* `projects` list is a member of every project; a non-empty list narrows it like any other agent. External + empty is still none. Tasks with no project are invisible to everyone, internal included. |
| Knowledge is tiered, default-deny | `none` → every knowledge call returns `{ error: { code: "forbidden", message: "not granted" } }` — *not* "not found", so absence of permission never looks like absence of knowledge. `index` → titles + one-line descriptions. `areas` → search and full read under the granted `Knowledge/...` prefixes only. |
| Drafts are invisible | `status: draft` notes (the `draft` column on `knowledge_files`) are excluded by a `WHERE` clause at every tier. |
| One writer | `knowledge_write` is `forbidden` for any principal that is not `kind: "internal"`, whatever the path. For the internal principal: the path must be `Knowledge/...` (no traversal, no `knowledge/`) **and** inside its own `areas` grant — writes never reach wider than reads; the host's writer (Metistry's reconciler bridge) refuses the protected paths (`identity.yaml`, `rules.yaml`, `queries/`, …) behind that. Markdown gets `source: <agent id>` (the credential, never an argument) and `updated: <today>` merged into its frontmatter, line by line, nothing else invented. Compare-and-swap is mandatory: `expected_sha256` (from `knowledge_read`) is what the note must currently hash to, and OMITTING it means create-only — an existing note answers `conflict` with the current hash rather than being overwritten unseen. There is no unconditional write; the people who edit these files by hand are the reason. No delete, no rename. |
| Text boundary | Every string that came out of the database passes `sanitizeForAgent` from core before it is rendered: bidi overrides and zero-width characters stripped, no leading `/`. The stored row is untouched. |
| Every call is audited | One two-phase `runs` row per tool call: `component = <agent id>`, `kind = 'tool'`, `tool = <name>`, with clipped arguments and, for knowledge calls, the tier and areas it was judged under. Refusals are logged too. |
| Idempotent writes | `requests_create` on `idempotency_key` (unique partial index, safe under concurrency) and near-duplicate suppression (same agent + same title within 24 h → the existing id). `tasks_create` on its `idempotency_key` via the tasks module. |
| Secrets stay out | Secret-named fields in a report payload are redacted before the row is written (core's `redactSecrets`). |

**Tool-result nudges.** Every result — success or error — ends with one
terse deterministic line when something is waiting for the caller:

```
{"tasks":[]}
nudge: 2 tasks ready in project drey — call tasks_list; claim on task #14 expires in 40s — call tasks_renew
```

Computed server-side from the task list on every call; no model involved.
A pull-only agent has no other attention channel.

## Tools

Arguments are validated with zod; the JSON schema is what `tools/list`
returns. Results are one `text` content block: a JSON document, then the
optional nudge line. Errors set `isError` and carry core's uniform envelope
`{ error: { code, message } }` with codes `invalid_request`, `forbidden`,
`not_found`, `conflict`, `not_available`, `internal`.

| Tool | Arguments | Returns |
| --- | --- | --- |
| `capture` | `note?`, `filename?`, `content_base64?`, `mime?` (one of `note` / `content_base64` required) | `{ id, path, sha256 }` — an `inbox` row, `source = 'mcp'`, `source_agent` = you |
| `requests_create` | `title`, `body`, `kind?` ∈ finding \| decided \| gotcha \| progress \| question (`decision` is accepted and stored as `decided`), `questions?` (with kind `question`: 1–5 of `{prompt, options, multi?, allow_other?}`, 2–8 options each), `refs?: string[]`, `idempotency_key?` | `{ id, deduplicated: false \| "idempotency_key" \| "title", answer? }` — `answer` on a replay only: where the owner's answer to YOUR request stands, `{state, decided_at?, answers?, feedback?}` (X-10; `docs/ops/client-api.md`), never another agent's — a request of type `report` in the user's Needs You queue (a `proposals` row, kind `report`, trust `external`); with kind `question`, a request of type `question` (kind `decision`, the questions in `payload.questions`, `body` and `refs` as `payload.context`) that the user answers per question — an option, or their own words where `allow_other` (the default) |
| `tasks_list` | `filter?` ∈ ready \| mine \| all (default `ready`), `project?`, `limit?` | `{ filter, tasks }` — `ready` = claimable, `mine` = held by you, `all` = both |
| `tasks_claim` | `id`, `lease_seconds?` | `{ ok: true, task }` or `{ ok: false, reason, task? }` |
| `tasks_renew` | `id`, `lease_seconds?` | same |
| `tasks_update` | `id`, `status?` ∈ in_progress \| blocked \| closed, `note?` | same — prefer `tasks_close` to finish a task |
| `tasks_release` | `id`, `note?` | same |
| `tasks_close` | `id`, `note?` | same — `status: closed` in one call, the `tasks_update` path underneath |
| `tasks_create` | `title`, `project`, `area?`, `depends_on?: number[]`, `due?` (YYYY-MM-DD), `idempotency_key?` | `{ task }` |
| `knowledge_search` | `query`, `limit?` | `{ tier, hits: [{ path, title, description }] }` |
| `knowledge_read` | `path` (`Knowledge/...`) | `{ path, title, content, sha256 }` — the hash is the `expected_sha256` for a following write |
| `knowledge_list` | `prefix?`, `depth?` | `{ entries: [{ path, kind: file \| dir, title?, updated? }] }` — a vault directory listing, tier `index` global, tier `areas` scoped to your prefixes; drafts excluded |
| `knowledge_grep` | `pattern` (regex, ≤200 chars), `prefix?`, `limit?` | `{ hits: [{ path, line, text }] }` — regex over settled note content, `areas` grant only; candidates from a keyword pre-filter, capped at 50 files / 200 hits; an overly expensive pattern is refused rather than left to hang |
| `knowledge_write` | `path` (`Knowledge/...`), `content` (the whole file), `message` (commit message), `expected_sha256?` (from `knowledge_read`; `""` **or omitted** = create only) | `{ path, sha256, bytes, created, queued: true, provenance: { source, updated } \| null }` — internal principals only |
| `artifacts_publish` | `project`, `slug`, `files: [{ path, content \| content_base64 }]`, `expected_current_version?` (id or `null` = must be new), `idempotency_key`, `message` | `{ artifact, version, links: { artifact, version, review }, deduplicated }` — `conflict` on a stale expected version |
| `artifacts_get` | `id`, `version?`, `path?` | `{ artifact, version, links, versions, threads, file? }` |
| `artifacts_list` | `project?`, `limit?` | `{ artifacts }` across your projects |
| `artifacts_comment` | `artifact`, `version`, `body`, `path?`, `anchor?`, `parent?` (reply to a root) | `{ comment }` or `{ demoted: true, proposal_id, cap }` past the agent-only cap |
| `artifacts_resolve` | `id`, `reopen?` | `{ comment }` |
| `artifacts_review` | `artifact`, `version`, `thread_ids`, `to_agent`, `message?`, `idempotency_key?` | `{ route: 'work', work, links }` inside the project; `{ route: 'proposal', proposal_id }` across the boundary |
| `agents_delegate` | `crew`, `brief`, `task_id?`, `idempotency_key?` | `{ queued: true, work_id, crew, allow, deduplicated }` — internal principals only; `invalid_request` with the violations in the message when the brief cites a path outside the helper agent's scope ∩ the local target's `allow`, or a denied source |
| `queries_list` | — | `{ queries: [{ name, description, params: { <param>: { type, default? } } }] }` — every named query loaded into the injected `QueryStore` (invariant 3) |
| `queries_run` | `name`, `params?: Record<string, string \| number \| boolean>` | `{ name, params, rows, as_of, row_count, truncated? }` — rows capped at 200 (`truncated: true` past the cap); `not_found` for an unknown query, `invalid_request` for a bad/unknown param. Internal principals always; external agents need a `queries: true` grant. |
| `connections_list` | `connection?` | no argument: `{ connections: [{ name, type, description?, status, tools }] }` — the connections lent to you, each with the tools you may call, read without dialling anything; with `connection`: `{ connection, tools: [{ name, description, inputSchema }] }` — the upstream's own definitions, fetched on demand (the lazy half: none of them is ever in this bridge's `tools/list`). A connection is lent when the owner offered it to agents **and** your credential's `grants.connections` names it; a crew also needs `uses: [connections]`; the internal assistant reaches every connection. |
| `connections_call` | `connection`, `tool`, `arguments?`, `confirm_token?` | A Read at Allow: `{ connection, tool, content, structuredContent?, isError? }` — the upstream's answer, redacted, with every string through the sanitizer. Changes things / Starts an agent at Allow: first `{ status: "preview", arguments, confirm_token, expires_in_sec }`, nothing dialled; the same call with `confirm_token` runs it, once (a replayed, mismatched, foreign or expired token is `conflict`). Ask First: `{ status: "pending", proposal_id }` — an `action` of kind `connection_call` in Needs You, run only by the owner's Approve; from a run that said nobody is there (`_meta` interactive `false`, below), `{ skipped: true, reason: "waits_for_you", proposal_id }` — the same request, deferred. A tool at Never or not listed is `not_found` (`no such tool: <connection>/<tool>`). Over the hourly limits (`ConnectionLimits`, counted from `runs`) is `rate_limited`. A connection you cannot reach is `not_found` (`no such connection: <name>`), exactly like one that does not exist. One `runs` row of kind `connection_call` per call, refusals included. |

**Correlating one reply's calls.** Put a handle in the `_meta` of each
`tools/call` — key `com.foldedspacelabs.metistry/turn_id`, value `≤ 64 chars`
of `[A-Za-z0-9_-]` — and the calls carrying the same value group under it in
`runs.meta.turn_id` (and the `activity_feed` query's `turn_id` column):

```jsonc
{ "method": "tools/call",
  "params": { "name": "knowledge_read",
              "arguments": { "path": "Areas/Fsl/Note.md" },
              "_meta": { "com.foldedspacelabs.metistry/turn_id": "b1f0…" } } }
```

It is deliberately **not** a tool parameter: printed into all 25 schemas it
cost ~940 definition tokens, 19% of the whole advertised surface, for a field
no model should be reasoning about. It is a correlation handle — shape-checked
and stored, never trusted for anything else, and a malformed one is dropped
rather than failing the call. *Until 0.10.0 it was an optional `turn_id`
argument on every tool; that still works for one release and is not
advertised.*

**Saying nobody is there.** Beside it, `com.foldedspacelabs.metistry/interactive:
false` in a call's `_meta` says the run that made it has no one to ask — a
scheduled job, not a conversation. It changes one answer: an Ask First
`connections_call` is **deferred** rather than paused — `{ skipped: true,
reason: "waits_for_you", proposal_id }`, the same request raised, nothing
dialled — and its `runs` row carries `outcome: "deferred"`, `unattended: true`
and your turn handle, so your run can report what it skipped. Absent, or any
value but the boolean `false`, is interactive. It grants nothing either way:
an Ask First call runs only on the owner's Approve.

Policy refusals from the task list (`claimed`, `dependencies_open`,
`not_holder`, `lease_expired`, …) are *outcomes*, returned as data; only a
scope miss is an error envelope.

## Embed it

This package needs a database and a principal source, so it is not an
`npx` one-liner; it is a handler you mount inside your own `node:http`
server. No `pg` import here — pass any client with pg's `query(text,
values)` shape.

```ts
import { createServer } from "node:http";
import pg from "pg";
import { TasksService } from "@foldedspacelabs/metistry-tasks";
import { createBrainServer, vaultBridgeWriter } from "@foldedspacelabs/metistry-mcp-brain";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const brain = createBrainServer({
  db: pool,
  tasks: new TasksService(pool),
  inboxDir: "/data/inbox", // where `capture` writes when no sink is injected
  // YOUR credential → principal. Return null for anything you don't trust; the bridge answers 401.
  authenticate: async (req) => lookupAgentByBearer(req.headers.authorization), // → { id, kind?, grants: { tier, areas }, projects } | null
  // Optional: a vault read path. Without it, knowledge_read answers `not_available`.
  readKnowledge: async (path) => readFileOrNull(path),
  // Optional: a vault write path for internal principals. Metistry uses `vaultBridgeWriter({ url, token })`
  // (the reconciler's POST /vault/write with a commit intent); any `KnowledgeWriter` will do.
  writeKnowledge: vaultBridgeWriter({ url: process.env.VAULT_BRIDGE_URL!, token: process.env.VAULT_BRIDGE_TOKEN! }),
});

createServer((req, res) => {
  if (req.url === "/mcp") return void brain.handle(req, res);
  res.writeHead(404).end();
}).listen(8080);
```

`createBrainServer` options:

| Option | Meaning |
| --- | --- |
| `db` | `{ query(text, values) }` — pg.Pool, pg.Client, or a fake |
| `authenticate(req)` | `AgentPrincipal \| null`. **Grants and projects come from here, never from the request** — `grants.connections` (the connections this credential is lent) included. `kind` (`external` when absent) only feeds the internal project rule above. |
| `tasks` | a `TasksService` over the same database |
| `inboxDir` | where `capture` writes files when no `inbox` sink is given (the triage row references them) |
| `inbox?` | a `CaptureSink` — where captures actually go. `vaultSink(vault)` writes them into a vault at `Knowledge/Inbox/` through a bridge with compare-and-swap on absence, records repo-relative paths, and spills anything over `maxTrackedBytes` (5 MiB) into `Knowledge/Inbox/.large/`; `dirSink(dir)` is a plain directory. Absent → `dirSink(inboxDir)`. |
| `readKnowledge?` | `(path) => Promise<string \| null>` — absent → `knowledge_read` is `not_available` and `check()` reports `degraded` |
| `writeKnowledge?` | `KnowledgeWriter` — `({ path, content, intent, expected_sha256? }) => Promise<VaultWriteOutcome>`; absent → `knowledge_write` is `not_available` and `check()` reports `degraded`. `vaultBridgeWriter({ url, token })` speaks the reconciler's wire contract (bearer, envelope, CAS, one read on `409` for the current hash). |
| `listKnowledge?` | `(prefix, depth) => Promise<Array<{ path, kind }>>` — absent → `knowledge_list` answers from the index instead (the `knowledge_pages` named query, via `queries`), and is only `not_available` when that is not loaded either; also `knowledge_grep`'s candidate source when no keyword searcher is configured (or a pattern has no literal substring to seed one). `vaultBridgeLister({ url, token })` speaks the reconciler's `GET /vault/list`. |
| `searchVaultKeyword?` | `(query, limit) => Promise<Array<{ path }>>` — `knowledge_grep`'s keyword pre-filter; absent → it falls back to `listKnowledge`. `vaultBridgeSearcher({ url, token })` speaks the reconciler's `GET /vault/search?mode=keyword`. |
| `artifacts?` | an `ArtifactsService` (`@foldedspacelabs/metistry-artifacts`) — absent → every `artifacts_*` tool is `not_available` |
| `queries?` | a `QueryStore` (`@foldedspacelabs/metistry-queries`, invariant 3's one read path) — absent → `queries_list`/`queries_run` are `not_available`, and `knowledge_list { links_for }` with them. Internal principals always have the `queries_*` tools; external agents need `grants.queries = true`. A query whose manifest says `expose: route` is never served by `queries_run` at all — it answers with the unknown-query refusal, byte for byte, because the scope filter its rows need lives on a door of its own (`knowledge_list`, `GET /api/knowledge/pages`). |
| `connections?` | a `ConnectionsProxy` — `list()` (every connection with the owner's per-tool policy and `offer_to_agents`; never dials), `tools(name)` and `call({connection, tool, args, caller})`. `@foldedspacelabs/metistry-connections`' `ConnectionPool` satisfies the last two and its `describeConnections` the first. Absent → both `connections_*` tools are `not_available`. The bridge decides who reaches which connection (core's `may`) and which tools run; the proxy owns the dial, the secrets and the redaction. The caller's bearer is handed to `call` only as `caller.bearer`, so a call whose arguments carry it is refused — never sent upstream. |
| `leaseWarningSeconds?` | nudge threshold for a held lease (default 120) |
| `version?` | reported to clients as the server version |

The returned `BrainServer` has `handle(req, res)`, `check()` (the §4.3
behavioral probe: selects the columns every tool depends on and runs the
tasks module's own check), and `tools` (the full name list, in manifest
order).

**Deprecated names, one release.** The 2026-09-09 vocabulary
simplification renamed eleven tools. The old spellings still *work* —
`src/aliases.ts` maps them at call time — but they are **not listed** by
`tools/list`, so the eager surface stays exactly the primary names (now
twenty-three, `tasks_close` added after the rename) and its definition
budget stays where it was: 18,369 chars of JSON schema, ≈ 4.6k tokens at
chars/4, against PoC-17's 5k line (`test/brain.test.ts` asserts it and
prints the measured size on every run). Registering the aliases with
schemas of their own would have doubled that.
Every alias call is recorded in its `runs` row as `meta.alias`, and
`check()` reports the list as `deprecated_aliases`; they come out one
release after this one.

| Deprecated | Now |
| --- | --- |
| `report` | `requests_create` |
| `tasks_list_ready` | `tasks_list` (`filter: "ready"`) |
| `tasks_mine` | `tasks_list` (`filter: "mine"`) |
| `tasks_heartbeat` | `tasks_renew` |
| `artifact_publish` / `artifact_get` / `artifact_list` / `artifact_comment` | `artifacts_publish` / `artifacts_get` / `artifacts_list` / `artifacts_comment` |
| `artifact_comment_resolve` | `artifacts_resolve` |
| `artifact_dispatch_review` | `artifacts_review` |
| `crew_dispatch` | `agents_delegate` |

Argument names did not change: `agents_delegate` still takes `crew`, and a
crew's `uses` groups (`CREW_TOOL_GROUPS` in core) carry the new names
only — a helper agent's allowlist is built from the primary set.

**Transport.** Stateless Streamable HTTP: a fresh MCP server per request,
no session header, JSON responses (`enableJsonResponse`). Unauthenticated
requests get `401` + `WWW-Authenticate: Bearer` + the uniform envelope at
the HTTP layer, before any MCP parsing.

**Schema.** Metistry's migrations own it (`0009_brain.sql` adds
`knowledge_files.title/description/draft` and the report idempotency
index). Standalone users need the tasks module's `ensureSchema()` plus the
`inbox`, `proposals`, and `knowledge_files` tables from
`db/migrations/0001` / `0002` / `0009`.

## In Metistry

The console mounts it at `POST /mcp` with `authenticateAgent` from the
agent registry as the principal source — the same function that
authenticates `POST /capture`. Register an agent, set its grants and
projects, and point any MCP client at the instance:

```sh
# on the instance (owner session): mint, then grant
curl -X POST https://<origin>/api/agents -d '{"id":"drey-dev","display_name":"Drey dev agent"}'   # → { id, token }  (the token crosses the wire once)
curl -X PUT  https://<origin>/api/agents/drey-dev/grants   -d '{"tier":"areas","areas":["Knowledge/Areas/Drey"]}'
curl -X PUT  https://<origin>/api/agents/drey-dev/projects -d '{"projects":["drey"]}'

# in Claude Code
claude mcp add --transport http metistry https://<origin>/mcp --header "Authorization: Bearer <token>"
```

A capture-only agent needs no grants at all (tier `none`, no projects):
`capture` and `requests_create` work for every registered agent. Revoking or
rotating the agent kills the token on the next request.

The instance's own assistant is the first *internal* agent on this same
surface (plan §4.11: one knowledge interface for all agents). The console
registers it at startup from `METISTRY_ASSISTANT_TOKEN` (`kind: internal`,
id `assistant`) and the assistant engine mounts `/mcp` as its only MCP
server — see `docs/ops/assistant-tools.md`.

## Test

`vitest run` in this package: unit tests with a fake executor (manifest ↔
tool-list lock, nudge arithmetic, the reader-less `not_available` path,
the one-writer / path / grant rules of `knowledge_write`, provenance
stamping byte for byte, the bridge client against a fake that speaks
the reconciler's contract, and the full `tools/list` definition-token
measurement against the PoC-17 lazy-load line) and, when
`METISTRY_DB_PASSWORD` is set, the misuse suite against the scratch
database through the real MCP client: 401 envelopes, cross-project
`not_found`, tier `none` → `not granted`, draft exclusion, nudge appearing
and disappearing, request dedupe, sanitizer on the way out, the write round
trip with CAS, `knowledge_list`/`knowledge_grep` tier gating and drafts
exclusion (a catastrophic pattern proven to hit the worker timeout, not
hang the request), `resources/list`+`resources/read` mirroring
`knowledge_read`'s tier rule, deprecated names resolving to their primaries
at call time, one `runs` row per tool call. From the repo root, `pnpm test`
provisions the scratch database first.

## License

Apache-2.0
