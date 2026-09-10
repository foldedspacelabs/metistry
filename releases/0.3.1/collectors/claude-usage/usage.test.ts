import { describe, expect, it } from "vitest";
import { run } from "./run.js";

function fakeDb(rollup: any[]) {
  const q: { text: string; values: unknown[] }[] = [];
  return {
    q,
    async query(text: string, values: unknown[] = []) {
      q.push({ text, values });
      if (text.includes("FROM runs")) return { rows: rollup };
      return { rows: [] };
    },
  };
}

describe("claude-usage collector", () => {
  it("rolls turns into five metrics per model-day (incl. cache read/write) and replaces the window atomically", async () => {
    const db = fakeDb([
      { day: new Date("2026-09-05T00:00:00Z"), model: "haiku", turns: "12", tokens_in: "300", tokens_out: "900", cost_usd: "0.0412", cache_read: "1200", cache_write: "150" },
      { day: "2026-09-05", model: "sonnet", turns: "2", tokens_in: "5000", tokens_out: "800", cost_usd: "0.12", cache_read: "0", cache_write: "0" },
    ]);
    const n = await run(db, { now: new Date("2026-09-06T12:00:00Z") });
    expect(n).toBe(10);
    const texts = db.q.map((x) => x.text);
    expect(db.q[0]!.values).toEqual(["2026-09-03"]); // trailing 3-day window
    expect(texts[1]).toBe("BEGIN");
    expect(texts[2]).toMatch(/^DELETE FROM metrics/);
    expect(db.q[2]!.values[1]).toBe("2026-09-03");
    const inserts = db.q.filter((x) => x.text.startsWith("INSERT INTO metrics"));
    expect(inserts.map((x) => x.values[1])).toEqual([
      "claude.tokens_in", "claude.tokens_out", "claude.cost_usd", "claude.cache_read", "claude.cache_write",
      "claude.tokens_in", "claude.tokens_out", "claude.cost_usd", "claude.cache_read", "claude.cache_write",
    ]);
    expect(inserts[0]!.values[0]).toBe("2026-09-05"); // Date normalized
    expect(inserts[2]!.values[2]).toBeCloseTo(0.0412);
    expect(inserts[3]!.values[2]).toBe(1200); // cache_read
    expect(inserts[4]!.values[2]).toBe(150); // cache_write
    expect(JSON.parse(String(inserts[5]!.values[3]))).toEqual({ model: "sonnet", day: "2026-09-05", turns: 2 });
    expect(texts.at(-1)).toBe("COMMIT");
  });

  it("no turns → window cleared, nothing inserted, still commits", async () => {
    const db = fakeDb([]);
    expect(await run(db)).toBe(0);
    expect(db.q.map((x) => x.text).at(-1)).toBe("COMMIT");
  });

  it("rolls back when an insert fails", async () => {
    const db = fakeDb([{ day: "2026-09-05", model: "haiku", turns: 1, tokens_in: 1, tokens_out: 1, cost_usd: 0, cache_read: 0, cache_write: 0 }]);
    const orig = db.query.bind(db);
    db.query = async (t: string, v?: unknown[]) => { if (t.startsWith("INSERT")) throw new Error("disk full"); return orig(t, v); };
    await expect(run(db)).rejects.toThrow("disk full");
    expect(db.q.map((x) => x.text).at(-1)).toBe("ROLLBACK");
  });
});
