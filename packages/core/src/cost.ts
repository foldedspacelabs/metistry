// What one call cost, and where the number came from (C12: cost is a
// first-class row). Users pay per call now, so "how much" must be a column
// on `runs`, not an estimate reconstructed later from a token count and a
// price list that has since changed.
//
// THREE SOURCES, in this order, and the row records which one answered:
//
//   provider — the response's own `usage.cost` (OpenRouter always sends it,
//              and it is the only number that includes that account's
//              discounts, BYOK fee and per-endpoint rate). Authoritative.
//   pricing  — the provider's `pricing:` table in `compute.yaml`, for clouds
//              whose responses carry no cost (Zen and anything hand-written).
//   local    — `locality: on_machine` is 0 by definition; electricity is not
//              billed through this ledger.
//
// A fourth outcome is deliberate: `unknown`. An off-machine provider that
// sent no cost and has no `pricing:` entry for the model it just ran is
// recorded as 0 with `cost_source: unknown`, never silently priced at a
// guessed rate — a budget that counted invented numbers would be worse than
// one that visibly cannot see part of the spend. `metistry doctor` and the
// weekly review read the source, so "unknown" is a finding, not a gap.

import type { Provider } from "./compute.js";

/** Where the number on the row came from. Recorded so an unpriced call is visible rather than invisible. */
export const COST_SOURCES = ["provider", "pricing", "local", "unknown"] as const;

/**
 * What a cached prompt token costs as a multiple of `in_per_m`, when
 * `pricing:` names no multiplier of its own. These are Anthropic's rates as
 * OpenRouter passes them through — cache reads at 0.1×, five-minute cache
 * writes at 1.25× (`docs/research/2026-09-11-local-models-openrouter-opencode.md`
 * [or-cache] = <https://openrouter.ai/docs/features/prompt-caching>, fetched
 * 2026-09-11) — because that is the one provider the product ships a
 * template for and the only caching shape the engine sends today. A cloud
 * written by hand states its own two numbers.
 *
 * They only ever apply on the `pricing` path: OpenRouter itself sends
 * `usage.cost`, which already knows what the cache saved.
 */
export const DEFAULT_CACHE_READ_MULTIPLIER = 0.1;
export const DEFAULT_CACHE_WRITE_MULTIPLIER = 1.25;
export type CostSource = (typeof COST_SOURCES)[number];

/**
 * One call's accounting, normalised out of whatever the provider sent.
 *
 * `tokens_in` is the WHOLE prompt as the provider billed it, on every wire
 * shape; `cache_read` is the cached subset of it, reported BESIDE it rather
 * than subtracted from it, so the two can never disagree about the total.
 * The two shapes disagree about which of those the wire carries, and
 * `usageFromResponse` is where they are made to agree.
 *
 * `cache_read`/`cache_write` are OPTIONAL and that is load-bearing:
 * `undefined` means the response said nothing about the cache at all, and 0
 * means it said zero. A provider whose field names we guessed wrong reports
 * the first; a stable prefix that simply missed reports the second. OPEN-6's
 * measurement reads the difference (`seed/queries/cache_report.yaml`), so
 * nothing between here and the `runs` row may flatten one into the other.
 */
