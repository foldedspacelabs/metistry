// The router's policy (T9-2; docs/ops/dynamic-router.md §2–§5), unit by unit.
//
// T9-2's own tests, in bold in the spec's §8:
//
//   **no output outside the allow-list, over a generated feature space and
//   arbitrary scorer answers; a failure or a timeout takes the default**
//
// — plus "every §4 refusal names its field". The feature space is generated
// exhaustively where it is small and by a seeded PRNG where it is not, so a
// failure reproduces byte for byte. The console-side half (the consultation's
// deadline, the record, the door) is apps/console/test/router-policy.test.ts.
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { codesFor } from "../src/choice.js";
import { parseCompute, type Compute } from "../src/compute.js";
import { INTENT_NAMES, INTENT_UNSURE, intentRulesSchema, isIntent } from "../src/intent.js";
import {
  COMPLEXITY,
  COMPLEXITY_NAMES,
  COMPLEXITY_OPTIONS,
  ROUTE_OPERATIONS,
  boundDecision,
  complexityMessages,
  complexityValue,
  decide,
  intentValue,
  isComplexity,
  operationTools,
  parseOperation,
  policyReads,
  scoreRouteFeatures,
  scorerTimeoutMs,
  tierTarget,
  validateRoutePolicy,
  type BoundedDecision,
  type BoundsContext,
  type ComplexityFeature,
  type IntentFeature,
  type PolicyContext,
  type PolicyFeatures,
  type RoutePolicyConfig,
} from "../src/router-policy.js";
import type { ModelAccess } from "../src/score-choice.js";
import type { TierMap } from "../src/tiers.js";

// ---- fixtures ------------------------------------------------------------------

const CTX: PolicyContext = { tiers: ["fast", "default", "deep", "routine"], fastPathQueries: ["open_work"], intentRules: true };

/** The spec's own example (§4), verbatim. */
const EXAMPLE = `
mode: shadow
tiers: [fast, default, deep]
timeout_ms: 400
caps:
  tool_calls: 12
  tokens: 150000
  cost_usd: 0.50
complexity:
  min_confidence: 0.70
table:
  - id: status
    when: { intent: [status_open_work, task_list], words: { max: 15 } }
    then: { operation: "fast_path:open_work" }
  - id: small-talk
    when: { intent: smalltalk }
    then: { operation: answer, tier: fast }
  - id: the-record
    when: { intent: knowledge_search }
    then: { operation: "retrieve:knowledge", tier: default, tool_calls: 4 }
  - id: struggling
    when: { reask: true }
    then: { operation: tools, tier: deep }
  - id: by-complexity
    when: { complexity: [simple, moderate, demanding] }
    then: { operation: tools, tier: { simple: fast, moderate: default, demanding: deep } }
`;

function valid(yamlText: string, ctx: PolicyContext = CTX): RoutePolicyConfig {
  const r = validateRoutePolicy(parseYaml(yamlText), ctx);
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r.policy;
}

const example = valid(EXAMPLE);

/** The example as an object, for mutation in the refusal table. */
const exampleDoc = (): any => parseYaml(EXAMPLE);

const COMPUTE: Compute = parseCompute(`
providers:
  ollama: { kind: openai-compatible, base_url: http://127.0.0.1:11434/v1, locality: on_machine }
assignments:
  default: { model: ollama/small-model, effort: medium }
  tiers:
    fast: { model: ollama/small-model, effort: low }
    deep: { model: ollama/big-model, effort: high }
  intent: { model: ollama/gemma4:e4b-it-qat }
`);
const TIERS: TierMap = { fast: { model: "haiku", effort: "low" }, default: { model: "haiku", effort: "medium" }, deep: { model: "opus", effort: "high" }, routine: { model: "haiku", effort: "low" } };

const bounds = (over: Partial<BoundsContext> = {}): BoundsContext => ({
  session: { active: false, provider: null, model: null },
  resolve: (t) => tierTarget(COMPUTE, TIERS, t),
  hasQuery: () => true,
  hasCrew: () => true,
  ...over,
});

