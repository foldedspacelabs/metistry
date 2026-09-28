// `POST /events/move` (T2-12; design-build-plan §2.11 "Move a meeting", B10)
// with a scripted fake helper — real EventKit is verified live on a Mac with
// the TCC grant, never here.
//
// The ticket's own test, bold in its Tests line: **the engine's own confirm
// is refused for an event with attendees** — the assistant reaches this
// bridge with the bearer alone, so a confirm without the owner-door token
// never moves an event with others in it. And its Accept: an owner-only
// event moves without the warning.
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mintToken } from "@foldedspacelabs/metistry-core";
import { makeBridge } from "../src/index.js";
import type { Helper, HelperResponse } from "../src/helper.js";
import type { HelperEvent, HelperParticipant } from "../src/events.js";
import { OWNER_DOOR_HEADER, canonicalInstant, checkMovable, eventFingerprint, moveKey, othersIn, parseMove } from "../src/move.js";
import { bridgeEvent } from "../src/events.js";

const token = mintToken();
const doorToken = mintToken();

const me: HelperParticipant = { name: "Matt", email: "me@example.com", status: "accepted", role: "chair", type: "person", self: true };
const dana: HelperParticipant = { name: "Dana", email: "dana@example.com", status: "accepted", role: "required", type: "person", self: false };

const focus: HelperEvent = {
  id: "EK-FOCUS",
  title: "Focus block",
  start: "2026-09-28T14:00:00Z",
  end: "2026-09-28T15:00:00Z",
  all_day: false,
  location: "",
  calendar: "Home",
  attendees: [],
  participants: [],
  organizer: null,
  recurring: false,
  occurrence: null,
  writable: true,
  notes: "private scratch — never served",
};
const oneOnOne: HelperEvent = {
  ...focus,
  id: "EK-SERIES",
  title: "1:1 with Dana",
  calendar: "Work",
  attendees: ["Matt", "Dana"],
  participants: [me, dana],
  organizer: me,
  recurring: true,
  occurrence: "20260928T140000Z",
  notes: "Dial-in 555-0100 pin 4242",
};
const ONE_ON_ONE = "EK-SERIES_20260928T140000Z";

/** The calendar the fake helper holds, by occurrence key; a test may change it between preview and confirm. */
let calendar: Map<string, HelperEvent>;
/** Every request the bridge made of the helper. */
const asked: Record<string, unknown>[] = [];
const moved: Record<string, unknown>[] = [];
let moveFails = false;

const key = (e: HelperEvent) => (e.recurring && e.occurrence ? `${e.id}_${e.occurrence}` : e.id!);
const fakeHelper = {
  async request(p: Record<string, unknown>): Promise<HelperResponse> {
    asked.push(p);
    if (p.op === "get_event") return { id: 1, ok: true, event: calendar.get(String(p.event_id)) ?? null };
    if (p.op === "move_event") {
      if (moveFails) return { id: 1, ok: false, error: "the event's calendar is read-only" };
      const e = calendar.get(String(p.event_id))!;
      const next = { ...e, start: String(p.start), end: String(p.end) };
      calendar.set(String(p.event_id), next);
      moved.push(p);
      return { id: 1, ok: true, moved: next };
    }
    return { id: 1, ok: false, error: "nope" };
  },
} as unknown as Helper;

