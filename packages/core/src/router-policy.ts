// The router's policy — rules outside, a policy inside (T9-2;
// docs/ops/dynamic-router.md is the whole spec, §2–§5).
//
// Invariant 4, as ratified on 2026-09-26: "Rules the owner writes decide what
// may run … Inside those bounds a local policy may choose the operations and
// the tier for a request; it can never choose outside them, every choice is
// recorded with its reasons, and with the policy absent or failing every
// request takes the rules' default."
//
// This file is the "local policy" of that sentence and the bounds around it,
// and every part of it is either closed or pure:
//
//   * **Closed vocabularies, in code.** The planner's three classes
//     (`COMPLEXITY`) and the operations (`ROUTE_OPERATIONS`) are product
//     changes, never config lines — invariant 10's rule, applied. The table in
//     `rules.yaml` may only pick from them, and from the owner's own tier
//     names.
//   * **The table is validated at LOAD** (`validateRoutePolicy`), in the same
//     parse that already refuses an uncompilable `fast_path` regex, and every
//     refusal names its field. A tier outside the allow-list, a `tool_calls`
//     above the cap, an operation outside the vocabulary: a startup failure,
//     never a surprise on a message.
//   * **`decide()` is pure.** Features in, a decision out, no I/O. A condition
//     on an absent feature is false, never true, so a scorer that is down makes
//     its rows skip rather than misfire.
//   * **`boundDecision()` checks again at run time** what the load could not know —
//     the thread's session, the registries — and re-asserts what it could, so
//     a decision outside the allow-list is a THROW (a `failed` consultation,
//     the rules' default), whatever produced it.
//   * **The policy never names a model.** It names a tier from a list the owner
//     wrote; the tier resolves to its model exactly as the drain resolves it.
//     Nothing here has a field that could hold a model name.
//
// The model features (`intent`, `complexity`) come from ONE on-machine scorer
// — `compute.yaml` `assignments.intent` — through `scoreChoice`, which moved
// into core for exactly this (score-choice.ts). The planner asks what the
// message SAYS, never what to do about it: it answers a class, and the owner's
// table maps the class to a tier. That mapping is the clamp.

import { z } from "zod";
import { choicePlan, codesFor, type ChoiceOption } from "./choice.js";
import { resolveAssignment, type Compute } from "./compute.js";
import { intentGuard, intentMessages, intentStage, intentThreshold, isIntent, INTENT_NAMES, INTENT_UNSURE, type Intent, type IntentPhrasing, type IntentRules } from "./intent.js";
import { scoreChoice, type ModelAccess } from "./score-choice.js";
import { DEFAULT_TIER, resolveTier, type TierMap } from "./tiers.js";

// ---- the planner's classes (§2) ----------------------------------------------

/**
 * How much a message asks for — the planner's closed answer (§2, "The
 * planner"). Each description is a statement about the TEXT, in the present
 * tense, starting "it …" — never an instruction and never a destination
 * (PoC-20's Laya lesson 1: ask what the message says, not what to do about
 * it).
 *
 * The names map to PoC-15's labels — `simple` = cheap, `moderate` = standard,
 * `demanding` = deep — so PoC-15/16's fixtures carry over. They are not tier
 * names on purpose: `tier: { demanding: deep }` reads as a decision,
 * `tier: { deep: deep }` as a typo.
 *
 * The wording is the spec's starting wording. It is T9-3's harness that tunes
 * it on the owner's fixtures and then freezes it before the scored run; a
 * change here after that voids the run (§7.2).
 */
export const COMPLEXITY = [
  { name: "simple", description: "it asks for one small thing: a fact, a short reply, a lookup, a quick change" },
  { name: "moderate", description: "it asks for a piece of work with a few steps: reading, gathering, or writing something of moderate length" },
  { name: "demanding", description: "it asks for careful judgement: weighing options, planning around several constraints, or getting something consequential right" },
] as const satisfies readonly { name: string; description: string }[];

export type Complexity = (typeof COMPLEXITY)[number]["name"];

/** The names alone, in order. The order is the code order, so it is not cosmetic. */
export const COMPLEXITY_NAMES = COMPLEXITY.map((c) => c.name) as readonly Complexity[] as [Complexity, ...Complexity[]];

/** The options as the scorer takes them — one place, so the eval harness and the router describe them identically. */
export const COMPLEXITY_OPTIONS: ChoiceOption[] = COMPLEXITY.map((c) => ({ key: c.name, description: c.description }));

export function isComplexity(v: unknown): v is Complexity {
  return typeof v === "string" && (COMPLEXITY_NAMES as readonly string[]).includes(v);
}

