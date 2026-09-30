// live-capture bridge — §4.3 wire contract over node:http: bearer caller auth
// (CRIT-9), core's error envelope, a behavioural check(), and TWO credentials
// with two reaches.
//
//   the bridge token     METISTRY_BRIDGE_TOKEN_LIVE_CAPTURE — what the router,
//                        doctor, the console's recording-retention routine and
//                        any tool caller present. Reaches the manifest's
//                        `exposes:` — `check`, `status` and `recording_review`,
//                        all reads — and one `system` route that is not a
//                        tool: the retention routine's ingestion report
//                        (src/review.ts), which can only bring a deletion
//                        the helper's rule allows forward, never cause one.
//   the control token    METISTRY_LIVE_CAPTURE_CONTROL_TOKEN — the owner's
//                        hand: the capture bar on this Mac (plan §2.2,
//                        "controlling a recording — the app talks to the
//                        local live-capture bridge directly"). Reaches start,
//                        stop, Keep Going and Purge Now as well.
//   the inbox token      METISTRY_LIVE_CAPTURE_INBOX_TOKEN — not a credential
//                        this bridge ACCEPTS at all: the capture owner token it
//                        PRESENTS to the console's POST /capture when a
//                        session ends (src/delivery.ts, T8-2b). Optional; must
//                        differ from both of the above.
//
// What a recording takes (C76): `audio_only` — a process tap over the apps
// the body names — or `window` / `screen`, where the body names NOTHING and
// the system picker, presented by the helper, is the only chooser. A window
// id, display id or app list on a picture start is refused here, and again
// by the helper (helper/sources/kit/picture.swift): the picker's choice is
// the only filter the helper builds.
//
// A tool caller that asks to start a recording is refused 403 before the
// helper hears anything: the route is not in `exposes:` AND the credential
// cannot reach it (plan §2.15: no `exposes` entry starts a recording;
// invariant 9; screen 11 §9.6). Enforced here, not by prompting.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { errorEnvelope, parseBearer, runCheck, statusFor, tokenEquals, type CheckResult, type ErrorCode } from "@foldedspacelabs/metistry-core";
import { Deliverer, type DeliveryConfig, type DeliveryState } from "./delivery.js";
import type { HelperClient, HelperResponse } from "./helper.js";
import { purgeBody, retentionBody, retentionState, reviewAnswer, reviewQuery } from "./review.js";

export { DEFAULT_HELPER_TIMEOUT_MS, Helper, type HelperClient, type HelperResponse } from "./helper.js";
export { clock, Deliverer, idempotencyKey, IDEMPOTENCY_PREFIX, renderTranscript, type DeliveryConfig, type DeliveryState, type SessionRecordJson, type TranscriptLine } from "./delivery.js";
export { deletedNote, MAX_REVIEW_SPAN_S, purgeBody, retentionBody, retentionState, reviewAnswer, reviewQuery, SESSION_ID_RE, type RetentionState, type ReviewAnswer, type ReviewLine } from "./review.js";

export interface BridgeConfig {
  /** The bridge token: tool callers, the router, doctor. */
  token: string;
  /** The owner's control credential: the capture bar. Never the bridge token. */
  controlToken: string;
  /**
   * Where an ended session's transcript goes (`POST /capture`) and the
   * capture owner token it is sent with. Absent: transcripts stay on this
   * Mac, and `check` says so.
   */
  delivery?: DeliveryConfig | undefined;
}

/** The bridge, and its delivery loop when it has one (`main.ts` runs the timer; tests call `sweep`). */
export type Bridge = Server & { deliverer?: Deliverer };

/** Who a request is from, by the credential it carries. */
export type Caller = "tool" | "control";

/**
 * Every route the bridge serves. `tool` names the manifest `exposes:` entry a
 * route answers — reach `any`, and always a GET read; a route without one is
 * not a tool. `control` is the owner's hand only; `system` is the bridge
 * token or the control credential, for a caller that is not an agent (the
 * console's retention routine) and is never advertised as a tool. The test
 * holds the manifest and this table to each other, so a new exposed route is
 * a decision made in both places.
 */
