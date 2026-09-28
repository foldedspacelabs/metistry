// The runner against a tiny in-memory model of the two tables it touches
// (`runs`, `outbound_messages`), so the hardening behaviours are tested as
// behaviour rather than as SQL strings: a component that keeps failing stops
// being run, a blocked one never starts a run at all, each records exactly
// one row per window however often the runner ticks, and one fault costs one
// notification.
import { describe, expect, it } from "vitest";
import { errorSignature, parseCompute } from "@foldedspacelabs/metistry-core";
import type { PlanVault } from "@metistry-apps/routines";
import { budgetStopKey, dependentsSentence, routineCapabilities, secretDependents, scheduleToSeconds, tick, type BudgetStop, type ComponentStop, type RoutineFailure, type RunnerRequests, type ScheduledCollector, type SecretFailure } from "../src/runner.js";
import { FakeRuns as Fake } from "./runs-fake.js";

const NOW = new Date("2026-09-15T12:00:00Z");
const NOTHING = { env: [], reachable: [], engine: false };

function collector(over: Partial<ScheduledCollector> = {}): ScheduledCollector {
  return {
    name: "t",
    dir: "collectors/t",
    schedule: { every: "5m" },
    runKind: "collector_run",
    requires: NOTHING,
    run: async () => 1,
    ...over,
  };
}

const fetchNever = (async () => {
  throw new Error("no network in these tests");
}) as unknown as typeof fetch;

// runs-fake models `runs` alone: the Needs You requests (T2-9) are off here, and recorded below
const opts = (over: Record<string, unknown> = {}) => ({ now: NOW, env: {}, fetchFn: fetchNever, requests: null, ...over });

