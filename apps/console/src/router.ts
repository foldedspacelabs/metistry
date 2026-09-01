// The router (invariant 4): deterministic — prefix, regex, explicit
// commands only. No model decides which model to use. Lives in the console
// (CRIT-3: no third container). First match wins.

import { parse as parseYaml } from "yaml";
import { z } from "zod";

const rulesSchema = z.object({
  fast_path: z.array(z.object({ match: z.string(), query: z.string() })).default([]),
  tiers: z
    .record(z.string(), z.object({ model: z.string() }))
    .refine((t) => "default" in t, "tiers must include 'default'"),
  commands: z.object({ deep_alias: z.string().default("deep") }).default({ deep_alias: "deep" }),
});

export type Rules = z.infer<typeof rulesSchema>;

export type Route =
  | { kind: "fast_path"; query: string; routed_by: "rule" }
  | { kind: "note"; text: string; routed_by: "rule" }
  | { kind: "model"; tier: string; model: string; text: string; routed_by: "rule" | "override" };

export function loadRules(yamlText: string): Rules {
  const parsed = rulesSchema.safeParse(parseYaml(yamlText));
  if (!parsed.success) throw new Error(`invalid rules.yaml: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  const rules = parsed.data;
  for (const r of rules.fast_path) new RegExp(r.match, "i"); // fail at load, not per message
  return rules;
}

export function route(rules: Rules, text: string): Route {
  const trimmed = text.trim();

  // /note <text> — straight to inbox, no model, acknowledged instantly (§4.1)
  const note = /^\/note\s+([\s\S]+)$/.exec(trimmed);
  if (note?.[1]) return { kind: "note", text: note[1], routed_by: "rule" };

  // explicit tier overrides: /model <tag> <text> and the shipped /deep alias
  const model = /^\/model\s+(\S+)\s+([\s\S]+)$/.exec(trimmed);
  if (model?.[1] && model[2]) {
    const tier = rules.tiers[model[1]];
    if (tier) return { kind: "model", tier: model[1], model: tier.model, text: model[2], routed_by: "override" };
  }
  const deep = new RegExp(`^\\/${rules.commands.deep_alias}\\s+([\\s\\S]+)$`).exec(trimmed);
  if (deep?.[1]) {
    const tier = rules.tiers["deep"] ?? rules.tiers["default"]!;
    return { kind: "model", tier: "deep", model: tier.model, text: deep[1], routed_by: "override" };
  }

  for (const r of rules.fast_path) {
    if (new RegExp(r.match, "i").test(trimmed)) return { kind: "fast_path", query: r.query, routed_by: "rule" };
  }

  return { kind: "model", tier: "default", model: rules.tiers["default"]!.model, text: trimmed, routed_by: "rule" };
}