export const ROUTES = [
  { method: "GET", path: "/check", reach: "any", tool: "check" },
  { method: "GET", path: "/status", reach: "any", tool: "status" },
  { method: "GET", path: "/recording/review", reach: "any", tool: "recording_review" },
  { method: "POST", path: "/recording/retention", reach: "system" },
  { method: "POST", path: "/recording/start", reach: "control" },
  { method: "POST", path: "/recording/stop", reach: "control" },
  { method: "POST", path: "/recording/keep-going", reach: "control" },
  { method: "POST", path: "/recording/purge", reach: "control" },
] as const satisfies readonly { method: string; path: string; reach: "any" | "system" | "control"; tool?: string }[];

/** The helper ops a tool caller can ever cause. Nothing that starts, stops, answers or deletes a recording. */
export const TOOL_OPS = ["check", "status", "review"] as const;
/** …and the one more the bridge token reaches off the tool list: the routine's report (`system`). Never `purge`. */
export const SYSTEM_OPS = ["retention"] as const;

/** The record sheet's three acts (C76). */
export const CAPTURE_MODES = ["audio_only", "window", "screen"] as const;
export type CaptureMode = (typeof CAPTURE_MODES)[number];

// limit: fixed — a start body is a mode, a short list of bundle identifiers and two switches.
const MAX_BODY_BYTES = 16 * 1024;
// limit: fixed — the record sheet's list, matched by the helper's own cap (helper/sources/kit/scope.swift).
const MAX_SCOPE_APPS = 16;

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function fail(res: ServerResponse, code: ErrorCode, message?: string): void {
  send(res, statusFor(code), errorEnvelope(code, message));
}

class BadBody extends Error {}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new BadBody("body too large");
    chunks.push(c as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new BadBody("body is not JSON");
  }
}

export type StartPayload =
  | { op: "start"; mode: "audio_only"; apps: string[]; app_audio: boolean; microphone: boolean }
  | { op: "start"; mode: "window" | "screen"; app_audio: boolean; microphone: boolean };

/**
 * The record sheet's body, checked, and rebuilt from its known fields only —
 * nothing else in the body reaches the helper (an `op` in it cannot turn a
 * start into anything else, and no window, display or filter can ride along).
 * `window` and `screen` take no `apps`: the picker chooses.
 */
export function startPayload(body: unknown): { ok: true; payload: StartPayload } | { ok: false; message: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, message: "the body is an object: {mode?, apps?, app_audio?, microphone?}" };
  const b = body as Record<string, unknown>;
  const unknown = Object.keys(b).filter((k) => !["mode", "apps", "app_audio", "microphone"].includes(k));
  if (unknown.length > 0) return { ok: false, message: `unknown field${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}` };
  const mode = b.mode ?? "audio_only";
  if (typeof mode !== "string" || !(CAPTURE_MODES as readonly string[]).includes(mode)) return { ok: false, message: `mode is one of ${CAPTURE_MODES.join(", ")}` };
  for (const key of ["app_audio", "microphone"] as const) {
    if (b[key] !== undefined && typeof b[key] !== "boolean") return { ok: false, message: `${key} is true or false` };
  }
  const app_audio = (b.app_audio as boolean | undefined) ?? true;
  const microphone = (b.microphone as boolean | undefined) ?? true;
  if (mode === "window" || mode === "screen") {
    if (b.apps !== undefined) return { ok: false, message: `${mode} is chosen in the macOS picker — a start names no apps, window or display` };
    return { ok: true, payload: { op: "start", mode, app_audio, microphone } };
  }
  if (!Array.isArray(b.apps) || b.apps.length === 0 || !b.apps.every((a) => typeof a === "string")) {
    return { ok: false, message: "apps is a non-empty list of bundle identifiers — a recording never hears everything" };
  }
  if (b.apps.length > MAX_SCOPE_APPS) return { ok: false, message: `at most ${MAX_SCOPE_APPS} apps` };
  return { ok: true, payload: { op: "start", mode: "audio_only", apps: b.apps as string[], app_audio, microphone } };
}

