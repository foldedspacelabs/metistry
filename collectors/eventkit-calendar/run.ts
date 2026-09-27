// eventkit-calendar: the owner's calendars on this Mac into `calendar_events`
// (design-build-plan §2.9, §2.10; ticket T2-11). Every calendar source syncs
// into that one table under its own `connection`, so Today reads one table;
// this is the first source, reading the eventkit bridge's `GET /events`.
//
// What it writes, and what it will not:
//
//  * **One row per occurrence**, keyed `(eventkit, event_id)` — the bridge's
//    occurrence key (packages/mcp-eventkit `eventKey`). Attendee and
//    organizer addresses are normalised exactly as `people_emails` stores
//    them (trimmed, `mailto:` dropped, lowercased, and dropped when not
//    plainly an address), so `day_events` joins an attendee to a person page
//    on equality and never on a guess.
//  * **The window, and only the window.** The bridge says which span it read
//    (`window`: local midnight today for SYNC_DAYS days). A row whose start is
//    inside it and which the read did not return was cancelled or moved out,
//    and goes; a row outside it — a past meeting — stays as last seen, so
//    "last time" survives the day moving on. An older helper sends no window,
//    and then nothing is written: without the span, "missing" cannot be told
//    from "not asked about", and deleting on that guess would empty the day.
//  * **Never the invite body.** The bridge neither asks the helper for it
//    nor serves it (packages/mcp-eventkit/src/events.ts), and
//    `calendar_events` has no column for it (0034). `toRow` builds the row
//    from named fields only, so a body a future bridge sent would still stop
//    here.
//  * **One statement.** The upsert and the removal run as one SQL statement
//    (data-modifying CTEs), so a reader never sees the window half-replaced —
//    the `Db` handed to a collector is a pool, where BEGIN/COMMIT would land
//    on different connections.
//
// Degrades absent (docs/ops/automation.md): no bridge URL or token → 0, an
// `ok` run, nothing written. A bridge that answers badly is a failed run,
// which the runner records and alerts on; the table keeps what it had.

import type { Db } from "../github-state/run.js";

/** The `connection` every row this sync writes carries — the bridge's name (manifest.yaml), until the eventkit bridge becomes a connection of its own (§2.6). */
export const EVENTKIT_CONNECTION = "eventkit";

/** How far ahead a pass reads: today and the next two weeks — Today, Next Up and tomorrow's plan all fall inside it. */
export const SYNC_DAYS = 14; // limit: fixed — the bridge caps a read at 31 days; two weeks is what the views show

const TIMEOUT_MS = 30_000; // limit: fixed — a local EventKit read; past this the helper is wedged, and the run says so

/** A participant's answer, as calendar_events' CHECK spells them (0034). */
const STATUSES: ReadonlySet<string> = new Set(["unknown", "pending", "accepted", "declined", "tentative", "delegated", "completed", "in_process"]);

export interface EventkitCtx {
  ekUrl?: string;
  ekToken?: string;
  fetchFn?: typeof fetch;
}

interface BridgeParticipant {
  name?: unknown;
  email?: unknown;
  status?: unknown;
  role?: unknown;
  type?: unknown;
  self?: unknown;
}

interface BridgeEvent {
  event_id?: unknown;
  ical_uid?: unknown;
  series_id?: unknown;
  title?: unknown;
  start?: unknown;
  end?: unknown;
  all_day?: unknown;
  location?: unknown;
  participants?: unknown;
  organizer?: unknown;
  self_status?: unknown;
}

/** One `calendar_events` row, as the statement below reads it. Named fields only — nothing is spread from the bridge's object. */
export interface CalendarRow {
  event_id: string;
  ical_uid: string | null;
  series_id: string | null;
  starts_at: string;
  ends_at: string;
  all_day: boolean;
  title: string;
  location: string | null;
  organizer: string | null;
  attendees: { name: string | null; email: string | null; status: string; role: string; type: string; self: boolean }[];
  self_status: string | null;
}

/** RFC 5321's path limit; nothing longer is a deliverable address. */
const EMAIL_MAX = 254; // limit: fixed — the protocol's own ceiling
/** apps/reconciler/src/notes.ts `EMAIL_RE`, verbatim: the two must agree, or an attendee and the page naming them never meet. */
const EMAIL_RE = /^[^\s@<>()[\]{},;:"'\\]+@[^\s@<>()[\]{},;:"'\\.]+(?:\.[^\s@<>()[\]{},;:"'\\.]+)+$/;

/**
 * An address as `people_emails` stores it (apps/reconciler/src/notes.ts
 * `normaliseEmail`, the walk's side of the same join): trimmed, a `mailto:`
 * dropped, lowercased; null when it is not plainly an address.
 */
export function normaliseEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().replace(/^mailto:/i, "").toLowerCase();
  if (email.length === 0 || email.length > EMAIL_MAX) return null;
  return EMAIL_RE.test(email) ? email : null;
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const instant = (v: unknown): string | null => {
  if (typeof v !== "string" || v === "") return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};

