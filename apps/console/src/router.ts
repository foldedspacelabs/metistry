// The router (invariant 4): the RULES are deterministic — prefix, regex,
// explicit commands only — and they run first and always win. Lives in the
// console (CRIT-3: no third container). First match wins.
//
// Invariant 4 as ratified on 2026-09-26: inside the rules' bounds a local
// policy may choose the operations and the tier for a request. That policy is
// consulted only on the rules' fall-through, and only in `policy.mode: serve`
// does its choice become the route (T9-4, `serveRoute` below) — never inside
// `route()`, which is the rules alone.
//
// What the router picks is a TIER NAME. A tier is a (model, effort) pair
// (core's `tiers.ts`, cost research decision 2); the router resolves it here
// for the record it writes onto the message, and the drain resolves the same
// name again at the point of the call. One name, two readers of the same
// `tiers:` block — instance overlay (D4) applies to both.

import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  POLICY_TIMEOUT_DEFAULT_MS,
  RUNTIME_BOUNDS,
  boundDecision,
  complexityValue,
  decide,
  intentRulesSchema,
  intentValue,
  isComplexity,
  isIntent,
  parseOperation,
  policyReads,
  resolveTier,
  scoreRouteFeatures,
  scorerTimeoutMs,
  tierTarget,
  tiersSchema,
  validateRoutePolicy,
  type Compute,
  type ComplexityFeature,
  type Effort,
  type IntentFeature,
  type PolicyMode,
  type RouteOperation,
  type ModelFeatureOutcome,
  type ModelFeatures,
  type RoutePolicyConfig,
  type TierMap,
} from "@foldedspacelabs/metistry-core";

const rulesSchema = z.object({
  fast_path: z.array(z.object({ match: z.string(), query: z.string() })).default([]),
  tiers: tiersSchema,
  commands: z.object({ deep_alias: z.string().default("deep") }).default({ deep_alias: "deep" }),
  /**
   * The intent tier's thresholds (PoC-20 phase 1,
   * docs/research/2026-09-21-intent-classification-tier.md §3.2 P2).
   *
   * Validated here, and NEVER read by `route()`: the rules below route by
   * prefix, regex and explicit command alone, `Route` is not extended, and a
   * test greps `route()` for exactly that (collectors/test/invariant4.test.ts).
   * Two readers use the numbers: `inbox-drain`, at the capture door, and —
   * since invariant 4 was ratified on 2026-09-26 — the local policy above
   * `route()` (T9-2), for which a verdict under the owner's threshold is the
   * feature `unsure` (docs/ops/dynamic-router.md §2). The policy runs in
   * shadow: it records what it would choose and serves nothing.
   *
   * It is parsed here because this is where `rules.yaml` is parsed, and the
   * schema's whole job is to fail AT LOAD: a threshold outside [0,1], or an
   * intent outside `packages/core`'s enum, is a startup error in the same
   * parse that already refuses an uncompilable `fast_path` regex — never a
   * surprise on the day somebody captures the wrong sentence.
   */
  intent: intentRulesSchema.optional(),
});

/**
 * `rules.yaml` as the console reads it. `policy` is the owner's table
 * (docs/ops/dynamic-router.md §4), validated by core's `validateRoutePolicy`
 * against the rest of this file — its tiers, its fast paths, its `intent:`
 * block — so it is set by `loadRules` and nowhere else. Absent = no policy,
 * the shipped behaviour.
 */
export type Rules = z.infer<typeof rulesSchema> & { policy?: RoutePolicyConfig };
export type { TierMap };

/**
 * What a message is served as. `route()` makes the first three shapes with
 * `routed_by: "rule" | "override"`; a `policy`-routed one is made only by
 * `serveRoute` at `policy.mode: serve` (docs/ops/dynamic-router.md §6,
 * "`inbound_messages.meta.route` at serve"), and carries the three additive
 * fields the drain builds the turn from — never a model the policy named:
 * `model` is the tier's, resolved here exactly as for any other route.
 */
export type Route =
  | { kind: "fast_path"; query: string; routed_by: "rule" | "policy"; policy_row?: string }
  | { kind: "note"; text: string; routed_by: "rule" }
  | {
      kind: "model";
      tier: string;
      model: string;
      effort: Effort;
      text: string;
      routed_by: "rule" | "override" | "policy";
      operation?: RouteOperation;
      tool_calls?: number;
      policy_row?: string;
    };