/** A helper refusal, onto core's envelope, in the owner's words. */
function helperFailure(res: ServerResponse, r: HelperResponse): void {
  switch (r.code) {
    case "invalid_request":
    case "invalid_scope":
    case "nothing_to_record":
      return fail(res, "invalid_request", r.error);
    case "already_recording":
    case "disk_full":
    case "still_recording":
      return fail(res, "conflict", r.error);
    case "unknown_session":
      return fail(res, "not_found", r.error);
    case "stream_failed":
    case "unreachable":
    case "not_available":
    case "no_transcriber":
    case "review_failed":
      return fail(res, "not_available", r.error);
    default:
      return fail(res, "internal");
  }
}

/** The helper's answer without its envelope fields. */
function body(r: HelperResponse): Record<string, unknown> {
  const { id: _id, ok: _ok, ...rest } = r;
  return rest;
}

/**
 * check(): the grants and the transcriber (T8-2a's acceptance). `ok` when the
 * transcriber can run and nothing refuses the microphone; `degraded` when a
 * recording would work without a transcript, or without the owner's side;
 * `failed` when the helper does not answer.
 */
export async function check(helper: HelperClient, deliverer?: Deliverer): Promise<CheckResult> {
  return runCheck("live-capture", "asked the helper for its grant states and the on-device transcriber's readiness; read the transcript delivery's last sweep", async () => {
    const r = await helper.request({ op: "check" });
    if (!r.ok) throw new Error(`${r.error ?? "helper failed"} — is lc-helper running? (its launchd job: com.foldedspacelabs.metistry.recorder — metistry doctor names it)`);
    const grants = (r.grants ?? {}) as Record<string, string>;
    const transcriber = (r.transcriber ?? {}) as { available?: boolean; reason?: string };
    const delivery: DeliveryState | "off" = deliverer ? deliverer.state() : "off";
    const meta = { grants, transcriber: r.transcriber, recording: r.recording, os: r.os, delivery };
    if (transcriber.available !== true) {
      return { status: "degraded" as const, remediation: transcriber.reason ?? "the on-device transcriber is not available", meta };
    }
    if (grants.microphone === "denied" || grants.microphone === "restricted") {
      return { status: "degraded" as const, remediation: "the microphone is not allowed — System Settings ▸ Privacy & Security ▸ Microphone; recordings keep app audio only", meta };
    }
    if (delivery === "off") {
      return { status: "degraded" as const, remediation: "transcripts are kept on this Mac and never reach Metistry — set METISTRY_LIVE_CAPTURE_INBOX_TOKEN to a capture owner token (docs/ops/capture-shortcut.md §1) and restart the bridge", meta };
    }
    if (delivery.last_error !== undefined && delivery.owed > 0) {
      return { status: "degraded" as const, remediation: `${delivery.owed} recording${delivery.owed === 1 ? "" : "s"} not yet delivered: ${delivery.last_error}`, meta };
    }
    return { meta };
  });
}

