// The intent tier at the capture door — PoC-20 phase 1
// (docs/research/2026-09-21-intent-classification-tier.md §4.1, §5.2).
//
// This is the capture door and only the capture door. §4.1 ranks the four
// places a classifier could plug in by how much invariant argument each one
// costs, and this is the one that costs **none**: the tier already exists here
// (ruled 2026-09-01), a wrong verdict costs a mislabelled proposal card, and
// the row is still born of a click. The composer door — the one §3.2 is about
// — is PoC-20 phase 2 and needs the owner's ruling first. Nothing in this file
// is reachable from `apps/console/src/router.ts`, and a test greps for that.
//
// **Everything here is RULE CODE.** The scorer supplies one fact —
// `{intent, confidence}` — and the three exported functions below decide what
// happens about it, from a table in this file and a threshold in the owner's
// `rules.yaml`. That division is §3.2's P1/P2 and it is the reason the tier
// needs no invariant amendment: the model supplies a feature, the rules make
// the decision, exactly as `fast_path`'s regexes already relate to the message
// text.
//
// It also repeats the discipline `run.ts` already applies to the FM tier: the
// model's answer is RE-VALIDATED in code after it speaks ("`strict: true` is
// the provider's promise, not this collector's assumption"), and an intent
// outside the enum is not a fact — it is a discarded verdict and a
// fall-through.

import {
  INTENT_UNSURE,
  intentGuard,
  intentMessages,
  intentThreshold,
  isIntent,
  type Intent,
  type IntentPhrasing,
  type IntentRules,
  type ChoiceStage,
} from "@foldedspacelabs/metistry-core";
import { scoreChoice, type ComputeAccess } from "../compute-client.js";

/** The five the inbox already speaks — `FM_SCHEMA`'s enum, and what the console can render. */
export const INBOX_KINDS = ["todo", "event", "idea", "link", "note"] as const;
export type InboxKind = (typeof INBOX_KINDS)[number];

/**
 * Intent → the proposal kind it justifies, or `null` for "this intent says
 * nothing about which inbox category the capture is".
 *
 * THE DECISION TABLE, in code, in the product, reviewable in a diff. Three
 * things about it are deliberate:
 *
 *   * **`null` is the common case and it is not a gap.** `status_open_work`
 *     and `task_list` are perfectly good things for a message to say and
 *     perfectly useless for deciding what an inbox item IS. A verdict that
 *     maps to `null` falls through to the tier below exactly as if the
 *     classifier had never run.
 *   * **`unsure` is always `null`.** The whole point of the "no match" member
 *     (Nimble's README: "add an answer that means 'no match'") is that it
 *     escalates.
 *   * **It maps onto the EXISTING five.** The intent enum is richer than the
 *     inbox's categories on purpose — it is the same enum the composer door
 *     will read in phase 2 — but nothing here may widen what a proposal can
 *     be, because the console renders that set and invariant 10 says a new one
 *     is a product change (`run.ts`'s own re-check of `FM_CATEGORIES` is the
 *     precedent).
 */
export const INBOX_KIND_FOR_INTENT: Record<Intent, InboxKind | null> = {
  task_create: "todo",
  task_update: "todo",
  task_close: "todo",
  task_list: null,
  status_open_work: null,
  note_capture: "note",
  knowledge_search: null,
  link_capture: "link",
  event_capture: "event",
  schedule_lookup: "event",
  explanation_request: "idea",
  artifact_review: null,
  triage_answer: null,
  agent_delegate: null,
  smalltalk: null,
  unsure: null,
};

/** Rule code: which proposal kind an intent justifies, if any. Pure, total over the enum, and the only reader of a verdict's `intent`. */
export function inboxKindForIntent(intent: string): InboxKind | null {
  if (!isIntent(intent)) return null; // re-validate after the model speaks (§3.3.2)
  return INBOX_KIND_FOR_INTENT[intent];
}