/** mulberry32: a seeded PRNG, so a generated case that fails fails again the same way. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

// ---- the closed vocabularies ---------------------------------------------------

describe("the planner's classes (§2)", () => {
  it("three, closed, in PoC-15's order, each a present-tense statement about the text — never a tier, a model or an instruction", () => {
    expect(COMPLEXITY_NAMES).toEqual(["simple", "moderate", "demanding"]);
    for (const c of COMPLEXITY) {
      expect(c.description).toMatch(/^it /);
      for (const word of ["haiku", "opus", "sonnet", "tier", "model", "effort", "fast", "deep", "route", "should", "escalate"]) expect(c.description.toLowerCase()).not.toContain(word);
    }
    expect(isComplexity("demanding")).toBe(true);
    expect(isComplexity("deep")).toBe(false);
    expect(isComplexity("__proto__")).toBe(false);
  });

  it("asks through the intent tier's own prompt builder, with generated codes", () => {
    const [system, user] = complexityMessages("plan the move around three deadlines", { now: new Date("2026-09-26T00:00:00Z") });
    expect(user).toEqual({ role: "user", content: "plan the move around three deadlines" });
    expect(system!.content).toContain("Which line below describes what the message says?");
    const codes = codesFor(3);
    COMPLEXITY_OPTIONS.forEach((o, i) => expect(system!.content).toContain(`${codes[i]} = ${o.description}`));
    expect(system!.content).toContain("Answer with one letter and nothing else.");
  });
});

describe("the operation vocabulary (§3)", () => {
  it("parses the six forms, spelled exactly, and nothing else", () => {
    expect(ROUTE_OPERATIONS).toEqual(["answer", "fast_path:<query>", "retrieve:knowledge", "retrieve:queries", "delegate:<crew>", "tools"]);
    expect(parseOperation("answer")).toEqual({ form: "answer" });
    expect(parseOperation("tools")).toEqual({ form: "tools" });
    expect(parseOperation("retrieve:knowledge")).toEqual({ form: "retrieve:knowledge" });
    expect(parseOperation("retrieve:queries")).toEqual({ form: "retrieve:queries" });
    expect(parseOperation("fast_path:open_work")).toEqual({ form: "fast_path:<query>", query: "open_work" });
    expect(parseOperation("delegate:research-crew")).toEqual({ form: "delegate:<crew>", crew: "research-crew" });
    for (const bad of ["", "Answer", "tools ", "retrieve", "retrieve:web", "fast_path:", "fast_path:Open Work", "delegate:", "delegate:../x", "shell", "tools:all", "fast_path:a:b", 42, null, undefined]) {
      expect(parseOperation(bad), String(bad)).toBeUndefined();
    }
  });
});

// ---- the table: load-time refusals (§4) ----------------------------------------

describe("operationTools (§3): what a served turn may execute, a subset of the whole surface", () => {
  it("tools is the whole surface; answer and a fast path none; the rest their lists, and delegate carries the vault reads to write the brief", () => {
    const tools = (s: string) => operationTools(parseOperation(s)!);
    expect(tools("tools")).toBeUndefined();
    expect(tools("answer")).toEqual([]);
    expect(tools("fast_path:open_work")).toEqual([]);
    expect(tools("retrieve:knowledge")).toEqual(["knowledge_search", "knowledge_read", "knowledge_list", "knowledge_grep"]);
    expect(tools("retrieve:queries")).toEqual(["queries_list", "queries_run"]);
    expect(tools("delegate:reviewer")).toEqual(["agents_delegate", "knowledge_search", "knowledge_read", "knowledge_list", "knowledge_grep"]);
  });
});

describe("validateRoutePolicy (§4)", () => {
  it("accepts the spec's example and fills the defaults", () => {
    expect(example).toMatchObject({ mode: "shadow", tiers: ["fast", "default", "deep"], timeout_ms: 400, caps: { tool_calls: 12, tokens: 150000, cost_usd: 0.5 }, complexity: { min_confidence: 0.7 } });
    expect(example.table.map((r) => r.id)).toEqual(["status", "small-talk", "the-record", "struggling", "by-complexity"]);
    expect(example.table[0]!.when).toEqual({ intent: ["status_open_work", "task_list"], words: { max: 15 } });
    expect(example.table[1]!.when).toEqual({ intent: ["smalltalk"] });
    const d = exampleDoc();
    delete d.mode;
    delete d.timeout_ms;
    expect(validateRoutePolicy(d, CTX)).toMatchObject({ ok: true, policy: { mode: "shadow", timeout_ms: 400 } });
  });

  it("mode: serve is the owner's to write since T9-4 wired the composer (§7.3); anything else is still refused", () => {
    const d = exampleDoc();
    d.mode = "serve";
    expect(validateRoutePolicy(d, CTX)).toMatchObject({ ok: true, policy: { mode: "serve" } });
  });

  it("reads the model features only where a row reads them — a tier map reads complexity", () => {
    expect(policyReads(example)).toEqual({ intent: true, complexity: true });
    const cheap = valid(`
tiers: [default, deep]
caps: { tool_calls: 4, tokens: 1000, cost_usd: 0.1 }
table:
  - { id: long, when: { words: { min: 200 } }, then: { operation: tools, tier: deep } }
`);
    expect(policyReads(cheap)).toEqual({ intent: false, complexity: false });
    const mapOnly = valid(`
tiers: [fast, deep]
caps: { tool_calls: 4, tokens: 1000, cost_usd: 0.1 }
complexity: { min_confidence: 0.5 }
table:
  - { id: any, then: { operation: tools, tier: { simple: fast, moderate: fast, demanding: deep } } }
`);
    expect(policyReads(mapOnly)).toEqual({ intent: false, complexity: true });
  });

  // Every refusal of §4, each with the field it must name.
  const REFUSALS: Array<[string, (d: any) => void, string, RegExp?, PolicyContext?]> = [
    ["an unknown key at the top", (d) => (d.budget = 3), "policy.budget", /unknown key/],
    ["an unknown key in caps", (d) => (d.caps.retries = 3), "policy.caps.retries", /unknown key/],
    ["an unknown key in complexity", (d) => (d.complexity.model = "x"), "policy.complexity.model", /unknown key/],
    ["an unknown key in a row", (d) => (d.table[0].model = "opus"), "policy.table[0].model", /unknown key/],
    ["an unknown key in when", (d) => (d.table[1].when.text = "hello"), "policy.table[1].when.text", /unknown key/],
    ["an unknown key in then", (d) => (d.table[1].then.model = "opus"), "policy.table[1].then.model", /unknown key/],
    ["an unknown key in a tier map", (d) => (d.table[4].then.tier.trivial = "fast"), "policy.table[4].then.tier.trivial", /unknown key/],
    ["an unknown key in a range", (d) => (d.table[0].when.words.below = 3), "policy.table[0].when.words.below", /unknown key/],
    ["a policy tier outside tiers:", (d) => (d.tiers = ["fast", "gpt99"]), "policy.tiers[1]", /not a key of tiers:/],
    ["a tier listed twice", (d) => (d.tiers = ["fast", "default", "fast", "deep"]), "policy.tiers[2]", /twice/],
    ["an empty allow-list", (d) => (d.tiers = []), "policy.tiers", /may not be empty/],
    ["a row tier outside policy.tiers", (d) => (d.table[1].then.tier = "routine"), "policy.table[1].then.tier", /not in policy.tiers/],
    ["a row tier outside tiers: altogether", (d) => (d.table[1].then.tier = "opus"), "policy.table[1].then.tier", /not in policy.tiers/],
    ["a tier-map value outside policy.tiers", (d) => (d.table[4].then.tier.demanding = "routine"), "policy.table[4].then.tier.demanding", /not in policy.tiers/],
    ["an operation outside the vocabulary", (d) => (d.table[3].then.operation = "shell"), "policy.table[3].then.operation", /not an operation/],
    ["an operation almost in the vocabulary", (d) => (d.table[3].then.operation = "Tools"), "policy.table[3].then.operation", /not an operation/],
    ["a fast path no fast_path: rule names", (d) => (d.table[0].then.operation = "fast_path:all_secrets"), "policy.table[0].then.operation", /no fast_path: rule names/],
    ["tool_calls above the cap", (d) => (d.table[2].then.tool_calls = 13), "policy.table[2].then.tool_calls", /above caps.tool_calls/],
    ["tool_calls on answer", (d) => (d.table[1].then.tool_calls = 1), "policy.table[1].then.tool_calls", /makes no tool calls/],
    ["tool_calls on a fast path", (d) => (d.table[0].then.tool_calls = 1), "policy.table[0].then.tool_calls", /makes no tool calls/],
    ["a negative tool_calls", (d) => (d.table[2].then.tool_calls = -1), "policy.table[2].then.tool_calls"],
    ["a tier map missing a class", (d) => delete d.table[4].then.tier.demanding, "policy.table[4].then.tier.demanding", /all three classes/],
    ["a tier on a fast path", (d) => (d.table[0].then.tier = "fast"), "policy.table[0].then.tier", /takes no tier/],
    ["no tier on a model operation", (d) => delete d.table[3].then.tier, "policy.table[3].then.tier", /names a tier/],
    ["a row reading intent with no intent: block", () => {}, "policy.table[0].when.intent", /no intent: block/, { ...CTX, intentRules: false }],
    ["an intent outside the enum", (d) => (d.table[1].when.intent = "banter"), "policy.table[1].when.intent", /one of: task_create/],
    ["a complexity outside the enum", (d) => (d.table[4].when.complexity = ["simple", "deep"]), "policy.table[4].when.complexity", /one of: simple, moderate, demanding/],
    ["a row reading complexity with no min_confidence", (d) => delete d.complexity, "policy.complexity.min_confidence", /required/],
    ["min_confidence above 1", (d) => (d.complexity.min_confidence = 1.2), "policy.complexity.min_confidence", /between 0 and 1/],
    ["a mode that is neither", (d) => (d.mode = "live"), "policy.mode", /shadow or serve/],
    ["timeout_ms below 50", (d) => (d.timeout_ms = 49), "policy.timeout_ms", /50–2000/],
    ["timeout_ms above 2000", (d) => (d.timeout_ms = 2001), "policy.timeout_ms", /50–2000/],
    ["a fractional timeout_ms", (d) => (d.timeout_ms = 400.5), "policy.timeout_ms"],
    ["no caps at all", (d) => delete d.caps, "policy.caps", /required/],
    ["no caps.tool_calls", (d) => delete d.caps.tool_calls, "policy.caps.tool_calls", /required/],
    ["no caps.tokens", (d) => delete d.caps.tokens, "policy.caps.tokens", /required/],
    ["no caps.cost_usd", (d) => delete d.caps.cost_usd, "policy.caps.cost_usd", /required/],
    ["caps.tokens of 0", (d) => (d.caps.tokens = 0), "policy.caps.tokens", /above 0/],
    ["caps.cost_usd of 0", (d) => (d.caps.cost_usd = 0), "policy.caps.cost_usd", /above 0/],
    ["a row with no id", (d) => delete d.table[2].id, "policy.table[2].id", /every row has an id/],
    ["an id that is not kebab-case", (d) => (d.table[2].id = "The Record"), "policy.table[2].id", /kebab-case/],
    ["an id used twice", (d) => (d.table[2].id = "status"), "policy.table[2].id", /earlier row/],
    ["an empty range", (d) => (d.table[0].when.words = {}), "policy.table[0].when.words", /min, max or both/],
    ["a range that can never match", (d) => (d.table[0].when.words = { min: 10, max: 2 }), "policy.table[0].when.words", /never match/],
    ["reask that is not a boolean", (d) => (d.table[3].when.reask = "yes"), "policy.table[3].when.reask", /true or false/],
    ["a row with no then", (d) => delete d.table[3].then, "policy.table[3].then"],
  ];

  for (const [what, mutate, field, message, ctx] of REFUSALS) {
    it(`every §4 refusal names its field: ${what} → ${field}`, () => {
      const d = exampleDoc();
      mutate(d);
      const r = validateRoutePolicy(d, ctx ?? CTX);
      expect(r.ok, what).toBe(false);
      if (r.ok) return;
      const hit = r.errors.find((e) => e.startsWith(`${field}:`));
      expect(hit, `${what}: ${r.errors.join(" | ")}`).toBeDefined();
      if (message) expect(hit).toMatch(message);
    });
  }
});

// ---- evaluation ----------------------------------------------------------------

const f = (over: Partial<PolicyFeatures> = {}): PolicyFeatures => ({ words: 9, attachments: 0, thread_turns: 0, recent_failures: 0, reask: false, ...over });

describe("decide (§4): the first matching row, over the features, pure", () => {
  it("first match wins, and each row's choice is exactly what it says", () => {
    expect(decide(example, f({ intent: "status_open_work", words: 4 }))).toEqual({ outcome: "chosen", row: "status", chosen: { operation: "fast_path:open_work" } });
    expect(decide(example, f({ intent: "smalltalk" }))).toEqual({ outcome: "chosen", row: "small-talk", chosen: { operation: "answer", tier: "fast" } });
    expect(decide(example, f({ intent: "knowledge_search", reask: true }))).toEqual({ outcome: "chosen", row: "the-record", chosen: { operation: "retrieve:knowledge", tier: "default", tool_calls: 4 } });
    expect(decide(example, f({ reask: true }))).toEqual({ outcome: "chosen", row: "struggling", chosen: { operation: "tools", tier: "deep", tool_calls: 12 } });
    expect(decide(example, f({ complexity: "demanding" }))).toEqual({ outcome: "chosen", row: "by-complexity", chosen: { operation: "tools", tier: "deep", tool_calls: 12 } });
    expect(decide(example, f({ complexity: "simple" }))).toMatchObject({ chosen: { tier: "fast" } });
  });

  it("a condition on an absent feature is false, never true — a scorer that is down skips its rows and the next rows still apply", () => {
    // the words bound holds but intent is absent: `status` does not fire
    expect(decide(example, f({ words: 3 }))).toEqual({ outcome: "no_match" });
    // reask absent (the features query failed) does not match `reask: true`, nor would it match `reask: false`
    expect(decide(example, f({ reask: undefined, complexity: "moderate" }))).toMatchObject({ row: "by-complexity" });
    const onlyFalse = valid(`
tiers: [default, deep]
caps: { tool_calls: 4, tokens: 1000, cost_usd: 0.1 }
table:
  - { id: calm, when: { reask: false, thread_turns: { max: 3 } }, then: { operation: answer, tier: default } }
`);
    expect(decide(onlyFalse, f({ reask: undefined }))).toEqual({ outcome: "no_match" });
    expect(decide(onlyFalse, f({ thread_turns: undefined }))).toEqual({ outcome: "no_match" });
    expect(decide(onlyFalse, f({ thread_turns: 3 }))).toMatchObject({ outcome: "chosen" });
  });

  it("a tier map does not match while complexity is absent, and no row is no_match", () => {
    expect(decide(example, f())).toEqual({ outcome: "no_match" });
    const unconditional = valid(`
tiers: [fast, default, deep]
caps: { tool_calls: 4, tokens: 1000, cost_usd: 0.1 }
complexity: { min_confidence: 0.5 }
table:
  - { id: by-class, then: { operation: tools, tier: { simple: fast, moderate: default, demanding: deep } } }
  - { id: fallback, then: { operation: tools, tier: default, tool_calls: 2 } }
`);
    expect(decide(unconditional, f())).toEqual({ outcome: "chosen", row: "fallback", chosen: { operation: "tools", tier: "default", tool_calls: 2 } });
  });

  it("the intent feature is the verdict at or over the owner's threshold, `unsure` below it, absent otherwise", () => {
    expect(intentValue({ outcome: "scored", intent: "smalltalk", confidence: 0.9 })).toBe("smalltalk");
    expect(intentValue({ outcome: "below_threshold", intent: "smalltalk", confidence: 0.4 })).toBe(INTENT_UNSURE);
    expect(intentValue({ outcome: "guarded", reason: "too_long" })).toBeUndefined();
    expect(intentValue({ outcome: "unavailable" })).toBeUndefined();
    expect(intentValue({ outcome: "scored", intent: "deep" as never })).toBeUndefined();
    expect(complexityValue({ outcome: "scored", class: "demanding", confidence: 0.9 })).toBe("demanding");
    expect(complexityValue({ outcome: "below_threshold", class: "demanding", confidence: 0.4 })).toBeUndefined();
    expect(complexityValue({ outcome: "scored", class: "toString" as never })).toBeUndefined();
  });
});

// ---- the bounds ----------------------------------------------------------------

describe("boundDecision (§1, §5): the session and the registries, at run time", () => {
  const deep = decide(example, f({ reask: true }));
  const fastAnswer = decide(example, f({ intent: "smalltalk" }));

  it("a new thread is free", () => {
    expect(boundDecision(example, deep, bounds())).toEqual(deep);
  });

  it("an active session keeps its model: another model is out_of_bounds (session), an effort-only variant is not", () => {
    const onSmall = bounds({ session: { active: true, provider: "ollama", model: "small-model" } });
    expect(boundDecision(example, deep, onSmall)).toEqual({ outcome: "out_of_bounds", row: "struggling", chosen: { operation: "tools", tier: "deep", tool_calls: 12 }, bounded_by: "session" });
    // fast is (small-model, low): the same model as the session, a different effort
    expect(boundDecision(example, fastAnswer, onSmall)).toEqual(fastAnswer);
    const onBig = bounds({ session: { active: true, provider: "ollama", model: "big-model" } });
    expect(boundDecision(example, deep, onBig)).toEqual(deep);
    expect(boundDecision(example, fastAnswer, onBig)).toMatchObject({ outcome: "out_of_bounds", bounded_by: "session" });
    // the same model id on another provider is another model
    expect(boundDecision(example, deep, bounds({ session: { active: true, provider: "lmstudio", model: "big-model" } }))).toMatchObject({ bounded_by: "session" });
  });

  it("an active session whose model is not on record (an Agent SDK session) may take only what the rules' default runs on", () => {
    const sdk = bounds({ session: { active: true, provider: null, model: null }, resolve: (t) => tierTarget(undefined, TIERS, t) });
    // default = haiku; deep = opus
    expect(boundDecision(example, deep, sdk)).toMatchObject({ outcome: "out_of_bounds", bounded_by: "session" });
    expect(boundDecision(example, fastAnswer, sdk)).toEqual(fastAnswer); // fast = haiku/low
  });

  it("a fast path runs no model, so the session does not hold it; its query must be loaded now", () => {
    const status = decide(example, f({ intent: "task_list", words: 3 }));
    expect(boundDecision(example, status, bounds({ session: { active: true, provider: "x", model: "y" } }))).toEqual(status);
    expect(boundDecision(example, status, bounds({ hasQuery: () => false }))).toEqual({ outcome: "out_of_bounds", row: "status", chosen: { operation: "fast_path:open_work" }, bounded_by: "queries" });
  });

  it("a crew must be loaded now", () => {
    const p = valid(`
tiers: [default]
caps: { tool_calls: 4, tokens: 1000, cost_usd: 0.1 }
table:
  - { id: hand-off, then: { operation: "delegate:research", tier: default } }
`);
    const d = decide(p, f());
    expect(boundDecision(p, d, bounds({ hasCrew: (c) => c === "research" }))).toEqual(d);
    expect(boundDecision(p, d, bounds({ hasCrew: () => false }))).toMatchObject({ outcome: "out_of_bounds", bounded_by: "crew_registry" });
  });

  it("a decision the table could not have produced is a THROW — a failed consultation, the rules' default — never a choice", () => {
    const forged = [
      { operation: "tools", tier: "routine" }, // in tiers:, not in the allow-list
      { operation: "tools", tier: "gpt99" },
      { operation: "tools" }, // a model operation with no tier
      { operation: "fast_path:open_work", tier: "deep" },
      { operation: "tools", tier: "deep", tool_calls: 13 },
      { operation: "answer", tier: "fast", tool_calls: 1 },
      { operation: "shell", tier: "deep" },
    ];
    for (const chosen of forged) {
      expect(() => boundDecision(example, { outcome: "chosen", row: "forged", chosen: chosen as never }, bounds()), JSON.stringify(chosen)).toThrow();
    }
    expect(boundDecision(example, { outcome: "no_match" }, bounds())).toEqual({ outcome: "no_match" });
  });

  it("tierTarget resolves a tier exactly as the drain does: assignments, then default; no assignments, rules.yaml's tiers", () => {
    expect(tierTarget(COMPUTE, TIERS, "deep")).toEqual({ provider: "ollama", model: "big-model" });
    expect(tierTarget(COMPUTE, TIERS, "routine")).toEqual({ provider: "ollama", model: "small-model" }); // unassigned → default
    expect(tierTarget(undefined, TIERS, "deep")).toEqual({ provider: null, model: "opus" });
    expect(tierTarget(parseCompute("providers: {}"), TIERS, "nonesuch")).toEqual({ provider: null, model: "haiku" });
  });
});

// ---- the bold test --------------------------------------------------------------

/**
 * Every property "no output outside the allow-list" means, for one decision:
 * the reason it is outside, or undefined. A plain function rather than a run
 * of `expect`s, because the exhaustive space below calls it half a million
 * times.
 */
