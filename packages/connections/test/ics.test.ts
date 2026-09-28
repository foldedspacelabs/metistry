// The `ics` provider (T4-12): content lines, zones, recurrence, and the read
// through the door the sync opens. No network: every feed is a string here or
// a fake fetch's answer. The sync that writes `calendar_events` from a whole
// recorded feed is proven in collectors/ics-calendar/.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { EgressRefused, SecretRedactor, guardedFetch, parseSecretsFile } from "@foldedspacelabs/metistry-core";
import {
  ConnectionRefused,
  ICS_MODULE,
  ICS_SYNC,
  IcsError,
  envSecretSource,
  expandRule,
  icsOccurrences,
  openSyncHttp,
  parseDuration,
  parseIcs,
  parseRule,
  readIcsFeed,
  syncTarget,
  type IcsComponent,
  type OpenedSync,
  type SyncHttp,
} from "../src/index.js";
import { catalogOf } from "./helpers.js";

/** The shipped connection type, read from the seed — the real manifest, not a copy. */
const ICS_TYPE = parse(readFileSync(new URL("../../../seed/connection-types/ics/manifest.yaml", import.meta.url), "utf8")) as Record<string, unknown>;

const DAY = 86_400_000;

/** A VCALENDAR around `body` (lines joined with CRLF, as a server sends them). */
function cal(body: string, head = ""): IcsComponent {
  const text = ["BEGIN:VCALENDAR", "VERSION:2.0", ...head.split("\n").filter(Boolean), ...body.trim().split("\n"), "END:VCALENDAR"].join("\r\n");
  const c = parseIcs(text);
  if (!c) throw new Error("no calendar");
  return c;
}

const event = (lines: string) => `BEGIN:VEVENT\n${lines.trim()}\nEND:VEVENT`;

/** Occurrence starts of `c` in a window, as ISO strings. */
function starts(c: IcsComponent, from: string, to: string, ownerZone = "UTC"): string[] {
  return icsOccurrences(c, { windowStart: Date.parse(from), windowEnd: Date.parse(to), ownerZone }).events.map((e) => e.start);
}

/** The walls a rule gives from a DTSTART, as dates — expandRule alone. */
function walls(rule: string, dtstart: string, limit: string, date = false): string[] {
  const start = Date.parse(dtstart);
  return [...expandRule(parseRule(rule), start, date, Date.parse(limit), () => false, null)].map((w) => new Date(w).toISOString().slice(0, date ? 10 : 16));
}

describe("content lines", () => {
  it("unfolds, honours quoted parameters, unescapes text, and keeps a VALARM's properties its own", () => {
    const c = cal(
      event(`
UID:a@x
DTSTART:20261001T120000Z
SUMMARY:Planning\\, part one\\; bring
  notes
ATTENDEE;CN="Mulder, Fox";PARTSTAT=ACCEPTED:mailto:fox@example.com
BEGIN:VALARM
ACTION:DISPLAY
SUMMARY:the alarm's own summary
DESCRIPTION:reminder
END:VALARM`),
    );
    const ev = c.children.find((x) => x.name === "VEVENT")!;
    expect(ev.props.filter((p) => p.name === "SUMMARY")).toHaveLength(1);
    expect(ev.children[0]?.name).toBe("VALARM");
    const [e] = icsOccurrences(c, { windowStart: Date.parse("2026-10-01T00:00:00Z"), windowEnd: Date.parse("2026-10-02T00:00:00Z"), ownerZone: "UTC" }).events;
    expect(e?.title).toBe("Planning, part one; bring notes");
    expect(e?.participants[0]).toMatchObject({ name: "Mulder, Fox", email: "fox@example.com", status: "accepted", role: "required", type: "person", self: false });
  });

  it("a body that is not a calendar is null, and a line it cannot read is skipped", () => {
    expect(parseIcs("<html>not a feed</html>")).toBeNull();
    const c = parseIcs("BEGIN:VCALENDAR\r\nthis line has no colon\r\nX-WR-CALNAME:Work\r\nEND:VCALENDAR\r\n");
    expect(c?.props.map((p) => p.name)).toEqual(["X-WR-CALNAME"]);
  });

  it("DURATION values", () => {
    expect(parseDuration("PT45M")).toBe(45 * 60_000);
    expect(parseDuration("P1DT2H")).toBe(DAY + 2 * 3600_000);
    expect(parseDuration("P2W")).toBe(14 * DAY);
    expect(parseDuration("-PT15M")).toBe(-15 * 60_000);
    expect(parseDuration("P")).toBeNull();
    expect(parseDuration("PT")).toBeNull();
  });
});

