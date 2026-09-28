// A local CalDAV fixture server for the CalDAV provider's tests (T4-13): a
// real HTTP server on 127.0.0.1 and an ephemeral port — never a real CalDAV
// service — speaking the subset `caldav.ts` uses: PROPFIND (principal, home,
// calendars), REPORT calendar-query (a time range, or a UID text-match —
// a substring match, as RFC 4791 has it), GET, PUT and DELETE with ETags and
// their preconditions, and Basic sign-in. As an RFC 6638 server it records
// the iTIP REPLY it would deliver when an attendee's PARTSTAT changes.
//
// The calendars and events are fixtures written from RFC 5545/6638 in the
// shapes iCloud and Fastmail serve — not captured from a real account.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface Stored {
  data: string;
  etag: string;
}

export interface FakeRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface FakeCaldavOptions {
  username: string;
  password: string;
  /** the owner's calendar user addresses, as the principal lists them */
  addresses?: string[];
  /** a schedule outbox and `calendar-auto-schedule` (RFC 6638); default true */
  scheduling?: boolean;
  /** the calendar home, absolute, on another origin (iCloud's numbered hosts) */
  homeOrigin?: string;
  /** answer every request with a redirect here */
  redirectTo?: string;
  /** wrap calendar-data in CDATA rather than escaping it */
  cdata?: boolean;
  /** refuse every PUT as RFC 6638 refuses an attendee change it does not allow (403) */
  forbidWrites?: boolean;
  /** resources: path under the work calendar → text */
  events?: Record<string, string>;
}

export interface FakeCaldav {
  origin: string;
  host: string;
  url: string;
  requests: FakeRequest[];
  resources: Map<string, Stored>;
  /** the iTIP REPLYs an RFC 6638 server would have delivered */
  replies: { uid: string; partstat: string; to: string | null }[];
  /** change a stored event behind the client's back (a new ETag) */
  touch(path: string, data?: string): void;
  close(): Promise<void>;
}

export const HOME = "/calendars/me/";
export const WORK = `${HOME}work/`;
export const TASKS = `${HOME}tasks/`;
export const PRINCIPAL = "/principals/me/";

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function ms(responses: string[]): string {
  return `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/">${responses.join("")}</D:multistatus>`;
}

function resp(href: string, props: string, missing = ""): string {
  const ok = `<D:propstat><D:prop>${props}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>`;
  const nf = missing ? `<D:propstat><D:prop>${missing}</D:prop><D:status>HTTP/1.1 404 Not Found</D:status></D:propstat>` : "";
  return `<D:response><D:href>${esc(href)}</D:href>${ok}${nf}</D:response>`;
}

/** The PARTSTAT of `address`'s ATTENDEE line in each VEVENT (VALARMs skipped), for the reply log. */
function partstats(text: string, address: string): string[] {
  const unfolded = text.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "");
  const out: string[] = [];
  let depth = 0;
  for (const line of unfolded.split(/\r?\n/)) {
    if (/^BEGIN:/i.test(line)) depth++;
    else if (/^END:/i.test(line)) depth--;
    else if (depth === 2 && /^ATTENDEE[;:]/i.test(line) && line.toLowerCase().endsWith(`:mailto:${address}`)) out.push(/PARTSTAT=([A-Z-]+)/i.exec(line)?.[1] ?? "NEEDS-ACTION");
  }
  return out;
}

