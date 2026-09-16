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
   * configuration in the user's hand (§4.11). The only rule that reads it is
   * project membership (scope.ts): internal + empty `projects` = every project.
   */
  kind?: "external" | "internal" | undefined;
  grants: { tier: Tier; areas: string[]; queries?: boolean };
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
