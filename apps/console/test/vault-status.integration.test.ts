// `GET /api/vault/status` (design-build-plan §2.21, T10-2) over real sockets
// against the scratch database (docs/ops/testing.md). The reconciler is a
// fake bridge on its own loopback port, reached through the real
// `httpVaultStatus` — the console holds no git.
//
// U2's misuse tests: 401 with no credential, 403 for an agent bearer and for
// the capture owner token, and the local owner token (and a passkey session)
// reach it. The route's own: the body is parsed STRICTLY, so a field the
// schema does not name — a note's content, say — can never ride through; no
// bridge, or a bridge that fails, is 503 not_available.
import { createServer, type Server as HttpServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { mintToken, vaultStatusSchema } from "@foldedspacelabs/metistry-core";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";
import { makeServer } from "../src/server.js";
import { httpVaultStatus } from "../src/vault-status.js";
import * as store from "../src/auth-store.js";
import * as agents from "../src/agents.js";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url));
const policy = { idleDays: 30, maxDays: 365 };
const MARK = "itest-vault-status";
const suffix = mintToken(6).toLowerCase().replaceAll(/[^a-z0-9]/g, "").slice(0, 6) || "x";

const STATUS = {
  branch: "main",
  remote: "origin",
  ahead: 2,
  behind: 1,
  last_commit: { sha: "4c1d2e3f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d", subject: "Tick 1 task", author: "user", at: "2026-09-28T12:58:01.000Z" },
  last_push: { at: "2026-09-28T12:30:00.000Z", ok: true, remote: "origin" },
  last_pull: { at: "2026-09-28T13:00:00.000Z", ok: true, remote: "origin" },
  conflict: { paths: ["now.md"] },
  policy: { push: "after_commit", pull: { every: "5m" } },
  as_of: "2026-09-28T13:05:00.000Z",
};

type Server = ReturnType<typeof makeServer>;

