// Passkey ceremonies (§4.2) via @simplewebauthn — never hand-rolled.
// Challenges are short-lived, single-process state (the console is one
// process); each is single-use and expires in 5 minutes.
//
// METISTRY_ORIGIN may be a comma-separated LIST. One install is reachable
// under more than one origin in practice — the remote-access origin and the
// loopback one `init` wrote (§2.23) — and @simplewebauthn v14 takes
// `expectedOrigin` and `expectedRPID` as arrays. The FIRST entry stays
// canonical for two things only: it is the base every relative URL resolves
// against, and its host is what a passkey recorded before 0039 (no `rp_id`)
// reads as. The rpID of a ceremony is NOT the first entry's: it follows the
// request (X-104). A passkey is scoped by the browser to the host it was
// created on and is never offered anywhere else, so an rpID taken from the
// list's head meant a second origin on another host could never finish a
// ceremony. Each `start` reads the configured origin the request came from
// and issues that host as the rpID; each `finish` verifies against the list
// and records which host the passkey was bound to.

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export class ChallengeStore {
  private map = new Map<string, { challenge: string; expires: number }>();

  put(key: string, challenge: string): void {
    this.map.set(key, { challenge, expires: Date.now() + CHALLENGE_TTL_MS });
  }

  /** Single-use take: returns and deletes, or null if absent/expired. */
  take(key: string): string | null {
    const e = this.map.get(key);
    this.map.delete(key);
    return e && e.expires > Date.now() ? e.challenge : null;
  }
}

export interface RpConfig {
  /** every accepted origin, normalised to `scheme://host[:port]`; `[0]` is canonical (deployment.yaml/env, §4.2) */
  origin: string[];
  /** the rpID (hostname) of each origin, in the same order; `[0]` is what a passkey with no recorded host reads as */
  rpIDs: string[];
  rpName: string;
}

/**
 * A ceremony that could not be verified for a reason worth SAYING. The
 * library throws on an origin mismatch, which used to surface as a 500 —
 * an install pointed at the wrong METISTRY_ORIGIN looked like a broken
 * console instead of a misconfigured one. The reason names the two sides
 * and nothing else: both are already known to the caller (it presented its
 * own) and to anyone who can load the login page.
 */
export class WebAuthnError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "WebAuthnError";
  }
}

/** The rpID a browser scopes a passkey to: the origin's hostname, no scheme, no port. */
export function rpIDOf(origin: string): string {
  return new URL(origin).hostname;
}

export function rpFromOrigin(origin: string): RpConfig {
  const origins = origin
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((o) => new URL(o).origin);
  if (origins.length === 0) throw new Error("METISTRY_ORIGIN is empty");
  return { origin: origins, rpIDs: origins.map(rpIDOf), rpName: "metistry" };
}

/** The canonical origin: the base relative URLs resolve against, and the host a pre-0039 passkey reads as. */
export function canonicalOrigin(origin: string): string {
  return rpFromOrigin(origin).origin[0]!;
}

/** The request headers a ceremony's `start` reads to learn which configured origin it came from. */
export interface OriginHeaders {
  origin?: string | string[] | undefined;
}

function headerValue(v: string | string[] | undefined): string | null {
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === "string" && s.trim() ? s.trim() : null;
}

/**
 * The configured origin a request came from, or null when it names one the
 * console is not configured for. A browser sends `Origin` on every POST, and
 * that is matched exactly against the list. A client that sends none — the
 * Mac app's enrolment, a probe — has no origin to come from and is issued the
 * canonical (first) origin's host, as every ceremony was before X-104; it
 * states another with an `Origin` header. `Host` is not read: the console
 * sits behind TLS terminators that may rewrite it, and the one real client
 * without a browser reaches the console over loopback for a ceremony it then
 * performs at the canonical host. The header decides only WHICH configured
 * origin's host to issue; the `finish` step verifies the browser's own signed
 * statement of the origin against the whole list.
 */
export function requestOrigin(rp: RpConfig, headers: OriginHeaders): string | null {
  const origin = headerValue(headers.origin);
  if (!origin) return rp.origin[0]!;
  let normalised: string;
  try {
    normalised = new URL(origin).origin;
  } catch {
    return null;
  }
  return rp.origin.find((o) => o === normalised) ?? null;
}

/** What a `start` answers 401 with when `requestOrigin` found nothing: both sides, named. */
export function unconfiguredOrigin(rp: RpConfig, headers: OriginHeaders): WebAuthnError {
  const got = headerValue(headers.origin);
  return new WebAuthnError(
    `origin mismatch: this console expects ${rp.origin.join(" or ")}, the browser presented ${got ?? "an origin it did not disclose"} — set METISTRY_ORIGIN to the origin you actually load`,
  );
}

