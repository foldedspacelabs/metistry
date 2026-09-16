// The bake-off fixture format (PoC-18, docs/plan-refresh-2026-09-13.md §3.2).
//
// A fixture is ONE turn with ONE axis. That is the load-bearing rule: "a
// failure must name the component to fix, so no fixture mixes two axes" —
// a case that fails tells you whether to change the model, the tool
// descriptions or the prompt, and a case that measures two things at once
// tells you neither.
//
// Two of the five axes are scorable in code (`tool_calls`, `stopping`); the
// other three are judgment and voice and need a rubric (score.ts, judge.ts).
// The schema enforces the split — a `tool_calls` fixture carrying a rubric is
// refused by the validator, not silently half-scored at run time.
//
// The fixtures themselves are the OWNER'S, never Claude's: Claude is the bar
// the candidates are measured against and is never the source of an expected
// answer (C11 — Anthropic's usage policy forbids Claude outputs as training
// data of any kind, and a fixture written by the bar is the bar marking its
// own homework besides). `example: true` marks the format illustrations that
// ship with the harness; the runner skips them unless asked, so they can
// never quietly become part of a scored run.

import { z } from "zod";

/** The five things the main agent's turns actually need (§3.2, and the compute note's "What quality means … concretely"). */
export const AXES = ["tool_calls", "stopping", "triage", "voice", "writing"] as const;
export type Axis = (typeof AXES)[number];

/** Scored in code: an expected tool call either happened with the right arguments or it did not. */
export const DETERMINISTIC_AXES: readonly Axis[] = ["tool_calls", "stopping"];

/** Scored by a judge from a third family (§3.2, Atomic ADOPT 6). Judgment, voice, writing. */
export const RUBRIC_AXES: readonly Axis[] = ["triage", "voice", "writing"];

/** "pass at ≥ 4 of 5" (§3.2). One number, stated once, so the runner and the report cannot disagree about it. */
export const RUBRIC_PASS = 4;

export function isRubricAxis(axis: Axis): boolean {
  return RUBRIC_AXES.includes(axis);
}

// ---- argument matchers --------------------------------------------------------

/** The keys that make an object a MATCHER rather than a literal expected value. */
export const MATCHER_KEYS = ["equals", "regex", "contains", "any"] as const;

const MatcherObject = z.union([
  z.strictObject({ equals: z.unknown() }),
  z.strictObject({ regex: z.string().min(1) }),
  z.strictObject({ contains: z.string().min(1) }),
  z.strictObject({ any: z.literal(true) }),
]);

/** An object with EXACTLY ONE key, and that key one of `MATCHER_KEYS`. Anything else is a literal to deep-equal. */
export function looksLikeMatcher(v: unknown): boolean {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const keys = Object.keys(v as Record<string, unknown>);
  return keys.length === 1 && (MATCHER_KEYS as readonly string[]).includes(keys[0]!);
}

/**
 * `"Knowledge/Areas/Home"` and `{ "equals": "Knowledge/Areas/Home" }` mean the
 * same thing — the shorthand exists because the owner is writing fifty of
 * these by hand and the common case is an exact argument. The disambiguation
 * is mechanical, not a guess: only a single-key object whose key is one of
 * `MATCHER_KEYS` is read as a matcher.
 */
export const ArgMatcher = z.preprocess((v) => (looksLikeMatcher(v) ? v : { equals: v }), MatcherObject);
export type ArgMatcher = z.infer<typeof ArgMatcher>;

export const ExpectedToolCall = z.strictObject({
  /** Qualified (`mcp__brain__capture`) or bare (`capture`) — the scorer compares unqualified, so both spellings are the same fixture. */
  name: z.string().min(1),
  /** Argument name → matcher. Arguments not named here are not checked; a tool call with EXTRA arguments still matches. */
  args_match: z.record(z.string(), ArgMatcher).optional(),
});
export type ExpectedToolCall = z.infer<typeof ExpectedToolCall>;

// ---- the fixture --------------------------------------------------------------

