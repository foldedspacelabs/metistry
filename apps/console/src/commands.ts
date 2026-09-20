// `GET /api/commands` — the composer's command list, GENERATED
// (docs/product/ux-direction.md: "Discoverability is generated, not
// hand-maintained"; design-system.md §3.6).
//
// Every client shipped a hand-written array until this route existed, each
// one labelled as a placeholder, and the first instance whose `rules.yaml`
// differed from the shipped defaults was lied to by all of them. This is the
// one source: the instance's own router rules, plus the agent registry, which
// is where `@drey` already comes from.
//
// It is DERIVED, not declared, and derivation from a regex has to be honest
// about what it cannot know. A `fast_path` rule is a regex, and most regexes
// are not commands: `^what('| i)?s (my |the )?(status|open work)\b` is a
// sentence the router recognises, not something anybody types with a slash.
// So `literalCommands` extracts a command only from the two shapes that ARE
// unambiguous — `^/name…` and `^/(a|b|c)…` — and returns nothing for
// everything else. A rule that yields no command is not a bug and not
// hidden: it is a rule you reach by writing the sentence.
//
// The router's own three (`/note`, the `deep` alias, `/model <tier>`) are
// hard-coded in `router.ts` rather than in `rules.yaml`, so they are listed
// from the same place the router reads — `rules.commands.deep_alias` and
// `rules.tiers` — never from a literal here.

import { DEFAULT_TIER, resolveTier, type Effort } from "@foldedspacelabs/metistry-core";
import type { Rules } from "./router.js";

/** Where a command goes, in the router's own vocabulary (`Route.kind`), plus the two overrides the router spells itself. */
export type CommandRoute = "note" | "fast_path" | "model_override";

export interface CommandEntry {
  /** exactly what a client inserts at the caret — with its leading `/` */
  id: string;
  /** one line: the named query's own description, or the router behaviour this spelling triggers */
  description: string;
  routes_to: CommandRoute;
  /** the tier a model route takes, or null for the paths that never reach a model */
  tier: string | null;
  /** what that tier resolves to right now — `compute.yaml`'s assignments when it has any, else `rules.yaml`'s `tiers:` (docs/ops/compute.md) */
  model: string | null;
  effort: Effort | null;
  /** the named query a fast path answers from, or null */
  query: string | null;
  /** true when the router needs text after the command (`/note buy milk`); false when the bare word is the whole message */
  takes_argument: boolean;
}

export interface AgentEntry {
  /** `@` plus the registry id — the token the composer inserts */
  id: string;
  description: string;
  kind: string | null;
  /** the registry's own presence: an approved, unrevoked row that has authenticated at least once */
  present: boolean;
  last_seen_at: string | null;
}

/**
 * The literal slash commands one `fast_path` regex can be read as, or `[]`
 * when it cannot be read as any.
 *
 * Accepted, and nothing else:
 *
 *   `^/status`        → ["/status"]
 *   `^/status\b`      → ["/status"]
 *   `^/(status|open)` → ["/open", "/status"]
 *   `^\/note\s+(.+)$` → ["/note"], taking an argument
 *
 * Refused (returns `[]`): anything whose head is not `^/`, and anything whose
 * tail is a pattern rather than a word boundary or whitespace — `^/s[ua]m`
 * matches two spellings and we will not invent either.
 */
export function literalCommands(pattern: string): { names: string[]; takes_argument: boolean } {
  const m = /^\^\\?\/(?:\(([^()]*)\)|([a-z][a-z0-9_-]*))((?:\\b)?(?:\$)?|\\s[\s\S]*)$/.exec(pattern.trim());
  if (!m) return { names: [], takes_argument: false };
  const alternation = m[1];
  const single = m[2];
  const raw = alternation !== undefined ? alternation.split("|") : [single ?? ""];
  const names: string[] = [];
  for (const part of raw) {
    if (!/^[a-z][a-z0-9_-]*$/.test(part)) return { names: [], takes_argument: false }; // one unreadable branch and the whole rule yields nothing
    names.push(`/${part}`);
  }
  return { names: [...new Set(names)].sort(), takes_argument: (m[3] ?? "").startsWith("\\s") };
}

