// OAuth as a public client (T4-10). Bold, the ticket's own:
//
//   **the loopback listener binds 127.0.0.1 only and closes after one
//   callback**; **`state` and the PKCE verifier are checked** — a callback
//   carrying another state is refused before any code is exchanged, and the
//   fixture authorization server refuses a verifier that is not the one the
//   challenge was made from.
//
// (**The assistant cannot start an OAuth flow** is oauth-reach.test.ts.)
//
// And the rest: the shipped client id and a bring-your-own one; the broker,
// refused; a refresh token stored and nothing else; the access token minted
// at the door, cached, redacted, and sent only where its secret may go.

import { networkInterfaces } from "node:os";
import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { EgressRefused, SecretRedactor, parseSecretsFile } from "@foldedspacelabs/metistry-core";
import {
  ConnectionPool,
  ConnectionRefused,
  OAUTH_CALLBACK_PATH,
  OAuthError,
  authorizeConnection,
  exchangeCode,
  oauthClientOf,
  openLoopback,
  pkceChallenge,
  pkcePair,
  type ConnectionEntry,
} from "../src/index.js";
import { catalogOf, fakeHttpMcp, secretsWith, type FakeHttp } from "./helpers.js";
import { AUTHORIZE_URL, TOKEN_URL, fakeAuthServer, type FakeAuthServer } from "./oauth-server.js";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
});
async function auth(opts: Parameters<typeof fakeAuthServer>[0] = {}): Promise<FakeAuthServer> {
  const s = await fakeAuthServer(opts);
  closers.push(() => s.close());
  return s;
}

/** Does anything answer a TCP connect on host:port? */
function answers(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host, port });
    sock.once("connect", () => {
      sock.destroy();
      resolve(true);
    });
    sock.once("error", () => resolve(false));
  });
}

// ---- connections ----------------------------------------------------------------------

const CLIENT = { authorize_url: AUTHORIZE_URL, token_url: TOKEN_URL, scopes: ["read", "offline_access"], pkce: true, redirect: "loopback" };

/** A custom MCP connection signing in with its own client (C118). */
function customOauth(name: string, url: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    type: "mcp",
    provider: "custom",
    reach: { http: { url, auth: { scheme: "oauth", client: CLIENT, token: `{{ secret.${name}_token }}`, client_id: `{{ secret.${name}_client }}`, ...extra } } },
    secrets: [`${name}_token`, `${name}_client`, ...(extra.client_secret ? [`${name}_secret`] : [])],
    tools: { echo: { group: "reads", mode: "on" }, echo_auth: { group: "reads", mode: "on" } },
  };
}

/** A connection type that ships a public client id — the shape `google-calendar` will have (T4-14). */
const SHIPPED_TYPE = {
  schema: 1,
  name: "example-oauth",
  type: "connection-type",
  provides: "mcp",
  transports: ["http"],
  fields: [{ key: "account", kind: "oauth", label: "Account", oauth: { ...CLIENT, client_id: "shipped-client-id" } }],
};

function typedOauth(name: string, url: string, config: Record<string, string>) {
  return {
    name,
    type: "mcp",
    provider: "example-oauth",
    reach: { http: { url, auth: "oauth" } },
    secrets: Object.values(config).map((v) => /secret\.([a-z_]+)/.exec(v)![1]!),
    config: { account: config },
    tools: { echo: { group: "reads", mode: "on" }, echo_auth: { group: "reads", mode: "on" } },
  };
}

function entryOf(file: Record<string, unknown>, secrets = "", types: Record<string, unknown>[] = [SHIPPED_TYPE]): { entry: ConnectionEntry; secretsFile: ReturnType<typeof parseSecretsFile> } {
  const cat = catalogOf([file], { secrets, types });
  const entry = cat.entries[0]!;
  if (entry.status !== "ok") throw new Error(`${entry.name}: ${entry.issues.join("; ")}`);
  return { entry, secretsFile: parseSecretsFile(secrets) };
}

/** An in-memory token store: what `authorizeConnection` kept. */
function memoryStore() {
  const kept = new Map<string, string>();
  return { kept, set: async (n: string, v: string) => void kept.set(n, v) };
}

// ---- the listener ----------------------------------------------------------------------

