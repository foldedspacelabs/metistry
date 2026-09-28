// The `caldav` provider (plan §2.6, §4 Q7 first; T4-13): a `calendar`
// connection type whose implementation is this module — iCloud, Fastmail and
// any RFC 6638 server, signed in with an **app password**. Capabilities
// `read`, `write_own` and `rsvp`.
//
// **How it reaches the server.** Through the fetch a sync opens (`sync.ts`):
// pinned to the connection's own origin, through the egress door with the
// connection as the grantee, following no redirect. The app password is a
// secret of the connection; the file's `reach.http.auth` is
// `{scheme: basic, username, secret}`, so the header this module sends is
// `Basic {{ secret.<name> }}` and the door encodes and fills it for a listed
// host over https, or refuses. A secret is never in a URL. A server that
// names an address on another origin (iCloud keeps an account's calendars on
// a numbered host, `p<NN>-caldav.icloud.com`) is refused before anything is
// sent there, naming the host to point the connection at instead.
//
// **Google is refused by name.** Google's CalDAV takes OAuth 2.0 only — Basic
// with an app password is an HTTP 401 (Google, *CalDAV API developer's
// guide*) — so a Google address is refused at the connection file with
// *Google needs sign-in with Google* (`caldavConnectionIssues`).
//
// **Read** — discovery (RFC 4791 §6, RFC 5397: the current user's principal,
// its calendar home, its calendar user addresses and schedule outbox), the
// calendars in the home that hold events, and a `calendar-query` REPORT per
// calendar for the window. Each resource is parsed and expanded by the ICS
// provider (`ics.ts`) — the same recurrence, zones and keys — and the owner
// is found among the attendees by the addresses the SERVER says are the
// owner's (`calendar-user-address-set`), never by a guess from a name, so
// `self_status` is the owner's own answer. Never the invite body: `ics.ts`
// reads named fields only.
//
// **Reply (`rsvp`)** — RFC 6638 §3.2.2: an attendee changes `PARTSTAT` in its
// own copy of the event, and the server "MUST deliver an iTIP REPLY" to the
// organizer. What changes is exactly **the owner's own attendee line** — in
// the event and in each moved occurrence the owner is in — and nothing else:
// the resource is edited as text, line by line, so every other byte is what
// the server sent (`planReply`). A VALARM's attendee (an email alarm) is not
// an invitation and is never touched. Refused, each a code path: the owner
// is not an attendee or is the organizer (`not_invited`); the server does
// not schedule, names no address for the owner, or the organizer's copy says
// a client delivers replies (`SCHEDULE-AGENT=CLIENT`) — a reply that would
// never arrive (`no_scheduling`).
//
// **Write own (`write_own`)** — create, change and delete an event that is
// the owner's alone: no organizer but the owner and no attendee but the
// owner. An event with anyone else in it changes only by the owner's reply:
// changing a meeting would make the server send every attendee an update,
// which is not this capability (`not_own`). A series is not rewritten
// (`unsupported`).
//
// **Preview, then confirm.** Every change has a preview that reads the
// event and says exactly which lines would change, with the event's ETag;
// the confirm names that ETag and re-derives the change from the server's
// copy — never from a body the caller sends — and writes with `If-Match`,
// so an event that changed in between is refused (`changed`), never
// overwritten. The confirm token and who may press it are the console
// door's (T4-17, T4-9).
//
// Pure over a `fetch`: no Postgres, no vault (the dependency arrow). The sync
// that writes `calendar_events` is `collectors/caldav-calendar/`.

import { randomUUID } from "node:crypto";
import type { ConnectionFile } from "@foldedspacelabs/metistry-core";
import { CALDAV_NS, DAV_NS, DavXmlError, child, childrenOf, escapeXml, parseMultistatus, propKey, type DavResponse, type XmlElement } from "./dav-xml.js";
import { ICS_MAX_BYTES, icsOccurrences, parseIcs, type ExpandOptions, type IcsComponent, type IcsOccurrence, type IcsSkipped } from "./ics.js";
import type { SyncHttp } from "./sync.js";

/** The builtin module name every CalDAV connection type's `implementation` names. */
export const CALDAV_MODULE = "caldav";
/** The sync (collector unit) that reads CalDAV connections. */
export const CALDAV_SYNC = "caldav-calendar";

/**
 * The known services (plan §2.6): each ships as its own connection type over
 * this module, naming the address discovery starts at and the hosts that
 * are that service's. A connection of a known service pointed anywhere else
 * is refused; any other RFC 6638 server is the `caldav` type.
 */
export const CALDAV_KNOWN_SERVICES: Readonly<Record<string, { label: string; url: string; host: RegExp }>> = {
  "icloud-calendar": { label: "iCloud", url: "https://caldav.icloud.com/", host: /^(?:caldav|p[0-9]{1,4}-caldav)\.icloud\.com$/ },
  "fastmail-calendar": { label: "Fastmail", url: "https://caldav.fastmail.com/dav/", host: /^caldav\.fastmail\.com$/ },
};

/** The words a Google address is refused with (the ticket's; plan §2.6 *Resolving Q7*). */
export const GOOGLE_CALDAV_REFUSAL = "Google needs sign-in with Google";

const REQUEST_TIMEOUT_MS = 30_000; // limit: fixed — one DAV request; past this the server is wedged, and the run says so
const MAX_CALENDARS = 100; // limit: fixed — past any one person's calendar list; the read stops rather than walk a server's whole tree

/** Why a CalDAV call failed or was refused. A closed set: each is a code path with a test (U3). */
export const CALDAV_ERROR_CODES = [
  "not_https",
  "unauthorized",
  "http_status",
  "not_caldav",
  "other_host",
  "too_large",
  "not_found",
  "not_invited",
  "no_scheduling",
  "not_own",
  "unsupported",
  "changed",
  "bad_request",
] as const;
export type CaldavErrorCode = (typeof CALDAV_ERROR_CODES)[number];

/** A refusal. Names the connection, the origin and the reason — never a path, a query or a value. */
export class CaldavError extends Error {
  override readonly name = "CaldavError";
  constructor(
    readonly code: CaldavErrorCode,
    message: string,
  ) {
    super(`caldav (${code}): ${message}`);
  }
}

type Http = Pick<SyncHttp, "connection" | "url" | "origin" | "headers" | "fetch">;

// ---- the connection file ------------------------------------------------------------