describe("routine runner", () => {
  it("parses the narrow cron dialect and refuses the rest loudly", () => {
    expect(scheduleToSeconds("*/5 * * * *")).toBe(300);
    expect(scheduleToSeconds("@hourly")).toBe(3600);
    expect(scheduleToSeconds("@daily")).toBe(86400);
    expect(() => scheduleToSeconds("0 4 * * 1")).toThrow(/cannot schedule/);
  });

  it("runs only when due, records a two-phase run, and isolates failures", async () => {
    const db = new Fake(NOW).seed([{ component: "t", kind: "collector_run", minutesAgo: 1, ok: true }]);
    let ran = 0;
    const c = collector({ run: async () => (ran++, 1) });

    await tick(db, [c], {}, opts()); // not due (1m < 5m)
    expect(ran).toBe(0);

    db.runs = []; // never ran → due
    await tick(db, [c], {}, opts());
    expect(ran).toBe(1);
    expect(db.rowsFor("t").map((r) => ({ kind: r.kind, ok: r.ok }))).toEqual([{ kind: "collector_run", ok: true }]);

    const failing = collector({ name: "f", dir: "collectors/f", run: async () => { throw new Error("x"); } }); // never ran → due
    await expect(tick(db, [failing], {}, opts())).resolves.toBeUndefined(); // failure recorded, never thrown
    expect(db.rowsFor("f")[0]).toMatchObject({ ok: false, error: "x" });
  });

  // T1-4: every routine_run row carries meta.outcome — acted | silent — so the
  // activity feed (T1-3) can tell a real event from an hourly tick that found
  // nothing to do. A routine that skips for a specific reason writes ITS OWN
  // row saying so (plan-tomorrow, knowledge-fold: see their own suites) — this
  // is the runner's generic per-tick row, which only ever knows the count.
  it("records meta.outcome on a routine_run row — acted when it did something, silent when it did not", async () => {
    const db = new Fake(NOW);
    const acted = collector({ name: "morning-brief", dir: "routines/morning-brief", runKind: "routine_run", run: async () => 1 });
    await tick(db, [acted], {}, opts());
    expect(db.rowsFor("morning-brief")[0]).toMatchObject({ ok: true, meta: { processed: 1, outcome: "acted" } });

    const silent = collector({ name: "reply-review", dir: "routines/reply-review", runKind: "routine_run", run: async () => 0 });
    await tick(db, [silent], {}, opts());
    expect(db.rowsFor("reply-review")[0]).toMatchObject({ ok: true, meta: { processed: 0, outcome: "silent" } });
  });

  it("never invents an outcome for a collector_run row — that vocabulary is the routines'", async () => {
    const db = new Fake(NOW);
    await tick(db, [collector({ run: async () => 3 })], {}, opts());
    expect(db.rowsFor("t")[0]?.meta).toEqual({ processed: 3 });
  });

  it("signs the failing run so the same fault is one fact, not one per hour", async () => {
    const db = new Fake(NOW);
    await tick(db, [collector({ run: async () => { throw new Error("401 Bad credentials"); } })], {}, opts());
    expect(db.outbound).toHaveLength(1);
    expect(db.outbound[0]?.text).toContain(`[sig:${errorSignature("t", "401 Bad credentials")}]`);
    expect(db.outbound[0]?.text).toContain("METISTRY_RUNNER_MAX_STREAK");
    expect(db.outbound[0]?.text).toContain("collectors/t/manifest.yaml");
  });

  it("alerts once per signature per window, and again when the fault changes", async () => {
    const db = new Fake(NOW);
    let message = "401 Bad credentials";
    const c = collector({ run: async () => { throw new Error(message); } }); // every 5m
    // one tick per window, so each is due: every failure is a run
    const at = (windows: number) => {
      db.now = new Date(NOW.getTime() + windows * 5 * 60_000);
      return opts({ alertDedupeHours: 24, now: db.now });
    };
    await tick(db, [c], {}, at(0));
    await tick(db, [c], {}, at(1));
    await tick(db, [c], {}, at(2));
    expect(db.rowsFor("t").filter((r) => r.kind === "collector_run")).toHaveLength(3); // every failure is still recorded
    expect(db.outbound).toHaveLength(1); // but you are told once

    message = "403 rate limit exceeded";
    await tick(db, [c], {}, at(3));
    expect(db.outbound).toHaveLength(2); // a different signature is news
  });

  it("stops running a component after METISTRY_RUNNER_MAX_STREAK failures, one row per window", async () => {
    const db = new Fake(NOW).seed(
      [10, 9, 8, 7, 6].map((minutesAgo) => ({ component: "t", kind: "collector_run", minutesAgo, ok: false, error: "401 Bad credentials" })),
    );
    let ran = 0;
    const c = collector({ run: async () => (ran++, 1) }); // every 5m

    await tick(db, [c], {}, opts({ maxStreak: 5 }));
    expect(ran).toBe(0); // not run at all: no call, no spend
    const skips = () => db.rowsFor("t", "skipped_streak");
    expect(skips()).toHaveLength(1);
    expect(skips()[0]).toMatchObject({ kind: "runner", ok: false });
    expect(skips()[0]?.error).toContain("5 consecutive failed runs");
    expect(skips()[0]?.error).toContain("METISTRY_RUNNER_MAX_STREAK = 5");

    // the runner ticks every minute; the window is five. Still one row.
    await tick(db, [c], {}, opts({ maxStreak: 5 }));
    await tick(db, [c], {}, opts({ maxStreak: 5 }));
    expect(skips()).toHaveLength(1);
    expect(db.outbound).toHaveLength(1);

    // next window: one more row, and the alert stays quiet inside its own window
    await tick(db, [c], {}, { now: new Date(NOW.getTime() + 6 * 60_000), env: {}, fetchFn: fetchNever, maxStreak: 5, requests: null });
    expect(skips()).toHaveLength(2);
    expect(db.outbound).toHaveLength(1);

    // raising the limit lets it try again — the message said which knob
    await tick(db, [c], {}, opts({ maxStreak: 9 }));
    expect(ran).toBe(1);
  });

  it("clears the skip as soon as one run succeeds", async () => {
    const db = new Fake(NOW).seed([
      ...[10, 9, 8, 7, 6].map((minutesAgo) => ({ component: "t", kind: "collector_run", minutesAgo, ok: false, error: "boom" })),
      { component: "t", kind: "collector_run", minutesAgo: 5, ok: true },
    ]);
    let ran = 0;
    await tick(db, [collector({ run: async () => (ran++, 1) })], {}, opts({ maxStreak: 5 }));
    expect(ran).toBe(1);
    expect(db.rowsFor("t", "skipped_streak")).toHaveLength(0);
  });

  it("preflight: a missing variable costs no run, one row per window, and the message names the variable", async () => {
    const db = new Fake(NOW);
    let ran = 0;
    const c = collector({
      name: "devin-knowledge",
      dir: "collectors/devin-knowledge",
      requires: { env: ["METISTRY_DEVIN_API_KEY"], reachable: [], engine: false },
      run: async () => (ran++, 1),
    });

    await tick(db, [c], {}, opts());
    await tick(db, [c], {}, opts());
    expect(ran).toBe(0);
    expect(db.rowsFor("devin-knowledge").filter((r) => r.kind === "collector_run")).toHaveLength(0); // nothing was even started
    const blocked = db.rowsFor("devin-knowledge", "preflight_failed");
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.error).toContain("blocked_config");
    expect(blocked[0]?.error).toContain("METISTRY_DEVIN_API_KEY");
    expect(db.outbound).toHaveLength(1);
    expect(db.outbound[0]?.text).toContain("collectors/devin-knowledge/manifest.yaml");

    // configured → it runs, and nothing new is recorded as blocked
    await tick(db, [c], {}, opts({ env: { METISTRY_DEVIN_API_KEY: "cog_x" } }));
    expect(ran).toBe(1);
    expect(db.rowsFor("devin-knowledge", "preflight_failed")).toHaveLength(1);
  });

  it("preflight: an unreachable declared url blocks the window before anything is spent", async () => {
    const db = new Fake(NOW);
    let ran = 0;
    const fetchFn = (async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:7801"); }) as unknown as typeof fetch;
    const c = collector({ requires: { env: [], reachable: ["METISTRY_EK_URL"], engine: false }, run: async () => (ran++, 1) });
    await tick(db, [c], {}, opts({ env: { METISTRY_EK_URL: "http://127.0.0.1:7801" }, fetchFn }));
    expect(ran).toBe(0);
    expect(db.rowsFor("t", "preflight_failed")[0]?.error).toContain("METISTRY_EK_URL");
  });

  // C2/C3: an engine is `assignments.default` in compute.yaml plus the key its
  // provider names — read through core's one seam, the same one `up` and
  // doctor read, so the scheduler and the supervisor cannot disagree.
  it("preflight: a routine that would enqueue a turn is blocked when the install has no engine", async () => {
    const db = new Fake(NOW);
    let ran = 0;
    const fold = collector({
      name: "knowledge-fold",
      dir: "routines/knowledge-fold",
      runKind: "routine_run",
      requires: { env: [], reachable: [], engine: true },
      run: async () => (ran++, 1),
    });
    const compute = parseCompute(`
providers:
  openrouter:
    kind: openai-compatible
    base_url: https://openrouter.ai/api/v1
    locality: off_machine
    auth: { secret: METISTRY_OPENROUTER_API_KEY }
    data_policy: { allow: [Projects], deny_sources: [comms], max_brief_bytes: 65536 }
assignments:
  default: { model: openrouter/anthropic/claude-sonnet-5 }
`);

    // nothing assigned at all: the file itself is the miss, and the verb is the fix
    await tick(db, [fold], {}, opts());
    expect(ran).toBe(0);
    expect(db.rowsFor("knowledge-fold", "preflight_failed")[0]?.error).toContain("no assignments.default in compute.yaml");

    // assigned, but the provider's key is unset: the miss names THAT variable.
    // A fresh db, because one blocked window per component is recorded once.
    const noKey = new Fake(NOW);
    await tick(noKey, [fold], {}, opts({ compute: () => compute }));
    expect(ran).toBe(0);
    expect(noKey.rowsFor("knowledge-fold", "preflight_failed")[0]?.error).toContain("METISTRY_OPENROUTER_API_KEY");

    await tick(new Fake(NOW), [fold], {}, opts({ compute: () => compute, env: { METISTRY_OPENROUTER_API_KEY: "sk-or-x" } }));
    expect(ran).toBe(1);
  });
});

