// The Google Calendar provider (plan §2.6, §4 Q7 second; T4-14; ruling
// 2026-09-30, Q8), against a fixture Google on loopback (`google-server.ts`:
// T4-10's authorization server at Google's addresses, and the Calendar API
// over the fixtures in `google-fixtures.ts`) — never Google. Bold, the
// ticket's own:
//
//   **only `responseStatus` of the self attendee is sent** when the owner
//   answers an invitation — the PATCH body is exactly the owner's address and
//   answer, with `attendeesOmitted`;
//   **a bring-your-own client id overrides the shipped one** — in the address
//   the browser opens and at the token endpoint.
//
// And the rest: the connection type as shipped; a connection pointed anywhere
// but the Calendar API refused at the file; the sign-in's token sent to
// exactly the token endpoint and the API, or the connection not opened; the
// access token minted once and reused, never sent elsewhere, never through a
// redirect; the recorded answers read into occurrences with the owner's own
// answer and never the description; write_own only for events nobody else is
// in; every change bound to the ETag its preview read.

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { EgressRefused, SecretRedactor, parseSecretsFile } from "@foldedspacelabs/metistry-core";
import {
  ConnectionRefused,
  GOOGLE_CALENDAR_ORIGIN,
  GOOGLE_CALENDAR_URL,
  GOOGLE_LIST_FIELDS,
  GOOGLE_TOKEN_HOSTS,
  GoogleCalendarError,
  OAuthError,
  authorizeConnection,
  changeOwnGoogleEvent,
  createOwnGoogleEvent,
  deleteOwnGoogleEvent,
  envSecretSource,
  newGoogleEventId,
  oauthClientOf,
  openSyncHttp,
  previewChangeGoogleEvent,
  previewCreateGoogleEvent,
  previewDeleteGoogleEvent,
  previewGoogleReply,
  readGoogleCalendar,
  respondToGoogleInvitation,
  type OAuthCache,
  type SyncHttp,
} from "../src/index.js";
import { catalogOf } from "./helpers.js";
import { CANCELLED, HOSTED, INVITE, INVITE_BODY, OFFSITE, OWN, OWNER, STANDUP, STANDUP_SERIES, WORKING_LOCATION } from "./google-fixtures.js";
import { fakeGoogle, type FakeGoogle, type FakeGoogleOptions } from "./google-server.js";

const SEED = parse(readFileSync(new URL("../../../seed/connection-types/google-calendar/manifest.yaml", import.meta.url), "utf8")) as Record<string, any>;
const SHIPPED = "1234-shipped.apps.googleusercontent.com";
const OWN_CLIENT = "5678-own.apps.googleusercontent.com";
/** The seed with the maintainer's client id in it — the shape it has once that client exists (§3.4). */
const WITH_SHIPPED = { ...SEED, fields: SEED.fields.map((f: Record<string, any>) => (f.kind === "oauth" ? { ...f, oauth: { ...f.oauth, client_id: SHIPPED } } : f)) };

/** Monday 28 September 2026, the owner's two weeks in New York. */
const WINDOW = { windowStart: Date.parse("2026-09-28T04:00:00Z"), windowEnd: Date.parse("2026-10-12T04:00:00Z"), ownerZone: "America/New_York" };

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
});
async function google(opts: FakeGoogleOptions = {}): Promise<FakeGoogle> {
  const g = await fakeGoogle({ clients: [SHIPPED, OWN_CLIENT], ...opts });
  closers.push(() => g.close());
  return g;
}

const file = (over: Record<string, unknown> = {}, config: Record<string, string> = {}) => ({
  name: "google",
  type: "calendar",
  provider: "google-calendar",
  reach: { http: { url: GOOGLE_CALENDAR_URL, auth: "oauth" } },
  config: { google: { token: "{{ secret.google_oauth_token }}", ...config } },
  secrets: ["google_oauth_token", ...Object.values(config).map((v) => /secret\.([a-z_]+)/.exec(v)![1]!)],
  ...over,
});

const policy = (hosts: readonly string[] = GOOGLE_TOKEN_HOSTS, extra = "") => `
secrets:
  google_oauth_token:
    hosts: [${hosts.join(", ")}]
    grants: { "connection:google": on }
${extra}`;

const OWN_CLIENT_POLICY = `  google_client_id:
    hosts: [accounts.google.com, oauth2.googleapis.com]
    grants: { "connection:google": on }
`;