const GOOGLE_HOST = /(?:^|\.)(?:google\.com|googleapis\.com|googleusercontent\.com|googlemail\.com|gmail\.com)$/i;
const LOOPBACK = /^(?:localhost|127(?:\.[0-9]{1,3}){3}|\[::1\])$/i;

/**
 * The rules a CalDAV connection file must keep, beside the frozen schema —
 * run by `judgeConnection` for every provider this module implements. Empty =
 * none broken. Names hosts and fields, never a value.
 */
export function caldavConnectionIssues(c: ConnectionFile, provider: string): string[] {
  const http = c.reach.http;
  if (!http) return [];
  const issues: string[] = [];
  let url: URL | undefined;
  try {
    url = new URL(http.url);
  } catch {
    // a {{ variable }} or a typo: the sync says so when it opens the connection
  }
  if (url) {
    if (GOOGLE_HOST.test(url.hostname)) {
      issues.push(`reach.http.url: ${GOOGLE_CALDAV_REFUSAL} — Google's CalDAV takes OAuth only and refuses an app password; Google Calendar is its own connection type`);
    } else {
      if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.test(url.host.replace(/:\d+$/, "")))) {
        issues.push(`reach.http.url: CalDAV is reached over https — ${url.protocol} is refused (plain http only to this Mac's loopback)`);
      }
      const known = Object.hasOwn(CALDAV_KNOWN_SERVICES, provider) ? CALDAV_KNOWN_SERVICES[provider] : undefined;
      if (known && !known.host.test(url.hostname)) {
        issues.push(`reach.http.url: ${provider} is ${known.label}'s server (${known.url}) — ${url.hostname} is not; another server is the caldav connection type`);
      }
    }
  }
  if (http.auth.scheme !== "basic") {
    issues.push(`reach.http.auth: a CalDAV connection signs in with an app password — auth: { scheme: basic, username, secret } (\`--auth basic --username <you> --secret <name>\`), not ${http.auth.scheme}`);
  }
  return issues;
}

// ---- requests -------------------------------------------------------------------------

/** An href the server named, as a URL on the connection's own origin — or a refusal naming the origin it points at. */
function resolve(sync: Http, href: string, base: string): URL {
  let u: URL;
  try {
    u = new URL(href, base);
  } catch {
    throw new CaldavError("not_caldav", `connection ${sync.connection}: the server named an address that is not a URL`);
  }
  if (u.origin !== sync.origin) {
    throw new CaldavError(
      "other_host",
      `connection ${sync.connection}: the server keeps this account at ${u.origin}, and this connection reaches ${sync.origin} only — point the connection there (\`metistry connections set ${sync.connection} --url ${u.origin}/\`) and list ${u.host} on its secret (\`metistry secrets hosts <secret> ${u.host}\`); nothing was sent to it`,
    );
  }
  u.hash = "";
  return u;
}

async function cappedText(res: Response, what: string, max: number = ICS_MAX_BYTES): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new CaldavError("too_large", `${what}: more than ${max} bytes, which is not read`);
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

interface DavCall {
  depth?: "0" | "1";
  body?: string;
  contentType?: string;
  headers?: Record<string, string>;
}

