# @foldedspacelabs/metistry-mcp-brain

The one MCP surface an external agent uses to work *with* a Metistry
instance — a standalone Claude session, a coding agent, another vendor's
agent, any MCP client — and the instance's own assistant. Twelve tools
over Streamable HTTP:

- **in:** `capture` (a note or file into the inbox), `report` (a finding,
  decision, gotcha, or progress note into the proposal queue);
- **shared work:** `tasks_list_ready`, `tasks_claim`, `tasks_heartbeat`,
  `tasks_update`, `tasks_release`, `tasks_create`, `tasks_mine` — thin
  adapters over [`@foldedspacelabs/metistry-tasks`](../tasks);
- **out, under grants:** `knowledge_search`, `knowledge_read`;
- **the one writer:** `knowledge_write` — `kind: internal` principals only
  (the owner's own assistant); everyone else is told "not granted".

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
| One writer | `knowledge_write` is `forbidden` for any principal that is not `kind: "internal"`, whatever the path. For the internal principal: the path must be `Knowledge/...` (no traversal, no `knowledge/`) **and** inside its own `areas` grant — writes never reach wider than reads; the host's writer (Metistry's reconciler bridge) refuses the protected paths (`identity.yaml`, `rules.yaml`, `queries/`, …) behind that. Markdown gets `source: <agent id>` (the credential, never an argument) and `updated: <today>` merged into its frontmatter, line by line, nothing else invented. Compare-and-swap on `expected_sha256` (from `knowledge_read`); a lost race is `conflict` with the current hash in the message. No delete, no rename. |
| Text boundary | Every string that came out of the database passes `sanitizeForAgent` from core before it is rendered: bidi overrides and zero-width characters stripped, no leading `/`. The stored row is untouched. |
| Every call is audited | One two-phase `runs` row per tool call: `component = <agent id>`, `kind = 'tool'`, `tool = <name>`, with clipped arguments and, for knowledge calls, the tier and areas it was judged under. Refusals are logged too. |
| Idempotent writes | `report` on `idempotency_key` (unique partial index, safe under concurrency) and near-duplicate suppression (same agent + same title within 24 h → the existing id). `tasks_create` on its `idempotency_key` via the tasks module. |
| Secrets stay out | Secret-named fields in a report payload are redacted before the row is written (core's `redactSecrets`). |

**Tool-result nudges.** Every result — success or error — ends with one
terse deterministic line when something is waiting for the caller:

```
{"tasks":[]}
nudge: 2 tasks ready in project drey — call tasks_list_ready; claim on task #14 expires in 40s — call tasks_heartbeat
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
| `report` | `title`, `body`, `kind?` ∈ finding \| decision \| gotcha \| progress, `refs?: string[]`, `idempotency_key?` | `{ id, deduplicated: false \| "idempotency_key" \| "title" }` — a `proposals` row, kind `report`, trust `external` |
| `tasks_list_ready` | `project?`, `limit?` | `{ tasks }` across your projects (or one) |
| `tasks_claim` | `id`, `lease_seconds?` | `{ ok: true, task }` or `{ ok: false, reason, task? }` |
| `tasks_heartbeat` | `id`, `lease_seconds?` | same |
| `tasks_update` | `id`, `status?` ∈ in_progress \| blocked \| closed, `note?` | same |
| `tasks_release` | `id`, `note?` | same |
| `tasks_create` | `title`, `project`, `area?`, `depends_on?: number[]`, `due?` (YYYY-MM-DD), `idempotency_key?` | `{ task }` |
| `tasks_mine` | — | `{ tasks }` you hold |
| `knowledge_search` | `query`, `limit?` | `{ tier, hits: [{ path, title, description }] }` |
| `knowledge_read` | `path` (`Knowledge/...`) | `{ path, title, content, sha256 }` — the hash is the `expected_sha256` for a following write |
| `knowledge_write` | `path` (`Knowledge/...`), `content` (the whole file), `message` (commit message), `expected_sha256?` (from `knowledge_read`; `""` = create only; omit = unconditional) | `{ path, sha256, bytes, created, queued: true, provenance: { source, updated } \| null }` — internal principals only |
| `artifact_publish` | `project`, `slug`, `files: [{ path, content \| content_base64 }]`, `expected_current_version?` (id or `null` = must be new), `idempotency_key`, `message` | `{ artifact, version, links: { artifact, version, review }, deduplicated }` — `conflict` on a stale expected version |
| `artifact_get` | `id`, `version?`, `path?` | `{ artifact, version, links, versions, threads, file? }` |
| `artifact_list` | `project?`, `limit?` | `{ artifacts }` across your projects |
| `artifact_comment` | `artifact`, `version`, `body`, `path?`, `anchor?`, `parent?` (reply to a root) | `{ comment }` or `{ demoted: true, proposal_id, cap }` past the agent-only cap |
| `artifact_comment_resolve` | `id`, `reopen?` | `{ comment }` |
| `artifact_dispatch_review` | `artifact`, `version`, `thread_ids`, `to_agent`, `message?`, `idempotency_key?` | `{ route: 'work', work, links }` inside the project; `{ route: 'proposal', proposal_id }` across the boundary |
| `crew_dispatch` | `crew`, `brief`, `task_id?`, `idempotency_key?` | `{ queued: true, work_id, crew, allow, deduplicated }` — internal principals only; `invalid_request` with the violations in the message when the brief cites a path outside the crew's scope ∩ the local target's `allow`, or a denied source |
| `queries_list` | — | `{ queries: [{ name, description, params: { <param>: { type, default? } } }] }` — every named query loaded into the injected `QueryStore` (invariant 3) |
| `queries_run` | `name`, `params?: Record<string, string \| number \| boolean>` | `{ name, params, rows, as_of, row_count, truncated? }` — rows capped at 200 (`truncated: true` past the cap); `not_found` for an unknown query, `invalid_request` for a bad/unknown param. Internal principals always; external agents need a `queries: true` grant. |

Every tool above also takes an optional `turn_id` (`≤ 64 chars`, `[A-Za-z0-9_-]`):
pass the same value on every call within one reply and they group under it in
`runs.meta.turn_id` (and the `activity_feed` query's `turn_id` column).

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
  inboxDir: "/data/inbox",
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
| `authenticate(req)` | `AgentPrincipal \| null`. **Grants and projects come from here, never from the request.** `kind` (`external` when absent) only feeds the internal project rule above. |
| `tasks` | a `TasksService` over the same database |
| `inboxDir` | where `capture` writes files (the triage row references them) |
| `readKnowledge?` | `(path) => Promise<string \| null>` — absent → `knowledge_read` is `not_available` and `check()` reports `degraded` |
| `writeKnowledge?` | `KnowledgeWriter` — `({ path, content, intent, expected_sha256? }) => Promise<VaultWriteOutcome>`; absent → `knowledge_write` is `not_available` and `check()` reports `degraded`. `vaultBridgeWriter({ url, token })` speaks the reconciler's wire contract (bearer, envelope, CAS, one read on `409` for the current hash). |
| `artifacts?` | an `ArtifactsService` (`@foldedspacelabs/metistry-artifacts`) — absent → every `artifact_*` tool is `not_available` |
| `queries?` | a `QueryStore` (`@foldedspacelabs/metistry-queries`, invariant 3's one read path) — absent → `queries_list`/`queries_run` are `not_available`. Internal principals always have these tools; external agents need `grants.queries = true`. |
| `leaseWarningSeconds?` | nudge threshold for a held lease (default 120) |
| `version?` | reported to clients as the server version |

The returned `BrainServer` has `handle(req, res)`, `check()` (the §4.3
behavioral probe: selects the columns every tool depends on and runs the
tasks module's own check), and `tools` (the full name list, in manifest
order).

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
`capture` and `report` work for every registered agent. Revoking or
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
stamping byte for byte, and the bridge client against a fake that speaks
the reconciler's contract) and, when `METISTRY_DB_PASSWORD` is set, the
misuse suite against the scratch database through the real MCP client:
401 envelopes, cross-project `not_found`, tier `none` → `not granted`,
draft exclusion, nudge appearing and disappearing, report dedupe,
sanitizer on the way out, the write round trip with CAS, one `runs` row
per call. From the repo root, `pnpm test` provisions the scratch database
first.

## License

Apache-2.0
