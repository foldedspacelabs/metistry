// The fake `/mcp`: production's definitions, stubbed execution.
//
// The lock that matters is the first test — the definitions a bake-off
// presents are the ones the console actually advertises, read from
// `mcp-brain` itself. A snapshot would pass this suite for a year and then
// score a model on a tool surface that no longer exists.
import { describe, expect, it } from "vitest";
import { EAGER_TOOL_NAMES } from "@foldedspacelabs/metistry-mcp-brain";
import { brainToolDefs, DEFAULT_STUB_RESULT, qualify, recordingToolHost, toolDefsFromListResult, unqualify, type ToolDef } from "../src/tools.js";

describe("the definitions are production's", () => {
  it("lists exactly the brain bridge's tools, qualified the way every runs row already spells them", async () => {
    const defs = await brainToolDefs();
    // the EAGER surface: what a principal is actually presented with. A tool
    // registered per credential (propose_action) is not on it, and a bake-off
    // that scored against it would be scoring a surface no model was shown.
    expect(defs.map((d) => d.name)).toEqual(EAGER_TOOL_NAMES.map((n) => `mcp__brain__${n}`));
    expect(defs.length).toBeGreaterThan(10); // §3.2 axis 1 is "a tool loop over ~12 MCP tools"
  });

  it("carries each tool's JSON Schema, which is what an arguments expectation is written against", async () => {
    const defs = await brainToolDefs();
    const capture = defs.find((d) => unqualify(d.name) === "capture");
    expect(capture?.description.length).toBeGreaterThan(0);
    expect(capture?.parameters).toMatchObject({ type: "object" });
    // `note`, not `text` — which is exactly why a fixture's `args_match` is written against the live schema rather than from memory.
    expect(Object.keys((capture?.parameters as { properties: Record<string, unknown> }).properties)).toContain("note");
  });

  it("needs no database — a fixture validates on a laptop with nothing running", async () => {
    await expect(brainToolDefs()).resolves.toBeInstanceOf(Array);
  });
});

describe("reading a captured tools/list", () => {
  it("accepts the result object, a bare array, and either schema spelling", () => {
    const fromObject = toolDefsFromListResult({ tools: [{ name: "capture", description: "d", inputSchema: { type: "object" } }] });
    const fromArray = toolDefsFromListResult([{ name: "mcp__brain__capture", description: "d", parameters: { type: "object" } }]);
    expect(fromObject).toEqual(fromArray);
    expect(fromObject[0]?.name).toBe("mcp__brain__capture");
  });

  it("refuses something that is not a tools/list, and a tool with no name", () => {
    expect(() => toolDefsFromListResult({ nope: 1 })).toThrow(/expected an MCP tools\/list result/);
    expect(() => toolDefsFromListResult([{ description: "d" }])).toThrow(/tools\[0\] has no name/);
  });

  it("qualifies once, never twice", () => {
    expect(qualify("capture")).toBe("mcp__brain__capture");
    expect(qualify(qualify("capture"))).toBe("mcp__brain__capture");
    expect(unqualify(qualify("capture"))).toBe("capture");
  });
});

describe("the recording host", () => {
  const defs: ToolDef[] = [
    { name: "mcp__brain__capture", description: "c", parameters: { type: "object" } },
    { name: "mcp__brain__knowledge_search", description: "s", parameters: { type: "object" } },
  ];

  it("records every call in order with the arguments as sent, and executes nothing", async () => {
    const host = recordingToolHost(defs);
    expect(host.listed()).toBe(false);
    await host.list();
    expect(host.listed()).toBe(true);
    const first = await host.call("mcp__brain__capture", { note: "boiler" });
    await host.call("knowledge_search", { query: "boiler" });
    expect(first).toEqual({ text: DEFAULT_STUB_RESULT, isError: false });
    expect(first.text).toMatch(/nothing was changed/); // a model reading the result is not misled into thinking work happened
    expect(host.calls).toEqual([
      { name: "mcp__brain__capture", args: { note: "boiler" } },
      { name: "knowledge_search", args: { query: "boiler" } },
    ]);
  });

  it("answers a canned result where a fixture needs the model to react to one", async () => {
    const host = recordingToolHost(defs, { responses: { knowledge_search: "1 hit: Areas/House/Boiler.md" } });
    expect((await host.call("mcp__brain__knowledge_search", {})).text).toBe("1 hit: Areas/House/Boiler.md");
  });

  it("marks a call to a tool that was never listed as a hallucination and answers with an error", async () => {
    const host = recordingToolHost(defs);
    const res = await host.call("mcp__brain__send_email", { to: "x" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/no tool named "mcp__brain__send_email" exists/);
    expect(host.hallucinated).toEqual(["mcp__brain__send_email"]);
    expect(host.toolErrors()).toBe(1);
    expect(host.calls[0]).toMatchObject({ is_error: true });
  });

  it("gives each host its own empty log — one per case, never shared", async () => {
    const a = recordingToolHost(defs);
    const b = recordingToolHost(defs);
    await a.call("capture", {});
    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(0);
  });
});