function entryOf(f: Record<string, unknown>, secrets = policy(), types: Record<string, unknown>[] = [WITH_SHIPPED]) {
  const catalog = catalogOf([f], { secrets, types });
  const entry = catalog.entries[0]!;
  expect(entry.status, entry.issues.join("; ")).toBe("ok");
  return { catalog, entry, secretsFile: parseSecretsFile(secrets) };
}

/** Sign in through the one flow, at Google's addresses: the refresh token it kept. */
async function signIn(g: FakeGoogle, f = file(), secrets = policy(), values: Record<string, string> = {}): Promise<{ refresh: string; notices: Array<string | undefined>; result: Awaited<ReturnType<typeof authorizeConnection>> }> {
  const { entry, secretsFile } = entryOf(f, secrets);
  const kept = new Map<string, string>();
  const notices: Array<string | undefined> = [];
  const result = await authorizeConnection(entry, {
    secrets: secretsFile,
    source: { value: async (n) => values[n] },
    redactor: new SecretRedactor(),
    fetch: g.routeTo(),
    store: { set: async (n, v) => void kept.set(n, v) },
    onListening: ({ notice }) => void notices.push(notice),
    open: (url) => void g.browse(url),
  });
  return { refresh: kept.get("google_oauth_token")!, notices, result };
}

function open(g: FakeGoogle, refresh: string | undefined, extra: { secrets?: string; oauth?: OAuthCache; fetch?: typeof fetch; tokenHosts?: readonly string[] } = {}) {
  const catalog = catalogOf([file()], { secrets: extra.secrets ?? policy(), types: [WITH_SHIPPED] });
  return openSyncHttp({
    catalog: { ...catalog, scheduled: null },
    sync: "google-calendar",
    origin: GOOGLE_CALENDAR_ORIGIN,
    module: "google-calendar",
    tokenHosts: extra.tokenHosts ?? GOOGLE_TOKEN_HOSTS,
    secrets: envSecretSource(refresh ? { METISTRY_SECRET_GOOGLE_OAUTH_TOKEN: refresh } : {}),
    fetch: extra.fetch ?? g.routeTo(),
    ...(extra.oauth ? { oauth: extra.oauth } : {}),
  });
}

async function signedIn(opts: FakeGoogleOptions = {}): Promise<{ g: FakeGoogle; sync: SyncHttp; refresh: string }> {
  const g = await google(opts);
  const { refresh } = await signIn(g);
  const o = open(g, refresh);
  if (!o.ok) throw new Error(`expected an open sync, got ${o.status}: ${o.why}`);
  return { g, sync: o.sync, refresh };
}

const writes = (g: FakeGoogle) => g.api.filter((r) => r.method !== "GET");

// ---- the connection type ------------------------------------------------------------------

