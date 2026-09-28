// The ICS sync (design-build-plan §2.6, T4-12): a recorded feed through the
// console's own opener into `calendar_events`. The fixture
// (`fixtures/work.ics`) is written from RFC 5545 in the shapes Google and
// Outlook publish — not captured from a real calendar: no test reads a real
// feed, and no address or token is in the repository. It holds a weekly
// series in a named zone with an EXDATE, a moved and a cancelled occurrence,
// an all-day event, a one-off in UTC, a cancelled one-off, an event in an
// Outlook zone defined only by the feed's VTIMEZONE, a rule this sync does
// not expand, an event with no UID, and invite bodies it must never keep.
//
// The window-replacement SQL is the eventkit sync's (`replaceCalendarWindow`),
// proven there and again here against the scratch database.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { loadKind } from "@foldedspacelabs/metistry-core";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";
import { instanceSyncOpener, type SyncOpener } from "@foldedspacelabs/metistry-connections";
import { SYNC_DAYS, run, syncWindow } from "./run.js";

const { hasDb } = loadTestEnv(new URL("../../.env", import.meta.url)); // METISTRY_DB_* only (docs/ops/testing.md)

const SEED_DIR = fileURLToPath(new URL("../../seed", import.meta.url));
const FEED = readFileSync(new URL("./fixtures/work.ics", import.meta.url), "utf8");
const FEED_URL = "https://calendar.example.com/work/basic.ics";
/** Monday 28 September 2026, noon in New York — the fixture's first week. */
const NOW = Date.parse("2026-09-28T16:00:00Z");
const ZONE = "America/New_York";

const connectionYaml = (name: string, url: string) => `name: ${name}\ntype: calendar\nprovider: ics\nreach:\n  http:\n    url: ${url}\n`;

/** A scratch instance under os.tmpdir() with the given `.metistry/` files. */
function instance(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "metistry-ics-"));
  mkdirSync(join(dir, ".metistry", "connections"), { recursive: true });
  for (const [rel, text] of Object.entries(files)) writeFileSync(join(dir, ".metistry", rel), text);
  return dir;
}

/** A fake feed server: answers every request with `answer()`, recording where each went. */
function feedServer(answer: () => Response = () => new Response(FEED, { headers: { "content-type": "text/calendar; charset=utf-8" } })) {
  const sent: { url: string; redirect: RequestRedirect | undefined }[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    sent.push({ url: String(input), redirect: init.redirect });
    return answer();
  }) as typeof fetch;
  return { sent, fetchFn };
}

function opener(dir: string, fetchFn: typeof fetch): SyncOpener {
  return instanceSyncOpener({ instanceDir: dir, seedDir: SEED_DIR, extensions: false, env: {}, fetch: fetchFn });
}

/** Records every statement; answers the window replacement with counts. */
function fakeDb() {
  const q: { text: string; values: unknown[] }[] = [];
  return {
    q,
    async query(text: string, values: unknown[] = []) {
      q.push({ text, values });
      if (/INSERT INTO calendar_events/.test(text)) return { rows: [{ upserted: (JSON.parse(String(values[1])) as unknown[]).length, removed: 0 }] };
      return { rows: [] };
    },
  };
}

const writtenRows = (db: ReturnType<typeof fakeDb>) => JSON.parse(String(db.q.find((x) => /INSERT INTO calendar_events/.test(x.text))?.values[1] ?? "[]")) as Record<string, unknown>[];

describe("the ics-calendar collector's manifest", () => {
  it("loads through the collector registry as a sync every 15 minutes", async () => {
    const reg = await loadKind("collector", { productDir: fileURLToPath(new URL("../..", import.meta.url)) });
    const m = reg.get("ics-calendar")?.manifest;
    expect(m, JSON.stringify(reg.skipped)).toMatchObject({ name: "ics-calendar", display_name: "Calendar Feed", schedule: { every: "15m" }, writes: ["calendar_events", "sync_state"] });
  });
});

describe("the window", () => {
  it("is the owner's midnight today for SYNC_DAYS days — New York's, or UTC's without a zone", () => {
    expect(syncWindow(NOW, ZONE)).toEqual({ start: Date.parse("2026-09-28T04:00:00Z"), end: Date.parse("2026-10-12T04:00:00Z") });
    expect(syncWindow(NOW, "UTC")).toEqual({ start: Date.parse("2026-09-28T00:00:00Z"), end: Date.parse("2026-09-28T00:00:00Z") + SYNC_DAYS * 86_400_000 });
  });
});

describe("ics-calendar run — degrades absent", () => {
  it("no opener (no instance) is 0 and no statement", async () => {
    const db = fakeDb();
    expect(await run(db, {})).toBe(0);
    expect(db.q).toHaveLength(0);
  });

  it("no ICS connection yet is 0, no statement, nothing fetched", async () => {
    const db = fakeDb();
    const feed = feedServer();
    expect(await run(db, { openSync: opener(instance({}), feed.fetchFn) })).toBe(0);
    expect(db.q).toHaveLength(0);
    expect(feed.sent).toHaveLength(0);
  });
});