function outside(policy: RoutePolicyConfig, d: BoundedDecision, ctx: { fastPathQueries: readonly string[] }): string | undefined {
  if (d.outcome === "no_match") return undefined;
  if (d.outcome !== "chosen" && d.outcome !== "out_of_bounds") return `outcome ${String((d as { outcome: unknown }).outcome)}`;
  if (!policy.table.some((r) => r.id === d.row)) return `row ${d.row} is not in the table`;
  const op = parseOperation(d.chosen.operation);
  if (!op) return `operation ${d.chosen.operation} is outside the vocabulary`;
  if (!Object.keys(d.chosen).every((k) => ["operation", "tier", "tool_calls"].includes(k))) return `the choice carries ${Object.keys(d.chosen).join(",")}`;
  if (op.form === "fast_path:<query>") {
    if (d.chosen.tier !== undefined) return "a fast path carries a tier";
    if (!ctx.fastPathQueries.includes(op.query)) return `fast path ${op.query} is not a fast_path: query`;
  } else if (typeof d.chosen.tier !== "string" || !policy.tiers.includes(d.chosen.tier)) {
    return `tier ${String(d.chosen.tier)} is outside policy.tiers`;
  }
  const n = d.chosen.tool_calls;
  if (n !== undefined && (!Number.isInteger(n) || n < 0 || n > policy.caps.tool_calls)) return `tool_calls ${n} is outside caps.tool_calls`;
  if ((op.form === "answer" || op.form === "fast_path:<query>") && n !== undefined) return `${op.form} carries tool_calls`;
  return undefined;
}

