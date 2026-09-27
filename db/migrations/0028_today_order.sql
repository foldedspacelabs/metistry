-- 0028_today_order — the owner's drag order for one day's Today list
-- (plan §2.9, §2.10, decision D10: "Today's drag order stored server-side";
-- ticket T1-9). Read by `today_order`; written by `PUT /api/today/order`
-- (T2-7, out of this ticket's scope — this file is the table alone).
--
-- Why a table at all: Today composes several sources for one day —
-- `vault_tasks_query`, `day_work`, `day_events` — and none of them is where
-- the owner dragged a row to. The drag order is a fact about none of those
-- rows' own data, so it gets a row of its own: one (day, task_key) pair, and
-- where it sits.
--
-- `task_key` is `vault_tasks.task_key` (0024) BY VALUE, not by foreign key —
-- deliberately, the same reasoning `vault_tasks.work_id` gives for not
-- pointing at `work`: `vault_tasks` is derived and rebuilt by the
-- reconciler's walk, so a FK here would make a stale order row fail a
-- rebuilt walk it has no business blocking. A key the walk no longer
-- produces (the line moved, was deleted, or was never on today) is simply a
-- row `today_order` serves that nothing joins to today's list — harmless,
-- and cleared the next time the owner reorders that day.
--
-- Durability (invariant 1, D6): DURABLE. Nothing derives it — no walk, no
-- collector, no sync ever writes a row here, and there is no source file the
-- drag order could be reconstructed from. `docker compose down -v` and a
-- rebuild lose every day's order for good; Today falls back to its
-- underlying queries' own ordering (unblocked-first, then due, per
-- `day_work`/`vault_tasks_query`), which is a worse arrangement, never a
-- wrong one. Small and low-stakes enough that D6's honest restatement of the
-- durable set can decide, later, whether it rides in the nightly dump; this
-- migration does not answer that.
--
-- Additive: one new table, nothing rewritten. Every statement is
-- idempotent (`IF NOT EXISTS`), so applying the file twice is a no-op the
-- second time even outside the runner's own bookkeeping.
--
-- ROLLBACK NOTE (nothing here is destructive to anything else — it is the
-- whole of what it destroys): `DROP TABLE IF EXISTS today_order;` — after
-- `PUT /api/today/order` and `today_order` (the query) stop being called.
-- Today reverts to its queries' natural order for every day, immediately.

CREATE TABLE IF NOT EXISTS today_order (
    day       date        NOT NULL,                 -- durable: the day this position applies to
    task_key  text        NOT NULL,                  -- durable: vault_tasks.task_key by value — no FK (see header)
    position  integer     NOT NULL,                  -- durable: sort position within the day, owner's own arrangement
    updated_at timestamptz NOT NULL DEFAULT now(),    -- durable: when the owner last moved this row
    PRIMARY KEY (day, task_key)
);

COMMENT ON TABLE today_order IS
  'Durable: the owner''s drag order for one day''s Today list (day, task_key) -> position. Nothing derives or rebuilds it; lost on docker compose down -v with no walk or collector to replace it (plan §2.9, D10).';

-- Today reads one day's rows in position order; this is that scan.
CREATE INDEX IF NOT EXISTS today_order_day_idx ON today_order (day, position);
