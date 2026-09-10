// The passkey ceremonies' configuration edges. A verification failure is a
// 401 with a reason, never the HTTP 500 the library's throw used to become
// (flagged by the Mac app PR, 2026-09-10).
import { describe, expect, it } from "vitest";
import { canonicalOrigin, presentedOrigin, rpFromOrigin, verifyAuthentication, verifyRegistration, WebAuthnError } from "../src/webauthn.js";

const clientData = (origin: string, type = "webauthn.create") =>
  Buffer.from(JSON.stringify({ type, challenge: "abc", origin }), "utf8").toString("base64url");

describe("rpFromOrigin", () => {
  it("takes a single origin", () => {
    expect(rpFromOrigin("https://metis.example")).toEqual({ origin: ["https://metis.example"], rpID: "metis.example", rpName: "metistry" });
  });

  it("takes METISTRY_ORIGIN as a comma-separated list, first entry canonical", () => {
    const rp = rpFromOrigin("https://metis.example, https://metis.tailnet.ts.net");
    expect(rp.origin).toEqual(["https://metis.example", "https://metis.tailnet.ts.net"]);
    expect(rp.rpID).toBe("metis.example"); // the rpID follows the canonical origin, never the list
    expect(canonicalOrigin("https://metis.example,https://metis.tailnet.ts.net")).toBe("https://metis.example");
  });

  it("refuses an empty origin rather than inventing one", () => {
    expect(() => rpFromOrigin("")).toThrow(/METISTRY_ORIGIN/);
    expect(() => rpFromOrigin(" , ")).toThrow(/METISTRY_ORIGIN/);
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
  const rp = rpFromOrigin("https://metis.example");
  const shell = { id: "cred-1", rawId: "cred-1", type: "public-key", clientExtensionResults: {} };
  const response = { ...shell, response: { clientDataJSON: clientData("https://evil.example"), attestationObject: "AA" } };
  const assertion = {
    ...shell,
    response: { clientDataJSON: clientData("https://evil.example", "webauthn.get"), authenticatorData: "AA", signature: "AA" },
  };

  it("is a WebAuthnError naming expected vs presented — not a raw throw the route turns into a 500", async () => {
    await expect(verifyRegistration(rp, response, "abc")).rejects.toThrow(WebAuthnError);
    await expect(verifyRegistration(rp, response, "abc")).rejects.toThrow(/expects https:\/\/metis\.example.*presented https:\/\/evil\.example/);
    await expect(
      verifyAuthentication(rp, assertion, "abc", { id: "cred-1", publicKey: new Uint8Array([1, 2, 3]), counter: 0 }),
    ).rejects.toThrow(/expects https:\/\/metis\.example.*presented https:\/\/evil\.example/);
  });

  it("names every accepted origin when METISTRY_ORIGIN is a list", async () => {
    const many = rpFromOrigin("https://metis.example,https://metis.tailnet.ts.net");
    await expect(verifyRegistration(many, response, "abc")).rejects.toThrow(/https:\/\/metis\.example or https:\/\/metis\.tailnet\.ts\.net/);
  });
});
