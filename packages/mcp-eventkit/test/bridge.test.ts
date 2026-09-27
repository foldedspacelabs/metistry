// Wire-contract tests with a scripted fake helper. Real EventKit is
// verified live (it needs the TCC grant on this Mac).
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mintToken } from "@foldedspacelabs/metistry-core";
import { makeBridge } from "../src/index.js";
import type { Helper, HelperResponse } from "../src/helper.js";
import { bridgeEvent, eventKey, selfStatus } from "../src/events.js";

const token = mintToken();
const created: any[] = [];
/** Every request the bridge made of the helper — to prove what it never asks for. */
const asked: Record<string, unknown>[] = [];
/** What the scripted helper answers `list_events` with; a test may replace it. */
let listed: HelperResponse = { id: 1, ok: true, events: [{ title: "standup" }] };
const fakeHelper = {
  async request(p: Record<string, unknown>): Promise<HelperResponse> {
    asked.push(p);
    if (p.op === "check") return { id: 1, ok: true, auth_events: "full_access", auth_reminders: "full_access", events_found: 3 };
    if (p.op === "list_events") return listed;
    if (p.op === "create_event" || p.op === "create_reminder") { created.push(p); return { id: 1, ok: true, created: { id: "x1" } }; }
    return { id: 1, ok: false, error: "nope" };
  },
  stop() {},
} as unknown as Helper;

