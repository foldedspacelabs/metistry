// The runner against a tiny in-memory model of the two tables it touches
// (`runs`, `outbound_messages`), so the hardening behaviours are tested as
// behaviour rather than as SQL strings: a component that keeps failing stops
// being run, a blocked one never starts a run at all, each records exactly
// one row per window however often the runner ticks, and one fault costs one
// notification.
import { describe, expect, it } from "vitest";
import { errorSignature } from "@foldedspacelabs/metistry-core";
import { scheduleToSeconds, tick, type ScheduledCollector } from "../src/runner.js";

interface RunRow {
  id: number;
  component: string;
  kind: string;
  tool: string | null;
  ts: Date;
  ok: boolean | null;
  error: string | null;
}

/** Enough of Postgres to answer the runner's five queries, and nothing more. */
class Fake {
  runs: RunRow[] = [];
  outbound: { ts: Date; kind: string; text: string }[] = [];
  constructor(public now: Date) {}

  seed(rows: { component: string; kind: string; tool?: string; minutesAgo: number; ok: boolean | null; error?: string }[]): this {
    for (const r of rows) {
      this.runs.push({
        id: this.runs.length + 1,
        component: r.component,
        kind: r.kind,
        tool: r.tool ?? null,
        ts: new Date(this.now.getTime() - r.minutesAgo * 60_000),
        ok: r.ok,
        error: r.error ?? null,
      });
    }
    return this;
  }

  rowsFor(component: string, tool?: string): RunRow[] {
    return this.runs.filter((r) => r.component === component && (tool === undefined || r.tool === tool));
  }

  async query(text: string, values: unknown[] = []): Promise<{ rows: any[] }> {
    if (text.includes("max(ts) FILTER")) {
      const [component, runKind, runnerKind, skipTool, preTool] = values as string[];
      const max = (pick: (r: RunRow) => boolean) => {
        const hits = this.runs.filter((r) => r.component === component && pick(r));
        return hits.length === 0 ? null : new Date(Math.max(...hits.map((r) => r.ts.getTime())));
      };
      return {
        rows: [
          {
            last_run: max((r) => r.kind === runKind),
            last_skip: max((r) => r.kind === runnerKind && r.tool === skipTool),
            last_preflight: max((r) => r.kind === runnerKind && r.tool === preTool),
          },
        ],
      };
    }
    if (text.includes("last_ok")) {
      const kinds = (values[0] as string[]) ?? [];
      const keys = [...new Set(this.runs.filter((r) => kinds.includes(r.kind)).map((r) => `${r.component} ${r.kind}`))];
      return {
        rows: keys.flatMap((key) => {
          const [component, kind] = key.split(" ") as [string, string];
          const mine = this.runs.filter((r) => r.component === component && r.kind === kind).sort((a, b) => a.ts.getTime() - b.ts.getTime());
          const lastOk = [...mine].reverse().find((r) => r.ok === true);
          const open = mine.filter((r) => r.ok === false && (!lastOk || r.ts > lastOk.ts));
          if (open.length === 0) return [];
          return [{ component, kind, n: String(open.length), since: open[0]!.ts, last_error: open[open.length - 1]!.error }];
        }),
      };
    }
    if (text.startsWith("INSERT INTO runs")) {
      const [component, kind, , tool] = values as (string | null)[];
      const row: RunRow = { id: this.runs.length + 1, component: component!, kind: kind!, tool: tool ?? null, ts: this.now, ok: null, error: null };
      this.runs.push(row);
      return { rows: [{ id: row.id }] };
    }
    if (text.startsWith("UPDATE runs")) {
      const [id, ok, error] = values as [number, boolean, string | null];
      const row = this.runs.find((r) => r.id === id)!;
      row.ok = ok;
      row.error = error;
      return { rows: [] };
    }
    if (text.includes("FROM outbound_messages")) {
      const tag = values[0] as string;
      const hits = this.outbound.filter((o) => o.kind === "alert" && o.text.includes(tag));
      return { rows: [{ ts: hits.length === 0 ? null : new Date(Math.max(...hits.map((o) => o.ts.getTime()))) }] };
    }
    if (text.startsWith("INSERT INTO outbound_messages")) {
      this.outbound.push({ ts: this.now, kind: "alert", text: String(values[0]) });
      return { rows: [] };
    }
    throw new Error(`unexpected query: ${text}`);
  }
}

const NOW = new Date("2026-09-15T12:00:00Z");
const NOTHING = { env: [], reachable: [], engine: false };

function collector(over: Partial<ScheduledCollector> = {}): ScheduledCollector {
  return {
    name: "t",
    dir: "collectors/t",
    intervalSec: 300,
    runKind: "collector_run",
    requires: NOTHING,
    run: async () => 1,
    ...over,
  };
}

const fetchNever = (async () => {
  throw new Error("no network in these tests");
}) as unknown as typeof fetch;

const opts = (over: Record<string, unknown> = {}) => ({ now: NOW, env: {}, fetchFn: fetchNever, ...over });

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

    const failing = collector({ name: "f", dir: "collectors/f", intervalSec: 1, run: async () => { throw new Error("x"); } });
    await expect(tick(db, [failing], {}, opts())).resolves.toBeUndefined(); // failure recorded, never thrown
    expect(db.rowsFor("f")[0]).toMatchObject({ ok: false, error: "x" });
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
    const c = collector({ intervalSec: 0, run: async () => { throw new Error(message); } }); // due on every tick
    await tick(db, [c], {}, opts({ alertDedupeHours: 24 }));
    await tick(db, [c], {}, opts({ alertDedupeHours: 24 }));
    await tick(db, [c], {}, opts({ alertDedupeHours: 24 }));
    expect(db.rowsFor("t").filter((r) => r.kind === "collector_run")).toHaveLength(3); // every failure is still recorded
    expect(db.outbound).toHaveLength(1); // but you are told once

    message = "403 rate limit exceeded";
    await tick(db, [c], {}, opts({ alertDedupeHours: 24 }));
    expect(db.outbound).toHaveLength(2); // a different signature is news
  });

  it("stops running a component after METISTRY_RUNNER_MAX_STREAK failures, one row per window", async () => {
    const db = new Fake(NOW).seed(
      [10, 9, 8, 7, 6].map((minutesAgo) => ({ component: "t", kind: "collector_run", minutesAgo, ok: false, error: "401 Bad credentials" })),
    );
    let ran = 0;
    const c = collector({ intervalSec: 300, run: async () => (ran++, 1) });

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
    await tick(db, [c], {}, { now: new Date(NOW.getTime() + 6 * 60_000), env: {}, fetchFn: fetchNever, maxStreak: 5 });
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
    await tick(db, [fold], {}, opts());
    expect(ran).toBe(0);
    expect(db.rowsFor("knowledge-fold", "preflight_failed")[0]?.error).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    await tick(db, [fold], {}, opts({ env: { CLAUDE_CODE_OAUTH_TOKEN: "tok" } }));
    expect(ran).toBe(1);
  });
});
