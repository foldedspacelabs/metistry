// The runner against a tiny in-memory model of the two tables it touches
// (`runs`, `outbound_messages`), so the hardening behaviours are tested as
// behaviour rather than as SQL strings: a component that keeps failing stops
// being run, a blocked one never starts a run at all, each records exactly
// one row per window however often the runner ticks, and one fault costs one
// notification.
import { describe, expect, it } from "vitest";
import { errorSignature, parseCompute } from "@foldedspacelabs/metistry-core";
import type { PlanVault } from "@metistry-apps/routines";
import { routineCapabilities, scheduleToSeconds, tick, type RoutineFailure, type RunnerRequests, type ScheduledCollector, type SecretFailure } from "../src/runner.js";
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
    secrets: [] as SecretFailure[][],
    restoredChecks: [] as ((name: string) => boolean)[],
  };
  const requests: RunnerRequests = {
    routineFailed: async (f) => void calls.failed.push(f),
    routineSucceeded: async (c) => void calls.succeeded.push(c),
    secretsFailed: async (fs) => void calls.secrets.push([...fs]),
    secretsRestored: async (isSet) => void calls.restoredChecks.push(isSet),
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

  it("a routine that runs clears its reports; a collector's run asks nothing", async () => {
    const db = new Fake(NOW);
    const { calls, requests } = recordingRequests();
    const brief = collector({ name: "morning-brief", dir: "routines/morning-brief", runKind: "routine_run" });
    await tick(db, [brief, collector()], {}, opts({ requests }));
    expect(calls.succeeded).toEqual(["morning-brief"]);
    expect(calls.failed).toEqual([]);
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
    expect(calls.secrets).toEqual([[{ name: "METISTRY_DEVIN_API_KEY", why: "METISTRY_DEVIN_API_KEY is unset", stopped: ["devin-knowledge", "devin-sessions"] }]]);

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
    const broken: RunnerRequests = {
      routineFailed: async () => { throw new Error("proposals is gone"); },
      routineSucceeded: async () => { throw new Error("proposals is gone"); },
      secretsFailed: async () => { throw new Error("proposals is gone"); },
      secretsRestored: async () => { throw new Error("proposals is gone"); },
    };
    const failing = collector({ name: "morning-brief", dir: "routines/morning-brief", runKind: "routine_run", run: async () => { throw new Error("x"); } });
    await expect(tick(db, [failing], {}, opts({ requests: broken }))).resolves.toBeUndefined();
    expect(db.rowsFor("morning-brief")[0]).toMatchObject({ ok: false, error: "x" });
    expect(db.outbound).toHaveLength(1);
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
