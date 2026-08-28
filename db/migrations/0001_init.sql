-- 0001_init — the substrate tables (plan §Phase 1).
-- Postgres is derived and operational; git is the record (invariant 1).
-- Everything here must survive the test: down -v, rebuild, run collectors once.

CREATE EXTENSION IF NOT EXISTS vector;

-- Every model turn, bridge call, collector run, escalation, and outbound
-- message logs one row here. The audit trail for "what did it do and why".
CREATE TABLE runs (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ts          timestamptz NOT NULL DEFAULT now(),
    component   text        NOT NULL,               -- bridge/collector/agent/router name
    kind        text        NOT NULL,               -- bridge_call | collector_run | turn | escalation | outbound | doctor
    session_id  uuid,
    tool        text,
    model       text,
    tokens_in   integer,
    tokens_out  integer,
    cost_usd    numeric(10, 6),
    duration_ms integer,
    ok          boolean     NOT NULL,
    error       text,
    meta        jsonb       NOT NULL DEFAULT '{}'
);
CREATE INDEX runs_ts_idx        ON runs (ts DESC);
CREATE INDEX runs_component_idx ON runs (component, ts DESC);

-- Capture lands as files (decision §6.1); this is the triage record that
-- references them. Proposals, never auto-created actions (§4.11).
CREATE TABLE inbox (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ts          timestamptz NOT NULL DEFAULT now(),
    source      text        NOT NULL,               -- imessage | share | http | obsidian | cli
    path        text        NOT NULL,               -- file under inbox/, relative to repo root
    mime        text,
    note        text,
    sha256      text,
    status      text        NOT NULL DEFAULT 'new', -- new | classified | accepted | rejected | archived
    proposal    jsonb,                              -- classifier output (post-redaction), if any
    triaged_at  timestamptz
);
CREATE INDEX inbox_status_idx ON inbox (status, ts DESC);

-- Designed for RE-BRIEFING, not transcript reconstruction (§4.16 rule 6):
-- enough state that a fresh session UUID can pick up the thread via
-- brain-query when the transcript is gone. The transcript is a cache.
CREATE TABLE sessions (
    id             uuid        PRIMARY KEY,          -- the Agent SDK session UUID
    thread         text        NOT NULL,             -- logical thread key (handle, 'default', agent id)
    created_at     timestamptz NOT NULL DEFAULT now(),
    last_active_at timestamptz NOT NULL DEFAULT now(),
    status         text        NOT NULL DEFAULT 'active', -- active | rolled | dead
    parent_session uuid REFERENCES sessions (id),    -- roll chain
    summary        text,                             -- rolling summary, updated as the session runs
    decisions      jsonb       NOT NULL DEFAULT '[]',
    open_loops     jsonb       NOT NULL DEFAULT '[]',
    refs           jsonb       NOT NULL DEFAULT '[]',-- msg:/issue:/note: references touched
    turns          integer     NOT NULL DEFAULT 0,
    context_tokens integer                           -- instrumented per §6.3 (roll signal)
);
CREATE INDEX sessions_thread_idx ON sessions (thread, last_active_at DESC);

-- Federates GitHub issues, calendar holds, and internal threads into one
-- status view (§4.7). Collectors reconcile from the source; nothing invents.
CREATE TABLE work (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    title        text        NOT NULL,
    area         text,
    kind         text        NOT NULL,               -- issue | event | thread | task
    status       text        NOT NULL DEFAULT 'open',-- open | in_progress | blocked | closed
    external_ref text,                               -- gh:owner/repo#n | cal:event-id | session:uuid | inbox:id
    owner        text,
    due          date,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX work_status_idx ON work (status, updated_at DESC);
CREATE INDEX work_area_idx   ON work (area, status);

-- Collector output. Downsampling policy (§6.2): full 90d -> hourly 1y -> daily.
CREATE TABLE metrics (
    id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ts     timestamptz NOT NULL DEFAULT now(),
    name   text        NOT NULL,
    value  numeric     NOT NULL,
    labels jsonb       NOT NULL DEFAULT '{}'
);
CREATE INDEX metrics_name_ts_idx ON metrics (name, ts DESC);

-- Reconciler state for the knowledge vault. Content hash, not mtime, decides
-- re-embedding (§4.12) — sync churns mtime constantly.
CREATE TABLE knowledge_files (
    path         text        PRIMARY KEY,            -- vault-relative, TitleCase preserved
    mtime        timestamptz,
    content_hash text,
    indexed_at   timestamptz,
    status       text NOT NULL DEFAULT 'dirty'       -- clean | dirty | conflict
);
CREATE INDEX knowledge_files_status_idx ON knowledge_files (status);

-- Wikilink graph edges parsed by the reconciler (§4.13).
CREATE TABLE knowledge_links (
    from_path text NOT NULL,
    to_path   text NOT NULL,
    kind      text NOT NULL DEFAULT 'wikilink',      -- wikilink | frontmatter | embed
    PRIMARY KEY (from_path, to_path, kind)
);
CREATE INDEX knowledge_links_to_idx ON knowledge_links (to_path);

-- Embeddings. model + dim per row keep the choice reversible (§6.8); the
-- vector column is typed to the current default (nomic-embed-text, 768d)
-- because pgvector indexes require a fixed dimension — changing models is a
-- migration plus a ~45s full re-embed (PoC-5), which is the accepted cost.
CREATE TABLE embeddings (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    path         text        NOT NULL,
    chunk_index  integer     NOT NULL,
    content      text        NOT NULL,
    model        text        NOT NULL,
    dim          integer     NOT NULL,
    embedding    vector(768) NOT NULL,
    content_hash text        NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (path, chunk_index, model)
);
CREATE INDEX embeddings_hnsw_idx ON embeddings USING hnsw (embedding vector_cosine_ops);