async function dav(sync: Http, method: string, url: URL, call: DavCall = {}): Promise<Response> {
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.test(url.host.replace(/:\d+$/, "")))) {
    throw new CaldavError("not_https", `connection ${sync.connection}: CalDAV is reached over https — ${sync.origin} is not`);
  }
  const headers: Record<string, string> = { ...sync.headers, "user-agent": "metistry-caldav", ...(call.headers ?? {}) };
  if (call.depth !== undefined) headers.depth = call.depth;
  if (call.body !== undefined) headers["content-type"] = call.contentType ?? "application/xml; charset=utf-8";
  const res = await sync.fetch(url.href, {
    method,
    headers,
    ...(call.body !== undefined ? { body: call.body } : {}),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  // 401 is the sign-in; a 403 on a read is too (some servers answer a wrong password so). A 403 on a
  // write is the server refusing that change (RFC 6638's attendee rules) — the caller's to say.
  if (res.status === 401 || (res.status === 403 && (method === "PROPFIND" || method === "REPORT" || method === "GET"))) {
    void res.body?.cancel().catch(() => undefined); // not awaited: nothing here waits on a body it will not read
    throw new CaldavError(
      "unauthorized",
      `connection ${sync.connection}: ${sync.origin} refused the sign-in (HTTP ${res.status}) — an app password, not the account's own (\`metistry secrets set <name>\` replaces it)`,
    );
  }
  return res;
}

async function multistatus(sync: Http, res: Response, what: string): Promise<DavResponse[]> {
  if (res.status !== 207) {
    void res.body?.cancel().catch(() => undefined); // not awaited
    throw new CaldavError(res.status === 404 ? "not_found" : "http_status", `connection ${sync.connection}: ${sync.origin} answered ${what} with HTTP ${res.status}`);
  }
  const text = await cappedText(res, `connection ${sync.connection}: ${what}`);
  try {
    return parseMultistatus(text);
  } catch (err) {
    throw new CaldavError("not_caldav", `connection ${sync.connection}: ${sync.origin} answered ${what} with a body that is not a DAV multistatus (${err instanceof DavXmlError ? err.message : "unreadable"})`);
  }
}

const propfind = (props: string) =>
  `<?xml version="1.0" encoding="utf-8"?>\n<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop>${props}</d:prop></d:propfind>`;

const hrefIn = (el: XmlElement | undefined): string | undefined => child(el, DAV_NS, "href")?.text.trim() || undefined;

/** The response for `url` in a multistatus (a server may answer with its own spelling of the path, so compare decoded paths). */
function responseFor(sync: Http, responses: DavResponse[], url: URL): DavResponse | undefined {
  const path = (u: URL) => {
    try {
      return decodeURIComponent(u.pathname).replace(/\/+$/, "");
    } catch {
      return u.pathname.replace(/\/+$/, "");
    }
  };
  const want = path(url);
  return responses.find((r) => {
    try {
      return path(resolve(sync, r.href, url.href)) === want;
    } catch {
      return false;
    }
  }) ?? (responses.length === 1 ? responses[0] : undefined);
}

// ---- discovery ------------------------------------------------------------------------

/** The account as the server describes it. Addresses are the server's, lowercased, `mailto:` dropped. */
export interface CaldavAccount {
  principal: string;
  home: string;
  /** the owner's calendar user addresses (RFC 6638 `calendar-user-address-set`) — how the owner's attendee line is found */
  addresses: string[];
  /** whether the server delivers scheduling messages (RFC 6638: a schedule outbox, or `calendar-auto-schedule` in its DAV header) */
  scheduling: boolean;
}

/** `mailto:Dana@Example.com` → `dana@example.com`; anything that is not a mailto address → null. */
export function calendarAddress(value: string): string | null {
  const t = value.trim();
  if (!/^mailto:/i.test(t)) return null;
  let a = t.slice("mailto:".length);
  try {
    a = decodeURIComponent(a);
  } catch {
    // as written
  }
  a = a.trim().toLowerCase();
  return a === "" ? null : a;
}

/** Find the principal, its calendar home, its addresses and whether it schedules. Two PROPFINDs, both on the connection's origin. */
export async function discoverCaldav(sync: Http): Promise<CaldavAccount> {
  const start = resolve(sync, sync.url, sync.url);
  const first = await multistatus(sync, await dav(sync, "PROPFIND", start, { depth: "0", body: propfind("<d:current-user-principal/>") }), "PROPFIND (current-user-principal)");
  const cup = hrefIn(responseFor(sync, first, start)?.props.get(propKey(DAV_NS, "current-user-principal")));
  const principal = cup ? resolve(sync, cup, start.href) : start;

  const res = await dav(sync, "PROPFIND", principal, {
    depth: "0",
    body: propfind("<c:calendar-home-set/><c:calendar-user-address-set/><c:schedule-outbox-URL/>"),
  });
  const davHeader = (res.headers.get("dav") ?? "").toLowerCase();
  const second = await multistatus(sync, res, "PROPFIND (calendar-home-set)");
  const props = responseFor(sync, second, principal)?.props;
  const homeHref = hrefIn(props?.get(propKey(CALDAV_NS, "calendar-home-set")));
  if (!homeHref) {
    throw new CaldavError("not_caldav", `connection ${sync.connection}: ${sync.origin} names no calendar home for this account — is the connection's URL a CalDAV server's?`);
  }
  const home = resolve(sync, homeHref, principal.href);
  const addresses = [
    ...new Set(
      childrenOf(props?.get(propKey(CALDAV_NS, "calendar-user-address-set")), DAV_NS, "href")
        .map((h) => calendarAddress(h.text))
        .filter((a): a is string => a !== null),
    ),
  ].sort();
  const scheduling = props?.has(propKey(CALDAV_NS, "schedule-outbox-URL")) === true || /\bcalendar-auto-schedule\b/.test(davHeader);
  return { principal: principal.href, home: home.href, addresses, scheduling };
}

/** A calendar in the home that holds events. */
export interface CaldavCalendar {
  href: string;
  name: string | null;
}

/** The calendars in the account's home that hold events (a calendar whose component set names no VEVENT — a task list — is not one). */
export async function caldavCalendars(sync: Http, account: Pick<CaldavAccount, "home">): Promise<CaldavCalendar[]> {
  const home = resolve(sync, account.home, account.home);
  const responses = await multistatus(
    sync,
    await dav(sync, "PROPFIND", home, { depth: "1", body: propfind("<d:resourcetype/><d:displayname/><c:supported-calendar-component-set/>") }),
    "PROPFIND (calendars)",
  );
  const out: CaldavCalendar[] = [];
  for (const r of responses) {
    const u = resolve(sync, r.href, home.href);
    if (u.href.replace(/\/+$/, "") === home.href.replace(/\/+$/, "")) continue;
    if (!child(r.props.get(propKey(DAV_NS, "resourcetype")), CALDAV_NS, "calendar")) continue;
    const comps = r.props.get(propKey(CALDAV_NS, "supported-calendar-component-set"));
    if (comps && !childrenOf(comps, CALDAV_NS, "comp").some((c) => (c.attrs.name ?? "").toUpperCase() === "VEVENT")) continue;
    const name = r.props.get(propKey(DAV_NS, "displayname"))?.text.trim();
    out.push({ href: u.href, name: name ? name : null });
    if (out.length > MAX_CALENDARS) throw new CaldavError("too_large", `connection ${sync.connection}: more than ${MAX_CALENDARS} calendars — the read stopped rather than walk them all`);
  }
  return out.sort((a, b) => (a.href < b.href ? -1 : a.href > b.href ? 1 : 0));
}

/** One calendar object resource: its address, its ETag, and the iCalendar text the server holds. */
export interface CaldavResource {
  calendar: string;
  href: string;
  etag: string | null;
  data: string;
}

/** `20260928T040000Z` — RFC 4791's time-range spelling. */
function utcStamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

async function calendarQuery(sync: Http, calendar: string, filter: string): Promise<CaldavResource[]> {
  const url = resolve(sync, calendar, calendar);
  const body =
    `<?xml version="1.0" encoding="utf-8"?>\n<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">` +
    `<d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">${filter}</c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
  const responses = await multistatus(sync, await dav(sync, "REPORT", url, { depth: "1", body }), "REPORT (calendar-query)");
  const out: CaldavResource[] = [];
  for (const r of responses) {
    const data = r.props.get(propKey(CALDAV_NS, "calendar-data"))?.text;
    if (data === undefined || data.trim() === "") continue;
    const etag = r.props.get(propKey(DAV_NS, "getetag"))?.text.trim();
    out.push({ calendar: url.href, href: resolve(sync, r.href, url.href).href, etag: etag ? etag : null, data });
  }
  return out;
}

// ---- read -----------------------------------------------------------------------------

/** An occurrence as the CalDAV sync stores it: the ICS shape, with the owner found by the server's own addresses. */
export interface CaldavOccurrence extends Omit<IcsOccurrence, "self_status"> {
  /** the owner's own answer, when the owner is an attendee; null otherwise */
  self_status: string | null;
}

export interface CaldavRead {
  account: CaldavAccount;
  calendars: number;
  resources: number;
  events: CaldavOccurrence[];
  skipped: IcsSkipped;
}

/** Mark the owner among an occurrence's attendees by the server's addresses, and take their answer as `self_status`. */
export function markOwner(e: IcsOccurrence, addresses: readonly string[]): CaldavOccurrence {
  const mine = new Set(addresses);
  const participants = e.participants.map((p) => ({ ...p, self: p.email !== null && mine.has(p.email.trim().toLowerCase()) }));
  const self = participants.find((p) => p.self);
  return { ...e, participants, self_status: self ? self.status : null };
}

/**
 * Everything in the account's calendars that overlaps the window, expanded
 * by `ics.ts` (one resource at a time, so each keeps its own VTIMEZONEs),
 * the owner marked. A key read twice — one event in two calendars — is kept
 * once, the first calendar's.
 */
export async function readCaldav(sync: Http, opts: ExpandOptions): Promise<CaldavRead> {
  const account = await discoverCaldav(sync);
  const calendars = await caldavCalendars(sync, account);
  const range = `<c:time-range start="${utcStamp(opts.windowStart)}" end="${utcStamp(opts.windowEnd)}"/>`;
  const skipped: IcsSkipped = { unsupported_rule: 0, unreadable: 0, unknown_zones: [] };
  const zones = new Set<string>();
  const events: CaldavOccurrence[] = [];
  const seen = new Set<string>();
  let resources = 0;
  for (const cal of calendars) {
    for (const r of await calendarQuery(sync, cal.href, range)) {
      resources++;
      const parsed = parseIcs(r.data);
      if (!parsed) {
        skipped.unreadable++;
        continue;
      }
      const got = icsOccurrences(parsed, opts);
      skipped.unsupported_rule += got.skipped.unsupported_rule;
      skipped.unreadable += got.skipped.unreadable;
      for (const z of got.skipped.unknown_zones) zones.add(z);
      for (const e of got.events) {
        if (seen.has(e.event_id)) continue;
        seen.add(e.event_id);
        events.push(markOwner(e, account.addresses));
      }
    }
  }
  skipped.unknown_zones = [...zones].sort();
  events.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0));
  return { account, calendars: calendars.length, resources, events, skipped };
}

// ---- one event, by UID ------------------------------------------------------------------

const UID_MAX = 1024; // limit: fixed — apps/reconciler EVENT_ID_MAX: a UID a meeting note could not name is not one this module looks up

function checkUid(uid: string): void {
  if (typeof uid !== "string" || uid.trim() === "" || uid.length > UID_MAX || /[\u0000-\u001f\u007f]/.test(uid) || uid !== uid.trim()) {
    throw new CaldavError("bad_request", "an event's UID is non-empty text with no control characters, at most 1024 long");
  }
}

function uidsOf(cal: IcsComponent): Set<string> {
  const out = new Set<string>();
  for (const c of cal.children) if (c.name === "VEVENT") for (const p of c.props) if (p.name === "UID") out.add(p.value.trim());
  return out;
}

/**
 * The resource that holds the event `uid`, read afresh with GET — its exact
 * text and its ETag, which is what a change is bound to. RFC 4791's
 * text-match is a substring match, so the UID is compared exactly after.
 */
export async function findCaldavEvent(sync: Http, account: Pick<CaldavAccount, "home">, uid: string): Promise<CaldavResource> {
  checkUid(uid);
  const filter = `<c:prop-filter name="UID"><c:text-match collation="i;octet">${escapeXml(uid)}</c:text-match></c:prop-filter>`;
  for (const cal of await caldavCalendars(sync, account)) {
    for (const r of await calendarQuery(sync, cal.href, filter)) {
      const parsed = parseIcs(r.data);
      if (!parsed || !uidsOf(parsed).has(uid)) continue;
      const res = await dav(sync, "GET", resolve(sync, r.href, r.href), { headers: { accept: "text/calendar" } });
      if (res.status === 404) {
        void res.body?.cancel().catch(() => undefined);
        throw new CaldavError("not_found", `connection ${sync.connection}: the event is gone from ${sync.origin}`);
      }
      if (!res.ok) {
        void res.body?.cancel().catch(() => undefined);
        throw new CaldavError("http_status", `connection ${sync.connection}: ${sync.origin} answered GET with HTTP ${res.status}`);
      }
      const data = await cappedText(res, `connection ${sync.connection}: GET`);
      const etag = res.headers.get("etag") ?? r.etag;
      return { calendar: cal.href, href: r.href, etag: etag ? etag.trim() : null, data };
    }
  }
  throw new CaldavError("not_found", `connection ${sync.connection}: no event with that UID in this account's calendars`);
}

// ---- the resource as text -----------------------------------------------------------------

/** One logical content line: what it is, unfolded, and the exact text (terminator included) it was sent as. */
interface Logical {
  raw: string;
  unfolded: string;
}

function logicalLines(text: string): { lines: Logical[]; eol: string } {
  const eol = /\r\n/.test(text) ? "\r\n" : "\n";
  const physical = text.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g)?.filter((l) => l !== "") ?? [];
  const lines: Logical[] = [];
  for (const p of physical) {
    const content = p.replace(/(?:\r\n|\n|\r)$/, "");
    const last = lines[lines.length - 1];
    if (last && (content.startsWith(" ") || content.startsWith("\t"))) {
      last.raw += p;
      last.unfolded += content.slice(1);
    } else {
      lines.push({ raw: p, unfolded: content });
    }
  }
  return { lines, eol };
}

