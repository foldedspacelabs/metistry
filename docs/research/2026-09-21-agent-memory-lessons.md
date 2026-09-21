# Agent memory — lessons from TencentDB-Agent-Memory and the neighbours (2026-09-21)

Research commissioned by the owner the same day: *"Tencent DB agent memory.
https://github.com/TencentCloud/TencentDB-Agent-Memory has a similar goal to
what we've been building around remembering the user's context over time and
using it to make agent interactions better. Let's see if there are lessons for
us here."*

Nothing here is built. Sources were read in full and are cited with dates; the
Tencent repo was cloned at `b545fe9` (2026-09-20) and read on disk rather than
through the rendered README, so file paths below are theirs. Every claim about
Metistry cites a file and a line in **this checkout**. **The owner's instance
was not read** — no vault, no database, no fixtures.

## The short version

1. **Their layers are our folders, and they arrived there independently.**
   L0 raw conversation → L1 extracted atom → L2 scenario → L3 persona. L2 is
   `scene_blocks/<name>.md` and L3 is `persona.md` — **markdown files on
   disk**, with the vectors beside them as an index
   (`MemoryCore/src/core/storage/types.ts:258-290`). The two most valuable
   layers in the best-known Chinese agent-memory system are a folder of notes.
   That is our vault, and it is the single strongest finding here (§1.2).
2. **Every memory they keep was written by a model, and nothing asks the user
   first.** One LLM call segments the conversation and emits typed memories
   with a priority band the prompt dictates; a second LLM call decides
   store/update/merge/skip against the top-5 recalled neighbours
   (`core/prompts/l1-extraction.ts`, `core/record/l1-dedup.ts`). This is the
   one mechanism we must **not** adopt as-is: a model-extracted fact about the
   user is a proposal here, never a silent write (§4, rows 3–4).
3. **There is no forgetting curve. There is no decay. There is no
   recency weighting.** Repo-wide search for `decay|forgetting|half-life|
   ebbinghaus|recency|time_weight|遗忘` returns nothing in the memory path; the
   only `decay` in the repo is a per-hop graph-walk score factor in the Wiki
   (`MemoryKnowledge/src/mcp/tools.ts:166-170`). `confidence`, `expires_at`,
   `last_used_at` and `usage_count` exist as asset **metadata** and feed no
   ranking (§1.4). The literature's headline mechanism is absent from the
   27k-star implementation of it.
4. **Their retrieval constant is our retrieval constant.** `RRF_K = 60`
   (`MemoryCore/src/core/store/search-utils.ts:18`) and
   `RRF_K = 60` (`apps/reconciler/src/search.ts:58`). Both fuse a keyword list
   and a vector list by reciprocal rank because the two scores are not
   comparable. We built ours in Phase 6 for the same stated reason (§3.4).
5. **One benchmark number, and no harness behind it.** PersonaMem 48% → 76%
   (`README.md:275`). LoCoMo, LongMemEval and MemBench appear nowhere in the
   repo — not as a script, not as a fixture, not as a dependency. Mem0
   publishes 92.5 LoCoMo / 94.4 LongMemEval for comparison. Whatever we take
   from Tencent, we cannot take an evaluation (§1.7, §5).
6. **Their authorization is in the UI, not the service**, and they say so:
   delete and clear endpoints treat `Bearer + x-tdai-service-id` as a trusted
   admin credential and do **no owner check**, because "Owner 校验由面板转发前
   完成" — the panel validates before forwarding
   (`MemoryCore/v3-api-memorycore-doc.md:107`, `:621`). That is invariant 8's
   exact failure mode, in a system otherwise well-shaped. Worth naming because
   the architecture is good and the boundary is not (§1.8).
7. **Four gaps on our side are real and I verified each in code**: no memory
   type on a page; no recency signal in any ranking; `knowledge_search`'s
   keyword arm never reads a note's body; and `decisions:` is a frontmatter
   field the seed prompt asks for that **nothing parses, stores or queries**
   (§3.7). The last one is the cheapest fix in this document and the one the
   owner's question most directly names.
8. **Recommendation: adopt the vocabulary and two named queries now; PoC the
   recency-weighted rank; reject extraction-into-storage, decay, and the
   proxy** (§6). Six open questions, one of which (Q1) decides half the plan.

---

## 1. What TencentDB-Agent-Memory is

### 1.1 The shape

| | |
| --- | --- |
| repo | `TencentCloud/TencentDB-Agent-Memory`, created **2026-04-07**, last push **2026-09-20** |
| scale | 27,070 stars, 2,588 forks, 814 open issues (GitHub API, 2026-09-21) |
| language | **TypeScript**, Node ≥ 22.16 (`README.md` badge) |
| licence | **MIT** (`LICENSE`: "TencentDB Agent Memory is licensed under the MIT"). GitHub's API reports `NOASSERTION` because of the Tencent copyright preamble above the MIT text — the terms are MIT |
| default branch | **`feat/server_team`** — not `main`. A 27k-star project developing on a feature branch |
| version | v2.0.0 released; `CHANGELOG.md` top entry is `2.0.2-beta.1` (2026-09-07) |
| modules | `MemoryCore` (the memory algorithms + gateway), `MemoryKnowledge` (Wiki + CodeGraph), `MemoryPanel` (the control UI), `MemoryProxy` (a transparent LLM proxy), plus `sdk/`, `adapters/`, `deploy/` |

Positioning, from the repo description: "a **team-level memory hub** for AI
Agents — turning conversations, docs, and code into four reusable memory assets
(Chat Memory, Skill, LLM-Wiki, Code-Graph) that are governed, shared, and
equipped across agents and frameworks."

Two of the four assets are acknowledged borrowings (`README.md`,
Acknowledgements): CodeGraph "uses code from" `colbymchenry/codegraph`, and
Skill management "uses part of the Skill-related code from Hermes Agent". The
Wiki cites Karpathy's "LLM Wiki" gist as its design source. **We have already
reviewed Hermes twice** (`docs/research/2026-09-12-hermes-agent-review.md` and
`-2.md`), so one quarter of this system is prior art we have an opinion on.

The centre of gravity for our question is `MemoryCore` — Chat Memory. Skill,
Wiki and CodeGraph are a team-asset marketplace, which is not the owner's
question and is largely out of scope below.

### 1.2 The memory model — four layers, and two of them are markdown

From `README.md` ("Memory isn't flat records — it grows in layers"):

| Layer | What it stores | Where it lives on disk |
| --- | --- | --- |
| **L0 Conversation** | raw conversations with full context | `conversations/<date>.jsonl` |
| **L1 Atom** | facts, preferences, constraints, events extracted from conversations | `records/<date>.jsonl` + a vector/FTS index |
| **L2 Scenario** | knowledge blocks organised around projects or scenarios | **`scene_blocks/<name>.md`** |
| **L3 Core / Persona** | long-term profiles, stable patterns, high-level cognition | **`persona.md`** |

`MemoryCore/src/core/storage/types.ts:258-290` is the whole layout, and it also
carries `.metadata/scene_index.json`, `.metadata/checkpoint.json`, and
`.backup/persona/persona.<n>.md` — a versioned backup of the persona file.