export async function fakeCaldav(opts: FakeCaldavOptions): Promise<FakeCaldav> {
  const requests: FakeRequest[] = [];
  const replies: FakeCaldav["replies"] = [];
  const resources = new Map<string, Stored>();
  let n = 0;
  const etag = () => `"etag-${++n}"`;
  for (const [name, data] of Object.entries(opts.events ?? {})) resources.set(`${WORK}${name}`, { data, etag: etag() });
  const scheduling = opts.scheduling ?? true;
  const addresses = opts.addresses ?? ["mailto:me@example.com"];
  const expected = `Basic ${Buffer.from(`${opts.username}:${opts.password}`).toString("base64")}`;
  let origin = "";

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    const path = decodeURIComponent((req.url ?? "/").split("?")[0]!);
    requests.push({ method: req.method ?? "", path, headers: { ...req.headers }, body });
    const send = (status: number, text = "", headers: Record<string, string> = {}) => {
      res.writeHead(status, { ...(text ? { "content-type": "application/xml; charset=utf-8" } : {}), ...headers }).end(text);
    };
    if (opts.redirectTo) return send(307, "", { location: opts.redirectTo });
    if (req.headers.authorization !== expected) return send(401, "", { "www-authenticate": 'Basic realm="fake"' });
    const dav = scheduling ? "1, 3, access-control, calendar-access, calendar-auto-schedule" : "1, 3, access-control, calendar-access";

    if (req.method === "PROPFIND") {
      if (path === PRINCIPAL) {
        const home = opts.homeOrigin ? `${opts.homeOrigin}${HOME}` : HOME;
        const addrs = addresses.map((a) => `<D:href>${esc(a)}</D:href>`).join("");
        return send(
          207,
          ms([resp(PRINCIPAL, `<C:calendar-home-set><D:href>${esc(home)}</D:href></C:calendar-home-set><C:calendar-user-address-set>${addrs}</C:calendar-user-address-set>${scheduling ? `<C:schedule-outbox-URL><D:href>${PRINCIPAL}outbox/</D:href></C:schedule-outbox-URL>` : ""}`, scheduling ? "" : "<C:schedule-outbox-URL/>")]),
          { dav },
        );
      }
      if (path === HOME) {
        if (req.headers.depth !== "1") return send(207, ms([resp(HOME, "<D:resourcetype><D:collection/></D:resourcetype>")]));
        return send(
          207,
          ms([
            resp(HOME, "<D:resourcetype><D:collection/></D:resourcetype>"),
            resp(WORK, `<D:resourcetype><D:collection/><C:calendar/></D:resourcetype><D:displayname>Work</D:displayname><C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>`),
            resp(TASKS, `<D:resourcetype><D:collection/><C:calendar/></D:resourcetype><D:displayname>Tasks</D:displayname><C:supported-calendar-component-set><C:comp name="VTODO"/></C:supported-calendar-component-set>`),
            resp(`${HOME}inbox/`, "<D:resourcetype><D:collection/><C:schedule-inbox/></D:resourcetype>"),
          ]),
        );
      }
      // anything else: the root answers with the principal (RFC 5397)
      return send(207, ms([resp(path, `<D:current-user-principal><D:href>${PRINCIPAL}</D:href></D:current-user-principal>`)]), { dav });
    }

    if (req.method === "REPORT") {
      if (path !== WORK && path !== TASKS) return send(404);
      const uid = /<c:text-match[^>]*>([^<]*)<\/c:text-match>/.exec(body)?.[1]?.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
      const rows: string[] = [];
      for (const [href, r] of resources) {
        if (!href.startsWith(path)) continue;
        if (uid !== undefined && !r.data.includes(uid)) continue;
        const data = opts.cdata ? `<![CDATA[${r.data}]]>` : esc(r.data);
        rows.push(resp(href, `<D:getetag>${esc(r.etag)}</D:getetag><C:calendar-data>${data}</C:calendar-data>`));
      }
      return send(207, ms(rows));
    }

    const r = resources.get(path);
    if (req.method === "GET") {
      if (!r) return send(404);
      res.writeHead(200, { "content-type": "text/calendar; charset=utf-8", etag: r.etag }).end(r.data);
      return;
    }
    if (req.method === "PUT" && opts.forbidWrites) {
      return send(403, `<?xml version="1.0"?><D:error xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><C:allowed-attendee-scheduling-object-change/></D:error>`);
    }
    if (req.method === "PUT") {
      const ifMatch = req.headers["if-match"];
      const ifNone = req.headers["if-none-match"];
      if (ifNone === "*" && r) return send(412);
      if (ifMatch !== undefined && (!r || r.etag !== ifMatch)) return send(412);
      if (scheduling && r) {
        for (const a of addresses) {
          const addr = a.replace(/^mailto:/i, "").toLowerCase();
          const before = partstats(r.data, addr);
          const after = partstats(body, addr);
          if (after.length > 0 && after.join() !== before.join()) {
            const org = /\nORGANIZER[^\n]*mailto:([^\s\r\n]+)/i.exec(r.data.replace(/\r\n[ \t]/g, ""))?.[1] ?? null;
            replies.push({ uid: /\nUID:([^\r\n]+)/.exec(body)?.[1] ?? "", partstat: after.join(","), to: org });
          }
        }
      }
      const tag = etag();
      resources.set(path, { data: body, etag: tag });
      return send(r ? 204 : 201, "", { etag: tag });
    }
    if (req.method === "DELETE") {
      if (!r) return send(404);
      if (req.headers["if-match"] !== undefined && req.headers["if-match"] !== r.etag) return send(412);
      resources.delete(path);
      return send(204);
    }
    return send(405);
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as AddressInfo).port;
  origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    host: `127.0.0.1:${port}`,
    url: `${origin}/`,
    requests,
    resources,
    replies,
    touch(path, data) {
      const r = resources.get(path);
      if (r) resources.set(path, { data: data ?? r.data, etag: etag() });
    },
    close: () => new Promise<void>((ok) => server.close(() => ok())),
  };
}
