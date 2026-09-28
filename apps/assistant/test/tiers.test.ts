// resolveTurn: the ONE place a tier name becomes (provider, model, effort),
// and therefore the one place that decides which engine runs the turn. The
// precedence is the assertion — compute.yaml's assignments over a crew
// manifest over rules.yaml's tiers — because a half-applied precedence is
// how an install ends up paying a cloud for a tier it moved to a local model.
import { describe, expect, it } from "vitest";
import { emptyCompute, parseCompute, PrivateTierUnavailable, type TierMap } from "@foldedspacelabs/metistry-core";
import { captureSessionInScope, resolveTurn, resolveTurnFor } from "../src/tiers.js";
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
    expect(kindFor(none)).toBeUndefined(); // nothing assigns it, so no engine runs it (C2/C3)
  });

  it("with no assignments at all there is no engine — rules.yaml's tiers: still name a model, and nothing can serve one", () => {
    const t = resolveTurn(emptyCompute(), rules, "deep");
    expect(t).toEqual({ tier: "deep", model: "opus", effort: "high" });
    expect(kindFor(t)).toBeUndefined();
    expect(resolveTurn(emptyCompute(), rules, "nope")).toEqual({ tier: "default", model: "haiku", effort: "medium" });
  });
});

// T8-6's `turnTier`, wired (T8-2b): every turn with a capture session in scope
// resolves on the private tier — an on_machine provider — or is refused. The
// refusal is the assertion as much as the routing: with nowhere private to
// run, the turn must not land on `default`, on rules.yaml, or on a shadow.
describe("a capture session in scope runs on the private tier, with no fallback", () => {
  const PRIVATE = `
providers:
  lmstudio: { kind: openai-compatible, base_url: "http://127.0.0.1:1234/v1", locality: on_machine }
  openrouter:
    kind: openai-compatible
    base_url: https://openrouter.ai/api/v1
    locality: off_machine
    data_policy: { allow: [Knowledge], deny_sources: [], max_brief_bytes: 1024 }
assignments:
  default:
    model: openrouter/anthropic/claude-sonnet-5
    effort: medium
    shadow: { model: openrouter/openai/gpt-6, fraction: 1 }
  tiers:
    deep: { model: openrouter/anthropic/claude-opus-5, effort: high }
    private: { model: lmstudio/google/gemma-3n-e4b, effort: low }
`;

  it("whatever was chosen — deep, default, a routine, nothing — the turn resolves on the private tier's on_machine provider", () => {
    const cfg = parseCompute(PRIVATE);
    for (const chosen of ["deep", "default", "routine", "does-not-exist", null, undefined]) {
      const t = resolveTurnFor(cfg, rules, chosen, { captureSession: true });
      expect(t, String(chosen)).toMatchObject({ tier: "private", model: "google/gemma-3n-e4b", effort: "low" });
      expect(t.assignment?.provider).toBe("lmstudio");
      expect(t.assignment?.config.locality).toBe("on_machine");
      expect(t.assignment?.shadow, "a shadow would run the turn a second time elsewhere").toBeUndefined();
    }
    // out of scope, the choice stands
    expect(resolveTurnFor(cfg, rules, "deep", { captureSession: false }).assignment?.provider).toBe("openrouter");
  });

  it("refused — never moved — when compute.yaml assigns no private tier, even with a default and rules.yaml both there to fall back to", () => {
    const noPrivate = parseCompute(PRIVATE.replace(/^ {4}private: .*$/m, ""));
    expect(noPrivate.assignments?.tiers.private).toBeUndefined();
    expect(() => resolveTurnFor(noPrivate, rules, "deep", { captureSession: true })).toThrow(PrivateTierUnavailable);
    expect(() => resolveTurnFor(noPrivate, rules, null, { captureSession: true })).toThrow(/never falls back to default/);
    // nothing assigned at all: rules.yaml names a model, and it is still refused
    expect(() => resolveTurnFor(emptyCompute(), rules, "default", { captureSession: true })).toThrow(PrivateTierUnavailable);
  });

  it("refused when the private tier's provider is switched off — at load, and again for an object that never met the schema", () => {
    expect(() => parseCompute(PRIVATE.replace("locality: on_machine }", "locality: on_machine, enabled: false }"))).toThrow(/switched off/);
    const cfg = parseCompute(PRIVATE);
    const off = { ...cfg, providers: { ...cfg.providers, lmstudio: { ...cfg.providers.lmstudio!, enabled: false } } };
    expect(() => resolveTurnFor(off, rules, "deep", { captureSession: true })).toThrow(/switched off/);
  });

  it("an off-machine private tier cannot even be loaded — the schema refuses it before a turn could meet it", () => {
    expect(() => parseCompute(PRIVATE.replace("private: { model: lmstudio/", "private: { model: openrouter/"))).toThrow(/on_machine/);
  });

  it("the marker: capture_session on the row or its route — and any value but null counts, so a bad marker only ever keeps a turn home", () => {
    expect(captureSessionInScope({ capture_session: "20260928-120000-00ab" })).toBe(true);
    expect(captureSessionInScope({ route: { kind: "model", tier: "deep", capture_session: "20260928-120000-00ab" } })).toBe(true);
    for (const odd of ["", 0, false, {}, []]) expect(captureSessionInScope({ capture_session: odd }), JSON.stringify(odd)).toBe(true);
    for (const none of [null, undefined, {}, { capture_session: null }, { route: null }, { route: { tier: "deep" } }, "capture_session", 7]) {
      expect(captureSessionInScope(none), JSON.stringify(none)).toBe(false);
    }
  });
});
