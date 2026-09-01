import { describe, expect, it } from "vitest";
import { scheduleToSeconds, tick, type ScheduledCollector } from "../src/runner.js";

describe("routine runner", () => {
  it("parses the narrow cron dialect and refuses the rest loudly", () => {
    expect(scheduleToSeconds("*/5 * * * *")).toBe(300);
    expect(scheduleToSeconds("@hourly")).toBe(3600);
    expect(scheduleToSeconds("@daily")).toBe(86400);
    expect(() => scheduleToSeconds("0 4 * * 1")).toThrow(/cannot schedule/);
  });

  it("runs only when due, records a two-phase run, and isolates failures", async () => {
    const calls: string[] = [];
    let lastRun: string | null = new Date(Date.now() - 10_000).toISOString(); // 10s ago
    const db = {
      async query(text: string): Promise<{ rows: any[] }> {
        calls.push(text.split(" ")[0]!);
        if (text.startsWith("SELECT max")) return { rows: [{ last: lastRun }] };
        if (text.startsWith("INSERT INTO runs")) return { rows: [{ id: 1 }] };
        return { rows: [] };
      },
    };
    let ran = 0;
    const c: ScheduledCollector = { name: "t", intervalSec: 300, run: async () => (ran++, 1) };

    await tick(db, [c]); // not due (10s < 300s)
    expect(ran).toBe(0);

    lastRun = null; // never ran → due
    await tick(db, [c]);
    expect(ran).toBe(1);
    expect(calls.filter((c) => c === "INSERT").length).toBe(1); // startRun
    expect(calls.filter((c) => c === "UPDATE").length).toBe(1); // finishRun

    const failing: ScheduledCollector = { name: "f", intervalSec: 1, run: async () => { throw new Error("x"); } };
    await expect(tick(db, [failing])).resolves.toBeUndefined(); // failure recorded, never thrown
  });
});
