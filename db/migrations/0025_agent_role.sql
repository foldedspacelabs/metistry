-- 0025_agent_role — `crew` is a real kind, and a row says where its grants
-- came from (P2 of docs/research/2026-09-19-grants-and-access-simplified.md
-- §2.3, §2.7).
--
-- What this answers: `agents.kind` has stored THREE values since Phase 5 —
-- `crews.ts` writes `'crew'` — while the column's comment (0007) said
-- "external | internal" and the console collapsed anything not `internal` to
-- `external` at authentication. A crew therefore reached `/mcp` looking like
-- any other foreign agent, which is why the toolset its manifest declares
-- could only be enforced in the process that dispatched it. The CHECK writes
-- the real set down in the one place a future INSERT cannot argue with; the
-- console reads the row's own kind from here on.
--
-- `grant_source` records which of the three sources a row's grants came from
-- — the registry (the owner's hand), the environment (`.env`, replaced at
-- every console start), or a manifest (a crew's `scope:`, re-synced at every
-- crew sync). Today three files reconstruct that sentence in prose from
-- `kind`; the column is so that the renderer and the "your scope is
-- configuration, not a grant" refusal read a field instead. Nothing DECIDES
-- on it: `may()` never reads it, and no grant is widened by it.
--
-- Additive per CLAUDE.md: one constraint over values already stored, one
-- nullable column. Nothing is rewritten and no row changes. NULL is the
-- honest value for every row written before this migration and reads as
-- `registry`, which is where those rows were written by hand.
--
-- ROLLBACK (nothing else to undo — no data is rewritten):
--   ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_kind_check;
--   ALTER TABLE agents DROP COLUMN IF EXISTS grant_source;
-- The console tolerates both being absent for reads; it would have to be
-- rolled back with them, because its INSERTs name `grant_source`.

-- Idempotent: `ADD CONSTRAINT` has no IF NOT EXISTS, and `metistry update`
-- must be able to run this twice under its advisory lock.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agents_kind_check' AND conrelid = 'agents'::regclass) THEN
    ALTER TABLE agents ADD CONSTRAINT agents_kind_check CHECK (kind IN ('external', 'internal', 'crew'));
  END IF;
END $$;

ALTER TABLE agents ADD COLUMN IF NOT EXISTS grant_source text
  CHECK (grant_source IS NULL OR grant_source IN ('registry', 'environment', 'manifest')); -- durable: where this row's grants come from

COMMENT ON COLUMN agents.kind IS
  'durable: external (a foreign agent under user-issued grants) | internal (this instance''s own assistant, scope from configuration) | crew (a sub-agent defined by agents/<area>/<name>.md). The principal carries this value as written — it is not collapsed.';

COMMENT ON COLUMN agents.grant_source IS
  'durable: registry (the owner''s hand) | environment (.env, replaced at every console start) | manifest (a crew''s scope:, re-synced at every crew sync). NULL on rows written before migration 0025 and read as registry. A description of where the grants live, never an input to a permission decision.';
