// The engine layer (§4.18.C; C2 in docs/plan-refresh-2026-09-13.md §1).
//
// ONE interface, and a factory keyed on the provider's `kind`. What a turn
// runs on is configuration — `compute.yaml`'s `assignments:` — resolved into
// a (provider, model, effort) triple before anything is called. No model
// decides which model runs (invariant 4), and no tool can reach an engine at
// all (invariant 9, collaboration rule 2): the factory is called by the
// drain, never from inside a turn.
//
// Two kinds live here today:
//
//   openai-compatible — the in-house loop (engine-openai.ts). Every provider
//                       `compute.yaml` can name: OpenRouter, Zen, LM Studio,
//                       Ollama, a bundled llama-server, Apple FM once its
//                       bridge grows /v1.
//   anthropic         — the Claude Agent SDK (engine-sdk.ts), unchanged in
//                       behaviour, and the engine for a turn `compute.yaml`
//                       does not assign. C2 removes it with the subscription
//                       scrub; until that PR lands it is the path every
//                       existing install is still running on, so it is a
//                       KIND here rather than a special case anywhere else.
//
// Invariant 9 holds identically on both: the engine's only tools are the
// console's `/mcp`, built-ins are off, and there is no shell and no raw git.

import { SDK_ENGINE_KIND, type CostSource, type Effort, type EngineKind, type ResolvedAssignment } from "@foldedspacelabs/metistry-core";
import { makeSdkEngine, type SdkEngineConfig } from "./engine-sdk.js";
import { makeOpenAiEngine, type OpenAiEngineConfig } from "./engine-openai.js";

export interface TurnResult {
  text: string;
  session_id: string;
  tokens_in?: number;
  tokens_out?: number;
  /** Cache tokens as the provider reported them. `tokens_in` stays the count the provider billed as input. */
  cache_read?: number;
  cache_write?: number;
  cost_usd?: number;
  /** The provider NAME that served the turn (`compute.yaml`'s key); absent on the un-assigned SDK path. */
  provider?: string;
  /** The model id as the provider knows it. */
  model?: string;
  /** Where the cost number came from — `unknown` is a finding, not a gap (core's cost.ts). */
  cost_source?: CostSource;
  /** Agentic turns the loop actually took. */
  turns?: number;
  /**
   * Why the loop stopped early, when it did: the turn cap, the per-run
   * budget, or the no-progress veto (Atomic ADOPT 4). Absent = the model
   * finished on its own. Every one of the three still ANSWERS — the run ends
   * in a reply, not a stack trace.
   */
  stopped?: "max_turns" | "max_budget" | "veto";
  /** Lines worth keeping on the `runs` row — an unpriced call, a non-ZDR warning. Never user-facing text. */
  notes?: string[];
  /** Tool calls the turn made, by name (`mcp__brain__capture`), with counts. Absent when none. */
  tools_used?: Record<string, number>;
}

/**
 * What one turn runs as: the model and effort (a tier is a (model, effort)
 * pair — core's `tiers.ts`), the session to continue, and — when
 * `compute.yaml` assigns this tier — the resolved assignment that says WHICH
 * PROVIDER serves it. The assignment is what the factory keys on; its
 * absence is the SDK path.
 */
export interface TurnSpec {
  /** The model as the engine wants it: an SDK alias on the SDK path, the provider's own id on an assigned one. */
  model: string;
  effort: Effort;
  /** Continue an existing session. Absent = a fresh one. */
  resume?: string | undefined;
  /** The `compute.yaml` assignment for this turn; absent = nothing assigned it, so the SDK path runs. */
  assignment?: ResolvedAssignment | undefined;
  /** The thread this turn belongs to — the in-house engine's session key. */
  thread?: string | undefined;
  /** The tier or `crew:<name>` the turn resolved through, for the run row and the budget's `critical` flag. */
  tier?: string | undefined;
  /** A hard cap on what THIS turn may cost (a crew manifest's `budget_usd_per_run`). The loop stops and answers rather than exceeding it. */
  maxCostUsd?: number | undefined;
  /** Agentic turns for this turn only — a crew manifest's `max_turns`. Absent = the engine's own default. */
  maxTurns?: number | undefined;
}

/** One turn. The whole contract: a prompt and a spec in, a result out — and nothing about the provider leaks into the caller. */
export type Engine = (prompt: string, spec: TurnSpec) => Promise<TurnResult>;

/**
 * A pre-call gate the factory runs before EVERY turn on EVERY kind. Budgets
 * are the caller of record (budgets.ts): the check has to happen before the
 * call, and putting it here is what makes that true for the SDK path, the
 * in-house loop and every future adapter at once. Throws to refuse.
 */
export type TurnGuard = (spec: TurnSpec) => Promise<void>;

export interface EngineConfig extends SdkEngineConfig, OpenAiEngineConfig {
  /** Run before every turn; throw to refuse it (budgets, and anything else that must happen before money moves). */
  guard?: TurnGuard | undefined;
}

/** The kinds this build can run. A `compute.yaml` naming anything else fails its own schema long before it reaches here. */
export const ENGINE_KINDS: readonly EngineKind[] = ["openai-compatible", SDK_ENGINE_KIND];

/** Which engine a spec runs on. One rule, stated once: the provider's kind, or the SDK when nothing assigned it. */
export function kindFor(spec: TurnSpec): EngineKind {
  return spec.assignment?.config.kind ?? SDK_ENGINE_KIND;
}

/**
 * The factory. Both engines are built once and picked per turn, because a
 * turn's kind is a property of its tier and two tiers of one install may sit
 * on different providers — `routine` on a local server, `deep` on a cloud —
 * which is the normal case, not an edge one.
 */
export function makeEngine(cfg: EngineConfig): Engine {
  const engines: Record<EngineKind, Engine> = {
    "openai-compatible": makeOpenAiEngine(cfg),
    [SDK_ENGINE_KIND]: makeSdkEngine(cfg),
  };
  return async (prompt, spec) => {
    const kind = kindFor(spec);
    const engine = engines[kind];
    if (!engine) {
      throw new Error(`no engine for provider kind "${kind}" — compute.yaml's providers.<name>.kind must be one of ${ENGINE_KINDS.join(", ")}`);
    }
    await cfg.guard?.(spec); // before the call: a budget checked afterwards is a report, not a control
    return engine(prompt, spec);
  };
}

// The SDK path's surface, re-exported so `engine.js` stays the one import
// path for callers that do not care which engine answered.
export { DISALLOWED, buildQueryOptions, makeSdkEngine, tallyToolUse, type SdkEngineConfig } from "./engine-sdk.js";
