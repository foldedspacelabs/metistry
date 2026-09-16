// The live loop — SKIPPED UNTIL THE ENGINE MERGES.
//
// Every other test in this package runs the harness against an injected fake,
// which proves the scoring and the bookkeeping but not that the harness's
// `EvalEngine` and the assistant's `Engine` are the same shape in practice.
// That proof needs `apps/assistant/src/engine-openai.ts`, which is open in a
// separate PR (`claude/compute-engine`, #159) and not on `main` yet.
//
// When it lands, delete the skip and the local declarations: the body below
// is written against the real interface —
//
//   import { makeOpenAiEngine } from "@metistry-apps/assistant/…";
//   const factory: EngineFactory = (host) => makeOpenAiEngine({ tools: () => host, sessions, … });
//
// — and the one thing it asserts is the one thing a fake cannot: that the
// engine's own tool loop drives the recording host, so the calls the harness
// scores are the calls the engine really made. The import cannot be written
// today (and `packages/` may not import `apps/` in any case — CLAUDE.md), so
// the stage-0 script owns the wiring and this test owns the contract.
import { describe, expect, it } from "vitest";
import type { EvalEngine, EvalTurnResult, EvalTurnSpec } from "../src/runner.js";

/**
 * The assistant's `Engine`, transcribed from `apps/assistant/src/engine.ts` on
 * `claude/compute-engine`. If this stops compiling against `EvalEngine` after
 * the merge, the harness and the engine have diverged — which is the whole
 * value of keeping it here rather than in a comment.
 */
type AssistantEngineShape = (prompt: string, spec: { model: string; effort: "low" | "medium" | "high"; resume?: string | undefined; thread?: string | undefined; tier?: string | undefined; maxTurns?: number | undefined }) => Promise<{
  text: string;
  session_id: string;
  tokens_in?: number;
  tokens_out?: number;
  cost_usd?: number;
  turns?: number;
  stopped?: "max_turns" | "max_budget" | "veto";
}>;

describe("the harness's engine seam", () => {
  it("is assignable from the assistant's Engine signature, so no adapter is needed beyond passing the tool host", () => {
    const assistant: AssistantEngineShape = async () => ({ text: "", session_id: "s" });
    const asEval: EvalEngine = assistant;
    expect(typeof asEval).toBe("function");
    const spec: EvalTurnSpec = { model: "m", effort: "medium" };
    const result: EvalTurnResult = { text: "", session_id: "s" };
    expect(spec.effort).toBe("medium");
    expect(result.session_id).toBe("s");
  });

  it.skip("drives the recording host through the real openai-compatible loop (unskip when #159 merges)", async () => {
    // const host = recordingToolHost(await brainToolDefs());
    // const engine = makeOpenAiEngine({ tools: () => host, sessions: memorySessions(), fetchFn: stubCompletions([...]) });
    // await runBakeoff({ fixtures: [toolFixture], candidate, toolDefs, engine: () => engine });
    // expect(host.calls.map((c) => c.name)).toEqual(["mcp__brain__capture"]);
    expect.unreachable("unskip with the engine");
  });
});