describe("recurrence (RFC 5545 §3.3.10)", () => {
  it("DAILY with INTERVAL and COUNT — DTSTART counts as the first", () => {
    expect(walls("FREQ=DAILY;INTERVAL=2;COUNT=3", "2026-10-01T09:00:00Z", "2027-01-01")).toEqual(["2026-10-01T09:00", "2026-10-03T09:00", "2026-10-05T09:00"]);
  });

  it("WEEKLY every other week on Tuesday and Thursday, and WKST decides which weeks pair (the RFC's own example)", () => {
    expect(walls("FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,SU;WKST=MO", "1997-08-05T09:00:00Z", "1998-01-01")).toEqual(["1997-08-05T09:00", "1997-08-10T09:00", "1997-08-19T09:00", "1997-08-24T09:00"]);
    expect(walls("FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,SU;WKST=SU", "1997-08-05T09:00:00Z", "1998-01-01")).toEqual(["1997-08-05T09:00", "1997-08-17T09:00", "1997-08-19T09:00", "1997-08-31T09:00"]);
  });

  it("MONTHLY on the last day, the last Friday, and the last working day (BYSETPOS)", () => {
    expect(walls("FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=3", "2026-01-31T00:00:00Z", "2027-01-01", true)).toEqual(["2026-01-31", "2026-02-28", "2026-03-31"]);
    expect(walls("FREQ=MONTHLY;BYDAY=-1FR;COUNT=3", "2026-09-25T16:00:00Z", "2027-01-01")).toEqual(["2026-09-25T16:00", "2026-10-30T16:00", "2026-11-27T16:00"]);
    expect(walls("FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=3", "2026-10-30T17:00:00Z", "2027-01-01")).toEqual(["2026-10-30T17:00", "2026-11-30T17:00", "2026-12-31T17:00"]);
  });

  it("MONTHLY on the 31st skips the months without one, as the RFC says", () => {
    expect(walls("FREQ=MONTHLY;COUNT=3", "2026-10-31T00:00:00Z", "2028-01-01", true)).toEqual(["2026-10-31", "2026-12-31", "2027-01-31"]);
  });

  it("YEARLY: the fourth Thursday of November, and 29 February only in a leap year", () => {
    expect(walls("FREQ=YEARLY;BYMONTH=11;BYDAY=4TH;COUNT=3", "2026-11-26T00:00:00Z", "2030-01-01", true)).toEqual(["2026-11-26", "2027-11-25", "2028-11-23"]);
    expect(walls("FREQ=YEARLY;COUNT=2", "2024-02-29T00:00:00Z", "2040-01-01", true)).toEqual(["2024-02-29", "2028-02-29"]);
  });

  it("UNTIL is inclusive", () => {
    const rule = parseRule("FREQ=DAILY;UNTIL=20261003T090000Z");
    const until = rule.until!;
    const got = [...expandRule(rule, Date.parse("2026-10-01T09:00:00Z"), false, Date.parse("2027-01-01"), (w) => w > until.wall, null)];
    expect(got.map((w) => new Date(w).toISOString().slice(0, 10))).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"]);
  });

  it("a rule it does not expand is not guessed at: the series is skipped and counted", () => {
    expect(parseRule("FREQ=YEARLY;BYWEEKNO=20;BYDAY=MO").supported).toBe(false);
    expect(parseRule("FREQ=HOURLY;INTERVAL=4").supported).toBe(false);
    expect(parseRule("FREQ=DAILY;BYHOUR=9,17").supported).toBe(false);
    const c = cal(event("UID:w@x\nDTSTART:20260101T120000Z\nRRULE:FREQ=YEARLY;BYWEEKNO=40;BYDAY=TH"));
    const r = icsOccurrences(c, { windowStart: Date.parse("2026-09-28T00:00:00Z"), windowEnd: Date.parse("2026-10-12T00:00:00Z"), ownerZone: "UTC" });
    expect(r.events).toEqual([]);
    expect(r.skipped.unsupported_rule).toBe(1);
  });

  it("a daily series from 1990 with no end reaches the window at once (whole periods are skipped), and one that never matches ends", () => {
    const c = cal(event("UID:d@x\nDTSTART:19900101T080000Z\nDURATION:PT30M\nRRULE:FREQ=DAILY"));
    const t0 = performance.now();
    expect(starts(c, "2026-10-01T00:00:00Z", "2026-10-03T00:00:00Z")).toEqual(["2026-10-01T08:00:00.000Z", "2026-10-02T08:00:00.000Z"]);
    expect(performance.now() - t0).toBeLessThan(500);
    const never = cal(event("UID:n@x\nDTSTART:20260101T080000Z\nRRULE:FREQ=MONTHLY;BYMONTH=2;BYMONTHDAY=30;COUNT=5"));
    expect(starts(never, "2026-10-01T00:00:00Z", "2026-10-03T00:00:00Z")).toEqual([]);
  });

  it("EXDATE removes one; RDATE adds one; an override moves or cancels one and keeps its original key", () => {
    const c = cal(
      [
        event(`UID:s@x
DTSTART:20261001T090000Z
DTEND:20261001T093000Z
RRULE:FREQ=DAILY;COUNT=5
EXDATE:20261002T090000Z
RDATE:20261010T090000Z
SUMMARY:Series`),
        event(`UID:s@x
RECURRENCE-ID:20261003T090000Z
DTSTART:20261003T140000Z
DTEND:20261003T150000Z
SUMMARY:Moved`),
        event(`UID:s@x
RECURRENCE-ID:20261004T090000Z
DTSTART:20261004T090000Z
STATUS:CANCELLED`),
      ].join("\n"),
    );
    const { events } = icsOccurrences(c, { windowStart: Date.parse("2026-10-01T00:00:00Z"), windowEnd: Date.parse("2026-10-15T00:00:00Z"), ownerZone: "UTC" });
    expect(events.map((e) => [e.event_id, e.start, e.title, e.series_id])).toEqual([
      ["s@x_20261001T090000Z", "2026-10-01T09:00:00.000Z", "Series", "s@x"],
      ["s@x_20261003T090000Z", "2026-10-03T14:00:00.000Z", "Moved", "s@x"],
      ["s@x_20261005T090000Z", "2026-10-05T09:00:00.000Z", "Series", "s@x"],
      ["s@x_20261010T090000Z", "2026-10-10T09:00:00.000Z", "Series", "s@x"],
    ]);
    // the moved one inherits the series' length when it gives none of its own — here it gives one
    expect(events[1]?.end).toBe("2026-10-03T15:00:00.000Z");
  });

  it("a one-off's key is its UID, and a cancelled one is not returned", () => {
    const c = cal([event("UID:one@x\nDTSTART:20261001T090000Z"), event("UID:gone@x\nDTSTART:20261001T100000Z\nSTATUS:CANCELLED")].join("\n"));
    const { events } = icsOccurrences(c, { windowStart: Date.parse("2026-10-01T00:00:00Z"), windowEnd: Date.parse("2026-10-02T00:00:00Z"), ownerZone: "UTC" });
    expect(events.map((e) => [e.event_id, e.series_id, e.end])).toEqual([["one@x", null, "2026-10-01T09:00:00.000Z"]]); // no DTEND, no DURATION: an instant
  });
});