/** A random VALID policy: the property has to hold for any table the owner can write, not just the example. */
function randomPolicy(r: () => number): RoutePolicyConfig {
  const allow = CTX.tiers.filter(() => r() < 0.6);
  const tiers = allow.length > 0 ? allow : ["default"];
  const cap = Math.floor(r() * 20);
  const rows: unknown[] = [];
  const n = 1 + Math.floor(r() * 6);
  for (let i = 0; i < n; i++) {
    const when: Record<string, unknown> = {};
    if (r() < 0.4) when.intent = r() < 0.5 ? pick(r, INTENT_NAMES) : INTENT_NAMES.filter(() => r() < 0.3).concat(pick(r, INTENT_NAMES));
    if (r() < 0.3) when.complexity = pick(r, COMPLEXITY_NAMES);
    for (const k of ["words", "attachments", "thread_turns", "recent_failures"]) {
      if (r() < 0.25) {
        const lo = Math.floor(r() * 20);
        when[k] = r() < 0.5 ? { min: lo } : { min: lo, max: lo + Math.floor(r() * 40) };
      }
    }
    if (r() < 0.2) when.reask = r() < 0.5;
    const form = pick(r, ["answer", "fast_path:open_work", "retrieve:knowledge", "retrieve:queries", "delegate:research", "tools"]);
    const then: Record<string, unknown> = { operation: form };
    if (form !== "fast_path:open_work") {
      then.tier = r() < 0.3 ? { simple: pick(r, tiers), moderate: pick(r, tiers), demanding: pick(r, tiers) } : pick(r, tiers);
      if (form !== "answer" && r() < 0.5) then.tool_calls = Math.floor(r() * (cap + 1));
    }
    rows.push({ id: `row-${i}`, when, then });
  }
  const res = validateRoutePolicy({ tiers, caps: { tool_calls: cap, tokens: 1000, cost_usd: 0.25 }, complexity: { min_confidence: r() }, table: rows }, CTX);
  if (!res.ok) throw new Error(`generator made an invalid policy: ${res.errors.join("; ")}`);
  return res.policy;
}