/** The one scored call for the planner. Three classes, one token. */
export const complexityStage = () => choicePlan(COMPLEXITY_OPTIONS);

/**
 * The two messages the planner sends: `intentMessages`, the SAME builder the
 * intent tier uses, over the complexity options — one prompt shape, so a
 * threshold T9-3 fits against the harness holds at the router (§7.2: "the
 * served call byte for byte … the same prompt builder").
 */
export function complexityMessages(text: string, opts: { phrasing?: IntentPhrasing; now?: Date; maxChars?: number } = {}): Array<{ role: "system" | "user"; content: string }> {
  return intentMessages(text, { options: COMPLEXITY_OPTIONS, codes: codesFor(COMPLEXITY_OPTIONS.length), ...opts });
}

// ---- the operation vocabulary (§3) --------------------------------------------

/**
 * Every operation a policy may choose, as its written form. Closed, in code:
 * a new operation is a product change, never a config line. Two forms take one
 * argument — a named query, a crew — and the argument is checked against the
 * owner's own registries (at load for queries, at run time for both).
 *
 * `tools` is today's turn and the rules' default; every other operation
 * narrows it, and none widens what the assistant may do (§3).
 */
export const ROUTE_OPERATIONS = ["answer", "fast_path:<query>", "retrieve:knowledge", "retrieve:queries", "delegate:<crew>", "tools"] as const;
export type RouteOperationForm = (typeof ROUTE_OPERATIONS)[number];

/** A chosen operation, as it is written in `rules.yaml` and in the record. */
export type RouteOperation = "answer" | "retrieve:knowledge" | "retrieve:queries" | "tools" | `fast_path:${string}` | `delegate:${string}`;

/** The operation the rules' default serves: today's whole turn. */
export const DEFAULT_OPERATION = "tools" satisfies RouteOperation;

export type ParsedOperation =
  | { form: "answer" }
  | { form: "fast_path:<query>"; query: string }
  | { form: "retrieve:knowledge" }
  | { form: "retrieve:queries" }
  | { form: "delegate:<crew>"; crew: string }
  | { form: "tools" };

/** A query or crew name, as the owner's registries spell them. */
const OPERATION_ARG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Read an operation, spelled exactly, or undefined. The only way a string becomes an operation. */
export function parseOperation(s: unknown): ParsedOperation | undefined {
  if (typeof s !== "string") return undefined;
  if (s === "answer" || s === "retrieve:knowledge" || s === "retrieve:queries" || s === "tools") return { form: s };
  const fast = /^fast_path:(.+)$/.exec(s);
  if (fast && OPERATION_ARG_RE.test(fast[1]!)) return { form: "fast_path:<query>", query: fast[1]! };
  const crew = /^delegate:(.+)$/.exec(s);
  if (crew && OPERATION_ARG_RE.test(crew[1]!)) return { form: "delegate:<crew>", crew: crew[1]! };
  return undefined;
}

/** A fast path runs no model, so it has no tier and no tool budget (§4, `then.tier`, `then.tool_calls`). */
function takesTier(op: ParsedOperation): boolean {
  return op.form !== "fast_path:<query>";
}
/** `answer` sends no tools and a fast path runs no model: neither has a tool-call budget to grant. */
function takesToolCalls(op: ParsedOperation): boolean {
  return op.form !== "answer" && op.form !== "fast_path:<query>";
}

// ---- the table: `rules.yaml` `policy:` (§4) ----------------------------------

/** §4's `timeout_ms` default: the whole consultation — features, table, bounds. The intent research's p95 bar for the composer path. */
export const POLICY_TIMEOUT_DEFAULT_MS = 400; // limit: fixed — the spec's default; the owner's `policy.timeout_ms` (50–2000) replaces it
/** The floor and ceiling on `policy.timeout_ms`. */
export const POLICY_TIMEOUT_MIN_MS = 50; // limit: fixed — §4: below 50 ms no local scorer answers at all
export const POLICY_TIMEOUT_MAX_MS = 2000; // limit: fixed — §4: past 2 s the routing path is slower than the turn it routes

const ROW_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ROW_ID_MAX = 64; // limit: fixed — a row id is a label in a report, not prose

export const POLICY_MODES = ["shadow", "serve"] as const;
export type PolicyMode = (typeof POLICY_MODES)[number];

/** An inclusive integer range over a count feature. */
export interface FeatureRange {
  min?: number;
  max?: number;
}

/** The conditions of one row, all ANDed. Absent keys do not constrain. */
export interface PolicyWhen {
  intent?: Intent[];
  complexity?: Complexity[];
  words?: FeatureRange;
  attachments?: FeatureRange;
  thread_turns?: FeatureRange;
  recent_failures?: FeatureRange;
  reask?: boolean;
}