describe("zones", () => {
  it("a 09:00 New York series stays at 09:00 across the end of DST (13:00Z, then 14:00Z)", () => {
    const c = cal(event("UID:dst@x\nDTSTART;TZID=America/New_York:20261015T090000\nDTEND;TZID=America/New_York:20261015T093000\nRRULE:FREQ=WEEKLY"));
    expect(starts(c, "2026-10-25T00:00:00Z", "2026-11-10T00:00:00Z")).toEqual(["2026-10-29T13:00:00.000Z", "2026-11-05T14:00:00.000Z"]);
  });

  it("the same through the feed's own VTIMEZONE, for a TZID no runtime knows (Outlook's names) — Europe's change, a week earlier", () => {
    const vtz = `BEGIN:VTIMEZONE
TZID:W. Europe Standard Time
BEGIN:STANDARD
DTSTART:16010101T030000
TZOFFSETFROM:+0200
TZOFFSETTO:+0100
RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=10
END:STANDARD
BEGIN:DAYLIGHT
DTSTART:16010101T020000
TZOFFSETFROM:+0100
TZOFFSETTO:+0200
RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=3
END:DAYLIGHT
END:VTIMEZONE`;
    const c = cal(`${vtz}\n${event("UID:eu@x\nDTSTART;TZID=W. Europe Standard Time:20261014T100000\nDURATION:PT1H\nRRULE:FREQ=WEEKLY")}`);
    const r = icsOccurrences(c, { windowStart: Date.parse("2026-10-18T00:00:00Z"), windowEnd: Date.parse("2026-11-01T00:00:00Z"), ownerZone: "UTC" });
    expect(r.events.map((e) => e.start)).toEqual(["2026-10-21T08:00:00.000Z", "2026-10-28T09:00:00.000Z"]);
    expect(r.skipped.unknown_zones).toEqual([]);
  });

  it("a wall time DST skips moves forward by the gap; one it repeats is the earlier", () => {
    const c = cal([event("UID:gap@x\nDTSTART;TZID=America/New_York:20260308T023000"), event("UID:twice@x\nDTSTART;TZID=America/New_York:20261101T013000")].join("\n"));
    expect(starts(c, "2026-03-08T00:00:00Z", "2026-03-09T00:00:00Z")).toEqual(["2026-03-08T07:30:00.000Z"]); // 03:30 EDT
    expect(starts(c, "2026-11-01T00:00:00Z", "2026-11-02T00:00:00Z")).toEqual(["2026-11-01T05:30:00.000Z"]); // 01:30 EDT, not EST
  });

  it("a floating time is the calendar's zone (X-WR-TIMEZONE), else the owner's; a vendor-prefixed TZID is its IANA tail", () => {
    const body = event("UID:f@x\nDTSTART:20261001T090000");
    expect(starts(cal(body, "X-WR-TIMEZONE:Europe/London"), "2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z", "America/New_York")).toEqual(["2026-10-01T08:00:00.000Z"]);
    expect(starts(cal(body), "2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z", "America/New_York")).toEqual(["2026-10-01T13:00:00.000Z"]);
    const moz = cal(event("UID:m@x\nDTSTART;TZID=/mozilla.org/20050126_1/America/Chicago:20261001T090000"));
    expect(starts(moz, "2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z")).toEqual(["2026-10-01T14:00:00.000Z"]);
  });

  it("an all-day date is the owner's midnight to midnight, whatever zone the calendar names", () => {
    const c = cal(event("UID:hol@x\nDTSTART;VALUE=DATE:20261225\nSUMMARY:Holiday"), "X-WR-TIMEZONE:UTC");
    const { events } = icsOccurrences(c, { windowStart: Date.parse("2026-12-20T00:00:00Z"), windowEnd: Date.parse("2026-12-30T00:00:00Z"), ownerZone: "America/New_York" });
    expect(events.map((e) => [e.start, e.end, e.all_day])).toEqual([["2026-12-25T05:00:00.000Z", "2026-12-26T05:00:00.000Z", true]]);
  });

  it("a TZID nobody defines is read in the calendar's zone and named — never silently", () => {
    const c = cal(event("UID:u@x\nDTSTART;TZID=Mars/Olympus_Mons:20261001T090000"), "X-WR-TIMEZONE:America/New_York");
    const r = icsOccurrences(c, { windowStart: Date.parse("2026-10-01T00:00:00Z"), windowEnd: Date.parse("2026-10-02T00:00:00Z"), ownerZone: "UTC" });
    expect(r.events.map((e) => e.start)).toEqual(["2026-10-01T13:00:00.000Z"]);
    expect(r.skipped.unknown_zones).toEqual(["Mars/Olympus_Mons"]);
  });
});

