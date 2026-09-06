-- 0009 — mcp-brain (plan §4.11 one knowledge interface, §4.19 report.submit).
-- Additive on two existing tables (CLAUDE.md: additive-first).
--
-- knowledge_files: the bridge serves an INDEX (titles + one-line
-- descriptions, §4.11 tier 1) and must exclude `status: draft` notes at
-- every tier. Both need to be columns the reconciler fills, so the
-- exclusion is a WHERE clause the tool cannot skip — not a frontmatter
-- parse at read time. Durability (D6): derived — rebuilt from the vault
-- by the reconciler.
ALTER TABLE knowledge_files ADD COLUMN IF NOT EXISTS title       text;                              -- derived: frontmatter title or the basename
ALTER TABLE knowledge_files ADD COLUMN IF NOT EXISTS description text;                              -- derived: one-line frontmatter description
ALTER TABLE knowledge_files ADD COLUMN IF NOT EXISTS draft       boolean NOT NULL DEFAULT false;    -- derived: frontmatter `status: draft` — never served to an agent
CREATE INDEX IF NOT EXISTS knowledge_files_served_idx ON knowledge_files (path) WHERE NOT draft;

-- proposals: `report` is idempotent on a caller-supplied key (§4.19,
-- §4.20 idempotency contract). The key is scoped to the reporting agent,
-- and the index is what makes a retried report safe under concurrency —
-- the bridge inserts ON CONFLICT DO NOTHING and hands back the existing id.
CREATE UNIQUE INDEX IF NOT EXISTS proposals_report_idempotency_uidx
  ON proposals (source_agent, (payload->>'idempotency_key'))
  WHERE kind = 'report' AND payload->>'idempotency_key' IS NOT NULL;
CREATE INDEX IF NOT EXISTS proposals_report_title_idx
  ON proposals (source_agent, (payload->>'title'), ts DESC)
  WHERE kind = 'report';
