// PWA-chunk integration: static serving (traversal-safe), push endpoint
// authz, message listing. Skipped without a db (CI provides one).
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { mintToken } from "@foldedspacelabs/metistry-core";
import { makeServer } from "../src/server.js";
import * as store from "../src/auth-store.js";

try {
  for (const line of readFileSync(new URL("../../../.env", import.meta.url), "utf8").split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m && m[1] && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {}

const hasDb = !!process.env.METISTRY_DB_PASSWORD;

describe.skipIf(!hasDb)("console PWA chunk", () => {
  let pool: pg.Pool;
  let base: string;
  let server: ReturnType<typeof makeServer>;
  let sessionCookie: string;
  let ownerToken: string;

  beforeAll(async () => {
    pool = new pg.Pool({
      host: process.env.METISTRY_DB_HOST ?? "127.0.0.1",
      user: process.env.METISTRY_DB_USER ?? "metistry",
      database: process.env.METISTRY_TEST_DB_NAME ?? "metistry_test", // scratch db (ops/scripts/test-db.sh)
      password: process.env.METISTRY_DB_PASSWORD,
    });
    server = makeServer(pool, new QueryStore(pool), {
      origin: "http://127.0.0.1:0",
      inboxDir: `/tmp/metistry-test-inbox-${Date.now()}`,
      policy: { idleDays: 30, maxDays: 365 },
      secureCookies: false,
      webRoot: fileURLToPath(new URL("../web", import.meta.url)),
      push: { publicKey: "test", privateKey: "test", subject: "mailto:test@example.com" },
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const pkId = `pwa-${mintToken(8)}`;
    await store.storePasskey(pool, { id: pkId, publicKey: new Uint8Array([1]), signCount: 0, transports: [], origin: "t", label: "pwa-test" });
    sessionCookie = `metistry_session=${await store.issueSession(pool, pkId, { idleDays: 30, maxDays: 365 })}`;
    ownerToken = await store.mintOwnerToken(pool, "pwa-test");
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await pool.end();
  });

  it("serves the shell unauthenticated (login page must render)", async () => {
    const r = await fetch(base + "/");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    expect(await r.text()).toContain("sign in with passkey");
    expect((await fetch(base + "/sw.js")).status).toBe(200);
    expect((await fetch(base + "/vendor/simplewebauthn.js")).status).toBe(200);
  });

  it("static serving refuses traversal and unknown files (falls to auth wall)", async () => {
    const t = await fetch(base + "/..%2f..%2f.env");
    expect(t.status).toBe(401); // never 200, no file content
    expect(await t.text()).not.toContain("PASSWORD");
    expect((await fetch(base + "/nope.js")).status).toBe(401);
  });

  it("push endpoints: session-only (owner token forbidden), subscribe stores on the session", async () => {
    expect((await fetch(`${base}/api/push/vapid-key`, { headers: { authorization: `Bearer ${ownerToken}` } })).status).toBe(403);
    const sub = { endpoint: `https://push.example/${Date.now()}`, keys: { p256dh: "a", auth: "b" } };
    const r = await fetch(`${base}/api/push/subscribe`, {
      method: "POST",
      headers: { cookie: sessionCookie, "content-type": "application/json" },
      body: JSON.stringify({ subscription: sub }),
    });
    expect(r.status).toBe(200);
    const { rows } = await pool.query(
      `SELECT push_subscription FROM auth_sessions WHERE push_subscription->>'endpoint' = $1`,
      [sub.endpoint],
    );
    expect(rows.length).toBe(1);
  });

  it("lists inbound messages for the thread view", async () => {
    await fetch(`${base}/message`, {
      method: "POST",
      headers: { cookie: sessionCookie, "content-type": "application/json" },
      body: JSON.stringify({ text: "pwa test msg" }),
    });
    const r = await fetch(`${base}/api/messages?limit=5`, { headers: { cookie: sessionCookie } });
    const { messages } = await r.json();
    expect(messages.some((m: any) => m.text === "pwa test msg")).toBe(true);
  });
});
