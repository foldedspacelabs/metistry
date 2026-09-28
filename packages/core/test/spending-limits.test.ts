// Spending limits (T4-19, C130, C133): project daily budgets beside the
// instance's and each provider's, and a subscription's plan window as its
// limit. The assertion the ticket names — a subscription provider has no
// dollar limit — is held twice: `compute.yaml`'s schema refuses one (so no
// door can write it), and the fold reports a subscription as a window
// whatever it is handed.
import { describe, expect, it } from "vitest";
import { callsFrom, parseCompute, providerTag, spendingLimits, validateCompute, type SpendRow } from "../src/index.js";

const PLAN = `  plan:
    kind: openai-compatible
    base_url: https://cloud.example/v1
    locality: off_machine
    billing: subscription
    auth: { secret: "{{ secret.plan_key }}" }
    data_policy: { allow: [Projects], deny_sources: [comms], max_brief_bytes: 65536 }
`;
const OPENROUTER = `  openrouter:
    kind: openai-compatible
    base_url: https://openrouter.ai/api/v1
    locality: off_machine
    auth: { secret: "{{ secret.openrouter_api_key }}" }
    data_policy: { allow: [Projects], deny_sources: [comms], max_brief_bytes: 65536 }
`;
const LOCAL = `  lmstudio: { kind: openai-compatible, base_url: http://127.0.0.1:1234/v1, locality: on_machine }
`;
const FILE = (budgets: string) => `providers:\n${PLAN}${OPENROUTER}${LOCAL}${budgets}`;