/** Arbitrary scorer answers, as the record would hold them — including ones no real scorer returns. */
function arbitraryIntent(r: () => number): IntentFeature | undefined {
  if (r() < 0.2) return undefined;
  return {
    outcome: pick(r, ["scored", "below_threshold", "guarded", "unavailable", "bogus"] as never[]),
    intent: pick(r, [...INTENT_NAMES, "deep", "__proto__", "constructor", "", undefined] as never[]),
    confidence: pick(r, [0, 0.3, 0.8, 1, Number.NaN, -1, 7]),
  };
}
function arbitraryComplexity(r: () => number): ComplexityFeature | undefined {
  if (r() < 0.2) return undefined;
  return {
    outcome: pick(r, ["scored", "below_threshold", "guarded", "unavailable", "bogus"] as never[]),
    class: pick(r, [...COMPLEXITY_NAMES, "deep", "__proto__", "hasOwnProperty", "DEMANDING", undefined] as never[]),
    confidence: pick(r, [0, 0.5, 0.99, Number.NaN]),
  };
}

describe("**no output outside the allow-list, over a generated feature space and arbitrary scorer answers**", () => {
  // Every feature at its edges, absent included, and garbage where a value
  // could only arrive by a bug — the table must never turn one into a choice.
  const WORDS = [0, 8, 15, 16, 10_000, Number.NaN];
  const COUNTS = [undefined, 0, 3, 50, -1];
  const REASK = [undefined, true, false, "true" as never];
  const INTENTS = [undefined, ...INTENT_NAMES, "deep" as never, "__proto__" as never, "constructor" as never];
  const CLASSES = [undefined, ...COMPLEXITY_NAMES, "deep" as never, "__proto__" as never, "toString" as never];
  const SESSIONS: BoundsContext["session"][] = [
    { active: false, provider: null, model: null },
    { active: true, provider: "ollama", model: "small-model" },
    { active: true, provider: "ollama", model: "big-model" },
    { active: true, provider: null, model: null },
    { active: true, provider: "elsewhere", model: "other" },
  ];

  it("the spec's table, exhaustively: every feature combination × every session × both registry states", () => {
    let n = 0;
    const seen = new Set<string>();
    const violations: string[] = [];
    for (const words of WORDS)
      for (const thread_turns of COUNTS)
        for (const recent_failures of [undefined, 0, 5])
          for (const reask of REASK)
            for (const intent of INTENTS)
              for (const complexity of CLASSES) {
                const features: PolicyFeatures = { words, attachments: 0, thread_turns, recent_failures, reask, intent, complexity };
                const d = decide(example, features);
                for (const session of SESSIONS)
                  for (const loaded of [true, false]) {
                    const b = boundDecision(example, d, bounds({ session, hasQuery: () => loaded, hasCrew: () => loaded }));
                    const why = outside(example, b, CTX);
                    if (why) violations.push(`${why}: ${JSON.stringify({ features, session, loaded })}`);
                    // the session rule, as a property: a choice that survived the bounds keeps an active session's model
                    if (b.outcome === "chosen" && b.chosen.tier !== undefined && session.active && session.model !== null) {
                      const to = tierTarget(COMPUTE, TIERS, b.chosen.tier);
                      if (to.provider !== session.provider || to.model !== session.model) violations.push(`moved the session: ${JSON.stringify({ features, session, b })}`);
                    }
                    seen.add(b.outcome === "no_match" ? "no_match" : `${b.outcome}:${b.row}`);
                    n++;
                  }
              }
    expect(violations.slice(0, 5)).toEqual([]);
    // the space reached every row, both ways, and the fall-through
    for (const id of ["status", "small-talk", "the-record", "struggling", "by-complexity"]) expect(seen, id).toContain(`chosen:${id}`);
    expect(seen).toContain("out_of_bounds:struggling");
    expect(seen).toContain("out_of_bounds:status");
    expect(seen).toContain("no_match");
    expect(n).toBeGreaterThan(400_000);
  });

  it("any valid table, with arbitrary scorer answers (seeded)", () => {
    const r = prng(0x7902);
    const violations: string[] = [];
    for (let p = 0; p < 200; p++) {
      const policy = randomPolicy(r);
      for (let i = 0; i < 400; i++) {
        const intent = arbitraryIntent(r);
        const complexity = arbitraryComplexity(r);
        const features: PolicyFeatures = {
          words: pick(r, WORDS),
          attachments: pick(r, [0, 1, 3]),
          thread_turns: pick(r, COUNTS),
          recent_failures: pick(r, [undefined, 0, 2, 5]),
          reask: pick(r, REASK),
          intent: intentValue(intent),
          complexity: complexityValue(complexity),
        };
        // what the table reads is only ever a name from the closed enums, or absent
        if (features.intent !== undefined) expect(isIntent(features.intent)).toBe(true);
        if (features.complexity !== undefined) expect(isComplexity(features.complexity)).toBe(true);
        const b = boundDecision(policy, decide(policy, features), bounds({ session: pick(r, SESSIONS), hasQuery: () => r() < 0.8, hasCrew: () => r() < 0.8 }));
        const why = outside(policy, b, CTX);
        if (why) violations.push(`${why}: policy ${p} case ${i}: ${JSON.stringify({ policy, features })}`);
      }
    }
  });

  it("whatever the scorer's server returns on the wire (seeded)", async () => {
    const r = prng(0x2026);
    const TOKENS = ["A", "B", "C", "D", "P", "Z", "a", "c", "AB", "", " B", "<|channel>", "deep", "\n"];
    for (let i = 0; i < 300; i++) {
      const top = Array.from({ length: Math.floor(r() * 12) }, () => ({ token: pick(r, TOKENS), logprob: pick(r, [0, -0.01, -1, -5, -50, Number.NEGATIVE_INFINITY, 3]) }));
      const shape = pick(r, ["ok", "ok", "ok", "null", "http500", "garbage", "throw"]);
      const fetchFn = (async () => {
        if (shape === "throw") throw new Error("connection refused");
        if (shape === "http500") return new Response("upstream error", { status: 500 });
        if (shape === "garbage") return new Response("not json at all", { status: 200 });
        const logprobs = shape === "null" ? null : { content: [{ top_logprobs: top }] };
        return new Response(JSON.stringify({ choices: [{ message: { content: "A" }, logprobs }] }), { status: 200, headers: { "content-type": "application/json" } });
      }) as unknown as typeof fetch;
      const got = await scoreRouteFeatures({ compute: () => COMPUTE, fetchFn }, "weigh the two offers against the move", {
        reads: { intent: true, complexity: true },
        intentRules: intentRulesSchema.parse({ min_confidence: pick(r, [0, 0.5, 0.9]) }),
        complexityMinConfidence: pick(r, [0, 0.5, 0.9]),
        timeoutMs: 1000,
      });
      expect(["scored", "below_threshold", "unavailable"]).toContain(got.intent?.outcome);
      expect(["scored", "below_threshold", "unavailable"]).toContain(got.complexity?.outcome);
      const features: PolicyFeatures = { words: 7, attachments: 0, thread_turns: 0, recent_failures: 0, reask: false, intent: intentValue(got.intent), complexity: complexityValue(got.complexity) };
      const b = boundDecision(example, decide(example, features), bounds());
      expect(outside(example, b, CTX), JSON.stringify({ shape, top, got })).toBeUndefined();
    }
  });
});

