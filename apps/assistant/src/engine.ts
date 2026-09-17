// The engine layer (§4.18.C; C2 in docs/plan-refresh-2026-09-13.md §1).
//
// ONE interface, and a factory keyed on the provider's `kind`. What a turn
// runs on is configuration — `compute.yaml`'s `assignments:` — resolved into
// a (provider, model, effort) triple before anything is called. No model
// decides which model runs (invariant 4), and no tool can reach an engine at
// all (invariant 9, collaboration rule 2): the factory is called by the
// drain, never from inside a turn.
//
// ONE kind lives here (C2, and the owner's decision of 2026-09-11 recorded
// under "Dropping the SDK entirely"):
//
//   openai-compatible — the in-house loop (engine-openai.ts). Every provider
//                       `compute.yaml` can name: OpenRouter, OpenCode Zen,
//                       LM Studio, Ollama, a bundled llama-server, Apple FM
//                       once its bridge grows /v1. Claude arrives through
//                       one of them like any other cloud model.
//
// The interface stays an interface so a second kind is additive — a native
// Messages adapter, a `llama-server` with GBNF grammars (C15) — but there is
// no engine for a turn `compute.yaml` does not assign, and that is the
// point: an install with no `assignments.default` has NO engine, the
// assistant is not started at all, and `metistry doctor` says so. Everything
// model-free keeps running (docs/ops/assistant-tools.md, "Running without an
// engine").
//
// Invariant 9 holds by construction: the engine's only tools are the
// console's `/mcp`, and there is no shell and no raw git.

import type { CostSource, Effort, EngineKind, ResolvedAssignment } from "@foldedspacelabs/metistry-core";
import { makeOpenAiEngine, type OpenAiEngineConfig } from "./engine-openai.js";
import type { ShadowRun } from "./shadow.js";

export interface TurnResult {
  text: string;
  session_id: string;
  tokens_in?: number;
  tokens_out?: number;
  /** Cache tokens as the provider reported them. `tokens_in` stays the count the provider billed as input. */
  cache_read?: number;
  cache_write?: number;
  cost_usd?: number;
  /** The provider NAME that served the turn (`compute.yaml`'s key). */
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
  /**
   * The stage-2 shadow comparison, when this turn fell in the sampled
   * fraction (`assignments.default.shadow`). It is here for the DRAIN to
   * store and for nothing to render: `text` above is always the assignment's
   * answer, and the candidate's is inside this (shadow.ts).
   */
  shadow?: ShadowRun;
}

/**
 * What one turn runs as: the model and effort (a tier is a (model, effort)
 * pair — core's `tiers.ts`), the session to continue, and the resolved
 * assignment that says WHICH PROVIDER serves it. The assignment is what the
 * factory keys on; its absence is not another engine, it is no engine.
 */
export interface TurnSpec {
  /** The model as the provider knows it — the second half of the assignment's `<provider>/<id>`. */
  model: string;
  effort: Effort;
  /** Continue an existing session. Absent = a fresh one. */
  resume?: string | undefined;
  /** The `compute.yaml` assignment for this turn. Absent = nothing assigned it, and the factory refuses by name. */
  assignment?: ResolvedAssignment | undefined;
  /** The thread this turn belongs to — the engine's session key. */
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
 * call, and putting it here is what makes that true for the in-house loop
 * and every future adapter at once. Throws to refuse.
 */
export type TurnGuard = (spec: TurnSpec) => Promise<void>;

export interface EngineConfig extends OpenAiEngineConfig {
  /**
   * Run before every turn; throw to refuse it (budgets, and anything else
   * that must happen before money moves). It is declared on
   * `OpenAiEngineConfig` as well, because the loop asks it one more time for
   * a shadow run — the same gate, with the shadow's own provider.
   */
  guard?: TurnGuard | undefined;
}

/** The kinds this build can run. A `compute.yaml` naming anything else fails its own schema long before it reaches here. */
export const ENGINE_KINDS: readonly EngineKind[] = ["openai-compatible"];

/**
 * Raised when a turn arrives with nothing assigned to it, or with a kind
 * this build has no engine for. Named, and carrying the field to edit (R3),
 * because the drain has to tell it apart from a provider being down: an
 * unassigned turn is a configuration state to report, not an outage to
 * retry.
 */
export class NoEngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoEngineError";
  }
}

/** Which engine a spec runs on. One rule, stated once: the provider's kind, and `undefined` when nothing assigned it. */
export function kindFor(spec: TurnSpec): EngineKind | undefined {
  return spec.assignment?.config.kind;
}

/**
 * The factory. The engine is built once and picked per turn, because a
 * turn's kind is a property of its tier and two tiers of one install may sit
 * on different providers — `routine` on a local server, `deep` on a cloud —
 * which is the normal case, not an edge one.
 */
export function makeEngine(cfg: EngineConfig): Engine {
  const engines: Record<EngineKind, Engine> = {
    "openai-compatible": makeOpenAiEngine(cfg),
  };
  return async (prompt, spec) => {
    const kind = kindFor(spec);
    if (kind === undefined) {
      throw new NoEngineError(
        `no engine for ${spec.tier ?? "this turn"}: compute.yaml assigns nothing to it and there is no default — ` +
          `\`metistry compute assign default <provider/model>\` (docs/ops/compute.md)`,
      );
    }
    const engine = engines[kind];
    if (!engine) {
      throw new NoEngineError(`no engine for provider kind "${kind}" — compute.yaml's providers.<name>.kind must be one of ${ENGINE_KINDS.join(", ")}`);
    }
    await cfg.guard?.(spec); // before the call: a budget checked afterwards is a report, not a control
    return engine(prompt, spec);
  };
}
