// The crew runner (plan §4.11 "the brief is the context transfer", §4.18.B
// local target, Phase 5 crews). One crew run = one engine turn with:
//
// - the crew's model AND effort, from `assignments.crews.<name>` in
//   `compute.yaml` (collaboration rule 3: a crew's engine follows ITS OWN
//   provider, not the assistant's); the crew's operating prompt as the
//   system prompt (identity-templated: `{{name}}` is the primary
//   assistant's name, never a hardcoded one), the brief as the user turn;
// - exactly ONE MCP server — the console's mcp-brain — carrying a PER-RUN
//   bearer the drain loop minted for this run and burns after it;
// - a tool host holding exactly the tool groups the manifest's `uses` names
//   (core's CREW_TOOL_GROUPS): `knowledge_write` and `agents_delegate` are
//   not groups, so no `uses` list can reach them, and the loop can call
//   nothing the host does not hold — invariant 9 holds for crews exactly as
//   for the assistant (engine.ts);
// - `max_turns` and `budget_usd_per_run` from the manifest: the loop stops
//   past either, and still answers.
//
// The final text is NOT a result channel: what the crew wants kept, it
// reports through its own tools (§4.11 "results land in the existing report
// queue"). This file only returns the accounting the runs row needs.

import { crewToolsFor, validateManifest, type AgentManifest, type CostSource, type ResolvedAssignment } from "@foldedspacelabs/metistry-core";
import { BRAIN_SERVER } from "./brain.js";
import type { Engine } from "./engine.js";
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

/** Fully-qualified tool names for a `uses` list: mcp__brain__<tool>. */
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

export type CrewOutcome = "ok" | "max_budget" | "max_turns" | "error";

export interface CrewRunResult {
  outcome: CrewOutcome;
  session_id: string;
  num_turns: number;
  tokens_in?: number | undefined;
  tokens_out?: number | undefined;
  /**
   * What the provider's prompt cache did on this run. A crew run is an
   * engine turn like any other and lands on `runs` as one, so it carries the
   * same two counts — absent where the provider reported no such field
   * (core's CallUsage), which the cache-report reads as a separate finding
   * from a cache that missed.
   */
  cache_read?: number | undefined;
  cache_write?: number | undefined;
  cost_usd?: number | undefined;
  /** Where the cost number came from — `unknown` is a finding, not a gap (core's cost.ts). */
  cost_source?: CostSource | undefined;
  /** Tool calls by fully-qualified name (`mcp__brain__report`), with counts. */
  tools_used: Record<string, number>;
  /** Length of the final text — never its content (not a result channel). */
  text_chars: number;
  errors?: string[] | undefined;
}

// ---- one crew run, on its assigned provider (C2, collaboration rule 3) --------

/**
 * A crew's engine follows ITS OWN provider, not the assistant's
 * (collaboration rule 3): `assignments.crews.<name>` in `compute.yaml` is
 * what decides, and a crew nothing assigns has no engine at all — the drain
 * parks its run as blocked rather than inventing one (crew-drain.ts).
 *
 * Everything that makes a crew a crew lives here — the same
 * operating prompt and trailer, the same `uses` allowlist (enforced by the
 * tool host the drain builds for this run), the same per-run bearer the
 * drain minted and burns after, the same `max_turns` and
 * `budget_usd_per_run`, and the same rule that the final text is not a
 * result channel. Crews still never resume a session (cost research decision
 * 3), which is why the store is in memory and dies with the run.
 */
export async function runCrewOnEngine(input: CrewRunInput, assignment: ResolvedAssignment, engine: Engine): Promise<CrewRunResult> {
  const spec = {
    model: assignment.model,
    effort: assignment.effort,
    assignment,
    thread: `${CREW_THREAD_PREFIX}${input.crew.name}`,
    tier: `crew:${input.crew.name}`,
    maxTurns: input.crew.max_turns,
    maxCostUsd: input.crew.budget_usd_per_run,
  };
  const result = await engine(crewUserPrompt(input.brief, input.task_id), spec);
  const outcome: CrewOutcome = result.stopped === "max_budget" ? "max_budget" : result.stopped === "max_turns" ? "max_turns" : "ok";
  return {
    outcome,
    session_id: result.session_id,
    num_turns: result.turns ?? 0,
    tokens_in: result.tokens_in,
    tokens_out: result.tokens_out,
    cache_read: result.cache_read,
    cache_write: result.cache_write,
    cost_usd: result.cost_usd,
    cost_source: result.cost_source,
    tools_used: result.tools_used ?? {},
    text_chars: result.text.length,
    ...(result.notes?.length ? { errors: result.notes } : {}),
  };
}

/** The thread a crew run's session is filed under. Never a person's thread: a crew's history is its own. */
export const CREW_THREAD_PREFIX = "crew:";
