// The confirmatory eval (T9-3; docs/ops/dynamic-router.md §7.2).
//
// PoC-15's disposition was that the router's amendment "proceeds only if a
// confirmatory eval passes: … fixtures authored independently of the rubric,
// ≥50 deep items", and PoC-16 named the candidate. This file is that eval,
// run on the planner AS IT WILL SERVE:
//
//   * **The scorer is the served call, not a harness around it.** Every item
//     goes through core's `scoreRouteFeatures` — the function the console's
//     policy calls — with the instance's own `compute.yaml`, so the guard, the
//     prompt builder (`complexityMessages`), the model `assignments.intent`
//     names, the provider's `request:` block and the server wire are the
//     served ones byte for byte. PoC-15's Haiku numbers were discounted for
//     exactly the harness this avoids.
//   * **The bar is pre-registered, in code, and quoted before any result.**
//     `COMPLEXITY_BAR` is §7.2's table. The report prints it first and prints
//     its sha256, and the planner's wording's, so a number or a description
//     changed after a run is visible on the page that run produced.
//   * **The fixtures are the OWNER'S.** C11 forbids a Claude-authored label,
//     so the example file this package ships is empty, as
//     `intents.example.jsonl` is, and the fixture set is itself checked
//     against §7.2 (≥ 50 per class, the traps, length not predicting the
//     label, the D08-class items) before its result may be called a pass.
//   * **The threshold is an output.** `--fit` sweeps
//     `complexity.min_confidence`, counting an item below it as served on the
//     default tier, and prints the value that meets the accuracy and
//     deep-miss rows together.
//   * **Cost is reported, never gated** (PoC-15 found its own cost criterion
//     ill-posed), at the owner's real message mix from the shadow window.

import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  COMPLEXITY,
  COMPLEXITY_NAMES,
  DEFAULT_TIER,
  POLICY_TIMEOUT_DEFAULT_MS,
  complexityMessages,
  costOf,
  isComplexity,
  parseTiers,
  resolveAssignment,
  scoreRouteFeatures,
  scorerTimeoutMs,
  validateRoutePolicy,
  type Complexity,
  type Compute,
  type ModelAccess,
  type RoutePolicyConfig,
  type TierMap,
} from "@foldedspacelabs/metistry-core";
import { percentile } from "./intents.js";

// ---- the fixtures ----------------------------------------------------------------

export const COMPLEXITY_TRAPS = ["none", "long_simple", "short_demanding"] as const;
export type ComplexityTrap = (typeof COMPLEXITY_TRAPS)[number];

/** §7.2: a long-simple trap is a `simple` item of more than 40 words. */
export const LONG_SIMPLE_MIN_WORDS = 41; // limit: fixed — §7.2's "> 40 words"
/** §7.2: a short-demanding trap is a `demanding` item of 8 words or fewer. */
export const SHORT_DEMANDING_MAX_WORDS = 8; // limit: fixed — §7.2's "≤ 8 words"

/** Words as a person counts them — whitespace runs, the same count `route_report` takes. */
export function wordCount(text: string): number {
  const t = text.trim();
  return t === "" ? 0 : t.split(/\s+/).length;
}

/**
 * One labelled message. `<instance>/.metistry/eval/complexity.jsonl`, one per
 * line. The fields are §7.2's, plus two the spec needs and does not name:
 *
 *   * `d08` — §7.2 requires at least five D08-class items ("terse,
 *     operational replanning under several constraints"), each labelled by the
 *     owner before it is scored. Counting them needs a mark; this is it.
 *   * `notes` — why the item exists, as the intent fixtures have. Never sent
 *     to a model.
 */
export const ComplexityFixture = z
  .strictObject({
    /** the message, exactly as it was written */
    text: z.string().min(1),
    /** the owner's class, from the class NAMES alone — labelled before reading the descriptions (§7.2) */
    label: z.enum(COMPLEXITY_NAMES),
    /** the other classes an ambiguous item may take (PoC-15's `accept` list) */
    accept: z.array(z.enum(COMPLEXITY_NAMES)).optional(),
    trap: z.enum(COMPLEXITY_TRAPS).optional(),
    /** a D08-class item: terse, operational replanning under several constraints */
    d08: z.boolean().optional(),
    id: z.string().min(1).optional(),
    notes: z.string().optional(),
  })
  .superRefine((f, ctx) => {
    const words = wordCount(f.text);
    // A trap marked on the wrong item would count toward a requirement it
    // does not meet, so the mark is checked against what it claims.
    if (f.trap === "long_simple" && (f.label !== "simple" || words < LONG_SIMPLE_MIN_WORDS)) {
      ctx.addIssue({ code: "custom", path: ["trap"], message: `long_simple marks a simple item of more than ${LONG_SIMPLE_MIN_WORDS - 1} words; this one is ${f.label}, ${words} words` });
    }
    if (f.trap === "short_demanding" && (f.label !== "demanding" || words > SHORT_DEMANDING_MAX_WORDS)) {
      ctx.addIssue({ code: "custom", path: ["trap"], message: `short_demanding marks a demanding item of ${SHORT_DEMANDING_MAX_WORDS} words or fewer; this one is ${f.label}, ${words} words` });
    }
    if (f.d08 === true && f.label !== "demanding") {
      ctx.addIssue({ code: "custom", path: ["d08"], message: `a D08-class item is a demanding one; this one is labelled ${f.label}` });
    }
  });
export type ComplexityFixture = z.infer<typeof ComplexityFixture>;

export interface ComplexityFixtureIssue {
  source: string;
  line: number;
  message: string;
}

/** One JSON object per line; blank lines and `#` comment lines ignored, because the owner writes this by hand. */
export function loadComplexityFixtures(text: string, source: string): { fixtures: ComplexityFixture[]; issues: ComplexityFixtureIssue[] } {
  const fixtures: ComplexityFixture[] = [];
  const issues: ComplexityFixtureIssue[] = [];
  const ids = new Set<string>();
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
    const parsed = ComplexityFixture.safeParse(raw);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) issues.push({ source, line: i + 1, message: `${issue.path.join(".") || "(root)"}: ${issue.message}` });
      continue;
    }
    if (parsed.data.id !== undefined) {
      if (ids.has(parsed.data.id)) {
        issues.push({ source, line: i + 1, message: `duplicate id: ${parsed.data.id}` });
        continue;
      }
      ids.add(parsed.data.id);
    }
    fixtures.push(parsed.data);
  }
  return { fixtures, issues };
}

