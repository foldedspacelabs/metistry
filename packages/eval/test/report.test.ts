// Report arithmetic over a synthetic run file. Everything here is a pure
// function of committed rows — the bake-off's answer has to be reproducible
// from the evidence in the repo (§3.5).
import { describe, expect, it } from "vitest";
import { buildReport, callSignature, renderReport, statsFor } from "../src/report.js";
import { Candidate, RunRecord, parseRunRecords, serialiseRecord, type RunRecord as Row } from "../src/record.js";

const bar = Candidate.parse({ name: "sonnet-bar", provider: "openrouter", model: "anthropic/claude-sonnet-5", server: "openrouter", effort: "medium" });
const local = Candidate.parse({ name: "qwen-llamaserver", provider: "llamaserver", model: "qwen3.6:35b-a3b-q4_K_M", server: "llamaserver", effort: "medium" });

interface RowOver {
  id: string;
  axis?: Row["axis"];
  pass?: boolean;
  score?: number;
  weight?: number;
  tokens_out?: number;
  latency_ms?: number;
  cost_usd?: number;
  ttft_ms?: number | null;
  calls?: string[];
  steps?: number | null;
  error?: string;
}

const row = (candidate: Candidate, o: RowOver): Row =>
  RunRecord.parse({
    fixture_id: o.id,
    axis: o.axis ?? "tool_calls",
    candidate,
    weight: o.weight ?? 1,
    pass: o.pass ?? true,
    score: o.score ?? (o.pass === false ? 0 : 1),
    judge: null,
    tokens_in: 100,
    tokens_out: o.tokens_out ?? 50,
    cost_usd: o.cost_usd ?? 0,
    latency_ms: o.latency_ms ?? 1000,
    ttft_ms: o.ttft_ms ?? null,
    turns: 1,
    tool_calls: (o.calls ?? []).map((name) => ({ name, args: {} })),
    transcript_ref: `.transcripts/${o.id}.json`,
    steps: o.steps ?? 1,
    parse_retries: null,
    tool_errors: 0,
    batch_count: null,
    prompt_tokens: 100,
    predicted_tokens: o.tokens_out ?? 50,
    ts: "2026-09-16T10:00:00.000Z",
    ...(o.error ? { error: o.error } : {}),
  });

describe("pass rate per axis", () => {
  it("is weighted, so a case the owner marked as counting double counts double", () => {
    const stat = statsFor([row(local, { id: "a", pass: true, weight: 1 }), row(local, { id: "b", pass: false, weight: 3 })], undefined, local);
    expect(stat.axes.find((a) => a.axis === "tool_calls")?.passRate).toBeCloseTo(0.25);
    expect(stat.overallPassRate).toBeCloseTo(0.25);
  });

  it("is null, not zero, for an axis the candidate never ran", () => {
    const stat = statsFor([row(local, { id: "a", axis: "voice", pass: true })], undefined, local);
    expect(stat.axes.find((a) => a.axis === "voice")?.passRate).toBe(1);
    expect(stat.axes.find((a) => a.axis === "writing")?.passRate).toBeNull();
    expect(stat.axes.find((a) => a.axis === "writing")?.n).toBe(0);
  });

  it("carries the mean partial score beside it — the number that says \"close\" rather than \"wrong\"", () => {
    const stat = statsFor([row(local, { id: "a", pass: false, score: 0.5 }), row(local, { id: "b", pass: false, score: 0.5 })], undefined, local);
    expect(stat.axes.find((a) => a.axis === "tool_calls")?.meanScore).toBeCloseTo(0.5);
    expect(stat.overallPassRate).toBe(0);
  });
});

describe("throughput, TTFT and cost", () => {
  it("computes tokens/s over the whole run and the median TTFT over the rows that reported one", () => {
    const stat = statsFor(
      [row(local, { id: "a", tokens_out: 100, latency_ms: 1000, ttft_ms: 400 }), row(local, { id: "b", tokens_out: 300, latency_ms: 3000, ttft_ms: 600 }), row(local, { id: "c", tokens_out: 200, latency_ms: 2000 })],
      undefined,
      local,
    );
    expect(stat.tokensPerSecond).toBeCloseTo(100); // 600 tokens over 6 s
    expect(stat.ttftP50Ms).toBe(500);
    expect(stat.medianLatencyMs).toBe(2000);
  });

  it("is cost per TURN, not per run — the unit the compute note's price table uses", () => {
    const stat = statsFor([row(local, { id: "a", cost_usd: 0.01 }), row(local, { id: "b", cost_usd: 0.03 })], undefined, local);
    expect(stat.costPerTurnUsd).toBeCloseTo(0.02);
  });

  it("counts the rows that carry an error", () => {
    expect(statsFor([row(local, { id: "a", pass: false, score: 0, error: "judge_unavailable: 502" })], undefined, local).errors).toBe(1);
  });
});

