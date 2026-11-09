// The eventkit sync (design-build-plan §2.9, T2-11): the bridge's events into
// `calendar_events`. The mapping is pure and tested first; the window
// replacement needs the real (scratch) database, because "one statement, and
// a cancelled meeting inside the window goes while the past stays" is a claim
// about SQL. Skipped without a db.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";
import { EVENTKIT_CONNECTION, SYNC_DAYS, normaliseEmail, run, toRow } from "./run.js";

const { hasDb } = loadTestEnv(new URL("../../.env", import.meta.url)); // METISTRY_DB_* only (docs/ops/testing.md)

const WINDOW = { start: "2026-09-28T04:00:00.000Z", end: "2026-10-12T04:00:00.000Z" };
const NOTES = "Dial-in 555-0100, pin 4242 — the confidential agenda";

/** One event as the bridge serves it — including a `notes` field it never sends, to prove the sync would not keep one. */
function event(id: string, start: string, over: Record<string, unknown> = {}) {
  return {
    id: id.split("_")[0],
    event_id: id,
    title: `Meeting ${id}`,
    start,
    end: Number.isNaN(Date.parse(start)) ? start : new Date(Date.parse(start) + 30 * 60_000).toISOString(),
    all_day: false,
    location: "",
    calendar: "Work",
    attendees: ["Dana"],
    participants: [
      { name: "Dana", email: "MAILTO:Dana@Example.COM", status: "accepted", role: "required", type: "person", self: false },
      { name: "Me", email: "me@example.com", status: "pending", role: "required", type: "person", self: true },
      { name: "Room 4", email: null, status: "accepted", role: "non_participant", type: "room", self: false },
    ],
    organizer: { name: "Dana", email: "dana@example.com", status: "accepted", role: "chair", type: "person", self: false },
    ical_uid: `${id}@example.com`,
    series_id: null,
    self_status: "pending",
    notes: NOTES,
    ...over,
  };
}

/** A bridge that answers GET /events with these events, and records what it was asked. */
function bridge(events: unknown[], window: unknown = WINDOW, status = 200) {
  const asked: string[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    asked.push(`${url} ${(init?.headers as Record<string, string>)?.authorization ?? ""}`);
    return new Response(JSON.stringify({ events, ...(window ? { window } : {}), as_of: "2026-09-28T12:00:00.000Z" }), { status });
  }) as unknown as typeof fetch;
  return { fetchFn, asked };
}

describe("the eventkit sync's mapping (pure)", () => {
  it("normalises an address exactly as the walk does for people_emails — or drops it", () => {
    expect(normaliseEmail(" MAILTO:Jim@X.com ")).toBe("jim@x.com");
    expect(normaliseEmail("jim@x.com")).toBe("jim@x.com");
    for (const bad of ["Jim <jim@x.com>", "jim at x dot com", "jim@x", "", null, 42, `${"a".repeat(250)}@x.com`]) expect(normaliseEmail(bad), String(bad)).toBeNull();
  });

  it("builds a row from named fields only: no invite body, addresses normalised, answers in the vocabulary", () => {
    const row = toRow(event("EK-1", "2026-09-28T13:30:00Z"))!;
    expect(row).toEqual({
      event_id: "EK-1",
      ical_uid: "EK-1@example.com",
      series_id: null,
      starts_at: "2026-09-28T13:30:00.000Z",
      ends_at: "2026-09-28T14:00:00.000Z",
      all_day: false,
      title: "Meeting EK-1",
      location: null,
      organizer: "dana@example.com",
      attendees: [
        { name: "Dana", email: "dana@example.com", status: "accepted", role: "required", type: "person", self: false },
        { name: "Me", email: "me@example.com", status: "pending", role: "required", type: "person", self: true },
        { name: "Room 4", email: null, status: "accepted", role: "non_participant", type: "room", self: false },
      ],
      self_status: "pending",
    });
    expect(JSON.stringify(row)).not.toContain("4242");
    expect(toRow(event("EK-2", "2026-09-28T13:30:00Z", { self_status: "maybe" }))!.self_status).toBeNull();
    expect(toRow(event("EK-3", "not a time"))).toBeNull();
    expect(toRow(event("EK-4", "2026-09-28T13:30:00Z", { event_id: null }))).toBeNull(); // an event the bridge could not key is not stored
  });

  it("degrades absent: no bridge URL or token → 0, and nothing is asked", async () => {
    const b = bridge([]);
    const db = { query: async () => { throw new Error("no write expected"); } };
    expect(await run(db, { fetchFn: b.fetchFn })).toBe(0);
    expect(await run(db, { ekUrl: "http://ek.test", fetchFn: b.fetchFn })).toBe(0);
    expect(b.asked).toEqual([]);
  });

  it("an older helper (no window) is a failed run naming the fix — and nothing is written", async () => {
    const b = bridge([event("EK-1", "2026-09-28T13:30:00Z")], null);
    const db = { query: async () => { throw new Error("no write expected"); } };
    await expect(run(db, { ekUrl: "http://ek.test/", ekToken: "t", fetchFn: b.fetchFn })).rejects.toThrow(/no window.*Rebuild/);
    expect(b.asked).toEqual([`http://ek.test/events?days=${SYNC_DAYS} Bearer t`]);
  });

  it("a bridge that refuses is a failed run, and nothing is written", async () => {
    const b = bridge([], WINDOW, 401);
    const db = { query: async () => { throw new Error("no write expected"); } };
    await expect(run(db, { ekUrl: "http://ek.test", ekToken: "t", fetchFn: b.fetchFn })).rejects.toThrow(/401/);
  });
});

