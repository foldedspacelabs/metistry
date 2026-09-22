// Answer-token scoring: the arithmetic, the per-server request shapes, and
// every way it degrades (PoC-20 phase 1).
//
// The per-server bodies are pinned against what was MEASURED on this Mac on
// 2026-09-22, not against what a README says, because two of the three
// measurements contradicted the research note that commissioned this work.
import { describe, expect, it } from "vitest";
import {
  CHOICE_MAX_OPTIONS,
  CHOICE_WIRE,
  choiceBody,
  choiceConfidence,
  choicePlan,
  choiceServerOf,
  codesFor,
  readChoice,
  scoreChoiceOver,
  stageFor,
  type ChoiceGroup,
  type ChoiceOption,
} from "../src/choice.js";

const opts = (...keys: string[]): ChoiceOption[] => keys.map((k) => ({ key: k, description: `it is ${k}` }));
const lp = (pairs: Array<[string, number]>) => pairs.map(([token, logprob]) => ({ token, logprob }));

/** An OpenAI-shaped `/v1/chat/completions` that answers with a fixed top_logprobs list. */
function fakeServer(reply: (body: any) => unknown, status = 200) {
  const sent: any[] = [];
  const fn = (async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    sent.push(body);
    return new Response(JSON.stringify(reply(body)), { status, headers: { "content-type": "application/json" } });
  }) as never;
  return { fn, sent };
}

const answered = (top: Array<[string, number]>) => () => ({ choices: [{ message: { content: "X" }, logprobs: { content: [{ top_logprobs: lp(top) }] } }] });

describe("codes are generated, never written down", () => {
  it("gives one capital letter per option, in list order", () => {
    expect(codesFor(4)).toEqual(["A", "B", "C", "D"]);
    expect(codesFor(26)[25]).toBe("Z");
  });

  it("refuses past 26 and names the way out — Nimble's own ceiling (research §2.1 item 6)", () => {
    expect(() => codesFor(27)).toThrow(/choicePlan/);
  });
});

describe("TypeSafe's confidence statistic (research §2.2)", () => {
  it("is (n·peak − 1)/(n − 1), clamped", () => {
    // Their ConfidenceExplorer, verbatim: max(0, min(1, (n * peak - 1) / (n - 1)))
    expect(choiceConfidence(1, 4)).toBeCloseTo(1, 10);
    expect(choiceConfidence(0.25, 4)).toBeCloseTo(0, 10); // uniform over 4 = no confidence at all
    expect(choiceConfidence(0.86, 15)).toBeCloseTo((15 * 0.86 - 1) / 14, 10);
    expect(choiceConfidence(0.1, 4)).toBe(0); // below uniform clamps at 0, never negative
  });

  it("reproduces the research's own measured pair", () => {
    // §2.5: "A=status_open_work p=0.860 conf=0.850" over 15 intents.
    expect(choiceConfidence(0.86, 15)).toBeCloseTo(0.85, 2);
  });
});

describe("renormalising over the closed alphabet", () => {
  const three = opts("a", "b", "c");

  it("renormalises only the option codes and reports alpha as the share it kept", () => {
    const r = readChoice(lp([["C", Math.log(0.5)], ["B", Math.log(0.25)], ["<|channel>", Math.log(0.25)]]), three, codesFor(3));
    expect("why" in r).toBe(false);
    if ("why" in r) return;
    expect(r.key).toBe("c");
    expect(r.peak).toBeCloseTo(0.5 / 0.75, 6);
    expect(r.distribution.a).toBe(0);
    expect(r.alpha).toBeCloseTo(0.75, 6); // a quarter of the mass was outside — an honest signal, not a hidden one
    expect(r.covered).toBe(2);
  });

  it("folds case: a model that answered `a` meant `A`", () => {
    const r = readChoice(lp([["a", Math.log(0.9)], ["B", Math.log(0.1)]]), three, codesFor(3));
    if ("why" in r) throw new Error(r.why);
    expect(r.key).toBe("a");
    expect(r.alpha).toBeCloseTo(1, 6);
  });

  it("says so when no option code carried any probability at all", () => {
    const r = readChoice(lp([["The", -1], ["One", -2]]), three, codesFor(3));
    expect("why" in r && r.why).toMatch(/none of the 3 option codes/);
  });

  it("breaks a tie on the earlier code, so two runs of one input are one answer", () => {
    const r = readChoice(lp([["B", Math.log(0.5)], ["A", Math.log(0.5)]]), three, codesFor(3));
    if ("why" in r) throw new Error(r.why);
    expect(r.key).toBe("a");
  });
});

