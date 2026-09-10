// Passkey ceremonies (§4.2) via @simplewebauthn — never hand-rolled.
// Challenges are short-lived, single-process state (the console is one
// process); each is single-use and expires in 5 minutes.
//
// METISTRY_ORIGIN may be a comma-separated LIST. One install is reachable
// under more than one origin in practice — the tailnet name and the public
// hostname, say — and @simplewebauthn v13 takes `expectedOrigin` as an
// array. The FIRST entry stays canonical: it is the rpID's source, what
// enrolled passkeys record, and the base every relative URL resolves against.

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
  /** every accepted origin; `[0]` is canonical (deployment.yaml/env, §4.2) */
  origin: string[];
  rpID: string; // hostname of the canonical origin
  rpName: string;
}

/**
 * A ceremony that could not be verified for a reason worth SAYING. The
 * library throws on an origin mismatch, which used to surface as a 500 —
 * an install pointed at the wrong METISTRY_ORIGIN looked like a broken
 * console instead of a misconfigured one. The reason names the two origins
 * and nothing else: both are already known to the caller (it presented its
 * own) and to anyone who can load the login page.
 */
export class WebAuthnError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "WebAuthnError";
  }
}

export function rpFromOrigin(origin: string): RpConfig {
  const origins = origin.split(",").map((s) => s.trim()).filter(Boolean);
  if (origins.length === 0) throw new Error("METISTRY_ORIGIN is empty");
  return { origin: origins, rpID: new URL(origins[0]!).hostname, rpName: "metistry" };
}

/** The canonical origin: what passkeys record and what relative URLs resolve against. */
export function canonicalOrigin(origin: string): string {
  return rpFromOrigin(origin).origin[0]!;
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
function refuse(err: unknown, rp: RpConfig, response: unknown): never {
  const got = presentedOrigin(response);
  const message = err instanceof Error ? err.message : String(err);
  if (/origin/i.test(message)) {
    throw new WebAuthnError(`origin mismatch: this console expects ${rp.origin.join(" or ")}, the browser presented ${got ?? "an origin it did not disclose"} — set METISTRY_ORIGIN to the origin you actually load`);
  }
  throw new WebAuthnError("the passkey ceremony could not be verified");
}

export async function registrationOptions(rp: RpConfig) {
  return generateRegistrationOptions({
    rpName: rp.rpName,
    rpID: rp.rpID,
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
      expectedRPID: rp.rpID,
    });
  } catch (err) {
    refuse(err, rp, response);
  }
  if (!v.verified || !v.registrationInfo) return null;
  const c = v.registrationInfo.credential;
  return {
    id: c.id,
    publicKey: c.publicKey,
    signCount: c.counter,
    transports: c.transports ?? [],
  };
}

export async function authenticationOptions(rp: RpConfig) {
  return generateAuthenticationOptions({ rpID: rp.rpID, userVerification: "preferred" });
}

export async function verifyAuthentication(
  rp: RpConfig,
  response: unknown,
  expectedChallenge: string,
  credential: { id: string; publicKey: Uint8Array; counter: number },
) {
  let v: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    v = await verifyAuthenticationResponse({
      response: response as any,
      expectedChallenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
      credential: credential as Parameters<typeof verifyAuthenticationResponse>[0]["credential"],
    });
  } catch (err) {
    refuse(err, rp, response);
  }
  return v.verified ? { newCounter: v.authenticationInfo.newCounter } : null;
}
