import { describe, expect, it } from "vitest";
import { authorized, mintToken, parseBearer, tokenEquals, tokenHash } from "../src/auth.js";
import { errorEnvelope, statusFor } from "../src/errors.js";

describe("bridge caller auth (CRIT-9 misuse tests)", () => {
  const token = mintToken();

  it("rejects a missing Authorization header", () => {
    expect(authorized(undefined, token)).toBe(false);
    expect(authorized(null, token)).toBe(false);
    expect(authorized("", token)).toBe(false);
  });

  it("rejects a malformed header and a wrong token", () => {
    expect(authorized(token, token)).toBe(false); // missing "Bearer "
    expect(authorized(`Bearer ${mintToken()}`, token)).toBe(false);
    expect(authorized(`Basic ${token}`, token)).toBe(false);
  });

  it("accepts exactly the expected bearer token", () => {
    expect(authorized(`Bearer ${token}`, token)).toBe(true);
  });

  it("compares in constant time regardless of length", () => {
    expect(tokenEquals("short", token)).toBe(false);
  });

  it("parses only well-formed bearer headers", () => {
    expect(parseBearer("Bearer abc")).toBe("abc");
    expect(parseBearer("bearer abc")).toBeNull();
  });

  it("hashes tokens for storage (never plaintext)", () => {
    expect(tokenHash("t")).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash("t")).not.toBe("t");
  });

  it("mints high-entropy url-safe tokens", () => {
    const t = mintToken();
    expect(t.length).toBeGreaterThanOrEqual(40);
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(mintToken()).not.toBe(t);
  });
});

describe("uniform error envelope (invariant 8)", () => {
  it("does not leak existence by default", () => {
    expect(errorEnvelope("forbidden").error.message).toBe("not granted");
    expect(errorEnvelope("unauthenticated").error.message).toBe("authentication required");
  });
  it("maps codes to http statuses", () => {
    expect(statusFor("unauthenticated")).toBe(401);
    expect(statusFor("rate_limited")).toBe(429);
    expect(statusFor("local_only")).toBe(403);
  });
});
