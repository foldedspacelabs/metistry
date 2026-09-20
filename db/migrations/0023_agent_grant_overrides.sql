-- 0023_agent_grant_overrides — the assistant may ask for an area, and an
-- approval has to survive the next console start (ruled 2026-09-19 B: "the
-- assistant should be able to ask").
--
-- The trap this closes: an INTERNAL row's grants are configuration in the
-- user's hand (`METISTRY_ASSISTANT_AREAS`), and `ensureInternalAgent`
-- REPLACES them from that configuration on every start. A widening written
-- into `agents.grants` alone would vanish at the next restart and the owner
-- would believe they had granted it — which is why `request_access` used to
-- refuse an internal principal outright.
--
-- Why a table rather than a file in git (invariant 1's preference, and the
-- ruling's): there is no file. An internal agent's scope is an environment
-- variable in the instance's own `.metistry/state/.env`, which is derived,
-- gitignored, and not reachable through the reconciler's protected-path
-- write. Inventing a `.metistry/agents/<id>.yaml` for it would be a redesign
-- of the grants surface, which is being researched separately and is
-- explicitly not this change. So: the approvals are recorded here and MERGED
-- on top of the configured grants at every start — configuration stays the
-- floor, and each row is one answer the owner gave in Needs You, with the
-- proposal it came from beside it.
--
-- Additive per CLAUDE.md: one new table, nothing rewritten.

CREATE TABLE IF NOT EXISTS agent_grant_overrides (
  agent_id    text        NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  -- one vault area prefix, exactly as the grants validator admits it
  area        text        NOT NULL,
  -- the `proposals` row the owner answered; null only for a hand-written row
  proposal_id bigint,
  granted_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, area)
);

COMMENT ON TABLE agent_grant_overrides IS
  'Widenings the owner approved for an agent whose grants are re-synced from configuration (internal rows). ensureInternalAgent merges these on top of the configured areas at every console start; revoking the agent clears them.';
