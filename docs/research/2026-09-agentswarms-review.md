# AgentSwarms review — what to take, what to leave (2026-09-08)

Owner prompt: [AgentSwarms-fyi/agentswarms](https://github.com/AgentSwarms-fyi/agentswarms)
shares some goals but is more ambitious in approach and data stored, and
is BI/ML-centred rather than personal-knowledge-and-execution-centred.
Is there anything worth taking?

## What it is

A self-hosted, **source-available** (Elastic License 2.0 — no SaaS
offering without a commercial licence) platform that bolts agents onto a
full data stack: TanStack/React front end, Supabase (Postgres + auth +
storage), a **lakehouse** (DuckDB over zstd Parquet in the user's S3
bucket, Postgres catalog with lineage and time travel), pgvector, sandboxed
Python/JS kernels, optional Spark. Agents and multi-agent "swarms" are
built on a **graph canvas** (agent, router, condition, loop, approval, and
tool nodes) and published as immutable snapshots; a BI workspace (19
visual types, cross-filtering, alerts), an "AI analyst" (plan → SQL →
results, self-checking, PDF), no-code ML (versions, stages, drift), 29
data connectors, knowledge-base sync from Drive/Notion/SharePoint/
Confluence, and export to LangGraph/CrewAI/Strands. ~234★, 821 commits,
active. Stated limits: pgvector only, single-node catalog, no SCIM.

Its four principles, verbatim: *governance that runs before the call;
answers you can check; data you keep; one platform instead of five
subscriptions.*

## Where it agrees with us (convergent, not new)

| Their principle / mechanism | Ours |
| --- | --- |
| Governance before the call: model rules, budgets, row filters and column masks enforced server-side | "Enforce at the tool, never by prompting"; grant tiers filtered in SQL; data policy at the dispatch tool; project budgets and caps (§4.21) |
| Answers you can check: analysts cite SQL, forecasts explain themselves | Handles not payloads (§4.19); every action a `runs` row; briefs cite paths; `knowledge_read` returns the hash |
| Data you keep: Parquet in your bucket, transactional catalog | Git is the record; the instance repo is yours; Postgres is derived (invariant 1) |
| Immutable published workflow snapshots | Artifact versions are commits; crew manifests live in the instance repo's history |
| pgvector, no external vector DB | Decision 8 |
| Approval steps as first-class nodes | The one `proposals` queue (D7) |
| MCP in and out, OpenAI-compatible endpoint | MCP is the one door; gateway seam declarative (§4.18 E) |

The convergence is worth noting for launch material: two independent
teams reached "governance in the tool, answers with receipts, data you
own" from opposite starting points (a data platform vs. a personal
assistant).

## Worth taking

1. **A tamper-evident action record.** Their audit log is **hash-chained
   and survives user deletion**. Our `runs` table is the action record for
   everything (§4.20) but is plain rows. Chaining each `runs` row to the
   previous (store `prev_hash`, `hash = sha256(prev_hash ‖ canonical row)`)
   makes history append-only in a checkable way: an agent, or a bug, that
   rewrites a row breaks the chain, and `doctor` can verify it. Cheap
   (one column, one trigger or one core function), and it sharpens open
   decision D6: `runs` is *derived* for cost trend lines but *durable* as
   evidence — the chain is what makes the distinction honest. Recommend
   as a D6 addendum, built when D6 is closed.
2. **Decision ids across the hop.** They stamp every trace with a decision
   id and a data snapshot so a run can be replayed. We have the pieces —
   a turn's `runs` row, its tool-call rows, the reconciler intents, the
   commits — but nothing links a turn to the tool calls it made, because
   the SDK's MCP config is static headers (noted in #57). Fix at the
   bridge: `mcp-brain` accepts an optional `turn_id` in tool arguments
   that the engine's operating prompt asks the assistant to pass, *and*
   stamps it server-side from the principal's most recent open turn when
   absent, so the feed and the weekly review can group "what this turn
   did". No replay machinery; just the join key.
3. **The analyst pattern over named queries.** Their AI analyst shows
   plan → SQL → results and cites the SQL. Our equivalent is already
   designed and unbuilt: the plan's `brain-query` bridge (Phase 5 list:
   "exposing named queries to Metis"). Build it as two `mcp-brain` tools,
   `queries_list` and `queries_run(name, params)`, over the queries
   package (invariant 3: the one read path — no free-form SQL, ever),
   internal principals by default and external by grant. The assistant
   then answers "what did AWS cost in August" with the query name and
   parameters in the reply — answers you can check, on the existing
   semantic layer (named queries *are* our semantic layer).
4. **Knowledge-base sync with dedup from Drive/Notion/Confluence.** Not
   now, but it is the shape of future *capture sources*: collectors that
   pull documents into `inbox/` with provenance and content-hash dedup,
   flowing through the same triage gate. Record the pattern; build when a
   real source is needed (on the second instance, another organisation's
   tools — Confluence/SharePoint — are the obvious first two).

## Not taking

- **The lakehouse, BI workspace, ML lifecycle, notebooks, 29 connectors.**
  A different product. Metistry's analytics are the dashboard over
  `metrics` and `runs`, and that is the right size for a personal system;
  anything bigger belongs in the user's BI tool, fed by `POST /capture`
  or a named query, not rebuilt here.
- **The graph canvas.** Swarm-as-DAG (routers, conditions, loops) is an
  orchestration framework; invariant 4 keeps routing deterministic and
  §4.19 keeps coordination pull-based on a shared task list. Crews plus
  the task list express the same work without a second execution model.
- **Supabase and a React front end.** Invariant-level stack decisions
  stand: hand-rolled console, PWA + SwiftUI.
- **Elastic License.** Metistry is Apache-2.0 and, as of 2026-09-07,
  fully open with no hosted plan; nothing here changes that.

## Decisions recorded

- D6 addendum (proposed): hash-chain `runs`; `doctor` verifies the chain.
- `mcp-brain` gains `queries_list` / `queries_run` (Phase 5 `brain-query`
  item, now specified) and an optional `turn_id` join key on every tool.
- Capture-source collectors (Drive/Notion/Confluence-style, hash-dedup)
  are a recorded pattern for the second instance, not scheduled.
