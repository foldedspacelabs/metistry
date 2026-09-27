// Invariant 4, as a test rather than a promise: **no model decides which
// model to use** (PoC-20 phase 1; research §3.2).
//
// Three properties, each checked a different way, because a comment saying
// "the classifier only supplies a fact" is not a control:
//
//   1. BEHAVIOURAL — for every intent in the enum, the set of models the drain
//      dials is identical. A classifier that could change which model runs
//      would show up here as a sixteenth different model list.
//   2. SOURCE — the verdict is READ in exactly one module, `intent-tier.ts`,
//      and `run.ts` consumes only what that module's rule functions return.
//      A new consumer of `.intent` in the drain fails this, loudly, with the
//      line that added it.
//   3. SOURCE — the router does not know the intent tier exists. The composer
//      door is PoC-20 phase 2 and it needs the owner's ruling on invariant 4's
//      wording first (§6 question 1); wiring it early would be the implicit
//      amendment PoC-15/16's process exists to prevent.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { INTENT_NAMES, codesFor, intentRulesSchema, parseCompute, type Compute, type Intent } from "@foldedspacelabs/metistry-core";
import { run, type CollectorCtx } from "../inbox-drain/run.js";

const read = (p: string): string => readFileSync(new URL(p, import.meta.url), "utf8");

const rules = intentRulesSchema.parse({ min_confidence: 0.5 });

const cfg: Compute = parseCompute(`
providers:
  applefm: { kind: openai-compatible, base_url: http://127.0.0.1:7810/v1, locality: on_machine }
  ollama: { kind: openai-compatible, base_url: http://127.0.0.1:11434/v1, locality: on_machine }
assignments:
  default: { model: applefm/foundation-model }
  intent: { model: ollama/gemma4:e4b-it-qat }
`);

function serverAnswering(intent: Intent) {
  const models: string[] = [];
  const bodies: any[] = [];
  const fn = (async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    models.push(body.model);
    bodies.push(body);
    if (body.logprobs === true) {
      const codes = codesFor(INTENT_NAMES.length);
      const i = INTENT_NAMES.indexOf(intent);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: codes[i] }, logprobs: { content: [{ top_logprobs: [{ token: codes[i], logprob: Math.log(0.99) }, { token: codes[(i + 1) % 16], logprob: Math.log(0.01) }] }] } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ category: "idea", has_action: false, action: "" }) } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fn, models, bodies };
}

function fakeDb(rows: any[]) {
  let id = 1;
  return {
    async query(text: string, values?: unknown[]): Promise<{ rows: any[] }> {
      if (text.startsWith("SELECT id, path")) return { rows };
      if (text.includes("INSERT INTO runs")) return { rows: [{ id: id++ }] };
      void values;
      return { rows: [] };
    },
  };
}

const ctx = (fetchFn: typeof fetch): CollectorCtx => ({ compute: () => cfg, secretEnv: {}, usesModel: "applefm/foundation-model", fetchFn, intentRules: rules });
const capture = { id: 1, path: "1-note.md", mime: "text/markdown", note: "thoughts on the migration approach", source: "note" };

describe("a verdict cannot change which model runs", () => {
  it("dials the same models whatever the classifier says, for every intent in the enum", async () => {
    const seen = new Map<string, string[]>();
    for (const intent of INTENT_NAMES) {
      const server = serverAnswering(intent);
      await run(fakeDb([{ ...capture }]), ctx(server.fn));
      seen.set(intent, [...new Set(server.models)].sort());
    }
    // Exactly two model names exist in this configuration: the intent tier's,
    // which is always dialled, and the schema tier's, which is dialled when
    // the intent tier placed nothing. No verdict introduces a third, and none
    // of them names a TIER.
    const everyModel = new Set([...seen.values()].flat());
    expect([...everyModel].sort()).toEqual(["foundation-model", "gemma4:e4b-it-qat"]);
    for (const [intent, models] of seen) {
      expect(models[0], intent).toBe(models.includes("foundation-model") ? "foundation-model" : "gemma4:e4b-it-qat");
      expect(models.length, intent).toBeLessThanOrEqual(2);
    }
  });

  it("never sends a tier name, a model name or an effort to the classifier", async () => {
    const server = serverAnswering("task_create");
    await run(fakeDb([{ ...capture }]), ctx(server.fn));
    const scored = server.bodies.find((b) => b.logprobs === true);
    const prompt = JSON.stringify(scored.messages);
    for (const word of ["haiku", "opus", "sonnet", "tier", "effort", "escalate", "which model"]) {
      expect(prompt.toLowerCase()).not.toContain(word);
    }
  });
});

