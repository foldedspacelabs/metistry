// A console on the internet (plan §2.23, X-111) over real sockets against the
// scratch database (docs/ops/testing.md): rate limits and security headers on
// the PROXY listener, and nothing of either on the main one. The ticket's own:
//
//   * a forwarded-address header on the main listener changes nothing;
//   * a burst past the limit is refused with 429 and audited ONCE;
//   * no header can raise a principal — on either listener;
//   * through the proxy listener the routes answering without a session are
//     exactly the shell's static files, GET /health, GET /api/identity and
//     the four passkey ceremony routes, and no route serves a public share
//     link;
//   * the main listener's behaviour is unchanged.
//
// The limiter's own arithmetic is rate-limit.test.ts; this file is the same
// rules at the door, with the 429s, the headers and the audit rows they leave.
import { request as httpRequest } from "node:http";
import { rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { CLIENT_API, mintToken, routeKey, type ClientRoute } from "@foldedspacelabs/metistry-core";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";
import { makeServer, type ConsoleServer } from "../src/server.js";
import { listenProxySocket, PROXY_SOCKET_FILENAME } from "../src/proxy-listener.js";
import { PROXY_SECURITY_HEADERS } from "../src/http-util.js";
import * as store from "../src/auth-store.js";
import * as agents from "../src/agents.js";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url));
const policy = { idleDays: 30, maxDays: 365 };
const MARK = "itest-proxy-limits";
const suffix = mintToken(6).toLowerCase().replaceAll(/[^a-z0-9]/g, "").slice(0, 6) || "x";
const REMOTE_HOST = "studio.tail1234.ts.net";
const ORIGINS = `https://${REMOTE_HOST},http://127.0.0.1:0`;
const WEB_ROOT = fileURLToPath(new URL("../web", import.meta.url));
/** The window every limited server here uses, and the clock the tests turn by hand. */
const WINDOW_MS = 60_000;
let clockMs = Date.now();
const clock = () => clockMs;

interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: { error?: { code: string; message: string }; [k: string]: unknown };
  text: string;
}

type Endpoint = { port: number } | { socketPath: string };

/** node:http so a request can dial the Unix socket and carry exactly the headers the test names. */
function send(at: Endpoint, method: string, path: string, opts: { headers?: Record<string, string>; body?: unknown; host?: string } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    if (payload !== undefined) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(Buffer.byteLength(payload));
    }
    headers.host = opts.host ?? REMOTE_HOST;
    const req = httpRequest(
      { ...("socketPath" in at ? { socketPath: at.socketPath } : { host: "127.0.0.1", port: at.port }), method, path, headers, setHost: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let body: Answer["body"] = {};
          try {
            body = JSON.parse(text) as Answer["body"];
          } catch {
            body = {};
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body, text });
        });
      },
    );
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/** A request from a given client address, as a provider would present it. */
const from = (addr: string, more: Record<string, string> = {}): Record<string, string> => ({ "x-forwarded-for": addr, ...more });

/** A concrete path for a route template — the conformance test's grammar, so a served row answers from its handler, never from the router. */
function sample(path: string): string {
  return path
    .split("/")
    .map((seg) => {
      if (!seg.startsWith(":")) return seg;
      const name = seg.slice(1);
      if (path.startsWith("/api/agents/")) return "probe-agent";
      if (path.startsWith("/api/artifacts/")) return ({ id: "art_00000000000000000000000000", version: "ver_00000000000000000000000000", comment: "cmt_00000000000000000000000000" } as Record<string, string>)[name] ?? "probe";
      if (path.startsWith("/api/sessions/") && name === "id") return "00000000-0000-4000-8000-000000000000";
      if (name === "id") return "999999999999";
      if (name === "slug") return "probe-project";
      return "probe";
    })
    .join("/");
}
const methodOf = (r: ClientRoute) => (r.method === "*" ? "POST" : r.method);

