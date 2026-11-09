// *Opened on your phone* (plan §2.23 step 7, X-114; migration 0040) at the
// console's door, over real sockets against the scratch database
// (docs/ops/testing.md). `POST /auth/enroll/start` with a LIVE code stamps
// `auth_enrollment_codes.opened_at` / `opened_via`, and the stamp names the
// listener that answered. The ticket's own tests:
//
//   * a start through the proxy listener stamps `proxy`;
//   * a start on the main listener stamps `main` — which the sheet never shows
//     as *Opened on your phone* (core's `enrollmentStatus` is what it reads);
//   * stamping does not consume the code: it is still live, still single-use,
//     still dies when it would have;
//   * an unknown code stamps nothing — and neither does a used, expired or
//     cancelled one.
//
// `start` is a public ceremony door, not a new route: its 401-with-no-credential
// answer is the code check itself (an unknown code is the same uniform 401 as a
// wrong one), and the proxy listener's toll and Host rule already cover it
// (proxy-limits / proxy-listener suites). This file adds what the stamp does.
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { enrollmentStatus, mintToken } from "@foldedspacelabs/metistry-core";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";
import { makeServer, type ConsoleServer } from "../src/server.js";
import * as store from "../src/auth-store.js";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url));
const policy = { idleDays: 30, maxDays: 365 };
/** The host a provider would carry — METISTRY_ORIGIN's first entry once one is chosen (§2.23). */
const REMOTE_HOST = "studio.tail1234.ts.net";

interface Answer {
  status: number;
  text: string;
}

