// The keep-awake holder against fakes: no `caffeinate` is ever spawned here,
// no `pmset` is ever run, and the clock is ours — which is what lets the
// early-cutoff rule (a wall-clock jump while we were holding = the Mac slept
// under us) be tested without a Mac that sleeps.
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { KeepAwake, KeepAwakeState, PowerSource } from "@foldedspacelabs/metistry-core";
import { CAFFEINATE_BIN, CaffeinateHolder, KeepAwakeLoop, type HeldProcess } from "../src/power.js";

/** A `caffeinate` that never existed: it remembers what was done to it. */
class FakeHolderProcess extends EventEmitter implements HeldProcess {
  static n = 0;
  pid = 5000 + FakeHolderProcess.n++;
  signals: string[] = [];
  kill(signal?: NodeJS.Signals): boolean {
    this.signals.push(signal ?? "SIGTERM");
    this.exit(0, signal ?? null);
    return true;
  }
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit("exit", code, signal);
  }
}

function holderWithFake(watchPid = 9007) {
  const spawned: FakeHolderProcess[] = [];
  const argvs: string[][] = [];
  const log: string[] = [];
  const holder = new CaffeinateHolder(watchPid, {
    spawn: (argv) => {
      argvs.push(argv);
      const c = new FakeHolderProcess();
      spawned.push(c);
      return c;
    },
    log: (l) => log.push(l),
  });
  return { holder, spawned, argvs, log };
}

describe("the caffeinate holder", () => {
  it("holds the idle-sleep assertion and nothing else, watching the supervisor's pid", async () => {
    const { holder, argvs } = holderWithFake(9007);
    await holder.hold("Athena is running");
    expect(argvs).toEqual([[CAFFEINATE_BIN, "-i", "-w", "9007"]]);
    // never -d (that pins the display the user did not ask us to pin) and
    // never -s (deprecated, and AC-only)
    expect(argvs[0]).not.toContain("-d");
    expect(argvs[0]).not.toContain("-s");
  });

  it("hold is idempotent — a second hold refreshes the reason and spawns nothing", async () => {
    const { holder, spawned } = holderWithFake();
    await holder.hold("one");
    await holder.hold("two");
    expect(spawned).toHaveLength(1);
    expect(holder.status().reason).toBe("two");
    expect(holder.status().holding).toBe(true);
    expect(holder.status().pid).toBe(spawned[0]!.pid);
  });

  it("release kills the child, and releasing twice is safe", async () => {
    const { holder, spawned } = holderWithFake();
    await holder.hold("x");
    await holder.release();
    expect(spawned[0]!.signals).toEqual(["SIGTERM"]);
    expect(holder.status()).toMatchObject({ holding: false, restarts: 0 });
    await holder.release();
    expect(spawned).toHaveLength(1);
  });

  it("a child that dies on its own is replaced, and the restarts are counted", async () => {
    const { holder, spawned, log } = holderWithFake();
    await holder.hold("x");
    spawned[0]!.exit(1, null);
    expect(holder.status().holding).toBe(false);
    expect(holder.status().restarts).toBe(1);
    expect(log.join("\n")).toContain("restarting in");
    // the backoff is the supervisor's own; wait it out
    await new Promise((r) => setTimeout(r, 1_100));
    expect(spawned).toHaveLength(2);
    expect(holder.status()).toMatchObject({ holding: true, restarts: 1 });
    await holder.release();
  });

  it("a child that dies AFTER we released is not replaced", async () => {
    const { holder, spawned } = holderWithFake();
    await holder.hold("x");
    await holder.release();
    await new Promise((r) => setTimeout(r, 1_100));
    expect(spawned).toHaveLength(1);
    expect(holder.status().restarts).toBe(0);
  });
});

// ---- the loop --------------------------------------------------------------

