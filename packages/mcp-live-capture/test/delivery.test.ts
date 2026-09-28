// The end of a session (T8-2b): an ended recording's transcript to the
// console's POST /capture, with a key. A scripted helper holds the sessions
// the way session.json does (owed until `delivered`), and the console is a
// real HTTP server on port 0 that records every request and keeps one row
// per Idempotency-Key, as the real door does. No audio, no grant, no
// instance, and never the real console.
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mintToken } from "@foldedspacelabs/metistry-core";
import { check, Deliverer, idempotencyKey, makeBridge, renderTranscript, type HelperResponse, type SessionRecordJson, type TranscriptLine } from "../src/index.js";

const token = mintToken();
const controlToken = mintToken();
const inboxToken = mintToken();

// ---- the helper, as its socket answers ----------------------------------------

interface HeldSession {
  record: SessionRecordJson & { state: string };
  lines: TranscriptLine[];
}

class ScriptedHelper {
  sessions: HeldSession[] = [];
  asked: Record<string, unknown>[] = [];
  refuseDelivered = false;
  async request(p: Record<string, unknown>): Promise<HelperResponse> {
    this.asked.push(p);
    switch (p.op) {
      case "check":
        return { id: 1, ok: true, recording: false, os: "26.4", grants: { microphone: "granted", audio_capture: "observed", screen_recording: "not_granted" }, transcriber: { engine: "SpeechTranscriber", available: true, assets: "installed", locale: "en_US" } };
      case "owed":
        return { id: 1, ok: true, sessions: this.sessions.filter((s) => s.record.state === "ended" && !s.record.delivery).map((s) => s.record) };
      case "transcript": {
        const s = this.sessions.find((x) => x.record.session_id === p.session_id);
        if (!s) return { id: 1, ok: false, code: "unknown_session", error: `no session ${String(p.session_id)}` };
        return { id: 1, ok: true, session: s.record, lines: s.lines };
      }
      case "delivered": {
        if (this.refuseDelivered) return { id: 1, ok: false, code: "invalid_request", error: "cannot write the session: disk full" };
        const s = this.sessions.find((x) => x.record.session_id === p.session_id)!;
        s.record.delivery ??= { inbox_id: p.inbox_id as number, at: "2026-09-28T13:00:00Z" };
        return { id: 1, ok: true, session: s.record };
      }
      default:
        return { id: 1, ok: false, code: "invalid_request", error: `unknown op ${String(p.op)}` };
    }
  }
}

const ended = (id: string, reason: string, lines: TranscriptLine[] = []): HeldSession => ({
  record: { session_id: id, state: "ended", started_at: "2026-09-28T12:00:00Z", ended_at: "2026-09-28T12:41:07Z", ended_reason: reason, apps: ["us.zoom.xos"], gaps: [] },
  lines,
});

const meeting: TranscriptLine[] = [
  { kind: "segment", source: "app", from_s: 1.2, to_s: 3.4, text: "the numbers are in" },
  { kind: "segment", source: "mic", from_s: 4, to_s: 5.5, text: "send them over" },
  { kind: "gap", from_s: 600, to_s: 750, reason: "sleep" },
  { kind: "segment", source: "app", from_s: 751, to_s: 753, text: "welcome back" },
];

// ---- the console, as POST /capture behaves --------------------------------------

interface Received {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: { note?: string; filename?: string };
}

let consoleServer: Server;
let consoleUrl: string;
const received: Received[] = [];
const rows = new Map<string, number>(); // Idempotency-Key → inbox id
let consoleAnswer: "store" | 401 | 403 | 500 | "no-id" = "store";

beforeAll(async () => {
  consoleServer = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    received.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
    const reply = (status: number, b: unknown, h: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...h });
      res.end(JSON.stringify(b));
    };
    if (consoleAnswer === 401) return reply(401, { error: { code: "unauthenticated", message: "authentication required" } });
    if (consoleAnswer === 403) return reply(403, { error: { code: "forbidden", message: "not granted" } });
    if (consoleAnswer === 500) return reply(500, { error: { code: "internal", message: "internal error" } });
    if (consoleAnswer === "no-id") return reply(201, { path: "Inbox/x.md" });
    if (req.headers.authorization !== `Bearer ${inboxToken}`) return reply(401, { error: { code: "unauthenticated", message: "authentication required" } });
    const key = String(req.headers["idempotency-key"] ?? "");
    const replay = rows.has(key);
    if (!replay) rows.set(key, 100 + rows.size);
    return reply(201, { id: rows.get(key), path: `Inbox/${body.filename}`, sha256: "0" }, replay ? { "idempotency-replayed": "true" } : {});
  });
  await new Promise<void>((r) => consoleServer.listen(0, "127.0.0.1", r));
  consoleUrl = `http://127.0.0.1:${(consoleServer.address() as AddressInfo).port}`;
});
afterAll(async () => new Promise<void>((r) => consoleServer.close(() => r())));
beforeEach(() => {
  received.length = 0;
  rows.clear();
  consoleAnswer = "store";
});