/** node:http, because the proxy listener answers only for the remote Host and fetch is not ours to set it on. */
function start(port: number, code: string, host: string): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ code });
    const req = httpRequest(
      { host: "127.0.0.1", port, method: "POST", path: "/auth/enroll/start", setHost: false, headers: { host, "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

describe.skipIf(!hasDb)("Opened on your phone: the console stamps which listener the phone's start arrived on", () => {
  let pool: pg.Pool;
  let server: ConsoleServer;
  let proxyServer: ReturnType<ConsoleServer["proxyListener"]>;
  let mainPort: number;
  let proxyPort: number;
  const minted: number[] = [];

  const mint = async () => {
    const m = await store.mintEnrollmentCode(pool);
    minted.push(m.code_id);
    return m;
  };
  const viaProxy = (code: string) => start(proxyPort, code, REMOTE_HOST);
  const viaMain = (code: string) => start(mainPort, code, "127.0.0.1");
  const row = async (id: number) => (await pool.query(`SELECT used_at, expires_at, opened_at, opened_via FROM auth_enrollment_codes WHERE id = $1`, [id])).rows[0];
  const openedRows = async (since: number) =>
    (await pool.query(`SELECT meta FROM runs WHERE component = 'console' AND kind = 'auth' AND tool = 'enroll_opened' AND id > $1 ORDER BY id`, [since])).rows.map((r) => r.meta as Record<string, unknown>);
  const sinceNow = async () => Number((await pool.query(`SELECT coalesce(max(id), 0) AS id FROM runs`)).rows[0].id);

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
    const queries = new QueryStore(pool);
    server = makeServer(pool, queries, { origin: "http://127.0.0.1:0", origins: `https://${REMOTE_HOST},http://127.0.0.1:0`, inboxDir: "/nonexistent-inbox", policy, secureCookies: false });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    mainPort = (server.address() as AddressInfo).port;
    proxyServer = server.proxyListener();
    await new Promise<void>((r) => proxyServer.listen(0, "127.0.0.1", r));
    proxyPort = (proxyServer.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM auth_enrollment_codes WHERE id = ANY($1)`, [minted]);
    for (const s of [proxyServer, server]) await new Promise<void>((r) => s.close(() => r()));
    await pool.end();
  });

  it("**a start through the proxy listener stamps `proxy`**, once, in the audit trail — which names the row and never the code", async () => {
    const since = await sinceNow();
    const m = await mint();
    expect((await row(m.code_id)).opened_via).toBeNull();
    const first = await viaProxy(m.code);
    expect(first.status).toBe(200); // the ceremony itself still answers
    const stamped = await row(m.code_id);
    expect(stamped.opened_via).toBe("proxy");
    expect(stamped.opened_at).toBeInstanceOf(Date);
    expect(await enrollmentStatus(pool, m.code_id)).toMatchObject({ code_id: m.code_id, state: "live", opened_via: "proxy" });

    // a second start (the phone retried) changes nothing and is not audited again
    const at = stamped.opened_at as Date;
    expect((await viaProxy(m.code)).status).toBe(200);
    expect((await row(m.code_id)).opened_at).toEqual(at);
    const audited = await openedRows(since);
    expect(audited.filter((a) => a.code_id === m.code_id)).toEqual([{ code_id: m.code_id, listener: "proxy" }]);
    expect(JSON.stringify(audited)).not.toContain(m.code);
  });

  it("**a start on the main listener stamps `main`** and never reads as proxy — and `proxy` then replaces it, but `main` never replaces `proxy`", async () => {
    const m = await mint();
    expect((await viaMain(m.code)).status).toBe(200);
    expect(await enrollmentStatus(pool, m.code_id)).toMatchObject({ state: "live", opened_via: "main" });

    // the owner opened the link on this Mac first; the phone arriving still shows
    expect((await viaProxy(m.code)).status).toBe(200);
    expect((await enrollmentStatus(pool, m.code_id))?.opened_via).toBe("proxy");

    // …and a later request on the main listener cannot take that proof away
    const at = (await row(m.code_id)).opened_at as Date;
    expect((await viaMain(m.code)).status).toBe(200);
    const after = await row(m.code_id);
    expect(after.opened_via).toBe("proxy");
    expect(after.opened_at).toEqual(at);
  });

  it("**stamping does not consume the code**: still live, still unused, the expiry unmoved, and it still spends exactly once", async () => {
    const m = await mint();
    const before = await row(m.code_id);
    await viaProxy(m.code);
    await viaMain(m.code);
    const after = await row(m.code_id);
    expect(after.used_at).toBeNull();
    expect(after.expires_at).toEqual(before.expires_at);
    expect(await store.peekEnrollmentCode(pool, m.code)).toBe(true);
    expect(await store.consumeEnrollmentCode(pool, m.code)).toBe(true);
    expect(await store.consumeEnrollmentCode(pool, m.code)).toBe(false); // still single-use
    expect(await enrollmentStatus(pool, m.code_id)).toMatchObject({ state: "used", opened_via: "proxy" });
  });

  it("**an unknown code stamps nothing** — the same uniform 401, no row touched, nothing audited", async () => {
    const since = await sinceNow();
    const stampsBefore = Number((await pool.query(`SELECT count(*)::int AS n FROM auth_enrollment_codes WHERE opened_at IS NOT NULL`)).rows[0].n);
    for (const code of [mintToken(16), "", "x"]) {
      for (const go of [viaProxy, viaMain]) {
        const a = await go(code);
        expect(a.status).toBe(401);
        expect(JSON.parse(a.text)).toEqual({ error: { code: "unauthenticated", message: "authentication required" } });
      }
    }
    expect(Number((await pool.query(`SELECT count(*)::int AS n FROM auth_enrollment_codes WHERE opened_at IS NOT NULL`)).rows[0].n)).toBe(stampsBefore);
    expect(await openedRows(since)).toEqual([]);
  });

  it("a used, an expired and a cancelled code are not live, so they stamp nothing either", async () => {
    const used = await mint();
    await store.consumeEnrollmentCode(pool, used.code);
    const expired = await mint();
    await pool.query(`UPDATE auth_enrollment_codes SET expires_at = now() - interval '1 second' WHERE id = $1`, [expired.code_id]);
    const cancelled = await mint();
    await store.cancelEnrollmentCode(pool, cancelled.code_id);
    for (const m of [used, expired, cancelled]) {
      expect((await viaProxy(m.code)).status).toBe(401);
      const r = await row(m.code_id);
      expect([r.opened_at, r.opened_via]).toEqual([null, null]);
    }
    expect((await enrollmentStatus(pool, used.code_id))?.state).toBe("used");
    expect((await enrollmentStatus(pool, expired.code_id))?.state).toBe("expired");
    expect((await enrollmentStatus(pool, cancelled.code_id))?.state).toBe("expired");
    expect(await enrollmentStatus(pool, 2 ** 40)).toBeUndefined(); // an id that never existed
  });
});