describe.skipIf(!hasDb)("the eventkit sync (real db)", () => {
  let pool: pg.Pool;
  // invitations are collectors/test/invitations.integration.test.ts's: this suite is about the rows
  const ctx = (events: unknown[]) => ({ ekUrl: "http://ek.test", ekToken: "t", fetchFn: bridge(events).fetchFn, raise: { invitation: false } });
  const rows = async () =>
    (await pool.query(`SELECT event_id, starts_at, title, organizer, attendees, self_status FROM calendar_events WHERE connection = $1 ORDER BY event_id COLLATE "C"`, [EVENTKIT_CONNECTION])).rows;

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
  });
  beforeEach(async () => {
    await pool.query(`DELETE FROM calendar_events WHERE connection = $1`, [EVENTKIT_CONNECTION]);
    await pool.query(`DELETE FROM sync_state WHERE connection = $1`, [EVENTKIT_CONNECTION]);
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM calendar_events WHERE connection = $1`, [EVENTKIT_CONNECTION]);
    await pool.query(`DELETE FROM sync_state WHERE connection = $1`, [EVENTKIT_CONNECTION]);
    await pool.end();
  });

  it("writes every occurrence once, and a second identical pass changes nothing", async () => {
    const events = [event("EK-1", "2026-09-28T13:30:00Z"), event("S_20260928T150000Z", "2026-09-28T15:00:00Z", { series_id: "S" }), event("S_20261005T150000Z", "2026-10-05T15:00:00Z", { series_id: "S" })];
    expect(await run(pool, ctx(events))).toBe(3);
    const first = await rows();
    expect(first.map((r) => r.event_id)).toEqual(["EK-1", "S_20260928T150000Z", "S_20261005T150000Z"]);
    expect(first[0]).toMatchObject({ organizer: "dana@example.com", self_status: "pending" });
    expect(first[0].attendees[0]).toEqual({ name: "Dana", email: "dana@example.com", status: "accepted", role: "required", type: "person", self: false });
    const stamped = (await pool.query(`SELECT event_id, updated_at FROM calendar_events WHERE connection = $1 ORDER BY event_id`, [EVENTKIT_CONNECTION])).rows;
    expect(await run(pool, ctx(events))).toBe(0); // a quiet pass
    expect((await pool.query(`SELECT event_id, updated_at FROM calendar_events WHERE connection = $1 ORDER BY event_id`, [EVENTKIT_CONNECTION])).rows).toEqual(stamped);
    const state = (await pool.query(`SELECT key, value FROM sync_state WHERE connection = $1 ORDER BY key`, [EVENTKIT_CONNECTION])).rows;
    expect(state).toEqual([
      { key: "events", value: "3" },
      { key: "window_end", value: WINDOW.end },
      { key: "window_start", value: WINDOW.start },
    ]);
  });

  it("**notes never reach an agent**: no column holds an invite body, and nothing the sync wrote carries one", async () => {
    await run(pool, ctx([event("EK-1", "2026-09-28T13:30:00Z")]));
    const cols = (await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name IN ('calendar_events', 'sync_state')`)).rows.map((r) => r.column_name);
    expect(cols.filter((c) => /note|body|description/i.test(c))).toEqual([]);
    const all = JSON.stringify((await pool.query(`SELECT * FROM calendar_events WHERE connection = $1`, [EVENTKIT_CONNECTION])).rows);
    expect(all).not.toContain("4242");
    expect(all).not.toContain("Dial-in");
  });

  it("a meeting cancelled inside the window goes, a moved one updates, and the past outside the window stays", async () => {
    // a meeting last seen yesterday — outside the window this pass reads
    await pool.query(
      `INSERT INTO calendar_events (connection, event_id, starts_at, ends_at, title) VALUES ($1, 'PAST', '2026-09-27T13:00:00Z', '2026-09-27T13:30:00Z', 'Yesterday')`,
      [EVENTKIT_CONNECTION],
    );
    await run(pool, ctx([event("EK-1", "2026-09-28T13:30:00Z"), event("EK-2", "2026-09-29T09:00:00Z")]));
    expect(await run(pool, ctx([event("EK-1", "2026-09-28T16:00:00Z")]))).toBe(2); // EK-1 moved, EK-2 cancelled
    const now = await rows();
    expect(now.map((r) => r.event_id)).toEqual(["EK-1", "PAST"]);
    expect(new Date(now[0].starts_at).toISOString()).toBe("2026-09-28T16:00:00.000Z");
  });

  it("only its own connection: another source's rows in the same window are never touched", async () => {
    await pool.query(
      `INSERT INTO calendar_events (connection, event_id, starts_at, ends_at, title) VALUES ('itest-ics', 'ICS-1', '2026-09-28T13:00:00Z', '2026-09-28T14:00:00Z', 'From a feed')`,
    );
    try {
      await run(pool, ctx([]));
      expect((await pool.query(`SELECT event_id FROM calendar_events WHERE connection = 'itest-ics'`)).rows).toEqual([{ event_id: "ICS-1" }]);
    } finally {
      await pool.query(`DELETE FROM calendar_events WHERE connection = 'itest-ics'`);
    }
  });

  it("one occurrence reported twice in a pass is stored once — the first stands", async () => {
    expect(await run(pool, ctx([event("EK-1", "2026-09-28T13:30:00Z"), event("EK-1", "2026-09-28T13:30:00Z", { title: "the copy" })]))).toBe(1);
    expect((await rows()).map((r) => r.title)).toEqual(["Meeting EK-1"]);
  });
});