export function loadRules(yamlText: string): Rules {
  const doc: unknown = parseYaml(yamlText);
  const parsed = rulesSchema.safeParse(doc);
  if (!parsed.success) throw new Error(`invalid rules.yaml: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  const rules: Rules = parsed.data;
  for (const r of rules.fast_path) new RegExp(r.match, "i"); // fail at load, not per message
  // The policy block (T9-2): refused at load, every refusal naming its field,
  // in this same parse — never a surprise on a message. `policy:` with
  // nothing under it is the block commented out, and absent means off.
  const block = typeof doc === "object" && doc !== null ? (doc as Record<string, unknown>).policy : undefined;
  if (block !== undefined && block !== null) {
    const p = validateRoutePolicy(block, { tiers: Object.keys(rules.tiers), fastPathQueries: rules.fast_path.map((r) => r.query), intentRules: rules.intent !== undefined });
    if (!p.ok) throw new Error(`invalid rules.yaml: ${p.errors.join("; ")}`);
    rules.policy = p.policy;
  }
  return rules;
}

/** A model route for a tier NAME, resolved through the map (an unknown name lands on `default`, never on an invented model). */
function modelRoute(tiers: TierMap, name: string | undefined, text: string, routed_by: "rule" | "override"): Route & { kind: "model" } {
  const t = resolveTier(tiers, name);
  return { kind: "model", tier: t.tier, model: t.model, effort: t.effort, text, routed_by };
}

// ---- The route record: the decision, in shadow (docs/ops/dynamic-router.md §6, T9-1) ----
//
// Invariant 4 as ratified on 2026-09-26: "every choice is recorded with its
// reasons, and with the policy absent or failing every request takes the
// rules' default". This is the recording half, and it is deliberately
// OUTSIDE `route()`: the rules below decide what is served, byte for byte as
// they did before any of this existed, and nothing in this section can reach
// that decision — it takes the `Route` the rules already returned and
// describes it, beside what a policy WOULD have chosen.
//
// The seam — `RoutePolicy` — was built first (T9-1), so the consultation's
// deadline, its failure modes and its record were tested before anything
// could choose: a stub that answers, throws or never resolves leaves the
// served route untouched, and T9-1's tests hold that at the HTTP door. The
// policy that fills it is the owner's table in `rules.yaml` `policy:`
// (T9-2, `makeRoutePolicy` below, over core's `router-policy.ts`); with no
// block every row reads `policy.outcome: "absent"`, as before. In
// `mode: shadow` (the default) it chooses, the choice is recorded, and the
// rules' route is what is served. In `mode: serve` (T9-4, `serveRoute`) a
// choice on the fall-through is served — written to the record first.
//
// It sits above `route()` on purpose: `route()` is the rules alone, and
// apps/console/test/invariant4.test.ts holds that every rule is served
// identically with any policy wired.

/** The five words `route_report` counts a served route by — the four the rules make, and `policy` (T9-4; reads 0 until then). */
export type ServedKind = "note" | "fast_path" | "override" | "default" | "policy";

/** The eight outcomes of a consultation (docs/ops/dynamic-router.md §5). `route_report` emits a row for each, zeros included. */
export const POLICY_OUTCOMES = ["not_consulted", "counterfactual", "absent", "chosen", "no_match", "out_of_bounds", "timeout", "failed"] as const;
export type PolicyOutcome = (typeof POLICY_OUTCOMES)[number];

/** §4's `timeout_ms` default: the whole consultation — features, table, bounds — or the rules' default. A policy built from `rules.yaml` carries the owner's `policy.timeout_ms` (50–2000) instead. */
export const POLICY_TIMEOUT_MS = POLICY_TIMEOUT_DEFAULT_MS;

/** How far back a previous message may be for `reask` to fire (§2). */
export const REASK_WINDOW_MS = 30 * 60_000; // limit: fixed — §2's feature definition, not an install's policy
/** The word-set overlap at which a message is the same question again (§2). */
export const REASK_JACCARD = 0.5; // limit: fixed — §2's feature definition

/** What a policy proposes for one message: an operation from §3's closed vocabulary and a tier name — never a model. */
export interface PolicyChoice {
  operation: string;
  tier?: string;
  tool_calls?: number;
}

/** What a policy answers. The table and its bounds are T9-2's; T9-1 only needs the shape, so a malformed answer is a `failed` consultation. */
export type PolicyAnswer =
  | { outcome: "chosen"; row: string; chosen: PolicyChoice }
  | { outcome: "no_match" }
  | { outcome: "out_of_bounds"; row: string; chosen: PolicyChoice; bounded_by: (typeof RUNTIME_BOUNDS)[number] };

/** The cheap features (§2): no model call, and no message text — `reask` is computed from the text and recorded as the boolean alone. */
export interface RouteFeatures {
  words: number;
  attachments: number;
  /** absent when the features query failed */
  thread_turns?: number;
  recent_failures?: number;
  reask?: boolean;
  /** the model features (T9-2), present only when the policy's table reads them: the scorer's outcome and numbers, never text */
  intent?: IntentFeature;
  complexity?: ComplexityFeature;
}

/** The thread's session, as the session rule (§1, R10) will need it: a policy may not move an active session to another model. */
export interface SessionFacts {
  active: boolean;
  provider: string | null;
  model: string | null;
}

/** The one row `seed/queries/route_features.yaml` returns (invariant 3: the router reads no table itself). */
export interface ThreadFacts {
  session_active: boolean;
  session_turns: number;
  session_provider: string | null;
  session_model: string | null;
  recent_failures: number;
  prev_ts: Date | string | null;
  /** compared here and dropped — never recorded */
  prev_text: string | null;
}

/**
 * The local policy (T9-2). Consulted on the fall-through and, AFTER the 202,
 * as a counterfactual on an override; never on `/note` or a fast path. It
 * sees counts and names only, never the message.
 */
export interface RoutePolicy {
  /** `policy.mode`: `shadow` (absent) records what it would choose and serves the rules' route; `serve` makes its choice on the fall-through the route (T9-4). */
  mode?: PolicyMode;
  decide(input: { features: RouteFeatures; session: SessionFacts; served: ServedKind }): PolicyAnswer | Promise<PolicyAnswer>;
  /**
   * The model features the table reads (§2) — `intent`, `complexity` — from
   * the text, on the local scorer. Called inside the consultation's one
   * deadline, concurrently with the features query, and only when the
   * policy is consulted. The text goes to the on-machine scorer and nowhere
   * else; what comes back is names and numbers, checked again here before
   * any of it is recorded. Absent = the table reads no model feature.
   */
  modelFeatures?: (text: string, at: Date) => Promise<ModelFeatures>;
  /** `policy.timeout_ms`; absent = `POLICY_TIMEOUT_MS` */
  timeoutMs?: number;
  /** `policy.tiers`, cheapest first — the allow-list: an answer naming any other tier is not a decision. Recorded so the report can tell a higher tier from a lower one */
  tiers?: readonly string[];
  /** `policy.caps.tool_calls` — an answer granting more is not a decision */
  toolCallsCap?: number;
}

/** The derived kind `route_report` counts: `override` and `default` are both `kind: "model"` on the wire. */
export function servedKindOf(r: Route): ServedKind {
  if ((r as { routed_by: string }).routed_by === "policy") return "policy";
  if (r.kind === "note") return "note";
  if (r.kind === "fast_path") return "fast_path";
  return r.routed_by === "override" ? "override" : "default";
}

/** Whitespace-separated words of the trimmed text — the same count `route_report`'s length buckets take in SQL. */
export function wordCount(text: string): number {
  const t = text.trim();
  return t === "" ? 0 : t.split(/\s+/).length;
}

/** §2's `reask` word set: lower-cased runs of letters and digits, tokens under two characters dropped. */
export function reaskTokens(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => [...t].length >= 2));
}

/** The previous inbound message in the thread arrived within 30 minutes and its word set overlaps this one's at Jaccard ≥ 0.5. */
export function isReask(text: string, prevText: string | null, prevTs: Date | string | null, at: Date): boolean {
  if (prevText === null || prevTs === null) return false;
  const gap = at.getTime() - new Date(prevTs).getTime();
  if (!Number.isFinite(gap) || gap < 0 || gap > REASK_WINDOW_MS) return false;
  const a = reaskTokens(text);
  const b = reaskTokens(prevText);
  if (a.size === 0 || b.size === 0) return false;
  let both = 0;
  for (const t of a) if (b.has(t)) both++;
  return both / (a.size + b.size - both) >= REASK_JACCARD;
}

/** The cheap features, from the text the rules saw and the thread's facts (null = the features query failed or ran out of time). */
export function routeFeatures(text: string, attachments: number, facts: ThreadFacts | null, at: Date): RouteFeatures {
  const f: RouteFeatures = { words: wordCount(text), attachments };
  if (facts) {
    f.thread_turns = facts.session_active ? facts.session_turns : 0;
    f.recent_failures = Math.min(5, Math.max(0, facts.recent_failures));
    f.reask = isReask(text, facts.prev_text, facts.prev_ts, at);
  }
  return f;
}

/** Coerce `route_features`' row (pg returns bigint counts as strings) into facts, or null when there is no usable row. */
export function threadFactsOf(row: Record<string, unknown> | undefined): ThreadFacts | null {
  if (!row) return null;
  const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const s = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
  return {
    session_active: row.session_active === true,
    session_turns: n(row.session_turns),
    session_provider: s(row.session_provider),
    session_model: s(row.session_model),
    recent_failures: n(row.recent_failures),
    prev_ts: row.prev_ts instanceof Date || typeof row.prev_ts === "string" ? row.prev_ts : null,
    prev_text: typeof row.prev_text === "string" ? row.prev_text : null,
  };
}

// Names from the owner's own vocabulary, and nothing else, reach the record:
// a policy that answered with a sentence would be a way to put text in a row
// Run detail shows, so an answer that is not name-shaped is not an answer.
const ROW_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Validate what a policy answered; a string is the reason it is not a
 * decision (→ `failed`). This is the bounds check at run time, on WHATEVER
 * answered (§4, "load-time validation, then the bounds check at run time"):
 * an operation outside the vocabulary, a tier outside `tiers:` or outside
 * the policy's own allow-list, a tool budget above its cap — none of them
 * is a choice, and none of them reaches the record as one.
 */
function checkAnswer(a: unknown, rules: Rules, policy: Pick<RoutePolicy, "tiers" | "toolCallsCap">): PolicyAnswer | string {
  const tiers = rules.tiers;
  if (typeof a !== "object" || a === null) return "the policy answered something that is not a decision";
  const o = a as Record<string, unknown>;
  if (o.outcome === "no_match") return { outcome: "no_match" };
  if (o.outcome !== "chosen" && o.outcome !== "out_of_bounds") return "the policy answered an outcome that is not chosen, no_match or out_of_bounds";
  if (typeof o.row !== "string" || o.row.length > 64 || !ROW_ID_RE.test(o.row)) return "the policy named no table row";
  const c = o.chosen as Record<string, unknown> | null | undefined;
  if (typeof c !== "object" || c === null) return "the policy chose nothing";
  // The vocabulary is core's, spelled exactly (`parseOperation`). T9-1 held
  // this with a shape regex whose head could not contain `_`, which refused
  // every `fast_path:<query>` choice as garbage.
  if (typeof c.operation !== "string" || c.operation.length > 80) return "the policy chose no operation";
  if (!parseOperation(c.operation)) return "the policy chose an operation outside the vocabulary";
  const chosen: PolicyChoice = { operation: c.operation };
  const op = parseOperation(c.operation)!;
  const runsModel = op.form !== "fast_path:<query>";
  // A fast path runs no model, so it has no tier and no tool budget; every
  // other operation runs one on a tier the allow-list names (§4, `then`).
  if (runsModel && c.tier === undefined) return "the policy chose a model operation with no tier";
  if (!runsModel && c.tier !== undefined) return "the policy gave a tier to an operation that runs no model";
  // A fast path the policy chooses is one the owner's rules already answer
  // from (§3) — it can reach no query the rules could not.
  if (op.form === "fast_path:<query>" && !rules.fast_path.some((r) => r.query === op.query)) return "the policy chose a fast path no fast_path: rule names";
  if (c.tool_calls !== undefined && (op.form === "answer" || !runsModel)) return "the policy gave a tool_calls to an operation that makes no tool calls";
  if (c.tier !== undefined) {
    if (typeof c.tier !== "string" || !Object.hasOwn(tiers, c.tier)) return "the policy named a tier outside tiers:";
    if (policy.tiers && !policy.tiers.includes(c.tier)) return "the policy named a tier outside policy.tiers";
    chosen.tier = c.tier;
  }
  if (c.tool_calls !== undefined) {
    if (typeof c.tool_calls !== "number" || !Number.isInteger(c.tool_calls) || c.tool_calls < 0 || c.tool_calls > 10_000) return "the policy chose a tool_calls that is not a count";
    if (policy.toolCallsCap !== undefined && c.tool_calls > policy.toolCallsCap) return "the policy chose a tool_calls above caps.tool_calls";
    chosen.tool_calls = c.tool_calls;
  }
  if (o.outcome === "chosen") return { outcome: "chosen", row: o.row, chosen };
  const bounded = o.bounded_by;
  if (typeof bounded !== "string" || !(RUNTIME_BOUNDS as readonly string[]).includes(bounded)) return "the policy named no bound it was held to";
  return { outcome: "out_of_bounds", row: o.row, chosen, bounded_by: bounded as (typeof RUNTIME_BOUNDS)[number] };
}

const MODEL_FEATURE_OUTCOMES: readonly ModelFeatureOutcome[] = ["scored", "below_threshold", "guarded", "unavailable"];
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/; // a provider or model id: a name, never a sentence
const CODE_RE = /^[a-z_]{1,40}$/;

/**
 * What a policy's scorer answered, re-checked field by field before any of it
 * is recorded: the outcome from its closed list, the verdict from its closed
 * enum, the numbers finite, the provenance name-shaped and the reason a code.
 * Anything else is dropped — the record is read in Run detail, so a scorer
 * cannot put a sentence in it. The table reads the values core derives from
 * these (`intentValue`, `complexityValue`), so a dropped field is an absent
 * feature, never a misfire.
 */
function modelFeaturesOf(m: unknown): Pick<RouteFeatures, "intent" | "complexity"> {
  const out: Pick<RouteFeatures, "intent" | "complexity"> = {};
  if (typeof m !== "object" || m === null) return out;
  const one = (v: unknown, verdict: "intent" | "class"): Record<string, unknown> | undefined => {
    if (typeof v !== "object" || v === null) return undefined;
    const o = v as Record<string, unknown>;
    if (!MODEL_FEATURE_OUTCOMES.includes(o.outcome as ModelFeatureOutcome)) return undefined;
    const f: Record<string, unknown> = { outcome: o.outcome };
    const named = verdict === "intent" ? isIntent(o.intent) : isComplexity(o.class);
    if (named) f[verdict] = verdict === "intent" ? o.intent : o.class;
    for (const k of ["confidence", "threshold"] as const) if (typeof o[k] === "number" && Number.isFinite(o[k]) && o[k] >= 0 && o[k] <= 1) f[k] = o[k];
    if (typeof o.latency_ms === "number" && Number.isFinite(o.latency_ms) && o.latency_ms >= 0) f.latency_ms = Math.round(o.latency_ms);
    for (const k of ["provider", "model"] as const) if (typeof o[k] === "string" && NAME_RE.test(o[k])) f[k] = o[k];
    if (typeof o.reason === "string" && CODE_RE.test(o.reason)) f.reason = o.reason;
    return f;
  };
  const r = m as Record<string, unknown>;
  const intent = one(r.intent, "intent");
  const complexity = one(r.complexity, "class");
  if (intent) out.intent = intent as unknown as IntentFeature;
  if (complexity) out.complexity = complexity as unknown as ComplexityFeature;
  return out;
}

/** One consultation's record: the `runs` row's `ok`/`error` and its `meta` (v1, §6). Never the message text. */
export interface RouteRecord {
  tool: ServedKind;
  ok: boolean;
  error?: string;
  meta: Record<string, unknown>;
}

/**
 * A consultation: its record, and what is served. `route` is the rules'
 * route, byte for byte, in every case but one — `phase: "serve"`, the rules'
 * fall-through, and a `chosen` decision — when it is the policy's. Every
 * failure, timeout, no-match or bound serves the rules' default (§5). Kept
 * apart from the record because a `Route` carries the text and the record
 * never does.
 */
interface Consultation {
  record: RouteRecord;
  route: Route;
}

export interface ConsultInput {
  rules: Rules;
  /** the route the rules served — already written, already answered */
  route: Route;
  /** the text as posted: counted and compared here, never recorded */
  text: string;
  attachments: number;
  thread: string;
  messageId: number;
  /** absent = no `policy:` block — the shipped behaviour */
  policy?: RoutePolicy | undefined;
  /** runs `route_features` (the named query); a throw is a failed features query */
  loadFacts: () => Promise<ThreadFacts | null>;
  /** when the rules decided — what `reask`'s thirty minutes are measured to */
  at: Date;
  /** `policy.mode` in force: `serve` lets a chosen decision on the fall-through become the route. Absent = `shadow` */
  phase?: PolicyMode | undefined;
}

/** What the served route was, in the record's words: counts and names, and never the `text` a `Route` carries. */
function servedOf(r: Route): Record<string, unknown> {
  if (r.kind === "note") return { kind: "note", routed_by: r.routed_by };
  const row = r.policy_row !== undefined ? { policy_row: r.policy_row } : {};
  if (r.kind === "fast_path") return { kind: "fast_path", query: r.query, operation: `fast_path:${r.query}`, routed_by: r.routed_by, ...row };
  return { kind: "model", tier: r.tier, operation: r.operation ?? "tools", ...(r.tool_calls !== undefined ? { tool_calls: r.tool_calls } : {}), routed_by: r.routed_by, ...row };
}

/**
 * A chosen decision as the route it serves (§6, §7.3). The operation and the
 * tier are the policy's — already checked against the vocabulary, `tiers:`,
 * `policy.tiers` and the caps (`checkAnswer`), and against the session and
 * the registries (`boundDecision`) — and the MODEL is the tier's, resolved
 * through the same map every other route resolves through. A fast path is
 * answered by the console as an R4 match is.
 */
function policyRoute(rules: Rules, fallThrough: Route & { kind: "model" }, row: string, chosen: PolicyChoice): Route {
  const op = parseOperation(chosen.operation)!;
  if (op.form === "fast_path:<query>") return { kind: "fast_path", query: op.query, routed_by: "policy", policy_row: row };
  const t = resolveTier(rules.tiers, chosen.tier);
  return {
    kind: "model",
    tier: t.tier,
    model: t.model,
    effort: t.effort,
    text: fallThrough.text,
    routed_by: "policy",
    operation: chosen.operation as RouteOperation,
    ...(chosen.tool_calls !== undefined ? { tool_calls: chosen.tool_calls } : {}),
    policy_row: row,
  };
}

const TIMED_OUT = Symbol("timed out");

/** `work` or `TIMED_OUT`, whichever settles first. The work is not cancelled — a policy that never resolves is simply no longer waited for. */
async function withDeadline<T>(work: () => Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([work(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The consultation: the features, then the policy if there is one, all under
 * one deadline — and a record of it. In shadow it cannot change a route,
 * because the route was served before it was called (docs/ops/dynamic-router.md
 * §6, "Shadow does not wait"); at serve its `route` is what `serveRoute`
 * writes onto the message. Every failure is a value here, never a throw: a
 * policy that throws, answers garbage or never answers is `failed` or
 * `timeout`, and the served route is what the rules said.
 */
export async function consultRoute(input: ConsultInput): Promise<RouteRecord> {
  return (await consult(input)).record;
}

async function consult(input: ConsultInput): Promise<Consultation> {
  const { rules, route: served, policy } = input;
  const kind = servedKindOf(served);
  const defaultTier = resolveTier(rules.tiers, undefined).tier;
  const phase: PolicyMode = input.phase ?? "shadow";
  const base: Record<string, unknown> = {
    v: 1,
    message_id: input.messageId,
    thread: input.thread,
    phase,
    rules: { served: kind, default_tier: defaultTier },
    served: servedOf(served),
  };
  // R1 and R4 are served without the policy (§1), and so is every row while
  // no `policy:` block exists; their features are recorded all the same,
  // best effort, so the report has one population to read.
  const consulted = policy !== undefined && (kind === "default" || kind === "override");
  const timeoutMs = policy?.timeoutMs ?? POLICY_TIMEOUT_MS;

  type Step = { features: RouteFeatures; session: SessionFacts; factsError?: string; answer?: PolicyAnswer | string };
  const step = async (): Promise<Step> => {
    // The model features start WITH the features query, not after it: one
    // deadline covers both (§4 `timeout_ms`). Awaited below; a rejection a
    // failed features query pre-empts is handled here so it never surfaces.
    const scoring = consulted && policy.modelFeatures ? policy.modelFeatures(input.text, input.at) : undefined;
    scoring?.catch(() => {});
    let facts: ThreadFacts | null = null;
    let factsError: string | undefined;
    try {
      facts = await input.loadFacts();
      if (facts === null) factsError = "route_features returned no row";
    } catch (err) {
      factsError = `route_features failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    const features = routeFeatures(input.text, input.attachments, facts, input.at);
    const session: SessionFacts = { active: facts?.session_active ?? false, provider: facts?.session_provider ?? null, model: facts?.session_model ?? null };
    if (!consulted || factsError !== undefined) return { features, session, ...(factsError !== undefined ? { factsError } : {}) };
    let answer: PolicyAnswer | string;
    try {
      if (scoring) Object.assign(features, modelFeaturesOf(await scoring));
      answer = checkAnswer(await policy.decide({ features, session, served: kind }), rules, policy);
    } catch (err) {
      answer = `the policy threw: ${err instanceof Error ? err.message : String(err)}`;
    }
    return { features, session, answer };
  };

  const got = await withDeadline(step, timeoutMs);
  const cheap: RouteFeatures = { words: wordCount(input.text), attachments: input.attachments };

  if (!consulted) {
    const features = got === TIMED_OUT ? cheap : got.features;
    const factsError = got === TIMED_OUT ? `route_features ran past ${timeoutMs} ms` : got.factsError;
    const bounded_by = kind === "note" ? ["command:note"] : served.kind === "fast_path" ? [`fast_path:${served.query}`] : [];
    return {
      record: {
        tool: kind,
        ok: true,
        meta: {
          ...base,
          features,
          ...(factsError !== undefined ? { features_error: factsError } : {}),
          policy: { outcome: kind === "note" || kind === "fast_path" ? "not_consulted" : "absent", bounded_by },
          agrees: null,
        },
      },
      route: served,
    };
  }

  if (got === TIMED_OUT) {
    const error = `the consultation ran past ${timeoutMs} ms`;
    return { record: { tool: kind, ok: false, error, meta: { ...base, features: cheap, policy: { outcome: "timeout", bounded_by: ["timeout"] }, agrees: null } }, route: served };
  }
  const session = got.session;
  const tiersOf = policy.tiers ? { tiers: [...policy.tiers] } : {};
  if (got.factsError !== undefined || typeof got.answer !== "object") {
    const error = got.factsError ?? (typeof got.answer === "string" ? got.answer : "the policy did not answer");
    return { record: { tool: kind, ok: false, error, meta: { ...base, features: got.features, policy: { outcome: "failed", bounded_by: ["failed"], session, ...tiersOf }, agrees: null } }, route: served };
  }

  const answer = got.answer;
  // At serve, and only on the fall-through, a chosen decision IS the route
  // (§7.3). An override stays counterfactual whatever the mode: the owner
  // chose, and the rules win.
  const route: Route = phase === "serve" && kind === "default" && served.kind === "model" && answer.outcome === "chosen" ? policyRoute(rules, served, answer.row, answer.chosen) : served;
  const servedTier = route.kind === "model" ? route.tier : null;
  const servedOp = route.kind === "model" ? (route.operation ?? "tools") : `fast_path:${route.kind === "fast_path" ? route.query : ""}`;
  // What serve would have done with this answer: the row's choice when it
  // passed the bounds, and the rules' default otherwise (§5).
  const would = answer.outcome === "chosen" ? answer.chosen : { operation: "tools", tier: defaultTier };
  const agrees = would.operation === servedOp && (would.tier ?? null) === servedTier;
  const policyMeta: Record<string, unknown> = {
    outcome: kind === "override" ? "counterfactual" : answer.outcome,
    ...(kind === "override" ? { answer: answer.outcome } : {}),
    ...(answer.outcome !== "no_match" ? { row: answer.row, chosen: answer.chosen } : {}),
    bounded_by: kind === "override" ? ["override", ...(answer.outcome === "out_of_bounds" ? [answer.bounded_by] : [])] : answer.outcome === "out_of_bounds" ? [answer.bounded_by] : [],
    would_serve: would,
    session,
    ...tiersOf,
  };
  const policyServed = route !== served;
  return {
    record: { tool: servedKindOf(route), ok: true, meta: { ...base, ...(policyServed ? { served: servedOf(route) } : {}), features: got.features, policy: policyMeta, agrees } },
    route,
  };
}

