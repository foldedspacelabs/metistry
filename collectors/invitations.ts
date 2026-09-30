// Invitation requests (design-build-plan §2.6, §2.12; ticket T4-17; R7,
// C108) — shared by every calendar sync that knows who the owner is.
//
// Every calendar source writes `calendar_events` (0034), each under its own
// `connection`, with the owner's attendee marked `self` and the owner's own
// answer in `self_status` where the source can say it: the eventkit sync (the
// Mac's calendars) and a CalDAV account (T4-13). An ICS feed cannot — it
// never says who the owner is — so it never raises one (R7: a sync raises a
// request only when the source names the owner).
//
// **Raised** (`reconcileInvitations`, run by each such sync after its window
// is written): an occurrence still to come whose owner's answer is
// NEEDS-ACTION (`self_status = 'pending'`), where the owner is an attendee
// and the organizer is someone else, raises ONE `invitation` mirror (core's
// `raiseMirror`) for the meeting — its iCalendar UID, so a series is one
// card and the same meeting on two calendars (the Mac's and the CalDAV
// account behind it) is one card with both askers on it (T4-23's
// `also_asked`). An answer anywhere wins: a meeting any source shows the
// owner answered is not raised, even while a slower source still says
// NEEDS-ACTION.
//
// **Cleared** (`resolveAtSource`, with a receipt): the source changed —
// the owner answered (in their calendar, or through the Respond door
// below), the meeting was cancelled or left the calendar, or it passed.
// A mirror its source cleared is raised again only if the source asks
// again (an organizer who moves a meeting resets the answer to
// NEEDS-ACTION); one the owner answered here is not.
//
// **Respond** — the owner's Accept · Maybe · Decline — goes through the
// connection that can: a calendar connection whose provider declares `rsvp`
// (CalDAV's `previewReply` / `respondToInvitation`, T4-13). Preview, then
// confirm against the event's ETag; exactly the owner's own attendee line
// changes, and the server delivers the reply. **Without an `rsvp`
// capability it is refused** (`no_rsvp`) before anything is sent, and the
// client offers *Open in Calendar* (Q9) — the Mac's own calendar cannot
// answer (EventKit's participant status is read-only). The confirm token
// and who may press it are the console door's
// (`apps/console/src/invitation-respond-route.ts`).
//
// Never the invite body: `calendar_events` has no column for it, and every
// payload here is built from named fields.

import { EgressRefused, RESOLVED_AT_SOURCE, lastMirror, raiseMirror, resolveAtSource, type RequestSource } from "@foldedspacelabs/metistry-core";
import {
  CALDAV_MODULE,
  CALDAV_SYNC,
  CaldavError,
  ConnectionRefused,
  RSVP_RESPONSES,
  envSecretSource,
  loadInstanceCatalog,
  openSyncHttp,
  previewReply,
  respondToInvitation,
  type CatalogRoots,
  type ReplyPreview,
  type RsvpResponse,
  type WriteResult,
} from "@foldedspacelabs/metistry-connections";
import type { Db } from "./github-state/run.js";

/** The stored request kind (§2.12's `invitation` row). */
export const INVITATION_KIND = "invitation";
/** `proposals.source.kind` of every invitation mirror: the source system, whichever calendar holds it. */
export const CALENDAR_SOURCE_KIND = "calendar";
/** `source.external_ref` of an invitation: this prefix, then `uid/<ical_uid>` — or `event/<connection>/<event_id>` for an event with no UID. */
export const INVITE_REF_PREFIX = "invite:";
/** `payload.event` — what raised the request. */
export const INVITED_EVENT = "invited";
/** The `needs_you` rule a calendar sync declares for it (`syncs.<sync>.raise.invitation`). */
export const INVITATION_RULE = "invitation";
/** The capability Respond needs (core's CONNECTION_CAPABILITIES.calendar). */
export const RSVP_CAPABILITY = "rsvp";

/** The owner's answers, as `calendar_events.self_status` spells them — an answer anywhere means no request. */
const ANSWERED = ["accepted", "declined", "tentative", "delegated"] as const;
const SUMMARY_MAX = 280; // limit: fixed — a card's preview is a line or two; the meeting itself is in the calendar

