// Purge Now — `POST /api/sessions/purge` (T3-9, reach `local`, plan §2.1 and
// §2.3: "Sessions: Purge Now — Mac only, irreversible"). Over a real socket
// against the scratch database (docs/ops/testing.md).
//
// U2's misuse tests, each with a body that WOULD purge (`confirm: true`), so a
// refusal here is the gate and not a 400 — and each proving nothing was
// deleted. Then the door's own behaviour: without `confirm: true` it deletes
// nothing and names the unfolded sessions (C136: the confirm names them and
// offers Fold First); with it, it deletes exactly what the preview counted.
//
// Hermetic in a shared database: every fixture turn is dated 2000-01-01 and
// the confirm is bounded by `as_of: 2000-01-02`, so this file can only ever
// delete its own rows, whatever other suites have archived meanwhile.
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { mintToken } from "@foldedspacelabs/metistry-core";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";
import { makeServer } from "../src/server.js";
import * as store from "../src/auth-store.js";
import * as agents from "../src/agents.js";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url));
const policy = { idleDays: 30, maxDays: 365 };
const MARK = "itest-sessions-purge";
const PATH = "/api/sessions/purge";
const BOUND = "2000-01-02T00:00:00.000Z"; // after every fixture turn, before anything any other suite archives

describe.skipIf(!hasDb)("Purge Now — POST /api/sessions/purge", () => {
  let pool: pg.Pool;
  let server: ReturnType<typeof makeServer>;
  let base: string;
  let sessionCookie: string;
  let ownerToken: string;
  let agentToken: string;
  const localOwnerToken = mintToken();
  const agentId = `itest-purge-${mintToken(6).toLowerCase().replaceAll(/[^a-z0-9]/g, "").slice(0, 6) || "x"}`;
  const passkeyId = `${MARK}-${mintToken(8)}`;
  let inboxDir: string;
  let unfolded: string;
  let folded: string;

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
    inboxDir = await mkdtemp(join(tmpdir(), "metistry-sessions-purge-"));
    server = makeServer(pool, new QueryStore(pool), {
      origin: "http://127.0.0.1:0",
      inboxDir,
      policy,
      secureCookies: false,
      localOwner: { token: localOwnerToken, trusted: [] },
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await store.storePasskey(pool, { id: passkeyId, publicKey: new Uint8Array([1]), signCount: 0, transports: [], origin: "t", label: MARK });
    sessionCookie = `metistry_session=${await store.issueSession(pool, passkeyId, policy)}`;
    ownerToken = await store.mintOwnerToken(pool, MARK);
    agentToken = (await agents.createAgent(pool, { id: agentId, display_name: "itest purge" })).token;
  });

  /** Two sessions of the year 2000, still unexpired: one with an unfolded turn, one wholly folded. */
  beforeEach(async () => {
    await pool.query(`DELETE FROM session_archive WHERE ts <= $1`, [BOUND]);
    unfolded = randomUUID();
    folded = randomUUID();
    await pool.query(
      `INSERT INTO session_archive (session_id, thread, turn_id, ts, system_prompt, messages, tool_calls, folded_at, expires_at) VALUES
         ($1, 'default', 't1', '2000-01-01T10:00:00Z', 'p', '[]', '[]', NULL,  now() + interval '1 day'),
         ($1, 'default', 't2', '2000-01-01T10:05:00Z', 'p', '[]', '[]', now(), now() + interval '1 day'),
         ($2, 'fold',    't1', '2000-01-01T11:00:00Z', 'p', '[]', '[]', now(), now() + interval '1 day')`,
      [unfolded, folded],
    );
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM session_archive WHERE ts <= $1`, [BOUND]);
    await pool.query(`DELETE FROM agents WHERE id = $1`, [agentId]);
    await pool.query(`DELETE FROM owner_tokens WHERE label = $1`, [MARK]).catch(() => undefined);
    await pool.query(`DELETE FROM auth_sessions WHERE passkey_id = $1`, [passkeyId]).catch(() => undefined);
    await pool.query(`DELETE FROM passkeys WHERE id = $1`, [passkeyId]).catch(() => undefined);
    await new Promise<void>((r) => server.close(() => r()));
    await pool.end();
    rmSync(inboxDir, { recursive: true, force: true });
  });

  async function post(headers: Record<string, string>, body: unknown): Promise<{ status: number; body: any }> {
    const r = await fetch(base + PATH, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  }
  const mine = async (): Promise<number> => Number((await pool.query(`SELECT count(*) AS n FROM session_archive WHERE session_id = ANY($1::uuid[])`, [[unfolded, folded]])).rows[0].n);

  it("U2: no credential is the uniform 401, and nothing is purged", async () => {
    const p = await post({}, { confirm: true, as_of: BOUND });
    expect(p.status).toBe(401);
    expect(p.body).toEqual({ error: { code: "unauthenticated", message: "authentication required" } });
    expect(await mine()).toBe(3);
  });

  it("U2: an agent bearer and the capture owner token are the uniform 403 — never local_only — and nothing is purged", async () => {
    for (const bearer of [agentToken, ownerToken]) {
      const p = await post({ authorization: `Bearer ${bearer}` }, { confirm: true, as_of: BOUND });
      expect(p.status).toBe(403);
      expect(p.body).toEqual({ error: { code: "forbidden", message: "not granted" } });
    }
    expect(await mine()).toBe(3);
  });

  it("**a passkey session — even from 127.0.0.1 — is refused 403 local_only: Purge Now is Mac only**, and nothing is purged", async () => {
    const p = await post({ cookie: sessionCookie }, { confirm: true, as_of: BOUND });
    expect(p.status).toBe(403);
    expect(p.body.error.code).toBe("local_only");
    expect(p.body.error.message).toContain("POST /api/sessions/purge");
    expect(p.body.error.message).toContain("Mac app");
    expect(await mine()).toBe(3);
  });

  it("U2: the local owner token reaches it — and **without confirm: true it deletes nothing** and names the sessions not yet folded", async () => {
    for (const body of [{}, { confirm: false }, { as_of: BOUND }]) {
      const p = await post({ authorization: `Bearer ${localOwnerToken}` }, body);
      expect(p.status, JSON.stringify(body)).toBe(200);
      expect(p.body.purged).toBe(false);
      expect(p.body.sessions).toBeGreaterThanOrEqual(2);
      expect(p.body.turns).toBeGreaterThanOrEqual(3);
      expect(p.body.sessions_unfolded).toBeGreaterThanOrEqual(1);
      const named = p.body.unfolded.find((s: { session_id: string }) => s.session_id === unfolded);
      expect(named).toEqual({ session_id: unfolded, thread: "default", turns: 2, unfolded_turns: 1, first_ts: "2000-01-01T10:00:00.000Z", last_ts: "2000-01-01T10:05:00.000Z" });
      expect(p.body.unfolded.some((s: { session_id: string }) => s.session_id === folded)).toBe(false); // wholly folded: nothing to lose
      expect(Number.isNaN(Date.parse(p.body.as_of))).toBe(false);
    }
    expect(await mine()).toBe(3);
  });

  it("confirm: true purges folded and unfolded alike — bounded by as_of — and the purge is audited with its counts", async () => {
    const p = await post({ authorization: `Bearer ${localOwnerToken}` }, { confirm: true, as_of: BOUND });
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ purged: true, sessions: 2, turns: 3, sessions_unfolded: 1 });
    expect(await mine()).toBe(0);
    const { rows } = await pool.query(`SELECT ok, meta FROM runs WHERE component = 'console' AND kind = 'sessions' AND tool = 'purge' ORDER BY id DESC LIMIT 1`);
    expect(rows[0]).toMatchObject({ ok: true, meta: { sessions: 2, turns: 3, sessions_unfolded: 1, as_of: BOUND, via: "local_owner" } });
  });

  it("a confirm that is not true/false, or an as_of that is not a timestamp, is a 400 naming the field — and purges nothing", async () => {
    for (const [body, field] of [
      [{ confirm: "yes" }, "confirm"],
      [{ confirm: 1 }, "confirm"],
      [{ confirm: true, as_of: "yesterday" }, "as_of"],
      [{ confirm: true, as_of: 946771200 }, "as_of"],
    ] as const) {
      const p = await post({ authorization: `Bearer ${localOwnerToken}` }, body);
      expect(p.status, JSON.stringify(body)).toBe(400);
      expect(p.body.error.code).toBe("invalid_request");
      expect(p.body.error.message).toContain(field);
    }
    expect(await mine()).toBe(3);
  });
});