const why = (text: string): string => {
  try {
    parseCompute(text);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error("expected a refusal");
};

const SPEND: SpendRow[] = [
  { provider: "openrouter", is_today: true, is_this_month: true, calls: "3", cost_usd: "1.25" },
  { provider: "openrouter", is_today: false, is_this_month: true, calls: 10, cost_usd: 4 },
  { provider: "plan", is_today: true, is_this_month: true, calls: "7", cost_usd: 0 },
  { provider: "plan", is_today: false, is_this_month: true, calls: 30, cost_usd: 0 },
  { provider: "plan", is_today: false, is_this_month: false, calls: 99, cost_usd: 0 },
];

describe("a subscription provider has no dollar limit", () => {
  it("compute.yaml refuses a daily or monthly dollar limit on one, naming the field and the two ways out", () => {
    for (const limit of ["daily_usd: 5", "monthly_usd: 60", "daily_usd: 5, monthly_usd: 60, action: allow"]) {
      const m = why(FILE(`budgets:\n  providers: { plan: { ${limit} } }\n`));
      expect(m, limit).toContain("budgets.providers.plan");
      expect(m, limit).toContain("billed by subscription");
      expect(m, limit).toContain("plan window is its limit");
      expect(m, limit).toContain("providers.plan.billing: token");
    }
  });

  it("a provider switched to subscription while it still carries a dollar limit is refused too — the order of edits does not matter", () => {
    const r = validateCompute({
      providers: { plan: { kind: "openai-compatible", base_url: "https://cloud.example/v1", locality: "off_machine", billing: "subscription", data_policy: { allow: ["Projects"], deny_sources: [], max_brief_bytes: 1 } } },
      budgets: { providers: { plan: { monthly_usd: 20 } } },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join("\n")).toContain("budgets.providers.plan");
  });

  it("the same provider billed by the token takes a dollar limit, and the instance's still applies beside a subscription", () => {
    const cfg = parseCompute(FILE(`budgets:\n  instance: { daily_usd: 5 }\n  providers: { openrouter: { monthly_usd: 20 } }\n`));
    expect(cfg.budgets?.providers.openrouter?.monthly_usd).toBe(20);
    expect(cfg.budgets?.instance?.daily_usd).toBe(5);
    expect(parseCompute(FILE("").replace("billing: subscription", "billing: token") + "budgets:\n  providers: { plan: { daily_usd: 5 } }\n").budgets?.providers.plan?.daily_usd).toBe(5);
  });

  it("the fold reports a subscription as its plan window — calls in each window, no dollars and no action", () => {
    const cfg = parseCompute(FILE(""));
    const limits = spendingLimits({
      instance: undefined,
      providers: Object.entries(cfg.providers).map(([name, p]) => ({ name, tag: providerTag(p), enabled: true })),
      spend: SPEND,
      projects: null,
    });
    const plan = limits.providers.find((p) => p.name === "plan")!;
    expect(plan).toEqual({ name: "plan", tag: "subscription", enabled: true, kind: "window", scope: "provider:plan", used: { calls_today: 7, calls_this_month: 37 } });
    expect(plan).not.toHaveProperty("daily_usd");
    expect(plan).not.toHaveProperty("monthly_usd");
    expect(plan).not.toHaveProperty("action");
  });

  it("reads the tag, not the budget: a subscription handed a dollar budget anyway is still a window", () => {
    const limits = spendingLimits({ instance: undefined, providers: [{ name: "plan", tag: "subscription", enabled: true, budget: { daily_usd: 5, action: "stop" } }], spend: [], projects: null });
    expect(limits.providers[0]).toMatchObject({ kind: "window", used: { calls_today: 0, calls_this_month: 0 } });
    expect(limits.providers[0]).not.toHaveProperty("daily_usd");
  });
});

describe("spending limits, side by side", () => {
  const cfg = parseCompute(FILE(`budgets:\n  instance: { daily_usd: 5, monthly_usd: 60, action: critical_only }\n  providers: { openrouter: { monthly_usd: 20 } }\n`));
  const providers = Object.entries(cfg.providers).map(([name, p]) => ({ name, tag: providerTag(p), enabled: p.enabled !== false, budget: cfg.budgets?.providers[name] }));

  it("the instance and each token provider are dollar limits with their field, their action and what was spent against them", () => {
    const limits = spendingLimits({ instance: cfg.budgets?.instance, providers, spend: SPEND, projects: null });
    expect(limits.instance).toEqual({ kind: "usd", scope: "instance", field: "budgets.instance", daily_usd: 5, monthly_usd: 60, action: "critical_only", spent: { daily: 1.25, monthly: 5.25 } });
    expect(limits.providers.find((p) => p.name === "openrouter")).toEqual({
      name: "openrouter", tag: "cloud", enabled: true, kind: "usd", scope: "provider:openrouter", field: "budgets.providers.openrouter",
      daily_usd: null, monthly_usd: 20, action: "stop", spent: { daily: 1.25, monthly: 5.25 },
    });
  });

  it("no limit set reads as nulls and no action — state, not a default dressed up as a choice", () => {
    const limits = spendingLimits({ instance: undefined, providers, spend: SPEND, projects: null });
    expect(limits.instance).toMatchObject({ daily_usd: null, monthly_usd: null, action: null });
    expect(limits.providers.find((p) => p.name === "lmstudio")).toMatchObject({ kind: "usd", tag: "local", daily_usd: null, monthly_usd: null, action: null, spent: { daily: 0, monthly: 0 } });
  });

  it("project daily budgets sit beside them, from projects_rollup's rows, flipping to review at the limit", () => {
    const limits = spendingLimits({
      instance: cfg.budgets?.instance,
      providers,
      spend: SPEND,
      projects: [
        { id: "drey", title: "Drey", mode: "autonomous", daily_budget_usd: "2.50", spend_today_usd: "1.10" },
        { id: "garden", title: null, mode: "review", daily_budget_usd: null, spend_today_usd: 0 },
      ],
    });
    expect(limits.projects).toEqual([
      { kind: "usd", scope: "project:drey", id: "drey", title: "Drey", daily_usd: 2.5, spent: { daily: 1.1 }, mode: "autonomous", at_limit: "review" },
      { kind: "usd", scope: "project:garden", id: "garden", title: null, daily_usd: null, spent: { daily: 0 }, mode: "review", at_limit: "review" },
    ]);
  });

  it("a query that is not loaded is null, never a guessed zero or an empty list", () => {
    const limits = spendingLimits({ instance: cfg.budgets?.instance, providers, spend: null, projects: null });
    expect(limits.instance.spent).toBeNull();
    expect(limits.projects).toBeNull();
    expect(limits.providers.find((p) => p.name === "plan")).toMatchObject({ kind: "window", used: null });
    expect(limits.providers.find((p) => p.name === "openrouter")).toMatchObject({ spent: null });
  });
});

describe("callsFrom", () => {
  it("counts calls by the window flags Postgres set, per provider or across them all", () => {
    expect(callsFrom(SPEND, "plan")).toEqual({ calls_today: 7, calls_this_month: 37 });
    expect(callsFrom(SPEND)).toEqual({ calls_today: 10, calls_this_month: 50 });
    expect(callsFrom([{ provider: "plan", is_today: true, is_this_month: true, calls: null }], "plan")).toEqual({ calls_today: 0, calls_this_month: 0 });
  });
});
