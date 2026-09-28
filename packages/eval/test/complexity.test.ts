// The confirmatory eval (T9-3, docs/ops/dynamic-router.md §7.2).
//
// OFFLINE throughout: the planner is answered by recorded responses
// (`test/fixtures/complexity/recording.jsonl`, replayed through the served
// call) or by an in-memory scorer. No test dials a server, and none could
// dial a paid one — the money rule is itself one of the tests.
//
// Every label below is SYNTHETIC test data ("synthetic simple item one"),
// chosen to make a statistic testable. The eval's fixtures are the owner's,
// labelled by the owner (C11), and the example this package ships is empty.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  COMPLEXITY_NAMES,
  COMPLEXITY_OPTIONS,
  choiceBody,
  codesFor,
  complexityMessages,
  intentGuard,
  parseCompute,
  type Complexity,
  type Compute,
} from "@foldedspacelabs/metistry-core";
import {
  BAR_TABLE,
  CacheReportJson,
  COMPLEXITY_BAR,
  DEFAULT_CLASS,
  RouteReportJson,
  buildComplexityReport,
  buildCostReport,
  checkFixtureSet,
  fitComplexityThreshold,
  loadComplexityFixtures,
  loadEvalRules,
  measureAt,
  parseRecording,
  pearson,
  recordingFetch,
  renderComplexityReport,
  replayFetch,
  runComplexityEval,
  servedClass,
  servedScorer,
  tierCost,
  wordCount,
  type ComplexityFixture,
  type ComplexityRow,
  type ComplexityScorer,
  type PlannerAnswer,
} from "../src/complexity.js";
import { main } from "../src/main.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FX = join(HERE, "fixtures", "complexity");
const fx = (name: string): string => join(FX, name);
const read = (name: string): string => readFileSync(fx(name), "utf8");

const COMPUTE: Compute = parseCompute(read("compute.yaml"));

// ---- a synthetic set that meets every §7.2 requirement ----------------------------

const words = (n: number, seed: string): string => Array.from({ length: n }, (_, i) => `${seed}${i}`).join(" ");

/**
 * 50 of each class; in every class five items of 45 words and five of 6, the
 * rest 12–30 — so length says nothing about the label (r ≈ 0). The long
 * `simple` ones are the long traps, the short `demanding` ones the short
 * traps, and five `demanding` items are D08-class.
 */
function qualifyingSet(): ComplexityFixture[] {
  const out: ComplexityFixture[] = [];
  for (const label of COMPLEXITY_NAMES) {
    for (let i = 0; i < 50; i++) {
      const n = i < 5 ? 45 : i < 10 ? 6 : 12 + (i % 19);
      const f: ComplexityFixture = { id: `${label}-${i}`, text: words(n, `${label[0]}${i}w`), label };
      if (label === "simple" && i < 5) f.trap = "long_simple";
      if (label === "demanding" && i >= 5 && i < 10) f.trap = "short_demanding";
      if (label === "demanding" && i >= 10 && i < 15) f.d08 = true;
      out.push(f);
    }
  }
  return out;
}

/** A planner that answers from a table by text, with a fixed confidence and latency. */
function tableScorer(answers: (f: ComplexityFixture, call: number) => PlannerAnswer, fixtures: readonly ComplexityFixture[]): ComplexityScorer & { calls: number } {
  const byText = new Map(fixtures.map((f) => [f.text, f]));
  const counts = new Map<string, number>();
  const s = (async (text: string) => {
    s.calls += 1;
    const n = (counts.get(text) ?? 0) + 1;
    counts.set(text, n);
    return answers(byText.get(text)!, n);
  }) as ComplexityScorer & { calls: number };
  s.calls = 0;
  return s;
}

const right = (f: ComplexityFixture): PlannerAnswer => ({ outcome: "scored", class: f.label, confidence: 0.9, latency_ms: 150 });