/** A content line's parts as written: the name, each parameter's own spelling, the value. */
interface RawProp {
  name: string;
  params: { key: string; raw: string; values: string[] }[];
  value: string;
}

function scanProp(line: string): RawProp | null {
  let i = 0;
  const n = line.length;
  while (i < n && line[i] !== ";" && line[i] !== ":") i++;
  if (i >= n || i === 0) return null;
  const name = line.slice(0, i);
  const params: RawProp["params"] = [];
  while (i < n && line[i] === ";") {
    const from = i;
    i++;
    const eq = line.indexOf("=", i);
    if (eq < 0) return null;
    const key = line.slice(i, eq).trim().toUpperCase();
    i = eq + 1;
    const values: string[] = [];
    for (;;) {
      if (line[i] === '"') {
        const close = line.indexOf('"', i + 1);
        if (close < 0) return null;
        values.push(line.slice(i + 1, close));
        i = close + 1;
      } else {
        const s = i;
        while (i < n && line[i] !== "," && line[i] !== ";" && line[i] !== ":") i++;
        values.push(line.slice(s, i));
      }
      if (line[i] === ",") {
        i++;
        continue;
      }
      break;
    }
    params.push({ key, raw: line.slice(from, i), values });
  }
  if (line[i] !== ":") return null;
  return { name, params, value: line.slice(i + 1) };
}

const paramOf = (p: RawProp, key: string): string | undefined => p.params.find((x) => x.key === key)?.values[0];

