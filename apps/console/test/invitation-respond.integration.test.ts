// Respond to an invitation — `POST /api/calendar/invitations/:id/respond`
// (design-build-plan §2.6, §2.11, §2.12; T4-17), over real sockets against
// the scratch database. The calendar is a local CalDAV fixture server
// (packages/connections/test/caldav-server.ts — 127.0.0.1, an ephemeral
// port, never a real service) behind a scratch instance's connection, opened
// by the console's own opener (`calendarRsvpOpener`) through the egress door.
//
// The ticket's own test, bold in its Tests line: **Respond is refused
// without an `rsvp` capability** — a meeting only the Mac's calendar or a
// feed holds, or a console with no calendars at all — and nothing is sent.
// Plus U2's four, preview-then-confirm with a single-use token bound to what
// the preview showed, and the invitation's request clearing on the answer.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { mintToken } from "@foldedspacelabs/metistry-core";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";
import { instanceSyncOpener } from "@foldedspacelabs/metistry-connections";
import { calendarRsvpOpener } from "@metistry-apps/collectors";
import { INVITE, INVITE_BODY } from "../../../packages/connections/test/caldav-fixtures.js";
import { fakeCaldav, type FakeCaldav } from "../../../packages/connections/test/caldav-server.js";
import { run as caldavSync } from "../../../collectors/caldav-calendar/run.js";
import { makeServer } from "../src/server.js";
import { isInvitationRespondRoute } from "../src/invitation-respond-route.js";
import { ConfirmTokens } from "../src/door-confirm.js";
import * as store from "../src/auth-store.js";
import * as agents from "../src/agents.js";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url));
const policy = { idleDays: 30, maxDays: 365 };
const MARK = "itest-rsvp";
const suffix = mintToken(6).toLowerCase().replaceAll(/[^a-z0-9]/g, "").slice(0, 6) || "x";
const SEED = fileURLToPath(new URL("../../../seed", import.meta.url));
const USER = "me@example.com";
const PASSWORD = ["qzvt", "hmwk", "rbxe", "lpfa"].join("-"); // an app password's shape, built at run time
const ENV = { METISTRY_SECRET_CALDAV_PASSWORD: PASSWORD };
const NOW = Date.parse("2026-09-28T16:00:00Z");
const CONN = `itest-rsvp-${suffix}`;
const MAC = `itest-rsvp-mac-${suffix}`;
const FEED = `itest-rsvp-ics-${suffix}`;
/** This run's own meetings: the fixture invitation under UIDs no other suite uses. */
const UID = `vendor-review-${suffix}@example.com`;
const UID2 = `vendor-review-2-${suffix}@example.com`;
const invite = (uid: string) => INVITE.replaceAll("vendor-review-0929@example.com", uid);

describe("the route (pure)", () => {
  it("matches the respond door and nothing near it", () => {
    expect(isInvitationRespondRoute("POST /api/calendar/invitations/evt-1/respond")).toBe(true);
    for (const k of ["GET /api/calendar/invitations/evt-1/respond", "POST /api/calendar/invitations/evt-1", "POST /api/calendar/invitations//respond", "POST /api/calendar/events/evt-1/respond", "POST /api/calendar/invitations/a/b/respond"]) {
      expect(isInvitationRespondRoute(k), k).toBe(false);
    }
  });

  it("a confirm token is single-use, bound to its door and subject, and expires", () => {
    let t = 0;
    const tokens = new ConfirmTokens<string>(() => t);
    const a = tokens.mint("respond", "e#accepted", "A");
    expect(tokens.take(a.confirm_token, "respond", "e#declined")).toBeNull(); // another answer: refused, and unspent
    expect(tokens.take(a.confirm_token, "draft", "e#accepted")).toBeNull(); // another door
    expect(tokens.take(a.confirm_token, "respond", "e#accepted")).toBe("A");
    expect(tokens.take(a.confirm_token, "respond", "e#accepted")).toBeNull(); // spent
    const b = tokens.mint("respond", "e#accepted", "B");
    t += b.expires_in_sec * 1000;
    expect(tokens.take(b.confirm_token, "respond", "e#accepted")).toBeNull(); // expired
  });
});