export type TierByComplexity = Record<Complexity, string>;

export interface PolicyThen {
  operation: RouteOperation;
  /** a name in `policy.tiers`, or one per complexity class. Absent exactly on `fast_path:*`. */
  tier?: string | TierByComplexity;
  /** absent = `caps.tool_calls` where the operation takes tools */
  tool_calls?: number;
}

export interface PolicyRow {
  id: string;
  when: PolicyWhen;
  then: PolicyThen;
}

/** `rules.yaml` `policy:`, validated. Only `validateRoutePolicy` makes one. */
export interface RoutePolicyConfig {
  mode: PolicyMode;
  /** the allow-list, cheapest first — each a key of `tiers:` */
  tiers: string[];
  timeout_ms: number;
  caps: { tool_calls: number; tokens: number; cost_usd: number };
  complexity?: { min_confidence: number };
  table: PolicyRow[];
}

/** What `rules.yaml` says around the block, which the block has to agree with (§4, "Refused at load"). */
export interface PolicyContext {
  /** the keys of `rules.yaml` `tiers:` */
  tiers: readonly string[];
  /** the named queries the `fast_path:` rules answer from — a policy reaches no query the rules could not */
  fastPathQueries: readonly string[];
  /** whether `rules.yaml` has an `intent:` block — both files have to agree before a verdict moves anything */
  intentRules: boolean;
}

const rangeSchema = z
  .strictObject({
    min: z.number().int("a bound is a whole number").min(0, "a bound is 0 or more").optional(),
    max: z.number().int("a bound is a whole number").min(0, "a bound is 0 or more").optional(),
  })
  .refine((r) => r.min !== undefined || r.max !== undefined, "a range names min, max or both")
  .refine((r) => r.min === undefined || r.max === undefined || r.min <= r.max, "min is above max, so the row can never match");

const oneOrMany = <T extends string>(names: readonly [T, ...T[]], what: string) =>
  z.union([z.enum(names), z.array(z.enum(names)).min(1)], { error: `${what} is one name or a list, each one of: ${names.join(", ")}` });

const whenSchema = z.strictObject({
  intent: oneOrMany(INTENT_NAMES, "intent").optional(),
  complexity: oneOrMany(COMPLEXITY_NAMES, "complexity").optional(),
  words: rangeSchema.optional(),
  attachments: rangeSchema.optional(),
  thread_turns: rangeSchema.optional(),
  recent_failures: rangeSchema.optional(),
  reask: z.boolean({ error: "reask is true or false" }).optional(),
});

const thenSchema = z.strictObject({
  operation: z.string({ error: `operation is one of ${ROUTE_OPERATIONS.join(", ")}` }),
  tier: z.union([z.string(), z.record(z.string(), z.string())], { error: "tier is a name in policy.tiers, or a map from simple, moderate and demanding to names in policy.tiers" }).optional(),
  tool_calls: z.number().int("tool_calls is a whole number").min(0, "tool_calls is 0 or more").optional(),
});

const rowSchema = z.strictObject({
  id: z
    .string({ error: "every row has an id — it is how the record names the rule that decided" })
    .max(ROW_ID_MAX, `an id is at most ${ROW_ID_MAX} characters`)
    .regex(ROW_ID_RE, "an id is lowercase kebab-case (casing rule: only the vault is TitleCase)"),
  when: whenSchema.nullable().optional(),
  then: thenSchema,
});

