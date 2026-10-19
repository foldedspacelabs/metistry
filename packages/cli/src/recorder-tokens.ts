// The recorder's three tokens — minted by `metistry up` and `metistry secrets
// mint`, so an install that configures the recorder has no owner-hand step
// left (owner ruling 2026-10-04, ticket X-80).
//
//   METISTRY_LIVE_CAPTURE_CONTROL_TOKEN   the bar's control key: the Mac app
//        reads it from the login Keychain (service
//        `metistry:METISTRY_LIVE_CAPTURE_CONTROL_TOKEN`, account = the
//        instance_id) and the bridge is started with the same value.
//   METISTRY_BRIDGE_TOKEN_LIVE_CAPTURE    the bearer the router presents to
//        the bridge. It was an owner-pasted random value in `.env`; one that
//        is already there is adopted, never replaced.
//   METISTRY_LIVE_CAPTURE_INBOX_TOKEN     a capture OWNER token labelled
//        `live-capture`: the credential the bridge posts transcripts to the
//        console with. Its plaintext is kept like the other two; the console
//        holds only its hash, in `owner_tokens` — the row
//        `apps/console/scripts/enroll.mjs --owner-token` writes. That script
//        is not in the release pack, so the CLI owns the mint (a packages/
//        file cannot import the console; the one INSERT is repeated here and
//        its hashing is core's `tokenHash`, which the console uses too).
//
// Idempotent in every part: a value any store already holds is kept; the
// `owner_tokens` row is recorded only when the DB has no row for that hash,
// so a rebuilt database (invariant 1) is repaired by the next `up` without
// rotating the token, and a row the owner revoked is reported, never revived.
// Nothing here runs unless `METISTRY_LIVE_CAPTURE_URL` is set: an install that
// never asked for a microphone gets none of the three.

import { tokenHash } from "@foldedspacelabs/metistry-core";
import { bridgeEnabled } from "./launchd.js";
import { openMigrationSession, type MigrationSession } from "./migrate.js";
import { ensureSecret, type SecretsOptions } from "./secrets.js";

export const CAPTURE_CONTROL_TOKEN = "METISTRY_LIVE_CAPTURE_CONTROL_TOKEN";
export const CAPTURE_BRIDGE_TOKEN = "METISTRY_BRIDGE_TOKEN_LIVE_CAPTURE";
export const CAPTURE_INBOX_TOKEN = "METISTRY_LIVE_CAPTURE_INBOX_TOKEN";
/** In the order they are minted and reported. */
export const RECORDER_TOKENS = [CAPTURE_CONTROL_TOKEN, CAPTURE_BRIDGE_TOKEN, CAPTURE_INBOX_TOKEN] as const;
/** The `owner_tokens.label` the console lists the inbox token under. */
export const CAPTURE_TOKEN_LABEL = "live-capture";

/** Whether this install has opted into the recorder — the signal doctor and `up` already read. */
export function recorderConfigured(env: NodeJS.ProcessEnv): boolean {
  return bridgeEnabled("live-capture", env);
}

export interface EnsureRecorderTokensOptions extends Omit<SecretsOptions, "out"> {
  env: NodeJS.ProcessEnv;
  /** Every variable this mint puts into `.env` is also set here (a second copy `up` renders its jobs from). */
  also?: NodeJS.ProcessEnv | undefined;
  out: (line: string) => void;
}

export interface EnsureRecorderTokensResult {
  /** names only — a result must never be able to carry a value into a log */
  minted: string[];
  adopted: string[];
  kept: string[];
  /** the plaintext inbox token, for `registerCaptureOwnerToken`; absent when nothing was configured or it could not be had */
  inbox?: string | undefined;
  /** why a token could not be made (name → the Keychain's or the filesystem's words) */
  failed: Array<{ name: string; reason: string }>;
}

/**
 * The three tokens, each made only when no store holds one. A token that
 * cannot be made (the Keychain refused) is reported in `failed` rather than
 * thrown: `up` still renders every job, and doctor's recorder rows name what
 * is missing and the command that fixes it.
 */