function loopWith(setting: KeepAwake, opts: { source?: PowerSource; previous?: KeepAwakeState | undefined; intervalMs?: number } = {}) {
  let source: PowerSource = opts.source ?? "ac";
  let now = Date.UTC(2026, 8, 19, 12, 0, 0);
  const written: KeepAwakeState[] = [];
  const log: string[] = [];
  const spawned: FakeHolderProcess[] = [];
  const holder = new CaffeinateHolder(9007, {
    spawn: () => {
      const c = new FakeHolderProcess();
      spawned.push(c);
      return c;
    },
    now: () => now,
    log: (l) => log.push(l),
  });
  const loop = new KeepAwakeLoop(
    {
      setting,
      supervisorPid: 9007,
      reason: "Athena is running",
      statePath: "/nowhere/keep-awake.json",
      intervalMs: opts.intervalMs ?? 60_000,
    },
    {
      holder,
      power: async () => source,
      now: () => now,
      log: (l) => log.push(l),
      writeState: async (_path, state) => {
        written.push(state);
      },
      readState: async () => opts.previous,
    },
  );
  return {
    loop,
    spawned,
    log,
    written,
    last: () => written.at(-1)!,
    setSource: (s: PowerSource) => {
      source = s;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("the loop's state machine", () => {
  it("allow_sleep_on_battery holds on wall power and releases on battery, both ways round", async () => {
    const t = loopWith("allow_sleep_on_battery", { source: "ac" });
    await t.loop.tick();
    expect(t.last()).toMatchObject({ holding: true, power_source: "ac", mode: "allow_sleep_on_battery" });
    t.setSource("battery");
    t.advance(60_000);
    await t.loop.tick();
    expect(t.last()).toMatchObject({ holding: false, power_source: "battery" });
    expect(t.last().pid).toBeUndefined();
    t.setSource("ac");
    t.advance(60_000);
    await t.loop.tick();
    expect(t.last().holding).toBe(true);
    expect(t.log.join("\n")).toContain("released on purpose");
  });

  it("a UPS is a battery, and `always` holds on both", async () => {
    const onUps = loopWith("allow_sleep_on_battery", { source: "ups" });
    await onUps.loop.tick();
    expect(onUps.last().holding).toBe(false);
    for (const source of ["battery", "ups"] as const) {
      const t = loopWith("always", { source });
      await t.loop.tick();
      expect(t.last()).toMatchObject({ holding: true, power_source: source });
    }
  });

  it("always_lid_closed behaves exactly as always — the lid half is not ours to give", async () => {
    const t = loopWith("always_lid_closed", { source: "battery" });
    await t.loop.tick();
    expect(t.last()).toMatchObject({ holding: true, mode: "always_lid_closed" });
  });

  it("writes the facts doctor reports: our pid, since, the reason, the supervisor's pid, a heartbeat", async () => {
    const t = loopWith("always");
    const state = await t.loop.tick();
    expect(state).toMatchObject({
      schema: 1,
      holding: true,
      pid: t.spawned[0]!.pid,
      supervisor_pid: 9007,
      reason: "Athena is running",
      interval_ms: 60_000,
      restarts: 0,
    });
    expect(state.since).toBe("2026-09-19T12:00:00.000Z");
    expect(state.heartbeat_at).toBe("2026-09-19T12:00:00.000Z");
    t.advance(60_000);
    expect((await t.loop.tick()).heartbeat_at).toBe("2026-09-19T12:01:00.000Z");
  });

  it("a clean stop releases and says so, so the gap after it is never read as a sleep", async () => {
    const t = loopWith("always");
    await t.loop.tick();
    await t.loop.stop();
    expect(t.last()).toMatchObject({ holding: false, stopped_at: "2026-09-19T12:00:00.000Z" });
    expect(t.spawned[0]!.signals).toEqual(["SIGTERM"]);
  });

  it("never starts nothing: the loop is not even constructed for it, but a tick would hold nothing", async () => {
    const t = loopWith("never");
    const state = await t.loop.tick();
    expect(state.holding).toBe(false);
    expect(t.spawned).toHaveLength(0);
  });
});

describe("the early cutoff (ruling E)", () => {
  it("a wall-clock jump while holding is recorded with the policy that was live at the time", async () => {
    const t = loopWith("always");
    await t.loop.tick();
    // the Mac slept for 41 minutes: the next tick is 41 minutes late
    t.advance(2_460_000);
    const state = await t.loop.tick();
    expect(state.last_cutoff).toEqual({
      at: "2026-09-19T12:41:00.000Z",
      from: "2026-09-19T12:00:00.000Z",
      gap_ms: 2_460_000,
      mode: "always",
      power_source: "ac",
    });
    expect(t.log.join("\n")).toContain("slept for about 41m");
  });

  it("an ordinary late tick is not a cutoff — one slow minute is not a sleep", async () => {
    const t = loopWith("always");
    await t.loop.tick();
    t.advance(120_000); // two intervals: late, not asleep
    expect((await t.loop.tick()).last_cutoff).toBeUndefined();
  });

  it("a gap while we were deliberately NOT holding is the setting working, not a cutoff", async () => {
    const t = loopWith("allow_sleep_on_battery", { source: "battery" });
    await t.loop.tick();
    t.advance(2_460_000);
    expect((await t.loop.tick()).last_cutoff).toBeUndefined();
  });

  it("start() carries a previous run's cutoff forward, and drops it once the setting has changed", async () => {
    const cutoff = { at: "2026-09-18T02:00:00.000Z", from: "2026-09-18T01:00:00.000Z", gap_ms: 3_600_000, mode: "always" as const, power_source: "ac" as const };
    const previous: KeepAwakeState = {
      schema: 1,
      mode: "always",
      holding: false,
      power_source: "ac",
      reason: "Athena is running",
      supervisor_pid: 1,
      heartbeat_at: "2026-09-18T02:00:00.000Z",
      interval_ms: 60_000,
      restarts: 0,
      last_cutoff: cutoff,
    };
    const same = loopWith("always", { previous });
    expect((await same.loop.start()).last_cutoff).toEqual(cutoff);
    await same.loop.stop();
    // the user answered the question differently: the finding was about the
    // policy they replaced, and is not theirs to be shown any more
    const changed = loopWith("allow_sleep_on_battery", { previous });
    expect((await changed.loop.start()).last_cutoff).toBeUndefined();
    await changed.loop.stop();
  });
});