const REPORT_OPTS = { threshold: 0, thresholdSource: "test", timeoutMs: 400, timeoutSource: "test", at: new Date("2026-09-28T00:00:00Z") };

// ---- the fixture file the OWNER writes --------------------------------------------

describe("the fixture file the owner writes", () => {
  it("reads one labelled message per line, ignoring blanks and comments", () => {
    const { fixtures, issues } = loadComplexityFixtures(read("items.jsonl"), "items.jsonl");
    expect(issues).toEqual([]);
    expect(fixtures).toHaveLength(12);
    expect(fixtures.find((f) => f.id === "d2")!.d08).toBe(true);
  });

  it("the shipped example is EMPTY, because Claude may not write a label (C11)", () => {
    const text = readFileSync(join(HERE, "..", "examples", "complexity.example.jsonl"), "utf8");
    expect(text).toBe("");
    expect(loadComplexityFixtures(text, "complexity.example.jsonl")).toEqual({ fixtures: [], issues: [] });
  });

  it("refuses a class this build does not know, a key nobody named, and an unreadable line — each with its line number", () => {
    const { fixtures, issues } = loadComplexityFixtures(
      ['{"text":"x","label":"deep"}', '{"text":"x","label":"simple","lable":"typo"}', "{not json"].join("\n"),
      "complexity.jsonl",
    );
    expect(fixtures).toEqual([]);
    expect(issues.map((i) => i.line)).toEqual([1, 2, 3]);
  });

  it("refuses a trap mark on an item that is not that trap, so it cannot count toward a requirement it does not meet", () => {
    const { issues } = loadComplexityFixtures(
      [
        JSON.stringify({ text: "short simple", label: "simple", trap: "long_simple" }),
        JSON.stringify({ text: words(45, "x"), label: "moderate", trap: "long_simple" }),
        JSON.stringify({ text: words(9, "y"), label: "demanding", trap: "short_demanding" }),
        JSON.stringify({ text: "replan it", label: "moderate", d08: true }),
      ].join("\n"),
      "complexity.jsonl",
    );
    expect(issues.map((i) => i.line)).toEqual([1, 2, 3, 4]);
    expect(issues[0]!.message).toMatch(/more than 40 words/);
    expect(issues[3]!.message).toMatch(/D08-class/);
  });

  it("refuses a duplicate id", () => {
    const { issues } = loadComplexityFixtures(['{"id":"a","text":"x","label":"simple"}', '{"id":"a","text":"y","label":"simple"}'].join("\n"), "c.jsonl");
    expect(issues).toEqual([{ source: "c.jsonl", line: 2, message: "duplicate id: a" }]);
  });

  it("counts words as whitespace runs", () => {
    expect(wordCount("  one two\tthree\n four ")).toBe(4);
    expect(wordCount("   ")).toBe(0);
  });
});

// ---- the fixture set against §7.2 ---------------------------------------------------

