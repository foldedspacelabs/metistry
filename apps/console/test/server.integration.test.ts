// Integration + misuse tests against the real database and a live server
// on an ephemeral port. Skipped when no db is configured (CI provides one;
// locally `.env` does).
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { networkInterfaces } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { mintToken } from "@foldedspacelabs/metistry-core";
import { makeServer } from "../src/server.js";
import * as store from "../src/auth-store.js";
import { loadTestEnv } from "@foldedspacelabs/metistry-core/test-env";

// load ../.env for local runs
const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url)); // METISTRY_DB_* only, and nothing of the operator's install (docs/ops/testing.md)
const policy = { idleDays: 30, maxDays: 365 };

describe.skipIf(!hasDb)("console server (integration)", () => {
  let pool: pg.Pool;
  let base: string;
  let server: ReturnType<typeof makeServer>;
  let queries: QueryStore;
  let sessionCookie: string;
  let ownerToken: string;
  // METISTRY_LOCAL_OWNER_TOKEN: an env value, not a database row — minted here the
  // way `metistry init` mints it, and never registered in `owner_tokens`.
  const localOwnerToken = mintToken();

  beforeAll(async () => {
    pool = new pg.Pool({
      host: process.env.METISTRY_DB_HOST ?? "127.0.0.1",
      user: process.env.METISTRY_DB_USER ?? "metistry",
      database: process.env.METISTRY_TEST_DB_NAME ?? "metistry_test", // scratch db (ops/scripts/test-db.sh)
      password: process.env.METISTRY_DB_PASSWORD,
    });
    queries = new QueryStore(pool);
    queries.load(`
name: open_work
description: test
params:
  limit: { type: int, default: 5 }
sql: SELECT id, title FROM work WHERE status <> 'closed' ORDER BY updated_at DESC LIMIT :limit
`);
    const { loadRules } = await import("../src/router.js");
    server = makeServer(pool, queries, {
      origin: "http://127.0.0.1:0",
      inboxDir: `/tmp/metistry-test-inbox-${Date.now()}`,
      policy,
      secureCookies: false,
      rules: loadRules(readFileSync(new URL("../../../seed/rules.yaml", import.meta.url), "utf8")),
      localOwner: { token: localOwnerToken, trusted: [] }, // loopback only, as on the launchd shape
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

  // ----- the local owner token (docs/ops/auth.md) -----
  // The unit-level misuse matrix lives in test/local-owner.test.ts, where a
  // peer address can be fabricated. These are the same rules over real
  // sockets, plus what the token is actually GRANTED.
  it("METISTRY_LOCAL_OWNER_TOKEN over loopback is the `user` principal — the same one a passkey session yields", async () => {
    const auth = { authorization: `Bearer ${localOwnerToken}` };

    const who = await fetch(`${base}/api/whoami`, { headers: auth });
    expect(who.status).toBe(200);
    expect(await who.json()).toMatchObject({ principal: "user", via: "local_owner_token", management: true });

    // management: what a capture owner token is forbidden on, this may do
    const devices = await fetch(`${base}/api/devices`, { headers: auth });
    expect(devices.status).toBe(200);
    expect(Array.isArray((await devices.json()).devices)).toBe(true);
    expect((await fetch(`${base}/api/agents`, { headers: auth })).status).toBe(200);
    expect((await fetch(`${base}/api/proposals`, { headers: auth })).status).toBe(200);
    expect((await fetch(`${base}/api/targets`, { headers: auth })).status).toBe(200);

    // …and the agent/capture surface still works, so nothing regressed
    const cap = await fetch(`${base}/capture`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ note: "from the mac app" }),
    });
    expect(cap.status).toBe(201);
  });

  it("a passkey session and the local owner token answer whoami as the same principal, by different means", async () => {
    const viaSession = await (await fetch(`${base}/api/whoami`, { headers: { cookie: sessionCookie } })).json();
    expect(viaSession).toMatchObject({ principal: "user", via: "passkey_session", management: true });
    // a host-minted capture token is in the owner CLASS but is not that principal
    const viaShortcut = await (await fetch(`${base}/api/whoami`, { headers: { authorization: `Bearer ${ownerToken}` } })).json();
    expect(viaShortcut).toMatchObject({ principal: "owner_token", via: "owner_token", management: false });
  });

  it("has no session to log out of, and cannot subscribe a device to push", async () => {
    const auth = { authorization: `Bearer ${localOwnerToken}` };
    expect((await fetch(`${base}/auth/logout`, { method: "POST", headers: auth })).status).toBe(403);
    expect((await fetch(`${base}/api/push/vapid-key`, { headers: auth })).status).toBe(403);
  });

  it("is refused from a non-loopback address, indistinguishably from an unknown token", async () => {
    // A second server on 0.0.0.0, reached over one of this host's real
    // interfaces: the peer address is genuinely not loopback.
    const external = Object.values(networkInterfaces())
      .flatMap((a) => a ?? [])
      .find((a) => a.family === "IPv4" && !a.internal)?.address;
    if (!external) return; // no non-loopback interface here (some CI sandboxes)

    const exposed = makeServer(pool, queries, {
      origin: "http://127.0.0.1:0",
      inboxDir: `/tmp/metistry-test-inbox-${Date.now()}`,
      policy,
      secureCookies: false,
      localOwner: { token: localOwnerToken, trusted: [] },
    });
    await new Promise<void>((r) => exposed.listen(0, "0.0.0.0", r));
    const remote = `http://${external}:${(exposed.address() as AddressInfo).port}`;
    try {
      const unknown = await fetch(`${remote}/api/status`, { headers: { authorization: `Bearer ${mintToken()}` } });
      const stolen = await fetch(`${remote}/api/status`, { headers: { authorization: `Bearer ${localOwnerToken}` } });
      // X-Forwarded-For is the caller's to write, and buys nothing
      const spoofed = await fetch(`${remote}/api/status`, {
        headers: { authorization: `Bearer ${localOwnerToken}`, "x-forwarded-for": "127.0.0.1", "x-real-ip": "127.0.0.1" },
      });
      for (const r of [unknown, stolen, spoofed]) expect(r.status).toBe(401);
      const bodies = await Promise.all([unknown.json(), stolen.json(), spoofed.json()]);
      expect(bodies[1]).toEqual(bodies[0]); // byte-identical to an unknown token
      expect(bodies[2]).toEqual(bodies[0]);

      // the refusal IS recorded, even though the caller is told nothing
      const { rows } = await pool.query(
        `SELECT meta FROM runs WHERE component = 'console' AND kind = 'auth' AND tool = 'owner_token_remote' ORDER BY id DESC LIMIT 2`,
      );
      expect(rows.length).toBe(2);
      expect(String(rows[0].meta.remote)).not.toMatch(/^(127\.0\.0\.1|::1)$/);

      // …and the same server still opens for loopback, so the rule is the
      // address and not the server
      const local = await fetch(`http://127.0.0.1:${(exposed.address() as AddressInfo).port}/api/whoami`, {
        headers: { authorization: `Bearer ${localOwnerToken}` },
      });
      expect(local.status).toBe(200);
    } finally {
      await new Promise<void>((r) => exposed.close(() => r()));
    }
  });

  it("a wrong token from loopback is the same 401 as no token at all", async () => {
    const wrong = await fetch(`${base}/api/status`, { headers: { authorization: `Bearer ${mintToken()}` } });
    const none = await fetch(`${base}/api/status`);
    expect(wrong.status).toBe(401);
    expect(none.status).toBe(401);
    expect(await wrong.json()).toEqual(await none.json());
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

  // Tiers are (model, effort) pairs; `tier` on the body is the composer's
  // picker. The row carries the resolved pair, and /api/messages surfaces the
  // NAME so the thread can chip it.
  it("POST /message takes a `tier`, records the resolved (model, effort) on the row, and /api/messages returns the tier name", async () => {
    const post = (body: unknown) =>
      fetch(`${base}/message`, { method: "POST", headers: { cookie: sessionCookie, "content-type": "application/json" }, body: JSON.stringify(body) });

    const deep = await (await post({ text: "think about the roadmap", tier: "deep" })).json();
    const chosen = await pool.query(`SELECT meta->'route' AS route FROM inbound_messages WHERE id = $1`, [deep.message_id]);
    expect(chosen.rows[0].route).toMatchObject({ kind: "model", tier: "deep", model: "opus", effort: "high", routed_by: "override" });

    // an unknown tier is ignored, never invented
    const bogus = await (await post({ text: "and this", tier: "gpt99" })).json();
    const fell = await pool.query(`SELECT meta->'route' AS route FROM inbound_messages WHERE id = $1`, [bogus.message_id]);
    expect(fell.rows[0].route).toMatchObject({ tier: "default", model: "haiku", effort: "medium", routed_by: "rule" });

    const list = await (await fetch(`${base}/api/messages?limit=50`, { headers: { cookie: sessionCookie } })).json();
    expect(list.messages.find((m: any) => m.direction === "in" && Number(m.id) === Number(deep.message_id)).tier).toBe("deep");
  });

  // Cost research decision 3: answering a blocking decision is a task
  // boundary, so the thread's session rolls and the answering turn starts fresh.
  it("answering a `decision` rolls the thread's session and logs a session_roll run", async () => {
    const thread = `roll-${mintToken(6)}`;
    const session = randomUUID();
    await pool.query(`INSERT INTO sessions (id, thread, turns) VALUES ($1, $2, 9)`, [session, thread]);
    await pool.query(
      `INSERT INTO proposals (kind, source_agent, trust, payload) VALUES ('decision', 'assistant', 'internal', $1)`,
      [JSON.stringify({ title: "Which repo?", options: ["a", "b"], thread })],
    );

    const r = await fetch(`${base}/message`, {
      method: "POST",
      headers: { cookie: sessionCookie, "content-type": "application/json" },
      body: JSON.stringify({ thread_id: thread, text: "b, please" }),
    });
    expect(r.status).toBe(202);

    expect((await pool.query(`SELECT status FROM sessions WHERE id = $1`, [session])).rows[0].status).toBe("rolled");
    const roll = await pool.query(
      `SELECT session_id, meta->>'reason' AS reason, (meta->>'turns')::int AS turns FROM runs WHERE kind = 'session_roll' AND meta->>'thread' = $1`,
      [thread],
    );
    expect(roll.rows).toHaveLength(1);
    expect(roll.rows[0]).toMatchObject({ session_id: session, reason: "decision_answered", turns: 9 });

    // idempotent: nothing active left, so a second answer rolls nothing more
    await fetch(`${base}/message`, {
      method: "POST",
      headers: { cookie: sessionCookie, "content-type": "application/json" },
      body: JSON.stringify({ thread_id: thread, text: "still b" }),
    });
    expect((await pool.query(`SELECT count(*)::int AS n FROM runs WHERE kind = 'session_roll' AND meta->>'thread' = $1`, [thread])).rows[0].n).toBe(1);
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

  it("/note goes straight to inbox with an instant ack — no model", async () => {
    // earlier revoke test killed the shared session; mint a fresh one
    const pkId = `note-${mintToken(6)}`;
    await store.storePasskey(pool, { id: pkId, publicKey: new Uint8Array([1]), signCount: 0, transports: [], origin: "t", label: "note-test" });
    const fresh = `metistry_session=${await store.issueSession(pool, pkId, policy)}`;
    const r = await fetch(`${base}/message`, {
      method: "POST",
      headers: { cookie: fresh, "content-type": "application/json" },
      body: JSON.stringify({ text: "/note try the new espresso place" }),
    });
    expect(r.status).toBe(202);
    const { reply, message_id } = await r.json();
    expect(reply).toMatch(/noted → inbox #\d+/);
    const inb = await pool.query(`SELECT status FROM inbound_messages WHERE id = $1`, [message_id]);
    expect(inb.rows[0].status).toBe("done"); // assistant never sees it
    const box = await pool.query(`SELECT note, status FROM inbox WHERE source='note' ORDER BY id DESC LIMIT 1`);
    expect(box.rows[0]).toMatchObject({ note: "try the new espresso place", status: "new" });
  });

  it("triage is session-only, decides once, and refuses junk decisions", async () => {
    const { rows } = await pool.query(
      `INSERT INTO proposals (kind, source_agent, trust, payload) VALUES ('knowledge','test','user','{}') RETURNING id`,
    );
    const id = rows[0].id;
    // owner token forbidden (CRIT-7: triage is a management action)
    expect((await fetch(`${base}/api/proposals`, { headers: { authorization: `Bearer ${ownerToken}` } })).status).toBe(403);
    const pkId = `tri-${mintToken(6)}`;
    await store.storePasskey(pool, { id: pkId, publicKey: new Uint8Array([1]), signCount: 0, transports: [], origin: "t", label: "tri" });
    const cookie = `metistry_session=${await store.issueSession(pool, pkId, policy)}`;
    expect((await fetch(`${base}/api/proposals/${id}`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ decision: "yolo" }) })).status).toBe(400);
    expect((await fetch(`${base}/api/proposals/${id}`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ decision: "allow" }) })).status).toBe(200);
    // already decided → 409 with the winner (no re-triage; docs/ops/console-api.md)
    const again = await fetch(`${base}/api/proposals/${id}`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ decision: "deny" }) });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: { code: "conflict" }, decision: "allow" });
    // unknown stays 404
    expect((await fetch(`${base}/api/proposals/999999999`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ decision: "deny" }) })).status).toBe(404);
    const after = await pool.query(`SELECT decision FROM proposals WHERE id = $1`, [id]);
    expect(after.rows[0].decision).toBe("allow");
  });

  it("enrollment codes are single-use and expiring", async () => {
    const code = await store.mintEnrollmentCode(pool);
    expect(await store.peekEnrollmentCode(pool, code)).toBe(true);
    expect(await store.consumeEnrollmentCode(pool, code)).toBe(true);
    expect(await store.consumeEnrollmentCode(pool, code)).toBe(false); // burned
    expect(await store.peekEnrollmentCode(pool, "wrong")).toBe(false);
  });
});