/** Records what the tick hands the requests seam — the decisions; event-requests.integration.test.ts proves the rows. */
function recordingRequests() {
  const calls = {
    failed: [] as RoutineFailure[],
    succeeded: [] as string[],
    collected: [] as string[],
    stopped: [] as ComponentStop[],
    secrets: [] as SecretFailure[][],
    restoredChecks: [] as ((name: string) => boolean)[],
    budgets: [] as BudgetStop[][],
    resumed: [] as (() => Promise<string | null | undefined>)[],
  };
  const requests: RunnerRequests = {
    routineFailed: async (f) => void calls.failed.push(f),
    routineSucceeded: async (c) => void calls.succeeded.push(c),
    collectorSucceeded: async (c) => void calls.collected.push(c),
    componentStopped: async (s) => void calls.stopped.push(s),
    secretsFailed: async (fs) => void calls.secrets.push([...fs]),
    secretsRestored: async (isSet) => void calls.restoredChecks.push(isSet),
    budgetStopped: async (bs) => void calls.budgets.push([...bs]),
    budgetResumed: async (current) => void calls.resumed.push(current),
  };
  return { calls, requests };
}

describe("events become requests (C96, T2-9) — what the tick raises", () => {
  it("a failed ROUTINE raises one report with its signature and the time it failed; a collector's failure does not (T3-12's)", async () => {
    const db = new Fake(NOW);
    const { calls, requests } = recordingRequests();
    const brief = collector({ name: "morning-brief", dir: "routines/morning-brief", runKind: "routine_run", run: async () => { throw new Error("vault bridge 503 at 06:00"); } });
    const sync = collector({ name: "github-state", dir: "collectors/github-state", run: async () => { throw new Error("401 Bad credentials"); } });
    await tick(db, [brief, sync], {}, opts({ requests }));
    expect(calls.failed).toEqual([
      {
        component: "morning-brief",
        title: "morning-brief",
        runId: db.rowsFor("morning-brief")[0]!.id,
        error: "vault bridge 503 at 06:00",
        signature: errorSignature("morning-brief", "vault bridge 503 at 06:00"),
        failedAt: NOW,
      },
    ]);
  });

  it("a routine that runs clears its reports; a collector that runs clears its stop (T3-12)", async () => {
    const db = new Fake(NOW);
    const { calls, requests } = recordingRequests();
    const brief = collector({ name: "morning-brief", dir: "routines/morning-brief", runKind: "routine_run" });
    await tick(db, [brief, collector()], {}, opts({ requests }));
    expect(calls.succeeded).toEqual(["morning-brief"]);
    expect(calls.collected).toEqual(["t"]);
    expect(calls.failed).toEqual([]);
    expect(calls.stopped).toEqual([]);
  });

  it("a missing secret is ONE failure naming every component it stopped; a URL, the compute file and a budget are not secrets", async () => {
    const db = new Fake(NOW);
    const { calls, requests } = recordingRequests();
    const key = { env: ["METISTRY_DEVIN_API_KEY"], reachable: [], engine: false };
    const a = collector({ name: "devin-sessions", dir: "collectors/devin-sessions", requires: key });
    const b = collector({ name: "devin-knowledge", dir: "collectors/devin-knowledge", requires: key });
    const url = collector({ name: "ek", dir: "collectors/ek", requires: { env: [], reachable: ["METISTRY_EK_URL"], engine: false } });
    const fold = collector({ name: "knowledge-fold", dir: "routines/knowledge-fold", runKind: "routine_run", requires: { env: [], reachable: [], engine: true } });
    await tick(db, [a, b, url, fold], {}, opts({ requests }));
    expect(calls.secrets).toEqual([
      [
        {
          name: "METISTRY_DEVIN_API_KEY",
          why: "METISTRY_DEVIN_API_KEY is unset",
          stopped: ["devin-knowledge", "devin-sessions"],
          // its dependents (T4-23): what requires it by name — never the URL's component or the engine's
          dependents: [
            { component: "devin-knowledge", title: "devin-knowledge", kind: "collector" },
            { component: "devin-sessions", title: "devin-sessions", kind: "collector" },
          ],
        },
      ],
    ]);

    // the engine's own key is a secret like any other
    const compute = parseCompute(`
providers:
  openrouter:
    kind: openai-compatible
    base_url: https://openrouter.ai/api/v1
    locality: off_machine
    auth: { secret: METISTRY_OPENROUTER_API_KEY }
    data_policy: { allow: [Projects], deny_sources: [comms], max_brief_bytes: 65536 }
assignments:
  default: { model: openrouter/anthropic/claude-sonnet-5 }
`);
    const engine = recordingRequests();
    await tick(new Fake(NOW), [fold], {}, opts({ requests: engine.requests, compute: () => compute, budget: async () => ({ name: "budgets.stop", why: "stopped", fix: "raise it" }) }));
    expect(engine.calls.secrets.flat().map((f) => [f.name, f.stopped])).toEqual([["METISTRY_OPENROUTER_API_KEY", ["knowledge-fold"]]]);

    // the engine's secret names every component that requires the engine — whether or not its time came
    const planner = collector({ name: "plan-tomorrow", dir: "routines/plan-tomorrow", runKind: "routine_run", requires: { env: [], reachable: [], engine: true } });
    expect(secretDependents([fold, planner, a], "METISTRY_OPENROUTER_API_KEY", true).map((d) => d.component)).toEqual(["knowledge-fold", "plan-tomorrow"]);
    expect(secretDependents([fold, planner, a], "METISTRY_OPENROUTER_API_KEY", false)).toEqual([]);
    expect(secretDependents([fold, planner, a, b], "METISTRY_DEVIN_API_KEY", false).map((d) => [d.component, d.kind])).toEqual([["devin-knowledge", "collector"], ["devin-sessions", "collector"]]);
  });

  it("names a secret's dependents in one line a card shows", () => {
    const d = (component: string, kind: "routine" | "collector") => ({ component, title: component, kind });
    expect(dependentsSentence([])).toBe("");
    expect(dependentsSentence([d("Morning Brief", "routine")])).toBe("Morning Brief uses it");
    expect(dependentsSentence([d("GitHub", "collector"), d("Morning Brief", "routine")])).toBe("GitHub and Morning Brief use it");
    expect(dependentsSentence([d("a", "collector"), d("b", "routine"), d("c", "routine")])).toBe("2 routines and 1 sync use it");
    expect(dependentsSentence([d("a", "collector"), d("b", "collector"), d("c", "collector")])).toBe("3 syncs use it");
  });

  it("every tick asks whether a waiting secret is set again — against the install's environment", async () => {
    const { calls, requests } = recordingRequests();
    await tick(new Fake(NOW), [], {}, opts({ requests, env: { METISTRY_DEVIN_API_KEY: "cog_x", BLANK: "  " } }));
    const [isSet] = calls.restoredChecks;
    expect(isSet?.("METISTRY_DEVIN_API_KEY")).toBe(true);
    expect(isSet?.("BLANK")).toBe(false);
    expect(isSet?.("METISTRY_OTHER")).toBe(false);
    expect(calls.secrets).toEqual([]); // nothing missing, nothing raised
  });

  it("a queue that cannot be written never costs the tick: the run, its row and the alert still happen", async () => {
    const db = new Fake(NOW);
    const gone = async (): Promise<void> => { throw new Error("proposals is gone"); };
    const broken: RunnerRequests = {
      routineFailed: gone,
      routineSucceeded: gone,
      collectorSucceeded: gone,
      componentStopped: gone,
      secretsFailed: gone,
      secretsRestored: gone,
      budgetStopped: gone,
      budgetResumed: gone,
    };
    const failing = collector({ name: "morning-brief", dir: "routines/morning-brief", runKind: "routine_run", run: async () => { throw new Error("x"); } });
    await expect(tick(db, [failing], {}, opts({ requests: broken }))).resolves.toBeUndefined();
    expect(db.rowsFor("morning-brief")[0]).toMatchObject({ ok: false, error: "x" });
    expect(db.outbound).toHaveLength(1);
  });
});