describe.skipIf(!hasDb)("the proxy listener on the internet: rate limits and headers", { timeout: 60_000 }, () => {
  let pool: pg.Pool;
  let queries: QueryStore;
  /** limits 5 per client: the burst tests, the 401 toll, /mcp, the Host gate */
  let tight: ConsoleServer;
  let tightProxy: Endpoint;
  let tightSock: Endpoint;
  let main: Endpoint;
  /** a ceiling of 6 over everyone */
  let ceiling: ConsoleServer;
  let ceilingProxy: Endpoint;
  /** room for the whole table, with the shell served: the enumeration and the headers */
  let wide: ConsoleServer;
  let wideProxy: Endpoint;
  let wideMain: Endpoint;
  const servers: { close(cb: () => void): unknown }[] = [];
  let sessionCookie: string;
  let agentToken: string;
  const localOwnerToken = mintToken();
  const agentId = `${MARK}-${suffix}`;
  const passkeyIds: string[] = [];
  const dirs: string[] = [];

  const sinceNow = async (): Promise<number> => Number((await pool.query(`SELECT coalesce(max(id), 0) AS id FROM runs`)).rows[0].id);
  const limitRows = async (since: number): Promise<Record<string, unknown>[]> =>
    (await pool.query(`SELECT meta FROM runs WHERE component = 'console' AND kind = 'auth' AND tool = 'rate_limited' AND id > $1 ORDER BY id`, [since])).rows.map((r) => r.meta as Record<string, unknown>);

  async function listen(server: { listen(port: number, host: string, cb: () => void): unknown; address(): unknown }): Promise<Endpoint> {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return { port: (server.address() as AddressInfo).port };
  }

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
    queries = new QueryStore(pool);
    const inboxDir = await mkdtemp(join(tmpdir(), "metistry-proxy-limits-"));
    dirs.push(inboxDir);
    const common = { inboxDir, policy, secureCookies: false, origin: "http://127.0.0.1:0", origins: ORIGINS, localOwner: { token: localOwnerToken, trusted: [] as string[] } };

    tight = makeServer(pool, queries, { ...common, proxyLimits: { perClient: 5, global: 100_000, windowMs: WINDOW_MS, now: clock } });
    main = await listen(tight);
    const tp = tight.proxyListener();
    tightProxy = await listen(tp);
    const stateDir = await mkdtemp(join(tmpdir(), "metistry-proxy-limits-state-"));
    dirs.push(stateDir);
    const ts = tight.proxyListener();
    await listenProxySocket(ts, join(stateDir, PROXY_SOCKET_FILENAME));
    tightSock = { socketPath: join(stateDir, PROXY_SOCKET_FILENAME) };

    ceiling = makeServer(pool, queries, { ...common, proxyLimits: { perClient: 100, global: 6, windowMs: WINDOW_MS, now: clock } });
    const cp = ceiling.proxyListener();
    ceilingProxy = await listen(cp);

    wide = makeServer(pool, queries, { ...common, webRoot: WEB_ROOT, proxyLimits: { perClient: 100_000, global: 1_000_000, windowMs: WINDOW_MS, now: clock } });
    wideMain = await listen(wide);
    const wp = wide.proxyListener();
    wideProxy = await listen(wp);
    servers.push(tp, ts, tight, cp, ceiling, wp, wide);

    const pkId = `${MARK}-${mintToken(8)}`;
    passkeyIds.push(pkId);
    await store.storePasskey(pool, { id: pkId, publicKey: new Uint8Array([1]), signCount: 0, transports: [], origin: "t", label: MARK });
    sessionCookie = `metistry_session=${await store.issueSession(pool, pkId, policy)}`;
    agentToken = (await agents.createAgent(pool, { id: agentId, display_name: "itest proxy limits" })).token;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM agents WHERE id = $1`, [agentId]);
    await pool.query(`DELETE FROM auth_sessions WHERE passkey_id = ANY($1)`, [passkeyIds]).catch(() => undefined);
    await pool.query(`DELETE FROM passkeys WHERE id = ANY($1)`, [passkeyIds]).catch(() => undefined);
    for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
    await pool.end();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  // ----- the ticket's own -----
  it("**a burst past the limit is refused with 429 and audited once** — per client, by the provider's address; the window turns and a new burst is a new row", async () => {
    const since = await sinceNow();
    const a = from("203.0.113.7");
    for (let i = 0; i < 5; i++) expect((await send(tightProxy, "GET", "/health", { headers: a })).status, `answer ${i + 1}`).toBe(200);
    const refused = await send(tightProxy, "GET", "/health", { headers: a });
    expect(refused.status).toBe(429);
    expect(refused.body.error?.code).toBe("rate_limited");
    expect(refused.body.error?.message).toContain("signed-in session is not limited");
    expect(Number(refused.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(Number(refused.headers["retry-after"])).toBeLessThanOrEqual(60);
    for (let i = 0; i < 3; i++) expect((await send(tightProxy, "GET", "/health", { headers: a })).status).toBe(429);
    // another address is another client
    expect((await send(tightProxy, "GET", "/health", { headers: from("198.51.100.4") })).status).toBe(200);
    // one row for the burst, however long it ran
    const rows = await limitRows(since);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ listener: "proxy", scope: "client", client: "203.0.113.7", route: "GET /health", limit: 5, window_s: 60 });

    // the window turns: answered again, and the next burst is its own row
    clockMs += WINDOW_MS;
    for (let i = 0; i < 5; i++) expect((await send(tightProxy, "GET", "/health", { headers: a })).status).toBe(200);
    expect((await send(tightProxy, "GET", "/health", { headers: a })).status).toBe(429);
    expect(await limitRows(since)).toHaveLength(2);
  });

  it("the port and the socket are one listener to the limiter: a client's answers add up across both", async () => {
    clockMs += WINDOW_MS;
    const a = from("203.0.113.8");
    for (let i = 0; i < 3; i++) expect((await send(tightProxy, "GET", "/health", { headers: a })).status).toBe(200);
    for (let i = 0; i < 2; i++) expect((await send(tightSock, "GET", "/health", { headers: a })).status).toBe(200);
    expect((await send(tightSock, "GET", "/health", { headers: a })).status).toBe(429);
    expect((await send(tightProxy, "GET", "/health", { headers: a })).status).toBe(429);
  });

  it("**the client's address is the one the provider wrote** — the last entry — so a client cannot pick a fresh bucket by writing its own", async () => {
    clockMs += WINDOW_MS;
    const since = await sinceNow();
    for (let i = 0; i < 5; i++) expect((await send(tightProxy, "GET", "/health", { headers: from(`10.0.0.${i}, 203.0.113.9`) })).status).toBe(200);
    expect((await send(tightProxy, "GET", "/health", { headers: from("10.9.9.9, 203.0.113.9") })).status).toBe(429);
    expect((await limitRows(since))[0]).toMatchObject({ client: "203.0.113.9" });
    // and with no address at all every request through that provider shares one bucket
    for (let i = 0; i < 5; i++) expect((await send(tightProxy, "GET", "/health")).status).toBe(200);
    const shared = await send(tightProxy, "GET", "/health");
    expect(shared.status).toBe(429);
    expect((await limitRows(since)).at(-1)).toMatchObject({ client: "127.0.0.1" });
  });

  it("**the global ceiling** refuses everyone once the listener has answered its total — once audited as `global` — and a session is still the owner through it", async () => {
    clockMs += WINDOW_MS;
    const since = await sinceNow();
    for (let i = 0; i < 6; i++) expect((await send(ceilingProxy, "GET", "/health", { headers: from(`203.0.113.${100 + i}`) })).status).toBe(200);
    const over = await send(ceilingProxy, "GET", "/health", { headers: from("203.0.113.200") });
    expect(over.status).toBe(429);
    expect(over.body.error?.message).toContain("this console has answered");
    expect((await send(ceilingProxy, "GET", "/api/identity", { headers: from("203.0.113.201") })).status).toBe(429);
    expect((await send(ceilingProxy, "POST", "/auth/login/start", { headers: from("203.0.113.202"), body: {} })).status).toBe(429);
    const rows = await limitRows(since);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ listener: "proxy", scope: "global", client: "203.0.113.200", limit: 6 });
    // a credential is never limited: the phone keeps working while the sign-in page is closed to strangers
    const who = await send(ceilingProxy, "GET", "/api/whoami", { headers: { cookie: sessionCookie, ...from("203.0.113.200") } });
    expect(who.status).toBe(200);
    expect(who.body).toMatchObject({ principal: "user", via: "passkey_session" });
    expect((await send(ceilingProxy, "POST", "/capture", { headers: { authorization: `Bearer ${agentToken}`, ...from("203.0.113.200") }, body: { note: "under the ceiling" } })).status).toBe(201);
  });

  it("**a 401 is an unauthenticated answer and is charged**; a session or a bearer from the same address is not, and goes through", async () => {
    clockMs += WINDOW_MS;
    const c = from("203.0.113.10");
    for (let i = 0; i < 5; i++) {
      const r = await send(tightProxy, "GET", "/api/whoami", { headers: { ...c, authorization: `Bearer ${mintToken()}` } });
      expect(r.status).toBe(401);
    }
    const sixth = await send(tightProxy, "GET", "/api/whoami", { headers: c });
    expect(sixth.status).toBe(429);
    // the credential is checked first: the owner's session from that very address is answered
    const who = await send(tightProxy, "GET", "/api/whoami", { headers: { ...c, cookie: sessionCookie } });
    expect(who.status).toBe(200);
    expect(who.body).toMatchObject({ via: "passkey_session" });
    expect((await send(tightProxy, "GET", "/api/devices", { headers: { ...c, cookie: sessionCookie } })).status).toBe(200);
    expect((await send(tightProxy, "POST", "/capture", { headers: { ...c, authorization: `Bearer ${agentToken}` }, body: { note: "still through" } })).status).toBe(201);
    // …and the stranger is still refused
    expect((await send(tightProxy, "GET", "/api/whoami", { headers: c })).status).toBe(429);
  });

  it("/mcp: a bearer guessed there spends the same allowance, and an exhausted address is refused before the bridge", async () => {
    clockMs += WINDOW_MS;
    const d = from("203.0.113.11");
    for (let i = 0; i < 5; i++) {
      const r = await send(tightProxy, "POST", "/mcp", { headers: { ...d, authorization: `Bearer ${mintToken()}` }, body: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
      expect(r.status).toBe(401);
    }
    // the bridge's own 401s ended; the toll is spent, and the sixth is the limiter's
    const sixth = await send(tightProxy, "POST", "/mcp", { headers: { ...d, authorization: `Bearer ${mintToken()}` }, body: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
    expect(sixth.status).toBe(429);
    expect(sixth.body.error?.code).toBe("rate_limited");
  });

  it("a wrong Host is charged like any other unauthenticated answer: a scanner on the provider's address runs out of 421s too", async () => {
    clockMs += WINDOW_MS;
    const e = from("203.0.113.12");
    for (let i = 0; i < 5; i++) expect((await send(tightProxy, "GET", "/health", { headers: e, host: "other.example" })).status).toBe(421);
    expect((await send(tightProxy, "GET", "/health", { headers: e, host: "other.example" })).status).toBe(429);
    expect((await send(tightProxy, "GET", "/health", { headers: e })).status).toBe(429);
  });

  it("one request is one toll: a GET that is not a shell file falls through to the API's 401 charged once, not twice", async () => {
    clockMs += WINDOW_MS;
    const f = from("203.0.113.13");
    for (let i = 0; i < 5; i++) expect((await send(wideProxy, "GET", "/nothing-here", { headers: f })).status).toBe(401);
    // `wide` has room for thousands; `tight` serves no shell, so the same shape there with its limit of 5:
    for (let i = 0; i < 5; i++) expect((await send(tightProxy, "GET", "/nothing-here", { headers: f })).status).toBe(401);
    expect((await send(tightProxy, "GET", "/nothing-here", { headers: f })).status).toBe(429);
  });

  it("**no header can raise a principal** — on either listener, with no credential, with the local owner token, and beside a real session", async () => {
    clockMs += WINDOW_MS;
    const claims: Record<string, string> = {
      "x-forwarded-for": "127.0.0.1",
      forwarded: "for=127.0.0.1;proto=https",
      "x-real-ip": "127.0.0.1",
      "cf-connecting-ip": "127.0.0.1",
      "true-client-ip": "127.0.0.1",
      "x-forwarded-host": "127.0.0.1:8080",
      "tailscale-user-login": "owner@example.com",
      "tailscale-user-name": "The Owner",
      "x-forwarded-user": "owner",
      "remote-user": "owner",
      "x-metistry-principal": "user",
      "x-metistry-listener": "main",
      "x-metistry-auth": "local_owner",
    };
    const bare = await send(tightProxy, "GET", "/api/whoami");
    expect(bare.status).toBe(401);
    for (const at of [tightProxy, tightSock]) {
      const none = await send(at, "GET", "/api/whoami", { headers: claims });
      expect(none.status).toBe(401);
      expect(none.text).toBe(bare.text);
      // X-103's door, with every claim beside the token: still the uniform 401
      const token = await send(at, "GET", "/api/whoami", { headers: { ...claims, authorization: `Bearer ${localOwnerToken}` } });
      expect(token.status).toBe(401);
      expect(token.text).toBe(bare.text);
      // a session is a session, and nothing more: the same answer with and without the claims
      const plain = await send(at, "GET", "/api/whoami", { headers: { cookie: sessionCookie } });
      const claimed = await send(at, "GET", "/api/whoami", { headers: { ...claims, cookie: sessionCookie } });
      expect(claimed.status).toBe(200);
      expect({ ...claimed.body, as_of: undefined }).toEqual({ ...plain.body, as_of: undefined });
      expect(claimed.body).toMatchObject({ principal: "user", via: "passkey_session" });
    }
    // and on the main listener the claims change nothing either: no credential is 401, the token is itself
    const mainNone = await send(main, "GET", "/api/whoami", { headers: claims, host: "127.0.0.1" });
    expect(mainNone.status).toBe(401);
    const mainToken = await send(main, "GET", "/api/whoami", { headers: { ...claims, authorization: `Bearer ${localOwnerToken}` }, host: "127.0.0.1" });
    expect(mainToken.status).toBe(200);
    expect(mainToken.body).toMatchObject({ via: "local_owner_token" });
  });

  it("**a forwarded-address header on the main listener changes nothing**: no limit, no row, no headers, the local door as it was", async () => {
    clockMs += WINDOW_MS;
    const since = await sinceNow();
    const a = from("203.0.113.7");
    // the proxy's limit is 5; the main listener answers thirty from the same claimed address
    for (let i = 0; i < 30; i++) {
      const r = await send(main, "GET", "/health", { headers: a, host: "127.0.0.1" });
      expect(r.status, `answer ${i + 1}`).toBe(200);
      for (const h of Object.keys(PROXY_SECURITY_HEADERS)) expect(r.headers[h], h).toBeUndefined();
      expect(r.headers["retry-after"]).toBeUndefined();
    }
    for (let i = 0; i < 30; i++) expect((await send(main, "GET", "/api/whoami", { headers: a, host: "127.0.0.1" })).status).toBe(401);
    const who = await send(main, "GET", "/api/whoami", { headers: { ...a, authorization: `Bearer ${localOwnerToken}` }, host: "whatever.example" });
    expect(who.status).toBe(200);
    expect(who.body).toMatchObject({ principal: "user", via: "local_owner_token", management: true });
    expect(await limitRows(since)).toEqual([]);
    // the shell on the main listener: served, and bare of the proxy's headers
    const shell = await send(wideMain, "GET", "/", { host: "127.0.0.1" });
    expect(shell.status).toBe(200);
    for (const h of Object.keys(PROXY_SECURITY_HEADERS)) expect(shell.headers[h], h).toBeUndefined();
  });

  it("**every answer on the proxy listener carries the security headers** — the shell, JSON, a 401, a 421, a 429 — and the main listener none", async () => {
    clockMs += WINDOW_MS;
    const g = from("203.0.113.14");
    const answers: [string, Answer][] = [
      ["shell /", await send(wideProxy, "GET", "/", { headers: g })],
      ["shell /app.js", await send(wideProxy, "GET", "/app.js", { headers: g })],
      ["vendor", await send(wideProxy, "GET", "/vendor/simplewebauthn.js", { headers: g })],
      ["health", await send(wideProxy, "GET", "/health", { headers: g })],
      ["identity", await send(wideProxy, "GET", "/api/identity", { headers: g })],
      ["401", await send(wideProxy, "GET", "/api/whoami", { headers: g })],
      ["421", await send(wideProxy, "GET", "/health", { headers: g, host: "other.example" })],
      ["session 200", await send(wideProxy, "GET", "/api/whoami", { headers: { ...g, cookie: sessionCookie } })],
      ["session 404", await send(wideProxy, "GET", "/api/no-such-route", { headers: { ...g, cookie: sessionCookie } })],
    ];
    for (let i = 0; i < 5; i++) await send(tightProxy, "GET", "/health", { headers: g });
    answers.push(["429", await send(tightProxy, "GET", "/health", { headers: g })]);
    for (const [name, r] of answers) {
      for (const [h, v] of Object.entries(PROXY_SECURITY_HEADERS)) expect(r.headers[h], `${name}: ${h}`).toBe(v);
    }
    expect(answers.find(([n]) => n === "shell /")![1].status).toBe(200);
    expect(answers.find(([n]) => n === "429")![1].status).toBe(429);
    const hsts = PROXY_SECURITY_HEADERS["strict-transport-security"]!;
    expect(hsts).toContain("max-age=31536000");
    expect(hsts).not.toContain("preload");
    const csp = PROXY_SECURITY_HEADERS["content-security-policy"]!;
    for (const d of ["default-src 'self'", "script-src 'self'", "frame-ancestors 'none'", "object-src 'none'", "base-uri 'none'", "connect-src 'self'"]) expect(csp).toContain(d);
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(PROXY_SECURITY_HEADERS["x-frame-options"]).toBe("DENY");
    expect(PROXY_SECURITY_HEADERS["x-content-type-options"]).toBe("nosniff");
    expect(PROXY_SECURITY_HEADERS["referrer-policy"]).toBe("no-referrer");
  });

  it("**through the proxy listener the routes answering without a session are exactly the shell's static files, GET /health, GET /api/identity and the four passkey ceremony routes — and no route serves a public share link**", async () => {
    clockMs += WINDOW_MS;
    const h = from("203.0.113.15");
    // the table's public rows, pinned by name: a seventh is a decision, not a drift
    const publicRows = CLIENT_API.filter((r) => r.served && r.reach.includes("public")).map(routeKey).sort();
    expect(publicRows).toEqual(["GET /api/identity", "GET /health", "POST /auth/enroll/finish", "POST /auth/enroll/start", "POST /auth/login/finish", "POST /auth/login/start"]);
    // nothing in the table — served or frozen — is a share, a public link or a short link
    for (const r of CLIENT_API) expect(r.path, routeKey(r)).not.toMatch(/share|public|\/s\/|\/go\//i);
    for (const r of CLIENT_API.filter((x) => !x.reach.includes("public"))) expect(r.principals, routeKey(r)).not.toContain("anyone");

    // each public row answers from its handler with no credential — none asks for one first, none is the limiter's
    for (const key of publicRows) {
      const [method, path] = key.split(" ") as [string, string];
      const r = await send(wideProxy, method, path, { headers: h, ...(method === "POST" ? { body: {} } : {}) });
      expect([200, 400, 401, 503], key).toContain(r.status);
      expect(r.status, key).not.toBe(429);
    }
    expect((await send(wideProxy, "GET", "/health", { headers: h })).status).toBe(200);
    expect((await send(wideProxy, "POST", "/auth/login/start", { headers: h, body: {} })).status).toBe(200);

    // the shell's files, and nothing beside them
    for (const file of ["/", "/index.html", "/app.js", "/style.css", "/manifest.webmanifest", "/sw.js", "/icon-192.png", "/vendor/simplewebauthn.js"]) {
      expect((await send(wideProxy, "GET", file, { headers: h })).status, file).toBe(200);
    }
    for (const notAFile of ["/nothing", "/share/abc", "/s/abc", "/public/abc", "/api/share/abc", "/api/artifacts/share/abc", "/api/public/abc", "/.env", "/../package.json"]) {
      const r = await send(wideProxy, "GET", notAFile, { headers: h });
      expect(r.status, notAFile).toBe(401);
    }

    // every other served row — the whole table, with no credential — is 401 through the proxy listener
    const answered: string[] = [];
    for (const r of CLIENT_API.filter((x) => x.served && !x.reach.includes("public"))) {
      const method = methodOf(r);
      const p = await send(wideProxy, method, sample(r.path), { headers: h, ...(method === "GET" ? {} : { body: {} }) });
      if (p.status !== 401) answered.push(`${routeKey(r)}: ${p.status}`);
    }
    expect(answered, "a route answered through the proxy listener without a session").toEqual([]);
  });

  it("the main listener's behaviour is unchanged: the shell, the public rows and the owner's door answer as before, with no toll and no Host question", async () => {
    clockMs += WINDOW_MS;
    for (const host of ["127.0.0.1", "whatever.example", REMOTE_HOST]) {
      expect((await send(wideMain, "GET", "/", { host })).status).toBe(200);
      expect((await send(wideMain, "GET", "/health", { host })).status).toBe(200);
      expect((await send(wideMain, "POST", "/auth/login/start", { host, body: {} })).status).toBe(200);
      expect((await send(wideMain, "GET", "/api/whoami", { host, headers: { authorization: `Bearer ${localOwnerToken}` } })).status).toBe(200);
    }
    // a hundred unauthenticated asks from one claimed address on the tight server's main listener: never a 429
    for (let i = 0; i < 100; i++) expect((await send(main, "GET", "/api/whoami", { headers: from("203.0.113.7"), host: "127.0.0.1" })).status).toBe(401);
  });
});
