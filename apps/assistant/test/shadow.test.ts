// Shadow mode's two claims, and nothing else: it NEVER executes a tool, and
// it never costs the real turn anything but money. Both are asserted as
// properties of the code rather than as behaviours of a model.
import { describe, expect, it } from "vitest";
import { parseCompute, resolveAssignment } from "@foldedspacelabs/metistry-core";
import {
  SHADOW_STUB_RESULT,
  agreementOf,
  recordShadow,
  runShadow,
  shadowToolHost,
  shouldShadow,
  tokenJaccard,
  type ShadowRun,
} from "../src/shadow.js";
import type { ChatClient, ChatResponse } from "../src/engine-openai.js";
import { toolCallKey, type ToolHost, type ToolSpec } from "../src/tools.js";

const FILE = `
providers:
  local:  { kind: openai-compatible, base_url: http://127.0.0.1:1234/v1, locality: on_machine }
  candid: { kind: openai-compatible, base_url: http://127.0.0.1:7813/v1, locality: on_machine }
assignments:
  default:
    model: local/incumbent
    shadow: { model: candid/qwen3.6-35b-a3b, fraction: 0.1 }
`;
const assignment = resolveAssignment(parseCompute(FILE), "default")!;
const candidate = assignment.shadow!;

const TOOLS: ToolSpec[] = [{ name: "mcp__brain__knowledge_search", description: "search", parameters: { type: "object", properties: {} } }];

/** A ChatClient that answers from a script — no fetch, no provider. */
function client(script: Array<{ text?: string; calls?: Array<{ id: string; name: string; args: Record<string, unknown> }> }>): ChatClient & { sent: number } {
  const state = {
    sent: 0,
    providerName: candidate.provider,
    model: candidate.model,
    provider: candidate.config,
    async chat(): Promise<ChatResponse> {
      const next = script.shift() ?? { text: "(script exhausted)" };
      state.sent++;
      return {
        text: next.text ?? "",
        toolCalls: (next.calls ?? []).map((c) => ({ id: c.id, name: c.name, args: c.args })),
        message: { role: "assistant", content: next.text ?? null },
        usage: { tokens_in: 10, tokens_out: 2 },
        cost: { cost_usd: 0.002, source: "provider" },
      };
    },
  };
  return state;
}

const input = (c: ChatClient, extra: Partial<Parameters<typeof runShadow>[0]> = {}) => ({
  makeClient: () => c,
  candidate,
  assignment,
  messages: [{ role: "user" as const, content: "what do we know about folds?" }],
  tools: TOOLS,
  recorded: new Map<string, string>(),
  real: { text: "three notes mention folds", tool_calls: ["mcp__brain__knowledge_search"], messages: [{ role: "user" as const, content: "what do we know about folds?" }] },
  maxTurns: 4,
  ...extra,
});

describe("the stubbed tool surface (the misuse test)", () => {
  it("records a call and returns the fixed stub — there is no host, client or token in scope to execute it against", async () => {
    const host = shadowToolHost(TOOLS, new Map());
    expect(await host.list()).toEqual(TOOLS);
    const out = await host.call("mcp__brain__knowledge_write", { path: "Knowledge/Areas/x.md", text: "hi" });
    expect(out).toEqual({ text: SHADOW_STUB_RESULT, isError: false });
    expect(host.calls).toEqual([{ name: "mcp__brain__knowledge_write", args: { path: "Knowledge/Areas/x.md", text: "hi" }, executed: false, result_from: "stub" }]);
  });

  it("hands back the REAL run's result for the identical call, and the stub for anything else", async () => {
    const recorded = new Map([[toolCallKey("mcp__brain__knowledge_search", { q: "folds" }), "Knowledge/Areas/folds.md"]]);
    const host = shadowToolHost(TOOLS, recorded);
    expect((await host.call("mcp__brain__knowledge_search", { q: "folds" })).text).toBe("Knowledge/Areas/folds.md");
    expect((await host.call("mcp__brain__knowledge_search", { q: "FOLDS" })).text).toBe(SHADOW_STUB_RESULT); // different arguments are a different call
    expect(host.calls.map((c) => c.result_from)).toEqual(["real_run", "stub"]);
  });

  it("a shadow run that calls a WRITING tool leaves the real tool host untouched", async () => {
    const real: ToolHost & { calls: number } = {
      calls: 0,
      async list() {
        return TOOLS;
      },
      async call() {
        real.calls++;
        throw new Error("the shadow reached a real tool host");
      },
      async close() {},
    };
    const run = await runShadow(
      input(client([{ calls: [{ id: "c1", name: "mcp__brain__knowledge_write", args: { path: "Knowledge/Areas/x.md" } }] }, { text: "written" }])),
    );
    expect(real.calls).toBe(0);
    expect(run.shadow.tool_calls).toEqual([{ name: "mcp__brain__knowledge_write", args: { path: "Knowledge/Areas/x.md" }, executed: false, result_from: "stub" }]);
    expect(run.shadow.text).toBe("written");
  });
});

