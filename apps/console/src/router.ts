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
import { resolveTier, tiersSchema, type Effort, type TierMap } from "@foldedspacelabs/metistry-core";

const rulesSchema = z.object({
  fast_path: z.array(z.object({ match: z.string(), query: z.string() })).default([]),
  tiers: tiersSchema,
  commands: z.object({ deep_alias: z.string().default("deep") }).default({ deep_alias: "deep" }),
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
