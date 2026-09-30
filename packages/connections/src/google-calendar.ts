// The `google-calendar` provider (plan §2.6, §4 Q7 second; T4-14; ruling
// 2026-09-30, Q8): a `calendar` connection type whose implementation is this
// module — Google Calendar through the Calendar API v3, signed in with
// Google through Metistry's own OAuth door. Capabilities `read`, `write_own`
// and `rsvp`.
//
// **How it signs in.** OAuth as a public client (T4-10, `oauth.ts`): PKCE and
// a loopback redirect, the owner's hand only (`metistry connections
// authorize`). The client id is the one the connection type ships — public by
// design: an installed app cannot keep a secret, Google says so, and PKCE is
// what protects the code — or the owner's own, a secret per instance, which
// overrides it; a client secret, where one is used, is always the owner's
// secret (`metistry secrets set`), never a manifest's. The refresh token is
// the connection's token secret in the Keychain; the access token is minted
// by the process that dials and held in memory. There is no secret-in-URL
// door: Google's private iCal address stays out (ruling 2026-09-30).
//
// **Where it may go** — enforced by the sync opener (`sync.ts`), not asked of
// this module: every request is pinned to https://www.googleapis.com, follows
// no redirect, and carries the access token only because that token secret's
// *Sent only to* list names this host; the sign-in's token secret must list
// **exactly** the token endpoint's host and this one (`GOOGLE_TOKEN_HOSTS`),
// or the connection is not opened. A connection file pointed anywhere but the
// Calendar API is refused at the file (`googleCalendarConnectionIssues`).
//
// **The scope is `calendar.events`** — events, on calendars the owner can
// reach — and nothing else: no calendar list, no settings, no Gmail. So this
// module reads the owner's **primary** calendar.
//
// **Read** — `events.list` over the window with `singleEvents=true` (Google
// expands each series into its occurrences, each with its own id — the key
// the row is written under), asking with `fields=` for named fields only: the
// description is never requested, and never read if sent. Google marks the
// owner's own attendee (`self`), so `self_status` is the owner's own answer.
// A cancelled occurrence and a working-location marker are not meetings and
// are skipped, counted.
//
// **Reply (`rsvp`)** — the Calendar API's `attendees[].responseStatus` is
// writable, and `attendeesOmitted` "can be used to only update the
// participant's response". So the reply is a PATCH whose body is exactly
// `{attendeesOmitted: true, attendees: [{email: <the self attendee>,
// responseStatus: <answer>}]}` — the owner's own response and the address
// that names it, nothing else: no other attendee, no time, no title
// (`replyBody`, and a test holds the wire to it). Refused, each a code path:
// the owner is not an attendee or is the organizer (`not_invited`); the event
// is not a meeting Google takes replies for (`unsupported`).
//
// **Write own (`write_own`)** — create, change (move) and delete an event that
// is the owner's alone: organised by the owner, with no attendee but the
// owner. A meeting with anyone else in it changes only by the owner's reply
// (`not_own`); a series is not rewritten — one occurrence moves (`unsupported`
// for the series itself); `sendUpdates=none` on every own write, because
// nobody else is in it.
//
// **Preview, then confirm.** Every change has a preview that reads the event
// now and says exactly what would be sent, with the event's ETag; the confirm
// names that ETag, re-reads the event, re-derives the body from Google's copy
// — never from a body the caller sends — and writes with `If-Match`, so an
// event that changed in between is refused (`changed`), never overwritten. A
// new event's id is minted by the preview and written by the confirm, so a
// second confirm finds it there (`exists`) rather than making two. The
// confirm token and who may press it are the console door's (T4-17, X-57).
//
// Pure over a `fetch`: no Postgres, no vault (the dependency arrow). The sync
// that writes `calendar_events` is `collectors/google-calendar/`.

import { randomBytes } from "node:crypto";
import type { ConnectionFile } from "@foldedspacelabs/metistry-core";
import { zonedMidnight, type ExpandOptions, type IcsOccurrence, type IcsParticipant } from "./ics.js";
import type { SyncHttp } from "./sync.js";