describe("the google-calendar connection type, as shipped", () => {
  it("is a calendar read by the google-calendar sync, with read, write_own and rsvp, signed in with Google only", () => {
    const { entry } = entryOf(file(), policy(), [SEED]);
    expect(entry.provider?.manifest).toMatchObject({
      provides: "calendar",
      capabilities: ["read", "write_own", "rsvp"],
      auth: ["oauth"],
      sync: "google-calendar",
      implementation: { kind: "builtin", module: "google-calendar" },
    });
  });

  it("asks for calendar.events and nothing else, at Google's own endpoints, as a public client with PKCE and a loopback", () => {
    const field = SEED.fields.find((f: Record<string, unknown>) => f.kind === "oauth");
    expect(field.oauth).toEqual({
      pkce: true,
      redirect: "loopback",
      authorize_url: "https://accounts.google.com/o/oauth2/v2/auth",
      token_url: "https://oauth2.googleapis.com/token",
      scopes: ["https://www.googleapis.com/auth/calendar.events"],
    });
    expect(Object.keys(field.oauth)).not.toContain("client_secret");
  });

  it("says *Google hasn't verified this app* before the browser opens — for the shipped client only", () => {
    const { entry } = entryOf(file());
    expect(oauthClientOf(entry).notice).toMatch(/Google hasn't verified this app/);
    const own = entryOf(file({}, { client_id: "{{ secret.google_client_id }}" }), policy(GOOGLE_TOKEN_HOSTS, OWN_CLIENT_POLICY));
    expect(oauthClientOf(own.entry).notice).toBeUndefined();
  });

  it("ships no client id until the maintainer's client exists — a connection then names the owner's own", () => {
    const { entry } = entryOf(file(), policy(), [SEED]);
    expect(() => oauthClientOf(entry)).toThrow(OAuthError);
    expect(() => oauthClientOf(entry)).toThrow(/signs in with your own .*--client-id-secret/);
    const own = entryOf(file({}, { client_id: "{{ secret.google_client_id }}" }), policy(GOOGLE_TOKEN_HOSTS, OWN_CLIENT_POLICY), [SEED]);
    expect(oauthClientOf(own.entry).clientId).toEqual({ kind: "secret", name: "google_client_id" });
  });

  it("refuses at the file a connection pointed anywhere but the Calendar API, or signed in any way but Google's", () => {
    const judged = (f: Record<string, unknown>) => catalogOf([f], { types: [SEED] }).entries[0]!;
    for (const url of ["https://evil.example.test/calendar/v3/", "https://www.googleapis.com/gmail/v1/", "https://www.googleapis.com/calendar/v3/?key=x", "http://www.googleapis.com/calendar/v3/"]) {
      const e = judged(file({ reach: { http: { url, auth: "oauth" } } }));
      expect(e.status, url).toBe("failed");
      expect(e.issues.join("; "), url).toMatch(/reached at https:\/\/www\.googleapis\.com\/calendar\/v3\/ and nowhere else/);
    }
    const basic = judged(file({ reach: { http: { url: GOOGLE_CALENDAR_URL, auth: { scheme: "basic", username: OWNER, secret: "pw" } } }, config: {}, secrets: ["pw"] }));
    expect(basic.status).toBe("failed");
    expect(basic.issues.join("; ")).toMatch(/signs in with oauth, not basic/);
    const header = judged(file({ reach: { http: { url: GOOGLE_CALENDAR_URL, auth: "oauth", headers: { "X-Goog-User-Project": "p" } } } }));
    expect(header.issues.join("; ")).toMatch(/sends no headers of its own/);
    expect(judged(file({ reach: { http: { url: "https://www.googleapis.com/calendar/v3", auth: "oauth" } } })).status).toBe("ok");
  });
});

// ---- sign in -------------------------------------------------------------------------------

describe("sign in with Google — Metistry's own OAuth door at Google's addresses", () => {
  it("the shipped client: PKCE, the loopback, calendar.events; the refresh token is what is kept; the notice said before the browser", async () => {
    const g = await google();
    const { refresh, notices, result } = await signIn(g);
    expect(result).toMatchObject({ connection: "google", stored: "google_oauth_token", client: "shipped", scopes: ["https://www.googleapis.com/auth/calendar.events"] });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/Google hasn't verified this app/);
    const q = g.auth.authorizeRequests[0]!;
    expect(q.get("client_id")).toBe(SHIPPED);
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("scope")).toBe("https://www.googleapis.com/auth/calendar.events");
    expect(new URL(q.get("redirect_uri")!).hostname).toBe("127.0.0.1");
    const t = g.auth.tokenRequests[0]!;
    expect(t).toMatchObject({ grant_type: "authorization_code", client_id: SHIPPED, client_secret: null });
    expect(g.auth.issuedRefresh).toEqual([refresh]);
    expect(g.api).toEqual([]); // signing in reads nothing
  });

  it("**a bring-your-own client id overrides the shipped one** — in the address the browser opens and at the token endpoint", async () => {
    const g = await google();
    const f = file({}, { client_id: "{{ secret.google_client_id }}" });
    const { entry } = entryOf(f, policy(GOOGLE_TOKEN_HOSTS, OWN_CLIENT_POLICY));
    expect(oauthClientOf(entry).clientId).toEqual({ kind: "secret", name: "google_client_id" });
    const { refresh, notices, result } = await signIn(g, f, policy(GOOGLE_TOKEN_HOSTS, OWN_CLIENT_POLICY), { google_client_id: OWN_CLIENT });
    expect(result.client).toBe("yours");
    expect(notices).toEqual([undefined]); // Metistry's words are about Metistry's client
    expect(g.auth.authorizeRequests[0]!.get("client_id")).toBe(OWN_CLIENT);
    expect(g.auth.tokenRequests.map((t) => t.client_id)).toEqual([OWN_CLIENT]);
    expect(JSON.stringify(g.auth.authorizeRequests.map((q) => q.toString()))).not.toContain(SHIPPED);

    // and on every refresh after: the owner's client, never the shipped one
    const catalog = catalogOf([f], { secrets: policy(GOOGLE_TOKEN_HOSTS, OWN_CLIENT_POLICY), types: [WITH_SHIPPED] });
    const o = openSyncHttp({
      catalog: { ...catalog, scheduled: null },
      sync: "google-calendar",
      origin: GOOGLE_CALENDAR_ORIGIN,
      module: "google-calendar",
      tokenHosts: GOOGLE_TOKEN_HOSTS,
      secrets: envSecretSource({ METISTRY_SECRET_GOOGLE_OAUTH_TOKEN: refresh, METISTRY_SECRET_GOOGLE_CLIENT_ID: OWN_CLIENT }),
      fetch: g.routeTo(),
    });
    if (!o.ok) throw new Error(o.why);
    await readGoogleCalendar(o.sync, WINDOW);
    expect(g.auth.tokenRequests.map((t) => [t.grant_type, t.client_id])).toEqual([
      ["authorization_code", OWN_CLIENT],
      ["refresh_token", OWN_CLIENT],
    ]);
    expect(o.sync.secretsUsed()).toEqual(["google_client_id", "google_oauth_token"]);
  });

  it("a client secret is the owner's secret — sent to the token endpoint only, when the owner names one", async () => {
    const g = await google({ secrets: { [SHIPPED]: "desktop-client-secret-value" } });
    const f = file({}, { client_secret: "{{ secret.google_client_secret }}" });
    const secrets = policy(GOOGLE_TOKEN_HOSTS, `  google_client_secret:\n    hosts: [oauth2.googleapis.com]\n    grants: { "connection:google": on }\n`);
    await signIn(g, f, secrets, { google_client_secret: "desktop-client-secret-value" });
    expect(g.auth.tokenRequests[0]).toMatchObject({ client_id: SHIPPED, client_secret: "desktop-client-secret-value" });
    expect(g.auth.authorizeRequests[0]!.toString()).not.toContain("desktop-client-secret-value");
  });
});

