// Per-instance secrets (design-build-plan §2.14, T4-1): the names, the
// Keychain naming, `secrets.yaml`, the `{{ secret.x }}` resolver and the
// store. Every Keychain here is `memoryKeychain()` — the real login Keychain
// is never touched by a test.
//
// The bold test is the isolation one: two instances on ONE shared Keychain,
// exactly as two instance directories on one Mac share the login Keychain,
// and neither can read, overwrite, delete or even see the other's item.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SECRET_GRANT,
  InstanceSecrets,
  describeSecrets,
  fillSecretRefs,
  instancePresence,
  isSecretName,
  memoryKeychain,
  normalizeSecretHost,
  parseSecretGrantee,
  parseSecretReference,
  parseSecretsFile,
  secretAccount,
  secretEnvName,
  secretGrant,
  secretRefsIn,
  secretService,
  type KeychainBackend,
  type SecretSource,
} from "../src/index.js";

const A = "11111111-2222-4333-8444-555555555555";
const B = "66666666-7777-4888-9999-aaaaaaaaaaaa";
const VALUE_A = "ghp_instanceA-SENTINEL-value";
const VALUE_B = "ghp_instanceB-other-value";

const source = (values: Record<string, string>): SecretSource => ({ value: async (n) => values[n] });

describe("names and Keychain naming", () => {
  it("a name is lowercase snake_case, at most 64 characters", () => {
    for (const ok of ["github_write", "a", "devin_api_key", "k2", "a".repeat(64)]) expect(isSecretName(ok), ok).toBe(true);
    for (const bad of ["", "GitHub", "METISTRY_DEVIN_API_KEY", "2fa", "_x", "a-b", "a.b", "a:b", "a/b", "../x", "a b", "a\u0000", "é", "a".repeat(65), "secret:x"]) {
      expect(isSecretName(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("the item is service metistry:secret:<name>, account <instance_id> — and nothing else can be spelled", () => {
    expect(secretService("github_write")).toBe("metistry:secret:github_write");
    expect(secretAccount(A)).toBe(A);
    expect(() => secretService("GITHUB")).toThrow(/not a secret name/);
    expect(() => secretService("x:y")).toThrow(/not a secret name/);
    // the per-user account the shared scope used, and anything that is not a v4 instance_id
    for (const bad of ["metistry", "", B.toUpperCase(), `${A}x`, "../11111111-2222-4333-8444-555555555555"]) {
      expect(() => secretAccount(bad), JSON.stringify(bad)).toThrow(/not an instance_id/);
    }
  });

  it("a local agent gets a granted secret as the upper-cased name", () => {
    expect(secretEnvName("github_read")).toBe("GITHUB_READ");
    expect(() => secretEnvName("PATH")).toThrow();
  });
});

describe("**one instance can never read another's item**", () => {
  it("two instances on one shared Keychain: A's item is invisible to B — value, presence, the resolver and the listing", async () => {
    const kc = memoryKeychain();
    const a = new InstanceSecrets(kc, A);
    const b = new InstanceSecrets(kc, B);
    await a.set("github_write", VALUE_A);

    expect(await a.value("github_write")).toBe(VALUE_A);
    expect(await b.value("github_write")).toBeUndefined();
    expect(await b.has("github_write")).toBe(false);
    expect(await b.presence().has("github_write")).toBe(false);

    const filled = await fillSecretRefs("Bearer {{ secret.github_write }}", b);
    expect(filled.ok).toBe(false);
    expect(JSON.stringify(filled)).not.toContain(VALUE_A);

    const policy = parseSecretsFile("secrets:\n  github_write: { hosts: [api.github.com] }\n");
    const [row] = await describeSecrets(policy, b.presence());
    expect(row?.present).toBe(false);

    // the item really is there, under A's account and no other
    expect(kc.items()).toEqual([{ service: "metistry:secret:github_write", account: A }]);
  });

  it("B writing the same name makes B's own item and leaves A's alone; B removing it removes only B's", async () => {
    const kc = memoryKeychain();
    const a = new InstanceSecrets(kc, A);
    const b = new InstanceSecrets(kc, B);
    await a.set("github_write", VALUE_A);
    await b.set("github_write", VALUE_B);
    expect(await a.value("github_write")).toBe(VALUE_A);
    expect(await b.value("github_write")).toBe(VALUE_B);

    expect(await b.remove("github_write")).toBe(true);
    expect(await b.remove("github_write")).toBe(false);
    expect(await a.value("github_write")).toBe(VALUE_A);
  });

  it("nothing on the store takes an account: every door takes a name, and a crafted name is refused before the Keychain is asked", async () => {
    const asked: string[] = [];
    const spy: KeychainBackend = {
      get: async (s, acc) => (asked.push(`${acc}/${s}`), undefined),
      has: async (s, acc) => (asked.push(`${acc}/${s}`), false),
      set: async (s, acc) => void asked.push(`${acc}/${s}`),
      delete: async (s, acc) => (asked.push(`${acc}/${s}`), false),
    };
    const b = new InstanceSecrets(spy, B);
    // one argument each (set: name and value) — there is no parameter to put another account in
    expect([b.value.length, b.has.length, b.remove.length, b.set.length]).toEqual([1, 1, 1, 2]);
    // the backend is a private field: not a property anyone can reach around the binding
    expect(Object.keys(b)).toEqual(["account"]);
    expect((b as unknown as Record<string, unknown>).backend).toBeUndefined();

    for (const crafted of [`github_write:${A}`, `../${A}/github_write`, "GITHUB_WRITE", "metistry:secret:github_write", `github_write\u0000${A}`, ""]) {
      await expect(b.value(crafted), JSON.stringify(crafted)).rejects.toThrow(/not a secret name/);
      await expect(b.has(crafted)).rejects.toThrow(/not a secret name/);
      await expect(b.remove(crafted)).rejects.toThrow(/not a secret name/);
    }
    await b.value("github_write");
    // everything that did reach the Keychain was addressed to B's account
    expect(asked.length).toBeGreaterThan(0);
    for (const a of asked) expect(a.startsWith(`${B}/metistry:secret:`), a).toBe(true);
  });

  it("the shared scope is never read: an item under the per-user account, or an install variable, is not this instance's", async () => {
    const kc = memoryKeychain([
      { service: "metistry:secret:devin_api_key", account: "metistry", value: "user-scope-value" },
      { service: "metistry:METISTRY_DEVIN_API_KEY", account: "metistry", value: "legacy-value" },
      { service: "metistry:METISTRY_DEVIN_API_KEY", account: A, value: "legacy-instance-value" },
    ]);
    const a = new InstanceSecrets(kc, A);
    expect(await a.value("devin_api_key")).toBeUndefined();
    expect(await a.has("devin_api_key")).toBe(false);
    expect(() => new InstanceSecrets(kc, "metistry")).toThrow(/not an instance_id/);
  });

  it("a presence probe is bound the same way", async () => {
    const kc = memoryKeychain([{ service: "metistry:secret:x", account: A, value: VALUE_A }]);
    expect(await instancePresence((s, acc) => kc.has(s, acc), A).has("x")).toBe(true);
    expect(await instancePresence((s, acc) => kc.has(s, acc), B).has("x")).toBe(false);
    expect(() => instancePresence((s, acc) => kc.has(s, acc), "metistry")).toThrow(/not an instance_id/);
  });
});

describe("storing a value", () => {
  it("refuses an empty value and one with a newline, and stores nothing", async () => {
    const kc = memoryKeychain();
    const a = new InstanceSecrets(kc, A);
    await expect(a.set("x", "")).rejects.toThrow(/empty/);
    await expect(a.set("x", "one\ntwo")).rejects.toThrow(/newline/);
    expect(kc.items()).toEqual([]);
  });

  it("reads the value back, and a Keychain that did not keep it whole leaves nothing behind", async () => {
    const kc = memoryKeychain();
    const truncating: KeychainBackend = { ...kc, set: (s, acc, v) => kc.set(s, acc, v.slice(0, 8)) };
    const a = new InstanceSecrets(truncating, A);
    await expect(a.set("long_key", "0123456789abcdef")).rejects.toThrow(/did not keep the value of long_key whole/);
    expect(await kc.has("metistry:secret:long_key", A)).toBe(false);
  });
});

describe("the resolver: {{ secret.name }}", () => {
  it("fills every reference from the store and reports the names it used", async () => {
    const r = await fillSecretRefs("Authorization: Bearer {{ secret.github_write }} / {{secret.github_write}} / {{ secret.other }}", source({ github_write: "v1", other: "v2" }));
    expect(r).toEqual({ ok: true, text: "Authorization: Bearer v1 / v1 / v2", used: ["github_write", "other"] });
  });

  it("is all or nothing: a missing name fills nothing and returns names, never a partial string", async () => {
    const r = await fillSecretRefs("{{ secret.present }} and {{ secret.absent }}", source({ present: VALUE_A }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.missing).toEqual(["absent"]);
    expect(r.message).toContain("{{ secret.absent }}");
    expect(JSON.stringify(r)).not.toContain(VALUE_A);
  });

  it("an empty value counts as missing", async () => {
    const r = await fillSecretRefs("{{ secret.blank }}", source({ blank: "" }));
    expect(r.ok).toBe(false);
  });

  it("refuses a malformed reference rather than sending the braces", async () => {
    for (const t of ["{{ secret.GitHub }}", "{{ secrets.x }}", "{{secret}}", "{{ Secret.x }}", "{{ secret.x.y }}", "{{ secret.x-y }}", "{{ SECRET.x }}"]) {
      const r = await fillSecretRefs(`Bearer ${t}`, source({ x: "v" }));
      expect(r.ok, t).toBe(false);
      if (!r.ok) expect(r.malformed, t).toEqual([t]);
    }
  });

  it("fills in one pass: a value that looks like a reference, or a replacement pattern, goes in as it is", async () => {
    const r = await fillSecretRefs("{{ secret.a }}|{{ secret.b }}", source({ a: "{{ secret.b }}", b: "$&$1$$" }));
    expect(r).toEqual({ ok: true, text: "{{ secret.b }}|$&$1$$", used: ["a", "b"] });
  });

  it("leaves {{ variable.x }} and every other brace for their own resolvers", async () => {
    const r = await fillSecretRefs("{{ variable.company }} {{ today }} {{ secret.k }}", source({ k: "v" }));
    expect(r).toEqual({ ok: true, text: "{{ variable.company }} {{ today }} v", used: ["k"] });
  });

  it("lists references and attempts at one", () => {
    expect(secretRefsIn("{{ secret.a }} {{ secret.b }} {{ secret.a }} {{ secret.B }}")).toEqual({ names: ["a", "b"], malformed: ["{{ secret.B }}"] });
    expect(secretRefsIn("no references here {{ variable.x }}")).toEqual({ names: [], malformed: [] });
  });

  it("a one-reference field takes {{ secret.name }}, or env:NAME for one release", () => {
    expect(parseSecretReference("{{ secret.github_write }}")).toEqual({ kind: "secret", name: "github_write" });
    expect(parseSecretReference("  {{secret.k}} ")).toEqual({ kind: "secret", name: "k" });
    expect(parseSecretReference("env:METISTRY_DEVIN_API_KEY")).toEqual({ kind: "env", name: "METISTRY_DEVIN_API_KEY", deprecated: true });
    for (const bad of ["github_write", "Bearer {{ secret.k }}", "env:lower", "env:", "{{ secret.K }}", "METISTRY_X"]) expect(parseSecretReference(bad), bad).toBeUndefined();
  });
});

describe("secrets.yaml", () => {
  const FILE = `# names and policy — never a value
secrets:
  github_write:
    hosts: [api.github.com]
    grants:
      connection:github: on
      agent:devin: ask
    expires: 2026-12-31
  lmstudio_key:
    hosts: ["127.0.0.1:1234"]
`;

  it("parses names, hosts, grants and expiry", () => {
    const f = parseSecretsFile(FILE);
    expect(f.secrets.github_write).toEqual({ hosts: ["api.github.com"], grants: { "connection:github": "on", "agent:devin": "ask" }, expires: "2026-12-31" });
    expect(f.secrets.lmstudio_key).toEqual({ hosts: ["127.0.0.1:1234"], grants: {} });
    expect(parseSecretsFile("")).toEqual({ secrets: {} });
    expect(parseSecretsFile("secrets: {}\n")).toEqual({ secrets: {} });
  });

  it("**cannot carry a value**: any field the policy does not name is refused, so the file does not load", () => {
    expect(() => parseSecretsFile("secrets:\n  k:\n    value: sk-live-123\n")).toThrow(/secrets\.k.*value|Unrecognized key/);
    expect(() => parseSecretsFile("secrets:\n  k: sk-live-123\n")).toThrow(/does not validate/);
    expect(() => parseSecretsFile("secrets: {}\nk: sk-live-123\n")).toThrow(/does not validate/);
  });

  it("refuses a host with a scheme, a path, a wildcard or capitals; a bad grantee or mode; a bad name; a bad date", () => {
    for (const host of ["https://api.github.com", "api.github.com/v3", "*.github.com", "API.github.com", "api..github.com", ""]) {
      expect(() => parseSecretsFile(`secrets:\n  k: { hosts: ["${host}"] }\n`), host).toThrow(/does not validate/);
    }
    expect(() => parseSecretsFile("secrets:\n  k: { grants: { github: on } }\n")).toThrow(/grantee/);
    expect(() => parseSecretsFile("secrets:\n  k: { grants: { connection:github: always } }\n")).toThrow(/does not validate/);
    expect(() => parseSecretsFile("secrets:\n  GitHub: { hosts: [] }\n")).toThrow(/snake_case/);
    expect(() => parseSecretsFile("secrets:\n  k: { expires: next week }\n")).toThrow(/ISO date/);
  });

  it("a grantee the file does not name is Off; so is everyone, for a secret it does not name", () => {
    const f = parseSecretsFile(FILE);
    expect(secretGrant(f, "github_write", "connection:github")).toBe("on");
    expect(secretGrant(f, "github_write", "agent:devin")).toBe("ask");
    expect(secretGrant(f, "github_write", "agent:assistant")).toBe(DEFAULT_SECRET_GRANT);
    expect(DEFAULT_SECRET_GRANT).toBe("off");
    expect(secretGrant(f, "nope", "connection:github")).toBe("off");
    expect(secretGrant(f, "constructor", "connection:github")).toBe("off");
  });

  it("grantees are connection:<name> or agent:<id>; hosts are egress entries", () => {
    expect(parseSecretGrantee("connection:google-calendar")).toEqual({ kind: "connection", name: "google-calendar" });
    expect(parseSecretGrantee("agent:devin")).toEqual({ kind: "agent", name: "devin" });
    for (const bad of ["devin", "agent:", "agent:Devin", "user:me", "connection:a b", "agent:devin@x"]) expect(parseSecretGrantee(bad), bad).toBeUndefined();
    expect(normalizeSecretHost("API.GitHub.com")).toBe("api.github.com");
    expect(normalizeSecretHost("example.test:8443")).toBe("example.test:8443");
    expect(normalizeSecretHost("https://x.test")).toBeUndefined();
    expect(normalizeSecretHost("*.x.test")).toBeUndefined();
  });
});

describe("the listing", () => {
  it("names, hosts, grants, expiry, presence and last used — and never a value, though the Keychain holds one", async () => {
    const kc = memoryKeychain();
    const a = new InstanceSecrets(kc, A);
    await a.set("github_write", VALUE_A);
    const f = parseSecretsFile("secrets:\n  zeta: { hosts: [z.test] }\n  github_write:\n    hosts: [api.github.com]\n    grants: { connection:github: on }\n");
    const rows = await describeSecrets(f, a.presence(), new Map([["github_write", "2026-09-28T13:00:02.000Z"]]));
    expect(rows).toEqual([
      { name: "github_write", hosts: ["api.github.com"], grants: [{ to: "connection:github", mode: "on" }], expires: null, present: true, last_used: "2026-09-28T13:00:02.000Z" },
      { name: "zeta", hosts: ["z.test"], grants: [], expires: null, present: false, last_used: null },
    ]);
    expect(JSON.stringify(rows)).not.toContain(VALUE_A);
  });

  it("presence is null, not false, where there is no Keychain to ask", async () => {
    const rows = await describeSecrets(parseSecretsFile("secrets:\n  k: {}\n"), undefined);
    expect(rows[0]?.present).toBeNull();
  });
});
