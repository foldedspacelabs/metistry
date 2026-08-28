-- PoC-5: embed -> store -> retrieve mechanics
-- Table stores model name and dim PER ROW so the embedding-model choice is
-- reversible (plan requirement) -- a future re-embed with a different model
-- can coexist in the same table during migration, distinguished by (model, dim).

CREATE EXTENSION IF NOT EXISTS vector;

DROP TABLE IF EXISTS poc5_embeddings;

CREATE TABLE poc5_embeddings (
  id           serial PRIMARY KEY,
  path         text NOT NULL,
  chunk_index  int  NOT NULL,
  content      text NOT NULL,
  model        text NOT NULL,
  dim          int  NOT NULL,
  embedding    vector(768) NOT NULL,
  content_hash text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- One row per (path, chunk_index) per embed run -- rebuild truncates+reinserts
-- rather than upserting, see poc5_rebuild.sh.
CREATE UNIQUE INDEX poc5_embeddings_path_chunk_idx
  ON poc5_embeddings (path, chunk_index);

-- HNSW index, cosine distance (vector_cosine_ops) -- matches the cosine
-- similarity search used in poc5_query.mjs (<=> operator).
CREATE INDEX poc5_embeddings_hnsw_idx
  ON poc5_embeddings
  USING hnsw (embedding vector_cosine_ops);