describe("never the invite body", () => {
  it("DESCRIPTION, ATTACH, COMMENT and a VALARM's text reach no field of an occurrence", () => {
    const c = cal(
      event(`UID:b@x
DTSTART:20261001T090000Z
SUMMARY:Board
DESCRIPTION:Dial-in 555-0100\\, pin 4242
COMMENT:the confidential agenda
ATTACH:https://files.example.com/agenda.pdf
BEGIN:VALARM
DESCRIPTION:pin 4242 again
END:VALARM`),
    );
    const out = JSON.stringify(icsOccurrences(c, { windowStart: Date.parse("2026-10-01T00:00:00Z"), windowEnd: Date.parse("2026-10-02T00:00:00Z"), ownerZone: "UTC" }));
    for (const s of ["555-0100", "4242", "confidential", "agenda.pdf"]) expect(out).not.toContain(s);
    expect(out).toContain("Board");
  });
});

// ---- the connection, the door and the read -------------------------------------------

const icsFile = (url: string, over: Record<string, unknown> = {}) => ({ name: "holidays", type: "calendar", provider: "ics", reach: { http: { url } }, ...over });

function catalog(files: Record<string, unknown>[], secrets = "") {
  return { ...catalogOf(files, { secrets, types: [ICS_TYPE] }), scheduled: null };
}

