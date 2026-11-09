// Host-minted owner access tokens (plan §4.2) — the `owner_tokens` table and
// the three things done to it: mint a new one, check a presented one, record a
// plaintext that already exists elsewhere (the recorder's inbox token, minted
// by `metistry up` into the Keychain and `.env` before the database has a row).
//
// In core for the same reason as enrollment-codes.ts: the console checks a
// token, the CLI (`metistry up`, `secrets mint`) and apps/console/scripts/enroll.mjs
// mint and record one, and a packages/ file may not import the app — so the
// one INSERT and the one hash live below both and are never repeated
// (coordinator note, X-75/X-80). Stored hashed; never a value in a row.

import { mintToken, tokenHash } from "./auth.js";
import type { EnrollmentDb } from "./enrollment-codes.js";

export type OwnerTokenDb = EnrollmentDb;

/** Host-minted owner access token (Shortcuts/CLI — no WebAuthn there). Returns the plaintext once. */
export async function mintOwnerToken(db: OwnerTokenDb, label: string): Promise<string> {
  const token = mintToken(32);
  await db.query(`INSERT INTO owner_tokens (token_hash, label) VALUES ($1, $2)`, [tokenHash(token), label]);
  return token;
}

/** True iff the token is on file and not revoked; touches last_used_at. */
export async function checkOwnerToken(db: OwnerTokenDb, token: string): Promise<boolean> {
  const { rows } = await db.query(
    `UPDATE owner_tokens SET last_used_at = now()
     WHERE token_hash = $1 AND revoked_at IS NULL RETURNING id`,
    [tokenHash(token)],
  );
  return rows.length === 1;
}

export type RegisterOwnerTokenOutcome = "recorded" | "present" | "revoked";

/**
 * Record a plaintext the caller already holds as an owner token, if the
 * database has no row for it — keyed on the hash, so it is a no-op on a token
 * that is already there, and a row the owner revoked is reported, never
 * revived. Idempotent: what repairs a rebuilt database (invariant 1) on the
 * next `metistry up` without rotating the token.
 */
export async function registerOwnerToken(db: OwnerTokenDb, token: string, label: string): Promise<RegisterOwnerTokenOutcome> {
  const hash = tokenHash(token);
  const found = await db.query("SELECT revoked_at FROM owner_tokens WHERE token_hash = $1", [hash]);
  if (found.rows.length > 0) return (found.rows[0] as { revoked_at: unknown }).revoked_at ? "revoked" : "present";
  await db.query("INSERT INTO owner_tokens (token_hash, label) VALUES ($1, $2) ON CONFLICT (token_hash) DO NOTHING", [hash, label]);
  return "recorded";
}