export function makeBridge(helper: HelperClient, cfg: BridgeConfig): Bridge {
  // Two credentials are two reaches only if they differ: refuse to start
  // otherwise, rather than serve a bridge where a tool caller holds the bar's key.
  if (!cfg.token || !cfg.controlToken) throw new Error("live-capture needs both the bridge token and the control token");
  if (tokenEquals(cfg.token, cfg.controlToken)) throw new Error("the control token must not be the bridge token — a tool caller would hold the owner's hand");
  // …and the console credential is a third thing: a caller presenting it here
  // must be refused like any stranger, which only holds if it is neither key.
  if (cfg.delivery) {
    if (tokenEquals(cfg.delivery.inboxToken, cfg.token)) throw new Error("the inbox token must not be the bridge token — a tool caller would hold a console credential");
    if (tokenEquals(cfg.delivery.inboxToken, cfg.controlToken)) throw new Error("the inbox token must not be the control token — each credential is one reach");
  }
  const deliverer = cfg.delivery ? new Deliverer(helper, cfg.delivery) : undefined;

  function callerOf(header: string | undefined): Caller | null {
    const presented = parseBearer(header);
    if (presented === null) return null;
    // Both compared, constant-time, whichever matches.
    const control = tokenEquals(presented, cfg.controlToken);
    const tool = tokenEquals(presented, cfg.token);
    return control ? "control" : tool ? "tool" : null;
  }

  const server: Bridge = createServer(async (req, res) => {
    try {
      const caller = callerOf(req.headers.authorization);
      if (caller === null) return fail(res, "unauthenticated");
      const url = new URL(req.url ?? "/", "http://x");
      const route = ROUTES.find((r) => r.method === req.method && r.path === url.pathname);
      if (!route) return fail(res, "not_found");
      if (route.reach === "control" && caller !== "control") return fail(res, "forbidden");
      // `system`: the bridge token or the control credential — both already authenticated above.

      switch (route.path) {
        case "/check": {
          const result = await check(helper, deliverer);
          return send(res, result.status === "ok" ? 200 : 503, result);
        }
        case "/status": {
          const r = await helper.request({ op: "status" });
          // `delivery`: how many ended recordings still owe their transcript — a count, never text
          return r.ok ? send(res, 200, { ...body(r), delivery: deliverer ? { owed: deliverer.state().owed } : "off", as_of: new Date().toISOString() }) : helperFailure(res, r);
        }
        case "/recording/start": {
          const parsed = startPayload(await readJson(req));
          if (!parsed.ok) return fail(res, "invalid_request", parsed.message);
          const r = await helper.request(parsed.payload);
          return r.ok ? send(res, 201, body(r)) : helperFailure(res, r);
        }
        case "/recording/stop": {
          const r = await helper.request({ op: "stop" });
          if (!r.ok) return helperFailure(res, r);
          send(res, 200, body(r));
          // The end of a session: its transcript goes now, not at the next
          // tick. After the answer — the owner's Stop never waits on the console.
          void deliverer?.sweep().catch(() => undefined);
          return;
        }
        case "/recording/keep-going": {
          const r = await helper.request({ op: "keep_going" });
          return r.ok ? send(res, 200, body(r)) : helperFailure(res, r);
        }
        case "/recording/review": {
          // recording_review (T8-4): text with timestamps, never audio —
          // the answer is rebuilt from known fields (src/review.ts).
          const q = reviewQuery(url.searchParams);
          if (!q.ok) return fail(res, "invalid_request", q.message);
          const r = await helper.request(q.payload);
          if (!r.ok) return helperFailure(res, r);
          return send(res, 200, reviewAnswer(r, { session_id: q.payload.session_id, from_s: q.payload.from_s, to_s: q.payload.to_s, ...(q.question !== undefined ? { question: q.question } : {}) }));
        }
        case "/recording/retention": {
          const b = retentionBody(await readJson(req));
          if (!b.ok) return fail(res, "invalid_request", b.message);
          const r = await helper.request(b.payload);
          if (!r.ok) return helperFailure(res, r);
          const state = retentionState(r);
          return state ? send(res, 200, { ...state, as_of: new Date().toISOString() }) : fail(res, "internal");
        }
        case "/recording/purge": {
          const b = purgeBody(await readJson(req));
          if (!b.ok) return fail(res, "invalid_request", b.message);
          const r = await helper.request(b.payload);
          if (!r.ok) return helperFailure(res, r);
          const state = retentionState(r);
          return state ? send(res, 200, { ...state, as_of: new Date().toISOString() }) : fail(res, "internal");
        }
      }
    } catch (err) {
      if (res.headersSent) return;
      if (err instanceof BadBody) return fail(res, "invalid_request", err.message);
      fail(res, "internal");
    }
  });
  if (deliverer) server.deliverer = deliverer;
  return server;
}
