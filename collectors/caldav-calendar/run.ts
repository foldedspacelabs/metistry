// caldav-calendar: a CalDAV account into `calendar_events` (design-build-plan
// §2.6, §2.9; ticket T4-13). The third calendar source, built on the first
// two: the eventkit sync's row, window and one-statement replacement
// (`replaceCalendarWindow`), and the ICS provider's expansion — so Today
// reads one table and never asks which calendar a meeting came from.
//
// What it writes, and what it will not:
//
//  * **One row per occurrence**, keyed `(<connection>, event_id)` — the key
//    the ICS sync and EventKit's bridge spell: the UID for a one-off, the UID
//    plus the ORIGINAL start for a series' occurrence.
//  * **The owner's own answer.** Unlike a feed, a CalDAV server says who the
//    owner is (`calendar-user-address-set`), so the owner's attendee is
//    marked `self` and their PARTSTAT is `self_status` — what an invitation
//    request (T4-17) reads.
//  * **The window, and only the window**: the owner's midnight today
//    (`METISTRY_TZ`, else UTC) for SYNC_DAYS days; an event inside it the
//    server no longer gives goes, a row outside it stays as last seen.
//  * **Never the invite body.** `ics.ts` never reads DESCRIPTION; `toRow`
//    builds from named fields; `calendar_events` has no column for one.
//
// **What it may reach** is decided by `packages/connections`, not here: the
// opener gives a `fetch` pinned to the connection's own origin, through the
// egress door, following no redirect, with the app password filled there as
// Basic sign-in (`openSyncHttp`). A server that keeps the calendars on
// another origin (iCloud's numbered hosts) fails the run naming that host —
// nothing is sent to it.
//
// Degrades absent: no opener, or no CalDAV connection yet, is 0 rows and no
// error. A connection that is there but cannot be read fails the run with
// the reason, and the table keeps what it had.

import { CALDAV_MODULE, CALDAV_SYNC, knownZone, readCaldav, type SyncOpener } from "@foldedspacelabs/metistry-connections";
import type { Db } from "../github-state/run.js";
import { replaceCalendarWindow, saveSyncState, toRow, type CalendarRow } from "../eventkit-calendar/run.js";
import { SYNC_DAYS, syncWindow } from "../ics-calendar/run.js";
import { INVITATION_RULE, RSVP_CAPABILITY, reconcileInvitations } from "../invitations.js";

export { SYNC_DAYS };

/** apps/reconciler/src/notes.ts `EVENT_ID_MAX`: an id the walk would refuse is one this sync does not write. */
const EVENT_ID_MAX = 1024; // limit: fixed — longer than any calendar's UID plus its occurrence

export interface CaldavCtx {
  /** the console's opener (`instanceSyncOpener`); absent = no instance to read a connection from */
  openSync?: SyncOpener | undefined;
  /** the owner's IANA zone (`METISTRY_TZ`); absent or unknown = UTC */
  ownerTimeZone?: string | undefined;
  /** the clock (a test's) */
  now?: () => number;
  /** the runner's resolved Needs You switches (`syncs.caldav-calendar.raise`); absent = the manifest's defaults */
  raise?: Readonly<Record<string, boolean>> | undefined;
}

/** This collector's name — the `source_agent` of every invitation it raises. */
export const COMPONENT = "caldav-calendar";
/** The manifest's `needs_you` defaults (a test holds this to manifest.yaml). */
export const RAISE_DEFAULTS: Readonly<Record<typeof INVITATION_RULE, boolean>> = { invitation: true };

/** One pass. Returns rows inserted, changed or removed. */
export async function run(db: Db, ctx: CaldavCtx = {}): Promise<number> {
  if (!ctx.openSync) return 0; // degrades absent
  const opened = await ctx.openSync({ sync: CALDAV_SYNC, module: CALDAV_MODULE }); // no origin: a CalDAV server lives anywhere, and is pinned to its own
  if (!opened.ok) {
    if (opened.status === "absent") return 0;
    throw new Error(`caldav-calendar: ${opened.why}`);
  }
  const sync = opened.sync;
  const zone = ctx.ownerTimeZone && knownZone(ctx.ownerTimeZone) ? ctx.ownerTimeZone : "UTC";
  const now = (ctx.now ?? Date.now)();
  const window = syncWindow(now, zone);

  const read = await readCaldav(sync, { windowStart: window.start, windowEnd: window.end, ownerZone: zone });
  const rows: CalendarRow[] = [];
  const seen = new Set<string>();
  let unreadable = read.skipped.unreadable;
  for (const e of read.events) {
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
    calendars: String(read.calendars),
    resources: String(read.resources),
    scheduling: String(read.account.scheduling),
    skipped_rules: String(read.skipped.unsupported_rule),
    unreadable: String(unreadable),
    unknown_zones: read.skipped.unknown_zones.join(","),
  });
  // invitations (T4-17): the owner's NEEDS-ACTION, as this server says it — raised once per meeting, cleared when it changes
  const raise = ctx.raise && Object.hasOwn(ctx.raise, INVITATION_RULE) ? ctx.raise[INVITATION_RULE] === true : RAISE_DEFAULTS.invitation;
  const asked = await reconcileInvitations(db, { component: COMPONENT, connection: sync.connection, raise, rsvp: sync.capabilities.includes(RSVP_CAPABILITY), zone, now });
  return changed + asked.raised + asked.cleared;
}