/** One `calendar_events` row, as this module reads it. */
interface EventRow {
  connection: string;
  event_id: string;
  ical_uid: string | null;
  series_id: string | null;
  title: string;
  starts_at: Date | string;
  ends_at: Date | string;
  all_day: boolean;
  location: string | null;
  organizer: string | null;
  attendees: unknown;
  self_status: string | null;
}

interface Attendee {
  name: string | null;
  email: string | null;
  self: boolean;
}

function attendeesOf(value: unknown): Attendee[] {
  if (!Array.isArray(value)) return [];
  return value.map((a) => {
    const o = (a ?? {}) as Record<string, unknown>;
    return { name: typeof o.name === "string" && o.name !== "" ? o.name : null, email: typeof o.email === "string" && o.email !== "" ? o.email : null, self: o.self === true };
  });
}

/** R7 and §2.12: the source names the owner as an attendee, and someone else organises it. */
function askedOfOwner(row: Pick<EventRow, "organizer" | "attendees">): boolean {
  if (!row.organizer) return false; // nobody to answer to
  const people = attendeesOf(row.attendees);
  const self = people.filter((a) => a.self);
  if (self.length === 0) return false; // the source does not say the owner is in it
  return !self.some((a) => a.email !== null && a.email === row.organizer);
}

const ms = (v: Date | string): number => (v instanceof Date ? v.getTime() : Date.parse(v));
const iso = (v: Date | string): string => new Date(ms(v)).toISOString();

/** The subject an event's invitation mirrors: the meeting, by its UID, whichever calendar holds it. */
export function invitationSource(row: Pick<EventRow, "connection" | "event_id" | "ical_uid" | "organizer">): RequestSource {
  const ref = row.ical_uid ? `${INVITE_REF_PREFIX}uid/${row.ical_uid}` : `${INVITE_REF_PREFIX}event/${row.connection}/${row.event_id}`;
  return { kind: CALENDAR_SOURCE_KIND, external_ref: ref, person: row.organizer };
}

/** The rows a subject names, read now — every calendar that holds the meeting. */
async function rowsOf(db: Db, ref: string): Promise<EventRow[]> {
  const body = ref.slice(INVITE_REF_PREFIX.length);
  const cols = `connection, event_id, ical_uid, series_id, title, starts_at, ends_at, all_day, location, organizer, attendees, self_status`;
  if (body.startsWith("uid/")) {
    return (await db.query(`SELECT ${cols} FROM calendar_events WHERE ical_uid = $1 ORDER BY starts_at, connection COLLATE "C", event_id COLLATE "C"`, [body.slice(4)])).rows as EventRow[];
  }
  if (body.startsWith("event/")) {
    const rest = body.slice(6);
    const slash = rest.indexOf("/");
    if (slash <= 0) return [];
    return (await db.query(`SELECT ${cols} FROM calendar_events WHERE connection = $1 AND event_id = $2`, [rest.slice(0, slash), rest.slice(slash + 1)])).rows as EventRow[];
  }
  return [];
}

/** Whether a subject still waits on the owner — and, when it does not, the receipt that says what happened at the source. */
export interface InvitationState {
  waiting: boolean;
  receipt: string;
  /** the rows still asking, earliest first */
  asking: EventRow[];
}

const ANSWER_RECEIPT: Readonly<Record<(typeof ANSWERED)[number], string>> = {
  accepted: "You accepted it in your calendar",
  declined: "You declined it in your calendar",
  tentative: "You said maybe in your calendar",
  delegated: "You delegated it in your calendar",
};