describe("three strikes and a Stop limit (C135, C133, T3-12) — what the tick raises", () => {
  const FIVE = 5 * 60_000;
  const later = (db: Fake, windows: number, over: Record<string, unknown> = {}) => {
    db.now = new Date(NOW.getTime() + windows * FIVE);
    return opts({ now: db.now, ...over });
  };

  it("stops at the THIRD failure by default — no METISTRY_RUNNER_MAX_STREAK set", async () => {
    const db = new Fake(NOW);
    let ran = 0;
    const c = collector({ run: async () => { ran++; throw new Error("401 Bad credentials"); } });
    for (let w = 0; w < 5; w++) await tick(db, [c], {}, later(db, w));
    expect(ran).toBe(3); // the fourth and fifth windows cost nothing
    expect(db.rowsFor("t", "skipped_streak")).toHaveLength(2);
    expect(db.rowsFor("t", "skipped_streak")[0]?.error).toContain("METISTRY_RUNNER_MAX_STREAK = 3");
  });

  it("the failure that stops a component raises its stop, with the streak and the run", async () => {
    const db = new Fake(NOW);
    const { calls, requests } = recordingRequests();
    let n = 0;
    const c = collector({ name: "github-state", dir: "collectors/github-state", run: async () => { throw new Error(`401 Bad credentials (request ${++n})`); } });
    await tick(db, [c], {}, later(db, 0, { requests }));
    await tick(db, [c], {}, later(db, 1, { requests }));
    expect(calls.stopped).toEqual([]); // two strikes: not yet
    await tick(db, [c], {}, later(db, 2, { requests }));
    const runs = db.rowsFor("github-state").filter((r) => r.kind === "collector_run");
    expect(calls.stopped).toEqual([
      {
        component: "github-state",
        title: "github-state",
        runKind: "collector_run",
        failures: 3,
        limit: 3,
        since: runs[0]!.ts,
        error: "401 Bad credentials (request 3)",
        signature: errorSignature("github-state", "401 Bad credentials (request 3)"),
        runId: runs[2]!.id,
        stoppedAt: db.now,
      },
    ]);
  });

  it("a skipped window names the same stop again — the seam's dedupe makes it one request — and a routine's stop follows its failure report", async () => {
    const db = new Fake(NOW);
    const { calls, requests } = recordingRequests();
    const brief = collector({ name: "morning-brief", dir: "routines/morning-brief", runKind: "routine_run", run: async () => { throw new Error("vault bridge 503"); } });
    for (let w = 0; w < 4; w++) await tick(db, [brief], {}, later(db, w, { requests }));
    expect(calls.failed).toHaveLength(3); // each failure is handed on; the seam keeps one per signature
    expect(calls.stopped.map((s) => [s.failures, s.runId === null])).toEqual([
      [3, false], // the third failure
      [3, true], // the first skipped window: no run to name
    ]);
    const signature = errorSignature("morning-brief", "vault bridge 503");
    expect(new Set(calls.stopped.map((s) => s.signature))).toEqual(new Set([signature]));
    expect(calls.failed[2]?.signature).toBe(signature); // the same key the report was raised under
  });

  it("a Stop limit is ONE budget stop per window naming every routine it paused; a collector and a model-free routine are not paused", async () => {
    const db = new Fake(NOW);
    const { calls, requests } = recordingRequests();
    const compute = parseCompute(`
providers:
  openrouter:
    kind: openai-compatible
    base_url: https://openrouter.ai/api/v1
    locality: off_machine
    auth: { secret: METISTRY_OPENROUTER_API_KEY }
    data_policy: { allow: [Projects], deny_sources: [comms], max_brief_bytes: 65536 }
assignments:
  default: { model: openrouter/anthropic/claude-sonnet-5 }
`);
    const engine = { env: [], reachable: [], engine: true };
    const ran: string[] = [];
    const routine = (name: string, requires = engine) =>
      collector({ name, dir: `routines/${name}`, runKind: "routine_run", requires, run: async () => (ran.push(name), 1) });
    const hit = { scope: "instance", window: "monthly" as const, field: "budgets.instance.monthly_usd", limit: 60, spent: 61.2, fraction: 1.02, over: true, action: "stop" as const };
    let over = true;
    const budget = async () => (over ? { name: hit.field, why: "the instance monthly budget is spent", fix: "raise it", hit } : null);
    const all = [routine("knowledge-fold"), routine("morning-brief"), routine("update-check", NOTHING), collector({ run: async () => (ran.push("t"), 1) })];
    await tick(db, all, {}, opts({ requests, budget, compute: () => compute, env: { METISTRY_OPENROUTER_API_KEY: "sk-or-x" } }));

    expect(ran.sort()).toEqual(["t", "update-check"]); // paused: only the two that would enqueue a turn
    const key = budgetStopKey(hit, NOW);
    expect(key).toBe("instance:monthly:2026-09@60");
    expect(calls.budgets).toEqual([[{ key, hit, paused: ["knowledge-fold", "morning-brief"], at: NOW }]]);
    expect(calls.secrets).toEqual([]); // a budget is not a secret

    // every tick asks, while one waits, which budget stops routines NOW
    expect(await calls.resumed[0]!()).toBe(key);
    over = false;
    expect(await calls.resumed[0]!()).toBeNull();
    // a budget miss that cannot say which budget clears nothing
    const vague = recordingRequests();
    await tick(new Fake(NOW), [], {}, opts({ requests: vague.requests, budget: async () => ({ name: "budgets", why: "spend cannot be read", fix: "load it" }) }));
    expect(await vague.calls.resumed[0]!()).toBeUndefined();
    // no budget option at all: nothing to ask
    const none = recordingRequests();
    await tick(new Fake(NOW), [], {}, opts({ requests: none.requests }));
    expect(none.calls.resumed).toEqual([]);
  });

  it("a raised limit spent again is a new key; the next calendar window is too", () => {
    const hit = { scope: "provider:openrouter", window: "daily" as const, field: "budgets.providers.openrouter.daily_usd", limit: 5, spent: 5, fraction: 1, over: true, action: "stop" as const };
    expect(budgetStopKey(hit, NOW)).toBe("provider:openrouter:daily:2026-09-15@5");
    expect(budgetStopKey({ ...hit, limit: 8 }, NOW)).toBe("provider:openrouter:daily:2026-09-15@8");
    expect(budgetStopKey(hit, new Date("2026-09-16T00:00:01Z"))).toBe("provider:openrouter:daily:2026-09-16@5");
  });
});

