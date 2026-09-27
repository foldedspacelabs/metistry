// Three strikes and a Stop limit (C135, C133, T3-12) against a real
// Postgres: a component that fails three times in a row stops, and a budget
// whose action is `stop` pauses the routines — each raising ONE Needs You
// request per signature per window. runner.test.ts proves what the tick
// decides; this proves the rows, through the runner's default requests
// (`runnerRequests` over the same pool).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { RESOLVED_AT_SOURCE, describeRequest, errorSignature, mintToken, parseCompute, type BudgetHit } from "@foldedspacelabs/metistry-core";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";
import { RUNNER_AGENT, budgetStopKey, budgetStoppedSource, collectorFailedSource, routineFailedSource, tick, type RunnerOptions, type ScheduledCollector } from "../src/runner.js";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url)); // METISTRY_DB_* only (docs/ops/testing.md)

const NOTHING = { env: [], reachable: [], engine: false };
const MINUTE = 60_000;

describe.skipIf(!hasDb)("three strikes and a Stop limit (C135, C133, T3-12, integration)", () => {
  let pool: pg.Pool;
  const suffix = mintToken(4).toLowerCase().replaceAll(/[^a-z0-9]/g, "").slice(0, 6) || "x";
  const names: string[] = [];
  const nameFor = (what: string): string => {
    const n = `strikes-itest-${what}-${suffix}`;
    names.push(n);
    return n;
  };
  // every tick is a window later, so an every-5m component is due on each
  let window = 0;
  const at = (over: RunnerOptions = {}): RunnerOptions => ({ timeZone: null, env: {}, now: new Date(Date.now() + ++window * 6 * MINUTE), ...over });
  // a limit no other suite or run of this one uses, so its budget key is this test's alone
  const limit = 1000 + (Number.parseInt(suffix, 36) % 100_000);

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM proposals WHERE source_agent = $1 AND (source->>'external_ref' LIKE $2 OR source->>'external_ref' LIKE $3)`, [RUNNER_AGENT, `%${suffix}%`, `%@${limit}`]);
    await pool.query(`DELETE FROM runs WHERE component = ANY($1)`, [names]);
    await pool.query(`DELETE FROM outbound_messages WHERE kind = 'alert' AND text LIKE $1`, [`%strikes-itest-%-${suffix}%`]);
    await pool.end();
  });

  function component(name: string, runKind: ScheduledCollector["runKind"], behave: { error: string | null }): ScheduledCollector {
    return {
      name,
      dir: `${runKind === "routine_run" ? "routines" : "collectors"}/${name}`,
      schedule: { every: "5m" },
      runKind,
      requires: NOTHING,
      run: async () => {
        if (behave.error !== null) throw new Error(behave.error);
        return 1;
      },
    };
  }

  const requestsFor = async (ref: string) =>
    (await pool.query(`SELECT id, kind, decision, payload FROM proposals WHERE source->>'kind' = 'metistry' AND source->>'external_ref' = $1 ORDER BY id`, [ref])).rows;
  const dismiss = (id: number) => pool.query(`UPDATE proposals SET decision = 'deny', decided_at = now() WHERE id = $1`, [id]);
  const runsOf = async (name: string, kind: string) =>
    (await pool.query(`SELECT id::int AS id, ts, ok FROM runs WHERE component = $1 AND kind = $2 ORDER BY id`, [name, kind])).rows as { id: number; ts: Date; ok: boolean }[];

  it("a collector failing three times stops and raises ONE report per signature per streak", async () => {
    const name = nameFor("collector");
    const behave: { error: string | null } = { error: null };
    const c = component(name, "collector_run", behave);
    const ref = collectorFailedSource(name, errorSignature(name, "401 Bad credentials")).external_ref;
    await tick(pool, [c], {}, at()); // it worked once
    behave.error = "401 Bad credentials";
    await tick(pool, [c], {}, at());
    await tick(pool, [c], {}, at());
    expect(await requestsFor(ref)).toHaveLength(0); // two strikes: nothing yet
    await tick(pool, [c], {}, at()); // three: it stops
    for (let i = 0; i < 3; i++) await tick(pool, [c], {}, at()); // skipped windows: still the one request

    const runs = await runsOf(name, "collector_run");
    expect(runs.map((r) => r.ok)).toEqual([true, false, false, false]); // stopped: no fourth failure was spent
    const rows = await requestsFor(ref);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "report", decision: "pending" });
    expect(rows[0].payload).toMatchObject({
      title: `${name} stopped after 3 failures`,
      body: "401 Bad credentials",
      event: "collector_failed",
      component: name,
      run_id: runs[3]!.id,
      last_ok_at: runs[0]!.ts.toISOString(),
      stopped: { failures: 3, limit: 3, since: runs[1]!.ts.toISOString() },
      act: { label: "Try Again", kind: "run_now", component: name },
    });
    expect(describeRequest("report", rows[0].payload)).toMatchObject({ type: "report", body: "excerpt", primary: { label: null, sends: { door: "act" } } });

    // a Dismiss holds while it stays stopped
    await dismiss(rows[0].id);
    await tick(pool, [c], {}, at());
    expect((await requestsFor(ref)).map((r) => r.decision)).toEqual(["deny"]);

    // a raised limit lets it run; the run that works clears the stop at its source…
    behave.error = null;
    await tick(pool, [c], {}, at({ maxStreak: 9 }));
    // …and three strikes of the same fault after that are news again
    behave.error = "401 Bad credentials";
    for (let i = 0; i < 4; i++) await tick(pool, [c], {}, at());
    expect((await requestsFor(ref)).map((r) => r.decision)).toEqual(["deny", "pending"]);

    behave.error = null;
    await tick(pool, [c], {}, at({ maxStreak: 9 }));
    expect((await requestsFor(ref)).map((r) => r.decision)).toEqual(["deny", RESOLVED_AT_SOURCE]);
  });

  it("a routine's stop is its failure report, turned — never a second request about the same fault", async () => {
    const name = nameFor("routine");
    const behave: { error: string | null } = { error: "vault bridge answered 503 for request 81" };
    const c = component(name, "routine_run", behave);
    const ref = routineFailedSource(name, errorSignature(name, behave.error!)).external_ref;
    await tick(pool, [c], {}, at());
    let rows = await requestsFor(ref);
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.title).toBe(`${name} failed`);
    expect(rows[0].payload.stopped).toBeUndefined();

    behave.error = "vault bridge answered 503 for request 82";
    await tick(pool, [c], {}, at());
    await tick(pool, [c], {}, at()); // three
    await tick(pool, [c], {}, at()); // skipped
    rows = await requestsFor(ref);
    expect(rows).toHaveLength(1);
    const runs = await runsOf(name, "routine_run");
    expect(rows[0]).toMatchObject({ kind: "report", decision: "pending" });
    expect(rows[0].payload).toMatchObject({
      title: `${name} stopped after 3 failures`,
      event: "routine_failed",
      run_id: runs[0]!.id, // the report still names the run it was raised for
      stopped: { failures: 3, limit: 3, since: runs[0]!.ts.toISOString() },
      act: { label: "Try Again", kind: "run_now", component: name },
    });
    const all = await pool.query(`SELECT count(*)::int AS n FROM proposals WHERE source_agent = $1 AND source->>'external_ref' LIKE $2`, [RUNNER_AGENT, `%${name}%`]);
    expect(all.rows[0].n).toBe(1);

    // the run that works clears it, as T2-9's report always was
    behave.error = null;
    await tick(pool, [c], {}, at({ maxStreak: 9 }));
    expect((await requestsFor(ref)).map((r) => r.decision)).toEqual([RESOLVED_AT_SOURCE]);
  });

  it("an answer to a routine's failure sticks through its stop: one request per signature per streak", async () => {
    const name = nameFor("answered");
    const c = component(name, "routine_run", { error: "the model timed out" });
    const ref = routineFailedSource(name, errorSignature(name, "the model timed out")).external_ref;
    await tick(pool, [c], {}, at());
    const [raised] = await requestsFor(ref);
    await dismiss(raised.id);
    for (let i = 0; i < 4; i++) await tick(pool, [c], {}, at()); // three strikes, then a skipped window
    expect((await requestsFor(ref)).map((r) => r.decision)).toEqual(["deny"]);
    expect((await requestsFor(ref))[0].payload.stopped).toBeUndefined();
  });

  it("a Stop limit pauses the routines and raises ONE report per budget window, naming each, cleared when it no longer stops", async () => {
    const KEY = `METISTRY_STRIKES_ITEST_${suffix.toUpperCase()}`;
    const compute = parseCompute(`
providers:
  openrouter:
    kind: openai-compatible
    base_url: https://openrouter.ai/api/v1
    locality: off_machine
    auth: { secret: ${KEY} }
    data_policy: { allow: [Projects], deny_sources: [comms], max_brief_bytes: 65536 }
assignments:
  default: { model: openrouter/anthropic/claude-sonnet-5 }
`);
    const engine = { env: [], reachable: [], engine: true };
    const ran: string[] = [];
    const routine = (what: string): ScheduledCollector => {
      const name = nameFor(what);
      return { name, dir: `routines/${name}`, schedule: { every: "5m" }, runKind: "routine_run", requires: engine, run: async () => (ran.push(name), 1) };
    };
    const [fold, brief, plan] = [routine("fold"), routine("brief"), routine("plan")];
    const hit: BudgetHit = { scope: "instance", window: "monthly", field: "budgets.instance.monthly_usd", limit, spent: limit + 1.5, fraction: 1.01, over: true, action: "stop" };
    let stopping: BudgetHit | null = hit;
    const budget = async () => (stopping ? { name: stopping.field, why: "the instance monthly budget is spent", fix: "raise it", hit: stopping } : null);
    const when = (over: RunnerOptions = {}) => at({ budget, compute: () => compute, env: { [KEY]: "sk-or-x" }, ...over });

    const first = when();
    await tick(pool, [fold, brief], {}, first);
    await tick(pool, [fold, brief], {}, when()); // still over: the same request
    expect(ran).toEqual([]); // paused: nothing was started, nothing spent
    const ref = budgetStoppedSource(budgetStopKey(hit, first.now!)).external_ref;
    let rows = await requestsFor(ref);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "report", decision: "pending" });
    expect(rows[0].payload).toMatchObject({
      title: `Compute stopped at the $${limit}.00 monthly budget`,
      event: "budget_stopped",
      budget: { scope: "instance", window: "monthly", field: "budgets.instance.monthly_usd", limit, action: "stop" },
      paused: [fold.name, brief.name].sort(),
      act: { label: "Raise", kind: "open_settings", pane: "compute", section: "spending_limits" },
    });
    expect(rows[0].payload.fix).toContain("budgets.instance.monthly_usd");
    expect(describeRequest("report", rows[0].payload)).toMatchObject({ type: "report", body: "excerpt" });

    // a routine paused later in the window joins the list — not a request of its own
    await tick(pool, [fold, brief, plan], {}, when());
    rows = await requestsFor(ref);
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.paused).toEqual([fold.name, brief.name, plan.name].sort());

    // Dismissed: not asked again in this window
    await dismiss(rows[0].id);
    await tick(pool, [fold, brief, plan], {}, when());
    expect((await requestsFor(ref)).map((r) => r.decision)).toEqual(["deny"]);

    // the limit raised and spent again: a new key, news
    const raised: BudgetHit = { ...hit, limit: limit + 0.5 };
    stopping = raised;
    const again = when();
    await tick(pool, [fold], {}, again);
    const ref2 = budgetStoppedSource(budgetStopKey(raised, again.now!)).external_ref;
    expect((await requestsFor(ref2)).map((r) => r.decision)).toEqual(["pending"]);

    // no longer over: the routines run, and the waiting request clears itself —
    // even on a tick where none of them is due
    stopping = null;
    await tick(pool, [], {}, when());
    expect((await requestsFor(ref2)).map((r) => r.decision)).toEqual([RESOLVED_AT_SOURCE]);
    await tick(pool, [fold], {}, when());
    expect(ran).toEqual([fold.name]);
  });
});