export async function ensureRecorderTokens(opts: EnsureRecorderTokensOptions): Promise<EnsureRecorderTokensResult> {
  const result: EnsureRecorderTokensResult = { minted: [], adopted: [], kept: [], failed: [] };
  if (!recorderConfigured(opts.env)) return result;
  const { env, also, ...secrets } = opts;
  for (const name of RECORDER_TOKENS) {
    try {
      const got = await ensureSecret(name, { ...secrets, env });
      (got.how === "minted" ? result.minted : got.how === "adopted" ? result.adopted : result.kept).push(name);
      env[name] = got.value;
      if (also) also[name] = got.value;
      if (name === CAPTURE_INBOX_TOKEN) result.inbox = got.value;
    } catch (err) {
      result.failed.push({ name, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}

/** The lines `up` and `secrets mint` print for a result: names and what happened, never a value. */
export function describeRecorderTokens(r: EnsureRecorderTokensResult): string[] {
  const out: string[] = [];
  if (r.minted.length) out.push(`recorder tokens minted: ${r.minted.join(", ")} — the live-capture bridge reads them when it starts`);
  if (r.adopted.length) out.push(`recorder tokens adopted from .env into the login Keychain (the value the bridge holds is unchanged): ${r.adopted.join(", ")}`);
  if (r.kept.length && !r.minted.length && !r.adopted.length) out.push(`recorder tokens already present, kept: ${r.kept.join(", ")}`);
  else if (r.kept.length) out.push(`kept: ${r.kept.join(", ")}`);
  for (const f of r.failed) out.push(`could not make ${f.name} (${f.reason}) — run \`metistry secrets mint\``);
  return out;
}

export type CaptureTokenRecord = "recorded" | "present" | "revoked" | "unreachable";

export interface RegisterCaptureTokenOptions {
  env: NodeJS.ProcessEnv;
  token: string;
  out: (line: string) => void;
  /** test seam: the session the INSERT goes through (default: one pg client from METISTRY_DB_*) */
  openSession?: ((env: NodeJS.ProcessEnv) => Promise<(MigrationSession & { end(): Promise<void> }) | null>) | undefined;
}

/**
 * Record the inbox token as a capture owner token, if the database has no row
 * for it: `INSERT INTO owner_tokens (token_hash, label)` — the statement
 * `mintOwnerToken` runs — keyed on the hash, so it is a no-op on a token that
 * is already there. A database that is not up, or has not been migrated yet,
 * is a note, not a failure: the token is in the Keychain and `.env`, and the
 * next `metistry up` records it.
 */
export async function registerCaptureOwnerToken(opts: RegisterCaptureTokenOptions): Promise<CaptureTokenRecord> {
  const hash = tokenHash(opts.token);
  let session: (MigrationSession & { end(): Promise<void> }) | null;
  try {
    session = await (opts.openSession ?? openMigrationSession)(opts.env);
  } catch (err) {
    opts.out(`${CAPTURE_INBOX_TOKEN} is minted but not yet recorded as an owner token — the database did not answer (${err instanceof Error ? err.message : String(err)}); \`metistry up\` records it once it does`);
    return "unreachable";
  }
  if (!session) {
    opts.out(`${CAPTURE_INBOX_TOKEN} is minted but not yet recorded as an owner token — METISTRY_DB_PASSWORD is unset; \`metistry up\` records it once the database is configured`);
    return "unreachable";
  }
  try {
    const found = await session.query("SELECT revoked_at FROM owner_tokens WHERE token_hash = $1", [hash]);
    if (found.rows.length > 0) {
      if (found.rows[0].revoked_at) {
        opts.out(`${CAPTURE_INBOX_TOKEN} is revoked in the console — transcripts stay on this Mac; \`metistry secrets mint ${CAPTURE_INBOX_TOKEN}\` makes a fresh one`);
        return "revoked";
      }
      return "present";
    }
    await session.query("INSERT INTO owner_tokens (token_hash, label) VALUES ($1, $2) ON CONFLICT (token_hash) DO NOTHING", [hash, CAPTURE_TOKEN_LABEL]);
    opts.out(`${CAPTURE_INBOX_TOKEN} recorded as a capture owner token labelled ${CAPTURE_TOKEN_LABEL}`);
    return "recorded";
  } catch (err) {
    opts.out(`${CAPTURE_INBOX_TOKEN} is minted but not yet recorded as an owner token (${err instanceof Error ? err.message : String(err)}) — the schema may not be migrated yet; \`metistry up\` records it once it is`);
    return "unreachable";
  } finally {
    await session.end().catch(() => {});
  }
}
