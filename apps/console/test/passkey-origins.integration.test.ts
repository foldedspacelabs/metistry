// Passkeys per origin, over HTTP (§2.23 *Two fixes*, 2; X-104). The rpID of a
// ceremony follows the request: a `start` from a configured origin is issued
// that origin's host, one from an origin outside METISTRY_ORIGIN is refused
// naming both sides, and a passkey signs in only at the host it was created
// for — a passkey created at the second origin is refused at the first, and
// one from before 0039 (no `rp_id`) still signs in at the first. Skipped
// without a db (CI provides one).
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { mintToken } from "@foldedspacelabs/metistry-core";
import { makeServer } from "../src/server.js";
import * as store from "../src/auth-store.js";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";
import { SoftwarePasskey } from "./passkey-fake.js";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url)); // METISTRY_DB_* only, and nothing of the operator's install (docs/ops/testing.md)

const FIRST = "https://assistant.example";
const SECOND = "https://assistant.tailnet.ts.net";
const FIRST_HOST = "assistant.example";
const SECOND_HOST = "assistant.tailnet.ts.net";
const policy = { idleDays: 30, maxDays: 365 };

describe.skipIf(!hasDb)("passkeys per origin — the rpID follows the request (X-104)", () => {
  let pool: pg.Pool;
  let base: string;
  let server: ReturnType<typeof makeServer>;
  const localOwnerToken = mintToken(32);
  const created: string[] = [];

  const post = (path: string, body: unknown, origin?: string) =>
    fetch(base + path, {
      method: "POST",
      headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
      body: JSON.stringify(body ?? {}),
    });

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
    server = makeServer(pool, new QueryStore(pool), {
      origin: FIRST,
      origins: `${FIRST}, ${SECOND}`,
      inboxDir: `/tmp/metistry-test-inbox-${Date.now()}`,
      policy,
      secureCookies: false,
      localOwner: { token: localOwnerToken, trusted: [] },
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    if (created.length) {
      await pool.query(`DELETE FROM auth_sessions WHERE passkey_id = ANY($1)`, [created]);
      await pool.query(`DELETE FROM passkeys WHERE id = ANY($1)`, [created]);
    }
    await pool.end();
  });

  /** Enrol `pk` through the real routes from `origin`; returns the session cookie. */
  async function enrol(pk: SoftwarePasskey, origin: string, label: string): Promise<string> {
    const { code } = await store.mintEnrollmentCode(pool);
    const start = await post("/auth/enroll/start", { code }, origin);
    expect(start.status).toBe(200);
    const { options } = (await start.json()) as { options: { challenge: string; rp: { id: string } } };
    expect(options.rp.id).toBe(new URL(origin).hostname); // the rpID is the request's host, not the list's head
    const finish = await post("/auth/enroll/finish", { code, label, response: pk.attest(origin, options.challenge) }, origin);
    expect(finish.status, await finish.clone().text()).toBe(200);
    created.push(pk.id);
    return finish.headers.get("set-cookie")!.split(";")[0]!;
  }

  /** One sign-in attempt from `origin`; `rpID` forges the host the assertion claims (what no browser does). */
  async function signIn(pk: SoftwarePasskey, origin: string, rpID?: string): Promise<Response> {
    const start = await post("/auth/login/start", {}, origin);
    expect(start.status).toBe(200);
    const { key, options } = (await start.json()) as { key: string; options: { challenge: string; rpId: string } };
    expect(options.rpId).toBe(new URL(origin).hostname);
    return post("/auth/login/finish", { key, response: pk.assert(origin, options.challenge, rpID) }, origin);
  }

  it("a passkey created at the second origin records its host, signs in there, and is refused at the first", async () => {
    const pk = new SoftwarePasskey(SECOND_HOST);
    const cookie = await enrol(pk, SECOND, "second-origin phone");
    expect(cookie).toMatch(/^metistry_session=/);

    const row = await pool.query(`SELECT rp_id, rp_origin FROM passkeys WHERE id = $1`, [pk.id]);
    expect(row.rows[0]).toEqual({ rp_id: SECOND_HOST, rp_origin: SECOND }); // 0039: the host it was created for, and the origin as the browser stated it

    const there = await signIn(pk, SECOND);
    expect(there.status).toBe(200);
    expect(there.headers.get("set-cookie")).toMatch(/^metistry_session=/);

    const here = await signIn(pk, FIRST, FIRST_HOST);
    expect(here.status).toBe(401);
    const body = (await here.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("unauthenticated");
    expect(body.error.message).toMatch(/added for assistant\.tailnet\.ts\.net, the browser presented https:\/\/assistant\.example/);
    expect(here.headers.get("set-cookie")).toBeNull();

    const audit = await pool.query(`SELECT ok, meta FROM runs WHERE kind = 'auth' AND tool = 'login' ORDER BY id DESC LIMIT 2`);
    expect(audit.rows.map((r) => r.ok)).toEqual([false, true]);
    expect(audit.rows[0]!.meta.refused).toMatch(/rpID mismatch/);
  });

  it("a passkey created at the first origin signs in there and is refused at the second", async () => {
    const pk = new SoftwarePasskey(FIRST_HOST);
    await enrol(pk, FIRST, "first-origin phone");
    expect((await pool.query(`SELECT rp_id FROM passkeys WHERE id = $1`, [pk.id])).rows[0]!.rp_id).toBe(FIRST_HOST);
    expect((await signIn(pk, FIRST)).status).toBe(200);
    const refused = await signIn(pk, SECOND, SECOND_HOST);
    expect(refused.status).toBe(401);
    expect(((await refused.json()) as any).error.message).toMatch(/added for assistant\.example, the browser presented https:\/\/assistant\.tailnet\.ts\.net/);
  });

  it("an existing passkey with a null rp_id still signs in at the first origin — and only there", async () => {
    const legacy = new SoftwarePasskey(FIRST_HOST);
    await store.storePasskey(pool, { id: legacy.id, publicKey: legacy.publicKey, signCount: 0, transports: ["internal"], origin: FIRST, label: "pre-0039 phone" }); // no rpId: a row from before the migration
    created.push(legacy.id);
    expect((await pool.query(`SELECT rp_id FROM passkeys WHERE id = $1`, [legacy.id])).rows[0]!.rp_id).toBeNull();

    expect((await signIn(legacy, FIRST)).status).toBe(200);
    const refused = await signIn(legacy, SECOND, SECOND_HOST);
    expect(refused.status).toBe(401);
    expect(((await refused.json()) as any).error.message).toMatch(/added for assistant\.example/); // null reads as the first host, never as "any host"
  });

  it("an origin outside the list is refused at both starts, naming both sides, and the ceremonies' challenges are never issued", async () => {
    const { code } = await store.mintEnrollmentCode(pool);
    const enroll = await post("/auth/enroll/start", { code }, "https://evil.example");
    expect(enroll.status).toBe(401);
    expect(((await enroll.json()) as any).error.message).toBe(
      "origin mismatch: this console expects https://assistant.example or https://assistant.tailnet.ts.net, the browser presented https://evil.example — set METISTRY_ORIGIN to the origin you actually load",
    );
    expect(await store.peekEnrollmentCode(pool, code)).toBe(true); // the code is not burned by a refused start

    const login = await post("/auth/login/start", {}, "https://evil.example");
    expect(login.status).toBe(401);
    expect(((await login.json()) as any).error.message).toMatch(/expects https:\/\/assistant\.example or https:\/\/assistant\.tailnet\.ts\.net, the browser presented https:\/\/evil\.example/);

    // the finish refuses an outside origin too, as before X-104
    const pk = new SoftwarePasskey("evil.example");
    const start = await post("/auth/login/start", {}, FIRST);
    const { key, options } = (await start.json()) as { key: string; options: { challenge: string } };
    const finish = await post("/auth/login/finish", { key, response: pk.assert("https://evil.example", options.challenge) }, FIRST);
    expect(finish.status).toBe(401); // no such passkey — uniform, no existence leak
  });

  it("a start with no Origin header is issued the canonical origin's host — the Mac app's enrolment, which performs its ceremony there", async () => {
    const r = await post("/auth/login/start", {});
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).options.rpId).toBe(FIRST_HOST);
    const { code } = await store.mintEnrollmentCode(pool);
    const e = await post("/auth/enroll/start", { code });
    expect(e.status).toBe(200);
    expect(((await e.json()) as any).options.rp.id).toBe(FIRST_HOST);
  });

  describe("GET /api/devices serves each passkey's rp_id", () => {
    it("the recorded host, and the first origin's host for a passkey from before 0039", async () => {
      const second = new SoftwarePasskey(SECOND_HOST);
      await enrol(second, SECOND, "devices-second");
      const legacy = new SoftwarePasskey(FIRST_HOST);
      await store.storePasskey(pool, { id: legacy.id, publicKey: legacy.publicKey, signCount: 0, transports: [], origin: FIRST, label: "devices-legacy" });
      created.push(legacy.id);
      await store.issueSession(pool, legacy.id, policy);

      const r = await fetch(base + "/api/devices", { headers: { authorization: `Bearer ${localOwnerToken}` } });
      expect(r.status).toBe(200);
      const { devices } = (await r.json()) as { devices: { label: string; rp_id: string }[] };
      expect(devices.find((d) => d.label === "devices-second")?.rp_id).toBe(SECOND_HOST);
      expect(devices.find((d) => d.label === "devices-legacy")?.rp_id).toBe(FIRST_HOST); // null resolved server-side: a client never needs the origin list
      for (const d of devices) expect(typeof d.rp_id).toBe("string");
    });

    it("misuse: 401 with no credential, 403 for the capture owner token, the local owner reaches it", async () => {
      expect((await fetch(base + "/api/devices")).status).toBe(401);
      const captureToken = await store.mintOwnerToken(pool, "x-104 capture");
      expect((await fetch(base + "/api/devices", { headers: { authorization: `Bearer ${captureToken}` } })).status).toBe(403);
      expect((await fetch(base + "/api/devices", { headers: { authorization: `Bearer ${localOwnerToken}` } })).status).toBe(200);
    });
  });
});
