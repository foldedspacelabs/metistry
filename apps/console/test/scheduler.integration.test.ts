// The scheduler's SQL against a real Postgres (T3-1). scheduler.test.ts
// proves the decisions against an in-memory `runs`; this proves the one query
// they rest on — `windowsFor`'s slot anchor (`meta->>'scheduled_for'`, cast
// behind a shape guard), the refused-row window and the held marker — and
// that a slot fires once when Postgres, not the test, stamps each row's `ts`.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { mintToken, type Weekday } from "@foldedspacelabs/metistry-core";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";
import { tick, type OverlayRead, type ScheduledCollector } from "../src/runner.js";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url)); // METISTRY_DB_* only (docs/ops/testing.md)

const EVERY_DAY: Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const NOTHING = { env: [], reachable: [], engine: false };
const MINUTE = 60_000;
const hhmm = (d: Date): string => `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;

describe.skipIf(!hasDb)("the scheduler against a real runs table (integration)", () => {
  let pool: pg.Pool;
  const suffix = mintToken(4).toLowerCase().replaceAll(/[^a-z0-9]/g, "").slice(0, 6) || "x";
  const names: string[] = [];
  const nameFor = (what: string): string => {
    const n = `sched-itest-${what}-${suffix}`;
    names.push(n);
    return n;
  };

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM runs WHERE component = ANY($1)`, [names]);
    await pool.query(`DELETE FROM outbound_messages WHERE kind = 'alert' AND text LIKE $1`, [`%sched-itest-%-${suffix}%`]);
    await pool.end();
  });

  /** A routine due at the minute two minutes ago, in UTC — a slot that has just passed on Postgres's own clock. */
  function justPassed(name: string, ran: { n: number }): ScheduledCollector {
    const slot = new Date(Math.floor(Date.now() / MINUTE) * MINUTE - 2 * MINUTE);
    return {
      name,
      dir: `routines/${name}`,
      schedule: { days: EVERY_DAY, at: [hhmm(slot)], tz: "UTC" },
      runKind: "routine_run",
      requires: NOTHING,
      run: async () => (ran.n++, 0),
    };
  }

  it("a slot fires once: the second tick finds the run row and its scheduled_for, and does not fire again", async () => {
    const name = nameFor("once");
    const ran = { n: 0 };
    const c = justPassed(name, ran);
    const startedAt = new Date(Date.now() - 10 * MINUTE);
    await tick(pool, [c], {}, { startedAt, timeZone: null, env: {} });
    await tick(pool, [c], {}, { startedAt, timeZone: null, env: {}, now: new Date(Date.now() + MINUTE) });
    expect(ran.n).toBe(1);
    const { rows } = await pool.query(`SELECT ok, meta FROM runs WHERE component = $1 AND kind = 'routine_run'`, [name]);
    expect(rows).toHaveLength(1);
    expect(rows[0].meta).toMatchObject({ time_zone: "UTC", outcome: "silent" });
    expect(String(rows[0].meta.scheduled_for)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/);
  });

  it("a row stamped BEFORE its slot (a drifted clock) still anchors on the slot it ran for", async () => {
    const name = nameFor("skew");
    const ran = { n: 0 };
    const c = justPassed(name, ran);
    const slot = new Date(Math.floor(Date.now() / MINUTE) * MINUTE - 2 * MINUTE);
    await pool.query(
      `INSERT INTO runs (component, kind, ts, started_at, finished_at, ok, meta) VALUES ($1, 'routine_run', $2, $2, $2, true, $3)`,
      [name, new Date(slot.getTime() - 5_000), JSON.stringify({ scheduled_for: slot.toISOString() })],
    );
    await tick(pool, [c], {}, { startedAt: new Date(Date.now() - 10 * MINUTE), timeZone: null, env: {} });
    expect(ran.n).toBe(0);
  });

  it("a malformed scheduled_for on some other writer's row is ignored, not a cast error that stops the tick", async () => {
    const name = nameFor("junk");
    const ran = { n: 0 };
    const c = justPassed(name, ran);
    await pool.query(`INSERT INTO runs (component, kind, ts, started_at, finished_at, ok, meta) VALUES ($1, 'routine_run', now() - interval '2 days', now(), now(), true, $2)`, [
      name,
      JSON.stringify({ scheduled_for: "last tuesday" }),
    ]);
    await tick(pool, [c], {}, { startedAt: new Date(Date.now() - 10 * MINUTE), timeZone: null, env: {} });
    expect(ran.n).toBe(1);
  });

  it("a refused schedule is one row a day — the second tick finds it through meta.schedule_refused", async () => {
    const name = nameFor("refused");
    const ran = { n: 0 };
    const c: ScheduledCollector = { ...justPassed(name, ran), schedule: { days: "working_days", at: ["07:00"], tz: "UTC" } };
    await tick(pool, [c], {}, { profile: async () => ({}), timeZone: null, env: {} });
    await tick(pool, [c], {}, { profile: async () => ({}), timeZone: null, env: {}, now: new Date(Date.now() + MINUTE) });
    expect(ran.n).toBe(0);
    const { rows } = await pool.query(`SELECT ok, meta FROM runs WHERE component = $1`, [name]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ok: true, meta: { schedule_refused: "no_working_days", outcome: "skipped:no_working_days" } });
  });

  it("a held component is one runner row a day, and never a run", async () => {
    const name = nameFor("held");
    const ran = { n: 0 };
    const c = justPassed(name, ran);
    const broken = async (): Promise<OverlayRead> => ({ ok: false, errors: [`routines.${name}.paused: expected boolean`], held: [name] });
    await tick(pool, [c], {}, { scheduled: broken, startedAt: new Date(Date.now() - 10 * MINUTE), timeZone: null, env: {} });
    await tick(pool, [c], {}, { scheduled: broken, startedAt: new Date(Date.now() - 10 * MINUTE), timeZone: null, env: {}, now: new Date(Date.now() + MINUTE) });
    expect(ran.n).toBe(0);
    const { rows } = await pool.query(`SELECT kind, tool, ok FROM runs WHERE component = $1`, [name]);
    expect(rows).toEqual([{ kind: "runner", tool: "schedule_held", ok: false }]);
  });
});