/** RFC 5545 §3.1: a line longer than 75 octets is folded — never inside a UTF-8 sequence. No terminator is added. */
export function foldLine(line: string, eol: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let at = 0;
  let limit = 75;
  while (at < bytes.length) {
    let end = Math.min(at + limit, bytes.length);
    while (end < bytes.length && end > at && (bytes[end]! & 0xc0) === 0x80) end--; // not in the middle of a character
    parts.push(bytes.subarray(at, end).toString("utf8"));
    at = end;
    limit = 74; // a continuation line starts with one space
  }
  return parts.join(`${eol} `);
}

/** The terminator a line was sent with ("" for a last line with none). */
const terminatorOf = (raw: string): string => /(\r\n|\n|\r)$/.exec(raw)?.[1] ?? "";


/** Each VEVENT's lines (by index), outside any nested component — so a VALARM's ATTENDEE or DESCRIPTION is never read as its event's. */
interface EventLines {
  begin: number;
  end: number;
  /** indexes of the VEVENT's own properties */
  own: number[];
}

function eventsIn(lines: Logical[]): EventLines[] {
  const out: EventLines[] = [];
  const stack: string[] = [];
  let current: EventLines | null = null;
  lines.forEach((l, i) => {
    const p = scanProp(l.unfolded);
    const name = p?.name.toUpperCase();
    if (name === "BEGIN") {
      const comp = p!.value.trim().toUpperCase();
      stack.push(comp);
      if (comp === "VEVENT" && stack.length === 2 && stack[0] === "VCALENDAR") current = { begin: i, end: -1, own: [] };
      return;
    }
    if (name === "END") {
      const comp = p!.value.trim().toUpperCase();
      if (comp === "VEVENT" && current && stack.length === 2) {
        current.end = i;
        out.push(current);
        current = null;
      }
      const at = stack.lastIndexOf(comp);
      if (at >= 0) stack.length = at;
      return;
    }
    if (current && stack.length === 2 && stack[1] === "VEVENT") current.own.push(i);
  });
  return out;
}

function unescapeText(v: string): string {
  return v.replace(/\\([nN,;\\])/g, (_m, c: string) => (c === "n" || c === "N" ? "\n" : c));
}

function escapeText(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r\n|\r|\n/g, "\\n");
}

/** A line that changed: the text as unfolded, before and after. */
export interface LineChange {
  before: string | null;
  after: string | null;
}

function textOf(lines: Logical[]): string {
  return lines.map((l) => l.raw).join("");
}

function propsOf(lines: Logical[], ev: EventLines, name: string): { i: number; p: RawProp }[] {
  const out: { i: number; p: RawProp }[] = [];
  for (const i of ev.own) {
    const p = scanProp(lines[i]!.unfolded);
    if (p && p.name.toUpperCase() === name) out.push({ i, p });
  }
  return out;
}

function eventUid(lines: Logical[], ev: EventLines): string | undefined {
  return propsOf(lines, ev, "UID")[0]?.p.value.trim();
}

function eventTitle(lines: Logical[], evs: EventLines[]): string {
  const master = evs.find((ev) => propsOf(lines, ev, "RECURRENCE-ID").length === 0) ?? evs[0];
  const s = master ? propsOf(lines, master, "SUMMARY")[0]?.p.value : undefined;
  return s !== undefined ? unescapeText(s) : "";
}

// ---- reply (rsvp) ---------------------------------------------------------------------------

/** The answers an invitation takes — `calendar_events.self_status`'s spelling. */
export const RSVP_RESPONSES = ["accepted", "tentative", "declined"] as const;
export type RsvpResponse = (typeof RSVP_RESPONSES)[number];
const PARTSTAT_OF: Readonly<Record<RsvpResponse, string>> = { accepted: "ACCEPTED", tentative: "TENTATIVE", declined: "DECLINED" };

export interface ReplyPlan {
  uid: string;
  response: RsvpResponse;
  title: string;
  /** who the reply goes to — the organizer's address */
  organizer: string | null;
  /** the owner's address it answers as */
  as: string;
  /** exactly the lines that change: the owner's own attendee lines */
  changes: LineChange[];
  /** the resource as it will be written */
  text: string;
  /** the owner has already given this answer: nothing to write */
  unchanged: boolean;
}

/**
 * The reply as a text edit of the server's copy, and nothing else: in each
 * VEVENT of `uid` the owner attends, the owner's own ATTENDEE line gets
 * `PARTSTAT=<answer>` (in place when it had one), and loses `RSVP` (the
 * request is answered) and `SCHEDULE-STATUS` (the server's to set, RFC 6638
 * §3.2.9). Every other line — every other attendee, the organizer, the
 * times, a VALARM's attendee — is the server's bytes, unchanged.
 */
export function planReply(data: string, addresses: readonly string[], uid: string, response: RsvpResponse): ReplyPlan {
  checkUid(uid);
  if (!(RSVP_RESPONSES as readonly string[]).includes(response)) throw new CaldavError("bad_request", `an answer is one of ${RSVP_RESPONSES.join(", ")}`);
  const mine = new Set(addresses.map((a) => a.trim().toLowerCase()));
  if (mine.size === 0) throw new CaldavError("no_scheduling", "the server names no calendar address for this account, so the owner's attendee line cannot be found");
  const { lines, eol } = logicalLines(data);
  const events = eventsIn(lines).filter((ev) => eventUid(lines, ev) === uid);
  if (events.length === 0) throw new CaldavError("not_found", "the resource holds no event with that UID");

  const rewrite = new Map<number, string>();
  let organizer: string | null = null;
  let as: string | null = null;
  for (const ev of events) {
    const org = propsOf(lines, ev, "ORGANIZER")[0];
    const orgAddress = org ? calendarAddress(org.p.value) : null;
    if (orgAddress !== null && mine.has(orgAddress)) throw new CaldavError("not_invited", "the owner organises this event — a reply is an attendee's");
    const own = propsOf(lines, ev, "ATTENDEE").filter(({ p }) => {
      const a = calendarAddress(p.value);
      return a !== null && mine.has(a);
    });
    if (own.length === 0) continue;
    if (!org || orgAddress === null) throw new CaldavError("no_scheduling", "the event names no organizer to reply to");
    const agent = (paramOf(org.p, "SCHEDULE-AGENT") ?? "SERVER").toUpperCase();
    if (agent !== "SERVER") throw new CaldavError("no_scheduling", `the organizer's copy says SCHEDULE-AGENT=${agent.slice(0, 20)} — the server would not deliver the reply`);
    organizer = orgAddress;
    for (const { i, p } of own) {
      as ??= calendarAddress(p.value);
      const params: string[] = [];
      let placed = false;
      for (const x of p.params) {
        if (x.key === "RSVP" || x.key === "SCHEDULE-STATUS") continue;
        if (x.key === "PARTSTAT") {
          if (!placed) params.push(`;PARTSTAT=${PARTSTAT_OF[response]}`);
          placed = true;
          continue;
        }
        params.push(x.raw);
      }
      if (!placed) params.push(`;PARTSTAT=${PARTSTAT_OF[response]}`);
      const after = `${p.name}${params.join("")}:${p.value}`;
      if (after !== lines[i]!.unfolded) rewrite.set(i, after);
    }
  }
  if (as === null) throw new CaldavError("not_invited", "the owner is not an attendee of this event");

  const changes: LineChange[] = [];
  const next = lines.map((l, i) => {
    const after = rewrite.get(i);
    if (after === undefined) return l;
    changes.push({ before: l.unfolded, after });
    return { raw: foldLine(after, eol) + terminatorOf(l.raw), unfolded: after };
  });
  return { uid, response, title: eventTitle(lines, events), organizer, as, changes, text: textOf(next), unchanged: changes.length === 0 };
}