const policySchema = z.strictObject({
  mode: z.enum(POLICY_MODES, { error: "mode is shadow or serve" }).default("shadow"),
  tiers: z.array(z.string(), { error: "tiers is the allow-list: a list of tier names, cheapest first" }).min(1, "tiers is the allow-list and may not be empty"),
  timeout_ms: z
    .number({ error: `timeout_ms is a whole number of milliseconds, ${POLICY_TIMEOUT_MIN_MS}–${POLICY_TIMEOUT_MAX_MS}` })
    .int(`timeout_ms is a whole number of milliseconds, ${POLICY_TIMEOUT_MIN_MS}–${POLICY_TIMEOUT_MAX_MS}`)
    .min(POLICY_TIMEOUT_MIN_MS, `timeout_ms is ${POLICY_TIMEOUT_MIN_MS}–${POLICY_TIMEOUT_MAX_MS}`)
    .max(POLICY_TIMEOUT_MAX_MS, `timeout_ms is ${POLICY_TIMEOUT_MIN_MS}–${POLICY_TIMEOUT_MAX_MS}`)
    .default(POLICY_TIMEOUT_DEFAULT_MS),
  // No defaults, for the reason `intent.min_confidence` has none: a number
  // nobody chose is not a limit.
  caps: z.strictObject(
    {
      tool_calls: z.number({ error: "caps.tool_calls is required: the tool calls a policy-served turn may make, a whole number 0 or more" }).int("caps.tool_calls is a whole number").min(0, "caps.tool_calls is 0 or more"),
      tokens: z.number({ error: "caps.tokens is required: the prompt + completion tokens a policy-served turn may spend, a whole number above 0" }).int("caps.tokens is a whole number").positive("caps.tokens is above 0"),
      cost_usd: z.number({ error: "caps.cost_usd is required: what a policy-served turn may cost, in USD, above 0" }).positive("caps.cost_usd is above 0"),
    },
    { error: "caps is required: tool_calls, tokens and cost_usd — every turn the policy serves is bound by all three" },
  ),
  complexity: z
    .strictObject({
      min_confidence: z
        .number({ error: "complexity.min_confidence is a number between 0 and 1 — fit it with T9-3's --fit on your own labelled messages rather than picking one" })
        .min(0, "complexity.min_confidence is between 0 and 1")
        .max(1, "complexity.min_confidence is between 0 and 1"),
    })
    .optional(),
  table: z.array(rowSchema, { error: "table is a list of rows" }).default([]),
});

/** `policy.table[2].then.tier` — the field a refusal names. */
function fieldOf(path: readonly PropertyKey[]): string {
  let out = "policy";
  for (const seg of path) out += typeof seg === "number" ? `[${seg}]` : `.${String(seg)}`;
  return out;
}

function asList<T>(v: T | T[] | undefined): T[] | undefined {
  return v === undefined ? undefined : Array.isArray(v) ? v : [v];
}

/** A row reads `complexity` when it conditions on it or maps its tier by it. */
function rowReadsComplexity(row: { when?: { complexity?: unknown } | null | undefined; then: { tier?: unknown } }): boolean {
  return row.when?.complexity !== undefined || (typeof row.then.tier === "object" && row.then.tier !== null);
}

export type PolicyValidation = { ok: true; policy: RoutePolicyConfig } | { ok: false; errors: string[] };

/**
 * `rules.yaml` `policy:` → a policy, or every reason it is not one, each
 * naming its field (§4, "Refused at load"): an unknown key anywhere; a tier
 * outside `tiers:` or outside `policy.tiers`; an operation outside the
 * vocabulary; a `fast_path:<query>` no `fast_path:` rule names; a `tool_calls`
 * above the cap; a tier map missing a class; a row reading `intent` while
 * `rules.yaml` has no `intent:` block; a row reading `complexity` with no
 * `complexity.min_confidence`; `mode: serve` before T9-4.
 */