export interface CallUsage {
  tokens_in: number;
  tokens_out: number;
  /** Prompt tokens served from the provider's cache. Absent = the response reported no such field. */
  cache_read?: number | undefined;
  /** Prompt tokens written to the provider's cache. Absent = the response reported no such field. */
  cache_write?: number | undefined;
  /** The provider's own charge for this call (OpenRouter's `usage.cost`), when it sent one. */
  cost_usd?: number | undefined;
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/**
 * Normalise a `usage` object off either wire shape the engine can meet.
 * Every field is optional on the wire — a local server may send none of it —
 * so everything absent means 0 tokens and no cost, never a thrown error in
 * the middle of a turn.
 *
 * TWO SHAPES, and the difference is not cosmetic:
 *
 *   OpenAI-compatible (OpenRouter, LM Studio, Ollama, anything with
 *     `/v1/chat/completions`) — `prompt_tokens` is the WHOLE prompt with the
 *     cached share already inside it, and the split lives in
 *     `prompt_tokens_details.cached_tokens`. OpenRouter adds `usage.cost`,
 *     but only for a request that asked for it with `usage: { include:
 *     true }` (the `openrouter` template's `request:` block sends it).
 *
 *   Anthropic-native (`/v1/messages`) — `input_tokens` is the FRESH
 *     remainder ONLY, with `cache_read_input_tokens` and
 *     `cache_creation_input_tokens` reported beside it. The whole prompt is
 *     the sum of the three, which is what this returns: one `tokens_in`
 *     meaning, whichever endpoint answered, so `runs.tokens_in` is
 *     comparable across providers and a hit ratio over it means one thing.
 *
 * The shape is recognised by its ANCHOR field (`prompt_tokens` vs
 * `input_tokens`), never by the provider's name — a gateway is free to send
 * either, and the row has to be right in both cases.
 */
export function usageFromResponse(raw: unknown): CallUsage {
  const u = (raw ?? {}) as Record<string, unknown>;
  const details = (u.prompt_tokens_details ?? {}) as Record<string, unknown>;
  // Anthropic's own two names, kept apart because they are also the two that
  // sit OUTSIDE `input_tokens` and therefore have to be added back below.
  const nativeRead = num(u.cache_read_input_tokens);
  const nativeWrite = num(u.cache_creation_input_tokens);
  const cacheRead = num(details.cached_tokens) ?? num(u.cached_tokens) ?? nativeRead;
  const cacheWrite = num(details.cache_write_tokens) ?? num(u.cache_write_tokens) ?? nativeWrite;
  const cost = num(u.cost);
  const prompt = num(u.prompt_tokens);
  return {
    // `prompt_tokens` present = the OpenAI shape, and it is already the
    // total; anything else is the native shape, where the total is the sum.
    tokens_in: prompt ?? (num(u.input_tokens) ?? 0) + (nativeRead ?? 0) + (nativeWrite ?? 0),
    tokens_out: num(u.completion_tokens) ?? num(u.output_tokens) ?? 0,
    ...(cacheRead !== undefined ? { cache_read: cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cache_write: cacheWrite } : {}),
    ...(cost !== undefined ? { cost_usd: cost } : {}),
  };
}

export interface CallCost {
  cost_usd: number;
  source: CostSource;
}

/**
 * Price one call. `model` is the id AS THE PROVIDER KNOWS IT (everything
 * after the first `/` of a `<provider>/<id>` reference), which is also how
 * `pricing:` is keyed — so a table entry and a request name the same string
 * or neither matches, and there is no normalisation to get wrong.
 */
export function costOf(usage: CallUsage, provider: Provider, model: string): CallCost {
  if (provider.locality === "on_machine") return { cost_usd: 0, source: "local" };
  if (usage.cost_usd !== undefined) return { cost_usd: usage.cost_usd, source: "provider" };
  const rate = provider.pricing?.[model];
  if (rate) {
    // Caching splits the prompt into three prices. `tokens_in` is the whole
    // prompt as the provider billed it, and `cache_read`/`cache_write` are
    // subsets of it (the CallUsage note above), so the FRESH remainder is
    // what is left after both — clamped, because a provider that reported
    // more cached tokens than prompt tokens must not be able to produce a
    // negative charge. A response that reports neither prices exactly as it
    // did before caching existed.
    //
    // The "cache writes are inside `tokens_in`" half of that is the
    // assumption OPEN-6's measurement checks: if a provider reports them
    // beside the prompt instead, this undercharges a write by 1× the input
    // rate and nothing else moves.
    const cacheRead = Math.min(Math.max(0, usage.cache_read ?? 0), usage.tokens_in);
    const cacheWrite = Math.min(Math.max(0, usage.cache_write ?? 0), usage.tokens_in - cacheRead);
    const fresh = usage.tokens_in - cacheRead - cacheWrite;
    const cost =
      (fresh / 1_000_000) * rate.in_per_m +
      (cacheRead / 1_000_000) * rate.in_per_m * (rate.cache_read_multiplier ?? DEFAULT_CACHE_READ_MULTIPLIER) +
      (cacheWrite / 1_000_000) * rate.in_per_m * (rate.cache_write_multiplier ?? DEFAULT_CACHE_WRITE_MULTIPLIER) +
      (usage.tokens_out / 1_000_000) * rate.out_per_m;
    // six decimals is what `runs.cost_usd` stores (numeric(10,6)); rounding
    // here rather than at the column keeps the number the engine logged and
    // the number the budget added up identical.
    return { cost_usd: Math.round(cost * 1e6) / 1e6, source: "pricing" };
  }
  return { cost_usd: 0, source: "unknown" };
}

/** The sentence a run row carries when nothing could price the call — it names the field that would fix it (R3). */
export function unpricedNote(providerName: string, model: string): string {
  return `${providerName} sent no usage.cost and compute.yaml has no providers.${providerName}.pricing["${model}"] — this call is recorded at $0 and does not count against any budget`;
}
