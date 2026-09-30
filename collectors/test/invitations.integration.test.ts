// Invitation requests (T4-17; R7, C108) against the real (scratch) database:
// a meeting the owner has not answered, organised by someone else, raises
// ONE `invitation` mirror — per meeting, whichever calendars hold it — and
// the mirror clears, with a receipt, when the source changes: answered,
// cancelled, passed. Respond goes through a connection that declares `rsvp`
// and is refused, before anything is sent, where none does.
//
// Every row here is under connection names of this run's own, and every
// meeting a UID of its own, so a concurrent suite's calendar is never these.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { mintToken } from "@foldedspacelabs/metistry-core";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";
import {
  CALENDAR_SOURCE_KIND,
  INVITATION_KIND,
  RespondRefused,
  confirmInvitationReply,
  invitationState,
  previewInvitationReply,
  reconcileInvitations,
  type OpenedRsvp,
  type RsvpOpener,
} from "../invitations.js";

const { hasDb } = loadTestEnv(new URL("../../.env", import.meta.url)); // METISTRY_DB_* only (docs/ops/testing.md)
const suffix = mintToken(6).toLowerCase().replaceAll(/[^a-z0-9]/g, "").slice(0, 6) || "x";
const MAC = `itest-inv-mac-${suffix}`;
const DAV = `itest-inv-dav-${suffix}`;
const FEED = `itest-inv-ics-${suffix}`;
const uid = (n: string) => `${n}-${suffix}@example.com`;
const NOW = Date.parse("2026-09-28T12:00:00Z");
const HOUR = 3_600_000;

const ME = { name: "Me", email: "me@example.com", status: "pending", role: "required", type: "person", self: true };
const DANA = { name: "Dana Scully", email: "dana@example.com", status: "accepted", role: "chair", type: "person", self: false };
const FOX = { name: "Fox Mulder", email: "fox@example.com", status: "tentative", role: "required", type: "person", self: false };

interface Ev {
  connection?: string;
  event_id?: string;
  ical_uid?: string | null;
  series_id?: string | null;
  title?: string;
  start?: number;
  organizer?: string | null;
  attendees?: unknown[];
  self_status?: string | null;
}

describe("an invitation's state, from the rows (pure)", () => {
  const row = (o: Ev) => ({
    connection: o.connection ?? DAV,
    event_id: o.event_id ?? "e",
    ical_uid: o.ical_uid ?? "u",
    series_id: o.series_id ?? null,
    title: o.title ?? "Vendor review",
    starts_at: new Date(o.start ?? NOW + 24 * HOUR),
    ends_at: new Date((o.start ?? NOW + 24 * HOUR) + HOUR),
    all_day: false,
    location: null,
    organizer: o.organizer === undefined ? "dana@example.com" : o.organizer,
    attendees: o.attendees ?? [DANA, ME, FOX],
    self_status: o.self_status === undefined ? "pending" : o.self_status,
  });

  it("waits while the owner's answer is needs-action and someone else organises it — and says what happened when not", () => {
    expect(invitationState([row({})], NOW).waiting).toBe(true);
    expect(invitationState([], NOW)).toMatchObject({ waiting: false, receipt: "No longer on your calendar" });
    expect(invitationState([row({ start: NOW - 3 * HOUR })], NOW)).toMatchObject({ waiting: false, receipt: "The meeting has passed" });
    expect(invitationState([row({ self_status: "accepted" })], NOW)).toMatchObject({ waiting: false, receipt: "You accepted it in your calendar" });
    expect(invitationState([row({ self_status: "declined" })], NOW).receipt).toBe("You declined it in your calendar");
    expect(invitationState([row({ self_status: "tentative" })], NOW).receipt).toBe("You said maybe in your calendar");
    // an answer on any calendar wins over a slower one still saying needs-action
    expect(invitationState([row({ connection: MAC }), row({ self_status: "accepted" })], NOW).waiting).toBe(false);
    // R7: the source must name the owner — no `self` attendee (an ICS feed) asks nothing; nor does the owner's own meeting
    expect(invitationState([row({ attendees: [DANA, { ...ME, self: false }] })], NOW).waiting).toBe(false);
    expect(invitationState([row({ organizer: "me@example.com" })], NOW).waiting).toBe(false);
    expect(invitationState([row({ organizer: null })], NOW).waiting).toBe(false);
  });
});