export function validateRoutePolicy(input: unknown, ctx: PolicyContext): PolicyValidation {
  const parsed = policySchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => (i.code === "unrecognized_keys" ? i.keys.map((k) => `${fieldOf([...i.path, k])}: unknown key`).join("; ") : `${fieldOf(i.path)}: ${i.message}`)) };
  }
  const p = parsed.data;
  const errors: string[] = [];
  const refuse = (path: readonly PropertyKey[], message: string): void => void errors.push(`${fieldOf(path)}: ${message}`);

  if (p.mode === "serve") {
    refuse(["mode"], "serve is refused until T9-4 wires the composer (docs/ops/dynamic-router.md §7.3); the policy runs in shadow — write mode: shadow");
  }

  const seenTier = new Set<string>();
  p.tiers.forEach((t, i) => {
    if (!ctx.tiers.includes(t)) refuse(["tiers", i], `${JSON.stringify(t)} is not a key of tiers: (${ctx.tiers.join(", ")}) — the allow-list names the owner's tiers, never a model`);
    if (seenTier.has(t)) refuse(["tiers", i], `${JSON.stringify(t)} is listed twice; the order is what "a higher tier" means`);
    seenTier.add(t);
  });
  const allowed = new Set(p.tiers);
  const inAllowList = (path: readonly PropertyKey[], t: string): void => {
    if (!allowed.has(t)) refuse(path, `${JSON.stringify(t)} is not in policy.tiers (${p.tiers.join(", ")}) — the policy may name only the tiers the allow-list names`);
  };

  if (p.table.some(rowReadsComplexity) && p.complexity === undefined) {
    refuse(["complexity", "min_confidence"], "a row reads complexity, so complexity.min_confidence is required — fit it with T9-3's --fit rather than guessing it");
  }

  const seenId = new Set<string>();
  p.table.forEach((row, i) => {
    if (seenId.has(row.id)) refuse(["table", i, "id"], `${JSON.stringify(row.id)} is used by an earlier row; an id is how the record names the rule that decided`);
    seenId.add(row.id);

    if (row.when?.intent !== undefined && !ctx.intentRules) {
      refuse(["table", i, "when", "intent"], "this row reads intent and rules.yaml has no intent: block — both files have to agree before a verdict moves anything, as they do at the capture door");
    }

    const op = parseOperation(row.then.operation);
    if (!op) {
      refuse(["table", i, "then", "operation"], `${JSON.stringify(row.then.operation)} is not an operation: one of ${ROUTE_OPERATIONS.join(", ")}, spelled exactly — a new one is a product change, never a config line`);
      return;
    }
    if (op.form === "fast_path:<query>" && !ctx.fastPathQueries.includes(op.query)) {
      refuse(["table", i, "then", "operation"], `no fast_path: rule names the query ${op.query} (${ctx.fastPathQueries.join(", ") || "there are none"}) — the policy can reach no query the rules could not`);
    }

    const tier = row.then.tier;
    if (!takesTier(op)) {
      if (tier !== undefined) refuse(["table", i, "then", "tier"], `${op.form} runs no model, so it takes no tier`);
    } else if (tier === undefined) {
      refuse(["table", i, "then", "tier"], `${row.then.operation} runs a model, so the row names a tier from policy.tiers (or one per complexity class)`);
    } else if (typeof tier === "string") {
      inAllowList(["table", i, "then", "tier"], tier);
    } else {
      for (const k of Object.keys(tier)) if (!isComplexity(k)) refuse(["table", i, "then", "tier", k], "unknown key — a tier map is keyed by simple, moderate and demanding");
      for (const c of COMPLEXITY_NAMES) {
        const t = Object.hasOwn(tier, c) ? tier[c] : undefined;
        if (t === undefined) refuse(["table", i, "then", "tier", c], "a tier map names a tier for all three classes — a class with no tier would be a message with no route");
        else inAllowList(["table", i, "then", "tier", c], t);
      }
    }

    const n = row.then.tool_calls;
    if (n !== undefined) {
      if (!takesToolCalls(op)) refuse(["table", i, "then", "tool_calls"], `${op.form} makes no tool calls, so it takes no tool_calls`);
      else if (n > p.caps.tool_calls) refuse(["table", i, "then", "tool_calls"], `${n} is above caps.tool_calls (${p.caps.tool_calls}) — a row cannot grant itself more than the owner's cap`);
    }
  });

  if (errors.length > 0) return { ok: false, errors };

  const table: PolicyRow[] = p.table.map((row) => {
    const w = row.when ?? {};
    const when: PolicyWhen = {};
    const intents = asList(w.intent);
    if (intents) when.intent = [...intents];
    const classes = asList(w.complexity);
    if (classes) when.complexity = [...classes];
    for (const k of ["words", "attachments", "thread_turns", "recent_failures"] as const) {
      const r = w[k];
      if (r) when[k] = { ...(r.min !== undefined ? { min: r.min } : {}), ...(r.max !== undefined ? { max: r.max } : {}) };
    }
    if (w.reask !== undefined) when.reask = w.reask;
    const t = row.then.tier;
    const then: PolicyThen = {
      operation: row.then.operation as RouteOperation,
      ...(typeof t === "string" ? { tier: t } : t ? { tier: { simple: t.simple!, moderate: t.moderate!, demanding: t.demanding! } } : {}),
      ...(row.then.tool_calls !== undefined ? { tool_calls: row.then.tool_calls } : {}),
    };
    return { id: row.id, when, then };
  });
  return {
    ok: true,
    policy: {
      mode: p.mode,
      tiers: [...p.tiers],
      timeout_ms: p.timeout_ms,
      caps: { ...p.caps },
      ...(p.complexity ? { complexity: { min_confidence: p.complexity.min_confidence } } : {}),
      table,
    },
  };
}

/** Which model features the table reads — determined once, at load (§2: "computed only when some row reads them"). */
export function policyReads(policy: RoutePolicyConfig): { intent: boolean; complexity: boolean } {
  return {
    intent: policy.table.some((r) => r.when.intent !== undefined),
    complexity: policy.table.some(rowReadsComplexity),
  };
}

// ---- evaluation (§4) -----------------------------------------------------------

/** The features as the table reads them: values, not records. Every one but `words` and `attachments` may be absent. */
export interface PolicyFeatures {
  words: number;
  attachments: number;
  thread_turns?: number | undefined;
  recent_failures?: number | undefined;
  reask?: boolean | undefined;
  intent?: Intent | undefined;
  complexity?: Complexity | undefined;
}