describe("the sampler", () => {
  it("is the fraction and nothing else — 0 never runs, 1 always runs, and the draw is compared once", () => {
    expect(shouldShadow(undefined, () => 0)).toBe(false);
    expect(shouldShadow({ ...candidate, fraction: 0 }, () => 0)).toBe(false);
    expect(shouldShadow({ ...candidate, fraction: 1 }, () => 0.999)).toBe(true);
    expect(shouldShadow({ ...candidate, fraction: 0.1 }, () => 0.05)).toBe(true);
    expect(shouldShadow({ ...candidate, fraction: 0.1 }, () => 0.1)).toBe(false); // strictly less than, so 0.1 means one turn in ten
    expect(shouldShadow({ ...candidate, fraction: 0.1 }, () => 0.9)).toBe(false);
  });
});

describe("agreement", () => {
  it("token Jaccard ignores case and punctuation, and says 1 only when the token sets match", () => {
    expect(tokenJaccard("Three notes mention folds.", "three notes mention folds")).toBe(1);
    expect(tokenJaccard("", "")).toBe(1);
    expect(tokenJaccard("something", "")).toBe(0);
    expect(tokenJaccard("a b c d", "a b c e")).toBe(0.6); // 3 shared of 5 distinct
  });

  it("the score is the tool sequence and the answer, half each — and the sequence is ORDER, not a tally", () => {
    const same = agreementOf({ text: "same words", tool_calls: ["a", "b"] }, { text: "same words", tool_calls: ["a", "b"] });
    expect(same).toEqual({ score: 1, tool_sequence: true, answer_similarity: 1 });
    const reordered = agreementOf({ text: "same words", tool_calls: ["a", "b"] }, { text: "same words", tool_calls: ["b", "a"] });
    expect(reordered).toMatchObject({ tool_sequence: false, answer_similarity: 1, score: 0.5 });
    const nothing = agreementOf({ text: "one", tool_calls: [] }, { text: "two", tool_calls: ["a"] });
    expect(nothing).toEqual({ score: 0, tool_sequence: false, answer_similarity: 0 });
  });
});

