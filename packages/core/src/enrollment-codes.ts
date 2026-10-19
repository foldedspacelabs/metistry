// One-time passkey enrolment codes (plan §4.2, §2.22) — the table
// `auth_enrollment_codes` (migration 0003) and the four things anything may do
// to a row: mint, peek, consume, cancel.
//
// This lives in core so the two callers share ONE implementation and can never
// disagree on the hash, the lifetime or what "spent" means: the console spends
// a code (`POST /auth/enroll/start|finish`, through apps/console/src/auth-store.ts,
// which re-exports these) and the CLI mints and cancels one (`metistry enroll`,
// M19). The CLI never imports the app (CLAUDE.md: apps → packages, never the
// reverse), so the shared function has to be below both.
//
// Every code is stored hashed, like every other credential: a database read
// yields nothing a phone could present. No pg here — the caller passes any
// executor with pg's query shape, as runs.ts does.

import { mintToken, tokenHash } from "./auth.js";

export interface EnrollmentDb {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

/** A one-shot enrolment code's lifetime; interpolated into SQL, which is why it is a constant and not a parameter. */
export const ENROLLMENT_CODE_TTL_MIN = 10; // limit: fixed — a security parameter, not a setting (§2.22: "the 10 minutes stays a fixed security parameter")

export interface MintedEnrollmentCode {
  /** the secret the phone presents — printed once, never stored */
  code: string;
  /** the row's id: what `metistry enroll --cancel` takes and what `--json` prints; never the code */
  code_id: number;
  /** ISO-8601, the server's clock */
  expires_at: string;
}

/** Mint a single-use code: stored hashed, dead after ENROLLMENT_CODE_TTL_MIN minutes or one use. */
export async function mintEnrollmentCode(db: EnrollmentDb): Promise<MintedEnrollmentCode> {
  const code = mintToken(16);
  const { rows } = await db.query(
    `INSERT INTO auth_enrollment_codes (code_hash, expires_at)
     VALUES ($1, now() + interval '${ENROLLMENT_CODE_TTL_MIN} minutes')
     RETURNING id, expires_at`,
    [tokenHash(code)],
  );
  const row = rows[0] as { id: unknown; expires_at: unknown };
  return { code, code_id: Number(row.id), expires_at: new Date(row.expires_at as string | Date).toISOString() };
}

/** Valid-without-burning check (enrolment /start). */
export async function peekEnrollmentCode(db: EnrollmentDb, code: string): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM auth_enrollment_codes
     WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now()`,
    [tokenHash(code)],
  );
  return rows.length === 1;
}

/** Consume a code: single-use, unexpired. Returns false on any miss. */
export async function consumeEnrollmentCode(db: EnrollmentDb, code: string): Promise<boolean> {
  const { rows } = await db.query(
    `UPDATE auth_enrollment_codes SET used_at = now()
     WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now()
     RETURNING id`,
    [tokenHash(code)],
  );
  return rows.length === 1;
}

/**
 * What cancelling a code found. Only `cancelled` changed a row; the other three
 * say why there was nothing left to kill, so a sheet closing on an expired code
 * can tell "already dead" from "never existed".
 */
export type CancelEnrollmentOutcome = "cancelled" | "already_used" | "already_expired" | "not_found";

/**
 * Expire an unused code at once (`metistry enroll --cancel <code_id>`): a QR
 * left on screen or in a screenshot is dead the moment the owner is done with
 * it. No new column and no new state — the row's `expires_at` is moved to now,
 * so `peek` and `consume` refuse it by the rule they already apply.
 */
export async function cancelEnrollmentCode(db: EnrollmentDb, codeId: number): Promise<CancelEnrollmentOutcome> {
  if (!Number.isSafeInteger(codeId) || codeId <= 0) return "not_found";
  const killed = await db.query(
    `UPDATE auth_enrollment_codes SET expires_at = now()
     WHERE id = $1 AND used_at IS NULL AND expires_at > now()
     RETURNING id`,
    [codeId],
  );
  if (killed.rows.length === 1) return "cancelled";
  const { rows } = await db.query(`SELECT used_at FROM auth_enrollment_codes WHERE id = $1`, [codeId]);
  if (rows.length !== 1) return "not_found";
  return (rows[0] as { used_at: unknown }).used_at ? "already_used" : "already_expired";
}