/** What a policy proposes: an operation from the vocabulary and a tier from the allow-list — never a model. */
export interface PolicyChoice {
  operation: RouteOperation;
  tier?: string;
  tool_calls?: number;
}

export type PolicyDecision = { outcome: "chosen"; row: string; chosen: PolicyChoice } | { outcome: "no_match" };

function inRange(v: unknown, r: FeatureRange): boolean {
  if (typeof v !== "number" || !Number.isFinite(v)) return false; // absent (or not a count) is false, never true
  return (r.min === undefined || v >= r.min) && (r.max === undefined || v <= r.max);
}

function matches(when: PolicyWhen, f: PolicyFeatures): boolean {
  if (when.intent && !(isIntent(f.intent) && when.intent.includes(f.intent))) return false;
  if (when.complexity && !(isComplexity(f.complexity) && when.complexity.includes(f.complexity))) return false;
  for (const k of ["words", "attachments", "thread_turns", "recent_failures"] as const) {
    const r = when[k];
    if (r && !inRange(f[k], r)) return false;
  }
  if (when.reask !== undefined && f.reask !== when.reask) return false;
  return true;
}

/**
 * The table over the features: the first row whose every condition holds
 * decides. Pure — no I/O, no clock, no model.
 *
 * A condition on an absent feature is false, so a scorer that is down makes
 * its rows skip and the next rows still apply. A row whose tier is a map
 * does not match while `complexity` is absent. No row matching is
 * `no_match`, and the rules' default is served.
 */
export function decide(policy: RoutePolicyConfig, features: PolicyFeatures): PolicyDecision {
  for (const row of policy.table) {
    if (!matches(row.when, features)) continue;
    const t = row.then.tier;
    let tier: string | undefined;
    if (typeof t === "string") tier = t;
    else if (t) {
      if (!isComplexity(features.complexity)) continue;
      tier = t[features.complexity];
    }
    const op = parseOperation(row.then.operation);
    const toolCalls = op && takesToolCalls(op) ? (row.then.tool_calls ?? policy.caps.tool_calls) : undefined;
    return {
      outcome: "chosen",
      row: row.id,
      chosen: { operation: row.then.operation, ...(tier !== undefined ? { tier } : {}), ...(toolCalls !== undefined ? { tool_calls: toolCalls } : {}) },
    };
  }
  return { outcome: "no_match" };
}

// ---- the bounds (§1, §5) ------------------------------------------------------

/** The run-time bounds a choice can be held to (§5's `out_of_bounds` row). The load-time refusals never reach a message. */
export const RUNTIME_BOUNDS = ["session", "crew_registry", "queries"] as const;
export type RuntimeBound = (typeof RUNTIME_BOUNDS)[number];

export type BoundedDecision = PolicyDecision | { outcome: "out_of_bounds"; row: string; chosen: PolicyChoice; bounded_by: RuntimeBound };

/** Where a tier runs: the provider (null on the Agent SDK path, which `compute.yaml` does not assign) and the model. */
export interface TierTarget {
  provider: string | null;
  model: string;
}

/**
 * A tier NAME → where it runs, exactly as the drain resolves it
 * (apps/assistant/src/tiers.ts `resolveTurn`): `compute.yaml`
 * `assignments.tiers`, then `assignments.default`; with no assignments,
 * `rules.yaml` `tiers:`. An unknown name is `default` at every level.
 */
export function tierTarget(cfg: Compute | undefined, tiers: TierMap, name: string): TierTarget {
  const a = cfg ? resolveAssignment(cfg, name) : undefined;
  if (a) return { provider: a.provider, model: a.model };
  return { provider: null, model: resolveTier(tiers, name).model };
}

export interface BoundsContext {
  /** the thread's active session (`route_features`): a policy may not move one to another model (R10) */
  session: { active: boolean; provider: string | null; model: string | null };
  /** where a tier runs, as the drain resolves it (`tierTarget`) */
  resolve: (tier: string) => TierTarget;
  /** the named query is loaded now */
  hasQuery: (name: string) => boolean;
  /** the crew's manifest is loaded now */
  hasCrew: (name: string) => boolean;
}

/**
 * Re-assert what the load already refused. A validated table cannot produce
 * any of these; reaching one means something other than the table produced
 * the decision, and that THROWS — a `failed` consultation, the rules'
 * default — rather than being served or recorded as a choice.
 */
