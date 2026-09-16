// The budget guard: the pre-call gate wired into `makeEngine`, over a
// scripted db. What is asserted is the shape of the control — refused BEFORE
// the call, one warning per window, a refusal that names the field, and a
// budget that cannot be measured refusing rather than guessing.
import { describe, expect, it } from "vitest";
import { parseCompute, resolveAssignment, type SpendRow } from "@foldedspacelabs/metistry-core";
import { BudgetRefusal, isBudgetRefusal, makeBudgetGuard, offerBudgetWindow } from "../src/budgets.js";

/**
 * A db that is enough for this module: `runs` rows with a `window_key` in
 * meta (so the dedupe query answers truthfully), and every other statement
 * recorded.
 */
function fakeDb() {
  const runs: { kind: string; tool: string | null; meta: any; error?: string | null }[] = [];
  const statements: { text: string; values: unknown[] }[] = [];
  return {
    runs,
    statements,
    inserted: (re: RegExp) => statements.filter((s) => re.test(s.text)),
    async query(text: string, values: unknown[] = []) {
      statements.push({ text, values });
      if (/SELECT 1 FROM runs WHERE kind/.test(text)) {
        const [kind, tool, key] = values as [string, string, string];
        return { rows: runs.filter((r) => r.kind === kind && r.tool === tool && r.meta?.window_key === key).map(() => ({ "?column?": 1 })) };
      }
      if (/INSERT INTO runs/.test(text)) {
        runs.push({ kind: String(values[1]), tool: (values[3] as string) ?? null, meta: JSON.parse(String(values[6])) });
        return { rows: [{ id: runs.length }] };
      }
      if (/UPDATE runs/.test(text)) {
        const row = runs[Number(values[0]) - 1];
        if (row) row.error = (values[2] as string) ?? null;
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

const FILE = (action: string, extra = "") => `
providers:
  openrouter:
    kind: openai-compatible
    base_url: https://openrouter.ai/api/v1
    locality: off_machine
    data_policy: { allow: [Knowledge], deny_sources: [], max_brief_bytes: 1024 }
assignments:
  default: { model: openrouter/anthropic/claude-sonnet-5 }
  tiers:
    deep: { model: openrouter/anthropic/claude-opus-5, critical: true }
budgets:
  instance: { daily_usd: 5, action: ${action} }
${extra}`;

const spendOf = (usd: number): SpendRow[] => [{ provider: "openrouter", is_today: true, is_this_month: true, cost_usd: usd }];
const specFor = (cfg: ReturnType<typeof parseCompute>, tier = "default") => {
  const assignment = resolveAssignment(cfg, tier)!;
  return { model: assignment.model, effort: assignment.effort, assignment, thread: "default", tier };
};

describe("the budget guard", () => {
  it("does not read spend at all when the file sets no budgets", async () => {
    const db = fakeDb();
    let read = 0;
    const cfg = parseCompute("providers: {}\n");
    const guard = makeBudgetGuard({ db, compute: () => cfg, spend: async () => (read++, []) });
    await guard({ model: "m", effort: "medium" });
    expect(read).toBe(0);
    expect(db.statements).toHaveLength(0);
  });

  it("stop: refuses over the limit, records one `budget/stop` run row, and names the field", async () => {
    const db = fakeDb();
    const cfg = parseCompute(FILE("stop"));
    const guard = makeBudgetGuard({ db, compute: () => cfg, spend: async () => spendOf(5.2) });
    await expect(guard(specFor(cfg))).rejects.toThrow(BudgetRefusal);
    try {
      await guard(specFor(cfg));
    } catch (err) {
      expect(isBudgetRefusal(err)).toBe(true);
      expect((err as BudgetRefusal).message).toContain("budgets.instance.daily_usd");
      expect((err as BudgetRefusal).hit.scope).toBe("instance");
    }
    expect(db.runs.filter((r) => r.kind === "budget" && r.tool === "stop")).toHaveLength(2); // every refusal is recorded; only warnings dedupe
  });

  it("allow: the turn proceeds, and the 80% warning is written ONCE per window", async () => {
    const db = fakeDb();
    const cfg = parseCompute(FILE("allow"));
    const guard = makeBudgetGuard({ db, compute: () => cfg, spend: async () => spendOf(4.5), now: () => new Date("2026-09-16T09:00:00Z") });
    await guard(specFor(cfg));
    await guard(specFor(cfg));
    await guard(specFor(cfg));
    const warnings = db.runs.filter((r) => r.kind === "budget" && r.tool === "warn");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.meta.window_key).toBe("instance:daily:2026-09-16");
    expect(warnings[0]!.error).toContain("budgets.instance.daily_usd");
  });

  it("allow: tomorrow is a new window, so the warning comes back", async () => {
    const db = fakeDb();
    const cfg = parseCompute(FILE("allow"));
    let day = "2026-09-16";
    const guard = makeBudgetGuard({ db, compute: () => cfg, spend: async () => spendOf(4.5), now: () => new Date(`${day}T09:00:00Z`) });
    await guard(specFor(cfg));
    day = "2026-09-17";
    await guard(specFor(cfg));
    expect(db.runs.filter((r) => r.tool === "warn")).toHaveLength(2);
  });

  it("critical_only: a critical assignment runs, everything else is refused", async () => {
    const db = fakeDb();
    const cfg = parseCompute(FILE("critical_only"));
    const guard = makeBudgetGuard({ db, compute: () => cfg, spend: async () => spendOf(9) });
    await expect(guard(specFor(cfg, "default"))).rejects.toThrow(/budget_exceeded/);
    await expect(guard(specFor(cfg, "deep"))).resolves.toBeUndefined(); // deep is marked critical: true
  });

  it("budgets configured but the spend query absent: refuses, naming the query rather than guessing", async () => {
    const db = fakeDb();
    const cfg = parseCompute(FILE("stop"));
    const guard = makeBudgetGuard({ db, compute: () => cfg });
    await expect(guard(specFor(cfg))).rejects.toThrow(/`spend` named query is not loaded/);
  });

  it("a provider budget applies to that provider only", async () => {
    const db = fakeDb();
    const cfg = parseCompute(FILE("allow", "  providers: { openrouter: { daily_usd: 1, action: stop } }\n"));
    const guard = makeBudgetGuard({ db, compute: () => cfg, spend: async () => spendOf(2) });
    await expect(guard(specFor(cfg))).rejects.toThrow(/budgets.providers.openrouter.daily_usd/);
  });
});

describe("the Needs You window (a chat turn's refusal)", () => {
  it("writes one decision proposal and one alert, once per window", async () => {
    const db = fakeDb();
    const hit = { scope: "instance", window: "daily" as const, field: "budgets.instance.daily_usd", limit: 5, spent: 6, fraction: 1.2, over: true, action: "stop" as const };
    const now = new Date("2026-09-16T12:00:00Z");
    expect(await offerBudgetWindow(db, "default", hit, now)).toBe(true);
    expect(await offerBudgetWindow(db, "default", hit, now)).toBe(false);

    const proposals = db.inserted(/INSERT INTO proposals/);
    expect(proposals).toHaveLength(1);
    const payload = JSON.parse(String(proposals[0]!.values[0]));
    expect(payload.title).toContain("allow one more");
    expect(payload.options[0]).toContain("budgets.instance.daily_usd");
    expect(db.inserted(/INSERT INTO outbound_messages/)).toHaveLength(1);
    expect(String(db.inserted(/INSERT INTO outbound_messages/)[0]!.values[1])).toContain("metistry compute budget");
  });
});
