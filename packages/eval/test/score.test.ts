// The two axes that are scored in code, and the gates that apply to all five.
// Nothing here touches a model: the scorers are pure functions of
// (fixture, observation), which is what lets a rubric revision re-score
// stored rows without a re-run (§3.2).
import { describe, expect, it } from "vitest";
import { Fixture } from "../src/fixtures.js";
import { checkGates, matchesArg, matchesCall, needsJudge, scoreCase, scoreStopping, scoreToolCalls, type Observation } from "../src/score.js";

const obs = (over: Partial<Observation> = {}): Observation => ({ answer: "", calls: [], hallucinated: [], turns: 1, ...over });
const call = (name: string, args: Record<string, unknown> = {}, is_error?: boolean) => ({ name, args, ...(is_error ? { is_error } : {}) });

describe("argument matchers", () => {
  it("equals is a deep compare, order-insensitive on object keys", () => {
    expect(matchesArg({ a: 1, b: [2, 3] }, { equals: { b: [2, 3], a: 1 } })).toBe(true);
    expect(matchesArg({ a: 1 }, { equals: { a: 2 } })).toBe(false);
  });

  it("contains ignores case and whitespace, and reaches into an array of strings", () => {
    expect(matchesArg("Areas/Home", { contains: "areas" })).toBe(true);
    expect(matchesArg(["Areas/Home", "Areas/Work"], { contains: "areas/work" })).toBe(true);
    expect(matchesArg(["Areas/Home"], { contains: "areas/work" })).toBe(false);
  });

  it("regex is case-insensitive and stringifies a non-string argument", () => {
    expect(matchesArg("2026-09-16", { regex: "^\\d{4}-\\d{2}-\\d{2}$" })).toBe(true);
    expect(matchesArg(7, { regex: "^7$" })).toBe(true);
    expect(matchesArg("x", { regex: "[" })).toBe(false); // an unparseable pattern never matches; it does not throw mid-run
  });

  it("any means present, and an absent argument is not present", () => {
    expect(matchesArg("", { any: true })).toBe(true);
    expect(matchesArg(undefined, { any: true })).toBe(false);
  });

  it("matches on the unqualified name, so both spellings are the same fixture", () => {
    expect(matchesCall(call("mcp__brain__capture", { text: "x" }), { name: "capture" })).toBe(true);
    expect(matchesCall(call("capture", { text: "x" }), { name: "mcp__brain__capture" })).toBe(true);
  });

  it("checks only the arguments the fixture named — extras are allowed", () => {
    expect(matchesCall(call("capture", { text: "x", source: "eval" }), { name: "capture", args_match: { text: { equals: "x" } } })).toBe(true);
  });
});

describe("the tool_calls axis", () => {
  const f = Fixture.parse({
    id: "T1",
    axis: "tool_calls",
    prompt: "p",
    expected: { tool_calls: [{ name: "knowledge_search", args_match: { query: { contains: "boiler" } } }, { name: "capture" }] },
  });

  it("passes when every expectation is met, whatever else was called", () => {
    const s = scoreToolCalls(f, obs({ calls: [call("mcp__brain__knowledge_search", { query: "the boiler" }), call("mcp__brain__queries_list"), call("mcp__brain__capture", { text: "x" })] }));
    expect(s).toMatchObject({ pass: true, score: 1, reasons: [] });
  });

  it("scores partially and names the expectation that was missed", () => {
    const s = scoreToolCalls(f, obs({ calls: [call("capture")] }));
    expect(s.pass).toBe(false);
    expect(s.score).toBe(0.5);
    expect(s.reasons[0]).toMatch(/no call matched knowledge_search/);
  });

  it("needs one actual call per expectation — listing a tool twice means calling it twice", () => {
    const twice = Fixture.parse({ id: "T2", axis: "tool_calls", prompt: "p", expected: { tool_calls: [{ name: "capture" }, { name: "capture" }] } });
    expect(scoreToolCalls(twice, obs({ calls: [call("capture")] })).score).toBe(0.5);
    expect(scoreToolCalls(twice, obs({ calls: [call("capture"), call("capture")] })).score).toBe(1);
  });

  it("zeroes the case on a hallucinated tool even when every expectation was met", () => {
    const s = scoreToolCalls(f, obs({ calls: [call("knowledge_search", { query: "boiler" }), call("capture")], hallucinated: ["mcp__brain__send_email"] }));
    expect(s).toMatchObject({ pass: false, score: 0 });
    expect(s.reasons.join(" ")).toMatch(/hallucinated tool: mcp__brain__send_email/);
  });

  it("treats an empty expectation as \"call nothing\", and fails a turn that called something", () => {
    const none = Fixture.parse({ id: "T3", axis: "tool_calls", prompt: "p", expected: { tool_calls: [] } });
    expect(scoreToolCalls(none, obs()).pass).toBe(true);
    expect(scoreToolCalls(none, obs({ calls: [call("capture")] }))).toMatchObject({ pass: false, score: 0 });
  });
});