describe.skipIf(!hasDb)("Respond: POST /api/calendar/invitations/:id/respond", () => {
  let pool: pg.Pool;
  let dav: FakeCaldav;
  let server: ReturnType<typeof makeServer>;
  let bareServer: ReturnType<typeof makeServer>;
  let base: string;
  let bare: string;
  let sessionCookie: string;
  let ownerToken: string;
  let agentToken: string;
  const dirs: string[] = [];
  const localOwnerToken = mintToken();
  const agentId = `itest-rsvp-${suffix}`;
  const passkeyIds: string[] = [];
  const local = { authorization: `Bearer ${localOwnerToken}` };

  async function post(id: string, body: unknown, headers: Record<string, string> = local, at = base) {
    const r = await fetch(`${at}/api/calendar/invitations/${encodeURIComponent(id)}/respond`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { status: r.status, body: JSON.parse(await r.text()) as Record<string, any> };
  }
  /** What reached the calendar server that could change it. */
  const writes = () => dav.requests.filter((r) => r.method === "PUT" || r.method === "DELETE");
  const mirror = async (uid: string) =>
    (await pool.query(`SELECT decision, payload->'cleared' AS cleared FROM proposals WHERE kind = 'invitation' AND source->>'external_ref' = $1`, [`invite:uid/${uid}`])).rows;

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
    const queries = new QueryStore(pool);
    await queries.loadDir(fileURLToPath(new URL("../../../seed/queries", import.meta.url)));
    dav = await fakeCaldav({ username: USER, password: PASSWORD, events: { "review.ics": invite(UID), "review-2.ics": invite(UID2) } });
    const dir = mkdtempSync(join(tmpdir(), "metistry-rsvp-"));
    dirs.push(dir);
    mkdirSync(join(dir, ".metistry", "connections"), { recursive: true });
    writeFileSync(join(dir, ".metistry", "connections", `${CONN}.yaml`), `name: ${CONN}\ntype: calendar\nprovider: caldav\nreach:\n  http:\n    url: ${dav.url}\n    auth: { scheme: basic, username: ${USER}, secret: caldav_password }\nsecrets: [caldav_password]\n`);
    writeFileSync(join(dir, ".metistry", "connections", `${FEED}.yaml`), `name: ${FEED}\ntype: calendar\nprovider: ics\nreach:\n  http:\n    url: https://calendar.example.com/feed.ics\n`);
    writeFileSync(join(dir, ".metistry", "secrets.yaml"), `secrets:\n  caldav_password:\n    hosts: ["${dav.host}"]\n    grants: { "connection:${CONN}": on }\n`);
    // the CalDAV sync writes the account's events, and raises the invitations (the collectors' own tests prove how)
    await caldavSync(pool, { openSync: instanceSyncOpener({ instanceDir: dir, seedDir: SEED, extensions: false, env: ENV }), ownerTimeZone: "America/New_York", now: () => NOW });
    // the same meeting on the Mac's calendar, and one only a feed holds
    const row = (connection: string, eventId: string, uid: string) =>
      pool.query(
        `INSERT INTO calendar_events (connection, event_id, ical_uid, starts_at, ends_at, title, organizer, attendees, self_status)
         VALUES ($1, $2, $3, '2026-09-29T18:00:00Z', '2026-09-29T19:00:00Z', 'Vendor review', 'dana@example.com', $4::jsonb, 'pending')`,
        [connection, eventId, uid, JSON.stringify([{ name: "Dana", email: "dana@example.com", status: "accepted", role: "chair", type: "person", self: false }, { name: "Me", email: USER, status: "pending", role: "required", type: "person", self: true }])],
      );
    await row(MAC, `EK-${suffix}`, UID);
    await row(MAC, `EK-only-${suffix}`, `mac-only-${suffix}@example.com`);
    await row(FEED, `feed-only-${suffix}`, `feed-only-${suffix}@example.com`);

    const calendars = calendarRsvpOpener({ instanceDir: dir, seedDir: SEED, extensions: false, env: ENV });
    const serve = async (withCalendars: boolean) => {
      const inboxDir = mkdtempSync(join(tmpdir(), "metistry-rsvp-inbox-"));
      dirs.push(inboxDir);
      const s = makeServer(pool, queries, { origin: "http://127.0.0.1:0", inboxDir, policy, secureCookies: false, localOwner: { token: localOwnerToken, trusted: [] }, ...(withCalendars ? { calendars } : {}) });
      await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
      return { s, url: `http://127.0.0.1:${(s.address() as AddressInfo).port}` };
    };
    ({ s: server, url: base } = await serve(true));
    ({ s: bareServer, url: bare } = await serve(false));
    const pkId = `${MARK}-${mintToken(8)}`;
    passkeyIds.push(pkId);
    await store.storePasskey(pool, { id: pkId, publicKey: new Uint8Array([1]), signCount: 0, transports: [], origin: "t", label: MARK });
    sessionCookie = `metistry_session=${await store.issueSession(pool, pkId, policy)}`;
    ownerToken = await store.mintOwnerToken(pool, MARK);
    agentToken = (await agents.createAgent(pool, { id: agentId, display_name: "itest rsvp" })).token;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM proposals WHERE kind = 'invitation' AND (payload->>'connection' = ANY($1) OR source->>'external_ref' LIKE $2)`, [[CONN, MAC, FEED], `%${suffix}%`]);
    await pool.query(`DELETE FROM calendar_events WHERE connection = ANY($1)`, [[CONN, MAC, FEED]]);
    await pool.query(`DELETE FROM sync_state WHERE connection = $1`, [CONN]);
    await pool.query(`DELETE FROM runs WHERE component = 'console' AND kind = 'invitation_respond' AND meta->>'event_id' LIKE $1`, [`%${suffix}%`]);
    await pool.query(`DELETE FROM agents WHERE id = $1`, [agentId]);
    await pool.query(`DELETE FROM owner_tokens WHERE label = $1`, [MARK]).catch(() => undefined);
    await pool.query(`DELETE FROM auth_sessions WHERE passkey_id = ANY($1)`, [passkeyIds]).catch(() => undefined);
    await pool.query(`DELETE FROM passkeys WHERE id = ANY($1)`, [passkeyIds]).catch(() => undefined);
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => bareServer.close(() => r()));
    await dav.close();
    await pool.end();
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  describe("who may answer (U2)", () => {
    it("no credential is the uniform 401, and the calendar hears nothing", async () => {
      const before = dav.requests.length;
      expect((await post(UID2, { response: "accepted" }, {})).status).toBe(401);
      expect(dav.requests.length).toBe(before);
    });

    it("an agent bearer is refused 403 — nothing is sent", async () => {
      const before = dav.requests.length;
      expect((await post(UID2, { response: "accepted" }, { authorization: `Bearer ${agentToken}` })).status).toBe(403);
      expect(dav.requests.length).toBe(before);
    });

    it("the capture owner token is refused 403 — capture is its whole reach", async () => {
      const before = dav.requests.length;
      expect((await post(UID2, { response: "accepted" }, { authorization: `Bearer ${ownerToken}` })).status).toBe(403);
      expect(dav.requests.length).toBe(before);
    });

    it("the local owner token reaches it, and so does a passkey session", async () => {
      const r = await post(UID2, { response: "declined" });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body).toMatchObject({ ok: true, event_id: UID2, response: "declined", connection: CONN, responded: false });
      const s = await post(UID2, { response: "declined" }, { cookie: sessionCookie });
      expect(s.status, JSON.stringify(s.body)).toBe(200);
    });
  });

  it("**is refused without an rsvp capability** — the Mac's calendar alone, a feed, or no calendars here — 503 with Open in Calendar, and nothing is sent", async () => {
    const before = dav.requests.length;
    for (const id of [`EK-only-${suffix}`, `feed-only-${suffix}`]) {
      const r = await post(id, { response: "accepted" });
      expect(r.status, id).toBe(503);
      expect(r.body).toMatchObject({ error: { code: "not_available" }, reason: "no_rsvp", open_in_calendar: true });
    }
    const none = await post(UID, { response: "accepted" }, local, bare);
    expect(none.status).toBe(503);
    expect(none.body).toMatchObject({ reason: "no_rsvp", open_in_calendar: true });
    expect(dav.requests.length).toBe(before);
    expect((await pool.query(`SELECT meta->>'outcome' AS outcome FROM runs WHERE component = 'console' AND kind = 'invitation_respond' AND meta->>'event_id' = $1`, [`feed-only-${suffix}`])).rows).toEqual([{ outcome: "no_rsvp" }]);
  });

  it("previews through the calendar that can — from the Mac's copy of the meeting — then answers exactly as previewed, and the card clears", async () => {
    expect(await mirror(UID)).toEqual([{ decision: "pending", cleared: null }]);
    const p = await post(`EK-${suffix}`, { response: "accepted" });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body).toMatchObject({
      ok: true,
      event_id: `EK-${suffix}`,
      response: "accepted",
      connection: CONN,
      preview: { event_id: `EK-${suffix}`, connection: CONN, title: "Vendor review", response: "accepted", organizer: "dana@example.com", as: USER, unchanged: false },
      expires_in_sec: 300,
      responded: false,
    });
    expect(typeof p.body.confirm_token).toBe("string");
    expect(writes()).toHaveLength(0); // a preview writes nothing

    // the token confirms only what it previewed: another answer is stale, and the token survives it
    const other = await post(`EK-${suffix}`, { response: "declined", confirm_token: p.body.confirm_token });
    expect(other.status).toBe(409);
    expect(other.body.reason).toBe("stale");
    expect(writes()).toHaveLength(0);

    const c = await post(`EK-${suffix}`, { response: "accepted", confirm_token: p.body.confirm_token });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(c.body).toEqual({ ok: true, event_id: `EK-${suffix}`, response: "accepted", connection: CONN, responded: true, unchanged: false, cleared: 1 });
    expect(dav.replies).toContainEqual({ uid: UID, partstat: "ACCEPTED", to: "dana@example.com" });
    expect(writes()).toHaveLength(1);
    expect(await mirror(UID)).toEqual([{ decision: "resolved_at_source", cleared: { what: "You accepted — the reply went to the organizer", where: "calendar" } }]);
    expect((await pool.query(`SELECT self_status FROM calendar_events WHERE connection = $1 AND ical_uid = $2`, [CONN, UID])).rows).toEqual([{ self_status: "accepted" }]);

    // spent: the same token again is stale, and nothing more is written
    const again = await post(`EK-${suffix}`, { response: "accepted", confirm_token: p.body.confirm_token });
    expect(again.status).toBe(409);
    expect(writes()).toHaveLength(1);
    // the audit rows name the event and the outcome — never the title or an address
    const audit = (await pool.query(`SELECT tool, meta FROM runs WHERE component = 'console' AND kind = 'invitation_respond' AND meta->>'event_id' = $1 ORDER BY id`, [`EK-${suffix}`])).rows;
    expect(audit.map((r) => [r.tool, r.meta.outcome])).toEqual([["preview", "previewed"], ["confirm", "stale_token"], ["confirm", "responded"], ["confirm", "stale_token"]]);
    expect(JSON.stringify(audit)).not.toMatch(/Vendor review|dana@example\.com|me@example\.com/);
    expect(JSON.stringify(audit)).not.toContain(INVITE_BODY);
  });

  it("an event that changed on the server since the preview is 409 stale — nothing overwritten", async () => {
    const p = await post(UID2, { response: "tentative" });
    expect(p.status).toBe(200);
    dav.touch("/calendars/me/work/review-2.ics");
    const before = writes().length;
    const c = await post(UID2, { response: "tentative", confirm_token: p.body.confirm_token });
    expect(c.status).toBe(409);
    expect(c.body).toMatchObject({ error: { code: "conflict" }, reason: "stale" });
    expect(writes().length).toBe(before);
  });

  it("refuses a body that says more than the answer, an answer that is not one, an unknown event", async () => {
    const before = dav.requests.length;
    expect((await post(UID2, { response: "accepted", to: "someone@else.example" })).status).toBe(400);
    expect((await post(UID2, { response: "maybe" })).body).toMatchObject({ error: { code: "invalid_request" }, reason: "bad_request" });
    expect((await post(UID2, { response: "accepted", confirm_token: "" })).status).toBe(400);
    expect((await post(`nope-${suffix}`, { response: "accepted" })).status).toBe(404);
    expect((await post(UID2, { response: "accepted", confirm_token: "never-minted" })).status).toBe(409);
    expect(dav.requests.length).toBe(before);
  });
});