describe("**the loopback listener binds 127.0.0.1 only and closes after one callback**", () => {
  it("binds 127.0.0.1 on a port the system picks, and nothing else on this Mac reaches it", async () => {
    const loop = await openLoopback({ state: "s1" });
    closers.push(() => loop.close());
    expect(loop.address).toBe("127.0.0.1");
    expect(loop.redirectUri).toBe(`http://127.0.0.1:${loop.port}${OAUTH_CALLBACK_PATH}`);
    expect(await answers("127.0.0.1", loop.port)).toBe(true);
    // not the IPv6 loopback, and not any of this machine's other addresses
    expect(await answers("::1", loop.port)).toBe(false);
    const others = Object.values(networkInterfaces())
      .flat()
      .filter((i): i is NonNullable<typeof i> => !!i && !i.internal && i.family === "IPv4")
      .map((i) => i.address);
    for (const a of others) expect(await answers(a, loop.port), a).toBe(false);
  });

  it("answers one callback and closes: a second callback finds nothing listening", async () => {
    const loop = await openLoopback({ state: "the-state" });
    closers.push(() => loop.close());
    // a request to any other path is not the callback and changes nothing
    expect((await fetch(`http://127.0.0.1:${loop.port}/favicon.ico`)).status).toBe(404);
    expect(loop.closed).toBe(false);
    const first = await fetch(`${loop.redirectUri}?code=abc&state=the-state`);
    expect(first.status).toBe(200);
    await expect(loop.callback).resolves.toEqual({ code: "abc" });
    expect(loop.closed).toBe(true);
    await expect(fetch(`${loop.redirectUri}?code=again&state=the-state`)).rejects.toThrow();
    expect(await answers("127.0.0.1", loop.port)).toBe(false);
  });

  it("closes after a refused callback too, and at its timeout", async () => {
    const refused = await openLoopback({ state: "right" });
    closers.push(() => refused.close());
    expect((await fetch(`${refused.redirectUri}?code=abc&state=wrong`)).status).toBe(400);
    await expect(refused.callback).rejects.toMatchObject({ code: "state_mismatch" });
    expect(refused.closed).toBe(true);
    expect(await answers("127.0.0.1", refused.port)).toBe(false);

    const idle = await openLoopback({ state: "x", timeoutMs: 50 });
    closers.push(() => idle.close());
    await expect(idle.callback).rejects.toMatchObject({ code: "timeout" });
    await new Promise((r) => setTimeout(r, 20));
    expect(idle.closed).toBe(true);
    expect(await answers("127.0.0.1", idle.port)).toBe(false);
  });

  it("the provider's error is refused by its code alone — never its free text", async () => {
    const loop = await openLoopback({ state: "s" });
    closers.push(() => loop.close());
    await fetch(`${loop.redirectUri}?error=access_denied&error_description=${encodeURIComponent("<script>x</script>")}&state=s`);
    const err = await loop.callback.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OAuthError);
    expect((err as OAuthError).code).toBe("denied");
    expect((err as Error).message).toContain("access_denied");
    expect((err as Error).message).not.toContain("script");
  });
});

// ---- state and PKCE ------------------------------------------------------------------------

