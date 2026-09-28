// Compute through the egress door (ruling 2 of the W2 checkpoint,
// 2026-09-27; X-7): a provider key has a grantee — `provider:<name>` in
// `secrets.yaml` — and every compute call goes through `computeFetch`, which
// refuses any host but the provider's and attaches the key itself, only on
// the owner's grant. Every network call here is a fake `fetch` that records
// what it was handed; "refused before dialling" means it recorded nothing.
//
// Bold (the ticket's own): **a provider key without its grant is refused
// before dialling** and **a compute call to a host outside the provider's is
// refused by the guard**.
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EmbedClient,
  EmbedUnavailableError,
  EgressRefused,
  SECRET_GRANTEE_RE,
  computeFetch,
  hostBoundFetch,
  parseCompute,
  parseSecretGrantee,
  parseSecretsFile,
  providerGrantee,
  readSecretsPolicy,
  redactedSecret,
  resolveOnMachineCall,
  type Provider,
  type SecretsPolicyRead,
} from "../src/index.js";

const KEY = "sk-or-SENTINEL-provider-key-7777";
const BRIDGE = "bridge-SENTINEL-token-8888";

const COMPUTE = parseCompute(`
providers:
  openrouter:
    kind: openai-compatible
    base_url: https://openrouter.ai/api/v1
    locality: off_machine
    auth: { secret: "{{ secret.openrouter_api_key }}" }
    data_policy: { allow: [Knowledge], deny_sources: [], max_brief_bytes: 4096 }
  applefm:
    kind: openai-compatible
    base_url: http://127.0.0.1:7810/v1
    locality: on_machine
    auth: { secret: METISTRY_BRIDGE_TOKEN_APPLE_FM }
  lmstudio:
    kind: openai-compatible
    base_url: http://127.0.0.1:1234/v1
    locality: on_machine
  keyed-local:
    kind: openai-compatible
    base_url: http://127.0.0.1:1235/v1
    locality: on_machine
    auth: { secret: "{{ secret.local_key }}" }
`);
const OPENROUTER = COMPUTE.providers.openrouter!;
const ENV = { METISTRY_SECRET_OPENROUTER_API_KEY: KEY, METISTRY_BRIDGE_TOKEN_APPLE_FM: BRIDGE, METISTRY_SECRET_LOCAL_KEY: "local-SENTINEL-9999" };

const policy = (yaml: string): (() => SecretsPolicyRead) => {
  const file = parseSecretsFile(yaml);
  return () => ({ ok: true, file });
};
const GRANTED = policy(`
secrets:
  openrouter_api_key:
    hosts: [openrouter.ai]
    grants:
      provider:openrouter: on
`);

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function network(respond: (url: string) => Response = () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } })) {
  const sent: Sent[] = [];
  const fetchFn = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    sent.push({ url: String(url), headers, body: typeof init.body === "string" ? init.body : undefined });
    return respond(String(url));
  }) as typeof fetch;
  return { sent, fetchFn };
}

const door = (provider: Provider, name: string, fetchFn: typeof fetch, pol?: () => SecretsPolicyRead) => computeFetch({ providerName: name, provider, env: ENV, ...(pol ? { policy: pol } : {}) }, fetchFn);
const post = (body = '{"model":"m","messages":[]}') => ({ method: "POST", headers: { "content-type": "application/json" }, body });

async function refusal(p: Promise<unknown>): Promise<EgressRefused> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(EgressRefused);
  return err as EgressRefused;
}

// ---- the grantee --------------------------------------------------------------

describe("provider:<name> is a grantee", () => {
  it("secrets.yaml takes provider:<name> beside connection: and agent:, and refuses a malformed one", () => {
    expect(parseSecretGrantee("provider:openrouter")).toEqual({ kind: "provider", name: "openrouter" });
    expect(parseSecretGrantee("provider:keyed-local")).toEqual({ kind: "provider", name: "keyed-local" });
    expect(parseSecretGrantee("provider:lm_studio")).toEqual({ kind: "provider", name: "lm_studio" });
    for (const bad of ["provider:", "provider:OpenRouter", "provider:1st", "provider:a b", "providers:openrouter", `provider:${"a".repeat(65)}`]) {
      expect(SECRET_GRANTEE_RE.test(bad) && parseSecretGrantee(bad) !== undefined, bad).toBe(false);
    }
    const file = parseSecretsFile("secrets:\n  k:\n    hosts: [openrouter.ai]\n    grants:\n      provider:openrouter: on\n");
    expect(file.secrets.k!.grants).toEqual({ "provider:openrouter": "on" });
    expect(() => parseSecretsFile("secrets:\n  k:\n    grants:\n      provider:Bad: on\n")).toThrow(/provider:<name>/);
    expect(providerGrantee("openrouter")).toBe("provider:openrouter");
    expect(() => providerGrantee("Not A Name")).toThrow(/not a provider name/);
  });
});