**This is the finding.** Strip the branding and the top two layers of a
team-scale agent memory are *a folder of markdown files, one per topic, plus
one long-lived profile page, plus a JSON index and a backup directory*. That is
`Areas/`, `Me/profile.md`, `knowledge_files` and git. Their L2 filename is
normalised by a dedicated module (`core/scene/filename-normalizer.ts`) for the
same reason our vault is TitleCase with a casing check in CI.

The memory **types** are an enum, not a layer (`core/record/l1-extractor.ts:808`):

```ts
const VALID_TYPES: MemoryType[] = ["persona", "episodic", "instruction", "work_fact", "work_task", "work_method", "work_artifact"];
```

and two lines later:

```ts
if (lower === "preference") return "persona"; // fold preference into persona
```

So the taxonomy is: **persona** (stable attributes, preferences, skills,
values, habits), **episodic** (things that happened, decisions, plans,
outcomes), **instruction** (durable rules the user gave the agent about how to
behave), plus four `work_*` types for the team mode. Preferences are not their
own type. Procedural memory in the classical sense lives in the separate Skill
asset, not in Chat Memory.

The stored record (`core/record/l1-writer.ts:55-98`) is:

```
id, content, type, priority, scene_name, source_message_ids[], metadata,
timestamps[], createdAt, updatedAt, version, sessionKey, sessionId, taskId,
teamId, userId, agentId
```

`timestamps[]` is described as a "timestamp trail: all timestamps related to
this memory (for merge history tracking)" — their audit of a consolidation, and
the closest thing they have to provenance. `version` is monotonic: new memories
start at 1 and every update or merge increments.

### 1.3 How a memory gets written — a model, always

One LLM call does scene segmentation **and** memory extraction together
(`core/prompts/l1-extraction.ts`). The prompt is Chinese and explicit; the
priority bands are written into it as prose, e.g. for `persona`:

> 打分 (priority)：80-100（健康/禁忌/核心特质）；50-70（一般喜好/技能）；<50（模糊次要，可丢弃）
> *(score: 80–100 for health / taboos / core traits; 50–70 for general likes and skills; under 50 is vague and secondary, discardable)*

and for `instruction`, `-1` means an absolutely strict global directive. The
prompt also carries the three extraction principles ("better to omit than to
over-collect"; "each memory must stand alone outside the conversation";
"merge causally linked messages rather than fragmenting"), a do-not-extract
list (chit-chat, one-off requests, pure subjective feeling), and a strict JSON
output schema.

**The importance score is a number a model chose from a band a prompt
described.** It is not measured, not derived from use, and not revisable by
evidence. Everything downstream that reads `priority` inherits that.

Extraction is asynchronous and decoupled from capture: `core/hooks/auto-capture.ts`
writes L0 and notifies a pipeline manager — its own comment says
"Extraction is NOT triggered here. The pipeline manager decides when." L3
persona regeneration is triggered by a checkpoint policy with five priorities
(`core/persona/persona-trigger.ts`): explicit agent request, cold start,
recovery when `persona.md`'s body is empty, then interval-based.

### 1.4 Consolidation, dedup — and the thing that is not there

**Dedup is two-phase** (`core/record/l1-dedup.ts:1-14`): candidate recall per
new memory (top-5 by native hybrid search, else FTS ∥ client-vector merged with
RRF), then **one batch LLM call** judging every new memory against its
candidate pool. The verdicts are `store | update | merge | skip`
(`core/record/l1-writer.ts:114`).

Its degradation is worth quoting, because it is the opposite of ours:

> If neither FTS, client embedding, nor native hybrid is available, conflict
> detection is skipped — **all memories go straight to store.**

