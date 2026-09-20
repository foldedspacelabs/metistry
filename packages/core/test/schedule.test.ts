// scheduleToSeconds is shared by the console runner (when is a collector
// due) and the watchdog (how long is too long) — one parser, so the two
// can never disagree about an interval.
import { describe, expect, it } from "vitest";
import { scheduleToSeconds } from "../src/index.js";

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