describe("the fixture set is itself held to §7.2", () => {
  it("a set meeting every requirement qualifies", () => {
    const set = checkFixtureSet(qualifyingSet());
    expect(set.requirements.filter((r) => !r.pass)).toEqual([]);
    expect(set.qualifies).toBe(true);
    expect(Math.abs(set.length_r!)).toBeLessThan(0.2);
  });

  it("49 demanding items is not a qualifying set", () => {
    const set = checkFixtureSet(qualifyingSet().filter((f) => f.id !== "demanding-49"));
    expect(set.qualifies).toBe(false);
    expect(set.requirements.find((r) => r.requirement === "`demanding` items")!.pass).toBe(false);
  });

  it("a set where length predicts the label does not qualify", () => {
    const set = qualifyingSet().map((f) => ({ ...f, text: words(f.label === "simple" ? 20 : f.label === "moderate" ? 25 : 30, f.id!) }));
    const checked = checkFixtureSet(set.map(({ trap: _t, ...rest }) => rest));
    expect(Math.abs(checked.length_r!)).toBeGreaterThan(0.2);
    expect(checked.qualifies).toBe(false);
  });

  it("fewer than five D08-class items, or traps under 10%, is not a qualifying set", () => {
    const noD08 = checkFixtureSet(qualifyingSet().map(({ d08: _d, ...f }) => f));
    expect(noD08.requirements.find((r) => r.requirement.startsWith("D08"))!.pass).toBe(false);
    const fewTraps = checkFixtureSet(qualifyingSet().map((f) => (f.trap === "long_simple" && f.id !== "simple-0" ? { ...f, trap: "none" as const } : f)));
    expect(fewTraps.requirements.find((r) => r.requirement.startsWith("long-simple"))!.pass).toBe(false);
  });

  it("Pearson r is null where a side has no variance — not 0, which would read as a pass", () => {
    expect(pearson([1, 2, 3], [0, 0, 0])).toBeNull();
    expect(pearson([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 9);
  });
});

// ---- the bar ------------------------------------------------------------------------

const row = (f: Partial<ComplexityFixture> & { label: Complexity }, answer: PlannerAnswer, repeat: PlannerAnswer = answer): ComplexityRow => {
  const fixture: ComplexityFixture = { text: "x", ...f };
  return { fixture, words: wordCount(fixture.text), answer, repeat };
};
const said = (cls: Complexity, confidence: number): PlannerAnswer => ({ outcome: "scored", class: cls, confidence, latency_ms: 100 });

describe("reading the planner at a threshold", () => {
  it("below the threshold an item is served on the default tier, as moderate", () => {
    expect(DEFAULT_CLASS).toBe("moderate");
    expect(servedClass(said("demanding", 0.59), 0.6)).toBe("moderate");
    expect(servedClass(said("demanding", 0.6), 0.6)).toBe("demanding");
    expect(servedClass({ outcome: "guarded", reason: "too_long" }, 0)).toBe("moderate");
    expect(servedClass({ outcome: "unavailable", reason: "no_answer" }, 0)).toBe("moderate");
  });

  it("accuracy honours the accept list; deep-miss does not — an ambiguous deep item served on default is still a deep miss", () => {
    const rows = [row({ label: "demanding", accept: ["moderate"] }, said("moderate", 0.9)), row({ label: "demanding" }, said("demanding", 0.9))];
    const at = measureAt(rows, 0);
    expect(at.accuracy).toBe(1);
    expect(at.deep_miss).toBe(0.5);
  });

  it("the traps are read literally, and a set with none reads null rather than a pass", () => {
    const rows = [row({ label: "simple", trap: "long_simple" }, said("moderate", 0.9)), row({ label: "demanding", trap: "short_demanding" }, said("demanding", 0.9))];
    expect(measureAt(rows, 0)).toMatchObject({ long_simple: 0, short_demanding: 1 });
    expect(measureAt([row({ label: "simple" }, said("simple", 0.9))], 0)).toMatchObject({ long_simple: null, short_demanding: null });
  });
});

describe("the report against the pre-registered bar", () => {
  it("PASSES a qualifying set the planner gets right, deterministically, warm and in time", async () => {
    const set = qualifyingSet();
    const result = await runComplexityEval({ fixtures: set, score: tableScorer(right, set) });
    const report = buildComplexityReport(result, REPORT_OPTS);
    expect(report.bar.filter((b) => !b.pass)).toEqual([]);
    expect(report.verdict.pass).toBe(true);
    expect(report.verdict.line).toMatch(/^PASS/);
  });

  it("scores every item in two whole runs, after one discarded warm-up call", async () => {
    const set = qualifyingSet();
    const s = tableScorer(right, set);
    const result = await runComplexityEval({ fixtures: set, score: s });
    expect(s.calls).toBe(set.length * 2 + 1);
    expect(result.rows).toHaveLength(set.length);
  });

  it("FAILS determinism when a second temperature-0 run answers differently", async () => {
    const set = qualifyingSet();
    const flip = (f: ComplexityFixture, call: number): PlannerAnswer => (f.id === "moderate-20" && call >= 2 ? { ...right(f), confidence: 0.8 } : right(f));
    const report = buildComplexityReport(await runComplexityEval({ fixtures: set, score: tableScorer(flip, set), warmUp: false }), REPORT_OPTS);
    expect(report.bar.find((b) => b.key === "determinism")!.pass).toBe(false);
    expect(report.verdict.line).toMatch(/^FAIL — .*determinism/);
  });

  it("FAILS on one unscored item, and on a p95 over the owner's policy.timeout_ms", async () => {
    const set = qualifyingSet();
    const down = (f: ComplexityFixture): PlannerAnswer => (f.id === "simple-30" ? { outcome: "unavailable", reason: "no_answer" } : right(f));
    const slow = (f: ComplexityFixture): PlannerAnswer => ({ ...right(f), latency_ms: 450 });
    const a = buildComplexityReport(await runComplexityEval({ fixtures: set, score: tableScorer(down, set) }), REPORT_OPTS);
    expect(a.bar.find((b) => b.key === "unscored")).toMatchObject({ result: "1", pass: false });
    const b = buildComplexityReport(await runComplexityEval({ fixtures: set, score: tableScorer(slow, set) }), REPORT_OPTS);
    expect(b.bar.find((x) => x.key === "latency")!.pass).toBe(false);
    expect(b.latency.over_served_deadline).toBe(set.length * 2); // every call over the 300 ms a scorer gets of a 400 ms deadline
  });

  it("FAILS deep-miss when more than 10% of demanding items are served below demanding, and lists every one verbatim", async () => {
    const set = qualifyingSet();
    const miss = (f: ComplexityFixture): PlannerAnswer => (f.label === "demanding" && Number(f.id!.split("-")[1]) >= 44 ? said("moderate", 0.7) : right(f));
    const report = buildComplexityReport(await runComplexityEval({ fixtures: set, score: tableScorer(miss, set) }), REPORT_OPTS);
    expect(report.bar.find((b) => b.key === "deep_miss")).toMatchObject({ result: "12.0%", pass: false });
    expect(report.deep_misses).toHaveLength(6);
    expect(report.deep_misses[0]).toMatchObject({ id: "demanding-44", served: "moderate", predicted: "moderate", confidence: 0.7 });
    expect(report.deep_misses[0]!.text).toBe(set.find((f) => f.id === "demanding-44")!.text);
    expect(report.confusion.demanding).toEqual({ simple: 0, moderate: 6, demanding: 44 });
  });

  it("a perfect score on a set that does not qualify is NOT A QUALIFYING RUN, never a pass", async () => {
    const set = qualifyingSet().slice(0, 120);
    const report = buildComplexityReport(await runComplexityEval({ fixtures: set, score: tableScorer(right, set) }), REPORT_OPTS);
    expect(report.bar.every((b) => b.key === "long_simple" || b.key === "short_demanding" || b.pass)).toBe(true);
    expect(report.verdict.pass).toBe(false);
    expect(report.verdict.line).toMatch(/^NOT A QUALIFYING RUN/);
  });

  it("quotes the bar, as §7.2 states it, BEFORE any result", async () => {
    const set = qualifyingSet();
    const text = renderComplexityReport(buildComplexityReport(await runComplexityEval({ fixtures: set, score: tableScorer(right, set) }), REPORT_OPTS));
    const barAt = text.indexOf("## The bar, pre-registered");
    expect(barAt).toBeGreaterThan(0);
    expect(barAt).toBeLessThan(text.indexOf("## The fixture set"));
    expect(barAt).toBeLessThan(text.indexOf("## Result"));
    for (const b of BAR_TABLE) expect(text).toContain(b.bar.replace(/\|/g, "\\|"));
    expect(COMPLEXITY_BAR).toEqual({ accuracy: 0.85, deep_miss: 0.1, long_simple: 0.83, short_demanding: 0.83, determinism: 1, unscored: 0 });
  });
});

// ---- the fit ------------------------------------------------------------------------

describe("the threshold is an OUTPUT of the eval", () => {
  it("picks the lowest threshold that meets accuracy and deep-miss together, counting below it as the default tier", () => {
    const rows: ComplexityRow[] = [
      ...Array.from({ length: 18 }, () => row({ label: "simple" }, said("simple", 0.9))),
      // two confident-looking wrong answers on moderate items, at 0.5: below a
      // threshold they are served moderate, which is right
      row({ label: "moderate" }, said("simple", 0.5)),
      row({ label: "moderate" }, said("demanding", 0.5)),
      ...Array.from({ length: 10 }, () => row({ label: "demanding" }, said("demanding", 0.95))),
    ];
    const fit = fitComplexityThreshold(rows);
    expect(measureAt(rows, 0).accuracy).toBeCloseTo(28 / 30, 6);
    expect(fit.fitted!.threshold).toBe(0);
    // a harsher set: at 0 accuracy is 25/30 and only a threshold above 0.5 clears it
    const harsh = [...rows, ...Array.from({ length: 3 }, () => row({ label: "moderate" }, said("simple", 0.5)))];
    const f2 = fitComplexityThreshold(harsh);
    expect(f2.fitted!.threshold).toBe(0.9);
    expect(f2.fitted!.deep_miss).toBe(0);
  });

  it("says so, and prints no number, when no threshold meets the bar", () => {
    const rows = Array.from({ length: 10 }, () => row({ label: "demanding" }, said("simple", 0.9)));
    const fit = fitComplexityThreshold(rows);
    expect(fit.fitted).toBeNull();
    expect(fit.why).toMatch(/no threshold/);
  });
});

// ---- the scorer IS the served call --------------------------------------------------

describe("the scorer is the router's call, byte for byte", () => {
  it("sends exactly the body the router's policy sends: complexityMessages over the COMPLEXITY options, to assignments.intent", async () => {
    const seen: Array<{ url: string; body: string }> = [];
    const fetchFn = (async (url: string, init: { body: string }) => {
      seen.push({ url, body: init.body });
      return new Response(JSON.stringify({ choices: [{ logprobs: { content: [{ top_logprobs: [{ token: "C", logprob: Math.log(0.9) }, { token: "B", logprob: Math.log(0.1) }] }] } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const now = new Date("2026-09-28T09:00:00Z");
    const answer = await servedScorer({ access: { compute: () => COMPUTE, fetchFn }, now })("  replan the week around the offsite  ");
    expect(answer).toMatchObject({ outcome: "scored", class: "demanding" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("http://127.0.0.1:9/v1/chat/completions");
    const guarded = intentGuard("  replan the week around the offsite  ");
    if (!guarded.ok) throw new Error("guard refused");
    const expected = choiceBody({
      url: seen[0]!.url,
      model: "gemma4:e4b-it-qat",
      options: COMPLEXITY_OPTIONS,
      codes: codesFor(COMPLEXITY_OPTIONS.length),
      messages: complexityMessages(guarded.text, { now }),
      server: "ollama",
    });
    expect(JSON.parse(seen[0]!.body)).toEqual(expected);
  });

  it("the guard refuses what the router's guard refuses, before any call", async () => {
    const fetchFn = vi.fn();
    const answer = await servedScorer({ access: { compute: () => COMPUTE, fetchFn: fetchFn as unknown as typeof fetch } })("");
    expect(answer.outcome).toBe("guarded");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("MONEY RULE: an off-machine planner is refused at load, and again at the call — nothing is dialled", async () => {
    expect(() =>
      parseCompute(read("compute.yaml").replace("intent: { model: ollama/gemma4:e4b-it-qat }", "intent: { model: cloud/big-model }")),
    ).toThrow(/intent/);
    // an instance that edited its own file after the schema ran: the call refuses
    const edited: Compute = { ...COMPUTE, assignments: { ...COMPUTE.assignments!, intent: { model: "cloud/big-model" } } };
    const fetchFn = vi.fn();
    await expect(servedScorer({ access: { compute: () => edited, fetchFn: fetchFn as unknown as typeof fetch } })("plan the move")).rejects.toThrow(/locality: off_machine/);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

// ---- recorded responses --------------------------------------------------------------

describe("recorded responses", () => {
  it("a recording replays to the same answers the recorded run gave", async () => {
    const live = (async () =>
      new Response(JSON.stringify({ choices: [{ logprobs: { content: [{ top_logprobs: [{ token: "A", logprob: Math.log(0.8) }, { token: "B", logprob: Math.log(0.2) }] }] } }] }), { status: 200 })) as unknown as typeof fetch;
    const recorded: ReturnType<typeof parseRecording> = [];
    const first = await servedScorer({ access: { compute: () => COMPUTE, fetchFn: recordingFetch(live, (c) => recorded.push(c)) } })("synthetic item");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.content).toBe("synthetic item");
    const replay = replayFetch(parseRecording(recorded.map((c) => JSON.stringify(c)).join("\n"), "rec"));
    const again = await servedScorer({ access: { compute: () => COMPUTE, fetchFn: replay.fetchFn }, latencyOf: replay.lastLatency })("synthetic item");
    expect({ ...again, latency_ms: 0 }).toEqual({ ...first, latency_ms: 0 });
    expect(again.latency_ms).toBe(recorded[0]!.latency_ms);
    expect(replay.unused()).toBe(0);
  });

  it("a request the recording has no answer for is a server that did not answer — unscored, never invented", async () => {
    const replay = replayFetch([]);
    expect(await servedScorer({ access: { compute: () => COMPUTE, fetchFn: replay.fetchFn } })("never recorded")).toMatchObject({ outcome: "unavailable" });
  });
});

// ---- cost ----------------------------------------------------------------------------

describe("cost — reported, not gated", () => {
  const route = RouteReportJson.parse(JSON.parse(read("route-report.json")));
  const cache = CacheReportJson.parse(JSON.parse(read("cache-report.json")));

  it("a tier with 20+ observed calls is its observed mean; a thin one is the default tier's tokens at its own rate, and says so", () => {
    expect(tierCost("deep", cache, COMPUTE)).toMatchObject({ basis: "observed", per_turn_usd: 0.09 });
    expect(tierCost("fast", cache, COMPUTE)).toMatchObject({ basis: "default_tokens_at_rate", per_turn_usd: 0 });
    const thinDeep = { ...cache, groups: cache.groups.map((g) => (g.tier === "deep" ? { ...g, turns: 10 } : g)) };
    // 10000 in / 1000 out (the default tier's means) at 3 / 15 per million
    expect(tierCost("deep", thinDeep, COMPUTE)).toMatchObject({ basis: "default_tokens_at_rate", per_turn_usd: 0.045 });
    expect(tierCost("deep", thinDeep, COMPUTE).note).toMatch(/< 20/);
  });

  it("an unpriceable tier reads unpriced — never $0", () => {
    const noRate = parseCompute(read("compute.yaml").replace("    pricing:\n      big-model: { in_per_m: 3, out_per_m: 15 }\n", ""));
    const thin = { ...cache, groups: cache.groups.filter((g) => g.tier !== "deep") };
    expect(tierCost("deep", thin, noRate)).toMatchObject({ basis: "unpriced", per_turn_usd: null });
  });

  it("prices today's mix, the policy's shadow decisions applied to it, and always-the-top, and the cost per rescued turn", () => {
    const rules = loadEvalRules(read("rules.yaml"));
    const rows = [row({ label: "demanding" }, said("demanding", 0.9)), row({ label: "demanding" }, said("demanding", 0.9)), row({ label: "moderate" }, said("demanding", 0.9))];
    const c = buildCostReport({ routeReport: route, cacheReport: cache, compute: COMPUTE, policyTiers: rules.policy!.tiers, rows, threshold: 0.6 });
    expect(c.turns).toBe(1000);
    const [today, policy, top] = c.lines;
    expect(today!.per_1000_usd).toBeCloseTo(9, 9); // 100 deep turns × $0.09
    expect(policy!.mix).toMatchObject({ default: 500, fast: 300, deep: 200 });
    expect(policy!.per_1000_usd).toBeCloseTo(18, 9);
    expect(top!.name).toMatch(/deep/);
    expect(top!.per_1000_usd).toBeCloseTo(90, 9);
    expect(c.upgrades_per_1000).toBe(100);
    expect(c.upgrade_precision).toBeCloseTo(2 / 3, 9);
    expect(c.cost_per_rescued_usd).toBeCloseTo(9 / (100 * (2 / 3)), 9);
  });
});

// ---- the command, end to end, offline --------------------------------------------------

describe("metistry-eval complexity, end to end on a recording", () => {
  it("runs the served call against recorded responses and writes the report the owner reads", async () => {
    const dir = mkdtempSync(join(tmpdir(), "metistry-eval-complexity-"));
    const outFile = join(dir, "report.md");
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((s: string | Uint8Array) => (writes.push(String(s)), true));
    const netSpy = vi.spyOn(globalThis, "fetch");
    let code: number;
    try {
      code = await main([
        "complexity",
        fx("items.jsonl"),
        "--compute", fx("compute.yaml"),
        "--rules", fx("rules.yaml"),
        "--replay", fx("recording.jsonl"),
        "--route-report", fx("route-report.json"),
        "--cache-report", fx("cache-report.json"),
        "--fit",
        "--out", outFile,
      ]);
    } finally {
      spy.mockRestore();
    }
    expect(netSpy).not.toHaveBeenCalled();
    netSpy.mockRestore();
    // twelve synthetic items cannot qualify, so the only exit that means PASS is not the answer
    expect(code).toBe(1);
    const report = readFileSync(outFile, "utf8");
    expect(report).toMatch(/NOT A QUALIFYING RUN/);
    expect(report).toContain("replayed from a recording");
    expect(report).toContain('`d3` served **moderate** (planner said moderate at 0.550): "synthetic demanding item three"');
    expect(report).toMatch(/\| determinism \| 100% identical across two temperature-0 runs \| 100\.0% \(12\/12\) \| PASS \|/);
    expect(report).toContain("| today's router | $9.00 |");
    expect(report).toContain("| default → deep | 100 | 11.1% |");
    expect(writes.join("")).toContain("report → ");
  });

  it("refuses an empty fixture file by name, before dialling anything", async () => {
    const dir = mkdtempSync(join(tmpdir(), "metistry-eval-complexity-"));
    writeFileSync(join(dir, "complexity.jsonl"), "");
    const errs: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((s: string | Uint8Array) => (errs.push(String(s)), true));
    try {
      expect(await main(["complexity", join(dir, "complexity.jsonl"), "--compute", fx("compute.yaml")])).toBe(1);
    } finally {
      spy.mockRestore();
    }
    expect(errs.join("")).toMatch(/C11/);
  });

  it("refuses a compute.yaml with no planner assigned", async () => {
    const dir = mkdtempSync(join(tmpdir(), "metistry-eval-complexity-"));
    writeFileSync(join(dir, "compute.yaml"), read("compute.yaml").replace("  intent: { model: ollama/gemma4:e4b-it-qat }\n", ""));
    const errs: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((s: string | Uint8Array) => (errs.push(String(s)), true));
    try {
      expect(await main(["complexity", fx("items.jsonl"), "--compute", join(dir, "compute.yaml")])).toBe(1);
    } finally {
      spy.mockRestore();
    }
    expect(errs.join("")).toMatch(/assignments\.intent/);
  });
});
