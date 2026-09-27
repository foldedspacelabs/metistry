// The scheduler (T3-1, design-build-plan §2.5): the runner reads each
// manifest's schedule ⊕ `.metistry/scheduled.yaml` on every tick and runs what
// is due — an interval once it has passed, a time of day once, at its slot.
//
// Every case drives `tick` with a clock, one tick a minute, against the
// in-memory `runs` table (runs-fake.ts) — so "fires once, at its time" is an
// assertion about the minutes a routine actually ran, across a whole week,
// both daylight-saving nights, a timezone change and a Mac that slept.
//
// 2026-09-20 is a Sunday; New York is on EDT (UTC−4) until 1 November.
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkScheduled, type ManifestSchedule, type ProfileFacts, type Weekday } from "@foldedspacelabs/metistry-core";
import { loadCollectors } from "@metistry-apps/collectors";
import { loadRoutines } from "@metistry-apps/routines";
import {
  effectiveSchedule,
  loadSchedules,
  profileFacts,
  readOverlay,
  tick,
  type ComponentCtx,
  type OverlayRead,
  type RunnerOptions,
  type ScheduledCollector,
} from "../src/runner.js";
import { FakeRuns } from "./runs-fake.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const NY = "America/New_York";
const MON_FRI: Weekday[] = ["mon", "tue", "wed", "thu", "fri"];
const EVERY_DAY: Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const PROFILE: ProfileFacts = { timezone: NY, working_days: MON_FRI };
const NOTHING = { env: [], reachable: [], engine: false };
/** plan-tomorrow declares these in `requires.env`; set, so preflight passes and the schedule is what is tested */
const ENV = { METISTRY_RECONCILER_URL: "http://127.0.0.1:9", METISTRY_BRIDGE_TOKEN_RECONCILER: "t" };
const MINUTE = 60_000;

const fetchNever = (async () => {
  throw new Error("no network in these tests");
}) as unknown as typeof fetch;

/** `2026-09-21 07:00` — a wall clock, in a zone. */
const local = (d: Date | string, tz = NY): string =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(
    typeof d === "string" ? new Date(d) : d,
  );

interface Fired {
  at: string;
  scheduledFor: string | undefined;
  timeZone: string | undefined;
}

/** A component that records the wall-clock minute it ran at, and the slot and zone it was handed. */
function recorder(db: FakeRuns, fired: Record<string, Fired[]>, name: string) {
  return async (_db: unknown, ctx?: ComponentCtx): Promise<number> => {
    (fired[name] ??= []).push({ at: db.now.toISOString(), scheduledFor: ctx?.scheduledFor?.toISOString(), timeZone: ctx?.timeZone });
    return 0;
  };
}

function routine(db: FakeRuns, fired: Record<string, Fired[]>, name: string, schedule: ManifestSchedule, over: Partial<ScheduledCollector> = {}): ScheduledCollector {
  return { name, dir: `routines/${name}`, schedule, runKind: "routine_run", requires: NOTHING, run: recorder(db, fired, name), ...over };
}

interface Clock extends Omit<RunnerOptions, "now"> {
  from: string;
  to: string;
  /** half-open (from, to) windows with no tick at all: the Mac asleep */
  asleep?: [string, string][];
  /** the profile as it stands at a moment — a timezone that changes mid-week */
  profileAt?: (now: Date) => ProfileFacts;
}

/** One tick a minute from `from` to `to`, inclusive, skipping the minutes the Mac slept. */
async function runClock(db: FakeRuns, components: ScheduledCollector[], c: Clock): Promise<void> {
  const { from, to, asleep = [], profileAt, ...options } = c;
  const sleeps = asleep.map(([a, b]) => [Date.parse(a), Date.parse(b)] as const);
  for (let t = Date.parse(from); t <= Date.parse(to); t += MINUTE) {
    if (sleeps.some(([a, b]) => t > a && t < b)) continue;
    db.now = new Date(t);
    const now = db.now;
    await tick(db, components, {}, {
      env: ENV,
      fetchFn: fetchNever,
      timeZone: null,
      startedAt: new Date(Date.parse(from)),
      profile: async () => (profileAt ? profileAt(now) : PROFILE),
      ...options,
      now,
    });
  }
}

const ats = (fired: Fired[] | undefined): string[] => (fired ?? []).map((f) => local(f.at));

// ---------------------------------------------------------------- the accept

