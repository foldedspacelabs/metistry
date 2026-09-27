-- 0035_event_notify — the server tells the client what changed
-- (docs/product/design-build-plan.md §2.20, ticket T2-18).
--
-- What this answers: every client polls — Chat every 1–2.5 s, Activity and
-- the board every 10 s — and a Mac app would spawn a poll per view. The
-- console now streams what changed (`GET /api/events`); this migration is
-- where those changes come from. One function, `metistry_notify()`, and one
-- `AFTER INSERT OR UPDATE` row trigger on each of the seven tables the
-- live-changes catalogue is derived from: `runs`, `proposals`, `work`,
-- `inbox`, `artifact_comments`, `outbound_messages`, `agents`. Nothing that
-- writes those tables changes — the engine, the reconciler, the collectors
-- and the console already write them, and the trigger is how they are heard.
--
-- **`{table, op, id}` and nothing else.** The notice never carries a column
-- value: no text, no payload, no meta. The console's one `LISTEN` maps a
-- notice to a typed event (apps/console/src/events.ts) and the client
-- refetches the row through the route that already decides who may read it,
-- so the channel cannot leak what the routes would not (invariant 3). It is
-- also what keeps every notice far under `pg_notify`'s 8000-byte ceiling.
--
-- **Two things are quiet on purpose.** An UPDATE that changes nothing (a
-- collector's upsert of an unchanged row) notifies nobody. And an agent's
-- heartbeat — `agents.last_seen_at`, bumped on EVERY authenticated call — is
-- throttled: an update that moves nothing but `last_seen_at` notifies only
-- when it crosses into a new minute, or the agent is seen for the first time.
-- Anything else on the row (a grant, a revocation) always notifies.
--
-- A notice is delivered when its transaction commits, and not at all if it
-- rolls back — so a client is never told about a row it cannot then read.
--
-- Durability: NO DATA (invariant 1). A function and seven triggers; no
-- table, column or row is written. `down -v` loses nothing, and the next
-- migrate recreates them from this file.
--
-- Idempotent: `CREATE OR REPLACE FUNCTION` and `CREATE OR REPLACE TRIGGER`
-- (PostgreSQL 14+; every install runs 17), so `metistry update` can apply it
-- twice under its advisory lock and the second pass is a no-op.
--
-- ROLLBACK (nothing to restore — no data is written):
--   DROP TRIGGER IF EXISTS metistry_notify ON runs;
--   DROP TRIGGER IF EXISTS metistry_notify ON proposals;
--   DROP TRIGGER IF EXISTS metistry_notify ON work;
--   DROP TRIGGER IF EXISTS metistry_notify ON inbox;
--   DROP TRIGGER IF EXISTS metistry_notify ON artifact_comments;
--   DROP TRIGGER IF EXISTS metistry_notify ON outbound_messages;
--   DROP TRIGGER IF EXISTS metistry_notify ON agents;
--   DROP FUNCTION IF EXISTS metistry_notify();
-- The console tolerates their absence — its `LISTEN` simply hears nothing —
-- but a client subscribed to a silent stream stops polling and goes stale,
-- so roll the console back with them (to one that does not serve
-- `GET /api/events`) rather than dropping them under a live one.

CREATE OR REPLACE FUNCTION metistry_notify() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- nothing moved: a no-op upsert is not a change
    IF to_jsonb(NEW) = to_jsonb(OLD) THEN
      RETURN NULL;
    END IF;
    -- a heartbeat alone, inside the minute it was last seen in. NESTED, not
    -- one AND: PL/pgSQL does not short-circuit, and `OLD.last_seen_at` on
    -- any other table is an error that would fail the write it rides on.
    IF TG_TABLE_NAME = 'agents' THEN
      IF (to_jsonb(NEW) - 'last_seen_at') = (to_jsonb(OLD) - 'last_seen_at')
         AND OLD.last_seen_at IS NOT NULL
         AND NEW.last_seen_at IS NOT NULL
         AND date_trunc('minute', NEW.last_seen_at) = date_trunc('minute', OLD.last_seen_at) THEN
        RETURN NULL;
      END IF;
    END IF;
  END IF;
  PERFORM pg_notify('metistry_events', json_build_object('table', TG_TABLE_NAME, 'op', lower(TG_OP), 'id', NEW.id)::text);
  RETURN NULL;
END
$$;

COMMENT ON FUNCTION metistry_notify() IS
  'no data: pg_notify(''metistry_events'', {table, op, id}) for the live-changes stream (design-build-plan §2.20). Never a column value — the console maps the notice to a typed event and the client refetches through its route.';

CREATE OR REPLACE TRIGGER metistry_notify AFTER INSERT OR UPDATE ON runs              FOR EACH ROW EXECUTE FUNCTION metistry_notify();
CREATE OR REPLACE TRIGGER metistry_notify AFTER INSERT OR UPDATE ON proposals         FOR EACH ROW EXECUTE FUNCTION metistry_notify();
CREATE OR REPLACE TRIGGER metistry_notify AFTER INSERT OR UPDATE ON work              FOR EACH ROW EXECUTE FUNCTION metistry_notify();
CREATE OR REPLACE TRIGGER metistry_notify AFTER INSERT OR UPDATE ON inbox             FOR EACH ROW EXECUTE FUNCTION metistry_notify();
CREATE OR REPLACE TRIGGER metistry_notify AFTER INSERT OR UPDATE ON artifact_comments FOR EACH ROW EXECUTE FUNCTION metistry_notify();
CREATE OR REPLACE TRIGGER metistry_notify AFTER INSERT OR UPDATE ON outbound_messages FOR EACH ROW EXECUTE FUNCTION metistry_notify();
CREATE OR REPLACE TRIGGER metistry_notify AFTER INSERT OR UPDATE ON agents            FOR EACH ROW EXECUTE FUNCTION metistry_notify();
