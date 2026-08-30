// The reference engine (§4.18.C): Claude Agent SDK behind the documented
// contract — messages in, sessions rows, every call logged to runs.
// Invariant 9: the engine has no shell and no raw git — no MCP servers are
// mounted yet and the built-in mutating/exec tools are disallowed outright.
// (When brain tools mount in Phase 3+, this list gets misuse tests.)

import { query } from "@anthropic-ai/claude-agent-sdk";

export interface TurnResult {
  text: string;
  session_id: string;
  tokens_in?: number;
  tokens_out?: number;
  cost_usd?: number;
}

/** One turn. `resume` continues an existing SDK session (PoC-4). */
export type Engine = (prompt: string, model: string, resume?: string) => Promise<TurnResult>;

const DISALLOWED = ["Bash", "Write", "Edit", "NotebookEdit", "WebFetch", "WebSearch", "Task", "Agent"];

export const sdkEngine: Engine = async (prompt, model, resume) => {
  const stream = query({
    prompt,
    options: {
      model,
      ...(resume ? { resume } : {}),
      disallowedTools: DISALLOWED,
      permissionMode: "default",
      maxTurns: 4,
    },
  });

  let text = "";
  let sessionId = resume ?? "";
  let usage: any = {};
  let cost: number | undefined;
  for await (const msg of stream) {
    if (msg.type === "system" && msg.subtype === "init") sessionId = msg.session_id;
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
  };
};
