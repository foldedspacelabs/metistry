// The intent axis: the fixture format the owner types, the metrics, and the
// THRESHOLD FIT — which is the command's whole reason to exist (§4.4).
//
// Scored with a fake scorer throughout. The labels below are not fixtures and
// could never be: they are a synthetic distribution chosen to make a
// statistic testable, and C11's rule is about expected ANSWERS, which is why
// `fitThreshold` is exercised against numbers rather than against sentences.
import { describe, expect, it } from "vitest";
import { INTENT_UNSURE, type Intent, type IntentPhrasing } from "@foldedspacelabs/metistry-core";
import { INTENT_BAR, buildIntentReport, ece, fitThreshold, loadIntentFixtures, percentile, renderIntentReport, runIntentEval, type IntentFixture, type IntentRow } from "../src/intents.js";

const fx = (text: string, intent: Intent): IntentFixture => ({ text, intent });

describe("the fixture file the OWNER writes", () => {
  it("reads one labelled message per line, ignoring blanks and comments", () => {
    const { fixtures, issues } = loadIntentFixtures(
      ['# my own messages, labelled by me', '{"text":"buy milk","intent":"task_create"}', "", '{"text":"hey","intent":"smalltalk","compound":false}'].join("\n"),
      "intents.jsonl",
    );
    expect(issues).toEqual([]);
    expect(fixtures).toHaveLength(2);
    expect(fixtures[1]!.compound).toBe(false);
  });

  it("refuses a label this build does not know, with the line number", () => {
    const { fixtures, issues } = loadIntentFixtures('{"text":"x","intent":"book_a_flight"}', "intents.jsonl");
    expect(fixtures).toHaveLength(0);
    expect(issues[0]!.line).toBe(1);
    expect(issues[0]!.message).toMatch(/intent/);
  });

  it("refuses an unreadable line rather than dropping it in silence", () => {
    const { issues } = loadIntentFixtures("{not json", "intents.jsonl");
    expect(issues[0]!.message).toMatch(/not JSON/);
  });

  it("refuses a key nobody named — a typo must not become a silently ignored field", () => {
    const { issues } = loadIntentFixtures('{"text":"x","intent":"smalltalk","intnt":"typo"}', "intents.jsonl");
    expect(issues).toHaveLength(1);
  });

  it("the shipped example is EMPTY, because Claude may not write a label (C11)", () => {
    const { fixtures, issues } = loadIntentFixtures("", "intents.example.jsonl");
    expect(fixtures).toEqual([]);
    expect(issues).toEqual([]);
  });
});

describe("the metrics", () => {
  it("percentiles over an empty set are 0, not NaN", () => {
    expect(percentile([], 0.5)).toBe(0);
    expect(percentile([10, 20, 30, 40], 0.5)).toBe(30);
  });

  it("ECE is 0 when confidence matches accuracy and 1 when it is exactly inverted", () => {
    expect(ece([{ confidence: 1, correct: true }, { confidence: 0, correct: false }])).toBeCloseTo(0, 6);
    expect(ece([{ confidence: 1, correct: false }])).toBeCloseTo(1, 6);
  });
});

// ---- the fit -------------------------------------------------------------------

const row = (gold: Intent, predicted: Intent | null, confidence: number, latency = 150): IntentRow => ({
  fixture: fx("x", gold),
  phrasing: "says" as IntentPhrasing,
  predicted,
  confidence,
  alpha: 0.99,
  latency_ms: latency,
});

