// The Move-a-meeting door (design-build-plan §2.1, §2.11, B10; ticket T2-12):
// `POST /api/calendar/events/:id/move` — preview, then confirm — through the
// REAL eventkit bridge (packages/mcp-eventkit, over a socket) with a scripted
// helper in place of EventKit, against the scratch database
// (docs/ops/testing.md). No calendar on this machine is ever touched.
//
// The ticket's own test, bold in its Tests line: **the engine's own confirm
// is refused for an event with attendees** — here end to end: the bearer
// the assistant would hold gets 403 from the bridge, and only this door's
// confirm (which adds the owner-door token) moves the meeting. Accept: an
// owner-only event moves without the warning. Plus U2's four.
import type { AddressInfo } from "node:net";
import { rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { mintToken } from "@foldedspacelabs/metistry-core";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";
import { makeBridge } from "../../../packages/mcp-eventkit/src/index.js";
import type { Helper, HelperResponse } from "../../../packages/mcp-eventkit/src/helper.js";
import type { HelperEvent, HelperParticipant } from "../../../packages/mcp-eventkit/src/events.js";
import { makeServer } from "../src/server.js";
import { OWNER_DOOR_HEADER, isMeetingMoveRoute } from "../src/meeting-move-route.js";
import * as store from "../src/auth-store.js";
import * as agents from "../src/agents.js";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url));
const policy = { idleDays: 30, maxDays: 365 };
const MARK = "itest-move";
const suffix = mintToken(6).toLowerCase().replaceAll(/[^a-z0-9]/g, "").slice(0, 6) || "x";
/** This file's own calendar source, so the eventkit sync's tests (which clear `eventkit`'s rows) never race it. */
const CONNECTION = `itest-move-${suffix}`;

describe("the door's route (pure)", () => {
  it("matches exactly POST /api/calendar/events/:id/move", () => {
    expect(isMeetingMoveRoute("POST /api/calendar/events/EK-1/move")).toBe(true);
    expect(isMeetingMoveRoute("GET /api/calendar/events/EK-1/move")).toBe(false);
    expect(isMeetingMoveRoute("POST /api/calendar/events/EK-1/move/x")).toBe(false);
    expect(isMeetingMoveRoute("POST /api/calendar/events//move")).toBe(false);
  });
  it("names the bridge's header", async () => {
    const bridge = await import("../../../packages/mcp-eventkit/src/move.js");
    expect(OWNER_DOOR_HEADER).toBe(bridge.OWNER_DOOR_HEADER);
  });
});