function assertInsideRules(policy: RoutePolicyConfig, c: PolicyChoice): ParsedOperation {
  const op = parseOperation(c.operation);
  if (!op) throw new Error("the decision named an operation outside the vocabulary");
  if (takesTier(op)) {
    if (typeof c.tier !== "string" || !policy.tiers.includes(c.tier)) throw new Error("the decision named a tier outside policy.tiers");
  } else if (c.tier !== undefined) {
    throw new Error("the decision gave a tier to an operation that runs no model");
  }
  if (c.tool_calls !== undefined && (!takesToolCalls(op) || !Number.isInteger(c.tool_calls) || c.tool_calls < 0 || c.tool_calls > policy.caps.tool_calls)) {
    throw new Error("the decision granted a tool_calls outside caps.tool_calls");
  }
  return op;
}

/**
 * The bounds, at run time (§5): what the load could not know. A choice
 * that fails one is `out_of_bounds`, recorded with the bound that held it,
 * and the rules' default is what serve would do.
 *
 *   * **the registries** — a `fast_path:<query>` whose query is not loaded
 *     now (`queries`), a `delegate:<crew>` whose manifest is not loaded now
 *     (`crew_registry`);
 *   * **the session** (R10) — while the thread has an active session, the
 *     tier must resolve to that session's (provider, model), because the
 *     drain does not resume a session built against another model and the
 *     conversation would be silently dropped. Effort-only variants pass.
 *     Where the session's model is not on record (an Agent SDK session keeps
 *     no `assistant_sessions` row), the only model known not to move it is
 *     the one the rules' default serves, so the tier must resolve to that.
 */
export function boundDecision(policy: RoutePolicyConfig, decision: PolicyDecision, ctx: BoundsContext): BoundedDecision {
  if (decision.outcome !== "chosen") return decision;
  const { row, chosen } = decision;
  const op = assertInsideRules(policy, chosen);
  const held = (bounded_by: RuntimeBound): BoundedDecision => ({ outcome: "out_of_bounds", row, chosen, bounded_by });
  if (op.form === "fast_path:<query>" && !ctx.hasQuery(op.query)) return held("queries");
  if (op.form === "delegate:<crew>" && !ctx.hasCrew(op.crew)) return held("crew_registry");
  if (chosen.tier !== undefined && ctx.session.active) {
    const to = ctx.resolve(chosen.tier);
    const from: TierTarget = ctx.session.model !== null ? { provider: ctx.session.provider, model: ctx.session.model } : ctx.resolve(DEFAULT_TIER);
    if (to.provider !== from.provider || to.model !== from.model) return held("session");
  }
  return decision;
}

// ---- the model features (§2) --------------------------------------------------

/**
 * What became of one model feature, for the record (§5: "a model feature
 * that is unavailable is not a failed consultation"). `scored` and
 * `below_threshold` carry the scorer's numbers; nothing carries text — the
 * guard's reason is a code, and a server's own words (which can echo the
 * prompt) never reach the record.
 */
export type ModelFeatureOutcome = "scored" | "below_threshold" | "guarded" | "unavailable";

export interface ScorerProvenance {
  provider?: string;
  model?: string;
  latency_ms?: number;
}

export interface IntentFeature extends ScorerProvenance {
  outcome: ModelFeatureOutcome;
  /** the verdict, when the scorer answered — below the threshold the FEATURE is `unsure` */
  intent?: Intent;
  confidence?: number;
  threshold?: number;
  /** why there is no verdict: the guard's code, or `no_assignment` / `no_answer` */
  reason?: string;
}

export interface ComplexityFeature extends ScorerProvenance {
  outcome: ModelFeatureOutcome;
  class?: Complexity;
  confidence?: number;
  threshold?: number;
  reason?: string;
}

export interface ModelFeatures {
  intent?: IntentFeature;
  complexity?: ComplexityFeature;
}

/** The value the table reads for `intent` (§2): the verdict at or over the owner's threshold; `unsure` below it; absent otherwise. */
export function intentValue(f: IntentFeature | undefined): Intent | undefined {
  if (!f || !isIntent(f.intent)) return undefined;
  if (f.outcome === "scored") return f.intent;
  if (f.outcome === "below_threshold") return INTENT_UNSURE;
  return undefined;
}

/** The value the table reads for `complexity` (§2): the class at or over `complexity.min_confidence`; absent otherwise. */
export function complexityValue(f: ComplexityFeature | undefined): Complexity | undefined {
  return f && f.outcome === "scored" && isComplexity(f.class) ? f.class : undefined;
}

/** The share of `timeout_ms` a scorer call may take, so that a slow scorer is an ABSENT feature and the table still decides inside the deadline (§2: absent when "the call … ran past the timeout"). */
const SCORER_SHARE = 0.75; // limit: fixed — leaves a quarter of the owner's deadline for the table and the bounds, which take microseconds; the features query runs concurrently

/** Each scorer call's own deadline, from the consultation's. */
export function scorerTimeoutMs(policyTimeoutMs: number): number {
  return Math.max(1, Math.floor(policyTimeoutMs * SCORER_SHARE));
}