// ---- the sync opener -------------------------------------------------------------------------

describe("the sync opener — the sign-in's token goes to exactly the token endpoint and the Calendar API", () => {
  it("opens with the token secret sent to exactly oauth2.googleapis.com and www.googleapis.com", async () => {
    const g = await google();
    const o = open(g, "rt_x");
    expect(o.ok).toBe(true);
    if (o.ok) expect(o.sync).toMatchObject({ origin: GOOGLE_CALENDAR_ORIGIN, headers: { authorization: "Bearer {{ secret.google_oauth_token }}" } });
  });

  it("refuses to open — sending nothing — when the list says more, less, or nothing", async () => {
    const g = await google();
    for (const hosts of [[...GOOGLE_TOKEN_HOSTS, "evil.example.test"], ["oauth2.googleapis.com"], ["www.googleapis.com"], []]) {
      const o = open(g, "rt_x", { secrets: policy(hosts) });
      expect(o.ok, hosts.join(",")).toBe(false);
      if (!o.ok) {
        expect(o.status).toBe("failed");
        expect(o.why).toMatch(/is sent to exactly oauth2\.googleapis\.com and www\.googleapis\.com/);
        expect(o.why).toMatch(/metistry secrets hosts google_oauth_token oauth2\.googleapis\.com www\.googleapis\.com/);
      }
    }
    expect(g.api).toEqual([]);
    expect(g.auth.tokenRequests).toEqual([]);
  });

  it("refuses a token endpoint that is not one of the sync's hosts", async () => {
    const g = await google();
    const o = open(g, "rt_x", { tokenHosts: ["login.example.test", "www.googleapis.com"] });
    expect(o.ok).toBe(false);
    if (!o.ok) expect(o.why).toMatch(/token endpoint \(oauth2\.googleapis\.com\) is not one of the hosts/);
  });

  it("not signed in yet: the read stops at the door, naming the secret — nothing reaches Google", async () => {
    const g = await google();
    const o = open(g, undefined);
    if (!o.ok) throw new Error(o.why);
    await expect(readGoogleCalendar(o.sync, WINDOW)).rejects.toBeInstanceOf(EgressRefused);
    await expect(readGoogleCalendar(o.sync, WINDOW)).rejects.toMatchObject({ code: "missing_secret" });
    expect(g.api).toEqual([]);
  });

  it("a revoked sign-in is `sign_in`, naming authorize — and the API is sent nothing", async () => {
    const g = await google();
    const o = open(g, "rt_not_one_google_issued");
    if (!o.ok) throw new Error(o.why);
    const err = await readGoogleCalendar(o.sync, WINDOW).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectionRefused);
    expect((err as ConnectionRefused).code).toBe("sign_in");
    expect((err as Error).message).toMatch(/metistry connections authorize google/);
    expect(g.api).toEqual([]);
  });

  it("mints the access token once and reuses it across runs (the opener's cache); sends it as Bearer to the API only", async () => {
    const g = await google();
    const { refresh } = await signIn(g);
    const cache: OAuthCache = new Map();
    for (let i = 0; i < 3; i++) {
      const o = open(g, refresh, { oauth: cache });
      if (!o.ok) throw new Error(o.why);
      await readGoogleCalendar(o.sync, WINDOW);
    }
    expect(g.auth.tokenRequests.filter((t) => t.grant_type === "refresh_token")).toHaveLength(1);
    const access = g.auth.issuedAccess.at(-1)!;
    expect(new Set(g.api.map((r) => r.headers.authorization))).toEqual(new Set([`Bearer ${access}`]));
    // the refresh token went to the token endpoint and nowhere else
    expect(JSON.stringify(g.api)).not.toContain(refresh);
  });

  it("reaches www.googleapis.com and nothing else, and follows no redirect", async () => {
    const { sync, g } = await signedIn();
    await expect(sync.fetch("https://evil.example.test/calendar/v3/calendars/primary/events")).rejects.toMatchObject({ code: "other_host" });
    const r = await signedIn({ redirectTo: "https://evil.example.test/steal" });
    await expect(readGoogleCalendar(r.sync, WINDOW)).rejects.toMatchObject({ code: "other_host" });
    expect(r.g.api).toHaveLength(1); // the one that answered with the redirect
    expect(g.api).toEqual([]);
  });
});

