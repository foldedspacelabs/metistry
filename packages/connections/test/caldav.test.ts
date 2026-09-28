// The CalDAV provider (plan §2.6, §4 Q7; T4-13), against a local CalDAV
// fixture server (`caldav-server.ts`: 127.0.0.1, an ephemeral port — never a
// real service). What it proves:
//
//  * **only the owner's own attendee line changes** when the owner replies,
//    in the event and in each moved occurrence — every other byte is the
//    server's, and the server (as RFC 6638 has it) delivers the REPLY;
//  * the app password is Basic sign-in filled at the egress door, for a
//    listed host or not at all — never to another host, never through a
//    redirect, never in an error, and redacted if a server echoes it;
//  * a Google address is refused with *Google needs sign-in with Google*;
//  * write_own touches only events nobody else is in, and every change is
//    bound to the ETag its preview read.

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { EgressRefused } from "@foldedspacelabs/metistry-core";
import {
  CaldavError,
  ConnectionRefused,
  DavXmlError,
  GOOGLE_CALDAV_REFUSAL,
  changeOwnEvent,
  createOwnEvent,
  deleteOwnEvent,
  discoverCaldav,
  envSecretSource,
  foldLine,
  openSyncHttp,
  parseMultistatus,
  parseXml,
  planOwnChange,
  planReply,
  previewChangeEvent,
  previewCreateEvent,
  previewDeleteEvent,
  previewReply,
  readCaldav,
  respondToInvitation,
  type SyncHttp,
} from "../src/index.js";
import { ALL_EVENTS, CLIENT_AGENT, INVITE, INVITE_BODY, OWN, SERIES } from "./caldav-fixtures.js";
import { HOME, WORK, fakeCaldav, type FakeCaldav } from "./caldav-server.js";
import { catalogOf } from "./helpers.js";

const seedType = (name: string) => parse(readFileSync(new URL(`../../../seed/connection-types/${name}/manifest.yaml`, import.meta.url), "utf8")) as Record<string, unknown>;
const TYPES = [seedType("caldav"), seedType("icloud-calendar"), seedType("fastmail-calendar")];

const USER = "me@example.com";
// an app password's shape (Apple's xxxx-xxxx-xxxx-xxxx); built at run time so no key-shaped literal is in the tree
const PASSWORD = ["qzvt", "hmwk", "rbxe", "lpfa"].join("-");
const ENCODED = Buffer.from(`${USER}:${PASSWORD}`).toString("base64");
const ENV = { METISTRY_SECRET_CALDAV_PASSWORD: PASSWORD };

/** Monday 28 September 2026, noon in New York. */
const WINDOW = { windowStart: Date.parse("2026-09-28T04:00:00Z"), windowEnd: Date.parse("2026-10-12T04:00:00Z"), ownerZone: "America/New_York" };

const servers: FakeCaldav[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function server(opts: Partial<Parameters<typeof fakeCaldav>[0]> = {}): Promise<FakeCaldav> {
  const s = await fakeCaldav({ username: USER, password: PASSWORD, events: ALL_EVENTS, ...opts });
  servers.push(s);
  return s;
}

const file = (url: string, over: Record<string, unknown> = {}) => ({
  name: "calendar",
  type: "calendar",
  provider: "caldav",
  reach: { http: { url, auth: { scheme: "basic", username: USER, secret: "caldav_password" } } },
  secrets: ["caldav_password"],
  ...over,
});

const policy = (hosts: string[], grantee = "connection:calendar") => `
secrets:
  caldav_password:
    hosts: [${hosts.join(", ")}]
    grants: { "${grantee}": on }
`;

function open(s: { url: string; host: string }, extra: { hosts?: string[]; file?: Record<string, unknown>; fetch?: typeof fetch; grantee?: string } = {}): SyncHttp {
  const catalog = catalogOf([extra.file ?? file(s.url)], { secrets: policy(extra.hosts ?? [s.host], extra.grantee), types: TYPES });
  const o = openSyncHttp({ catalog: { ...catalog, scheduled: null }, sync: "caldav-calendar", module: "caldav", secrets: envSecretSource(ENV), ...(extra.fetch ? { fetch: extra.fetch } : {}) });
  if (!o.ok) throw new Error(`expected an open sync, got ${o.status}: ${o.why}`);
  return o.sync;
}

/** Every logical line of a resource, unfolded. */
const logical = (text: string) => text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/).filter((l) => l !== "");

