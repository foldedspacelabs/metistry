// eventkit bridge — §4.3 wire contract over node:http: bearer caller auth
// (CRIT-9), uniform envelope, behavioral check(), and PREVIEW-THEN-CONFIRM
// on the destructive tools (§4.3 default 2): a create returns what would
// change plus a short-lived confirm token; the same request with the token
// executes. Enforced here, not by prompting.
//
// Moving an event (`POST /events/move`, T2-12) is the same shape with one
// more gate: a confirm for an event with others in it must ALSO carry the
// owner-door token (move.ts says why and how "others" is counted).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { authorized, errorEnvelope, statusFor, runCheck, tokenEquals, type ErrorCode } from "@foldedspacelabs/metistry-core";
import type { Helper } from "./helper.js";
import { bridgeEvent, type HelperEvent } from "./events.js";
import { OWNER_DOOR_HEADER, checkMovable, describeMove, eventFingerprint, moveKey, movedView, parseMove } from "./move.js";

export { bridgeEvent, eventKey, selfStatus, PARTICIPANT_STATUSES, type BridgeEvent, type HelperEvent, type HelperParticipant, type Participant } from "./events.js";
export { OWNER_DOOR_HEADER, othersIn, parseMove, type MoveRequest } from "./move.js";

export interface BridgeConfig {
  /** The bearer every caller presents (METISTRY_BRIDGE_TOKEN_EVENTKIT). */
  token: string;
  /**
   * The owner-door token (METISTRY_OWNER_DOOR_TOKEN_EVENTKIT): the second
   * secret a confirm must carry, in `Metistry-Owner-Door`, to move an event
   * with others in it. Only the console's owner door holds it; the assistant
   * never does. Absent = no such move is ever confirmed (fail closed); an
   * event with nobody else in it still moves.
   */
  ownerDoorToken?: string | undefined;
}

const CONFIRM_TTL_MS = 5 * 60 * 1000;

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}
function fail(res: ServerResponse, code: ErrorCode): void {
  send(res, statusFor(code), errorEnvelope(code));
}
async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