/** The builtin module name the `google-calendar` connection type's `implementation` names. */
export const GOOGLE_CALENDAR_MODULE = "google-calendar";
/** The sync (collector unit) that reads Google Calendar connections. */
export const GOOGLE_CALENDAR_SYNC = "google-calendar";
/** The Calendar API's host — the only one a Google Calendar connection's requests reach. */
export const GOOGLE_API_HOST = "www.googleapis.com";
/** Google's token endpoint's host (the connection type's `token_url`). */
export const GOOGLE_TOKEN_HOST = "oauth2.googleapis.com";
/** Google's authorize endpoint's host — the owner's browser goes there, never a request of Metistry's. */
export const GOOGLE_AUTHORIZE_HOST = "accounts.google.com";
/** The Calendar API's origin: the sync opener pins every request to it. */
export const GOOGLE_CALENDAR_ORIGIN = `https://${GOOGLE_API_HOST}`;
/** Where a Google Calendar connection points, and nowhere else. */
export const GOOGLE_CALENDAR_URL = `${GOOGLE_CALENDAR_ORIGIN}/calendar/v3/`;
/**
 * Exactly the hosts a Google sign-in's token secret may list: the token
 * endpoint (the refresh token goes there to mint an access token) and the
 * Calendar API (the access token goes there). Not a subset, not a superset —
 * the sync opener refuses the connection otherwise (`tokenHosts`).
 */
export const GOOGLE_TOKEN_HOSTS: readonly string[] = [GOOGLE_TOKEN_HOST, GOOGLE_API_HOST];

/** The one calendar the `calendar.events` scope lets this module find without a calendar list: the owner's own. */
const CALENDAR = "primary";
const API_PATH = "/calendar/v3/";
const REQUEST_TIMEOUT_MS = 30_000; // limit: fixed — one API request; past this Google is not answering, and the run says so
const MAX_BYTES = 5 * 1024 * 1024; // limit: fixed — one page of 250 events is well under 1 MB; past this an answer is not read
const PAGE_SIZE = 250; // limit: fixed — events.list's own default maximum per page
const MAX_PAGES = 20; // limit: fixed — 5,000 occurrences in two weeks is past any one person's calendar; the read stops rather than walk forever

/** Why a Google Calendar call failed or was refused. A closed set: each is a code path with a test (U3). */
export const GOOGLE_CALENDAR_ERROR_CODES = [
  "unauthorized",
  "forbidden",
  "http_status",
  "not_found",
  "not_invited",
  "not_own",
  "unsupported",
  "changed",
  "exists",
  "bad_request",
  "bad_response",
  "too_large",
] as const;
export type GoogleCalendarErrorCode = (typeof GOOGLE_CALENDAR_ERROR_CODES)[number];

/** A refusal. Names the connection and the reason — never a token, a query or an event's text. */
export class GoogleCalendarError extends Error {
  override readonly name = "GoogleCalendarError";
  constructor(
    readonly code: GoogleCalendarErrorCode,
    message: string,
  ) {
    super(`google-calendar (${code}): ${message}`);
  }
}

type Http = Pick<SyncHttp, "connection" | "origin" | "headers" | "fetch">;

// ---- the connection file ------------------------------------------------------------

/**
 * The rules a Google Calendar connection file must keep, beside the frozen
 * schema — run by `judgeConnection` for every provider this module
 * implements. Empty = none broken. Names fields and hosts, never a value.
 */
export function googleCalendarConnectionIssues(c: ConnectionFile, provider: string): string[] {
  const http = c.reach.http;
  if (!http) return [`reach: ${provider} is reached over http at ${GOOGLE_CALENDAR_URL}`];
  const issues: string[] = [];
  let u: URL | undefined;
  try {
    u = new URL(http.url);
  } catch {
    issues.push(`reach.http.url: not a URL — ${provider} is reached at ${GOOGLE_CALENDAR_URL}`);
  }
  if (u && (u.origin !== GOOGLE_CALENDAR_ORIGIN || !["/calendar/v3", API_PATH].includes(u.pathname) || u.search !== "" || u.hash !== "" || u.username !== "" || u.password !== "")) {
    issues.push(`reach.http.url: ${provider} is reached at ${GOOGLE_CALENDAR_URL} and nowhere else`);
  }
  if (http.auth.scheme !== "oauth") issues.push(`reach.http.auth: ${provider} signs in with Google (auth: oauth), not ${http.auth.scheme}`);
  if (Object.keys(http.headers).length > 0) issues.push(`reach.http.headers: ${provider} sends no headers of its own`);
  if (Object.keys(http.query).length > 0) issues.push(`reach.http.query: ${provider} sends no query parameters of its own`);
  return issues;
}

// ---- the wire -----------------------------------------------------------------------------

async function cappedText(res: Response, what: string): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new GoogleCalendarError("too_large", `${what}: more than ${MAX_BYTES} bytes, which is not read`);
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder("utf-8").decode(all);
}