// `routineCapabilities` is what `main.ts` spreads into `ComponentCtx`
// (`queries`, `vault`, `reader`) — this is the ctx builder itself, so a
// regression here is a routine silently losing the vault or its `TemplateReader`
// again, the exact bug this covers (the fold received `queries` but not
// `reader` until this was fixed).
describe("routineCapabilities", () => {
  const queries = { run: async () => ({ rows: [] }) };

  it("supplies queries alone when there is no vault bridge", () => {
    const ctx = routineCapabilities(queries);
    expect(ctx).toEqual({ queries });
    expect(ctx.vault).toBeUndefined();
    expect(ctx.reader).toBeUndefined();
  });

  it("supplies queries, the vault client, AND a reader built over it, when the vault bridge is up", async () => {
    const vault: PlanVault = {
      read: async (path) => (path === "Templates/Fold.md" ? { content: Buffer.from("skeleton text", "utf8"), sha256: "abc" } : null),
      write: async (path, content) => ({ path, sha256: "x", bytes: content.length, created: true }),
    };
    const ctx = routineCapabilities(queries, vault);

    expect(ctx.queries).toBe(queries);
    expect(ctx.vault).toBe(vault);
    // the reader is `vaultReader(vault)` — proven by behaviour, not by
    // reference, since it is a fresh closure over `vault` each call
    expect(await ctx.reader?.read("Templates/Fold.md")).toBe("skeleton text");
    expect(await ctx.reader?.read("Templates/Plan.md")).toBeNull();
  });
});

