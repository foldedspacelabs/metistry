// What `GET /events` serves for one event, made from what the Swift helper
// read. Pure: no socket, no clock — the wire contract's tests drive it with
// a scripted helper, and every calendar consumer (the routines, the eventkit
// sync that fills `calendar_events`) reads the same fields from it.
//
// Three facts are decided HERE rather than in Swift, so they are tested on
// every platform CI runs on:
//
//  * **`event_id` names one occurrence.** EventKit's `eventIdentifier` is the
//    SERIES for a recurring event (every Monday standup shares it), and a
//    meeting note is for one Monday. A recurring occurrence's key is the
//    identifier plus its ORIGINAL date (`occurrenceDate`, which stays put
//    when that one occurrence is moved — EKEvent.h), the shape Google uses
//    for its instance ids. A one-off event's key is its identifier alone, so
//    moving it does not orphan its note.
//  * **`self_status` is the owner's answer**, from the participant EventKit
//    marks `isCurrentUser`; the organizer of a meeting has accepted it by
//    definition (RFC 5545 gives the organizer's own PARTSTAT as ACCEPTED);
//    an event with nobody else in it has nothing to answer, so null.
//  * **`notes` never leaves the bridge.** The invite body carries dial-in
//    codes and confidential agendas (today-hub-requests A1). The helper reads
//    it only when asked, the bridge never asks, and this function drops the
//    field even if a helper sends it unasked — so no consumer of `GET
//    /events`, and nothing any consumer writes, can carry one.

/** A participant as the helper reports it (`participant()` in ek-helper.swift). */
export interface HelperParticipant {
  name?: string | null;
  email?: string | null;
  status?: string;
  role?: string;
  type?: string;
  self?: boolean;
}

/** One event as the helper's `list_events` reports it. Every field past `calendar` arrived with T2-11; an older helper sends none of them. */
export interface HelperEvent {
  id?: string;
  title?: string;
  start?: string;
  end?: string;
  all_day?: boolean;
  location?: string;
  calendar?: string;
  attendees?: string[];
  participants?: HelperParticipant[];
  organizer?: HelperParticipant | null;
  ical_uid?: string | null;
  recurring?: boolean;
  occurrence?: string | null;
  notes?: string | null;
}

/** A participant as `GET /events` serves it: the address as EventKit gave it (the sync lowercases), the owner's own row marked. */
export interface Participant {
  name: string | null;
  email: string | null;
  status: string;
  role: string;
  type: string;
  self: boolean;
}

/** One event as `GET /events` serves it. The first eight fields are unchanged from before T2-11, so every existing reader still reads them. */
export interface BridgeEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  all_day: boolean;
  location: string;
  calendar: string;
  /** Names only — `morning-brief` and `weekly-review` join these as strings. */
  attendees: string[];
  /** Null only for an event the helper could not name — served (a brief still lists it), never synced. */
  event_id: string | null;
  ical_uid: string | null;
  series_id: string | null;
  participants: Participant[];
  organizer: Participant | null;
  self_status: string | null;
}

/** Everything a participant's status may be; anything else a helper says is `unknown`. */
export const PARTICIPANT_STATUSES = ["unknown", "pending", "accepted", "declined", "tentative", "delegated", "completed", "in_process"] as const;
const STATUSES: ReadonlySet<string> = new Set(PARTICIPANT_STATUSES);

const text = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

function participant(p: HelperParticipant): Participant {
  return {
    name: text(p.name),
    email: text(p.email),
    status: typeof p.status === "string" && STATUSES.has(p.status) ? p.status : "unknown",
    role: text(p.role) ?? "unknown",
    type: text(p.type) ?? "unknown",
    self: p.self === true,
  };
}

/**
 * The occurrence key: the identifier, and for an occurrence of a recurring
 * event its original date (`20260928T133000Z`, or `20260928` all-day).
 * Null when the helper gave no identifier — an event that cannot be named
 * cannot be keyed (EKEvent.h: nil only for an event never saved).
 */
export function eventKey(e: Pick<HelperEvent, "id" | "recurring" | "occurrence">): string | null {
  const id = text(e.id);
  if (id === null) return null;
  const occurrence = e.recurring === true ? text(e.occurrence) : null;
  return occurrence === null ? id : `${id}_${occurrence}`;
}

/** The owner's own answer to this event, or null when there is nothing to answer (see the header). */
export function selfStatus(participants: Participant[], organizer: Participant | null): string | null {
  const mine = participants.find((p) => p.self);
  if (mine) return mine.status;
  if (organizer?.self) return "accepted";
  return null;
}

/** The helper's event → the bridge's. `notes` is never carried (see the header). */
export function bridgeEvent(e: HelperEvent): BridgeEvent {
  const key = eventKey(e);
  const participants = Array.isArray(e.participants) ? e.participants.map(participant) : [];
  const organizer = e.organizer ? participant(e.organizer) : null;
  return {
    id: e.id ?? "",
    title: e.title ?? "",
    start: e.start ?? "",
    end: e.end ?? "",
    all_day: e.all_day === true,
    location: e.location ?? "",
    calendar: e.calendar ?? "",
    attendees: Array.isArray(e.attendees) ? e.attendees.filter((a): a is string => typeof a === "string") : [],
    event_id: key,
    ical_uid: text(e.ical_uid),
    series_id: e.recurring === true ? text(e.id) : null,
    participants,
    organizer,
    self_status: selfStatus(participants, organizer),
  };
}
