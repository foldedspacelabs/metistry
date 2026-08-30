// Passkey ceremonies (§4.2) via @simplewebauthn — never hand-rolled.
// Challenges are short-lived, single-process state (the console is one
// process); each is single-use and expires in 5 minutes.

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
  origin: string; // canonical HTTPS origin, deployment.yaml/env (§4.2)
  rpID: string; // hostname of origin
  rpName: string;
}

export function rpFromOrigin(origin: string): RpConfig {
  return { origin, rpID: new URL(origin).hostname, rpName: "metistry" };
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
  const v = await verifyRegistrationResponse({
    response: response as any,
    expectedChallenge,
    expectedOrigin: rp.origin,
    expectedRPID: rp.rpID,
  });
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
  const v = await verifyAuthenticationResponse({
    response: response as any,
    expectedChallenge,
    expectedOrigin: rp.origin,
    expectedRPID: rp.rpID,
    credential: credential as Parameters<typeof verifyAuthenticationResponse>[0]["credential"],
  });
  return v.verified ? { newCounter: v.authenticationInfo.newCounter } : null;
}