export function makeBridge(helper: Helper, cfg: BridgeConfig): Server {
  // one secret in two roles is no split at all: whoever holds the bearer would hold the door
  if (cfg.ownerDoorToken !== undefined && (cfg.ownerDoorToken === "" || tokenEquals(cfg.ownerDoorToken, cfg.token))) {
    throw new Error("the owner-door token must be set and differ from the bridge token — mint its own (metistry secrets mint METISTRY_OWNER_DOOR_TOKEN_EVENTKIT)");
  }
  const ownerDoor = (req: IncomingMessage): boolean => {
    const presented = req.headers[OWNER_DOOR_HEADER];
    return cfg.ownerDoorToken !== undefined && typeof presented === "string" && presented !== "" && tokenEquals(presented, cfg.ownerDoorToken);
  };
  // confirm tokens bind to the exact payload they previewed
  const pendingConfirms = new Map<string, { payload: string; expires: number }>();

  async function previewOrExecute(res: ServerResponse, op: string, body: any, describe: (b: any) => string) {
    const { confirm_token, ...payload } = body ?? {};
    const canonical = JSON.stringify(payload);
    if (confirm_token) {
      const p = pendingConfirms.get(confirm_token);
      pendingConfirms.delete(confirm_token);
      if (!p || p.expires < Date.now() || p.payload !== canonical) return fail(res, "conflict"); // stale/mismatched confirm
      const r = await helper.request({ op, ...payload });
      return r.ok ? send(res, 201, { created: r.created }) : fail(res, "invalid_request");
    }
    const token = randomUUID();
    pendingConfirms.set(token, { payload: canonical, expires: Date.now() + CONFIRM_TTL_MS });
    return send(res, 200, { preview: describe(payload), confirm_token: token, expires_in_sec: CONFIRM_TTL_MS / 1000 });
  }

  // move confirms bind the move AND the event as previewed (move.ts `eventFingerprint`)
  const pendingMoves = new Map<string, { move: string; fingerprint: string; expires: number }>();
  const sweep = () => {
    const now = Date.now();
    for (const [k, v] of pendingMoves) if (v.expires < now) pendingMoves.delete(k);
  };

  async function readEvent(eventId: string) {
    const r = await helper.request({ op: "get_event", event_id: eventId });
    return r.ok ? { ok: true as const, check: checkMovable(r.event) } : { ok: false as const };
  }

  async function move(req: IncomingMessage, res: ServerResponse) {
    let body: unknown;
    try {
      body = await readJson(req);
    } catch {
      return send(res, 400, errorEnvelope("invalid_request", "request body is not JSON"));
    }
    const parsed = parseMove(body);
    if (!parsed.ok) return send(res, 400, errorEnvelope("invalid_request", parsed.message));
    const { move: m, confirmToken } = parsed;

    // the token is spent on first sight, whatever happens next: single-use
    const pending = confirmToken !== null ? pendingMoves.get(confirmToken) : undefined;
    if (confirmToken !== null) {
      pendingMoves.delete(confirmToken);
      if (!pending || pending.expires < Date.now() || pending.move !== moveKey(m)) {
        return send(res, 409, errorEnvelope("conflict", "this confirm token is spent, expired, or for a different move — preview again"));
      }
    }

    // the event as it stands NOW, for the preview and again for the confirm
    const read = await readEvent(m.event_id);
    if (!read.ok) return fail(res, "internal");
    if (!read.check.ok) return send(res, statusFor(read.check.code), errorEnvelope(read.check.code, read.check.message));
    const { event, others } = read.check;

    if (!pending) {
      sweep();
      const token = randomUUID();
      pendingMoves.set(token, { move: moveKey(m), fingerprint: eventFingerprint(event), expires: Date.now() + CONFIRM_TTL_MS });
      return send(res, 200, {
        preview: describeMove(event, m, others),
        event: movedView(event),
        to: { start: m.start, end: m.end },
        others: others.length,
        owner_door_required: others.length > 0,
        confirm_token: token,
        expires_in_sec: CONFIRM_TTL_MS / 1000,
      });
    }

    // B10: others in it → the owner's door, or no move. Checked on the event
    // as it stands, so a guest added since the preview is counted too.
    if (others.length > 0 && !ownerDoor(req)) {
      return send(res, 403, errorEnvelope("forbidden", `this event has ${others.length === 1 ? "someone else" : `${others.length} others`} in it — only the owner's door may confirm moving it`));
    }
    if (eventFingerprint(event) !== pending.fingerprint) {
      return send(res, 409, { ...errorEnvelope("conflict", "the event changed since the preview — its time or who is in it — preview again"), event: movedView(event) });
    }
    const r = await helper.request({ op: "move_event", event_id: m.event_id, start: m.start, end: m.end });
    if (!r.ok) return send(res, 409, errorEnvelope("conflict", "the calendar refused the move — the event may have changed or been deleted, or its calendar is read-only; preview again"));
    return send(res, 200, { moved: movedView(bridgeEvent(r.moved as HelperEvent)), others: others.length });
  }

  return createServer(async (req, res) => {
    try {
      if (!authorized(req.headers.authorization, cfg.token)) return fail(res, "unauthenticated");
      const url = new URL(req.url ?? "/", "http://x");
      const key = `${req.method} ${url.pathname}`;

      if (key === "GET /check") {
        const result = await runCheck("eventkit", "real 7-day event read via EventKit (auth status reported)", async () => {
          const r = await helper.request({ op: "check" });
          if (!r.ok) throw new Error(r.error ?? "helper failed");
          const auth = { events: r.auth_events, reminders: r.auth_reminders };
          if (auth.events !== "full_access" || auth.reminders !== "full_access") {
            return {
              status: "failed" as const,
              remediation: `TCC grant missing (events=${auth.events}, reminders=${auth.reminders}) — re-run enrollment: launchd job 'request' op; a rebuilt ad-hoc helper drops the grant`,
              meta: auth,
            };
          }
          return { meta: { ...auth, events_found: r.events_found } };
        });
        return send(res, result.status === "ok" ? 200 : 503, result);
      }

      // Every event with its occurrence key, participants, organizer and the
      // owner's own answer (events.ts). Never the invite body: the helper is
      // not asked for `notes`, and `bridgeEvent` drops the field if one comes
      // anyway — no reader of this route can hand one on (T2-11). `window` is
      // the span the helper read, so a sync can tell an event that was
      // cancelled from one that is simply outside what it asked for; an older
      // helper sends none and the response says so by omitting it.
      if (key === "GET /events") {
        const days = Math.min(Math.max(Number(url.searchParams.get("days") ?? 1), 1), 31);
        const r = await helper.request({ op: "list_events", days });
        if (!r.ok) return fail(res, "internal");
        const events = (Array.isArray(r.events) ? (r.events as HelperEvent[]) : []).map(bridgeEvent);
        const w = r.window as { start?: unknown; end?: unknown } | undefined;
        const window = w && typeof w.start === "string" && typeof w.end === "string" ? { start: w.start, end: w.end } : undefined;
        return send(res, 200, { events, ...(window ? { window } : {}), as_of: new Date().toISOString() });
      }

      if (key === "GET /reminders") {
        const r = await helper.request({ op: "list_reminders" });
        return r.ok ? send(res, 200, { reminders: r.reminders, as_of: new Date().toISOString() }) : fail(res, "internal");
      }

      if (key === "POST /events") {
        const body = await readJson(req);
        if (typeof body.title !== "string" || !body.start || !body.end) return fail(res, "invalid_request");
        return previewOrExecute(res, "create_event", body, (b) => `create event "${b.title}" ${b.start} → ${b.end} on the default calendar`);
      }

      if (key === "POST /events/move") return move(req, res);

      if (key === "POST /reminders") {
        const body = await readJson(req);
        if (typeof body.title !== "string") return fail(res, "invalid_request");
        return previewOrExecute(res, "create_reminder", body, (b) => `create reminder "${b.title}"${b.due ? ` due ${b.due}` : ""} on the default list`);
      }

      return fail(res, "not_found");
    } catch {
      if (!res.headersSent) fail(res, "internal");
    }
  });
}
