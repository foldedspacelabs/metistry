// The policy at the console (T9-2; docs/ops/dynamic-router.md §4–§6): the
// owner's `rules.yaml` `policy:` block, loaded with the rest of the file,
// made into the `RoutePolicy` T9-1's consultation asks, and consulted in
// shadow. No database: the features query is a function here. The door-level
// half — the served route byte-identical with the real policy wired — is
// route-policy.integration.test.ts.
//
// The table's own properties (the generated feature space, arbitrary scorer
// answers) are packages/core/test/router-policy.test.ts; this file holds
// them through the consultation: **no output outside the allow-list; a
// failure or a timeout takes the default**.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { codesFor, COMPLEXITY_NAMES, INTENT_NAMES, parseCompute, type Compute } from "@foldedspacelabs/metistry-core";
import { consultRoute, loadRules, makeRoutePolicy, route, type ConsultInput, type RoutePolicyDeps, type Rules, type ThreadFacts } from "../src/router.js";

const SEED = readFileSync(new URL("../../../seed/rules.yaml", import.meta.url), "utf8");
const at = new Date("2026-09-26T12:00:00Z");

/** The seed with its commented `intent:` and `policy:` blocks switched on — the example the seed ships must load. */
function seedWithBlocksOn(): string {
  const lines = SEED.split("\n");
  const out: string[] = [];
  let on: "intent" | "policy" | null = null;
  for (const line of lines) {
    if (/^# (intent|policy):$/.test(line)) on = line.slice(2, -1) as "intent" | "policy";
    else if (on && !/^# {2}/.test(line)) on = null;
    out.push(on ? line.slice(2) : line);
  }
  return out.join("\n");
}

const rulesWith = (policy: string, intent = "intent:\n  min_confidence: 0.8\n"): Rules => loadRules(`${SEED}\n${intent}\npolicy:\n${policy.replace(/^/gm, "  ")}`);

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

/** A local scorer: answers each question with the class the test names; counts the questions. */
function scorer(answer: { intent?: string; complexity?: string; delayMs?: number; status?: number; body?: string; peak?: number } = {}) {
  const asked: string[] = [];
  const fn = (async (_url: string, init: { body: string; signal?: AbortSignal }) => {
    const body = JSON.parse(init.body);
    const kind = body.top_logprobs === 3 ? "complexity" : "intent";
    asked.push(kind);
    if (answer.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, answer.delayMs);
        init.signal?.addEventListener("abort", () => (clearTimeout(t), reject(init.signal!.reason)));
      });
    }
    if (answer.status) return new Response(answer.body ?? "", { status: answer.status });
    const names: readonly string[] = kind === "intent" ? INTENT_NAMES : COMPLEXITY_NAMES;
    const codes = codesFor(names.length);
    const i = Math.max(0, names.indexOf((kind === "intent" ? answer.intent : answer.complexity) ?? ""));
    const peak = answer.peak ?? 0.98;
    const top = [
      { token: codes[i]!, logprob: Math.log(peak) },
      { token: codes[(i + 1) % names.length]!, logprob: Math.log(1 - peak) },
    ];
    return new Response(JSON.stringify({ choices: [{ message: { content: codes[i] }, logprobs: { content: [{ top_logprobs: top }] } }] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fn, asked };
}

const facts = (over: Partial<ThreadFacts> = {}): ThreadFacts => ({
  session_active: false,
  session_turns: 0,
  session_provider: null,
  session_model: null,
  recent_failures: 0,
  prev_ts: null,
  prev_text: null,
  ...over,
});

function policyFor(rules: Rules, over: Partial<RoutePolicyDeps> = {}) {
  const p = makeRoutePolicy({ rules, compute: () => COMPUTE, hasQuery: () => true, hasCrew: () => true, ...over });
  if (!p) throw new Error("no policy");
  return p;
}

function input(rules: Rules, text: string, over: Partial<ConsultInput> = {}, tier?: string): ConsultInput {
  return { rules, route: route(rules, text, tier), text, attachments: 0, thread: "t-1", messageId: 7, loadFacts: async () => facts(), at, ...over };
}

// ---- loading ---------------------------------------------------------------------

describe("rules.yaml `policy:` loads with the rest of the file", () => {
  it("absent means off: the seed as shipped has no policy, and makeRoutePolicy makes none", () => {
    const rules = loadRules(SEED);
    expect(rules.policy).toBeUndefined();
    expect(makeRoutePolicy({ rules, hasQuery: () => true, hasCrew: () => true })).toBeUndefined();
    // `policy:` with nothing under it is the block commented out
    expect(loadRules(`${SEED}\npolicy:\n`).policy).toBeUndefined();
  });

  it("the seed's commented example, switched on with its intent: block, is a valid policy", () => {
    const rules = loadRules(seedWithBlocksOn());
    expect(rules.intent).toMatchObject({ min_confidence: 0.8 });
    expect(rules.policy).toMatchObject({ mode: "shadow", tiers: ["fast", "default", "deep"], timeout_ms: 400, caps: { tool_calls: 12, tokens: 150000, cost_usd: 0.5 } });
    expect(rules.policy!.table.map((r) => r.id)).toEqual(["status", "small-talk", "the-record", "struggling", "by-complexity"]);
  });

  it("a refusal is a startup failure that names its field, in the same parse as a bad regex", () => {
    const bad = (policy: string, intent?: string) => () => rulesWith(policy, intent);
    const base = "tiers: [fast, default]\ncaps: { tool_calls: 4, tokens: 1000, cost_usd: 0.1 }\n";
    expect(bad(`${base}table:\n  - { id: x, then: { operation: tools, tier: deep } }`)).toThrow(/^invalid rules\.yaml: policy\.table\[0\]\.then\.tier: "deep" is not in policy\.tiers/);
    expect(bad(`${base}mode: live`)).toThrow(/policy\.mode: mode is shadow or serve/);
    expect(bad(`${base}mode: serve`)).not.toThrow(); // lifted by T9-4 (docs/ops/dynamic-router.md §7.3)
    expect(bad(`${base}table:\n  - { id: x, when: { intent: smalltalk }, then: { operation: answer, tier: fast } }`, "")).toThrow(/policy\.table\[0\]\.when\.intent: .*no intent: block/);
    expect(bad(`${base}table:\n  - { id: x, then: { operation: "fast_path:secrets", tier: fast } }`)).toThrow(/policy\.table\[0\]\.then\.operation: no fast_path: rule names the query secrets/);
    expect(bad("tiers: [fast, gpt99]\ncaps: { tool_calls: 4, tokens: 1000, cost_usd: 0.1 }")).toThrow(/policy\.tiers\[1\]: "gpt99" is not a key of tiers:/);
    expect(bad(`${base}engine: opus`)).toThrow(/policy\.engine: unknown key/);
  });
});

// ---- the consultation, in shadow ---------------------------------------------------

const TABLE = `
tiers: [fast, default, deep]
timeout_ms: 400
caps: { tool_calls: 12, tokens: 150000, cost_usd: 0.5 }
complexity: { min_confidence: 0.7 }
table:
  - { id: status, when: { intent: [status_open_work, task_list], words: { max: 15 } }, then: { operation: "fast_path:open_work" } }
  - { id: small-talk, when: { intent: smalltalk }, then: { operation: answer, tier: fast } }
  - { id: the-record, when: { intent: knowledge_search }, then: { operation: "retrieve:knowledge", tier: default, tool_calls: 4 } }
  - { id: struggling, when: { reask: true }, then: { operation: tools, tier: deep } }
  - { id: by-complexity, when: { complexity: [simple, moderate, demanding] }, then: { operation: tools, tier: { simple: fast, moderate: default, demanding: deep } } }
`;
const rules = rulesWith(TABLE);
const TEXT = "what did we decide about the lease renewal";

describe("consultRoute with the owner's table", () => {
  it("a fall-through is decided by the table and recorded with the features it read — and the served route is still the rules'", async () => {
    const s = scorer({ intent: "knowledge_search", complexity: "moderate" });
    const rec = await consultRoute(input(rules, TEXT, { policy: policyFor(rules, { fetchFn: s.fn }) }));
    expect(rec).toMatchObject({ tool: "default", ok: true });
    expect(rec.meta.served).toEqual({ kind: "model", tier: "default", operation: "tools", routed_by: "rule" });
    expect(rec.meta.policy).toMatchObject({
      outcome: "chosen",
      row: "the-record",
      chosen: { operation: "retrieve:knowledge", tier: "default", tool_calls: 4 },
      bounded_by: [],
      would_serve: { operation: "retrieve:knowledge", tier: "default", tool_calls: 4 },
      tiers: ["fast", "default", "deep"],
    });
    expect(rec.meta.agrees).toBe(false); // same tier, narrower operation
    expect(rec.meta.features).toMatchObject({
      words: 8,
      intent: { outcome: "scored", intent: "knowledge_search", threshold: 0.8, provider: "ollama", model: "gemma4:e4b-it-qat" },
      complexity: { outcome: "scored", class: "moderate", threshold: 0.7 },
    });
    expect(s.asked.sort()).toEqual(["complexity", "intent"]);
  });

  it("an override is consulted as a counterfactual, with the model features, and compared with what the owner picked", async () => {
    const s = scorer({ intent: "explanation_request", complexity: "demanding" });
    const rec = await consultRoute(input(rules, "/deep weigh the two offers against the move", { policy: policyFor(rules, { fetchFn: s.fn }) }));
    expect(rec.meta.policy).toMatchObject({ outcome: "counterfactual", answer: "chosen", row: "by-complexity", chosen: { tier: "deep" }, bounded_by: ["override"] });
    expect(rec.meta.agrees).toBe(true);
  });

  it("/note and a fast path never consult it: the scorer is not asked", async () => {
    const s = scorer({ intent: "smalltalk" });
    const policy = policyFor(rules, { fetchFn: s.fn });
    for (const text of ["/note buy oat milk", "/status"]) {
      const rec = await consultRoute(input(rules, text, { policy }));
      expect((rec.meta.policy as { outcome: string }).outcome).toBe("not_consulted");
    }
    expect(s.asked).toEqual([]);
  });

  it("a table that reads no model feature never dials the scorer", async () => {
    const cheap = rulesWith("tiers: [default, deep]\ncaps: { tool_calls: 4, tokens: 1000, cost_usd: 0.1 }\ntable:\n  - { id: long, when: { words: { min: 5 } }, then: { operation: tools, tier: deep } }");
    const s = scorer();
    const rec = await consultRoute(input(cheap, TEXT, { policy: policyFor(cheap, { fetchFn: s.fn }) }));
    expect(rec.meta.policy).toMatchObject({ outcome: "chosen", row: "long", chosen: { tier: "deep", tool_calls: 4 } });
    expect(rec.meta.features).not.toHaveProperty("intent");
    expect(s.asked).toEqual([]);
  });

  it("the session rule: an active session is not moved to another model (out_of_bounds: session); an effort-only variant is free", async () => {
    const onSmall = async () => facts({ session_active: true, session_turns: 9, session_provider: "ollama", session_model: "small-model" });
    const demanding = scorer({ intent: "explanation_request", complexity: "demanding" });
    const held = await consultRoute(input(rules, TEXT, { policy: policyFor(rules, { fetchFn: demanding.fn }), loadFacts: onSmall }));
    expect(held.meta.policy).toMatchObject({ outcome: "out_of_bounds", row: "by-complexity", chosen: { tier: "deep" }, bounded_by: ["session"], would_serve: { operation: "tools", tier: "default" } });
    const simple = scorer({ intent: "explanation_request", complexity: "simple" });
    const free = await consultRoute(input(rules, TEXT, { policy: policyFor(rules, { fetchFn: simple.fn }), loadFacts: onSmall }));
    expect(free.meta.policy).toMatchObject({ outcome: "chosen", chosen: { tier: "fast" } }); // fast = small-model at low effort
  });

  it("the registries, at run time: a fast path whose query is not loaded, a crew whose manifest is not", async () => {
    const s = scorer({ intent: "status_open_work" });
    // loaded: the fast path is a choice (T9-1's shape check refused `fast_path:*` outright — the regression this holds)
    const loaded = await consultRoute(input(rules, "how are things going this week", { policy: policyFor(rules, { fetchFn: s.fn }) }));
    expect(loaded.meta.policy).toMatchObject({ outcome: "chosen", row: "status", chosen: { operation: "fast_path:open_work" }, would_serve: { operation: "fast_path:open_work" } });
    expect((loaded.meta.policy as { chosen: object }).chosen).not.toHaveProperty("tier");
    const rec = await consultRoute(input(rules, "how are things going this week", { policy: policyFor(rules, { fetchFn: s.fn, hasQuery: () => false }) }));
    expect(rec.meta.policy).toMatchObject({ outcome: "out_of_bounds", row: "status", bounded_by: ["queries"], would_serve: { operation: "tools", tier: "default" } });
    const crew = rulesWith("tiers: [default]\ncaps: { tool_calls: 4, tokens: 1000, cost_usd: 0.1 }\ntable:\n  - { id: hand-off, then: { operation: \"delegate:research\", tier: default } }");
    const gone = await consultRoute(input(crew, TEXT, { policy: policyFor(crew, { hasCrew: () => false }) }));
    expect(gone.meta.policy).toMatchObject({ outcome: "out_of_bounds", bounded_by: ["crew_registry"] });
  });
});

// ---- the bold test, through the consultation ----------------------------------------

describe("**no output outside the allow-list; a failure or timeout takes the default**", () => {
  it("whatever the scorer answers, the recorded choice is inside policy.tiers, the vocabulary and the caps", async () => {
    const allowed = new Set(["fast", "default", "deep"]);
    for (const intent of [...INTENT_NAMES, "not-an-intent"]) {
      for (const complexity of [...COMPLEXITY_NAMES, "not-a-class"]) {
        for (const peak of [0.34, 0.75, 0.99]) {
          const s = scorer({ intent, complexity, peak });
          const rec = await consultRoute(input(rules, TEXT, { policy: policyFor(rules, { fetchFn: s.fn }) }));
          const p = rec.meta.policy as { outcome: string; chosen?: { operation: string; tier?: string; tool_calls?: number }; would_serve: { tier?: string } };
          expect(["chosen", "no_match", "out_of_bounds"]).toContain(p.outcome);
          if (p.chosen?.tier !== undefined) expect(allowed.has(p.chosen.tier)).toBe(true);
          if (p.would_serve.tier !== undefined) expect(allowed.has(p.would_serve.tier)).toBe(true);
          if (p.chosen?.tool_calls !== undefined) expect(p.chosen.tool_calls).toBeLessThanOrEqual(12);
        }
      }
    }
  });

  it("a scorer that is down or slow is an absent feature: the table falls through inside the deadline, and the rules' default is what serve would do", async () => {
    for (const s of [scorer({ status: 503, body: "loading model" }), scorer({ intent: "smalltalk", delayMs: 10_000 })]) {
      const started = Date.now();
      const rec = await consultRoute(input(rules, TEXT, { policy: policyFor(rules, { fetchFn: s.fn }) }));
      expect(Date.now() - started).toBeLessThan(400);
      expect(rec).toMatchObject({ ok: true, meta: { policy: { outcome: "no_match", would_serve: { operation: "tools", tier: "default" } }, agrees: true } });
      expect(rec.meta.features).toMatchObject({ intent: { outcome: "unavailable", reason: "no_answer" }, complexity: { outcome: "unavailable", reason: "no_answer" } });
    }
  });

  it("a features query that never answers is a `timeout` at the owner's deadline — the default, ok false", async () => {
    const quick = rulesWith(TABLE.replace("timeout_ms: 400", "timeout_ms: 80"));
    const started = Date.now();
    const rec = await consultRoute(input(quick, TEXT, { policy: policyFor(quick, { fetchFn: scorer({ intent: "smalltalk" }).fn }), loadFacts: () => new Promise(() => {}) }));
    expect(Date.now() - started).toBeLessThan(500);
    expect(rec).toMatchObject({ ok: false, error: "the consultation ran past 80 ms", meta: { policy: { outcome: "timeout", bounded_by: ["timeout"] } } });
  });

  it("an off-machine scorer is refused at the call: `failed`, the refusal in `error`, nothing dialled", async () => {
    const s = scorer({ intent: "smalltalk" });
    const offMachine = { ...COMPUTE, providers: { ollama: { ...COMPUTE.providers.ollama!, locality: "off_machine" as const } } } as Compute;
    const rec = await consultRoute(input(rules, TEXT, { policy: policyFor(rules, { fetchFn: s.fn, compute: () => offMachine }) }));
    expect(rec).toMatchObject({ ok: false, meta: { policy: { outcome: "failed", bounded_by: ["failed"] } } });
    expect(rec.error).toMatch(/locality: off_machine/);
    expect(s.asked).toEqual([]);
  });

  it("a bound that throws — a registry that cannot be read — is `failed`, never a choice", async () => {
    const s = scorer({ intent: "status_open_work" });
    const rec = await consultRoute(
      input(rules, "how are things going this week", {
        policy: policyFor(rules, {
          fetchFn: s.fn,
          hasQuery: () => {
            throw new Error("query store unavailable");
          },
        }),
      }),
    );
    expect(rec).toMatchObject({ ok: false, error: "the policy threw: query store unavailable", meta: { policy: { outcome: "failed" } } });
  });

  it("the row carries no message text, whatever the scorer echoes back", async () => {
    const secret = "the safe combination is seven three nine";
    for (const s of [scorer({ status: 400, body: `bad request near '${secret}'` }), scorer({ intent: "note_capture", complexity: "simple" })]) {
      const rec = await consultRoute(input(rules, secret, { policy: policyFor(rules, { fetchFn: s.fn }), loadFacts: async () => facts({ prev_text: secret, prev_ts: at }) }));
      expect(JSON.stringify(rec)).not.toMatch(/combination|seven three|safe|bad request/);
    }
  });
});
