// The tool surface for the engine (§4.11, invariant 9). This file is the MCP
// client half of `engine-openai.ts`: `tools/list` once per run, `tools/call`
// per tool call, the run's own bearer, and nothing else.
//
// Why the seam. `ToolHost` is an interface with two methods, and the MCP
// client is one implementation of it. That is what lets the loop's tests run
// against a fake with no server, and — more importantly — it is what keeps
// the loop honest about its own surface: the engine can call a tool the host
// lists and NOTHING ELSE. There is no shell, no file, no fetch, and no
// "run this on provider X" (invariant 9, collaboration rule 2 — enforced by
// absence, not by prompting).
//
// Names carry the server prefix — `mcp__brain__<tool>` — so a `tools_used`
// tally, an allowlist and a `runs` row mean the same thing wherever they are
// read, and rows written before the scrub still line up with rows written
// after it.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { BRAIN_SERVER, newTurnId, TURN_ID_META_KEY } from "./brain.js";

/** One tool as the chat-completions wire wants it: a name, a description, and a JSON Schema for the arguments. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** What a tool call produced, flattened to text — the only thing an OpenAI-shaped `tool` message can carry. */
export interface ToolResult {
  text: string;
  isError: boolean;
}

export interface ToolHost {
  /** The tools this run may use. Called once per run: a mid-run change of surface would break the cached prompt prefix. */
  list(): Promise<ToolSpec[]>;
  call(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  close(): Promise<void>;
}

/** The empty surface. A turn with no brain configured runs tool-less rather than failing (degrades: absent). */
export const NO_TOOLS: ToolHost = {
  async list() {
    return [];
  },
  async call(name) {
    return { text: `no tools are configured in this deployment (METISTRY_BRAIN_URL); "${name}" was not called`, isError: true };
  },
  async close() {},
};

/**
 * The identity of a tool call: its name and its arguments, byte for byte.
 *
 * One definition, two readers — the loop's no-progress veto ("the same call
 * came back with the same answer") and shadow mode ("the real run already
 * made this exact call, so the shadow is handed that result instead of a
 * stub"). Two spellings of "the same call" would let those two mechanisms
 * disagree about what sameness is.
 */
export function toolCallKey(name: string, args: unknown): string {
  return `${name}(${JSON.stringify(args)})`;
}

/** `<tool>` → `mcp__brain__<tool>`, the spelling the allowlist and every `runs` row already use. */
export function qualify(tool: string): string {
  return `mcp__${BRAIN_SERVER}__${tool}`;
}

/** The inverse, for the `tools/call` the bridge actually understands. */
export function unqualify(name: string): string {
  return name.startsWith(`mcp__${BRAIN_SERVER}__`) ? name.slice(`mcp__${BRAIN_SERVER}__`.length) : name;
}

export interface McpToolHostOptions {
  /** The console's /mcp (METISTRY_BRAIN_URL). */
  url: string;
  /** This run's bearer — the assistant's own, or the per-run token the crew drain minted and burns after. */
  token: string;
  /**
   * Fully-qualified names this run may use; absent = everything the bridge
   * lists. A crew's `uses` list arrives here — as **defence in depth, not as
   * the control**: since P2 the door enforces a crew's toolset itself
   * (`may(principal, "act", {kind:"toolset"})` in `packages/core/src/access.ts`,
   * applied by `/mcp` before any tool body runs), so a call outside `uses`
   * is refused there whether or not this filter is in the loop. Keeping it
   * means the model is not offered a tool it cannot use, which costs a
   * refusal turn; removing the door's check would mean the allowlist was a
   * property of this process again (docs/ops/crews.md).
   */
  allow?: readonly string[] | undefined;
  /** Client identity on the wire; the assistant's NAME never appears (CLAUDE.md). */
  clientName?: string | undefined;
  /**
   * The correlation handle every call in this run carries. Absent = one is
   * minted here, which is the normal case: a host is built per run
   * (`cfg.tools(spec)` in engine-openai.ts), so "one id per reply" falls out
   * of the object's lifetime rather than out of the model remembering to.
   */
  turnId?: string | undefined;
}

/**
 * The `tools/call` params for one call: the bridge's name, the model's
 * arguments, and the turn handle in `_meta` — the spec's carrier for request
 * metadata, which is where it lives now that it is in no tool's schema
 * (`packages/mcp-brain/src/turn-id.ts`).
 *
 * Exported because it is the whole of the wire contract worth testing: a
 * handle that stops being sent breaks the activity feed's grouping silently.
 */
export function callParams(name: string, args: Record<string, unknown>, turnId: string): { name: string; arguments: Record<string, unknown>; _meta: Record<string, unknown> } {
  return { name, arguments: args, _meta: { [TURN_ID_META_KEY]: turnId } };
}

/**
 * The real host: one lazily-connected MCP client over Streamable HTTP.
 *
 * Lazy on purpose — a turn that never reaches a tool (a refused budget, a
 * one-line answer) opens no connection at all, which is the same
 * "tool discovery costs nothing until it is needed" property the bridge
 * contract asks of every TypeScript bridge.
 */
export function mcpToolHost(opts: McpToolHostOptions): ToolHost {
  let client: Client | undefined;
  const allow = opts.allow ? new Set(opts.allow) : undefined;
  // One handle for the life of this host, i.e. for this reply (above).
  const turnId = opts.turnId ?? newTurnId();

  const connect = async (): Promise<Client> => {
    if (client) return client;
    const c = new Client({ name: opts.clientName ?? "metistry-assistant", version: "1" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(opts.url), {
      requestInit: { headers: { Authorization: `Bearer ${opts.token}` } },
    });
    // The cast is the SDK's `sessionId?: string` against this repo's
    // `exactOptionalPropertyTypes` — a declaration mismatch in the library,
    // not a shape mismatch at runtime.
    await c.connect(transport as unknown as Transport);
    client = c;
    return c;
  };

  return {
    async list() {
      const c = await connect();
      const { tools } = await c.listTools();
      return tools
        .map((t) => ({
          name: qualify(t.name),
          description: (t.description ?? "").slice(0, 1024),
          parameters: (t.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>,
        }))
        .filter((t) => allow === undefined || allow.has(t.name));
    },
    async call(name, args) {
      if (allow !== undefined && !allow.has(name)) {
        // Defence in depth since P2, not the control: the door refuses this
        // same call with the uniform `forbidden` envelope and a `runs` row on
        // the crew's own id. This answer only spares the round trip — and the
        // model being told about the list is not a control either.
        return { text: `"${name}" is not in this run's tool list`, isError: true };
      }
      const c = await connect();
      const r = (await c.callTool(callParams(unqualify(name), args, turnId))) as {
        content?: { type?: string; text?: string }[];
        isError?: boolean;
      };
      const text = (r.content ?? [])
        .filter((b) => b?.type === "text" && typeof b.text === "string")
        .map((b) => b.text as string)
        .join("\n");
      return { text: text || "(no content)", isError: r.isError === true };
    },
    async close() {
      await client?.close().catch(() => {});
      client = undefined;
    },
  };
}