/** What the calendars say of one invitation now (module header). Pure over the rows. */
export function invitationState(rows: readonly EventRow[], now: number): InvitationState {
  if (rows.length === 0) return { waiting: false, receipt: "No longer on your calendar", asking: [] };
  const ahead = rows.filter((r) => ms(r.ends_at) > now);
  if (ahead.length === 0) return { waiting: false, receipt: "The meeting has passed", asking: [] };
  const answered = ahead.find((r) => (ANSWERED as readonly string[]).includes(r.self_status ?? ""));
  if (answered) return { waiting: false, receipt: ANSWER_RECEIPT[answered.self_status as (typeof ANSWERED)[number]], asking: [] };
  const asking = ahead.filter((r) => r.self_status === "pending" && askedOfOwner(r)).sort((a, b) => ms(a.starts_at) - ms(b.starts_at));
  if (asking.length > 0) return { waiting: true, receipt: "", asking };
  return { waiting: false, receipt: "No longer waiting on your answer", asking: [] };
}

/** `Tue 29 Sep, 14:00–15:00` in the owner's zone — or the date alone for an all-day event. Built from parts, so no locale's spelling moves it. */
function when(row: EventRow, zone: string): string {
  const parts = (t: number): Record<string, string> => {
    let f: Intl.DateTimeFormat;
    try {
      f = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    } catch {
      f = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    }
    return Object.fromEntries(f.formatToParts(new Date(t)).map((p) => [p.type, p.value]));
  };
  const a = parts(ms(row.starts_at));
  const b = parts(ms(row.ends_at));
  const day = `${a.weekday} ${a.day} ${a.month}`;
  return row.all_day ? `${day}, all day` : `${day}, ${a.hour}:${a.minute}–${b.hour}:${b.minute}`;
}

/** The request an invitation raises: what the card shows (§2.12's preview body) — named fields only, never the invite body. */
export function invitationPayload(row: EventRow, opts: { rows: number; rsvp: boolean; zone?: string | undefined }): Record<string, unknown> {
  const people = attendeesOf(row.attendees);
  const organizer = people.find((a) => a.email === row.organizer);
  const others = people.filter((a) => !a.self && a.email !== row.organizer).length;
  const by = organizer?.name ?? row.organizer ?? "Someone";
  const title = row.title.trim() === "" ? "(no title)" : row.title;
  const summary = [`${by} invites you: ${title}`, when(row, opts.zone ?? "UTC"), ...(row.location ? [row.location] : []), ...(others > 0 ? [`${others} other${others === 1 ? "" : "s"} invited`] : [])].join(" · ");
  return {
    title,
    summary: summary.length > SUMMARY_MAX ? `${summary.slice(0, SUMMARY_MAX - 1)}…` : summary,
    event: INVITED_EVENT,
    connection: row.connection,
    event_id: row.event_id,
    ical_uid: row.ical_uid,
    start: iso(row.starts_at),
    end: iso(row.ends_at),
    all_day: row.all_day,
    location: row.location,
    organizer: { name: organizer?.name ?? null, email: row.organizer },
    others,
    series: row.series_id !== null || opts.rows > 1,
    // a hint for the card: the connection that raised it can answer. The
    // Respond door decides — it looks for any connection holding the meeting
    // that can, and refuses (Open in Calendar) when none does
    rsvp: opts.rsvp,
  };
}

export interface ReconcileInvitations {
  /** the sync raising — the `source_agent` of what it raises */
  component: string;
  /** the `calendar_events.connection` it just wrote */
  connection: string;
  /** `syncs.<component>.raise.invitation`, resolved (the manifest's default: on) */
  raise: boolean;
  /** this connection's provider can answer an invitation */
  rsvp: boolean;
  /** the owner's zone, for the card's time */
  zone?: string | undefined;
  now: number;
}

/**
 * One pass over the invitations (module header): raise what this
 * connection's rows ask of the owner, and clear every waiting invitation
 * this connection raised or holds whose source has changed — whichever
 * calendar raised it; a meeting it has never held is another sync's to
 * settle. Returns how many it raised or cleared.
 */
