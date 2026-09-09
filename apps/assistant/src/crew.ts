// The crew runner (plan §4.11 "the brief is the context transfer", §4.18.B
// local target, Phase 5 crews). One crew run = one Agent SDK query with:
//
// - the crew's model, the crew's operating prompt as the system prompt
//   (identity-templated: `{{name}}` is the primary assistant's name, never
//   a hardcoded one), the brief as the user turn;
// - exactly ONE MCP server — the console's mcp-brain — carrying a PER-RUN
//   bearer the drain loop minted for this run and burns after it;
// - `allowedTools` = exactly the tool groups the manifest's `uses` names
//   (core's CREW_TOOL_GROUPS): `knowledge_write` and `agents_delegate` are not
//   groups, so no `uses` list can reach them; built-ins are off, foreign
//   MCP config ignored — invariant 9 holds for crews exactly as for the
//   assistant (engine.ts);
// - `maxTurns` and `maxBudgetUsd` from the manifest: the SDK stops the run
//   past either and says so in the result subtype.
//
// The final text is NOT a result channel: what the crew wants kept, it
// reports through its own tools (§4.11 "results land in the existing report
// queue"). This file only returns the accounting the runs row needs.

import { query, type McpHttpServerConfig, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { crewToolsFor, validateManifest, type AgentManifest } from "@foldedspacelabs/metistry-core";
import { BRAIN_SERVER } from "./brain.js";
import { DISALLOWED, tallyToolUse } from "./engine.js";
import { renderPrompt, type Identity } from "./prompt.js";

/** The console's snapshot of a crew, frozen into the work row at dispatch (apps/console/src/crews.ts `CrewSnapshot`). */
export interface CrewSnapshot extends Omit<AgentManifest, "type"> {
  prompt: string;
  sha256: string;
}

/**
 * Re-validate a snapshot through core's manifest schema before running it:
 * the row was written by the console from a manifest in a protected path,
 * but a schema is a control only if every consumer applies it. Throws on
 * any miss.
 */
export function parseCrewSnapshot(raw: unknown): CrewSnapshot {
  if (raw === null || typeof raw !== "object") throw new Error("crew snapshot missing from the work row");
  const { prompt, sha256, ...rest } = raw as Record<string, unknown>;
  if (typeof prompt !== "string" || !prompt.trim()) throw new Error("crew snapshot has no operating prompt");
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) throw new Error("crew snapshot has no manifest sha256");
  const r = validateManifest({ ...rest, type: "agent" });
  if (!r.ok) throw new Error(`crew snapshot invalid: ${r.errors.join("; ")}`);
  if (r.manifest.type !== "agent") throw new Error("crew snapshot is not an agent manifest");
  const { type: _type, ...manifest } = r.manifest;
  return { ...manifest, prompt: prompt.trim(), sha256 };
}

/** Fully-qualified SDK tool names for a `uses` list: mcp__brain__<tool>. */
export function crewToolNames(uses: readonly string[]): string[] {
  return crewToolsFor(uses).map((t) => `mcp__${BRAIN_SERVER}__${t}`);
}

export interface CrewRunInput {
  crew: CrewSnapshot;
  brief: string;
  task_id?: number | undefined;
  /** The console's /mcp and THIS run's token (minted by the drain loop, burned after). */
  brain: { url: string; token: string };
  /** identity.yaml, for `{{name}}` in the operating prompt; absent = the template is left as-is. */
  identity?: Identity | undefined;
}

// Fixed trailer on every crew's system prompt: what the runner enforces,
// said in words the crew can act on. A seed, not a control — the controls
// are the allowlist, the grant, the budget, and the burnt token.
const TRAILER = [
  "",
  "## How this run works",
  "You are a crew: a sub-agent run once, for one brief, by this instance's assistant. You have no shell, no files, no web — only the `brain` tools listed for you, under the vault areas you were granted.",
  "Your reply text is NOT read by anyone. Anything worth keeping must go out through `report` (findings, decisions, gotchas, progress — handles and paths in `refs`, never pasted payloads) or, where you hold them, `tasks_update` notes and `capture`. Report before you run out of turns; several short reports beat one you never send.",
  "You cannot write knowledge and cannot dispatch other crews; the assistant folds accepted reports into the vault in its own voice.",
].join("\n");

