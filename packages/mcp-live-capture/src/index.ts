// live-capture bridge — §4.3 wire contract over node:http: bearer caller auth
// (CRIT-9), core's error envelope, a behavioural check(), and TWO credentials
// with two reaches.
//
//   the bridge token     METISTRY_BRIDGE_TOKEN_LIVE_CAPTURE — what the router,
//                        doctor and any tool caller present. Reaches the
//                        manifest's `exposes:` and nothing else: `check` and
//                        `status`, both reads.
//   the control token    METISTRY_LIVE_CAPTURE_CONTROL_TOKEN — the owner's
//                        hand: the capture bar on this Mac (plan §2.2,
//                        "controlling a recording — the app talks to the
//                        local live-capture bridge directly"). Reaches start,
//                        stop and Keep Going as well.
//
// A tool caller that asks to start a recording is refused 403 before the
// helper hears anything: the route is not in `exposes:` AND the credential
// cannot reach it (plan §2.15: no `exposes` entry starts a recording;
// invariant 9; screen 11 §9.6). Enforced here, not by prompting.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { errorEnvelope, parseBearer, runCheck, statusFor, tokenEquals, type CheckResult, type ErrorCode } from "@foldedspacelabs/metistry-core";
import type { HelperClient, HelperResponse } from "./helper.js";

export { DEFAULT_HELPER_TIMEOUT_MS, Helper, type HelperClient, type HelperResponse } from "./helper.js";

export interface BridgeConfig {
  /** The bridge token: tool callers, the router, doctor. */
  token: string;
  /** The owner's control credential: the capture bar. Never the bridge token. */
  controlToken: string;
}

/** Who a request is from, by the credential it carries. */
export type Caller = "tool" | "control";

/**
 * Every route the bridge serves. `tool` names the manifest `exposes:` entry a
 * route answers; a route without one is not a tool and is reachable by the
 * control credential only. The test holds the manifest and this table to each
 * other, so a new exposed route is a decision made in both places.
 */
export const ROUTES = [
  { method: "GET", path: "/check", reach: "any", tool: "check" },
  { method: "GET", path: "/status", reach: "any", tool: "status" },
  { method: "POST", path: "/recording/start", reach: "control" },
  { method: "POST", path: "/recording/stop", reach: "control" },
  { method: "POST", path: "/recording/keep-going", reach: "control" },
] as const satisfies readonly { method: string; path: string; reach: "any" | "control"; tool?: string }[];

/** The helper ops a tool caller can ever cause. Nothing that starts, stops or answers a recording. */
export const TOOL_OPS = ["check", "status"] as const;

// limit: fixed — a start body is a short list of bundle identifiers and two switches.
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

/**
 * The record sheet's body, checked, and rebuilt from its known fields only —
 * nothing else in the body reaches the helper (an `op` in it cannot turn a
 * start into anything else).
 */
export function startPayload(body: unknown): { ok: true; payload: { op: "start"; apps: string[]; app_audio: boolean; microphone: boolean } } | { ok: false; message: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, message: "the body is an object: {apps, app_audio?, microphone?}" };
  const b = body as Record<string, unknown>;
  const unknown = Object.keys(b).filter((k) => !["apps", "app_audio", "microphone"].includes(k));
  if (unknown.length > 0) return { ok: false, message: `unknown field${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}` };
  if (!Array.isArray(b.apps) || b.apps.length === 0 || !b.apps.every((a) => typeof a === "string")) {
    return { ok: false, message: "apps is a non-empty list of bundle identifiers — a recording never hears everything" };
  }
  if (b.apps.length > MAX_SCOPE_APPS) return { ok: false, message: `at most ${MAX_SCOPE_APPS} apps` };
  for (const key of ["app_audio", "microphone"] as const) {
    if (b[key] !== undefined && typeof b[key] !== "boolean") return { ok: false, message: `${key} is true or false` };
  }
  return {
    ok: true,
    payload: { op: "start", apps: b.apps as string[], app_audio: (b.app_audio as boolean | undefined) ?? true, microphone: (b.microphone as boolean | undefined) ?? true },
  };
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
      return fail(res, "conflict", r.error);
    case "stream_failed":
    case "unreachable":
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
export async function check(helper: HelperClient): Promise<CheckResult> {
  return runCheck("live-capture", "asked the helper for its grant states and the on-device transcriber's readiness", async () => {
    const r = await helper.request({ op: "check" });
    if (!r.ok) throw new Error(`${r.error ?? "helper failed"} — is lc-helper running? (its launchd job: T8-2b)`);
    const grants = (r.grants ?? {}) as Record<string, string>;
    const transcriber = (r.transcriber ?? {}) as { available?: boolean; reason?: string };
    const meta = { grants, transcriber: r.transcriber, recording: r.recording, os: r.os };
    if (transcriber.available !== true) {
      return { status: "degraded" as const, remediation: transcriber.reason ?? "the on-device transcriber is not available", meta };
    }
    if (grants.microphone === "denied" || grants.microphone === "restricted") {
      return { status: "degraded" as const, remediation: "the microphone is not allowed — System Settings ▸ Privacy & Security ▸ Microphone; recordings keep app audio only", meta };
    }
    return { meta };
  });
}

export function makeBridge(helper: HelperClient, cfg: BridgeConfig): Server {
  // Two credentials are two reaches only if they differ: refuse to start
  // otherwise, rather than serve a bridge where a tool caller holds the bar's key.
  if (!cfg.token || !cfg.controlToken) throw new Error("live-capture needs both the bridge token and the control token");
  if (tokenEquals(cfg.token, cfg.controlToken)) throw new Error("the control token must not be the bridge token — a tool caller would hold the owner's hand");

  function callerOf(header: string | undefined): Caller | null {
    const presented = parseBearer(header);
    if (presented === null) return null;
    // Both compared, constant-time, whichever matches.
    const control = tokenEquals(presented, cfg.controlToken);
    const tool = tokenEquals(presented, cfg.token);
    return control ? "control" : tool ? "tool" : null;
  }

  return createServer(async (req, res) => {
    try {
      const caller = callerOf(req.headers.authorization);
      if (caller === null) return fail(res, "unauthenticated");
      const url = new URL(req.url ?? "/", "http://x");
      const route = ROUTES.find((r) => r.method === req.method && r.path === url.pathname);
      if (!route) return fail(res, "not_found");
      if (route.reach === "control" && caller !== "control") return fail(res, "forbidden");

      switch (route.path) {
        case "/check": {
          const result = await check(helper);
          return send(res, result.status === "ok" ? 200 : 503, result);
        }
        case "/status": {
          const r = await helper.request({ op: "status" });
          return r.ok ? send(res, 200, { ...body(r), as_of: new Date().toISOString() }) : helperFailure(res, r);
        }
        case "/recording/start": {
          const parsed = startPayload(await readJson(req));
          if (!parsed.ok) return fail(res, "invalid_request", parsed.message);
          const r = await helper.request(parsed.payload);
          return r.ok ? send(res, 201, body(r)) : helperFailure(res, r);
        }
        case "/recording/stop": {
          const r = await helper.request({ op: "stop" });
          return r.ok ? send(res, 200, body(r)) : helperFailure(res, r);
        }
        case "/recording/keep-going": {
          const r = await helper.request({ op: "keep_going" });
          return r.ok ? send(res, 200, body(r)) : helperFailure(res, r);
        }
      }
    } catch (err) {
      if (res.headersSent) return;
      if (err instanceof BadBody) return fail(res, "invalid_request", err.message);
      fail(res, "internal");
    }
  });
}