describe("the transcript as a capture", () => {
  it("frontmatter the inbox drain classifies on, then one line per segment and gap, in the helper's order", () => {
    const md = renderTranscript(ended("20260928-120000-00ab", "owner").record, meeting);
    const [, fm, body] = md.split(/^---$/m);
    expect(fm).toContain('kind: "transcript"');
    expect(fm).toContain('capture_session: "20260928-120000-00ab"');
    expect(fm).toContain('ended_reason: "owner"');
    expect(fm).toContain('apps: "us.zoom.xos"');
    expect(fm).toContain('source: "live-capture"');
    expect(fm).toMatch(/title: "Recording \d{4}-\d\d-\d\d \d\d:\d\d"/);
    expect(body!.trim().split("\n")).toEqual([
      "[00:00:01] (apps) the numbers are in",
      "[00:00:04] (you) send them over",
      "[00:10:00–00:12:30] not recorded — the Mac slept",
      "[00:12:31] (apps) welcome back",
    ]);
  });

  it("a crash is said in the frontmatter and at the end — everything above was saved before it", () => {
    const md = renderTranscript(ended("20260928-120000-00ab", "crashed").record, meeting.slice(0, 2));
    expect(md).toContain('ended_reason: "crashed"');
    expect(md.trim().split("\n").at(-1)).toMatch(/^The recorder stopped unexpectedly at \d{4}-\d\d-\d\d \d\d:\d\d; everything above was saved before it did\.$/);
  });

  it("nothing in a session can add a frontmatter line or end the block — every value is a JSON string literal", () => {
    const hostile = ended("20260928-120000-00ab", 'owner"\nkind: "task', [{ kind: "segment", source: "app", from_s: 0, to_s: 1, text: "line one\n---\nkind: task" }]).record;
    hostile.apps = ['us.zoom.xos\n---'];
    const md = renderTranscript(hostile, [{ kind: "segment", source: "app", from_s: 0, to_s: 1, text: "line one\n---\nkind: task" }]);
    const fm = md.split(/^---$/m)[1]!;
    expect(fm.trim().split("\n").map((l) => l.split(":")[0])).toEqual(["kind", "title", "capture_session", "started_at", "ended_at", "ended_reason", "apps", "source"]);
    expect(md.match(/^---$/gm)).toHaveLength(2);
    expect(md).toContain("[00:00:00] (apps) line one --- kind: task");
  });

  it("an empty recording still says so", () => {
    expect(renderTranscript(ended("20260928-120000-00ab", "owner").record, [])).toContain("(nothing was transcribed)");
  });
});

