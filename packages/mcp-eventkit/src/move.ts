// `move_event` — the pure half of `POST /events/move` (design-build-plan
// §2.11 "Move a meeting", B10; ticket T2-12). Pure: no socket, no clock, no
// token store — index.ts owns those — so every rule below is tested on every
// platform CI runs on.
//
// Moving a meeting changes other people's day, so the bridge — not a prompt,
// not the caller — decides who may confirm one:
//
//  * **An event with nobody else in it** moves on any confirm the bridge's
//    own bearer carries. The owner's focus block is theirs to shift, and an
//    assistant may shift it after the preview.
//  * **An event with others in it** moves only on a confirm that ALSO
//    carries the owner-door token (`Metistry-Owner-Door`), a second secret
//    only the console's owner door holds. The assistant reaches this bridge
//    with the bearer alone, so its own confirm of such a move is refused
//    here, whatever it was told — and the preview says, before anyone
//    confirms, who would see the new time.
//  * **"Others" is counted fail-closed**: every participant EventKit does
//    not mark as the owner, of any kind (a room is someone's booking too),
//    plus an organizer who is not the owner.
//  * **The confirm is for the event as previewed.** The token binds the
//    request (id, new start, new end) and a fingerprint of the event as it
//    stood — its times, who is in it, who organises it. A confirm after any
//    of those changed is `409`: the preview the owner agreed to is no longer
//    the truth.
//
// Never the invite body: the helper's `get_event` never reads it, and
// `bridgeEvent` drops it if one arrives.

import { bridgeEvent, type BridgeEvent, type HelperEvent, type Participant } from "./events.js";

/** The header a confirm carries the owner-door token in. Never a body field: the payload a confirm token binds is the move, not who is asking. */
export const OWNER_DOOR_HEADER = "metistry-owner-door";

/** events.ts's occurrence keys and the console's meeting-note door's bound: an id longer than this is refused, never cut. */
export const MOVE_EVENT_ID_MAX = 1024; // limit: fixed — the meeting-note door's EVENT_ID_MAX; longer than any calendar's id

/** What a move asks for, canonical: the id as served, and both instants at second precision in UTC (what the helper's ISO8601DateFormatter reads). */
export interface MoveRequest {
  event_id: string;
  start: string;
  end: string;
}

export type ParsedMove = { ok: true; move: MoveRequest; confirmToken: string | null } | { ok: false; message: string };

const BODY_FIELDS = new Set(["event_id", "start", "end", "confirm_token"]);

/** An instant as the helper reads it: `2026-09-28T14:00:00Z`. Null for anything `Date` cannot read. */
export function canonicalInstant(v: unknown): string | null {
  if (typeof v !== "string" || v.trim() === "") return null;
  const t = Date.parse(v);
  if (Number.isNaN(t)) return null;
  return new Date(Math.floor(t / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** The body of `POST /events/move`: exactly `{event_id, start, end, confirm_token?}`. */
export function parseMove(body: unknown): ParsedMove {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return { ok: false, message: "the body is {event_id, start, end} and, to confirm, confirm_token" };
  const b = body as Record<string, unknown>;
  const extra = Object.keys(b).filter((k) => !BODY_FIELDS.has(k));
  if (extra.length > 0) return { ok: false, message: `unknown field${extra.length > 1 ? "s" : ""} ${extra.join(", ")} — a move is {event_id, start, end, confirm_token?}` };
  const id = b.event_id;
  if (typeof id !== "string" || id === "" || id !== id.trim() || id.length > MOVE_EVENT_ID_MAX || /[\u0000-\u001f\u007f]/.test(id)) {
    return { ok: false, message: `event_id is the event's key exactly as GET /events serves it — at most ${MOVE_EVENT_ID_MAX} characters, no surrounding space, no control characters` };
  }
  const start = canonicalInstant(b.start);
  const end = canonicalInstant(b.end);
  if (start === null || end === null) return { ok: false, message: "start and end are ISO 8601 instants" };
  if (Date.parse(end) <= Date.parse(start)) return { ok: false, message: "end is after start" };
  const token = b.confirm_token;
  if (token !== undefined && (typeof token !== "string" || token === "")) return { ok: false, message: "confirm_token is the string the preview returned" };
  return { ok: true, move: { event_id: id, start, end }, confirmToken: typeof token === "string" ? token : null };
}

/** The move as one string, fields in a fixed order — what a confirm token binds. Key order in the request body never matters. */
export function moveKey(m: MoveRequest): string {
  return JSON.stringify([m.event_id, m.start, m.end]);
}

/** Everyone in the event who is not the owner — the people a move re-times. Fail-closed: every kind counts, and an organizer who is not the owner counts once. */
export function othersIn(e: Pick<BridgeEvent, "participants" | "organizer">): Participant[] {
  const others = e.participants.filter((p) => !p.self);
  const org = e.organizer;
  if (org && !org.self) {
    const listed = others.some((p) => (org.email !== null && p.email !== null ? p.email.toLowerCase() === org.email.toLowerCase() : p.name !== null && p.name === org.name));
    if (!listed) others.push(org);
  }
  return others;
}

/**
 * What the owner saw when they previewed: the event's times, who is in it,
 * and who organises it (not their answers — Dana accepting is no reason to
 * preview again). A confirm is for this; if any
 * of it has changed, the confirm is refused (`409`), never applied to an
 * event the owner has not looked at.
 */
export function eventFingerprint(e: BridgeEvent): string {
  const who = (p: Participant) => [p.email?.toLowerCase() ?? null, p.name, p.self, p.type];
  const people = e.participants.map(who).map((x) => JSON.stringify(x)).sort();
  return JSON.stringify([e.event_id, e.start, e.end, e.all_day, people, e.organizer ? who(e.organizer) : null]);
}

/** The event as a preview and a confirm show it: never the invite body (bridgeEvent drops it). */
export function movedView(e: BridgeEvent) {
  return {
    event_id: e.event_id,
    title: e.title,
    start: e.start,
    end: e.end,
    all_day: e.all_day,
    calendar: e.calendar,
    participants: e.participants,
    organizer: e.organizer,
  };
}

export type MoveCheck = { ok: true; event: BridgeEvent; others: Participant[] } | { ok: false; code: "not_found" | "invalid_request"; message: string };

/** Whether this event may be moved at all, whoever asks — the helper's `get_event` answer in, the bridge's event (or the refusal) out. */
export function checkMovable(helperEvent: unknown): MoveCheck {
  if (helperEvent === null || helperEvent === undefined || typeof helperEvent !== "object") {
    return { ok: false, code: "not_found", message: "no calendar on this Mac holds an event with this key — it may have been deleted, or it recurs and was moved more than a month from its original date" };
  }
  const h = helperEvent as HelperEvent;
  const event = bridgeEvent(h);
  if (h.writable === false) return { ok: false, code: "invalid_request", message: `the calendar "${event.calendar}" is read-only — move it where it is subscribed` };
  return { ok: true, event, others: othersIn(event) };
}

/** One line a person reads before confirming. With others: who sees the new time. Without: no warning. */
export function describeMove(e: BridgeEvent, to: MoveRequest, others: Participant[]): string {
  const base = `move "${e.title}" from ${e.start} → ${e.end} to ${to.start} → ${to.end}`;
  if (others.length === 0) return `${base}; nobody else is in it`;
  const names = others.map((p) => p.name ?? p.email ?? "someone").slice(0, 5);
  const more = others.length > names.length ? ` and ${others.length - names.length} more` : "";
  return `${base}; ${others.length === 1 ? "1 other person" : `${others.length} others`} in it will see the new time: ${names.join(", ")}${more}`;
}