describe("the cascade past the option ceiling (Laya lesson 5)", () => {
  const many = opts(...Array.from({ length: 24 }, (_, i) => `k${i}`));
  const groups: ChoiceGroup[] = [
    { key: "g1", description: "the first twelve", members: many.slice(0, 12).map((o) => o.key) },
    { key: "g2", description: "the rest", members: many.slice(12).map((o) => o.key) },
  ];

  it("asks once when the list fits", () => {
    const stage = choicePlan(opts("a", "b"), groups);
    expect(stage.kind).toBe("members");
    expect(stage.codes).toEqual(["A", "B"]);
  });

  it("asks about groups first past 20, then about the winner's members", () => {
    const stage = choicePlan(many, groups);
    expect(stage.kind).toBe("groups");
    expect(stage.options.map((o) => o.key)).toEqual(["g1", "g2"]);
    const second = stageFor(stage, "g2");
    expect(second?.kind).toBe("members");
    expect(second?.options).toHaveLength(12);
    expect(second?.codes).toHaveLength(12);
    expect(stageFor(stage, "nope")).toBeUndefined();
  });

  it("refuses groups that leave an option unreachable", () => {
    const partial: ChoiceGroup[] = [{ key: "g1", description: "some", members: many.slice(0, 12).map((o) => o.key) }];
    expect(() => choicePlan(many, partial)).toThrow(/unreachable/);
  });

  it("refuses to cascade with no groups at all", () => {
    expect(() => choicePlan(many)).toThrow(new RegExp(`${CHOICE_MAX_OPTIONS}-option ceiling`));
  });
});

describe("which server a provider block is", () => {
  it("believes serve: outright, then the default ports, then the name", () => {
    expect(choiceServerOf("anything", { base_url: "http://127.0.0.1:7813/v1", serve: { runtime: "llamaserver", port: 7813, extra_args: [] } as never })).toBe("llamaserver");
    expect(choiceServerOf("whatever", { base_url: "http://127.0.0.1:1234/v1" })).toBe("lmstudio");
    expect(choiceServerOf("whatever", { base_url: "http://127.0.0.1:11434/v1" })).toBe("ollama");
    expect(choiceServerOf("whatever", { base_url: "http://127.0.0.1:7810/v1" })).toBe("applefm");
    expect(choiceServerOf("ollama", { base_url: "http://127.0.0.1:9999/v1" })).toBe("ollama");
    expect(choiceServerOf("mystery", { base_url: "http://127.0.0.1:9999/v1" })).toBeUndefined();
  });
});

