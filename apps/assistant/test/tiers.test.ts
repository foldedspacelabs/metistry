// resolveTurn: the ONE place a tier name becomes (provider, model, effort),
// and therefore the one place that decides which engine runs the turn. The
// precedence is the assertion — compute.yaml's assignments over a crew
// manifest over rules.yaml's tiers — because a half-applied precedence is
// how an install ends up paying a cloud for a tier it moved to a local model.
import { describe, expect, it } from "vitest";
import { emptyCompute, parseCompute, SDK_ENGINE_KIND, type TierMap } from "@foldedspacelabs/metistry-core";
import { resolveTurn } from "../src/tiers.js";
import { kindFor } from "../src/engine.js";

const rules: TierMap = {
  default: { model: "haiku", effort: "medium" },
  deep: { model: "opus", effort: "high" },
  routine: { model: "haiku", effort: "low" },
};

const FILE = `
providers:
  lmstudio: { kind: openai-compatible, base_url: "http://127.0.0.1:1234/v1", locality: on_machine }
  openrouter:
    kind: openai-compatible
    base_url: https://openrouter.ai/api/v1
    locality: off_machine
    data_policy: { allow: [Knowledge], deny_sources: [], max_brief_bytes: 1024 }
assignments:
  default: { model: openrouter/anthropic/claude-sonnet-5, effort: medium }
  tiers:
    routine: { model: lmstudio/google/gemma-3n-e4b, effort: low }
  crews:
    researcher: { model: lmstudio/google/gemma-3n-e4b }
`;

describe("resolveTurn precedence", () => {
  const cfg = parseCompute(FILE);

  it("compute.yaml assignments win, and carry the provider the engine is picked from", () => {
    const t = resolveTurn(cfg, rules, "routine");
    expect(t).toMatchObject({ tier: "routine", model: "google/gemma-3n-e4b", effort: "low" });
    expect(t.assignment?.provider).toBe("lmstudio");
    expect(kindFor(t)).toBe("openai-compatible");
  });

  it("an unknown tier lands on assignments.default, never on an invented model", () => {
    const t = resolveTurn(cfg, rules, "does-not-exist");
    expect(t).toMatchObject({ tier: "default", model: "anthropic/claude-sonnet-5" });
    expect(t.assignment?.provider).toBe("openrouter");
  });

  it("a crew resolves through assignments.crews and follows ITS provider, not the assistant's", () => {
    const t = resolveTurn(cfg, rules, "crew:researcher", { model: "sonnet", effort: "low" });
    expect(t.assignment?.provider).toBe("lmstudio");
    expect(t.model).toBe("google/gemma-3n-e4b");
  });

  it("an unassigned crew keeps its manifest's pair — the fallback beats rules.yaml", () => {
    const t = resolveTurn(cfg, rules, "crew:unassigned", { model: "sonnet", effort: "low" });
    expect(t.assignment?.provider).toBe("openrouter"); // assignments.default still covers it
    const none = resolveTurn(emptyCompute(), rules, "crew:unassigned", { model: "sonnet", effort: "low" });
    expect(none).toEqual({ tier: "crew:unassigned", model: "sonnet", effort: "low" });
    expect(kindFor(none)).toBe(SDK_ENGINE_KIND);
  });

  it("with no assignments at all, rules.yaml's tiers: are still the live map and the SDK still runs the turn", () => {
    const t = resolveTurn(emptyCompute(), rules, "deep");
    expect(t).toEqual({ tier: "deep", model: "opus", effort: "high" });
    expect(kindFor(t)).toBe(SDK_ENGINE_KIND);
    expect(resolveTurn(emptyCompute(), rules, "nope")).toEqual({ tier: "default", model: "haiku", effort: "medium" });
  });
});
