// A fixture OAuth 2.0 authorization server on loopback (T4-10) — never a real
// provider. It does what the flow's other half must: remembers the PKCE
// challenge the authorize request carried, issues one code bound to it and to
// the redirect, and at the token endpoint checks the verifier against that
// challenge (RFC 7636 §4.6), the redirect and the client, before it issues an
// access token and a refresh token. A refresh exchanges a refresh token it
// issued for a new access token.
//
// The connection files name `https://auth.example.test/…` (the schema takes
// https endpoints only); `routeTo` is the base fetch a test hands the door,
// which sends that origin here over loopback and everything else on as it is.

import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const AUTH_ORIGIN = "https://auth.example.test";
export const AUTHORIZE_URL = `${AUTH_ORIGIN}/authorize`;
export const TOKEN_URL = `${AUTH_ORIGIN}/token`;

const b64url = (b: Buffer) => b.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

export interface TokenRequest {
  grant_type: string | null;
  code: string | null;
  code_verifier: string | null;
  redirect_uri: string | null;
  client_id: string | null;
  client_secret: string | null;
  refresh_token: string | null;
  raw: string;
}

export interface FakeAuthServer {
  origin: string;
  /** every POST to /token, parsed */
  tokenRequests: TokenRequest[];
  /** every GET to /authorize: its query */
  authorizeRequests: URLSearchParams[];
  /** the refresh tokens it issued */
  issuedRefresh: string[];
  /** the access tokens it issued */
  issuedAccess: string[];
  /** a fetch that sends AUTH_ORIGIN here and anything else to `fallback` */
  routeTo(fallback?: typeof fetch): typeof fetch;
  /**
   * The owner's browser: GET the authorize address (routed here), take the
   * redirect it answers with, and GET that — the loopback — returning its
   * status. `tamper` changes the redirect before it is followed.
   */
  browse(authorizationUrl: string, tamper?: (redirect: URL) => void): Promise<number>;
  close(): Promise<void>;
}

export interface FakeAuthOptions {
  /** the client ids it knows */
  clients?: string[];
  /** client id → the secret it requires */
  secrets?: Record<string, string>;
  /** answer the authorize request with error=… instead of a code */
  deny?: string;
  /** issue no refresh token */
  noRefresh?: boolean;
  /** seconds */
  expiresIn?: number;
}

export async function fakeAuthServer(opts: FakeAuthOptions = {}): Promise<FakeAuthServer> {
  const clients = new Set(opts.clients ?? ["shipped-client-id"]);
  const codes = new Map<string, { challenge: string; method: string; redirect: string; client: string }>();
  const refresh = new Set<string>();
  const tokenRequests: TokenRequest[] = [];
  const authorizeRequests: URLSearchParams[] = [];
  const issuedRefresh: string[] = [];
  const issuedAccess: string[] = [];

  const json = (res: ServerResponse, status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  const issue = (res: ServerResponse) => {
    const access = `at_${b64url(randomBytes(18))}`;
    issuedAccess.push(access);
    const body: Record<string, unknown> = { access_token: access, token_type: "Bearer", expires_in: opts.expiresIn ?? 3600, scope: "read" };
    if (!opts.noRefresh) {
      const r = `rt_${b64url(randomBytes(18))}`;
      refresh.add(r);
      issuedRefresh.push(r);
      body.refresh_token = r;
    }
    json(res, 200, body);
  };

  const http = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (req.method === "GET" && url.pathname === "/authorize") {
      const q = url.searchParams;
      authorizeRequests.push(q);
      const redirect = q.get("redirect_uri") ?? "";
      const back = new URL(redirect);
      if (opts.deny) {
        back.searchParams.set("error", opts.deny);
      } else {
        if (!clients.has(q.get("client_id") ?? "") || q.get("code_challenge_method") !== "S256" || !q.get("code_challenge")) {
          res.writeHead(400).end("bad authorize request");
          return;
        }
        const code = `code_${b64url(randomBytes(12))}`;
        codes.set(code, { challenge: q.get("code_challenge")!, method: "S256", redirect, client: q.get("client_id")! });
        back.searchParams.set("code", code);
      }
      back.searchParams.set("state", q.get("state") ?? "");
      res.writeHead(302, { location: back.href }).end();
      return;
    }
    if (req.method === "POST" && url.pathname === "/token") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString("utf8");
      const f = new URLSearchParams(raw);
      const t: TokenRequest = {
        grant_type: f.get("grant_type"),
        code: f.get("code"),
        code_verifier: f.get("code_verifier"),
        redirect_uri: f.get("redirect_uri"),
        client_id: f.get("client_id"),
        client_secret: f.get("client_secret"),
        refresh_token: f.get("refresh_token"),
        raw,
      };
      tokenRequests.push(t);
      const client = t.client_id ?? "";
      if (!clients.has(client)) return json(res, 401, { error: "invalid_client" });
      const needs = opts.secrets?.[client];
      if (needs !== undefined && t.client_secret !== needs) return json(res, 401, { error: "invalid_client" });
      if (t.grant_type === "authorization_code") {
        const bound = t.code ? codes.get(t.code) : undefined;
        if (!bound) return json(res, 400, { error: "invalid_grant" });
        codes.delete(t.code!); // a code is spent once
        if (bound.redirect !== t.redirect_uri || bound.client !== client) return json(res, 400, { error: "invalid_grant" });
        // RFC 7636 §4.6: BASE64URL(SHA256(verifier)) == challenge
        const derived = b64url(createHash("sha256").update(t.code_verifier ?? "", "ascii").digest());
        if (!t.code_verifier || derived !== bound.challenge) return json(res, 400, { error: "invalid_grant", error_description: "PKCE verification failed" });
        return issue(res);
      }
      if (t.grant_type === "refresh_token") {
        if (!t.refresh_token || !refresh.has(t.refresh_token)) return json(res, 400, { error: "invalid_grant" });
        return issue(res);
      }
      return json(res, 400, { error: "unsupported_grant_type" });
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const port = (http.address() as AddressInfo).port;
  const local = `http://127.0.0.1:${port}`;

  const routeTo = (fallback: typeof fetch = fetch): typeof fetch =>
    (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const u = input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
      if (u.startsWith(AUTH_ORIGIN)) return fetch(local + u.slice(AUTH_ORIGIN.length), init);
      return fallback(input, init);
    }) as typeof fetch;

  return {
    origin: local,
    tokenRequests,
    authorizeRequests,
    issuedRefresh,
    issuedAccess,
    routeTo,
    async browse(authorizationUrl, tamper) {
      const first = await routeTo()(authorizationUrl, { redirect: "manual" });
      const loc = first.headers.get("location");
      if (!loc) throw new Error(`the authorize endpoint answered ${first.status} with no redirect`);
      const back = new URL(loc);
      tamper?.(back);
      const res = await fetch(back.href);
      await res.text();
      return res.status;
    },
    close: () => new Promise<void>((r) => http.close(() => r())),
  };
}
