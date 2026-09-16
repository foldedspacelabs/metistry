// The brain allowlist is the control (invariant 9): the assistant's entire
// tool surface is mcp-brain's exposed tools, fully qualified, and the list is
// locked to the bridge's own manifest so the two cannot drift. What ENFORCES
// it is the tool host (tools.ts `allow`), which the engine's tests exercise;
// this file locks the list and the config that reaches it. Pure functions —
// nothing here opens a socket.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { BRAIN_SERVER, BRAIN_TOOLS, brainConfigFromEnv, brainToolNames } from "../src/brain.js";
const manifest = parseYaml(readFileSync(new URL("../../../packages/mcp-brain/manifest.yaml", import.meta.url), "utf8")) as { exposes: { name: string }[] };

describe("brain allowlist", () => {
  it("is exactly mcp-brain's manifest, in order, fully qualified as mcp__brain__<tool>", () => {
    expect([...BRAIN_TOOLS]).toEqual(manifest.exposes.map((t) => t.name));
    expect(brainToolNames()).toEqual(manifest.exposes.map((t) => `mcp__${BRAIN_SERVER}__${t.name}`));
    expect(brainToolNames()).toHaveLength(25);
    expect(brainToolNames()).toContain("mcp__brain__queries_run"); // invariant 3's one read path, out to agents (internal always; external needs grants.queries)
    expect(brainToolNames()).toContain("mcp__brain__knowledge_write"); // the assistant's brain-commit rides the same allowlist; the bridge admits it for the internal principal only
    expect(brainToolNames()).toContain("mcp__brain__knowledge_grep"); // filesystem semantics over the same areas grant as knowledge_read
    expect(brainToolNames()).toContain("mcp__brain__agents_delegate"); // likewise internal-only; no crew's allowlist (crew.ts) ever carries it
  });

  it("the env is read as a pair: both halves or nothing, and a non-http URL is refused outright", () => {
    expect(brainConfigFromEnv({ METISTRY_BRAIN_URL: " http://console:8080/mcp ", METISTRY_ASSISTANT_TOKEN: "tok-123 " })).toEqual({
      url: "http://console:8080/mcp",
      token: "tok-123",
    });
    for (const env of [{}, { METISTRY_BRAIN_URL: "http://console:8080/mcp" }, { METISTRY_ASSISTANT_TOKEN: "tok" }, { METISTRY_BRAIN_URL: "", METISTRY_ASSISTANT_TOKEN: "tok" }]) {
      expect(brainConfigFromEnv(env), JSON.stringify(env)).toBeUndefined();
    }
    expect(() => brainConfigFromEnv({ METISTRY_BRAIN_URL: "console:8080/mcp", METISTRY_ASSISTANT_TOKEN: "tok" })).toThrow(/http\(s\)/);
  });
});
