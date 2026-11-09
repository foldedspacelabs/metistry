// Owner-auth persistence (§4.2). Every credential is stored hashed; every
// check is server-side per request. Two structurally distinct classes:
// owner (sessions + owner tokens) vs agent tokens (Phase 4/5 — not here).

import { mintToken, tokenHash } from "@foldedspacelabs/metistry-core";
import { evaluateSession, shouldRefreshLastSeen, type SessionPolicy } from "./session-policy.js";

export interface Db {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

// The enrolment-code functions live in core (`enrollment-codes.ts`) so the
// CLI's `metistry enroll` — which mints and cancels a code and may not import
// this app — and the console — which spends one — run the same code and can
// never disagree (plan §2.22). Re-exported here so every console caller keeps
// its `store.*` spelling.
export { cancelEnrollmentCode, consumeEnrollmentCode, mintEnrollmentCode, peekEnrollmentCode, stampEnrollmentOpened } from "@foldedspacelabs/metistry-core";

/**
 * `rpId` is the host the passkey was created for (0039, §2.23) — the console
 * always writes it. Absent = NULL, which `getPasskey` and `listDevices` read
 * as the first configured origin's host: that is exactly a passkey from
 * before 0039, and the tests that stand one up say so.
 */
export async function storePasskey(
  db: Db,
  p: { id: string; publicKey: Uint8Array; signCount: number; transports: string[]; origin: string; label: string; rpId?: string | null },
): Promise<void> {
  await db.query(
    `INSERT INTO passkeys (id, public_key, sign_count, transports, rp_origin, label, rp_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [p.id, Buffer.from(p.publicKey), p.signCount, p.transports, p.origin, p.label, p.rpId ?? null],
  );
}

/**
 * The credential a login ceremony names. `rpID` null = a passkey from before
 * 0039; the ceremony reads it as the first configured host. A **revoked**
 * passkey (a removed device, §2.22) answers `null` exactly as an unknown id
 * does, so the login route's uniform 401 cannot say whether the credential
 * ever existed.
 */
export async function getPasskey(
  db: Db,
  id: string,
): Promise<{ id: string; publicKey: Uint8Array; counter: number; rpID: string | null } | null> {
  const { rows } = await db.query(`SELECT id, public_key, sign_count, rp_id FROM passkeys WHERE id = $1 AND revoked_at IS NULL`, [id]);
  const r = rows[0];
  return r ? { id: r.id, publicKey: new Uint8Array(r.public_key), counter: Number(r.sign_count), rpID: r.rp_id ?? null } : null;
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

/**
 * Validate a session cookie value. Refreshes last_seen at most hourly. A
 * session whose passkey is revoked is refused whatever its own row says:
 * removing a device revokes its sessions too, but a session issued in the
 * instant between a login's passkey lookup and the removal would otherwise
 * outlive it. The join closes that window.
 */
export async function checkSession(db: Db, token: string, policy: SessionPolicy): Promise<AuthedSession | null> {
  const { rows } = await db.query(
    `SELECT s.id, s.passkey_id, s.last_seen_at, s.absolute_expires_at, s.revoked_at
     FROM auth_sessions s JOIN passkeys p ON p.id = s.passkey_id
     WHERE s.token_hash = $1 AND p.revoked_at IS NULL`,
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

/** What Remove does to a device (§2.22): the whole device, or its sessions only (Sign Out Everywhere). */
export type RevokeScope = "device" | "sessions";
export const REVOKE_SCOPES: readonly RevokeScope[] = ["device", "sessions"];

/**
 * Remove a device, named by any of its session rows (§2.22). `device` revokes
 * the passkey — it never signs in again — then every session under it, each
 * losing its push subscription; `sessions` ends the sessions and keeps the
 * passkey, which is Sign Out Everywhere's meaning. `null` when no session has
 * that id or the device is already removed: the route answers 404, as it did
 * for an unknown session before.
 */
export async function revokeDevice(
  db: Db,
  sessionId: number,
  scope: RevokeScope,
): Promise<{ passkey_id: string; sessions: number } | null> {
  const { rows } = await db.query(
    `SELECT p.id FROM auth_sessions s JOIN passkeys p ON p.id = s.passkey_id
     WHERE s.id = $1 AND p.revoked_at IS NULL`,
    [sessionId],
  );
  const passkeyId: string | undefined = rows[0]?.id;
  if (!passkeyId) return null;
  if (scope === "device") {
    // The passkey first: it is the credential that must die; a session the
    // second statement misses is refused by checkSession's join anyway.
    await db.query(`UPDATE passkeys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [passkeyId]);
  }
  const ended = await db.query(
    `UPDATE auth_sessions SET revoked_at = now(), push_subscription = NULL
     WHERE passkey_id = $1 AND revoked_at IS NULL RETURNING id`,
    [passkeyId],
  );
  return { passkey_id: passkeyId, sessions: ended.rows.length };
}