export async function reconcileInvitations(db: Db, r: ReconcileInvitations): Promise<{ raised: number; cleared: number }> {
  let raised = 0;
  let cleared = 0;
  if (r.raise) {
    const { rows } = await db.query(
      `SELECT connection, event_id, ical_uid, series_id, title, starts_at, ends_at, all_day, location, organizer, attendees, self_status
       FROM calendar_events WHERE connection = $1 AND self_status = 'pending' AND ends_at > $2 AND organizer IS NOT NULL
       ORDER BY starts_at, event_id COLLATE "C"`,
      [r.connection, new Date(r.now).toISOString()],
    );
    const seen = new Set<string>();
    for (const row of rows as EventRow[]) {
      if (!askedOfOwner(row)) continue;
      const source = invitationSource(row);
      if (seen.has(source.external_ref)) continue; // one card per meeting: the earliest occurrence speaks for it
      seen.add(source.external_ref);
      const all = await rowsOf(db, source.external_ref);
      const state = invitationState(all, r.now);
      if (!state.waiting) continue; // answered on another calendar already
      const last = await lastMirror(db, source);
      if (last && last.decision !== "pending" && last.decision !== RESOLVED_AT_SOURCE) continue; // the owner answered it here
      const first = state.asking.find((a) => a.connection === r.connection) ?? row;
      const out = await raiseMirror(db, {
        kind: INVITATION_KIND,
        source_agent: r.component,
        trust: "external", // the words are the organizer's calendar's, not the owner's or the assistant's
        source,
        payload: invitationPayload(first, { rows: all.filter((a) => a.connection === r.connection).length, rsvp: r.rsvp, zone: r.zone }),
      });
      if (out.raised) raised++;
    }
  }
  // what waits — this connection's business only: raised from it, or a meeting it holds
  const waiting = await db.query(
    `SELECT source->>'external_ref' AS ref, bool_or(payload->>'connection' = $5) AS raised_here FROM proposals
     WHERE decision = 'pending' AND kind = $1 AND source->>'kind' = $2 AND left(source->>'external_ref', $3) = $4
     GROUP BY 1`,
    [INVITATION_KIND, CALENDAR_SOURCE_KIND, INVITE_REF_PREFIX.length, INVITE_REF_PREFIX, r.connection],
  );
  for (const { ref, raised_here } of waiting.rows as { ref: string; raised_here: boolean | null }[]) {
    const rows = await rowsOf(db, ref);
    if (raised_here !== true && !rows.some((x) => x.connection === r.connection)) continue; // another calendar's to settle
    const state = invitationState(rows, r.now);
    if (state.waiting) continue;
    cleared += (await resolveAtSource(db, { kind: CALENDAR_SOURCE_KIND, external_ref: ref }, state.receipt)).length;
  }
  return { raised, cleared };
}

// ---- Respond: Accept · Maybe · Decline, through the connection that can ------------------------

/** A calendar connection that can answer an invitation, opened by name. Names, never a value. */
export interface RsvpConnection {
  connection: string;
  provider: string;
  preview(req: { uid: string; response: RsvpResponse }): Promise<ReplyPreview>;
  respond(req: { uid: string; response: RsvpResponse; etag: string }): Promise<WriteResult>;
  secretsUsed(): string[];
}

export type OpenedRsvp = { ok: true; rsvp: RsvpConnection } | { ok: false; status: "absent" | "no_capability" | "failed"; why: string };

/** How the door opens a calendar connection by name: the console builds one (`calendarRsvpOpener`); a test hands in its own. */
export type RsvpOpener = (connection: string) => Promise<OpenedRsvp>;

/**
 * The console's opener: the instance's catalog afresh on every press, the
 * connection by NAME, and only when its provider declares `rsvp` — then
 * opened through the same door the CalDAV sync reads through (pinned to its
 * own origin, the app password filled at the egress door, no redirect
 * followed). Never dials. A connection that is not a file of the instance
 * (the Mac's own `eventkit` calendar) is absent: it cannot answer.
 */
