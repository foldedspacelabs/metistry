// Deprecated tool names, kept working for ONE release (the vocabulary
// simplification, docs/product/glossary.md, 2026-09-09).
//
// Aliases are resolved at CALL time and are deliberately NOT listed by
// tools/list. That is the whole design: the eager surface stays exactly the
// primary names, so `manifest.yaml`, `TOOL_NAMES`, `BRAIN_TOOLS` and
// `CREW_TOOL_GROUPS` all still see one set of names, and the definition-token
// budget (PoC-17: lazy discovery past >20 tools / >5k definition tokens) is
// unchanged rather than doubled by a shadow copy of every schema.
//
// The cost of that choice, stated plainly: an agent that has never listed the
// tools can still call an old name for one release, but an agent that lists
// them sees only the new ones. Every alias call is recorded in its `runs` row
// as `meta.alias`, so the remaining callers are countable before removal.

/** old name → the primary tool it resolves to, plus any argument the old name implied. */
export const TOOL_ALIASES: Readonly<Record<string, { readonly to: string; readonly args?: Readonly<Record<string, unknown>> }>> = {
  report: { to: "requests_create" },
  tasks_list_ready: { to: "tasks_list", args: { filter: "ready" } },
  tasks_mine: { to: "tasks_list", args: { filter: "mine" } },
  tasks_heartbeat: { to: "tasks_renew" },
  artifact_publish: { to: "artifacts_publish" },
  artifact_get: { to: "artifacts_get" },
  artifact_list: { to: "artifacts_list" },
  artifact_comment: { to: "artifacts_comment" },
  artifact_comment_resolve: { to: "artifacts_resolve" },
  artifact_dispatch_review: { to: "artifacts_review" },
  crew_dispatch: { to: "agents_delegate" },
};

/** The deprecated names, for docs and the `check()` payload. */
export const ALIAS_NAMES = Object.keys(TOOL_ALIASES);

/**
 * Rewrite one incoming JSON-RPC message in place when it calls a deprecated
 * name. Returns the alias that was resolved (for the audit row), or null.
 * Anything that is not a `tools/call` for a known alias is left untouched.
 */
export function resolveAliasCall(message: unknown): { alias: string; to: string; id?: string | number } | null {
  if (message === null || typeof message !== "object") return null;
  const msg = message as { method?: unknown; id?: unknown; params?: { name?: unknown; arguments?: unknown } };
  if (msg.method !== "tools/call" || msg.params === undefined || msg.params === null) return null;
  const name = msg.params.name;
  if (typeof name !== "string") return null;
  const hit = TOOL_ALIASES[name];
  if (!hit) return null;
  msg.params.name = hit.to;
  if (hit.args) {
    const args = msg.params.arguments !== null && typeof msg.params.arguments === "object" ? (msg.params.arguments as Record<string, unknown>) : {};
    // the alias' own args win: `tasks_mine` meant filter=mine whatever else was passed
    msg.params.arguments = { ...args, ...hit.args };
  }
  return { alias: name, to: hit.to, ...(typeof msg.id === "string" || typeof msg.id === "number" ? { id: msg.id } : {}) };
}
