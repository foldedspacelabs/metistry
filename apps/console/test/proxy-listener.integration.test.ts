// The proxy listener (plan §2.23, X-103) over real sockets against the scratch
// database (docs/ops/testing.md): a second console listener for remote-access
// providers only — a loopback TCP port and a 0600 Unix socket — on which every
// request is remote by construction. The ticket's own misuse tests:
//
//   * the local owner token from 127.0.0.1 on the proxy port is refused exactly
//     as a remote one is, and audited — and the same over the socket;
//   * a `local` route answers 403 there, whoever asks, and nothing is minted;
//   * a wrong Host is refused, 421, before anything else answers;
//   * the socket is 0600;
//   * U2 on the proxy listener: 401 with no credential, 403 for an agent
//     bearer and for the capture owner token on management, the passkey
//     session through — the phone's door, which is what the listener is FOR;
//   * the main listener's local door still works, and never asks about Host.
//
// The unit matrices are local-owner.test.ts (the verdicts) and
// proxy-listener.test.ts (the Host rule); this file is the same rules at the
// server's door, with the audit rows they leave.
import { request as httpRequest } from "node:http";
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { mintToken } from "@foldedspacelabs/metistry-core";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";
import { makeServer, type ConsoleServer } from "../src/server.js";
import { listenProxySocket, PROXY_SOCKET_FILENAME } from "../src/proxy-listener.js";
import * as store from "../src/auth-store.js";
import * as agents from "../src/agents.js";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url));
const policy = { idleDays: 30, maxDays: 365 };
const MARK = "itest-proxy-listener";
const suffix = mintToken(6).toLowerCase().replaceAll(/[^a-z0-9]/g, "").slice(0, 6) || "x";
/** The remote host a provider would carry — METISTRY_ORIGIN's first entry once a provider is chosen (§2.23 "How the origin flows"). */
const REMOTE_HOST = "studio.tail1234.ts.net";
const ORIGINS = `https://${REMOTE_HOST},http://127.0.0.1:0`;

/** One of this host's real, non-loopback IPv4 addresses — the peer a request over it genuinely has. */
const external = Object.values(networkInterfaces())
  .flatMap((a) => a ?? [])
  .find((a) => a.family === "IPv4" && !a.internal)?.address;

interface Answer {
  status: number;
  body: { error?: { code: string; message: string }; [k: string]: unknown };
  text: string;
}

/** Where a request goes: the TCP endpoint, or the Unix socket. */
type Endpoint = { port: number } | { socketPath: string };

/**
 * A request over node:http rather than fetch: fetch cannot dial a Unix socket
 * and always writes a Host header, and this file needs both a socket and a
 * request with NO Host (`setHost: false`).
 */
function send(at: Endpoint, method: string, path: string, opts: { headers?: Record<string, string>; body?: unknown; host?: string | false } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    if (payload !== undefined) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(Buffer.byteLength(payload));
    }
    // the Host the proxy listener is asked about: the remote host unless the test says otherwise; `false` sends none at all
    if (opts.host !== false) headers.host = opts.host ?? REMOTE_HOST;
    const req = httpRequest(
      {
        ...("socketPath" in at ? { socketPath: at.socketPath } : { host: "127.0.0.1", port: at.port }),
        method,
        path,
        headers,
        setHost: false, // node would otherwise add `Host: 127.0.0.1:<port>` beside ours
      },
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
          resolve({ status: res.statusCode ?? 0, body, text });
        });
      },
    );
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

