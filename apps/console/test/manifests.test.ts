// Every shipped collector/routine manifest must load through the runner —
// the console refuses to start on an unparseable schedule, and one slipped
// through unit tests once (aws-costs "0 */6 * * *") and crash-looped the
// deployed console. This is the CI gate for that.
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { collectors } from "@metistry-apps/collectors";
import { routines } from "@metistry-apps/routines";
import { loadSchedules, scheduleToSeconds } from "../src/runner.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));

describe("shipped manifests schedule through the runner", () => {
  it("every registered collector and routine loads", async () => {
    const c = await loadSchedules(collectors, `${root}collectors`);
    const r = await loadSchedules(routines, `${root}routines`);
    expect(c.map((x) => x.name)).toEqual(collectors.map((x) => x.name));
    expect(r.map((x) => x.name)).toEqual(routines.map((x) => x.name));
    for (const s of [...c, ...r]) expect(s.intervalSec).toBeGreaterThan(0);
  });

  it("cron subset", () => {
    expect(scheduleToSeconds("*/15 * * * *")).toBe(900);
    expect(scheduleToSeconds("0 */6 * * *")).toBe(21600);
    expect(scheduleToSeconds("@hourly")).toBe(3600);
    expect(() => scheduleToSeconds("0 9 * * 1-5")).toThrow(/cannot schedule/);
  });
});
