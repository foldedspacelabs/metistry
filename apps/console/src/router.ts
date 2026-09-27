// The router (invariant 4): deterministic — prefix, regex, explicit
// commands only. No model decides which model to use. Lives in the console
// (CRIT-3: no third container). First match wins.
//
// What the router picks is a TIER NAME. A tier is a (model, effort) pair
// (core's `tiers.ts`, cost research decision 2); the router resolves it here
// for the record it writes onto the message, and the drain resolves the same
// name again at the point of the call. One name, two readers of the same
// `tiers:` block — instance overlay (D4) applies to both.

import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { intentRulesSchema, resolveTier, tiersSchema, type Effort, type TierMap } from "@foldedspacelabs/metistry-core";

const rulesSchema = z.object({
  fast_path: z.array(z.object({ match: z.string(), query: z.string() })).default([]),
  tiers: tiersSchema,
  commands: z.object({ deep_alias: z.string().default("deep") }).default({ deep_alias: "deep" }),
  /**
   * The intent tier's thresholds (PoC-20 phase 1,
   * docs/research/2026-09-21-intent-classification-tier.md §3.2 P2).
   *
   * VALIDATED here and read NOWHERE in this file. That is not an oversight and
   * a test greps for it: `route()` never sees a classifier verdict, `Route` is
   * not extended, and the composer door is PoC-20 phase 2, which needs the
   * owner's ruling on invariant 4's wording first (§6 question 1). What reads
   * these numbers today is `inbox-drain`, at the capture door, which §4.1
   * rates as costing no invariant argument at all.
   *
   * It is parsed here because this is where `rules.yaml` is parsed, and the
   * schema's whole job is to fail AT LOAD: a threshold outside [0,1], or an
   * intent outside `packages/core`'s enum, is a startup error in the same
   * parse that already refuses an uncompilable `fast_path` regex — never a
   * surprise on the day somebody captures the wrong sentence.
   */
  intent: intentRulesSchema.optional(),
});

export type Rules = z.infer<typeof rulesSchema>;
export type { TierMap };

export type Route =
  | { kind: "fast_path"; query: string; routed_by: "rule" }
  | { kind: "note"; text: string; routed_by: "rule" }
  | { kind: "model"; tier: string; model: string; effort: Effort; text: string; routed_by: "rule" | "override" };

