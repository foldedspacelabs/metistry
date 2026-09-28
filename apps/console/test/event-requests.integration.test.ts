// Events become requests (C96, T2-9) against a real Postgres: a failed
// routine and a missing secret each become ONE Needs You request per
// signature — deduped while it waits, not asked again once answered until
// what it was about has recovered, and cleared at its source when it does.
// runner.test.ts proves what the tick decides; this proves the rows, through
// the runner's default requests (`runnerRequests` over the same pool).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { RESOLVED_AT_SOURCE, describeRequest, errorSignature, mintToken } from "@foldedspacelabs/metistry-core";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";
import { RUNNER_AGENT, routineFailedSource, secretFailedSource, tick, type RunnerOptions, type ScheduledCollector } from "../src/runner.js";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url)); // METISTRY_DB_* only (docs/ops/testing.md)

const NOTHING = { env: [], reachable: [], engine: false };
const MINUTE = 60_000;

describe.skipIf(!hasDb)("events become requests (C96, T2-9, integration)", () => {
  let pool: pg.Pool;
  const suffix = mintToken(4).toLowerCase().replaceAll(/[^a-z0-9]/g, "").slice(0, 6) || "x";
  const names: string[] = [];
  const nameFor = (what: string): string => {
    const n = `events-itest-${what}-${suffix}`;
    names.push(n);
    return n;
  };
  const SECRET = `METISTRY_ITEST_KEY_${suffix.toUpperCase()}`;
  // every tick is a window later, so an every-5m component is due on each
  let window = 0;
  const at = (over: RunnerOptions = {}): RunnerOptions => ({ timeZone: null, env: {}, now: new Date(Date.now() + ++window * 6 * MINUTE), ...over });

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM proposals WHERE source_agent = $1 AND source->>'external_ref' LIKE $2`, [RUNNER_AGENT, `%${suffix}%`]);
    await pool.query(`DELETE FROM proposals WHERE source_agent = $1 AND source->>'external_ref' = $2`, [RUNNER_AGENT, secretFailedSource(SECRET).external_ref]);
    await pool.query(`DELETE FROM runs WHERE component = ANY($1)`, [names]);
    await pool.query(`DELETE FROM outbound_messages WHERE kind = 'alert' AND text LIKE $1`, [`%events-itest-%-${suffix}%`]);
    await pool.end();
  });

  function routine(name: string, behave: { error: string | null }): ScheduledCollector {
    return {
      name,
      dir: `routines/${name}`,
      schedule: { every: "5m" },
      runKind: "routine_run",
      requires: NOTHING,
      run: async () => {
        if (behave.error !== null) throw new Error(behave.error);
        return 1;
      },
    };
  }

  const requestsFor = async (ref: string) =>
    (await pool.query(`SELECT id, kind, decision, payload FROM proposals WHERE source->>'kind' = 'metistry' AND source->>'external_ref' = $1 ORDER BY id`, [ref])).rows;

  it("a failed routine is one report per signature, with both timestamps, deduped while it waits", async () => {
    const name = nameFor("fails");
    const behave: { error: string | null } = { error: null };
    const c = routine(name, behave);
    await tick(pool, [c], {}, at()); // it worked once
    behave.error = "vault bridge answered 503 for request 81";
    await tick(pool, [c], {}, at());
    await tick(pool, [c], {}, at()); // same fault, another number: the same signature
    behave.error = "template Templates/Brief.md is missing";
    await tick(pool, [c], {}, at()); // a different fault is news

    const first = routineFailedSource(name, errorSignature(name, "vault bridge answered 503 for request 81"));
    const second = routineFailedSource(name, errorSignature(name, "template Templates/Brief.md is missing"));
    const a = await requestsFor(first.external_ref);
    const b = await requestsFor(second.external_ref);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    const lastOk = (await pool.query(`SELECT max(ts) AS ts FROM runs WHERE component = $1 AND kind = 'routine_run' AND ok`, [name])).rows[0].ts as Date;
    expect(a[0]).toMatchObject({ kind: "report", decision: "pending" });
    expect(a[0].payload).toMatchObject({
      title: `${name} failed`,
      body: "vault bridge answered 503 for request 81",
      event: "routine_failed",
      component: name,
      last_ok_at: lastOk.toISOString(),
      act: { label: "Try Again", kind: "run_now", component: name },
    });
    expect(Date.parse(a[0].payload.failed_at)).toBeGreaterThan(lastOk.getTime());
    // the table draws it as a report whose act is its own word
    expect(describeRequest("report", a[0].payload)).toMatchObject({ type: "report", body: "excerpt", primary: { label: null, sends: { door: "act" } } });

    // the next run that works clears both at their source — three failures in
    // a row have stopped it (T3-12), so the limit is raised to let it run
    behave.error = null;
    await tick(pool, [c], {}, at({ maxStreak: 9 }));
    expect((await requestsFor(first.external_ref)).map((r) => r.decision)).toEqual([RESOLVED_AT_SOURCE]);
    expect((await requestsFor(second.external_ref)).map((r) => r.decision)).toEqual([RESOLVED_AT_SOURCE]);
    expect((await requestsFor(first.external_ref))[0].payload.cleared).toEqual({ what: "Ran cleanly again", where: "metistry" });
  });

  it("a Dismiss holds while the fault lasts; the same fault after a recovery is asked again", async () => {
    const name = nameFor("dismissed");
    const behave: { error: string | null } = { error: "the model timed out" };
    const c = routine(name, behave);
    const ref = routineFailedSource(name, errorSignature(name, "the model timed out")).external_ref;
    await tick(pool, [c], {}, at());
    const [raised] = await requestsFor(ref);
    await pool.query(`UPDATE proposals SET decision = 'deny', decided_at = now() WHERE id = $1`, [raised.id]); // Dismiss
    await tick(pool, [c], {}, at());
    expect((await requestsFor(ref)).map((r) => r.decision)).toEqual(["deny"]);

    behave.error = null;
    await tick(pool, [c], {}, at()); // recovered
    behave.error = "the model timed out";
    await tick(pool, [c], {}, at()); // broke again, the same way
    expect((await requestsFor(ref)).map((r) => r.decision)).toEqual(["deny", "pending"]);
  });

  it("a collector's failure raises no report here — three strikes are T3-12's", async () => {
    const name = nameFor("collector");
    const c: ScheduledCollector = { ...routine(name, { error: "401 Bad credentials" }), runKind: "collector_run", dir: `collectors/${name}` };
    await tick(pool, [c], {}, at());
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM proposals WHERE source_agent = $1 AND source->>'external_ref' LIKE $2`, [RUNNER_AGENT, `%${name}%`]);
    expect(rows[0].n).toBe(0);
  });

  it("a missing secret is ONE access request naming everything it stopped, and clears when it is set", async () => {
    const needs = { env: [SECRET], reachable: [], engine: false };
    const one: ScheduledCollector = { ...routine(nameFor("sec-a"), { error: null }), requires: needs };
    const two: ScheduledCollector = { ...routine(nameFor("sec-b"), { error: null }), runKind: "collector_run", requires: needs };
    const later: ScheduledCollector = { ...routine(nameFor("sec-c"), { error: null }), requires: needs };
    const ref = secretFailedSource(SECRET).external_ref;

    // a daily one that ran a moment ago: not due this tick, but it depends on the secret all the same
    const daily: ScheduledCollector = { ...routine(nameFor("sec-d"), { error: null }), schedule: { every: "6h" }, requires: needs };
    const bystander = routine(nameFor("sec-x"), { error: null }); // needs nothing: not a dependent
    await pool.query(`INSERT INTO runs (component, kind, ok, ts) VALUES ($1, 'routine_run', true, now())`, [daily.name]);

    await tick(pool, [one, two, daily, bystander], {}, at());
    await tick(pool, [one, two, daily, bystander], {}, at()); // still missing: the same request
    let rows = await requestsFor(ref);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "secret_failure", decision: "pending" });
    expect(rows[0].payload).toMatchObject({ title: `${SECRET} is not set`, event: "secret_failed", variable: SECRET, stopped: [one.name, two.name].sort(), last_ok_at: null });
    // ONE request naming its dependents: everything that needs it, stopped yet or not — never the bystander
    const deps = [
      { component: one.name, title: one.name, kind: "routine" },
      { component: two.name, title: two.name, kind: "collector" },
      { component: daily.name, title: daily.name, kind: "routine" },
    ].sort((a, b) => (a.component < b.component ? -1 : 1));
    expect(rows[0].payload.dependents).toEqual(deps);
    expect(rows[0].payload.used_by).toBe("2 routines and 1 sync use it");
    expect(rows[0].payload.body).toMatchObject({ kind: "before_after", heading: SECRET, before: { label: "Waiting on it" } });
    expect(rows[0].payload.body.before.text.split("\n")).toEqual(deps.map((d) => `${d.title}${d.component === daily.name ? " — stops when its time comes" : " — stopped"}`));
    expect(describeRequest("secret_failure", rows[0].payload)).toMatchObject({ type: "access", word: "access", body: "before_after" });

    // a component stopped since joins the list — it is not a request of its own
    await tick(pool, [one, two, later], {}, at());
    rows = await requestsFor(ref);
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.stopped).toEqual([one.name, two.name, later.name].sort());
    expect(rows[0].payload.dependents.map((d: { component: string }) => d.component)).toEqual([one.name, two.name, daily.name, later.name].sort());

    // set: the request leaves the queue at its source, with a receipt, and the components run
    await tick(pool, [one, two, later], {}, at({ env: { [SECRET]: "k" } }));
    expect((await requestsFor(ref)).map((r) => r.decision)).toEqual([RESOLVED_AT_SOURCE]);
    expect((await requestsFor(ref))[0].payload.cleared).toEqual({ what: `${SECRET} is set again`, where: "metistry" });
    const ran = await pool.query(`SELECT count(*)::int AS n FROM runs WHERE component = ANY($1) AND kind IN ('routine_run', 'collector_run') AND ok`, [[one.name, two.name, later.name]]);
    expect(ran.rows[0].n).toBe(3);

    // unset again after they ran: news, a new request
    await tick(pool, [one], {}, at());
    expect((await requestsFor(ref)).map((r) => r.decision)).toEqual([RESOLVED_AT_SOURCE, "pending"]);

    // declined while still missing: not asked again
    const [, waiting] = await requestsFor(ref);
    await pool.query(`UPDATE proposals SET decision = 'deny', decided_at = now() WHERE id = $1`, [waiting.id]);
    await tick(pool, [one, two], {}, at());
    expect((await requestsFor(ref)).map((r) => r.decision)).toEqual([RESOLVED_AT_SOURCE, "deny"]);
  });
});
