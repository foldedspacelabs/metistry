// The intent axis (PoC-20 phase 1,
// docs/research/2026-09-21-intent-classification-tier.md §4.4).
//
// Two things separate this from the five axes next door, and both come
// straight out of the research:
//
//   * **The threshold is an OUTPUT of this command, never an input.** §4.4:
//     "Sweep it over the fixture set and pick the point that satisfies rows 4
//     and 5 together; a threshold chosen before seeing the data is the mistake
//     Nimble's README warns about in as many words." So `--fit` prints the
//     line to paste into `rules.yaml`, and nothing in the product ships a
//     default one.
//   * **The fixtures are the OWNER'S, and nothing else will do.** C11 forbids
//     Claude-authored expected answers, and that plainly covers labels as well
//     as text — which is why every accuracy figure in the research note is
//     marked illustrative and why none of them may be reused. The example file
//     this repo ships is EMPTY on purpose.
//
// The fixture format is deliberately not `fixtures.ts`'s `Fixture`. That shape
// is one agentic turn with tool calls, transcripts and a judge; an intent case
// is a sentence and a label, the owner is writing two hundred of them by hand,
// and a format they can type is worth more than a shared schema. The join is
// the vocabulary, not the file: `Candidate.server` names the same three local
// servers, and the metrics below print the same p50/p95 columns.

import { z } from "zod";
import {
  INTENT_NAMES,
  INTENT_PHRASINGS,
  INTENT_UNSURE,
  intentGuard,
  intentMessages,
  scoreChoiceOver,
  type ChoiceOption,
  type ChoiceServer,
  type Intent,
  type IntentPhrasing,
} from "@foldedspacelabs/metistry-core";

// ---- fixtures ------------------------------------------------------------------

/**
 * One labelled message. `<instance>/.metistry/eval/intents.jsonl`, one per
 * line.
 *
 * `compound` is the owner's note that the sentence asks for more than one
 * thing. **Phase 1 cannot answer it** — one scored token carries one answer
 * (research §2.5) — so it is collected now and scored by phase 2's
 * JSON-schema arm. Labelling it while the messages are in front of you is
 * free; going back for it later is not.
 */
export const IntentFixture = z.strictObject({
  /** the message, exactly as it was written */
  text: z.string().min(1),
  /** what it says, from this build's closed enum */
  intent: z.enum(INTENT_NAMES),
  /** does it ask for more than one thing? Collected for phase 2; phase 1 never predicts it. */
  compound: z.boolean().optional(),
  /** optional, and only so a report row can be found again */
  id: z.string().min(1).optional(),
  /** why this case exists — never sent to a model */
  notes: z.string().optional(),
});
export type IntentFixture = z.infer<typeof IntentFixture>;

export interface IntentFixtureIssue {
  source: string;
  line: number;
  message: string;
}

