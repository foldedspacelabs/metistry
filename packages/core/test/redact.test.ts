import { describe, expect, it } from "vitest";
import {
  REDACTED,
  containsRedactedPlaceholder,
  redactSecrets,
  scrubModelOutput,
} from "../src/redact.js";

describe("redactSecrets", () => {
  it("redacts secret-named fields at any depth", () => {
    const out = redactSecrets({
      user: "matt",
      api_key: "sk-live-abc",
      nested: { authorization: "Bearer xyz", ok: "keep" },
      list: [{ password: "hunter2" }],
    });
    expect(out.api_key).toBe(REDACTED);
    expect(out.nested.authorization).toBe(REDACTED);
    expect(out.list[0]?.password).toBe(REDACTED);
    expect(out.user).toBe("matt");
    expect(out.nested.ok).toBe("keep");
  });

  it("redacts string leaves under a secret-named parent object", () => {
    const out = redactSecrets({ credentials: { value: "abc", region: "us" } });
    expect(out.credentials.value).toBe(REDACTED);
  });
});

describe("scrubModelOutput — the PoC-13 boundary", () => {
  it("scrubs an OTP that survived prompt instructions", () => {
    expect(scrubModelOutput("Your verification code is 482913")).not.toContain("482913");
  });
  it("scrubs card-like digit groups", () => {
    expect(scrubModelOutput("pay 4242 4242 4242 4242 now")).not.toContain("4242");
  });
  it("leaves prose alone", () => {
    expect(scrubModelOutput("meet at 3pm on the 2nd")).toBe("meet at 3pm on the 2nd");
  });
});

describe("placeholder rejection", () => {
  it("detects the placeholder anywhere in a structure", () => {
    expect(containsRedactedPlaceholder({ a: [{ b: `x ${REDACTED} y` }] })).toBe(true);
    expect(containsRedactedPlaceholder({ a: "clean" })).toBe(false);
  });
});
