-- 0010 — artifacts module (plan §4.21, §4.20 module contract). Additive:
-- three new tables, nothing rewritten.
--
-- Storage is git (invariant 1): an artifact is `Artifacts/<project>/<slug>/`
-- in the instance repo and every version is ONE commit by the reconciler
-- (D5 — the publish writes every file under one intent group = the
-- version id). Postgres holds the INDEX so the console can list, diff, and
-- link without touching git on the hot path.
--
-- Durability (D6, decision 13): `artifacts` and `artifact_versions` are
-- DERIVED — rebuildable from `git log` on the prefix (author, message, and
-- the file manifest are all in the commit). `artifact_comments` is
-- DURABLE — fine-grained mutable state with no upstream copy; it joins the
-- nightly dump.

CREATE TABLE IF NOT EXISTS artifacts (
    id              text        PRIMARY KEY,                    -- derived: "art_" + ulid
    project         text        NOT NULL,                       -- derived: collaboration boundary (§4.19/§4.20)
    slug            text        NOT NULL,                       -- derived: directory name under Artifacts/<project>/
    kind            text,                                       -- derived: sniffed from content, never trusted from the extension
    current_version text,                                       -- derived: artifact_versions.id the `artifact` link follows; CAS target
    visibility      text        NOT NULL DEFAULT 'project',     -- derived: v1 knows only 'project'
    created_by      text,                                       -- derived: principal id (server-side identity)
    created_at      timestamptz NOT NULL DEFAULT now(),         -- derived
    updated_at      timestamptz NOT NULL DEFAULT now(),         -- derived
    UNIQUE (project, slug)
);
CREATE INDEX IF NOT EXISTS artifacts_project_idx ON artifacts (project, updated_at DESC);

CREATE TABLE IF NOT EXISTS artifact_versions (
    id               text        PRIMARY KEY,                   -- derived: "ver_" + ulid; also the reconciler intent group → one commit
    artifact_id      text        NOT NULL REFERENCES artifacts (id),
    commit           text,                                      -- derived: git sha; NULL until the reconciler has flushed, resolved lazily from `vault.log`
    path_prefix      text        NOT NULL,                      -- derived: Artifacts/<project>/<slug>
    manifest         jsonb       NOT NULL DEFAULT '{}',         -- derived: { "<relative path>": { sha256, bytes, kind } }
    author_principal text        NOT NULL,                      -- derived: server-side identity (§4.19), also the commit author
    author_kind      text        NOT NULL,                      -- derived: user | agent | system
    message          text        NOT NULL,                      -- derived: the commit subject
    idempotency_key  text,                                      -- derived: caller-supplied; a retried publish returns this row
    created_at       timestamptz NOT NULL DEFAULT now()         -- derived
);
CREATE INDEX IF NOT EXISTS artifact_versions_artifact_idx ON artifact_versions (artifact_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS artifact_versions_idempotency_uidx
  ON artifact_versions (author_principal, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS artifact_comments (
    id               text        PRIMARY KEY,                   -- durable: "cmt_" + ulid
    artifact_id      text        NOT NULL REFERENCES artifacts (id),          -- durable
    version_id       text        NOT NULL REFERENCES artifact_versions (id),  -- durable: threads are on an EXACT version
    path             text,                                      -- durable: one file in the version, or NULL for the whole version
    anchor           jsonb,                                     -- durable: opaque, client-owned (a line range, a selector, …)
    body             text        NOT NULL,                      -- durable: rendered to agents through the §4.20 sanitizer, to browsers output-encoded
    state            text        NOT NULL DEFAULT 'open',       -- durable: open | resolved (roots only; replies inherit)
    author_principal text        NOT NULL,                      -- durable: server-side identity, never self-declared
    author_kind      text        NOT NULL,                      -- durable: human | agent — agent text is labeled everywhere it surfaces
    resolved_by      text,                                      -- durable
    resolved_at      timestamptz,                               -- durable
    parent_id        text        REFERENCES artifact_comments (id), -- durable: NULL = thread root; one level of replies
    created_at       timestamptz NOT NULL DEFAULT now()         -- durable
);
CREATE INDEX IF NOT EXISTS artifact_comments_version_idx ON artifact_comments (version_id, created_at);
CREATE INDEX IF NOT EXISTS artifact_comments_thread_idx  ON artifact_comments (parent_id, created_at);
CREATE INDEX IF NOT EXISTS artifact_comments_open_idx    ON artifact_comments (artifact_id, state) WHERE parent_id IS NULL;