// ---- the model features --------------------------------------------------------

/** A scorer server that answers each question with the code the test names, and counts the questions. */
function scorer(answer: { intent?: string; complexity?: string; peak?: number; delayMs?: number; status?: number; body?: string }) {
  const asked: Array<{ kind: "intent" | "complexity"; body: any }> = [];
  const fn = (async (_url: string, init: { body: string; signal?: AbortSignal }) => {
    const body = JSON.parse(init.body);
    const kind = body.top_logprobs === 3 ? "complexity" : "intent";
    asked.push({ kind, body });
    if (answer.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, answer.delayMs);
        init.signal?.addEventListener("abort", () => (clearTimeout(t), reject(init.signal!.reason)));
      });
    }
    if (answer.status) return new Response(answer.body ?? "", { status: answer.status });
    const names: readonly string[] = kind === "intent" ? INTENT_NAMES : COMPLEXITY_NAMES;
    const want = kind === "intent" ? answer.intent : answer.complexity;
    const codes = codesFor(names.length);
    const i = Math.max(0, names.indexOf(want ?? ""));
    const peak = answer.peak ?? 0.97;
    const top = [
      { token: codes[i]!, logprob: Math.log(peak) },
      { token: codes[(i + 1) % names.length]!, logprob: Math.log(1 - peak) },
    ];
    return new Response(JSON.stringify({ choices: [{ message: { content: codes[i] }, logprobs: { content: [{ top_logprobs: top }] } }] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fn, asked };
}

const INTENT_RULES = intentRulesSchema.parse({ min_confidence: 0.8, by_intent: { smalltalk: 0.95 } });
const access = (fetchFn: typeof fetch, cfg: Compute = COMPUTE): ModelAccess => ({ compute: () => cfg, fetchFn });
const BOTH = { intent: true, complexity: true };

describe("scoreRouteFeatures (§2): the one local scorer, only for what the table reads", () => {
  it("scores both features concurrently on assignments.intent, recording names and numbers", async () => {
    const s = scorer({ intent: "knowledge_search", complexity: "moderate", delayMs: 60 });
    const started = Date.now();
    const got = await scoreRouteFeatures(access(s.fn), "what did we decide about the lease", { reads: BOTH, intentRules: INTENT_RULES, complexityMinConfidence: 0.7, timeoutMs: 1000 });
    expect(Date.now() - started).toBeLessThan(115); // two 60 ms calls, side by side
    expect(s.asked.map((a) => a.kind).sort()).toEqual(["complexity", "intent"]);
    for (const a of s.asked) {
      expect(a.body.model).toBe("gemma4:e4b-it-qat");
      expect(a.body.temperature).toBe(0);
      expect(a.body.reasoning_effort).toBe("none");
    }
    expect(got.intent).toMatchObject({ outcome: "scored", intent: "knowledge_search", threshold: 0.8, provider: "ollama", model: "gemma4:e4b-it-qat" });
    expect(got.intent!.confidence).toBeGreaterThan(0.9);
    expect(got.complexity).toMatchObject({ outcome: "scored", class: "moderate", threshold: 0.7, provider: "ollama" });
  });

  it("asks only for what some row reads — and nothing at all when no row reads a model feature", async () => {
    const s = scorer({ intent: "smalltalk", complexity: "simple" });
    expect(await scoreRouteFeatures(access(s.fn), "hello there", { reads: { intent: false, complexity: false }, timeoutMs: 1000 })).toEqual({});
    expect(s.asked).toHaveLength(0);
    const only = await scoreRouteFeatures(access(s.fn), "hello there", { reads: { intent: false, complexity: true }, complexityMinConfidence: 0.5, timeoutMs: 1000 });
    expect(Object.keys(only)).toEqual(["complexity"]);
    expect(s.asked.map((a) => a.kind)).toEqual(["complexity"]);
  });

  it("below the owner's threshold: the intent feature is `unsure`, the complexity feature is absent", async () => {
    const s = scorer({ intent: "smalltalk", complexity: "demanding", peak: 0.8 });
    const got = await scoreRouteFeatures(access(s.fn), "hey, thanks", { reads: BOTH, intentRules: INTENT_RULES, complexityMinConfidence: 0.9, timeoutMs: 1000 });
    expect(got.intent).toMatchObject({ outcome: "below_threshold", intent: "smalltalk", threshold: 0.95 }); // by_intent wins over the floor
    expect(intentValue(got.intent)).toBe(INTENT_UNSURE);
    expect(got.complexity).toMatchObject({ outcome: "below_threshold", class: "demanding", threshold: 0.9 });
    expect(complexityValue(got.complexity)).toBeUndefined();
  });

  it("the guard runs first, in code: a message it refuses is never sent, and the record holds a code, not a sentence", async () => {
    const s = scorer({ intent: "smalltalk" });
    const got = await scoreRouteFeatures(access(s.fn), "x".repeat(2500), { reads: BOTH, intentRules: INTENT_RULES, complexityMinConfidence: 0.5, timeoutMs: 1000 });
    expect(got).toEqual({ intent: { outcome: "guarded", reason: "too_long" }, complexity: { outcome: "guarded", reason: "too_long" } });
    const script = await scoreRouteFeatures(access(s.fn), "Привет, как дела у тебя сегодня вечером", { reads: BOTH, intentRules: INTENT_RULES, complexityMinConfidence: 0.5, timeoutMs: 1000 });
    expect(script.intent).toEqual({ outcome: "guarded", reason: "out_of_script" });
    expect(s.asked).toHaveLength(0);
  });

  it("no assignments.intent: both features absent, nothing dialled — the tier is off, which is a supported install", async () => {
    const s = scorer({ intent: "smalltalk" });
    const none = parseCompute(`providers: { ollama: { kind: openai-compatible, base_url: http://127.0.0.1:11434/v1, locality: on_machine } }`);
    const got = await scoreRouteFeatures(access(s.fn, none), "hello there", { reads: BOTH, intentRules: INTENT_RULES, complexityMinConfidence: 0.5, timeoutMs: 1000 });
    expect(got).toEqual({ intent: { outcome: "unavailable", reason: "no_assignment" }, complexity: { outcome: "unavailable", reason: "no_assignment" } });
    expect(await scoreRouteFeatures({ fetchFn: s.fn }, "hello there", { reads: BOTH, timeoutMs: 1000 })).toMatchObject({ intent: { reason: "no_assignment" } });
    expect(s.asked).toHaveLength(0);
  });

  it("the money rule, at the call: an off-machine scorer THROWS before any request (the schema refuses it at load)", async () => {
    const s = scorer({ intent: "smalltalk" });
    const offMachine = { ...COMPUTE, providers: { ...COMPUTE.providers, ollama: { ...COMPUTE.providers.ollama!, locality: "off_machine" as const } } } as Compute;
    await expect(scoreRouteFeatures(access(s.fn, offMachine), "hello there", { reads: BOTH, intentRules: INTENT_RULES, complexityMinConfidence: 0.5, timeoutMs: 1000 })).rejects.toThrow(/locality: off_machine/);
    expect(s.asked).toHaveLength(0);
  });

  it("**a failure or a timeout takes the default** — a scorer that errors or runs past its deadline is an absent feature, and the table falls through", async () => {
    const intentOnly = valid(`
tiers: [fast, default]
caps: { tool_calls: 4, tokens: 1000, cost_usd: 0.1 }
table:
  - { id: chat, when: { intent: smalltalk }, then: { operation: answer, tier: fast } }
`);
    const cases: Array<[string, ReturnType<typeof scorer>]> = [
      ["http 500", scorer({ status: 500, body: "boom" })],
      ["past the deadline", scorer({ intent: "smalltalk", delayMs: 5_000 })],
      ["not json", scorer({ status: 200, body: "<html>" })],
    ];
    for (const [what, s] of cases) {
      const started = Date.now();
      const got = await scoreRouteFeatures(access(s.fn), "hey, thanks", { reads: { intent: true, complexity: false }, intentRules: INTENT_RULES, timeoutMs: scorerTimeoutMs(200) });
      expect(Date.now() - started, what).toBeLessThan(400);
      expect(got.intent, what).toEqual({ outcome: "unavailable", reason: "no_answer" });
      expect(decide(intentOnly, { words: 2, attachments: 0, intent: intentValue(got.intent) }), what).toEqual({ outcome: "no_match" });
    }
    expect(scorerTimeoutMs(400)).toBe(300);
    expect(scorerTimeoutMs(50)).toBe(37);
  });

  it("nothing the server says reaches the record — not an error body echoing the prompt, not an answer outside the enum", async () => {
    const echo = scorer({ status: 400, body: "bad request near 'the safe combination is seven three nine'" });
    const got = await scoreRouteFeatures(access(echo.fn), "the safe combination is seven three nine", { reads: BOTH, intentRules: INTENT_RULES, complexityMinConfidence: 0.5, timeoutMs: 1000 });
    expect(JSON.stringify(got)).not.toMatch(/combination|seven|safe|bad request/);
    expect(got).toEqual({ intent: { outcome: "unavailable", reason: "no_answer" }, complexity: { outcome: "unavailable", reason: "no_answer" } });
  });
});
