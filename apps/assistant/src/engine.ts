// The reference engine (§4.18.C): Claude Agent SDK behind the documented
// contract — messages in, sessions rows, every call logged to runs.
// Invariant 9: the engine has no shell and no raw git. Its ONLY tools are
// mcp-brain's, mounted as one HTTP MCP server when configured (brain.ts);
// built-in tools are disabled outright and the SDK is told to ignore every
// other MCP source. Absent the brain config, the engine runs tool-less.

import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { brainOptions, type BrainConfig } from "./brain.js";

export interface TurnResult {
  text: string;
  session_id: string;
  tokens_in?: number;
  tokens_out?: number;
  cost_usd?: number;
  /** Tool calls the turn made, by name (`mcp__brain__capture`), with counts. Absent when none. */
  tools_used?: Record<string, number>;
}

/** One turn. `resume` continues an existing SDK session (PoC-4). */
export type Engine = (prompt: string, model: string, resume?: string) => Promise<TurnResult>;

export interface EngineConfig {
  /** The console's mcp-brain; undefined = tool-less. */
  brain?: BrainConfig | undefined;
  /** Identity-templated system prompt (prompt.ts); undefined = the SDK's default (none). */
  systemPrompt?: string | undefined;
  /** Agentic turns per message. Tool use needs more than one; 4 was the tool-less default. */
  maxTurns?: number | undefined;
}

// Kept alongside `tools: []` (brain.ts) as belt and braces: these must never
// come back through any option the SDK grows later.
const DISALLOWED = ["Bash", "Write", "Edit", "NotebookEdit", "WebFetch", "WebSearch", "Task", "Agent"];

/** The whole SDK option object for one turn — pure, so the allowlist is testable without a live call. */
export function buildQueryOptions(cfg: EngineConfig, model: string, resume?: string): Options {
  return {
    model,
    ...(resume ? { resume } : {}),
    ...(cfg.systemPrompt ? { systemPrompt: cfg.systemPrompt } : {}),
    ...brainOptions(cfg.brain),
    disallowedTools: DISALLOWED,
    permissionMode: "default",
    maxTurns: cfg.maxTurns ?? (cfg.brain ? 12 : 4),
  };
}

/** Count `tool_use` blocks in an assistant message's content, by tool name. */
export function tallyToolUse(content: unknown, into: Record<string, number>): void {
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: unknown }).type === "tool_use") {
      const name = String((block as { name?: unknown }).name ?? "?");
      into[name] = (into[name] ?? 0) + 1;
    }
  }
}

export function makeSdkEngine(cfg: EngineConfig): Engine {
  return async (prompt, model, resume) => {
    const stream = query({ prompt, options: buildQueryOptions(cfg, model, resume) });

    let text = "";
    let sessionId = resume ?? "";
    let usage: any = {};
    let cost: number | undefined;
    const tools: Record<string, number> = {};
    for await (const msg of stream) {
      if (msg.type === "system" && msg.subtype === "init") sessionId = msg.session_id;
      if (msg.type === "assistant") tallyToolUse(msg.message?.content, tools);
      if (msg.type === "result") {
        if (msg.subtype === "success") text = msg.result;
        usage = (msg as any).usage ?? {};
        cost = (msg as any).total_cost_usd;
        sessionId = msg.session_id;
      }
    }
    if (!text) throw new Error("engine returned no result");
    return {
      text,
      session_id: sessionId,
      tokens_in: usage.input_tokens,
      tokens_out: usage.output_tokens,
      ...(cost !== undefined ? { cost_usd: cost } : {}),
      ...(Object.keys(tools).length > 0 ? { tools_used: tools } : {}),
    };
  };
}