export interface DeviceSessionRow {
  id: string;
  created_at: Date;
  last_seen_at: Date;
  absolute_expires_at: Date;
  revoked: boolean;
  push: boolean;
}

export interface DeviceRow {
  /** The id Remove posts (`POST /api/devices/:id/revoke`): the device's newest session row, live or not. */
  id: string;
  passkey_id: string;
  label: string;
  /** The host the passkey was created for — the only host it signs in at (0039, §2.23); never null on the wire. */
  rp_id: string;
  added: Date;
  last_seen: Date;
  this_device: boolean;
  sessions: DeviceSessionRow[];
  // The session-row fields the body carried before §2.22, kept so a reader of
  // the old shape still reads something true: the passkey's own dates, the
  // newest session's expiry, and `revoked`, which is always false — a removed
  // device is not listed.
  passkey_last_used: Date | null;
  created_at: Date;
  last_seen_at: Date;
  absolute_expires_at: Date | null;
  revoked: false;
}

/**
 * A device per passkey, with its sessions under it (§2.22); removed devices
 * are not listed. `rp_id` is the host the passkey was created for, read as
 * `defaultRpID` (the first configured origin's host) for a passkey from
 * before 0039 — resolved here so a client never has to know the origin list
 * to tell which passkeys a provider change stranded (§2.23). `this_device`
 * marks the caller's own — the passkey of its session — and is false on
 * every row for the local owner token, which has no device. Newest seen first.
 */
export async function listDevices(db: Db, defaultRpID: string, callerSessionId: number | null = null): Promise<DeviceRow[]> {
  const { rows } = await db.query(
    `SELECT s.id, s.passkey_id, s.created_at, s.last_seen_at, s.absolute_expires_at,
            s.revoked_at IS NOT NULL AS revoked, s.push_subscription IS NOT NULL AS push,
            p.label, p.created_at AS added, p.last_used_at, COALESCE(p.rp_id, $1) AS rp_id
     FROM auth_sessions s JOIN passkeys p ON p.id = s.passkey_id
     WHERE p.revoked_at IS NULL
     ORDER BY s.last_seen_at DESC, s.id DESC`,
    [defaultRpID],
  );
  const mine = callerSessionId === null ? null : String(callerSessionId);
  const byPasskey = new Map<string, DeviceRow>();
  for (const r of rows) {
    const session: DeviceSessionRow = {
      id: String(r.id),
      created_at: r.created_at,
      last_seen_at: r.last_seen_at,
      absolute_expires_at: r.absolute_expires_at,
      revoked: r.revoked,
      push: r.push,
    };
    let d = byPasskey.get(r.passkey_id);
    if (!d) {
      const lastSeen = r.last_used_at && r.last_used_at > r.last_seen_at ? r.last_used_at : r.last_seen_at;
      d = {
        id: session.id,
        passkey_id: r.passkey_id,
        label: r.label,
        rp_id: r.rp_id,
        added: r.added,
        last_seen: lastSeen,
        this_device: false,
        sessions: [],
        passkey_last_used: r.last_used_at,
        created_at: r.added,
        last_seen_at: lastSeen,
        absolute_expires_at: r.absolute_expires_at,
        revoked: false,
      };
      byPasskey.set(r.passkey_id, d);
    }
    if (Number(session.id) > Number(d.id)) d.id = session.id;
    if (mine !== null && session.id === mine) d.this_device = true;
    d.sessions.push(session);
  }
  return [...byPasskey.values()].sort((a, b) => b.last_seen.getTime() - a.last_seen.getTime());
}

// Owner access tokens live in core too (`owner-tokens.ts`): `metistry up`
// records the recorder's inbox token and scripts/enroll.mjs mints one with the
// same statements the console checks against.
export { checkOwnerToken, mintOwnerToken } from "@foldedspacelabs/metistry-core";