describe("tool-call agreement with the bar", () => {
  const barRows = [row(bar, { id: "a", calls: ["mcp__brain__knowledge_search", "mcp__brain__capture"] }), row(bar, { id: "b", calls: ["mcp__brain__capture"] })];

  it("compares the unqualified name SEQUENCE, over the fixtures both ran", () => {
    const stat = statsFor(
      [row(local, { id: "a", calls: ["knowledge_search", "capture"] }), row(local, { id: "b", calls: ["capture", "capture"] }), row(local, { id: "z", calls: [] })],
      barRows,
      local,
    );
    expect(stat.toolCallAgreement).toEqual({ matched: 1, compared: 2, rate: 0.5 });
  });

  it("is order-sensitive: the same two calls in the other order is not agreement", () => {
    expect(callSignature(row(local, { id: "a", calls: ["capture", "knowledge_search"] }))).not.toBe(callSignature(barRows[0]!));
  });

  it("is null without a bar", () => {
    expect(statsFor([row(local, { id: "a" })], undefined, local).toolCallAgreement).toBeNull();
  });
});

describe("the promotion line", () => {
  const barRows = [row(bar, { id: "a", axis: "tool_calls", pass: true }), row(bar, { id: "v", axis: "voice", pass: true }), row(bar, { id: "w", axis: "voice", pass: false })];

  it("says yes when the candidate is ≥ the bar on every axis it ran", () => {
    const rows = [...barRows, row(local, { id: "a", axis: "tool_calls", pass: true }), row(local, { id: "v", axis: "voice", pass: true }), row(local, { id: "w", axis: "voice", pass: false })];
    const report = buildReport(rows, { bar: "sonnet-bar" });
    const candidate = report.candidates.find((c) => c.name === local.name)!;
    expect(candidate.belowBar).toEqual([]);
    expect(renderReport(report)).toContain("≥ bar on all axes: yes");
    expect(renderReport(report)).toContain("two weeks of shadow agreement");
  });

  it("says no and names the axis and both numbers", () => {
    const rows = [...barRows, row(local, { id: "a", axis: "tool_calls", pass: true }), row(local, { id: "v", axis: "voice", pass: false }), row(local, { id: "w", axis: "voice", pass: false })];
    const report = buildReport(rows, { bar: "sonnet-bar" });
    const candidate = report.candidates.find((c) => c.name === local.name)!;
    expect(candidate.belowBar).toEqual([{ axis: "voice", candidate: 0, bar: 0.5 }]);
    expect(renderReport(report)).toContain("≥ bar on all axes: no");
    expect(renderReport(report)).toMatch(/voice 0 % < 50 %/);
  });

  it("never compares the bar with itself, and puts it first", () => {
    const report = buildReport([...barRows, row(local, { id: "a" })], { bar: "sonnet-bar" });
    expect(report.candidates[0]?.name).toBe("sonnet-bar");
    expect(report.candidates[0]?.belowBar).toEqual([]);
    expect(report.candidates[0]?.toolCallAgreement).toBeNull();
    expect(renderReport(report)).toContain("This is the reference row");
  });

  it("does not evaluate the gate without a bar, and says so", () => {
    const report = buildReport([row(local, { id: "a" })]);
    expect(renderReport(report)).toContain("the promotion gate is not evaluated");
    expect(renderReport(report)).not.toContain("≥ bar on all axes: yes");
  });

  it("warns rather than failing silently when --bar names a candidate no run file has", () => {
    const report = buildReport([row(local, { id: "a" })], { bar: "typo" });
    expect(report.warnings[0]).toMatch(/names a candidate that is not in these run files/);
    expect(renderReport(report)).toContain("qwen-llamaserver");
  });
});

describe("round-tripping a run file", () => {
  it("serialises to one line per row and parses back identically", () => {
    const rows = [row(bar, { id: "a", calls: ["capture"] }), row(local, { id: "a", calls: [] })];
    const text = `${rows.map(serialiseRecord).join("\n")}\n`;
    const parsed = parseRunRecords(text, "run.jsonl");
    expect(parsed.issues).toEqual([]);
    expect(parsed.records).toEqual(rows);
    expect(text.trim().split("\n")).toHaveLength(2);
  });

  it("reports the line it could not read instead of dropping it", () => {
    const parsed = parseRunRecords(`${serialiseRecord(row(local, { id: "a" }))}\n{"fixture_id":"b"}\nnot json\n`, "run.jsonl");
    expect(parsed.records).toHaveLength(1);
    expect(parsed.issues).toHaveLength(2);
    expect(parsed.issues[1]).toMatch(/line 3: not JSON/);
  });

  it("renders a table per candidate with the six trace columns under it", () => {
    const md = renderReport(buildReport([row(bar, { id: "a" }), row(local, { id: "a" })], { bar: "sonnet-bar" }));
    expect(md).toContain("| axis | n | pass rate | mean score |");
    expect(md).toMatch(/trace \(mean\): steps .* parse_retries .* tool_errors .* batch_count .* prompt_tokens .* predicted_tokens/);
    expect(md).toContain("server **llamaserver**"); // the server axis is on the face of the report, not only in the rows
  });
});
