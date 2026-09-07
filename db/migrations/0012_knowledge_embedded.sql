-- 0012 — embedding bookkeeping on the knowledge index (plan Phase 6,
-- §6 decision 8). Additive: two nullable columns, no rewrite.
--
-- `embeddings` already carries everything a VECTOR needs (model + dim per
-- row, content hash per chunk). What it cannot answer is "does this note's
-- current content have a complete, current set of vectors?" — a note whose
-- embedding was interrupted (Ollama down mid-cycle) has some rows, and the
-- reconciler must retry it without re-embedding the whole vault.
--
-- So the FILE-level marker lives next to the file's own hash: a note needs
-- embedding when embedded_hash <> content_hash (edited, or never finished)
-- or embedded_model <> the configured model (the model changed → decision
-- 8's deterministic rebuild). Set only after every chunk of that note is
-- stored, which makes a partial cycle self-healing rather than silently
-- half-indexed.
--
-- Durability (D6): derived. Both columns are rebuilt from the vault by the
-- reconciler; `POST /embeddings/rebuild` clears them on purpose.
ALTER TABLE knowledge_files ADD COLUMN IF NOT EXISTS embedded_hash  text; -- derived: content_hash the stored vectors were built from
ALTER TABLE knowledge_files ADD COLUMN IF NOT EXISTS embedded_model text; -- derived: embedding model those vectors used

-- The reconciler's per-cycle question: which settled notes are behind?
CREATE INDEX IF NOT EXISTS knowledge_files_embed_idx ON knowledge_files (embedded_model, embedded_hash) WHERE NOT draft;

-- Semantic search always filters by model before the vector scan (rows for
-- a superseded model stay queryable until a rebuild replaces them).
CREATE INDEX IF NOT EXISTS embeddings_model_idx ON embeddings (model);