describe("the default schedules fire once, at their time (T3-1's acceptance)", () => {
  it("a week of ticks, one a minute: every shipped routine runs at its §2.5 default, once per slot, and never otherwise", async () => {
    const db = new FakeRuns(new Date("2026-09-20T04:00:00Z"));
    const fired: Record<string, Fired[]> = {};
    // the shipped routines as the registry loads them (plan §2.7), each run swapped for a recorder
    const { routines, skipped } = await loadRoutines({ home: `${root}routines` });
    expect(skipped).toEqual([]);
    const loaded = await loadSchedules(routines.map((u) => ({ ...u, run: recorder(db, fired, u.name) })));
    expect(loaded.map((r) => r.name).sort()).toEqual(["knowledge-fold", "morning-brief", "plan-tomorrow", "reply-review", "session-purge", "standup", "update-check", "weekly-review"]);

    // Sunday 00:00 to Saturday 23:59, New York
    await runClock(db, loaded, { from: "2026-09-20T04:00:00Z", to: "2026-09-27T03:59:00Z" });

    const weekdays = ["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25"];
    const everyDay = ["2026-09-20", ...weekdays, "2026-09-26"];
    expect(ats(fired["morning-brief"])).toEqual(weekdays.map((d) => `${d} 07:00`));
    expect(ats(fired["standup"])).toEqual(weekdays.map((d) => `${d} 08:00`)); // T3-5: an hour after the brief
    expect(ats(fired["knowledge-fold"])).toEqual(everyDay.map((d) => `${d} 21:00`));
    // Sunday to Thursday evenings plan Monday to Friday; Friday and Saturday are skipped
    expect(ats(fired["plan-tomorrow"])).toEqual(["2026-09-20", "2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24"].map((d) => `${d} 23:00`));
    expect(ats(fired["reply-review"])).toEqual(everyDay.map((d) => `${d} 23:00`));
    expect(ats(fired["weekly-review"])).toEqual(["2026-09-20 18:00"]);
    expect(ats(fired["session-purge"])).toEqual(everyDay.map((d) => `${d} 04:00`)); // T3-9: the session archive's retention
    // §2.20's Update Check (T2-18): every day at 06:00, in the profile's zone
    expect(ats(fired["update-check"])).toEqual(everyDay.map((d) => `${d} 06:00`));

    // each run is handed its slot and zone, and its row carries the slot
    for (const f of Object.values(fired).flat()) expect(f).toMatchObject({ scheduledFor: f.at, timeZone: NY });
    const rows = db.runs.filter((r) => r.kind === "routine_run");
    expect(rows).toHaveLength(5 + 5 + 7 + 5 + 7 + 1 + 7 + 7);
    for (const r of rows) expect(r.meta).toMatchObject({ scheduled_for: r.ts.toISOString(), time_zone: NY, outcome: "silent" });
  }, 60_000); // ten thousand ticks: ~3 s alone, more beside every other suite
});

// ---------------------------------------------------------- daylight saving

describe("daylight saving, through the runner", () => {
  it("spring forward: a 02:30 slot runs once, at 03:30 EDT on the night 02:00–03:00 does not exist", async () => {
    const db = new FakeRuns(new Date("2026-03-07T12:00:00Z"));
    const fired: Record<string, Fired[]> = {};
    const c = routine(db, fired, "night-owl", { days: EVERY_DAY, at: ["02:30"] });
    await runClock(db, [c], { from: "2026-03-07T12:00:00Z", to: "2026-03-09T12:00:00Z" });
    expect((fired["night-owl"] ?? []).map((f) => f.at)).toEqual(["2026-03-08T07:30:00.000Z", "2026-03-09T06:30:00.000Z"]);
    expect(ats(fired["night-owl"])).toEqual(["2026-03-08 03:30", "2026-03-09 02:30"]);
  });

  it("fall back: a 01:30 slot runs once, at the first 01:30, on the night 01:00–02:00 happens twice", async () => {
    const db = new FakeRuns(new Date("2026-10-31T12:00:00Z"));
    const fired: Record<string, Fired[]> = {};
    const c = routine(db, fired, "night-owl", { days: EVERY_DAY, at: ["01:30"] });
    await runClock(db, [c], { from: "2026-10-31T12:00:00Z", to: "2026-11-02T12:00:00Z" });
    // 05:30Z is 01:30 EDT; 06:30Z on the 1st (01:30 EST) must NOT fire; 06:30Z on the 2nd is the next night
    expect((fired["night-owl"] ?? []).map((f) => f.at)).toEqual(["2026-11-01T05:30:00.000Z", "2026-11-02T06:30:00.000Z"]);
  });

  it("an 08:00 slot stays 08:00 on the wall across both changes", async () => {
    const db = new FakeRuns(new Date("2026-03-07T00:00:00Z"));
    const fired: Record<string, Fired[]> = {};
    const c = routine(db, fired, "standup", { days: EVERY_DAY, at: ["08:00"] });
    await runClock(db, [c], { from: "2026-03-07T00:00:00Z", to: "2026-03-09T23:59:00Z" });
    expect((fired.standup ?? []).map((f) => f.at)).toEqual(["2026-03-07T13:00:00.000Z", "2026-03-08T12:00:00.000Z", "2026-03-09T12:00:00.000Z"]);
  });
});