// ---- read ------------------------------------------------------------------------------------------

describe("read — the recorded answers into occurrences, the owner's own answer marked", () => {
  it("every occurrence of the two weeks, page by page; a cancelled occurrence and a working location skipped", async () => {
    const { g, sync } = await signedIn();
    const read = await readGoogleCalendar(sync, WINDOW);
    expect(read.pages).toBe(2);
    expect(read.events.map((e) => e.event_id)).toEqual([STANDUP.id, INVITE.id, OWN.id, HOSTED.id, OFFSITE.id]);
    expect(read.skipped).toEqual({ cancelled: 1, working_location: 1, unreadable: 0 });
    expect(read.events.map((e) => e.event_id)).not.toContain(CANCELLED.id);
    expect(read.events.map((e) => e.event_id)).not.toContain(WORKING_LOCATION.id);

    const [first, second] = g.api;
    expect(first!.method).toBe("GET");
    expect(first!.path).toBe("/calendar/v3/calendars/primary/events");
    expect(Object.fromEntries(first!.query)).toEqual({
      singleEvents: "true",
      orderBy: "startTime",
      timeMin: "2026-09-28T04:00:00.000Z",
      timeMax: "2026-10-12T04:00:00.000Z",
      maxResults: "250",
      fields: GOOGLE_LIST_FIELDS,
    });
    expect(second!.query.get("pageToken")).toBe("page2");
  });

  it("never asks for the description, the meeting link or the dial-in — and never reads them when a server sends them anyway", async () => {
    const { sync } = await signedIn();
    expect(GOOGLE_LIST_FIELDS).not.toMatch(/description|hangoutLink|conferenceData|attachments/);
    const text = JSON.stringify(await readGoogleCalendar(sync, WINDOW));
    expect(text).not.toContain(INVITE_BODY);
    expect(text).not.toContain("meet.google.com");
    expect(text).not.toContain("918273");
  });

  it("an invitation: its attendees, the organizer, and the owner's own answer — pending", async () => {
    const { sync } = await signedIn();
    const invite = (await readGoogleCalendar(sync, WINDOW)).events.find((e) => e.event_id === INVITE.id);
    expect(invite).toEqual({
      event_id: "inv0design0review0001",
      ical_uid: "inv0design0review0001@google.com",
      series_id: null,
      title: "Design review",
      start: "2026-09-28T14:00:00.000Z",
      end: "2026-09-28T15:00:00.000Z",
      all_day: false,
      location: "Room 4",
      organizer: { name: "Alice Chen", email: "alice@example.com" },
      participants: [
        { name: "Alice Chen", email: "alice@example.com", status: "accepted", role: "chair", type: "person", self: false },
        { name: null, email: OWNER, status: "pending", role: "required", type: "person", self: true },
        { name: "Bob Ortiz", email: "bob@example.com", status: "accepted", role: "optional", type: "person", self: false },
        { name: "Room 4", email: "c_room4@resource.calendar.google.com", status: "accepted", role: "required", type: "resource", self: false },
      ],
      self_status: "pending",
    });
  });

  it("a series' occurrence keeps Google's occurrence id and names its series; an all-day date is the owner's midnight; the owner's own event has no answer", async () => {
    const { sync } = await signedIn();
    const events = (await readGoogleCalendar(sync, WINDOW)).events;
    expect(events.find((e) => e.event_id === STANDUP.id)).toMatchObject({ series_id: "stand0up0series00001", self_status: "accepted", start: "2026-09-28T13:30:00.000Z" });
    expect(events.find((e) => e.event_id === OFFSITE.id)).toMatchObject({ all_day: true, start: "2026-09-30T04:00:00.000Z", end: "2026-10-01T04:00:00.000Z", participants: [], self_status: null });
    expect(events.find((e) => e.event_id === OWN.id)).toMatchObject({ organizer: { name: null, email: OWNER }, participants: [], self_status: null });
  });

  it("a sign-in Google no longer takes is `unauthorized`, naming authorize", async () => {
    const { g, sync } = await signedIn();
    await readGoogleCalendar(sync, WINDOW); // an access token minted, and held
    g.auth.issuedAccess.splice(0); // Google forgot every access token it issued
    const err = await readGoogleCalendar(sync, WINDOW).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoogleCalendarError);
    expect(err).toMatchObject({ code: "unauthorized" });
    expect((err as Error).message).toMatch(/metistry connections authorize google/);
  });
});