describe("runShadow", () => {
  it("stores both sides and the measure, and never throws when the candidate is unreachable", async () => {
    const broken: ChatClient = {
      providerName: candidate.provider,
      model: candidate.model,
      provider: candidate.config,
      async chat() {
        throw new Error("connect ECONNREFUSED 127.0.0.1:7813");
      },
    };
    const run = await runShadow(input(broken));
    expect(run.shadow.error).toContain("ECONNREFUSED");
    expect(run.shadow.text).toBe("");
    expect(run.real.text).toBe("three notes mention folds"); // the real turn already happened, and is on the row regardless
    expect(run.agreement).toEqual({ score: 0, tool_sequence: false, answer_similarity: 0 });
  });

  it("a credential the shadow provider needs but this install has not set is a shadow error, never a turn error", async () => {
    const run = await runShadow({
      ...input(client([])),
      makeClient: () => {
        throw new Error("compute.yaml names providers.candid.auth.secret = METISTRY_CANDIDATE_KEY, but it is unset");
      },
    });
    expect(run.shadow.error).toContain("providers.candid.auth.secret");
    expect(run.shadow.turns).toBe(0);
    expect(run.shadow.cost_usd).toBe(0);
  });

  it("accounts the candidate's own spend, and stops on the same turn cap the real loop had", async () => {
    const call = { id: "c", name: "mcp__brain__knowledge_search", args: { q: "folds" } };
    const c = client([{ calls: [call] }, { calls: [call] }, { text: "as far as I got" }]);
    const run = await runShadow({ ...input(c), maxTurns: 2 });
    expect(run.shadow.stopped).toBe("max_turns");
    expect(run.shadow.turns).toBe(2);
    expect(run.shadow.cost_usd).toBeCloseTo(0.006, 6); // two loop turns plus the tools-off ending
    expect(run.shadow.cost_source).toBe("provider");
    expect(run.shadow.messages.at(-1)).toMatchObject({ role: "assistant" });
  });

  it("the rubric is a HOOK: absent by default, and a scorer that throws costs the row its score, not the comparison", async () => {
    const plain = await runShadow(input(client([{ text: "ok" }])));
    expect(plain.rubric_score).toBeUndefined();
    const scored = await runShadow({ ...input(client([{ text: "ok" }])), rubric: async () => 4.5 });
    expect(scored.rubric_score).toBe(4.5);
    const angry = await runShadow({
      ...input(client([{ text: "ok" }])),
      rubric: async () => {
        throw new Error("packages/eval is not loaded");
      },
    });
    expect(angry.rubric_score).toBeUndefined();
    expect(angry.shadow.text).toBe("ok");
  });
});

describe("recordShadow", () => {
  const run = (over: Partial<ShadowRun["shadow"]> = {}): ShadowRun => ({
    shadow: { provider: "candid", model: "qwen3.6-35b-a3b", text: "close enough", messages: [], tool_calls: [], turns: 2, tokens_in: 100, tokens_out: 20, cost_usd: 0.004, cost_source: "provider", ...over },
    real: { provider: "local", model: "incumbent", text: "close enough", messages: [], tool_calls: [] },
    agreement: { score: 0.85, tool_sequence: true, answer_similarity: 0.7 },
  });

  function db() {
    const sent: Array<{ sql: string; values: unknown[] }> = [];
    return {
      sent,
      async query(sql: string, values: unknown[] = []) {
        sent.push({ sql, values });
        return { rows: [{ id: 77 }] };
      },
    };
  }

  it("puts the comparison on the TURN's row and the candidate's spend on its own row, against its own provider", async () => {
    const d = db();
    expect(await recordShadow(d, 42, run(), { tier: "default" })).toBe(77);
    const [update, insert, finish] = d.sent;
    expect(update!.sql).toContain("UPDATE runs SET shadow_provider");
    expect(update!.values.slice(0, 3)).toEqual([42, "candid", "qwen3.6-35b-a3b"]);
    expect(update!.values[4]).toBe(0.85);
    expect(update!.values[5]).toBe(0.004);
    expect(JSON.parse(String(update!.values[3])).real.model).toBe("incumbent"); // both sides in the one column

    // the spend row: kind `shadow`, the SHADOW's provider — so a per-provider
    // budget bills the provider that was actually paid
    expect(insert!.sql).toContain("INSERT INTO runs");
    expect(insert!.values.slice(0, 2)).toEqual(["assistant", "shadow"]);
    expect(insert!.values[4]).toBe("candid");
    expect(JSON.parse(String(insert!.values[6]))).toMatchObject({ shadow_of: 42, tier: "default", real_model: "incumbent", agreement: 0.85 });
    expect(finish!.values).toContain(0.004);
  });

  it("a shadow that failed is recorded as a failed run, so a candidate that is simply down is visible", async () => {
    const d = db();
    await recordShadow(d, 43, run({ error: "ECONNREFUSED", cost_usd: 0 }));
    const finish = d.sent.at(-1)!;
    expect(finish.values[1]).toBe(false);
    expect(finish.values[2]).toBe("ECONNREFUSED");
  });
});