/** Where `serveRoute` writes the route row: the two phases of `runs` (core's `startRun`/`finishRun`), injected so a failed write is testable. */
export interface RouteRecorder {
  start(meta: Record<string, unknown>, tool: ServedKind): Promise<number>;
  finish(runId: number, rec: RouteRecord): Promise<void>;
}

/**
 * The consultation at `policy.mode: serve` (docs/ops/dynamic-router.md §7.3):
 * it runs BEFORE the message is written, inside `timeout_ms`, and its row is
 * written first — so no choice is served that is not on the record (§5, "a
 * recording failure is a failure"). What it returns is the route to write
 * onto the message:
 *
 *   * the policy's, when the rules fell through, a row was chosen, it passed
 *     the bounds, and its record was written;
 *   * the rules' own route, byte for byte, in every other case — the rules
 *     decided (a command, a fast path, an override, the picker); the policy
 *     is absent, timed out, threw, answered garbage, matched no row or was
 *     held by a bound; or either phase of its row could not be written.
 *
 * It never throws: a failure here is the rules' default, never a failed
 * message.
 */
export async function serveRoute(input: ConsultInput, recorder: RouteRecorder, log: (line: string) => void = (l) => console.error(l)): Promise<Route> {
  const rules = input.route;
  if (servedKindOf(rules) !== "default" || input.policy === undefined) return rules;
  let runId: number;
  try {
    runId = await recorder.start({ v: 1, message_id: input.messageId, thread: input.thread, phase: "serve" }, servedKindOf(rules));
  } catch (err) {
    log(`route record not started, so the rules' route is served: ${err instanceof Error ? err.message : String(err)}`);
    return rules;
  }
  let c: Consultation;
  try {
    c = await consult({ ...input, phase: "serve" });
  } catch (err) {
    // consultRoute turns every failure into a value; this is the belt to its braces
    log(`route consultation threw, so the rules' route is served: ${err instanceof Error ? err.message : String(err)}`);
    return rules;
  }
  try {
    await recorder.finish(runId, c.record);
  } catch (err) {
    log(`route record not written, so the policy's choice is not served: ${err instanceof Error ? err.message : String(err)}`);
    return rules;
  }
  return c.route;
}

