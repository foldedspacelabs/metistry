// `POST /message` carries a session-turn marker (X-84, ruled 2026-10-04;
// screen 11 §4 "staying on this Mac"; plan §2.15). The bar's Ask panel sets
// `capture_session` to the recorder's id of the running recording, and the
// turn is held to the private tier — refused, never moved, when there is
// nowhere private to run it. Misuse tests (U2): the field is refused from an
// agent bearer with the route (uniform 403, no row); a value that is not a
// recorder id is 400; a session the console has seen END is 409 `stale`; and
// no refusal writes a row. Every unmarked turn is routed as before.
//
// The drain's half — a marked row runs on the private tier's on_machine
// provider, or is refused with `PrivateTierUnavailable` and an alert — is
// apps/assistant/test/drain.integration.test.ts; here the row the door writes
// is resolved through the same core functions the drain calls, so the two
// halves are pinned to one contract (`meta.capture_session`).
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { PRIVATE_TIER, PrivateTierUnavailable, mintToken, parseCompute, resolveAssignment, turnTier } from "@foldedspacelabs/metistry-core";
import { makeServer } from "../src/server.js";
import * as store from "../src/auth-store.js";
import * as agents from "../src/agents.js";
import { loadRules } from "../src/router.js";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url)); // METISTRY_DB_* only (docs/ops/testing.md)
const policy = { idleDays: 30, maxDays: 365 };

/** The recorder's ids: a recording in progress (no row — the console learns of one at its end), and one the console has seen end. */
const LIVE = "20261018-091500-00ab";
const ENDED = "20261018-083000-00cd";

/** compute.yaml with no private tier — the shape that refuses a marked turn. */
const NO_PRIVATE = `
providers:
  openrouter:
    kind: openai-compatible
    base_url: https://openrouter.ai/api/v1
    locality: off_machine
    data_policy: { allow: [Knowledge], deny_sources: [], max_brief_bytes: 1024 }
assignments:
  default: { model: openrouter/anthropic/claude-sonnet-5, effort: medium }
  tiers:
    deep: { model: openrouter/anthropic/claude-opus-5, effort: high }
`;

