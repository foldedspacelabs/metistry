// The runner: resume, the injected engine, the recording tool host, and the
// two ways a judge failure fails something. No network, no model, no engine —
// the whole point of the injection seam.
import { describe, expect, it } from "vitest";
import { Fixture, type Fixture as FixtureType } from "../src/fixtures.js";
import { JudgeFamilyError, JudgeNotConfiguredError } from "../src/judge.js";
import { Candidate, RunRecord, caseKey, runId } from "../src/record.js";
import { checkJudgeConfiguration, pending, runBakeoff, type EvalEngine } from "../src/runner.js";
import type { RecordingToolHost, ToolDef } from "../src/tools.js";

const candidate = Candidate.parse({ name: "qwen36-35ba3b-llamaserver", provider: "llamaserver", model: "qwen3.6:35b-a3b-q4_K_M", server: "llamaserver", effort: "medium" });

const defs: ToolDef[] = [
  { name: "mcp__brain__capture", description: "capture a note", parameters: { type: "object", properties: { text: { type: "string" } } } },
  { name: "mcp__brain__knowledge_search", description: "search the vault", parameters: { type: "object", properties: { query: { type: "string" } } } },
];

const toolFixture = Fixture.parse({ id: "T01", axis: "tool_calls", prompt: "note the boiler", expected: { tool_calls: [{ name: "capture", args_match: { text: { contains: "boiler" } } }] } });
const stopFixture = Fixture.parse({ id: "S01", axis: "stopping", prompt: "is that all?", expected: { stop_after_turns: 1 } });
const voiceFixture = Fixture.parse({ id: "V01", axis: "voice", prompt: "how did the week go?", expected: { rubric: "5 = the owner's voice" } });

/** An engine that calls the tools it is told to and answers a fixed string. */
const scripted =
  (script: { calls?: { name: string; args: Record<string, unknown> }[]; answer?: string; turns?: number; result?: Record<string, unknown> }) =>
  (host: RecordingToolHost): EvalEngine =>
  async () => {
    await host.list();
    for (const c of script.calls ?? []) await host.call(c.name, c.args);
    return { text: script.answer ?? "done", session_id: "s1", turns: script.turns ?? 1, tokens_in: 100, tokens_out: 20, cost_usd: 0.001, ...script.result };
  };

const base = { candidate, toolDefs: defs, now: () => 0, clock: () => new Date("2026-09-16T10:00:00.000Z") };

describe("one case, end to end", () => {
  it("records the calls the engine made, scores the axis, and points at a transcript", async () => {
    const { records } = await runBakeoff({ ...base, fixtures: [toolFixture], engine: scripted({ calls: [{ name: "mcp__brain__capture", args: { text: "the boiler" } }] }) });
    const r = records[0]!;
    expect(RunRecord.safeParse(r).success).toBe(true);
    expect(r).toMatchObject({ fixture_id: "T01", axis: "tool_calls", pass: true, score: 1, judge: null, tokens_in: 100, tokens_out: 20, turns: 1 });
    expect(r.tool_calls).toEqual([{ name: "mcp__brain__capture", args: { text: "the boiler" } }]);
    expect(r.transcript_ref).toBe(".transcripts/T01.json");
    expect(r.reasons).toEqual([]);
    expect(r.error).toBeUndefined();
  });

  it("fills the six trace columns, and leaves the ones the engine did not report as null — never zero", async () => {
    const { records } = await runBakeoff({ ...base, fixtures: [toolFixture], engine: scripted({ calls: [{ name: "nope", args: {} }], turns: 3, result: { parse_retries: 1 } }) });
    const r = records[0]!;
    expect(r.steps).toBe(3);
    expect(r.parse_retries).toBe(1);
    expect(r.tool_errors).toBe(1); // the hallucinated call came back as an error
    expect(r.batch_count).toBeNull();
    expect(r.prompt_tokens).toBe(100);
    expect(r.predicted_tokens).toBe(20);
  });

  it("records a hallucinated tool as an error result and zeroes the case", async () => {
    const { records } = await runBakeoff({ ...base, fixtures: [toolFixture], engine: scripted({ calls: [{ name: "mcp__brain__send_email", args: {} }] }) });
    expect(records[0]).toMatchObject({ pass: false, score: 0 });
    expect(records[0]!.reasons.join(" ")).toMatch(/hallucinated tool/);
    expect(records[0]!.tool_calls[0]).toMatchObject({ name: "mcp__brain__send_email", is_error: true });
  });

  it("turns an engine that throws into a failed row, not a failed run", async () => {
    const { records } = await runBakeoff({
      ...base,
      fixtures: [stopFixture],
      engine: () => async () => {
        throw new Error("connection refused");
      },
    });
    expect(records[0]).toMatchObject({ pass: false, score: 0 });
    expect(records[0]!.error).toMatch(/engine: connection refused/);
  });

  it("gives each fixture its own session key, so one case never inherits another's history", async () => {
    const threads: (string | undefined)[] = [];
    await runBakeoff({
      ...base,
      fixtures: [toolFixture, stopFixture],
      engine: () => async (_prompt, spec) => {
        threads.push(spec.thread);
        return { text: "ok", session_id: "s", turns: 1 };
      },
    });
    expect(threads).toEqual([`eval:${candidate.name}:T01`, `eval:${candidate.name}:S01`]);
    expect(new Set(threads).size).toBe(2);
  });
});