// ------------------------------------------------------------ the timezone

describe("a timezone change", () => {
  it("Me/profile.md's timezone moves from New York to London mid-week: the next slot is London's 08:00, and none fires twice", async () => {
    const db = new FakeRuns(new Date("2026-09-21T04:00:00Z"));
    const fired: Record<string, Fired[]> = {};
    const c = routine(db, fired, "standup", { days: EVERY_DAY, at: ["08:00"] });
    const moved = Date.parse("2026-09-21T20:00:00Z"); // Monday evening, after New York's standup
    await runClock(db, [c], {
      from: "2026-09-21T04:00:00Z",
      to: "2026-09-23T12:00:00Z",
      profileAt: (now) => ({ ...PROFILE, timezone: now.getTime() < moved ? NY : "Europe/London" }),
    });
    expect((fired.standup ?? []).map((f) => [f.at, f.timeZone])).toEqual([
      ["2026-09-21T12:00:00.000Z", NY], // Mon 08:00 New York
      ["2026-09-22T07:00:00.000Z", "Europe/London"], // Tue 08:00 London (BST)
      ["2026-09-23T07:00:00.000Z", "Europe/London"],
    ]);
  });

  it("a schedule's own tz wins over the profile's, and METISTRY_TZ is the fallback — never UTC", async () => {
    const db = new FakeRuns(new Date("2026-09-21T00:00:00Z"));
    const fired: Record<string, Fired[]> = {};
    const tokyo = routine(db, fired, "tokyo", { days: EVERY_DAY, at: ["08:00"], tz: "Asia/Tokyo" });
    const fallback = routine(db, fired, "fallback", { days: EVERY_DAY, at: ["08:00"] });
    await runClock(db, [tokyo, fallback], { from: "2026-09-21T00:00:00Z", to: "2026-09-21T23:59:00Z", profileAt: () => ({ working_days: MON_FRI }), timeZone: "Europe/Paris" });
    expect((fired.tokyo ?? []).map((f) => f.at)).toEqual(["2026-09-21T23:00:00.000Z"]); // 08:00 JST on the 22nd
    expect((fired.fallback ?? []).map((f) => [f.at, f.timeZone])).toEqual([["2026-09-21T06:00:00.000Z", "Europe/Paris"]]);
  });
});

// ------------------------------------------------------- the Mac that slept

