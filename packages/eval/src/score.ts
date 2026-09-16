// Scoring. Two axes in code, three by rubric — and the gates that apply to
// all five (§3.2, §3.5).
//
// Everything here is a pure function of (fixture, observation). No clock, no
// network, no engine: a rubric revision, a re-score and a CI regression run
// the same code over the same stored rows, which is what §3.2's "raw JSONL is
// stored so a revised rubric re-scores without a re-run" is for.
//
// The gates (`must_include`, `must_not_include`, `one_of`) are checked FIRST
// and on every axis. A case that violates one fails before a judge is called:
// a hard requirement the owner wrote down is not something a model talks its
// way past, and not something worth spending a judge call on.

import { RUBRIC_PASS, isRubricAxis, type ArgMatcher, type ExpectedToolCall, type Fixture } from "./fixtures.js";
import type { JudgeVerdict, RecordedCall } from "./record.js";
import { unqualify } from "./tools.js";

export interface Observation {
  /** The candidate's final answer. */
  answer: string;
  /** Every tool call it made, in order, arguments as sent. */
  calls: readonly RecordedCall[];
  /** Calls to tools that were never listed. */
  hallucinated: readonly string[];
  /** Agentic turns the loop took. */
  turns: number;
  /** Why the loop stopped, when it was not the model's own choice. `max_turns` and `veto` are runaway loops by definition. */
  stopped?: "max_turns" | "max_budget" | "veto" | undefined;
}

export interface Score {
  pass: boolean;
  /** 0–1. What fraction of the expectation was met — a partial score is what tells you a model is close rather than lost. */
  score: number;
  /** Every reason this case is not a 1.0, in the order they were checked. Rendered under a failure in the report. */
  reasons: string[];
}

// ---- gates --------------------------------------------------------------------

function normalise(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Case- and whitespace-insensitive containment: an expectation about words, not about formatting. */
export function includes(haystack: string, needle: string): boolean {
  return normalise(haystack).includes(normalise(needle));
}

export function checkGates(f: Fixture, answer: string): string[] {
  const reasons: string[] = [];
  for (const needle of f.expected.must_include ?? []) if (!includes(answer, needle)) reasons.push(`must_include: the answer never says "${needle}"`);
  for (const needle of f.expected.must_not_include ?? []) if (includes(answer, needle)) reasons.push(`must_not_include: the answer says "${needle}"`);
  const oneOf = f.expected.one_of;
  if (oneOf !== undefined && oneOf.length > 0 && !oneOf.some((n) => includes(answer, n))) reasons.push(`one_of: the answer names none of ${oneOf.map((n) => `"${n}"`).join(", ")}`);
  return reasons;
}

// ---- tool calls ---------------------------------------------------------------

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  const ka = Object.keys(a as Record<string, unknown>).sort();
  const kb = Object.keys(b as Record<string, unknown>).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i]) && ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** One argument against one matcher. `any` means "present, whatever it is"; `contains` reaches into an array of strings. */
export function matchesArg(value: unknown, matcher: ArgMatcher): boolean {
  if ("any" in matcher) return value !== undefined;
  if ("equals" in matcher) return deepEqual(value, matcher.equals);
  if ("regex" in matcher) {
    let re: RegExp;
    try {
      re = new RegExp(matcher.regex, "i");
    } catch {
      return false;
    }
    return typeof value === "string" ? re.test(value) : re.test(JSON.stringify(value ?? null));
  }
  if (Array.isArray(value)) return value.some((v) => typeof v === "string" && includes(v, matcher.contains));
  return typeof value === "string" ? includes(value, matcher.contains) : includes(JSON.stringify(value ?? null), matcher.contains);
}

/** Does this actual call satisfy this expectation? Name first, then only the arguments the fixture named — extras are allowed. */
export function matchesCall(actual: RecordedCall, expected: ExpectedToolCall): boolean {
  if (unqualify(actual.name) !== unqualify(expected.name)) return false;
  for (const [arg, matcher] of Object.entries(expected.args_match ?? {})) if (!matchesArg(actual.args[arg], matcher)) return false;
  return true;
}