export function calendarRsvpOpener(roots: CatalogRoots & { env: NodeJS.ProcessEnv; fetch?: typeof fetch | undefined }): RsvpOpener {
  const secrets = envSecretSource(roots.env);
  return async (connection) => {
    const catalog = await loadInstanceCatalog(roots);
    const entry = catalog.entries.find((e) => e.name === connection);
    if (!entry) return { ok: false, status: "absent", why: `${connection} is not a connection of this instance — it cannot answer an invitation` };
    if (entry.status !== "ok" || !entry.connection || !entry.provider) {
      return { ok: false, status: entry.status === "absent" ? "absent" : "failed", why: `connection ${connection} is ${entry.status}: ${entry.issues.join("; ") || "not ready"}` };
    }
    const m = entry.provider.manifest;
    if (m.provides !== "calendar" || !m.capabilities.includes(RSVP_CAPABILITY)) {
      return { ok: false, status: "no_capability", why: `connection ${connection}'s provider ${entry.provider.name} cannot answer an invitation (no ${RSVP_CAPABILITY} capability)` };
    }
    if (m.implementation.kind !== "builtin" || m.implementation.module !== CALDAV_MODULE) {
      return { ok: false, status: "no_capability", why: `connection ${connection}'s provider ${entry.provider.name} answers invitations through a module this console does not run` };
    }
    // `openSyncHttp` picks the connection a sync reads; naming this one for
    // the CalDAV sync (in a copy of scheduled.yaml that nothing writes)
    // opens exactly the connection named, with every check it applies
    const opened = openSyncHttp({
      catalog: { ...catalog, scheduled: { syncs: { [CALDAV_SYNC]: { connection } } } },
      sync: CALDAV_SYNC,
      module: CALDAV_MODULE,
      secrets,
      ...(roots.fetch ? { fetch: roots.fetch } : {}),
    });
    if (!opened.ok) return { ok: false, status: opened.status === "absent" ? "absent" : "failed", why: opened.why };
    const sync = opened.sync;
    return {
      ok: true,
      rsvp: {
        connection: sync.connection,
        provider: sync.provider,
        preview: (req) => previewReply(sync, req),
        respond: (req) => respondToInvitation(sync, req),
        secretsUsed: () => sync.secretsUsed(),
      },
    };
  };
}

/** Why Respond refused. Each a code path with a test (U3). */
export const RESPOND_REFUSAL_CODES = ["bad_request", "not_found", "no_rsvp", "not_invited", "no_scheduling", "changed", "connection_failed"] as const;
export type RespondRefusalCode = (typeof RESPOND_REFUSAL_CODES)[number];

export class RespondRefused extends Error {
  override readonly name = "RespondRefused";
  constructor(
    readonly code: RespondRefusalCode,
    message: string,
  ) {
    super(message);
  }
}

/** What a confirm must carry back — held by the door, never by the client. */
export interface RespondBinding {
  event_id: string;
  connection: string;
  uid: string;
  response: RsvpResponse;
  etag: string;
}

export interface RespondPreview {
  event_id: string;
  connection: string;
  title: string;
  response: RsvpResponse;
  /** the address the reply goes to */
  organizer: string | null;
  /** the owner's address it answers as */
  as: string;
  /** the owner already gave this answer: the confirm writes nothing */
  unchanged: boolean;
  /** true when the answer covers every occurrence of a series */
  series: boolean;
  binding: RespondBinding;
  secrets: string[];
}

const isResponse = (v: unknown): v is RsvpResponse => typeof v === "string" && (RSVP_RESPONSES as readonly string[]).includes(v);

function caldavRefusal(err: unknown): never {
  if (err instanceof CaldavError) {
    const code: RespondRefusalCode =
      err.code === "not_invited" ? "not_invited" : err.code === "no_scheduling" ? "no_scheduling" : err.code === "changed" ? "changed" : err.code === "not_found" ? "not_found" : "connection_failed";
    throw new RespondRefused(code, err.message);
  }
  // the door's own refusals — another host, a redirect, a secret it will not fill — name names and hosts, never a value
  if (err instanceof EgressRefused || err instanceof ConnectionRefused) throw new RespondRefused("connection_failed", err.message);
  throw err;
}

/**
 * Which connection answers for this event: the event's own connection when
 * it can, else another that holds the same meeting (its UID) and can —
 * `no_rsvp` when none does, before anything is sent.
 */