describe("the verdict is consumed only by rule code", () => {
  const drain = read("../inbox-drain/run.ts");

  it("run.ts never reads a verdict — it asks intent-tier.ts what the rules decided", () => {
    const code = drain.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    // The drain may hold a verdict (to audit it) and may ask for a placement.
    // It may not LOOK INSIDE one. Every field of a verdict is forbidden here,
    // so a future consumer has to be added to intent-tier.ts — which is where
    // the decision lives, and which is a file a reviewer reads as rules.
    for (const field of [".verdict", ".confidence", ".distribution", ".threshold", ".decision", ".alpha"]) {
      expect(code, `${field} is a verdict's field; read it in intent-tier.ts, not in the drain`).not.toContain(field);
    }
    // And the enum itself is not imported here: an `if (intent === …)` in the
    // drain is the shape this test exists to prevent.
    expect(code).not.toMatch(/\bINTENT_[A-Z_]+\b|\bisIntent\b|\bintentDecision\b|\binboxKindForIntent\b|INBOX_KIND_FOR_INTENT/);
    // What it may import from the tier module: the call, the rules' answer,
    // and the audit shape. Nothing that interprets.
    const imported = /import \{([^}]+)\} from "\.\/intent-tier\.js"/.exec(drain)?.[1] ?? "";
    expect(
      imported
        .split(",")
        .map((s) => s.replace(/^\s*type\s+/, "").trim())
        .filter(Boolean)
        .sort(),
    ).toEqual(["IntentOutcome", "intentMeta", "intentPlacement", "scoreIntent"]);
  });

  it("the tier module names no tier and no model of its own", () => {
    const tier = read("../inbox-drain/intent-tier.ts");
    // `provider`/`model` appear only as PROVENANCE — which model said this —
    // never as something the verdict selects. The check is that no tier name
    // from the seeded rules.yaml is written down anywhere in it.
    const code = tier.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    for (const tierName of ["haiku", "opus", "sonnet", '"deep"', '"fast"', '"routine"']) {
      expect(code).not.toContain(tierName);
    }
  });
});

describe("the classifier adds no surface (invariants 9 and 10)", () => {
  it("adds no brain tool: the assistant's mutating and outbound surface is unchanged", async () => {
    const { TOOL_NAMES } = await import("@foldedspacelabs/metistry-mcp-brain");
    expect(TOOL_NAMES.filter((n) => /intent|classif|score|confidence/i.test(n))).toEqual([]);
    // The tier is a COLLECTOR reading a local model, not a door anybody can
    // knock on. Nothing the assistant can call changed, and `ops/scripts/
    // check-tool-surface.mjs` measures the same list on every CI run.
    // 28 since T4-8b's connections lazy pair (the approved spec §2.6, Q5) — a
    // proxy door with its own gate, not a classifier surface.
    expect(TOOL_NAMES.filter((n) => n !== "propose_action").length).toBeLessThanOrEqual(28);
  });
});

describe("the composer door is not wired (PoC-20 phase 2 needs a ruling)", () => {
  const router = read("../../apps/console/src/router.ts");

  it("the router validates the thresholds and reads nothing", () => {
    // It imports the schema — that is what makes a bad threshold a startup
    // failure — and `route()` must not mention the block at all.
    expect(router).toContain("intentRulesSchema");
    const routeFn = router.slice(router.indexOf("export function route("));
    expect(routeFn).not.toMatch(/intent/i);
  });

  it("Route still has exactly the three kinds it had before a classifier existed", () => {
    const union = router.slice(router.indexOf("export type Route"), router.indexOf("export function loadRules"));
    expect(union.match(/kind: "/g)).toHaveLength(3);
    expect(union).not.toMatch(/confidence|intent/i);
  });
});
