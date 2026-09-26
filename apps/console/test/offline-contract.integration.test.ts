// The three server-side pieces the phone's offline design needs
// (docs/ops/console-api.md, research 2026-09-11): a public identity, an
// Idempotency-Key on capture that returns the ORIGINAL row on replay, and
// `since` cursors on the polled lists so a reconnect is one bounded pull.
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { mintToken } from "@foldedspacelabs/metistry-core";
import { makeServer } from "../src/server.js";
import { parsePublicIdentity } from "../src/identity.js";
import * as store from "../src/auth-store.js";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url)); // METISTRY_DB_* only, and nothing of the operator's install (docs/ops/testing.md)
const policy = { idleDays: 30, maxDays: 365 };

describe("identity.yaml → public identity", () => {
  it("serves name, icon and instance_id only — voice and mention stay home", () => {
    const id = parsePublicIdentity("name: Metis\nmention: '@metis'\nicon: 🦉\ninstance_id: 8b6a3a2e-1111-4222-8333-444455556666\nvoice: >\n  terse\n");
    expect(id).toEqual({ instance_id: "8b6a3a2e-1111-4222-8333-444455556666", name: "Metis", icon: "🦉" });
  });
  it("is absent without an instance_id (an un-inited instance is not addressable) or a name", () => {
    expect(parsePublicIdentity("name: Metis\n")).toBeUndefined();
    expect(parsePublicIdentity("instance_id: x\n")).toBeUndefined();
    expect(parsePublicIdentity("")).toBeUndefined();
  });
});