/** The guard's reason as a code (`too_long`, `out_of_script`, …): the sentence is for a log, the code is for a row Run detail shows. */
function guardCode(reason: string): string {
  const head = reason.split(":")[0]!.trim().toLowerCase().replace(/[^a-z]+/g, "_").replace(/^_+|_+$/g, "");
  return head === "" ? "guarded" : head.slice(0, 40);
}

const round4 = (n: number): number => Number(n.toFixed(4));

export interface RouteScoreOptions {
  /** which features the table reads (`policyReads`) — a feature no row reads is never scored */
  reads: { intent: boolean; complexity: boolean };
  /** `rules.yaml` `intent:` — the owner's thresholds */
  intentRules?: IntentRules | undefined;
  /** `policy.complexity.min_confidence` */
  complexityMinConfidence?: number | undefined;
  /** each call's own deadline (`scorerTimeoutMs`) */
  timeoutMs: number;
  now?: Date;
}

/** Who the router's scorer calls are, in the money rule's refusal. */
const ROUTER_CALLER = "the router's policy (assignments.intent)";

/**
 * The model features the table reads, on the one local scorer
 * (`assignments.intent`) — `intent` and `complexity`, each only when some row
 * reads it, the two calls concurrently (§2).
 *
 * The text goes to the on-machine scorer and nowhere else: what comes back is
 * names from the closed enums and the scorer's numbers. The deterministic
 * guard runs first, as it does at the capture door.
 *
 * THROWS only for the money rule — an off-machine provider behind
 * `assignments.intent`, refused at the call (the schema refuses it at load).
 * The consultation turns that into `failed` and the rules' default is
 * served. Everything else is an absent feature.
 */
export async function scoreRouteFeatures(access: ModelAccess, text: string, opts: RouteScoreOptions): Promise<ModelFeatures> {
  const out: ModelFeatures = {};
  if (!opts.reads.intent && !opts.reads.complexity) return out;

  const guard = intentGuard(text);
  if (!guard.ok) {
    const reason = guardCode(guard.reason);
    if (opts.reads.intent) out.intent = { outcome: "guarded", reason };
    if (opts.reads.complexity) out.complexity = { outcome: "guarded", reason };
    return out;
  }

  const modelRef = access.compute?.().assignments?.intent?.model;
  if (!modelRef) {
    if (opts.reads.intent) out.intent = { outcome: "unavailable", reason: "no_assignment" };
    if (opts.reads.complexity) out.complexity = { outcome: "unavailable", reason: "no_assignment" };
    return out;
  }
  const now = opts.now ? { now: opts.now } : {};

  const intentCall = async (): Promise<IntentFeature> => {
    const rules = opts.intentRules;
    if (!rules) return { outcome: "unavailable", reason: "no_intent_rules" };
    const stage = intentStage();
    const s = await scoreChoice(access, { collector: ROUTER_CALLER, modelRef, options: stage.options, codes: stage.codes, messages: intentMessages(guard.text, { options: stage.options, codes: stage.codes, ...now }), timeoutMs: opts.timeoutMs });
    if (!s.ok || !isIntent(s.choice)) return { outcome: "unavailable", reason: "no_answer" };
    const threshold = intentThreshold(rules, s.choice);
    const provenance = { provider: s.provider, model: s.model, latency_ms: s.latency_ms };
    return { outcome: s.confidence >= threshold ? "scored" : "below_threshold", intent: s.choice, confidence: round4(s.confidence), threshold, ...provenance };
  };

  const complexityCall = async (): Promise<ComplexityFeature> => {
    const threshold = opts.complexityMinConfidence;
    if (threshold === undefined) return { outcome: "unavailable", reason: "no_min_confidence" };
    const stage = complexityStage();
    const s = await scoreChoice(access, { collector: ROUTER_CALLER, modelRef, options: stage.options, codes: stage.codes, messages: complexityMessages(guard.text, now), timeoutMs: opts.timeoutMs });
    if (!s.ok || !isComplexity(s.choice)) return { outcome: "unavailable", reason: "no_answer" };
    const provenance = { provider: s.provider, model: s.model, latency_ms: s.latency_ms };
    return { outcome: s.confidence >= threshold ? "scored" : "below_threshold", class: s.choice, confidence: round4(s.confidence), threshold, ...provenance };
  };

  const [intent, complexity] = await Promise.all([opts.reads.intent ? intentCall() : undefined, opts.reads.complexity ? complexityCall() : undefined]);
  if (intent) out.intent = intent;
  if (complexity) out.complexity = complexity;
  return out;
}