const neverTheSecret = (text: string) => {
  expect(text).not.toContain(PASSWORD);
  expect(text).not.toContain(ENCODED);
};

// ---- the XML reader ----------------------------------------------------------------------

describe("dav-xml — the WebDAV subset, hand-rolled", () => {
  it("reads namespaces (prefixed and default), entities, numeric references and CDATA", () => {
    const doc = parseXml(`<?xml version="1.0"?><!-- hi --><multistatus xmlns="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><response><href>/a%20b/</href><propstat><prop><c:calendar-data><![CDATA[BEGIN:VCALENDAR <x>]]>&amp;&#65;&#x42;</c:calendar-data></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>`);
    expect(doc).toMatchObject({ ns: "DAV:", name: "multistatus" });
    const r = parseMultistatus(`<d:multistatus xmlns:d="DAV:"><d:response><d:href>/x/</d:href><d:propstat><d:prop><d:displayname>A &lt;b&gt;</d:displayname></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat><d:propstat><d:prop><d:getetag/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response></d:multistatus>`);
    expect(r[0]?.href).toBe("/x/");
    expect(r[0]?.props.get("DAV:|displayname")?.text).toBe("A <b>");
    expect(r[0]?.props.has("DAV:|getetag")).toBe(false); // a 404 propstat gives nothing
    expect(doc.children[0]?.children[1]?.children[0]?.children[0]?.text).toBe("BEGIN:VCALENDAR <x>&AB");
  });

  it("**refuses a DOCTYPE — no server-defined entity is ever expanded** — and malformed documents", () => {
    expect(() => parseXml(`<!DOCTYPE x [<!ENTITY a "aaaa">]><x>&a;</x>`)).toThrow(DavXmlError);
    expect(() => parseXml(`<x>&a;</x>`)).toThrow(/entity/);
    expect(() => parseXml(`<a><b></a>`)).toThrow(DavXmlError);
    expect(() => parseXml(`<a>`)).toThrow(DavXmlError);
    expect(() => parseXml(`<p:a/>`)).toThrow(/prefix/);
    expect(() => parseMultistatus(`<html/>`)).toThrow(/multistatus/);
  });
});

// ---- the connection file -----------------------------------------------------------------

describe("the shipped CalDAV connection types", () => {
  it("validate: caldav, and the iCloud and Fastmail known services name their servers", () => {
    const [caldav, icloud, fastmail] = TYPES;
    expect(caldav).toMatchObject({ provides: "calendar", capabilities: ["read", "write_own", "rsvp"], sync: "caldav-calendar", implementation: { kind: "builtin", module: "caldav" } });
    expect(icloud).toMatchObject({ fields: [{ key: "server", default: "https://caldav.icloud.com/" }], implementation: { module: "caldav" } });
    expect(fastmail).toMatchObject({ fields: [{ key: "server", default: "https://caldav.fastmail.com/dav/" }], implementation: { module: "caldav" } });
    const c = catalogOf(
      [
        file("https://caldav.icloud.com/", { name: "icloud", provider: "icloud-calendar" }),
        file("https://p42-caldav.icloud.com/", { name: "icloud-home", provider: "icloud-calendar" }),
        file("https://caldav.fastmail.com/dav/", { name: "fastmail", provider: "fastmail-calendar" }),
        file("https://dav.example.com/"),
      ],
      { types: TYPES },
    );
    expect(c.entries.map((e) => [e.name, e.status, e.issues])).toEqual([
      ["icloud", "ok", []],
      ["icloud-home", "ok", []],
      ["fastmail", "ok", []],
      ["calendar", "ok", []],
    ]);
  });

  it("**a Google CalDAV address is refused: Google needs sign-in with Google**", () => {
    for (const url of ["https://apidata.googleusercontent.com/caldav/v2/owner%40gmail.com/events", "https://www.google.com/calendar/dav/owner@gmail.com/events", "https://calendar.google.com/"]) {
      const [e] = catalogOf([file(url)], { types: TYPES }).entries;
      expect(e?.status).toBe("failed");
      expect(e?.issues.join(" ")).toContain(GOOGLE_CALDAV_REFUSAL);
    }
  });

  it("a known service pointed elsewhere, plain http off this Mac, and a sign-in that is not an app password are refused", () => {
    const [elsewhere, http, bearer] = catalogOf(
      [
        file("https://caldav.fastmail.com/dav/", { name: "a", provider: "icloud-calendar" }),
        file("http://dav.example.com/", { name: "b" }),
        file("https://dav.example.com/", { name: "c", reach: { http: { url: "https://dav.example.com/", auth: { scheme: "bearer", secret: "caldav_password" } } } }),
      ],
      { types: TYPES },
    ).entries;
    expect(elsewhere?.issues.join(" ")).toContain("iCloud's server (https://caldav.icloud.com/)");
    expect(http?.issues.join(" ")).toContain("over https");
    expect(bearer?.issues.join(" ")).toContain("app password");
  });
});