describe("ics-calendar run — the feed", () => {
  it("**a feed with recurrence and a time zone parses** — every occurrence in the window, where the feed puts it", async () => {
    const db = fakeDb();
    const feed = feedServer();
    const n = await run(db, { openSync: opener(instance({ "connections/work-feed.yaml": connectionYaml("work-feed", FEED_URL) }), feed.fetchFn), ownerTimeZone: ZONE, now: () => NOW });
    expect(n).toBe(7);
    expect(feed.sent).toEqual([{ url: FEED_URL, redirect: "manual" }]);
    const rows = writtenRows(db);
    expect(rows.map((r) => [r.event_id, r.starts_at, r.ends_at, r.all_day, r.title])).toEqual([
      // Monday's standup, 09:00 EDT; Wednesday's is EXDATE'd; Monday 5 October's override cancels it
      ["standup-7f3a@example.com_20260928T130000Z", "2026-09-28T13:00:00.000Z", "2026-09-28T13:15:00.000Z", false, "Standup"],
      ["review-22@example.com", "2026-09-29T18:00:00.000Z", "2026-09-29T18:45:00.000Z", false, "Design review — a very long title that a calendar server folds across two content lines"],
      // all day on 1–2 October: New York's midnights
      ["offsite-11@example.com", "2026-10-01T04:00:00.000Z", "2026-10-03T04:00:00.000Z", true, "Team offsite"],
      // Friday's moved to 11:00 — still keyed by its original 09:00
      ["standup-7f3a@example.com_20261002T130000Z", "2026-10-02T15:00:00.000Z", "2026-10-02T15:30:00.000Z", false, "Standup (moved for the offsite)"],
      ["standup-7f3a@example.com_20261007T130000Z", "2026-10-07T13:00:00.000Z", "2026-10-07T13:15:00.000Z", false, "Standup"],
      // 10:00 in the feed's "Pacific Standard Time" VTIMEZONE, which is on daylight time in October
      ["vendor-44@example.com", "2026-10-07T17:00:00.000Z", "2026-10-07T18:00:00.000Z", false, "Vendor call (an Outlook zone)"],
      ["standup-7f3a@example.com_20261009T130000Z", "2026-10-09T13:00:00.000Z", "2026-10-09T13:15:00.000Z", false, "Standup"],
    ]);
    const standup = rows[0]!;
    expect(standup).toMatchObject({ ical_uid: "standup-7f3a@example.com", series_id: "standup-7f3a@example.com", location: "Room 4, second floor", organizer: "dana@example.com", self_status: null });
    expect(standup.attendees).toEqual([
      { name: "Dana Scully", email: "dana@example.com", status: "accepted", role: "chair", type: "person", self: false },
      { name: "Mulder, Fox", email: "fox@example.com", status: "tentative", role: "required", type: "person", self: false },
      { name: "Room 4", email: "room4@resource.example.com", status: "accepted", role: "non_participant", type: "room", self: false },
    ]);
    expect(writtenRows(db).find((r) => r.event_id === "review-22@example.com")?.attendees).toEqual([{ name: null, email: "me@example.com", status: "pending", role: "required", type: "person", self: false }]);
    // the window and what was not used, in sync_state
    const state = db.q.find((x) => /INSERT INTO sync_state/.test(x.text))!;
    expect(state.values[0]).toBe("work-feed");
    expect(Object.fromEntries((state.values[1] as string[]).map((k, i) => [k, (state.values[2] as string[])[i]]))).toEqual({
      window_start: "2026-09-28T04:00:00.000Z",
      window_end: "2026-10-12T04:00:00.000Z",
      events: "7",
      skipped_rules: "1",
      unreadable: "1",
      unknown_zones: "",
    });
  });

  it("**never the invite body**: nothing it writes carries a DESCRIPTION or an alarm's text", async () => {
    const db = fakeDb();
    await run(db, { openSync: opener(instance({ "connections/work-feed.yaml": connectionYaml("work-feed", FEED_URL) }), feedServer().fetchFn), ownerTimeZone: ZONE, now: () => NOW });
    const all = JSON.stringify(db.q.map((x) => x.values));
    for (const s of ["555-0100", "4242", "confidential", "launch date", "10 minutes"]) expect(all).not.toContain(s);
  });

  it("**the feed URL is a secret when it carries a token**: such a connection is never read, and nothing is sent or written", async () => {
    const token = ["3f9a1c0b", "7e2d4a6f", "8b1c3e5d", "7f9a0b2c"].join("");
    const db = fakeDb();
    const feed = feedServer();
    const dir = instance({ "connections/gcal.yaml": connectionYaml("gcal", `https://calendar.google.com/calendar/ical/owner%40gmail.com/private-${token}/basic.ics`) });
    expect(await run(db, { openSync: opener(dir, feed.fetchFn), ownerTimeZone: ZONE, now: () => NOW })).toBe(0);
    expect(feed.sent).toHaveLength(0);
    expect(db.q).toHaveLength(0);
  });

  it("a feed that redirects fails the run — the redirect is not followed — and the table keeps what it had", async () => {
    const db = fakeDb();
    const feed = feedServer(() => new Response(null, { status: 301, headers: { location: "https://elsewhere.example.net/feed.ics" } }));
    const dir = instance({ "connections/work-feed.yaml": connectionYaml("work-feed", FEED_URL) });
    await expect(run(db, { openSync: opener(dir, feed.fetchFn), now: () => NOW })).rejects.toThrow(/a redirect is not followed/);
    expect(feed.sent).toHaveLength(1);
    expect(db.q).toHaveLength(0);
  });

  it("two ICS connections and none named in scheduled.yaml fails the run with how to choose; naming one reads it", async () => {
    const files = { "connections/a-feed.yaml": connectionYaml("a-feed", FEED_URL), "connections/b-feed.yaml": connectionYaml("b-feed", "https://other.example.com/b.ics") };
    await expect(run(fakeDb(), { openSync: opener(instance(files), feedServer().fetchFn), now: () => NOW })).rejects.toThrow(/syncs\.ics-calendar\.connection/);
    const feed = feedServer();
    const db = fakeDb();
    await run(db, { openSync: opener(instance({ ...files, "scheduled.yaml": "syncs:\n  ics-calendar:\n    connection: a-feed\n" }), feed.fetchFn), now: () => NOW });
    expect(feed.sent.map((s) => s.url)).toEqual([FEED_URL]);
    expect(db.q[0]?.values[0]).toBe("a-feed");
  });
});

