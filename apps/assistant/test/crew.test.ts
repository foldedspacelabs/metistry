// The crew runner's controls, without a live call: the allowlist builder is
// exhaustive against mcp-brain's manifest (every tool is in exactly one group
// or is a never-tool), the turn the engine is handed carries the crew's own
// assignment, turns and budget and never a session to resume, and the runner
// maps a stopped loop to an outcome. Pure functions plus a fake engine.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { CREW_NEVER_TOOLS, CREW_TOOL_GROUPS, parseCompute, resolveAssignment } from "@foldedspacelabs/metistry-core";
import { BRAIN_TOOLS, brainToolNames } from "../src/brain.js";
import { crewSystemPrompt, crewToolNames, crewUserPrompt, parseCrewSnapshot, runCrewOnEngine, type CrewSnapshot } from "../src/crew.js";
import type { Engine, TurnResult, TurnSpec } from "../src/engine.js";

const manifest = parseYaml(readFileSync(new URL("../../../packages/mcp-brain/manifest.yaml", import.meta.url), "utf8")) as { exposes: { name: string }[] };
const seedFile = readFileSync(new URL("../../../seed/agents/example/researcher.md", import.meta.url), "utf8");

const researcher: CrewSnapshot = {
  name: "researcher",
  area: "example",
  model: "haiku",
  effort: "low",
  uses: ["brain-read", "brain-report"],
  skills: [],
  scope: ["Knowledge/Projects"],
  projects: [],
  manages: [],
  max_turns: 7,
  budget_usd_per_run: 0.2,
  prompt: "You research for {{name}}.",
  sha256: "a".repeat(64),
};

describe("allowlist from tool groups", () => {
  it("is exhaustive against mcp-brain's manifest: every tool is in exactly one group, or is a never-tool (knowledge_write, agents_delegate)", () => {
    const all = manifest.exposes.map((t) => t.name);
    const grouped = Object.values(CREW_TOOL_GROUPS).flat() as string[];
    expect(new Set(grouped).size).toBe(grouped.length); // no tool in two groups
    expect([...grouped, ...CREW_NEVER_TOOLS].sort()).toEqual([...all].sort());
    expect(all).toEqual([...BRAIN_TOOLS]); // and the assistant's own list is still the whole manifest
    for (const t of grouped) expect(brainToolNames()).toContain(`mcp__brain__${t}`);
  });

  it("maps uses → fully-qualified names, aliases included, never the write or dispatch tools", () => {
    expect(crewToolNames(["brain-read", "brain-report"])).toEqual([
      "mcp__brain__knowledge_search",
      "mcp__brain__knowledge_read",
      "mcp__brain__knowledge_list",
      "mcp__brain__knowledge_grep",
      "mcp__brain__requests_create",
    ]);
    expect(crewToolNames(["tasks", "capture"])).toEqual(["mcp__brain__capture", ...CREW_TOOL_GROUPS.tasks.map((t) => `mcp__brain__${t}`)]);
    expect(crewToolNames([])).toEqual([]);
    const everything = crewToolNames(Object.keys(CREW_TOOL_GROUPS));
    expect(everything).not.toContain("mcp__brain__knowledge_write");
    expect(everything).not.toContain("mcp__brain__agents_delegate");
    expect(everything).toHaveLength(BRAIN_TOOLS.length - CREW_NEVER_TOOLS.length);
  });
});

