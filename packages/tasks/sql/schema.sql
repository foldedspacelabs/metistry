-- Standalone schema for @foldedspacelabs/metistry-tasks. Idempotent: every
-- statement is IF NOT EXISTS, so it is safe to run on every start, and safe
-- on a database that already carries Metistry's own migrations (same
-- column names and types — inside the console this file is a no-op).
--
-- `work` is the task list; `runs` is the action record every mutation
-- appends to (component = the acting agent, kind = 'task_op').

CREATE TABLE IF NOT EXISTS work (
    id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    title            text        NOT NULL,
    area             text,
    kind             text        NOT NULL DEFAULT 'task',
    status           text        NOT NULL DEFAULT 'open',   -- open | in_progress | blocked | closed
    external_ref     text,
    owner            text,
    due              date,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    claimed_by       text,                                  -- server-side agent identity
    lease_expires_at timestamptz,
    depends_on       bigint[]    NOT NULL DEFAULT '{}',
    meta             jsonb       NOT NULL DEFAULT '{}',
    project          text,
    idempotency_key  text,
    history          jsonb       NOT NULL DEFAULT '[]',     -- append-only [{ts, agent, op, note?, status?}]
    created_by       text,
    closed_at        timestamptz
);
ALTER TABLE work ADD COLUMN IF NOT EXISTS claimed_by       text;
ALTER TABLE work ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;
ALTER TABLE work ADD COLUMN IF NOT EXISTS depends_on       bigint[] NOT NULL DEFAULT '{}';
ALTER TABLE work ADD COLUMN IF NOT EXISTS meta             jsonb NOT NULL DEFAULT '{}';
ALTER TABLE work ADD COLUMN IF NOT EXISTS project          text;
ALTER TABLE work ADD COLUMN IF NOT EXISTS idempotency_key  text;
ALTER TABLE work ADD COLUMN IF NOT EXISTS history          jsonb NOT NULL DEFAULT '[]';
ALTER TABLE work ADD COLUMN IF NOT EXISTS created_by       text;
ALTER TABLE work ADD COLUMN IF NOT EXISTS closed_at        timestamptz;

CREATE INDEX        IF NOT EXISTS work_status_idx           ON work (status, updated_at DESC);
CREATE INDEX        IF NOT EXISTS work_ready_idx            ON work (status, lease_expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS work_external_ref_uidx    ON work (external_ref) WHERE external_ref IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS work_idempotency_key_uidx ON work (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX        IF NOT EXISTS work_project_status_idx   ON work (project, status);

-- The project row a `work.project` slug points at (0011): the §4.21
-- controls (mode, budget, bundle cap) live here; create() ensures it.
CREATE TABLE IF NOT EXISTS projects (
    id               text        PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9-]{0,39}$'),
    title            text,
    area             text,
    mode             text        NOT NULL DEFAULT 'autonomous' CHECK (mode IN ('autonomous', 'review')),
    daily_budget_usd numeric(10, 2),
    max_open_bundles integer     NOT NULL DEFAULT 20 CHECK (max_open_bundles >= 0),
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS runs (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ts          timestamptz NOT NULL DEFAULT now(),
    component   text        NOT NULL,
    kind        text        NOT NULL,
    session_id  uuid,
    tool        text,
    model       text,
    tokens_in   integer,
    tokens_out  integer,
    cost_usd    numeric(10, 6),
    duration_ms integer,
    ok          boolean,
    error       text,
    meta        jsonb       NOT NULL DEFAULT '{}',
    started_at  timestamptz,
    finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS runs_ts_idx        ON runs (ts DESC);
CREATE INDEX IF NOT EXISTS runs_component_idx ON runs (component, ts DESC);
