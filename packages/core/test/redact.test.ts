import { describe, expect, it } from "vitest";
import {
  REDACTED,
  SecretRedactor,
  containsRedactedPlaceholder,
  redactSecrets,
  redactedSecret,
  scrubModelOutput,
} from "../src/redact.js";
import { secretRefsIn } from "../src/secrets.js";

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

describe("SecretRedactor — values, on the way back (§2.14, T4-2)", () => {
  const TOKEN = "ghp_SENTINEL-abcdef-123";
  const make = () => {
    const r = new SecretRedactor();
    r.learn("github_write", TOKEN);
    return r;
  };

  it("replaces a value with its name — a transcript shows the name", () => {
    expect(make().redactText(`auth failed for ${TOKEN}.`)).toBe(`auth failed for ${redactedSecret("github_write")}.`);
  });

  it("the marker is a placeholder and never a reference the fill would expand", () => {
    expect(containsRedactedPlaceholder(redactedSecret("github_write"))).toBe(true);
    expect(secretRefsIn(redactedSecret("github_write"))).toEqual({ names: [], malformed: [] });
  });

  it("catches the JSON-escaped, URL-encoded and base64 spellings", () => {
    const r = new SecretRedactor();
    const v = 'a"b\\c d/e+f=SENTINEL';
    r.learn("odd", v);
    for (const form of [v, JSON.stringify(v).slice(1, -1), encodeURIComponent(v), Buffer.from(v).toString("base64"), Buffer.from(v).toString("base64url")]) {
      expect(r.redactText(`x ${form} y`), form).toBe(`x ${redactedSecret("odd")} y`);
      expect(r.find(form)).toEqual(["odd"]);
    }
  });

  it("a value containing another is redacted whole, longest first", () => {
    const r = new SecretRedactor();
    r.learn("short", "abcd1234");
    r.learn("long", "xx-abcd1234-yy");
    expect(r.redactText("xx-abcd1234-yy and abcd1234")).toBe(`${redactedSecret("long")} and ${redactedSecret("short")}`);
  });

  it("never rewrites a marker it already wrote", () => {
    const r = new SecretRedactor();
    r.learn("github_write", "REDACTED secret");
    expect(r.redactText("REDACTED secret")).toBe(redactedSecret("github_write"));
  });

  it("redacts a structure, keys included, and knows only names", () => {
    const r = make();
    expect(r.redact({ [TOKEN]: [{ m: `x${TOKEN}` }], n: 1 })).toEqual({ [redactedSecret("github_write")]: [{ m: `x${redactedSecret("github_write")}` }], n: 1 });
    expect(r.size).toBe(1);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it("an error comes back with a redacted message and no cause", () => {
    const e = make().redactError(new TypeError(`fetch failed: ${TOKEN}`, { cause: { token: TOKEN } }));
    expect(e.message).toBe(`fetch failed: ${redactedSecret("github_write")}`);
    expect(e.name).toBe("TypeError");
    expect(e.cause).toBeUndefined();
  });

  it("prime learns every named value from a store, returning names", async () => {
    const r = new SecretRedactor();
    const learned = await r.prime(["a_one", "b_two", "absent"], { value: async (n) => (n === "absent" ? undefined : `${n}-SENTINEL-value`) });
    expect(learned).toEqual(["a_one", "b_two"]);
    expect(r.find("x b_two-SENTINEL-value")).toEqual(["b_two"]);
  });

  it("streaming: redactPrefix over any chunking equals redactText over the whole", () => {
    const r = make();
    r.learn("other", "zz-OTHER-SENTINEL-zz");
    const whole = `start ${TOKEN} mid zz-OTHER-SENTINEL-zz ${TOKEN}${TOKEN} end ${encodeURIComponent(TOKEN)}`;
    const expected = r.redactText(whole);
    for (let size = 1; size <= whole.length; size += 3) {
      let buf = "";
      let out = "";
      for (let i = 0; i < whole.length; i += size) {
        buf += whole.slice(i, i + size);
        const safe = buf.length - (r.longestForm - 1);
        if (safe <= 0) continue;
        const step = r.redactPrefix(buf, safe);
        out += step.text;
        buf = buf.slice(step.consumed);
      }
      out += r.redactText(buf);
      expect(out, `chunk ${size}`).toBe(expected);
    }
  });

  it("refuses a name that is not a secret name", () => {
    expect(() => new SecretRedactor().learn("Not A Name", "v")).toThrow(/not a secret name/);
  });
});
