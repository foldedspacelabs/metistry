import { describe, expect, it } from "vitest";
import { sanitizeForAgent } from "../src/sanitize.js";
import { errorEnvelope, statusFor } from "../src/errors.js";

describe("sanitizeForAgent (§4.20 text boundary)", () => {
  it("strips bidi overrides and isolates", () => {
    for (const cp of [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]) {
      const ch = String.fromCodePoint(cp);
      expect(sanitizeForAgent(`a${ch}b`), cp.toString(16)).toBe("ab");
    }
    // the Trojan Source shape: what a reader sees is not what is parsed
    expect(sanitizeForAgent("return‮ // check_admin⁦")).toBe("return // check_admin");
  });

  it("strips zero-width characters", () => {
    for (const cp of [0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2060, 0xfeff]) {
      expect(sanitizeForAgent(`a${String.fromCodePoint(cp)}b`), cp.toString(16)).toBe("ab");
    }
    expect(sanitizeForAgent("﻿hello")).toBe("hello"); // BOM
  });

  it("never returns text that starts with a slash", () => {
    expect(sanitizeForAgent("/clear")).toBe("clear");
    expect(sanitizeForAgent("  ///compact now")).toBe("compact now");
    expect(sanitizeForAgent("​/exit")).toBe("exit"); // a hidden char before the slash does not rescue it
    expect(sanitizeForAgent("a /b")).toBe("a /b"); // only the leading position matters
    expect(sanitizeForAgent("/")).toBe("");
  });

  it("is idempotent and leaves ordinary text alone", () => {
    const plain = "Résumé — naïve café, 日本語, emoji 🎉, path Knowledge/Areas/Fsl";
    expect(sanitizeForAgent(plain)).toBe(plain);
    const once = sanitizeForAgent("‮/x​");
    expect(sanitizeForAgent(once)).toBe(once);
  });
});

describe("not_available envelope", () => {
  it("is a 503 with a generic message, overridable", () => {
    expect(statusFor("not_available")).toBe(503);
    expect(errorEnvelope("not_available")).toEqual({ error: { code: "not_available", message: "not available" } });
    expect(errorEnvelope("not_available", "no vault read path").error.message).toBe("no vault read path");
  });
});