/** What a reply would do, read now — the preview. `etag` is what the confirm names. */
export interface ReplyPreview {
  connection: string;
  uid: string;
  response: RsvpResponse;
  title: string;
  organizer: string | null;
  as: string;
  etag: string;
  changes: LineChange[];
  unchanged: boolean;
}

async function replyFor(sync: Http, uid: string, response: RsvpResponse): Promise<{ resource: CaldavResource; plan: ReplyPlan }> {
  const account = await discoverCaldav(sync);
  if (!account.scheduling) throw new CaldavError("no_scheduling", `connection ${sync.connection}: ${sync.origin} does not implement scheduling (RFC 6638), so a reply would never reach the organizer`);
  const resource = await findCaldavEvent(sync, account, uid);
  if (resource.etag === null) throw new CaldavError("unsupported", `connection ${sync.connection}: ${sync.origin} gives the event no ETag, so a change cannot be bound to what was previewed`);
  return { resource, plan: planReply(resource.data, account.addresses, uid, response) };
}

/** Preview a reply: which line changes, as whom, to whom — nothing is written. */
export async function previewReply(sync: Http, req: { uid: string; response: RsvpResponse }): Promise<ReplyPreview> {
  const { resource, plan } = await replyFor(sync, req.uid, req.response);
  return { connection: sync.connection, uid: plan.uid, response: plan.response, title: plan.title, organizer: plan.organizer, as: plan.as, etag: resource.etag!, changes: plan.changes, unchanged: plan.unchanged };
}

export interface WriteResult {
  connection: string;
  uid: string;
  /** the new ETag, when the server gave one */
  etag: string | null;
  changes: LineChange[];
  /** nothing needed writing */
  unchanged: boolean;
}

function checkEtag(etag: unknown): string {
  if (typeof etag !== "string" || etag.trim() === "" || etag.length > 256 || /[\u0000-\u001f\u007f]/.test(etag)) {
    throw new CaldavError("bad_request", "a confirm names the ETag its preview gave");
  }
  return etag.trim();
}

async function put(sync: Http, href: string, text: string, condition: Record<string, string>, what: string): Promise<string | null> {
  const res = await dav(sync, "PUT", resolve(sync, href, href), { body: text, contentType: "text/calendar; charset=utf-8", headers: condition });
  void res.body?.cancel().catch(() => undefined); // not awaited: the status is the answer
  if (res.status === 412) throw new CaldavError("changed", `connection ${sync.connection}: the event changed on ${sync.origin} since the preview — preview again`);
  if (!res.ok) throw new CaldavError("http_status", `connection ${sync.connection}: ${sync.origin} refused the ${what} (HTTP ${res.status})`);
  return res.headers.get("etag");
}

/**
 * Answer an invitation (`rsvp`). The change is re-derived from the server's
 * copy — never taken from the caller — and written only if that copy is
 * still the one previewed (`etag`, sent as `If-Match`). The server delivers
 * the iTIP REPLY (RFC 6638 §3.2.2).
 */
export async function respondToInvitation(sync: Http, req: { uid: string; response: RsvpResponse; etag: string }): Promise<WriteResult> {
  const etag = checkEtag(req.etag);
  const { resource, plan } = await replyFor(sync, req.uid, req.response);
  if (resource.etag !== etag) throw new CaldavError("changed", `connection ${sync.connection}: the event changed on ${sync.origin} since the preview — preview again`);
  if (plan.unchanged) return { connection: sync.connection, uid: plan.uid, etag, changes: [], unchanged: true };
  const next = await put(sync, resource.href, plan.text, { "if-match": etag }, "reply");
  return { connection: sync.connection, uid: plan.uid, etag: next, changes: plan.changes, unchanged: false };
}

// ---- write own ---------------------------------------------------------------------------------

/** An event of the owner's own, as a caller describes it. Times are ISO 8601; an all-day event's are dates, the end exclusive. */
export interface OwnEventDraft {
  title: string;
  start: string;
  end: string;
  all_day?: boolean | undefined;
  location?: string | null | undefined;
}

/** A change to one: only what is named changes. `start` and `end` go together. */
export interface OwnEventChange {
  title?: string | undefined;
  start?: string | undefined;
  end?: string | undefined;
  all_day?: boolean | undefined;
  location?: string | null | undefined;
}

const TEXT_MAX = 500; // limit: fixed — a title or a place, not a document
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function checkText(v: unknown, what: string, empty: boolean): string {
  if (typeof v !== "string" || (!empty && v.trim() === "") || v.length > TEXT_MAX || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(v)) {
    throw new CaldavError("bad_request", `${what} is text of at most ${TEXT_MAX} characters${empty ? "" : ", not empty"}, with no control characters`);
  }
  return v;
}

