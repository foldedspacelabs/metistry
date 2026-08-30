// Bridge caller authentication (review CRIT-9): loopback is NOT a trust
// boundary — it is reachable from the container. Every host bridge requires
// a per-bridge bearer token from env; comparison is constant-time.

import { createHash, timingSafeEqual, randomBytes } from "node:crypto";

/** Parse "Authorization: Bearer <token>"; null if absent/malformed. */
export function parseBearer(header: string | undefined | null): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(\S+)$/.exec(header);
  return m?.[1] ?? null;
}

/** Constant-time token equality (hash first so lengths never short-circuit). */
export function tokenEquals(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** True iff the Authorization header carries exactly the expected token. */
export function authorized(header: string | undefined | null, expected: string): boolean {
  const presented = parseBearer(header);
  return presented !== null && tokenEquals(presented, expected);
}

/** SHA-256 hex — how session/owner tokens are stored (never plaintext). */
export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Mint a URL-safe high-entropy token (enrollment codes, owner tokens). */
export function mintToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}