/** Google's machine reason (`insufficientPermissions`, `rateLimitExceeded`) — kept only if it is one, never free text. */
function reasonOf(json: unknown): string | null {
  const errors = (json as { error?: { errors?: Array<{ reason?: unknown }> } } | null)?.error?.errors;
  const r = Array.isArray(errors) ? errors[0]?.reason : undefined;
  return typeof r === "string" && /^[A-Za-z0-9_]{1,64}$/.test(r) ? r : null;
}

interface Call {
  query?: Record<string, string>;
  body?: unknown;
  ifMatch?: string;
}

interface Answer {
  status: number;
  json: Record<string, unknown> | null;
}

const EVENT_ID_RE = /^[A-Za-z0-9_@.-]{1,1024}$/;

function checkEventId(id: unknown): string {
  if (typeof id !== "string" || !EVENT_ID_RE.test(id)) throw new GoogleCalendarError("bad_request", "an event id is letters, digits and _ @ . -, at most 1024");
  return id;
}

/** One request to the Calendar API through the sync's door. Statuses a caller acts on come back; every other failure is thrown here. */
async function call(sync: Http, method: "GET" | "POST" | "PATCH" | "DELETE", path: string, what: string, c: Call = {}): Promise<Answer> {
  const url = new URL(`${API_PATH}${path}`, sync.origin);
  for (const [k, v] of Object.entries(c.query ?? {})) url.searchParams.set(k, v);
  const headers: Record<string, string> = { ...sync.headers, accept: "application/json" };
  if (c.body !== undefined) headers["content-type"] = "application/json";
  if (c.ifMatch !== undefined) headers["if-match"] = c.ifMatch;
  const res = await sync.fetch(url.href, {
    method,
    headers,
    ...(c.body !== undefined ? { body: JSON.stringify(c.body) } : {}),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await cappedText(res, `connection ${sync.connection}: ${what}`);
  let json: Record<string, unknown> | null = null;
  if (text.trim() !== "") {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) json = parsed as Record<string, unknown>;
    } catch {
      if (res.ok) throw new GoogleCalendarError("bad_response", `connection ${sync.connection}: Google answered the ${what} with something that is not JSON`);
    }
  }
  if (res.ok) return { status: res.status, json };
  const reason = reasonOf(json);
  const why = `HTTP ${res.status}${reason ? `, ${reason}` : ""}`;
  if (res.status === 401) {
    throw new GoogleCalendarError("unauthorized", `connection ${sync.connection}: Google refused the sign-in for the ${what} (${why}) — sign in again: \`metistry connections authorize ${sync.connection}\``);
  }
  if (res.status === 403) throw new GoogleCalendarError("forbidden", `connection ${sync.connection}: Google refused the ${what} (${why})`);
  if (res.status === 404 || res.status === 410) throw new GoogleCalendarError("not_found", `connection ${sync.connection}: no such event on the primary calendar (${why})`);
  if (res.status === 412) throw new GoogleCalendarError("changed", `connection ${sync.connection}: the event changed in Google Calendar since the preview — preview again`);
  if (res.status === 409) throw new GoogleCalendarError("exists", `connection ${sync.connection}: an event with that id is already there — the ${what} was already made`);
  throw new GoogleCalendarError("http_status", `connection ${sync.connection}: Google refused the ${what} (${why})`);
}

// ---- events, as Google spells them ---------------------------------------------------

interface GPerson {
  email?: unknown;
  displayName?: unknown;
  self?: unknown;
  organizer?: unknown;
  responseStatus?: unknown;
  optional?: unknown;
  resource?: unknown;
}

interface GTime {
  dateTime?: unknown;
  date?: unknown;
}

/** The fields this module reads of an event. Named here, asked for by `fields=`, and nothing else is read — there is no field for a description. */
interface GEvent {
  id?: unknown;
  iCalUID?: unknown;
  etag?: unknown;
  status?: unknown;
  summary?: unknown;
  location?: unknown;
  start?: GTime;
  end?: GTime;
  recurringEventId?: unknown;
  recurrence?: unknown;
  eventType?: unknown;
  organizer?: GPerson;
  attendees?: unknown;
  attendeesOmitted?: unknown;
}