// ---- The policy (T9-2): the owner's table, bounded, in shadow ----------------
//
// `rules.yaml` `policy:` made into the `RoutePolicy` the consultation above
// asks (docs/ops/dynamic-router.md §2–§5). Everything that decides is core's
// and pure — `decide()` over the table, `boundDecision()` over the session
// and the registries — and this is only the wiring to the console's world:
// the live tier map, `compute.yaml` in force, the loaded queries and crews,
// and the one local scorer. With no `policy:` block there is no policy and
// every row reads `absent`, which is the shipped behaviour.

export interface RoutePolicyDeps {
  /** the LIVE rules object — `tiers` is swapped when `compute.yaml`'s assignments change (main.ts); `policy` and `intent` are the owner's */
  rules: Rules;
  /** `compute.yaml` in force: where a tier runs (the session rule) and which model scores (`assignments.intent`) */
  compute?: (() => Compute) | undefined;
  /** where a scorer provider's `auth.secret` resolves */
  secretEnv?: NodeJS.ProcessEnv | undefined;
  fetchFn?: typeof fetch | undefined;
  /** the named query is loaded now — a `fast_path:<query>` choice whose query is not is `out_of_bounds` (`queries`) */
  hasQuery: (name: string) => boolean;
  /** the crew's manifest is loaded now — a `delegate:<crew>` choice whose crew is not is `out_of_bounds` (`crew_registry`) */
  hasCrew: (name: string) => boolean;
}