describe.skipIf(!hasDb)("Move a meeting: POST /api/calendar/events/:id/move", () => {
  let pool: pg.Pool;
  let queries: QueryStore;
  let server: ReturnType<typeof makeServer>;
  let base: string;
  let bridge: ReturnType<typeof makeBridge>;
  let bridgeUrl: string;
  let sessionCookie: string;
  let ownerToken: string;
  let agentToken: string;
  const localOwnerToken = mintToken();
  const bridgeToken = mintToken();
  const doorToken = mintToken();
  const agentId = `itest-move-${suffix}`;
  const passkeyIds: string[] = [];
  const dirs: string[] = [];
  const servers: { close(cb: () => void): unknown }[] = [];
  let n = 0;

  /** The calendar the scripted helper holds, by key. */
  const calendar = new Map<string, HelperEvent>();
  const helperMoves: Record<string, unknown>[] = [];
  /** Every request that reached the bridge, with whether it carried the owner-door header. */
  const reached: { door: boolean }[] = [];
  let refreshes = 0;

  const me: HelperParticipant = { name: "Matt", email: "me@example.com", status: "accepted", role: "chair", type: "person", self: true };
  const dana: HelperParticipant = { name: "Dana", email: "dana@example.com", status: "accepted", role: "required", type: "person", self: false };

  const helper = {
    async request(p: Record<string, unknown>): Promise<HelperResponse> {
      if (p.op === "get_event") return { id: 1, ok: true, event: calendar.get(String(p.event_id)) ?? null };
      if (p.op === "move_event") {
        const next = { ...calendar.get(String(p.event_id))!, start: String(p.start), end: String(p.end) };
        calendar.set(String(p.event_id), next);
        helperMoves.push(p);
        return { id: 1, ok: true, moved: next };
      }
      return { id: 1, ok: false, error: "nope" };
    },
  } as unknown as Helper;

  async function serve(eventkit: Parameters<typeof makeServer>[2]["eventkit"], withRefresh = true) {
    const dir = await mkdtemp(join(tmpdir(), "metistry-move-"));
    dirs.push(dir);
    const s = makeServer(pool, queries, {
      origin: "http://127.0.0.1:0",
      inboxDir: dir,
      policy,
      secureCookies: false,
      localOwner: { token: localOwnerToken, trusted: [] },
      ...(eventkit ? { eventkit } : {}),
      ...(withRefresh
        ? {
            scheduled: {
              components: [],
              overlay: {} as never,
              timeZone: null,
              runNow: async (name: string) => {
                expect(name).toBe("eventkit-calendar");
                refreshes++;
                return { started: true as const, runId: "1", done: Promise.resolve() };
              },
            },
          }
        : {}),
    });
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    servers.push(s);
    return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  }

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
    queries = new QueryStore(pool);
    await queries.loadDir(fileURLToPath(new URL("../../../seed/queries", import.meta.url)));
    bridge = makeBridge(helper, { token: bridgeToken, ownerDoorToken: doorToken });
    bridge.prependListener("request", (req) => {
      if (req.url === "/events/move") reached.push({ door: typeof req.headers[OWNER_DOOR_HEADER] === "string" });
    });
    await new Promise<void>((r) => bridge.listen(0, "127.0.0.1", r));
    servers.push(bridge);
    bridgeUrl = `http://127.0.0.1:${(bridge.address() as AddressInfo).port}`;
    base = await serve({ url: bridgeUrl, token: bridgeToken, ownerDoorToken: doorToken, connection: CONNECTION });
    const pkId = `${MARK}-${mintToken(8)}`;
    passkeyIds.push(pkId);
    await store.storePasskey(pool, { id: pkId, publicKey: new Uint8Array([1]), signCount: 0, transports: [], origin: "t", label: MARK });
    sessionCookie = `metistry_session=${await store.issueSession(pool, pkId, policy)}`;
    ownerToken = await store.mintOwnerToken(pool, MARK);
    agentToken = (await agents.createAgent(pool, { id: agentId, display_name: "itest move" })).token;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM calendar_events WHERE connection = $1`, [CONNECTION]);
    await pool.query(`DELETE FROM runs WHERE kind = 'meeting_move' AND meta->>'event_id' LIKE $1`, [`${CONNECTION}-%`]).catch(() => undefined);
    await pool.query(`DELETE FROM agents WHERE id = $1`, [agentId]);
    await pool.query(`DELETE FROM owner_tokens WHERE label = $1`, [MARK]).catch(() => undefined);
    await pool.query(`DELETE FROM auth_sessions WHERE passkey_id = ANY($1)`, [passkeyIds]).catch(() => undefined);
    await pool.query(`DELETE FROM passkeys WHERE id = ANY($1)`, [passkeyIds]).catch(() => undefined);
    for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
    await pool.end();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  beforeEach(() => {
    helperMoves.length = 0;
    reached.length = 0;
    refreshes = 0;
  });

  const to = { start: "2026-10-01T16:00:00Z", end: "2026-10-01T16:30:00Z" };

  /** A meeting in both places a real one is: the calendar table (as the sync leaves it) and the helper's calendar. */
  async function meeting(title: string, people: HelperParticipant[], connection = CONNECTION): Promise<string> {
    const id = `${CONNECTION}-${++n}`;
    const start = "2026-10-01T12:00:00Z";
    const end = "2026-10-01T12:30:00Z";
    await pool.query(
      `INSERT INTO calendar_events (connection, event_id, starts_at, ends_at, title, attendees, self_status) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [connection, id, start, end, title, JSON.stringify(people), people.length ? "accepted" : null],
    );
    calendar.set(id, {
      id,
      title,
      start,
      end,
      all_day: false,
      location: "",
      calendar: "Work",
      attendees: people.map((p) => p.name ?? ""),
      participants: people,
      organizer: people.length ? me : null,
      recurring: false,
      writable: true,
      notes: "Dial-in 555-0100 pin 4242",
    });
    return id;
  }

  const local = { authorization: `Bearer ${localOwnerToken}` };
  async function move(id: string, body: unknown, headers: Record<string, string> = local, at = base) {
    const r = await fetch(`${at}/api/calendar/events/${encodeURIComponent(id)}/move`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await r.text();
    return { status: r.status, text, body: JSON.parse(text) as Record<string, any> };
  }

  // ---- U2: the four --------------------------------------------------------------------------

  describe("who may move a meeting (U2)", () => {
    it("no credential is the uniform 401, and the bridge is never asked", async () => {
      const id = await meeting("U2 none", [me, dana]);
      const r = await move(id, to, {});
      expect(r.status).toBe(401);
      expect(reached).toHaveLength(0);
    });

    it("an agent bearer is refused 403 with the canonical answer, and the bridge is never asked", async () => {
      const id = await meeting("U2 agent", [me, dana]);
      const r = await move(id, to, { authorization: `Bearer ${agentToken}` });
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe("forbidden");
      expect(reached).toHaveLength(0);
    });

    it("the capture owner token is refused 403 — capture is its whole reach — and the bridge is never asked", async () => {
      const id = await meeting("U2 capture", [me, dana]);
      const r = await move(id, to, { authorization: `Bearer ${ownerToken}` });
      expect(r.status).toBe(403);
      expect(reached).toHaveLength(0);
    });

    it("the local owner token reaches it, and so does a passkey session (reach `owner`)", async () => {
      const a = await meeting("U2 local", [me, dana]);
      expect((await move(a, to)).status).toBe(200);
      const b = await meeting("U2 session", [me, dana]);
      expect((await move(b, to, { cookie: sessionCookie })).status).toBe(200);
    });
  });

  // ---- the ticket's own ----------------------------------------------------------------------

  it("the preview names who is in it and the new time, with the warning — nothing moves, and never the invite body", async () => {
    const id = await meeting("1:1 with Dana", [me, dana]);
    const r = await move(id, to);
    expect(r.status).toBe(200);
    expect(r.text).not.toContain("Dial-in");
    expect(r.body).toMatchObject({ ok: true, moved: false, others: 1, expires_in_sec: 300 });
    expect(r.body.preview).toMatchObject({ event_id: id, title: "1:1 with Dana", from: { start: "2026-10-01T12:00:00Z", end: "2026-10-01T12:30:00Z" }, to });
    // who is in it, as Today spells an attendee — the shape MetistryKit reads (F-7)
    expect(r.body.preview.attendees).toEqual([
      { name: "Matt", email: "me@example.com", person: null, self: true },
      { name: "Dana", email: "dana@example.com", person: null, self: false },
    ]);
    expect(r.body.warning).toMatch(/1 other person in it will see the new time: Dana/);
    expect(typeof r.body.confirm_token).toBe("string");
    expect(helperMoves).toHaveLength(0);
    expect(reached).toEqual([{ door: false }]); // a preview never presents the owner-door token
  });

  it("**the engine's own confirm is refused for an event with attendees** — the bearer alone gets 403 at the bridge; this door's confirm moves it", async () => {
    const id = await meeting("Planning with Dana", [me, dana]);
    const p = await move(id, to);
    // the assistant's reach: the bridge's bearer, and no owner-door token — whatever it was told
    const engine = await fetch(`${bridgeUrl}/events/move`, {
      method: "POST",
      headers: { authorization: `Bearer ${bridgeToken}`, "content-type": "application/json" },
      body: JSON.stringify({ event_id: id, ...to, confirm_token: p.body.confirm_token }),
    });
    expect(engine.status).toBe(403);
    expect(helperMoves).toHaveLength(0);
    // the refused confirm spent the token: the owner confirms from a fresh preview
    expect((await move(id, { ...to, confirm_token: p.body.confirm_token })).status).toBe(409);
    const q = await move(id, to);
    const c = await move(id, { ...to, confirm_token: q.body.confirm_token });
    expect(c.status).toBe(200);
    expect(c.body).toMatchObject({ ok: true, moved: true, event_id: id, others: 1, refreshing: true, event: { start: to.start, end: to.end } });
    expect(c.text).not.toContain("Dial-in");
    expect(helperMoves).toEqual([{ op: "move_event", event_id: id, start: to.start, end: to.end }]);
    expect(reached.at(-1)!.door).toBe(true); // the confirm carried the owner door's token
    expect(refreshes).toBe(1); // Today catches up now, not on the next pass
  });

  it("an owner-only event moves without the warning (Accept)", async () => {
    const id = await meeting("Focus block", []);
    const p = await move(id, to);
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ others: 0, warning: null });
    const c = await move(id, { ...to, confirm_token: p.body.confirm_token });
    expect(c.status).toBe(200);
    expect(c.body.moved).toBe(true);
    expect(helperMoves).toHaveLength(1);
  });

  it("a confirm is single-use, and bound to the time it previewed: 409 `stale`, nothing moved", async () => {
    const id = await meeting("Bound", []);
    const p = await move(id, to);
    const other = await move(id, { start: to.start, end: "2026-10-01T17:00:00Z", confirm_token: p.body.confirm_token });
    expect(other.status).toBe(409);
    expect(other.body).toMatchObject({ error: { code: "conflict" }, reason: "stale" });
    const q = await move(id, to);
    expect((await move(id, { ...to, confirm_token: q.body.confirm_token })).status).toBe(200);
    expect((await move(id, { ...to, confirm_token: q.body.confirm_token })).status).toBe(409);
    expect(helperMoves).toHaveLength(1);
  });

  it("an event that changed since the preview is 409 `stale` with the event as it stands", async () => {
    const id = await meeting("Changed", [me, dana]);
    const p = await move(id, to);
    calendar.set(id, { ...calendar.get(id)!, start: "2026-10-01T12:15:00Z" });
    const c = await move(id, { ...to, confirm_token: p.body.confirm_token });
    expect(c.status).toBe(409);
    expect(c.body).toMatchObject({ reason: "stale", event: { start: "2026-10-01T12:15:00Z" } });
    expect(helperMoves).toHaveLength(0);
  });

  it("a console without the owner-door token can move an owner-only event, and says what to mint for one with others", async () => {
    const at = await serve({ url: bridgeUrl, token: bridgeToken, connection: CONNECTION }, false);
    const solo = await meeting("Solo", []);
    const sp = await move(solo, to, local, at);
    expect((await move(solo, { ...to, confirm_token: sp.body.confirm_token }, local, at)).status).toBe(200);
    const shared = await meeting("Shared", [me, dana]);
    const p = await move(shared, to, local, at);
    const c = await move(shared, { ...to, confirm_token: p.body.confirm_token }, local, at);
    expect(c.status).toBe(503);
    expect(c.body.error.message).toMatch(/others in it.*metistry secrets mint METISTRY_OWNER_DOOR_TOKEN_EVENTKIT/);
    expect(helperMoves).toHaveLength(1);
  });

  it("an id no calendar holds is 404, an event from a source this console cannot move is 503, and no bridge is 503 — the bridge never asked", async () => {
    expect((await move(`${CONNECTION}-nope`, to)).status).toBe(404);
    const ics = await meeting("From ICS", [], `${CONNECTION}-ics`);
    const r = await move(ics, to);
    expect(r.status).toBe(503);
    expect(r.body.error.message).toMatch(/open it in Calendar/);
    await pool.query(`DELETE FROM calendar_events WHERE connection = $1`, [`${CONNECTION}-ics`]);
    const none = await serve(undefined, false);
    const id = await meeting("No bridge", []);
    expect((await move(id, to, local, none)).status).toBe(503);
    expect(reached).toHaveLength(0);
  });

  it("an unreachable bridge is 503 naming the Mac, never a 500", async () => {
    const away = await serve({ url: "http://127.0.0.1:1", token: bridgeToken, ownerDoorToken: doorToken, connection: CONNECTION }, false);
    const id = await meeting("Away", []);
    const r = await move(id, to, local, away);
    expect(r.status).toBe(503);
    expect(r.body.error.message).toMatch(/not answering/);
  });

  it("the body is {start, end, confirm_token?}: anything else is 400 and the bridge is never asked", async () => {
    const id = await meeting("Body", []);
    for (const b of [{}, { start: to.start }, { ...to, title: "renamed" }, { ...to, event_id: "other" }, { start: to.end, end: to.start }, { start: "soon", end: to.end }, { ...to, confirm_token: 5 }, [], "not json"]) {
      expect((await move(id, b)).status, JSON.stringify(b)).toBe(400);
    }
    expect((await move(" padded", to)).status).toBe(400);
    expect(reached).toHaveLength(0);
  });

  it("the ledger row names the id and the outcome — never the title, the people or the times", async () => {
    const id = await meeting("Secret offsite with Dana", [me, dana]);
    await move(id, to);
    const { rows } = await pool.query(`SELECT kind, tool, ok, meta FROM runs WHERE kind = 'meeting_move' AND meta->>'event_id' = $1 ORDER BY id`, [id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "meeting_move", tool: "preview", ok: true, meta: { event_id: id, outcome: "previewed", others: 1 } });
    const text = JSON.stringify(rows);
    for (const leak of ["Secret offsite", "Dana", "dana@", to.start]) expect(text).not.toContain(leak);
  });
});
