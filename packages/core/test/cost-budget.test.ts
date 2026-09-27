// Cost and budgets — the two things a user now pays for directly, so the
// assertions that matter are: the number on the row came from a named
// source and was never invented, and a refusal names the field that would
// permit it (R3).
import { describe, expect, it } from "vitest";
import {
  BUDGET_EXCEEDED,
  budgetMiss,
  budgetRefusalMessage,
  budgetWarningMessage,
  budgetWindowKey,
  checkBudgets,
  costOf,
  parseCompute,
  spentFrom,
  unpricedNote,
  usageFromResponse,
  type Provider,
  type SpendRow,
} from "../src/index.js";

const local: Provider = { kind: "openai-compatible", base_url: "http://127.0.0.1:1234/v1", locality: "on_machine" };
const cloud: Provider = {
  kind: "openai-compatible",
  base_url: "https://openrouter.ai/api/v1",
  locality: "off_machine",
  data_policy: { allow: ["Projects"], deny_sources: [], max_brief_bytes: 65536 },
  pricing: { "anthropic/claude-sonnet-5": { in_per_m: 3, out_per_m: 15 } },
};

describe("usage → cost", () => {
  it("normalises an OpenAI-shaped usage block, cached tokens included in tokens_in", () => {
    const u = usageFromResponse({ prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 800 }, cost: 0.0042 });
    expect(u).toEqual({ tokens_in: 1000, tokens_out: 200, cache_read: 800, cost_usd: 0.0042 });
  });

  it("an absent usage block is zero tokens and no cost, never a thrown error mid-turn", () => {
    expect(usageFromResponse(undefined)).toEqual({ tokens_in: 0, tokens_out: 0 });
  });

  it("the provider's own usage.cost wins — it is the only number that knows the account's discounts", () => {
    const u = usageFromResponse({ prompt_tokens: 1_000_000, completion_tokens: 1_000_000, cost: 0.01 });
    expect(costOf(u, cloud, "anthropic/claude-sonnet-5")).toEqual({ cost_usd: 0.01, source: "provider" });
  });

  it("falls back to the pricing: table when the response carries no cost", () => {
    const u = usageFromResponse({ prompt_tokens: 1_000_000, completion_tokens: 100_000 });
    expect(costOf(u, cloud, "anthropic/claude-sonnet-5")).toEqual({ cost_usd: 3 + 1.5, source: "pricing" });
  });

  it("on_machine is 0 by definition, before anything else is consulted", () => {
    expect(costOf(usageFromResponse({ prompt_tokens: 9e6, cost: 5 }), local, "whatever")).toEqual({ cost_usd: 0, source: "local" });
  });

  it("cached prompt tokens come off whatever field the provider put them in, and tokens_in is the whole prompt either way", () => {
    // OPENAI-SHAPED (OpenRouter and every /v1/chat/completions endpoint):
    // `prompt_tokens` is ALREADY the whole prompt, cached share included, and
    // the split lives in the details block.
    expect(usageFromResponse({ prompt_tokens: 1000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 600 }, cache_write_tokens: 300 }))
      .toEqual({ tokens_in: 1000, tokens_out: 20, cache_read: 600, cache_write: 300 });
    // ANTHROPIC-NATIVE (/v1/messages): `input_tokens` is the FRESH remainder
    // and the two cache counts sit beside it, so the whole prompt is the sum —
    // 100 + 600 + 300. A row that recorded 100 here would say a turn which
    // cached 90 % of its prefix was a tenth the size of the same turn on
    // OpenRouter, and every ratio over `tokens_in` would be wrong.
    expect(usageFromResponse({ input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 600, cache_creation_input_tokens: 300 }))
      .toEqual({ tokens_in: 1000, tokens_out: 10, cache_read: 600, cache_write: 300 });
    // The shape is read off the ANCHOR field, never the provider's name: a
    // gateway that sends `prompt_tokens` beside Anthropic's cache spellings
    // has already included them, so they are not added a second time.
    expect(usageFromResponse({ prompt_tokens: 1000, completion_tokens: 10, cache_read_input_tokens: 600, cache_creation_input_tokens: 300 }))
      .toEqual({ tokens_in: 1000, tokens_out: 10, cache_read: 600, cache_write: 300 });
  });

  it("a response that says nothing about the cache is undefined, not zero — the two are different findings (OPEN-6)", () => {
    // `undefined` = "this provider reported no such field", which is how a
    // wrong guess at the field name shows up; 0 = "reported, and none of the
    // prompt was cached", which is a prefix that is not stable. The
    // cache-report reads the difference, so it must survive normalisation.
    const silent = usageFromResponse({ prompt_tokens: 1000, completion_tokens: 20 });
    expect(silent.cache_read).toBeUndefined();
    expect(silent.cache_write).toBeUndefined();
    const reportedZero = usageFromResponse({ prompt_tokens: 1000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 0 }, cache_write_tokens: 0 });
    expect(reportedZero.cache_read).toBe(0);
    expect(reportedZero.cache_write).toBe(0);
  });

  it("the pricing: table prices the prompt in three parts — fresh, cache read, cache write", () => {
    // 100k fresh at $3/M, 800k read at 0.1×, 100k written at 1.25×, and no
    // output: the whole point of caching is that the same prompt costs a
    // tenth the second time, and the row has to show it.
    const u = usageFromResponse({ prompt_tokens: 1_000_000, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 800_000 }, cache_write_tokens: 100_000 });
    expect(costOf(u, cloud, "anthropic/claude-sonnet-5")).toEqual({ cost_usd: 0.3 + 0.24 + 0.375, source: "pricing" });
    // and with nothing cached it is exactly the pre-caching arithmetic
    expect(costOf(usageFromResponse({ prompt_tokens: 1_000_000, completion_tokens: 0 }), cloud, "anthropic/claude-sonnet-5")).toEqual({ cost_usd: 3, source: "pricing" });
  });

  it("a pricing: entry's own multipliers win over the Anthropic-via-OpenRouter defaults", () => {
    const other: Provider = {
      ...cloud,
      pricing: { "some/model": { in_per_m: 10, out_per_m: 30, cache_read_multiplier: 0.5, cache_write_multiplier: 2 } },
    };
    const u = usageFromResponse({ prompt_tokens: 1_000_000, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 500_000 }, cache_write_tokens: 200_000 });
    // 300k fresh at $10/M + 500k at 0.5× + 200k at 2×
    expect(costOf(u, other, "some/model")).toEqual({ cost_usd: 3 + 2.5 + 4, source: "pricing" });
  });

  it("a provider that reports more cached tokens than prompt tokens cannot produce a negative charge", () => {
    const u = usageFromResponse({ prompt_tokens: 1000, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 9_000_000 }, cache_write_tokens: 9_000_000 });
    const r = costOf(u, cloud, "anthropic/claude-sonnet-5");
    expect(r.source).toBe("pricing");
    expect(r.cost_usd).toBeGreaterThan(0);
    expect(r.cost_usd).toBeLessThanOrEqual((1000 / 1_000_000) * 3); // never more than the uncached prompt
  });

  it("an off-machine call nothing can price is $0 with source `unknown` — visible, never a guessed rate", () => {
    const r = costOf(usageFromResponse({ prompt_tokens: 100, completion_tokens: 10 }), cloud, "some/unlisted-model");
    expect(r).toEqual({ cost_usd: 0, source: "unknown" });
    expect(unpricedNote("openrouter", "some/unlisted-model")).toContain("providers.openrouter.pricing");
  });
});