async function serve(ownerDoorToken?: string) {
  const server = makeBridge(fakeHelper, { token, ...(ownerDoorToken ? { ownerDoorToken } : {}) });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

describe("move_event over the wire", () => {
  let base: string;
  let bare: string; // a bridge started with no owner-door token at all
  let servers: Awaited<ReturnType<typeof serve>>["server"][] = [];
  const to = { start: "2026-09-28T16:00:00Z", end: "2026-09-28T17:00:00Z" };

  /** The assistant's call: the bearer, nothing else. */
  const asEngine = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  /** The console's owner door: the bearer and the owner-door token. */
  const asOwnerDoor = { ...asEngine, [OWNER_DOOR_HEADER]: doorToken };

  const post = (body: unknown, headers: Record<string, string> = asEngine, at = base) =>
    fetch(`${at}/events/move`, { method: "POST", headers, body: JSON.stringify(body) });
  const preview = async (eventId: string, headers: Record<string, string> = asEngine, at = base) => {
    const r = await post({ event_id: eventId, ...to }, headers, at);
    expect(r.status).toBe(200);
    return (await r.json()) as Record<string, any>;
  };

  beforeAll(async () => {
    const a = await serve(doorToken);
    const b = await serve();
    servers = [a.server, b.server];
    base = a.base;
    bare = b.base;
  });
  afterAll(async () => {
    for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
  });
  beforeEach(() => {
    calendar = new Map([focus, oneOnOne].map((e) => [key(e), { ...e }]));
    asked.length = 0;
    moved.length = 0;
    moveFails = false;
  });

  it("no bearer, or a wrong one, is the uniform 401 — the owner-door token alone is not a credential", async () => {
    expect((await post({ event_id: "EK-FOCUS", ...to }, { "content-type": "application/json" })).status).toBe(401);
    expect((await post({ event_id: "EK-FOCUS", ...to }, { authorization: `Bearer ${mintToken()}` })).status).toBe(401);
    expect((await post({ event_id: "EK-FOCUS", ...to }, { [OWNER_DOOR_HEADER]: doorToken })).status).toBe(401);
    expect(asked).toHaveLength(0);
  });

  it("the preview names who is in it and the new time, writes nothing, and never carries the invite body", async () => {
    const r = await post({ event_id: ONE_ON_ONE, ...to });
    const text = await r.text();
    expect(r.status).toBe(200);
    expect(text).not.toContain("Dial-in");
    expect(text).not.toContain("notes");
    const p = JSON.parse(text);
    expect(p).toMatchObject({ others: 1, owner_door_required: true, to, expires_in_sec: 300 });
    expect(p.event).toMatchObject({ event_id: ONE_ON_ONE, title: "1:1 with Dana", start: oneOnOne.start, end: oneOnOne.end });
    expect(p.event.participants.map((x: { name: string }) => x.name)).toEqual(["Matt", "Dana"]);
    expect(p.preview).toContain("1 other person in it will see the new time: Dana");
    expect(p.preview).toContain(to.start);
    expect(typeof p.confirm_token).toBe("string");
    expect(moved).toHaveLength(0);
    // the helper was asked for the one event, and never for its notes
    expect(asked).toEqual([{ op: "get_event", event_id: ONE_ON_ONE }]);
  });

  it("**the engine's own confirm is refused for an event with attendees** — 403, nothing moved", async () => {
    const p = await preview(ONE_ON_ONE);
    const r = await post({ event_id: ONE_ON_ONE, ...to, confirm_token: p.confirm_token });
    expect(r.status).toBe(403);
    expect((await r.json()).error.code).toBe("forbidden");
    expect(moved).toHaveLength(0);
    expect(calendar.get(ONE_ON_ONE)!.start).toBe(oneOnOne.start);
    // the refused confirm spent the token: the owner-door cannot ride on it afterwards
    expect((await post({ event_id: ONE_ON_ONE, ...to, confirm_token: p.confirm_token }, asOwnerDoor)).status).toBe(409);
    expect(moved).toHaveLength(0);
  });

  it("…and so is a confirm with a wrong owner-door token, or with the bearer repeated in the owner-door header", async () => {
    for (const door of [mintToken(), token, ""]) {
      const p = await preview(ONE_ON_ONE);
      const r = await post({ event_id: ONE_ON_ONE, ...to, confirm_token: p.confirm_token }, { ...asEngine, [OWNER_DOOR_HEADER]: door });
      expect(r.status, JSON.stringify(door)).toBe(403);
    }
    expect(moved).toHaveLength(0);
  });

  it("…and a bridge started with no owner-door token never confirms one, whoever asks (fail closed)", async () => {
    const p = await preview(ONE_ON_ONE, asOwnerDoor, bare);
    const r = await post({ event_id: ONE_ON_ONE, ...to, confirm_token: p.confirm_token }, asOwnerDoor, bare);
    expect(r.status).toBe(403);
    expect(moved).toHaveLength(0);
  });

  it("the owner door's confirm moves an event with others in it — this occurrence, to the previewed time, once", async () => {
    const p = await preview(ONE_ON_ONE, asOwnerDoor);
    const r = await post({ ...to, event_id: ONE_ON_ONE, confirm_token: p.confirm_token }, asOwnerDoor); // key order is not the payload
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toMatchObject({ moved: { event_id: ONE_ON_ONE, start: to.start, end: to.end }, others: 1 });
    expect(JSON.stringify(body)).not.toContain("Dial-in");
    expect(moved).toEqual([{ op: "move_event", event_id: ONE_ON_ONE, start: to.start, end: to.end }]);
    // single-use
    expect((await post({ event_id: ONE_ON_ONE, ...to, confirm_token: p.confirm_token }, asOwnerDoor)).status).toBe(409);
    expect(moved).toHaveLength(1);
  });

  it("an owner-only event moves on the bearer's confirm, and its preview carries no warning (Accept)", async () => {
    const p = await preview("EK-FOCUS");
    expect(p).toMatchObject({ others: 0, owner_door_required: false });
    expect(p.preview).toContain("nobody else is in it");
    expect(p.preview).not.toContain("will see the new time");
    const r = await post({ event_id: "EK-FOCUS", ...to, confirm_token: p.confirm_token });
    expect(r.status).toBe(200);
    expect(moved).toHaveLength(1);
    expect(calendar.get("EK-FOCUS")).toMatchObject(to);
  });

  it("a confirm is bound to the move it previewed: another time, another event, or no preview at all is 409", async () => {
    const p = await preview("EK-FOCUS");
    expect((await post({ event_id: "EK-FOCUS", start: to.start, end: "2026-09-28T18:00:00Z", confirm_token: p.confirm_token })).status).toBe(409);
    const q = await preview("EK-FOCUS");
    expect((await post({ event_id: ONE_ON_ONE, ...to, confirm_token: q.confirm_token }, asOwnerDoor)).status).toBe(409);
    expect((await post({ event_id: "EK-FOCUS", ...to, confirm_token: mintToken() })).status).toBe(409);
    expect(moved).toHaveLength(0);
  });

  it("a guest added after an owner-only preview is counted at the confirm: the engine's confirm is then refused", async () => {
    const p = await preview("EK-FOCUS");
    calendar.set("EK-FOCUS", { ...focus, participants: [me, dana], organizer: me });
    const r = await post({ event_id: "EK-FOCUS", ...to, confirm_token: p.confirm_token });
    expect(r.status).toBe(403);
    expect(moved).toHaveLength(0);
  });

  it("an event that changed since the preview — its time or who is in it — is 409 with the event as it stands, even at the owner door", async () => {
    const p = await preview(ONE_ON_ONE, asOwnerDoor);
    calendar.set(ONE_ON_ONE, { ...oneOnOne, start: "2026-09-28T14:30:00Z" });
    const r = await post({ event_id: ONE_ON_ONE, ...to, confirm_token: p.confirm_token }, asOwnerDoor);
    expect(r.status).toBe(409);
    const body = await r.json();
    expect(body.error.code).toBe("conflict");
    expect(body.event.start).toBe("2026-09-28T14:30:00Z");
    expect(JSON.stringify(body)).not.toContain("Dial-in");
    expect(moved).toHaveLength(0);
  });

  it("a meeting someone else organises is one with others in it: the preview names them, and only the owner door confirms it", async () => {
    calendar.set(ONE_ON_ONE, { ...oneOnOne, organizer: dana, participants: [{ ...me, role: "required" }, { ...dana, role: "chair" }] });
    const p = await preview(ONE_ON_ONE);
    expect(p).toMatchObject({ others: 1, owner_door_required: true });
    expect((await post({ event_id: ONE_ON_ONE, ...to, confirm_token: p.confirm_token })).status).toBe(403);
    const q = await preview(ONE_ON_ONE, asOwnerDoor);
    expect((await post({ event_id: ONE_ON_ONE, ...to, confirm_token: q.confirm_token }, asOwnerDoor)).status).toBe(200);
  });

  it("a read-only calendar is refused at the preview; an unknown key is 404; a calendar that refuses the save is 409", async () => {
    calendar.set("EK-FOCUS", { ...focus, writable: false });
    expect((await post({ event_id: "EK-FOCUS", ...to })).status).toBe(400);
    expect((await post({ event_id: "EK-NOPE", ...to })).status).toBe(404);
    calendar.set("EK-FOCUS", { ...focus });
    const p = await preview("EK-FOCUS");
    moveFails = true;
    expect((await post({ event_id: "EK-FOCUS", ...to, confirm_token: p.confirm_token })).status).toBe(409);
  });

  it("refuses malformed moves before asking the calendar anything", async () => {
    const bad: unknown[] = [
      {},
      [],
      { event_id: "EK-FOCUS" },
      { event_id: "EK-FOCUS", start: "tomorrow-ish", end: to.end },
      { event_id: "EK-FOCUS", start: to.end, end: to.start }, // backwards
      { event_id: "EK-FOCUS", start: to.start, end: to.start }, // zero length
      { event_id: " EK-FOCUS", ...to },
      { event_id: "EK\u0000FOCUS", ...to },
      { event_id: "x".repeat(1025), ...to },
      { event_id: "EK-FOCUS", ...to, title: "renamed" },
      { event_id: "EK-FOCUS", ...to, span: "future" },
      { event_id: "EK-FOCUS", ...to, confirm_token: 7 },
    ];
    for (const b of bad) expect((await post(b)).status, JSON.stringify(b)).toBe(400);
    const junk = await fetch(`${base}/events/move`, { method: "POST", headers: asEngine, body: "{not json" });
    expect(junk.status).toBe(400);
    expect(asked).toHaveLength(0);
  });

  it("refuses to start with the owner-door token equal to the bearer, or empty", () => {
    expect(() => makeBridge(fakeHelper, { token, ownerDoorToken: token })).toThrow(/differ from the bridge token/);
    expect(() => makeBridge(fakeHelper, { token, ownerDoorToken: "" })).toThrow(/differ from the bridge token/);
  });
});

describe("move.ts (pure)", () => {
  it("instants are canonical: second precision, UTC, whatever the offset they arrived in", () => {
    expect(canonicalInstant("2026-09-28T10:00:00-04:00")).toBe("2026-09-28T14:00:00Z");
    expect(canonicalInstant("2026-09-28T14:00:00.789Z")).toBe("2026-09-28T14:00:00Z");
    expect(canonicalInstant("soon")).toBeNull();
    expect(canonicalInstant(1790000000)).toBeNull();
  });

  it("the move key ignores body key order and binds the canonical instants", () => {
    const a = parseMove({ event_id: "E", start: "2026-09-28T10:00:00-04:00", end: "2026-09-28T15:00:00Z" });
    const b = parseMove({ end: "2026-09-28T15:00:00.000Z", start: "2026-09-28T14:00:00Z", event_id: "E" });
    expect(a.ok && b.ok && moveKey(a.move) === moveKey(b.move)).toBe(true);
  });

  it("others are counted fail-closed: every non-owner participant of any kind, plus an unlisted organizer, once", () => {
    const room: HelperParticipant = { name: "Room 4", email: null, status: "accepted", role: "non_participant", type: "room", self: false };
    expect(othersIn(bridgeEvent({ participants: [me] , organizer: me }))).toHaveLength(0);
    expect(othersIn(bridgeEvent({ participants: [me, room], organizer: me }))).toHaveLength(1); // a room is someone's booking
    expect(othersIn(bridgeEvent({ participants: [me, dana], organizer: { ...dana, email: "DANA@example.com" } }))).toHaveLength(1);
    expect(othersIn(bridgeEvent({ participants: [], organizer: dana }))).toHaveLength(1);
    expect(othersIn(bridgeEvent({}))).toHaveLength(0);
  });

  it("the fingerprint moves with the times and the people, not with the title or the answers' order", () => {
    const e = bridgeEvent(oneOnOne);
    expect(eventFingerprint(bridgeEvent({ ...oneOnOne, participants: [dana, me] }))).toBe(eventFingerprint(e));
    expect(eventFingerprint(bridgeEvent({ ...oneOnOne, title: "renamed" }))).toBe(eventFingerprint(e));
    expect(eventFingerprint(bridgeEvent({ ...oneOnOne, end: "2026-09-28T15:30:00Z" }))).not.toBe(eventFingerprint(e));
    expect(eventFingerprint(bridgeEvent({ ...oneOnOne, participants: [me] }))).not.toBe(eventFingerprint(e));
  });

  it("checkMovable: no event is not_found; the check never carries the notes", () => {
    expect(checkMovable(null)).toMatchObject({ ok: false, code: "not_found" });
    const c = checkMovable(oneOnOne);
    expect(c.ok && "notes" in c.event).toBe(false);
  });
});
