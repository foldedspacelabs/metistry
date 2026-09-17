// Tiers are (model, effort) PAIRS — docs/research/2026-09-cost-optimization.md
// decision 2. A tier used to be a model alone; effort is the other half of the
// same choice ("a stronger model at low effort can be cheaper than a weaker
// model working hard"), so the two live and travel together.
//
// The router names a tier (invariant 4: deterministic — no model decides which
// model runs). Whoever makes the call resolves the name to (model, effort).
// This lives in core because two apps resolve it: the console's router, for
// the record it writes onto the message, and the assistant's drain, which
// makes the actual SDK call.
//
// EFFORT CHANGES ONLY AT TURN BOUNDARIES, by construction rather than by
// promise: one SDK query per turn, its options built once from that turn's
// tier and never mutated mid-stream (apps/assistant/src/engine.ts). This is a
// cost control, not a style rule — changing effort inside a session breaks the
// cached prompt prefix, and a cache break costs up to 50x the read price per
// token on Fable/Mythos 5.1.

import { z } from "zod";

/** The effort levels a tier or crew may name. The SDK also accepts `xhigh`/`max`; those are deliberately not offered — they are model-specific and the research found negligible gain at the top. */
export const EFFORTS = ["low", "medium", "high"] as const;
export type Effort = (typeof EFFORTS)[number];

export const tierSchema = z.object({
  model: z.string().min(1),
  /** Absent = medium: the same middle the chat tier wants, so an old model-only tier keeps working. */
  effort: z.enum(EFFORTS).default("medium"),
});
export type Tier = z.infer<typeof tierSchema>;

/** Every unknown or absent tier name resolves here. Required in any tier map. */
export const DEFAULT_TIER = "default";
/** The tier a routine-enqueued turn carries (`meta.tier`) — the fold and anything else assembled by machine. */
export const ROUTINE_TIER = "routine";

export const tiersSchema = z
  .record(
    z.string().regex(/^[a-z][a-z0-9_-]*$/, "tier names are lowercase kebab-case (casing rule: only the vault is TitleCase)"),
    tierSchema,
  )
  .refine((t) => DEFAULT_TIER in t, `tiers must include '${DEFAULT_TIER}'`);

export type TierMap = z.infer<typeof tiersSchema>;

export interface ResolvedTier extends Tier {
  /** The tier that actually applied — `default` when the name was unknown, never the name that was asked for. */
  tier: string;
}

/**
 * Resolve a tier NAME to (model, effort). An unknown or absent name is
 * `default` — the resolver never invents a model, and never passes a name
 * through as though it had matched.
 */
export function resolveTier(tiers: TierMap, name?: string | null): ResolvedTier {
  const key = typeof name === "string" && Object.hasOwn(tiers, name) ? name : DEFAULT_TIER;
  const t = tiers[key]!;
  return { tier: key, model: t.model, effort: t.effort };
}

/** Parse a `tiers:` block (already YAML-parsed). Throws with every issue — a bad tier map is a startup failure, not a silent default. */
export function parseTiers(input: unknown): TierMap {
  const r = tiersSchema.safeParse(input);
  if (r.success) return r.data;
  throw new Error(`invalid tiers: ${r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
}
