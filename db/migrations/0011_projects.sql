-- 0011 — projects (plan §4.19 "Multi-agent projects", §4.21 controls).
-- Additive: one new table, one new column. A project was a slug shared
-- by agents.projects, work.project, and artifacts.project with no row of
-- its own; the §4.21 controls need somewhere to keep the user's kill
-- switch (`mode`), the daily soft budget, and the per-project bundle cap.
-- Rows are created lazily the first time a slug is used (core's
-- ensureProject, called from tasks.create / artifacts.publish /
-- agents.projects) — the user never has to "create a project".
--
-- Durability (D6): DURABLE. mode/budget/caps are user decisions with no
-- upstream copy; the table joins the nightly dump with `agents`.

CREATE TABLE IF NOT EXISTS projects (
    id               text        PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9-]{0,39}$'), -- durable: the slug every other table already carries
    title            text,                                                          -- durable: optional display name
    area             text,                                                          -- durable: optional Knowledge/ area the project belongs to
    mode             text        NOT NULL DEFAULT 'autonomous'
                                 CHECK (mode IN ('autonomous', 'review')),         -- durable: the kill switch — review routes EVERY agent-to-agent bundle to proposals
    daily_budget_usd numeric(10, 2),                                                -- durable: soft budget over runs.cost_usd; NULL = none; exceeding it flips mode to review
    max_open_bundles integer     NOT NULL DEFAULT 20 CHECK (max_open_bundles >= 0), -- durable: per-project cap on review bundles in flight; over → queued (blocked), never dropped
    created_at       timestamptz NOT NULL DEFAULT now(),                            -- durable
    updated_at       timestamptz NOT NULL DEFAULT now()                             -- durable
);

-- Optional narrowing below the project default (§4.21 "never widening"):
-- { may_dispatch_to: [agent ids], accept_from: [agent ids | "user"],
--   max_open_bundles: n }. Absent keys mean "project members" / the
-- default cap. Set by the user's hand (PUT /api/agents/:id/autonomy).
ALTER TABLE agents ADD COLUMN IF NOT EXISTS autonomy jsonb NOT NULL DEFAULT '{}'; -- durable

-- Backfill: every slug already in use gets its row, so the rollup and the
-- controls see the projects that existed before this migration. Only
-- slug-shaped values qualify (work.project is free text historically).
INSERT INTO projects (id)
SELECT DISTINCT p FROM (
    SELECT project AS p FROM work WHERE project IS NOT NULL
    UNION SELECT project FROM artifacts
    UNION SELECT unnest(projects) FROM agents
) s
WHERE p ~ '^[a-z][a-z0-9-]{0,39}$'
ON CONFLICT (id) DO NOTHING;