/** One JSON object per line; blank lines and `#` comment lines ignored, because the owner is writing this by hand. */
export function loadIntentFixtures(text: string, source: string): { fixtures: IntentFixture[]; issues: IntentFixtureIssue[] } {
  const fixtures: IntentFixture[] = [];
  const issues: IntentFixtureIssue[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line === "" || line.startsWith("#")) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (err) {
      issues.push({ source, line: i + 1, message: `not JSON: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }
    const parsed = IntentFixture.safeParse(raw);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) issues.push({ source, line: i + 1, message: `${issue.path.join(".") || "(root)"}: ${issue.message}` });
      continue;
    }
    fixtures.push(parsed.data);
  }
  return { fixtures, issues };
}

// ---- one scored row ------------------------------------------------------------

export interface IntentRow {
  fixture: IntentFixture;
  phrasing: IntentPhrasing;
  /** what the scorer said, or `null` where the deterministic guard refused before any call */
  predicted: Intent | null;
  confidence: number;
  alpha: number;
  latency_ms: number;
  /** the guard's reason, where it refused */
  guarded?: string;
  /** why no verdict, where the server could not produce one */
  error?: string;
}

/** The seam the tests inject and the CLI fills with a real local server. */
export type IntentScorer = (text: string, phrasing: IntentPhrasing) => Promise<Omit<IntentRow, "fixture" | "phrasing">>;

export interface LiveScorerOptions {
  baseUrl: string;
  model: string;
  server?: ChoiceServer;
  bearer?: string;
  topLogprobs?: number;
  timeoutMs?: number;
  now?: Date;
  options: readonly ChoiceOption[];
  codes: readonly string[];
  fetchFn?: typeof fetch;
}

/**
 * The real scorer: `packages/core`'s `scoreChoiceOver`, which is the SAME
 * function and the same request body the capture door sends. That is not
 * tidiness — a threshold fitted against one request shape is not valid against
 * another, and this command exists to produce a threshold the capture door
 * will honour.
 *
 * The deterministic guard runs here too, for the same reason: a fixture the
 * product would never send to a model must not be scored as though it would
 * be, or the fitted threshold is fitted on a population the tier never sees.
 */
export function liveScorer(opts: LiveScorerOptions): IntentScorer {
  const url = `${opts.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  return async (text, phrasing) => {
    const guard = intentGuard(text);
    if (!guard.ok) return { predicted: null, confidence: 0, alpha: 0, latency_ms: 0, guarded: guard.reason };
    const scored = await scoreChoiceOver({
      url,
      model: opts.model,
      options: opts.options,
      codes: opts.codes,
      messages: intentMessages(guard.text, { options: opts.options, codes: opts.codes, phrasing, ...(opts.now ? { now: opts.now } : {}) }),
      ...(opts.server ? { server: opts.server } : {}),
      ...(opts.bearer ? { bearer: opts.bearer } : {}),
      ...(opts.topLogprobs !== undefined ? { topLogprobs: opts.topLogprobs } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.fetchFn ? { fetchFn: opts.fetchFn as never } : {}),
    });
    if (!scored.ok) return { predicted: null, confidence: 0, alpha: 0, latency_ms: 0, error: scored.why };
    return { predicted: scored.key as Intent, confidence: scored.confidence, alpha: scored.alpha, latency_ms: scored.latency_ms };
  };
}

export interface RunIntentEvalOptions {
  fixtures: readonly IntentFixture[];
  score: IntentScorer;
  phrasings?: readonly IntentPhrasing[];
  /** one throwaway call per phrasing before the clock starts — 29.5 s was measured for a cold LM Studio (§2.4) */
  warmUp?: boolean;
  onRow?: (row: IntentRow) => void;
}

export interface IntentRunResult {
  rows: IntentRow[];
  /** the discarded first call per phrasing, kept out of the percentiles and reported on its own */
  cold_start_ms: Record<string, number>;
}

export async function runIntentEval(opts: RunIntentEvalOptions): Promise<IntentRunResult> {
  const phrasings = opts.phrasings ?? [INTENT_PHRASINGS[0]];
  const rows: IntentRow[] = [];
  const cold: Record<string, number> = {};
  for (const phrasing of phrasings) {
    if (opts.warmUp !== false && opts.fixtures.length > 0) {
      const warm = await opts.score(opts.fixtures[0]!.text, phrasing);
      cold[phrasing] = warm.latency_ms;
    }
    for (const fixture of opts.fixtures) {
      const scored = await opts.score(fixture.text, phrasing);
      const row: IntentRow = { fixture, phrasing, ...scored };
      rows.push(row);
      opts.onRow?.(row);
    }
  }
  return { rows, cold_start_ms: cold };
}

// ---- the bar, pre-registered ---------------------------------------------------

/**
 * §4.4's table, in code, so a result cannot be read to taste. Every number is
 * the research's, pre-registered before any run.
 */
export const INTENT_BAR = {
  /** ≥ 95% of the owner's labelled fixtures, EXCLUDING cases whose gold label is `unsure` */
  accuracy: 0.95,
  /** on cases whose gold label is `unsure`, ≥ 90% fall below the threshold — "the tier's whole purpose is knowing when not to answer" */
  unsure_escalation: 0.9,
  /** ≤ 2% of fixtures wrong ABOVE the threshold — "the single worst failure mode" */
  confident_errors: 0.02,
  /** warm */
  p50_ms: 150,
  p95_ms: 400,
} as const;

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
}

/**
 * Expected Calibration Error, ten equal-width bins.
 *
 * `ECE = Σ (n_b/N) · |accuracy_b − mean confidence_b|`. Laya's authors put the
 * number on why it matters: refitting one temperature per (question type,
 * option count) moved mean ECE **0.466 → 0.081** (§2.3.1.4). A high ECE here
 * does not mean the classifier is wrong — it means its confidence does not
 * mean what it says, and a threshold on a miscalibrated number is arithmetic
 * on sand.
 */
export function ece(rows: readonly { confidence: number; correct: boolean }[], bins = 10): number {
  if (rows.length === 0) return 0;
  let total = 0;
  for (let b = 0; b < bins; b++) {
    const lo = b / bins;
    const hi = (b + 1) / bins;
    const inBin = rows.filter((r) => (b === bins - 1 ? r.confidence >= lo && r.confidence <= hi : r.confidence >= lo && r.confidence < hi));
    if (inBin.length === 0) continue;
    const acc = inBin.filter((r) => r.correct).length / inBin.length;
    const conf = inBin.reduce((s, r) => s + r.confidence, 0) / inBin.length;
    total += (inBin.length / rows.length) * Math.abs(acc - conf);
  }
  return total;
}

// ---- the sweep and the fit -----------------------------------------------------

export interface ThresholdPoint {
  threshold: number;
  /** share of the non-`unsure` fixtures this threshold would act on */
  coverage: number;
  /** accuracy among the ones it acts on */
  accuracy_above: number;
  /** share of gold-`unsure` fixtures whose confidence falls BELOW the threshold (§4.4's literal statistic) */
  unsure_escalation: number;
  /** the same, counting a predicted `unsure` as escalated too — which is what the rules actually do */
  unsure_escalation_operational: number;
  /** wrong answers above the threshold, as a share of ALL fixtures (§4.4's denominator) */
  confident_errors: number;
  meets_bar: boolean;
}

export interface IntentFit {
  sweep: ThresholdPoint[];
  /** the point the bar picks, or null when no threshold on this fixture set meets it */
  fitted: ThresholdPoint | null;
  /** why, in one line, for the report and for the owner */
  why: string;
}

/**
 * Sweep the threshold and pick.
 *
 * **The rule, stated because §4.4 does not state a coverage floor and the
 * brief's "≥X% coverage" therefore has no X in the source.** What §4.4 states
 * is three bar rows — accuracy ≥ 95% above the threshold, ≥ 90% of gold
 * `unsure` below it, ≤ 2% confident errors — and "pick the point that
 * satisfies rows 4 and 5 together". So: among the thresholds that satisfy all
 * three, take the one with the **most coverage**, and where two tie, the lower
 * threshold. That is "maximise how much the tier answers, subject to the bar",
 * which is the same instruction read from the other end. `--min-coverage`
 * exists for an owner who would rather read it the first way.
 */
export function fitThreshold(rows: readonly IntentRow[], opts: { bar?: typeof INTENT_BAR; minCoverage?: number } = {}): IntentFit {
  const bar = opts.bar ?? INTENT_BAR;
  const scored = rows.filter((r) => r.predicted !== null);
  const answerable = scored.filter((r) => r.fixture.intent !== INTENT_UNSURE);
  const unsureRows = scored.filter((r) => r.fixture.intent === INTENT_UNSURE);
  const candidates = [...new Set([0, 1, ...scored.map((r) => Number(r.confidence.toFixed(4)))])].sort((a, b) => a - b);

  const sweep: ThresholdPoint[] = candidates.map((threshold) => {
    const above = answerable.filter((r) => r.confidence >= threshold);
    const correctAbove = above.filter((r) => r.predicted === r.fixture.intent).length;
    const wrongAbove = scored.filter((r) => r.confidence >= threshold && r.predicted !== r.fixture.intent).length;
    const escalated = unsureRows.filter((r) => r.confidence < threshold).length;
    const escalatedOperational = unsureRows.filter((r) => r.confidence < threshold || r.predicted === INTENT_UNSURE).length;
    const point: ThresholdPoint = {
      threshold,
      coverage: answerable.length === 0 ? 0 : above.length / answerable.length,
      // Vacuously 1 where the threshold answers nothing. That point is
      // excluded from the fit by the coverage requirement below — a threshold
      // that acts on no message satisfies every accuracy bar and IS the tier
      // switched off, which is not a fit and must never be printed as one.
      accuracy_above: above.length === 0 ? 1 : correctAbove / above.length,
      unsure_escalation: unsureRows.length === 0 ? 1 : escalated / unsureRows.length,
      unsure_escalation_operational: unsureRows.length === 0 ? 1 : escalatedOperational / unsureRows.length,
      confident_errors: scored.length === 0 ? 0 : wrongAbove / scored.length,
      meets_bar: false,
    };
    point.meets_bar =
      point.coverage > 0 &&
      point.accuracy_above >= bar.accuracy &&
      point.unsure_escalation >= bar.unsure_escalation &&
      point.confident_errors <= bar.confident_errors &&
      (opts.minCoverage === undefined || point.coverage >= opts.minCoverage);
    return point;
  });

  const meeting = sweep.filter((p) => p.meets_bar);
  if (meeting.length === 0) {
    return {
      sweep,
      fitted: null,
      why:
        `no threshold on these ${scored.length} scored fixture(s) meets the bar ` +
        `(accuracy ≥ ${bar.accuracy}, unsure escalation ≥ ${bar.unsure_escalation}, confident errors ≤ ${bar.confident_errors}` +
        `${opts.minCoverage !== undefined ? `, coverage ≥ ${opts.minCoverage}` : ""}) — the sweep is printed so the shortfall is visible rather than rounded away`,
    };
  }
  let best = meeting[0]!;
  for (const p of meeting) {
    if (p.coverage > best.coverage || (p.coverage === best.coverage && p.threshold < best.threshold)) best = p;
  }
  return {
    sweep,
    fitted: best,
    why: `${meeting.length} threshold(s) meet the bar; ${best.threshold} is the one that answers the most (${Math.round(best.coverage * 100)}% coverage at ${Math.round(best.accuracy_above * 100)}% accuracy)`,
  };
}

// ---- the report ----------------------------------------------------------------

export interface PhrasingReport {
  phrasing: IntentPhrasing;
  n: number;
  scored: number;
  guarded: number;
  errors: number;
  /** over the non-`unsure` fixtures the scorer answered at all, ignoring any threshold */
  accuracy: number;
  ece: number;
  mean_alpha: number;
  p50_ms: number;
  p95_ms: number;
  /** per-intent confusion, most-missed first */
  misses: Array<{ gold: Intent; predicted: string; n: number }>;
  fit: IntentFit;
}

export interface IntentReport {
  fixtures: number;
  by_phrasing: PhrasingReport[];
  /** the phrasing with the best accuracy — "keep the best on the fixtures" (§5.2 phase 1) */
  best_phrasing: IntentPhrasing | null;
  cold_start_ms: Record<string, number>;
  bar: typeof INTENT_BAR;
}

export function buildIntentReport(result: IntentRunResult, opts: { minCoverage?: number } = {}): IntentReport {
  const phrasings = [...new Set(result.rows.map((r) => r.phrasing))];
  const by_phrasing = phrasings.map((phrasing) => {
    const rows = result.rows.filter((r) => r.phrasing === phrasing);
    const scored = rows.filter((r) => r.predicted !== null);
    const answerable = scored.filter((r) => r.fixture.intent !== INTENT_UNSURE);
    const correct = answerable.filter((r) => r.predicted === r.fixture.intent).length;
    const missCounts = new Map<string, { gold: Intent; predicted: string; n: number }>();
    for (const r of scored) {
      if (r.predicted === r.fixture.intent) continue;
      const key = `${r.fixture.intent}→${r.predicted}`;
      const existing = missCounts.get(key);
      if (existing) existing.n += 1;
      else missCounts.set(key, { gold: r.fixture.intent, predicted: String(r.predicted), n: 1 });
    }
    return {
      phrasing,
      n: rows.length,
      scored: scored.length,
      guarded: rows.filter((r) => r.guarded !== undefined).length,
      errors: rows.filter((r) => r.error !== undefined).length,
      accuracy: answerable.length === 0 ? 0 : correct / answerable.length,
      ece: ece(scored.map((r) => ({ confidence: r.confidence, correct: r.predicted === r.fixture.intent }))),
      mean_alpha: scored.length === 0 ? 0 : scored.reduce((s, r) => s + r.alpha, 0) / scored.length,
      p50_ms: percentile(scored.map((r) => r.latency_ms), 0.5),
      p95_ms: percentile(scored.map((r) => r.latency_ms), 0.95),
      misses: [...missCounts.values()].sort((a, b) => b.n - a.n).slice(0, 10),
      fit: fitThreshold(rows, opts.minCoverage !== undefined ? { minCoverage: opts.minCoverage } : {}),
    };
  });
  let best: IntentPhrasing | null = null;
  for (const p of by_phrasing) {
    if (p.scored === 0) continue;
    if (best === null || p.accuracy > by_phrasing.find((x) => x.phrasing === best)!.accuracy) best = p.phrasing;
  }
  return {
    fixtures: result.rows.length === 0 ? 0 : result.rows.length / Math.max(1, phrasings.length),
    by_phrasing,
    best_phrasing: best,
    cold_start_ms: result.cold_start_ms,
    bar: INTENT_BAR,
  };
}

const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;

export function renderIntentReport(report: IntentReport): string {
  const out: string[] = [];
  out.push(`intent axis — ${report.fixtures} owner-labelled fixture(s)`);
  out.push("");
  out.push("| phrasing | scored | accuracy | ECE | mean alpha | p50 ms | p95 ms | fitted threshold |");
  out.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const p of report.by_phrasing) {
    out.push(
      `| ${p.phrasing} | ${p.scored}/${p.n} | ${pct(p.accuracy)} | ${p.ece.toFixed(3)} | ${p.mean_alpha.toFixed(3)} | ${p.p50_ms} | ${p.p95_ms} | ${p.fit.fitted ? p.fit.fitted.threshold.toFixed(2) : "—"} |`,
    );
  }
  out.push("");
  for (const p of report.by_phrasing) {
    out.push(`## ${p.phrasing}`);
    if (p.guarded > 0) out.push(`${p.guarded} fixture(s) never reached the model — the deterministic guard refused them (research §2.3.1.3).`);
    if (p.errors > 0) out.push(`${p.errors} fixture(s) produced no verdict: the server could not answer.`);
    out.push(p.fit.why);
    const f = p.fit.fitted;
    if (f) {
      out.push("");
      out.push("Paste into `.metistry/rules.yaml` (it is your file, and this number is the whole decision):");
      out.push("");
      out.push("```yaml");
      out.push("intent:");
      out.push(`  min_confidence: ${f.threshold.toFixed(2)}`);
      out.push("```");
      out.push("");
      out.push(`At that threshold: coverage ${pct(f.coverage)}, accuracy above ${pct(f.accuracy_above)}, gold-unsure escalated ${pct(f.unsure_escalation)} (${pct(f.unsure_escalation_operational)} counting predicted-unsure), confident errors ${pct(f.confident_errors)}.`);
    }
    if (p.misses.length > 0) {
      out.push("");
      out.push("Most common misses (gold → predicted):");
      for (const m of p.misses) out.push(`  ${m.n}×  ${m.gold} → ${m.predicted}`);
    }
    out.push("");
  }
  const bar = report.bar;
  out.push(
    `Bar (§4.4, pre-registered): accuracy ≥ ${pct(bar.accuracy)} excluding gold-unsure · gold-unsure escalation ≥ ${pct(bar.unsure_escalation)} · ` +
      `confident errors ≤ ${pct(bar.confident_errors)} · p50 < ${bar.p50_ms} ms · p95 < ${bar.p95_ms} ms warm.`,
  );
  const cold = Object.entries(report.cold_start_ms);
  if (cold.length > 0) out.push(`Cold start (the discarded first call, per phrasing): ${cold.map(([k, v]) => `${k} ${v} ms`).join(", ")}. The bar wants < 1 s, and 29.5 s was measured for a cold LM Studio.`);
  if (report.best_phrasing) out.push(`Best phrasing on these fixtures: ${report.best_phrasing}.`);
  return out.join("\n");
}
