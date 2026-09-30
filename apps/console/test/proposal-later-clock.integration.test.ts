// The `later` verb's `snoozed_until` follows an injected clock (X-31), the
// same way #451 found for `audit()`'s rows: `POST /api/proposals/batch`
// hands `results[].snoozed_until` straight back in its response body, so a
// console left to stamp it with Postgres's wall clock (`now() + interval`)
// left the fixture recorder's `post-api-proposals-batch.json` moving on
// every re-record even though RECORDING_NOW never does. `cfg.now` absent
// (every real install) leaves the wall clock exactly as before.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { mintToken } from "@foldedspacelabs/metistry-core";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";
import { makeServer } from "../src/server.js";
import * as store from "../src/auth-store.js";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url)); // METISTRY_DB_* only (docs/ops/testing.md)
const policy = { idleDays: 30, maxDays: 365 };
const INJECTED_NOW = new Date("2026-01-01T00:00:00.000Z");

describe.skipIf(!hasDb)("later's snoozed_until follows an injected clock (X-31)", () => {
  let pool: pg.Pool;
  let dir: string;

  async function propose(): Promise<number> {
    const { rows } = await pool.query(
      `INSERT INTO proposals (kind, source_agent, trust, payload) VALUES ('report', 'clock-test', 'internal', '{"title":"snooze me"}'::jsonb) RETURNING id`,
    );
    return Number(rows[0].id);
  }

  async function startServer(now?: () => Date) {
    const server = makeServer(pool, new QueryStore(pool), {
      origin: "http://127.0.0.1:0",
      inboxDir: join(dir, `inbox-${mintToken(6)}`),
      policy,
      secureCookies: false,
      ...(now ? { now } : {}),
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const pkId = `clock-${mintToken(8)}`;
    await store.storePasskey(pool, { id: pkId, publicKey: new Uint8Array([1]), signCount: 0, transports: [], origin: "t", label: "clock-test" });
    const cookie = `metistry_session=${await store.issueSession(pool, pkId, policy)}`;
    return { server, base, cookie };
  }

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
    dir = await mkdtemp(join(tmpdir(), "metistry-clock-"));
  });

  afterAll(async () => {
    await pool.end();
    await rm(dir, { recursive: true, force: true });
  });

  it("with cfg.now set, snoozed_until is exactly the injected clock plus the snooze window — not the wall clock's", async () => {
    const { server, base, cookie } = await startServer(() => new Date(INJECTED_NOW));
    try {
      const id = await propose();
      const r = await fetch(`${base}/api/proposals/batch`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ ids: [id], decision: "later" }),
      });
      expect(r.status).toBe(200);
      const { results } = (await r.json()) as { results: { snoozed_until: string }[] };
      // METISTRY_SNOOZE_HOURS defaults to 3 (server.ts) — unset here, so the default holds.
      expect(results[0]!.snoozed_until).toBe("2026-01-01T03:00:00.000Z");
      const row = await pool.query(`SELECT snoozed_until FROM proposals WHERE id = $1`, [id]);
      expect((row.rows[0]!.snoozed_until as Date).toISOString()).toBe("2026-01-01T03:00:00.000Z");
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });

  it("with no cfg.now (every real install), snoozed_until still follows the wall clock — unchanged behaviour", async () => {
    const { server, base, cookie } = await startServer();
    try {
      const id = await propose();
      const before = Date.now();
      const r = await fetch(`${base}/api/proposals/batch`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ ids: [id], decision: "later" }),
      });
      const { results } = (await r.json()) as { results: { snoozed_until: string }[] };
      const gotMs = new Date(results[0]!.snoozed_until).getTime();
      // within a generous window of "now + 3h" measured around the call — never pinned to INJECTED_NOW
      expect(gotMs).toBeGreaterThan(before + 3 * 3_600_000 - 10_000);
      expect(gotMs).toBeLessThan(Date.now() + 3 * 3_600_000 + 10_000);
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });
});