// ---- the secret boundary -------------------------------------------------------------------

describe("the app password — Basic sign-in at the egress door", () => {
  it("the sync holds a reference; the server receives Basic base64(username:password), filled at the door", async () => {
    const s = await server();
    const sync = open(s);
    expect(sync.headers).toEqual({ authorization: "Basic {{ secret.caldav_password }}" });
    const account = await discoverCaldav(sync);
    expect(account).toEqual({ principal: `${s.origin}/principals/me/`, home: `${s.origin}${HOME}`, addresses: ["me@example.com"], scheduling: true });
    expect(s.requests.every((r) => r.headers.authorization === `Basic ${ENCODED}`)).toBe(true);
    expect(sync.secretsUsed()).toEqual(["caldav_password"]);
  });

  it("**a secret whose Sent-only-to list does not name the server is not sent — to it or anywhere**", async () => {
    const s = await server();
    const err = await discoverCaldav(open(s, { hosts: ["caldav.example.net"] })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EgressRefused);
    expect((err as EgressRefused).code).toBe("host_not_listed");
    expect(s.requests).toHaveLength(0);
    neverTheSecret(String(err));
  });

  it("**not granted to the connection is refused at the door**", async () => {
    const s = await server();
    await expect(discoverCaldav(open(s, { grantee: "connection:other" }))).rejects.toMatchObject({ code: "not_granted" });
    expect(s.requests).toHaveLength(0);
  });

  it("**a calendar home on another origin is refused, naming it — and nothing is sent there**", async () => {
    const elsewhere = await server();
    const s = await server({ homeOrigin: elsewhere.origin });
    const err = await readCaldav(open(s, { hosts: [s.host, elsewhere.host] }), WINDOW).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CaldavError);
    expect((err as CaldavError).code).toBe("other_host");
    expect(String(err)).toContain(elsewhere.origin);
    expect(String(err)).toContain(`--url ${elsewhere.origin}/`);
    expect(elsewhere.requests).toHaveLength(0);
    neverTheSecret(String(err));
  });

  it("**a redirect is not followed — the password never reaches where it points**", async () => {
    const thief = await server();
    const s = await server({ redirectTo: `${thief.origin}/steal` });
    const err = await discoverCaldav(open(s, { hosts: [s.host, thief.host] })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectionRefused);
    expect((err as ConnectionRefused).code).toBe("other_host");
    expect(thief.requests).toHaveLength(0);
  });

  it("**a wrong password is `unauthorized`, and the error carries neither the password nor its encoding**", async () => {
    const s = await server({ password: "not-the-one" });
    const err = await discoverCaldav(open(s)).catch((e: unknown) => e);
    expect((err as CaldavError).code).toBe("unauthorized");
    expect(String(err)).toContain("app password");
    neverTheSecret(String(err));
    neverTheSecret(JSON.stringify(err, Object.getOwnPropertyNames(err)));
  });

  it("**a server that echoes the credential gets its name back, never the value**", async () => {
    const s = await server();
    const echo = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const auth = new Headers(init.headers).get("authorization") ?? "";
      return new Response(`<d:multistatus xmlns:d="DAV:"><d:response><d:href>/${auth} ${Buffer.from(auth.slice(6), "base64").toString()}</d:href></d:response></d:multistatus>`, { status: 207, headers: { "x-echo": auth } });
    }) as typeof fetch;
    const sync = open(s, { fetch: echo });
    const res = await sync.fetch(s.url, { method: "PROPFIND", headers: sync.headers, body: "<x/>" });
    const text = await res.text();
    neverTheSecret(text);
    neverTheSecret(res.headers.get("x-echo") ?? "");
    expect(text).toContain("REDACTED secret.caldav_password");
  });

  it("a username with a colon is refused — the server would split the pair there", async () => {
    const s = await server();
    const catalog = catalogOf([file(s.url, { reach: { http: { url: s.url, auth: { scheme: "basic", username: "me:x", secret: "caldav_password" } } } })], { secrets: policy([s.host]), types: TYPES });
    expect(openSyncHttp({ catalog: { ...catalog, scheduled: null }, sync: "caldav-calendar", module: "caldav", secrets: envSecretSource(ENV) })).toMatchObject({ ok: false, status: "failed", why: expect.stringContaining("colon") });
  });
});

