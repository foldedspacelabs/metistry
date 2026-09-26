// scheduleToSeconds is shared by the console runner (when is a collector
// due) and the watchdog (how long is too long) — one parser, so the two
// can never disagree about an interval.
//
// Below it, the closed schedule shape (design-build-plan §2.5, F-4): what
// scheduled.yaml may hold, and what it refuses. The next-occurrence function
// is T3-1's; its DST and timezone tests land with it.
import { describe, expect, it } from "vitest";
import {
  DAY_SETS,
  EVERY,
  EVERY_SECONDS,
  MAX_AT_TIMES,
  SCHEDULE_SHAPE_REFUSAL,
  WEEKDAYS,
  isInterval,
  isLegacyCron,
  manifestScheduleSchema,
  resolveDays,
  scheduleSchema,
  scheduleToSeconds,
  validTimeZone,
  type Weekday,
} from "../src/index.js";

describe("scheduleToSeconds", () => {
  it("parses the supported cron subset", () => {
    expect(scheduleToSeconds("*/5 * * * *")).toBe(300);
    expect(scheduleToSeconds("*/15 * * * *")).toBe(900);
    expect(scheduleToSeconds("0 */6 * * *")).toBe(21600);
    expect(scheduleToSeconds("@hourly")).toBe(3600);
    expect(scheduleToSeconds("@daily")).toBe(86400);
    expect(scheduleToSeconds("@weekly")).toBe(604800);
    expect(scheduleToSeconds("@monthly")).toBe(2592000);
  });

  it("refuses what it cannot schedule (loud, not a silent default)", () => {
    expect(() => scheduleToSeconds("0 9 * * 1-5")).toThrow(/cannot schedule/);
  });
});

/** Every refusal as `path: message` lines — what a door or doctor would print. */
function refusals(schema: typeof scheduleSchema | typeof manifestScheduleSchema, value: unknown): string[] {
  const r = schema.safeParse(value);
  if (r.success) throw new Error(`expected a refusal, but ${JSON.stringify(value)} parsed`);
  return r.error.issues.map((i) => `${i.path.join(".") || "(schedule)"}: ${i.message}`);
}

describe("the closed schedule shape (§2.5)", () => {
  it("holds exactly the four intervals, and each is the cron interval it replaces", () => {
    expect(EVERY).toEqual(["5m", "15m", "1h", "6h"]);
    expect(EVERY_SECONDS["5m"]).toBe(scheduleToSeconds("*/5 * * * *"));
    expect(EVERY_SECONDS["15m"]).toBe(scheduleToSeconds("*/15 * * * *"));
    expect(EVERY_SECONDS["1h"]).toBe(scheduleToSeconds("@hourly"));
    expect(EVERY_SECONDS["6h"]).toBe(scheduleToSeconds("0 */6 * * *"));
    expect(DAY_SETS).toEqual(["working_days", "eve_of_working_days"]);
  });

  it("accepts both forms, and returns exactly what was written", () => {
    const good = [
      { days: "working_days", at: ["08:00"] },
      { days: "eve_of_working_days", at: ["23:00"] },
      { days: ["mon", "tue", "wed", "thu", "fri"], at: ["07:00"] },
      { days: ["sun"], at: ["18:00", "06:30"], tz: "America/New_York" },
      { days: [...WEEKDAYS], at: ["21:00"], tz: "Etc/UTC" },
      ...EVERY.map((every) => ({ every })),
    ];
    for (const s of good) expect(scheduleSchema.parse(s)).toEqual(s);
    expect(isInterval(scheduleSchema.parse({ every: "1h" }))).toBe(true);
    expect(isInterval(scheduleSchema.parse({ days: "working_days", at: ["08:00"] }))).toBe(false);
  });

  it("refuses `every` outside the closed set, naming the field and the set", () => {
    for (const every of ["10m", "30m", "1d", "2h", "15M", "5 m", "*/5 * * * *", "@hourly", "", 15, 300, null, true]) {
      expect(refusals(scheduleSchema, { every }), JSON.stringify(every)).toEqual([
        `every: every must be one of 5m, 15m, 1h, 6h — ${JSON.stringify(every)} is not (the set is closed)`,
      ]);
    }
  });

  it("refuses a cron string — cron is for a product manifest, for one release", () => {
    for (const cron of ["*/15 * * * *", "0 8 * * 1-5", "@daily"]) {
      expect(refusals(scheduleSchema, cron)).toEqual([`(schedule): ${SCHEDULE_SHAPE_REFUSAL}`]);
    }
    expect(SCHEDULE_SHAPE_REFUSAL).toMatch(/cron string is accepted only in a product manifest/);
  });

  it("refuses the two forms mixed, a missing half, and a key it does not know", () => {
    expect(refusals(scheduleSchema, { every: "5m", days: "working_days", at: ["08:00"] })[0]).toMatch(/never both/);
    expect(refusals(scheduleSchema, { every: "5m", tz: "Etc/UTC" })[0]).toMatch(/never both/);
    expect(refusals(scheduleSchema, { days: "working_days" })).toEqual([`at: at is a list of times — at: ["08:00"]`]);
    expect(refusals(scheduleSchema, { at: ["08:00"] })[0]).toMatch(/^days: days must be working_days, eve_of_working_days, or a list of weekdays/);
    expect(refusals(scheduleSchema, { days: "working_days", at: ["08:00"], when: "later" })).toEqual([`(schedule): Unrecognized key: "when"`]);
    expect(refusals(scheduleSchema, undefined)[0]).toMatch(/required/);
    expect(refusals(scheduleSchema, null)).toEqual([`(schedule): ${SCHEDULE_SHAPE_REFUSAL}`]);
    expect(refusals(scheduleSchema, [{ every: "5m" }])).toEqual([`(schedule): ${SCHEDULE_SHAPE_REFUSAL}`]);
  });

  it("refuses days that are not a day set or a list of weekdays", () => {
    const at = ["08:00"];
    const daysRefusal = "days: days must be working_days, eve_of_working_days, or a list of weekdays (sun, mon, tue, wed, thu, fri, sat)";
    for (const days of ["weekdays", "mon", ["monday"], ["Mon"], [1], null]) {
      expect(refusals(scheduleSchema, { days, at }), JSON.stringify(days)).toEqual([daysRefusal]);
    }
    expect(refusals(scheduleSchema, { days: [], at })).toEqual(["days: days lists at least one weekday"]);
    expect(refusals(scheduleSchema, { days: ["mon", "tue", "mon"], at })).toEqual(["days.2: days names mon twice"]);
  });

  it("refuses at times that are not two-digit 24-hour HH:MM, and a list that is empty, repeated or too long", () => {
    const days = "working_days";
    expect(refusals(scheduleSchema, { days, at: "08:00" })).toEqual([`at: at is a list of times — at: ["08:00"]`]);
    for (const t of ["8:00", "24:00", "08:60", "8am", "08:00:00", " 08:00"]) {
      expect(refusals(scheduleSchema, { days, at: [t] }), t).toEqual([`at.0: at times are HH:MM, 24-hour, two-digit hours ("08:00", "23:00")`]);
    }
    expect(refusals(scheduleSchema, { days, at: [800] })).toEqual([`at.0: at times are quoted HH:MM strings ("08:00")`]);
    expect(refusals(scheduleSchema, { days, at: [] })).toEqual(["at: at lists at least one time"]);
    expect(refusals(scheduleSchema, { days, at: ["08:00", "12:00", "08:00"] })).toEqual(["at.2: at names 08:00 twice"]);
    const halfHours = Array.from({ length: MAX_AT_TIMES }, (_, i) => `${String(Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}`);
    expect(scheduleSchema.parse({ days, at: halfHours })).toEqual({ days, at: halfHours }); // every half hour is the ceiling
    expect(refusals(scheduleSchema, { days, at: [...halfHours, "23:59"] })).toEqual([`at: at lists at most ${MAX_AT_TIMES} times — anything denser is an every`]);
  });

  it("refuses a tz that is not an IANA zone name this runtime knows — a UTC offset included", () => {
    for (const tz of ["UTC", "Etc/UTC", "America/New_York", "America/Argentina/Buenos_Aires", "Europe/London"]) {
      expect(validTimeZone(tz), tz).toBe(true);
    }
    for (const tz of ["+05:00", "-0800", "utc", "Mars/Olympus", "America/New York", "", 5]) {
      expect(validTimeZone(tz), String(tz)).toBe(false);
      expect(refusals(scheduleSchema, { days: "working_days", at: ["08:00"], tz }), String(tz)).toEqual([
        "tz: tz must be an IANA zone name this runtime knows (America/New_York, Etc/UTC) — never a UTC offset",
      ]);
    }
  });
});