describe.skipIf(!hasDb)("GET /api/vault/status", () => {
  let pool: pg.Pool;
  let queries: QueryStore;
  const servers: Server[] = [];
  let bridge: HttpServer;
  let bridgeUrl: string;
  /** what the fake bridge answers next, and the bearers it was shown */
  let answer: { status: number; body: unknown } = { status: 200, body: STATUS };
  const bearers: string[] = [];
  const bridgeToken = mintToken();
  let base: string;
  let sessionCookie: string;
  let ownerToken: string;
  let agentToken: string;
  const localOwnerToken = mintToken();
  const agentId = `itest-vault-status-${suffix}`;
  const passkeyIds: string[] = [];

  async function listen(extra: Partial<Parameters<typeof makeServer>[2]>): Promise<string> {
    const server = makeServer(pool, queries, {
      origin: "http://127.0.0.1:0",
      inboxDir: await mkdtemp(join(tmpdir(), "metistry-vault-status-")),
      policy,
      secureCookies: false,
      localOwner: { token: localOwnerToken, trusted: [] },
      ...extra,
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
    queries = new QueryStore(pool);

    bridge = createServer((req, res) => {
      bearers.push(String(req.headers.authorization ?? ""));
      if (req.url !== "/vault/status") {
        res.writeHead(404).end();
        return;
      }
      const text = JSON.stringify(answer.body);
      res.writeHead(answer.status, { "content-type": "application/json" }).end(text);
    });
    await new Promise<void>((r) => bridge.listen(0, "127.0.0.1", r));
    bridgeUrl = `http://127.0.0.1:${(bridge.address() as AddressInfo).port}`;
    base = await listen({ vaultStatus: httpVaultStatus({ url: bridgeUrl, token: bridgeToken }) });

    const pkId = `${MARK}-${mintToken(8)}`;
    passkeyIds.push(pkId);
    await store.storePasskey(pool, { id: pkId, publicKey: new Uint8Array([1]), signCount: 0, transports: [], origin: "t", label: MARK });
    sessionCookie = `metistry_session=${await store.issueSession(pool, pkId, policy)}`;
    ownerToken = await store.mintOwnerToken(pool, MARK);
    agentToken = (await agents.createAgent(pool, { id: agentId, display_name: "itest vault status" })).token;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM agents WHERE id = $1`, [agentId]).catch(() => undefined);
    await pool.query(`DELETE FROM owner_tokens WHERE label = $1`, [MARK]).catch(() => undefined);
    await pool.query(`DELETE FROM auth_sessions WHERE passkey_id = ANY($1)`, [passkeyIds]).catch(() => undefined);
    await pool.query(`DELETE FROM passkeys WHERE id = ANY($1)`, [passkeyIds]).catch(() => undefined);
    for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
    await new Promise<void>((r) => bridge.close(() => r()));
    await pool.end();
  });

  async function get(at: string, headers: Record<string, string> = {}): Promise<{ status: number; text: string; body: any }> {
    const r = await fetch(`${at}/api/vault/status`, { headers });
    const text = await r.text();
    return { status: r.status, text, body: JSON.parse(text) };
  }

  it("U2: no credential is the uniform 401 — and the bridge is never asked", async () => {
    const before = bearers.length;
    const r = await get(base);
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: { code: "unauthenticated", message: "authentication required" } });
    expect(bearers.length).toBe(before);
  });

  it("U2: an agent bearer and the capture owner token are the uniform 403 — and the bridge is never asked", async () => {
    const before = bearers.length;
    for (const bearer of [agentToken, ownerToken]) {
      const r = await get(base, { authorization: `Bearer ${bearer}` });
      expect(r.status).toBe(403);
      expect(r.body).toEqual({ error: { code: "forbidden", message: "not granted" } });
      expect(r.text).not.toContain("now.md");
    }
    expect(bearers.length).toBe(before);
  });

  it("U2: the local owner token reaches it, and so does a passkey session (reach owner)", async () => {
    const byToken = await get(base, { authorization: `Bearer ${localOwnerToken}` });
    expect(byToken.status).toBe(200);
    expect(byToken.body).toEqual(STATUS);
    expect(vaultStatusSchema.parse(byToken.body)).toEqual(STATUS);
    expect((await get(base, { cookie: sessionCookie })).status).toBe(200);
    // the console asked with ITS bridge bearer — never the caller's credential
    expect(bearers.at(-1)).toBe(`Bearer ${bridgeToken}`);
    expect(bearers).not.toContain(`Bearer ${localOwnerToken}`);
  });

  it("**strict**: a bridge that sends a field the schema does not name is refused, not relayed", async () => {
    answer = { status: 200, body: { ...STATUS, diff: "SECRET-NOTE-CONTENT" } };
    try {
      const r = await get(base, { authorization: `Bearer ${localOwnerToken}` });
      expect(r.status).toBe(503);
      expect(r.body.error.code).toBe("not_available");
      expect(r.text).not.toContain("SECRET-NOTE-CONTENT");
    } finally {
      answer = { status: 200, body: STATUS };
    }
  });

  it("a bridge that fails, or is down, is 503 not_available naming it; no bridge configured is 503 naming the variables", async () => {
    answer = { status: 503, body: { error: { code: "not_available", message: "x" } } };
    try {
      const r = await get(base, { authorization: `Bearer ${localOwnerToken}` });
      expect(r.status).toBe(503);
      expect(r.body.error.message).toMatch(/reconciler answered HTTP 503/);
    } finally {
      answer = { status: 200, body: STATUS };
    }

    const down = await listen({ vaultStatus: httpVaultStatus({ url: "http://127.0.0.1:1", token: bridgeToken, timeoutMs: 2000 }) });
    const d = await get(down, { authorization: `Bearer ${localOwnerToken}` });
    expect(d.status).toBe(503);
    expect(d.body.error.message).toMatch(/did not answer/);

    const none = await listen({});
    const n = await get(none, { authorization: `Bearer ${localOwnerToken}` });
    expect(n.status).toBe(503);
    expect(n.body.error.message).toContain("METISTRY_RECONCILER_URL");
  });
});