// ---- read ----------------------------------------------------------------------------------

describe("readCaldav — the account's events in the window, the owner found by the server's addresses", () => {
  it("expands every event-holding calendar, marks the owner and their answer, and never reads an invite body", async () => {
    const s = await server({ addresses: ["mailto:ME@example.com", "mailto:me@example.com", "urn:uuid:1234"] });
    const read = await readCaldav(open(s), WINDOW);
    expect(read.account.addresses).toEqual(["me@example.com"]);
    expect(read.calendars).toBe(1); // the task list holds no events, and is not read
    expect(s.requests.filter((r) => r.method === "REPORT").map((r) => r.path)).toEqual([WORK]);
    expect(s.requests.find((r) => r.method === "REPORT")?.body).toContain('<c:time-range start="20260928T040000Z" end="20261012T040000Z"/>');
    const vendor = read.events.find((e) => e.ical_uid === "vendor-review-0929@example.com");
    expect(vendor).toMatchObject({ event_id: "vendor-review-0929@example.com", title: "Vendor review", start: "2026-09-29T18:00:00.000Z", location: "Room 4, second floor", organizer: { email: "dana@example.com" }, self_status: "pending" });
    expect(vendor?.participants.filter((p) => p.self).map((p) => p.email)).toEqual(["me@example.com"]);
    const moved = read.events.find((e) => e.event_id === "standup-7f3a@example.com_20260930T133000Z");
    expect(moved).toMatchObject({ title: "Standup (moved)", start: "2026-09-30T15:30:00.000Z", self_status: "pending" });
    expect(read.events.find((e) => e.ical_uid === "dentist-1@example.com")?.self_status).toBeNull();
    expect(read.events.find((e) => e.ical_uid === "their-4@example.com")?.self_status).toBeNull();
    expect(JSON.stringify(read)).not.toContain(INVITE_BODY);
  });

  it("reads calendar-data sent as CDATA the same way", async () => {
    const s = await server({ cdata: true });
    expect((await readCaldav(open(s), WINDOW)).events.some((e) => e.ical_uid === "vendor-review-0929@example.com")).toBe(true);
  });
});

// ---- reply -----------------------------------------------------------------------------------