const rows = (...r: SpendRow[]): SpendRow[] => r;
const budgets = (yaml: string) => parseCompute(yaml).budgets;

const FILE = `
providers:
  openrouter:
    kind: openai-compatible
    base_url: https://openrouter.ai/api/v1
    locality: off_machine
    data_policy: { allow: [Areas], deny_sources: [], max_brief_bytes: 1024 }
assignments:
  default: { model: openrouter/anthropic/claude-sonnet-5 }
  tiers:
    routine: { model: openrouter/anthropic/claude-haiku-4.5 }
budgets:
  instance: { daily_usd: 5, action: ACTION }
`;

describe("spend windows", () => {
  it("sums by the window flags Postgres set, not by a clock in this process", () => {
    const r = rows(
      { provider: "openrouter", is_today: true, is_this_month: true, cost_usd: "1.50" },
      { provider: "openrouter", is_today: false, is_this_month: true, cost_usd: 2 },
      { provider: "lmstudio", is_today: true, is_this_month: true, cost_usd: 0 },
      { provider: "openrouter", is_today: false, is_this_month: false, cost_usd: 99 },
    );
    expect(spentFrom(r)).toEqual({ daily: 1.5, monthly: 3.5 });
    expect(spentFrom(r, "lmstudio")).toEqual({ daily: 0, monthly: 0 });
  });
});

