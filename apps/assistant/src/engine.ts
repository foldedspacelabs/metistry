// The reference engine (§4.18.C): Claude Agent SDK behind the documented
// contract — messages in, sessions rows, every call logged to runs.
// Invariant 9: the engine has no shell and no raw git. Its ONLY tools are
// mcp-brain's, mounted as one HTTP MCP server when configured (brain.ts);
// built-in tools are disabled outright and the SDK is told to ignore every
// other MCP source. Absent the brain config, the engine runs tool-less.

import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import type { Effort } from "@foldedspacelabs/metistry-core";
import { brainOptions, type BrainConfig } from "./brain.js";

export interface TurnResult {
  text: string;
  session_id: string;
  tokens_in?: number;
  tokens_out?: number;
  /** Cache tokens from the SDK result's `usage` (Anthropic API's `cache_read_input_tokens` / `cache_creation_input_tokens`). `tokens_in` above stays the uncached input count — these are additional. */
  cache_read?: number;
  cache_write?: number;
  cost_usd?: number;
  /** Tool calls the turn made, by name (`mcp__brain__capture`), with counts. Absent when none. */
  tools_used?: Record<string, number>;
}

/**
 * What one turn runs as: the resolved tier (core's `tiers.ts` — a tier is a
 * (model, effort) pair) plus the session to continue, if any.
 */
export interface TurnSpec {
  model: string;
  effort: Effort;
  /** Continue an existing SDK session (PoC-4). Absent = a fresh session. */
  resume?: string | undefined;
}

/** One turn. */
export type Engine = (prompt: string, spec: TurnSpec) => Promise<TurnResult>;

export interface EngineConfig {
  /** The console's mcp-brain; undefined = tool-less. */
  brain?: BrainConfig | undefined;
  /** Identity-templated system prompt (prompt.ts); undefined = the SDK's default (none). */
  systemPrompt?: string | undefined;
  /** Agentic turns per message. Tool use needs more than one; 4 was the tool-less default. */
  maxTurns?: number | undefined;
}

// Kept alongside `tools: []` (brain.ts) as belt and braces: these must never
// come back through any option the SDK grows later. Shared with the crew
// runner (crew.ts) so a crew's built-in surface is exactly the assistant's: none.
export const DISALLOWED = ["Bash", "Write", "Edit", "NotebookEdit", "WebFetch", "WebSearch", "Task", "Agent"];

/**
 * The whole SDK option object for one turn — pure, so the allowlist is
 * testable without a live call.
 *
 * This function is also where "effort changes only at turn boundaries" is
 * enforced by construction rather than by prompting: the options are built
 * ONCE per turn from that turn's resolved tier and handed to a single
 * `query()`; nothing mutates them while the stream runs. Consecutive turns on
 * the same session with the same tier therefore produce byte-identical
 * options, which is what keeps the cached prompt prefix intact (a break costs
 * up to 50x the cache-read price per token on Fable/Mythos 5.1). Tested in
 * `test/brain.test.ts`.
 */
export function buildQueryOptions(cfg: EngineConfig, spec: TurnSpec): Options {
  return {
    model: spec.model,
    effort: spec.effort,
    ...(spec.resume ? { resume: spec.resume } : {}),
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
  return async (prompt, spec) => {
    const stream = query({ prompt, options: buildQueryOptions(cfg, spec) });

    let text = "";
    let sessionId = spec.resume ?? "";
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
      // cache_read_input_tokens / cache_creation_input_tokens (BetaUsage, via NonNullableUsage on the result message) — the main-loop total, same scope as tokens_in/out above.
      cache_read: usage.cache_read_input_tokens,
      cache_write: usage.cache_creation_input_tokens,
      ...(cost !== undefined ? { cost_usd: cost } : {}),
      ...(Object.keys(tools).length > 0 ? { tools_used: tools } : {}),
    };
  };
}