describe.skipIf(!hasDb)("offline contract (integration)", () => {
  let pool: pg.Pool;
  let base: string;
  let server: ReturnType<typeof makeServer>;
  let cookie: string;
  let ownerToken: string;
  const json = { "content-type": "application/json" };

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
    server = makeServer(pool, new QueryStore(pool), {
      origin: "http://127.0.0.1:0",
      inboxDir: `/tmp/metistry-test-inbox-offline-${Date.now()}`,
      policy,
      secureCookies: false,
      identity: { instance_id: "8b6a3a2e-1111-4222-8333-444455556666", name: "Metis", icon: null },
      version: "0.0.0-test",
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const pkId = `off-${mintToken(8)}`;
    await store.storePasskey(pool, { id: pkId, publicKey: new Uint8Array([1]), signCount: 0, transports: [], origin: "t", label: "off" });
    cookie = `metistry_session=${await store.issueSession(pool, pkId, policy)}`;
    ownerToken = await store.mintOwnerToken(pool, "off");
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await pool.end();
  });

  it("GET /api/identity is public and says nothing but who the instance is and which coarse groups it has", async () => {
    const r = await fetch(`${base}/api/identity`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toMatchObject({ instance_id: "8b6a3a2e-1111-4222-8333-444455556666", name: "Metis", icon: null, version: "0.0.0-test" });
    // `capabilities` (S1) — coarse tool GROUP names, never a tool name and never
    // a count — and `api_version` (F-1) are the only fields this read has taken
    // since (docs/ops/client-api.md).
    expect(Object.keys(body).sort()).toEqual(["api_version", "as_of", "capabilities", "icon", "instance_id", "name", "version"]);
    expect(body.capabilities).toEqual(["capture", "tasks"]); // this server wires nothing else
  });

  it("GET /api/identity is 503 not_available when the instance has no identity", async () => {
    const bare = makeServer(pool, new QueryStore(pool), { origin: "http://127.0.0.1:0", inboxDir: "/tmp/x", policy, secureCookies: false });
    await new Promise<void>((r) => bare.listen(0, "127.0.0.1", r));
    const r = await fetch(`http://127.0.0.1:${(bare.address() as AddressInfo).port}/api/identity`);
    expect(r.status).toBe(503);
    await new Promise<void>((r) => bare.close(() => r()));
  });

  it("a replayed Idempotency-Key on /capture returns the original row, one file, one inbox row", async () => {
    const key = mintToken(8);
    const send = () =>
      fetch(`${base}/capture`, { method: "POST", headers: { authorization: `Bearer ${ownerToken}`, "idempotency-key": key, ...json }, body: JSON.stringify({ note: "same note" }) });
    const a = await send();
    expect(a.status).toBe(201);
    expect(a.headers.get("idempotency-replayed")).toBeNull();
    const first = await a.json();
    const b = await send();
    expect(b.status).toBe(201);
    expect(b.headers.get("idempotency-replayed")).toBe("true");
    expect(await b.json()).toEqual(first);
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM inbox WHERE idempotency_key = $1`, [key]);
    expect(rows[0].n).toBe(1);
  });

  it("two attempts racing on the same key still land one row", async () => {
    const key = mintToken(8);
    const send = () =>
      fetch(`${base}/capture`, { method: "POST", headers: { cookie, "idempotency-key": key, ...json }, body: JSON.stringify({ note: "raced" }) });
    const results = await Promise.all([send(), send(), send()]);
    const bodies = await Promise.all(results.map((r) => r.json()));
    expect(results.map((r) => r.status)).toEqual([201, 201, 201]);
    expect(new Set(bodies.map((b) => b.id)).size).toBe(1);
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM inbox WHERE idempotency_key = $1`, [key]);
    expect(rows[0].n).toBe(1);
  });

  it("the key is scoped to the credential class: the same key from an owner token and the session are two rows", async () => {
    const key = mintToken(8);
    const a = await fetch(`${base}/capture`, { method: "POST", headers: { authorization: `Bearer ${ownerToken}`, "idempotency-key": key, ...json }, body: JSON.stringify({ note: "a" }) });
    const b = await fetch(`${base}/capture`, { method: "POST", headers: { cookie, "idempotency-key": key, ...json }, body: JSON.stringify({ note: "b" }) });
    expect((await a.json()).id).not.toBe((await b.json()).id);
  });

  it("no key means no dedupe (today's Shortcut is unchanged); an empty or oversized key is a 400", async () => {
    const send = (headers: Record<string, string>) =>
      fetch(`${base}/capture`, { method: "POST", headers: { cookie, ...headers, ...json }, body: JSON.stringify({ note: "plain" }) });
    const a = await send({});
    const b = await send({});
    expect((await a.json()).id).not.toBe((await b.json()).id);
    expect((await send({ "idempotency-key": "" })).status).toBe(400);
    expect((await send({ "idempotency-key": "k".repeat(201) })).status).toBe(400);
  });

  it("GET /api/messages?since= replays forward from a cursor, and a rating moves the row", async () => {
    const thread = `cur-${mintToken(4)}`;
    const head = await (await fetch(`${base}/api/messages?limit=1`, { headers: { cookie } })).json();
    expect(head).toHaveProperty("cursor");
    expect(typeof head.more).toBe("boolean");
    const cursor0: string = head.cursor ?? "1970-01-01 00:00:00+00|in|0";
    const ins = await pool.query(`INSERT INTO outbound_messages (thread, text, kind) VALUES ($1, 'first', 'reply'), ($1, 'second', 'reply') RETURNING id`, [thread]);
    // page forward one row at a time (other test files write concurrently, so only OUR thread is asserted on)
    const mine: string[] = [];
    let cursor = cursor0;
    let more = true;
    let sawMore = false;
    while (more) {
      const page = await (await fetch(`${base}/api/messages?since=${encodeURIComponent(cursor)}&limit=1`, { headers: { cookie } })).json();
      expect(page.messages.length).toBeLessThanOrEqual(1);
      for (const m of page.messages) if (m.thread === thread) mine.push(m.text);
      if (page.more) sawMore = true;
      more = page.more;
      cursor = page.cursor;
    }
    expect(mine).toEqual(["first", "second"]); // oldest first, both rows despite sharing one now()
    expect(sawMore).toBe(true);
    const empty = await (await fetch(`${base}/api/messages?since=${encodeURIComponent(cursor)}`, { headers: { cookie } })).json();
    expect(empty.messages.filter((m: { thread: string }) => m.thread === thread)).toEqual([]);
    if (empty.messages.length === 0) expect(empty.cursor).toBe(cursor); // nothing new: the caller keeps its cursor
    const cursorBeforeRating = empty.cursor;
    // a 👍 from another device resurfaces the first row on the next pull
    await fetch(`${base}/api/messages/${ins.rows[0].id}/feedback`, { method: "POST", headers: { cookie, ...json }, body: JSON.stringify({ rating: 1 }) });
    const after = await (await fetch(`${base}/api/messages?since=${encodeURIComponent(cursorBeforeRating)}`, { headers: { cookie } })).json();
    expect(after.messages.filter((m: { thread: string }) => m.thread === thread).map((m: { text: string; feedback: { rating: number } }) => [m.text, m.feedback?.rating])).toEqual([["first", 1]]);
    // a junk cursor is a 400, not a silent full repaint
    expect((await fetch(`${base}/api/messages?since=yesterday`, { headers: { cookie } })).status).toBe(400);
  });

  it("GET /api/proposals?since= returns new rows AND rows decided since, with their decision", async () => {
    const head = await (await fetch(`${base}/api/proposals?limit=1`, { headers: { cookie } })).json();
    const cursor0: string = head.cursor ?? "1970-01-01 00:00:00+00|0";
    const { rows } = await pool.query(`INSERT INTO proposals (kind, source_agent, trust, payload) VALUES ('knowledge','test','user','{}') RETURNING id`);
    const id = rows[0].id;
    const fresh = await (await fetch(`${base}/api/proposals?since=${encodeURIComponent(cursor0)}`, { headers: { cookie } })).json();
    expect(fresh.proposals.map((p: { id: number; decision: string }) => [p.id, p.decision])).toContainEqual([id, "pending"]);
    // decided (from "another device") after the cursor: it comes back again, settled
    expect((await fetch(`${base}/api/proposals/${id}`, { method: "POST", headers: { cookie, ...json }, body: JSON.stringify({ decision: "deny" }) })).status).toBe(200);
    const settled = await (await fetch(`${base}/api/proposals?since=${encodeURIComponent(fresh.cursor)}`, { headers: { cookie } })).json();
    expect(settled.proposals.filter((p: { id: number }) => p.id === id).map((p: { decision: string }) => p.decision)).toEqual(["deny"]);
    expect((await fetch(`${base}/api/proposals?since=nope`, { headers: { cookie } })).status).toBe(400);
    // the plain queue is still pending-only
    const queue = await (await fetch(`${base}/api/proposals`, { headers: { cookie } })).json();
    expect(queue.proposals.find((p: { id: number }) => p.id === id)).toBeUndefined();
  });
});
