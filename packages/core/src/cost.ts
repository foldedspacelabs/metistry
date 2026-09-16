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
export type CostSource = (typeof COST_SOURCES)[number];

/**
 * One call's accounting, normalised out of whatever the provider sent.
 *
 * `tokens_in` is the WHOLE prompt as the provider billed it (OpenAI's
 * `prompt_tokens` already includes cached tokens); `cache_read` is the
 * cached subset of it, reported beside it rather than subtracted from it,
 * so the two can never disagree about the total.
 */
export interface CallUsage {
  tokens_in: number;
  tokens_out: number;
  /** Prompt tokens served from the provider's cache (`prompt_tokens_details.cached_tokens`). */
  cache_read?: number | undefined;
  /** Prompt tokens written to the provider's cache, where the provider reports it. */
  cache_write?: number | undefined;
  /** The provider's own charge for this call (OpenRouter's `usage.cost`), when it sent one. */
  cost_usd?: number | undefined;
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/**
 * Normalise an OpenAI-shaped `usage` object. Every field is optional on the
 * wire — a local server may send none of it — so everything absent means 0
 * tokens and no cost, never a thrown error in the middle of a turn.
 */
export function usageFromResponse(raw: unknown): CallUsage {
  const u = (raw ?? {}) as Record<string, unknown>;
  const details = (u.prompt_tokens_details ?? {}) as Record<string, unknown>;
  const cacheRead = num(details.cached_tokens) ?? num(u.cached_tokens);
  const cacheWrite = num(details.cache_write_tokens) ?? num(u.cache_write_tokens) ?? num(u.cache_creation_input_tokens);
  const cost = num(u.cost);
  return {
    tokens_in: num(u.prompt_tokens) ?? num(u.input_tokens) ?? 0,
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
    const cost = (usage.tokens_in / 1_000_000) * rate.in_per_m + (usage.tokens_out / 1_000_000) * rate.out_per_m;
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
