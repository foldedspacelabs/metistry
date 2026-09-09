// A tier is a (model, effort) pair, and the resolver is the one place a NAME
// becomes one. Both apps resolve through this, so an unknown name must land
// somewhere stated rather than somewhere invented.
import { describe, expect, it } from "vitest";
import { DEFAULT_TIER, EFFORTS, ROUTINE_TIER, parseTiers, resolveTier, rollSession } from "../src/index.js";

const tiers = parseTiers({
  fast: { model: "haiku", effort: "low" },
  default: { model: "haiku", effort: "medium" },
  deep: { model: "opus", effort: "high" },
  routine: { model: "haiku", effort: "low" },
});

describe("tiers", () => {
  it("effort defaults to medium; a tier is model + effort", () => {
    expect(parseTiers({ default: { model: "sonnet" } })).toEqual({ default: { model: "sonnet", effort: "medium" } });
    expect(EFFORTS).toEqual(["low", "medium", "high"]);
  });

  it("refuses a map with no default, a bad effort, no model, or a TitleCase tier name", () => {
    expect(() => parseTiers({ deep: { model: "opus" } })).toThrow(/default/);
    expect(() => parseTiers({ default: { model: "x", effort: "max" } })).toThrow(/effort/);
    expect(() => parseTiers({ default: {} })).toThrow(/model/);
    expect(() => parseTiers({ default: { model: "x" }, Deep: { model: "y" } })).toThrow(/Deep/);
    expect(() => parseTiers(undefined)).toThrow();
  });

  it("resolves a name to the pair; an unknown or absent name is default, and says so", () => {
    expect(resolveTier(tiers, "deep")).toEqual({ tier: "deep", model: "opus", effort: "high" });
    expect(resolveTier(tiers, ROUTINE_TIER)).toEqual({ tier: "routine", model: "haiku", effort: "low" });
    expect(resolveTier(tiers, "gpt99")).toEqual({ tier: DEFAULT_TIER, model: "haiku", effort: "medium" });
    expect(resolveTier(tiers, undefined).tier).toBe(DEFAULT_TIER);
    expect(resolveTier(tiers, null).tier).toBe(DEFAULT_TIER);
    // resolution is pure: the same name twice is the same pair, which is what
    // makes "same tier ⇒ same options" (engine.ts) hold across turns
    expect(resolveTier(tiers, "fast")).toEqual(resolveTier(tiers, "fast"));
  });
});

describe("rollSession", () => {
  function fakeDb(active: { id: string; turns: number }[]) {
    const calls: { text: string; values: unknown[] }[] = [];
    return {
      calls,
      async query(text: string, values: unknown[]) {
        calls.push({ text, values });
        if (text.includes("UPDATE sessions")) return { rows: active as unknown as Record<string, unknown>[] };
        return { rows: [] };
      },
    };
  }

  it("marks the thread's active sessions rolled and logs ONE session_roll run with the reason and turn count", async () => {
    const db = fakeDb([{ id: "s-1", turns: 6 }]);
    expect(await rollSession(db, "default", "decision_answered")).toEqual({ rolled: ["s-1"], turns: 6 });
    const insert = db.calls.find((c) => c.text.includes("INSERT INTO runs"))!;
    expect(insert.text).toContain("'session_roll'");
    expect(JSON.parse(String(insert.values[1]))).toEqual({ thread: "default", reason: "decision_answered", sessions: ["s-1"], turns: 6 });
  });

  it("is idempotent: a thread with nothing active rolls nothing and writes no row", async () => {
    const db = fakeDb([]);
    expect(await rollSession(db, "default", "task_closed:#7")).toEqual({ rolled: [], turns: 0 });
    expect(db.calls.some((c) => c.text.includes("INSERT INTO runs"))).toBe(false);
  });
});