/** `DTSTART:20260928T130000Z` / `DTSTART;VALUE=DATE:20260928` from a caller's times. */
function timeLines(start: unknown, end: unknown, allDay: boolean): { start: string; end: string } {
  if (allDay) {
    if (typeof start !== "string" || typeof end !== "string" || !DATE_RE.test(start) || !DATE_RE.test(end) || Number.isNaN(Date.parse(start)) || Number.isNaN(Date.parse(end)) || end <= start) {
      throw new CaldavError("bad_request", "an all-day event's start and end are dates (YYYY-MM-DD), the end after the start (exclusive)");
    }
    return { start: `DTSTART;VALUE=DATE:${start.replaceAll("-", "")}`, end: `DTEND;VALUE=DATE:${end.replaceAll("-", "")}` };
  }
  const s = typeof start === "string" && /T/.test(start) ? Date.parse(start) : Number.NaN;
  const e = typeof end === "string" && /T/.test(end) ? Date.parse(end) : Number.NaN;
  if (Number.isNaN(s) || Number.isNaN(e) || e <= s) throw new CaldavError("bad_request", "start and end are ISO 8601 date-times, the end after the start");
  return { start: `DTSTART:${utcStamp(s)}`, end: `DTEND:${utcStamp(e)}` };
}

const OWN_UID_RE = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,199}$/;

/** A UID for a new event: the resource is named for it, so it is URL-safe. */
export function newEventUid(): string {
  return `${randomUUID()}@metistry`;
}

/** The iCalendar text of a new event of the owner's own: no organizer, no attendee — nobody is sent anything. */
export function renderOwnEvent(uid: string, draft: OwnEventDraft, now: number): string {
  if (!OWN_UID_RE.test(uid)) throw new CaldavError("bad_request", "a new event's UID is letters, digits and . _ @ -, at most 200");
  const title = checkText(draft.title, "a title", false);
  const location = draft.location === undefined || draft.location === null ? null : checkText(draft.location, "a location", true);
  const t = timeLines(draft.start, draft.end, draft.all_day === true);
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Folded Space Labs//Metistry//EN",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${utcStamp(now)}`,
    `CREATED:${utcStamp(now)}`,
    `LAST-MODIFIED:${utcStamp(now)}`,
    t.start,
    t.end,
    `SUMMARY:${escapeText(title)}`,
    ...(location !== null && location.trim() !== "" ? [`LOCATION:${escapeText(location)}`] : []),
    "SEQUENCE:0",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map((l) => `${foldLine(l, "\r\n")}\r\n`).join("");
}

/** Refuse an event that is not the owner's alone, or is a series. */
function ownEvent(lines: Logical[], addresses: readonly string[], uid: string): EventLines {
  const mine = new Set(addresses.map((a) => a.trim().toLowerCase()));
  const events = eventsIn(lines).filter((ev) => eventUid(lines, ev) === uid);
  if (events.length === 0) throw new CaldavError("not_found", "the resource holds no event with that UID");
  for (const ev of events) {
    const org = propsOf(lines, ev, "ORGANIZER")[0];
    if (org) {
      const a = calendarAddress(org.p.value);
      if (a === null || !mine.has(a)) throw new CaldavError("not_own", "someone else organises this event — only the owner's reply changes it");
    }
    const others = propsOf(lines, ev, "ATTENDEE").filter(({ p }) => {
      const a = calendarAddress(p.value);
      return a === null || !mine.has(a);
    });
    if (others.length > 0) throw new CaldavError("not_own", "this event has others in it — changing it would send them an update, which write_own never does");
  }
  const master = events[0]!;
  if (events.length > 1 || ["RRULE", "RDATE", "EXDATE", "RECURRENCE-ID"].some((n) => propsOf(lines, master, n).length > 0)) {
    throw new CaldavError("unsupported", "a recurring event is not rewritten — change it in Calendar");
  }
  return master;
}

/** The change as a text edit of the owner's own event: the named fields, DTSTAMP, LAST-MODIFIED and SEQUENCE; nothing else. */
export function planOwnChange(data: string, addresses: readonly string[], uid: string, change: OwnEventChange, now: number): { text: string; changes: LineChange[]; title: string } {
  checkUid(uid);
  const { lines, eol } = logicalLines(data);
  const ev = ownEvent(lines, addresses, uid);
  const set = new Map<string, string | null>(); // property name → new unfolded line, or null to remove
  if (change.title !== undefined) set.set("SUMMARY", `SUMMARY:${escapeText(checkText(change.title, "a title", false))}`);
  if (change.location !== undefined) {
    const loc = change.location === null ? null : checkText(change.location, "a location", true);
    set.set("LOCATION", loc === null || loc.trim() === "" ? null : `LOCATION:${escapeText(loc)}`);
  }
  if (change.start !== undefined || change.end !== undefined || change.all_day !== undefined) {
    if (change.start === undefined || change.end === undefined) throw new CaldavError("bad_request", "a new time names both start and end");
    const t = timeLines(change.start, change.end, change.all_day === true);
    set.set("DTSTART", t.start);
    set.set("DTEND", t.end);
    set.set("DURATION", null);
  }
  if (set.size === 0) throw new CaldavError("bad_request", "say what changes: title, location, or start and end");
  const seq = Number(propsOf(lines, ev, "SEQUENCE")[0]?.p.value.trim() ?? "0");
  set.set("DTSTAMP", `DTSTAMP:${utcStamp(now)}`);
  set.set("LAST-MODIFIED", `LAST-MODIFIED:${utcStamp(now)}`);
  set.set("SEQUENCE", `SEQUENCE:${Number.isInteger(seq) && seq >= 0 ? seq + 1 : 1}`);

  const changes: LineChange[] = [];
  const done = new Set<string>();
  const out: Logical[] = [];
  lines.forEach((l, i) => {
    if (i === ev.end) {
      for (const [name, line] of set) {
        if (done.has(name) || line === null) continue;
        changes.push({ before: null, after: line });
        out.push({ raw: foldLine(line, eol) + eol, unfolded: line });
      }
      out.push(l);
      return;
    }
    const p = ev.own.includes(i) ? scanProp(l.unfolded) : null;
    const name = p?.name.toUpperCase();
    if (name !== undefined && set.has(name)) {
      if (done.has(name)) {
        changes.push({ before: l.unfolded, after: null }); // a second DTSTART or SUMMARY: one stands
        return;
      }
      done.add(name);
      const line = set.get(name)!;
      if (line === null) {
        changes.push({ before: l.unfolded, after: null });
        return;
      }
      if (line !== l.unfolded) changes.push({ before: l.unfolded, after: line });
      out.push(line === l.unfolded ? l : { raw: foldLine(line, eol) + terminatorOf(l.raw), unfolded: line });
      return;
    }
    out.push(l);
  });
  const summary = propsOf(lines, ev, "SUMMARY")[0]?.p.value;
  return { text: textOf(out), changes, title: change.title ?? (summary !== undefined ? unescapeText(summary) : "") };
}