function recorder(answer: () => Response) {
  const sent: { url: string; redirect: RequestRedirect | undefined; headers: Record<string, string> }[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    sent.push({ url: String(input), redirect: init.redirect, headers });
    return answer();
  }) as typeof fetch;
  return { sent, fetchFn };
}

function openIcs(files: Record<string, unknown>[], fetchFn?: typeof fetch): OpenedSync {
  return openSyncHttp({ catalog: catalog(files), sync: ICS_SYNC, module: ICS_MODULE, secrets: envSecretSource({}), ...(fetchFn ? { fetch: fetchFn } : {}) });
}

function opened(o: OpenedSync): SyncHttp {
  if (!o.ok) throw new Error(`expected an open sync, got ${o.status}: ${o.why}`);
  return o.sync;
}

const FEED = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:h@x\r\nDTSTART;VALUE=DATE:20261225\r\nSUMMARY:Holiday\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";

// Token shapes a calendar puts in a feed's address, built at run time so no
// key-shaped literal is in the tree.
const HEX = ["3f9a1c0b", "7e2d4a6f", "8b1c3e5d", "7f9a0b2c"].join("");
const TOKENED = {
  "Google's secret address": `https://calendar.google.com/calendar/ical/owner%40gmail.com/private-${HEX}/basic.ics`,
  "a published iCloud calendar": `https://p52-caldav.icloud.com/published/2/${["MTAxNzI4MzQ1Njcx", "MDE3MvXcGkYq1a8F", "hT3mLpZ2oQeR5wNs"].join("")}`,
  "a ?token= link": `https://cal.example.com/feed.ics?token=${["Zq81", "mNa0", "pLx7"].join("")}`,
};

describe("the shipped ics connection type", () => {
  it("validates, provides calendar with read only, and is read by the ics-calendar sync", () => {
    const c = catalog([icsFile("https://www.example.com/holidays.ics")]);
    expect(c.entries[0]?.status).toBe("ok");
    expect(c.entries[0]?.provider?.manifest).toMatchObject({ provides: "calendar", capabilities: ["read"], sync: ICS_SYNC, implementation: { kind: "builtin", module: ICS_MODULE } });
    const t = syncTarget(c, ICS_SYNC);
    expect(t.ok && t.entry.name).toBe("holidays");
  });
});