describe("**`state` and the PKCE verifier are checked**", () => {
  it("a full flow: the authorize address carries the S256 challenge of the verifier the exchange sends, and the refresh token is kept", async () => {
    const as = await auth();
    const { entry, secretsFile } = entryOf(typedOauth("ex", "https://mcp.example.test/mcp", { token: "{{ secret.ex_token }}" }));
    const store = memoryStore();
    const r = await authorizeConnection(entry, {
      secrets: secretsFile,
      source: { value: async () => undefined },
      redactor: new SecretRedactor(),
      fetch: as.routeTo(),
      store,
      open: (url) => void as.browse(url),
    });
    expect(r).toEqual({ connection: "ex", stored: "ex_token", from: "manifest", client: "shipped", scopes: ["read", "offline_access"] });
    const q = as.authorizeRequests[0]!;
    expect(q.get("client_id")).toBe("shipped-client-id");
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("response_type")).toBe("code");
    expect(q.get("scope")).toBe("read offline_access");
    expect(new URL(q.get("redirect_uri")!).hostname).toBe("127.0.0.1");
    const t = as.tokenRequests[0]!;
    expect(t.grant_type).toBe("authorization_code");
    expect(pkceChallenge(t.code_verifier!)).toBe(q.get("code_challenge"));
    expect(t.redirect_uri).toBe(q.get("redirect_uri"));
    // what is kept: the refresh token, in the connection's token secret — and nothing else
    expect([...store.kept.keys()]).toEqual(["ex_token"]);
    expect(store.kept.get("ex_token")).toBe(as.issuedRefresh[0]);
  });

  it("a callback carrying another state is refused, and no code is exchanged", async () => {
    const as = await auth();
    const { entry, secretsFile } = entryOf(typedOauth("ex", "https://mcp.example.test/mcp", { token: "{{ secret.ex_token }}" }));
    const store = memoryStore();
    const flow = authorizeConnection(entry, {
      secrets: secretsFile,
      source: { value: async () => undefined },
      redactor: new SecretRedactor(),
      fetch: as.routeTo(),
      store,
      open: (url) => void as.browse(url, (back) => back.searchParams.set("state", "forged")),
    });
    await expect(flow).rejects.toMatchObject({ code: "state_mismatch" });
    expect(as.tokenRequests).toEqual([]);
    expect(store.kept.size).toBe(0);
  });

  it("a verifier that is not the challenge's is refused by the authorization server, and nothing is kept", async () => {
    const as = await auth();
    const { entry, secretsFile } = entryOf(typedOauth("ex", "https://mcp.example.test/mcp", { token: "{{ secret.ex_token }}" }));
    const plan = oauthClientOf(entry);
    const { challenge } = pkcePair();
    const loop = await openLoopback({ state: "st" });
    closers.push(() => loop.close());
    const url = new URL(AUTHORIZE_URL);
    for (const [k, v] of Object.entries({ response_type: "code", client_id: "shipped-client-id", redirect_uri: loop.redirectUri, scope: "read", state: "st", code_challenge: challenge, code_challenge_method: "S256" })) url.searchParams.set(k, v);
    await as.browse(url.href);
    const { code } = await loop.callback;
    const door = { secrets: secretsFile, source: { value: async () => undefined }, redactor: new SecretRedactor(), fetch: as.routeTo() };
    const wrong = await exchangeCode(plan, { code, redirectUri: loop.redirectUri, verifier: pkcePair().verifier }, door).catch((e: unknown) => e);
    expect(wrong).toBeInstanceOf(OAuthError);
    expect((wrong as OAuthError).code).toBe("exchange_failed");
    expect((wrong as Error).message).toContain("invalid_grant");
    // and the code the server refused is spent: it cannot be tried again with the right verifier
    expect(as.issuedRefresh).toEqual([]);
  });

  it("a verifier is 43 characters of base64url and its challenge is its SHA-256 (RFC 7636 appendix B)", () => {
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    const { verifier, method } = pkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(method).toBe("S256");
  });
});

// ---- the client ----------------------------------------------------------------------------

