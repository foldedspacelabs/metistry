// Owner-session lifetime policy (§4.2, ratified 2026-08-29): rolling idle
// window + absolute backstop, both instance-configurable. Enforced
// server-side per request — the cookie is a pointer, never the authority.

export interface SessionPolicy {
  idleDays: number; // default 30
  maxDays: number; // default 365
}

export interface SessionRow {
  last_seen_at: Date;
  absolute_expires_at: Date;
  revoked_at: Date | null;
}

export type SessionState = "valid" | "idle_expired" | "absolute_expired" | "revoked";

export function evaluateSession(row: SessionRow, policy: SessionPolicy, now: Date): SessionState {
  if (row.revoked_at !== null) return "revoked";
  if (now >= row.absolute_expires_at) return "absolute_expired";
  const idleMs = policy.idleDays * 24 * 60 * 60 * 1000;
  if (now.getTime() - row.last_seen_at.getTime() >= idleMs) return "idle_expired";
  return "valid";
}

/** Refresh last_seen at most hourly — active use silently extends the idle window. */
export function shouldRefreshLastSeen(row: SessionRow, now: Date): boolean {
  return now.getTime() - row.last_seen_at.getTime() > 60 * 60 * 1000;
}