describe("**the feed URL is a secret when it carries a token**", () => {
  it.each(Object.entries(TOKENED))("%s is refused in the connection file, the sync reads nothing, and nothing is sent", async (_label, url) => {
    const c = catalog([icsFile(url)]);
    expect(c.entries[0]?.status).toBe("failed");
    expect(c.entries[0]?.issues.join("\n")).toMatch(/reach\.http\.url: this looks like a key — a connection file holds names, never values\. Store it as a secret/);
    // the refusal names the field, never the value
    expect(c.entries[0]?.issues.join("\n")).not.toContain(url);
    const { sent, fetchFn } = recorder(() => new Response(FEED));
    const o = openIcs([icsFile(url)], fetchFn);
    expect(o).toMatchObject({ ok: false, status: "absent" });
    expect(sent).toHaveLength(0);
  });

  it("and stored as a secret, it may not be put back in the URL: refused at the file, and at the egress door (secret_in_url) before a byte is sent", async () => {
    const withRef = icsFile("https://calendar.google.com/{{ secret.gcal_feed }}", { secrets: ["gcal_feed"] });
    const c = catalog([withRef]);
    expect(c.entries[0]?.status).toBe("failed");
    expect(c.entries[0]?.issues.join("\n")).toMatch(/reach\.http\.url: a secret goes in a header, never the URL/);
    // the door, handed the same URL directly: refused, with the value never read
    const { sent, fetchFn } = recorder(() => new Response(FEED));
    let read = 0;
    const door = guardedFetch(
      {
        secrets: parseSecretsFile(`secrets:\n  gcal_feed:\n    hosts: [calendar.google.com]\n    grants: { "connection:holidays": on }\n`),
        grantee: "connection:holidays",
        purpose: "service",
        redactor: new SecretRedactor(),
        source: { value: async () => (read++, TOKENED["Google's secret address"]) },
      },
      fetchFn,
    );
    const err = await door("https://calendar.google.com/{{ secret.gcal_feed }}").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EgressRefused);
    expect((err as EgressRefused).code).toBe("secret_in_url");
    expect(read).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it("a public feed's address is not a secret, and opens", () => {
    for (const url of ["https://www.example.com/sports/team-schedule.ics", "https://calendar.google.com/calendar/ical/en.usa%23holiday%40group.v.calendar.google.com/public/basic.ics"]) {
      expect(catalog([icsFile(url)]).entries[0]?.status, url).toBe("ok");
    }
  });
});

describe("readIcsFeed — through the door, to the feed's own origin only", () => {
  it("GETs the address, pinned to its own origin, with no redirect followed", async () => {
    const { sent, fetchFn } = recorder(() => new Response(FEED, { headers: { "content-type": "text/calendar" } }));
    const s = opened(openIcs([icsFile("https://www.example.com/holidays.ics")], fetchFn));
    expect(s.origin).toBe("https://www.example.com");
    const c = await readIcsFeed(s);
    expect(c.children.filter((x) => x.name === "VEVENT")).toHaveLength(1);
    expect(sent.map((x) => [x.url, x.redirect, x.headers.accept])).toEqual([["https://www.example.com/holidays.ics", "manual", "text/calendar, text/plain;q=0.5"]]);
    // the fetch it holds reaches nowhere else
    await expect(s.fetch("https://collector.evil.test/x")).rejects.toThrow(ConnectionRefused);
    expect(sent).toHaveLength(1);
  });

  it("**a redirect is not followed** — a feed that moves is refused, not chased", async () => {
    const { sent, fetchFn } = recorder(() => new Response(null, { status: 302, headers: { location: "https://elsewhere.example.net/feed.ics" } }));
    const s = opened(openIcs([icsFile("https://www.example.com/holidays.ics")], fetchFn));
    await expect(readIcsFeed(s)).rejects.toThrow(/a redirect is not followed/);
    expect(sent).toHaveLength(1);
  });

  it("refuses plain http (not_https) before sending", async () => {
    const { sent, fetchFn } = recorder(() => new Response(FEED));
    const s = opened(openIcs([icsFile("http://www.example.com/holidays.ics")], fetchFn));
    const err = await readIcsFeed(s).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IcsError);
    expect((err as IcsError).code).toBe("not_https");
    expect(sent).toHaveLength(0);
  });

  it("an HTTP error (http_status), a body that is not a calendar (not_calendar), and one too large (too_large) are refusals naming the origin, never the path", async () => {
    const url = "https://www.example.com/private/path/holidays.ics";
    const cases: [() => Response, string, number?][] = [
      [() => new Response("nope", { status: 404 }), "http_status"],
      [() => new Response("<html>login</html>"), "not_calendar"],
      [() => new Response(FEED + "X".repeat(4096)), "too_large", 1024],
    ];
    for (const [answer, code, cap] of cases) {
      const s = opened(openIcs([icsFile(url)], recorder(answer).fetchFn));
      const err = await readIcsFeed(s, cap).catch((e: unknown) => e);
      expect((err as IcsError).code, code).toBe(code);
      expect(String(err)).toContain("https://www.example.com");
      expect(String(err)).not.toContain("/private/path");
    }
  });
});