describe.skipIf(!hasDb)("invitation requests (T4-17, real db)", () => {
  let pool: pg.Pool;

  async function put(o: Ev): Promise<void> {
    const start = o.start ?? NOW + 24 * HOUR;
    await pool.query(
      `INSERT INTO calendar_events (connection, event_id, ical_uid, series_id, starts_at, ends_at, title, organizer, attendees, self_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
       ON CONFLICT (connection, event_id) DO UPDATE SET self_status = EXCLUDED.self_status, starts_at = EXCLUDED.starts_at, ends_at = EXCLUDED.ends_at, attendees = EXCLUDED.attendees, organizer = EXCLUDED.organizer`,
      [
        o.connection ?? DAV,
        o.event_id ?? o.ical_uid ?? "e",
        o.ical_uid === undefined ? null : o.ical_uid,
        o.series_id ?? null,
        new Date(start).toISOString(),
        new Date(start + HOUR).toISOString(),
        o.title ?? "Vendor review",
        o.organizer === undefined ? "dana@example.com" : o.organizer,
        JSON.stringify(o.attendees ?? [DANA, ME, FOX]),
        o.self_status === undefined ? "pending" : o.self_status,
      ],
    );
  }
  const drop = (connection: string, eventId: string) => pool.query(`DELETE FROM calendar_events WHERE connection = $1 AND event_id = $2`, [connection, eventId]);
  const pass = (connection: string, over: { raise?: boolean; rsvp?: boolean; now?: number } = {}) =>
    reconcileInvitations(pool, { component: connection === MAC ? "eventkit-calendar" : "caldav-calendar", connection, raise: over.raise ?? true, rsvp: over.rsvp ?? connection === DAV, zone: "America/New_York", now: over.now ?? NOW });
  const mirrors = async (u: string) =>
    (
      await pool.query(
        `SELECT id, decision, source_agent, trust, source, payload FROM proposals WHERE kind = $1 AND source->>'kind' = $2 AND source->>'external_ref' = $3 ORDER BY id`,
        [INVITATION_KIND, CALENDAR_SOURCE_KIND, `invite:uid/${u}`],
      )
    ).rows;
  const clean = async () => {
    await pool.query(`DELETE FROM calendar_events WHERE connection = ANY($1)`, [[MAC, DAV, FEED]]);
    await pool.query(`DELETE FROM proposals WHERE kind = $1 AND source->>'external_ref' LIKE $2`, [INVITATION_KIND, `invite:%${suffix}%`]);
  };

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
  });
  beforeEach(clean);
  afterAll(async () => {
    await clean();
    await pool.end();
  });

  it("raises one invitation per meeting the owner has not answered — the organizer named, from named fields only", async () => {
    await put({ ical_uid: uid("review"), event_id: uid("review") });
    expect(await pass(DAV)).toEqual({ raised: 1, cleared: 0 });
    const [m] = await mirrors(uid("review"));
    expect(m).toMatchObject({ decision: "pending", source_agent: "caldav-calendar", trust: "external", source: { kind: "calendar", external_ref: `invite:uid/${uid("review")}`, person: "dana@example.com" } });
    expect(m.payload).toMatchObject({
      title: "Vendor review",
      event: "invited",
      connection: DAV,
      event_id: uid("review"),
      ical_uid: uid("review"),
      organizer: { name: "Dana Scully", email: "dana@example.com" },
      others: 1,
      series: false,
      rsvp: true,
      summary: "Dana Scully invites you: Vendor review · Tue 29 Sep, 08:00–09:00 · 1 other invited",
    });
    // a second pass asks nothing new
    expect(await pass(DAV)).toEqual({ raised: 0, cleared: 0 });
    expect(await mirrors(uid("review"))).toHaveLength(1);
  });

  it("asks nothing the source does not ask of the owner: answered, organised by the owner, no owner named (a feed), past", async () => {
    await put({ ical_uid: uid("answered"), event_id: "a", self_status: "accepted" });
    await put({ ical_uid: uid("mine"), event_id: "b", organizer: "me@example.com" });
    await put({ connection: FEED, ical_uid: uid("feed"), event_id: "c", attendees: [DANA, { ...ME, self: false }], self_status: null });
    await put({ ical_uid: uid("past"), event_id: "d", start: NOW - 3 * HOUR });
    expect(await pass(DAV)).toEqual({ raised: 0, cleared: 0 });
    expect(await pass(FEED)).toEqual({ raised: 0, cleared: 0 });
    for (const n of ["answered", "mine", "feed", "past"]) expect(await mirrors(uid(n)), n).toEqual([]);
  });

  it("a series is one card; the same meeting on two calendars is one card with both askers on it", async () => {
    await put({ ical_uid: uid("standup"), event_id: `${uid("standup")}_1`, series_id: "S", start: NOW + 24 * HOUR });
    await put({ ical_uid: uid("standup"), event_id: `${uid("standup")}_2`, series_id: "S", start: NOW + 48 * HOUR });
    await put({ connection: MAC, ical_uid: uid("standup"), event_id: "EK-standup_1", series_id: "EKS", start: NOW + 24 * HOUR });
    expect(await pass(MAC)).toEqual({ raised: 1, cleared: 0 });
    expect(await pass(DAV)).toEqual({ raised: 0, cleared: 0 });
    const rows = await mirrors(uid("standup"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source_agent: "eventkit-calendar", payload: { connection: MAC, series: true, rsvp: false } });
    expect(rows[0].payload.also_asked).toEqual([expect.objectContaining({ source_agent: "caldav-calendar", trust: "external", title: "Vendor review" })]);
  });

  it("**a mirror clears when the source changes** — answered, cancelled, passed — each with a receipt", async () => {
    for (const n of ["answer", "cancel", "pass"]) await put({ ical_uid: uid(n), event_id: uid(n), start: n === "pass" ? NOW + HOUR : NOW + 24 * HOUR });
    expect(await pass(DAV)).toEqual({ raised: 3, cleared: 0 });

    await put({ ical_uid: uid("answer"), event_id: uid("answer"), self_status: "declined" });
    await drop(DAV, uid("cancel"));
    expect(await pass(DAV, { now: NOW + 3 * HOUR })).toEqual({ raised: 0, cleared: 3 });
    const receipt = async (n: string) => (await mirrors(uid(n))).map((r) => [r.decision, r.payload.cleared]);
    expect(await receipt("answer")).toEqual([["resolved_at_source", { what: "You declined it in your calendar", where: "calendar" }]]);
    expect(await receipt("cancel")).toEqual([["resolved_at_source", { what: "No longer on your calendar", where: "calendar" }]]);
    expect(await receipt("pass")).toEqual([["resolved_at_source", { what: "The meeting has passed", where: "calendar" }]]);

    // the organizer moves it and the answer goes back to needs-action: the source asks again
    await put({ ical_uid: uid("answer"), event_id: uid("answer"), self_status: "pending", start: NOW + 30 * HOUR });
    expect(await pass(DAV, { now: NOW + 3 * HOUR })).toEqual({ raised: 1, cleared: 0 });
    expect((await mirrors(uid("answer"))).map((r) => r.decision)).toEqual(["resolved_at_source", "pending"]);
  });

  it("an answer on one calendar clears the card another raised; with the rule off nothing is raised, and still it clears", async () => {
    await put({ connection: MAC, ical_uid: uid("both"), event_id: "EK-both" });
    await put({ ical_uid: uid("both"), event_id: uid("both") });
    expect(await pass(MAC)).toEqual({ raised: 1, cleared: 0 });
    await put({ ical_uid: uid("both"), event_id: uid("both"), self_status: "tentative" });
    expect(await pass(DAV, { raise: false })).toEqual({ raised: 0, cleared: 1 });
    expect((await mirrors(uid("both")))[0].payload.cleared).toEqual({ what: "You said maybe in your calendar", where: "calendar" });
    // the Mac's calendar still says needs-action: the answer elsewhere wins, and nothing is raised again
    expect(await pass(MAC)).toEqual({ raised: 0, cleared: 0 });

    await put({ ical_uid: uid("off"), event_id: uid("off") });
    expect(await pass(DAV, { raise: false })).toEqual({ raised: 0, cleared: 0 });
    expect(await mirrors(uid("off"))).toEqual([]);
  });

  it("one the owner put down here (Skip) is not raised again while it waits", async () => {
    await put({ ical_uid: uid("skip"), event_id: uid("skip") });
    await pass(DAV);
    await pool.query(`UPDATE proposals SET decision = 'deny', decided_at = now() WHERE kind = $1 AND source->>'external_ref' = $2`, [INVITATION_KIND, `invite:uid/${uid("skip")}`]);
    expect(await pass(DAV)).toEqual({ raised: 0, cleared: 0 });
    expect((await mirrors(uid("skip"))).map((r) => r.decision)).toEqual(["deny"]);
  });

  describe("Respond — through the connection that can", () => {
    const sent: { connection: string; op: string; target: string; response: string; etag?: string }[] = [];
    const opener =
      (can: Record<string, true | "absent" | "no_capability">): RsvpOpener =>
      async (connection) => {
        const how = can[connection] ?? "absent";
        if (how === true) {
          return {
            ok: true,
            rsvp: {
              connection,
              provider: "caldav",
              targetOf: (row) => row.ical_uid,
              preview: async (req) => (sent.push({ connection, op: "preview", target: req.target, response: req.response }), { title: "Vendor review", organizer: "dana@example.com", as: "me@example.com", etag: '"e1"', unchanged: false }),
              respond: async (req) => (sent.push({ connection, op: "respond", target: req.target, response: req.response, etag: req.etag }), { unchanged: false }),
              secretsUsed: () => ["caldav_password"],
            },
          } satisfies OpenedRsvp;
        }
        return { ok: false, status: how === "no_capability" ? "no_capability" : "absent", why: `${connection} cannot` };
      };

    beforeEach(() => {
      sent.length = 0;
    });

    it("**is refused without an rsvp capability** — an event only the Mac's calendar or a feed holds — and nothing is sent", async () => {
      await put({ connection: MAC, ical_uid: uid("rsvp"), event_id: "EK-rsvp" });
      const e = await previewInvitationReply(pool, opener({ [MAC]: "absent", [FEED]: "no_capability" }), { event_id: "EK-rsvp", response: "accepted" }).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(RespondRefused);
      expect(e).toMatchObject({ code: "no_rsvp" });
      expect((e as Error).message).toMatch(/open it in Calendar/);
      expect(sent).toEqual([]);
      // an event with no UID cannot be asked about anywhere
      await put({ connection: DAV, ical_uid: null, event_id: `nouid-${suffix}` });
      expect(await previewInvitationReply(pool, opener({ [DAV]: true }), { event_id: `nouid-${suffix}`, response: "accepted" }).catch((x: RespondRefused) => x.code)).toBe("no_rsvp");
      expect(sent).toEqual([]);
    });

    it("finds the calendar that can — the same meeting on the CalDAV account — previews, then answers and clears the card", async () => {
      await put({ connection: MAC, ical_uid: uid("rsvp"), event_id: "EK-rsvp" });
      await put({ connection: DAV, ical_uid: uid("rsvp"), event_id: uid("rsvp") });
      await pass(MAC);
      const open = opener({ [MAC]: "absent", [DAV]: true });
      const p = await previewInvitationReply(pool, open, { event_id: "EK-rsvp", response: "tentative" });
      expect(p).toMatchObject({ event_id: "EK-rsvp", connection: DAV, title: "Vendor review", response: "tentative", organizer: "dana@example.com", as: "me@example.com", unchanged: false, secrets: ["caldav_password"] });
      expect(p.binding).toEqual({ event_id: "EK-rsvp", connection: DAV, target: uid("rsvp"), response: "tentative", etag: '"e1"', subject_ref: `invite:uid/${uid("rsvp")}`, rows: { ical_uid: uid("rsvp"), event_id: uid("rsvp") } });
      expect(sent).toEqual([{ connection: DAV, op: "preview", target: uid("rsvp"), response: "tentative" }]);

      const done = await confirmInvitationReply(pool, open, p.binding);
      expect(sent.at(-1)).toEqual({ connection: DAV, op: "respond", target: uid("rsvp"), response: "tentative", etag: '"e1"' });
      expect(done.cleared).toHaveLength(1);
      const [m] = await mirrors(uid("rsvp"));
      expect(m.decision).toBe("resolved_at_source");
      expect(m.payload.cleared).toEqual({ what: "You said maybe — the reply went to the organizer", where: "calendar" });
      // the answering calendar's rows take the answer at once, so the Mac's slower "needs-action" raises nothing
      expect((await pool.query(`SELECT self_status FROM calendar_events WHERE connection = $1`, [DAV])).rows).toEqual([{ self_status: "tentative" }]);
      expect(await pass(MAC)).toEqual({ raised: 0, cleared: 0 });
    });

    it("refuses an answer that is not one, and an event no calendar holds", async () => {
      await put({ connection: DAV, ical_uid: uid("rsvp"), event_id: uid("rsvp") });
      expect(await previewInvitationReply(pool, opener({ [DAV]: true }), { event_id: uid("rsvp"), response: "maybe" }).catch((x: RespondRefused) => x.code)).toBe("bad_request");
      expect(await previewInvitationReply(pool, opener({ [DAV]: true }), { event_id: `nope-${suffix}`, response: "accepted" }).catch((x: RespondRefused) => x.code)).toBe("not_found");
      expect(sent).toEqual([]);
    });
  });
});
