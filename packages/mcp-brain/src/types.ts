// Shapes the bridge needs from its host. No pg, no project config
// (CLAUDE.md packages rule): the executor and the principal are injected.

import type { ActionAutonomy } from "@foldedspacelabs/metistry-core";

/** Minimal executor shape — satisfied by pg.Pool / pg.Client / a fake in tests. */
export interface Db {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/** Read tiers (§4.11): default-deny, user-granted, attached to the token server-side. */
export type Tier = "none" | "index" | "areas";

/**
 * The server-side principal for an agent call (§4.20 Principal, kind=agent).
 * Produced by the host's `authenticate(req)` from the credential; nothing in
 * a request body or tool argument is ever read as identity (§4.19).
 */
export interface AgentPrincipal {
  id: string;
  /**
   * `external` (the default when absent): a foreign agent under user-issued
   * grants. `internal`: the instance's own assistant, whose scope comes from
   * configuration in the user's hand (§4.11). `crew`: a sub-agent defined by
   * a manifest in the instance repo, authenticating with a bearer its run
   * minted and burns (docs/ops/crews.md).
   *
   * All three are the values the registry stores, and since P2 the host
   * passes the row's own value through rather than collapsing a crew to
   * `external` (§2.3). It is read in exactly one place in this package —
   * `principal.ts`, the credential → principal mapping — and nowhere else.
   */
  kind?: "external" | "internal" | "crew" | undefined;
  /**
   * A crew's own toolset: the `uses` GROUPS from its manifest (core's
   * `CREW_TOOL_GROUPS`), resolved by the HOST from the loaded manifest at
   * authentication — never from a request body or a tool argument (§4.19).
   * `/mcp` refuses every call outside it (P2 §2.2).
   *
   * Absent on any other kind. Absent on a `crew` means no tools at all: a
   * bearer whose manifest this console cannot see holds nothing.
   */
  uses?: readonly string[] | undefined;
  /**
   * Where a crew's scope and toolset were declared — the manifest path the
   * host loaded (`agents/<area>/<name>.md`). Carried so the principal's
   * `source` is the manifest rather than a fourth prose reconstruction of
   * "this scope is configuration, not a grant" (§2.7). Nothing decides on it.
   */
  manifest?: string | undefined;
  /**
   * `connections` (T4-8b): the connection names this credential is lent
   * through the proxy (`connections_list`, `connections_call`), attached by
   * the host beside the other grants — never asserted by the caller. Absent
   * is none. The assistant reaches every connection without one (core's
   * `mayConnection`).
   */
  grants: { tier: Tier; areas: string[]; queries?: boolean; connections?: string[] | undefined };
  /** Project membership — the collaboration boundary for every tasks_* tool (scope.ts holds the internal rule). */
  projects: string[];
  /**
   * A3 (docs/ops/actions.md): what this credential may DO — the level and the
   * per-kind table, straight off the agent's registry row. Like `grants`, it
   * is attached to the token server-side and never asserted by the caller;
   * `propose_action` resolves it through core's `effectiveActions` and is not
   * registered at all when the answer is "nothing". Absent = observe.
   */
  autonomy?: ActionAutonomy | undefined;
}