async function rsvpFor(db: Db, open: RsvpOpener, eventId: string): Promise<{ row: EventRow; rsvp: RsvpConnection; rows: EventRow[] }> {
  const cols = `connection, event_id, ical_uid, series_id, title, starts_at, ends_at, all_day, location, organizer, attendees, self_status`;
  const mine = (await db.query(`SELECT ${cols} FROM calendar_events WHERE event_id = $1 ORDER BY connection COLLATE "C"`, [eventId])).rows as EventRow[];
  if (mine.length === 0) throw new RespondRefused("not_found", "no calendar holds an event with this id — the calendar sync may not have read it yet");
  const uid = mine.find((r) => r.ical_uid)?.ical_uid ?? null;
  const rows = uid ? ((await db.query(`SELECT ${cols} FROM calendar_events WHERE ical_uid = $1 ORDER BY connection COLLATE "C"`, [uid])).rows as EventRow[]) : mine;
  const order = [...new Set([...mine.map((r) => r.connection), ...rows.map((r) => r.connection)])];
  const why: string[] = [];
  if (uid) {
    for (const connection of order) {
      const opened = await open(connection);
      if (opened.ok) return { row: rows.find((r) => r.connection === connection) ?? mine[0]!, rsvp: opened.rsvp, rows };
      why.push(opened.why);
    }
  } else {
    why.push("the event carries no iCalendar UID, so no calendar can be asked to answer it");
  }
  throw new RespondRefused("no_rsvp", `no connection that holds this event can answer it — open it in Calendar (${why.join("; ")})`);
}

/** Preview an answer (Accept · Maybe · Decline): which calendar, as whom, to whom — nothing is written. */
export async function previewInvitationReply(db: Db, open: RsvpOpener, req: { event_id: string; response: unknown }): Promise<RespondPreview> {
  if (!isResponse(req.response)) throw new RespondRefused("bad_request", `an answer is one of ${RSVP_RESPONSES.join(", ")}`);
  const { row, rsvp, rows } = await rsvpFor(db, open, req.event_id);
  const uid = row.ical_uid!;
  let p: ReplyPreview;
  try {
    p = await rsvp.preview({ uid, response: req.response });
  } catch (err) {
    caldavRefusal(err);
  }
  return {
    event_id: req.event_id,
    connection: rsvp.connection,
    title: p.title || row.title,
    response: p.response,
    organizer: p.organizer,
    as: p.as,
    unchanged: p.unchanged,
    series: rows.some((r) => r.series_id !== null) || rows.filter((r) => r.connection === rsvp.connection).length > 1,
    binding: { event_id: req.event_id, connection: rsvp.connection, uid, response: p.response, etag: p.etag },
    secrets: rsvp.secretsUsed(),
  };
}

const SAID: Readonly<Record<RsvpResponse, string>> = { accepted: "You accepted", tentative: "You said maybe", declined: "You declined" };

/**
 * Answer it, as previewed: re-derived from the server's copy and written
 * only if that copy is still the one previewed (`changed` otherwise). The
 * rows of that connection take the answer at once — what its sync reads on
 * its next pass — so no calendar re-asks in between, and the invitation's
 * request is cleared with a receipt naming what was sent.
 */
export async function confirmInvitationReply(db: Db, open: RsvpOpener, b: RespondBinding): Promise<{ result: WriteResult; cleared: number[]; secrets: string[] }> {
  const opened = await open(b.connection);
  if (!opened.ok) throw new RespondRefused(opened.status === "failed" ? "connection_failed" : "no_rsvp", opened.why);
  let result: WriteResult;
  try {
    result = await opened.rsvp.respond({ uid: b.uid, response: b.response, etag: b.etag });
  } catch (err) {
    caldavRefusal(err);
  }
  await db.query(`UPDATE calendar_events SET self_status = $3, updated_at = now() WHERE connection = $1 AND ical_uid = $2 AND self_status IS DISTINCT FROM $3 AND self_status IS NOT NULL`, [b.connection, b.uid, b.response]);
  const cleared = await resolveAtSource(db, { kind: CALENDAR_SOURCE_KIND, external_ref: `${INVITE_REF_PREFIX}uid/${b.uid}` }, `${SAID[b.response]} — the reply went to the organizer`);
  return { result, cleared, secrets: opened.rsvp.secretsUsed() };
}
