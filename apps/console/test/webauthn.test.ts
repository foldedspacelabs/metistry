// The passkey ceremonies' configuration edges. A verification failure is a
// 401 with a reason, never the HTTP 500 the library's throw used to become
// (flagged by the Mac app PR, 2026-09-10). Since X-104 the rpID follows the
// request (§2.23): a ceremony is issued for the configured origin it came
// from, and a passkey signs in only at the host it was created for.
import { describe, expect, it } from "vitest";
import {
  authenticationOptions,
  canonicalOrigin,
  presentedOrigin,
  registrationOptions,
  requestOrigin,
  rpFromOrigin,
  rpIDOf,
  unconfiguredOrigin,
  verifyAuthentication,
  verifyRegistration,
  WebAuthnError,
} from "../src/webauthn.js";
import { SoftwarePasskey } from "./passkey-fake.js";

const clientData = (origin: string, type = "webauthn.create") =>
  Buffer.from(JSON.stringify({ type, challenge: "abc", origin }), "utf8").toString("base64url");

const FIRST = "https://assistant.example";
const SECOND = "https://assistant.tailnet.ts.net";
const LIST = `${FIRST}, ${SECOND}`;

describe("rpFromOrigin", () => {
  it("takes a single origin", () => {
    expect(rpFromOrigin(FIRST)).toEqual({ origin: [FIRST], rpIDs: ["assistant.example"], rpName: "metistry" });
  });

  it("takes METISTRY_ORIGIN as a comma-separated list, first entry canonical, one rpID per origin", () => {
    const rp = rpFromOrigin(LIST);
    expect(rp.origin).toEqual([FIRST, SECOND]);
    expect(rp.rpIDs).toEqual(["assistant.example", "assistant.tailnet.ts.net"]); // every host, in order — the rpID follows the request, never the list's head
    expect(canonicalOrigin(`${FIRST},${SECOND}`)).toBe(FIRST);
  });

  it("normalises each entry to an origin — a path or a trailing slash never reaches the comparison", () => {
    expect(rpFromOrigin("https://assistant.example/, http://127.0.0.1:8080/x").origin).toEqual([FIRST, "http://127.0.0.1:8080"]);
    expect(rpIDOf("http://127.0.0.1:8080")).toBe("127.0.0.1"); // the rpID is the hostname: no scheme, no port
  });

  it("refuses an empty origin rather than inventing one", () => {
    expect(() => rpFromOrigin("")).toThrow(/METISTRY_ORIGIN/);
    expect(() => rpFromOrigin(" , ")).toThrow(/METISTRY_ORIGIN/);
  });
});

describe("requestOrigin — which configured origin a ceremony is issued for", () => {
  const rp = rpFromOrigin(LIST);

  it("reads the Origin header a browser sends on every POST and matches it exactly", () => {
    expect(requestOrigin(rp, { origin: SECOND })).toBe(SECOND);
    expect(requestOrigin(rp, { origin: FIRST })).toBe(FIRST);
    expect(requestOrigin(rp, { origin: "https://assistant.example/" })).toBe(FIRST); // serialised either way
    expect(requestOrigin(rp, { origin: ["https://assistant.tailnet.ts.net"] })).toBe(SECOND);
  });

  it("is the canonical origin for a client that sends no Origin — the Mac app's enrolment, a probe — as every ceremony was before X-104", () => {
    expect(requestOrigin(rp, {})).toBe(FIRST);
    expect(requestOrigin(rp, { origin: "" })).toBe(FIRST);
    expect(requestOrigin(rpFromOrigin(SECOND), {})).toBe(SECOND);
  });

  it("is null — never the first entry — for an Origin outside the list or an opaque one", () => {
    expect(requestOrigin(rp, { origin: "https://evil.example" })).toBe(null);
    expect(requestOrigin(rp, { origin: "http://assistant.example" })).toBe(null); // the scheme is part of the origin
    expect(requestOrigin(rp, { origin: "https://assistant.example:8443" })).toBe(null); // so is the port
    expect(requestOrigin(rp, { origin: "null" })).toBe(null); // an opaque origin can finish no ceremony
    expect(requestOrigin(rp, { origin: "not a url" })).toBe(null);
  });

  it("names both sides when nothing matched", () => {
    expect(unconfiguredOrigin(rp, { origin: "https://evil.example" }).reason).toMatch(/expects https:\/\/assistant\.example or https:\/\/assistant\.tailnet\.ts\.net, the browser presented https:\/\/evil\.example/);
    expect(unconfiguredOrigin(rp, { origin: "null" }).reason).toMatch(/presented null/);
    expect(unconfiguredOrigin(rp, {}).reason).toMatch(/an origin it did not disclose/);
  });
});

describe("the options carry the request's host as rpID", () => {
  const rp = rpFromOrigin(LIST);

  it("for registration and for authentication", async () => {
    expect((await registrationOptions(rp, "assistant.tailnet.ts.net")).rp.id).toBe("assistant.tailnet.ts.net");
    expect((await registrationOptions(rp, "assistant.example")).rp.id).toBe("assistant.example");
    expect((await authenticationOptions(rp, "assistant.tailnet.ts.net")).rpId).toBe("assistant.tailnet.ts.net");
  });
});

describe("presentedOrigin", () => {
  it("reads the origin the authenticator actually signed", () => {
    expect(presentedOrigin({ response: { clientDataJSON: clientData("https://elsewhere.example") } })).toBe("https://elsewhere.example");
  });

  it("is null rather than a guess when there is nothing to read", () => {
    expect(presentedOrigin(null)).toBe(null);
    expect(presentedOrigin({})).toBe(null);
    expect(presentedOrigin({ response: { clientDataJSON: "not base64 json" } })).toBe(null);
  });
});

