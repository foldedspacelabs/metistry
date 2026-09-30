// Wire-contract and misuse tests with a scripted fake helper. The real
// helper's decisions are tested in Swift (helper/tests, run by
// test/helper-kit.test.ts on a Mac); nothing here touches audio or a grant.
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { parse as parseYaml } from "yaml";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { checkResultSchema, CREW_NEVER_TOOLS, mintToken, validateManifest } from "@foldedspacelabs/metistry-core";
import { makeBridge, ROUTES, startPayload, SYSTEM_OPS, TOOL_OPS, type HelperResponse } from "../src/index.js";

const token = mintToken();
const controlToken = mintToken();
const inboxToken = mintToken();
/** The console, faked at the fetch seam: delivery's own tests (delivery.test.ts) use a real socket. */
const consoleFetch = (async () => new Response(JSON.stringify({ id: 7, path: "Inbox/x.md", sha256: "0" }), { status: 201 })) as typeof fetch;

/** Every request the bridge made of the helper — to prove what it never asks for. */
const asked: Record<string, unknown>[] = [];
let checkAnswer: HelperResponse;
let startAnswer: HelperResponse;
let reviewAnswerFake: HelperResponse;
let retentionAnswer: HelperResponse;
let reachable = true;

const fakeHelper = {
  async request(p: Record<string, unknown>): Promise<HelperResponse> {
    asked.push(p);
    if (!reachable) return { id: 1, ok: false, code: "unreachable", error: "helper unreachable: ENOENT" };
    switch (p.op) {
      case "check": return checkAnswer;
      case "status": return { id: 1, ok: true, state: "idle", session: null, elapsed_s: null, stops_at: null, reminder_due_hours: null, disk_low_free_bytes: null, senses: { display: false, app_audio: false, microphone: false } };
      case "start": return startAnswer;
      case "stop": return { id: 1, ok: true, session: { session_id: "20260928-120000-00ab", ended_reason: "owner" } };
      case "keep_going": return { id: 1, ok: true, answered: true };
      case "owed": return { id: 1, ok: true, sessions: [] };
      case "review": return reviewAnswerFake;
      case "retention":
      case "purge": return retentionAnswer;
      default: return { id: 1, ok: false, code: "invalid_request", error: `unknown op ${String(p.op)}` };
    }
  },
};

/** An ended, delivered session record as the helper's retention ops answer it. */
const ended = {
  session_id: "20260928-120000-00ab", started_at: "2026-09-28T12:00:00Z", state: "ended", ended_at: "2026-09-28T12:10:00Z", ended_reason: "owner",
  apps: ["us.zoom.xos"], gaps: [], delivery: { inbox_id: 42, at: "2026-09-28T12:11:00Z" },
};

const healthy: HelperResponse = {
  id: 1, ok: true, recording: false, os: "26.4",
  grants: { microphone: "granted", audio_capture: "observed", screen_recording: "not_granted" },
  transcriber: { engine: "SpeechTranscriber", available: true, assets: "installed", locale: "en_US" },
};

