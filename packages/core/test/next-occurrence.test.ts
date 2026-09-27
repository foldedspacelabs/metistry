// The next-occurrence function (design-build-plan §2.5; F-4 froze the
// signature, T3-1 wrote the body) and the runner's question built on it,
// `dueOccurrence`. Every case is a plain call: the function is pure — no
// clock, no IO, no environment — so a daylight-saving night, a timezone
// change and a Mac that slept through three evenings are each one line.
//
// Dates are 2026. New York springs forward on Sunday 8 March (02:00 EST →
// 03:00 EDT) and falls back on Sunday 1 November (02:00 EDT → 01:00 EST).
// 2026-09-21 is a Monday.
import { describe, expect, it } from "vitest";
import {
  EVERY,
  EVERY_SECONDS,
  configuredTimeZone,
  describeSchedule,
  dueOccurrence,
  longestGapSeconds,
  nextOccurrence,
  type Occurrence,
  type OccurrenceContext,
  type Schedule,
  type Weekday,
} from "../src/index.js";

const WEEKDAYS_MON_FRI: Weekday[] = ["mon", "tue", "wed", "thu", "fri"];
const EVERY_DAY: Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const NY = "America/New_York";

const ctx = (over: Partial<OccurrenceContext["profile"]> = {}, fallbackTimeZone: string | null = null): OccurrenceContext => ({
  profile: { timezone: NY, working_days: WEEKDAYS_MON_FRI, ...over },
  fallbackTimeZone,
});

/** The instant, or the refusal's reason — so an expectation reads as one string. */
const at = (o: Occurrence | null): string | null => (o === null ? null : o.ok ? o.at.toISOString() : `refused:${o.reason}`);
const next = (s: Schedule, after: string, c: OccurrenceContext = ctx()): string | null => at(nextOccurrence(s, new Date(after), c));

describe("nextOccurrence — {every}", () => {
  it("is the last run plus the interval, with no zone, and is never refused", () => {
    for (const every of EVERY) {
      const o = nextOccurrence({ every }, new Date("2026-09-21T12:00:00Z"), { profile: {}, fallbackTimeZone: null });
      expect(o).toEqual({ ok: true, at: new Date(Date.parse("2026-09-21T12:00:00Z") + EVERY_SECONDS[every] * 1000), timeZone: null });
    }
  });
});

describe("nextOccurrence — {days, at}", () => {
  const daily8 = { days: EVERY_DAY, at: ["08:00"] };

  it("is the earliest slot STRICTLY after `after` — the slot itself is already past", () => {
    expect(next(daily8, "2026-09-21T11:59:59Z")).toBe("2026-09-21T12:00:00.000Z"); // 07:59:59 EDT → 08:00 today
    expect(next(daily8, "2026-09-21T12:00:00Z")).toBe("2026-09-22T12:00:00.000Z"); // exactly 08:00 → tomorrow
    expect(next(daily8, "2026-09-21T12:00:00.001Z")).toBe("2026-09-22T12:00:00.000Z");
  });

  it("reports the zone it read the wall clock in", () => {
    expect(nextOccurrence(daily8, new Date("2026-09-21T00:00:00Z"), ctx())).toMatchObject({ ok: true, timeZone: NY });
  });

  it("several times a day run in order, each once", () => {
    const twice = { days: EVERY_DAY, at: ["18:00", "08:00"] };
    expect(next(twice, "2026-09-21T12:00:00Z")).toBe("2026-09-21T22:00:00.000Z"); // after 08:00 → 18:00
    expect(next(twice, "2026-09-21T22:00:00Z")).toBe("2026-09-22T12:00:00.000Z"); // after 18:00 → tomorrow 08:00
  });

  it("working_days follows the profile: Friday's brief is followed by Monday's", () => {
    const brief = { days: "working_days" as const, at: ["07:00"] };
    expect(next(brief, "2026-09-25T11:00:00Z")).toBe("2026-09-28T11:00:00.000Z"); // Fri 07:00 → Mon 07:00
    expect(next(brief, "2026-09-26T15:00:00Z")).toBe("2026-09-28T11:00:00.000Z"); // Saturday → Monday
    // …and a profile that works Saturdays moves it, with no change to the schedule
    expect(next(brief, "2026-09-25T11:00:00Z", ctx({ working_days: [...WEEKDAYS_MON_FRI, "sat"] }))).toBe("2026-09-26T11:00:00.000Z");
  });

  it("eve_of_working_days: Sunday to Thursday plan Monday to Friday; Friday and Saturday are skipped", () => {
    const plan = { days: "eve_of_working_days" as const, at: ["23:00"] };
    expect(next(plan, "2026-09-24T12:00:00Z")).toBe("2026-09-25T03:00:00.000Z"); // Thu → Thu 23:00 EDT
    expect(next(plan, "2026-09-25T03:00:00Z")).toBe("2026-09-28T03:00:00.000Z"); // after Thu 23:00 → Sun 23:00 (Fri, Sat skipped)
  });

  it("a weekly slot is a week away once it has run", () => {
    const weekly = { days: ["sun"] as Weekday[], at: ["18:00"] };
    expect(next(weekly, "2026-09-27T22:00:00Z")).toBe("2026-10-04T22:00:00.000Z");
  });
});