// ---- rsvp ---------------------------------------------------------------------------------------------

describe("rsvp — **only `responseStatus` of the self attendee is sent**", () => {
  it("the preview says as whom, to whom, from which answer, and the exact body — and writes nothing", async () => {
    const { g, sync } = await signedIn();
    const p = await previewGoogleReply(sync, { event_id: String(INVITE.id), response: "accepted" });
    expect(p).toEqual({
      connection: "google",
      event_id: INVITE.id,
      response: "accepted",
      title: "Design review",
      organizer: "alice@example.com",
      as: OWNER,
      from: "pending",
      etag: INVITE.etag,
      body: { attendeesOmitted: true, attendees: [{ email: OWNER, responseStatus: "accepted" }] },
      unchanged: false,
    });
    expect(writes(g)).toEqual([]);
  });

  it("the confirm sends exactly the owner's own address and answer with attendeesOmitted — every other attendee, the time and the title are Google's", async () => {
    const { g, sync } = await signedIn();
    const p = await previewGoogleReply(sync, { event_id: String(INVITE.id), response: "accepted" });
    const r = await respondToGoogleInvitation(sync, { event_id: String(INVITE.id), response: "accepted", etag: p.etag });
    expect(r).toMatchObject({ connection: "google", event_id: INVITE.id, unchanged: false });
    expect(r.etag).not.toBe(INVITE.etag);

    const [patch, ...rest] = writes(g);
    expect(rest).toEqual([]);
    expect(patch!.method).toBe("PATCH");
    expect(patch!.path).toBe(`/calendar/v3/calendars/primary/events/${String(INVITE.id)}`);
    expect(patch!.headers["if-match"]).toBe(INVITE.etag);
    expect(patch!.query.get("sendUpdates")).toBe("all");
    // the wire, byte for byte: nothing but the owner's own responseStatus and the address that names it
    expect(JSON.parse(patch!.body)).toStrictEqual({ attendeesOmitted: true, attendees: [{ email: OWNER, responseStatus: "accepted" }] });

    const after = g.events.get(String(INVITE.id))!;
    expect(after.attendees).toEqual((INVITE.attendees as Array<Record<string, unknown>>).map((a) => (a.self ? { ...a, responseStatus: "accepted" } : a)));
    expect([after.summary, after.start, after.end, after.description]).toEqual([INVITE.summary, INVITE.start, INVITE.end, INVITE.description]);
  });

  it("an answer already given writes nothing", async () => {
    const { g, sync } = await signedIn();
    const p = await previewGoogleReply(sync, { event_id: String(STANDUP.id), response: "accepted" });
    expect(p).toMatchObject({ from: "accepted", unchanged: true });
    expect(await respondToGoogleInvitation(sync, { event_id: String(STANDUP.id), response: "accepted", etag: p.etag })).toMatchObject({ unchanged: true });
    expect(writes(g)).toEqual([]);
  });

  it("refuses — sending nothing — where the owner is not an invited attendee, or the answer is not one", async () => {
    const { g, sync } = await signedIn();
    await expect(previewGoogleReply(sync, { event_id: String(OWN.id), response: "accepted" })).rejects.toMatchObject({ code: "not_invited" });
    await expect(previewGoogleReply(sync, { event_id: String(HOSTED.id), response: "declined" })).rejects.toMatchObject({ code: "not_invited" });
    await expect(previewGoogleReply(sync, { event_id: String(INVITE.id), response: "maybe" as never })).rejects.toMatchObject({ code: "bad_request" });
    await expect(previewGoogleReply(sync, { event_id: "../calendarList", response: "accepted" })).rejects.toMatchObject({ code: "bad_request" });
    await expect(previewGoogleReply(sync, { event_id: "no0such0event", response: "accepted" })).rejects.toMatchObject({ code: "not_found" });
    await expect(respondToGoogleInvitation(sync, { event_id: String(HOSTED.id), response: "declined", etag: String(HOSTED.etag) })).rejects.toMatchObject({ code: "not_invited" });
    expect(writes(g)).toEqual([]);
  });

  it("is bound to the ETag its preview read: a stale one is refused here, and one Google finds changed is refused there — never overwritten", async () => {
    const { g, sync } = await signedIn();
    await expect(respondToGoogleInvitation(sync, { event_id: String(INVITE.id), response: "declined", etag: '"3371000000000000"' })).rejects.toMatchObject({ code: "changed" });
    await expect(respondToGoogleInvitation(sync, { event_id: String(INVITE.id), response: "declined", etag: "" })).rejects.toMatchObject({ code: "bad_request" });
    expect(writes(g)).toEqual([]);
    const racing = await signedIn({ editBetween: true });
    const p = await previewGoogleReply(racing.sync, { event_id: String(INVITE.id), response: "declined" });
    await expect(respondToGoogleInvitation(racing.sync, { event_id: String(INVITE.id), response: "declined", etag: p.etag })).rejects.toMatchObject({ code: "changed" });
    expect((racing.g.events.get(String(INVITE.id))!.attendees as Array<Record<string, unknown>>).find((a) => a.self)?.responseStatus).toBe("needsAction");
  });
});

