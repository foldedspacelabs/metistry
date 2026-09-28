// The Move-a-meeting door — `POST /api/calendar/events/:id/move`
// (design-build-plan §2.1, §2.11 "Move a meeting", B10; ticket T2-12; D7:
// the assistant moves meetings after a warning).
//
// The owner drags a meeting on Today (or accepts the assistant's suggestion
// to move it) and sees, before anything changes, the event, the new time and
// who else is in it. Two calls, as every destructive tool is:
//
//   1. `{start, end}` — the PREVIEW. Nothing moves. The answer carries the
//      event as the calendar holds it now (`preview`: its title, where it
//      is, where it goes, who is in it), how many others are in it, a
//      `warning` sentence naming them (null when the event is the owner's
//      alone — a focus block moves without one), a single-use
//      `confirm_token`, and `moved: false`.
//   2. `{start, end, confirm_token}` — the CONFIRM. The event moves, this
//      occurrence only, to exactly the previewed time: `moved: true`.
//
// **Where the rule lives: the bridge, not here.** The eventkit bridge
// (packages/mcp-eventkit `POST /events/move`) refuses a confirm for an
// event with others in it unless it carries the owner-door token, a second
// secret this door holds and the assistant never does. So the assistant's
// own confirm of such a move is refused at the bridge, whatever it was told;
// this door is the one way the owner's tap reaches it. The door itself only:
//
//   * **moves an event the calendar holds** — the id must be a row of
//     `calendar_events` (the `calendar_event` query), as the meeting-note door
//     requires, and its source must be one this console can move through:
//     the eventkit sync's (`eventkit`). Any other source answers `503` and
//     the client offers *Open in Calendar* (client-api.md);
//   * **presents the owner-door token on a confirm only** — a preview needs
//     no more than the bearer;
//   * **asks the calendar sync to run now** after a move, so Today shows the
//     new time without waiting for the next five-minute pass.
//
// The token and the rule are the bridge's; its `409`s (a spent or mismatched
// token, an event that changed since the preview) come through as `409` with
// `reason: "stale"`. Never the invite body: neither the bridge nor the table
// carries one. Not an action: `ACTION_KINDS` is untouched, so no proposal
// can move a meeting at any autonomy level.
//
// Reached only by the `user` principal: server.ts's management gate runs
// first, so an agent bearer and the capture owner token get the uniform 403.

import type { IncomingMessage, ServerResponse } from "node:http";
import { errorEnvelope, statusFor, type ErrorCode } from "@foldedspacelabs/metistry-core";
import type { QueryStore } from "@foldedspacelabs/metistry-queries";
import { readBody, sendJson } from "./http-util.js";
import { CALENDAR_EVENT_QUERY, validEventId } from "./meeting-note-route.js";

const MOVE_ROUTE = /^POST \/api\/calendar\/events\/([^/]+)\/move$/;

/** The `connection` the eventkit sync writes (collectors/eventkit-calendar `EVENTKIT_CONNECTION`) — the one source this door can move today. */
export const EVENTKIT_CONNECTION = "eventkit";
/** The sync Run Now is asked for after a move (collectors/eventkit-calendar/manifest.yaml). */
export const CALENDAR_SYNC = "eventkit-calendar";
/** The header the bridge reads the owner-door token from (packages/mcp-eventkit `OWNER_DOOR_HEADER`). */
export const OWNER_DOOR_HEADER = "metistry-owner-door";
/** The helper's own timeout is 30 s (packages/mcp-eventkit helper.ts); the bridge answers within it. */
const BRIDGE_TIMEOUT_MS = 35_000; // limit: fixed — the helper's 30 s plus the bridge's own round trip

const BODY_FIELDS = new Set(["start", "end", "confirm_token"]);
const MINT_HINT = "`metistry secrets mint METISTRY_OWNER_DOOR_TOKEN_EVENTKIT`, then restart eventkit and the console (docs/ops/client-api.md, Move a meeting)";

type Audit = (kind: string, tool: string, ok: boolean, meta: Record<string, unknown>) => Promise<void>;

/** The eventkit bridge as this door reaches it. */
export interface EventkitDoor {
  url: string;
  /** METISTRY_BRIDGE_TOKEN_EVENTKIT — the bearer every caller of the bridge presents. */
  token: string;
  /** METISTRY_OWNER_DOOR_TOKEN_EVENTKIT — presented on a confirm, and only here. Absent = an event with others in it cannot be moved from this console. */
  ownerDoorToken?: string | undefined;
  /** The `calendar_events.connection` this bridge's sync writes. Absent = `eventkit`, the sync's own; a test names its own so a concurrent sync test cannot clear its rows. */
  connection?: string | undefined;
}

export interface MeetingMoveDeps {
  queries: QueryStore;
  /** Absent → `503`: no calendar bridge is configured in this deployment. */
  eventkit?: EventkitDoor | undefined;
  audit: Audit;
  /** Run the calendar sync now (runner.ts `runNow`); resolves true when it started. Absent = Today catches up on the next pass. */
  refresh?: (() => Promise<boolean>) | undefined;
  fetchFn?: typeof fetch;
}

