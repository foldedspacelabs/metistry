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

  it("bare text routes to the default tier", () => {
    expect(route(rules, "plan my week")).toMatchObject({ kind: "model", tier: "default", text: "plan my week" });
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
  });
});