/**
 * The owner's table as a `RoutePolicy`, or undefined when `rules.yaml` has
 * no `policy:` block. In `mode: shadow` whatever this chooses is recorded and
 * not served; in `mode: serve` a chosen decision on the fall-through is the
 * route (`serveRoute`).
 *
 * The scorer is asked only for what some row reads (`policyReads`, once),
 * with each call cut off inside the owner's deadline (`scorerTimeoutMs`), so
 * a slow scorer is an absent feature and the table still decides.
 */
export function makeRoutePolicy(deps: RoutePolicyDeps): RoutePolicy | undefined {
  const policy = deps.rules.policy;
  if (!policy) return undefined;
  const reads = policyReads(policy);
  const access = {
    ...(deps.compute ? { compute: deps.compute } : {}),
    ...(deps.secretEnv ? { secretEnv: deps.secretEnv } : {}),
    ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
  };
  const timeoutMs = scorerTimeoutMs(policy.timeout_ms);
  const modelFeatures = (text: string, at: Date): Promise<ModelFeatures> =>
    scoreRouteFeatures(access, text, { reads, intentRules: deps.rules.intent, complexityMinConfidence: policy.complexity?.min_confidence, timeoutMs, now: at });
  return {
    mode: policy.mode,
    timeoutMs: policy.timeout_ms,
    tiers: policy.tiers,
    toolCallsCap: policy.caps.tool_calls,
    ...(reads.intent || reads.complexity ? { modelFeatures } : {}),
    decide: ({ features, session }) => {
      const decision = decide(policy, {
        words: features.words,
        attachments: features.attachments,
        thread_turns: features.thread_turns,
        recent_failures: features.recent_failures,
        reask: features.reask,
        intent: intentValue(features.intent),
        complexity: complexityValue(features.complexity),
      });
      return boundDecision(policy, decision, {
        session,
        resolve: (tier) => tierTarget(deps.compute?.(), deps.rules.tiers, tier),
        hasQuery: deps.hasQuery,
        hasCrew: deps.hasCrew,
      });
    },
  };
}

