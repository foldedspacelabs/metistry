// One-time passkey enrolment codes (plan §4.2, §2.22) — the table
// `auth_enrollment_codes` (migration 0003) and the four things anything may do
// to a row: mint, peek, consume, cancel — plus the two X-114 adds: `stamp` (the
// phone's start reached the console, §2.23 step 7) and `status` (read it back).
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

/** The console listener that answered a phone's `start`: `proxy` came from outside (a provider is pointed at it), `main` is loopback. */
export type EnrollmentListener = "proxy" | "main";

/**
 * Record that the phone's `POST /auth/enroll/start` reached the console with
 * this code (§2.23 step 7, X-114): `opened_at` and `opened_via`. **Stamping is
 * not using** — `used_at` is untouched, the code stays single-use and expires
 * when it would have. Only a LIVE code is stamped (an unknown, used or expired
 * code changes nothing). The first stamp stands, except that `proxy` replaces
 * `main`: the owner opening the link on this Mac must not hide the phone
 * arriving, and nothing replaces a `proxy` stamp. Returns the row's id when a
 * stamp was written (so the caller can audit exactly once), undefined when not.
 */
export async function stampEnrollmentOpened(db: EnrollmentDb, code: string, via: EnrollmentListener): Promise<number | undefined> {
  const { rows } = await db.query(
    `UPDATE auth_enrollment_codes SET opened_at = now(), opened_via = $2
     WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now()
       AND (opened_via IS NULL OR (opened_via = 'main' AND $2 = 'proxy'))
     RETURNING id`,
    [tokenHash(code), via],
  );
  return rows.length === 1 ? Number((rows[0] as { id: unknown }).id) : undefined;
}

/** Where a code is in its life: `live` (usable), `used` (a phone finished with it), `expired` (the ten minutes ran out, or it was cancelled). */
export type EnrollmentState = "live" | "used" | "expired";

/** What `metistry enroll --status <code_id>` prints: never the code, never its hash. */
export interface EnrollmentStatus {
  code_id: number;
  state: EnrollmentState;
  expires_at: string;
  /** ISO-8601, when the phone's `start` arrived; null until it has */
  opened_at: string | null;
  opened_via: EnrollmentListener | null;
}

/** Read a code's state and its opened stamp by id; undefined for an id that never existed. */
export async function enrollmentStatus(db: EnrollmentDb, codeId: number): Promise<EnrollmentStatus | undefined> {
  if (!Number.isSafeInteger(codeId) || codeId <= 0) return undefined;
  const { rows } = await db.query(
    `SELECT id, used_at, expires_at, expires_at > now() AS live, opened_at, opened_via
     FROM auth_enrollment_codes WHERE id = $1`,
    [codeId],
  );
  if (rows.length !== 1) return undefined;
  const r = rows[0] as { id: unknown; used_at: unknown; expires_at: string | Date; live: boolean; opened_at: string | Date | null; opened_via: unknown };
  const state: EnrollmentState = r.used_at ? "used" : r.live ? "live" : "expired";
  return {
    code_id: Number(r.id),
    state,
    expires_at: new Date(r.expires_at).toISOString(),
    opened_at: r.opened_at ? new Date(r.opened_at).toISOString() : null,
    opened_via: r.opened_via === "proxy" || r.opened_via === "main" ? r.opened_via : null,
  };
}
