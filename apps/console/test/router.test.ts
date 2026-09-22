import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadRules, route } from "../src/router.js";

const rules = loadRules(readFileSync(new URL("../../../seed/rules.yaml", import.meta.url), "utf8"));

describe("router (invariant 4: deterministic)", () => {
  it("routes /status and natural phrasings to the fast path", () => {
    expect(route(rules, "/status")).toMatchObject({ kind: "fast_path", query: "open_work" });
    expect(route(rules, "what's my status")).toMatchObject({ kind: "fast_path" });
    expect(route(rules, "Whats the open work")).toMatchObject({ kind: "fast_path" });
  });

  it("bare text routes to the default tier, resolved to a (model, effort) PAIR", () => {
    expect(route(rules, "plan my week")).toMatchObject({ kind: "model", tier: "default", model: "haiku", effort: "medium", text: "plan my week" });
  });

  it("every seeded tier resolves to a model AND an effort; the seed ships fast/default/deep/routine", () => {
    expect(Object.keys(rules.tiers).sort()).toEqual(["deep", "default", "fast", "routine"]);
    for (const [name, tier] of Object.entries(rules.tiers)) {
      expect(tier.model, name).toBeTruthy();
      expect(["low", "medium", "high"], name).toContain(tier.effort);
    }
    expect(route(rules, "/model fast quick one")).toMatchObject({ tier: "fast", model: "haiku", effort: "low", routed_by: "override" });
    expect(route(rules, "/model routine assemble")).toMatchObject({ tier: "routine", model: "haiku", effort: "low" });
  });

  it("a tier with no effort defaults to medium, and an instance overlay moves the pair (D4: the last file wins, whole)", () => {
    const overlaid = loadRules("tiers: { default: { model: sonnet }, deep: { model: opus, effort: high } }");
    expect(route(overlaid, "anything")).toMatchObject({ tier: "default", model: "sonnet", effort: "medium" });
    expect(route(overlaid, "/deep x")).toMatchObject({ tier: "deep", model: "opus", effort: "high" });
  });

  it("a `tier` from the composer applies only where the default would have: never over /note, a command, or the fast path", () => {
    expect(route(rules, "plan my week", "deep")).toMatchObject({ kind: "model", tier: "deep", model: "opus", effort: "high", routed_by: "override" });
    expect(route(rules, "plan my week", "nonesuch")).toMatchObject({ tier: "default", routed_by: "rule" }); // unknown name ignored, never invented
    expect(route(rules, "/note buy milk", "deep")).toMatchObject({ kind: "note" });
    expect(route(rules, "/status", "deep")).toMatchObject({ kind: "fast_path" });
    expect(route(rules, "/model fast x", "deep")).toMatchObject({ tier: "fast" }); // the typed command wins
  });

  it("/deep and /model override the tier deterministically", () => {
    expect(route(rules, "/deep think hard about x")).toMatchObject({ kind: "model", tier: "deep", routed_by: "override", text: "think hard about x" });
    expect(route(rules, "/model deep same thing")).toMatchObject({ kind: "model", tier: "deep" });
  });

  it("an unknown /model tag falls through to default (never invents a tier)", () => {
    expect(route(rules, "/model gpt99 hello")).toMatchObject({ kind: "model", tier: "default" });
  });

  it("quoted command-like text mid-message does not trigger commands", () => {
    expect(route(rules, 'my friend said "/deep is a cool feature"')).toMatchObject({ kind: "model", tier: "default" });
  });

  it("rejects rules without a default tier or with a bad regex at load", () => {
    expect(() => loadRules("tiers: { deep: { model: x } }")).toThrow();
    expect(() => loadRules('fast_path: [{ match: "([", query: q }]\ntiers: { default: { model: x } }')).toThrow();
    expect(() => loadRules("tiers: { default: { model: x, effort: extreme } }")).toThrow();
    expect(() => loadRules("tiers: { default: { effort: low } }")).toThrow(); // a tier without a model is not a tier
  });
});

// The intent tier's thresholds (PoC-20 phase 1, research §3.2 P2). The router
// VALIDATES them and reads nothing: the misuse test the research asks for is
// that a bad line is a STARTUP failure, in the same parse that already refuses
// an uncompilable fast_path regex — never a surprise on the day somebody
// captures the wrong sentence.
describe("rules.yaml's intent: block fails at load, not per message", () => {
  const withIntent = (block: string) => `tiers: { default: { model: x } }\nintent:\n${block}`;

  it("loads a threshold and per-intent overrides", () => {
    const r = loadRules(withIntent("  min_confidence: 0.8\n  by_intent: { task_create: 0.95 }\n"));
    expect(r.intent?.min_confidence).toBe(0.8);
    expect(r.intent?.by_intent.task_create).toBe(0.95);
  });

  it("absent is the shipped default, and means the tier does not run", () => {
    expect(loadRules("tiers: { default: { model: x } }").intent).toBeUndefined();
    // the seeded file ships the block commented out
    expect(loadRules(readFileSync(new URL("../../../seed/rules.yaml", import.meta.url), "utf8")).intent).toBeUndefined();
  });

  it("refuses a threshold outside [0, 1]", () => {
    expect(() => loadRules(withIntent("  min_confidence: 1.4\n"))).toThrow(/rules.yaml/);
    expect(() => loadRules(withIntent("  min_confidence: 0.8\n  by_intent: { task_create: 12 }\n"))).toThrow(/between 0 and 1/);
  });

  it("refuses an intent this build does not know — invariant 10: a new one is a product change", () => {
    expect(() => loadRules(withIntent("  min_confidence: 0.8\n  by_intent: { book_a_flight: 0.9 }\n"))).toThrow(/not one of the intents/);
  });

  it("refuses a block with no threshold at all", () => {
    expect(() => loadRules(withIntent("  by_intent: {}\n"))).toThrow();
  });
});
