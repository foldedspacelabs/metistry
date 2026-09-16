// The report (§3.5, §3.7 stage 3).
//
// Everything here is arithmetic over committed run files — no engine, no
// judge, no clock. That is deliberate: the bake-off's answer has to be
// reproducible from the evidence in the repo by anyone who pulls it, and a
// report that needed a model to regenerate would not be evidence.
//
// The numbers §3.5 asks for, per candidate: pass rate per axis, tool-call
// agreement with the bar, tokens/s, TTFT, cost per turn — plus the six trace
// columns summarised, because "a scalar says a model failed; an axis plus
// churn counts says whether to fix the model or the harness".
//
// And the line the whole PoC exists to produce: **≥ bar on all axes**. It is
// the fixtures half of stage 3's gate ("≥ the bar on the fixtures AND two
// weeks of shadow agreement"), so this file states the first half and names
// the second rather than implying a promotion.

import { AXES, type Axis } from "./fixtures.js";
import { unqualify } from "./tools.js";
import type { Candidate, RunRecord } from "./record.js";

export interface AxisStat {
  axis: Axis;
  /** Cases run on this axis. */
  n: number;
  /** Weighted: Σ(weight · pass) / Σ(weight). `null` when the candidate ran no case on this axis. */
  passRate: number | null;
  /** Weighted mean partial score — the number that says "close" rather than "wrong". */
  meanScore: number | null;
}

export interface TraceStat {
  steps: number | null;
  parse_retries: number | null;
  tool_errors: number | null;
  batch_count: number | null;
  prompt_tokens: number | null;
  predicted_tokens: number | null;
}

export interface CandidateStat {
  name: string;
  candidate: Candidate;
  n: number;
  axes: AxisStat[];
  overallPassRate: number | null;
  tokensPerSecond: number | null;
  ttftP50Ms: number | null;
  costPerTurnUsd: number;
  medianLatencyMs: number | null;
  /** Mean of the six trace columns over the records that reported each. */
  trace: TraceStat;
  /** Fixtures where the candidate's tool-call name sequence equals the bar's, over the fixtures both ran. `null` without a bar. */
  toolCallAgreement: { matched: number; compared: number; rate: number } | null;
  /** Axes where the candidate is below the bar. Empty and `barName` set = the gate's fixtures half is met. */
  belowBar: { axis: Axis; candidate: number; bar: number }[];
  errors: number;
}

export interface ReportOptions {
  /** The candidate NAME that is the reference. §3.1: "where the bar is — Sonnet's score and cost per turn on the same fixtures". */
  bar?: string | undefined;
}