describe("a product manifest's schedule: the closed shape, or cron for one release", () => {
  it("accepts the legacy cron subset and the closed shape", () => {
    for (const cron of ["*/5 * * * *", "0 */6 * * *", "@hourly", "@daily", "@weekly", "@monthly"]) {
      const s = manifestScheduleSchema.parse(cron);
      expect(isLegacyCron(s)).toBe(true);
    }
    expect(manifestScheduleSchema.parse({ days: "eve_of_working_days", at: ["23:00"] })).toEqual({ days: "eve_of_working_days", at: ["23:00"] });
    expect(isLegacyCron(manifestScheduleSchema.parse({ every: "5m" }))).toBe(false);
  });

  it("still refuses `every` outside the closed set, and a string that is not cron", () => {
    expect(refusals(manifestScheduleSchema, { every: "10m" })).toEqual([`every: every must be one of 5m, 15m, 1h, 6h — "10m" is not (the set is closed)`]);
    expect(refusals(manifestScheduleSchema, "every 5 minutes")[0]).toMatch(/not a 5-field cron expression/);
  });
});

describe("resolveDays — the one definition of each day set", () => {
  const monFri: Weekday[] = ["mon", "tue", "wed", "thu", "fri"];

  it("a list is itself, whatever the profile says — ascending from Sunday", () => {
    expect(resolveDays(["fri", "mon"], undefined)).toEqual(["mon", "fri"]);
    expect(resolveDays(["sat"], monFri)).toEqual(["sat"]);
  });

  it("working_days follows the profile", () => {
    expect(resolveDays("working_days", monFri)).toEqual(monFri);
    expect(resolveDays("working_days", ["sat", "sun"])).toEqual(["sun", "sat"]);
  });

  it("eve_of_working_days is every day whose next day is a working day", () => {
    expect(resolveDays("eve_of_working_days", monFri)).toEqual(["sun", "mon", "tue", "wed", "thu"]);
    expect(resolveDays("eve_of_working_days", ["sat"])).toEqual(["fri"]);
    expect(resolveDays("eve_of_working_days", ["sun"])).toEqual(["sat"]); // wraps the week
    expect(resolveDays("eve_of_working_days", [...WEEKDAYS])).toEqual([...WEEKDAYS]);
  });

  it("a day set with no working days in the profile is null — never guessed", () => {
    for (const set of DAY_SETS) {
      expect(resolveDays(set, undefined)).toBeNull();
      expect(resolveDays(set, [])).toBeNull();
    }
  });
});
