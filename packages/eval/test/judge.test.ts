// The judge rule (Atomic ADOPT 6): a third family, and an absent judge fails
// the run rather than passing the cases.
import { describe, expect, it } from "vitest";
import { assertThirdFamily, familyOf, judgeFromEnv, judgePrompt, openAiJudge, stripFence, JudgeFamilyError } from "../src/judge.js";
import { Fixture } from "../src/fixtures.js";

describe("familyOf", () => {
  it("takes the segment before the slash — OpenRouter's own naming", () => {
    expect(familyOf("anthropic/claude-sonnet-5")).toBe("anthropic");
    expect(familyOf("Qwen/Qwen3.6-35B-A3B")).toBe("qwen");
    expect(familyOf("google/gemini-3-flash-lite")).toBe("google");
  });

  it("maps a bare local id, tag and quant suffix stripped first", () => {
    expect(familyOf("qwen3.6:35b-a3b-q4_K_M")).toBe("qwen");
    expect(familyOf("gemma4:e4b")).toBe("google");
    expect(familyOf("granite8b")).toBe("ibm");
    expect(familyOf("claude-sonnet-5")).toBe("anthropic");
  });

  it("falls back to the id itself rather than guessing, so the rule fails safe", () => {
    expect(familyOf("some-new-model:q4")).toBe("some-new-model");
    expect(familyOf("")).toBe("");
  });
});

describe("the third-family rule", () => {
  const candidate = { model: "qwen3.6:35b-a3b-q4_K_M" };
  const bar = "anthropic/claude-sonnet-5";

  it("allows a judge from a third family", () => {
    expect(() => assertThirdFamily({ model: "google/gemini-3-pro" }, candidate, bar)).not.toThrow();
  });

  it("refuses the candidate's own family, however the two ids are spelled", () => {
    expect(() => assertThirdFamily({ model: "qwen/qwen3.6-72b" }, candidate, bar)).toThrow(JudgeFamilyError);
    try {
      assertThirdFamily({ model: "qwen/qwen3.6-72b" }, candidate, bar);
    } catch (err) {
      expect((err as JudgeFamilyError).code).toBe("judge_same_family");
      expect((err as Error).message).toMatch(/same family as the candidate/);
      expect((err as Error).message).toMatch(/METISTRY_EVAL_JUDGE_MODEL/); // R3: a refusal names the field that would permit it
    }
  });

  it("refuses the BAR's family — the bar is Claude, so a Claude judge marks its own homework", () => {
    expect(() => assertThirdFamily({ model: "anthropic/claude-haiku-5" }, candidate, bar)).toThrow(/same family as the bar/);
  });

  it("honours an explicit family for an id the map cannot place", () => {
    expect(() => assertThirdFamily({ model: "house-blend:q4", family: "qwen" }, candidate)).toThrow(JudgeFamilyError);
    expect(() => assertThirdFamily({ model: "house-blend:q4", family: "cohere" }, candidate, bar)).not.toThrow();
  });
});

describe("the judge call", () => {
  const fixture = Fixture.parse({ id: "V1", axis: "voice", prompt: "how did the week go?", expected: { rubric: "5 = the owner's voice, 1 = a press release" }, context: { brief: "two tasks overdue" } });

  it("puts the rubric, the request and the answer in the prompt and nothing else", () => {
    const { system, user } = judgePrompt({ fixture, answer: "Two things slipped." });
    expect(system).toMatch(/verdict/);
    expect(user).toContain("5 = the owner's voice");
    expect(user).toContain("how did the week go?");
    expect(user).toContain("Two things slipped.");
    expect(user).toContain("two tasks overdue");
  });

  it("parses a fenced reply and returns the verdict with its family", async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '```json\n{"verdict": 4, "reason": "close enough"}\n```' } }] }), { status: 200 })) as unknown as typeof fetch;
    const judge = openAiJudge({ model: "google/gemini-3-pro", baseUrl: "https://example.invalid/v1/", fetchFn });
    await expect(judge({ fixture, answer: "a" })).resolves.toEqual({ model: "google/gemini-3-pro", family: "google", verdict: 4, reason: "close enough" });
  });

  it("throws on a non-2xx, on prose, and on the wrong shape — every one of which fails the CASE", async () => {
    const withBody = (body: string, status = 200) =>
      openAiJudge({ model: "google/gemini-3-pro", baseUrl: "https://example.invalid/v1", fetchFn: (async () => new Response(body, { status })) as unknown as typeof fetch });
    await expect(withBody("nope", 500)({ fixture, answer: "a" })).rejects.toThrow(/returned 500/);
    await expect(withBody(JSON.stringify({ choices: [{ message: { content: "I think it is fine" } }] }))({ fixture, answer: "a" })).rejects.toThrow(/did not answer with JSON/);
    await expect(withBody(JSON.stringify({ choices: [{ message: { content: '{"verdict": 9, "reason": "x"}' } }] }))({ fixture, answer: "a" })).rejects.toThrow(/wrong shape/);
  });

  it("strips a fence and leaves plain JSON alone", () => {
    expect(stripFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripFence(' {"a":1} ')).toBe('{"a":1}');
  });
});

describe("judgeFromEnv", () => {
  it("is undefined until both the model and the base URL are set — absence is not an error here", () => {
    expect(judgeFromEnv({})).toBeUndefined();
    expect(judgeFromEnv({ METISTRY_EVAL_JUDGE_MODEL: "google/gemini-3-pro" })).toBeUndefined();
  });

  it("carries the family override through to the config", () => {
    const found = judgeFromEnv({ METISTRY_EVAL_JUDGE_MODEL: "house-blend", METISTRY_EVAL_JUDGE_BASE_URL: "http://127.0.0.1:1234/v1", METISTRY_EVAL_JUDGE_FAMILY: "cohere" });
    expect(found?.config).toEqual({ model: "house-blend", family: "cohere" });
  });
});
