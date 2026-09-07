---
"@foldedspacelabs/metistry-core": minor
"@foldedspacelabs/metistry-mcp-brain": minor
"@metistry-apps/reconciler": minor
"@metistry-apps/console": minor
---

Phase 6 — embeddings on reconcile, and semantic search behind the same
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
