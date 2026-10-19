// A software authenticator for the passkey tests: enough of WebAuthn to make
// a registration and an assertion @simplewebauthn/server will verify, and
// to FORGE what a real browser never produces — an assertion for a host the
// passkey was not created on — so the console's own binding can be shown to
// refuse it. ES256 (P-256) only, attestation "none", no extensions: what a
// platform authenticator presents to the console's `attestationType: "none"`
// options, with nothing a test here would ever inspect left out.
//
// A real browser scopes a passkey to its rpID and never offers it at another
// host, so the forged case cannot be reproduced in Safari; a server has to
// refuse it anyway (§2.23, X-104), and this is how that refusal is tested.

import { createHash, createSign, generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";
import { isoCBOR } from "@simplewebauthn/server/helpers";

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

const b64url = (b: Uint8Array | Buffer): string => Buffer.from(b).toString("base64url");
const sha256 = (b: Uint8Array | string): Buffer => createHash("sha256").update(b).digest();

function u32be(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}

function clientDataJSON(type: "webauthn.create" | "webauthn.get", challenge: string, origin: string): string {
  return b64url(Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }), "utf8"));
}

export class SoftwarePasskey {
  /** the credential id, base64url — what the console stores the passkey under */
  readonly id: string;
  private readonly rawId: Buffer;
  private readonly privateKey: KeyObject;
  /** the COSE-encoded public key — what `passkeys.public_key` holds after a verified registration */
  readonly publicKey: Uint8Array;
  private counter = 0;

  /** @param rpID the host this passkey is created for — the rpID the browser would scope it to */
  constructor(readonly rpID: string) {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privateKey = privateKey;
    const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
    this.publicKey = isoCBOR.encode(
      new Map<number, number | Uint8Array>([
        [1, 2], // kty: EC2
        [3, -7], // alg: ES256
        [-1, 1], // crv: P-256
        [-2, Buffer.from(jwk.x, "base64url")],
        [-3, Buffer.from(jwk.y, "base64url")],
      ]),
    );
    this.rawId = randomBytes(16);
    this.id = b64url(this.rawId);
  }

  /** A registration response for `challenge`, as a browser at `origin` would return it. */
  attest(origin: string, challenge: string): unknown {
    const authData = Buffer.concat([
      sha256(this.rpID),
      Buffer.from([FLAG_UP | FLAG_UV | FLAG_AT]),
      u32be(this.counter),
      Buffer.alloc(16), // aaguid: zero, as attestation "none" has it
      Buffer.from([this.rawId.length >> 8, this.rawId.length & 0xff]),
      this.rawId,
      Buffer.from(this.publicKey),
    ]);
    const attestationObject = isoCBOR.encode(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      authenticatorAttachment: "platform",
      clientExtensionResults: {},
      response: {
        clientDataJSON: clientDataJSON("webauthn.create", challenge, origin),
        attestationObject: b64url(attestationObject),
        transports: ["internal"],
      },
    };
  }

  /**
   * An assertion for `challenge` from `origin`. `rpID` defaults to the host
   * the passkey was created for; passing another FORGES what no browser
   * would — an assertion claiming this passkey at a sibling host.
   */
  assert(origin: string, challenge: string, rpID: string = this.rpID): unknown {
    this.counter += 1;
    const authData = Buffer.concat([sha256(rpID), Buffer.from([FLAG_UP | FLAG_UV]), u32be(this.counter)]);
    const cdj = clientDataJSON("webauthn.get", challenge, origin);
    const signature = createSign("sha256").update(Buffer.concat([authData, sha256(Buffer.from(cdj, "base64url"))])).sign(this.privateKey);
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      authenticatorAttachment: "platform",
      clientExtensionResults: {},
      response: {
        clientDataJSON: cdj,
        authenticatorData: b64url(authData),
        signature: b64url(signature),
        userHandle: null,
      },
    };
  }
}
