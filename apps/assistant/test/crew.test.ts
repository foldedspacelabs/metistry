// The crew runner's controls, without a live SDK call: the allowlist builder
// is exhaustive against mcp-brain's manifest (every tool is in exactly one
// group or is a never-tool), the option object carries the crew's model,
// its per-run bearer, its tool groups and nothing else, and the runner maps
// the SDK's result subtypes to outcomes. Pure functions plus a fake stream.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { CREW_NEVER_TOOLS, CREW_TOOL_GROUPS } from "@foldedspacelabs/metistry-core";
import { BRAIN_TOOLS, brainToolNames } from "../src/brain.js";
import { buildCrewOptions, crewSystemPrompt, crewToolNames, crewUserPrompt, parseCrewSnapshot, runCrew, type CrewSnapshot } from "../src/crew.js";

const manifest = parseYaml(readFileSync(new URL("../../../packages/mcp-brain/manifest.yaml", import.meta.url), "utf8")) as { exposes: { name: string }[] };
const seedFile = readFileSync(new URL("../../../seed/agents/example/researcher.md", import.meta.url), "utf8");

const researcher: CrewSnapshot = {
  name: "researcher",
  area: "example",
  model: "haiku",
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
    expect(everything).not.toContain("mcp__brain__crew_dispatch");
    expect(everything).toHaveLength(BRAIN_TOOLS.length - CREW_NEVER_TOOLS.length);
  });
});

describe("crew options", () => {
  const brain = { url: "http://console:8080/mcp", token: "run-token-xyz" };

  it("model, per-run bearer on the ONE server, allowlist = exactly the groups, built-ins off, foreign MCP ignored, turns + budget from the manifest", () => {
    const o = buildCrewOptions({ crew: researcher, brief: "b", brain, identity: { name: "Tester" } });
    expect(o).toMatchObject({
      model: "haiku",
      tools: [],
      strictMcpConfig: true,
      mcpServers: { brain: { type: "http", url: "http://console:8080/mcp", headers: { Authorization: "Bearer run-token-xyz" } } },
      allowedTools: ["mcp__brain__knowledge_search", "mcp__brain__knowledge_read", "mcp__brain__knowledge_list", "mcp__brain__knowledge_grep", "mcp__brain__requests_create"],
      permissionMode: "default",
      maxTurns: 7,
      maxBudgetUsd: 0.2,
    });
    expect(Object.keys(o.mcpServers ?? {})).toEqual(["brain"]);
    expect(o.disallowedTools).toEqual(expect.arrayContaining(["Bash", "Write", "Edit", "WebFetch", "Task", "Agent"]));
    expect("resume" in o).toBe(false); // every run is a fresh session
    expect(o.allowedTools?.every((t) => t.startsWith("mcp__brain__"))).toBe(true);
  });

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
    expect(snap).toMatchObject({ name: "researcher", model: "haiku", uses: ["knowledge", "requests"], max_turns: 10, budget_usd_per_run: 0.25, prompt: "p" });
    expect(() => parseCrewSnapshot({ ...researcher, uses: ["knowledge_write"] })).toThrow(/never available to a crew/);
    expect(() => parseCrewSnapshot({ ...researcher, prompt: "  " })).toThrow(/no operating prompt/);
    expect(() => parseCrewSnapshot({ ...researcher, model: "gpt" })).toThrow(/model/);
    expect(() => parseCrewSnapshot({ ...researcher, sha256: "nope" })).toThrow(/sha256/);
    expect(() => parseCrewSnapshot(null)).toThrow(/missing/);
  });
});

function fakeStream(messages: unknown[]) {
  return async function* () {
    for (const m of messages) yield m as SDKMessage;
  };
}
const init = { type: "system", subtype: "init", session_id: "sess-9" };
const toolTurn = { type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__brain__knowledge_read", id: "1", input: {} }, { type: "tool_use", name: "mcp__brain__requests_create", id: "2", input: {} }] } };

describe("runCrew (fake SDK)", () => {
  const input = { crew: researcher, brief: "do X", brain: { url: "http://c/mcp", token: "t" } };

  it("success → ok with cost, tokens, tool tally, text length (never the text); the prompt + options reach the SDK", async () => {
    let seen: { prompt: string; options: Record<string, unknown> } | null = null;
    const sdk = (prompt: string, options: Record<string, unknown>) => {
      seen = { prompt, options };
      return fakeStream([init, toolTurn, { type: "result", subtype: "success", is_error: false, result: "the answer", num_turns: 3, total_cost_usd: 0.0123, usage: { input_tokens: 100, output_tokens: 40 }, session_id: "sess-9" }])();
    };
    const r = await runCrew(input, sdk as never);
    expect(r).toEqual({ outcome: "ok", session_id: "sess-9", num_turns: 3, tokens_in: 100, tokens_out: 40, cost_usd: 0.0123, tools_used: { mcp__brain__knowledge_read: 1, mcp__brain__requests_create: 1 }, text_chars: 10 });
    expect(seen!.prompt).toBe("do X");
    expect(seen!.options).toMatchObject({ model: "haiku", maxTurns: 7, maxBudgetUsd: 0.2, allowedTools: crewToolNames(researcher.uses) });
  });

  it("error_max_budget_usd → max_budget; error_max_turns → max_turns; an is_error success → error with the text as the error; no result → throws", async () => {
    const budget = await runCrew(input, fakeStream([init, { type: "result", subtype: "error_max_budget_usd", is_error: true, num_turns: 9, total_cost_usd: 0.21, usage: {}, session_id: "s", errors: ["budget"] }]) as never);
    expect(budget).toMatchObject({ outcome: "max_budget", cost_usd: 0.21, num_turns: 9, errors: ["budget"] });
    const turns = await runCrew(input, fakeStream([init, { type: "result", subtype: "error_max_turns", is_error: true, num_turns: 7, total_cost_usd: 0.05, usage: {}, session_id: "s", errors: [] }]) as never);
    expect(turns).toMatchObject({ outcome: "max_turns" });
    expect("errors" in turns).toBe(false);
    const apiErr = await runCrew(input, fakeStream([init, { type: "result", subtype: "success", is_error: true, result: "API 529", num_turns: 1, total_cost_usd: 0, usage: {}, session_id: "s" }]) as never);
    expect(apiErr).toMatchObject({ outcome: "error", errors: ["API 529"], text_chars: 7 });
    await expect(runCrew(input, fakeStream([init]) as never)).rejects.toThrow(/no result message/);
  });
});