describe("delivery: POST /capture with a key", () => {
  const make = (helper: ScriptedHelper) => new Deliverer(helper, { consoleUrl, inboxToken, timeoutMs: 5_000 });

  it("posts every owed session once, with the inbox token and live-capture:<session> as its key, and records where it went", async () => {
    const helper = new ScriptedHelper();
    helper.sessions = [ended("20260928-120000-00ab", "owner", meeting), ended("20260928-150000-00cd", "max_duration"), { ...ended("20260928-170000-00ef", "owner"), record: { ...ended("20260928-170000-00ef", "owner").record, state: "recording" } }];
    const state = await make(helper).sweep();
    expect(state).toMatchObject({ owed: 0, delivered: 2 });
    expect(state.last_error).toBeUndefined();
    expect(received.map((r) => [r.method, r.url, r.headers["idempotency-key"], r.headers.authorization, r.body.filename])).toEqual([
      ["POST", "/capture", "live-capture:20260928-120000-00ab", `Bearer ${inboxToken}`, "transcript-20260928-120000-00ab.md"],
      ["POST", "/capture", "live-capture:20260928-150000-00cd", `Bearer ${inboxToken}`, "transcript-20260928-150000-00cd.md"],
    ]);
    expect(received[0]!.headers["content-type"]).toBe("application/json");
    expect(received[0]!.body.note).toContain("[00:00:04] (you) send them over");
    expect(helper.sessions.map((s) => s.record.delivery?.inbox_id)).toEqual([100, 101, undefined]);
    // a second sweep has nothing to send
    await make(helper).sweep();
    expect(received).toHaveLength(2);
  });

  it("a crash saves up to the crash: the crashed session is delivered, marked crashed, and a retry is the same row", async () => {
    const helper = new ScriptedHelper();
    helper.sessions = [ended("20260928-120000-00ab", "crashed", meeting.slice(0, 2))];
    // the console took it, but the helper could not write that down (the disk, a second crash)
    helper.refuseDelivered = true;
    const first = await make(helper).sweep();
    expect(first.owed).toBe(1);
    expect(first.last_error).toMatch(/reached the inbox \(#100\) but the helper could not record it/);
    helper.refuseDelivered = false;
    const second = await make(helper).sweep();
    expect(second).toMatchObject({ owed: 0, delivered: 1 });
    // two posts, one key, one row: the console's idempotency is what keeps it to ONE capture, and so one report
    expect(received.map((r) => r.headers["idempotency-key"])).toEqual([idempotencyKey("20260928-120000-00ab"), idempotencyKey("20260928-120000-00ab")]);
    expect(rows.size).toBe(1);
    expect(helper.sessions[0]!.record.delivery?.inbox_id).toBe(100);
    expect(received[1]!.body.note).toContain('ended_reason: "crashed"');
    expect(received[1]!.body.note).toContain("the numbers are in");
  });

  // ---- misuse: POST /capture at session end ----

  for (const status of [401, 403] as const) {
    it(`a console that refuses the capture token (${status}) leaves every session owed, marks nothing, and says which variable`, async () => {
      const helper = new ScriptedHelper();
      helper.sessions = [ended("20260928-120000-00ab", "owner", meeting), ended("20260928-150000-00cd", "owner")];
      consoleAnswer = status;
      const d = make(helper);
      const state = await d.sweep();
      expect(state.owed).toBe(2);
      expect(state.last_error).toMatch(new RegExp(`refused the capture token \\(HTTP ${status}\\).*METISTRY_LIVE_CAPTURE_INBOX_TOKEN`));
      expect(received).toHaveLength(1); // stopped at the first refusal: the next would be refused the same way
      expect(helper.asked.map((a) => a.op)).not.toContain("delivered");
      expect(helper.sessions.every((s) => !s.record.delivery)).toBe(true);
      // and doctor hears it through check()
      const c = await check(helper, d);
      expect(c.status).toBe("degraded");
      expect(c.remediation).toMatch(/^2 recordings not yet delivered: the console refused/);
      // fixed: the next sweep sends both, the first with the same key as before
      consoleAnswer = "store";
      expect(await d.sweep()).toMatchObject({ owed: 0, delivered: 2 });
      await expect(check(helper, d)).resolves.toMatchObject({ status: "ok" });
      expect(received[0]!.headers["idempotency-key"]).toBe(received[1]!.headers["idempotency-key"]);
    });
  }

  it("a console that is down, or answers without a row, leaves the session owed — nothing is marked on a guess", async () => {
    const helper = new ScriptedHelper();
    helper.sessions = [ended("20260928-120000-00ab", "owner")];
    const down = new Deliverer(helper, { consoleUrl: "http://127.0.0.1:9", inboxToken, timeoutMs: 2_000 });
    expect((await down.sweep()).last_error).toMatch(/did not answer at http:\/\/127\.0\.0\.1:9\/capture/);
    for (const answer of [500, "no-id"] as const) {
      consoleAnswer = answer;
      const s = await make(helper).sweep();
      expect(s.owed).toBe(1);
      expect(s.last_error).toMatch(/the console answered HTTP (500: internal error|201)/);
    }
    expect(helper.asked.map((a) => a.op)).not.toContain("delivered");
  });

  it("the only credential that ever reaches the console is the inbox token — never the bridge's or the bar's", async () => {
    const helper = new ScriptedHelper();
    helper.sessions = [ended("20260928-120000-00ab", "owner", meeting)];
    const bridge = makeBridge(helper, { token, controlToken, delivery: { consoleUrl, inboxToken } });
    await new Promise<void>((r) => bridge.listen(0, "127.0.0.1", r));
    try {
      const base = `http://127.0.0.1:${(bridge.address() as AddressInfo).port}`;
      // a tool caller asks for everything it can name; none of it delivers anything
      for (const path of ["/check", "/status", "/deliver", "/transcript", "/recording/stop"]) {
        await fetch(`${base}${path}`, { method: path === "/recording/stop" ? "POST" : "GET", headers: { authorization: `Bearer ${token}` } });
      }
      expect(received).toHaveLength(0);
      expect(helper.asked.map((a) => a.op).filter((op) => op !== "check" && op !== "status")).toEqual([]);
      // the owner's Stop does
      await fetch(`${base}/recording/stop`, { method: "POST", headers: { authorization: `Bearer ${controlToken}` } }).catch(() => undefined);
      await bridge.deliverer!.sweep();
      expect(received.length).toBeGreaterThan(0);
      for (const r of received) {
        expect(r.headers.authorization).toBe(`Bearer ${inboxToken}`);
        expect(JSON.stringify(r)).not.toContain(token);
        expect(JSON.stringify(r)).not.toContain(controlToken);
      }
    } finally {
      await new Promise<void>((r) => bridge.close(() => r()));
    }
  });

  it("two sweeps at once are one: a Stop during the timer's sweep cannot post a session twice", async () => {
    const helper = new ScriptedHelper();
    helper.sessions = [ended("20260928-120000-00ab", "owner"), ended("20260928-150000-00cd", "owner")];
    const d = make(helper);
    const [a, b] = await Promise.all([d.sweep(), d.sweep()]);
    expect(a).toEqual(b);
    expect(received).toHaveLength(2);
  });

  it("a helper that does not answer is said, and nothing is posted", async () => {
    const helper = new ScriptedHelper();
    helper.request = async (p) => (p.op === "owed" ? { id: 1, ok: false, code: "unreachable", error: "helper unreachable: ENOENT" } : { id: 1, ok: true });
    const s = await make(helper).sweep();
    expect(s.last_error).toMatch(/the helper did not answer: helper unreachable/);
    expect(received).toHaveLength(0);
  });
});