export function loadRules(yamlText: string): Rules {
  const parsed = rulesSchema.safeParse(parseYaml(yamlText));
  if (!parsed.success) throw new Error(`invalid rules.yaml: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  const rules = parsed.data;
  for (const r of rules.fast_path) new RegExp(r.match, "i"); // fail at load, not per message
  return rules;
}

/** A model route for a tier NAME, resolved through the map (an unknown name lands on `default`, never on an invented model). */
function modelRoute(tiers: TierMap, name: string | undefined, text: string, routed_by: "rule" | "override"): Route {
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
// No policy ships yet (T9-2 builds the table in `rules.yaml`), so every row
// on a real install reads `policy.outcome: "absent"`. The seam — `RoutePolicy`
// — exists now so the consultation's deadline, its failure modes and its
// record are built and tested before anything can choose: a stub that
// answers, throws or never resolves must leave the served route untouched,
// and T9-1's tests hold that at the HTTP door.
//
// It sits above `route()` on purpose: collectors/test/invariant4.test.ts reads
// `route()` to the end of this file and requires it to stay blind to any
// classifier, and the record is not part of the rules.

/** The five words `route_report` counts a served route by — the four the rules make, and `policy` (T9-4; reads 0 until then). */
export type ServedKind = "note" | "fast_path" | "override" | "default" | "policy";

/** The eight outcomes of a consultation (docs/ops/dynamic-router.md §5). `route_report` emits a row for each, zeros included. */
export const POLICY_OUTCOMES = ["not_consulted", "counterfactual", "absent", "chosen", "no_match", "out_of_bounds", "timeout", "failed"] as const;
export type PolicyOutcome = (typeof POLICY_OUTCOMES)[number];

/** §4's `timeout_ms` default: the whole consultation — features, table, bounds — or the rules' default. The intent research's p95 bar for the composer path. */
export const POLICY_TIMEOUT_MS = 400; // limit: fixed — the spec's default; T9-2 reads the owner's `policy.timeout_ms` (50–2000) in its place

/** How far back a previous message may be for `reask` to fire (§2). */
export const REASK_WINDOW_MS = 30 * 60_000; // limit: fixed — §2's feature definition, not an install's policy
/** The word-set overlap at which a message is the same question again (§2). */
export const REASK_JACCARD = 0.5; // limit: fixed — §2's feature definition

/** Why a bounded choice was refused (§5's `out_of_bounds` row). The run-time ones only — the load-time refusals never reach a message. */
const RUNTIME_BOUNDS = ["session", "crew_registry", "queries"] as const;

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
  decide(input: { features: RouteFeatures; session: SessionFacts; served: ServedKind }): PolicyAnswer | Promise<PolicyAnswer>;
  /** `policy.timeout_ms`; absent = `POLICY_TIMEOUT_MS` */
  timeoutMs?: number;
  /** `policy.tiers`, cheapest first — recorded so the report can tell a higher tier from a lower one */
  tiers?: readonly string[];
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
const OPERATION_RE = /^[a-z]+(?::[a-z0-9_-]+)?$/;

/** Validate what a policy answered; a string is the reason it is not a decision (→ `failed`). */
function checkAnswer(a: unknown, tiers: TierMap): PolicyAnswer | string {
  if (typeof a !== "object" || a === null) return "the policy answered something that is not a decision";
  const o = a as Record<string, unknown>;
  if (o.outcome === "no_match") return { outcome: "no_match" };
  if (o.outcome !== "chosen" && o.outcome !== "out_of_bounds") return "the policy answered an outcome that is not chosen, no_match or out_of_bounds";
  if (typeof o.row !== "string" || o.row.length > 64 || !ROW_ID_RE.test(o.row)) return "the policy named no table row";
  const c = o.chosen as Record<string, unknown> | null | undefined;
  if (typeof c !== "object" || c === null) return "the policy chose nothing";
  if (typeof c.operation !== "string" || c.operation.length > 80 || !OPERATION_RE.test(c.operation)) return "the policy chose no operation";
  const chosen: PolicyChoice = { operation: c.operation };
  if (c.tier !== undefined) {
    if (typeof c.tier !== "string" || !Object.hasOwn(tiers, c.tier)) return "the policy named a tier outside tiers:";
    chosen.tier = c.tier;
  }
  if (c.tool_calls !== undefined) {
    if (typeof c.tool_calls !== "number" || !Number.isInteger(c.tool_calls) || c.tool_calls < 0 || c.tool_calls > 10_000) return "the policy chose a tool_calls that is not a count";
    chosen.tool_calls = c.tool_calls;
  }
  if (o.outcome === "chosen") return { outcome: "chosen", row: o.row, chosen };
  const bounded = o.bounded_by;
  if (typeof bounded !== "string" || !(RUNTIME_BOUNDS as readonly string[]).includes(bounded)) return "the policy named no bound it was held to";
  return { outcome: "out_of_bounds", row: o.row, chosen, bounded_by: bounded as (typeof RUNTIME_BOUNDS)[number] };
}

/** One consultation's record: the `runs` row's `ok`/`error` and its `meta` (v1, §6). Never the message text. */
export interface RouteRecord {
  tool: ServedKind;
  ok: boolean;
  error?: string;
  meta: Record<string, unknown>;
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
}

/** What the served route was, in the record's words: counts and names, and never the `text` a `Route` carries. */
function servedOf(r: Route): Record<string, unknown> {
  if (r.kind === "note") return { kind: "note", routed_by: r.routed_by };
  if (r.kind === "fast_path") return { kind: "fast_path", query: r.query, operation: `fast_path:${r.query}`, routed_by: r.routed_by };
  return { kind: "model", tier: r.tier, operation: "tools", routed_by: r.routed_by };
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
 * The consultation, in shadow: the features, then the policy if there is
 * one, all under one deadline — and a record of it. It returns a record and
 * nothing else; it cannot change a route, because the route was served
 * before it was called (docs/ops/dynamic-router.md §6, "Shadow does not
 * wait"). Every failure is a value here, never a throw: a policy that throws,
 * answers garbage or never answers is `failed` or `timeout`, and the served
 * route is what the rules said.
 */
export async function consultRoute(input: ConsultInput): Promise<RouteRecord> {
  const { rules, route: served, policy } = input;
  const kind = servedKindOf(served);
  const defaultTier = resolveTier(rules.tiers, undefined).tier;
  const base: Record<string, unknown> = {
    v: 1,
    message_id: input.messageId,
    thread: input.thread,
    phase: "shadow",
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
      answer = checkAnswer(await policy.decide({ features, session, served: kind }), rules.tiers);
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
      tool: kind,
      ok: true,
      meta: {
        ...base,
        features,
        ...(factsError !== undefined ? { features_error: factsError } : {}),
        policy: { outcome: kind === "note" || kind === "fast_path" ? "not_consulted" : "absent", bounded_by },
        agrees: null,
      },
    };
  }

  if (got === TIMED_OUT) {
    const error = `the consultation ran past ${timeoutMs} ms`;
    return { tool: kind, ok: false, error, meta: { ...base, features: cheap, policy: { outcome: "timeout", bounded_by: ["timeout"] }, agrees: null } };
  }
  const session = got.session;
  const tiersOf = policy.tiers ? { tiers: [...policy.tiers] } : {};
  if (got.factsError !== undefined || typeof got.answer !== "object") {
    const error = got.factsError ?? (typeof got.answer === "string" ? got.answer : "the policy did not answer");
    return { tool: kind, ok: false, error, meta: { ...base, features: got.features, policy: { outcome: "failed", bounded_by: ["failed"], session, ...tiersOf }, agrees: null } };
  }

  const answer = got.answer;
  const servedTier = served.kind === "model" ? served.tier : null;
  const servedOp = served.kind === "model" ? "tools" : `fast_path:${served.kind === "fast_path" ? served.query : ""}`;
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
  return { tool: kind, ok: true, meta: { ...base, features: got.features, policy: policyMeta, agrees } };
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