describe("a missed tick while the Mac slept", () => {
  it("asleep through the 21:00 fold: it runs ONCE on waking, for the 21:00 slot, and not again that night", async () => {
    const db = new FakeRuns(new Date("2026-09-21T04:00:00Z")).seed([
      // Sunday's fold ran at its slot
      { component: "knowledge-fold", kind: "routine_run", minutesAgo: 3 * 60, ok: true, meta: { scheduled_for: "2026-09-21T01:00:00.000Z" } },
    ]);
    const fired: Record<string, Fired[]> = {};
    const fold = routine(db, fired, "knowledge-fold", { days: EVERY_DAY, at: ["21:00"] });
    await runClock(db, [fold], {
      from: "2026-09-21T04:00:00Z", // Mon 00:00 EDT
      to: "2026-09-22T03:59:00Z", // Mon 23:59 EDT
      asleep: [["2026-09-22T00:30:00Z", "2026-09-22T02:15:00Z"]], // lid shut 20:30–22:15
    });
    expect(fired["knowledge-fold"]).toEqual([{ at: "2026-09-22T02:15:00.000Z", scheduledFor: "2026-09-22T01:00:00.000Z", timeZone: NY }]);
    expect(ats(fired["knowledge-fold"])).toEqual(["2026-09-21 22:15"]);
  });

  it("asleep for three nights: ONE run on waking, for the latest slot — never three", async () => {
    const db = new FakeRuns(new Date("2026-09-22T01:00:00Z")).seed([
      { component: "knowledge-fold", kind: "routine_run", minutesAgo: 0, ok: true, meta: { scheduled_for: "2026-09-22T01:00:00.000Z" } }, // Mon 21:00
    ]);
    const fired: Record<string, Fired[]> = {};
    const fold = routine(db, fired, "knowledge-fold", { days: EVERY_DAY, at: ["21:00"] });
    await runClock(db, [fold], {
      from: "2026-09-22T01:01:00Z",
      to: "2026-09-25T12:10:00Z", // Fri 08:10
      asleep: [["2026-09-22T01:30:00Z", "2026-09-25T12:00:00Z"]], // Mon 21:30 → Fri 08:00
    });
    expect(fired["knowledge-fold"]).toEqual([{ at: "2026-09-25T12:00:00.000Z", scheduledFor: "2026-09-25T01:00:00.000Z", timeZone: NY }]); // Thu 21:00
  });

  it("the plan it owes on waking is for the day after its latest slot", async () => {
    const db = new FakeRuns(new Date("2026-09-25T03:00:00Z")).seed([
      { component: "plan-tomorrow", kind: "routine_run", minutesAgo: 0, ok: true, meta: { scheduled_for: "2026-09-25T03:00:00.000Z" } }, // Thu 23:00
    ]);
    const fired: Record<string, Fired[]> = {};
    const plan = routine(db, fired, "plan-tomorrow", { days: "eve_of_working_days", at: ["23:00"] });
    await runClock(db, [plan], {
      from: "2026-09-25T03:01:00Z",
      to: "2026-09-28T11:40:00Z",
      asleep: [["2026-09-25T04:00:00Z", "2026-09-28T11:30:00Z"]], // Fri 00:00 → Mon 07:30: the weekend
    });
    // one run, at 07:30 Monday, for Sunday 23:00 — the eve of Monday
    expect(fired["plan-tomorrow"]).toEqual([{ at: "2026-09-28T11:30:00.000Z", scheduledFor: "2026-09-28T03:00:00.000Z", timeZone: NY }]);
  });

  it("a Postgres clock that drifted behind while the Mac slept cannot make a slot fire twice", async () => {
    const db = new FakeRuns(new Date("2026-09-21T04:00:00Z"));
    db.skewMs = 5_000; // every row is stamped 5 s before the slot it ran for
    const fired: Record<string, Fired[]> = {};
    const c = routine(db, fired, "standup", { days: EVERY_DAY, at: ["08:00"] });
    await runClock(db, [c], { from: "2026-09-21T11:55:00Z", to: "2026-09-21T12:10:00Z", startedAt: new Date("2026-09-21T04:00:00Z") });
    expect(ats(fired.standup)).toEqual(["2026-09-21 08:00"]);
  });
});

// ------------------------------------------------------ never run, and refused