describe("budget actions", () => {
  const spent = (daily: number) => ({ instance: { daily, monthly: daily }, provider: { daily, monthly: daily } });

  it("stop refuses at the limit, and the refusal names the field AND the action that would relax it", () => {
    const v = checkBudgets({ budgets: budgets(FILE.replace("ACTION", "stop")), provider: "openrouter", spent: spent(5.01) });
    expect(v.allowed).toBe(false);
    const message = budgetRefusalMessage(v.refusal!);
    expect(message.startsWith(`${BUDGET_EXCEEDED}:`)).toBe(true);
    expect(message).toContain("budgets.instance.daily_usd");
    expect(message).toContain("budgets.instance.action: allow");
  });

  it("allow records and warns but never refuses — it is the `record only` setting", () => {
    const v = checkBudgets({ budgets: budgets(FILE.replace("ACTION", "allow")), provider: "openrouter", spent: spent(50) });
    expect(v.allowed).toBe(true);
    expect(v.warnings).toHaveLength(1);
    expect(budgetWarningMessage(v.warnings[0]!)).toContain("so calls continue");
  });

  it("critical_only lets a critical assignment through and stops everything else", () => {
    const over = { budgets: budgets(FILE.replace("ACTION", "critical_only")), provider: "openrouter", spent: spent(6) };
    expect(checkBudgets({ ...over, critical: false }).allowed).toBe(false);
    expect(checkBudgets({ ...over, critical: true }).allowed).toBe(true);
    expect(budgetRefusalMessage(checkBudgets(over).refusal!)).toContain("critical: true");
  });

  it("warns at 80% and not at 79%, with one key per calendar window", () => {
    const under = checkBudgets({ budgets: budgets(FILE.replace("ACTION", "stop")), provider: "openrouter", spent: spent(3.95) });
    expect(under.warnings).toHaveLength(0);
    const at = checkBudgets({ budgets: budgets(FILE.replace("ACTION", "stop")), provider: "openrouter", spent: spent(4) });
    expect(at.allowed).toBe(true);
    expect(at.warnings).toHaveLength(1);
    expect(budgetWarningMessage(at.warnings[0]!)).toContain("80%");
    const key = budgetWindowKey(at.warnings[0]!, new Date("2026-09-16T10:00:00Z"));
    expect(key).toBe("instance:daily:2026-09-16");
    expect(budgetWindowKey(at.warnings[0]!, new Date("2026-09-16T23:59:00Z"))).toBe(key); // same day, same key
    expect(budgetWindowKey(at.warnings[0]!, new Date("2026-09-17T00:01:00Z"))).not.toBe(key);
  });

  it("a provider's own budget is checked alongside the instance's, and names its own field", () => {
    const cfg = parseCompute(`${FILE.replace("ACTION", "allow")}
  providers: { openrouter: { monthly_usd: 20, action: stop } }
`);
    const v = checkBudgets({ budgets: cfg.budgets, provider: "openrouter", spent: { instance: { daily: 0, monthly: 0 }, provider: { daily: 0, monthly: 25 } } });
    expect(v.allowed).toBe(false);
    expect(v.refusal!.field).toBe("budgets.providers.openrouter.monthly_usd");
  });

  it("no budgets at all: nothing to check, nothing refused", () => {
    expect(checkBudgets({ budgets: undefined, provider: "openrouter", spent: { instance: { daily: 1e6, monthly: 1e6 }, provider: { daily: 1e6, monthly: 1e6 } } }).allowed).toBe(true);
  });
});

describe("the routine pause (preflight's budget half)", () => {
  const cfg = parseCompute(FILE.replace("ACTION", "stop"));

  it("returns a miss naming the compute.yaml field, with a fix that is not `set an env var`", () => {
    const miss = budgetMiss(cfg, rows({ provider: "openrouter", is_today: true, is_this_month: true, cost_usd: 7 }));
    expect(miss?.name).toBe("budgets.instance.daily_usd");
    expect(miss?.fix).toContain(BUDGET_EXCEEDED);
    expect(miss?.why).toContain("could not be answered");
    // the budget itself rides along, so the runner can key one request per window on it (C133, T3-12)
    expect(miss?.hit).toMatchObject({ scope: "instance", window: "daily", field: "budgets.instance.daily_usd", over: true, action: "stop" });
  });

  it("returns null under the limit, and null when the file sets no budgets at all", () => {
    expect(budgetMiss(cfg, rows({ provider: "openrouter", is_today: true, is_this_month: true, cost_usd: 1 }))).toBeNull();
    expect(budgetMiss(parseCompute("providers: {}"), rows({ is_today: true, is_this_month: true, cost_usd: 1e6 }))).toBeNull();
  });
});
