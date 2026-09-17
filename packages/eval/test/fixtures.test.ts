// The fixture schema accepts what the owner will write and refuses what
// would make a failure unreadable. The rule with teeth: one axis per
// fixture (§3.2).
import { describe, expect, it } from "vitest";
import { axisCounts, composePrompt, Fixture, loadFixturesFromText, looksLikeMatcher, parseFixtureRows } from "../src/fixtures.js";

const toolCase = {
  id: "T01",
  axis: "tool_calls",
  prompt: "file the note about the boiler under the house area",
  expected: { tool_calls: [{ name: "knowledge_write", args_match: { path: { contains: "Areas" } } }] },
};

describe("accepting", () => {
  it("takes a tool_calls fixture and defaults the weight", () => {
    const parsed = Fixture.safeParse(toolCase);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.weight).toBe(1);
    expect(parsed.data.expected.tool_calls?.[0]?.args_match?.path).toEqual({ contains: "Areas" });
  });

  it("reads a bare value as an equals matcher, and a single-key matcher object as itself", () => {
    const parsed = Fixture.parse({ ...toolCase, expected: { tool_calls: [{ name: "capture", args_match: { text: "boiler", limit: { equals: 5 }, area: { any: true } } }] } });
    expect(parsed.expected.tool_calls?.[0]?.args_match).toEqual({ text: { equals: "boiler" }, limit: { equals: 5 }, area: { any: true } });
  });

  it("reads a multi-key object as a literal, not as a matcher", () => {
    expect(looksLikeMatcher({ equals: 1 })).toBe(true);
    expect(looksLikeMatcher({ equals: 1, regex: "x" })).toBe(false);
    expect(looksLikeMatcher({ contains: "x" })).toBe(true);
    expect(looksLikeMatcher({ name: "x" })).toBe(false);
    const parsed = Fixture.parse({ ...toolCase, expected: { tool_calls: [{ name: "capture", args_match: { meta: { a: 1, b: 2 } } }] } });
    expect(parsed.expected.tool_calls?.[0]?.args_match?.meta).toEqual({ equals: { a: 1, b: 2 } });
  });

  it("takes `expected.tool_calls: []` — \"the right answer here is to call nothing\"", () => {
    expect(Fixture.safeParse({ ...toolCase, expected: { tool_calls: [] } }).success).toBe(true);
  });

  it("takes a rubric fixture on each of the three judgment axes", () => {
    for (const axis of ["triage", "voice", "writing"]) {
      const parsed = Fixture.safeParse({ id: `R-${axis}`, axis, prompt: "p", expected: { rubric: "5 = …, 1 = …" } });
      expect(parsed.success, axis).toBe(true);
    }
  });
});

describe("refusing", () => {
  const bad = (fixture: unknown): string => {
    const parsed = Fixture.safeParse(fixture);
    expect(parsed.success).toBe(false);
    return parsed.success ? "" : parsed.error.issues.map((i) => i.message).join(" | ");
  };

  it("refuses a rubric on a deterministic axis — that is two axes in one fixture", () => {
    expect(bad({ ...toolCase, expected: { tool_calls: [], rubric: "5 = …" } })).toMatch(/mix two axes/);
  });

  it("refuses tool_calls or stop_after_turns on a rubric axis, for the same reason", () => {
    expect(bad({ id: "V1", axis: "voice", prompt: "p", expected: { rubric: "r", stop_after_turns: 2 } })).toMatch(/mix two axes/);
  });

  it("refuses a tool_calls fixture with nothing to compare against", () => {
    expect(bad({ id: "T2", axis: "tool_calls", prompt: "p", expected: { must_include: ["x"] } })).toMatch(/axis tool_calls requires expected\.tool_calls/);
  });

  it("refuses a stopping fixture with no turn limit", () => {
    expect(bad({ id: "S1", axis: "stopping", prompt: "p", expected: { must_include: ["x"] } })).toMatch(/requires expected\.stop_after_turns/);
  });

  it("refuses a fixture with no expectation at all", () => {
    expect(bad({ id: "N1", axis: "voice", prompt: "p", expected: {} })).toMatch(/no expectation/);
  });

  it("refuses an unknown axis, an unknown field, an empty prompt and an id that cannot be a filename", () => {
    expect(bad({ ...toolCase, axis: "vibes" })).toMatch(/expected one of|Invalid option/i);
    expect(bad({ ...toolCase, tier: "deep" })).toMatch(/[Uu]nrecognized|unknown/);
    expect(bad({ ...toolCase, prompt: "" })).toBeTruthy();
    expect(bad({ ...toolCase, id: "../escape" })).toMatch(/filename-safe/);
  });

  it("refuses a weight of zero — a fixture that counts for nothing is a fixture that should be deleted", () => {
    expect(bad({ ...toolCase, weight: 0 })).toBeTruthy();
  });
});

describe("loading", () => {
  it("reads JSONL, ignoring blank lines, and reports the line that was not JSON", () => {
    const text = `${JSON.stringify(toolCase)}\n\n{ nope\n${JSON.stringify({ ...toolCase, id: "T02" })}\n`;
    const { fixtures, issues } = loadFixturesFromText(text, "cases.jsonl");
    expect(fixtures.map((f) => f.id)).toEqual(["T01", "T02"]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toMatch(/line 3 is not JSON/);
  });

  it("reads the PoC-15 container shape — an object with a `fixtures` array", () => {
    const text = JSON.stringify({ _readme: "notes live at the top level and are ignored", fixtures: [toolCase] });
    const { fixtures, issues } = loadFixturesFromText(text, "fixtures.json");
    expect(issues).toEqual([]);
    expect(fixtures).toHaveLength(1);
  });

  it("reads a bare JSON array too", () => {
    expect(parseFixtureRows(JSON.stringify([toolCase]), "a.json").rows).toHaveLength(1);
  });

  it("refuses a duplicate id — the id is the join key between a run, a transcript and the report", () => {
    const text = `${JSON.stringify(toolCase)}\n${JSON.stringify(toolCase)}\n`;
    const { fixtures, issues } = loadFixturesFromText(text, "cases.jsonl");
    expect(fixtures).toHaveLength(1);
    expect(issues[0]?.message).toMatch(/duplicate id/);
  });

  it("counts per axis, so an axis with no coverage is visible", () => {
    const counts = axisCounts([Fixture.parse(toolCase), Fixture.parse({ id: "V9", axis: "voice", prompt: "p", expected: { rubric: "r" } })]);
    expect(counts).toEqual({ tool_calls: 1, stopping: 0, triage: 0, voice: 1, writing: 0 });
  });
});

describe("the composed turn", () => {
  it("lays brief, thread and prompt out in one fixed order, so two runs are the same bytes", () => {
    const f = Fixture.parse({ ...toolCase, context: { brief: "  two tasks are overdue  ", thread: "them: can you look at the boiler" } });
    expect(composePrompt(f)).toBe(
      "# Today's brief\n\ntwo tasks are overdue\n\n---\n\n# The thread so far\n\nthem: can you look at the boiler\n\n---\n\nfile the note about the boiler under the house area",
    );
    expect(composePrompt(f)).toBe(composePrompt(f));
  });

  it("is just the prompt when there is no context", () => {
    expect(composePrompt(Fixture.parse(toolCase))).toBe(toolCase.prompt);
  });
});