function weightedRate(rows: readonly RunRecord[], value: (r: RunRecord) => number): number | null {
  const total = rows.reduce((sum, r) => sum + r.weight, 0);
  if (total === 0) return null;
  return rows.reduce((sum, r) => sum + r.weight * value(r), 0) / total;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function meanOf(rows: readonly RunRecord[], pick: (r: RunRecord) => number | null | undefined): number | null {
  const values = rows.map(pick).filter((v): v is number => typeof v === "number");
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** The sequence a fixture's tool calls form, unqualified — the thing "agreement with the bar" compares. */
export function callSignature(r: RunRecord): string {
  return r.tool_calls.map((c) => unqualify(c.name)).join(">");
}

export function statsFor(records: readonly RunRecord[], barRecords: readonly RunRecord[] | undefined, candidate: Candidate): CandidateStat {
  const axes: AxisStat[] = AXES.map((axis) => {
    const rows = records.filter((r) => r.axis === axis);
    return { axis, n: rows.length, passRate: weightedRate(rows, (r) => (r.pass ? 1 : 0)), meanScore: weightedRate(rows, (r) => r.score) };
  });
  const totalLatencyS = records.reduce((sum, r) => sum + r.latency_ms, 0) / 1000;
  const totalOut = records.reduce((sum, r) => sum + r.tokens_out, 0);
  const ttfts = records.map((r) => r.ttft_ms).filter((v): v is number => typeof v === "number");

  let toolCallAgreement: CandidateStat["toolCallAgreement"] = null;
  if (barRecords && barRecords.length > 0) {
    const barBy = new Map(barRecords.map((r) => [r.fixture_id, callSignature(r)]));
    const compared = records.filter((r) => barBy.has(r.fixture_id));
    const matched = compared.filter((r) => barBy.get(r.fixture_id) === callSignature(r)).length;
    toolCallAgreement = { matched, compared: compared.length, rate: compared.length === 0 ? 0 : matched / compared.length };
  }

  const belowBar: CandidateStat["belowBar"] = [];
  if (barRecords) {
    for (const axis of AXES) {
      const barRows = barRecords.filter((r) => r.axis === axis);
      const ownRows = records.filter((r) => r.axis === axis);
      if (barRows.length === 0 || ownRows.length === 0) continue;
      const barRate = weightedRate(barRows, (r) => (r.pass ? 1 : 0));
      const ownRate = weightedRate(ownRows, (r) => (r.pass ? 1 : 0));
      if (barRate === null || ownRate === null) continue;
      if (ownRate + 1e-9 < barRate) belowBar.push({ axis, candidate: ownRate, bar: barRate });
    }
  }

  return {
    name: candidate.name,
    candidate,
    n: records.length,
    axes,
    overallPassRate: weightedRate(records, (r) => (r.pass ? 1 : 0)),
    tokensPerSecond: totalLatencyS > 0 && totalOut > 0 ? totalOut / totalLatencyS : null,
    ttftP50Ms: median(ttfts),
    costPerTurnUsd: records.length === 0 ? 0 : records.reduce((sum, r) => sum + r.cost_usd, 0) / records.length,
    medianLatencyMs: median(records.map((r) => r.latency_ms)),
    trace: {
      steps: meanOf(records, (r) => r.steps),
      parse_retries: meanOf(records, (r) => r.parse_retries),
      tool_errors: meanOf(records, (r) => r.tool_errors),
      batch_count: meanOf(records, (r) => r.batch_count),
      prompt_tokens: meanOf(records, (r) => r.prompt_tokens),
      predicted_tokens: meanOf(records, (r) => r.predicted_tokens),
    },
    toolCallAgreement,
    belowBar,
    errors: records.filter((r) => r.error !== undefined).length,
  };
}

export interface Report {
  bar: string | null;
  /** Bar first, then every other candidate by name. */
  candidates: CandidateStat[];
  /** A run file naming a candidate the `--bar` flag does not match. Printed, so a typo in the flag is visible rather than silent. */
  warnings: string[];
}

export function buildReport(records: readonly RunRecord[], opts: ReportOptions = {}): Report {
  const byCandidate = new Map<string, RunRecord[]>();
  for (const r of records) {
    const rows = byCandidate.get(r.candidate.name);
    if (rows) rows.push(r);
    else byCandidate.set(r.candidate.name, [r]);
  }
  const warnings: string[] = [];
  const bar = opts.bar ?? null;
  if (bar !== null && !byCandidate.has(bar)) warnings.push(`--bar ${bar} names a candidate that is not in these run files (present: ${[...byCandidate.keys()].sort().join(", ") || "none"})`);
  const barRecords = bar !== null ? byCandidate.get(bar) : undefined;

  const names = [...byCandidate.keys()].sort((a, b) => (a === bar ? -1 : b === bar ? 1 : a.localeCompare(b)));
  const candidates = names.map((name) => {
    const rows = byCandidate.get(name)!;
    return statsFor(rows, name === bar ? undefined : barRecords, rows[0]!.candidate);
  });
  return { bar, candidates, warnings };
}

// ---- rendering ----------------------------------------------------------------

function pct(v: number | null): string {
  return v === null ? "—" : `${(v * 100).toFixed(0)} %`;
}

function n2(v: number | null): string {
  return v === null ? "—" : v.toFixed(2);
}

export function renderReport(report: Report): string {
  const out: string[] = ["# PoC-18 bake-off — results", ""];
  if (report.bar) out.push(`Bar: **${report.bar}**. A candidate is promotable on the fixtures half of stage 3's gate only when it is ≥ the bar on **every** axis it ran.`, "");
  else out.push("_No `--bar` given: pass rates are absolute and the promotion gate is not evaluated._", "");
  for (const w of report.warnings) out.push(`> ${w}`, "");

  for (const c of report.candidates) {
    const isBar = c.name === report.bar;
    out.push(`## ${c.name}${isBar ? " (bar)" : ""}`, "");
    out.push(
      `model \`${c.candidate.model}\` · provider \`${c.candidate.provider}\` · server **${c.candidate.server}** · effort ${c.candidate.effort} — ${c.n} case(s)${c.errors > 0 ? `, ${c.errors} with an error` : ""}`,
      "",
    );
    out.push("| axis | n | pass rate | mean score |", "|---|---:|---:|---:|");
    for (const a of c.axes) {
      if (a.n === 0) continue;
      out.push(`| ${a.axis} | ${a.n} | ${pct(a.passRate)} | ${n2(a.meanScore)} |`);
    }
    out.push(`| **overall** | ${c.n} | **${pct(c.overallPassRate)}** | |`, "");
    const perf = [
      `tokens/s ${c.tokensPerSecond === null ? "—" : c.tokensPerSecond.toFixed(1)}`,
      `TTFT p50 ${c.ttftP50Ms === null ? "—" : `${Math.round(c.ttftP50Ms)} ms`}`,
      `latency p50 ${c.medianLatencyMs === null ? "—" : `${Math.round(c.medianLatencyMs)} ms`}`,
      `cost/turn $${c.costPerTurnUsd.toFixed(4)}`,
    ];
    out.push(perf.join(" · "), "");
    const t = c.trace;
    out.push(`trace (mean): steps ${n2(t.steps)} · parse_retries ${n2(t.parse_retries)} · tool_errors ${n2(t.tool_errors)} · batch_count ${n2(t.batch_count)} · prompt_tokens ${n2(t.prompt_tokens)} · predicted_tokens ${n2(t.predicted_tokens)}`, "");
    if (c.toolCallAgreement) {
      out.push(`tool-call agreement with **${report.bar}**: ${pct(c.toolCallAgreement.rate)} (${c.toolCallAgreement.matched}/${c.toolCallAgreement.compared} fixtures)`, "");
    }
    if (isBar) out.push("_This is the reference row: the bar is not compared with itself._", "");
    else if (report.bar === null) out.push("_No bar: `≥ bar on all axes` is not evaluated._", "");
    else if (c.belowBar.length === 0) out.push(`**≥ bar on all axes: yes** — fixtures half of the stage-3 gate met; two weeks of shadow agreement is the other half (§3.7).`, "");
    else out.push(`**≥ bar on all axes: no** — ${c.belowBar.map((b) => `${b.axis} ${pct(b.candidate)} < ${pct(b.bar)}`).join(", ")}`, "");
  }
  return out.join("\n");
}