/** The bridge's event → a row, or null for one that cannot be stored (no key, no readable times). */
export function toRow(e: BridgeEvent): CalendarRow | null {
  const eventId = str(e.event_id);
  const starts = instant(e.start);
  const ends = instant(e.end);
  if (eventId === null || starts === null || ends === null) return null;
  const participants = Array.isArray(e.participants) ? (e.participants as BridgeParticipant[]) : [];
  const organizer = e.organizer && typeof e.organizer === "object" ? (e.organizer as BridgeParticipant) : null;
  const status = str(e.self_status);
  return {
    event_id: eventId,
    ical_uid: str(e.ical_uid),
    series_id: str(e.series_id),
    starts_at: starts,
    ends_at: ends,
    all_day: e.all_day === true,
    title: typeof e.title === "string" ? e.title : "",
    location: str(e.location),
    organizer: organizer ? normaliseEmail(organizer.email) : null,
    attendees: participants.map((p) => ({
      name: str(p.name),
      email: normaliseEmail(p.email),
      status: typeof p.status === "string" && STATUSES.has(p.status) ? p.status : "unknown",
      role: str(p.role) ?? "unknown",
      type: str(p.type) ?? "unknown",
      self: p.self === true,
    })),
    self_status: status !== null && STATUSES.has(status) ? status : null,
  };
}

/**
 * The window's rows in, whatever is gone from it out, in ONE statement.
 * `upserted` counts rows inserted or changed — an update whose every field
 * is what the row already holds is skipped, so `updated_at` means "the
 * calendar changed this", and a quiet pass reports 0.
 */
const REPLACE_WINDOW = `
WITH incoming AS (
  SELECT * FROM jsonb_to_recordset($2::jsonb) AS x(
    event_id text, ical_uid text, series_id text, starts_at timestamptz, ends_at timestamptz,
    all_day boolean, title text, location text, organizer text, attendees jsonb, self_status text)
), upserted AS (
  INSERT INTO calendar_events AS c (connection, event_id, ical_uid, series_id, starts_at, ends_at, all_day, title, location, organizer, attendees, self_status, updated_at)
  SELECT $1, event_id, ical_uid, series_id, starts_at, ends_at, all_day, title, location, organizer, attendees, self_status, now() FROM incoming
  ON CONFLICT (connection, event_id) DO UPDATE SET
    ical_uid = EXCLUDED.ical_uid, series_id = EXCLUDED.series_id, starts_at = EXCLUDED.starts_at, ends_at = EXCLUDED.ends_at,
    all_day = EXCLUDED.all_day, title = EXCLUDED.title, location = EXCLUDED.location, organizer = EXCLUDED.organizer,
    attendees = EXCLUDED.attendees, self_status = EXCLUDED.self_status, updated_at = now()
  WHERE (c.ical_uid, c.series_id, c.starts_at, c.ends_at, c.all_day, c.title, c.location, c.organizer, c.attendees, c.self_status)
        IS DISTINCT FROM
        (EXCLUDED.ical_uid, EXCLUDED.series_id, EXCLUDED.starts_at, EXCLUDED.ends_at, EXCLUDED.all_day, EXCLUDED.title, EXCLUDED.location, EXCLUDED.organizer, EXCLUDED.attendees, EXCLUDED.self_status)
  RETURNING 1
), removed AS (
  DELETE FROM calendar_events c
   WHERE c.connection = $1
     AND c.starts_at >= $3::timestamptz AND c.starts_at < $4::timestamptz
     AND NOT EXISTS (SELECT 1 FROM incoming i WHERE i.event_id = c.event_id)
  RETURNING 1
)
SELECT (SELECT count(*) FROM upserted)::int AS upserted, (SELECT count(*) FROM removed)::int AS removed`;

const SAVE_STATE = `
INSERT INTO sync_state (connection, key, value, updated_at)
SELECT $1, k, v, now() FROM unnest($2::text[], $3::text[]) AS s(k, v)
ON CONFLICT (connection, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;

export async function run(db: Db, ctx: EventkitCtx = {}): Promise<number> {
  if (!ctx.ekUrl || !ctx.ekToken) return 0; // degrades absent
  const base = ctx.ekUrl.replace(/\/+$/, "");
  const res = await (ctx.fetchFn ?? fetch)(`${base}/events?days=${SYNC_DAYS}`, {
    headers: { authorization: `Bearer ${ctx.ekToken}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`eventkit bridge answered GET /events with ${res.status}`);
  const body = (await res.json()) as { events?: unknown; window?: { start?: unknown; end?: unknown } };
  const start = instant(body.window?.start);
  const end = instant(body.window?.end);
  if (start === null || end === null) {
    throw new Error(
      "the eventkit bridge sent no window — its helper predates the calendar sync (T2-11). Rebuild it (pnpm --filter @foldedspacelabs/metistry-mcp-eventkit build:helper), restart the calendar service, and re-grant Calendar if macOS asks",
    );
  }
  const rows: CalendarRow[] = [];
  const seen = new Set<string>();
  for (const e of Array.isArray(body.events) ? (body.events as BridgeEvent[]) : []) {
    const row = toRow(e);
    // A key read twice in one pass is one occurrence reported twice (a shared
    // calendar and an invitation to the same meeting): the first stands.
    if (row === null || seen.has(row.event_id)) continue;
    seen.add(row.event_id);
    rows.push(row);
  }
  const { rows: out } = await db.query(REPLACE_WINDOW, [EVENTKIT_CONNECTION, JSON.stringify(rows), start, end]);
  const changed = Number(out[0]?.upserted ?? 0) + Number(out[0]?.removed ?? 0);
  await db.query(SAVE_STATE, [EVENTKIT_CONNECTION, ["window_start", "window_end", "events"], [start, end, String(rows.length)]]);
  return changed;
}