// ---- the scorer: the served call ---------------------------------------------------

/** What the planner said about one message, as the router would have read it. No text. */
export interface PlannerAnswer {
  /** `guarded`: the deterministic guard refused it before any call, exactly as it would at the router */
  outcome: "scored" | "guarded" | "unavailable";
  class?: Complexity;
  confidence?: number;
  latency_ms?: number;
  reason?: string;
}

/** The seam: the CLI fills it with the served call, the tests with recorded responses. */
export type ComplexityScorer = (text: string) => Promise<PlannerAnswer>;

/**
 * Each eval call's own deadline. NOT the served one: a call that runs past
 * the served deadline is an absent feature at the router, and here it has to
 * be MEASURED instead, so the latency row can say by how much. 20 s is
 * `scoreChoiceOver`'s own ceiling — past it the server is hung, not slow.
 */
export const EVAL_CALL_TIMEOUT_MS = 20_000; // limit: fixed — matches choice.ts's CHOICE_TIMEOUT_MS

export interface ServedScorerOptions {
  /** the instance's `compute.yaml` in force and where its credentials resolve — the planner is `assignments.intent` */
  access: ModelAccess;
  timeoutMs?: number;
  now?: Date;
  /** replay: the recorded call's latency, since a replayed response takes no time */
  latencyOf?: () => number | undefined;
}

/**
 * The planner exactly as the router's policy consults it: core's
 * `scoreRouteFeatures`, asked for `complexity` alone with a threshold of 0 so
 * every answer comes back with its class and confidence (the threshold is
 * applied afterwards, by the sweep). THROWS for the money rule — an
 * off-machine provider behind `assignments.intent` — which is the one thing
 * an eval must never degrade around: no item is scored on a paid provider.
 */
export function servedScorer(opts: ServedScorerOptions): ComplexityScorer {
  return async (text) => {
    const features = await scoreRouteFeatures(opts.access, text, {
      reads: { intent: false, complexity: true },
      complexityMinConfidence: 0,
      timeoutMs: opts.timeoutMs ?? EVAL_CALL_TIMEOUT_MS,
      ...(opts.now ? { now: opts.now } : {}),
    });
    const c = features.complexity;
    if (!c) return { outcome: "unavailable", reason: "no_answer" };
    if (c.outcome === "guarded") return { outcome: "guarded", ...(c.reason ? { reason: c.reason } : {}) };
    if (c.outcome === "unavailable" || !isComplexity(c.class)) return { outcome: "unavailable", reason: c.reason ?? "no_answer" };
    const replayed = opts.latencyOf?.();
    return { outcome: "scored", class: c.class, confidence: c.confidence ?? 0, latency_ms: replayed ?? c.latency_ms ?? 0 };
  };
}

// ---- recorded responses ------------------------------------------------------------

/**
 * One server response, as `--record` writes it and `--replay` reads it. Keyed
 * by the user message the served prompt builder produced, so a replay answers
 * exactly the request the served path makes, in the order it made them.
 */
export const RecordedResponse = z.strictObject({
  content: z.string(),
  status: z.number().int(),
  body: z.unknown(),
  latency_ms: z.number().nonnegative(),
});
export type RecordedResponse = z.infer<typeof RecordedResponse>;

function userContent(init: { body?: unknown } | undefined): string {
  try {
    const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: Array<{ role?: string; content?: unknown }> };
    const user = [...(body.messages ?? [])].reverse().find((m) => m.role === "user");
    return typeof user?.content === "string" ? user.content : "";
  } catch {
    return "";
  }
}

