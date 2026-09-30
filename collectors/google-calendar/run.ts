// google-calendar: the owner's primary Google calendar into `calendar_events`
// (design-build-plan §2.6, §2.9; ticket T4-14). The fourth calendar source,
// built on the others: the eventkit sync's row, window and one-statement
// replacement (`replaceCalendarWindow`), the ICS sync's window — so Today
// reads one table and never asks which calendar a meeting came from.
//
// What it writes, and what it will not:
//
//  * **One row per occurrence**, keyed `(<connection>, event_id)` — Google's
//    own id for it: the event's id for a one-off, the occurrence's id
//    (`<series>_<original start>`) for a series, as `singleEvents` gives it.
//  * **The owner's own answer.** Google marks the owner's attendee (`self`),
//    so `self_status` is the owner's answer — what an invitation request
//    (T4-17) reads.
//  * **The window, and only the window**: the owner's midnight today
//    (`METISTRY_TZ`, else UTC) for SYNC_DAYS days; an event inside it Google
//    no longer lists goes, a row outside it stays as last seen.
//  * **Never the description.** `google-calendar.ts` asks Google for named
//    fields only and builds from named fields; `calendar_events` has no
//    column for one.
//
// **What it may reach** is decided by `packages/connections`, not here: the
// opener gives a `fetch` pinned to https://www.googleapis.com, through the
// egress door, following no redirect, with an access token minted from the
// owner's sign-in (the refresh token delivered as the connection's token
// secret) and filled there — and it refuses to open at all unless that
// secret is sent to exactly the token endpoint and the Calendar API
// (`GOOGLE_TOKEN_HOSTS`).
//
// Degrades absent: no opener, or no Google Calendar connection yet, is 0
// rows and no error. A connection that is there but cannot be read — not
// signed in, a revoked sign-in — fails the run with the reason, and the
// table keeps what it had.

import { GOOGLE_CALENDAR_MODULE, GOOGLE_CALENDAR_ORIGIN, GOOGLE_CALENDAR_SYNC, GOOGLE_TOKEN_HOSTS, knownZone, readGoogleCalendar, type SyncOpener } from "@foldedspacelabs/metistry-connections";
import type { Db } from "../github-state/run.js";
import { replaceCalendarWindow, saveSyncState, toRow, type CalendarRow } from "../eventkit-calendar/run.js";
import { SYNC_DAYS, syncWindow } from "../ics-calendar/run.js";
import { INVITATION_RULE, RSVP_CAPABILITY, reconcileInvitations } from "../invitations.js";

export { SYNC_DAYS };

/** apps/reconciler/src/notes.ts `EVENT_ID_MAX`: an id the walk would refuse is one this sync does not write. */
const EVENT_ID_MAX = 1024; // limit: fixed — longer than any Google event id plus its occurrence

/** This collector's name — the `source_agent` of every invitation it raises. */
export const COMPONENT = "google-calendar";
/** The manifest's `needs_you` defaults (a test holds this to manifest.yaml). */
export const RAISE_DEFAULTS: Readonly<Record<typeof INVITATION_RULE, boolean>> = { invitation: true };

export interface GoogleCalendarCtx {
  /** the console's opener (`instanceSyncOpener`); absent = no instance to read a connection from */
  openSync?: SyncOpener | undefined;
  /** the owner's IANA zone (`METISTRY_TZ`); absent or unknown = UTC */
  ownerTimeZone?: string | undefined;
  /** the clock (a test's) */
  now?: () => number;
  /** the runner's resolved Needs You switches (`syncs.google-calendar.raise`); absent = the manifest's defaults */
  raise?: Readonly<Record<string, boolean>> | undefined;
}

/** One pass. Returns rows inserted, changed or removed. */
export async function run(db: Db, ctx: GoogleCalendarCtx = {}): Promise<number> {
  if (!ctx.openSync) return 0; // degrades absent
  const opened = await ctx.openSync({ sync: GOOGLE_CALENDAR_SYNC, origin: GOOGLE_CALENDAR_ORIGIN, module: GOOGLE_CALENDAR_MODULE, tokenHosts: GOOGLE_TOKEN_HOSTS });
  if (!opened.ok) {
    if (opened.status === "absent") return 0;
    throw new Error(`google-calendar: ${opened.why}`);
  }
  const sync = opened.sync;
  const zone = ctx.ownerTimeZone && knownZone(ctx.ownerTimeZone) ? ctx.ownerTimeZone : "UTC";
  const now = (ctx.now ?? Date.now)();
  const window = syncWindow(now, zone);

  const read = await readGoogleCalendar(sync, { windowStart: window.start, windowEnd: window.end, ownerZone: zone });
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
    pages: String(read.pages),
    cancelled: String(read.skipped.cancelled),
    working_location: String(read.skipped.working_location),
    unreadable: String(unreadable),
  });
  // invitations (T4-17): the owner's needs-action, as Google says it — raised once per meeting, cleared when it changes
  const raise = ctx.raise && Object.hasOwn(ctx.raise, INVITATION_RULE) ? ctx.raise[INVITATION_RULE] === true : RAISE_DEFAULTS.invitation;
  const asked = await reconcileInvitations(db, { component: COMPONENT, connection: sync.connection, raise, rsvp: sync.capabilities.includes(RSVP_CAPABILITY), zone, now });
  return changed + asked.raised + asked.cleared;
}