describe.skipIf(!hasDb)("POST /message: the session-turn marker (X-84)", () => {
  let pool: pg.Pool;
  let base: string;
  let server: ReturnType<typeof makeServer>;
  let agentToken: string;
  let captureToken: string;
  const localOwnerToken = mintToken();
  const thread = `x84-${mintToken(4)}`;

  const post = (body: unknown, token = localOwnerToken) =>
    fetch(`${base}/message`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const rowsInThread = async () => (await pool.query(`SELECT id, text, meta FROM inbound_messages WHERE thread = $1 ORDER BY id`, [thread])).rows;
  const served = async (): Promise<Array<{ text: string; tier: string | null }>> => {
    const r = await fetch(`${base}/api/messages?limit=50`, { headers: { authorization: `Bearer ${localOwnerToken}` } });
    expect(r.status).toBe(200);
    const page = (await r.json()) as { messages: Array<{ thread: string; direction: string; text: string; tier: string | null }> };
    return page.messages.filter((m) => m.thread === thread && m.direction === "in").map((m) => ({ text: m.text, tier: m.tier }));
  };

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
    const queries = new QueryStore(pool);
    server = makeServer(pool, queries, {
      origin: "http://127.0.0.1:0",
      inboxDir: `/tmp/metistry-test-inbox-x84-${Date.now()}`,
      policy,
      secureCookies: false,
      rules: loadRules(readFileSync(new URL("../../../seed/rules.yaml", import.meta.url), "utf8")),
      localOwner: { token: localOwnerToken, trusted: [] },
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    agentToken = (await agents.createAgent(pool, { id: `x84-${mintToken(3).toLowerCase().replace(/[^a-z0-9]/g, "a")}`, display_name: "x84 agent" })).token;
    captureToken = await store.mintOwnerToken(pool, "x84-capture");
    // a recording the console has seen end: its transcript was delivered through POST /capture
    await pool.query(
      `INSERT INTO capture_sessions (id, started_at, ended_at, apps, transcript_path) VALUES ($1, '2026-10-18T08:30:00Z', '2026-10-18T08:52:00Z', '{us.zoom.xos}', $2)
       ON CONFLICT (id) DO UPDATE SET ended_at = EXCLUDED.ended_at, transcript_path = EXCLUDED.transcript_path`,
      [ENDED, `Journal/Transcripts/2026-10-18-${ENDED}.md`],
    );
    await pool.query(`DELETE FROM capture_sessions WHERE id = $1`, [LIVE]);
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await pool.end();
  });

  it("a marked turn is accepted, carries the marker on its row, and resolves to the private tier — refused, never moved, when none is assigned", async () => {
    const r = await post({ thread_id: thread, text: "what did they just decide about the budget?", tier: "deep", capture_session: LIVE });
    expect(r.status).toBe(202);
    const { message_id } = (await r.json()) as { message_id: string };
    const rows = await rowsInThread();
    expect(rows.map((x) => String(x.id))).toContain(String(message_id));
    const row = rows.find((x) => String(x.id) === String(message_id))!;
    // the drain's contract: `meta.capture_session` names the recording; the route is what the rules decided
    expect(row.meta.capture_session).toBe(LIVE);
    expect(row.meta.route).toMatchObject({ kind: "model", tier: "deep", routed_by: "override" });
    // the drain's own resolution, step for step (apps/assistant/src/tiers.ts): the marker puts
    // `private` over the chosen tier, and `private` with nothing on this machine is a refusal
    const tier = turnTier(row.meta.route.tier, { captureSession: row.meta.capture_session != null });
    expect(tier).toBe(PRIVATE_TIER);
    expect(() => resolveAssignment(parseCompute(NO_PRIVATE), tier)).toThrow(PrivateTierUnavailable);
    expect(() => resolveAssignment(parseCompute(NO_PRIVATE), tier)).toThrow(/metistry compute assign private/);
  });

  it("an unmarked turn is routed as before: no marker on the row, the router's tier", async () => {
    const r = await post({ thread_id: thread, text: "what did they just decide about the budget?", tier: "deep" });
    expect(r.status).toBe(202);
    const row = (await rowsInThread()).at(-1)!;
    expect(row.meta).not.toHaveProperty("capture_session");
    expect(row.meta.route).toMatchObject({ kind: "model", tier: "deep", routed_by: "override" });
    expect(turnTier(row.meta.route.tier, { captureSession: row.meta.capture_session != null })).toBe("deep");
    // an explicit null is "no marker", exactly as the drain reads it
    const n = await post({ thread_id: thread, text: "and the timeline?", capture_session: null });
    expect(n.status).toBe(202);
    expect((await rowsInThread()).at(-1)!.meta).not.toHaveProperty("capture_session");
  });

  it("GET /api/messages reads a marked turn's tier as private — the tier it runs on, not the one the rules chose", async () => {
    const list = await served();
    expect(list.find((m) => m.text === "what did they just decide about the budget?" && m.tier === PRIVATE_TIER)).toBeDefined();
    expect(list.find((m) => m.text === "what did they just decide about the budget?" && m.tier === "deep")).toBeDefined();
    expect(list.find((m) => m.text === "and the timeline?")?.tier).not.toBe(PRIVATE_TIER);
  });

  it("a marker naming a session that is not open is refused: 409 stale, and no row is written", async () => {
    const before = (await rowsInThread()).length;
    const r = await post({ thread_id: thread, text: "what did they decide?", capture_session: ENDED });
    expect(r.status).toBe(409);
    const body = await r.json();
    expect(body).toMatchObject({ error: { code: "conflict" }, reason: "stale" });
    expect(body.error.message).toContain(ENDED);
    expect((await rowsInThread()).length).toBe(before);
  });

  it("a marker that is not a recorder session id is refused: 400, and no row is written", async () => {
    const before = (await rowsInThread()).length;
    for (const bad of ["", "../Journal", "UPPER-CASE", "a".repeat(65), 7, true, { id: LIVE }, [LIVE]]) {
      const r = await post({ thread_id: thread, text: "what did they decide?", capture_session: bad });
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect((await r.json()).error.code).toBe("invalid_request");
    }
    expect((await rowsInThread()).length).toBe(before);
  });

  it("misuse: an agent bearer is refused the field with the route — the uniform 403, and no row", async () => {
    const before = (await rowsInThread()).length;
    const r = await post({ thread_id: thread, text: "what did they decide?", capture_session: LIVE }, agentToken);
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: { code: "forbidden", message: "not granted" } });
    expect((await rowsInThread()).length).toBe(before);
  });

  it("misuse: no credential is the uniform 401, marker or not", async () => {
    const r = await fetch(`${base}/message`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "x", capture_session: LIVE }) });
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: { code: "unauthenticated", message: "authentication required" } });
  });

  it("the capture owner token reaches /message as it always has, and a marker it sends is checked the same way", async () => {
    // the Shortcut's token is an owner credential on this route (client-api.ts OWNER_AND_CAPTURE_TOKEN):
    // its marked turn is held private like the bar's — the marker only ever makes a turn more private
    const ok = await post({ thread_id: thread, text: "note the decision on pricing", capture_session: LIVE }, captureToken);
    expect(ok.status).toBe(202);
    expect((await rowsInThread()).at(-1)!.meta.capture_session).toBe(LIVE);
    const stale = await post({ thread_id: thread, text: "x", capture_session: ENDED }, captureToken);
    expect(stale.status).toBe(409);
  });

  it("the marker rides into a /note and a fast path too — both answer on this Mac in the 202", async () => {
    const note = await post({ thread_id: thread, text: "/note the vendor agreed to net-60", capture_session: LIVE });
    expect(note.status).toBe(202);
    expect(((await note.json()) as { reply?: string }).reply).toMatch(/^noted/);
    expect((await rowsInThread()).at(-1)!.meta.capture_session).toBe(LIVE);
    // it ran on no model, so the thread reads no tier for it — `private` is a model turn's word
    expect((await served()).find((m) => m.text === "/note the vendor agreed to net-60")?.tier ?? null).toBeNull();
  });
});