/** Wrap a fetch so every scored call is written down as it happens. */
export function recordingFetch(inner: typeof fetch, sink: (call: RecordedResponse) => void): typeof fetch {
  return (async (input: string, init: { body?: unknown }) => {
    const started = Date.now();
    const res = await inner(input, init as RequestInit);
    const latency_ms = Date.now() - started;
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // an error body stays a string
    }
    sink({ content: userContent(init), status: res.status, body, latency_ms });
    return new Response(text, { status: res.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

export interface Replay {
  fetchFn: typeof fetch;
  /** the latency the last answered call was recorded with */
  lastLatency: () => number | undefined;
  /** recorded calls nothing asked for — a replay that did not use its whole recording is a different run */
  unused: () => number;
}

/** Answer from a recording and never from the network. A request the recording has no answer for is a server that did not answer. */
export function replayFetch(calls: readonly RecordedResponse[]): Replay {
  const queues = new Map<string, RecordedResponse[]>();
  for (const c of calls) (queues.get(c.content) ?? queues.set(c.content, []).get(c.content)!).push(c);
  let last: number | undefined;
  const fetchFn = (async (_input: string, init: { body?: unknown }) => {
    const next = queues.get(userContent(init))?.shift();
    if (!next) {
      last = undefined;
      throw new Error("no recorded response for this request (replay)");
    }
    last = next.latency_ms;
    return new Response(typeof next.body === "string" ? next.body : JSON.stringify(next.body), { status: next.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetchFn, lastLatency: () => last, unused: () => [...queues.values()].reduce((s, q) => s + q.length, 0) };
}

export function parseRecording(text: string, source: string): RecordedResponse[] {
  const out: RecordedResponse[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line === "") continue;
    const parsed = RecordedResponse.safeParse(JSON.parse(line));
    if (!parsed.success) throw new Error(`${source}:${i + 1}: not a recorded call (${parsed.error.issues.map((x) => x.message).join("; ")})`);
    out.push(parsed.data);
  }
  return out;
}

// ---- the run: two passes, for determinism --------------------------------------------

export interface ComplexityRow {
  fixture: ComplexityFixture;
  words: number;
  /** the first temperature-0 run, which every row of the bar but determinism reads */
  answer: PlannerAnswer;
  /** the second, compared with the first */
  repeat: PlannerAnswer;
}

export interface ComplexityRunResult {
  rows: ComplexityRow[];
  /** the discarded first call, kept out of the percentiles */
  cold_start_ms: number | null;
}

export interface RunComplexityEvalOptions {
  fixtures: readonly ComplexityFixture[];
  score: ComplexityScorer;
  /** one throwaway call before the clock starts — the bar is about a WARM server */
  warmUp?: boolean;
  onAnswer?: (fixture: ComplexityFixture, answer: PlannerAnswer, pass: 1 | 2) => void;
}

/**
 * Every item, twice: the whole set once, then the whole set again — two
 * temperature-0 RUNS, as PoC-16 measured determinism, rather than the same
 * item asked twice back to back, which a server's prefix cache could make
 * trivially identical.
 */
export async function runComplexityEval(opts: RunComplexityEvalOptions): Promise<ComplexityRunResult> {
  let cold: number | null = null;
  if (opts.warmUp !== false && opts.fixtures.length > 0) cold = (await opts.score(opts.fixtures[0]!.text)).latency_ms ?? null;
  const first: PlannerAnswer[] = [];
  for (const f of opts.fixtures) {
    const a = await opts.score(f.text);
    first.push(a);
    opts.onAnswer?.(f, a, 1);
  }
  const rows: ComplexityRow[] = [];
  for (let i = 0; i < opts.fixtures.length; i++) {
    const f = opts.fixtures[i]!;
    const a = await opts.score(f.text);
    opts.onAnswer?.(f, a, 2);
    rows.push({ fixture: f, words: wordCount(f.text), answer: first[i]!, repeat: a });
  }
  return { rows, cold_start_ms: cold };
}

// ---- the bar, pre-registered ---------------------------------------------------------

/**
 * §7.2's table, in code, so a result cannot be read to taste. A number changed
 * after a run voids the run — the report prints this object's sha256 so the
 * change is visible. The latency row's bar is the owner's own
 * `policy.timeout_ms`, so it is an input, not a constant.
 */
export const COMPLEXITY_BAR = {
  /** accept-aware, over every item */
  accuracy: 0.85,
  /** `demanding` items served below `demanding`, as a share of `demanding` items */
  deep_miss: 0.1,
  /** long-simple traps served `simple` */
  long_simple: 0.83,
  /** short-demanding traps served `demanding` */
  short_demanding: 0.83,
  /** identical across two temperature-0 runs */
  determinism: 1,
  /** items the warm server could not score */
  unscored: 0,
} as const;

/** §7.2's requirements on the fixture set itself. A run on a set that misses one is not a qualifying run, whatever it scores. */
export const FIXTURE_SET_BAR = {
  min_per_class: 50,
  /** of `simple` items that are long traps, and of `demanding` items that are short ones */
  trap_share: 0.1,
  /** |Pearson r| between word count and the label's order */
  max_abs_length_r: 0.2,
  min_d08: 5,
} as const;

/** The pre-registered table as §7.2 states it — printed before any result. */
export const BAR_TABLE: ReadonlyArray<{ row: string; bar: string; from: string }> = [
  { row: "accuracy (accept-aware)", bar: "≥ 85%", from: "PoC-16 pre-registered" },
  { row: "deep-miss — `demanding` items classed below `demanding`", bar: "≤ 10% of `demanding` items", from: "PoC-15's miss threshold; PoC-16's ≤ 1/16 is the same line at n = 16" },
  { row: "long-simple traps classed `simple`", bar: "≥ 83%", from: "PoC-16's ≥ 5/6" },
  { row: "short-demanding traps classed `demanding`", bar: "≥ 83%", from: "PoC-16's ≥ 5/6" },
  { row: "determinism", bar: "100% identical across two temperature-0 runs", from: "PoC-16" },
  { row: "unscored items (`unavailable`) on a warm server", bar: "0", from: "PoC-16's parse-fail = 0" },
  { row: "warm latency", bar: "p95 ≤ the `policy.timeout_ms` the owner will serve with", from: "the runtime deadline; PoC-16's ceiling was 3000 ms" },
];

/**
 * The class an item BELOW the threshold is served as. Below
 * `complexity.min_confidence` the feature is absent and the request takes the
 * rules' default tier (§2), and the default tier is `moderate`'s: the classes
 * are PoC-15's cheap · standard · deep, and standard is today's default.
 */
export const DEFAULT_CLASS: Complexity = "moderate";

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/** The planner's wording, as a fingerprint: the served system prompt at a fixed clock. A description tuned after a run changes it. */
export function wordingSha256(): string {
  const [system] = complexityMessages("", { now: new Date(0) });
  return sha256(JSON.stringify({ classes: COMPLEXITY, system: system!.content }));
}

export function barSha256(): string {
  return sha256(JSON.stringify({ COMPLEXITY_BAR, FIXTURE_SET_BAR, DEFAULT_CLASS, LONG_SIMPLE_MIN_WORDS, SHORT_DEMANDING_MAX_WORDS }));
}

// ---- reading a row at a threshold -------------------------------------------------------

/** The class the router would have acted on at threshold θ: the planner's, at or over it; the default tier's, otherwise. */
export function servedClass(a: PlannerAnswer, threshold: number): Complexity {
  return a.outcome === "scored" && isComplexity(a.class) && (a.confidence ?? 0) >= threshold ? a.class : DEFAULT_CLASS;
}

export function isCorrect(f: ComplexityFixture, cls: Complexity): boolean {
  return cls === f.label || (f.accept ?? []).includes(cls);
}

const share = (n: number, d: number): number | null => (d === 0 ? null : n / d);

function sameAnswer(a: PlannerAnswer, b: PlannerAnswer): boolean {
  return a.outcome === b.outcome && a.class === b.class && (a.confidence ?? null) === (b.confidence ?? null);
}

/** Pearson r, or null where either side has no variance (the statistic does not exist, which is not 0). */
export function pearson(xs: readonly number[], ys: readonly number[]): number | null {
  const n = xs.length;
  if (n < 2 || ys.length !== n) return null;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

const ORDINAL: Record<Complexity, number> = Object.fromEntries(COMPLEXITY_NAMES.map((c, i) => [c, i])) as Record<Complexity, number>;

// ---- the fixture set -----------------------------------------------------------------

export interface Requirement {
  requirement: string;
  needed: string;
  have: string;
  pass: boolean;
}

export interface FixtureSetSummary {
  n: number;
  by_class: Record<Complexity, number>;
  long_simple: number;
  short_demanding: number;
  d08: number;
  length_r: number | null;
  requirements: Requirement[];
  qualifies: boolean;
}

export function checkFixtureSet(fixtures: readonly ComplexityFixture[]): FixtureSetSummary {
  const by_class = Object.fromEntries(COMPLEXITY_NAMES.map((c) => [c, fixtures.filter((f) => f.label === c).length])) as Record<Complexity, number>;
  const long_simple = fixtures.filter((f) => f.trap === "long_simple").length;
  const short_demanding = fixtures.filter((f) => f.trap === "short_demanding").length;
  const d08 = fixtures.filter((f) => f.d08 === true).length;
  const length_r = pearson(
    fixtures.map((f) => wordCount(f.text)),
    fixtures.map((f) => ORDINAL[f.label]),
  );
  const b = FIXTURE_SET_BAR;
  const pct = (v: number | null): string => (v === null ? "—" : `${(v * 100).toFixed(1)}%`);
  const req: Requirement[] = [
    { requirement: "`demanding` items", needed: `≥ ${b.min_per_class}`, have: String(by_class.demanding), pass: by_class.demanding >= b.min_per_class },
    { requirement: "`moderate` items", needed: `≥ ${b.min_per_class}`, have: String(by_class.moderate), pass: by_class.moderate >= b.min_per_class },
    { requirement: "`simple` items", needed: `≥ ${b.min_per_class}`, have: String(by_class.simple), pass: by_class.simple >= b.min_per_class },
    {
      requirement: `long-simple traps (> ${LONG_SIMPLE_MIN_WORDS - 1} words), of \`simple\` items`,
      needed: `≥ ${b.trap_share * 100}%`,
      have: `${long_simple} (${pct(share(long_simple, by_class.simple))})`,
      pass: by_class.simple > 0 && long_simple / by_class.simple >= b.trap_share,
    },
    {
      requirement: `short-demanding traps (≤ ${SHORT_DEMANDING_MAX_WORDS} words), of \`demanding\` items`,
      needed: `≥ ${b.trap_share * 100}%`,
      have: `${short_demanding} (${pct(share(short_demanding, by_class.demanding))})`,
      pass: by_class.demanding > 0 && short_demanding / by_class.demanding >= b.trap_share,
    },
    {
      requirement: "length does not predict the label — |r(words, class)|",
      needed: `< ${b.max_abs_length_r}`,
      have: length_r === null ? "— (no variance)" : Math.abs(length_r).toFixed(3),
      pass: length_r !== null && Math.abs(length_r) < b.max_abs_length_r,
    },
    { requirement: "D08-class `demanding` items (`d08: true`)", needed: `≥ ${b.min_d08}`, have: String(d08), pass: d08 >= b.min_d08 },
  ];
  return { n: fixtures.length, by_class, long_simple, short_demanding, d08, length_r, requirements: req, qualifies: req.every((r) => r.pass) };
}

// ---- the metrics at one threshold ------------------------------------------------------

export interface AtThreshold {
  threshold: number;
  accuracy: number | null;
  deep_miss: number | null;
  long_simple: number | null;
  short_demanding: number | null;
  /** share of items the planner's class is acted on (at or over the threshold) */
  coverage: number | null;
}

export function measureAt(rows: readonly ComplexityRow[], threshold: number): AtThreshold {
  const served = rows.map((r) => ({ r, cls: servedClass(r.answer, threshold) }));
  const demanding = served.filter((x) => x.r.fixture.label === "demanding");
  const ls = served.filter((x) => x.r.fixture.trap === "long_simple");
  const sd = served.filter((x) => x.r.fixture.trap === "short_demanding");
  const acting = rows.filter((r) => r.answer.outcome === "scored" && (r.answer.confidence ?? 0) >= threshold).length;
  return {
    threshold,
    accuracy: share(served.filter((x) => isCorrect(x.r.fixture, x.cls)).length, served.length),
    // literal: "classed below demanding", not accept-aware — an ambiguous deep
    // item served on the default tier is still one the owner said was deep
    deep_miss: share(demanding.filter((x) => x.cls !== "demanding").length, demanding.length),
    long_simple: share(ls.filter((x) => x.cls === "simple").length, ls.length),
    short_demanding: share(sd.filter((x) => x.cls === "demanding").length, sd.length),
    coverage: share(acting, rows.length),
  };
}

// ---- the fit ---------------------------------------------------------------------------

export interface ComplexityFit {
  sweep: AtThreshold[];
  fitted: AtThreshold | null;
  why: string;
}

const meetsFit = (p: AtThreshold): boolean => p.accuracy !== null && p.deep_miss !== null && p.accuracy >= COMPLEXITY_BAR.accuracy && p.deep_miss <= COMPLEXITY_BAR.deep_miss;

/**
 * Sweep `complexity.min_confidence` over every confidence the planner gave
 * (and 0), counting an item below it as served on the default tier, and pick
 * the threshold that meets the accuracy and deep-miss rows together (§7.2).
 *
 * Among those, the LOWEST — the one under which the planner acts on the most
 * messages, which is "maximise how much the policy decides, subject to the
 * bar", the rule the intent fit uses. Raising the threshold only moves items
 * onto the default tier, so everything above the fitted value is the policy
 * switched further off, never a better policy.
 */
export function fitComplexityThreshold(rows: readonly ComplexityRow[]): ComplexityFit {
  const confidences = rows.filter((r) => r.answer.outcome === "scored").map((r) => Number((r.answer.confidence ?? 0).toFixed(4)));
  const candidates = [...new Set([0, ...confidences])].sort((a, b) => a - b);
  const sweep = candidates.map((t) => measureAt(rows, t));
  const fitted = sweep.find(meetsFit) ?? null;
  const pct = (v: number | null): string => (v === null ? "—" : `${(v * 100).toFixed(1)}%`);
  if (!fitted) {
    return {
      sweep,
      fitted: null,
      why: `no threshold on these ${rows.length} item(s) meets accuracy ≥ ${pct(COMPLEXITY_BAR.accuracy)} and deep-miss ≤ ${pct(COMPLEXITY_BAR.deep_miss)} together — the sweep is in --json, so the shortfall is visible rather than rounded away`,
    };
  }
  return {
    sweep,
    fitted,
    why: `${sweep.filter(meetsFit).length} threshold(s) meet accuracy and deep-miss together; ${fitted.threshold.toFixed(2)} is the lowest (the planner decides ${pct(fitted.coverage)} of items at ${pct(fitted.accuracy)} accuracy, ${pct(fitted.deep_miss)} deep-miss)`,
  };
}

// ---- cost: reported, not gated -------------------------------------------------------------

/** One labelled count of `metistry compute route-report --json` — the fields this reads, and nothing else. */
const Share = z.object({ label: z.string(), n: z.number(), share: z.number().nullable().optional(), denominator: z.number().optional() }).loose();

export const RouteReportJson = z
  .object({
    since_days: z.number(),
    totals: z.object({ messages: z.number(), routed: z.number(), fall_through: z.number(), first_message: z.string().optional(), last_message: z.string().optional() }).loose(),
    tiers: z.array(Share),
    policy: z
      .object({
        recorded: z.boolean(),
        rows: z.number(),
        consultations: z.number(),
        outcomes: z.array(Share),
        table_rows: z.array(Share),
        operations: z.array(Share),
        tiers: z.array(Share),
        override: z.array(Share),
        latency: z.object({ p50_ms: z.number().nullable(), p95_ms: z.number().nullable(), over: z.number() }).loose(),
        shadow: z.array(z.object({ tier: z.string(), turns: z.number(), mean_agreement: z.number().nullable() }).loose()),
        thin: z.boolean(),
      })
      .loose(),
  })
  .loose();
export type RouteReportJson = z.infer<typeof RouteReportJson>;

/** `metistry compute cache-report --json` — per (provider, model, tier), what the calls cost. */
export const CacheReportJson = z
  .object({
    since_days: z.number(),
    groups: z.array(z.object({ provider: z.string(), model: z.string(), tier: z.string(), turns: z.number(), tokens_in: z.number(), tokens_out: z.number(), cost_usd: z.number(), turns_unpriced: z.number().optional() }).loose()),
  })
  .loose();
export type CacheReportJson = z.infer<typeof CacheReportJson>;

/** §7.2: below this many observed turns a tier's own mean is noise, and it is priced at the default tier's tokens instead. */
export const MIN_OBSERVED_TURNS = 20; // limit: fixed — §7.2's "fewer than 20 served turns"

export interface TierCost {
  tier: string;
  /** observed calls on this tier in the cache report's window */
  turns: number;
  per_turn_usd: number | null;
  basis: "observed" | "default_tokens_at_rate" | "fast_path" | "unpriced";
  note?: string;
}

/** A tier's per-turn cost: its observed mean, or — thin — the default tier's mean tokens at its own `pricing:` rate, said out loud. */
export function tierCost(tier: string, cache: CacheReportJson, compute: Compute | undefined): TierCost {
  if (tier === "fast_path") return { tier, turns: 0, per_turn_usd: 0, basis: "fast_path", note: "answered by a named query — no model" };
  const groups = cache.groups.filter((g) => g.tier === tier);
  const turns = groups.reduce((s, g) => s + g.turns, 0);
  const unpriced = groups.reduce((s, g) => s + (g.turns_unpriced ?? 0), 0);
  if (turns >= MIN_OBSERVED_TURNS) {
    return {
      tier,
      turns,
      per_turn_usd: groups.reduce((s, g) => s + g.cost_usd, 0) / turns,
      basis: "observed",
      ...(unpriced > 0 ? { note: `${unpriced} of ${turns} calls had no price and count as $0` } : {}),
    };
  }
  const def = cache.groups.filter((g) => g.tier === DEFAULT_TIER);
  const defTurns = def.reduce((s, g) => s + g.turns, 0);
  if (defTurns === 0) return { tier, turns, per_turn_usd: null, basis: "unpriced", note: `${turns} observed call(s), and no default-tier calls to borrow a token count from` };
  const a = compute ? resolveAssignment(compute, tier) : undefined;
  if (!a) return { tier, turns, per_turn_usd: null, basis: "unpriced", note: `${turns} observed call(s), and compute.yaml assigns no model to price it by` };
  const usage = { tokens_in: def.reduce((s, g) => s + g.tokens_in, 0) / defTurns, tokens_out: def.reduce((s, g) => s + g.tokens_out, 0) / defTurns };
  const priced = costOf(usage, a.config, a.model);
  if (priced.source === "unknown") {
    return { tier, turns, per_turn_usd: null, basis: "unpriced", note: `${turns} observed call(s), and no providers.${a.provider}.pricing["${a.model}"] to price the default tier's tokens at` };
  }
  return {
    tier,
    turns,
    per_turn_usd: priced.cost_usd,
    basis: "default_tokens_at_rate",
    note: `${turns} observed call(s) (< ${MIN_OBSERVED_TURNS}): priced at the default tier's mean ${Math.round(usage.tokens_in)} in / ${Math.round(usage.tokens_out)} out tokens and ${a.provider}/${a.model}'s ${priced.source === "local" ? "on-machine $0" : "pricing: rate"}`,
  };
}

export interface CostLine {
  name: string;
  per_1000_usd: number | null;
  mix: Record<string, number>;
  note?: string;
}

export interface CostReport {
  window_days: number;
  /** model turns in the window: the population every $/1000 is over */
  turns: number;
  tiers: TierCost[];
  lines: CostLine[];
  /** turns the policy would have moved off `default` to a higher tier, per 1000 */
  upgrades_per_1000: number;
  /** share of the planner's `demanding` calls (at the threshold) the owner also labelled `demanding` — the eval's half of "rescued" */
  upgrade_precision: number | null;
  rescued_per_1000: number | null;
  cost_per_rescued_usd: number | null;
  notes: string[];
}

const ARROW = " → ";

function priceMix(name: string, mix: Record<string, number>, costs: Map<string, TierCost>, turns: number): CostLine {
  let total = 0;
  const unpriced: string[] = [];
  for (const [tier, n] of Object.entries(mix)) {
    if (n <= 0) continue;
    const c = costs.get(tier)?.per_turn_usd;
    if (c === null || c === undefined) unpriced.push(tier);
    else total += n * c;
  }
  if (unpriced.length > 0) return { name, per_1000_usd: null, mix, note: `unpriced: ${unpriced.join(", ")}` };
  return { name, per_1000_usd: turns === 0 ? null : (total / turns) * 1000, mix };
}

/**
 * $/1000 turns for today's router, for the policy, and for always the top of
 * `policy.tiers`, at the real mix of the shadow window — and the cost per
 * rescued turn (§7.2).
 *
 *   today   the tiers `route-report` says were served
 *   policy  today's, with every `served → chosen` shadow decision applied
 *           (a `fast_path` choice costs no model call)
 *   top     every model turn on the last of `policy.tiers` (cheapest first)
 *
 * A rescued turn is a `demanding` message today serves on `default` that the
 * policy serves higher. The shadow window counts the upgrades off `default`;
 * the eval says what share of the planner's `demanding` calls were demanding
 * by the owner's own label. Their product is the rescued turns, and the
 * policy's extra spend over them is the price of one.
 */
export function buildCostReport(input: {
  routeReport: RouteReportJson;
  cacheReport: CacheReportJson;
  compute?: Compute | undefined;
  policyTiers?: readonly string[] | undefined;
  rows: readonly ComplexityRow[];
  threshold: number;
}): CostReport {
  const notes: string[] = [];
  const today: Record<string, number> = {};
  for (const t of input.routeReport.tiers) today[t.label] = (today[t.label] ?? 0) + t.n;
  const turns = Object.values(today).reduce((s, n) => s + n, 0);

  const policy: Record<string, number> = { ...today };
  let upgrades = 0;
  const order = input.policyTiers ?? [];
  for (const r of input.routeReport.policy.tiers) {
    const [from, to] = r.label.split(ARROW) as [string, string | undefined];
    if (to === undefined || from === to) continue;
    policy[from] = (policy[from] ?? 0) - r.n;
    policy[to] = (policy[to] ?? 0) + r.n;
    if (from === DEFAULT_TIER && order.indexOf(to) > order.indexOf(DEFAULT_TIER) && order.indexOf(DEFAULT_TIER) >= 0) upgrades += r.n;
  }

  const top = order.length > 0 ? order[order.length - 1]! : undefined;
  const allTiers = new Set([...Object.keys(today), ...Object.keys(policy), ...(top ? [top] : [])]);
  const costs = new Map<string, TierCost>();
  for (const t of allTiers) costs.set(t, tierCost(t, input.cacheReport, input.compute));

  const lines: CostLine[] = [priceMix("today's router", today, costs, turns), priceMix("the policy", policy, costs, turns)];
  if (top) lines.push(priceMix(`always \`${top}\` (the top of policy.tiers)`, { [top]: turns }, costs, turns));
  else notes.push("no rules.yaml policy.tiers, so there is no top tier to price — pass --rules");

  const calledDemanding = input.rows.filter((r) => servedClass(r.answer, input.threshold) === "demanding");
  const precision = share(calledDemanding.filter((r) => r.fixture.label === "demanding").length, calledDemanding.length);
  const upgrades_per_1000 = turns === 0 ? 0 : (upgrades / turns) * 1000;
  const rescued = precision === null ? null : upgrades_per_1000 * precision;
  const t0 = lines[0]!.per_1000_usd;
  const p0 = lines[1]!.per_1000_usd;
  const cost_per_rescued_usd = rescued !== null && rescued > 0 && t0 !== null && p0 !== null ? (p0 - t0) / rescued : null;
  if (input.routeReport.since_days < 14) notes.push(`the window is ${input.routeReport.since_days} days; the bar's shadow is fourteen — run route-report and cache-report with --since 14d`);
  if (input.cacheReport.since_days !== input.routeReport.since_days) notes.push(`the cache report covers ${input.cacheReport.since_days} days and the route report ${input.routeReport.since_days}: the tier prices and the mix are from different windows`);
  notes.push("a tier's observed mean is every engine call carrying that tier in cache-report (turns, crew runs and shadow calls alike); budgets remain the cost control at run time");

  return { window_days: input.routeReport.since_days, turns, tiers: [...costs.values()], lines, upgrades_per_1000, upgrade_precision: precision, rescued_per_1000: rescued, cost_per_rescued_usd, notes };
}

// ---- the owner's rules.yaml, for what the eval needs from it -------------------------------------

export interface EvalRules {
  tiers?: TierMap;
  policy?: RoutePolicyConfig;
}

/**
 * The parts of `rules.yaml` the eval reads — `tiers:` and `policy:` —
 * validated by core's `validateRoutePolicy` exactly as the console's
 * `loadRules` validates them, so an eval never runs against a policy the
 * console would refuse.
 */
export function loadEvalRules(text: string): EvalRules {
  const doc = (parseYaml(text) ?? {}) as Record<string, unknown>;
  const out: EvalRules = {};
  if (doc.tiers !== undefined) out.tiers = parseTiers(doc.tiers);
  if (doc.policy !== undefined && doc.policy !== null) {
    const fast = Array.isArray(doc.fast_path) ? (doc.fast_path as Array<{ query?: unknown }>).map((r) => r?.query).filter((q): q is string => typeof q === "string") : [];
    const p = validateRoutePolicy(doc.policy, { tiers: Object.keys(out.tiers ?? {}), fastPathQueries: fast, intentRules: doc.intent !== undefined && doc.intent !== null });
    if (!p.ok) throw new Error(`invalid rules.yaml: ${p.errors.join("; ")}`);
    out.policy = p.policy;
  }
  return out;
}

// ---- the report --------------------------------------------------------------------------

export interface BarRow {
  key: keyof typeof COMPLEXITY_BAR | "latency";
  row: string;
  bar: string;
  result: string;
  pass: boolean;
}

export interface DeepMiss {
  id?: string;
  text: string;
  served: Complexity;
  predicted: Complexity | null;
  confidence: number | null;
  outcome: PlannerAnswer["outcome"];
}

export interface ComplexityReport {
  run: {
    at: string;
    model: string | null;
    replay: boolean;
    wording_sha256: string;
    bar_sha256: string;
    threshold: number;
    threshold_source: string;
    timeout_ms: number;
    timeout_source: string;
  };
  fixture_set: FixtureSetSummary;
  bar: BarRow[];
  verdict: { pass: boolean; line: string };
  deep_misses: DeepMiss[];
  /** gold → served class → n, at the threshold */
  confusion: Record<Complexity, Record<Complexity, number>>;
  guarded: number;
  unavailable: number;
  latency: { p50_ms: number; p95_ms: number; over_served_deadline: number; served_deadline_ms: number; cold_start_ms: number | null };
  fit: ComplexityFit | null;
  cost: CostReport | null;
  cost_absent?: string;
  shadow: RouteReportJson | null;
}

export interface BuildComplexityReportOptions {
  threshold: number;
  thresholdSource: string;
  timeoutMs: number;
  timeoutSource: string;
  fit?: ComplexityFit | null;
  cost?: CostReport | null;
  costAbsent?: string;
  shadow?: RouteReportJson | null;
  model?: string | null;
  replay?: boolean;
  at?: Date;
}

const pct = (v: number | null): string => (v === null ? "—" : `${(v * 100).toFixed(1)}%`);

export function buildComplexityReport(result: ComplexityRunResult, opts: BuildComplexityReportOptions): ComplexityReport {
  const rows = result.rows;
  const set = checkFixtureSet(rows.map((r) => r.fixture));
  const at = measureAt(rows, opts.threshold);
  const identical = rows.filter((r) => sameAnswer(r.answer, r.repeat)).length;
  const unavailable = rows.filter((r) => r.answer.outcome === "unavailable" || r.repeat.outcome === "unavailable").length;
  const guarded = rows.filter((r) => r.answer.outcome === "guarded").length;
  const latencies = rows.flatMap((r) => [r.answer, r.repeat]).filter((a) => a.outcome === "scored").map((a) => a.latency_ms ?? 0);
  const p95 = percentile(latencies, 0.95);
  const servedDeadline = scorerTimeoutMs(opts.timeoutMs);
  const B = COMPLEXITY_BAR;
  const ge = (v: number | null, bar: number): boolean => v !== null && v >= bar;

  const bar: BarRow[] = [
    { key: "accuracy", row: BAR_TABLE[0]!.row, bar: BAR_TABLE[0]!.bar, result: pct(at.accuracy), pass: ge(at.accuracy, B.accuracy) },
    { key: "deep_miss", row: BAR_TABLE[1]!.row, bar: BAR_TABLE[1]!.bar, result: pct(at.deep_miss), pass: at.deep_miss !== null && at.deep_miss <= B.deep_miss },
    { key: "long_simple", row: BAR_TABLE[2]!.row, bar: BAR_TABLE[2]!.bar, result: at.long_simple === null ? "— (no traps)" : pct(at.long_simple), pass: ge(at.long_simple, B.long_simple) },
    { key: "short_demanding", row: BAR_TABLE[3]!.row, bar: BAR_TABLE[3]!.bar, result: at.short_demanding === null ? "— (no traps)" : pct(at.short_demanding), pass: ge(at.short_demanding, B.short_demanding) },
    { key: "determinism", row: BAR_TABLE[4]!.row, bar: BAR_TABLE[4]!.bar, result: `${pct(share(identical, rows.length))} (${identical}/${rows.length})`, pass: rows.length > 0 && identical / rows.length >= B.determinism },
    { key: "unscored", row: BAR_TABLE[5]!.row, bar: BAR_TABLE[5]!.bar, result: String(unavailable), pass: unavailable <= B.unscored },
    {
      key: "latency",
      row: BAR_TABLE[6]!.row,
      bar: `p95 ≤ ${opts.timeoutMs} ms`,
      result: latencies.length === 0 ? "— (nothing scored)" : `p95 ${p95} ms`,
      pass: latencies.length > 0 && p95 <= opts.timeoutMs,
    },
  ];

  const failed = bar.filter((r) => !r.pass);
  const pass = set.qualifies && failed.length === 0;
  const line = pass
    ? `PASS — every row of the pre-registered bar holds on a qualifying fixture set, at complexity.min_confidence ${opts.threshold.toFixed(2)}.`
    : !set.qualifies
      ? `NOT A QUALIFYING RUN — the fixture set misses ${set.requirements.filter((r) => !r.pass).length} of §7.2's requirements, so no result on it can pass${failed.length > 0 ? `; ${failed.length} bar row(s) fail besides` : ""}.`
      : `FAIL — ${failed.length} row(s) of the pre-registered bar do not hold: ${failed.map((r) => r.key).join(", ")}.`;

  const confusion = Object.fromEntries(COMPLEXITY_NAMES.map((g) => [g, Object.fromEntries(COMPLEXITY_NAMES.map((s) => [s, 0]))])) as Record<Complexity, Record<Complexity, number>>;
  for (const r of rows) confusion[r.fixture.label][servedClass(r.answer, opts.threshold)] += 1;

  const deep_misses: DeepMiss[] = rows
    .filter((r) => r.fixture.label === "demanding" && servedClass(r.answer, opts.threshold) !== "demanding")
    .map((r) => ({
      ...(r.fixture.id !== undefined ? { id: r.fixture.id } : {}),
      text: r.fixture.text,
      served: servedClass(r.answer, opts.threshold),
      predicted: r.answer.outcome === "scored" && isComplexity(r.answer.class) ? r.answer.class : null,
      confidence: r.answer.outcome === "scored" ? (r.answer.confidence ?? null) : null,
      outcome: r.answer.outcome,
    }));

  return {
    run: {
      at: (opts.at ?? new Date()).toISOString(),
      model: opts.model ?? null,
      replay: opts.replay === true,
      wording_sha256: wordingSha256(),
      bar_sha256: barSha256(),
      threshold: opts.threshold,
      threshold_source: opts.thresholdSource,
      timeout_ms: opts.timeoutMs,
      timeout_source: opts.timeoutSource,
    },
    fixture_set: set,
    bar,
    verdict: { pass, line },
    deep_misses,
    confusion,
    guarded,
    unavailable,
    latency: {
      p50_ms: percentile(latencies, 0.5),
      p95_ms: p95,
      over_served_deadline: latencies.filter((l) => l > servedDeadline).length,
      served_deadline_ms: servedDeadline,
      cold_start_ms: result.cold_start_ms,
    },
    fit: opts.fit ?? null,
    cost: opts.cost ?? null,
    ...(opts.costAbsent ? { cost_absent: opts.costAbsent } : {}),
    shadow: opts.shadow ?? null,
  };
}

const usd = (v: number | null): string => (v === null ? "—" : `$${v.toFixed(v >= 100 ? 0 : v >= 1 ? 2 : 4)}`);
const cell = (s: string): string => s.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");

/** One page the owner can read (§7.2): the bar first, then every result against it. */
export function renderComplexityReport(r: ComplexityReport): string {
  const out: string[] = [];
  out.push("# The confirmatory eval — the router's planner");
  out.push("");
  out.push(
    `${r.run.at} · planner ${r.run.model ?? "(unknown)"}${r.run.replay ? " · **replayed from a recording** — latency is the recorded one" : ""} · ${r.fixture_set.n} owner-labelled item(s), each scored twice`,
  );
  out.push(`Planner wording sha256 \`${r.run.wording_sha256.slice(0, 16)}\` · bar sha256 \`${r.run.bar_sha256.slice(0, 16)}\` — a change to either after this run voids it.`);
  out.push("");
  out.push("## The bar, pre-registered (docs/ops/dynamic-router.md §7.2)");
  out.push("");
  out.push("| | Bar | From |");
  out.push("| --- | --- | --- |");
  for (const b of BAR_TABLE) out.push(`| ${cell(b.row)} | ${cell(b.bar)} | ${cell(b.from)} |`);
  out.push("");
  out.push("## The fixture set (§7.2)");
  out.push("");
  out.push("| Requirement | Needed | Have | |");
  out.push("| --- | --- | --- | --- |");
  for (const q of r.fixture_set.requirements) out.push(`| ${cell(q.requirement)} | ${q.needed} | ${q.have} | ${q.pass ? "PASS" : "FAIL"} |`);
  out.push("");
  out.push(`## Result — at complexity.min_confidence ${r.run.threshold.toFixed(2)} (${r.run.threshold_source})`);
  out.push("");
  out.push("| | Bar | Result | |");
  out.push("| --- | --- | --- | --- |");
  for (const b of r.bar) out.push(`| ${b.row} | ${b.bar} | ${b.result} | ${b.pass ? "PASS" : "FAIL"} |`);
  out.push("");
  out.push(`**${r.verdict.line}**`);
  out.push("");
  const notes: string[] = [];
  if (r.guarded > 0) notes.push(`${r.guarded} item(s) never reached the model — the deterministic guard refused them, as it would at the router, so they count as served on the default tier.`);
  notes.push(
    `Latency: p50 ${r.latency.p50_ms} ms, p95 ${r.latency.p95_ms} ms, against policy.timeout_ms ${r.run.timeout_ms} (${r.run.timeout_source}). ` +
      `At serve each planner call gets ${r.latency.served_deadline_ms} ms of that; ${r.latency.over_served_deadline} call(s) here ran longer and would have been an absent feature.` +
      (r.latency.cold_start_ms !== null ? ` Cold start (the discarded first call): ${r.latency.cold_start_ms} ms.` : ""),
  );
  for (const n of notes) out.push(n);
  out.push("");
  out.push(`## Deep misses — every one, verbatim (${r.deep_misses.length})`);
  out.push("");
  if (r.deep_misses.length === 0) out.push("None: every `demanding` item was served `demanding`.");
  for (const m of r.deep_misses) {
    const why = m.outcome === "scored" ? `planner said ${m.predicted} at ${m.confidence?.toFixed(3)}` : `${m.outcome}`;
    out.push(`- ${m.id ? `\`${m.id}\` ` : ""}served **${m.served}** (${why}): "${cell(m.text)}"`);
  }
  out.push("");
  out.push("## Confusion matrix — your label ↓, served class →");
  out.push("");
  out.push(`| | ${COMPLEXITY_NAMES.join(" | ")} |`);
  out.push(`| --- | ${COMPLEXITY_NAMES.map(() => "---:").join(" | ")} |`);
  for (const g of COMPLEXITY_NAMES) out.push(`| **${g}** | ${COMPLEXITY_NAMES.map((s) => String(r.confusion[g][s])).join(" | ")} |`);
  out.push("");
  out.push(`Below the threshold an item is served on the default tier, counted as \`${DEFAULT_CLASS}\`.`);
  out.push("");
  out.push("## The fitted threshold");
  out.push("");
  if (!r.fit) out.push("Not fitted — run with `--fit` to sweep `complexity.min_confidence` (it is an output of this eval, never an input).");
  else {
    out.push(r.fit.why);
    if (r.fit.fitted) {
      out.push("");
      out.push("Paste into `.metistry/rules.yaml` (your file; this number is the whole decision):");
      out.push("");
      out.push("```yaml");
      out.push("policy:");
      out.push("  complexity:");
      out.push(`    min_confidence: ${r.fit.fitted.threshold.toFixed(2)}`);
      out.push("```");
    }
  }
  out.push("");
  out.push("## Cost — reported, not gated");
  out.push("");
  if (!r.cost) out.push(r.cost_absent ?? "Not computed.");
  else {
    const c = r.cost;
    out.push(`At the real mix of the last ${c.window_days} days: ${c.turns} model turn(s).`);
    out.push("");
    out.push("| | $/1000 turns | |");
    out.push("| --- | ---: | --- |");
    for (const l of c.lines) out.push(`| ${l.name} | ${usd(l.per_1000_usd)} | ${l.note ?? ""} |`);
    out.push(
      `| per rescued turn | ${usd(c.cost_per_rescued_usd)} | ${c.upgrades_per_1000.toFixed(1)} upgrade(s) off \`default\` per 1000 × ${pct(c.upgrade_precision)} of the planner's \`demanding\` calls you also labelled \`demanding\` = ${c.rescued_per_1000 === null ? "—" : c.rescued_per_1000.toFixed(1)} rescued per 1000 |`,
    );
    out.push("");
    out.push("| Tier | Observed calls | Per turn | Basis |");
    out.push("| --- | ---: | ---: | --- |");
    for (const t of c.tiers) out.push(`| ${t.tier} | ${t.turns} | ${usd(t.per_turn_usd)} | ${t.basis}${t.note ? ` — ${cell(t.note)}` : ""} |`);
    out.push("");
    for (const n of c.notes) out.push(`- ${n}`);
  }
  out.push("");
  out.push("## The shadow window — route-report's policy rows");
  out.push("");
  const s = r.shadow;
  if (!s) out.push("Not read — pass `--route-report` (the output of `metistry compute route-report --since 14d --json`).");
  else if (!s.policy.recorded) out.push("This console's route_report predates the route record — `metistry update` lands it.");
  else {
    const p = s.policy;
    out.push(
      `${s.since_days} day(s)${s.totals.first_message ? `, ${s.totals.first_message} → ${s.totals.last_message ?? ""}` : ""}: ${p.rows} route row(s), ${p.consultations} consultation(s)${p.thin ? " — thin: widen --since" : ""}.` +
        (s.since_days < 14 ? " Shadow counts after fourteen consecutive days in `mode: shadow`; this window is shorter." : ""),
    );
    const section = (title: string, rows: ReadonlyArray<{ label: string; n: number; share?: number | null | undefined }>): void => {
      out.push("");
      out.push(`| ${title} | n | share |`);
      out.push("| --- | ---: | ---: |");
      for (const x of rows) out.push(`| ${cell(x.label)} | ${x.n} | ${pct(x.share ?? null)} |`);
    };
    section("outcome", p.outcomes);
    section("table row that decided", p.table_rows);
    section("served tier → chosen tier", p.tiers);
    section("on your overrides", p.override);
    out.push("");
    out.push(`Consultation latency: p50 ${p.latency.p50_ms ?? "—"} ms, p95 ${p.latency.p95_ms ?? "—"} ms over ${p.latency.over}.`);
    if (p.shadow.length > 0) out.push(`Stage-2 shadow on the chosen tier: ${p.shadow.map((x) => `${x.tier} ${x.turns} turn(s), mean agreement ${x.mean_agreement ?? "—"}`).join("; ")}.`);
  }
  return out.join("\n");
}