describe("nextOccurrence — daylight saving (Temporal's `compatible`)", () => {
  const daily = (hhmm: string, tz?: string): Schedule => ({ days: EVERY_DAY, at: [hhmm], ...(tz ? { tz } : {}) });

  it("spring forward: a time the clocks skip runs shifted forward by the gap — 02:30 runs at 03:30 EDT", () => {
    expect(next(daily("02:30"), "2026-03-07T08:00:00Z")).toBe("2026-03-08T07:30:00.000Z"); // 03:30 EDT
    expect(next(daily("02:30"), "2026-03-08T07:30:00Z")).toBe("2026-03-09T06:30:00.000Z"); // and 02:30 EDT the next night
    expect(next(daily("02:30"), "2026-03-06T12:00:00Z")).toBe("2026-03-07T07:30:00.000Z"); // 02:30 EST the night before
  });

  it("spring forward: a time either side of the jump keeps its wall clock — 08:00 is 13:00Z, then 12:00Z", () => {
    expect(next(daily("08:00"), "2026-03-07T12:00:00Z")).toBe("2026-03-07T13:00:00.000Z");
    expect(next(daily("08:00"), "2026-03-07T13:00:00Z")).toBe("2026-03-08T12:00:00.000Z");
  });

  it("spring forward: a skipped time and a real one after it each run once, in instant order", () => {
    const both = { days: EVERY_DAY, at: ["02:30", "03:15"] };
    expect(next(both, "2026-03-08T06:00:00Z")).toBe("2026-03-08T07:15:00.000Z"); // 03:15 EDT first…
    expect(next(both, "2026-03-08T07:15:00Z")).toBe("2026-03-08T07:30:00.000Z"); // …then 02:30, shifted to 03:30
    expect(next(both, "2026-03-08T07:30:00Z")).toBe("2026-03-09T06:30:00.000Z");
  });

  it("fall back: a time that happens twice runs at the EARLIER, and not again that night", () => {
    expect(next(daily("01:30"), "2026-10-31T12:00:00Z")).toBe("2026-11-01T05:30:00.000Z"); // 01:30 EDT
    expect(next(daily("01:30"), "2026-11-01T05:30:00Z")).toBe("2026-11-02T06:30:00.000Z"); // not 01:30 EST (06:30Z) on the 1st
    expect(next(daily("01:30"), "2026-11-01T06:00:00Z")).toBe("2026-11-02T06:30:00.000Z"); // between the two 01:30s: already had it
  });

  it("fall back: 08:00 stays 08:00 on the wall — 12:00Z, then 13:00Z", () => {
    expect(next(daily("08:00"), "2026-10-31T12:00:00Z")).toBe("2026-11-01T13:00:00.000Z");
  });

  it("other zones, other rules: London at 01:00 UTC, Sydney in October, Lord Howe's half-hour jump", () => {
    // Europe/London: 29 March 2026, 01:00 GMT → 02:00 BST. 01:30 is skipped → 02:30 BST.
    expect(next(daily("01:30", "Europe/London"), "2026-03-28T12:00:00Z")).toBe("2026-03-29T01:30:00.000Z");
    // Australia/Sydney: 4 October 2026, 02:00 AEST → 03:00 AEDT. 02:30 → 03:30 AEDT (16:30Z the day before).
    expect(next(daily("02:30", "Australia/Sydney"), "2026-10-03T00:00:00Z")).toBe("2026-10-03T16:30:00.000Z");
    // Australia/Lord_Howe: 4 October 2026, 02:00 → 02:30 (a 30-minute gap). 02:15 → 02:45 (+11:00).
    expect(next(daily("02:15", "Australia/Lord_Howe"), "2026-10-03T12:00:00Z")).toBe("2026-10-03T15:45:00.000Z");
  });
});