describe.skipIf(!hasDb)("the ics sync (real db)", () => {
  let pool: pg.Pool;
  const CONN = `itest-ics-${process.pid}`;
  const ctx = (feed: string, now = NOW) => ({
    openSync: opener(instance({ [`connections/${CONN}.yaml`]: connectionYaml(CONN, FEED_URL) }), feedServer(() => new Response(feed)).fetchFn),
    ownerTimeZone: ZONE,
    now: () => now,
  });
  const ids = async () => (await pool.query(`SELECT event_id FROM calendar_events WHERE connection = $1 ORDER BY starts_at, event_id COLLATE "C"`, [CONN])).rows.map((r) => r.event_id as string);
  const clean = async () => {
    await pool.query(`DELETE FROM calendar_events WHERE connection = $1`, [CONN]);
    await pool.query(`DELETE FROM sync_state WHERE connection = $1`, [CONN]);
  };

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
  });
  beforeEach(clean);
  afterAll(async () => {
    await clean();
    await pool.end();
  });

  it("writes every occurrence once under the connection's name, and a second identical pass changes nothing", async () => {
    expect(await run(pool, ctx(FEED))).toBe(7);
    const stamped = (await pool.query(`SELECT event_id, updated_at FROM calendar_events WHERE connection = $1 ORDER BY event_id`, [CONN])).rows;
    expect(stamped).toHaveLength(7);
    expect(await run(pool, ctx(FEED))).toBe(0);
    expect((await pool.query(`SELECT event_id, updated_at FROM calendar_events WHERE connection = $1 ORDER BY event_id`, [CONN])).rows).toEqual(stamped);
    const all = JSON.stringify((await pool.query(`SELECT * FROM calendar_events WHERE connection = $1`, [CONN])).rows);
    expect(all).not.toContain("4242");
  });

  it("an event the feed drops inside the window goes; one moved updates; the past outside the window stays", async () => {
    await pool.query(`INSERT INTO calendar_events (connection, event_id, starts_at, ends_at, title) VALUES ($1, 'PAST', '2026-09-27T13:00:00Z', '2026-09-27T13:30:00Z', 'Yesterday')`, [CONN]);
    await run(pool, ctx(FEED));
    const edited = FEED.replace(/BEGIN:VEVENT\r\nUID:vendor-44[\s\S]*?END:VEVENT\r\n/, "").replace("DTSTART:20260929T180000Z", "DTSTART:20260929T190000Z");
    expect(await run(pool, ctx(edited))).toBe(2); // the vendor call gone, the review moved
    expect(await ids()).toEqual([
      "PAST",
      "standup-7f3a@example.com_20260928T130000Z",
      "review-22@example.com",
      "offsite-11@example.com",
      "standup-7f3a@example.com_20261002T130000Z",
      "standup-7f3a@example.com_20261007T130000Z",
      "standup-7f3a@example.com_20261009T130000Z",
    ]);
    const review = (await pool.query(`SELECT starts_at FROM calendar_events WHERE connection = $1 AND event_id = 'review-22@example.com'`, [CONN])).rows[0];
    expect(new Date(review.starts_at).toISOString()).toBe("2026-09-29T19:00:00.000Z");
  });

  it("the window moves with the day: a week on, last week's occurrences stay as last seen and the new week's arrive", async () => {
    await run(pool, ctx(FEED));
    await run(pool, ctx(FEED, NOW + 7 * 86_400_000));
    const got = await ids();
    expect(got).toContain("standup-7f3a@example.com_20260928T130000Z"); // outside the new window: kept
    expect(got).toContain("standup-7f3a@example.com_20261012T130000Z"); // the new week's Monday
    expect(got).not.toContain("standup-7f3a@example.com_20261005T130000Z"); // still cancelled
  });
});