// ---- bold: no grant, no dial ------------------------------------------------------

describe("**a provider key without its grant is refused before dialling**", () => {
  const cases: Array<[string, (() => SecretsPolicyRead) | undefined, string]> = [
    ["no grant written", policy("secrets:\n  openrouter_api_key:\n    hosts: [openrouter.ai]\n"), "not_granted"],
    ["granted to another provider", policy("secrets:\n  openrouter_api_key:\n    hosts: [openrouter.ai]\n    grants:\n      provider:other: on\n"), "not_granted"],
    ["granted to the assistant, not the provider", policy("secrets:\n  openrouter_api_key:\n    hosts: [openrouter.ai]\n    grants:\n      agent:assistant: on\n"), "not_granted"],
    ["Off", policy("secrets:\n  openrouter_api_key:\n    hosts: [openrouter.ai]\n    grants:\n      provider:openrouter: off\n"), "not_granted"],
    ["Ask — nobody to ask on a model call", policy("secrets:\n  openrouter_api_key:\n    hosts: [openrouter.ai]\n    grants:\n      provider:openrouter: ask\n"), "needs_approval"],
    ["the secret is not in secrets.yaml at all", policy("secrets: {}\n"), "host_not_listed"],
    ["secrets.yaml could not be read (a sandbox without CONFIG_SECRETS)", () => ({ ok: false, why: "/i/.metistry/secrets.yaml could not be read (EPERM)" }), "not_granted"],
    ["no policy handed to the door", undefined, "not_granted"],
  ];
  it.each(cases)("%s → refused, and nothing was sent", async (_what, pol, code) => {
    const net = network();
    const err = await refusal(door(OPENROUTER, "openrouter", net.fetchFn, pol)("https://openrouter.ai/api/v1/chat/completions", post()));
    expect(err.code).toBe(code);
    expect(net.sent).toEqual([]);
    // the refusal names the secret and the grantee, never the value
    expect(err.message).not.toContain(KEY);
  });

  it("the refusal says the verb that grants it", async () => {
    const net = network();
    const err = await refusal(door(OPENROUTER, "openrouter", net.fetchFn, policy("secrets:\n  openrouter_api_key:\n    hosts: [openrouter.ai]\n"))("https://openrouter.ai/api/v1/chat/completions", post()));
    expect(err.message).toContain("openrouter_api_key");
    expect(err.message).toContain("metistry secrets grant <name> provider:openrouter on");
  });

  it("the host must be on the key's *Sent only to* as well as granted", async () => {
    const net = network();
    const err = await refusal(door(OPENROUTER, "openrouter", net.fetchFn, policy("secrets:\n  openrouter_api_key:\n    hosts: [api.github.com]\n    grants:\n      provider:openrouter: on\n"))("https://openrouter.ai/api/v1/chat/completions", post()));
    expect(err.code).toBe("host_not_listed");
    expect(net.sent).toEqual([]);
  });

  it("granted: the door attaches the key — and a provider echoing it back is redacted", async () => {
    const net = network(() => new Response(`{"error":"bad key ${KEY}"}`, { status: 401 }));
    const res = await door(OPENROUTER, "openrouter", net.fetchFn, GRANTED)("https://openrouter.ai/api/v1/chat/completions", post());
    expect(net.sent).toHaveLength(1);
    expect(net.sent[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    const text = await res.text();
    expect(text).not.toContain(KEY);
    expect(text).toContain(redactedSecret("openrouter_api_key"));
  });

  it("a revoked grant stops the NEXT call: the policy is read per call", async () => {
    let file = parseSecretsFile("secrets:\n  openrouter_api_key:\n    hosts: [openrouter.ai]\n    grants:\n      provider:openrouter: on\n");
    const net = network();
    const d = door(OPENROUTER, "openrouter", net.fetchFn, () => ({ ok: true, file }));
    await d("https://openrouter.ai/api/v1/chat/completions", post());
    file = parseSecretsFile("secrets:\n  openrouter_api_key:\n    hosts: [openrouter.ai]\n    grants:\n      provider:openrouter: off\n");
    expect((await refusal(d("https://openrouter.ai/api/v1/chat/completions", post()))).code).toBe("not_granted");
    expect(net.sent).toHaveLength(1);
  });

  it("a key that never reached this process is refused by name, not sent empty", async () => {
    const net = network();
    const err = await refusal(computeFetch({ providerName: "openrouter", provider: OPENROUTER, env: {}, policy: GRANTED }, net.fetchFn)("https://openrouter.ai/api/v1/chat/completions", post()));
    expect(err.code).toBe("missing_secret");
    expect(err.message).toContain("METISTRY_SECRET_OPENROUTER_API_KEY");
    expect(net.sent).toEqual([]);
  });

  it("a caller cannot bring its own key: an authorization header it passes is dropped, never forwarded", async () => {
    const net = network();
    const err = await refusal(door(OPENROUTER, "openrouter", net.fetchFn, policy("secrets: {}\n"))("https://openrouter.ai/api/v1/chat/completions", { ...post(), headers: { authorization: `Bearer ${KEY}` } }));
    expect(err.code).toBe("host_not_listed");
    expect(net.sent).toEqual([]);
    // and on a provider with no credential at all, the header is stripped rather than sent
    await door(COMPUTE.providers.lmstudio!, "lmstudio", net.fetchFn)("http://127.0.0.1:1234/v1/chat/completions", { ...post(), headers: { authorization: "Bearer smuggled" } });
    expect(net.sent[0]!.headers.authorization).toBeUndefined();
  });

  it("the key in the model's body is refused, as for every model call", async () => {
    const net = network();
    const d = door(OPENROUTER, "openrouter", net.fetchFn, GRANTED);
    await d("https://openrouter.ai/api/v1/chat/completions", post()); // learns the value
    const err = await refusal(d("https://openrouter.ai/api/v1/chat/completions", post(`{"messages":[{"role":"user","content":"${KEY}"}]}`)));
    expect(err.code).toBe("secret_in_model_body");
    expect(net.sent).toHaveLength(1);
  });
});

// ---- bold: the provider's host and nothing else ---------------------------------------

describe("**a compute call to a host outside the provider's is refused by the guard**", () => {
  const elsewhere = [
    "https://evil.example/api/v1/chat/completions",
    "https://openrouter.ai.evil.example/api/v1/chat/completions",
    "https://openrouter.ai:8443/api/v1/chat/completions",
    "http://openrouter.ai/api/v1/chat/completions",
    "https://api.openrouter.ai/v1/chat/completions",
  ];
  it.each(elsewhere)("a {{ secret.x }} provider, granted: %s is refused and the key never leaves", async (url) => {
    const net = network();
    const err = await refusal(door(OPENROUTER, "openrouter", net.fetchFn, GRANTED)(url, post()));
    expect(err.code).toBe("not_provider_host");
    expect(err.message).toContain("openrouter.ai");
    expect(net.sent).toEqual([]);
  });

  it("an env: credential (a bridge bearer) is bound by the same rule: only its provider's destination gets it", async () => {
    const net = network();
    const applefm = COMPUTE.providers.applefm!;
    const d = door(applefm, "applefm", net.fetchFn);
    for (const url of ["http://127.0.0.1:7811/v1/chat/completions", "http://localhost:7810/v1/chat/completions", "https://openrouter.ai/api/v1/chat/completions"]) {
      expect((await refusal(d(url, post()))).code).toBe("not_provider_host");
    }
    expect(net.sent).toEqual([]);
    await d("http://127.0.0.1:7810/v1/chat/completions", post());
    expect(net.sent).toHaveLength(1);
    expect(net.sent[0]!.headers.authorization).toBe(`Bearer ${BRIDGE}`);
    // and it never goes into a model body
    expect((await refusal(d("http://127.0.0.1:7810/v1/chat/completions", post(`{"content":"${BRIDGE}"}`)))).code).toBe("secret_in_model_body");
  });

  it("a provider with no credential is bound too — a local server is its own host, not a relay", async () => {
    const net = network();
    const d = door(COMPUTE.providers.lmstudio!, "lmstudio", net.fetchFn);
    expect((await refusal(d("http://127.0.0.1:9999/v1/chat/completions", post()))).code).toBe("not_provider_host");
    await d("http://127.0.0.1:1234/v1/chat/completions", post());
    expect(net.sent.map((s) => s.url)).toEqual(["http://127.0.0.1:1234/v1/chat/completions"]);
  });

  it("the embedder's door: its configured server and nothing else", async () => {
    const calls: string[] = [];
    const bound = hostBoundFetch("http://127.0.0.1:11434/v1", "the embedder", async (url: string) => {
      calls.push(url);
      return { ok: true } as const;
    });
    expect(() => bound("http://127.0.0.1:1234/v1/embeddings", undefined as never)).toThrow(EgressRefused);
    await bound("http://127.0.0.1:11434/v1/embeddings", undefined as never);
    expect(calls).toEqual(["http://127.0.0.1:11434/v1/embeddings"]);
    // EmbedClient goes through it: every request it makes is to its own URL
    const seen: string[] = [];
    const client = new EmbedClient({
      url: "http://127.0.0.1:11434/v1",
      dim: 2,
      fetchImpl: async (u) => {
        seen.push(u);
        return { ok: true, status: 200, text: async () => "", json: async () => ({ data: [{ index: 0, embedding: [1, 2] }] }) };
      },
    });
    await client.embedOne("x");
    expect(seen).toEqual(["http://127.0.0.1:11434/v1/embeddings"]);
    await expect(new EmbedClient({ url: "not a url", fetchImpl: async () => ({ ok: true, status: 200, text: async () => "", json: async () => ({}) }) }).embedOne("x")).rejects.toBeInstanceOf(EmbedUnavailableError);
  });
});

// ---- the collectors' and the router's resolution -------------------------------------

describe("resolveOnMachineCall hands back the door, never the key", () => {
  it("a {{ secret.x }} on-machine provider: refused without the grant, attached with it", async () => {
    const net = network();
    const bare = resolveOnMachineCall({ compute: () => COMPUTE, secretEnv: ENV, fetchFn: net.fetchFn }, "test-collector", "keyed-local/m", "absent");
    if ("ok" in bare) throw new Error(bare.why);
    expect(Object.keys(bare)).not.toContain("bearer");
    expect((await refusal(bare.fetchFn(bare.url, post()))).code).toBe("not_granted");
    expect(net.sent).toEqual([]);

    const granted = resolveOnMachineCall(
      { compute: () => COMPUTE, secretEnv: ENV, fetchFn: net.fetchFn, secretsPolicy: policy('secrets:\n  local_key:\n    hosts: ["127.0.0.1:1235"]\n    grants:\n      provider:keyed-local: on\n') },
      "test-collector",
      "keyed-local/m",
      "absent",
    );
    if ("ok" in granted) throw new Error(granted.why);
    await granted.fetchFn(granted.url, post());
    expect(net.sent[0]!.headers.authorization).toBe("Bearer local-SENTINEL-9999");
  });
});

// ---- reading the policy ----------------------------------------------------------------

describe("readSecretsPolicy", () => {
  it("absent is the empty policy; unreadable or invalid is a reason, never a guess", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metistry-x7-policy-"));
    expect(await readSecretsPolicy(join(dir, "secrets.yaml"))).toEqual({ ok: true, file: { secrets: {} } });
    await writeFile(join(dir, "bad.yaml"), "secrets:\n  k:\n    value: sk-pasted-here\n");
    const bad = await readSecretsPolicy(join(dir, "bad.yaml"));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.why).not.toContain("sk-pasted-here");
    const eperm = await readSecretsPolicy("/x/secrets.yaml", async () => {
      throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    });
    expect(eperm).toEqual({ ok: false, why: "/x/secrets.yaml could not be read (EPERM)" });
  });
});