/** The origin the authenticator actually signed, read out of clientDataJSON. Unknown = null, never a guess. */
export function presentedOrigin(response: unknown): string | null {
  const raw = (response as { response?: { clientDataJSON?: unknown } } | null)?.response?.clientDataJSON;
  if (typeof raw !== "string") return null;
  try {
    const o = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as { origin?: unknown };
    return typeof o.origin === "string" ? o.origin : null;
  } catch {
    return null;
  }
}

/** Turn a library throw into a WebAuthnError the route answers 401 with. */
function refuse(err: unknown, rp: RpConfig, response: unknown, boundTo?: string): never {
  const got = presentedOrigin(response);
  const message = err instanceof Error ? err.message : String(err);
  if (/origin/i.test(message)) {
    throw new WebAuthnError(`origin mismatch: this console expects ${rp.origin.join(" or ")}, the browser presented ${got ?? "an origin it did not disclose"} — set METISTRY_ORIGIN to the origin you actually load`);
  }
  if (/RP ID/i.test(message)) {
    // A passkey is bound to the host it was added on and the browser never
    // offers it elsewhere; an assertion for another host is either a second
    // origin's passkey presented at the first or a forged response. Either
    // way the fix is the same, and it is the owner's, not the console's.
    throw new WebAuthnError(
      boundTo
        ? `rpID mismatch: this passkey was added for ${boundTo}, the browser presented ${got ?? "an origin it did not disclose"} — a passkey signs in only where it was added; add this device again there`
        : `rpID mismatch: this console expects ${rp.rpIDs.join(" or ")}, the browser presented ${got ?? "an origin it did not disclose"}`,
    );
  }
  throw new WebAuthnError("the passkey ceremony could not be verified");
}

/** Registration options for the host the request came from — `rpID` is one of `rp.rpIDs`, from `requestOrigin`. */
export async function registrationOptions(rp: RpConfig, rpID: string) {
  return generateRegistrationOptions({
    rpName: rp.rpName,
    rpID,
    userName: "owner",
    attestationType: "none",
    authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
  });
}

export async function verifyRegistration(rp: RpConfig, response: unknown, expectedChallenge: string) {
  let v: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    v = await verifyRegistrationResponse({
      response: response as any,
      expectedChallenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpIDs,
    });
  } catch (err) {
    refuse(err, rp, response);
  }
  if (!v.verified || !v.registrationInfo) return null;
  const c = v.registrationInfo.credential;
  const origin = presentedOrigin(response);
  return {
    id: c.id,
    publicKey: c.publicKey,
    signCount: c.counter,
    transports: c.transports ?? [],
    /** the host this passkey is bound to — the one the browser signed, matched out of `rp.rpIDs` */
    rpID: v.registrationInfo.rpID ?? rpIDOf(origin ?? rp.origin[0]!),
    /** the configured origin it was created on, as the browser stated it */
    origin: origin && rp.origin.includes(origin) ? origin : rp.origin[0]!,
  };
}

/** Authentication options for the host the request came from — `rpID` is one of `rp.rpIDs`, from `requestOrigin`. */
export async function authenticationOptions(rp: RpConfig, rpID: string) {
  return generateAuthenticationOptions({ rpID, userVerification: "preferred" });
}

/**
 * Verify a sign-in against the passkey's OWN host: `credential.rpID` as
 * recorded at enrolment, or the first configured host for a passkey from
 * before 0039 — never the whole list, which would let an assertion forged
 * for a sibling host sign in with a passkey that was never offered there.
 */
export async function verifyAuthentication(
  rp: RpConfig,
  response: unknown,
  expectedChallenge: string,
  credential: { id: string; publicKey: Uint8Array; counter: number; rpID?: string | null },
) {
  const boundTo = credential.rpID ?? rp.rpIDs[0]!;
  let v: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    v = await verifyAuthenticationResponse({
      response: response as any,
      expectedChallenge,
      expectedOrigin: rp.origin,
      expectedRPID: boundTo,
      credential: { id: credential.id, publicKey: credential.publicKey, counter: credential.counter } as Parameters<typeof verifyAuthenticationResponse>[0]["credential"],
    });
  } catch (err) {
    refuse(err, rp, response, boundTo);
  }
  return v.verified ? { newCounter: v.authenticationInfo.newCounter } : null;
}
