-- 0032_project_grants — T1-13: a project may hold its own read grant, so a
-- member's effective reach can include an area the OWNER handed to the
-- PROJECT instead of to every member by hand (P10, design-build-plan §4.19
-- "a project holds permissions; members inherit", screen 13). D13 (the
-- shape of "project grants" as a design) is still open; this ticket ships
-- only the column and the door that writes it. The union of a member's own
-- grant with its projects' — "via project" provenance — is T4-7's job, and
-- nothing reads this column before then.
--
-- Same envelope an agent's own grant already is (0007's `agents.grants`):
-- {tier: none|index|areas, areas: [...], queries?}. `PUT /api/projects/:slug`
-- validates it with the console's `validateGrants` — the identical function
-- `PUT /api/agents/:id/grants` uses, with the external (non-internal) rules:
-- the bare vault ("/") is refused (that spelling is the internal assistant
-- row's alone), and each area must be `validAgentAreaGrant` — a TitleCase
-- vault prefix that is vault CONTENT, so a grant naming `.metistry/`,
-- `Artifacts/…`, or anything else outside the vault's content is refused
-- before it is written (this ticket's test).
--
-- DURABLE (invariant 1 / D6): a project's grant is a user decision with no
-- upstream copy, exactly like an agent's own grant (0007) — nothing rebuilds
-- it from the repo. Back it up.
--
-- Additive per CLAUDE.md: one column, with the same safe default 0007 uses,
-- so every project row that predates this migration (0011's backfill
-- included) reads as "no project grant" with no backfill statement of its
-- own. Idempotent (`ADD COLUMN IF NOT EXISTS`) — `metistry update` can run
-- this twice under its advisory lock.
--
-- ROLLBACK (nothing else reads this column yet — T4-7 is its first reader):
--   ALTER TABLE projects DROP COLUMN IF EXISTS grants;

ALTER TABLE projects ADD COLUMN IF NOT EXISTS grants jsonb NOT NULL DEFAULT '{"tier":"none","areas":[]}'; -- durable: {tier: none|index|areas, areas: [Knowledge/... prefixes], queries?}

COMMENT ON COLUMN projects.grants IS
  'durable: the project''s own read grant -- {tier, areas, queries?}, the same envelope PUT /api/agents/:id/grants validates (0007), validated the same way (validateGrants, external rules -- the bare vault is refused). A member''s effective reach unions this with its own grants, "via project" (T4-7); nothing reads it before then.';