A store with no search capability silently accumulates duplicates. Our
equivalent decision — `knowledge_write` when the vault read path is
unavailable — **refuses** rather than waving the write through
(`packages/mcp-brain/src/knowledge-write.ts:339-343`: "could not read the note
to check who owns it — try again"). Same situation, opposite default.

**And now the absence.** I searched the whole repo for every spelling of the
mechanism the agent-memory literature leads with:

```
decay      → only MemoryKnowledge's Wiki graph walk: "Per-hop score decay factor
              when hop>0 (default 0.5)" (MemoryKnowledge/src/mcp/tools.ts:166-170)
forgetting → one comment about forgetting a tenant filter
half-life  → (nothing)
ebbinghaus → (nothing)
recency    → (nothing)
time_weight→ (nothing)
遗忘        → (nothing)
```

There is **no forgetting curve, no time decay, and no recency term in any
ranking.** What exists is metadata on the *asset* row
(`MemoryCore/scripts/db/sqlite-init.sql`, `meta_assets`): `confidence REAL`,
`expires_at`, `last_used_at`, `usage_count INTEGER NOT NULL DEFAULT 0`, plus a
`POST /asset/touch-usage` endpoint to bump them
(`v3-api-memorycore-doc.md:927`). None of them enters retrieval. They are
columns for a human reading the panel.

*Assumption, load-bearing:* I read the default branch `feat/server_team` at one
commit. A decay implementation on another branch, or in the closed Tencent
Cloud service the OSS repo fronts, would not appear here. What I can say
honestly is that **the open implementation has none**, which is the thing
relevant to us.

### 1.5 Retrieval

`core/hooks/auto-recall.ts` is the injection point, and its header is the
design in four lines:

> - Searches L1 memories using configurable strategy (keyword / embedding / hybrid)
>   - keyword: FTS5 BM25 … embedding: VectorStore cosine similarity …
>     hybrid: keyword + embedding merged with RRF
> - L3 persona injection
> - L2 scene navigation (full injection, LLM decides relevance)

`RRF_K = 60` with the standard `Σ 1/(k + rank)`
(`core/store/search-utils.ts:11-61`). The README states the layering policy:
"normally, L2/L3 provide a quick context bootstrap; when specific facts are
needed, BM25 + vector retrieval + RRF fall back to L1/L0. Results are further
capped by item count, character budget, and timeout limits to prevent memory
from overwhelming the context window."

**Their per-turn retrieval budget is a prompt, not a control.** From the
injected `MEMORY_TOOLS_GUIDE` in the same file:

> ### ⚠️ 调用次数限制
> 每轮对话中，tdai_memory_search 和 tdai_conversation_search **合计最多调用 3 次**。
> *(per conversation turn, memory_search and conversation_search may be called at most 3 times in total)*

A cap asserted in a system prompt is exactly what CLAUDE.md's closing principle
forbids. Ours is a schema: `queries_run` caps at 200 rows in code, `knowledge_grep`
at 50 files / 200 hits, each annotated `// limit: fixed`.

No retrieval path is time-weighted, entity-keyed, or importance-weighted.
`priority` is stored and returned on every hit (`L1SearchResult.priority`,
`core/store/types.ts:56-76`) and is not part of the rank.

### 1.6 Storage

**Not Postgres, and not pgvector.** Three backends behind one capability-flagged
interface (`core/store/types.ts:1-16`):

- **SQLite** — the default, one database file per instance
  (`scripts/db/sqlite-init.sql`, "v3.2 · 按实例分库"), with FTS5 for BM25.
- **Tencent Cloud VectorDB (TCVDB)** — advertises `nativeHybridSearch`, so
  dense + sparse in one call.
- **MongoDB** — experimental, off by default, added 2026-09-07
  (`CHANGELOG.md`), for mongot native full-text. The changelog is candid:
  "**切换存储后端不会迁移已有数据**" (switching backends does not migrate
  existing data) and there is no migration tool yet.

The SQLite schema I read in full is the *metadata* half — users, teams, agents,
tasks, assets, ACLs, config. The memory data itself is the JSONL + markdown
layout of §1.2 plus whichever vector store is configured. Tenancy is a
four-dimensional filter (`team_id / user_id / agent_id / task_id`) applied as a
WHERE clause everywhere (`core/store/isolation.ts`), with a `__legacy__`
backfill placeholder for rows that predate it.

### 1.7 Evaluation

One row, in the README (`README.md:275`):

| Benchmark | Without | With | Relative |
| --- | ---: | ---: | ---: |
| **PersonaMem** | 48% | **76%** | **+59%** |

That is the entire published evaluation. Searching the repo for
`PersonaMem|LoCoMo|LongMemEval|MemBench` returns **only those two README rows
and their Chinese translation** — no harness, no fixture file, no runner, no
dependency, no configuration. The two `bench-*` scripts in the repo are a
checkpoint-lock microbenchmark and a Mongo L0 write benchmark; neither is a
memory-quality evaluation.

So the number is unreproducible from the open repo, and it is on a benchmark
(PersonaMem) that the rest of the field does not lead with — Mem0 publishes
LoCoMo 92.5 and LongMemEval 94.4 (§2). **Take no evaluation from here.**

### 1.8 Sharing, privacy, erasure — and the boundary that is not one

The sharing model is genuinely good and worth naming:

| Visibility | Semantics (README) |
| --- | --- |
| `private` | "Only the Owner can read — not even team admins" |
| `team` | team members read; Owner/Admin manage |
| `restricted` | per-subject ACL: user / role / agent |
| `agent` | targeted equipping of one agent |

backed by `meta_asset_acl (asset_id, subject_type, subject_id, permission,
effect, granted_by)` with `permission ∈ read/write/delete/assign/share/use` and
an explicit `effect ∈ allow/deny`. New Chat Memory and Skills are private by
default: "Sharing is an explicit action, not a default leak."

Erasure cascades properly. `POST /v3/chat-memory/clear` empties L0/L1/L2/L3
content while **keeping the asset** (its ownership, bindings and ACL), and
reports what it removed per layer: `{ memory_id, cleared, l0_deleted: 10,
l1_deleted: 3, profile_deleted: 1 }` (`v3-api-memorycore-doc.md:615-655`).
Separating "forget the content" from "delete the container" is a distinction we
do not have and probably should not need, since our container is a file.

**And then the boundary.** Twice, in the API doc, verbatim:

> `conversation/delete`、`atomic/delete` 等删除接口信任 Bearer + `x-tdai-service-id`，
> **不做用户级鉴权**（与面板转发前校验一致）。
> *(:107 — the delete endpoints trust Bearer + service-id and perform no
> user-level authorization, consistent with the panel validating before it
> forwards)*

> 鉴权：Bearer + `x-tdai-service-id` 视为可信管理员级凭据，**不做用户级 Owner
> 校验**（Owner 校验由面板转发前完成）。
> *(:621 — treated as a trusted admin-level credential; no owner check; the
> owner check is done by the panel before forwarding)*

A four-tier ACL model, a per-asset permission table with allow/deny — and the
service that erases memory does not consult any of it. The check is in the UI
that calls the service. Anyone who reaches the service with a service token
bypasses the model entirely.

This is **invariant 8** stated as its own negation: "the network is not a
boundary … every request authenticates as if internet-exposed." The lesson is
not that Tencent is careless; it is that **a good permission model and an
enforced one are different artefacts**, and the gap is invisible from the
README. Our equivalent decision is the opposite and is load-bearing:
`ownershipRefusal` reads the file already on disk and never the caller's
claim (`packages/mcp-brain/src/knowledge-write.ts:263-269`), and the write
tool refuses a protected path itself rather than relying on the bridge
(`knowledge-write.ts:324`, with the comment "this is the same rule stated at
the tool the assistant actually holds, so the refusal never depends on the
bridge being reached").

### 1.9 The proxy — the one mechanism we could adopt and must not

`MemoryProxy` is a transparent LLM request proxy: point an agent's base URL at
it and "it changes no protocol and forwards OpenAI `/v1/chat/completions` and
Anthropic `/v1/messages` verbatim", doing session init, context injection,
conversation write-back, auth and billing around each call
(`MemoryProxy/README.md`).

**It would drop into our engine tomorrow.** `apps/assistant/src/engine-openai.ts`
is one OpenAI-compatible loop over `fetch`; a base-URL change is all the
integration this needs. That is precisely why it has to be refused: it would
make every turn silently write memory outside `brain-commit` — a mutating path
the `runs` ledger never sees, authored by a component the vault does not know
about. Invariant 9 ("`brain-commit` plus allowlisted bridges are the
assistant's entire mutating surface") and invariant 1 ("git is the record")
both fail at once. Named here because the ease of the integration is the danger.

One idea inside it is worth keeping, and it is free: injection is **split by
volatility**. From their own summary — "injects Skills, Knowledge and Memory
L2/L3 into the system prompt on demand; **L0/L1 are exposed as read-only tools**
for the model to query proactively, **avoiding upstream KV-cache
invalidation**." Stable layers ride in the cached prefix; volatile ones stay
behind tools. That is the same conclusion `docs/research/2026-09-cost-optimization.md`
reached about prompt-cache hygiene, arrived at from the memory side, and it is
an argument for keeping any future memory injection **small and stable** (§4,
row 8).

---

## 2. The neighbours, one line each

Metadata from the GitHub API on **2026-09-21**; the distinctive claim is from
each project's own README or paper.

| Project | Lang / licence / stars / last push | What is distinctive |
| --- | --- | --- |
| **Mem0** (`mem0ai/mem0`) | Python, Apache-2.0, 65.7k, 2026-09-19 | The benchmark leader and the one that publishes end-to-end numbers: "New Memory Algorithm (April 2026)" claims **LoCoMo 71.4 → 92.5** and **LongMemEval 67.8 → 94.4** at ~7k tokens and ~1s p50. Extraction + a `ADD/UPDATE/DELETE/NOOP` decision over retrieved neighbours — structurally Tencent's dedup, published two years earlier. |
| **Letta / MemGPT** (`letta-ai/letta`) | Apache-2.0, 24.8k, 2026-09-10 | "Stateful agents": memory is an OS-like tiered address space (in-context core memory blocks + out-of-context archival/recall, paged by the agent's own tool calls). The current harness has moved to `letta-ai/letta-code`. Its claim is that memory management belongs *to the agent itself*, not to a pipeline beside it. |
| **Zep / Graphiti** (`getzep/graphiti`) | Python, Apache-2.0, 31.0k, 2026-09-21 | A **bi-temporal knowledge graph**: "tracks how facts change over time, maintains provenance to source data, and supports both prescribed and learned ontology", with "incremental data updates … and precise historical queries without requiring complete graph recomputation" (arXiv:2501.13956). The only neighbour whose core abstraction is *when a fact was true*, separately from when it was recorded. |
| **LangMem** (`langchain-ai/langmem`) | Python, MIT, 1.7k, 2026-09-09 | Two modes, cleanly separated: "memory management tools that agents can use … **in the hot path**" and a "**background memory manager** that automatically extracts, consolidates, and updates". Storage-agnostic primitives over LangGraph's `BaseStore`. The hot/background split is the clearest statement of a choice everyone else makes implicitly. |
| **A-MEM** (`agiresearch/A-mem`) | Python, MIT, 1.2k, **last push 2025-12-12** | Zettelkasten as the organising principle: each memory is a note with structured attributes, contextual description and tags; new notes are **linked** to similar existing notes and both can be rewritten ("memory evolution") (arXiv:2502.12110). The closest academic relative of a wiki-shaped memory; effectively dormant. |
| **Anthropic memory tool** (`memory_20250818`) | first-party, platform docs | "a directory of memory files" with six commands (`view/create/str_replace/insert/delete/rename`), and — decisively — "**The memory tool operates client-side: Claude requests file operations, and your application executes them.** You control where and how the data is stored." The vendor's memory model is *files your application owns*. |
| **Claude Code auto memory** | first-party, product docs | Four types recorded as a `type` frontmatter field — `user`, `feedback`, `project`, `reference` — in `~/.claude/projects/<project>/memory/`, with a **`MEMORY.md` index, one line per memory, loaded into every session** (first 200 lines / 25 KB) and topic files read on demand. A `modified` ISO timestamp is stamped on every write. Consolidation is budget-triggered: over the limit, the write succeeds but the tool returns an error telling Claude to rewrite the index. |

Two things fall out of that table and neither is in the Tencent repo:

- **Bi-temporality (Zep) is the only mechanism that answers "what did I believe
  three weeks ago"** as distinct from "what do I believe now". Our vault has it
  for free and does not use it: git is the valid-time record and
  `GET /vault/log` already exposes it (`apps/reconciler/src/server.ts:261`).
- **Anthropic's two answers are both ours already.** The memory tool's storage
  model *is* the vault; `knowledge_read`/`knowledge_write` *is* the handler —
  with compare-and-swap, provenance stamping and an ownership rule that the
  reference handler in the docs does not have. And auto memory's shape —
  typed markdown, a small always-loaded index, everything user-editable — is
  the shape §4 recommends, validated by the vendor on a different product.

---

## 3. What Metistry has today

### 3.1 The record is the vault; the index is derived

The vault is the instance directory minus `.metistry/` (CLAUDE.md, ruled
2026-09-17). The reconciler walks it and fills seven derived tables — five of
them the knowledge index below, plus `proposals` and `inbox`
(`db/migrations/0024_vault_tasks.sql`'s own note). Every one is rebuildable
from the markdown:

| Table | Columns that matter here | Where |
| --- | --- | --- |
| `knowledge_files` | `path, mtime, content_hash, indexed_at, status` | `db/migrations/0001_init.sql:92-99` |
| | `+ title, description, draft` | `db/migrations/0009_brain.sql:10-12` |
| | `+ embedded_hash, embedded_model` | `db/migrations/0012_knowledge_embedded.sql:19-20` |
| `knowledge_links` | `from_path, to_path, kind` (wikilink \| frontmatter \| embed) | `0001_init.sql:102-108` |
| `embeddings` | `path, chunk_index, content, model, dim, vector(768)`, HNSW cosine | `0001_init.sql:114-126` |
| `vault_tasks` / `vault_task_refs` | 31 derived columns per `- [ ]` line; block-anchored backlinks | `db/migrations/0024_vault_tasks.sql` |

**Frontmatter is parsed for exactly five fields** — `title`, `description`,
`draft`, `source`, `area` (`apps/reconciler/src/notes.ts:10-22, 52-73`).
Anything else a note carries is bytes.

**`mtime` decides nothing and `indexed_at` is the honest clock.** The indexer's
own header: "hash CONTENT (sync churns mtime, so mtime decides nothing)"
(`apps/reconciler/src/indexer.ts:1-2`), and the upsert runs only when the
content hash changed, setting `indexed_at = now()`
(`indexer.ts:255-269`). So `indexed_at` is *when this note's content last
changed* — a usable recency signal that `mtime` is not. `seed/queries/knowledge_pages.yaml`
says the same thing from the other side, refusing to order by `mtime` because
"sync churns it constantly".

### 3.2 What is actually in a turn

Less than one might assume, and this is the baseline any memory proposal moves.

- **System prompt** = `identity.yaml` + `assistant-prompt.md` through the D4
  overlay, and nothing else (`apps/assistant/src/prompt.ts:99-113`). It
  refuses to start rather than fall back to the seed identity (`:100-106`).
- **History** = the replayed `assistant_sessions` row, capped at
  **60 messages / 120,000 chars**, trimmed from the front, then advanced to the
  first `user` message (`apps/assistant/src/sessions.ts:41-64`). Its own
  comment is the policy: "**A cap, not a compaction strategy: what falls off
  the front is gone, and the re-brief path is what recovers it.**"
- **The message.** `engine(prompt, { model, effort, resume, … })`
  (`apps/assistant/src/drain.ts:122`) — the routed text, and that is all.

**No vault content, no `now.md`, no search results and no memory are injected
into a turn.** Everything the assistant knows about the user's past, it fetches
by calling a tool. That is a deliberate and good position — it is Anthropic's
"just-in-time context retrieval" and Tencent's own tools-not-prompt split for
L0/L1 — and it means we are not paying for memory we do not use.

The one exception is the crew path: `briefThreadBlock()`
(`apps/assistant/src/crew-drain.ts:194-219`) folds a task room's prior comments
into a helper agent's brief under a byte budget, newest-first while filling and
oldest-first when read. That is the only assembled-context mechanism in the
repo, and it is a good template.

### 3.3 Consolidation is the fold, and it already has the hard parts

`routines/knowledge-fold/run.ts` + `docs/ops/knowledge-fold.md`. Three rules,
each of which the Tencent pipeline either lacks or enforces by prompt:

1. **It reads only what is new since its last successful fold.** The anchor is
   its own `runs` row (`component='knowledge-fold', kind='routine_run', ok,
   meta.folded=true`); a skipped pass writes no anchor, so the window never
   slides past unread material. Cold start is 7 days, not all of history.
2. **It writes only inside reserved paths** — `Journal/Fold/<date>.md` and the
   entity pages it owns — enforced at `knowledge_write`, not asked for.
3. **It never reads its own output**, by construction: every handle in the
   brief comes from Postgres and the routine never opens the vault.

The brief is **handles, never content**, capped at 4 KB, dropping from the
largest group with "…and N more". It runs as exactly one turn
(`tier: routine`, `fresh_session: true`), on the cheap tier.

This is a consolidation pass with a watermark, a budget, a reserved write
surface and an audit row. Tencent's pipeline has a checkpoint
(`.metadata/checkpoint.json`) and nothing else on that list.

### 3.4 Retrieval, precisely

Four tools, and their real parameters:

| Tool | Params | What it actually searches |
| --- | --- | --- |
| `knowledge_search` | `query, limit, mode` (`packages/mcp-brain/src/server.ts:491-497`) | keyword arm: `path ILIKE $1 OR title ILIKE $1 OR description ILIKE $1`, ordered **alphabetically**, score = `1/(1+i)` rank decay (`packages/mcp-brain/src/knowledge.ts:195-207`). semantic arm: cosine over chunk embeddings, one row per note (`:210-228`). hybrid: RRF |
| `knowledge_read` | `path` | one note; returns the `sha256` that `knowledge_write` needs |
| `knowledge_list` | `prefix, depth, links_for` (`packages/mcp-brain/src/knowledge-fs.ts:271`) | the tree — or, with `links_for`, **that page's in- and out-edges**: "the graph rather than the tree" |
| `knowledge_grep` | `pattern, prefix, limit` (`knowledge-fs.ts:432`) | note **bodies** by regex, in a worker thread with a 1,500 ms kill |

Fusion is `RRF_K = 60`, `Σ 1/(60 + rank)` (`apps/reconciler/src/search.ts:58,
129-134`), identical to Tencent's constant and adopted for the stated reason:
"a substring hit has no magnitude and a cosine similarity is not a probability,
so the two scores cannot be added" (`docs/ops/knowledge-search.md`).

Degradation is honest throughout: an explicit `mode=semantic` with no embedder
answers in keyword and sets `degraded` rather than failing or returning nothing.

**There is no time term, no importance term and no entity filter in any of
it.** `knowledge_search` cannot be asked for "the last month", and
`knowledge_list { links_for }` — the entity-centric path — is not reachable
from a search at all.

### 3.5 The four memory types are already here, unnamed

Mapping the literature's vocabulary onto what exists:

| Type | Where it already lives | Enforced how |
| --- | --- | --- |
| **working** | the `assistant_sessions` row + `now.md` — whose seed text literally reads "**The assistant's working memory of the present**" (`seed/vault/now.md:6`) | a 60-message cap; `now.md` is the one page the assistant is expected to keep writing |
| **episodic** | `Journal/Fold/<date>.md`, written nightly; `Journal/Meetings/`, `Journal/Standup/`, `Journal/Plan/` | the fold's reserved paths |
| **semantic** | `Areas/**`, `People/`, `Projects/`, `Resources/` | ownership at the tool |
| **procedural** | `.metistry/rules.yaml` (deterministic router + tiers) and `Me/Working Style.md` (prose, `{{ include }}`d verbatim into the plan and standup) | `rules.yaml` is a protected path; Working Style is the user's |
| **user profile** | `Me/profile.md` — and it ships **empty on purpose**: "Metistry discovers these from you; it never assumes them (owner ruling Q4)" (`seed/vault/Me/profile.md:4-5`) | absent → the routine records `skipped: no_working_days` rather than guessing (`docs/product/daily-flow-spec.md` §6.6) |

**We have the layers. We have never named them, and nothing in the schema
knows about them.** That is the gap §4 attacks first, because naming them costs
almost nothing and makes every later mechanism addressable.

### 3.6 The write path, and why it is the strongest thing here

| Property | Mechanism | Where |
| --- | --- | --- |
| one writer | only a principal of kind `internal` may `knowledge_write`; sub-agents and external agents `report` | `packages/mcp-brain/src/knowledge-write.ts:1-16` |
| ownership | `source` frontmatter, judged from the file **already on disk**, never from the incoming content; **no `source:` at all means the user**, not ownerless | `knowledge-write.ts:263-269` |
| provenance | `source` stamped from the credential, `updated` stamped today — never an argument | `knowledge-write.ts:348-355` |
| no blind overwrite | an omitted `expected_sha256` is **create-only**; an existing note comes back `conflict` | `knowledge-write.ts:359-362` |
| protected paths | `.metistry/**`, root `CLAUDE.md`, root `README.md` — refused at the tool as well as the bridge | `packages/core/src/instance-layout.ts:187`; `knowledge-write.ts:324` |
| proposals | anything unsettled is `capture` or `requests_create` → the Needs You queue → six verbs, `allow` / `accept_with_changes` / `deny` / snooze / skip | `docs/ops/reply-feedback.md` |
| erasure | a commit in the instance repo; the assistant has no `delete` and no `rename` at all | `docs/ops/knowledge-fold.md`, "Deliberately not built" |
| audit | every tool call is a two-phase `runs` row grouped by `turn_id`; every write is a commit in the writer's name | `docs/ops/knowledge-fold.md`, "Seeing what it did" |

**One gap in that table, and I want to be precise about it.** `Me/` is *not* in
the protected set. It is protected today only by the ownership rule, and the
ownership rule fires only on an **existing** note — "new notes are always
allowed" (`knowledge-write.ts:334-336`). `Me/profile.md` and
`Me/Working Style.md` ship with `source: user`, so those two are safe. A **new**
page under `Me/` — `Me/Preferences.md`, say — is not refused at the tool: the
internal principal's grant is the bare vault `/` (`packages/core/src/access.ts:164-165`),
and the "don't write `Me/`" rule exists twice as prose
(`seed/assistant-prompt.md:19`, `routines/knowledge-fold/run.ts:255`) and
nowhere as a control. That is the one place this design currently prompts where
it means to enforce, and §4 row 4 depends on closing it.

### 3.7 What is missing — each claim verified

| Claim | Verified how | Status |
| --- | --- | --- |
| **No memory-type model.** No page or row says whether it is episodic, semantic or procedural | `apps/reconciler/src/notes.ts:52-73` parses five frontmatter fields; `type` is not one. `seed/vault/Templates/Fold.md` sets `type: resource` — a template tag the index ignores | **true** |
| **No importance and no last-accessed.** Nothing counts reads or scores a page | every `ALTER TABLE knowledge_files` in `db/migrations/` adds exactly five columns (`title, description, draft, embedded_hash, embedded_model`) | **true** |
| **No decay and no recency weighting.** Nothing ages | `rankKeyword` is `1/(1+i)` on alphabetical order (`apps/reconciler/src/search.ts:95-97`); `semantic` is pure cosine (`:99-127`); `fuse` is pure RRF (`:129-140`); `knowledge_pages.yaml` orders by `path COLLATE "C"` | **true** |
| **No per-entity memory page beyond People/Projects** | `seed/vault/` ships `People/` and `Projects/` with READMEs and no pages; `Resources/` is named by `seed/assistant-prompt.md:41` but **is not a seeded directory**; `Areas/` likewise exists only as a convention in `docs/ops/cli.md` grants | **true, and two directories are named but unseeded** |
| **No "what did I decide" recall** | `decisions:` appears in **one** file in the entire repo — `seed/assistant-prompt.md:40`, which asks the fold to write it. It is not parsed (`notes.ts`), not a column (`db/migrations/`), not a named query (26 files in `seed/queries/`), and `Decisions/` appears nowhere | **true — and worse than "missing": we ask for a field nothing reads** |
| **Keyword search cannot see a note's body** | `keywordHits`' WHERE clause is `path ILIKE OR title ILIKE OR description ILIKE` (`packages/mcp-brain/src/knowledge.ts:198-201`) | **true.** With no embedder, a decision recorded in a note's body is reachable only by `knowledge_grep` with the right regex |
| **The brief cannot recall anything from the vault** | `routines/morning-brief/run.ts` reads Postgres only; its own comment at `:158-159` says richer prep — "**People notes, last-meeting decisions**" — "arrives when the vault exists to look them up" | **true, and already flagged in-repo** |

That last row is the owner's question, written down in our own source a while
ago and not yet answered.

---

## 4. Lessons — one table

The shape every row is held to: **a memory is a vault note or a frontmatter
field, never a hidden store** (invariant 1); **consolidation is the fold**;
**retrieval is a named query plus the bridge search** (invariant 3); **the user
can read and edit every memory in Obsidian**; **erasure is a git commit**; and
a model-extracted fact about the user is a **proposal**, never a silent write.

| # | Mechanism (source) | Applicable? | How it maps onto our shape | Cost | Conflicts |
| --- | --- | --- | --- | --- | --- |
| 1 | **Typed memories** — `persona / episodic / instruction` (Tencent `l1-extractor.ts:808`); `user / feedback / project / reference` (Claude Code auto memory) | **Yes — adopt the vocabulary, not the store** | A `memory:` frontmatter enum on a page (`episodic \| semantic \| procedural \| profile`), parsed into a nullable `knowledge_files.memory_type` column beside `area`. The vault stays the record; the column is derived and rebuilt by the walk. Obsidian shows it in the properties pane | ~0.5 day: one additive migration, ~6 lines in `notes.ts`, one index. No new table, no new tool | None. Additive per CLAUDE.md; derived per invariant 1 |
| 2 | **A small always-loaded index** — `MEMORY.md`, one line per memory, 200 lines / 25 KB (Claude Code); L3 `persona.md` injected every turn (Tencent) | **Partly — we have it and it is empty** | `now.md` already *is* this file, and says so. Give it a stable "Recent decisions" section the fold appends one line to, and leave injection alone: the assistant reads it with `knowledge_read`, it does not ride in the prefix | ~0 for the section; a prompt edit for the fold | None — but see row 8 before considering injection |
| 3 | **LLM extraction of facts from conversation** (Tencent §1.3; Mem0; LangMem background manager) | **No — not as a write** | The fold already does the reading half. The output must be a `capture` / `requests_create` into Needs You, decided by the owner, and only then folded. This is exactly what `seed/assistant-prompt.md:19` already says | ~0 (it is the status quo) | **Would violate invariant 2** and the Q4 ruling ("Metistry discovers these from you; it never assumes them"). Also C11-adjacent: extracted facts are not training data, but the same instinct applies |
| 4 | **A user-preference page the system maintains** (Tencent `persona`; Claude Code `type: user`) | **Yes — as a proposal target, with the gap closed first** | A `Me/Preferences.md` the **fold proposes updates to**, never writes: the proposal payload carries the diff, Approve writes it in the owner's name. **Prerequisite:** add `Me/` to the tool-enforced refusal so "new notes are always allowed" stops applying there (§3.6) | ~1 day: the `Me/` guard + a misuse test (invariant 8), then the fold's proposal path, which already exists | None once the guard lands. Without the guard this is prompt-enforced, which CLAUDE.md's closing principle forbids |
| 5 | **Importance + last-accessed as columns** (Tencent `meta_assets.confidence / usage_count / last_used_at`) | **Half — and not the half they built** | `usage_count` / `last_accessed` would be **not reconstructible** from the vault: `docker compose down -v` and they are zero, which fails invariant 1's test. **`indexed_at` already is** the honest content-change clock (`indexer.ts:255-269`) and *is* reconstructible by a walk. So: no new counters; use `indexed_at` | ~0 | A `usage_count` column would open D6 (the durable set). `indexed_at` does not |
| 6 | **Recency-weighted hybrid rank** (nobody — Tencent has none; the literature's headline) | **PoC, not adopt** | A third RRF list: notes by `indexed_at DESC`, fused with the existing two at the same `k=60`. `Σ 1/(60+rank)` over three lists instead of two — one list, no new score space, no tuning knob. It must be **a mode, not the default** (`mode: recent`), because `knowledge_search`'s contract is that mode "only reorders results, never what you can see" | 1–2 days incl. tests; the search path is one file | **One honest caveat:** `indexed_at` flattens on a full rebuild, so this ranking degrades after `down -v` until the vault is re-edited. That is acceptable for a *ranking* and would not be for a *fact*; stated here rather than discovered later |
| 7 | **Decay / forgetting curves** (the literature; **absent from Tencent**) | **No** | Nothing in the vault should get quieter because time passed. A note that stops being true gets **edited or deleted by a commit**, which is legible; a note that fades by arithmetic is a silent behaviour change the owner cannot see or diff. Anthropic's own guidance here is a suggestion to the *operator* ("periodically delete memory files that haven't been accessed in a long time"), not a ranking mechanism | — | Would violate invariant 1's spirit: the record is git, and git does not decay |
| 8 | **Inject stable layers, keep volatile ones behind tools** (Tencent MemoryProxy: "avoiding upstream KV-cache invalidation") | **Yes — as a written rule, pre-emptively** | We inject nothing today (§3.2), which is the right end of the spectrum. Write the rule down before the first memory-injection proposal: anything injected must be stable across turns, or it burns the cached prefix on every turn. Corroborates `docs/research/2026-09-cost-optimization.md` | one paragraph in `docs/ops/assistant-tools.md` | None |
| 9 | **Entity-centric recall** (A-MEM's Zettelkasten links; Tencent's Wiki link graph with hop-decay) | **Yes — we have the graph and do not use it** | `knowledge_links` is bidirectional and indexed both ways; `seed/queries/knowledge_page_links.yaml` already serves it; `knowledge_list { links_for }` already exposes it to the assistant. What is missing is the **habit**: a named query `entity_recall(path, since)` returning a person's or project's page plus its incoming edges plus the `Journal/Fold/` notes that link to it. `People/<Name>.md` becomes the memory page | ~1 day: one named query, no schema change, no new tool (invariant 3's default answer to "add a read capability") | None. Invariant 3 is satisfied by construction |
| 10 | **A decision log** (Tencent `episodic` type covers "decisions"; Zep's bi-temporality) | **Yes — the cheapest thing in this document** | Stop asking for a field nothing reads. Either (a) parse the existing `decisions:` frontmatter list into a derived `knowledge_decisions (path, text, decided_on)` table filled by the same walk, or (b) a `Decisions/` page pattern with a `decided_on:` field. **(a) is better**: the fold already writes `decisions:` (`seed/assistant-prompt.md:40`), the note stays the record, and the table is derived in full. Then one named query `decisions_since(days)`, and one line in the morning brief — which is the in-repo TODO at `routines/morning-brief/run.ts:158-159` | ~1.5 days: one additive migration, ~15 lines in `notes.ts`, one named query, one brief section | None. Derived, additive, one read path |
| 11 | **Bi-temporality** — when a fact was true vs when it was recorded (Zep/Graphiti) | **No new mechanism — surface the one we have** | Git is the transaction-time record and `GET /vault/log` (`apps/reconciler/src/server.ts:261`) already exposes it. Valid time, where it matters, is a field the user types (`decided_on`, `due`). A temporal graph is a second record beside git | ~0 | A second temporal store would violate invariant 1 |
| 12 | **A transparent LLM proxy that writes memory** (Tencent MemoryProxy) | **No — and it is the easiest thing here to do by accident** | `engine-openai.ts` is one `fetch` loop; a base URL is the whole integration. It would create a mutating path outside `brain-commit` with no `runs` row and no commit | — | **Violates invariants 1, 9 and 10 simultaneously.** Refuse by policy, in writing |
| 13 | **Per-turn retrieval budget** (Tencent: "at most 3 calls", asserted in a prompt) | **Yes — as a control if it is ever wanted** | If a memory-search budget is ever needed it is a counter in `server.ts`'s `wrap()`, keyed by `turn_id`, returning a refusal — not a sentence. We already cap rows (`queries_run` 200), files (`knowledge_grep` 50) and runtime (1,500 ms), each annotated `// limit: fixed` per R4 | ~0 today (no evidence a budget is needed) | The prompt version violates CLAUDE.md's closing principle |
| 14 | **Visibility tiers + per-asset ACL** (Tencent `private/team/restricted/agent`) | **No — we have a better-fitting model** | Single-user instance; `grants.tier` + `areas` + the ownership rule already decide who reads and writes what, and they are enforced at the tool rather than in a panel (§1.8) | — | None |
| 15 | **Content erasure separate from container deletion** (Tencent `chat-memory/clear`, `l0/l1/profile_deleted`) | **No** | Our container is a file. Erasure is `git rm` by the owner's hand; the derived index follows on the next walk. Nothing needs a two-phase delete | — | None |

---

## 5. Evaluation

### 5.1 The public benchmarks, against `packages/eval`

The harness (PoC-18) is the right runner and needs no replacement, which is
routing feedback worth having: `packages/eval/src/tools.ts` builds tool
definitions from `mcp-brain`'s real `tools/list` ("THE DEFINITIONS ARE
PRODUCTION'S"), `fixtures.ts` validates cases against five axes, `score.ts`
splits deterministic from rubric scoring, and `record.ts`'s `RunRecord` already
carries `steps`, `tool_errors`, `prompt_tokens` and the cache columns per case.

Three limits decide what can actually be run:

1. **C11 forbids the corpora outright for anything resembling training, and
   the licences complicate the rest.** LoCoMo, LongMemEval, PersonaMem and
   MemBench are third-party conversation datasets. Running our assistant
   against someone else's synthetic persona measures a general-purpose memory
   layer, which is not the product: Metistry's memory is *this owner's vault*.
   **The fixtures stay the owner's fifty** (`docs/plan-refresh-2026-09-13.md`
   §4a; not read here).
2. **Tool execution is stubbed record-only** (`packages/eval/src/tools.ts:13-16`):
   "Nothing the candidate calls touches a vault, a task or a row." A memory
   fixture whose whole point is *did the right note come back* cannot be scored
   under that contract. This is the real harness gap and it is not small.
3. **`FixtureContext` has two fields** — `thread` and `brief`
   (`packages/eval/src/fixtures.ts:95-100`). There is nowhere to say "and the
   vault contained this".

So the honest answer on public benchmarks is: **do not run them.** If the owner
ever wants a comparable number, the cheap version is to borrow only the
*question shapes* LoCoMo and LongMemEval use — single-hop recall, multi-hop
recall, temporal reasoning, knowledge update, abstention — and write five of
the owner's own fixtures in each shape. That is a taxonomy, not a dataset, and
carries no licence or C11 exposure.

### 5.2 A Metistry-specific memory eval

The question the owner actually asked — *"does the brief recall the decision
from three weeks ago"* — is scorable today with two additions:

- **`FixtureContext.vault`**: a list of `{ path, content }` seeded into a
  throwaway vault before the case runs. Small (a handful of notes), owner-written,
  committed beside the fixtures.
- **A third execution mode for `tools.ts`**: `stub | record-only | live-read`,
  where `live-read` serves `knowledge_search / read / list / grep` from that
  seeded vault and a scratch database, and every mutating tool stays stubbed.
  Read-only, so nothing the candidate does can escape the fixture, and the
  existing hallucination detection is unchanged.

Then the cases are ordinary fixtures on axes we already have:

| Fixture shape | Axis | Expectation |
| --- | --- | --- |
| "What did we decide about the vault layout?" — the decision is in `Journal/Fold/` three weeks back | `tool_calls` | expects a `knowledge_search` (or `queries_run: decisions_since`), and **no** `capture` — it should recall, not re-ask |
| The same question, scored on the answer | `triage` (rubric) | `must_include` the decision's distinguishing phrase |
| "What did we decide about X?" where nothing was decided | `triage` | **abstention** — `must_not_include` a fabricated decision. The most important case in the set, and the one the literature under-tests |
| "Remind me about [[Ada]] before this meeting" | `tool_calls` | expects `knowledge_list { links_for: "People/Ada.md" }` — the row-9 habit, measurable |
| A preference the owner stated once, three sessions ago | `voice` / `triage` | the reply respects it without being re-told |
| A preference the owner **changed** | `triage` | the reply follows the **newer** one — knowledge update, which is where Mem0's `UPDATE` verb earns its keep and where a naive vault search fails |

**State the adoption rule before running**, so a result cannot be read to
taste: a memory mechanism ships only if it raises the recall-fixture pass rate
**and** does not lower the abstention fixture's. A memory system that recalls
more by inventing more is a regression.

Effort: ~2–3 days for `FixtureContext.vault` + `live-read` + the golden-file
plumbing; the fixtures themselves are the owner's hand and cannot be written
here.

---

## 6. Recommendation

### 6.1 The decision table

| | Decision | Why | Effort |
| --- | --- | --- | --- |
| **`decisions:` → a derived table + `decisions_since` named query + one brief line** | **Yes — first** | We already ask the fold to write the field and nothing reads it (§3.7). This is the owner's question, answerable by wiring up a field that exists. Closes the in-repo TODO at `routines/morning-brief/run.ts:158-159` | ~1.5 days |
| **`memory:` frontmatter enum → `knowledge_files.memory_type`** | **Yes** | Names the four layers we already have (§3.5) and makes every later mechanism addressable. Additive, derived, zero new surface | ~0.5 day |
| **An `entity_recall` named query over `knowledge_links`** | **Yes** | The graph is built, indexed both ways and unused by any recall path. Invariant 3's own default: a new read capability is a named query, not a tool | ~1 day |
| **Close the `Me/` gap at the tool** | **Yes — before anything writes near `Me/`** | The rule is prose in two places and a control in none (§3.6). Ships with misuse tests per invariant 8 | ~1 day |
| **`Me/Preferences.md` proposed by the fold, never written** | **Yes, after the guard** | A profile the system maintains, under the Q4 ruling and invariant 2: the assistant drafts, the owner approves, the write lands in their name | ~1 day |
| **Write down the injection rule** (stable in the prefix, volatile behind tools) | **Yes** | Free, and it pre-empts the first memory-injection proposal (§4 row 8) | one paragraph |
| **Write down the proxy refusal** | **Yes** | The easiest architectural mistake available to us, because it is a base-URL change (§1.9) | one paragraph |
| **Recency-weighted `mode: recent`** | **PoC, gated on §5.2's harness** | Plausible and cheap, but unmeasurable today. Do not ship a ranking change without the fixture that says it helped | 1–2 days after the harness |
| **`FixtureContext.vault` + `live-read` in `packages/eval`** | **Yes — it gates the PoC above** | Without it no memory claim in this document can be tested | 2–3 days |
| **LLM extraction into storage** (Tencent, Mem0, LangMem background) | **No** | Facts about the user are proposals. The fold already does the reading half; the missing half is deliberately the owner's | — |
| **Decay / forgetting curves** | **No** | Nothing should get quieter because time passed; a stale note is edited by a commit. Note that **Tencent did not build this either** | — |
| **MemoryProxy-shaped integration** | **No, in writing** | Violates invariants 1, 9 and 10 at once | — |
| **Public memory benchmarks** (LoCoMo, LongMemEval, PersonaMem, MemBench) | **No — borrow the question shapes only** | C11 plus a product argument: our memory is this owner's vault, not a synthetic persona's | — |
| **Visibility tiers / ACL / two-phase erasure** | **No** | Single user; grants + ownership + git already cover it, and are enforced at the tool rather than in a panel | — |

### 6.2 Phasing

- **Now (~4 days, no new dependency, no new tool):** rows 1–7 of §6.1. Every
  one is a frontmatter field, an additive migration, a named query or a
  paragraph. Nothing changes the tool surface — relevant given the 2026-09-19
  ruling to design for the lower tool-count figure.
- **Then (~3 days):** the eval harness additions, because they gate everything
  after.
- **Then, measured:** `mode: recent`, adopted only on the §5.2 rule.
- **Never, in writing:** extraction-as-write, decay, the proxy.

### 6.3 What needs the owner

- **Q1 below**, which decides whether §6.2's "now" list is four items or seven.
- The fixtures. `Me/Preferences.md`'s shape, and the first five memory fixtures,
  are the owner's own words by construction (C11) and cannot be drafted here.
- A ruling on `Resources/` and `Areas/`: the seed prompt tells the fold to write
  `Resources/<Name>.md` into a directory `seed/vault/` does not ship, and
  `Areas/` exists only in grant examples. Harmless today; confusing the first
  time someone reads the seed expecting the directory.

---

## 7. Open questions (the owner's)

1. **Is a derived `knowledge_decisions` table the right shape, or should a
   decision be a first-class page?** §4 row 10 recommends parsing the existing
   `decisions:` frontmatter into a derived table — the note stays the record,
   nothing new is authored, and it is rebuildable by a walk. The alternative is
   a `Decisions/<slug>.md` page pattern with `decided_on:`, which is more
   legible in Obsidian and more for the owner to maintain. **Half of §6.2's
   first phase depends on this answer.**
2. **Should `Me/` be tool-enforced?** Today the rule lives in two prompts and
   no control (§3.6). Closing it is a day's work and a misuse suite; leaving it
   open means §4 row 4 cannot be built honestly. I read CLAUDE.md's closing
   principle as deciding this, but it is a scope change to a shipped tool and
   therefore the owner's.
3. **Is `indexed_at` an acceptable recency signal given that it flattens on a
   full rebuild?** It is the only honest one we have (`mtime` is churned by
   sync, and a `last_accessed` counter would not survive `down -v`). A ranking
   that degrades after a rebuild seems acceptable to me; a *fact* that did
   would not. This is also a D6 question in miniature.
4. **Does the eval harness get a read-only live mode?** §5.2. Without it, every
   memory claim in this document is unfalsifiable, and the PoC in §6.2 should
   not be started. With it, the same mode would also unblock A/B work the
   code-mode research left open.
5. **Do we want any memory in the prompt at all, ever?** Today: nothing is
   injected (§3.2), and both Tencent and Anthropic have independently concluded
   that volatile memory belongs behind tools. If the answer is "never", §4
   row 8 becomes an invariant rather than a paragraph, and `now.md`'s role is
   settled. If "eventually", the budget and the cache cost want deciding before
   the first proposal rather than after.
6. **`Resources/` and `Areas/`: seed them, or stop naming them?**
   `seed/assistant-prompt.md:41` directs writes into `Resources/`, which
   `seed/vault/` does not create; `Areas/` appears only in `docs/ops/cli.md`
   grant examples. Either seed both with READMEs like `People/` and `Projects/`,
   or drop them from the prompt. A small inconsistency, reported rather than
   fixed here because the seed prompt is the owner's voice.

---

## Sources

Read on 2026-09-21 unless noted; dates are the publishers'.

- [TencentCloud/TencentDB-Agent-Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) — cloned at `b545fe9` (2026-09-20), default branch `feat/server_team`. MIT (`LICENSE`); TypeScript; created 2026-04-07; 27,070 stars / 2,588 forks / 814 open issues (GitHub API, 2026-09-21). Files cited in text: `README.md`, `CHANGELOG.md` (2.0.2-beta.1, 2026-09-07), `MemoryCore/v3-api-memorycore-doc.md`, `MemoryCore/scripts/db/sqlite-init.sql`, `MemoryCore/src/core/storage/types.ts`, `.../core/record/{l1-writer,l1-dedup,l1-extractor}.ts`, `.../core/prompts/l1-extraction.ts`, `.../core/store/{types,search-utils}.ts`, `.../core/hooks/{auto-recall,auto-capture}.ts`, `.../core/persona/persona-trigger.ts`, `MemoryKnowledge/src/mcp/tools.ts`, `MemoryProxy/README.md`.
- [mem0ai/mem0](https://github.com/mem0ai/mem0) — Python, Apache-2.0, 65,731 stars, last push 2026-09-19. README's "New Memory Algorithm (April 2026)": LoCoMo 71.4 → 92.5, LongMemEval 67.8 → 94.4, 7.0K tokens, 0.88s p50.
- [letta-ai/letta](https://github.com/letta-ai/letta) — Apache-2.0, 24,813 stars, last push 2026-09-10. "Build stateful agents with memory that can learn and improve over time"; current source at `letta-ai/letta-code`.
- [getzep/graphiti](https://github.com/getzep/graphiti) — Python, Apache-2.0, 31,035 stars, last push 2026-09-21; paper [arXiv:2501.13956](https://arxiv.org/abs/2501.13956). Temporal context graphs, provenance to source data, incremental updates without recomputation.
- [getzep/zep](https://github.com/getzep/zep) — Python, Apache-2.0, 4,924 stars, last push 2026-09-18.
- [langchain-ai/langmem](https://github.com/langchain-ai/langmem) — Python, MIT, 1,675 stars, last push 2026-09-09. Hot-path memory tools vs. a background memory manager over LangGraph's `BaseStore`.
- [agiresearch/A-mem](https://github.com/agiresearch/A-mem) — Python, MIT, 1,182 stars, **last push 2025-12-12**; paper [arXiv:2502.12110](https://arxiv.org/pdf/2502.12110). Zettelkasten-style linking and "memory evolution" over ChromaDB.
- [Claude platform docs, "Memory tool"](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool) — `memory_20250818`; a directory of memory files; six commands; "The memory tool operates client-side: Claude requests file operations, and your application executes them"; path-traversal protection is the application's responsibility; "Periodically delete memory files that haven't been accessed in a long time."
- [Claude Code docs, "How Claude remembers your project"](https://code.claude.com/docs/en/memory) — auto memory's four `type` values (`user`, `feedback`, `project`, `reference`); `~/.claude/projects/<project>/memory/` with a `MEMORY.md` index and topic files; first 200 lines / 25 KB of the index loaded per session; `modified` frontmatter stamped on write; over-limit writes return an error telling Claude to rewrite the index.

Repo facts cite the file and line. Prior art this builds on rather than
repeats: `docs/ops/knowledge-fold.md` (the fold's three rules),
`docs/ops/knowledge-search.md` (keyword/semantic/hybrid and why RRF),
`docs/ops/reply-feedback.md` (the six verbs),
`docs/research/2026-09-stash-review.md` (the memory-curator pattern the fold
came from), `docs/research/2026-09-cost-optimization.md` (prompt-cache
hygiene), `docs/research/2026-09-19-code-mode-mcp.md` (the eval harness as a
measuring instrument, and the 2026-09-19 rulings on tool-surface growth),
`docs/product/daily-flow-spec.md` §6.6 (where the user's prose rules live, and
ruling Q4).