// T3-3: the resolved Scheduled config reaches the component's ctx — the
// owner's value from `routines.<name>.config` over the manifest's default, for
// every key the manifest declares — so `routines.standup.config` is no longer
// a line nothing reads.
describe("a routine's resolved config", () => {
  const unit = {
    name: "cfg",
    section: "routines" as const,
    displayName: "Configured",
    schedule: { every: "5m" as const },
    config: {
      template: { kind: "path" as const, label: "Template", default: "Templates/Standup.md" },
      skip_without_calendar_event: { kind: "boolean" as const, label: "Skip", default: false },
    },
    raise: {},
  };

  it("hands the owner's value over the default, key by key", async () => {
    const seen: unknown[] = [];
    const c = collector({ name: "cfg", runKind: "routine_run", unit, run: async (_db, ctx) => (seen.push((ctx as { config?: unknown }).config), 1) });
    const db = new Fake(NOW);
    await tick(db, [c], {}, opts({ scheduled: async () => ({ ok: true, value: { routines: { cfg: { config: { skip_without_calendar_event: true } } } } }) }));
    expect(seen).toEqual([{ template: "Templates/Standup.md", skip_without_calendar_event: true }]);
  });

  it("hands the defaults with no entry, and nothing to a component that declares no config", async () => {
    const seen: unknown[] = [];
    const record = async (_db: unknown, ctx: unknown) => (seen.push((ctx as { config?: unknown }).config), 1);
    await tick(new Fake(NOW), [collector({ name: "cfg", runKind: "routine_run", unit, run: record }), collector({ run: record })], {}, opts());
    expect(seen).toEqual([{ template: "Templates/Standup.md", skip_without_calendar_event: false }, undefined]);
  });
});
