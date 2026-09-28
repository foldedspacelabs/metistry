// The brain allowlist is the control (invariant 9): the assistant's entire
// tool surface is mcp-brain's exposed tools, fully qualified, and the list is
// locked to the bridge's own manifest so the two cannot drift. What ENFORCES
// it is the tool host (tools.ts `allow`), which the engine's tests exercise;
// this file locks the list and the config that reaches it. Pure functions —
// nothing here opens a socket.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { BRAIN_SERVER, BRAIN_TOOLS, brainConfigFromEnv, brainToolNames, INTERACTIVE_META_KEY, newTurnId, TURN_ID_META_KEY } from "../src/brain.js";
import { callParams } from "../src/tools.js";
const manifest = parseYaml(readFileSync(new URL("../../../packages/mcp-brain/manifest.yaml", import.meta.url), "utf8")) as { exposes: { name: string }[] };
/** The bridge's own copy of the `_meta` key and of the shape it will store, read as TEXT — the assistant does not import the bridge, it talks to it over HTTP. */
const bridgeTurnId = readFileSync(new URL("../../../packages/mcp-brain/src/turn-id.ts", import.meta.url), "utf8");

describe("brain allowlist", () => {
  it("is exactly mcp-brain's manifest, in order, fully qualified as mcp__brain__<tool>", () => {
    expect([...BRAIN_TOOLS]).toEqual(manifest.exposes.map((t) => t.name));
    expect(brainToolNames()).toEqual(manifest.exposes.map((t) => `mcp__${BRAIN_SERVER}__${t.name}`));
    expect(brainToolNames()).toHaveLength(29);
    expect(brainToolNames()).toContain("mcp__brain__connections_call"); // the proxy's lazy pair (T4-8b): the assistant reaches every connection; the bridge decides for everyone else
    expect(brainToolNames()).toContain("mcp__brain__propose_action"); // on the list because the list is the manifest; the BRIDGE registers it per credential (docs/ops/actions.md)
    expect(brainToolNames()).toContain("mcp__brain__queries_run"); // invariant 3's one read path, out to agents (internal always; external needs grants.queries)
    expect(brainToolNames()).toContain("mcp__brain__knowledge_write"); // the assistant's brain-commit rides the same allowlist; the bridge admits it for the internal principal only
    expect(brainToolNames()).toContain("mcp__brain__knowledge_grep"); // filesystem semantics over the same areas grant as knowledge_read
    expect(brainToolNames()).toContain("mcp__brain__agents_delegate"); // likewise internal-only; no crew's allowlist (crew.ts) ever carries it
    expect(brainToolNames()).toContain("mcp__brain__request_access"); // the mirror case: the bridge refuses it FOR the internal principal, and says where its scope really lives
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

// The turn handle stopped being a tool PARAMETER (938 definition tokens, 18.8%
// of the advertised surface) and became `_meta` on the call, which also moved
// it from the model's hands into the client's. Two ways that silently breaks
// the activity feed's grouping: the key drifts from the bridge's, or the id
// the client mints is not a shape the bridge will store. Both are locked here.
describe("the turn handle on the wire", () => {
  it("uses the same _meta key the bridge reads", () => {
    expect(TURN_ID_META_KEY).toBe("com.foldedspacelabs.metistry/turn_id");
    expect(bridgeTurnId).toContain(`export const TURN_ID_META_KEY = "${TURN_ID_META_KEY}";`);
  });

  it("mints a fresh id per reply, in a shape the bridge accepts", () => {
    expect(bridgeTurnId).toContain("/^[A-Za-z0-9_-]{1,64}$/"); // validTurnId's bound, verbatim
    const ids = new Set(Array.from({ length: 100 }, () => newTurnId()));
    expect(ids.size).toBe(100);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });

  it("puts it in _meta and never in the arguments the model wrote", () => {
    expect(callParams("knowledge_read", { path: "Areas/Fsl/Note.md" }, "turn-7")).toEqual({
      name: "knowledge_read",
      arguments: { path: "Areas/Fsl/Note.md" },
      _meta: { [TURN_ID_META_KEY]: "turn-7" },
    });
    expect(callParams("queries_list", {}, "turn-7").arguments).toEqual({});
  });

  it("carries the interactive bit beside it, under the key the bridge reads — and only when the run said (C59)", () => {
    expect(INTERACTIVE_META_KEY).toBe("com.foldedspacelabs.metistry/interactive");
    expect(bridgeTurnId).toContain(`export const INTERACTIVE_META_KEY = "${INTERACTIVE_META_KEY}";`);
    expect(callParams("connections_call", { connection: "github", tool: "comment_issue" }, "turn-8", false)).toEqual({
      name: "connections_call",
      arguments: { connection: "github", tool: "comment_issue" },
      _meta: { [TURN_ID_META_KEY]: "turn-8", [INTERACTIVE_META_KEY]: false },
    });
    expect(callParams("connections_call", {}, "turn-8", true)._meta).toEqual({ [TURN_ID_META_KEY]: "turn-8", [INTERACTIVE_META_KEY]: true });
    expect(callParams("connections_call", {}, "turn-8")._meta).toEqual({ [TURN_ID_META_KEY]: "turn-8" }); // unsaid: the bridge's interactive default
  });
});
