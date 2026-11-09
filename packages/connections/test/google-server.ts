// A fixture Google on loopback (T4-14) — never Google. Two halves:
//
//   * **the authorization server** — T4-10's fixture (`oauth-server.ts`),
//     reached at Google's own addresses: `accounts.google.com/o/oauth2/v2/auth`
//     and `oauth2.googleapis.com/token` are routed to its /authorize and
//     /token, so the PKCE check, the one-use code and the refresh are the
//     same fixture every OAuth test trusts;
//   * **the Calendar API v3** at `www.googleapis.com/calendar/v3/` — the
//     owner's primary calendar from the recorded fixtures
//     (`google-fixtures.ts`), answering only a Bearer access token the
//     authorization server issued, recording every request (headers and
//     body), honouring `If-Match` (412) and a caller's event id (409), and
//     applying a reply the way Google does: with `attendeesOmitted`, only the
//     attendees named change.
//
// `routeTo` is the base fetch a test hands the door: Google's three origins
// come here over loopback, everything else goes on as it is. Nothing is
// sent to Google.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { AUTH_ORIGIN, fakeAuthServer, type FakeAuthOptions, type FakeAuthServer } from "./oauth-server.js";
import { LIST_PAGES, eventsById, type RecordedEvent } from "./google-fixtures.js";

export const GOOGLE_AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
export const GOOGLE_API = "https://www.googleapis.com";

export interface ApiRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface FakeGoogle {
  auth: FakeAuthServer;
  /** every request to the Calendar API */
  api: ApiRequest[];
  /** the events as the fixture now holds them, by id */
  events: Map<string, RecordedEvent>;
  /** a fetch that sends Google's origins here and anything else to `fallback` */
  routeTo(fallback?: typeof fetch): typeof fetch;
  /** the owner's browser: GET the authorize address, follow its redirect to the loopback; the loopback's status */
  browse(authorizationUrl: string): Promise<number>;
  close(): Promise<void>;
}

export interface FakeGoogleOptions extends FakeAuthOptions {
  /** answer every API request with a 307 to another origin */
  redirectTo?: string;
  /** change an event's ETag after it is read and before a write lands — someone else edited it */
  editBetween?: boolean;
  /** the list pages to serve (default: the recorded ones) */
  pages?: RecordedEvent[][];
}

let etagSeq = 9000;
const nextEtag = () => `"${3371000000000000 + ++etagSeq}"`;

export async function fakeGoogle(opts: FakeGoogleOptions = {}): Promise<FakeGoogle> {
  const auth = await fakeAuthServer(opts);
  const api: ApiRequest[] = [];
  const events = eventsById();
  const deleted = new Set<string>();
  const pages = opts.pages ?? LIST_PAGES;
  const json = (res: ServerResponse, status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json; charset=UTF-8" }).end(JSON.stringify(body));
  const gError = (res: ServerResponse, status: number, reason: string, message: string) => json(res, status, { error: { code: status, message, errors: [{ domain: "global", reason, message }] } });

  const http = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://x");
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    api.push({ method: req.method ?? "", path: url.pathname, query: url.searchParams, headers: { ...req.headers }, body });
    if (opts.redirectTo) return void res.writeHead(307, { location: opts.redirectTo }).end();
    const bearer = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ""))?.[1];
    if (!bearer || !auth.issuedAccess.includes(bearer)) return gError(res, 401, "authError", "Invalid Credentials");
    const m = /^\/calendar\/v3\/calendars\/primary\/events(?:\/([^/]+))?$/.exec(url.pathname);
    if (!m) return gError(res, 404, "notFound", "Not Found");
    const id = m[1] !== undefined ? decodeURIComponent(m[1]) : undefined;

    if (req.method === "GET" && id === undefined) {
      const at = url.searchParams.get("pageToken");
      const n = at === null ? 0 : Number(at.replace("page", "")) - 1;
      // each page as the calendar holds it now: a reply or a move shows on the next read, a deleted event is gone
      const items = (pages[n] ?? []).filter((e) => !deleted.has(String(e.id))).map((e) => events.get(String(e.id)) ?? e);
      return json(res, 200, {
        kind: "calendar#events",
        etag: '"p33c1a2b3c4d5e6f"',
        summary: "me@example.com",
        timeZone: "America/New_York",
        items,
        ...(n + 1 < pages.length ? { nextPageToken: `page${n + 2}` } : {}),
      });
    }
    if (req.method === "POST" && id === undefined) {
      const e = JSON.parse(body) as RecordedEvent;
      if (typeof e.id === "string" && events.has(e.id)) return gError(res, 409, "duplicate", "The requested identifier already exists.");
      const made: RecordedEvent = { kind: "calendar#event", ...e, etag: nextEtag(), status: "confirmed", organizer: { email: "me@example.com", self: true }, creator: { email: "me@example.com", self: true } };
      events.set(String(made.id), made);
      return json(res, 200, made);
    }
    const e = id !== undefined ? events.get(id) : undefined;
    if (!e) return gError(res, 404, "notFound", "Not Found");
    if (req.method === "GET") return json(res, 200, e);
    const ifMatch = req.headers["if-match"];
    if (opts.editBetween) e.etag = nextEtag();
    if (ifMatch !== undefined && ifMatch !== e.etag) return gError(res, 412, "conditionNotMet", "Precondition Failed");
    if (req.method === "DELETE") {
      events.delete(id!);
      deleted.add(id!);
      return void res.writeHead(204).end();
    }
    if (req.method === "PATCH") {
      const patch = JSON.parse(body) as RecordedEvent & { attendeesOmitted?: boolean };
      const next: RecordedEvent = { ...e };
      for (const [k, v] of Object.entries(patch)) {
        if (k === "attendees" || k === "attendeesOmitted") continue;
        next[k] = v;
      }
      if (Array.isArray(patch.attendees)) {
        if (patch.attendeesOmitted === true) {
          // Google: with attendeesOmitted, only the attendees named change
          const list = [...((e.attendees as Array<Record<string, unknown>>) ?? [])].map((a) => ({ ...a }));
          for (const p of patch.attendees as Array<Record<string, unknown>>) {
            const hit = list.find((a) => a.email === p.email);
            if (hit) Object.assign(hit, p);
          }
          next.attendees = list;
        } else next.attendees = patch.attendees;
      }
      next.etag = nextEtag();
      events.set(id!, next);
      return json(res, 200, next);
    }
    return gError(res, 405, "methodNotAllowed", "Method Not Allowed");
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const local = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const toAuth = auth.routeTo();

  const routeTo = (fallback: typeof fetch = fetch): typeof fetch =>
    (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const u = input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
      if (u.startsWith(`${GOOGLE_AUTHORIZE}?`)) return toAuth(`${AUTH_ORIGIN}/authorize${u.slice(GOOGLE_AUTHORIZE.length)}`, init);
      if (u === GOOGLE_TOKEN) return toAuth(`${AUTH_ORIGIN}/token`, init);
      if (u.startsWith(`${GOOGLE_API}/`)) return fetch(local + u.slice(GOOGLE_API.length), init);
      return fallback(input, init);
    }) as typeof fetch;

  return {
    auth,
    api,
    events,
    routeTo,
    async browse(authorizationUrl) {
      const first = await routeTo()(authorizationUrl, { redirect: "manual" });
      const loc = first.headers.get("location");
      if (!loc) throw new Error(`the authorize endpoint answered ${first.status} with no redirect`);
      const res = await fetch(loc);
      await res.text();
      return res.status;
    },
    async close() {
      await auth.close();
      await new Promise<void>((r) => http.close(() => r()));
    },
  };
}