describe("the judge, and the two ways it fails something", () => {
  it("refuses the RUN when a rubric fixture is selected and no judge is configured", async () => {
    await expect(runBakeoff({ ...base, fixtures: [voiceFixture], engine: scripted({}) })).rejects.toThrow(JudgeNotConfiguredError);
    try {
      checkJudgeConfiguration({ fixtures: [voiceFixture], candidate });
    } catch (err) {
      expect((err as JudgeNotConfiguredError).code).toBe("judge_not_configured");
      expect((err as Error).message).toMatch(/METISTRY_EVAL_JUDGE_MODEL/);
    }
  });

  it("needs no judge at all for a deterministic-axes-only run", () => {
    expect(() => checkJudgeConfiguration({ fixtures: [toolFixture, stopFixture], candidate })).not.toThrow();
  });

  it("refuses the run before it spends anything when the judge is from the candidate's family", async () => {
    await expect(
      runBakeoff({ ...base, fixtures: [voiceFixture], engine: scripted({}), judge: async () => ({ model: "x", family: "qwen", verdict: 5, reason: "" }), judgeConfig: { model: "qwen/qwen3.6-72b" } }),
    ).rejects.toThrow(JudgeFamilyError);
  });

  it("fails the CASE — never passes it — when a configured judge cannot be reached", async () => {
    const { records } = await runBakeoff({
      ...base,
      fixtures: [voiceFixture],
      engine: scripted({ answer: "it went fine" }),
      judgeConfig: { model: "google/gemini-3-pro" },
      judge: async () => {
        throw new Error("502 bad gateway");
      },
    });
    expect(records[0]).toMatchObject({ pass: false, score: 0, judge: null });
    expect(records[0]!.error).toMatch(/judge_unavailable: 502 bad gateway/);
  });

  it("stores the verdict and its family on the row when the judge answers", async () => {
    const { records } = await runBakeoff({
      ...base,
      fixtures: [voiceFixture],
      engine: scripted({ answer: "it went fine" }),
      judgeConfig: { model: "google/gemini-3-pro" },
      judge: async () => ({ model: "google/gemini-3-pro", family: "google", verdict: 5, reason: "sounds like him" }),
    });
    expect(records[0]).toMatchObject({ pass: true, score: 1 });
    expect(records[0]!.judge).toEqual({ model: "google/gemini-3-pro", family: "google", verdict: 5, reason: "sounds like him" });
  });
});

describe("resume", () => {
  const done = (fixtureId: string): RunRecord =>
    RunRecord.parse({
      fixture_id: fixtureId,
      axis: "tool_calls",
      candidate,
      pass: true,
      score: 1,
      judge: null,
      tokens_in: 1,
      tokens_out: 1,
      cost_usd: 0,
      latency_ms: 1,
      turns: 1,
      tool_calls: [],
      transcript_ref: `.transcripts/${fixtureId}.json`,
      steps: 1,
      parse_retries: null,
      tool_errors: 0,
      batch_count: null,
      prompt_tokens: 1,
      predicted_tokens: 1,
      ts: "2026-09-16T10:00:00.000Z",
    });

  it("skips a (candidate, fixture) pair already in the run file and runs the rest, in order", async () => {
    const seen: string[] = [];
    const { records, skipped } = await runBakeoff({
      ...base,
      fixtures: [toolFixture, stopFixture],
      existing: [done("T01")],
      engine: () => async (prompt) => {
        seen.push(prompt);
        return { text: "ok", session_id: "s", turns: 1 };
      },
    });
    expect(skipped).toBe(1);
    expect(records.map((r) => r.fixture_id)).toEqual(["S01"]);
    expect(seen).toHaveLength(1);
  });

  it("does not skip the same fixture run by a DIFFERENT candidate", () => {
    const other = Candidate.parse({ ...candidate, name: "sonnet-bar" });
    expect(pending([toolFixture], other, [done("T01")]).map((f) => f.id)).toEqual(["T01"]);
    expect(pending([toolFixture], candidate, [done("T01")])).toEqual([]);
    expect(caseKey("T01", "sonnet-bar")).not.toBe(caseKey("T01", candidate.name));
  });

  it("re-running with nothing left to do is a no-op, not an error", async () => {
    const { records, skipped } = await runBakeoff({ ...base, fixtures: [toolFixture], existing: [done("T01")], engine: scripted({}) });
    expect(records).toEqual([]);
    expect(skipped).toBe(1);
  });
});

describe("ordering and parallelism", () => {
  it("runs one case at a time by default — the local half measures one model on one machine", async () => {
    let inFlight = 0;
    let peak = 0;
    const fixtures: FixtureType[] = Array.from({ length: 6 }, (_, i) => Fixture.parse({ ...toolFixture, id: `T${i}` }));
    await runBakeoff({
      ...base,
      fixtures,
      engine: () => async () => {
        peak = Math.max(peak, ++inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight--;
        return { text: "ok", session_id: "s", turns: 1 };
      },
    });
    expect(peak).toBe(1);
  });

  it("honours --concurrency for the cloud rows, where it only costs money", async () => {
    let inFlight = 0;
    let peak = 0;
    const fixtures: FixtureType[] = Array.from({ length: 6 }, (_, i) => Fixture.parse({ ...toolFixture, id: `T${i}` }));
    await runBakeoff({
      ...base,
      fixtures,
      concurrency: 3,
      engine: () => async () => {
        peak = Math.max(peak, ++inFlight);
        await new Promise((r) => setTimeout(r, 2));
        inFlight--;
        return { text: "ok", session_id: "s", turns: 1 };
      },
    });
    expect(peak).toBe(3);
  });
});

describe("the run id", () => {
  it("is filename-safe and sorts chronologically", () => {
    expect(runId("sonnet-bar", new Date("2026-09-16T10:11:12.345Z"))).toBe("sonnet-bar-2026-09-16T10-11-12-345Z");
    expect(runId("a", new Date("2026-01-01T00:00:00Z")) < runId("a", new Date("2026-02-01T00:00:00Z"))).toBe(true);
  });
});