describe("the per-server request shape, as MEASURED on 2026-09-22", () => {
  const four = opts("a", "b", "c", "d");
  const base = { url: "http://x/v1/chat/completions", model: "m", messages: [{ role: "system" as const, content: "s" }], options: four, codes: codesFor(4) };

  it("ollama: one token, reasoning_effort none — without it the top token is the reasoning channel", () => {
    const body = choiceBody({ ...base, server: "ollama" });
    expect(body.max_tokens).toBe(1);
    expect(body.reasoning_effort).toBe("none");
    expect(body.logprobs).toBe(true);
    expect(body.temperature).toBe(0);
  });

  it("llama-server: one token, enable_thinking false", () => {
    expect(choiceBody({ ...base, server: "llamaserver" }).chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  it("LM Studio: TWO tokens and top_logprobs capped at 10 — at max_tokens 1 it answers logprobs: null, and past 10 it answers 400", () => {
    const body = choiceBody({ ...base, server: "lmstudio", topLogprobs: 20 });
    expect(body.max_tokens).toBe(2);
    expect(body.top_logprobs).toBe(10);
  });

  it("an unrecognised server gets the shape all three measured servers accept", () => {
    const body = choiceBody({ ...base, topLogprobs: 20 });
    expect(body.max_tokens).toBe(2);
    expect(body.top_logprobs).toBe(10);
  });

  it("the provider's own request: block is merged last, exactly as completeJson merges it", () => {
    const body = choiceBody({ ...base, server: "ollama", extra: { max_tokens: 3, keep_alive: "30m" } });
    expect(body.max_tokens).toBe(3);
    expect(body.keep_alive).toBe("30m");
  });

  it("Apple FM is declared as having no logprobs at all", () => {
    expect(CHOICE_WIRE.applefm.top_logprobs_max).toBeNull();
  });
});

describe("scoreChoiceOver", () => {
  const four = opts("a", "b", "c", "d");
  const base = { url: "http://x/v1/chat/completions", model: "m", messages: [{ role: "system" as const, content: "s" }], options: four, codes: codesFor(4) };

  it("scores, and sends the bearer where there is one", async () => {
    const server = fakeServer(answered([["C", Math.log(0.9)], ["A", Math.log(0.1)]]));
    const r = await scoreChoiceOver({ ...base, server: "ollama", bearer: "t", fetchFn: server.fn });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.key).toBe("c");
    expect(r.confidence).toBeCloseTo(choiceConfidence(0.9, 4), 6);
    expect(r.max_tokens).toBe(1);
  });

  it("refuses a server that structurally has no logprobs, by name, and calls nothing", async () => {
    const server = fakeServer(answered([["A", 0]]));
    const r = await scoreChoiceOver({ ...base, server: "applefm", fetchFn: server.fn });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.why).toMatch(/no answer-token logprobs|no per-token logits/);
    expect(server.sent).toHaveLength(0);
  });

  it("degrades with a reason on every absent-shaped case", async () => {
    const cases: Array<[string, RegExp]> = [];
    const nullLogprobs = fakeServer(() => ({ choices: [{ message: { content: "" }, logprobs: null }] }));
    const r1 = await scoreChoiceOver({ ...base, server: "lmstudio", fetchFn: nullLogprobs.fn });
    expect(r1.ok).toBe(false);
    if (!r1.ok) cases.push([r1.why, /without answer-token logprobs/]);

    const http500 = fakeServer(() => ({ error: "nope" }), 500);
    const r2 = await scoreChoiceOver({ ...base, server: "ollama", fetchFn: http500.fn });
    expect(r2.ok).toBe(false);
    if (!r2.ok) cases.push([r2.why, /HTTP 500/]);

    const boom = (async () => {
      throw new Error("down");
    }) as never;
    const r3 = await scoreChoiceOver({ ...base, server: "ollama", fetchFn: boom });
    expect(r3.ok).toBe(false);
    if (!r3.ok) cases.push([r3.why, /did not answer/]);

    const noAlphabet = fakeServer(answered([["The", -1], ["One", -2]]));
    const r4 = await scoreChoiceOver({ ...base, server: "ollama", fetchFn: noAlphabet.fn });
    expect(r4.ok).toBe(false);
    if (!r4.ok) cases.push([r4.why, /none of the 4 option codes/]);

    expect(cases).toHaveLength(4);
    for (const [why, re] of cases) expect(why).toMatch(re);
  });

  it("refuses a mismatched option/code list as a caller bug rather than scoring nonsense", async () => {
    const server = fakeServer(answered([["A", 0]]));
    const r = await scoreChoiceOver({ ...base, codes: ["A", "B"], fetchFn: server.fn });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toMatch(/caller bug/);
  });
});
