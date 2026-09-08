# @metistry-apps/console

## 0.2.0

### Minor Changes

- 66d5c08: `queries_list` / `queries_run` on mcp-brain — invariant 3's one read path
  (named, parameterized queries, never free-form SQL) out to agents. An
  agent lists what's available (name, description, param types/defaults)
  and runs one, capped at 200 rows with truncation noted. The instance's
  own assistant always has it; an external agent needs an explicit
  `queries: true` grant (`PUT /api/agents/:id/grants`), a separate axis
  from the knowledge tier.
  
  Every mcp-brain tool also now takes an optional `turn_id` (≤ 64 chars,
  `[A-Za-z0-9_-]`), recorded on the tool's `runs` row (`meta.turn_id`); the
  `activity_feed` query surfaces it so one reply's tool calls group
  together. The seed assistant prompt tells it to generate one per reply.
  
  Crews never get `queries_list`/`queries_run` — a named query is not
  filtered by a crew's scope/projects the way every other tool group is.
- 4774e08: Phase 6 — embeddings on reconcile, and semantic search behind the same
  grants.
  
  The reconciler embeds settled notes as it reconciles (local Ollama
  `nomic-embed-text`, model and dim per row) and gains
  `POST /embeddings/rebuild`. `GET /vault/search` and mcp-brain's
  `knowledge_search` take `mode=keyword|semantic|hybrid`, defaulting to
  hybrid once vectors exist and keyword before that. Every mode keeps the
  grant tier and the draft exclusion in SQL. With no embedder running,
  search still answers in keyword and the index is unaffected.
  
  Migration 0012 adds `knowledge_files.embedded_hash` / `embedded_model`
  (additive, derived).

### Patch Changes

- Updated dependencies [66d5c08]
- Updated dependencies [4774e08]
- Updated dependencies
- Updated dependencies [fc0b525]
  - @foldedspacelabs/metistry-core@0.2.0
  - @foldedspacelabs/metistry-mcp-brain@0.2.0
  - @foldedspacelabs/metistry-queries@0.2.0
  - @foldedspacelabs/metistry-artifacts@0.2.0
  - @foldedspacelabs/metistry-tasks@0.2.0
  - @metistry-apps/collectors@0.2.0
  - @metistry-apps/routines@0.2.0

## 0.1.0

### Patch Changes

- Updated dependencies
  - @foldedspacelabs/metistry-core@0.1.0
  - @foldedspacelabs/metistry-queries@0.1.0
  - @foldedspacelabs/metistry-tasks@0.1.0
  - @foldedspacelabs/metistry-artifacts@0.1.0
  - @foldedspacelabs/metistry-mcp-brain@0.1.0
  - @metistry-apps/collectors@0.1.0
  - @metistry-apps/routines@0.1.0