describe("a component that has never run, and one the runner cannot place", () => {
  it("never run: its slots count from when the runner started — a 10:00 start does not fire the 07:00 brief at 10:01", async () => {
    const db = new FakeRuns(new Date("2026-09-21T14:00:00Z"));
    const fired: Record<string, Fired[]> = {};
    const brief = routine(db, fired, "morning-brief", { days: "working_days", at: ["07:00"] });
    await runClock(db, [brief], { from: "2026-09-21T14:00:00Z", to: "2026-09-22T12:00:00Z" }); // Mon 10:00 → Tue 08:00
    expect(ats(fired["morning-brief"])).toEqual(["2026-09-22 07:00"]);
  });

  it("no working days in Me/profile.md: not run, and says so once a day as `skipped:no_working_days` — nothing guessed", async () => {
    const db = new FakeRuns(new Date("2026-09-21T04:00:00Z"));
    const fired: Record<string, Fired[]> = {};
    const brief = routine(db, fired, "morning-brief", { days: "working_days", at: ["07:00"] });
    await runClock(db, [brief], { from: "2026-09-21T04:00:00Z", to: "2026-09-22T12:00:00Z", profileAt: () => ({ timezone: NY }) });
    expect(fired["morning-brief"]).toBeUndefined();
    const rows = db.rowsFor("morning-brief");
    expect(rows.map((r) => r.ts.toISOString())).toEqual(["2026-09-21T04:00:00.000Z", "2026-09-22T04:00:00.000Z"]); // once a day
    expect(rows[0]).toMatchObject({ kind: "routine_run", ok: true, meta: { schedule_refused: "no_working_days", outcome: "skipped:no_working_days" } });
    expect(String(rows[0]?.meta.why)).toContain("Me/profile.md");
    expect(db.outbound).toHaveLength(0); // a fact about the profile, not a fault
  });

  // T3-5's test, through the runner: the SHIPPED Standup routine, as the
  // registry loads it, is never started on a profile that does not say which
  // days you work — so nothing can be written — and says so once a day. The
  // routine asks the same question itself for a run nobody scheduled
  // (routines/standup/standup.test.ts).
  it("the Standup routine without working days: a whole week, never run, nothing written — `skipped:no_working_days` once a day", async () => {
    const db = new FakeRuns(new Date("2026-09-20T04:00:00Z"));
    const { routines } = await loadRoutines({ home: `${root}routines` });
    let started = 0;
    const [standup] = await loadSchedules(routines.filter((u) => u.name === "standup").map((u) => ({ ...u, run: async () => ++started })));
    expect(standup?.schedule).toEqual({ days: "working_days", at: ["08:00"] });
    await runClock(db, [standup!], { from: "2026-09-20T04:00:00Z", to: "2026-09-27T03:59:00Z", profileAt: () => ({ timezone: NY }) });
    expect(started).toBe(0);
    const rows = db.rowsFor("standup");
    expect(rows).toHaveLength(7); // once a day, never once a tick
    for (const r of rows) expect(r).toMatchObject({ kind: "routine_run", ok: true, meta: { schedule_refused: "no_working_days", outcome: "skipped:no_working_days" } });
    expect(db.outbound).toHaveLength(0);

    // …and the Monday the profile says Monday to Friday, it runs at 08:00
    await runClock(db, [standup!], { from: "2026-09-28T04:00:00Z", to: "2026-09-28T13:00:00Z", profileAt: () => PROFILE });
    expect(started).toBe(1);
  }, 60_000);

  it("no timezone anywhere: refused `no_timezone`, never run in UTC", async () => {
    const db = new FakeRuns(new Date("2026-09-21T04:00:00Z"));
    const fired: Record<string, Fired[]> = {};
    const standup = routine(db, fired, "standup", { days: EVERY_DAY, at: ["08:00"] });
    await runClock(db, [standup], { from: "2026-09-21T04:00:00Z", to: "2026-09-21T13:00:00Z", profileAt: () => ({ working_days: MON_FRI }), timeZone: null });
    expect(fired.standup).toBeUndefined();
    expect(db.rowsFor("standup")[0]?.meta).toMatchObject({ schedule_refused: "no_timezone", outcome: "skipped:no_timezone" });
  });

  it("a collector's refused row carries no outcome — that vocabulary is the routines'", async () => {
    const db = new FakeRuns(new Date("2026-09-21T04:00:00Z"));
    const c: ScheduledCollector = { name: "c", dir: "collectors/c", schedule: { days: "working_days", at: ["07:00"] }, runKind: "collector_run", requires: NOTHING, run: async () => 1 };
    await runClock(db, [c], { from: "2026-09-21T04:00:00Z", to: "2026-09-21T04:01:00Z", profileAt: () => ({ timezone: NY }) });
    expect(db.rowsFor("c")[0]?.meta).toEqual(expect.objectContaining({ schedule_refused: "no_working_days" }));
    expect(db.rowsFor("c")[0]?.meta).not.toHaveProperty("outcome");
  });

  it("a profile the vault bridge cannot read is not `no_working_days`: those schedules wait, and run late once it can", async () => {
    const db = new FakeRuns(new Date("2026-09-21T10:00:00Z")).seed([
      { component: "morning-brief", kind: "routine_run", minutesAgo: 24 * 60, ok: true, meta: { scheduled_for: "2026-09-20T11:00:00.000Z" } },
    ]);
    const fired: Record<string, Fired[]> = {};
    const brief = routine(db, fired, "morning-brief", { days: "working_days", at: ["07:00"] });
    const every = { ...routine(db, fired, "inbox-sort", { every: "5m" }), runKind: "collector_run" as const };
    const back = Date.parse("2026-09-21T11:20:00Z");
    await runClock(db, [brief, every], {
      from: "2026-09-21T10:55:00Z",
      to: "2026-09-21T11:30:00Z",
      profile: async () => {
        if (db.now.getTime() < back) throw new Error("vault bridge: connect ECONNREFUSED");
        return PROFILE;
      },
    });
    expect(ats(fired["morning-brief"])).toEqual(["2026-09-21 07:20"]); // late, once — for the 07:00 slot
    expect(fired["morning-brief"]?.[0]?.scheduledFor).toBe("2026-09-21T11:00:00.000Z");
    expect(db.rowsFor("morning-brief").some((r) => r.meta.schedule_refused !== undefined)).toBe(false);
    expect((fired["inbox-sort"] ?? []).length).toBeGreaterThan(0); // an interval does not wait for the profile
  });
});

// ---------------------------------------------------- preflight at a slot