/** True when the request is for this door. Used by server.ts's management gate so a non-`user` credential gets the uniform 403. */
export function isMeetingMoveRoute(key: string): boolean {
  return MOVE_ROUTE.test(key);
}

const refuse = (res: ServerResponse, code: ErrorCode, message: string, extra: Record<string, unknown> = {}) =>
  sendJson(res, statusFor(code), { ...errorEnvelope(code, message), ...extra });

/** An ISO 8601 instant `Date` can read; the bridge canonicalises it (packages/mcp-eventkit move.ts). */
const instant = (v: unknown): number | null => (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Date.parse(v)) ? Date.parse(v) : null);

type BridgeAnswer = { kind: "answer"; status: number; body: Record<string, unknown> } | { kind: "unreachable" };

async function callBridge(door: EventkitDoor, payload: Record<string, unknown>, confirming: boolean, fetchFn: typeof fetch): Promise<BridgeAnswer> {
  const headers: Record<string, string> = { authorization: `Bearer ${door.token}`, "content-type": "application/json" };
  if (confirming && door.ownerDoorToken) headers[OWNER_DOOR_HEADER] = door.ownerDoorToken;
  try {
    const r = await fetchFn(`${door.url.replace(/\/+$/, "")}/events/move`, { method: "POST", headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(BRIDGE_TIMEOUT_MS) });
    const text = await r.text();
    let body: Record<string, unknown> = {};
    try {
      const parsed: unknown = text === "" ? {} : JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
    } catch {
      /* a body that is not JSON is read as none */
    }
    return { kind: "answer", status: r.status, body };
  } catch {
    return { kind: "unreachable" };
  }
}

const bridgeMessage = (body: Record<string, unknown>, fallback: string): string => {
  const e = body.error as { message?: unknown } | undefined;
  return typeof e?.message === "string" && e.message !== "" ? e.message : fallback;
};

type Attendee = { name: string | null; email: string | null; person: string | null; self: boolean };

/**
 * Who is in it, as Today spells an attendee (`{name, email, person, self}`):
 * the bridge's participants as the calendar holds them NOW — plus an
 * organizer it does not list, the same people the bridge counts — with each
 * one's People page from the calendar row where the address matches.
 */
function attendeesOf(ev: Record<string, unknown>, rowAttendees: unknown): Attendee[] {
  const pages = new Map<string, string>();
  if (Array.isArray(rowAttendees)) {
    for (const a of rowAttendees as { email?: unknown; person?: unknown }[]) {
      if (typeof a?.email === "string" && typeof a.person === "string") pages.set(a.email.toLowerCase(), a.person);
    }
  }
  const text = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
  const one = (p: Record<string, unknown>): Attendee => {
    const email = text(p.email);
    return { name: text(p.name), email, person: email ? (pages.get(email.toLowerCase()) ?? null) : null, self: p.self === true };
  };
  const people = (Array.isArray(ev.participants) ? (ev.participants as Record<string, unknown>[]) : []).map(one);
  const org = ev.organizer && typeof ev.organizer === "object" ? one(ev.organizer as Record<string, unknown>) : null;
  if (org && !org.self && !people.some((p) => (org.email && p.email ? p.email.toLowerCase() === org.email.toLowerCase() : p.name !== null && p.name === org.name))) people.push(org);
  return people;
}