const PERSON_FIELDS = "email,displayName,self";
const ATTENDEE_FIELDS = `${PERSON_FIELDS},organizer,responseStatus,optional,resource`;
const EVENT_FIELDS = `id,iCalUID,etag,status,summary,location,start,end,recurringEventId,eventType,organizer(${PERSON_FIELDS}),attendees(${ATTENDEE_FIELDS}),attendeesOmitted`;
/** What `events.list` is asked for: named fields only — never `description`, `attachments`, `conferenceData` or `hangoutLink`. */
export const GOOGLE_LIST_FIELDS = `nextPageToken,items(${EVENT_FIELDS})`;
/** What one event is read with, before a change: the list's fields and `recurrence` (a series is not rewritten). */
export const GOOGLE_EVENT_FIELDS = `${EVENT_FIELDS},recurrence`;

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);

/** Google's `responseStatus` in `calendar_events`' spelling (the ICS provider's `PARTSTAT` map). */
const STATUS_OF: Readonly<Record<string, string>> = { needsAction: "pending", accepted: "accepted", declined: "declined", tentative: "tentative" };

function attendeesOf(e: GEvent): GPerson[] {
  return Array.isArray(e.attendees) ? (e.attendees.filter((a) => a !== null && typeof a === "object") as GPerson[]) : [];
}

function participantOf(a: GPerson): IcsParticipant {
  return {
    name: str(a.displayName)?.trim() ?? null,
    email: str(a.email),
    status: typeof a.responseStatus === "string" ? (STATUS_OF[a.responseStatus] ?? "unknown") : "unknown",
    role: a.organizer === true ? "chair" : a.optional === true ? "optional" : "required",
    type: a.resource === true ? "resource" : "person",
    self: a.self === true,
  };
}

/** An occurrence of the owner's primary calendar, the owner marked — the shape the CalDAV provider hands its sync. */
export interface GoogleOccurrence extends Omit<IcsOccurrence, "self_status"> {
  /** the owner's own answer (`pending`, `accepted`, …), or null when the owner is not an attendee */
  self_status: string | null;
}