/** One line for the menu. A query's description can be a paragraph (`activity_feed`'s is); the menu gets its first sentence-ish line. */
function oneLine(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/**
 * The instance's commands, in deterministic order: by `id`, alphabetically.
 * No recency, no popularity, no model — the same discipline invariant 4
 * applies to the router applies to the menu it renders. (The CLIENT re-ranks
 * this list by prefix-then-substring against what is being typed, §3.6; the
 * server's order is the one a menu opened with nothing typed shows.)
 *
 * `describeQuery` is how a fast path gets its line: the named query's own
 * description, so the menu says what the query says and there is nothing to
 * keep in sync.
 */
export function commandList(rules: Rules, describeQuery: (name: string) => string | undefined): CommandEntry[] {
  const out = new Map<string, CommandEntry>();
  const tierOf = (name: string): { tier: string; model: string; effort: Effort } => {
    const t = resolveTier(rules.tiers, name);
    return { tier: t.tier, model: t.model, effort: t.effort };
  };

  // `/note <text>` — the router's own fast path: a file, an inbox row and an
  // instant ack, with no model and no assistant (§4.1).
  out.set("/note", {
    id: "/note",
    description: "capture straight to the inbox — no model, no turn, acknowledged instantly",
    routes_to: "note",
    tier: null,
    model: null,
    effort: null,
    query: null,
    takes_argument: true,
  });

  // The deep alias, under whatever name this instance's rules.yaml gives it.
  const deep = tierOf("deep");
  out.set(`/${rules.commands.deep_alias}`, {
    id: `/${rules.commands.deep_alias}`,
    description: `run this turn on the ${deep.tier} tier (${deep.model}, effort ${deep.effort})`,
    routes_to: "model_override",
    ...deep,
    query: null,
    takes_argument: true,
  });

  // `/model <tier> <text>` — the general form of the same override, for every
  // tier the instance declares. Listed once, with the menu naming them.
  const tiers = Object.keys(rules.tiers).sort();
  out.set("/model", {
    id: "/model",
    description: `run this turn on a named tier: ${tiers.join(", ")} (\`/model <tier> <text>\`)`,
    routes_to: "model_override",
    ...tierOf(DEFAULT_TIER),
    query: null,
    takes_argument: true,
  });

  // Everything else comes out of this instance's own `fast_path:` rules.
  // First rule wins in the router, so the first rule that spells a command
  // wins here too — a later rule re-using the word does not overwrite it.
  for (const rule of rules.fast_path) {
    const { names, takes_argument } = literalCommands(rule.match);
    const described = describeQuery(rule.query);
    for (const id of names) {
      if (out.has(id)) continue;
      out.set(id, {
        id,
        description: oneLine(described ?? `answered from the ${rule.query} query — which is not loaded in this deployment`),
        routes_to: "fast_path",
        tier: null,
        model: null,
        effort: null,
        query: rule.query,
        takes_argument,
      });
    }
  }

  return [...out.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** A registry row as the composer needs it. `revoked` rows are dropped; a pending enrolment is listed but never `present` — it authenticates nothing until approved (S2). */
export function agentList(
  rows: Array<{ id: string; display_name?: string | null; kind?: string | null; revoked?: boolean; pending?: boolean; last_seen_at?: Date | string | null }>,
): AgentEntry[] {
  return rows
    .filter((a) => a.revoked !== true)
    .map((a) => ({
      id: `@${a.id}`,
      description: oneLine(a.display_name ?? a.kind ?? "", 80),
      kind: a.kind ?? null,
      present: a.pending !== true && a.last_seen_at != null,
      last_seen_at: a.last_seen_at ? new Date(a.last_seen_at).toISOString() : null,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
