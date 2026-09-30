# Hindsight — agent memory by Vectorize, and what Metistry's memory takes from it (2026-09-30)

Research answering the owner's 2026-09-30 ask: a competitive and technical
review of [Hindsight](https://github.com/vectorize-io/hindsight), which, in the
owner's words, "has a similar approach to Metistry for agent memory and
retrieval, plus they make it easy to integrate with nearly every agent,
provider, and coding tool". The owner "especially like[s] how easy they make it
to setup, integrate, and start persisting memory", notes that it is
cloud-hosted plus dockerized, and asks "what there is to learn here and what
they got right and wrong."

Nothing here is built; this PR adds one document and no product code.

Sources: Hindsight's repository, **shallow-cloned and read locally** at
`acfd157` (2026-09-30, head of `main`; latest release `v0.10.2`, 2026-09-29).
Its claims cite `path:line` in *that* tree, marked `hs:`; below, `api/` means
`hindsight-api-slim/hindsight_api/`, `ca/` means
`hindsight-integrations/coding-agents/` and `dev/` means
`hindsight-docs/docs/developer/`. Stars, forks, commits, contributors, issues,
releases and licence come from the GitHub API; pricing from vectorize.io, the
benchmark board and the paper's abstract from their pages — all fetched
2026-09-30. **Nothing was run**: no container, no server, no Cloud account.
Every behaviour below is read from code and docs, and every timing is theirs.
Metistry claims cite `origin/main` `f1742008` and build on
`docs/research/2026-09-21-agent-memory-lessons.md` (Tencent and the
neighbours) rather than repeating it.

## 1. What it is, in five lines

1. **An agent-memory server with three verbs** — `retain`, `recall`, `reflect` — over Postgres + pgvector (Oracle 23ai at parity): a FastAPI engine (~162k lines of Python in `hs:api/`; `api/engine/memory_engine.py` alone is 23,755), a Next.js control plane, a Rust CLI, generated clients in Python, TypeScript, Go and Rust, and 55 first-party integration directories.
2. **By Vectorize AI, Inc.**, with a paper ("Hindsight is 20/20", [arXiv:2512.12818](https://arxiv.org/abs/2512.12818), 2025-12-14) claiming 91.4% on LongMemEval; their live board now shows 94.6% LongMemEval-S and 92% LoCoMo-10, run on their own Agent Memory Benchmark harness. The README says Virginia Tech and The Washington Post reproduced the numbers (`hs:README.md:50`) — **not verifiable here**.
3. **Licence: MIT** (`hs:LICENSE`, "Copyright (c) 2025 Vectorize AI, Inc."; the GitHub API agrees).
4. **Pricing**: self-hosted free ("no usage limits, no telemetry, and no restrictions"); **Hindsight Cloud** usage-based — retain $10 per million tokens, recall $0.75 per million, reflect $0.05 a call, mental-model refresh $0.05 a call, storage $0.25 per million tokens a month, free credits to start, 99.9% SLA; Enterprise to 99.95%. I found **no public statement of Cloud region, sub-processors (which model extracts your data), SOC 2 or training use** on the pricing page, the docs home or the FAQ — **unverified either way**.
5. **Maturity**: created 2025-10-30; 43,620 ★ / 5,827 forks; 3,325 commits; 275 contributors; 71 releases since 2025-12-04 (roughly weekly); 84 open issues and 96 open PRs of 1,260 issues ever; 110 Alembic migrations. Pre-1.0, very active, and second only to Mem0 in stars among the memory projects our research has looked at.

## 2. The memory model, precisely

### 2.1 Written: by a model, on every retain

- **The call** is `retain(content, context?, timestamp?, tags?, metadata?, document_id?)`; the bank is created on first use (`hs:api/engine/retain/bank_utils.py:229`), so the quickstart has no setup call.
- **Extraction is always an LLM.** One prompt per chunk pulls out "SIGNIFICANT facts", each with *what/when/where/who/why*, a `fact_kind` (event or conversation), a `fact_type` (`world` for the user's facts and preferences, `assistant` for what the agent did), entities, and relative dates rewritten as absolute ones (`hs:api/engine/retain/fact_extraction.py:1058-1110`). Selectivity is one sentence of that prompt: "Would this be useful to recall in 6 months? If no, skip it." A verbatim mode stores text as given and extracts only metadata.
- **Who calls it**: anything holding the key — an SDK, an MCP client, the LLM wrapper after every completion (`hs:README.md:225-226`), or the coding-agent hooks. The `Stop` hook "writes the session transcript back to memory" (`hs:ca/src/claude-stop-hook.ts:2`) — the user's prompts, the agent's prose and one line per tool call, tool output dropped (`hs:ca/src/core/transcript.ts:3-7`) — and SessionStart seeds commit messages (`gitIngest: "message"` by default, `hs:ca/README.md:626`).
- **Consolidation runs by itself** after every retain: facts become **observations** — deduplicated beliefs that keep "exact quotes" of their evidence and a proof count, refined rather than overwritten (`hs:dev/observations.mdx:14-33`). **Mental models** are standing questions whose LLM-written answers are rewritten in the background; **knowledge pages** are mental models arranged as a wiki (`hs:README.md:354-358`).
- **Directives** are stored "hard rules" reflect must follow — "Never share personal data with third parties" is their example (`hs:dev/reflect.mdx:150-165`) — and any MCP client can create or delete one (`hs:api/mcp_tools.py:3299`).

### 2.2 Stored: the record and its derivations in one database

- `documents` (id, bank, `original_text`, `content_hash`); `memory_units` (text, an HNSW-indexed cosine embedding, `occurred_start`/`occurred_end`, `mentioned_at`, `fact_type` ∈ world · experience · observation, metadata, tags, `history`, `edited_at`); `entities`, `unit_entities`, `entity_cooccurrences`; `memory_links(temporal|semantic|entity|caused_by…, weight)` (`hs:api/models.py:99-323`, later columns in `api/alembic/versions/`), plus tables for mental models and their versions, observation history, directives, knowledge pages, an invalidation archive, `audit_log` and `llm_requests`.
- Embeddings and the reranker are **local by default** (SentenceTransformers, CrossEncoder; `hs:api/config.py:1211, 1273`); extraction defaults to OpenAI `gpt-4o-mini` (`:1091, :1126`), with 25+ providers including a Claude Code subscription (`hs:README.md:82`).
- **Tenancy is a Postgres schema per tenant**, chosen by a `TenantExtension`; a **bank** is a partition inside it — "one 'brain' for one user, agent, or project" (`hs:README.md:364`).

### 2.3 Retrieved: four arms, our RRF constant, then a reranker

- `recall` runs **semantic, BM25, graph (entity, temporal and causal link expansion) and temporal** (a date range read from the query: "What happened in June?") in parallel (`hs:api/engine/search/retrieval.py:1-9`), fuses them by **RRF with k = 60** (`…/search/fusion.py:29` — `packages/mcp-brain/src/knowledge.ts:156` uses the same constant for the same reason), sends ≤300 candidates to a cross-encoder (`hs:api/config.py:1304`), then applies **bounded multiplicative boosts** — recency ±10% (linear to a floor over 365 days, a 90-day half-life, or `none`), temporal proximity ±10%, proof count ±5% (`…/search/reranking.py:32-53`) — and trims to a token budget.
- **A measured failure worth keeping**: weighting one arm's RRF term under the 300-candidate cap dropped recall@20 from 0.97 to 0.40, so they boost an arm's *rank*, not its score (`…/search/recall_boost.py:29-45`).
- **Scoping** is the bank on each call, then tags and metadata filters inside it. The default tag match, `any`, **includes untagged memories** (`…/search/tags.py:6`), and the README's per-user pattern is a metadata filter the caller applies at recall (`hs:README.md:387`).
- `reflect` is an agentic loop over recall and mental models, shaped by the bank's "disposition" (skepticism, literalism, empathy, 1–5; `hs:api/models.py:332-334`) and its directives.
- **Knowledge-page search** returns whole pages (full-text plus semantic, no reranker), and their docs argue for pull: "Search is a tool an agent *chooses* to call, visible in the transcript … retrieval it didn't ask for tends to derail it" (`hs:dev/knowledge-pages.mdx:59`).

### 2.4 Forgotten, corrected, audited

- **Curation** (`hs:dev/api/memories.mdx:101-125`): *edit* a fact (re-embedded, derivations rebuilt, stamped `edited_at`), *invalidate* it (reversible, archived with a reason), *restore* it; observations are never edited, only their sources. Deleting a document deletes the observations derived from it (`hs:dev/observations.mdx:261-267`). Their rule of thumb is good: "if Hindsight could have known, let consolidation handle it; if only you know, curate it" (`memories.mdx:117`).
- **Curation does not survive a re-extraction**: "reprocessing a document resets curation of the facts it produced" (`memories.mdx:218`), and reprocess is how a model or strategy change is applied (`hs:api/api/http.py:7703-7708`).
- **Audit is off by default** and kept forever when on (`hs:api/config.py:1974-1976`), written fire-and-forget (`hs:api/engine/audit.py:1-5`); the LLM request trace is on by default and kept **one day** (`config.py:1984-1987`). A memory unit has **no column naming who retained it** (checked in `models.py` and every `ADD COLUMN` in `alembic/versions/`); provenance is caller-supplied metadata, which the coding-agents package stamps client-side as `metadata.harness`.

### 2.5 The durable record, against invariant 1

| | Hindsight | Metistry |
| --- | --- | --- |
| **The record** | `documents.original_text` in Postgres — "your raw documents remain the source of truth about *what was said*" (`hs:dev/knowledge-pages.mdx:73`) | the vault, in git; Postgres is derived (invariant 1) |
| **How the rest is derived** | by an LLM — facts, observations, pages; non-deterministic, and a rebuild is a paid re-extraction | by a walk — index, links, tasks, embeddings (`apps/reconciler/`) |
| **`docker compose down -v`** | the record goes with the index unless it was exported (`/transfer/export`) or backed up | rebuild from the repo, run collectors once |
| **A human correction** | a `PATCH` on a fact, reset by the next reprocess | an edit in Obsidian; a note with no `source:` is the user's, and `knowledge_write` refuses to overwrite it or anything under `Me/` (`packages/mcp-brain/src/knowledge-write.ts:14-21, 291-296, 361-362`) |
| **Pages on disk** | `hindsight fs mount` mirrors pages one-way at mode 0444 and **reverts any local edit on the next 30-second pass** (`hs:hindsight-cli/src/commands/fs/sync.rs:5-12`) | the page is the file, and the owner's edit wins |
| **Consolidation** | a background LLM after every retain; nobody approves | `knowledge-fold`: one turn at 21:00, handles not content, reserved paths, never reads its own output (`routines/knowledge-fold/run.ts:1-24`); `session-fold`: a learned fact must quote the owner verbatim, and only Approve writes `Me/`, as `user` (`routines/session-fold/run.ts:1-30`) |
| **Their stated view** | "A file is where information goes to age … A knowledge page is a projected view over processed memory" (`knowledge-pages.mdx:69-75`) | the file is the memory; the database is the projection |

The two designs are exact inverses. The one place Hindsight agrees with us is
its own Obsidian plugin: "**Hindsight is never a second source of truth.** Sync
is one-way: Obsidian → Hindsight. Your vault is canonical", with chat turns
not stored by default (`hs:hindsight-integrations/obsidian/README.md:9-11, 62`).
Faced with someone who already keeps notes, they chose invariant 1.

## 3. The integration surface

### 3.1 What, and how

| Mechanism | What it reaches | How |
| --- | --- | --- |
| **A built-in MCP server** | any MCP client — Claude Code and Desktop, VS Code Copilot, Devin Desktop, OpenHands, Continue, Zed; ChatGPT and Perplexity as Cloud connectors over OAuth | Streamable HTTP at `/mcp/{bank_id}/`, on by default (`hs:dev/mcp-server.md:11-15`). The docs count 27 tools per bank and 30 multi-bank (`:103-104`); `api/mcp_tools.py` registers 39, `delete_bank` and `clear_memories` among them; a per-bank allowlist exists and defaults to all (`hs:api/config.py:1518`) |
| **One installer, twenty coding agents** | Claude Code, Codex CLI, Dcode, opencode (v1 and v2), Kilo, Cursor CLI, Copilot CLI, Grok Build, Qwen Code, Kimi Code, Factory Droid, ZCode, TraeCode, Antigravity, Devin CLI, Cline CLI, pi, Prime Agent, DeepSeek Harness (`hs:ca/README.md:5`) | `npx @vectorize-io/hindsight-coding-agents install <harness\|all>` writes each agent's native hooks (SessionStart, UserPromptSubmit, Stop), an MCP registration and a companion skill; idempotent, backs up every file it touches, and `uninstall` removes exactly its own entries (`hs:ca/README.md:19-42, 344-354`). The agent sees 8 `hindsight_*` tools |
| **Framework adapters** | LangGraph/LangChain (`BaseStore`), LlamaIndex, CrewAI, Pydantic AI, OpenAI Agents SDK, Google ADK (`BaseMemoryService`), Agno, Strands, AutoGen, AG2, Microsoft Agent Framework, Vercel AI SDK, Haystack, Smolagents, Pipecat, AgentCore, Claude Agent SDK | Python and TypeScript packages exposing the three verbs as the framework's own tool or memory type (`hs:hindsight-integrations/README.md`) |
| **An LLM wrapper** | 100+ models through LiteLLM | `wrap_openai(OpenAI(), bank_id=…)`: recall before each call, retain after it; "Defaults to Hindsight Cloud" (`hs:README.md:205-233`) |
| **No-code and apps** | n8n, Zapier, Dify, Flowise, Vapi, Obsidian | a community node, a Zapier app, a plugin |
| **Clients** | REST (OpenAPI), Python, TypeScript, Go, Rust, a Rust CLI | `pip`, `npm`, `go get`, `curl … \| bash` |

Counted: 55 integration directories and 62 integration doc pages (the README
says "60+").

**Auth.** The default is **none** — "Default single-tenant extension with no
authentication" (`hs:api/extensions/builtin/tenant.py:8-37`); "By default, the
MCP endpoint is **open**" (`hs:dev/mcp-server.md:30`). Opt in to one shared key
(`ApiKeyTenantExtension`, compared with `!=` at `tenant.py:73`, with MCP auth
separately switchable off at `:81-90`); newer extensions add per-user static
keys compared with `hmac.compare_digest` and a schema per user, or Supabase
JWTs (`hs:hindsight-extensions/`). Cloud uses `hsk_…` tokens, and OAuth for
remote MCP. The control plane is open unless `HINDSIGHT_CP_ACCESS_KEY` is set
(`hs:hindsight-control-plane/src/middleware.ts:26-35`). Bearer headers
throughout: **I found no credential in a URL query string** anywhere in the tree.

### 3.2 Time to first memory, counted from their quickstart

**Docker, self-hosted — four steps** (`hs:README.md:70-77, 123-162`):

```sh
export OPENAI_API_KEY=sk-xxx
docker run -it --pull always --name hindsight --restart unless-stopped -p 8888:8888 -p 9999:9999 \
  -e HINDSIGHT_API_LLM_API_KEY=$OPENAI_API_KEY \
  -v hindsight-data:/home/hindsight/.pg0 \
  ghcr.io/vectorize-io/hindsight:latest
npm install @vectorize-io/hindsight-client
```

```javascript
const { HindsightClient } = require('@vectorize-io/hindsight-client');

const main = async () => {
  const client = new HindsightClient({ baseUrl: 'http://localhost:8888' });

  await client.retain('my-bank', 'Alice loves hiking in Yosemite');

  const results = await client.recall('my-bank', 'What does Alice like?');
  console.log(results);
}

main();
```

No bank to create, no key to mint, migrations on startup. **Cloud plus a coding
agent — three steps**: sign up and copy a token;
`npx @vectorize-io/hindsight-coding-agents install claude-code --server cloud --api-token <token>`
(`hs:ca/README.md:443`); open Claude Code in a repository. Commit messages and
the session stream in from then on, and the first prompt gets a synthesis.
**Local on a Mac without Docker** (daemon mode) is the rough path: `uv`, an LLM
key or the Claude Code CLI, and a current Rust toolchain, because `litellm`
publishes no macOS wheel (`hs:ca/README.md:462-469`).

**Metistry, the same distance** (from a terminal; the Mac app's first-run
wizard drives the same verbs):

1. `npx @foldedspacelabs/metistry-cli init ~/metistry-instance --name "…"` (`docs/ops/cli.md:46`)
2. secrets and compute — a provider for the assistant; an embedder only for semantic search (`docs/ops/knowledge-search.md`)
3. `metistry up` — containers or launchd, then doctor (`cli.md` § Bringing an install up)
4. `metistry connect claude-code` — mints a bearer into the Keychain and prints two `export` lines (`cli.md:807-866`)
5. `/plugin marketplace add foldedspacelabs/metistry`, then `/plugin install metistry@metistry` (`docs/ops/claude-code-plugin.md` §3)
6. to *read* knowledge from Claude Code, `claude mcp add --transport http metistry https://<origin>/mcp --header "Authorization: Bearer <token>"` by hand (`packages/mcp-brain/README.md` § In Metistry) — `connect claude-code` wires capture only (`packages/cli/src/connect.ts:58`, config `env`)

A capture then lands in `Inbox/` and Needs You, and becomes knowledge when the
owner approves it and the 21:00 fold writes it: by design, the first
*searchable* memory is an approval and an evening away. For a stranger,
`npx @foldedspacelabs/metistry-mcp-*` runs the TCC bridges (`apple-fm`,
`eventkit` and `live-capture` ship a `bin`), but `mcp-brain`, the memory
surface, is a handler you mount — "not an `npx` one-liner"
(`packages/mcp-brain/README.md` § Embed it).

**The comparison has two halves.** Steps 4–6 are where Hindsight is simply
better: one command per agent, both directions, twenty agents — against our
four (`connect.ts:36`) and, for Claude Code, three steps across two tools.
Steps 1–3 cost what they cost because the instance is a git repository, a
Keychain and local models; Hindsight's shortest path is short because its
default is their cloud (§5). Take the first half; do not buy the second.

## 4. What they got right

1. **Three verbs.** `retain`, `recall`, `reflect` is a vocabulary a stranger learns in a minute, the bank appears on first use, and the quickstart is three calls. Our brain bridge has the better *policy* surface; theirs has the better *first sentence*.
2. **Installing is a product.** Native wiring per agent, idempotent re-runs, a `.hindsight-backup` of every touched file, an `uninstall` that removes only its own entries, a bare `install` that changes nothing and prints the choice (`hs:ca/README.md:31-34`), refusal to overwrite a foreign `hindsight` entry (`:186-187, 244-245`), a companion skill so the agent can explain its own memory, and `hindsight_diagnose` reporting what the file says against what the running client uses (`:536-537`).
3. **Privacy switches that fail closed, and that a repository cannot flip**: "a cloned repository must not be able to turn memory on" (`hs:ca/README.md:562-563`); repo-supplied config may not set the endpoint or the token (`hs:ca/src/core/config.ts:720-725`); `optInOnly` makes every other project inert.
4. **Retrieval with receipts.** RRF at k = 60 (ours, for our reason), a cross-encoder after it, recency, date and evidence as **bounded multipliers that can be switched off** rather than a new score space, a temporal arm that answers "what happened in June", and a docstring recording the measured failure of the obvious alternative (§2.3).
5. **Beliefs carry evidence.** Observations keep exact quotes and a proof count; deleting a source takes its observations with it; curation has three honest verbs and a reason on every invalidation.
6. **Candour about injection.** `hs:ca/src/core/inject.ts:3-8` names the "0.8.6-blog incident", where reflect rendered history as imperatives "indistinguishable from a prompt injection to the receiving agent"; injected memory is wrapped in a tag the write-back strips, so it is never re-ingested (`:74-77`) — our fold's never-read-your-own-output rule, reached from the other side.
7. **Pull over push, in their own words** (`knowledge-pages.mdx:59`, §2.3) — the stance `2026-09-21-agent-memory-lessons.md` §3.2 took for us.
8. **Evaluation in the repository.** Stubbed-model system tests that run on forks, kept apart from real-model evals "judged, and only meaningful as a rate" (`hs:hindsight-system-evals/README.md:15-25`), a rule to "never judge with the same call you're testing" (`hs:CLAUDE.md:303`), and `uv run run-amb --dataset locomo …` to reproduce LoCoMo and LongMemEval. The harness is their own, but it runs — the opposite of Tencent's single unreproducible number.
9. **Secrets never in URLs**, and a newer tenant extension that compares keys in constant time and fails fast on misconfiguration.

## 5. What they got wrong, or what Metistry should refuse

| Invariant or principle | Hindsight | Metistry: refuse · adapt · keep |
| --- | --- | --- |
| **Git is the record** (1) | the database is the record; everything derived is regenerated by a model; curation resets on reprocess; the disk mirror reverts local edits | **Refuse.** The vault is the record and the owner's edit is final (§2.5). |
| **Enforce at the tool** (the principle over all) | selectivity, "hard rules" (directives), "NEVER phrase anything as an instruction" (`inject.ts:17-19`), memory framed as "a record of the PAST", and ChatGPT set up with "Retain and recall aggressively—assume everything is valuable" (`hs:hindsight-docs/docs-integrations/chatgpt.md:56`) — every control is prose | **Refuse as controls.** Ours are ownership judged from the file on disk, compare-and-swap, one writer, and requests the owner answers. |
| **One read path** (3) | the control plane and `hindsight fs` read through the same HTTP API (`hs:CLAUDE.md:316-323`) — but every query is code inside the engine, and the filter that scopes a user is an argument the caller supplies | **Keep ours.** Reads are named queries — YAML the owner can read and overlay — run by one driver, with scope taken from the credential, never the caller. |
| **Shared responsibility** (2) | any holder of the key can retain, edit, invalidate, create or delete directives, `clear_memories`, `delete_bank`; destructive tools are only *annotated* (`hs:api/mcp_tools.py:564-582`); the injected wrapper tells the agent to write corrections itself (`inject.ts:105-108`) | **Refuse.** External agents propose (`capture`, `requests_create`); `knowledge_write` is internal-only; preview-then-confirm binds every destructive bridge tool. |
| **Every request authenticates as if internet-exposed** (8) | no auth by default and `DEFAULT_HOST = "0.0.0.0"` (`hs:api/config.py:1500`, applied at `api/main.py:270`), so `hindsight-api` and `hindsight-local-mcp` — documented as "All data stays on your machine" (`hs:hindsight-docs/docs-integrations/local-mcp.md:14`) — serve an unauthenticated API, `delete_bank` included, on every interface. Only daemon mode binds 127.0.0.1, "for security" (`api/main.py:127-137`) | **Refuse.** A bearer on every request and the uniform 401 before any MCP parsing (`packages/mcp-brain/README.md` § Transport). |
| **Scoping and tenancy** | a bank is a partition, not a permission: `allowed_bank_ids` is declared (`hs:api/models.py:31`) and read nowhere in the tree, so a key reaches every bank in its schema; per-user scoping inside a bank is a filter the caller chooses, and the default match includes untagged rows | **Keep ours.** Grants come from the credential (`authenticate(req)`), area prefixes are `WHERE` clauses in every mode, drafts are invisible at every tier. |
| **Auditability: what was remembered, and why** | audit off by default; no author on a memory; the extraction call visible for one day | **Keep ours.** Every tool call is a `runs` row; every write is a commit in the writer's name with a message saying why; `source` is stamped from the credential; `GET /api/knowledge/history` and `/version` show it (`docs/ops/client-api.md:338-339`). |
| **Prompt injection through remembered content** | commit messages from any contributor, transcripts carrying whatever the agent read, and third-party documents are extracted and synthesized into a session's first prompt by default (`autoInject: "reflect"`, `hs:ca/README.md:606`); the wrapper tag is concatenated around the memory unescaped (`inject.ts:84-110`) | **Adapt the lesson.** Remembered content is untrusted input. We inject nothing (`2026-09-21-agent-memory-lessons.md` §3.2), strings pass `sanitizeForAgent`, and a model-extracted fact about the owner is a request (C79). |
| **Cloud residency** | 35 `DEFAULT_*API_URL` constants across the integrations, **all** `https://api.hindsight.vectorize.io` and none localhost; the coding-agents installer defaults to `cloud` (`hs:ca/README.md:436, 478`), as do the LLM wrapper and the Obsidian plugin (`hs:hindsight-integrations/obsidian/src/settings.ts:27`); no public region or sub-processor statement | **Refuse.** No hosted default and no hosted service. A fork may point anywhere; the product points at the owner's machine. |
| **Spend nobody asked for** (4) | a default-on "codebase survey" spawns a headless agent at SessionStart (`claude -p --model haiku --max-budget-usd 2`; no spend cap for the other agents, `hs:ca/README.md:618-620`), and every project gets memory unless `optInOnly` (`:541`) | **Refuse.** Nothing spawns an agent on install; crews are the owner's, budgeted and audited; every model call is a `runs` row. |
| **No shell, no raw git** (9) | the server has neither; the integration does both on the owner's behalf — hooks run `git` over the repository (`gitIngest`), and the survey launches another agent's CLI headless | **Keep ours.** The assistant's whole mutating surface is `brain-commit` plus allowlisted bridges; a helper agent runs only as a crew the owner defined. |
| **Supply chain** | `autoUpdate: true` — once a day a session start runs `npx …@<version> update` in the background (`hs:ca/src/core/auto-update.ts:9-12`, `config.ts:693`), code that then sees every prompt; the local daemon runs `hindsight-embed@latest` (`hs:ca/README.md:482`) | **Keep ours.** `metistry update` is explicit and pinned in `.metistry/metistry.lock`. |
| **Secrets at rest** | the Cloud token sits in `~/.hindsight/coding-agent.json`, written with no `0600` (`hs:ca/src/installer.ts:167-171`), and is passed as `--api-token` on the command line | **Keep ours.** The Keychain, a bearer shown once, values on stdin. |
| **Secrets in memory** | Memory Defense — 45 patterns, redact or block — is **off on every bank** until a policy is set (`hs:dev/memory-defense/index.md:7, 45-47`) | **Adapt, on by default.** A secret in our vault is in git history for good, so the check belongs at the tool (HS-5). |

A smaller note: the pricing page promises "no telemetry", and the product code
bears that out as far as I searched (OpenTelemetry only when an operator
configures it; a local usage file for `stats`), but the README ends in a
third-party tracking pixel (`hs:README.md:442`). It counts readers of the page,
not users of the software.

## 6. Take, adapt, refuse — tickets and questions

| Metistry component | Hindsight | Take · adapt · refuse |
| --- | --- | --- |
| **`knowledge_search`** (`packages/mcp-brain/src/knowledge.ts`) | four arms, a cross-encoder, bounded boosts | **Adapt.** Our keyword arm reads only path, title and description (`knowledge.ts:206-217`), so a note's body is reachable only by `knowledge_grep` — add a derived full-text column (HS-2). Recency is a measured PoC (HS-3). No reranker: a dependency and another model. |
| **The eager surface** (X-49, open: the ratchet at 4,597 of 4,600 tokens, 28 tools) | 39 server tools, a curated 8 for agents | **Take the instinct, add no tool.** New reads are named queries (HS-4). |
| **Named queries** (`seed/queries/`) | a temporal arm; entity links | **Adapt** as `knowledge_changed_since` and `entity_recall` — deterministic parameters, not an LLM query analyzer (HS-4). |
| **`knowledge_write`, `capture`** | retain, edit and delete open to any key; the secret scan opt-in | **Keep ours**, and refuse a known secret before it is committed (HS-5). |
| **`knowledge-fold`** | observations with exact quotes and proof counts | **Adapt.** Lines the fold writes into entity pages cite the handle they came from, and the next pass reports any that do not (HS-6). |
| **`session-fold`** | extraction on every retain, no approval | **Keep ours.** A learned fact quotes the owner verbatim, one request per file, Approve writes as `user` — the mechanism they lack. |
| **`metistry connect`** | one installer, twenty agents, an exact uninstall | **Take**: Claude Code gets both directions in one verb (HS-1), and `connect --remove` undoes what `connect` wrote (HS-7). How wide to go is Q2. |
| **The Claude Code plugin** | a reflect synthesis injected into the first prompt | **Open** (Q1). If ever, handles only — never synthesized prose. |
| **The console's client API** | a control plane over the same API, with audit and LLM-request views | **Keep ours.** `/api/knowledge/history` and `/version` already answer *what did the assistant write, and why*. |
| **`packages/eval`** | stubbed system tests apart from judged evals; LoCoMo and LongMemEval runnable | **Take the split** for vault-seeded memory fixtures (HS-8). Borrow the benchmarks' question shapes, not their corpora (C11). |
| **`docs/product/website-brief.md:576`** | not named | Name Hindsight in the *Memory layers* row, with a source, under the page's own rule (HS-9). |

**Tickets** (proposed; none is in the plan):

1. **HS-1 · `connect claude-code` reads as well as writes** · S — besides the capture `export` lines, register the console's `/mcp` for Claude Code with the bearer taken from the Keychain-backed variable and never written literally into a config file; `connect --list` shows both halves; maps `docs/ops/cli.md` § connect; X candidate. *Unverified:* whether Claude Code expands `${VAR}` in a user-scope MCP header — the first test decides between writing the entry and printing the `claude mcp add` line.
2. **HS-2 · The keyword arm reads note bodies** · M — a derived `tsvector` over title, description and body, filled by the reconciler's walk (additive migration, Postgres's built-in `simple` configuration, no dependency); `keywordHits` ranks by `ts_rank` and keeps the path match; closes the 09-21 §3.7 row *keyword search cannot see a note's body*; X candidate.
3. **HS-3 · Recency, measured** · M · after HS-8 — compare a third RRF list over `indexed_at` (09-21 §4 row 6) with a bounded post-fusion multiplier in Hindsight's shape; adopt only if the recall fixtures rise and the abstention fixture holds; `mode` still reorders and never widens; X candidate.
4. **HS-4 · Time and entity recall as named queries** · S — `knowledge_changed_since {days, prefix}` over `indexed_at`, and `entity_recall {path, since}` over `knowledge_links` plus the `Journal/Fold/` notes linking to it (09-21 §4 row 9); `expose` per plan §2.10's grant rule; no new tool (X-49).
5. **HS-5 · A known secret never reaches the vault** · S — `capture` and `knowledge_write` run core's `SecretRedactor` over the content with the instance's named secrets and **refuse** on a hit, naming the secret, never the value. Misuse test: a capture carrying a stored secret's value makes no file, no commit, and one refused `runs` row. I found no such check today — the redactors run on egress, connections and the engine, not in `packages/mcp-brain/src/{capture,knowledge-write}.ts` or `apps/reconciler/src/` (by search; the ticket's first test should confirm). Maps T4-1, T4-2, invariant 8.
6. **HS-6 · The fold cites what it folded** · M — each line the fold adds to an entity page ends with its handle (request, run or artifact id) in one fixed form; the next pass diffs the previous fold's commit and raises one report listing uncited lines, never rewriting them; maps `knowledge-fold`, T3-10's quote check, X-10.
7. **HS-7 · `metistry connect --remove <tool>`** · S — removes exactly the entries `connect` wrote (the Cursor and OpenCode config keys, the Keychain item) and revokes the row; idempotent; X candidate.
8. **HS-8 · Memory fixtures on a seeded vault** · M — `FixtureContext.vault` and a read-only `live-read` tool mode (09-21 §5.2, still unbuilt: `packages/eval/src/tools.ts:13-16` stubs every tool); deterministic `tool_calls` axes kept apart from judged answers, with a judge model other than the candidate's; gates HS-3.
9. **HS-9 · Hindsight in the website brief** · S — one clause per column of the *Memory layers* row: what it does well (one command for twenty coding agents; LoCoMo and LongMemEval runnable from its repository), where Metistry differs (the owner's files are the record; an extracted fact is a request; nothing is hosted), sourced to this document.

**Open questions for the owner.**

1. **Should anything be pushed into an external agent's context?** Hindsight injects a synthesis into the first prompt by default, while its own docs argue for pull. Options: never (agents call `knowledge_search`, and the plugin's skill says so); or an opt-in SessionStart hook that injects **handles only** — titles and paths of pages under that agent's grant that match the repository — labelled, sanitized, never prose.
2. **How many agents should `connect` reach?** The owner's praise is for breadth, and each harness is a config format that drifts (their README records Qwen's millisecond timeouts, TraeCode's sandbox and opencode's v1/v2 split). Options: stay at four and document the generic MCP line for the rest; or a harness registry with a conformance test per entry, grown on request.
3. **Should a revoked tool be reconnectable?** Revocation is permanent and the id cannot be re-minted (`packages/cli/src/connect.ts:249-251`), so disconnect-and-reconnect — free in Hindsight — needs a hand-named agent here. Options: keep it; or a reconnect after revocation mints `claude-code-2`, leaving the old row's provenance intact.

## Sources

- Hindsight repository, `main` at `acfd157` (2026-09-30): <https://github.com/vectorize-io/hindsight> — `README.md`, `CLAUDE.md`, `LICENSE`; `hindsight-api-slim/hindsight_api/` (`models.py`, `config.py`, `main.py`, `mcp_tools.py`, `mcp_local.py`, `api/http.py`, `engine/audit.py`, `engine/retain/{fact_extraction,bank_utils}.py`, `engine/search/{retrieval,fusion,reranking,recall_boost,tags}.py`, `extensions/builtin/tenant.py`, `alembic/versions/`); `hindsight-cli/src/commands/fs/`; `hindsight-control-plane/src/middleware.ts`; `hindsight-extensions/static-keys-tenant/README.md`; `hindsight-integrations/{README.md,coding-agents/,obsidian/}`; `hindsight-system-evals/README.md`; `hindsight-docs/docs/developer/` and `hindsight-docs/docs-integrations/`.
- GitHub API: `repos/vectorize-io/hindsight`, its releases, commits, contributors and issue search (fetched 2026-09-30).
- Pricing: <https://vectorize.io/pricing>; docs home and FAQ: <https://hindsight.vectorize.io/>, <https://hindsight.vectorize.io/faq>; benchmark board: <https://benchmarks.hindsight.vectorize.io/>; paper: [arXiv:2512.12818](https://arxiv.org/abs/2512.12818) (all fetched 2026-09-30).
- Metistry at `origin/main` `f1742008`: `CLAUDE.md` invariants 1, 2, 3, 4, 8, 9; `docs/research/2026-09-21-agent-memory-lessons.md`; `packages/mcp-brain/README.md` and `src/{knowledge,knowledge-write}.ts`; `routines/knowledge-fold/run.ts`, `routines/session-fold/run.ts`; `seed/queries/knowledge_page_links.yaml`; `packages/cli/src/connect.ts`; `packages/core/src/redact.ts`; `packages/eval/src/tools.ts`; `docs/ops/{cli,claude-code-plugin,knowledge-search,client-api}.md`; `docs/product/design-build-plan.md` §2.9, §2.10, T3-10, X-10, X-49; `docs/product/website-brief.md:576`.