/** When an event starts and ends, as instants; an all-day date is the owner's midnight. Null when unreadable. */
function spanOf(e: GEvent, zone: string): { start: number; end: number; allDay: boolean } | null {
  const sd = str(e.start?.date);
  const ed = str(e.end?.date);
  if (sd !== null && ed !== null) {
    const ws = Date.parse(`${sd}T00:00:00Z`);
    const we = Date.parse(`${ed}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(sd) || !/^\d{4}-\d{2}-\d{2}$/.test(ed) || Number.isNaN(ws) || Number.isNaN(we)) return null;
    return { start: zonedMidnight(ws, zone), end: zonedMidnight(we, zone), allDay: true };
  }
  const s = str(e.start?.dateTime);
  const t = str(e.end?.dateTime);
  const start = s === null ? Number.NaN : Date.parse(s);
  const end = t === null ? Number.NaN : Date.parse(t);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return { start, end: Math.max(start, end), allDay: false };
}

/** One event as an occurrence, built from named fields only; null when it has no id or no readable time. */
export function googleOccurrence(e: GEvent, zone: string): GoogleOccurrence | null {
  const id = str(e.id);
  const span = spanOf(e, zone);
  if (id === null || span === null) return null;
  const participants = attendeesOf(e).map(participantOf);
  const self = participants.find((p) => p.self);
  const org = e.organizer && typeof e.organizer === "object" ? e.organizer : null;
  return {
    event_id: id,
    ical_uid: str(e.iCalUID) ?? id,
    series_id: str(e.recurringEventId),
    title: typeof e.summary === "string" ? e.summary : "",
    start: new Date(span.start).toISOString(),
    end: new Date(span.end).toISOString(),
    all_day: span.allDay,
    location: str(e.location)?.trim() ?? null,
    organizer: org ? { name: str(org.displayName)?.trim() ?? null, email: str(org.email) } : null,
    participants,
    self_status: self ? self.status : null,
  };
}

/** What a read could not use, by reason — counted, never guessed at. */
export interface GoogleSkipped {
  /** a cancelled occurrence of a series (Google lists them) */
  cancelled: number;
  /** a working-location marker — where the owner works that day, not a meeting */
  working_location: number;
  /** an event with no id or no readable time */
  unreadable: number;
}

export interface GoogleRead {
  events: GoogleOccurrence[];
  /** pages of `events.list` read */
  pages: number;
  skipped: GoogleSkipped;
}

/**
 * The owner's primary calendar over the window: `events.list` with
 * `singleEvents=true` (every series expanded by Google into its occurrences),
 * `timeMin`/`timeMax` the window, named fields only, page by page up to a
 * ceiling. A key read twice is kept once.
 */
export async function readGoogleCalendar(sync: Http, opts: ExpandOptions): Promise<GoogleRead> {
  const events: GoogleOccurrence[] = [];
  const seen = new Set<string>();
  const skipped: GoogleSkipped = { cancelled: 0, working_location: 0, unreadable: 0 };
  let pageToken: string | undefined;
  let pages = 0;
  do {
    if (pages >= MAX_PAGES) throw new GoogleCalendarError("too_large", `connection ${sync.connection}: more than ${MAX_PAGES} pages of events in the window — not read`);
    const query: Record<string, string> = {
      singleEvents: "true",
      orderBy: "startTime",
      timeMin: new Date(opts.windowStart).toISOString(),
      timeMax: new Date(opts.windowEnd).toISOString(),
      maxResults: String(PAGE_SIZE),
      fields: GOOGLE_LIST_FIELDS,
    };
    if (pageToken !== undefined) query.pageToken = pageToken;
    const { json } = await call(sync, "GET", `calendars/${CALENDAR}/events`, "read of the calendar", { query });
    pages++;
    if (json === null || (json.items !== undefined && !Array.isArray(json.items))) throw new GoogleCalendarError("bad_response", `connection ${sync.connection}: Google's answer has no list of events`);
    for (const raw of (json.items ?? []) as unknown[]) {
      if (raw === null || typeof raw !== "object") {
        skipped.unreadable++;
        continue;
      }
      const e = raw as GEvent;
      if (e.status === "cancelled") {
        skipped.cancelled++;
        continue;
      }
      if (e.eventType === "workingLocation") {
        skipped.working_location++;
        continue;
      }
      const occ = googleOccurrence(e, opts.ownerZone);
      if (occ === null) {
        skipped.unreadable++;
        continue;
      }
      if (seen.has(occ.event_id)) continue;
      seen.add(occ.event_id);
      events.push(occ);
    }
    const next = json.nextPageToken;
    pageToken = typeof next === "string" && next !== "" ? next : undefined;
  } while (pageToken !== undefined);
  return { events, pages, skipped };
}

/** One event, read now with its ETag. */
async function readEvent(sync: Http, id: string): Promise<GEvent & { etag: string }> {
  const { json } = await call(sync, "GET", `calendars/${CALENDAR}/events/${encodeURIComponent(checkEventId(id))}`, "read of the event", { query: { fields: GOOGLE_EVENT_FIELDS } });
  if (json === null) throw new GoogleCalendarError("bad_response", `connection ${sync.connection}: Google's answer is not an event`);
  const e = json as GEvent;
  if (e.status === "cancelled") throw new GoogleCalendarError("not_found", `connection ${sync.connection}: the event is cancelled`);
  const etag = str(e.etag);
  if (etag === null) throw new GoogleCalendarError("bad_response", `connection ${sync.connection}: Google gave the event no ETag, so a change cannot be bound to what was previewed`);
  return { ...e, etag };
}

function checkEtag(etag: unknown): string {
  if (typeof etag !== "string" || etag.trim() === "" || etag.length > 256 || /[\u0000-\u001f\u007f]/.test(etag)) {
    throw new GoogleCalendarError("bad_request", "a confirm names the ETag its preview gave");
  }
  return etag.trim();
}

const titleOf = (e: GEvent) => (typeof e.summary === "string" ? e.summary : "");

// ---- reply (rsvp) ---------------------------------------------------------------------------

/** The answers an invitation takes — `calendar_events.self_status`'s spelling. */
export const GOOGLE_RSVP_RESPONSES = ["accepted", "tentative", "declined"] as const;
export type GoogleRsvpResponse = (typeof GOOGLE_RSVP_RESPONSES)[number];

/**
 * The whole body of a reply: the owner's own attendee — its address, which
 * names it, and its answer — and `attendeesOmitted`, which tells Google the
 * list is not the whole guest list. Nothing else is ever sent.
 */
export interface GoogleReplyBody {
  attendeesOmitted: true;
  attendees: [{ email: string; responseStatus: GoogleRsvpResponse }];
}

/** The reply as Google's PATCH body — the owner's own `responseStatus` and nothing else. */
export function replyBody(selfEmail: string, response: GoogleRsvpResponse): GoogleReplyBody {
  return { attendeesOmitted: true, attendees: [{ email: selfEmail, responseStatus: response }] };
}

export interface GoogleReplyPlan {
  event_id: string;
  response: GoogleRsvpResponse;
  title: string;
  /** who the answer goes to — the organizer's address */
  organizer: string | null;
  /** the owner's address it answers as */
  as: string;
  /** the owner's answer now (`pending`, `accepted`, …) */
  from: string;
  /** exactly what the confirm sends */
  body: GoogleReplyBody;
  /** the owner has already given this answer: nothing to write */
  unchanged: boolean;
}

/** The reply to one event as Google holds it, or the refusal that says why there is none. Pure. */
export function planGoogleReply(e: GEvent, id: string, response: GoogleRsvpResponse): GoogleReplyPlan {
  if (!(GOOGLE_RSVP_RESPONSES as readonly string[]).includes(response)) throw new GoogleCalendarError("bad_request", `an answer is one of ${GOOGLE_RSVP_RESPONSES.join(", ")}`);
  if (e.eventType !== undefined && e.eventType !== "default") throw new GoogleCalendarError("unsupported", `a ${String(e.eventType).slice(0, 40)} event takes no reply`);
  if (e.attendeesOmitted === true) throw new GoogleCalendarError("unsupported", "Google left the guest list out of this event, so the owner's own place in it cannot be found");
  if (e.organizer?.self === true) throw new GoogleCalendarError("not_invited", "the owner organises this event — a reply is an attendee's");
  const self = attendeesOf(e).find((a) => a.self === true);
  const email = self ? str(self.email) : null;
  if (!self || email === null) throw new GoogleCalendarError("not_invited", "the owner is not an attendee of this event");
  if (self.organizer === true) throw new GoogleCalendarError("not_invited", "the owner organises this event — a reply is an attendee's");
  const from = typeof self.responseStatus === "string" ? (STATUS_OF[self.responseStatus] ?? "unknown") : "unknown";
  return {
    event_id: id,
    response,
    title: titleOf(e),
    organizer: str(e.organizer?.email),
    as: email,
    from,
    body: replyBody(email, response),
    unchanged: self.responseStatus === response,
  };
}

/** What a reply would do, read now — the preview. `etag` is what the confirm names. */
export interface GoogleReplyPreview extends GoogleReplyPlan {
  connection: string;
  etag: string;
}

/** Preview a reply: as whom, to whom, from which answer, and the exact body — nothing is written. */
export async function previewGoogleReply(sync: Http, req: { event_id: string; response: GoogleRsvpResponse }): Promise<GoogleReplyPreview> {
  const e = await readEvent(sync, req.event_id);
  return { connection: sync.connection, etag: e.etag, ...planGoogleReply(e, req.event_id, req.response) };
}

/** What a confirm did. */
export interface GoogleWriteResult {
  connection: string;
  event_id: string;
  /** the event's new ETag, when Google gave one */
  etag: string | null;
  /** nothing needed writing */
  unchanged: boolean;
}

/**
 * Answer an invitation (`rsvp`). The body is re-derived from Google's copy —
 * never taken from the caller — and written only if that copy is still the
 * one previewed (`etag`, compared here and sent as `If-Match`). Google tells
 * the organizer (`sendUpdates=all`), as Calendar does when the owner answers
 * there.
 */
export async function respondToGoogleInvitation(sync: Http, req: { event_id: string; response: GoogleRsvpResponse; etag: string }): Promise<GoogleWriteResult> {
  const etag = checkEtag(req.etag);
  const e = await readEvent(sync, req.event_id);
  if (e.etag !== etag) throw new GoogleCalendarError("changed", `connection ${sync.connection}: the event changed in Google Calendar since the preview — preview again`);
  const plan = planGoogleReply(e, req.event_id, req.response);
  if (plan.unchanged) return { connection: sync.connection, event_id: req.event_id, etag, unchanged: true };
  const { json } = await call(sync, "PATCH", `calendars/${CALENDAR}/events/${encodeURIComponent(req.event_id)}`, "reply", {
    query: { sendUpdates: "all", fields: "etag" },
    body: plan.body,
    ifMatch: etag,
  });
  return { connection: sync.connection, event_id: req.event_id, etag: str(json?.etag), unchanged: false };
}

// ---- write own ---------------------------------------------------------------------------------

/** An event of the owner's own, as a caller describes it. Times are ISO 8601; an all-day event's are dates, the end exclusive. */
export interface GoogleEventDraft {
  title: string;
  start: string;
  end: string;
  all_day?: boolean | undefined;
  location?: string | null | undefined;
}

/** A change to one: only what is named changes. `start` and `end` go together. */
export interface GoogleEventChange {
  title?: string | undefined;
  start?: string | undefined;
  end?: string | undefined;
  all_day?: boolean | undefined;
  location?: string | null | undefined;
}

/** What is sent for an own event — the named fields, nothing else (no attendees, so nobody is sent anything). */
export interface GoogleEventBody {
  id?: string;
  summary?: string;
  location?: string;
  start?: { dateTime: string } | { date: string };
  end?: { dateTime: string } | { date: string };
}

const TEXT_MAX = 500; // limit: fixed — a title or a place, not a document
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function checkText(v: unknown, what: string, empty: boolean): string {
  if (typeof v !== "string" || (!empty && v.trim() === "") || v.length > TEXT_MAX || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(v)) {
    throw new GoogleCalendarError("bad_request", `${what} is text of at most ${TEXT_MAX} characters${empty ? "" : ", not empty"}, with no control characters`);
  }
  return v;
}

function times(start: unknown, end: unknown, allDay: boolean): Pick<Required<GoogleEventBody>, "start" | "end"> {
  if (allDay) {
    if (typeof start !== "string" || typeof end !== "string" || !DATE_RE.test(start) || !DATE_RE.test(end) || Number.isNaN(Date.parse(start)) || Number.isNaN(Date.parse(end)) || end <= start) {
      throw new GoogleCalendarError("bad_request", "an all-day event's start and end are dates (YYYY-MM-DD), the end after the start (exclusive)");
    }
    return { start: { date: start }, end: { date: end } };
  }
  const s = typeof start === "string" && /T/.test(start) ? Date.parse(start) : Number.NaN;
  const e = typeof end === "string" && /T/.test(end) ? Date.parse(end) : Number.NaN;
  if (Number.isNaN(s) || Number.isNaN(e) || e <= s) throw new GoogleCalendarError("bad_request", "start and end are ISO 8601 date-times, the end after the start");
  return { start: { dateTime: new Date(s).toISOString() }, end: { dateTime: new Date(e).toISOString() } };
}

const NEW_ID_RE = /^[a-v0-9]{5,1024}$/;

/** A new event's id, minted by the preview: Google's alphabet for a caller's id (base32hex, lowercase), 32 characters. */
export function newGoogleEventId(random: (n: number) => Buffer = randomBytes): string {
  const alphabet = "0123456789abcdefghijklmnopqrstuv";
  const bytes = random(20);
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

/** The body of a new event of the owner's own: its id, title, times and place. No attendee — nobody is sent anything. */
export function newEventBody(id: string, draft: GoogleEventDraft): GoogleEventBody {
  if (!NEW_ID_RE.test(id)) throw new GoogleCalendarError("bad_request", "a new event's id is Google's alphabet (a–v, 0–9), 5 to 1024 characters");
  const title = checkText(draft.title, "a title", false);
  const location = draft.location === undefined || draft.location === null ? null : checkText(draft.location, "a location", true);
  return { id, summary: title, ...(location !== null && location.trim() !== "" ? { location } : {}), ...times(draft.start, draft.end, draft.all_day === true) };
}

/** Refuse an event that is not the owner's alone, or is a series itself. Pure. */
export function checkOwnEvent(e: GEvent): void {
  if (e.organizer !== undefined && e.organizer?.self !== true) throw new GoogleCalendarError("not_own", "someone else organises this event — only the owner's reply changes it");
  if (e.attendeesOmitted === true) throw new GoogleCalendarError("unsupported", "Google left the guest list out of this event, so it cannot be known to be the owner's alone");
  const others = attendeesOf(e).filter((a) => a.self !== true);
  if (others.length > 0) throw new GoogleCalendarError("not_own", "this event has others in it — changing it would send them an update, which write_own never does");
  if (Array.isArray(e.recurrence) && e.recurrence.length > 0) throw new GoogleCalendarError("unsupported", "a series is not rewritten — move one occurrence, or change the series in Google Calendar");
  if (e.eventType !== undefined && e.eventType !== "default" && e.eventType !== "focusTime") {
    throw new GoogleCalendarError("unsupported", `a ${String(e.eventType).slice(0, 40)} event is changed in Google Calendar, not here`);
  }
}

/** The change as Google's PATCH body: the named fields, nothing else. Pure. */
export function changeBody(change: GoogleEventChange): GoogleEventBody {
  const body: GoogleEventBody = {};
  if (change.title !== undefined) body.summary = checkText(change.title, "a title", false);
  if (change.location !== undefined) {
    // an empty location clears it
    body.location = change.location === null ? "" : checkText(change.location, "a location", true);
  }
  if (change.start !== undefined || change.end !== undefined || change.all_day !== undefined) {
    if (change.start === undefined || change.end === undefined) throw new GoogleCalendarError("bad_request", "a new time names both start and end");
    Object.assign(body, times(change.start, change.end, change.all_day === true));
  }
  if (Object.keys(body).length === 0) throw new GoogleCalendarError("bad_request", "say what changes: title, location, or start and end");
  return body;
}

export interface GoogleOwnPreview {
  connection: string;
  event_id: string;
  title: string;
  /** null for a new event */
  etag: string | null;
  /** exactly what the confirm sends (null for a delete) */
  body: GoogleEventBody | null;
}

/** Preview a new event of the owner's own. The id it returns is what the confirm names. */
export function previewCreateGoogleEvent(sync: Pick<Http, "connection">, req: { draft: GoogleEventDraft; random?: ((n: number) => Buffer) | undefined }): GoogleOwnPreview {
  const id = newGoogleEventId(req.random);
  const body = newEventBody(id, req.draft);
  return { connection: sync.connection, event_id: id, title: body.summary ?? "", etag: null, body };
}

/** Create it (`write_own`) under the previewed id: a second confirm finds it there (`exists`) rather than making two. */
export async function createOwnGoogleEvent(sync: Http, req: { event_id: string; draft: GoogleEventDraft }): Promise<GoogleWriteResult> {
  const body = newEventBody(req.event_id, req.draft);
  const { json } = await call(sync, "POST", `calendars/${CALENDAR}/events`, "new event", { query: { sendUpdates: "none", fields: "id,etag" }, body });
  return { connection: sync.connection, event_id: req.event_id, etag: str(json?.etag), unchanged: false };
}

/** Preview a change (a move, a new title or place) to an event of the owner's own. */
export async function previewChangeGoogleEvent(sync: Http, req: { event_id: string; change: GoogleEventChange }): Promise<GoogleOwnPreview> {
  const e = await readEvent(sync, req.event_id);
  checkOwnEvent(e);
  const body = changeBody(req.change);
  return { connection: sync.connection, event_id: req.event_id, title: body.summary ?? titleOf(e), etag: e.etag, body };
}

/** Change it (`write_own`), only if Google's copy is still the one previewed. One occurrence of a series moves alone. */
export async function changeOwnGoogleEvent(sync: Http, req: { event_id: string; change: GoogleEventChange; etag: string }): Promise<GoogleWriteResult> {
  const etag = checkEtag(req.etag);
  const e = await readEvent(sync, req.event_id);
  if (e.etag !== etag) throw new GoogleCalendarError("changed", `connection ${sync.connection}: the event changed in Google Calendar since the preview — preview again`);
  checkOwnEvent(e);
  const body = changeBody(req.change);
  const { json } = await call(sync, "PATCH", `calendars/${CALENDAR}/events/${encodeURIComponent(req.event_id)}`, "change", { query: { sendUpdates: "none", fields: "etag" }, body, ifMatch: etag });
  return { connection: sync.connection, event_id: req.event_id, etag: str(json?.etag), unchanged: false };
}

/** Preview deleting an event of the owner's own. */
export async function previewDeleteGoogleEvent(sync: Http, req: { event_id: string }): Promise<GoogleOwnPreview> {
  const e = await readEvent(sync, req.event_id);
  checkOwnEvent(e);
  return { connection: sync.connection, event_id: req.event_id, title: titleOf(e), etag: e.etag, body: null };
}

/** Delete it (`write_own`) — only the owner's own, only the copy previewed (`If-Match`). */
export async function deleteOwnGoogleEvent(sync: Http, req: { event_id: string; etag: string }): Promise<GoogleWriteResult> {
  const etag = checkEtag(req.etag);
  const e = await readEvent(sync, req.event_id);
  if (e.etag !== etag) throw new GoogleCalendarError("changed", `connection ${sync.connection}: the event changed in Google Calendar since the preview — preview again`);
  checkOwnEvent(e);
  await call(sync, "DELETE", `calendars/${CALENDAR}/events/${encodeURIComponent(req.event_id)}`, "delete", { query: { sendUpdates: "none" }, ifMatch: etag });
  return { connection: sync.connection, event_id: req.event_id, etag: null, unchanged: false };
}
