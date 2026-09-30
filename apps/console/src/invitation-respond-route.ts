// Respond to an invitation — `POST /api/calendar/invitations/:id/respond`
// (design-build-plan §2.1, §2.6, §2.11 "Respond / Draft", §2.12; ticket
// T4-17; K16, Q9). The `invitation` request's Accept · Maybe · Decline.
//
// Two calls, as every change that reaches someone else is:
//
//   1. `{response}` — the PREVIEW (`accepted` · `tentative` · `declined`).
//      Nothing is written. The answer names the calendar that will answer,
//      the meeting, the organizer the reply goes to and the owner's address
//      it answers as, with a single-use `confirm_token`.
//   2. `{response, confirm_token}` — the CONFIRM. The owner's own attendee
//      line changes in that calendar's copy, and its server delivers the
//      reply (RFC 6638). The invitation's request clears with a receipt.
//
// **Through the connection that can, or not at all.** The event is a row
// of `calendar_events`; the answer goes through a calendar connection whose
// provider declares `rsvp` and holds the same meeting — its own calendar,
// or another that holds the same UID (the Mac's calendar cannot answer:
// EventKit's participant status is read-only). **Without an `rsvp`
// capability it is refused**, `503` with `open_in_calendar: true`, before
// anything is sent — the client offers *Open in Calendar* (Q9). The rule is
// `collectors/invitations.ts`'s; this module is the door: the path, the
// body, the token, the answer, the audit row.
//
// **The token is this console's** (door-confirm.ts): bound to the event and
// the answer the preview showed, and to the ETag the calendar gave then —
// the confirm re-derives the change from the server's copy and writes only
// if it is still that copy (`409 stale` otherwise). Not an action:
// `ACTION_KINDS` is untouched, so no proposal and no agent can answer an
// invitation at any autonomy level.
//
// **C45.** An answer the calendar could not take — no connection can
// answer, the server does not schedule, the connection failed — leaves the
// invitation's request pending with `payload.error` saying why (door
// `rsvp`), so every device that draws it shows the refusal, not a decision;
// a stale confirm is not a failed answer and writes nothing on the row.
//
// Reached only by the `user` principal: server.ts's management gate runs
// first, so an agent bearer and the capture owner token get the uniform 403.

import type { IncomingMessage, ServerResponse } from "node:http";
import { SECRET_USE_META_KEY, errorEnvelope, statusFor, type ErrorCode } from "@foldedspacelabs/metistry-core";
import { RespondRefused, confirmInvitationReply, previewInvitationReply, type RespondBinding, type RespondRefusalCode, type RsvpOpener } from "@metistry-apps/collectors";
import type { Db } from "./auth-store.js";
import { readBody, sendJson } from "./http-util.js";
import { validEventId } from "./meeting-note-route.js";
import type { ConfirmTokens } from "./door-confirm.js";

const RESPOND_ROUTE = /^POST \/api\/calendar\/invitations\/([^/]+)\/respond$/;
/** The door's name on its tokens: a Draft Reply token cannot confirm an answer. */
export const RESPOND_DOOR = "invitation_respond";

const BODY_FIELDS = new Set(["response", "confirm_token"]);

export const CALENDARS_NOT_AVAILABLE =
  "calendar connections are not readable from this deployment — the console needs METISTRY_INSTANCE_DIR pointing at the instance whose `.metistry/connections/` holds a calendar that can answer (docs/ops/connections.md, CalDAV) — open it in Calendar";

type Audit = (kind: string, tool: string, ok: boolean, meta: Record<string, unknown>) => Promise<void>;

export interface InvitationRespondDeps {
  db: Db;
  audit: Audit;
  /** Opens a calendar connection by name when it can answer (`calendarRsvpOpener`). Absent → `503`, Open in Calendar. */
  open?: RsvpOpener | undefined;
  tokens: ConfirmTokens<RespondBinding>;
}

export function isInvitationRespondRoute(key: string): boolean {
  return RESPOND_ROUTE.test(key);
}

/** Each refusal's HTTP answer. A code path each (U3); the service's message says why. */
const STATUS_OF: Readonly<Record<RespondRefusalCode, ErrorCode>> = {
  bad_request: "invalid_request",
  not_found: "not_found",
  no_rsvp: "not_available",
  not_invited: "invalid_request",
  no_scheduling: "not_available",
  changed: "conflict",
  connection_failed: "not_available",
};
/** The refusals after which the client offers Open in Calendar. */
const OPEN_IN_CALENDAR: ReadonlySet<RespondRefusalCode> = new Set(["no_rsvp", "no_scheduling"]);

const refuse = (res: ServerResponse, code: ErrorCode, message: string, extra: Record<string, unknown> = {}) => sendJson(res, statusFor(code), { ...errorEnvelope(code, message), ...extra });

/** §2.12's invitation row: Accept is the primary answer, Maybe the Revise, Decline the Decline — the verb `payload.error` names. */
const VERB_OF: Readonly<Record<string, string>> = { accepted: "allow", tentative: "accept_with_changes", declined: "deny" };