describe("the hardening gates, per slot", () => {
  it("preflight blocks a slot: one row for that slot however many ticks, then a late run once it is fixed", async () => {
    const db = new FakeRuns(new Date("2026-09-21T04:00:00Z"));
    const fired: Record<string, Fired[]> = {};
    const brief = routine(db, fired, "morning-brief", { days: "working_days", at: ["07:00"] }, { requires: { env: ["METISTRY_X"], reachable: [], engine: false } });
    await runClock(db, [brief], { from: "2026-09-21T10:59:00Z", to: "2026-09-21T11:30:00Z", startedAt: new Date("2026-09-21T04:00:00Z") });
    expect(fired["morning-brief"]).toBeUndefined();
    expect(db.rowsFor("morning-brief", "preflight_failed")).toHaveLength(1);
    await runClock(db, [brief], { from: "2026-09-21T11:31:00Z", to: "2026-09-21T11:40:00Z", startedAt: new Date("2026-09-21T04:00:00Z"), env: { ...ENV, METISTRY_X: "set" } });
    expect(fired["morning-brief"]).toEqual([{ at: "2026-09-21T11:31:00.000Z", scheduledFor: "2026-09-21T11:00:00.000Z", timeZone: NY }]);
    expect(db.rowsFor("morning-brief", "preflight_failed")).toHaveLength(1);
  });
});

// ------------------------------------------------------ the owner's overlay