describe("nextOccurrence — which zone, and when it refuses", () => {
  const daily8 = { days: EVERY_DAY, at: ["08:00"] };
  const AFTER = "2026-09-21T00:00:00Z";

  it("the schedule's tz beats the profile's timezone, which beats the runner's zone", () => {
    expect(next({ ...daily8, tz: "Europe/London" }, AFTER, ctx({ timezone: NY }, "Asia/Tokyo"))).toBe("2026-09-21T07:00:00.000Z");
    expect(next(daily8, AFTER, ctx({ timezone: NY }, "Asia/Tokyo"))).toBe("2026-09-21T12:00:00.000Z");
    expect(next(daily8, AFTER, ctx({ timezone: undefined }, "Asia/Tokyo"))).toBe("2026-09-21T23:00:00.000Z"); // 08:00 JST on the 22nd
  });

  it("no zone anywhere is `no_timezone` — never answered in UTC", () => {
    const o = nextOccurrence(daily8, new Date(AFTER), ctx({ timezone: undefined }, null));
    expect(o).toMatchObject({ ok: false, reason: "no_timezone" });
    expect(o.ok ? "" : o.why).toContain("METISTRY_TZ");
  });

  it("an empty timezone is the profile not saying, not a zone", () => {
    expect(next(daily8, AFTER, ctx({ timezone: "" }, "Asia/Tokyo"))).toBe("2026-09-21T23:00:00.000Z");
    expect(next(daily8, AFTER, ctx({ timezone: "  " }, null))).toBe("refused:no_timezone");
  });

  it("an unknown zone is `unknown_timezone` — never skipped for the next one in line", () => {
    expect(next(daily8, AFTER, ctx({ timezone: "Mars/Olympus_Mons" }, NY))).toBe("refused:unknown_timezone");
    expect(next(daily8, AFTER, ctx({ timezone: "+05:00" }, NY))).toBe("refused:unknown_timezone"); // an offset has no DST rules
    const o = nextOccurrence(daily8, new Date(AFTER), ctx({ timezone: "Mars/Olympus_Mons" }, NY));
    expect(o.ok ? "" : o.why).toContain("Me/profile.md's timezone");
  });

  it("a day set with no working days in the profile is `no_working_days`; explicit days need no profile", () => {
    expect(next({ days: "working_days", at: ["07:00"] }, AFTER, ctx({ working_days: undefined }))).toBe("refused:no_working_days");
    expect(next({ days: "eve_of_working_days", at: ["23:00"] }, AFTER, ctx({ working_days: [] }))).toBe("refused:no_working_days");
    expect(next(daily8, AFTER, { profile: {}, fallbackTimeZone: NY })).toBe("2026-09-21T12:00:00.000Z");
  });

  it("a timezone change moves the next slot to the new zone's wall clock, from the same last run", () => {
    // Last ran 08:00 in New York (12:00Z Monday). The owner moves to London.
    const last = "2026-09-21T12:00:00Z";
    expect(next(daily8, last, ctx({ timezone: NY }))).toBe("2026-09-22T12:00:00.000Z");
    expect(next(daily8, last, ctx({ timezone: "Europe/London" }))).toBe("2026-09-22T07:00:00.000Z"); // 08:00 BST Tuesday
    // …and west: last ran 08:00 London (07:00Z); New York's 08:00 that same day is still ahead, and is the next slot.
    expect(next(daily8, "2026-09-21T07:00:00Z", ctx({ timezone: NY }))).toBe("2026-09-21T12:00:00.000Z");
  });

  it("is pure: the process's own TZ changes nothing", () => {
    const before = process.env.TZ;
    try {
      process.env.TZ = "Asia/Kolkata";
      expect(next(daily8, AFTER)).toBe("2026-09-21T12:00:00.000Z");
      process.env.TZ = "UTC";
      expect(next(daily8, AFTER)).toBe("2026-09-21T12:00:00.000Z");
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
  });
});

describe("dueOccurrence — what a runner owes now", () => {
  const fold = { days: EVERY_DAY, at: ["21:00"] };
  const due = (s: Schedule, after: string, now: string, c: OccurrenceContext = ctx()): string | null =>
    at(dueOccurrence(s, new Date(after), new Date(now), c));

  it("nothing before the slot, the slot once it has passed, nothing again after it ran", () => {
    expect(due(fold, "2026-09-21T01:00:00Z", "2026-09-22T00:59:00Z")).toBe(null); // Mon 20:59 EDT; last ran Sun 21:00 EDT
    expect(due(fold, "2026-09-21T01:00:00Z", "2026-09-22T01:00:00Z")).toBe("2026-09-22T01:00:00.000Z"); // Mon 21:00 — exactly
    expect(due(fold, "2026-09-22T01:00:00Z", "2026-09-22T01:01:00Z")).toBe(null);
  });

  it("the Mac slept through the slot: owed once on waking, for that slot", () => {
    // Asleep from 20:30 to 22:15 on Monday; last fold was Sunday's.
    expect(due(fold, "2026-09-21T01:00:00Z", "2026-09-22T02:15:00Z")).toBe("2026-09-22T01:00:00.000Z");
  });

  it("the Mac slept through three slots: ONE run is owed, for the latest of them", () => {
    // Last fold Monday 21:00; woke Friday 08:00 — Tue, Wed and Thu were missed.
    expect(due(fold, "2026-09-22T01:00:00Z", "2026-09-25T12:00:00Z")).toBe("2026-09-25T01:00:00.000Z"); // Thu 21:00
    // …and a plan that slept from Friday to Tuesday owes Monday 23:00, not Sunday's
    const plan = { days: "eve_of_working_days" as const, at: ["23:00"] };
    expect(due(plan, "2026-09-25T03:00:00Z", "2026-09-29T13:00:00Z")).toBe("2026-09-29T03:00:00.000Z");
  });

  it("however long it slept, the answer comes from the last eight days", () => {
    expect(due(fold, "2026-01-01T00:00:00Z", "2026-09-25T12:00:00Z")).toBe("2026-09-25T01:00:00.000Z");
  });

  it("{every}: owed once the interval has passed since the last run", () => {
    expect(due({ every: "15m" }, "2026-09-21T12:00:00Z", "2026-09-21T12:14:59Z")).toBe(null);
    expect(due({ every: "15m" }, "2026-09-21T12:00:00Z", "2026-09-21T12:15:00Z")).toBe("2026-09-21T12:15:00.000Z");
  });

  it("refuses for the same reasons nextOccurrence does", () => {
    expect(due(fold, "2026-09-21T01:00:00Z", "2026-09-22T02:00:00Z", ctx({ timezone: undefined }, null))).toBe("refused:no_timezone");
    expect(due({ days: "working_days", at: ["07:00"] }, "2026-09-21T01:00:00Z", "2026-09-22T12:00:00Z", ctx({ working_days: undefined }))).toBe(
      "refused:no_working_days",
    );
  });

  it("a last run in the future (a clock that stepped back) owes nothing", () => {
    expect(due(fold, "2026-09-23T01:00:00Z", "2026-09-22T02:00:00Z")).toBe(null);
  });
});

describe("configuredTimeZone — METISTRY_TZ, and never TZ", () => {
  it("reads METISTRY_TZ; TZ is the deployment's UTC default, not a configured zone", () => {
    expect(configuredTimeZone({ METISTRY_TZ: NY, TZ: "UTC" })).toBe(NY);
    expect(configuredTimeZone({ TZ: "UTC" })).toBeNull();
    expect(configuredTimeZone({ METISTRY_TZ: "" })).toBeNull();
  });
});

describe("describeSchedule and longestGapSeconds", () => {
  it("says a schedule the way a person would", () => {
    expect(describeSchedule({ days: "working_days", at: ["07:00"] })).toBe("working days at 07:00");
    expect(describeSchedule({ days: "eve_of_working_days", at: ["23:00"] })).toBe("the eve of working days at 23:00");
    expect(describeSchedule({ days: EVERY_DAY, at: ["21:00"] })).toBe("every day at 21:00");
    expect(describeSchedule({ days: ["sun"], at: ["18:00"], tz: "Europe/London" })).toBe("sun at 18:00 (Europe/London)");
    expect(describeSchedule({ every: "5m" })).toBe("every 5m");
    expect(describeSchedule("@hourly")).toBe("@hourly");
  });

  it("bounds the gap between two runs — the interval, the widest gap of the week, or a week for a day set", () => {
    const HOUR = 3600;
    expect(longestGapSeconds("*/5 * * * *")).toBe(300);
    expect(longestGapSeconds({ every: "6h" })).toBe(6 * HOUR);
    expect(longestGapSeconds({ days: EVERY_DAY, at: ["21:00"] })).toBe(24 * HOUR + HOUR);
    expect(longestGapSeconds({ days: ["sun"], at: ["18:00"] })).toBe(7 * 24 * HOUR + HOUR);
    expect(longestGapSeconds({ days: ["mon", "fri"], at: ["08:00", "20:00"] })).toBe((3 * 24 + 12) * HOUR + HOUR); // Mon 20:00 → Fri 08:00
    expect(longestGapSeconds({ days: "working_days", at: ["07:00"] })).toBe(7 * 24 * HOUR + HOUR);
  });
});
