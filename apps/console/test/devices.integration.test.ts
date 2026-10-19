// X-76 — removing a device revokes its passkey (design-build-plan §2.22,
// Devices). A device is a passkey with its sessions under it: `GET
// /api/devices` serves one row per passkey, and `POST /api/devices/:id/revoke`
// — Remove — revokes the passkey (`passkeys.revoked_at`, migration 0038) and
// every session under it, dropping their push subscriptions. A revoked
// passkey's login is the same uniform 401 an unknown credential gets. Sign Out
// Everywhere is the same door with `scope: "sessions"`: sessions end, the
// passkey stays.
//
// U2's misuse tests for both doors sit first; the ticket's own (bold in its
// Tests line) follow. Everything runs against the scratch database and a live
// server on an ephemeral loopback port.
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { mintToken } from "@foldedspacelabs/metistry-core";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";
import { makeServer } from "../src/server.js";
import * as store from "../src/auth-store.js";
import * as agents from "../src/agents.js";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url)); // METISTRY_DB_* only (docs/ops/testing.md)
const policy = { idleDays: 30, maxDays: 365 };
const MARK = `x76-${randomBytes(3).toString("hex")}`; // a slug: it is also the probe agent's id

describe.skipIf(!hasDb)("devices — a device is a passkey; Remove revokes it (X-76, §2.22)", () => {
  let pool: pg.Pool;
  let base: string;
  let server: ReturnType<typeof makeServer>;
  let inboxDir: string;
  const localOwnerToken = mintToken();
  let ownerToken: string; // a capture Shortcut's `owner_tokens` row: capture-only
  let agentToken: string;
  const agentId = `${MARK}-agent`;
  const passkeyIds: string[] = [];

  /** An enrolled device: a passkey and one session per `sessions`, the first holding a push subscription when asked. */
  async function enrol(label: string, sessions: number, push = false): Promise<{ id: string; cookies: string[]; sessionIds: number[] }> {
    const id = `${MARK}-${label}-${mintToken(4)}`;
    passkeyIds.push(id);
    await store.storePasskey(pool, { id, publicKey: new Uint8Array([1, 2, 3]), signCount: 0, transports: [], origin: "http://test", label });
    const cookies: string[] = [];
    const sessionIds: number[] = [];
    for (let i = 0; i < sessions; i++) {
      const token = await store.issueSession(pool, id, policy);
      cookies.push(`metistry_session=${token}`);
      const { rows } = await pool.query(`SELECT id FROM auth_sessions WHERE passkey_id = $1 ORDER BY id DESC LIMIT 1`, [id]);
      sessionIds.push(Number(rows[0].id));
    }
    if (push) {
      await pool.query(`UPDATE auth_sessions SET push_subscription = $2::jsonb WHERE id = $1`, [
        sessionIds[0],
        JSON.stringify({ endpoint: `https://push.example.test/${MARK}`, keys: { p256dh: "a", auth: "b" } }),
      ]);
    }
    return { id, cookies, sessionIds };
  }

  const passkeyRow = async (id: string) => (await pool.query(`SELECT revoked_at FROM passkeys WHERE id = $1`, [id])).rows[0];
  const sessionRows = async (passkeyId: string) =>
    (await pool.query(`SELECT id, revoked_at, push_subscription FROM auth_sessions WHERE passkey_id = $1 ORDER BY id`, [passkeyId])).rows;

  async function call(method: string, path: string, headers: Record<string, string>, body?: string): Promise<{ status: number; text: string; setCookie: string | null; json: any }> {
    const r = await fetch(base + path, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, body });
    const text = await r.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: r.status, text, setCookie: r.headers.get("set-cookie"), json };
  }
  const asLocalOwner = { authorization: `Bearer ${localOwnerToken}` };

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
    inboxDir = await mkdtemp(join(tmpdir(), "metistry-x76-"));
    server = makeServer(pool, new QueryStore(pool), {
      origin: "http://127.0.0.1:0",
      inboxDir,
      policy,
      secureCookies: false,
      localOwner: { token: localOwnerToken, trusted: [] }, // loopback only, as on the launchd shape
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    ownerToken = await store.mintOwnerToken(pool, MARK);
    agentToken = (await agents.createAgent(pool, { id: agentId, display_name: "x76 probe" })).token;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM agents WHERE id = $1`, [agentId]).catch(() => undefined);
    await pool.query(`DELETE FROM owner_tokens WHERE label = $1`, [MARK]).catch(() => undefined);
    await pool.query(`DELETE FROM auth_sessions WHERE passkey_id = ANY($1)`, [passkeyIds]).catch(() => undefined);
    await pool.query(`DELETE FROM passkeys WHERE id = ANY($1)`, [passkeyIds]).catch(() => undefined);
    await new Promise<void>((r) => server.close(() => r()));
    await pool.end();
    rmSync(inboxDir, { recursive: true, force: true });
  });

  // ----- U2: the two doors' misuse tests -----

  it("U2 — GET /api/devices: 401 with no credential, 403 for an agent bearer, 403 for the capture owner token; the local owner token reaches it", async () => {
    expect((await call("GET", "/api/devices", {})).status).toBe(401);
    expect((await call("GET", "/api/devices", { authorization: `Bearer ${agentToken}` })).status).toBe(403);
    expect((await call("GET", "/api/devices", { authorization: `Bearer ${ownerToken}` })).status).toBe(403);
    const ok = await call("GET", "/api/devices", asLocalOwner);
    expect(ok.status).toBe(200);
    expect(Array.isArray(ok.json.devices)).toBe(true);
  });

  it("U2 — POST /api/devices/:id/revoke: 401, 403, 403 — and nothing is revoked by a refused call; the local owner token reaches it", async () => {
    const d = await enrol("misuse", 1);
    const path = `/api/devices/${d.sessionIds[0]}/revoke`;
    expect((await call("POST", path, {}, "{}")).status).toBe(401);
    expect((await call("POST", path, { authorization: `Bearer ${agentToken}` }, "{}")).status).toBe(403);
    expect((await call("POST", path, { authorization: `Bearer ${ownerToken}` }, "{}")).status).toBe(403);
    expect((await passkeyRow(d.id)).revoked_at).toBeNull();
    expect((await sessionRows(d.id)).every((s) => s.revoked_at === null)).toBe(true);
    expect((await call("GET", "/api/devices", { cookie: d.cookies[0] })).status).toBe(200); // still signed in
    const ok = await call("POST", path, asLocalOwner, "{}");
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual({ revoked: true, scope: "device", sessions: 1 });
    expect((await passkeyRow(d.id)).revoked_at).not.toBeNull();
  });

  // ----- the list -----

  it("GET /api/devices serves a device per passkey — label, added, last seen, this_device on the caller's own row, its sessions under it", async () => {
    const phone = await enrol("phone", 2);
    const tablet = await enrol("tablet", 1);
    const seen = await call("GET", "/api/devices", { cookie: phone.cookies[1] });
    expect(seen.status).toBe(200);
    const mine = seen.json.devices.filter((d: any) => [phone.id, tablet.id].includes(d.passkey_id));
    expect(mine).toHaveLength(2);
    const p = mine.find((d: any) => d.passkey_id === phone.id);
    const t = mine.find((d: any) => d.passkey_id === tablet.id);
    expect(p).toMatchObject({ label: "phone", this_device: true, revoked: false, id: String(Math.max(...phone.sessionIds)) });
    expect(typeof p.added).toBe("string");
    expect(typeof p.last_seen).toBe("string");
    expect(p.sessions.map((s: any) => Number(s.id)).sort()).toEqual([...phone.sessionIds].sort());
    expect(p.sessions.every((s: any) => s.revoked === false && s.push === false)).toBe(true);
    expect(t).toMatchObject({ label: "tablet", this_device: false, id: String(tablet.sessionIds[0]) });
    expect(t.sessions).toHaveLength(1);
    // the local owner token has no device: every row is somebody else's
    const asOwner = await call("GET", "/api/devices", asLocalOwner);
    expect(asOwner.json.devices.every((d: any) => d.this_device === false)).toBe(true);
    // the fields a reader of the pre-§2.22 shape knows are still there
    for (const k of ["passkey_last_used", "created_at", "last_seen_at", "absolute_expires_at", "revoked"]) expect(p).toHaveProperty(k);
  });

  // ----- the ticket's own tests -----

  it("**a removed device's passkey cannot sign in again and its push subscription is gone**: every session under it is revoked, the device leaves the list, and it lands in runs", async () => {
    const phone = await enrol("lost-phone", 2, true);
    const other = await enrol("other", 1);
    const since = Number((await pool.query(`SELECT coalesce(max(id), 0) AS id FROM runs`)).rows[0].id);
    expect((await sessionRows(phone.id))[0].push_subscription).not.toBeNull();

    // Remove, from another device, at the lost phone's OLDER session id — any of its sessions names the device
    const r = await call("POST", `/api/devices/${phone.sessionIds[0]}/revoke`, { cookie: other.cookies[0] }); // no body at all: the default scope
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ revoked: true, scope: "device", sessions: 2 });

    expect((await passkeyRow(phone.id)).revoked_at).not.toBeNull();
    const sessions = await sessionRows(phone.id);
    expect(sessions).toHaveLength(2);
    expect(sessions.every((s) => s.revoked_at !== null && s.push_subscription === null)).toBe(true);
    for (const cookie of phone.cookies) expect((await call("GET", "/api/devices", { cookie })).status).toBe(401);
    expect(await store.getPasskey(pool, phone.id)).toBeNull();
    const list = await call("GET", "/api/devices", { cookie: other.cookies[0] });
    expect(list.json.devices.some((d: any) => d.passkey_id === phone.id)).toBe(false);
    expect(list.json.devices.some((d: any) => d.passkey_id === other.id)).toBe(true);

    // removed is removed: a second Remove finds no device, as an unknown session did before
    expect((await call("POST", `/api/devices/${phone.sessionIds[1]}/revoke`, { cookie: other.cookies[0] }, "{}")).status).toBe(404);

    const { rows } = await pool.query(`SELECT kind, tool, ok, meta FROM runs WHERE id > $1 AND kind = 'auth' AND tool = 'revoke' ORDER BY id`, [since]);
    expect(rows.map((x) => [x.ok, x.meta.scope, x.meta.passkey_id, x.meta.sessions])).toEqual([
      [true, "device", phone.id, 2],
      [false, "device", undefined, undefined],
    ]);
  });

  it("**a revoked passkey's login is indistinguishable from an unknown one's**: the same status, the same body, no cookie", async () => {
    const phone = await enrol("gone", 1);
    const keeper = await enrol("keeper", 1);
    expect((await call("POST", `/api/devices/${phone.sessionIds[0]}/revoke`, { cookie: keeper.cookies[0] }, "{}")).status).toBe(200);

    const finish = async (credentialId: string) => {
      const start = await call("POST", "/auth/login/start", {}, "{}");
      expect(start.status).toBe(200);
      return call("POST", "/auth/login/finish", {}, JSON.stringify({ key: start.json.key, response: { id: credentialId } }));
    };
    const revoked = await finish(phone.id);
    const unknown = await finish(`${MARK}-never-enrolled`);
    expect(revoked.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(revoked.text).toBe(unknown.text);
    expect(revoked.setCookie).toBeNull();
    expect(unknown.setCookie).toBeNull();
    // and a live one is found — the refusal differs only after the lookup, inside the ceremony
    expect(await store.getPasskey(pool, keeper.id)).not.toBeNull();
  });

  it("**Sign Out Everywhere leaves passkeys valid**: scope sessions ends the sessions, drops their push, and the passkey still signs in", async () => {
    const phone = await enrol("so-phone", 2, true);
    const r = await call("POST", `/api/devices/${phone.sessionIds[1]}/revoke`, asLocalOwner, JSON.stringify({ scope: "sessions" }));
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ revoked: true, scope: "sessions", sessions: 2 });
    expect((await passkeyRow(phone.id)).revoked_at).toBeNull();
    expect(await store.getPasskey(pool, phone.id)).not.toBeNull();
    expect((await sessionRows(phone.id)).every((s) => s.revoked_at !== null && s.push_subscription === null)).toBe(true);
    for (const cookie of phone.cookies) expect((await call("GET", "/api/devices", { cookie })).status).toBe(401);
    // still a device: listed, signed out
    const list = await call("GET", "/api/devices", asLocalOwner);
    const row = list.json.devices.find((d: any) => d.passkey_id === phone.id);
    expect(row).toBeDefined();
    expect(row.sessions.every((s: any) => s.revoked === true)).toBe(true);
    // and a login with it may issue a session again, which then works
    const token = await store.issueSession(pool, phone.id, policy);
    expect((await call("GET", "/api/devices", { cookie: `metistry_session=${token}` })).status).toBe(200);
  });

  it("a session whose passkey was revoked underneath it is refused — the race between a login's lookup and Remove has no survivor", async () => {
    const phone = await enrol("racer", 1);
    await pool.query(`UPDATE passkeys SET revoked_at = now() WHERE id = $1`, [phone.id]); // the session row itself is untouched
    expect((await sessionRows(phone.id))[0].revoked_at).toBeNull();
    expect((await call("GET", "/api/devices", { cookie: phone.cookies[0] })).status).toBe(401);
    expect(await store.checkSession(pool, phone.cookies[0].slice("metistry_session=".length), policy)).toBeNull();
  });

  it("refuses a scope that is neither, a body that is not an object, a body that is not JSON, and an unknown session — revoking nothing", async () => {
    const phone = await enrol("careful", 1);
    const path = `/api/devices/${phone.sessionIds[0]}/revoke`;
    for (const body of [JSON.stringify({ scope: "everything" }), JSON.stringify({ scope: 1 }), "[]", "null", "not json"]) {
      const r = await call("POST", path, asLocalOwner, body);
      expect(r.status, body).toBe(400);
      expect(r.json.error.code, body).toBe("invalid_request");
    }
    expect((await call("POST", "/api/devices/999999999/revoke", asLocalOwner, "{}")).status).toBe(404);
    expect((await passkeyRow(phone.id)).revoked_at).toBeNull();
    expect((await sessionRows(phone.id))[0].revoked_at).toBeNull();
  });

  it("logout still ends only the caller's session row; the passkey and the device's other sessions stay", async () => {
    const phone = await enrol("logout", 2);
    const r = await call("POST", "/auth/logout", { cookie: phone.cookies[0] }, "{}");
    expect(r.status).toBe(200);
    expect((await passkeyRow(phone.id)).revoked_at).toBeNull();
    expect((await call("GET", "/api/devices", { cookie: phone.cookies[0] })).status).toBe(401);
    expect((await call("GET", "/api/devices", { cookie: phone.cookies[1] })).status).toBe(200);
  });
});
