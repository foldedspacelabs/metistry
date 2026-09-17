// The assistant's copy of the `tiers:` block — the SAME file the console's
// router reads (`METISTRY_RULES_FILES`, D4 overlay, last existing file wins),
// parsed by the same schema in core.
//
// Why both read it rather than the router shipping (model, effort) on the row:
// a routine enqueues turns without going through the router at all (the
// evening fold writes `meta.tier: routine` straight into `inbound_messages`),
// so the container that makes the call has to be able to resolve a tier NAME
// on its own. One resolution point, one schema, one file.
//
// Degrades to a stated default rather than refusing to start: an assistant
// that cannot see rules.yaml still answers, on the default model, and says so.

import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import {
  DEFAULT_TIER,
  RULES_FILES_DEFAULT,
  parseTiers,
  resolveAssignment,
  resolveTier,
  type Compute,
  type Effort,
  type ResolvedAssignment,
  type Tier,
  type TierMap,
} from "@foldedspacelabs/metistry-core";

/** The D4 overlay default, from core so the console and the engine read the same file. */
export { RULES_FILES_DEFAULT };

/** The map used when no rules file is readable: one tier, the configured default model, medium effort. */
export function fallbackTiers(model: string): TierMap {
  return { default: { model, effort: "medium" } };
}

export interface LoadedTiers {
  tiers: TierMap;
  /** The file the map came from; absent = the fallback. */
  path?: string;
}

/** Load the tier map from the colon-separated candidate paths; later files win (D4). A file that exists but is invalid throws — a bad tier map is a startup failure, not a silent default. */
export async function loadTiers(paths: string, fallbackModel: string): Promise<LoadedTiers> {
  let loaded: LoadedTiers | undefined;
  for (const p of paths.split(":").filter(Boolean)) {
    let text: string;
    try {
      text = await readFile(p, "utf8");
    } catch (err: any) {
      if (err?.code === "ENOENT") continue;
      throw err;
    }
    const doc = (parseYaml(text) ?? {}) as Record<string, unknown>;
    loaded = { tiers: parseTiers(doc.tiers), path: p };
  }
  return loaded ?? { tiers: fallbackTiers(fallbackModel) };
}

// ---- one resolution point: tier NAME → (provider, model, effort) --------------

/**
 * What a turn actually runs as. `assignment` is present exactly when
 * `compute.yaml` assigned this tier or crew — which is also what decides
 * WHICH ENGINE runs it (engine.ts `kindFor`), so the two can never disagree.
 */
export interface ResolvedTurn {
  /** The key that applied: a tier name, `crew:<name>`, or `default` when the name was unknown. */
  tier: string;
  /** The model as the engine wants it: the provider's own id when assigned, the rules.yaml/manifest string otherwise. */
  model: string;
  effort: Effort;
  assignment?: ResolvedAssignment | undefined;
}

/**
 * The precedence, in one place and one order:
 *
 *   1. `compute.yaml` `assignments:` — tiers by name, crews by `crew:<name>`,
 *      everything unknown on `assignments.default` (C1, §2.4: assignments
 *      supersede `rules.yaml`'s `tiers:` and a crew manifest's `model`).
 *   2. the caller's own fallback pair — a crew manifest's (model, effort),
 *      which is the only pair `rules.yaml` never had.
 *   3. `rules.yaml`'s `tiers:` block, which still decides on every install
 *      that has not written an `assignments:` block.
 *
 * An unknown name lands on `default` at every level. The resolver never
 * invents a model and never passes a name through as though it had matched.
 */
export function resolveTurn(cfg: Compute, tiers: TierMap, name?: string | null, fallback?: Tier | undefined): ResolvedTurn {
  const assignment = resolveAssignment(cfg, name);
  if (assignment) return { tier: assignment.from, model: assignment.model, effort: assignment.effort, assignment };
  if (fallback) return { tier: typeof name === "string" ? name : DEFAULT_TIER, model: fallback.model, effort: fallback.effort };
  const t = resolveTier(tiers, name);
  return { tier: t.tier, model: t.model, effort: t.effort };
}
