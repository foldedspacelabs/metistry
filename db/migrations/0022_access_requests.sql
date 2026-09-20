-- 0022_access_requests — `request_access` (ruled 2026-09-19): an agent that
-- can see a page's title and not its content asks the owner for the area
-- that holds it, and the owner answers it in Needs You with the three verbs
-- every other request takes. Additive-first per CLAUDE.md: `proposals.kind`
-- is free text with a comment, not a CHECK or an enum, so the new value
-- needs no migration at all — this file adds the two INDEXES that make the
-- new kind's rules true under concurrency rather than only in the read
-- above the write.

-- Dedupe, enforced at the database. One PENDING ask per (agent, area): a
-- second identical ask returns the first one's id (packages/mcp-brain/src/
-- access.ts), so an agent that keeps hitting the same refusal cannot fill
-- the owner's queue with the same sentence. Partial on `decision` on
-- purpose: once the owner has answered, asking again is a NEW question —
-- the world moved, or the reason did — and it gets its own row.
CREATE UNIQUE INDEX IF NOT EXISTS proposals_access_request_uidx
  ON proposals (source_agent, (payload->>'area'))
  WHERE kind = 'access_request' AND decision = 'pending';

-- The Agents panel lists what each agent has ASKED for beside what it holds
-- (GET /api/agents), so the owner sees the pending ask where the grant is
-- edited and not only in the queue. This is that read.
CREATE INDEX IF NOT EXISTS proposals_access_request_pending_idx
  ON proposals (source_agent, ts DESC)
  WHERE kind = 'access_request' AND decision = 'pending';