/** C45: the waiting invitation for this event carries why the answer did not go (pending rows only). */
async function recordRefusal(db: Db, eventId: string, response: string, code: ErrorCode, message: string): Promise<void> {
  const error = { code, message, decision: VERB_OF[response] ?? "allow", door: "rsvp", response, at: new Date().toISOString() };
  await db.query(
    `UPDATE proposals SET payload = payload || jsonb_build_object('error', $2::jsonb)
     WHERE decision = 'pending' AND kind = 'invitation' AND source IS NOT NULL AND source->>'kind' = 'calendar'
       AND (payload->>'event_id' = $1 OR source->>'external_ref' IN (SELECT 'invite:uid/' || ical_uid FROM calendar_events WHERE event_id = $1 AND ical_uid IS NOT NULL))`,
    [eventId, JSON.stringify(error)],
  );
}

export async function invitationRespondRoute(req: IncomingMessage, res: ServerResponse, key: string, deps: InvitationRespondDeps): Promise<void> {
  const m = RESPOND_ROUTE.exec(key)!;
  let eventId: string;
  try {
    eventId = decodeURIComponent(m[1]!);
  } catch {
    return refuse(res, "invalid_request", "the event id is not valid percent-encoding");
  }
  if (!validEventId(eventId)) return refuse(res, "invalid_request", "an event id is the event's `event_id` exactly as the invitation request and GET /api/today carry it — at most 1024 characters, no surrounding space, no control characters");

  let body: Record<string, unknown>;
  try {
    const text = (await readBody(req)).toString("utf8");
    const raw: unknown = text.trim() === "" ? {} : JSON.parse(text);
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return refuse(res, "invalid_request", "the body is {response} and, to confirm, confirm_token");
    body = raw as Record<string, unknown>;
  } catch {
    return refuse(res, "invalid_request", "request body is not JSON");
  }
  const extra = Object.keys(body).filter((k) => !BODY_FIELDS.has(k));
  if (extra.length > 0) return refuse(res, "invalid_request", `unknown field${extra.length > 1 ? "s" : ""} ${extra.join(", ")} — an answer is {response, confirm_token?}: the event is named in the path, and who it goes to is the calendar's`);
  const confirmToken = body.confirm_token;
  if (confirmToken !== undefined && (typeof confirmToken !== "string" || confirmToken === "")) return refuse(res, "invalid_request", "confirm_token is the string the preview returned");
  const confirming = typeof confirmToken === "string";
  const stage = confirming ? "confirm" : "preview";
  const response = typeof body.response === "string" ? body.response : "";
  const subject = `${eventId}#${response}`;

  // the id and the outcome, never the title, the organizer or the addresses: `runs` is read by surfaces broader than this door
  const audited = (ok: boolean, outcome: string, more: Record<string, unknown> = {}) => deps.audit(RESPOND_DOOR, stage, ok, { event_id: eventId, outcome, ...more });

  if (!deps.open) {
    await audited(false, "no_calendars");
    await recordRefusal(deps.db, eventId, response, "not_available", CALENDARS_NOT_AVAILABLE);
    return refuse(res, "not_available", CALENDARS_NOT_AVAILABLE, { reason: "no_rsvp", open_in_calendar: true });
  }

  try {
    if (!confirming) {
      const p = await previewInvitationReply(deps.db, deps.open, { event_id: eventId, response: body.response });
      const token = deps.tokens.mint(RESPOND_DOOR, subject, p.binding);
      await audited(true, "previewed", { connection: p.connection, ...(p.secrets.length > 0 ? { [SECRET_USE_META_KEY]: p.secrets } : {}) });
      return sendJson(res, 200, {
        ok: true,
        event_id: eventId,
        response: p.response,
        connection: p.connection,
        preview: { event_id: eventId, connection: p.connection, title: p.title, response: p.response, organizer: p.organizer, as: p.as, series: p.series, unchanged: p.unchanged },
        ...token,
        responded: false,
      });
    }
    const binding = deps.tokens.take(confirmToken as string, RESPOND_DOOR, subject);
    if (!binding) {
      await audited(false, "stale_token");
      return refuse(res, "conflict", "this confirm_token is spent, expired, or was not minted for this event and answer — preview again", { reason: "stale" });
    }
    const done = await confirmInvitationReply(deps.db, deps.open, binding);
    if (done.cleared.length > 0) await deps.db.query(`UPDATE proposals SET payload = payload - 'error' WHERE id = ANY($1::bigint[])`, [done.cleared]);
    await audited(true, done.result.unchanged ? "unchanged" : "responded", { connection: binding.connection, response: binding.response, ...(done.secrets.length > 0 ? { [SECRET_USE_META_KEY]: done.secrets } : {}) });
    return sendJson(res, 200, { ok: true, event_id: eventId, response: binding.response, connection: binding.connection, responded: true, unchanged: done.result.unchanged, cleared: done.cleared.length });
  } catch (err) {
    if (err instanceof RespondRefused) {
      await audited(false, err.code);
      // a stale confirm or a malformed answer is not a failed answer: nothing on the row
      if (err.code !== "changed" && err.code !== "bad_request") await recordRefusal(deps.db, eventId, response, STATUS_OF[err.code], err.message);
      return refuse(res, STATUS_OF[err.code], err.message, { reason: err.code === "changed" ? "stale" : err.code, ...(OPEN_IN_CALENDAR.has(err.code) ? { open_in_calendar: true } : {}) });
    }
    throw err;
  }
}