export const Expected = z.strictObject({
  /** The calls this turn should make. `[]` is a real expectation: "the right answer here is to call nothing". */
  tool_calls: z.array(ExpectedToolCall).optional(),
  /** The most agentic turns an acceptable answer takes. The model must stop ON ITS OWN inside it — being cut off by the turn cap is a fail. */
  stop_after_turns: z.int().min(0).optional(),
  /** What a 5 looks like and what a 1 looks like, in the owner's words. Sent to the judge verbatim. */
  rubric: z.string().min(1).optional(),
  /** Hard gates, checked in code on every axis before any judge is called. */
  must_include: z.array(z.string().min(1)).optional(),
  must_not_include: z.array(z.string().min(1)).optional(),
  /** At least one of these must appear — the OR to `must_include`'s AND. This is the PoC-15 `accept` list's shape. */
  one_of: z.array(z.string().min(1)).optional(),
});
export type Expected = z.infer<typeof Expected>;

export const FixtureContext = z.strictObject({
  /** Prior conversation the turn is answering into — the `stopping` axis is unscorable without it. */
  thread: z.string().optional(),
  /** The morning brief as the turn would have seen it. */
  brief: z.string().optional(),
});
export type FixtureContext = z.infer<typeof FixtureContext>;

export const Fixture = z
  .strictObject({
    /** Stable, and never reused: it is the join key between a run file, a transcript and the report. */
    id: z
      .string()
      .min(1)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "must be a filename-safe id (letters, digits, . _ -)"),
    axis: z.enum(AXES),
    prompt: z.string().min(1),
    context: FixtureContext.optional(),
    expected: Expected,
    /** How much this case counts in its axis's pass rate. Default 1. */
    weight: z.number().positive().default(1),
    /** A format illustration shipped with the harness, not one of the owner's fifty. Skipped by the runner unless `--include-examples`. */
    example: z.boolean().optional(),
    /** Why this case exists — for the human reading a failure, never sent to a model. */
    notes: z.string().optional(),
  })
  .superRefine((f, ctx) => {
    const e = f.expected;
    const deterministic = f.expected.tool_calls !== undefined || f.expected.stop_after_turns !== undefined;
    const scorable = deterministic || e.rubric !== undefined || e.must_include !== undefined || e.must_not_include !== undefined || e.one_of !== undefined;
    if (!scorable) {
      ctx.addIssue({ code: "custom", path: ["expected"], message: "no expectation: a fixture needs at least one of tool_calls, stop_after_turns, rubric, must_include, must_not_include, one_of" });
    }
    // One axis per fixture, enforced in both directions.
    if (f.axis === "tool_calls" && e.tool_calls === undefined) {
      ctx.addIssue({ code: "custom", path: ["expected", "tool_calls"], message: "axis tool_calls requires expected.tool_calls (use [] for \"no tool call is the right answer\")" });
    }
    if (f.axis === "stopping" && e.stop_after_turns === undefined) {
      ctx.addIssue({ code: "custom", path: ["expected", "stop_after_turns"], message: "axis stopping requires expected.stop_after_turns" });
    }
    if (!isRubricAxis(f.axis) && e.rubric !== undefined) {
      ctx.addIssue({ code: "custom", path: ["expected", "rubric"], message: `axis ${f.axis} is scored in code: a rubric here would mix two axes in one fixture (§3.2)` });
    }
    if (isRubricAxis(f.axis) && deterministic) {
      ctx.addIssue({ code: "custom", path: ["expected"], message: `axis ${f.axis} is rubric-scored: tool_calls/stop_after_turns here would mix two axes in one fixture (§3.2)` });
    }
    if (isRubricAxis(f.axis) && e.rubric === undefined && e.one_of === undefined && e.must_include === undefined && e.must_not_include === undefined) {
      ctx.addIssue({ code: "custom", path: ["expected", "rubric"], message: `axis ${f.axis} needs a rubric, or a deterministic gate (one_of/must_include) if the case really is mechanical` });
    }
  });
export type Fixture = z.infer<typeof Fixture>;

// ---- loading ------------------------------------------------------------------

/** A validation failure with the file and the row that caused it. The CLI prints these; nothing throws a bare zod error. */
export interface FixtureIssue {
  source: string;
  index: number;
  id?: string | undefined;
  message: string;
}

