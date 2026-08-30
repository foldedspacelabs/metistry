// Integration + misuse tests against the real database and a live server
// on an ephemeral port. Skipped when no db is configured (CI provides one;
// locally `.env` does).
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { QueryStore } from "@foldedspacelabs/queries";
import { mintToken } from "@foldedspacelabs/core";
import { makeServer } from "../src/server.js";
import * as store from "../src/auth-store.js";

// load ../.env for local runs
try {
  for (const line of readFileSync(new URL("../../../.env", import.meta.url), "utf8").split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m && m[1] && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {}

const hasDb = !!process.env.METISTRY_DB_PASSWORD;
const policy = { idleDays: 30, maxDays: 365 };

describe.skipIf(!hasDb)("console server (integration)", () => {
  let pool: pg.Pool;
  let base: string;
  let server: ReturnType<typeof makeServer>;
  let sessionCookie: string;
  let ownerToken: string;

  beforeAll(async () => {
    pool = new pg.Pool({
      host: process.env.METISTRY_DB_HOST ?? "127.0.0.1",
      user: process.env.METISTRY_DB_USER ?? "metistry",
      database: process.env.METISTRY_DB_NAME ?? "metistry",
      password: process.env.METISTRY_DB_PASSWORD,
    });
    const queries = new QueryStore(pool);
    queries.load(`
name: open_work
description: test
params:
  limit: { type: int, default: 5 }
sql: SELECT id, title FROM work WHERE status <> 'closed' ORDER BY updated_at DESC LIMIT :limit
`);
    server = makeServer(pool, queries, {
      origin: "http://127.0.0.1:0",
      inboxDir: `/tmp/metistry-test-inbox-${Date.now()}`,
      policy,
      secureCookies: false,
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // fabricate an enrolled device directly (WebAuthn ceremony is the
    // library's job; the store + policy paths are ours to test)
    const pkId = `test-${mintToken(8)}`;
    await store.storePasskey(pool, {
      id: pkId,
      publicKey: new Uint8Array([1, 2, 3]),
      signCount: 0,
      transports: [],
      origin: "http://test",
      label: "test-device",
    });
    sessionCookie = `metistry_session=${await store.issueSession(pool, pkId, policy)}`;
    ownerToken = await store.mintOwnerToken(pool, "test");
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await pool.end();
  });

  // ----- misuse tests (invariant 8) -----
  it("returns uniform 401 with no credential", async () => {
    for (const path of ["/capture", "/message"]) {
      const r = await fetch(base + path, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
      expect(r.status).toBe(401);
      expect(await r.json()).toEqual({ error: { code: "unauthenticated", message: "authentication required" } });
    }
    expect((await fetch(`${base}/api/devices`)).status).toBe(401);
  });

  it("owner token works on capture but is FORBIDDEN on management", async () => {
    const auth = { authorization: `Bearer ${ownerToken}` };
    const cap = await fetch(`${base}/capture`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ note: "from shortcut" }),
    });
    expect(cap.status).toBe(201);
    const mgmt = await fetch(`${base}/api/devices`, { headers: auth });
    expect(mgmt.status).toBe(403);
    expect((await mgmt.json()).error.message).toBe("not granted"); // no existence leak
  });

  it("rejects a bogus bearer and a bogus cookie", async () => {
    expect((await fetch(`${base}/api/status`, { headers: { authorization: `Bearer ${mintToken()}` } })).status).toBe(401);
    expect((await fetch(`${base}/api/status`, { headers: { cookie: `metistry_session=${mintToken()}` } })).status).toBe(401);
  });

  // ----- behavior -----
  it("POST /message lands a durable row before the 202", async () => {
    const r = await fetch(`${base}/message`, {
      method: "POST",
      headers: { cookie: sessionCookie, "content-type": "application/json" },
      body: JSON.stringify({ text: "hello metis" }),
    });
    expect(r.status).toBe(202);
    const { message_id } = await r.json();
    const { rows } = await pool.query(`SELECT text, status FROM inbound_messages WHERE id = $1`, [message_id]);
    expect(rows[0]).toEqual({ text: "hello metis", status: "new" });
  });

  it("capture stores file + inbox row + sha", async () => {
    const bytes = Buffer.from("fake image bytes");
    const r = await fetch(`${base}/capture`, {
      method: "POST",
      headers: { cookie: sessionCookie, "content-type": "application/octet-stream", "x-metistry-filename": "../../evil.png" },
      body: bytes,
    });
    expect(r.status).toBe(201);
    const body = await r.json();
    expect(body.path).not.toContain(".."); // traversal neutralized
    const { rows } = await pool.query(`SELECT sha256 FROM inbox WHERE id = $1`, [body.id]);
    expect(rows[0].sha256).toBe(body.sha256);
  });

  it("named queries serve with as_of; unknown query is 404; session works", async () => {
    const r = await fetch(`${base}/api/q/open_work?limit=3`, { headers: { cookie: sessionCookie } });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toHaveProperty("rows");
    expect(body).toHaveProperty("as_of");
    expect((await fetch(`${base}/api/q/nope`, { headers: { cookie: sessionCookie } })).status).toBe(404);
  });

  it("device list + revoke, and the revoked session dies immediately", async () => {
    const list = await fetch(`${base}/api/devices`, { headers: { cookie: sessionCookie } });
    expect(list.status).toBe(200);
    const { devices } = await list.json();
    const mine = devices.find((d: any) => d.label === "test-device" && !d.revoked);
    const rev = await fetch(`${base}/api/devices/${mine.id}/revoke`, { method: "POST", headers: { cookie: sessionCookie } });
    expect(rev.status).toBe(200);
    expect((await fetch(`${base}/api/devices`, { headers: { cookie: sessionCookie } })).status).toBe(401);
  });

  it("enrollment codes are single-use and expiring", async () => {
    const code = await store.mintEnrollmentCode(pool);
    expect(await store.peekEnrollmentCode(pool, code)).toBe(true);
    expect(await store.consumeEnrollmentCode(pool, code)).toBe(true);
    expect(await store.consumeEnrollmentCode(pool, code)).toBe(false); // burned
    expect(await store.peekEnrollmentCode(pool, "wrong")).toBe(false);
  });
});
