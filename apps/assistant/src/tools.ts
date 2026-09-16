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
import { BRAIN_SERVER } from "./brain.js";

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
  /** Fully-qualified names this run may use; absent = everything the bridge lists. A crew's `uses` list arrives here. */
  allow?: readonly string[] | undefined;
  /** Client identity on the wire; the assistant's NAME never appears (CLAUDE.md). */
  clientName?: string | undefined;
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
        // The allowlist is the control; the model being told about it is not.
        return { text: `"${name}" is not in this run's tool list`, isError: true };
      }
      const c = await connect();
      const r = (await c.callTool({ name: unqualify(name), arguments: args })) as {
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