export class FixtureError extends Error {
  constructor(readonly issues: readonly FixtureIssue[]) {
    super(`${issues.length} invalid fixture(s): ${issues.map((i) => `${i.source}#${i.index}${i.id ? ` (${i.id})` : ""}: ${i.message}`).join(" | ")}`);
    this.name = "FixtureError";
  }
}

export interface LoadResult {
  fixtures: Fixture[];
  issues: FixtureIssue[];
}

/**
 * Two container formats, because PoC-15 and PoC-16 already wrote both and the
 * bake-off reuses their shape rather than inventing a third (§3.2):
 *
 *   .jsonl  one fixture per line, blank lines ignored — the run-record format
 *           read back as input.
 *   .json   `{ "fixtures": [ … ] }` (PoC-15's `fixtures.json`) or a bare array.
 *           Keys beginning `_` at the top level are notes, and are ignored.
 */
export function parseFixtureRows(text: string, source: string): { rows: unknown[]; issues: FixtureIssue[] } {
  const trimmed = text.trim();
  const issues: FixtureIssue[] = [];
  if (trimmed === "") return { rows: [], issues };
  const looksJsonl = source.endsWith(".jsonl") || source.endsWith(".ndjson");
  if (looksJsonl) {
    const rows: unknown[] = [];
    const lines = trimmed.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.trim();
      if (line === "") continue;
      try {
        rows.push(JSON.parse(line));
      } catch (err) {
        issues.push({ source, index: i, message: `line ${i + 1} is not JSON: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
    return { rows, issues };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    return { rows: [], issues: [{ source, index: 0, message: `not JSON: ${err instanceof Error ? err.message : String(err)}` }] };
  }
  if (Array.isArray(parsed)) return { rows: parsed, issues };
  if (parsed !== null && typeof parsed === "object" && Array.isArray((parsed as { fixtures?: unknown }).fixtures)) {
    return { rows: (parsed as { fixtures: unknown[] }).fixtures, issues };
  }
  return { rows: [], issues: [{ source, index: 0, message: "expected a JSON array or an object with a `fixtures` array (the PoC-15 shape)" }] };
}

/** Validate already-parsed rows. Every row is reported; one bad fixture does not hide the next. */
export function validateFixtures(rows: readonly unknown[], source: string): LoadResult {
  const fixtures: Fixture[] = [];
  const issues: FixtureIssue[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const id = row !== null && typeof row === "object" ? (row as { id?: unknown }).id : undefined;
    const parsed = Fixture.safeParse(row);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        issues.push({ source, index: i, id: typeof id === "string" ? id : undefined, message: `${issue.path.join(".") || "(root)"}: ${issue.message}` });
      }
      continue;
    }
    if (seen.has(parsed.data.id)) {
      issues.push({ source, index: i, id: parsed.data.id, message: "duplicate id — ids are the join key between runs, transcripts and the report" });
      continue;
    }
    seen.add(parsed.data.id);
    fixtures.push(parsed.data);
  }
  return { fixtures, issues };
}

export function loadFixturesFromText(text: string, source: string): LoadResult {
  const { rows, issues } = parseFixtureRows(text, source);
  const validated = validateFixtures(rows, source);
  return { fixtures: validated.fixtures, issues: [...issues, ...validated.issues] };
}

/** Count per axis, for the validator's one-line summary. */
export function axisCounts(fixtures: readonly Fixture[]): Record<Axis, number> {
  const counts = Object.fromEntries(AXES.map((a) => [a, 0])) as Record<Axis, number>;
  for (const f of fixtures) counts[f.axis] += 1;
  return counts;
}

/** The composed turn: brief, then thread, then the prompt. One layout, so two runs of the same fixture are the same bytes. */
export function composePrompt(f: Fixture): string {
  const parts: string[] = [];
  if (f.context?.brief) parts.push(`# Today's brief\n\n${f.context.brief.trim()}`);
  if (f.context?.thread) parts.push(`# The thread so far\n\n${f.context.thread.trim()}`);
  parts.push(f.prompt.trim());
  return parts.join("\n\n---\n\n");
}
