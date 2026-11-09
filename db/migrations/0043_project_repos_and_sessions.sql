-- 0043_project_repos_and_sessions — a git remote → the project page the
-- owner wrote for it, and the handles of every captured coding session
-- (research docs/research/2026-10-04-context-mode-review.md §6, tickets
-- CM-3 and CM-4; owner rulings of 2026-10-04).
--
-- A coding agent's next session in a repository should start out knowing
-- which project it is in and what the last sessions there touched. Nothing
-- linked either: a session note carries a `repo` and a `cwd`, a project is
-- a slug, and the summaries captured at every SessionEnd were folded each
-- evening and never served back. These are the two maps, and both are the
-- reconciler's — derived from the vault on every walk.
--
--   * `project_repos (remote, path)` — from the `repos:` in a project page's
--     frontmatter (`Projects/<Name>.md`), one remote or a list, each reduced
--     to core's canonical `host/path` (`normalizeRepoRemote`, the Context
--     Mode Engine's shape). Only a page the user owns (no `source:`, or
--     `source: user`) is read: the fold creates pages under `Projects/`
--     under its own `source:`, and a page an agent wrote never makes a
--     repository resolve to it. The owner writes the mapping in Obsidian
--     and git carries it (invariant 1); this table is its index.
--   * `vault_sessions (path, …)` — one row per captured `kind: session` note
--     under `Inbox/`: date, tool, repo, branch, turns, files touched, and
--     the owner's first prompt clipped. **There is no column for the
--     agent's reply**: `## Last response` is never parsed
--     (`parseSessionNote`), so a later query cannot widen to it.
--
-- Neither table holds a guess. A row exists because a file names the key in
-- a field of its own; `project_for_repo` then refuses to choose between two
-- pages that claim one remote, and `recent_sessions` serves a session only
-- once the fold has read it and only when the owner's own door captured it
-- (the `inbox` row's `source_agent` is null).
--
-- DURABILITY — DERIVED IN FULL (invariant 1). Every row comes back from the
-- markdown: the reconciler's walk reads every project page's frontmatter and
-- every `Inbox/` session note on every pass, rebuilds `project_repos` whole
-- and rewrites a `vault_sessions` row whenever the note's bytes moved. So
-- `docker compose down -v`, rebuild, one walk, and they are exactly what
-- they were. Nothing here is backed up and nothing here needs to be.
--
-- ADDITIVE (CLAUDE.md, migrations are additive-first): two new tables, no
-- column rewritten, no existing row touched. Every statement is
-- `IF NOT EXISTS`, so applying the file twice is a no-op the second time even
-- outside the runner's own bookkeeping.
--
-- ROLLBACK NOTE: `DROP TABLE IF EXISTS project_repos, vault_sessions;` —
-- after reverting the reconciler's write of them (apps/reconciler/src/
-- indexer.ts `syncPairs` / `syncSessions`) and the two seed queries that
-- read them (`project_for_repo`, `recent_sessions`). Nothing references
-- either table — no foreign key in or out, deliberately, as 0029 says: a
-- derived index that can refuse to be rebuilt is not derived. The next walk
-- after a re-apply rebuilds both from the vault.
--
-- INVARIANT 3, as 0024 and 0029 state it: the reconciler already writes the
-- index tables directly; these are two more. Every READ is a named query in
-- `seed/queries/` executed by `packages/queries`; no route was added (ruled
-- 2026-10-04).

CREATE TABLE IF NOT EXISTS project_repos (
    remote text NOT NULL CHECK (remote = btrim(remote) AND remote <> ''),  -- derived: one git remote from a project page's `repos:`, in core's canonical host/path shape
    path   text NOT NULL,                                                 -- derived: vault-relative path of the project page the user owns, Projects/<Name>.md
    PRIMARY KEY (remote, path)
);

COMMENT ON TABLE project_repos IS
  'Derived in full: one row per (remote, project page) from the `repos:` frontmatter of a Projects/<Name>.md page the user owns. Remotes are stored in core''s canonical host/path shape (normalizeRepoRemote). Rebuilt by the reconciler''s walk (CM-3). Two pages claiming one remote are two rows, and project_for_repo resolves neither — a project is never guessed.';

-- "Which repositories does this page claim" — the project page's own view.
CREATE INDEX IF NOT EXISTS project_repos_path_idx ON project_repos (path);

CREATE TABLE IF NOT EXISTS vault_sessions (
    path         text        PRIMARY KEY,                -- derived: vault-relative path of the session note under Inbox/ — the handle, and the join to its `inbox` row
    content_hash text        NOT NULL,                   -- derived: sha256 of the note's bytes as last read; the walk rewrites the row only when this moves
    session_id   text,                                   -- derived: frontmatter `session_id:`, the tool's own id
    tool         text        NOT NULL,                   -- derived: frontmatter `source:` — the capturing tool (claude-code, cursor, opencode, …)
    repo         text,                                   -- derived: frontmatter `repo:` — the checkout's basename as the capture saw it
    cwd          text,                                   -- derived: frontmatter `project:` — the session's working directory
    branch       text,                                   -- derived: frontmatter `branch:`
    started      timestamptz,                            -- derived: frontmatter `started:`, when it parses as a timestamp
    ended        timestamptz,                            -- derived: frontmatter `ended:`
    turns        integer,                                -- derived: frontmatter `turns:` — the owner's turns; null when the tool reports none (Cursor)
    files        jsonb       NOT NULL DEFAULT '[]',      -- derived: the `## Files touched` list, in the note's order, capped at the summary's MAX_FILES
    first_prompt text        NOT NULL DEFAULT ''         -- derived: the `## First prompt` section, clipped to FIRST_PROMPT_CHARS — the owner's words, never the agent's
);

COMMENT ON TABLE vault_sessions IS
  'Derived in full: one row per captured `kind: session` note under Inbox/ — the handles recent_sessions serves (date, tool, repo, branch, turns, files, the owner''s first prompt clipped). The agent''s `## Last response` is never parsed and has no column here (ruled 2026-10-04). Rebuilt by the reconciler''s walk (CM-4).';

-- "The last sessions in this repository" — recent_sessions's own question.
CREATE INDEX IF NOT EXISTS vault_sessions_repo_idx ON vault_sessions (lower(repo), started DESC);
