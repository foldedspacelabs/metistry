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
import { parseTiers, type TierMap } from "@foldedspacelabs/metistry-core";

export const RULES_FILES_DEFAULT = "seed/rules.yaml:rules.yaml";

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