describe("the stopping axis", () => {
  const f = Fixture.parse({ id: "S1", axis: "stopping", prompt: "p", expected: { stop_after_turns: 2 } });

  it("passes a turn that stopped on its own inside the limit", () => {
    expect(scoreStopping(f, obs({ turns: 2 }))).toMatchObject({ pass: true, score: 1 });
  });

  it("fails a turn that ran long, and says by how much", () => {
    const s = scoreStopping(f, obs({ turns: 6 }));
    expect(s.pass).toBe(false);
    expect(s.reasons[0]).toMatch(/took 6 turns; the case stops in 2/);
  });

  it("fails a turn that was CUT OFF inside the limit — being vetoed is not stopping", () => {
    const s = scoreStopping(f, obs({ turns: 2, stopped: "veto" }));
    expect(s.pass).toBe(false);
    expect(s.reasons[0]).toMatch(/cut off \(veto\)/);
    expect(scoreStopping(f, obs({ turns: 1, stopped: "max_turns" })).pass).toBe(false);
  });

  it("does not fail a turn the BUDGET stopped — that is the harness's limit, not the model's judgment", () => {
    expect(scoreStopping(f, obs({ turns: 1, stopped: "max_budget" })).pass).toBe(true);
  });
});

describe("the gates, on every axis, before any judge call", () => {
  const f = Fixture.parse({ id: "W1", axis: "writing", prompt: "p", expected: { rubric: "r", must_include: ["Tuesday"], must_not_include: ["as an AI"], one_of: ["overdue", "late"] } });

  it("ignores case and whitespace — an expectation about words, not formatting", () => {
    expect(checkGates(f, "It is\n  overdue since   TUESDAY.")).toEqual([]);
  });

  it("names each gate it failed", () => {
    const reasons = checkGates(f, "as an AI I cannot say");
    expect(reasons).toHaveLength(3);
    expect(reasons.join(" ")).toMatch(/must_include.*Tuesday/);
    expect(reasons.join(" ")).toMatch(/must_not_include.*as an AI/);
    expect(reasons.join(" ")).toMatch(/one_of/);
  });

  it("fails the case at 0 without consulting the verdict", () => {
    const s = scoreCase(f, obs({ answer: "nothing here" }), { model: "google/gemini-3-pro", family: "google", verdict: 5, reason: "excellent" });
    expect(s).toMatchObject({ pass: false, score: 0 });
  });
});

describe("rubric cases", () => {
  const f = Fixture.parse({ id: "V1", axis: "voice", prompt: "p", expected: { rubric: "5 = the owner's voice" } });

  it("passes at 4 of 5 and fails at 3", () => {
    expect(scoreCase(f, obs({ answer: "a" }), { model: "google/gemini-3-pro", family: "google", verdict: 4, reason: "" })).toMatchObject({ pass: true, score: 0.8 });
    expect(scoreCase(f, obs({ answer: "a" }), { model: "google/gemini-3-pro", family: "google", verdict: 3, reason: "off" }).pass).toBe(false);
  });

  it("FAILS, never passes, when there is no verdict", () => {
    const s = scoreCase(f, obs({ answer: "a" }));
    expect(s).toMatchObject({ pass: false, score: 0 });
    expect(s.reasons[0]).toMatch(/absent judge fails the case/);
  });

  it("needs a judge only where a rubric was written", () => {
    expect(needsJudge(f)).toBe(true);
    expect(needsJudge(Fixture.parse({ id: "T9", axis: "tool_calls", prompt: "p", expected: { tool_calls: [] } }))).toBe(false);
    expect(needsJudge(Fixture.parse({ id: "X9", axis: "triage", prompt: "p", expected: { one_of: ["proposal", "noise"] } }))).toBe(false);
  });
});
