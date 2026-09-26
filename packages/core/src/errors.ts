// Uniform error envelope (invariant 8): every surface returns the same
// shape, and errors never leak existence — "not granted" vs "not found" is
// distinguishable to the OWNER's surfaces only, never to an agent caller.

export type ErrorCode =
  | "unauthenticated" // 401 — missing/invalid credential (uniform; never says which)
  | "forbidden"       // 403 — authenticated but not permitted (no existence leak)
  | "local_only"      // 403 — the owner, but not on this Mac: a `local` route admits the local owner token alone (client API §2.1)
  | "not_found"       // 404
  | "invalid_request" // 400
  | "conflict"        // 409
  | "section_missing" // 409 — a note's Metistry section is not there to write: broken, doubled, or quoted in code (the vault bridge's section operation, plan §2.13)
  | "rate_limited"    // 429
  | "not_available"   // 503 — the capability is absent in this deployment (degrades: absent); not a permission
  | "internal";       // 500 — no detail crosses the wire; detail goes to runs

export interface ErrorEnvelope {
  error: { code: ErrorCode; message: string };
}

const httpStatus: Record<ErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  local_only: 403,
  not_found: 404,
  invalid_request: 400,
  conflict: 409,
  section_missing: 409,
  rate_limited: 429,
  not_available: 503,
  internal: 500,
};

/** Canonical messages — deliberately generic so responses don't oracle. */
const canonicalMessage: Record<ErrorCode, string> = {
  unauthenticated: "authentication required",
  forbidden: "not granted",
  local_only: "only the Mac app on this console's Mac can do this",
  not_found: "not found",
  invalid_request: "invalid request",
  conflict: "conflict",
  section_missing: "the note's section could not be found — nothing was written",
  rate_limited: "rate limited",
  not_available: "not available",
  internal: "internal error",
};

export function errorEnvelope(code: ErrorCode, message?: string): ErrorEnvelope {
  return { error: { code, message: message ?? canonicalMessage[code] } };
}

export function statusFor(code: ErrorCode): number {
  return httpStatus[code];
}