describe.skipIf(!hasDb)("the proxy listener: remote by construction", () => {
  let pool: pg.Pool;
  let queries: QueryStore;
  let server: ConsoleServer;
  let proxyTcp: ReturnType<ConsoleServer["proxyListener"]>;
  let proxySock: ReturnType<ConsoleServer["proxyListener"]>;
  let loopbackOnly: ConsoleServer;
  let loopbackOnlyProxy: ReturnType<ConsoleServer["proxyListener"]>;
  let main: Endpoint;
  let proxy: Endpoint;
  let sock: Endpoint;
  let sockPath: string;
  let lonely: Endpoint;
  let sessionCookie: string;
  let ownerToken: string;
  let agentToken: string;
  const localOwnerToken = mintToken();
  const agentId = `${MARK}-${suffix}`;
  const minted: string[] = [agentId];
  const passkeyIds: string[] = [];
  const dirs: string[] = [];

  const localOwner = { authorization: `Bearer ${localOwnerToken}` };
  const sinceNow = async (): Promise<number> => Number((await pool.query(`SELECT coalesce(max(id), 0) AS id FROM runs`)).rows[0].id);
  // This file's own requests only: CI runs the package's files in parallel, and
  // another suite's refusal (reach-gate's session, say) lands in `runs` between
  // `since` and the read. This file is the only one that opens a proxy listener,
  // so `listener = 'proxy'` is its marker; the one main-listener row it makes on
  // purpose is the genuinely remote peer, named by that peer's address.
  const authRows = async (tool: string, since: number): Promise<Record<string, unknown>[]> =>
    (
      await pool.query(
        `SELECT meta FROM runs WHERE component = 'console' AND kind = 'auth' AND tool = $1 AND id > $2 AND (meta ->> 'listener' = 'proxy' OR meta ->> 'remote' = $3::text) ORDER BY id`,
        [tool, since, external ?? null],
      )
    ).rows.map((r) => r.meta as Record<string, unknown>);

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
    queries = new QueryStore(pool);
    const inboxDir = await mkdtemp(join(tmpdir(), "metistry-proxy-listener-"));
    dirs.push(inboxDir);
    const common = { inboxDir, policy, secureCookies: false, localOwner: { token: localOwnerToken, trusted: [] as string[] } };
    // the console as it stands once a provider is chosen: a remote origin first, the loopback one `init` wrote second
    server = makeServer(pool, queries, { ...common, origin: "http://127.0.0.1:0", origins: ORIGINS });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    main = { port: (server.address() as AddressInfo).port };
    proxyTcp = server.proxyListener();
    await new Promise<void>((r) => proxyTcp.listen(0, "127.0.0.1", r));
    proxy = { port: (proxyTcp.address() as AddressInfo).port };
    const stateDir = await mkdtemp(join(tmpdir(), "metistry-proxy-state-"));
    dirs.push(stateDir);
    sockPath = join(stateDir, PROXY_SOCKET_FILENAME);
    proxySock = server.proxyListener();
    await listenProxySocket(proxySock, sockPath);
    sock = { socketPath: sockPath };
    // …and every install's default: loopback only, no provider yet
    loopbackOnly = makeServer(pool, queries, { ...common, origin: "http://127.0.0.1:0" });
    loopbackOnlyProxy = loopbackOnly.proxyListener();
    await new Promise<void>((r) => loopbackOnlyProxy.listen(0, "127.0.0.1", r));
    lonely = { port: (loopbackOnlyProxy.address() as AddressInfo).port };

    const pkId = `${MARK}-${mintToken(8)}`;
    passkeyIds.push(pkId);
    await store.storePasskey(pool, { id: pkId, publicKey: new Uint8Array([1]), signCount: 0, transports: [], origin: "t", label: MARK });
    sessionCookie = `metistry_session=${await store.issueSession(pool, pkId, policy)}`;
    ownerToken = await store.mintOwnerToken(pool, MARK);
    agentToken = (await agents.createAgent(pool, { id: agentId, display_name: "itest proxy listener" })).token;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM agents WHERE id = ANY($1)`, [minted]);
    await pool.query(`DELETE FROM owner_tokens WHERE label = $1`, [MARK]).catch(() => undefined);
    await pool.query(`DELETE FROM auth_sessions WHERE passkey_id = ANY($1)`, [passkeyIds]).catch(() => undefined);
    await pool.query(`DELETE FROM passkeys WHERE id = ANY($1)`, [passkeyIds]).catch(() => undefined);
    for (const s of [proxySock, proxyTcp, server, loopbackOnlyProxy, loopbackOnly]) await new Promise<void>((r) => s.close(() => r()));
    await pool.end();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("**the socket is 0600**, in the instance's state directory under its fixed name", () => {
    expect(statSync(sockPath).isSocket()).toBe(true);
    expect((statSync(sockPath).mode & 0o777).toString(8)).toBe("600");
  });

  // ----- U2 on the proxy listener -----
  it("U2: 401 with no credential, 403 for an agent bearer and for the capture owner token on management — through the proxy port and the socket alike", async () => {
    for (const at of [proxy, sock]) {
      const none = await send(at, "GET", "/api/devices");
      expect(none.status).toBe(401);
      expect(none.body).toEqual({ error: { code: "unauthenticated", message: "authentication required" } });
      const agent = await send(at, "GET", "/api/devices", { headers: { authorization: `Bearer ${agentToken}` } });
      expect(agent.status).toBe(403);
      expect(agent.body.error?.message).toBe("not granted");
      const capture = await send(at, "GET", "/api/devices", { headers: { authorization: `Bearer ${ownerToken}` } });
      expect(capture.status).toBe(403);
      expect(capture.body.error?.message).toBe("not granted");
    }
  });

  it("the doors the listener exists for still open through it: a passkey session is the owner, an agent bearer captures, the bootstrap answers", async () => {
    for (const at of [proxy, sock]) {
      const who = await send(at, "GET", "/api/whoami", { headers: { cookie: sessionCookie } });
      expect(who.status).toBe(200);
      expect(who.body).toMatchObject({ principal: "user", via: "passkey_session", management: true });
      expect((await send(at, "GET", "/api/devices", { headers: { cookie: sessionCookie } })).status).toBe(200);
      const cap = await send(at, "POST", "/capture", { headers: { authorization: `Bearer ${agentToken}` }, body: { note: "through the tunnel" } });
      expect(cap.status).toBe(201);
      expect((await send(at, "GET", "/health")).status).toBe(200);
      // the remote host with its default port spelled out is the same host
      expect((await send(at, "GET", "/health", { host: `${REMOTE_HOST}:443` })).status).toBe(200);
    }
  });

  // ----- the ticket's own -----
  it("**the local owner token from 127.0.0.1 on the proxy port is refused exactly as a remote one is, and audited** — and over the socket, which has no peer at all", async () => {
    const since = await sinceNow();
    const unknown = await send(proxy, "GET", "/api/whoami", { headers: { authorization: `Bearer ${mintToken()}` } });
    expect(unknown.status).toBe(401);

    const viaPort = await send(proxy, "GET", "/api/whoami", { headers: localOwner });
    expect(viaPort.status).toBe(401);
    expect(viaPort.text).toBe(unknown.text); // byte-identical to an unknown token's: no oracle that the secret was right

    const viaSock = await send(sock, "GET", "/api/whoami", { headers: localOwner });
    expect(viaSock.status).toBe(401);
    expect(viaSock.text).toBe(unknown.text);

    // …and exactly what the same token from a genuinely remote address gets on the main listener
    if (external) {
      const remoteServer = makeServer(pool, queries, { origin: "http://127.0.0.1:0", origins: ORIGINS, inboxDir: dirs[0]!, policy, secureCookies: false, localOwner: { token: localOwnerToken, trusted: [] } });
      await new Promise<void>((r) => remoteServer.listen(0, external, r));
      try {
        const remote = await fetch(`http://${external}:${(remoteServer.address() as AddressInfo).port}/api/whoami`, { headers: localOwner });
        expect(remote.status).toBe(401);
        expect(await remote.text()).toBe(viaPort.text);
      } finally {
        await new Promise<void>((r) => remoteServer.close(() => r()));
      }
    }

    // the refusal is on the record, naming the listener and the peer the proxy dialled from
    const rows = await authRows("owner_token_remote", since);
    const proxyRows = rows.filter((m) => m.listener === "proxy");
    expect(proxyRows.length).toBe(2);
    expect(proxyRows[0]).toMatchObject({ listener: "proxy", remote: "127.0.0.1", reason: expect.stringContaining("never crosses a tunnel") });
    expect(proxyRows[1]).toMatchObject({ listener: "proxy", remote: "", reason: expect.stringContaining("never crosses a tunnel") });
    // an unknown token leaves no row: a mismatch is not a refusal of THE token
    expect(rows.length).toBe(proxyRows.length + (external ? 1 : 0));
  });

  it("**a `local` route answers 403 there**: a passkey session is refused local_only and audited with the listener; the local owner token is the uniform 401; nothing is minted", async () => {
    const since = await sinceNow();
    for (const at of [proxy, sock]) {
      const idSession = `${MARK}-s-${suffix}-${minted.length}`;
      minted.push(idSession);
      const asSession = await send(at, "POST", "/api/agents", { headers: { cookie: sessionCookie }, body: { id: idSession, display_name: "proxy probe", kind: "external" } });
      expect(asSession.status).toBe(403);
      expect(asSession.body.error?.code).toBe("local_only");
      expect(asSession.body.error?.message).toContain("POST /api/agents");

      const idToken = `${MARK}-t-${suffix}-${minted.length}`;
      minted.push(idToken);
      const asToken = await send(at, "POST", "/api/agents", { headers: localOwner, body: { id: idToken, display_name: "proxy probe", kind: "external" } });
      expect(asToken.status).toBe(401);
      expect(asToken.body).toEqual({ error: { code: "unauthenticated", message: "authentication required" } });

      const { rows } = await pool.query(`SELECT id FROM agents WHERE id = ANY($1)`, [[idSession, idToken]]);
      expect(rows).toEqual([]);
    }
    const refused = await authRows("local_only", since);
    expect(refused.length).toBe(2);
    for (const m of refused) expect(m).toMatchObject({ route: "POST /api/agents", via: "session", listener: "proxy", reason: expect.stringContaining("never answers on the proxy listener") });
  });

  it("**a wrong Host is refused** — 421 misdirected, before the shell, the ceremonies, /health, /mcp and any credential is looked at", async () => {
    const since = await sinceNow();
    const wrong = ["other.tail1234.ts.net", `${REMOTE_HOST}:8443`, "127.0.0.1", `127.0.0.1:${(proxy as { port: number }).port}`, "localhost"];
    for (const at of [proxy, sock]) {
      for (const host of wrong) {
        for (const [method, path, headers] of [
          ["GET", "/health", {}],
          ["GET", "/api/identity", {}],
          ["GET", "/", {}],
          ["POST", "/auth/login/start", {}],
          ["POST", "/mcp", { authorization: `Bearer ${agentToken}` }],
          ["GET", "/api/whoami", localOwner],
          ["GET", "/api/whoami", { cookie: sessionCookie }],
        ] as [string, string, Record<string, string>][]) {
          const r = await send(at, method, path, { headers, host, ...(method === "POST" ? { body: {} } : {}) });
          expect(r.status, `${method} ${path} Host ${String(host)}`).toBe(421);
          expect(r.body.error?.code).toBe("misdirected");
          expect(r.body.error?.message).toContain("METISTRY_ORIGIN");
        }
      }
    }
    // the Host gate is before authentication, so the token presented behind a wrong Host leaves no auth row of any kind
    expect(await authRows("owner_token_remote", since)).toEqual([]);
    expect(await authRows("local_only", since)).toEqual([]);
  });

  it("the message echoes the Host asked for, bounded, and never the hosts configured", async () => {
    const r = await send(proxy, "GET", "/health", { host: "other.example" });
    expect(r.body.error?.message).toContain('named "other.example"');
    expect(r.body.error?.message).not.toContain(REMOTE_HOST);
    const long = await send(proxy, "GET", "/health", { host: `${"a".repeat(300)}.example` });
    expect(long.status).toBe(421);
    expect(long.body.error!.message.length).toBeLessThan(400);
  });

  it("a request with no Host at all never reaches the router: node's parser answers 400 to it on either listener (the HTTP/1.0 path `hostAllowed` guards is the unit test's)", async () => {
    for (const at of [proxy, sock, main]) expect((await send(at, "GET", "/health", { host: false })).status).toBe(400);
  });

  it("**with no remote origin configured — every install's default — the proxy listener refuses every Host**, naming Settings ▸ Remote Access", async () => {
    for (const host of [REMOTE_HOST, "127.0.0.1", "localhost", "anything.example"]) {
      const r = await send(lonely, "GET", "/health", { host });
      expect(r.status).toBe(421);
      expect(r.body.error?.message).toContain("Remote Access");
    }
    const who = await send(lonely, "GET", "/api/whoami", { headers: localOwner, host: "127.0.0.1" });
    expect(who.status).toBe(421);
  });

  // ----- the main listener is unchanged -----
  it("the main listener's local door still works, and it never asks about Host", async () => {
    const who = await send(main, "GET", "/api/whoami", { headers: localOwner, host: `127.0.0.1:${(main as { port: number }).port}` });
    expect(who.status).toBe(200);
    expect(who.body).toMatchObject({ principal: "user", via: "local_owner_token", management: true });
    for (const host of ["whatever.example", REMOTE_HOST, "127.0.0.1", "[::1]:8080"]) {
      expect((await send(main, "GET", "/health", { host })).status).toBe(200);
      expect((await send(main, "GET", "/api/whoami", { headers: localOwner, host })).status).toBe(200);
    }
    // …including on the loopback-only console, whose proxy listener refuses everything
    await new Promise<void>((r) => loopbackOnly.listen(0, "127.0.0.1", r));
    const lonelyMain = { port: (loopbackOnly.address() as AddressInfo).port };
    expect((await send(lonelyMain, "GET", "/api/whoami", { headers: localOwner, host: "127.0.0.1" })).status).toBe(200);
  });

  it("a stale socket file is replaced; a file that is not a socket is refused rather than deleted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metistry-proxy-stale-"));
    dirs.push(dir);
    const path = join(dir, PROXY_SOCKET_FILENAME);
    // not ours: a plain file at the socket's path stays exactly as it was
    writeFileSync(path, "x");
    await expect(listenProxySocket(server.proxyListener(), path)).rejects.toThrow(/not a socket/);
    expect(readFileSync(path, "utf8")).toBe("x");
    rmSync(path);
    // a socket a dead console left behind — bound by another process and never
    // unlinked (node unlinks its own on close, so it cannot leave one here)
    const left = spawnSync("python3", ["-c", "import socket, sys; s = socket.socket(socket.AF_UNIX); s.bind(sys.argv[1])", path]);
    if (left.status === 0) {
      expect(statSync(path).isSocket()).toBe(true);
      const again = server.proxyListener();
      await expect(listenProxySocket(again, path)).resolves.toBeUndefined();
      expect((statSync(path).mode & 0o777).toString(8)).toBe("600");
      expect((await send({ socketPath: path }, "GET", "/health")).status).toBe(200);
      await new Promise<void>((r) => again.close(() => r()));
    }
  });
});
