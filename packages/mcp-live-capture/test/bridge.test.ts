// Wire-contract and misuse tests with a scripted fake helper. The real
// helper's decisions are tested in Swift (helper/tests, run by
// test/helper-kit.test.ts on a Mac); nothing here touches audio or a grant.
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { parse as parseYaml } from "yaml";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { checkResultSchema, mintToken, validateManifest } from "@foldedspacelabs/metistry-core";
import { makeBridge, ROUTES, startPayload, TOOL_OPS, type HelperResponse } from "../src/index.js";

const token = mintToken();
const controlToken = mintToken();

/** Every request the bridge made of the helper — to prove what it never asks for. */
const asked: Record<string, unknown>[] = [];
let checkAnswer: HelperResponse;
let startAnswer: HelperResponse;
let reachable = true;

const fakeHelper = {
  async request(p: Record<string, unknown>): Promise<HelperResponse> {
    asked.push(p);
    if (!reachable) return { id: 1, ok: false, code: "unreachable", error: "helper unreachable: ENOENT" };
    switch (p.op) {
      case "check": return checkAnswer;
      case "status": return { id: 1, ok: true, state: "idle", session: null, elapsed_s: null, stops_at: null, reminder_due_hours: null, disk_low_free_bytes: null };
      case "start": return startAnswer;
      case "stop": return { id: 1, ok: true, session: { session_id: "20260928-120000-00ab", ended_reason: "owner" } };
      case "keep_going": return { id: 1, ok: true, answered: true };
      default: return { id: 1, ok: false, code: "invalid_request", error: `unknown op ${String(p.op)}` };
    }
  },
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
    server = makeBridge(fakeHelper, { token, controlToken });
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

  it("the tool credential is refused 403 on every route that is not a tool, and the helper hears nothing", async () => {
    const control = ROUTES.filter((r) => r.reach === "control");
    expect(control.map((r) => r.path).sort()).toEqual(["/recording/keep-going", "/recording/start", "/recording/stop"]);
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
    expect(asked[0]).toEqual({ op: "start", apps: ["us.zoom.xos"], app_audio: true, microphone: false });

    expect((await call("POST", "/recording/keep-going", controlToken)).status).toBe(200);
    const stopped = await call("POST", "/recording/stop", controlToken);
    expect(stopped.status).toBe(200);
    expect((await stopped.json()).session.ended_reason).toBe("owner");
    expect(ops()).toEqual(["start", "keep_going", "stop"]);
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
    expect(startPayload({ apps: ["us.zoom.xos"] })).toEqual({ ok: true, payload: { op: "start", apps: ["us.zoom.xos"], app_audio: true, microphone: true } });
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

  it("status is a read with an as_of stamp, and never carries a transcript", async () => {
    const s = await (await call("GET", "/status", token)).json();
    expect(s).toMatchObject({ state: "idle" });
    expect(s.as_of).toBeTruthy();
    expect(JSON.stringify(s)).not.toMatch(/transcript|"text"/);
  });
});