/** What a verdict is, as a FACT. No tier, no model, no field that could hold one (§3.2 P1). */
export interface IntentVerdict {
  intent: Intent;
  /** 0–1, TypeSafe's statistic over the renormalised distribution (research §2.2) */
  confidence: number;
  distribution: Record<string, number>;
  /**
   * "This sentence asks for more than one thing" (§3.3.4).
   *
   * **Phase 1 never sets it.** One scored token cannot carry a second
   * question — the research says so in as many words (§2.5: "one scored token
   * cannot carry" compound) and assigns it to the JSON-schema arm in phase 2.
   * The field is here so that `rules.yaml` and the proposal meta can speak
   * about it on the day phase 2 lands without a shape change, and `undefined`
   * means "nothing asked", never `false`.
   */
  compound?: boolean;
}

/** What the rules decided about one verdict, and why — auditable, not vibes (`classify()`'s own standard). */
export interface IntentDecision {
  applied: boolean;
  threshold: number;
  kind: InboxKind | null;
  why: string;
}

/**
 * Rule code: does this verdict place the capture?
 *
 * Three conditions, all of them the rules': the confidence clears the
 * threshold the owner's file names for THIS intent, the intent maps to a
 * proposal kind, and the intent is not the "no match" member. A verdict that
 * fails any of them is recorded and ignored — §4.3 property 1 is explicit
 * that the discarded ones are the most interesting rows in the table.
 */
export function intentDecision(rules: IntentRules, verdict: Pick<IntentVerdict, "intent" | "confidence">): IntentDecision {
  const threshold = intentThreshold(rules, verdict.intent);
  const kind = inboxKindForIntent(verdict.intent);
  if (verdict.intent === INTENT_UNSURE) {
    return { applied: false, threshold, kind: null, why: `${INTENT_UNSURE}: none of the intents fit, so the rules below decide` };
  }
  if (kind === null) {
    return { applied: false, threshold, kind: null, why: `${verdict.intent} says nothing about which inbox category this is` };
  }
  if (verdict.confidence < threshold) {
    return { applied: false, threshold, kind, why: `${verdict.intent} at ${verdict.confidence.toFixed(3)} is under rules.yaml's threshold of ${threshold}` };
  }
  return { applied: true, threshold, kind, why: `${verdict.intent} at ${verdict.confidence.toFixed(3)} clears rules.yaml's threshold of ${threshold}` };
}

// ---- running it ---------------------------------------------------------------

/** Everything the row's audit needs: the fact, plus who said it and how long it took. Kept apart from `IntentVerdict` so the FACT stays a fact. */
export interface IntentScored {
  outcome: "scored";
  verdict: IntentVerdict;
  decision: IntentDecision;
  alpha: number;
  covered: number;
  code: string;
  provider: string;
  model: string;
  server: string | undefined;
  latency_ms: number;
  phrasing: IntentPhrasing;
}

/** The deterministic guard refused before any request was built (§2.3.1.3). The tier worked; it declined to ask. */
export interface IntentGuarded {
  outcome: "guarded";
  reason: string;
}

/** Nothing was called, or the call did not produce a usable answer. The caller keeps whatever it had. */
export interface IntentUnavailable {
  outcome: "unavailable";
  why: string;
}

export type IntentOutcome = IntentScored | IntentGuarded | IntentUnavailable;

export interface IntentTierOptions {
  /** the pinned `<provider>/<model-id>` from `compute.yaml`'s `assignments.intent` */
  modelRef: string;
  /** `rules.yaml`'s `intent:` block — the owner's thresholds */
  rules: IntentRules;
  /** the stage to score. One call today (sixteen intents); `choicePlan` cascades past twenty. */
  stage: ChoiceStage;
  phrasing?: IntentPhrasing;
  now?: Date;
  mime?: string | null;
  timeoutMs?: number;
}

/**
 * One capture through the intent tier.
 *
 * The guard runs FIRST and in code, which is the ordering the research calls
 * the strongest external evidence for this file's whole shape: Laya's authors
 * put a deterministic script check ahead of their own model for ACCURACY
 * reasons, having measured 0.000 accuracy at 0.952 confidence on
 * out-of-distribution input, in a project with no invariant 4 to satisfy
 * (§2.3.1.3).
 */