/** The system prompt: operating prompt (templated) + the fixed trailer. */
export function crewSystemPrompt(crew: CrewSnapshot, identity?: Identity): string {
  const body = identity ? renderPrompt(crew.prompt, identity) : crew.prompt.trim();
  return `${body}\n${TRAILER}`;
}

/** The user turn: the brief, plus the related task as a handle when there is one. */
export function crewUserPrompt(brief: string, taskId?: number): string {
  return taskId !== undefined ? `${brief.trimEnd()}\n\n---\nRelated task on the shared list: #${taskId} (a handle — claim it with tasks_claim only if it is in your projects).` : brief;
}

/** The whole SDK option object for one crew run — pure, so the controls are testable without a live call. */
export function buildCrewOptions(input: CrewRunInput): Options {
  const server: McpHttpServerConfig = { type: "http", url: input.brain.url, headers: { Authorization: `Bearer ${input.brain.token}` } };
  return {
    model: input.crew.model,
    systemPrompt: crewSystemPrompt(input.crew, input.identity),
    tools: [],
    strictMcpConfig: true,
    mcpServers: { [BRAIN_SERVER]: server },
    allowedTools: crewToolNames(input.crew.uses),
    disallowedTools: DISALLOWED,
    permissionMode: "default",
    maxTurns: input.crew.max_turns,
    maxBudgetUsd: input.crew.budget_usd_per_run,
  };
}

export type CrewOutcome = "ok" | "max_budget" | "max_turns" | "error";

export interface CrewRunResult {
  outcome: CrewOutcome;
  session_id: string;
  num_turns: number;
  tokens_in?: number | undefined;
  tokens_out?: number | undefined;
  cost_usd?: number | undefined;
  /** Tool calls by fully-qualified name (`mcp__brain__report`), with counts. */
  tools_used: Record<string, number>;
  /** Length of the final text — never its content (not a result channel). */
  text_chars: number;
  errors?: string[] | undefined;
}

/** The SDK entry point, injectable so the drain is testable with a fake. */
export type CrewSdk = (prompt: string, options: Options) => AsyncIterable<SDKMessage>;
export const defaultCrewSdk: CrewSdk = (prompt, options) => query({ prompt, options });

/** Run one crew to completion. Throws only on infrastructure failure (the SDK itself); a budget/turn stop is an outcome. */
export async function runCrew(input: CrewRunInput, sdk: CrewSdk = defaultCrewSdk): Promise<CrewRunResult> {
  const stream = sdk(crewUserPrompt(input.brief, input.task_id), buildCrewOptions(input));
  let sessionId = "";
  let result: CrewRunResult | null = null;
  const tools: Record<string, number> = {};
  for await (const msg of stream) {
    if (msg.type === "system" && msg.subtype === "init") sessionId = msg.session_id;
    if (msg.type === "assistant") tallyToolUse(msg.message?.content, tools);
    if (msg.type === "result") {
      const usage = (msg as { usage?: { input_tokens?: number; output_tokens?: number } }).usage ?? {};
      const outcome: CrewOutcome =
        msg.subtype === "success" ? (msg.is_error ? "error" : "ok") : msg.subtype === "error_max_budget_usd" ? "max_budget" : msg.subtype === "error_max_turns" ? "max_turns" : "error";
      result = {
        outcome,
        session_id: msg.session_id || sessionId,
        num_turns: msg.num_turns,
        tokens_in: usage.input_tokens,
        tokens_out: usage.output_tokens,
        cost_usd: msg.total_cost_usd,
        tools_used: tools,
        text_chars: msg.subtype === "success" ? msg.result.length : 0,
        ...(msg.subtype !== "success" && msg.errors?.length ? { errors: msg.errors } : msg.subtype === "success" && msg.is_error ? { errors: [msg.result] } : {}),
      };
    }
  }
  if (!result) throw new Error("crew run produced no result message");
  return result;
}