describe("rsvp — the owner's PARTSTAT, and nothing else", () => {
  it("**only the owner's own attendee line changes** — and the server delivers the REPLY to the organizer", async () => {
    const s = await server();
    const sync = open(s);
    const before = s.resources.get(`${WORK}vendor-review.ics`)!;
    const preview = await previewReply(sync, { uid: "vendor-review-0929@example.com", response: "accepted" });
    expect(preview).toMatchObject({ title: "Vendor review", organizer: "dana@example.com", as: "me@example.com", etag: before.etag, unchanged: false });
    expect(preview.changes).toHaveLength(1);
    expect(preview.changes[0]?.after).toBe('ATTENDEE;CN="Owner, The (a name long enough that the line is folded on the wire)";CUTYPE=INDIVIDUAL;PARTSTAT=ACCEPTED;ROLE=REQ-PARTICIPANT:mailto:me@example.com');
    expect(s.requests.some((r) => r.method === "PUT")).toBe(false); // a preview writes nothing

    const done = await respondToInvitation(sync, { uid: "vendor-review-0929@example.com", response: "accepted", etag: preview.etag });
    expect(done.unchanged).toBe(false);
    const after = s.resources.get(`${WORK}vendor-review.ics`)!;
    const a = logical(before.data);
    const b = logical(after.data);
    expect(b).toHaveLength(a.length);
    const differing = a.map((line, i) => [line, b[i]] as const).filter(([x, y]) => x !== y);
    expect(differing).toEqual([[preview.changes[0]!.before, preview.changes[0]!.after]]);
    // the VALARM's attendee (an email alarm, not an invitation) is untouched; so are the others
    expect(b).toContain("ATTENDEE:mailto:me@example.com");
    expect(b).toContain("ATTENDEE;CN=Dana Scully;PARTSTAT=ACCEPTED;ROLE=CHAIR:mailto:dana@example.com");
    expect(b.some((l) => l.includes("fox@example.com") && l.includes("PARTSTAT=TENTATIVE;RSVP=TRUE"))).toBe(true);
    // written with If-Match on the previewed ETag; lines stay within 75 octets, CRLF kept
    const put = s.requests.find((r) => r.method === "PUT")!;
    expect(put.headers["if-match"]).toBe(before.etag);
    const written = after.data.split("\r\n").filter((l) => !before.data.split("\r\n").includes(l));
    expect(written.length).toBeGreaterThan(1); // the owner's line, refolded
    expect(written.every((l) => Buffer.byteLength(l) <= 75)).toBe(true);
    expect(after.data.replace(/\r\n/g, "")).not.toMatch(/\n/);
    expect(s.replies).toEqual([{ uid: "vendor-review-0929@example.com", partstat: "ACCEPTED", to: "dana@example.com" }]);
  });

  it("**a series: the owner's line in the event and in its moved occurrence change, and nothing else**", async () => {
    const s = await server();
    const sync = open(s);
    const before = logical(SERIES);
    const preview = await previewReply(sync, { uid: "standup-7f3a@example.com", response: "tentative" });
    await respondToInvitation(sync, { uid: "standup-7f3a@example.com", response: "tentative", etag: preview.etag });
    const after = logical(s.resources.get(`${WORK}standup.ics`)!.data);
    expect(before.map((l, i) => [l, after[i]]).filter(([x, y]) => x !== y)).toEqual([
      ["ATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:Me@Example.com", "ATTENDEE;PARTSTAT=TENTATIVE:mailto:Me@Example.com"],
      ["ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:me@example.com", "ATTENDEE;PARTSTAT=TENTATIVE:mailto:me@example.com"],
    ]);
  });

  it("**a confirm is bound to the previewed ETag: an event changed since is refused, and nothing is written**", async () => {
    const s = await server();
    const sync = open(s);
    const preview = await previewReply(sync, { uid: "vendor-review-0929@example.com", response: "declined" });
    s.touch(`${WORK}vendor-review.ics`);
    await expect(respondToInvitation(sync, { uid: "vendor-review-0929@example.com", response: "declined", etag: preview.etag })).rejects.toMatchObject({ code: "changed" });
    expect(s.requests.some((r) => r.method === "PUT")).toBe(false);
    await expect(respondToInvitation(sync, { uid: "vendor-review-0929@example.com", response: "declined", etag: "" })).rejects.toMatchObject({ code: "bad_request" });
  });

  it("refusals, each before anything is written: organised by the owner, not an attendee, no such event, a client-delivered reply, a server that does not schedule", async () => {
    const s = await server();
    const sync = open(s);
    await expect(previewReply(sync, { uid: "planning-2@example.com", response: "accepted" })).rejects.toMatchObject({ code: "not_invited" });
    await expect(previewReply(sync, { uid: "their-4@example.com", response: "accepted" })).rejects.toMatchObject({ code: "not_invited" });
    await expect(previewReply(sync, { uid: "nope@example.com", response: "accepted" })).rejects.toMatchObject({ code: "not_found" });
    await expect(previewReply(sync, { uid: "offsite-3@example.com", response: "accepted" })).rejects.toMatchObject({ code: "no_scheduling" });
    await expect(previewReply(sync, { uid: "vendor-review-0929@example.com", response: "maybe" as never })).rejects.toMatchObject({ code: "bad_request" });
    const plain = await server({ scheduling: false });
    await expect(previewReply(open(plain), { uid: "vendor-review-0929@example.com", response: "accepted" })).rejects.toMatchObject({ code: "no_scheduling" });
    expect([...s.requests, ...plain.requests].some((r) => r.method === "PUT")).toBe(false);
  });

  it("a server that refuses the change (RFC 6638's 403) is http_status naming it — not a sign-in failure", async () => {
    const s = await server({ forbidWrites: true });
    const sync = open(s);
    const preview = await previewReply(sync, { uid: "vendor-review-0929@example.com", response: "accepted" });
    const err = await respondToInvitation(sync, { uid: "vendor-review-0929@example.com", response: "accepted", etag: preview.etag }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "http_status" });
    expect(String(err)).toContain("refused the reply (HTTP 403)");
    neverTheSecret(String(err));
  });

  it("a UID lookup is a substring match on the server, so the UID is compared exactly after", async () => {
    const s = await server();
    await expect(previewReply(open(s), { uid: "vendor-review", response: "accepted" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("answering again with the same answer writes nothing", async () => {
    const plan = planReply(planReply(INVITE, ["me@example.com"], "vendor-review-0929@example.com", "accepted").text, ["me@example.com"], "vendor-review-0929@example.com", "accepted");
    expect(plan).toMatchObject({ unchanged: true, changes: [] });
  });
});

describe("planReply and foldLine — the text edit", () => {
  it("appends PARTSTAT when the line had none, keeps LF endings, and keeps a quoted parameter's colon", () => {
    const text = CLIENT_AGENT.replace(";SCHEDULE-AGENT=CLIENT", "").replace("ATTENDEE;PARTSTAT=NEEDS-ACTION:", 'ATTENDEE;DELEGATED-FROM="mailto:x@example.com":').replace(/\r\n/g, "\n");
    const plan = planReply(text, ["me@example.com"], "offsite-3@example.com", "declined");
    expect(plan.changes).toEqual([{ before: 'ATTENDEE;DELEGATED-FROM="mailto:x@example.com":mailto:me@example.com', after: 'ATTENDEE;DELEGATED-FROM="mailto:x@example.com";PARTSTAT=DECLINED:mailto:me@example.com' }]);
    expect(plan.text).not.toContain("\r");
    expect(logical(plan.text).filter((l, i) => l !== logical(text)[i])).toEqual(['ATTENDEE;DELEGATED-FROM="mailto:x@example.com";PARTSTAT=DECLINED:mailto:me@example.com']);
  });

  it("folds at 75 octets, never inside a UTF-8 character", () => {
    const line = `ATTENDEE;CN="${"é".repeat(60)}";PARTSTAT=ACCEPTED:mailto:me@example.com`;
    const folded = foldLine(line, "\r\n");
    for (const part of folded.split("\r\n")) expect(Buffer.byteLength(part)).toBeLessThanOrEqual(75);
    expect(folded.split("\r\n").map((p, i) => (i === 0 ? p : p.slice(1))).join("")).toBe(line);
    expect(folded).not.toContain("�");
  });

  it("no address for the owner is no_scheduling — never a guess from a name", () => {
    expect(() => planReply(INVITE, [], "vendor-review-0929@example.com", "accepted")).toThrow(/no calendar address/);
  });
});

// ---- write own -------------------------------------------------------------------------------

describe("write_own — the owner's events, nobody else's, bound to the preview", () => {
  it("creates an event with nobody in it, named for its UID, never replacing one", async () => {
    const s = await server();
    const sync = open(s);
    const draft = { title: "Focus; deep work", start: "2026-10-01T13:00:00Z", end: "2026-10-01T15:00:00Z", location: "Home" };
    const preview = await previewCreateEvent(sync, { draft, now: Date.parse("2026-09-28T16:00:00Z") });
    expect(preview.calendar).toBe(`${s.origin}${WORK}`);
    expect(preview.changes.map((c) => c.after)).toContain("SUMMARY:Focus\\; deep work");
    expect(s.requests.some((r) => r.method === "PUT")).toBe(false);
    const done = await createOwnEvent(sync, { uid: preview.uid, draft, now: Date.parse("2026-09-28T16:00:00Z") });
    const stored = s.resources.get(`${WORK}${preview.uid}.ics`)!;
    expect(stored.data).toContain("DTSTART:20261001T130000Z");
    expect(stored.data).not.toMatch(/ORGANIZER|ATTENDEE/);
    expect(done.etag).toBe(stored.etag);
    expect(s.requests.find((r) => r.method === "PUT")?.headers["if-none-match"]).toBe("*");
    await expect(createOwnEvent(sync, { uid: preview.uid, draft })).rejects.toMatchObject({ code: "changed" });
    await expect(createOwnEvent(sync, { uid: "../../evil", draft })).rejects.toMatchObject({ code: "bad_request" });
    await expect(previewCreateEvent(sync, { draft: { ...draft, end: draft.start } })).rejects.toMatchObject({ code: "bad_request" });
  });

  it("changes the owner's own event: the named fields, its stamps and sequence, nothing else", async () => {
    const s = await server();
    const sync = open(s);
    const now = Date.parse("2026-09-28T16:00:00Z");
    const preview = await previewChangeEvent(sync, { uid: "dentist-1@example.com", change: { title: "Dentist (moved)", start: "2026-10-02T17:00:00Z", end: "2026-10-02T18:00:00Z" }, now });
    await changeOwnEvent(sync, { uid: "dentist-1@example.com", change: { title: "Dentist (moved)", start: "2026-10-02T17:00:00Z", end: "2026-10-02T18:00:00Z" }, etag: preview.etag!, now });
    const after = s.resources.get(`${WORK}dentist.ics`)!.data;
    expect(after.split("\n")).toEqual([
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Example Corp//Calendar 1.0//EN",
      "BEGIN:VEVENT",
      "UID:dentist-1@example.com",
      "DTSTAMP:20260928T160000Z",
      "DTSTART:20261002T170000Z",
      "SUMMARY:Dentist (moved)",
      "SEQUENCE:4",
      "DTEND:20261002T180000Z",
      "LAST-MODIFIED:20260928T160000Z",
      "END:VEVENT",
      "END:VCALENDAR",
      "",
    ]);
    expect(OWN).toContain("DURATION:PT1H");
  });

  it("**an event with anyone else in it is not the owner's to change or delete**, and a series is not rewritten", async () => {
    const s = await server();
    const sync = open(s);
    await expect(previewChangeEvent(sync, { uid: "vendor-review-0929@example.com", change: { title: "mine now" } })).rejects.toMatchObject({ code: "not_own" });
    await expect(previewChangeEvent(sync, { uid: "planning-2@example.com", change: { title: "x" } })).rejects.toMatchObject({ code: "not_own" });
    await expect(previewDeleteEvent(sync, { uid: "vendor-review-0929@example.com" })).rejects.toMatchObject({ code: "not_own" });
    const etag = s.resources.get(`${WORK}vendor-review.ics`)!.etag;
    await expect(deleteOwnEvent(sync, { uid: "vendor-review-0929@example.com", etag })).rejects.toMatchObject({ code: "not_own" });
    await expect(changeOwnEvent(sync, { uid: "vendor-review-0929@example.com", change: { title: "x" }, etag })).rejects.toMatchObject({ code: "not_own" });
    await expect(previewChangeEvent(sync, { uid: "standup-7f3a@example.com", change: { title: "x" } })).rejects.toMatchObject({ code: "not_own" });
    const ownSeries = OWN.replace("DURATION:PT1H", "DURATION:PT1H\nRRULE:FREQ=WEEKLY");
    expect(() => planOwnChange(ownSeries, ["me@example.com"], "dentist-1@example.com", { title: "x" }, 0)).toThrow(/recurring/);
    expect(s.requests.some((r) => r.method === "PUT" || r.method === "DELETE")).toBe(false);
  });

  it("deletes the owner's own event with If-Match; a stale ETag is refused", async () => {
    const s = await server();
    const sync = open(s);
    const preview = await previewDeleteEvent(sync, { uid: "dentist-1@example.com" });
    expect(preview.title).toBe("Dentist");
    s.touch(`${WORK}dentist.ics`);
    await expect(deleteOwnEvent(sync, { uid: "dentist-1@example.com", etag: preview.etag! })).rejects.toMatchObject({ code: "changed" });
    const fresh = await previewDeleteEvent(sync, { uid: "dentist-1@example.com" });
    await deleteOwnEvent(sync, { uid: "dentist-1@example.com", etag: fresh.etag! });
    expect(s.resources.has(`${WORK}dentist.ics`)).toBe(false);
    expect(s.requests.find((r) => r.method === "DELETE")?.headers["if-match"]).toBe(fresh.etag);
  });
});