describe("an origin mismatch", () => {
  const rp = rpFromOrigin(FIRST);
  const shell = { id: "cred-1", rawId: "cred-1", type: "public-key", clientExtensionResults: {} };
  const response = { ...shell, response: { clientDataJSON: clientData("https://evil.example"), attestationObject: "AA" } };
  const assertion = {
    ...shell,
    response: { clientDataJSON: clientData("https://evil.example", "webauthn.get"), authenticatorData: "AA", signature: "AA" },
  };

  it("is a WebAuthnError naming expected vs presented — not a raw throw the route turns into a 500", async () => {
    await expect(verifyRegistration(rp, response, "abc")).rejects.toThrow(WebAuthnError);
    await expect(verifyRegistration(rp, response, "abc")).rejects.toThrow(/expects https:\/\/assistant\.example.*presented https:\/\/evil\.example/);
    await expect(
      verifyAuthentication(rp, assertion, "abc", { id: "cred-1", publicKey: new Uint8Array([1, 2, 3]), counter: 0, rpID: null }),
    ).rejects.toThrow(/expects https:\/\/assistant\.example.*presented https:\/\/evil\.example/);
  });

  it("names every accepted origin when METISTRY_ORIGIN is a list", async () => {
    const many = rpFromOrigin(LIST);
    await expect(verifyRegistration(many, response, "abc")).rejects.toThrow(/https:\/\/assistant\.example or https:\/\/assistant\.tailnet\.ts\.net/);
  });
});

describe("a passkey is bound to the host it was created for (X-104)", () => {
  const rp = rpFromOrigin(LIST);
  const credentialOf = (pk: SoftwarePasskey, rpID: string | null, counter = 0) => ({ id: pk.id, publicKey: pk.publicKey, counter, rpID });

  it("created at the second origin, records the second host, signs in there and is refused at the first", async () => {
    const pk = new SoftwarePasskey("assistant.tailnet.ts.net");
    const reg = await registrationOptions(rp, "assistant.tailnet.ts.net");
    const cred = await verifyRegistration(rp, pk.attest(SECOND, reg.challenge), reg.challenge);
    expect(cred).not.toBeNull();
    expect(cred!.id).toBe(pk.id);
    expect(cred!.rpID).toBe("assistant.tailnet.ts.net"); // what 0039's rp_id is written from
    expect(cred!.origin).toBe(SECOND); // rp_origin: the origin the browser stated, not the list's head
    expect(Buffer.from(cred!.publicKey).equals(Buffer.from(pk.publicKey))).toBe(true);

    // signs in at the second
    const there = await authenticationOptions(rp, "assistant.tailnet.ts.net");
    await expect(verifyAuthentication(rp, pk.assert(SECOND, there.challenge), there.challenge, credentialOf(pk, cred!.rpID))).resolves.toEqual({ newCounter: 1 });

    // refused at the first — an assertion no browser would produce, forged for the sibling host, naming both sides
    const here = await authenticationOptions(rp, "assistant.example");
    const forged = pk.assert(FIRST, here.challenge, "assistant.example");
    await expect(verifyAuthentication(rp, forged, here.challenge, credentialOf(pk, cred!.rpID, 1))).rejects.toThrow(WebAuthnError);
    await expect(verifyAuthentication(rp, forged, here.challenge, credentialOf(pk, cred!.rpID, 1))).rejects.toThrow(
      /rpID mismatch: this passkey was added for assistant\.tailnet\.ts\.net, the browser presented https:\/\/assistant\.example/,
    );
  });

  it("with no recorded host (before 0039) reads as the first origin's host and still signs in there", async () => {
    const legacy = new SoftwarePasskey("assistant.example");
    const opts = await authenticationOptions(rp, "assistant.example");
    await expect(verifyAuthentication(rp, legacy.assert(FIRST, opts.challenge), opts.challenge, credentialOf(legacy, null))).resolves.toEqual({ newCounter: 1 });
    // and is NOT accepted at the second — null is the first host, not "any host"
    const second = await authenticationOptions(rp, "assistant.tailnet.ts.net");
    await expect(verifyAuthentication(rp, legacy.assert(SECOND, second.challenge, "assistant.tailnet.ts.net"), second.challenge, credentialOf(legacy, null, 1))).rejects.toThrow(
      /added for assistant\.example, the browser presented https:\/\/assistant\.tailnet\.ts\.net/,
    );
  });

  it("refuses an origin outside the list at both ceremonies, naming both sides", async () => {
    const stranger = new SoftwarePasskey("evil.example");
    const reg = await registrationOptions(rp, "assistant.example");
    await expect(verifyRegistration(rp, stranger.attest("https://evil.example", reg.challenge), reg.challenge)).rejects.toThrow(
      /expects https:\/\/assistant\.example or https:\/\/assistant\.tailnet\.ts\.net, the browser presented https:\/\/evil\.example/,
    );
    const auth = await authenticationOptions(rp, "assistant.example");
    await expect(verifyAuthentication(rp, stranger.assert("https://evil.example", auth.challenge), auth.challenge, credentialOf(stranger, "assistant.example"))).rejects.toThrow(
      /origin mismatch: .*presented https:\/\/evil\.example/,
    );
  });

  it("a registration whose rpID is not a configured host is refused even from a configured origin", async () => {
    // the browser would never do this (a registrable suffix of the origin is required); a forged response is refused the same way
    const odd = new SoftwarePasskey("elsewhere.example");
    const reg = await registrationOptions(rp, "assistant.example");
    await expect(verifyRegistration(rp, odd.attest(FIRST, reg.challenge), reg.challenge)).rejects.toThrow(/rpID mismatch: this console expects assistant\.example or assistant\.tailnet\.ts\.net/);
  });
});