export interface OwnPreview {
  connection: string;
  uid: string;
  title: string;
  /** the calendar it is (or would be) in */
  calendar: string;
  /** null for a new event */
  etag: string | null;
  changes: LineChange[];
}

async function defaultCalendar(sync: Http, account: CaldavAccount, calendar: string | undefined): Promise<string> {
  const calendars = await caldavCalendars(sync, account);
  if (calendar !== undefined) {
    const want = resolve(sync, calendar, account.home).href.replace(/\/+$/, "");
    const hit = calendars.find((c) => c.href.replace(/\/+$/, "") === want);
    if (!hit) throw new CaldavError("not_found", `connection ${sync.connection}: no calendar at that address in this account`);
    return hit.href;
  }
  const first = calendars[0];
  if (!first) throw new CaldavError("not_found", `connection ${sync.connection}: this account has no calendar that holds events`);
  return first.href;
}

function resourceHref(calendar: string, uid: string): string {
  return `${calendar.endsWith("/") ? calendar : `${calendar}/`}${encodeURIComponent(uid)}.ics`;
}

/** Preview a new event of the owner's own. The UID it returns is what the confirm names. */
export async function previewCreateEvent(sync: Http, req: { draft: OwnEventDraft; calendar?: string | undefined; now?: number | undefined }): Promise<OwnPreview> {
  const account = await discoverCaldav(sync);
  const calendar = await defaultCalendar(sync, account, req.calendar);
  const uid = newEventUid();
  const text = renderOwnEvent(uid, req.draft, req.now ?? Date.now());
  return { connection: sync.connection, uid, title: req.draft.title, calendar, etag: null, changes: logicalLines(text).lines.map((l) => ({ before: null, after: l.unfolded })) };
}

/** Create it (`write_own`): the resource is named for its UID and written with `If-None-Match: *`, so an existing event is never replaced. */
export async function createOwnEvent(sync: Http, req: { uid: string; draft: OwnEventDraft; calendar?: string | undefined; now?: number | undefined }): Promise<WriteResult> {
  const text = renderOwnEvent(req.uid, req.draft, req.now ?? Date.now());
  const account = await discoverCaldav(sync);
  const calendar = await defaultCalendar(sync, account, req.calendar);
  const etag = await put(sync, resourceHref(calendar, req.uid), text, { "if-none-match": "*" }, "new event");
  return { connection: sync.connection, uid: req.uid, etag, changes: logicalLines(text).lines.map((l) => ({ before: null, after: l.unfolded })), unchanged: false };
}

/** Preview a change to an event of the owner's own. */
export async function previewChangeEvent(sync: Http, req: { uid: string; change: OwnEventChange; now?: number | undefined }): Promise<OwnPreview> {
  const account = await discoverCaldav(sync);
  const resource = await findCaldavEvent(sync, account, req.uid);
  if (resource.etag === null) throw new CaldavError("unsupported", `connection ${sync.connection}: ${sync.origin} gives the event no ETag, so a change cannot be bound to what was previewed`);
  const plan = planOwnChange(resource.data, account.addresses, req.uid, req.change, req.now ?? Date.now());
  return { connection: sync.connection, uid: req.uid, title: plan.title, calendar: resource.calendar, etag: resource.etag, changes: plan.changes };
}

/** Change it (`write_own`), from the server's copy, only if that copy is still the one previewed. */
export async function changeOwnEvent(sync: Http, req: { uid: string; change: OwnEventChange; etag: string; now?: number | undefined }): Promise<WriteResult> {
  const etag = checkEtag(req.etag);
  const account = await discoverCaldav(sync);
  const resource = await findCaldavEvent(sync, account, req.uid);
  if (resource.etag !== etag) throw new CaldavError("changed", `connection ${sync.connection}: the event changed on ${sync.origin} since the preview — preview again`);
  const plan = planOwnChange(resource.data, account.addresses, req.uid, req.change, req.now ?? Date.now());
  const next = await put(sync, resource.href, plan.text, { "if-match": etag }, "change");
  return { connection: sync.connection, uid: req.uid, etag: next, changes: plan.changes, unchanged: false };
}

/** Preview deleting an event of the owner's own. */
export async function previewDeleteEvent(sync: Http, req: { uid: string }): Promise<OwnPreview> {
  const account = await discoverCaldav(sync);
  const resource = await findCaldavEvent(sync, account, req.uid);
  if (resource.etag === null) throw new CaldavError("unsupported", `connection ${sync.connection}: ${sync.origin} gives the event no ETag, so a delete cannot be bound to what was previewed`);
  const { lines } = logicalLines(resource.data);
  const ev = ownEvent(lines, account.addresses, req.uid);
  return { connection: sync.connection, uid: req.uid, title: eventTitle(lines, [ev]), calendar: resource.calendar, etag: resource.etag, changes: lines.map((l) => ({ before: l.unfolded, after: null })) };
}

/** Delete it (`write_own`) — only the owner's own, only the copy previewed (`If-Match`). */
export async function deleteOwnEvent(sync: Http, req: { uid: string; etag: string }): Promise<WriteResult> {
  const etag = checkEtag(req.etag);
  const account = await discoverCaldav(sync);
  const resource = await findCaldavEvent(sync, account, req.uid);
  if (resource.etag !== etag) throw new CaldavError("changed", `connection ${sync.connection}: the event changed on ${sync.origin} since the preview — preview again`);
  const { lines } = logicalLines(resource.data);
  ownEvent(lines, account.addresses, req.uid);
  const res = await dav(sync, "DELETE", resolve(sync, resource.href, resource.href), { headers: { "if-match": etag } });
  void res.body?.cancel().catch(() => undefined);
  if (res.status === 412) throw new CaldavError("changed", `connection ${sync.connection}: the event changed on ${sync.origin} since the preview — preview again`);
  if (!res.ok) throw new CaldavError("http_status", `connection ${sync.connection}: ${sync.origin} refused the delete (HTTP ${res.status})`);
  return { connection: sync.connection, uid: req.uid, etag: null, changes: lines.map((l) => ({ before: l.unfolded, after: null })), unchanged: false };
}
