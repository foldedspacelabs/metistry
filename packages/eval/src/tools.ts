// The fake `/mcp` the bake-off runs against, and the real tool DEFINITIONS it
// presents (§3.2 axis 1, §3.7 stage 2).
//
// Two halves, and the split is the point:
//
//   * THE DEFINITIONS ARE PRODUCTION'S. A tool-call fixture measures whether a
//     model can pick the right tool and fill in its arguments, which is a
//     question about the names and JSON Schemas the console actually
//     advertises. `brainToolDefs()` therefore asks `mcp-brain` itself — one
//     in-process server, a `tools/list`, no database — instead of a snapshot
//     that goes stale the first time a tool grows an argument. A test locks
//     the result to `TOOL_NAMES`.
//   * THE EXECUTION IS STUBBED, RECORD-ONLY. Nothing the candidate calls
//     touches a vault, a task or a row. This is the same contract stage 2's
//     shadow mode runs under ("tools stubbed record-only"), which is what
//     makes a bake-off score comparable with a shadow score.
//
// A call to a name that was never listed is recorded as a HALLUCINATION and
// answered with an error, rather than being quietly ignored: "no hallucinated
// tool" is half of what axis 1 measures.

import { toolSurface } from "@foldedspacelabs/metistry-mcp-brain";

/** The MCP server name the assistant qualifies brain tools with; `apps/assistant/src/brain.ts` holds the same constant. */
export const BRAIN_SERVER = "brain";

/** One tool as the chat-completions wire wants it — structurally the engine's own `ToolSpec`. */
export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface RecordedToolCall {
  name: string;
  args: Record<string, unknown>;
  is_error?: boolean;
}

/** `<tool>` → `mcp__brain__<tool>`, the spelling every `runs` row and allowlist already uses. */
export function qualify(tool: string): string {
  return tool.startsWith(`mcp__${BRAIN_SERVER}__`) ? tool : `mcp__${BRAIN_SERVER}__${tool}`;
}

/** The inverse. Fixtures may name either spelling; the scorer compares unqualified. */
export function unqualify(name: string): string {
  const prefix = `mcp__${BRAIN_SERVER}__`;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

/** The `tools/list` RESULT shape, from a file or a live bridge. Names are qualified on the way in. */
export function toolDefsFromListResult(raw: unknown): ToolDef[] {
  const tools = Array.isArray(raw) ? raw : Array.isArray((raw as { tools?: unknown } | null)?.tools) ? (raw as { tools: unknown[] }).tools : undefined;
  if (!tools) throw new Error("expected an MCP tools/list result: an array, or an object with a `tools` array");
  return tools.map((t, i) => {
    const tool = (t ?? {}) as { name?: unknown; description?: unknown; inputSchema?: unknown; parameters?: unknown };
    if (typeof tool.name !== "string" || tool.name === "") throw new Error(`tools[${i}] has no name`);
    const schema = tool.inputSchema ?? tool.parameters ?? { type: "object", properties: {} };
    return { name: qualify(tool.name), description: typeof tool.description === "string" ? tool.description : "", parameters: schema as Record<string, unknown> };
  });
}

/**
 * Production's tool surface, read from the bridge that serves it.
 *
 * `toolSurface()` (packages/mcp-brain/src/surface.ts) is the bridge's own
 * measurement contract — the same in-process server, fake `Db`, real
 * `tools/list` that `check-tool-surface.mjs` uses to budget the definition
 * tokens — reshaped into the chat-completions wire format a bake-off needs.
 * Nothing here needs Postgres, which is what lets a fixture validate on a
 * laptop with no stack running.
 */
export async function brainToolDefs(): Promise<ToolDef[]> {
  return toolDefsFromListResult(await toolSurface());
}

// ---- the recording host -------------------------------------------------------

/** The engine's `ToolHost`, structurally: one `list`, one `call`, one `close`. */
export interface ToolHostLike {
  list(): Promise<ToolDef[]>;
  call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
  close(): Promise<void>;
}

export interface RecordingToolHost extends ToolHostLike {
  /** Every call, in order, with the arguments as the model sent them. */
  readonly calls: RecordedToolCall[];
  /** Calls to names that were never listed. `no hallucinated tool` is scored off this. */
  readonly hallucinated: string[];
  /** How many calls came back as errors — the `tool_errors` trace column. */
  toolErrors(): number;
  /** Whether the candidate ever asked for the tool list at all. A model that never lists cannot be scored on tools. */
  listed(): boolean;
}

export interface RecordingHostOptions {
  /** Canned results by tool name, qualified or bare. A fixture that needs the model to react to a tool's answer supplies one. */
  responses?: Record<string, string> | undefined;
  /** What an un-canned tool answers. Deliberately says it was recorded, so a model reading it is not misled into thinking work happened. */
  defaultResponse?: string | undefined;
}

export const DEFAULT_STUB_RESULT = "(recorded; tools are stubbed record-only in this evaluation and nothing was changed)";

/**
 * A `/mcp` that lists production's tools and executes none of them. Every
 * call is appended to `calls` — which IS the record the `tool_calls` axis is
 * scored against and the `tool_calls` column of the run row.
 */
export function recordingToolHost(defs: readonly ToolDef[], opts: RecordingHostOptions = {}): RecordingToolHost {
  const calls: RecordedToolCall[] = [];
  const hallucinated: string[] = [];
  const known = new Map(defs.map((d) => [unqualify(d.name), d]));
  const responses = new Map(Object.entries(opts.responses ?? {}).map(([k, v]) => [unqualify(k), v]));
  const fallback = opts.defaultResponse ?? DEFAULT_STUB_RESULT;
  let didList = false;
  return {
    calls,
    hallucinated,
    toolErrors: () => calls.filter((c) => c.is_error === true).length,
    listed: () => didList,
    async list() {
      didList = true;
      return defs.map((d) => ({ ...d }));
    },
    async call(name, args) {
      const bare = unqualify(name);
      if (!known.has(bare)) {
        hallucinated.push(name);
        calls.push({ name, args, is_error: true });
        return { text: `no tool named "${name}" exists; call one of the tools you were given`, isError: true };
      }
      calls.push({ name, args });
      return { text: responses.get(bare) ?? fallback, isError: false };
    },
    async close() {},
  };
}
