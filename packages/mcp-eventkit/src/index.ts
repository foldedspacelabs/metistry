// eventkit bridge — §4.3 wire contract over node:http: bearer caller auth
// (CRIT-9), uniform envelope, behavioral check(), and PREVIEW-THEN-CONFIRM
// on the destructive tools (§4.3 default 2): a create returns what would
// change plus a short-lived confirm token; the same request with the token
// executes. Enforced here, not by prompting.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { authorized, errorEnvelope, statusFor, runCheck, type ErrorCode } from "@foldedspacelabs/metistry-core";
import type { Helper } from "./helper.js";
import { bridgeEvent, type HelperEvent } from "./events.js";

export { bridgeEvent, eventKey, selfStatus, PARTICIPANT_STATUSES, type BridgeEvent, type HelperEvent, type HelperParticipant, type Participant } from "./events.js";

export interface BridgeConfig {
  token: string;
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
