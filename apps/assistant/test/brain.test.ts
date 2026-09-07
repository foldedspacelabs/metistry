// The option builder is the control (invariant 9): with the brain env, the
// SDK gets exactly one HTTP MCP server carrying the bearer and an allowlist
// of exactly the eighteen brain tools; without, no servers and no allowlist.
// Built-in tools are off either way, and the list is locked to mcp-brain's
// manifest so the two cannot drift. No live SDK call — pure functions.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { BRAIN_SERVER, BRAIN_TOOLS, brainConfigFromEnv, brainOptions, brainToolNames } from "../src/brain.js";
import { buildQueryOptions, tallyToolUse } from "../src/engine.js";

const manifest = parseYaml(readFileSync(new URL("../../../packages/mcp-brain/manifest.yaml", import.meta.url), "utf8")) as { exposes: { name: string }[] };

describe("brain allowlist", () => {
  it("is exactly mcp-brain's manifest, in order, fully qualified as mcp__brain__<tool>", () => {
    expect([...BRAIN_TOOLS]).toEqual(manifest.exposes.map((t) => t.name));
    expect(brainToolNames()).toEqual(manifest.exposes.map((t) => `mcp__${BRAIN_SERVER}__${t.name}`));
    expect(brainToolNames()).toHaveLength(18);
    expect(brainToolNames()).toContain("mcp__brain__knowledge_write"); // the assistant's brain-commit rides the same allowlist; the bridge admits it for the internal principal only
  });

  it("env present → one http server with the bearer header + the allowlist; built-ins off; foreign MCP config ignored", () => {
    const cfg = brainConfigFromEnv({ METISTRY_BRAIN_URL: " http://console:8080/mcp ", METISTRY_ASSISTANT_TOKEN: "tok-123 " });
    expect(cfg).toEqual({ url: "http://console:8080/mcp", token: "tok-123" });
    const o = brainOptions(cfg);
    expect(o).toEqual({
      tools: [],
      strictMcpConfig: true,
      mcpServers: { brain: { type: "http", url: "http://console:8080/mcp", headers: { Authorization: "Bearer tok-123" } } },
      allowedTools: brainToolNames(),
    });
    expect(Object.keys(o.mcpServers ?? {})).toEqual(["brain"]); // one server, ever
  });

  it("env absent (either half) → no servers, no allowlist, built-ins still off", () => {
    for (const env of [{}, { METISTRY_BRAIN_URL: "http://console:8080/mcp" }, { METISTRY_ASSISTANT_TOKEN: "tok" }, { METISTRY_BRAIN_URL: "", METISTRY_ASSISTANT_TOKEN: "tok" }]) {
      expect(brainConfigFromEnv(env), JSON.stringify(env)).toBeUndefined();
    }
    expect(brainOptions(undefined)).toEqual({ tools: [], strictMcpConfig: true });
    expect(() => brainConfigFromEnv({ METISTRY_BRAIN_URL: "console:8080/mcp", METISTRY_ASSISTANT_TOKEN: "tok" })).toThrow(/http\(s\)/);
  });
});

describe("query options", () => {
  const brain = { url: "http://console:8080/mcp", token: "t" };

  it("with a brain: the allowlist is the ONLY allowed set, nothing outside mcp__brain__ ever appears, and the shell/file tools stay disallowed", () => {
    const o = buildQueryOptions({ brain, systemPrompt: "You are X." }, "haiku", "sess-1");
    expect(o.allowedTools).toEqual(brainToolNames());
    expect(o.allowedTools?.every((t) => t.startsWith("mcp__brain__"))).toBe(true);
    expect(o.tools).toEqual([]);
    expect(o.disallowedTools).toEqual(expect.arrayContaining(["Bash", "Write", "Edit", "WebFetch", "Task", "Agent"]));
    expect(o).toMatchObject({ model: "haiku", resume: "sess-1", systemPrompt: "You are X.", permissionMode: "default", strictMcpConfig: true });
    expect(o.maxTurns).toBeGreaterThan(1); // tool use needs more than one agentic turn
  });

  it("without a brain: tool-less as before (no mcpServers, no allowedTools, maxTurns 4, no systemPrompt key)", () => {
    const o = buildQueryOptions({}, "haiku");
    expect(o).toEqual({ model: "haiku", tools: [], strictMcpConfig: true, disallowedTools: expect.any(Array), permissionMode: "default", maxTurns: 4 });
    expect("mcpServers" in o).toBe(false);
    expect("allowedTools" in o).toBe(false);
    expect("resume" in o).toBe(false);
    expect(buildQueryOptions({ maxTurns: 2 }, "haiku").maxTurns).toBe(2);
  });
});

describe("tools_used", () => {
  it("tallies tool_use blocks by name across assistant messages; ignores text and malformed content", () => {
    const into: Record<string, number> = {};
    tallyToolUse([{ type: "text", text: "hi" }, { type: "tool_use", name: "mcp__brain__capture", id: "1", input: {} }], into);
    tallyToolUse([{ type: "tool_use", name: "mcp__brain__capture", id: "2", input: {} }, { type: "tool_use", name: "mcp__brain__tasks_mine", id: "3", input: {} }], into);
    tallyToolUse("not an array", into);
    tallyToolUse([null, 1, {}], into);
    expect(into).toEqual({ mcp__brain__capture: 2, mcp__brain__tasks_mine: 1 });
  });
});