/**
 * `tierHint` is the composer's picker (a `tier` on `POST /message`): an
 * explicit user choice for THIS message, applied only where the message would
 * otherwise take the default tier. Text commands still win — picking "deep"
 * must not turn `/note buy milk` into a model turn, and must not spend a model
 * on a question the fast path answers for free.
 */
export function route(rules: Rules, text: string, tierHint?: string | null): Route {
  const trimmed = text.trim();

  // /note <text> — straight to inbox, no model, acknowledged instantly (§4.1)
  const note = /^\/note\s+([\s\S]+)$/.exec(trimmed);
  if (note?.[1]) return { kind: "note", text: note[1], routed_by: "rule" };

  // explicit tier overrides: /model <tag> <text> and the shipped /deep alias
  const model = /^\/model\s+(\S+)\s+([\s\S]+)$/.exec(trimmed);
  if (model?.[1] && model[2]) {
    if (Object.hasOwn(rules.tiers, model[1])) return modelRoute(rules.tiers, model[1], model[2], "override");
  }
  const deep = new RegExp(`^\\/${rules.commands.deep_alias}\\s+([\\s\\S]+)$`).exec(trimmed);
  if (deep?.[1]) return modelRoute(rules.tiers, "deep", deep[1], "override");

  for (const r of rules.fast_path) {
    if (new RegExp(r.match, "i").test(trimmed)) return { kind: "fast_path", query: r.query, routed_by: "rule" };
  }

  if (typeof tierHint === "string" && Object.hasOwn(rules.tiers, tierHint)) {
    return modelRoute(rules.tiers, tierHint, trimmed, "override");
  }
  return modelRoute(rules.tiers, undefined, trimmed, "rule");
}