describe("crew options", () => {
  it("system prompt = the operating prompt templated from identity (never a hardcoded name) + the fixed trailer; user prompt = the brief + task handle", () => {
    const sys = crewSystemPrompt(researcher, { name: "Tester" });
    expect(sys.startsWith("You research for Tester.")).toBe(true);
    expect(sys).toMatch(/## How this run works/);
    expect(sys).toMatch(/reply text is NOT read/);
    expect(sys).toMatch(/cannot write knowledge and cannot dispatch other crews/);
    expect(crewSystemPrompt(researcher)).toContain("{{name}}"); // no identity: left visible, not silently blanked
    expect(crewUserPrompt("do X", 42)).toBe("do X\n\n---\nRelated task on the shared list: #42 (a handle — claim it with tasks_claim only if it is in your projects).");
    expect(crewUserPrompt("do X")).toBe("do X");
  });

  it("parseCrewSnapshot re-validates through core's schema: the seed snapshot passes; a snapshot with a write tool, no prompt, or a bad model is refused", () => {
    const fm = parseYaml(/^---\n([\s\S]*?)\n---/.exec(seedFile)![1]!) as Record<string, unknown>;
    const { type: _t, ...rest } = fm;
    const snap = parseCrewSnapshot({ ...rest, prompt: "p", sha256: "b".repeat(64) });
    expect(snap).toMatchObject({ name: "researcher", model: "haiku", effort: "low", uses: ["knowledge", "requests"], max_turns: 10, budget_usd_per_run: 0.25, prompt: "p" });
    // effort is optional in the manifest and defaults to low — an older crew file keeps working, cheaply
    const { effort: _e, ...noEffort } = rest;
    expect(parseCrewSnapshot({ ...noEffort, prompt: "p", sha256: "b".repeat(64) }).effort).toBe("low");
    expect(() => parseCrewSnapshot({ ...researcher, effort: "extreme" })).toThrow(/effort/);
    expect(() => parseCrewSnapshot({ ...researcher, uses: ["knowledge_write"] })).toThrow(/never available to a crew/);
    expect(() => parseCrewSnapshot({ ...researcher, prompt: "  " })).toThrow(/no operating prompt/);
    expect(() => parseCrewSnapshot({ ...researcher, model: "gpt" })).toThrow(/model/);
    expect(() => parseCrewSnapshot({ ...researcher, sha256: "nope" })).toThrow(/sha256/);
    expect(() => parseCrewSnapshot(null)).toThrow(/missing/);
  });
});

// The crew's own assignment (collaboration rule 3): `assignments.crews.<name>`
// decides the provider, and a crew nothing assigns never reaches here at all
// — the drain parks its row (crew-drain.ts).
const compute = parseCompute(`
providers:
  bench: { kind: openai-compatible, base_url: "http://127.0.0.1:1/v1", locality: on_machine }
assignments:
  default: { model: bench/generalist }
  crews: { researcher: { model: bench/small, effort: low } }
`);
const assignment = resolveAssignment(compute, "crew:researcher")!;

describe("runCrewOnEngine (fake engine)", () => {
  const input = { crew: researcher, brief: "do X", brain: { url: "http://c/mcp", token: "t" } };
  const result = (over: Partial<TurnResult> = {}): TurnResult => ({
    text: "the answer",
    session_id: "sess-9",
    tokens_in: 100,
    tokens_out: 40,
    cost_usd: 0.0123,
    turns: 3,
    tools_used: { mcp__brain__knowledge_read: 1, mcp__brain__requests_create: 1 },
    ...over,
  });

  it("hands the engine the crew's assignment, turns and budget — never a session to resume — and reports the accounting, never the text", async () => {
    let seen: { prompt: string; spec: TurnSpec } | null = null;
    const engine: Engine = async (prompt, spec) => {
      seen = { prompt, spec };
      return result();
    };
    const r = await runCrewOnEngine(input, assignment, engine);
    expect(r).toEqual({
      outcome: "ok",
      session_id: "sess-9",
      num_turns: 3,
      tokens_in: 100,
      tokens_out: 40,
      cost_usd: 0.0123,
      tools_used: { mcp__brain__knowledge_read: 1, mcp__brain__requests_create: 1 },
      text_chars: 10,
    });
    expect(seen!.prompt).toBe("do X");
    expect(seen!.spec).toMatchObject({ model: "small", effort: "low", tier: "crew:researcher", maxTurns: 7, maxCostUsd: 0.2 });
    expect(seen!.spec.assignment?.provider).toBe("bench");
    expect(seen!.spec.thread).toBe("crew:researcher"); // its own thread, never a person's
    expect(seen!.spec.resume).toBeUndefined(); // decision 3: a crew run never resumes a prior session
  });

  it("a stopped loop is an OUTCOME, not a throw: max_budget and max_turns come back with the accounting, and notes ride as errors", async () => {
    const stopped = async (over: Partial<TurnResult>) => runCrewOnEngine(input, assignment, async () => result(over));
    expect(await stopped({ stopped: "max_budget", cost_usd: 0.21, turns: 9, notes: ["budget"] })).toMatchObject({ outcome: "max_budget", cost_usd: 0.21, num_turns: 9, errors: ["budget"] });
    const turns = await stopped({ stopped: "max_turns", turns: 7 });
    expect(turns).toMatchObject({ outcome: "max_turns" });
    expect("errors" in turns).toBe(false);
    // the veto still ANSWERS, so it is an ordinary run as far as the queue is concerned
    expect(await stopped({ stopped: "veto" })).toMatchObject({ outcome: "ok" });
  });

  it("an infrastructure failure is the engine's to throw — the drain decides retry or park, not this function", async () => {
    await expect(
      runCrewOnEngine(input, assignment, async () => {
        throw new Error("provider down");
      }),
    ).rejects.toThrow(/provider down/);
  });
});
