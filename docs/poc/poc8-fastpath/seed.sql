-- PoC-8 fast path: work table matching the plan's shape, seeded with
-- ~25 plausible synthetic rows across mixed statuses.

DROP TABLE IF EXISTS work;

CREATE TABLE work (
  id serial PRIMARY KEY,
  title text NOT NULL,
  area text,
  kind text,
  status text,
  external_ref text,
  owner text,
  due date,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO work (title, area, kind, status, external_ref, owner, due, updated_at) VALUES
  ('Fix multipart parser boundary edge case', 'poc7-capture', 'bug', 'in_progress', 'MET-101', 'samrivera', '2026-08-28', now() - interval '2 hours'),
  ('Stand up pgvector container for fast-path PoC', 'poc8-fastpath', 'task', 'in_progress', 'MET-102', 'samrivera', '2026-08-27', now() - interval '10 minutes'),
  ('Write ADR: router fast path vs LLM-in-loop', 'architecture', 'doc', 'open', 'MET-103', 'samrivera', '2026-09-02', now() - interval '1 day'),
  ('Investigate psql subprocess spawn overhead', 'poc8-fastpath', 'spike', 'open', 'MET-104', 'samrivera', NULL, now() - interval '3 hours'),
  ('Review PoC-3 AFM model loading results', 'poc3-afm', 'review', 'closed', 'MET-090', 'jsmith', '2026-08-20', now() - interval '6 days'),
  ('Design named-query schema for router', 'poc8-fastpath', 'design', 'closed', 'MET-091', 'samrivera', '2026-08-22', now() - interval '4 days'),
  ('Add sha256 verification to capture inbox', 'poc7-capture', 'task', 'closed', 'MET-092', 'samrivera', '2026-08-25', now() - interval '1 day 4 hours'),
  ('Evaluate TCC prompt fatigue on macOS 26', 'poc1-mcp-tcc', 'spike', 'blocked', 'MET-085', 'jsmith', '2026-08-24', now() - interval '5 days'),
  ('Draft consolidated Phase 0 RESULTS.md outline', 'phase0', 'doc', 'open', 'MET-105', 'samrivera', '2026-09-05', now() - interval '12 hours'),
  ('Container image size audit for PoC-4', 'poc4-container', 'task', 'closed', 'MET-086', 'jsmith', '2026-08-23', now() - interval '3 days'),
  ('Benchmark cache hit vs miss latency for /api/q', 'poc8-fastpath', 'task', 'in_progress', 'MET-106', 'samrivera', '2026-08-27', now() - interval '30 minutes'),
  ('Prototype attachment OCR pipeline', 'poc2-attachments', 'spike', 'in_progress', 'MET-095', 'jsmith', '2026-08-29', now() - interval '8 hours'),
  ('Set up bearer-token auth scratch pattern', 'poc7-capture', 'task', 'closed', 'MET-093', 'samrivera', '2026-08-25', now() - interval '1 day 6 hours'),
  ('Sketch YAML named-query format for product', 'poc8-fastpath', 'design', 'open', 'MET-107', 'samrivera', NULL, now() - interval '1 hour'),
  ('Reproduce multipart corruption bug report', 'poc7-capture', 'bug', 'closed', 'MET-094', 'jsmith', '2026-08-24', now() - interval '2 days'),
  ('Confirm Docker Desktop resource limits on Mac Studio', 'infra', 'task', 'closed', 'MET-080', 'samrivera', '2026-08-18', now() - interval '8 days'),
  ('Explore connection pooling options for router', 'poc8-fastpath', 'spike', 'open', 'MET-108', 'samrivera', '2026-09-01', now() - interval '5 hours'),
  ('Validate vcf capture round-trip', 'poc7-capture', 'test', 'closed', 'MET-096', 'samrivera', '2026-08-26', now() - interval '2 hours'),
  ('Write PDF-by-hand fixture generator', 'poc7-capture', 'task', 'closed', 'MET-097', 'samrivera', '2026-08-26', now() - interval '3 hours'),
  ('Assess AFM tool-calling reliability', 'poc3-afm', 'spike', 'blocked', 'MET-088', 'jsmith', '2026-08-30', now() - interval '4 days'),
  ('Plan cache TTL invalidation strategy', 'poc8-fastpath', 'design', 'open', 'MET-109', 'samrivera', NULL, now() - interval '20 minutes'),
  ('Audit MCP TCC entitlement prompts', 'poc1-mcp-tcc', 'task', 'closed', 'MET-081', 'jsmith', '2026-08-19', now() - interval '7 days'),
  ('Draft freshness stamp (as_of) response contract', 'poc8-fastpath', 'design', 'in_progress', 'MET-110', 'samrivera', '2026-08-27', now() - interval '45 minutes'),
  ('Capture large binary integrity stress test', 'poc7-capture', 'test', 'in_progress', 'MET-098', 'samrivera', '2026-08-27', now() - interval '5 minutes'),
  ('Compile Phase 0 gotchas for real console build', 'phase0', 'doc', 'open', 'MET-111', 'samrivera', '2026-09-03', now() - interval '1 minute');