describe("the threshold is an OUTPUT of this command, never an input", () => {
  it("picks the most coverage among the thresholds that meet the bar", () => {
    const rows: IntentRow[] = [
      // twenty confident, correct answers
      ...Array.from({ length: 20 }, () => row("task_create", "task_create", 0.95)),
      // one confident error, at a LOWER confidence — so a threshold above it clears the bar
      row("note_capture", "task_create", 0.4),
      // ten genuinely ambiguous ones the owner labelled `unsure`
      ...Array.from({ length: 10 }, () => row(INTENT_UNSURE, "smalltalk", 0.2)),
    ];
    const fit = fitThreshold(rows);
    expect(fit.fitted).not.toBeNull();
    expect(fit.fitted!.threshold).toBeGreaterThan(0.4);
    expect(fit.fitted!.threshold).toBeLessThanOrEqual(0.95);
    expect(fit.fitted!.accuracy_above).toBeGreaterThanOrEqual(INTENT_BAR.accuracy);
    expect(fit.fitted!.unsure_escalation).toBeGreaterThanOrEqual(INTENT_BAR.unsure_escalation);
    expect(fit.fitted!.confident_errors).toBeLessThanOrEqual(INTENT_BAR.confident_errors);
  });

  it("returns NO threshold rather than a rounded-up one when the bar cannot be met", () => {
    // Confident errors AT the top confidence: nothing above any threshold is
    // clean, which is exactly the failure §4.4 calls the worst one.
    const rows: IntentRow[] = [
      ...Array.from({ length: 10 }, () => row("task_create", "task_create", 0.99)),
      ...Array.from({ length: 10 }, () => row("note_capture", "task_create", 0.99)),
    ];
    const fit = fitThreshold(rows);
    expect(fit.fitted).toBeNull();
    expect(fit.why).toMatch(/no threshold/);
    expect(fit.sweep.length).toBeGreaterThan(1);
  });

  it("reports the escalation statistic both ways: the doc's literal one, and what the rules actually do", () => {
    const rows: IntentRow[] = [
      ...Array.from({ length: 10 }, () => row("task_create", "task_create", 0.95)),
      // predicted `unsure` AT high confidence: above the threshold by the
      // letter of §4.4, but escalated in practice, because `unsure` maps to
      // no action at all.
      ...Array.from({ length: 5 }, () => row(INTENT_UNSURE, INTENT_UNSURE, 0.95)),
    ];
    const at = fitThreshold(rows).sweep.find((p) => p.threshold === 0.95)!;
    expect(at.unsure_escalation).toBe(0);
    expect(at.unsure_escalation_operational).toBe(1);
  });

  it("honours an explicit coverage floor when the owner names one", () => {
    const rows: IntentRow[] = [
      ...Array.from({ length: 10 }, () => row("task_create", "task_create", 0.5)),
      ...Array.from({ length: 10 }, () => row("note_capture", "note_capture", 0.9)),
    ];
    expect(fitThreshold(rows, { minCoverage: 0.99 }).fitted!.coverage).toBeGreaterThanOrEqual(0.99);
    expect(fitThreshold(rows, { minCoverage: 1.1 }).fitted).toBeNull();
  });
});

// ---- the run, and the phrasing trial --------------------------------------------

describe("the run", () => {
  const fixtures: IntentFixture[] = [fx("buy milk", "task_create"), fx("hey", "smalltalk"), fx("gemma is fast", "note_capture")];

  it("scores every fixture under every phrasing, discarding one warm-up call per phrasing", async () => {
    const calls: Array<[string, string]> = [];
    const result = await runIntentEval({
      fixtures,
      phrasings: ["says", "names"],
      score: async (text, phrasing) => {
        calls.push([text, phrasing]);
        return { predicted: "task_create" as Intent, confidence: 0.9, alpha: 1, latency_ms: calls.length === 1 ? 9000 : 150 };
      },
    });
    expect(calls).toHaveLength(8); // (1 warm-up + 3) × 2
    expect(result.rows).toHaveLength(6);
    expect(result.cold_start_ms.says).toBe(9000);
    // the cold call is NOT in the percentiles
    const report = buildIntentReport(result);
    expect(report.by_phrasing[0]!.p95_ms).toBe(150);
  });

  it("names the phrasing that did best on THESE fixtures (§5.2 phase 1's wording trial)", async () => {
    const result = await runIntentEval({
      fixtures,
      phrasings: ["says", "best_fits", "names"],
      warmUp: false,
      score: async (text, phrasing) => {
        const right = fixtures.find((f) => f.text === text)!.intent;
        // `says` is right every time; `names` is right once; `best_fits` twice.
        const correct = phrasing === "says" || (phrasing === "best_fits" && right !== "smalltalk") || (phrasing === "names" && right === "task_create");
        return { predicted: (correct ? right : "artifact_review") as Intent, confidence: 0.9, alpha: 1, latency_ms: 100 };
      },
    });
    const report = buildIntentReport(result);
    expect(report.best_phrasing).toBe("says");
    expect(report.by_phrasing.find((p) => p.phrasing === "names")!.accuracy).toBeCloseTo(1 / 3, 6);
  });

  it("counts a guarded fixture as guarded rather than as a miss", async () => {
    const result = await runIntentEval({
      fixtures,
      warmUp: false,
      score: async () => ({ predicted: null, confidence: 0, alpha: 0, latency_ms: 0, guarded: "out of script" }),
    });
    const report = buildIntentReport(result);
    expect(report.by_phrasing[0]!.guarded).toBe(3);
    expect(report.by_phrasing[0]!.scored).toBe(0);
  });

  it("renders the line the owner pastes into rules.yaml", async () => {
    const result = await runIntentEval({
      fixtures: [...Array.from({ length: 20 }, () => fx("buy milk", "task_create")), fx("who knows", INTENT_UNSURE)],
      warmUp: false,
      score: async (text) => ({
        predicted: (text === "buy milk" ? "task_create" : "smalltalk") as Intent,
        confidence: text === "buy milk" ? 0.92 : 0.1,
        alpha: 1,
        latency_ms: 150,
      }),
    });
    const rendered = renderIntentReport(buildIntentReport(result));
    expect(rendered).toContain("min_confidence:");
    expect(rendered).toContain(".metistry/rules.yaml");
    expect(rendered).toMatch(/Bar \(§4\.4, pre-registered\)/);
  });
});