describe("live-capture bridge", () => {
  let base: string;
  let server: ReturnType<typeof makeBridge>;
  const as = (t: string | null) => ({ ...(t ? { authorization: `Bearer ${t}` } : {}), "content-type": "application/json" });
  const call = (method: string, path: string, t: string | null, body?: unknown) =>
    fetch(`${base}${path}`, { method, headers: as(t), ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}) });
  const ops = () => asked.map((p) => p.op);

  beforeAll(async () => {
    server = makeBridge(fakeHelper, { token, controlToken, delivery: { consoleUrl: "http://127.0.0.1:9", inboxToken, fetchFn: consoleFetch } });
    // port 0: never 7815, so a run can never collide with a bridge this Mac is running
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => new Promise<void>((r) => server.close(() => r())));
  beforeEach(() => {
    asked.length = 0;
    reachable = true;
    checkAnswer = healthy;
    startAnswer = { id: 1, ok: true, session: { session_id: "20260928-120000-00ab", apps: ["us.zoom.xos"], state: "recording" }, transcriber: healthy.transcriber };
    reviewAnswerFake = { id: 1, ok: true, session_id: "20260928-120000-00ab", from_s: 160, to_s: 170, audio: "kept", lines: [{ source: "app", from_s: 160.5, to_s: 162, text: "the numbers are in" }] };
    retentionAnswer = { id: 1, ok: true, session: { ...ended, media_bytes: 2000, audio_delete_after: "2026-10-05T12:30:00Z", audio_deleted_at: null, transcript_delete_after: "2026-10-28T12:10:00Z" } };
  });

  // ---- CRIT-9: every route authenticates ----

  it("refuses a missing or wrong bearer on every route, uniformly, before the helper hears anything", async () => {
    for (const r of ROUTES) {
      for (const t of [null, mintToken()]) {
        const res = await call(r.method, r.path, t, r.method === "POST" ? { apps: ["us.zoom.xos"] } : undefined);
        expect(res.status, `${r.method} ${r.path}`).toBe(401);
        expect(await res.json()).toEqual({ error: { code: "unauthenticated", message: "authentication required" } });
      }
    }
    expect(asked).toEqual([]);
  });

  it("refuses to serve when the control token is the bridge token, or either is missing", () => {
    expect(() => makeBridge(fakeHelper, { token, controlToken: token })).toThrow(/must not be the bridge token/);
    expect(() => makeBridge(fakeHelper, { token, controlToken: "" })).toThrow(/both/);
    expect(() => makeBridge(fakeHelper, { token: "", controlToken })).toThrow(/both/);
  });

  it("refuses to serve when the inbox token is either of the bridge's own — a console credential is its own reach", () => {
    const delivery = (t: string) => ({ consoleUrl: "http://127.0.0.1:9", inboxToken: t, fetchFn: consoleFetch });
    expect(() => makeBridge(fakeHelper, { token, controlToken, delivery: delivery(token) })).toThrow(/inbox token must not be the bridge token/);
    expect(() => makeBridge(fakeHelper, { token, controlToken, delivery: delivery(controlToken) })).toThrow(/inbox token must not be the control token/);
    expect(() => makeBridge(fakeHelper, { token, controlToken, delivery: delivery("") })).toThrow(/capture owner token/);
  });

  it("the inbox token is not a credential here: presented to the bridge it is a stranger's, 401 on every route", async () => {
    for (const r of ROUTES) {
      const res = await call(r.method, r.path, inboxToken, r.method === "POST" ? { apps: ["us.zoom.xos"] } : undefined);
      expect(res.status, `${r.method} ${r.path}`).toBe(401);
    }
    expect(asked).toEqual([]);
  });

  // ---- the ticket's test: no `exposes` entry starts a recording ----

  it("no exposes entry starts a recording", async () => {
    const parsed = validateManifest(parseYaml(readFileSync(new URL("../manifest.yaml", import.meta.url), "utf8")));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.manifest.type !== "bridge") throw new Error("not a bridge manifest");
    const exposed = parsed.manifest.exposes.map((e) => e.name).sort();

    // The manifest and the route table say the same thing about what is a tool.
    const toolRoutes = ROUTES.filter((r) => "tool" in r);
    expect(exposed).toEqual(toolRoutes.map((r) => r.tool).sort());
    expect(parsed.manifest.exposes.every((e) => !e.destructive)).toBe(true);

    // Every exposed tool is a read, and calling each with the tool credential
    // asks the helper for nothing but a read.
    for (const name of exposed) {
      const route = toolRoutes.find((r) => r.tool === name)!;
      expect(route.method, name).toBe("GET");
      expect(route.reach, name).toBe("any");
      const res = await call(route.method, route.path, token);
      expect(res.status, name).toBeLessThan(500);
    }
    expect(ops().every((op) => (TOOL_OPS as readonly unknown[]).includes(op))).toBe(true);
    expect(ops()).not.toContain("start");
  });

  it("the tool credential is refused 403 on every route that is the owner's hand, and the helper hears nothing", async () => {
    const control = ROUTES.filter((r) => r.reach === "control");
    expect(control.map((r) => r.path).sort()).toEqual(["/recording/keep-going", "/recording/purge", "/recording/start", "/recording/stop"]);
    for (const r of control) {
      const res = await call(r.method, r.path, token, { apps: ["us.zoom.xos"] });
      expect(res.status, r.path).toBe(403);
      expect(await res.json()).toEqual({ error: { code: "forbidden", message: "not granted" } });
    }
    expect(asked).toEqual([]);
  });

  it("the owner's control credential reaches start, stop and Keep Going", async () => {
    const started = await call("POST", "/recording/start", controlToken, { apps: ["us.zoom.xos"], microphone: false });
    expect(started.status).toBe(201);
    expect((await started.json()).session.session_id).toBe("20260928-120000-00ab");
    expect(asked[0]).toEqual({ op: "start", mode: "audio_only", apps: ["us.zoom.xos"], app_audio: true, microphone: false });

    expect((await call("POST", "/recording/keep-going", controlToken)).status).toBe(200);
    const stopped = await call("POST", "/recording/stop", controlToken);
    expect(stopped.status).toBe(200);
    expect((await stopped.json()).session.ended_reason).toBe("owner");
    // …and the end of the session starts its delivery (after the answer: Stop never waits on the console)
    await vi.waitFor(() => expect(ops()).toEqual(["start", "keep_going", "stop", "owed"]));
  });

  it("the control credential reads check and status too", async () => {
    expect((await call("GET", "/status", controlToken)).status).toBe(200);
    expect((await call("GET", "/check", controlToken)).status).toBe(200);
  });

  // ---- the record sheet's body ----

  it("a start body is rebuilt from its known fields — nothing else reaches the helper", async () => {
    for (const bad of [
      {},
      { apps: [] },
      { apps: "us.zoom.xos" },
      { apps: [42] },
      { apps: ["us.zoom.xos"], microphone: "yes" },
      { apps: ["us.zoom.xos"], op: "stop" },
      { apps: ["us.zoom.xos"], exclusive: true },
      { apps: Array.from({ length: 17 }, (_, i) => `com.example.app${i}`) },
      ["us.zoom.xos"],
    ]) {
      const res = await call("POST", "/recording/start", controlToken, bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect((await res.json()).error.code).toBe("invalid_request");
    }
    expect((await call("POST", "/recording/start", controlToken, "{not json")).status).toBe(400);
    expect((await call("POST", "/recording/start", controlToken, JSON.stringify({ apps: ["a.b"], pad: "x".repeat(20_000) }))).status).toBe(400);
    expect(asked).toEqual([]);
    expect(startPayload({ apps: ["us.zoom.xos"] })).toEqual({ ok: true, payload: { op: "start", mode: "audio_only", apps: ["us.zoom.xos"], app_audio: true, microphone: true } });
  });

  // ---- T8-3: Window and Screen — the picker's choice is the only filter ----

  it("the tool credential cannot start a window or screen recording: 403, and the picker is never asked", async () => {
    for (const body of [{ mode: "window" }, { mode: "screen" }, { mode: "window", app_audio: true, microphone: true }]) {
      for (const [t, status] of [[token, 403], [null, 401], [inboxToken, 401], [mintToken(), 401]] as const) {
        const res = await call("POST", "/recording/start", t, body);
        expect(res.status, `${JSON.stringify(body)} as ${t === token ? "the tool" : "a stranger"}`).toBe(status);
      }
    }
    expect(asked).toEqual([]);
  });

  it("the control credential starts Window and Screen with a body that names no content", async () => {
    startAnswer = { id: 1, ok: true, session: { session_id: "20260930-120000-00ab", mode: "window", picture: { kind: "window", bundle_id: "us.zoom.xos" }, apps: ["us.zoom.xos"], state: "recording" } };
    const w = await call("POST", "/recording/start", controlToken, { mode: "window", microphone: false });
    expect(w.status).toBe(201);
    expect((await w.json()).session.picture).toEqual({ kind: "window", bundle_id: "us.zoom.xos" });
    const s = await call("POST", "/recording/start", controlToken, { mode: "screen" });
    expect(s.status).toBe(201);
    // exactly the mode and two switches reach the helper — no apps, no window, no display
    expect(asked).toEqual([
      { op: "start", mode: "window", app_audio: true, microphone: false },
      { op: "start", mode: "screen", app_audio: true, microphone: true },
    ]);
  });

  it("a Window or Screen start that names content is refused before the helper hears it", async () => {
    for (const bad of [
      { mode: "window", apps: ["us.zoom.xos"] },
      { mode: "screen", apps: [] },
      { mode: "window", window_id: 12 },
      { mode: "screen", display_id: 1 },
      { mode: "window", bundle_ids: ["us.zoom.xos"] },
      { mode: "window", filter: { display: 1, excluding: [] } },
      { mode: "screen", exclude: ["com.foldedspacelabs.metistry.live-capture"] },
      { mode: "display" },
      { mode: "everything" },
      { mode: "" },
      { mode: null },
      { mode: 1 },
      { mode: ["window"] },
      { mode: "window", microphone: "yes" },
    ]) {
      const res = await call("POST", "/recording/start", controlToken, bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect((await res.json()).error.code).toBe("invalid_request");
    }
    expect(asked).toEqual([]);
  });

  it("the helper's picture refusals reach the owner: a cancelled picker, a wrong pick, no ScreenCaptureKit", async () => {
    startAnswer = { id: 1, ok: false, code: "invalid_scope", error: "nothing was chosen in the picker — a recording never sees everything" };
    const cancelled = await call("POST", "/recording/start", controlToken, { mode: "window" });
    expect(cancelled.status).toBe(400);
    expect(await cancelled.json()).toEqual({ error: { code: "invalid_request", message: "nothing was chosen in the picker — a recording never sees everything" } });

    startAnswer = { id: 1, ok: false, code: "not_available", error: "recording a window or the screen is not available on this Mac — use Audio only" };
    const unavailable = await call("POST", "/recording/start", controlToken, { mode: "screen" });
    expect(unavailable.status).toBe(503);
    expect((await unavailable.json()).error.message).toMatch(/use Audio only/);
  });

  it("the helper's refusals reach the owner in its words, on core's envelope", async () => {
    startAnswer = { id: 1, ok: false, code: "invalid_scope", error: "choose at least one app to record — a recording never hears everything" };
    const scope = await call("POST", "/recording/start", controlToken, { apps: ["*"] });
    expect(scope.status).toBe(400);
    expect(await scope.json()).toEqual({ error: { code: "invalid_request", message: "choose at least one app to record — a recording never hears everything" } });

    startAnswer = { id: 1, ok: false, code: "already_recording", error: "already recording (session x) — stop it first" };
    expect((await call("POST", "/recording/start", controlToken, { apps: ["us.zoom.xos"] })).status).toBe(409);

    startAnswer = { id: 1, ok: false, code: "something_new", error: "internal detail" };
    const unknown = await call("POST", "/recording/start", controlToken, { apps: ["us.zoom.xos"] });
    expect(unknown.status).toBe(500);
    expect(await unknown.json()).toEqual({ error: { code: "internal", message: "internal error" } });
  });

  it("unknown routes and methods are 404 to either credential", async () => {
    expect((await call("GET", "/recording/start", controlToken)).status).toBe(404);
    expect((await call("POST", "/record", controlToken, {})).status).toBe(404);
    expect((await call("GET", "/transcript", token)).status).toBe(404);
  });

  // ---- acceptance: check() reports the grants and the transcriber ----

  it("check() reports the grants and the transcriber in the frozen shape", async () => {
    const res = await call("GET", "/check", token);
    expect(res.status).toBe(200);
    const c = await res.json();
    expect(checkResultSchema.parse(c)).toBeTruthy();
    expect(c).toMatchObject({
      name: "live-capture",
      status: "ok",
      meta: {
        grants: { microphone: "granted", audio_capture: "observed", screen_recording: "not_granted" },
        transcriber: { engine: "SpeechTranscriber", available: true, assets: "installed", locale: "en_US" },
        recording: false,
      },
    });
  });

  it("check() is degraded, with the transcriber's reason, when there is no on-device transcriber", async () => {
    checkAnswer = { ...healthy, os: "15.5", transcriber: { engine: "SpeechTranscriber", available: false, assets: "unsupported", locale: null, reason: "on-device transcription needs macOS 26 — recordings are kept without a transcript" } };
    const res = await call("GET", "/check", token);
    expect(res.status).toBe(503);
    const c = await res.json();
    expect(c.status).toBe("degraded");
    expect(c.remediation).toMatch(/macOS 26/);
    expect(c.meta.grants.microphone).toBe("granted");
  });

  it("check() is degraded when the microphone is refused, and says where to allow it", async () => {
    checkAnswer = { ...healthy, grants: { microphone: "denied", audio_capture: "unverified", screen_recording: "not_granted" } };
    const c = await (await call("GET", "/check", token)).json();
    expect(c.status).toBe("degraded");
    expect(c.remediation).toMatch(/Privacy & Security ▸ Microphone/);
  });

  it("check() fails, with a remediation, when the helper does not answer", async () => {
    reachable = false;
    const res = await call("GET", "/check", token);
    expect(res.status).toBe(503);
    const c = await res.json();
    expect(c.status).toBe("failed");
    expect(c.remediation).toMatch(/lc-helper/);
  });

  it("check() is degraded when there is nowhere to deliver a transcript, and names the variable", async () => {
    const off = makeBridge(fakeHelper, { token, controlToken });
    await new Promise<void>((r) => off.listen(0, "127.0.0.1", r));
    try {
      const res = await fetch(`http://127.0.0.1:${(off.address() as AddressInfo).port}/check`, { headers: as(token) });
      expect(res.status).toBe(503);
      const c = await res.json();
      expect(c.status).toBe("degraded");
      expect(c.remediation).toMatch(/METISTRY_LIVE_CAPTURE_INBOX_TOKEN/);
      expect(c.meta.delivery).toBe("off");
    } finally {
      await new Promise<void>((r) => off.close(() => r()));
    }
  });

  it("status is a read with an as_of stamp, and never carries a transcript", async () => {
    const s = await (await call("GET", "/status", token)).json();
    expect(s).toMatchObject({ state: "idle", delivery: { owed: 0 }, senses: { display: false, app_audio: false, microphone: false } });
    expect(s.as_of).toBeTruthy();
    expect(JSON.stringify(s)).not.toMatch(/transcript|"text"/);
  });
  // ---- T8-4: recording_review, the retention report, Purge Now ----

  const review = (t: string | null, q: string) => call("GET", `/recording/review?${q}`, t);
  const span = "session_id=20260928-120000-00ab&from_s=160&to_s=170";

  it("recording_review returns text only — rebuilt field by field, so nothing the helper adds rides out to a model", async () => {
    reviewAnswerFake = {
      id: 1, ok: true, audio: "kept", session_id: "20260928-120000-00ab",
      // what a confused or compromised helper might add: audio, a path, a buffer
      audio_base64: "UklGRg==", file: "/Users/x/.metistry/state/capture/20260928-120000-00ab/app.m4a",
      lines: [
        { source: "mic", from_s: 161, to_s: 163, text: "send them\nover", samples: [0.1, 0.2] },
        { source: "app", from_s: 160.5, to_s: 162, text: "the numbers are in", pcm: "AAAA" },
        { source: "screen", from_s: 1, to_s: 2, text: "not a source" },
        { source: "app", from_s: "1", to_s: 2, text: "a string time" },
        { source: "app", from_s: 1, to_s: 2, text: { audio: "x" } },
      ],
    };
    const res = await review(token, `${span}&question=${encodeURIComponent("did they say Q3 or Q4?")}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    const a = await res.json();
    expect(Object.keys(a).sort()).toEqual(["as_of", "audio", "from_s", "lines", "question", "session_id", "text", "to_s"]);
    expect(a.lines).toEqual([
      { source: "app", speaker: "apps", from_s: 160.5, to_s: 162, at: "00:02:40", text: "the numbers are in" },
      { source: "mic", speaker: "you", from_s: 161, to_s: 163, at: "00:02:41", text: "send them over" },
    ]);
    expect(a.text).toBe("[00:02:40] (apps) the numbers are in\n[00:02:41] (you) send them over");
    expect(a.question).toBe("did they say Q3 or Q4?");
    const wire = JSON.stringify(a);
    for (const leak of ["UklGRg", "app.m4a", "samples", "pcm", "AAAA", "screen", "state/capture"]) expect(wire).not.toContain(leak);
    // the helper was asked for the span and nothing else — the question never reaches it
    expect(asked).toEqual([{ op: "review", session_id: "20260928-120000-00ab", from_s: 160, to_s: 170 }]);
  });

  it("recording_review says when the audio was deleted — after the fold, by the ceiling, or by Purge Now — and that the transcript remains", async () => {
    const deleted = (session: Record<string, unknown>) => ({ id: 1, ok: true, audio: "deleted", lines: [], session: { ...ended, audio_deleted_at: "2026-10-05T12:11:00Z", ...session } });
    reviewAnswerFake = deleted({ audio_deleted_reason: "retention", ingested_at: "2026-09-28T13:00:00Z" });
    const a = await (await review(token, span)).json();
    expect(a).toMatchObject({ audio: "deleted", lines: [], text: "", audio_deleted_at: "2026-10-05T12:11:00.000Z", note: "Audio deleted on 2026-10-05 after the fold; the transcript remains." });

    reviewAnswerFake = deleted({ audio_deleted_reason: "retention", audio_deleted_at: "2026-10-28T12:10:00Z" });
    expect((await (await review(token, span)).json()).note).toBe("Audio deleted on 2026-10-28 30 days after the recording; the transcript remains.");
    reviewAnswerFake = deleted({ audio_deleted_reason: "owner" });
    expect((await (await review(token, span)).json()).note).toBe("Audio deleted on 2026-10-05 by Purge Now; the transcript remains.");
    reviewAnswerFake = deleted({ audio_deleted_reason: "retention", audio_deleted_at: "2026-10-28T12:10:00Z", transcript_deleted_at: "2026-10-28T12:10:00Z" });
    expect((await (await review(token, span)).json()).note).toBe("Audio deleted on 2026-10-28 30 days after the recording; the transcript was deleted on 2026-10-28.");
  });

  it("recording_review refuses a malformed span before the helper hears anything", async () => {
    for (const q of [
      "",
      "session_id=../etc&from_s=0&to_s=10",
      "session_id=ABC&from_s=0&to_s=10",
      "session_id=20260928-120000-00ab&from_s=-1&to_s=10",
      "session_id=20260928-120000-00ab&from_s=10&to_s=10",
      "session_id=20260928-120000-00ab&from_s=1e3&to_s=2e3",
      "session_id=20260928-120000-00ab&from_s=0&to_s=901",
      "session_id=20260928-120000-00ab&from_s=0&to_s=10&from_s=5",
      "session_id=20260928-120000-00ab&from_s=0&to_s=10&op=start",
      `session_id=20260928-120000-00ab&from_s=0&to_s=10&question=${"x".repeat(501)}`,
      "session_id=20260928-120000-00ab&from_s=0&to_s=10&question=",
    ]) {
      const res = await review(token, q);
      expect(res.status, q).toBe(400);
      expect((await res.json()).error.code).toBe("invalid_request");
    }
    expect(asked).toEqual([]);
  });

  it("recording_review: the helper's refusals in its words — no transcriber, an unknown session, one still recording", async () => {
    reviewAnswerFake = { id: 1, ok: false, code: "no_transcriber", error: "the on-device transcriber is not available on this Mac (macOS 26)" };
    const none = await review(token, span);
    expect(none.status).toBe(503);
    expect((await none.json()).error).toEqual({ code: "not_available", message: "the on-device transcriber is not available on this Mac (macOS 26)" });
    reviewAnswerFake = { id: 1, ok: false, code: "unknown_session", error: "no session 20260928-120000-00ab" };
    expect((await review(token, span)).status).toBe(404);
    reviewAnswerFake = { id: 1, ok: false, code: "still_recording", error: "still recording" };
    expect((await review(token, span)).status).toBe(409);
  });

  it("recording_review is never a crew's: core's CREW_NEVER_TOOLS names it", () => {
    expect(CREW_NEVER_TOOLS as readonly string[]).toContain("recording_review");
  });

  it("the retention report (system reach): the bridge token reaches it, off the tool list, rebuilt from its two fields", async () => {
    const r = ROUTES.find((x) => x.path === "/recording/retention")!;
    expect(r.reach).toBe("system");
    expect("tool" in r).toBe(false);
    for (const t of [token, controlToken]) {
      asked.length = 0;
      const res = await call("POST", "/recording/retention", t, { session_id: "20260928-120000-00ab", ingested_at: "2026-09-28T13:00:00+00:00" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ session_id: "20260928-120000-00ab", media_bytes: 2000, audio_delete_after: "2026-10-05T12:30:00.000Z", delivered_inbox_id: 42 });
      expect(JSON.stringify(body)).not.toMatch(/"text"|"lines"/);
      expect(asked).toEqual([{ op: "retention", session_id: "20260928-120000-00ab", ingested_at: "2026-09-28T13:00:00.000Z" }]);
    }
    asked.length = 0;
    for (const bad of [{}, { session_id: "../x" }, { session_id: "20260928-120000-00ab", ingested_at: "soon" }, { session_id: "20260928-120000-00ab", op: "purge" }, []]) {
      const res = await call("POST", "/recording/retention", token, bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect(asked).toEqual([]);
    // what the bridge token can cause, at most: reads, the review, and this report — never a purge
    expect([...TOOL_OPS, ...SYSTEM_OPS]).not.toContain("purge");
  });

  it("Purge Now is the owner's hand: the control credential only, {session_id} and nothing else", async () => {
    expect((await call("POST", "/recording/purge", token, { session_id: "20260928-120000-00ab" })).status).toBe(403);
    expect(asked).toEqual([]);
    retentionAnswer = { id: 1, ok: true, session: { ...ended, media_bytes: 0, audio_deleted_at: "2026-09-30T09:00:00Z", audio_deleted_reason: "owner" } };
    const res = await call("POST", "/recording/purge", controlToken, { session_id: "20260928-120000-00ab" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ session_id: "20260928-120000-00ab", media_bytes: 0, audio_deleted_reason: "owner", audio_deleted_at: "2026-09-30T09:00:00.000Z" });
    expect(asked).toEqual([{ op: "purge", session_id: "20260928-120000-00ab" }]);
    expect((await call("POST", "/recording/purge", controlToken, { session_id: "20260928-120000-00ab", all: true })).status).toBe(400);
  });
});