describe("eventkit bridge wire contract", () => {
  let base: string;
  let server: ReturnType<typeof makeBridge>;
  const H = { authorization: `Bearer ${token}`, "content-type": "application/json" };

  beforeAll(async () => {
    server = makeBridge(fakeHelper, { token });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => new Promise<void>((r) => server.close(() => r())));

  it("refuses missing/wrong bearer uniformly (CRIT-9)", async () => {
    expect((await fetch(`${base}/check`)).status).toBe(401);
    expect((await fetch(`${base}/events`, { headers: { authorization: `Bearer ${mintToken()}` } })).status).toBe(401);
  });

  it("check() reports auth status in the frozen shape", async () => {
    const c = await (await fetch(`${base}/check`, { headers: H })).json();
    expect(c).toMatchObject({ name: "eventkit", status: "ok", meta: { events: "full_access" } });
  });

  it("reads events with an as_of stamp", async () => {
    const r = await (await fetch(`${base}/events?days=3`, { headers: H })).json();
    expect(r.events[0].title).toBe("standup");
    expect(r.as_of).toBeTruthy();
  });

  // §4.3 default 2: destructive tools preview first, execute only on confirm
  it("create is preview-then-confirm: no write without the token, token bound to the payload", async () => {
    const body = { title: "dentist", start: "2026-09-02T10:00:00Z", end: "2026-09-02T11:00:00Z" };
    const preview = await (await fetch(`${base}/events`, { method: "POST", headers: H, body: JSON.stringify(body) })).json();
    expect(preview.preview).toContain("dentist");
    expect(created).toHaveLength(0); // nothing written yet
    // tampered payload with a valid token → refused
    const tampered = await fetch(`${base}/events`, { method: "POST", headers: H, body: JSON.stringify({ ...body, title: "not dentist", confirm_token: preview.confirm_token }) });
    expect(tampered.status).toBe(409);
    expect(created).toHaveLength(0);
    // fresh preview + honest confirm → executes once; token is single-use
    const p2 = await (await fetch(`${base}/events`, { method: "POST", headers: H, body: JSON.stringify(body) })).json();
    const ok = await fetch(`${base}/events`, { method: "POST", headers: H, body: JSON.stringify({ ...body, confirm_token: p2.confirm_token }) });
    expect(ok.status).toBe(201);
    expect(created).toHaveLength(1);
    const replay = await fetch(`${base}/events`, { method: "POST", headers: H, body: JSON.stringify({ ...body, confirm_token: p2.confirm_token }) });
    expect(replay.status).toBe(409);
    expect(created).toHaveLength(1);
  });

  it("rejects malformed creates", async () => {
    expect((await fetch(`${base}/events`, { method: "POST", headers: H, body: JSON.stringify({ title: "x" }) })).status).toBe(400);
  });

  // ---- T2-11: the fields a calendar needs, and the one it must never hand on ----

  const standup = {
    id: "EK-SERIES-1:ABC",
    title: "Standup",
    start: "2026-09-28T13:30:00Z",
    end: "2026-09-28T13:45:00Z",
    all_day: false,
    location: "",
    calendar: "Work",
    attendees: ["Dana", "Matt"],
    participants: [
      { name: "Dana", email: "Dana@Example.com", status: "accepted", role: "required", type: "person", self: false },
      { name: "Matt", email: "me@example.com", status: "tentative", role: "required", type: "person", self: true },
    ],
    organizer: { name: "Dana", email: "Dana@Example.com", status: "accepted", role: "chair", type: "person", self: false },
    ical_uid: "abc@example.com",
    recurring: true,
    occurrence: "20260928T133000Z",
    notes: "Dial-in: 555-0100 pin 4242 — the confidential agenda",
  };

  it("serves the occurrence key, participants with address and status, organizer, series and the owner's answer", async () => {
    listed = { id: 1, ok: true, events: [standup], window: { start: "2026-09-28T04:00:00Z", end: "2026-10-12T04:00:00Z" } };
    const r = await (await fetch(`${base}/events?days=14`, { headers: H })).json();
    expect(r.window).toEqual({ start: "2026-09-28T04:00:00Z", end: "2026-10-12T04:00:00Z" });
    expect(r.events[0]).toMatchObject({
      id: "EK-SERIES-1:ABC",
      event_id: "EK-SERIES-1:ABC_20260928T133000Z",
      series_id: "EK-SERIES-1:ABC",
      ical_uid: "abc@example.com",
      attendees: ["Dana", "Matt"], // unchanged: names, which the routines read as strings
      organizer: { name: "Dana", email: "Dana@Example.com", self: false },
      self_status: "tentative",
    });
    expect(r.events[0].participants).toEqual([
      { name: "Dana", email: "Dana@Example.com", status: "accepted", role: "required", type: "person", self: false },
      { name: "Matt", email: "me@example.com", status: "tentative", role: "required", type: "person", self: true },
    ]);
  });

  it("**notes never reach an agent**: the bridge never asks the helper for them, and drops them if a helper sends them anyway", async () => {
    listed = { id: 1, ok: true, events: [standup], window: { start: "2026-09-28T04:00:00Z", end: "2026-09-29T04:00:00Z" } };
    asked.length = 0;
    // every spelling a caller might try: the route has no parameter that reaches the notes
    for (const q of ["days=1", "days=1&notes=true", "days=1&include=notes", "days=1&fields=notes"]) {
      const res = await fetch(`${base}/events?${q}`, { headers: H });
      const text = await res.text();
      expect(res.status, q).toBe(200);
      expect(text, q).not.toContain("notes");
      expect(text, q).not.toContain("Dial-in");
      expect(text, q).not.toContain("4242");
    }
    const lists = asked.filter((p) => p.op === "list_events");
    expect(lists).toHaveLength(4);
    for (const p of lists) expect(Object.keys(p).sort()).toEqual(["days", "op"]);
    expect("notes" in bridgeEvent(standup)).toBe(false);
  });

  it("an older helper (no window, no participants) is still served — the routines keep working — and says it has no window", async () => {
    listed = { id: 1, ok: true, events: [{ id: "EK-2", title: "Dentist", start: "2026-09-28T15:00:00Z", end: "2026-09-28T16:00:00Z", all_day: false, location: "", calendar: "Home", attendees: [] }] };
    const r = await (await fetch(`${base}/events?days=1`, { headers: H })).json();
    expect(r.window).toBeUndefined();
    expect(r.events[0]).toMatchObject({ event_id: "EK-2", series_id: null, participants: [], organizer: null, self_status: null, ical_uid: null });
  });
});

describe("the occurrence key and the owner's answer (events.ts)", () => {
  it("a one-off event is its identifier, so moving it keeps its note; an occurrence adds its original date", () => {
    expect(eventKey({ id: "A:1", recurring: false, occurrence: "20260928T133000Z" })).toBe("A:1");
    expect(eventKey({ id: "A:1" })).toBe("A:1");
    expect(eventKey({ id: "A:1", recurring: true, occurrence: "20260928T133000Z" })).toBe("A:1_20260928T133000Z");
    expect(eventKey({ id: "A:1", recurring: true, occurrence: "20260928" })).toBe("A:1_20260928"); // all-day: the local day
    expect(eventKey({ id: "A:1", recurring: true, occurrence: null })).toBe("A:1");
    expect(eventKey({ id: "" })).toBeNull();
    expect(eventKey({})).toBeNull();
    // two occurrences of one series are two keys, never one
    expect(eventKey({ id: "S", recurring: true, occurrence: "20260928T133000Z" })).not.toBe(eventKey({ id: "S", recurring: true, occurrence: "20261005T133000Z" }));
  });

  it("the owner's answer: their own participant row, else accepted as organizer, else nothing to answer", () => {
    const p = (self: boolean, status: string) => ({ name: null, email: null, status, role: "required", type: "person", self });
    expect(selfStatus([p(false, "accepted"), p(true, "declined")], null)).toBe("declined");
    expect(selfStatus([p(false, "accepted")], { ...p(true, "unknown") })).toBe("accepted");
    expect(selfStatus([p(false, "accepted")], p(false, "accepted"))).toBeNull();
    expect(selfStatus([], null)).toBeNull();
  });

  it("a status outside the vocabulary is `unknown`, never passed through", () => {
    const e = bridgeEvent({ id: "X", participants: [{ name: "Z", email: "z@x.io", status: "maybe-later" as string, self: false }] });
    expect(e.participants[0]!.status).toBe("unknown");
  });
});