describe("the client a connection signs in with", () => {
  it("a bring-your-own client id overrides the shipped one — and its secret must be allowed to the authorize and token hosts", async () => {
    const as = await auth({ clients: ["owners-own-client"], secrets: { "owners-own-client": "s3cr+t&x" } });
    const file = typedOauth("ex", "https://mcp.example.test/mcp", { token: "{{ secret.ex_token }}", client_id: "{{ secret.ex_client }}", client_secret: "{{ secret.ex_secret }}" });
    const policy = `secrets:
  ex_client: { hosts: [auth.example.test], grants: { "connection:ex": on } }
  ex_secret: { hosts: [auth.example.test], grants: { "connection:ex": on } }
`;
    const { entry, secretsFile } = entryOf(file, policy);
    const values = await secretsWith({ ex_client: "owners-own-client", ex_secret: "s3cr+t&x" });
    const store = memoryStore();
    const r = await authorizeConnection(entry, { secrets: secretsFile, source: values, redactor: new SecretRedactor(), fetch: as.routeTo(), store, open: (url) => void as.browse(url) });
    expect(r.client).toBe("yours");
    expect(as.authorizeRequests[0]!.get("client_id")).toBe("owners-own-client");
    // the secret arrives as itself — form-encoded at the door, never mangled
    expect(as.tokenRequests[0]!.client_secret).toBe("s3cr+t&x");
    expect(store.kept.get("ex_token")).toBe(as.issuedRefresh[0]);

    // not on the client id's *Sent only to* list: refused before the browser opens
    const { entry: e2, secretsFile: s2 } = entryOf(file, policy.replace("ex_client: { hosts: [auth.example.test]", "ex_client: { hosts: []"));
    let opened = false;
    const refused = await authorizeConnection(e2, { secrets: s2, source: values, redactor: new SecretRedactor(), fetch: as.routeTo(), store: memoryStore(), open: () => void (opened = true) }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(EgressRefused);
    expect((refused as EgressRefused).code).toBe("host_not_listed");
    expect(opened).toBe(false);
  });

  it("a type that ships no client id and a connection that brings none is refused, naming how to bring one", () => {
    const noShipped = { ...SHIPPED_TYPE, fields: [{ key: "account", kind: "oauth", label: "Account", oauth: CLIENT }] };
    const { entry } = entryOf(typedOauth("ex", "https://mcp.example.test/mcp", { token: "{{ secret.ex_token }}" }), "", [noShipped]);
    expect(() => oauthClientOf(entry)).toThrow(/ships no client id.*--client-id-secret/);
  });

  it("a custom connection's client is its own (C118), and the broker is modelled, not built", () => {
    const { entry } = entryOf(customOauth("cx", "https://mcp.example.test/mcp"));
    expect(oauthClientOf(entry)).toMatchObject({ from: "custom", clientId: { kind: "secret", name: "cx_client" }, tokenSecret: "cx_token", authorizeUrl: AUTHORIZE_URL });
    const broker = customOauth("bx", "https://mcp.example.test/mcp");
    (broker.reach.http.auth as { client: Record<string, unknown> }).client = { ...CLIENT, redirect: "broker", pkce: false };
    const { entry: b } = entryOf(broker);
    expect(() => oauthClientOf(b)).toThrow(OAuthError);
    expect(() => oauthClientOf(b)).toThrow(/broker .* designed and not built/);
  });

  it("a provider that issues no refresh token is refused — nothing is kept that would stop working within the hour", async () => {
    const as = await auth({ noRefresh: true });
    const { entry, secretsFile } = entryOf(typedOauth("ex", "https://mcp.example.test/mcp", { token: "{{ secret.ex_token }}" }));
    const store = memoryStore();
    await expect(
      authorizeConnection(entry, { secrets: secretsFile, source: { value: async () => undefined }, redactor: new SecretRedactor(), fetch: as.routeTo(), store, open: (url) => void as.browse(url) }),
    ).rejects.toMatchObject({ code: "no_refresh_token" });
    expect(store.kept.size).toBe(0);
  });

  it("the owner declining at the provider keeps nothing", async () => {
    const as = await auth({ deny: "access_denied" });
    const { entry, secretsFile } = entryOf(typedOauth("ex", "https://mcp.example.test/mcp", { token: "{{ secret.ex_token }}" }));
    const store = memoryStore();
    await expect(
      authorizeConnection(entry, { secrets: secretsFile, source: { value: async () => undefined }, redactor: new SecretRedactor(), fetch: as.routeTo(), store, open: (url) => void as.browse(url) }),
    ).rejects.toMatchObject({ code: "denied" });
    expect(as.tokenRequests).toEqual([]);
    expect(store.kept.size).toBe(0);
  });
});

// ---- the access token, at the door ------------------------------------------------------------

describe("an OAuth connection's calls", () => {
  let mcp: FakeHttp;
  afterEach(async () => {
    await mcp?.close();
  });

  const pools: ConnectionPool[] = [];
  afterEach(async () => {
    for (const p of pools.splice(0)) await p.close();
  });

  /** A connection whose stored refresh token the fixture never issued — as after a revocation. */
  async function staleSignIn(listMcpHost: boolean) {
    const as = await auth({ clients: ["owners-own-client"] });
    mcp = await fakeHttpMcp();
    const file = customOauth("cx", mcp.url);
    const secrets = `secrets:
  cx_token: { hosts: [auth.example.test${listMcpHost ? `, "${mcp.host}"` : ""}], grants: { "connection:cx": on } }
  cx_client: { hosts: [auth.example.test], grants: { "connection:cx": on } }
`;
    const cat = catalogOf([file], { secrets });
    expect(cat.entries[0]!.status).toBe("ok");
    const values = await secretsWith({ cx_token: "rt_revoked_" + "Kd8Qz3Lp0Wm5Xc2Vb7Nj4Hr1", cx_client: "owners-own-client" });
    const pool = new ConnectionPool({ catalog: async () => cat, secrets: values, fetch: as.routeTo(), connectTimeoutMs: 10_000 });
    pools.push(pool);
    return { as, pool };
  }

  it("mints an access token from the stored refresh token, sends it as the Bearer, reuses it, and redacts both", async () => {
    const as = await auth({ clients: ["owners-own-client"] });
    mcp = await fakeHttpMcp();
    const file = customOauth("cx", mcp.url);
    const secrets = `secrets:
  cx_token: { hosts: [auth.example.test, "${mcp.host}"], grants: { "connection:cx": on } }
  cx_client: { hosts: [auth.example.test], grants: { "connection:cx": on } }
`;
    const cat = catalogOf([file], { secrets });
    // sign in first, through the flow, so the fixture knows the refresh token it issued
    const store = memoryStore();
    await authorizeConnection(cat.entries[0]!, {
      secrets: parseSecretsFile(secrets),
      source: await secretsWith({ cx_client: "owners-own-client" }),
      redactor: new SecretRedactor(),
      fetch: as.routeTo(),
      store,
      open: (url) => void as.browse(url),
    });
    const values = await secretsWith({ cx_token: store.kept.get("cx_token")!, cx_client: "owners-own-client" });
    const pool = new ConnectionPool({ catalog: async () => cat, secrets: values, fetch: as.routeTo(), connectTimeoutMs: 10_000 });
    pools.push(pool);

    const out = await pool.call({ connection: "cx", tool: "echo_auth", args: {} });
    const refreshes = as.tokenRequests.filter((t) => t.grant_type === "refresh_token");
    expect(refreshes.length).toBe(1);
    expect(refreshes[0]!.refresh_token).toBe(store.kept.get("cx_token"));
    const access = as.issuedAccess.at(-1)!;
    // the MCP server was sent the access token as the Bearer...
    expect(mcp.requests.some((r) => r.headers.authorization === `Bearer ${access}`)).toBe(true);
    // ...and what came back says the secret's name, never the token
    expect(JSON.stringify(out.content)).toContain("***REDACTED secret.cx_token***");
    expect(JSON.stringify(out.content)).not.toContain(access);
    expect(out.secrets).toContain("cx_token");
    // a second call reuses the access token: no second refresh
    await pool.call({ connection: "cx", tool: "echo", args: {} });
    expect(as.tokenRequests.filter((t) => t.grant_type === "refresh_token").length).toBe(1);
  });

  it("the access token goes only where its secret may: an MCP host not on the token's list is refused before anything is sent", async () => {
    const { pool, as } = await staleSignIn(false);
    const err = await pool.call({ connection: "cx", tool: "echo", args: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EgressRefused);
    expect((err as EgressRefused).code).toBe("host_not_listed");
    expect(mcp.requests).toEqual([]);
    expect(as.tokenRequests).toEqual([]);
  });

  it("a refresh the provider refuses is `sign_in`, naming the command that signs in again", async () => {
    const { pool } = await staleSignIn(true);
    const err = await pool.call({ connection: "cx", tool: "echo", args: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectionRefused);
    expect((err as ConnectionRefused).code).toBe("sign_in");
    expect((err as Error).message).toMatch(/invalid_grant.*metistry connections authorize cx/);
  });
});

describe("the listing says, before any call, what a sign-in would meet", () => {
  it("absent until signed in; failed while a sign-in secret may not go to the token endpoint or the service", async () => {
    const { describeConnection } = await import("../src/index.js");
    const file = customOauth("cx", "https://mcp.example.test/mcp");
    const good = `secrets:
  cx_token: { hosts: [auth.example.test, mcp.example.test], grants: { "connection:cx": on } }
  cx_client: { hosts: [auth.example.test], grants: { "connection:cx": on } }
`;
    const cat = catalogOf([file], { secrets: good });
    const none = { has: async (n: string) => n !== "cx_token" && n !== "cx_client" ? false : n === "cx_client" };
    const all = { has: async () => true };
    const unsigned = await describeConnection(cat.entries[0]!, cat, { presence: none });
    expect(unsigned.status).toBe("absent");
    expect(unsigned.issues).toContain("cx is not signed in yet — `metistry connections authorize cx`");
    expect((await describeConnection(cat.entries[0]!, cat, { presence: all })).status).toBe("ok");

    const narrow = catalogOf([file], { secrets: good.replace("hosts: [auth.example.test, mcp.example.test]", "hosts: [mcp.example.test]") });
    const row = await describeConnection(narrow.entries[0]!, narrow, { presence: all });
    expect(row.status).toBe("failed");
    expect(row.issues).toContain("cx_token may not be sent to auth.example.test — it is not on the secret's *Sent only to* list (`metistry secrets hosts cx_token mcp.example.test auth.example.test`)");
  });
});