describe(".metistry/scheduled.yaml, read every tick", () => {
  const overlay = (value: object): (() => Promise<OverlayRead>) => async () => ({ ok: true, value });

  it("an owner's schedule replaces the manifest's, on the next tick with no restart", async () => {
    const db = new FakeRuns(new Date("2026-09-21T04:00:00Z"));
    const fired: Record<string, Fired[]> = {};
    const fold = routine(db, fired, "knowledge-fold", { days: EVERY_DAY, at: ["21:00"] });
    let file: object = {};
    const changed = Date.parse("2026-09-21T12:00:00Z");
    await runClock(db, [fold], {
      from: "2026-09-21T04:00:00Z",
      to: "2026-09-23T03:59:00Z",
      scheduled: async () => {
        file = db.now.getTime() < changed ? {} : { routines: { "knowledge-fold": { schedule: { days: EVERY_DAY, at: ["20:00"] } } } };
        return { ok: true, value: file };
      },
    });
    expect(ats(fired["knowledge-fold"])).toEqual(["2026-09-21 20:00", "2026-09-22 20:00"]);
  });

  it("paused: not run, and no row a tick", async () => {
    const db = new FakeRuns(new Date("2026-09-21T04:00:00Z"));
    const fired: Record<string, Fired[]> = {};
    const fold = routine(db, fired, "knowledge-fold", { days: EVERY_DAY, at: ["21:00"] });
    await runClock(db, [fold], { from: "2026-09-21T04:00:00Z", to: "2026-09-22T03:59:00Z", scheduled: overlay({ routines: { "knowledge-fold": { paused: true } } }) });
    expect(fired["knowledge-fold"]).toBeUndefined();
    expect(db.runs).toHaveLength(0);
  });

  it("a sync's every replaces a collector's interval", async () => {
    const db = new FakeRuns(new Date("2026-09-21T12:00:00Z"));
    const fired: Record<string, Fired[]> = {};
    const gh = { ...routine(db, fired, "github-state", "*/15 * * * *"), runKind: "collector_run" as const, dir: "collectors/github-state" };
    await runClock(db, [gh], { from: "2026-09-21T12:00:00Z", to: "2026-09-21T13:59:00Z", scheduled: overlay({ syncs: { "github-state": { connection: "github", every: "1h" } } }) });
    expect((fired["github-state"] ?? []).map((f) => f.at)).toEqual(["2026-09-21T12:00:00.000Z", "2026-09-21T13:00:00.000Z"]);
  });

  it("an invalid file is never applied — what it names is HELD, not run on defaults; the rest run; one alert", async () => {
    const db = new FakeRuns(new Date("2026-09-21T04:00:00Z"));
    const fired: Record<string, Fired[]> = {};
    const fold = routine(db, fired, "knowledge-fold", { days: EVERY_DAY, at: ["21:00"] });
    const brief = routine(db, fired, "morning-brief", { days: "working_days", at: ["07:00"] });
    const broken: OverlayRead = { ok: false, errors: ["routines.knowledge-fold.schedule.every: every must be one of 5m, 15m, 1h, 6h"], held: ["knowledge-fold"] };
    await runClock(db, [fold, brief], { from: "2026-09-21T04:00:00Z", to: "2026-09-22T03:59:00Z", scheduled: async () => broken });
    expect(fired["knowledge-fold"]).toBeUndefined(); // a paused fold would otherwise have run again
    expect(ats(fired["morning-brief"])).toEqual(["2026-09-21 07:00"]);
    const held = db.rowsFor("knowledge-fold", "schedule_held");
    expect(held).toHaveLength(1); // once a day, not once a tick
    expect(held[0]?.error).toContain("does not validate");
    expect(db.outbound).toHaveLength(1);
    expect(db.outbound[0]?.text).toContain(".metistry/scheduled.yaml does not validate");
  });

  it("a file too broken to say what it names holds everything", async () => {
    const db = new FakeRuns(new Date("2026-09-21T12:00:00Z"));
    const fired: Record<string, Fired[]> = {};
    const inbox = { ...routine(db, fired, "inbox-drain", { every: "5m" }), runKind: "collector_run" as const };
    await runClock(db, [inbox], { from: "2026-09-21T12:00:00Z", to: "2026-09-21T12:30:00Z", scheduled: async () => ({ ok: false, errors: ["(root): bad indentation"], held: "all" }) });
    expect(fired["inbox-drain"]).toBeUndefined();
    expect(db.rowsFor("inbox-drain", "schedule_held")).toHaveLength(1);
  });

  it("an entry the runner cannot apply holds the component and says which — never silently ignored", () => {
    const db = new FakeRuns(new Date());
    const fired: Record<string, Fired[]> = {};
    const fold = routine(db, fired, "knowledge-fold", { days: EVERY_DAY, at: ["21:00"] });
    const gh = { ...routine(db, fired, "github-state", "*/15 * * * *"), runKind: "collector_run" as const };
    const ok = (value: object): OverlayRead => ({ ok: true, value });
    expect(effectiveSchedule(fold, ok({ syncs: { "knowledge-fold": { connection: "x" } } }))).toMatchObject({ held: true, why: expect.stringContaining("names a routine") });
    expect(effectiveSchedule(fold, ok({ routines: { "knowledge-fold": { actor: "a", task: "t", schedule: { every: "1h" } } } }))).toMatchObject({
      held: true,
      why: expect.stringContaining("New Routine"),
    });
    expect(effectiveSchedule(gh, ok({ routines: { "github-state": { paused: true } }, syncs: { "github-state": { connection: "github" } } }))).toMatchObject({
      held: true,
      why: expect.stringContaining("both routines: and syncs:"),
    });
    // …and a name nothing schedules is no one's business here
    expect(effectiveSchedule(fold, ok({ routines: { constructor: { paused: true } } }))).toEqual({ held: false, schedule: fold.schedule, paused: false });
  });

  // T3-2: the manifests' layer — what each shipped component declares decides
  // which section its changes live in and which keys an entry may name.
  it("against the shipped manifests: a collector presenting as a routine is changed under routines:, a sync under syncs:, and an undeclared key holds", async () => {
    const all = await loadSchedules([
      ...(await loadCollectors({ home: `${root}collectors` })).collectors,
      ...(await loadRoutines({ home: `${root}routines` })).routines,
    ]);
    const get = (name: string): ScheduledCollector => all.find((c) => c.name === name)!;
    const ok = (value: object): OverlayRead => ({ ok: true, value });
    // Inbox Sort is a routine under Scheduled, though a collector underneath
    expect(effectiveSchedule(get("inbox-drain"), ok({ routines: { "inbox-drain": { paused: true } } }))).toEqual({ held: false, schedule: { every: "5m" }, paused: true });
    expect(effectiveSchedule(get("inbox-drain"), ok({ syncs: { "inbox-drain": { connection: "inbox", every: "1h" } } }))).toMatchObject({ held: true, alert: true, why: expect.stringContaining("names a routine") });
    // GitHub is a sync: a routines: entry for it is not applied, and says so
    expect(effectiveSchedule(get("github-state"), ok({ routines: { "github-state": { paused: true } } }))).toMatchObject({ held: true, why: "routines.github-state: github-state is a sync — its changes live under syncs.github-state" });
    expect(effectiveSchedule(get("github-state"), ok({ syncs: { "github-state": { connection: "github", every: "1h", raise: { assigned: false } } } }))).toEqual({ held: false, schedule: { every: "1h" }, paused: false });
    expect(effectiveSchedule(get("github-state"), ok({ syncs: { "github-state": { connection: "github", raise: { merged: true } } } }))).toMatchObject({ held: true, why: expect.stringContaining("GitHub raises no merged") });
    // no shipped routine declares config yet, so any key is one it does not take
    expect(effectiveSchedule(get("knowledge-fold"), ok({ routines: { "knowledge-fold": { config: { template: "Templates/Fold.md" } } } }))).toMatchObject({
      held: true,
      alert: true,
      why: "routines.knowledge-fold.config.template: Knowledge Fold takes no template — it declares no config",
    });
  });

  // T3-4 moved standup_days / standup_time into `routines.standup` before
  // T3-5 shipped the Standup routine; until then the entry applied to
  // nothing. Now it is the routine's: the moved time is the one in force, and
  // the file carries no problem at all.
  it("routines.standup, as T3-4 writes it, applies to the Standup routine: the moved time wins, nothing is held", async () => {
    const all = await loadSchedules([
      ...(await loadCollectors({ home: `${root}collectors` })).collectors,
      ...(await loadRoutines({ home: `${root}routines` })).routines,
    ]);
    const text = `routines:\n  standup:\n    schedule: { days: working_days, at: [ "09:15" ] }\n`;
    const dir = await mkdtemp(join(tmpdir(), "metistry-scheduled-"));
    await writeFile(join(dir, "scheduled.yaml"), text);
    const read = await readOverlay(join(dir, "scheduled.yaml"));
    expect(read.ok).toBe(true);
    for (const c of all) expect(effectiveSchedule(c, read), c.name).toMatchObject({ held: false, paused: false });
    const standup = all.find((c) => c.name === "standup")!;
    expect(effectiveSchedule(standup, read)).toEqual({ held: false, paused: false, schedule: { days: "working_days", at: ["09:15"] } });
    if (!read.ok) return;
    expect(checkScheduled(read.value, all.map((c) => c.unit!))).toEqual([]);
  });

  it("an undeclared config key holds the routine for the ticks it lasts: not run on defaults, one row a day, one alert", async () => {
    const db = new FakeRuns(new Date("2026-09-21T04:00:00Z"));
    const fired: Record<string, Fired[]> = {};
    const fold = routine(db, fired, "knowledge-fold", { days: EVERY_DAY, at: ["21:00"] }, {
      unit: { name: "knowledge-fold", section: "routines", displayName: "Knowledge Fold", schedule: { days: EVERY_DAY, at: ["21:00"] }, config: {}, raise: {} },
    });
    await runClock(db, [fold], { from: "2026-09-21T04:00:00Z", to: "2026-09-22T03:59:00Z", scheduled: overlay({ routines: { "knowledge-fold": { paused: false, config: { voice: "dry" } } } }) });
    expect(fired["knowledge-fold"]).toBeUndefined();
    expect(db.rowsFor("knowledge-fold", "schedule_held")).toHaveLength(1);
    expect(db.outbound).toHaveLength(1);
    expect(db.outbound[0]?.text).toContain("Knowledge Fold takes no voice");
  });
});