// ---- write own -------------------------------------------------------------------------------------------

describe("write_own — only events nobody else is in, each bound to what its preview read", () => {
  it("create: the preview mints the id and says the exact body — no attendee; the confirm sends that; a second confirm finds it made", async () => {
    const { g, sync } = await signedIn();
    const draft = { title: "Write", start: "2026-09-29T13:00:00-04:00", end: "2026-09-29T14:00:00-04:00", location: "Library" };
    const p = previewCreateGoogleEvent(sync, { draft });
    expect(p.event_id).toMatch(/^[a-v0-9]{32}$/);
    expect(p.body).toEqual({ id: p.event_id, summary: "Write", location: "Library", start: { dateTime: "2026-09-29T17:00:00.000Z" }, end: { dateTime: "2026-09-29T18:00:00.000Z" } });
    expect(writes(g)).toEqual([]);
    await createOwnGoogleEvent(sync, { event_id: p.event_id, draft });
    const [post] = writes(g);
    expect(post!.method).toBe("POST");
    expect(post!.query.get("sendUpdates")).toBe("none");
    expect(JSON.parse(post!.body)).toStrictEqual(p.body);
    await expect(createOwnGoogleEvent(sync, { event_id: p.event_id, draft })).rejects.toMatchObject({ code: "exists" });
    expect(g.events.get(p.event_id)).toMatchObject({ summary: "Write" });
  });

  it("an all-day event is dates; bad times, an empty title and a malformed id are refused before anything is sent", async () => {
    const { g, sync } = await signedIn();
    expect(previewCreateGoogleEvent(sync, { draft: { title: "Away", start: "2026-10-02", end: "2026-10-03", all_day: true } }).body).toMatchObject({ start: { date: "2026-10-02" }, end: { date: "2026-10-03" } });
    expect(() => previewCreateGoogleEvent(sync, { draft: { title: "x", start: "2026-10-02T10:00:00Z", end: "2026-10-02T09:00:00Z" } })).toThrow(/end after the start/);
    expect(() => previewCreateGoogleEvent(sync, { draft: { title: " ", start: "2026-10-02T10:00:00Z", end: "2026-10-02T11:00:00Z" } })).toThrow(/not empty/);
    await expect(createOwnGoogleEvent(sync, { event_id: "Not-Google's-Alphabet", draft: { title: "x", start: "2026-10-02T10:00:00Z", end: "2026-10-02T11:00:00Z" } })).rejects.toMatchObject({ code: "bad_request" });
    expect(newGoogleEventId(() => Buffer.alloc(20, 0xff))).toBe("v".repeat(32));
    expect(writes(g)).toEqual([]);
  });

  it("move the owner's own event: the named fields only, sendUpdates=none, If-Match its preview's ETag", async () => {
    const { g, sync } = await signedIn();
    const change = { start: "2026-09-28T16:00:00-04:00", end: "2026-09-28T17:30:00-04:00" };
    const p = await previewChangeGoogleEvent(sync, { event_id: String(OWN.id), change });
    expect(p).toEqual({ connection: "google", event_id: OWN.id, title: "Focus", etag: OWN.etag, body: { start: { dateTime: "2026-09-28T20:00:00.000Z" }, end: { dateTime: "2026-09-28T21:30:00.000Z" } } });
    expect(writes(g)).toEqual([]);
    await changeOwnGoogleEvent(sync, { event_id: String(OWN.id), change, etag: p.etag! });
    const [patch] = writes(g);
    expect(patch!.headers["if-match"]).toBe(OWN.etag);
    expect(patch!.query.get("sendUpdates")).toBe("none");
    expect(JSON.parse(patch!.body)).toStrictEqual(p.body);
    expect(g.events.get(String(OWN.id))).toMatchObject({ summary: "Focus", start: { dateTime: "2026-09-28T20:00:00.000Z" } });
    await expect(changeOwnGoogleEvent(sync, { event_id: String(OWN.id), change, etag: p.etag! })).rejects.toMatchObject({ code: "changed" });
  });

  it("refuses — sending nothing — an event anyone else is in, one someone else organises, and a series itself", async () => {
    const { g, sync } = await signedIn();
    const change = { title: "Mine now" };
    await expect(previewChangeGoogleEvent(sync, { event_id: String(INVITE.id), change })).rejects.toMatchObject({ code: "not_own" });
    await expect(previewChangeGoogleEvent(sync, { event_id: String(HOSTED.id), change })).rejects.toMatchObject({ code: "not_own" });
    await expect(previewChangeGoogleEvent(sync, { event_id: String(STANDUP.id), change })).rejects.toMatchObject({ code: "not_own" });
    await expect(previewChangeGoogleEvent(sync, { event_id: String(STANDUP_SERIES.id), change })).rejects.toMatchObject({ code: "unsupported" });
    await expect(previewChangeGoogleEvent(sync, { event_id: String(WORKING_LOCATION.id), change })).rejects.toMatchObject({ code: "unsupported" });
    await expect(changeOwnGoogleEvent(sync, { event_id: String(HOSTED.id), change, etag: String(HOSTED.etag) })).rejects.toMatchObject({ code: "not_own" });
    await expect(deleteOwnGoogleEvent(sync, { event_id: String(INVITE.id), etag: String(INVITE.etag) })).rejects.toMatchObject({ code: "not_own" });
    await expect(previewChangeGoogleEvent(sync, { event_id: String(OWN.id), change: {} })).rejects.toMatchObject({ code: "bad_request" });
    await expect(previewChangeGoogleEvent(sync, { event_id: String(OWN.id), change: { start: "2026-09-28T16:00:00Z" } })).rejects.toMatchObject({ code: "bad_request" });
    expect(writes(g)).toEqual([]);
  });

  it("delete the owner's own event, If-Match its preview's ETag; gone after", async () => {
    const { g, sync } = await signedIn();
    const p = await previewDeleteGoogleEvent(sync, { event_id: String(OFFSITE.id) });
    expect(p).toEqual({ connection: "google", event_id: OFFSITE.id, title: "Offsite", etag: OFFSITE.etag, body: null });
    await expect(deleteOwnGoogleEvent(sync, { event_id: String(OFFSITE.id), etag: '"1"' })).rejects.toMatchObject({ code: "changed" });
    expect(writes(g)).toEqual([]);
    await deleteOwnGoogleEvent(sync, { event_id: String(OFFSITE.id), etag: p.etag! });
    const [del] = writes(g);
    expect([del!.method, del!.headers["if-match"], del!.query.get("sendUpdates")]).toEqual(["DELETE", OFFSITE.etag, "none"]);
    expect(g.events.has(String(OFFSITE.id))).toBe(false);
    await expect(previewDeleteGoogleEvent(sync, { event_id: String(OFFSITE.id) })).rejects.toMatchObject({ code: "not_found" });
  });
});