export async function scoreIntent(ctx: ComputeAccess, text: string, opts: IntentTierOptions): Promise<IntentOutcome> {
  const guard = intentGuard(text, { mime: opts.mime ?? null });
  if (!guard.ok) return { outcome: "guarded", reason: guard.reason };

  const stage = opts.stage;
  const phrasing = opts.phrasing ?? "says";
  const scored = await scoreChoice(ctx, {
    collector: "inbox-drain",
    modelRef: opts.modelRef,
    options: stage.options,
    codes: stage.codes,
    messages: intentMessages(guard.text, {
      options: stage.options,
      codes: stage.codes,
      phrasing,
      ...(opts.now ? { now: opts.now } : {}),
    }),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });
  if (!scored.ok) return { outcome: "unavailable", why: scored.why };

  // PARSE, NEVER MATCH, and validate anyway: the choice came back as one of
  // the codes WE generated, but a build that ever cascades could hand this
  // function a group key, and a group key is not an intent.
  if (!isIntent(scored.choice)) {
    return { outcome: "unavailable", why: `${scored.provider} answered ${JSON.stringify(scored.choice)}, which is not one of this build's intents` };
  }
  const verdict: IntentVerdict = { intent: scored.choice, confidence: scored.confidence, distribution: scored.distribution };
  return {
    outcome: "scored",
    verdict,
    decision: intentDecision(opts.rules, verdict),
    alpha: scored.alpha,
    covered: scored.covered,
    code: scored.code,
    provider: scored.provider,
    model: scored.model,
    server: scored.server,
    latency_ms: scored.latency_ms,
    phrasing,
  };
}

/**
 * What the rules decided to DO, or undefined — the only thing `run.ts` is
 * given about a verdict.
 *
 * Deliberately not "the verdict, for the caller to interpret". The drain never
 * reads a verdict's `intent` at all: it asks this module what the rules
 * decided and writes down the answer. That is the property
 * `collectors/test/invariant4.test.ts` greps `run.ts` for, and it is what
 * makes "the classifier's outputs are consumed only by rule code" checkable
 * rather than a claim in a comment.
 */
export function intentPlacement(outcome: IntentOutcome): { kind: InboxKind; provider: string; reason: string } | undefined {
  if (outcome.outcome !== "scored") return undefined;
  if (!outcome.decision.applied || outcome.decision.kind === null) return undefined;
  return { kind: outcome.decision.kind, provider: outcome.provider, reason: `intent:${outcome.verdict.intent}` };
}

/**
 * What lands in the proposal's payload and in the `runs` row (§4.3). The fact,
 * the decision, and who said it — one shape, so "what did the classifier say,
 * and what did the rules do about it" is one named query away.
 */
export function intentMeta(outcome: IntentOutcome): Record<string, unknown> {
  if (outcome.outcome === "guarded") return { outcome: "guarded", reason: outcome.reason };
  if (outcome.outcome === "unavailable") return { outcome: "unavailable", why: outcome.why };
  return {
    outcome: "scored",
    intent: outcome.verdict.intent,
    confidence: Number(outcome.verdict.confidence.toFixed(4)),
    ...(outcome.verdict.compound !== undefined ? { compound: outcome.verdict.compound } : {}),
    alpha: Number(outcome.alpha.toFixed(4)),
    covered: outcome.covered,
    code: outcome.code,
    distribution: Object.fromEntries(
      Object.entries(outcome.verdict.distribution)
        .filter(([, p]) => p >= 0.001)
        .map(([k, p]) => [k, Number(p.toFixed(4))]),
    ),
    threshold: outcome.decision.threshold,
    applied: outcome.decision.applied,
    why: outcome.decision.why,
    kind: outcome.decision.kind,
    provider: outcome.provider,
    model: outcome.model,
    server: outcome.server ?? null,
    latency_ms: outcome.latency_ms,
    phrasing: outcome.phrasing,
  };
}
