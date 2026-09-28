// ics-calendar: an iCalendar feed into `calendar_events` (design-build-plan
// §2.6, §2.9; ticket T4-12). The second calendar source after the eventkit
// sync (`collectors/eventkit-calendar`, T2-11), and built on it: the same
// table, the same row, the same window and the same one-statement
// replacement (`replaceCalendarWindow`), so Today reads one table and never
// asks which calendar a meeting came from.
//
// What it writes, and what it will not:
//
//  * **One row per occurrence**, keyed `(<connection>, event_id)` — the
//    connection's own name, and the key EventKit's bridge spells for an
//    occurrence: the UID for a one-off, the UID plus the ORIGINAL start for
//    a series' occurrence (packages/connections `ics.ts`), so a moved
//    occurrence keeps its meeting note. The row is built by the eventkit
//    sync's `toRow`, so an attendee's address is normalised exactly as
//    `people_emails` stores it, and nothing but named fields reach it.
//  * **The window, and only the window**: the owner's midnight today
//    (`METISTRY_TZ`, else UTC) for SYNC_DAYS days. A feed is a whole
//    snapshot, so an event whose start is inside the window and which the
//    feed no longer gives — cancelled, deleted, moved out — goes; a row
//    outside the window stays as last seen, so "last time" survives.
//  * **Never the invite body.** `ics.ts` never reads DESCRIPTION; `toRow`
//    builds from named fields; `calendar_events` has no column for one.
//  * **Nothing the feed did not say.** A series whose rule `ics.ts` does
//    not expand is skipped and counted (`sync_state.skipped_rules`), a TZID
//    nobody defines is named (`sync_state.unknown_zones`) — never guessed
//    at silently. A feed does not say which attendee is the owner, so
//    `self_status` is null.
//
// **What it may reach** is decided by `packages/connections`, not here: the
// collector asks the console's opener for the connection the
// `ics-calendar` sync reads, and gets a `fetch` pinned to that connection's
// own origin, through the egress door, following no redirect
// (`openSyncHttp`). A feed address that carries a token never gets that far:
// the connection file refuses it (a key-shaped value), and a `{{ secret }}`
// in a URL is refused there and at the door (`secret_in_url`).
//
// Degrades absent: no opener (a console without an instance), or no ICS
// connection yet, is 0 rows and no error. A connection that is there but
// cannot be read (not https, an HTTP error, not a calendar, too large)
// fails the run with the reason, and the table keeps what it had.

import { ICS_MODULE, ICS_SYNC, icsOccurrences, knownZone, readIcsFeed, zonedMidnight, zonedToday, type SyncOpener } from "@foldedspacelabs/metistry-connections";
import type { Db } from "../github-state/run.js";
import { replaceCalendarWindow, saveSyncState, toRow, type CalendarRow } from "../eventkit-calendar/run.js";

/** How far ahead a pass reads — the eventkit sync's span, so every source covers the same days. */
export const SYNC_DAYS = 14; // limit: fixed — Today, Next Up and tomorrow's plan all fall inside two weeks

const DAY = 86_400_000;
/** apps/reconciler/src/notes.ts `EVENT_ID_MAX`: an id the walk would refuse is one this sync does not write. */
const EVENT_ID_MAX = 1024; // limit: fixed — longer than any calendar's UID plus its occurrence

export interface IcsCtx {
  /** the console's opener (`instanceSyncOpener`); absent = no instance to read a connection from */
  openSync?: SyncOpener | undefined;
  /** the owner's IANA zone (`METISTRY_TZ`); absent or unknown = UTC */
  ownerTimeZone?: string | undefined;
  /** the clock (a test's) */
  now?: () => number;
}

/** The window a pass reads: the owner's midnight today, for SYNC_DAYS days — as instants. */
export function syncWindow(now: number, zone: string): { start: number; end: number } {
  const today = zonedToday(now, zone);
  return { start: zonedMidnight(today, zone), end: zonedMidnight(today + SYNC_DAYS * DAY, zone) };
}

/** One pass. Returns rows inserted, changed or removed. */
export async function run(db: Db, ctx: IcsCtx = {}): Promise<number> {
  if (!ctx.openSync) return 0; // degrades absent
  const opened = await ctx.openSync({ sync: ICS_SYNC, module: ICS_MODULE }); // no origin: a feed lives anywhere, and is pinned to its own
  if (!opened.ok) {
    if (opened.status === "absent") return 0;
    throw new Error(`ics-calendar: ${opened.why}`);
  }
  const sync = opened.sync;
  const zone = ctx.ownerTimeZone && knownZone(ctx.ownerTimeZone) ? ctx.ownerTimeZone : "UTC";
  const window = syncWindow((ctx.now ?? Date.now)(), zone);

  const calendar = await readIcsFeed(sync);
  const { events, skipped } = icsOccurrences(calendar, { windowStart: window.start, windowEnd: window.end, ownerZone: zone });
  const rows: CalendarRow[] = [];
  const seen = new Set<string>();
  let unreadable = skipped.unreadable;
  for (const e of events) {
    const row = toRow(e);
    if (row === null || seen.has(row.event_id)) continue;
    // an id the meeting-note door would refuse (apps/console meeting-note-route `validEventId`) is not stored
    if (row.event_id.length > EVENT_ID_MAX || /[\u0000-\u001f\u007f]/.test(row.event_id) || row.event_id !== row.event_id.trim()) {
      unreadable++;
      continue;
    }
    seen.add(row.event_id);
    rows.push(row);
  }
  const start = new Date(window.start).toISOString();
  const end = new Date(window.end).toISOString();
  const changed = await replaceCalendarWindow(db, sync.connection, rows, start, end);
  await saveSyncState(db, sync.connection, {
    window_start: start,
    window_end: end,
    events: String(rows.length),
    skipped_rules: String(skipped.unsupported_rule),
    unreadable: String(unreadable),
    unknown_zones: skipped.unknown_zones.join(","),
  });
  return changed;
}
