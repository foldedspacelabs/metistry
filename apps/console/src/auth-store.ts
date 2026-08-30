// Owner-auth persistence (§4.2). Every credential is stored hashed; every
// check is server-side per request. Two structurally distinct classes:
// owner (sessions + owner tokens) vs agent tokens (Phase 4/5 — not here).

import { mintToken, tokenHash } from "@foldedspacelabs/metistry-core";
import { evaluateSession, shouldRefreshLastSeen, type SessionPolicy } from "./session-policy.js";

export interface Db {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

const ENROLL_TTL_MIN = 10;

export async function mintEnrollmentCode(db: Db): Promise<string> {
  const code = mintToken(16);
  await db.query(
    `INSERT INTO auth_enrollment_codes (code_hash, expires_at)
     VALUES ($1, now() + interval '${ENROLL_TTL_MIN} minutes')`,
    [tokenHash(code)],
  );
  return code;
}

/** Valid-without-burning check (enrollment /start). */
export async function peekEnrollmentCode(db: Db, code: string): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM auth_enrollment_codes
     WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now()`,
    [tokenHash(code)],
  );
  return rows.length === 1;
}

/** Consume a code: single-use, unexpired. Returns false on any miss. */
export async function consumeEnrollmentCode(db: Db, code: string): Promise<boolean> {
  const { rows } = await db.query(
    `UPDATE auth_enrollment_codes SET used_at = now()
     WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now()
     RETURNING id`,
    [tokenHash(code)],
  );
  return rows.length === 1;
}

export async function storePasskey(
  db: Db,
  p: { id: string; publicKey: Uint8Array; signCount: number; transports: string[]; origin: string; label: string },
): Promise<void> {
  await db.query(
    `INSERT INTO passkeys (id, public_key, sign_count, transports, rp_origin, label)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [p.id, Buffer.from(p.publicKey), p.signCount, p.transports, p.origin, p.label],
  );
}

export async function getPasskey(
  db: Db,
  id: string,
): Promise<{ id: string; publicKey: Uint8Array; counter: number } | null> {
  const { rows } = await db.query(`SELECT id, public_key, sign_count FROM passkeys WHERE id = $1`, [id]);
  const r = rows[0];
  return r ? { id: r.id, publicKey: new Uint8Array(r.public_key), counter: Number(r.sign_count) } : null;
}

export async function touchPasskey(db: Db, id: string, newCounter: number): Promise<void> {
  await db.query(`UPDATE passkeys SET sign_count = $2, last_used_at = now() WHERE id = $1`, [id, newCounter]);
}

export async function issueSession(db: Db, passkeyId: string, policy: SessionPolicy): Promise<string> {
  const token = mintToken(32);
  await db.query(
    `INSERT INTO auth_sessions (token_hash, passkey_id, absolute_expires_at)
     VALUES ($1, $2, now() + ($3 || ' days')::interval)`,
    [tokenHash(token), passkeyId, String(policy.maxDays)],
  );
  return token;
}

export interface AuthedSession {
  id: number;
  passkey_id: string;
}

/** Validate a session cookie value. Refreshes last_seen at most hourly. */
export async function checkSession(db: Db, token: string, policy: SessionPolicy): Promise<AuthedSession | null> {
  const { rows } = await db.query(
    `SELECT id, passkey_id, last_seen_at, absolute_expires_at, revoked_at
     FROM auth_sessions WHERE token_hash = $1`,
    [tokenHash(token)],
  );
  const row = rows[0];
  if (!row) return null;
  const now = new Date();
  if (evaluateSession(row, policy, now) !== "valid") return null;
  if (shouldRefreshLastSeen(row, now)) {
    await db.query(`UPDATE auth_sessions SET last_seen_at = now() WHERE id = $1`, [row.id]);
  }
  return { id: row.id, passkey_id: row.passkey_id };
}

/** Revocation kills the session AND its push subscription together (§4.2). */
export async function revokeSession(db: Db, sessionId: number): Promise<boolean> {
  const { rows } = await db.query(
    `UPDATE auth_sessions SET revoked_at = now(), push_subscription = NULL
     WHERE id = $1 AND revoked_at IS NULL RETURNING id`,
    [sessionId],
  );
  return rows.length === 1;
}

export async function listDevices(db: Db): Promise<any[]> {
  const { rows } = await db.query(
    `SELECT s.id, p.label, p.last_used_at AS passkey_last_used, s.created_at,
            s.last_seen_at, s.absolute_expires_at, s.revoked_at IS NOT NULL AS revoked
     FROM auth_sessions s JOIN passkeys p ON p.id = s.passkey_id
     ORDER BY s.last_seen_at DESC`,
  );
  return rows;
}

/** Host-minted owner access token (Shortcuts/CLI — no WebAuthn there). */
export async function mintOwnerToken(db: Db, label: string): Promise<string> {
  const token = mintToken(32);
  await db.query(`INSERT INTO owner_tokens (token_hash, label) VALUES ($1, $2)`, [tokenHash(token), label]);
  return token;
}

export async function checkOwnerToken(db: Db, token: string): Promise<boolean> {
  const { rows } = await db.query(
    `UPDATE owner_tokens SET last_used_at = now()
     WHERE token_hash = $1 AND revoked_at IS NULL RETURNING id`,
    [tokenHash(token)],
  );
  return rows.length === 1;
}