export async function meetingMoveRoute(req: IncomingMessage, res: ServerResponse, key: string, deps: MeetingMoveDeps): Promise<void> {
  const m = MOVE_ROUTE.exec(key)!;
  let eventId: string;
  try {
    eventId = decodeURIComponent(m[1]!);
  } catch {
    return refuse(res, "invalid_request", "the event id is not valid percent-encoding");
  }
  if (!validEventId(eventId)) return refuse(res, "invalid_request", "an event id is the event's `event_id` exactly as GET /api/today returns it — at most 1024 characters, no surrounding space, no control characters");

  let body: Record<string, unknown>;
  try {
    const text = (await readBody(req)).toString("utf8");
    const raw: unknown = text.trim() === "" ? {} : JSON.parse(text);
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return refuse(res, "invalid_request", "the body is {start, end} and, to confirm, confirm_token");
    body = raw as Record<string, unknown>;
  } catch {
    return refuse(res, "invalid_request", "request body is not JSON");
  }
  const extra = Object.keys(body).filter((k) => !BODY_FIELDS.has(k));
  if (extra.length > 0) return refuse(res, "invalid_request", `unknown field${extra.length > 1 ? "s" : ""} ${extra.join(", ")} — a move is {start, end, confirm_token?}: the event is named in the path, and everything else about it is the calendar's`);
  const start = instant(body.start);
  const end = instant(body.end);
  if (start === null || end === null) return refuse(res, "invalid_request", "start and end are ISO 8601 instants");
  if (end <= start) return refuse(res, "invalid_request", "end is after start");
  const confirmToken = body.confirm_token;
  if (confirmToken !== undefined && (typeof confirmToken !== "string" || confirmToken === "")) return refuse(res, "invalid_request", "confirm_token is the string the preview returned");
  const confirming = typeof confirmToken === "string";
  const stage = confirming ? "confirm" : "preview";

  // the id and the outcome, never the title, the attendees or the times: `runs` is read by surfaces broader than this door
  const audited = (ok: boolean, outcome: string, others?: number) => deps.audit("meeting_move", stage, ok, { event_id: eventId, outcome, ...(others !== undefined ? { others } : {}) });

  const { rows } = await deps.queries.run(CALENDAR_EVENT_QUERY, { event_id: eventId });
  const event = rows[0];
  if (!event) {
    await audited(false, "unknown_event");
    return refuse(res, "not_found", "no calendar holds an event with this id — the calendar sync may not have read it yet; refresh Today");
  }
  if (!deps.eventkit) {
    await audited(false, "no_bridge");
    return refuse(res, "not_available", "moving a meeting goes through the calendar bridge, and none is configured in this deployment — METISTRY_EK_URL + METISTRY_BRIDGE_TOKEN_EVENTKIT (docs/ops/client-api.md, Move a meeting)");
  }
  if (event.connection !== (deps.eventkit.connection ?? EVENTKIT_CONNECTION)) {
    await audited(false, "no_capability");
    return refuse(res, "not_available", `no connection this console reaches can move an event from "${String(event.connection)}" — open it in Calendar`);
  }

  const payload = { event_id: eventId, start: body.start, end: body.end, ...(confirming ? { confirm_token: confirmToken } : {}) };
  const answer = await callBridge(deps.eventkit, payload, confirming, deps.fetchFn ?? fetch);
  if (answer.kind === "unreachable") {
    await audited(false, "bridge_unreachable");
    return refuse(res, "not_available", "the calendar bridge is not answering — the Mac that holds the calendar may be asleep or away; try again, or open it in Calendar");
  }
  const { status, body: b } = answer;

  if (status === 200 && !confirming) {
    const others = typeof b.others === "number" ? b.others : 0;
    const ev = (b.event ?? {}) as Record<string, unknown>;
    await audited(true, "previewed", others);
    return sendJson(res, 200, {
      ok: true,
      // the shape MetistryKit reads (F-7's fixture): the event, where it is, where it goes, who is in it
      preview: {
        event_id: eventId,
        title: typeof ev.title === "string" ? ev.title : String(event.title ?? ""),
        from: { start: ev.start, end: ev.end },
        to: b.to,
        attendees: attendeesOf(ev, event.attendees),
      },
      others,
      // D7: the warning is the bridge's sentence when anyone else is in it — and nothing at all when the event is the owner's alone
      warning: others > 0 && typeof b.preview === "string" ? b.preview : null,
      confirm_token: b.confirm_token,
      expires_in_sec: b.expires_in_sec,
      moved: false,
    });
  }
  if (status === 200) {
    const others = typeof b.others === "number" ? b.others : 0;
    await audited(true, "moved", others);
    let refreshing = false;
    try {
      refreshing = deps.refresh ? await deps.refresh() : false;
    } catch {
      refreshing = false; // the move is done; Today catches up on the next pass
    }
    return sendJson(res, 200, { ok: true, moved: true, event_id: eventId, event: b.moved, others, refreshing });
  }

  // the bridge's refusals, as the owner's client reads them
  if (status === 400) {
    await audited(false, "refused");
    return refuse(res, "invalid_request", bridgeMessage(b, "the calendar bridge refused this move"));
  }
  if (status === 404) {
    await audited(false, "gone");
    return refuse(res, "not_found", bridgeMessage(b, "the calendar no longer holds this event"));
  }
  if (status === 409) {
    await audited(false, "stale");
    return refuse(res, "conflict", bridgeMessage(b, "preview again"), { reason: "stale", ...(b.event ? { event: b.event } : {}) });
  }
  if (status === 403) {
    // the bridge's B10 gate: an event with others in it, and no owner-door token it accepts — a deployment gap, never the owner's permission
    await audited(false, "owner_door_refused");
    const why = deps.eventkit.ownerDoorToken
      ? "the calendar bridge did not accept this console's owner-door token (they were started with different values)"
      : "this console has no owner-door token for the calendar bridge";
    return refuse(res, "not_available", `this event has others in it, and ${why} — ${MINT_HINT}`);
  }
  if (status === 401) {
    await audited(false, "bridge_refused_bearer");
    return refuse(res, "not_available", "the calendar bridge refused this console's bearer — METISTRY_BRIDGE_TOKEN_EVENTKIT differs from the one the bridge was started with; restart the bridge and the console");
  }
  await audited(false, "bridge_failed");
  return refuse(res, "internal", "the calendar bridge failed");
}
