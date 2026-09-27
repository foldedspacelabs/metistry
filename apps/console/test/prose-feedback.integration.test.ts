// Prose feedback (T1-12; B7 of `today-hub-requests.md`; docs/ops/client-api.md
// § Prose feedback): a 👍/👎 on any piece of generated prose that is not a
// chat reply, keyed by a `runs.id` rather than an `outbound_messages.id` —
// `runs` is the one ledger every model turn already logs a row to, so it is
// the id already stable wherever prose is produced (0031_prose_feedback.sql).
//
// Misuse first (invariant 8, U2): this is the owner's own judgement, so an
// owner token is forbidden exactly where a passkey session is not — the
// client-api conformance suite holds this generally for every served row;
// this file is the door's own tests, over real sockets against the scratch
// database (docs/ops/testing.md).
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { mintToken } from "@foldedspacelabs/metistry-core";
import { makeServer } from "../src/server.js";
import * as store from "../src/auth-store.js";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url));
const policy = { idleDays: 30, maxDays: 365 };

describe.skipIf(!hasDb)("prose feedback (integration)", () => {
  let pool: pg.Pool;
  let base: string;
  let server: ReturnType<typeof makeServer>;
  let cookie: string;
  let ownerToken: string;
  const mark = `itest-prose-${mintToken(6)}`;

  const json = (method: string, path: string, body?: unknown, headers: Record<string, string> = { cookie }) =>
    fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

  /** A `runs` row — the ledger entry that stands in for one piece of generated prose. */
  const prose = async (component = "assistant") =>
    (await pool.query(`INSERT INTO runs (component, kind, ok, meta) VALUES ($1, 'turn', true, $2) RETURNING id`, [component, JSON.stringify({ mark })])).rows[0].id as number;

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
    server = makeServer(pool, new QueryStore(pool), {
      origin: "http://127.0.0.1:0",
      inboxDir: `/tmp/metistry-test-inbox-prose-${Date.now()}`,
      policy,
      secureCookies: false,
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const pkId = `pf-${mintToken(6)}`;
    await store.storePasskey(pool, { id: pkId, publicKey: new Uint8Array([1]), signCount: 0, transports: [], origin: "t", label: "pf" });
    cookie = `metistry_session=${await store.issueSession(pool, pkId, policy)}`;
    ownerToken = await store.mintOwnerToken(pool, "pf-test");
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM runs WHERE meta->>'mark' = $1`, [mark]);
    await pool.query(`DELETE FROM owner_tokens WHERE label = 'pf-test'`);
    await new Promise<void>((r) => server.close(() => r()));
    await pool.end();
  });

  it("rating prose needs a passkey session — an owner token is forbidden, not 404", async () => {
    const id = await prose();
    const r = await json("POST", `/api/prose/${id}/feedback`, { rating: 1 }, { authorization: `Bearer ${ownerToken}` });
    expect(r.status).toBe(403);
    expect((await json("DELETE", `/api/prose/${id}/feedback`, undefined, { authorization: `Bearer ${ownerToken}` })).status).toBe(403);
    const none = await fetch(`${base}/api/prose/${id}/feedback`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    expect(none.status).toBe(401);
  });

  it("upserts one row per prose id, carries the note, clears on DELETE, and logs a runs row each time", async () => {
    const id = await prose("routines/meeting-brief");
    expect((await json("POST", `/api/prose/${id}/feedback`, { rating: 1 })).status).toBe(200);
    // second rating replaces the first — one judgement per prose id
    const down = await json("POST", `/api/prose/${id}/feedback`, { rating: -1, note: "  guessed instead of retrieving  " });
    expect(down.status).toBe(200);
    expect((await down.json()).feedback).toMatchObject({ rating: -1, note: "guessed instead of retrieving" });
    const rows = await pool.query(`SELECT rating, note FROM prose_feedback WHERE prose_id = $1`, [id]);
    expect(rows.rows).toEqual([{ rating: -1, note: "guessed instead of retrieving" }]);

    // the runs row itself — the prose it rates — is untouched
    const run = await pool.query(`SELECT component FROM runs WHERE id = $1`, [id]);
    expect(run.rows[0].component).toBe("routines/meeting-brief");

    expect((await json("DELETE", `/api/prose/${id}/feedback`)).status).toBe(200);
    expect((await pool.query(`SELECT 1 FROM prose_feedback WHERE prose_id = $1`, [id])).rows).toEqual([]);

    const auditRows = await pool.query(`SELECT tool FROM runs WHERE component = 'console' AND kind = 'feedback' AND (meta->>'prose_id')::bigint = $1 ORDER BY id`, [id]);
    expect(auditRows.rows.map((r: any) => r.tool)).toEqual(["up", "down", "clear"]);
  });

  it("clears to null on DELETE with no prior rating, rather than erroring", async () => {
    const id = await prose();
    const r = await json("DELETE", `/api/prose/${id}/feedback`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, feedback: null });
  });

  it("refuses a rating that is not ±1, a non-string note, and an unknown id — POST and DELETE alike", async () => {
    const id = await prose();
    for (const body of [{}, { rating: 0 }, { rating: 5 }, { rating: "1" }, { rating: 1, note: { a: 1 } }]) {
      expect((await json("POST", `/api/prose/${id}/feedback`, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await json("POST", `/api/prose/999999999999/feedback`, { rating: 1 })).status).toBe(404);
    expect((await json("DELETE", `/api/prose/999999999999/feedback`)).status).toBe(404);
  });
});
