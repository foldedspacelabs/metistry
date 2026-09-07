// The assistant's tools (§4.11 one knowledge interface for ALL agents): the
// engine mounts exactly ONE MCP server — the console's mcp-brain at /mcp —
// and authenticates to it like any external agent, as the first INTERNAL
// agent in the registry. Invariant 9 is enforced here, not prompted: the
// allowlist below is the assistant's entire tool surface; built-in tools
// are disabled outright (`tools: []`), and `strictMcpConfig` ignores every
// other MCP source (.mcp.json, user settings, plugins). Absent the env, the
// engine runs tool-less exactly as before (degrades: absent).

import type { McpHttpServerConfig, Options } from "@anthropic-ai/claude-agent-sdk";

/** The MCP server name as the SDK sees it: tool names become `mcp__brain__<tool>`. */
export const BRAIN_SERVER = "brain";

/**
 * The seventeen mcp-brain tools, in manifest order. Duplicated here on purpose
 * — the engine's allowlist must be readable in one place — and locked to
 * packages/mcp-brain/manifest.yaml by test/brain.test.ts.
 */
export const BRAIN_TOOLS = [
  "capture",
  "report",
  "tasks_list_ready",
  "tasks_claim",
  "tasks_heartbeat",
  "tasks_update",
  "tasks_release",
  "tasks_create",
  "tasks_mine",
  "knowledge_search",
  "knowledge_read",
  "artifact_publish",
  "artifact_get",
  "artifact_list",
  "artifact_comment",
  "artifact_comment_resolve",
  "artifact_dispatch_review",
] as const;

export interface BrainConfig {
  /** The console's /mcp, e.g. http://console:8080/mcp (METISTRY_BRAIN_URL). */
  url: string;
  /** The internal agent's bearer (METISTRY_ASSISTANT_TOKEN) — the same value the console registers. */
  token: string;
}

/** Fully-qualified SDK tool names for the allowlist. */
export function brainToolNames(): string[] {
  return BRAIN_TOOLS.map((t) => `mcp__${BRAIN_SERVER}__${t}`);
}

/** Read the brain config from the environment; undefined unless BOTH values are present. */
export function brainConfigFromEnv(env: NodeJS.ProcessEnv = process.env): BrainConfig | undefined {
  const url = env.METISTRY_BRAIN_URL?.trim();
  const token = env.METISTRY_ASSISTANT_TOKEN?.trim();
  if (!url || !token) return undefined;
  if (!/^https?:\/\//.test(url)) throw new Error("METISTRY_BRAIN_URL must be an http(s) URL");
  return { url, token };
}

/**
 * The tool-related slice of the SDK query options. With a brain: one HTTP
 * MCP server carrying the bearer, and `allowedTools` = exactly the brain
 * tools. Without: no servers, no allowlist. In both cases built-in tools
 * are off and foreign MCP config is ignored.
 */
export function brainOptions(brain: BrainConfig | undefined): Pick<Options, "mcpServers" | "allowedTools" | "tools" | "strictMcpConfig"> {
  const base = { tools: [] as string[], strictMcpConfig: true };
  if (!brain) return base;
  const server: McpHttpServerConfig = { type: "http", url: brain.url, headers: { Authorization: `Bearer ${brain.token}` } };
  return { ...base, mcpServers: { [BRAIN_SERVER]: server }, allowedTools: brainToolNames() };
}