describe("readOverlay and profileFacts — the two files, read", () => {
  const write = async (text: string): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "metistry-scheduled-"));
    const path = join(dir, "scheduled.yaml");
    await writeFile(path, text);
    return path;
  };

  it("no path or no file is no changes; a valid file is its value", async () => {
    expect(await readOverlay(null)).toEqual({ ok: true, value: {} });
    expect(await readOverlay(join(tmpdir(), "metistry-no-such-dir", "scheduled.yaml"))).toEqual({ ok: true, value: {} });
    const path = await write(`routines:\n  morning-brief:\n    paused: true\n`);
    expect(await readOverlay(path)).toEqual({ ok: true, value: { routines: { "morning-brief": { paused: true } } } });
  });

  it("an invalid file holds exactly what it names; a YAML error or an unknown top-level key holds everything", async () => {
    const named = await readOverlay(await write(`routines:\n  knowledge-fold:\n    schedule: { every: 10m }\n  morning-brief:\n    paused: true\nsyncs:\n  github-state:\n    every: 1d\n`));
    expect(named).toMatchObject({ ok: false, held: ["knowledge-fold", "morning-brief", "github-state"] });
    expect(await readOverlay(await write(`routines:\n  a: [\n`))).toMatchObject({ ok: false, held: "all" });
    expect(await readOverlay(await write(`routine:\n  morning-brief:\n    paused: true\n`))).toMatchObject({ ok: false, held: "all" }); // a typo of routines:
  });

  it("profileFacts reads timezone and working_days the way plan-tomorrow's guard does, and never fills one in", () => {
    expect(profileFacts(`---\ntimezone: America/New_York\nworking_days: [mon, tue, wed, thu, fri]\n---\n`)).toEqual({ timezone: NY, working_days: MON_FRI });
    expect(profileFacts(`---\nworking_days: [Monday, SUN]\n---\n`)).toEqual({ working_days: ["sun", "mon"] });
    expect(profileFacts(null)).toEqual({});
    // the SEEDED profile says nothing — every fact commented out on purpose (#237)
    expect(profileFacts(`---\nsource: user\n# timezone: America/New_York\n# working_days: [mon, tue, wed, thu, fri]\n---\n`)).toEqual({});
    // a timezone that is not a string is passed on as written, to be refused — never skipped for the fallback
    expect(profileFacts(`---\ntimezone: 5\n---\n`)).toEqual({ timezone: "5" });
  });
});