/**
 * The `tool_calls` axis. Every expected call must appear once (matching is
 * greedy and one actual call satisfies at most one expectation, so "call
 * capture twice" is expressible by listing it twice), no hallucinated tool
 * may appear, and — where the fixture expects NO calls — no call may appear
 * at all. Extra calls to real tools cost nothing here; agreement with the bar
 * (report.ts) is where churn shows up.
 */
export function scoreToolCalls(f: Fixture, obs: Observation): Score {
  const expected = f.expected.tool_calls ?? [];
  const reasons: string[] = [];
  const unused = obs.calls.map((_, i) => i);
  let matched = 0;
  for (const want of expected) {
    const hitAt = unused.findIndex((i) => matchesCall(obs.calls[i]!, want));
    if (hitAt === -1) {
      reasons.push(`no call matched ${unqualify(want.name)}${want.args_match ? ` with ${JSON.stringify(want.args_match)}` : ""}`);
      continue;
    }
    unused.splice(hitAt, 1);
    matched += 1;
  }
  for (const name of obs.hallucinated) reasons.push(`hallucinated tool: ${name}`);
  if (expected.length === 0) {
    const real = obs.calls.filter((c) => c.is_error !== true).length;
    if (real > 0) reasons.push(`expected no tool call; the turn made ${real}`);
    return { pass: reasons.length === 0, score: reasons.length === 0 ? 1 : 0, reasons };
  }
  const score = matched / expected.length;
  return { pass: score === 1 && obs.hallucinated.length === 0, score: obs.hallucinated.length > 0 ? 0 : score, reasons };
}

/**
 * The `stopping` axis: "reading a thread and knowing when to stop". Two ways
 * to fail — taking more turns than the case is worth, and being CUT OFF (the
 * turn cap, the no-progress veto) rather than choosing to stop, which is the
 * runaway loop the axis exists to catch even when the answer happens to be
 * inside the cap.
 */
export function scoreStopping(f: Fixture, obs: Observation): Score {
  const limit = f.expected.stop_after_turns ?? 0;
  const reasons: string[] = [];
  if (obs.turns > limit) reasons.push(`took ${obs.turns} turns; the case stops in ${limit}`);
  if (obs.stopped === "max_turns" || obs.stopped === "veto") reasons.push(`the loop was cut off (${obs.stopped}) rather than stopping on its own`);
  for (const name of obs.hallucinated) reasons.push(`hallucinated tool: ${name}`);
  return { pass: reasons.length === 0, score: reasons.length === 0 ? 1 : Math.max(0, Math.min(1, limit === 0 ? 0 : limit / Math.max(obs.turns, 1))), reasons };
}

/** A rubric verdict, scored. 1–5 in, 0–1 out; pass at ≥ 4 (§3.2). */
export function scoreRubric(verdict: JudgeVerdict): Score {
  return {
    pass: verdict.verdict >= RUBRIC_PASS,
    score: verdict.verdict / 5,
    reasons: verdict.verdict >= RUBRIC_PASS ? [] : [`judge ${verdict.model} scored ${verdict.verdict}/5: ${verdict.reason}`],
  };
}

/**
 * The one entry point. Gates first, then the axis. `verdict` is required for
 * a rubric fixture and its absence FAILS the case — never passes it
 * (Atomic ADOPT 6); the runner turns an unreachable judge into exactly this.
 */
export function scoreCase(f: Fixture, obs: Observation, verdict?: JudgeVerdict | undefined): Score {
  const gateFailures = checkGates(f, obs.answer);
  const axisScore = ((): Score => {
    if (f.axis === "tool_calls") return scoreToolCalls(f, obs);
    if (f.axis === "stopping") return scoreStopping(f, obs);
    if (f.expected.rubric === undefined) return { pass: true, score: 1, reasons: [] }; // a rubric-axis fixture scored only by its gates
    if (verdict === undefined) return { pass: false, score: 0, reasons: ["no judge verdict: an absent judge fails the case (§3.2)"] };
    return scoreRubric(verdict);
  })();
  const reasons = [...gateFailures, ...axisScore.reasons];
  return { pass: gateFailures.length === 0 && axisScore.pass, score: gateFailures.length === 0 ? axisScore.score : 0, reasons };
}

/** Does this fixture need a judge call? Only a rubric axis with a rubric written on it does. */
export function needsJudge(f: Fixture): boolean {
  return isRubricAxis(f.axis) && f.expected.rubric !== undefined;
}
