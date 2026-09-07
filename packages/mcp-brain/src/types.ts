// Shapes the bridge needs from its host. No pg, no project config
// (CLAUDE.md packages rule): the executor and the principal are injected.

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
  grants: { tier: Tier; areas: string[] };
  /** Project membership — the collaboration boundary for every tasks_* tool. */
  projects: string[];
}
