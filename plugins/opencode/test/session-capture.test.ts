// The plugin's whole contract, exercised the way OpenCode exercises it: the
// `event` hook is handed `{ event }`, the capturer talks to a stand-in SDK
// client, and the note goes to a local node:http stand-in for the console.
//
// The fixture in test/fixtures/opencode-session.json is a REAL session,
// recorded from a running OpenCode 1.18.30 on 2026-09-16 (`GET
// /session/{id}/message` and `GET /session/{id}`) with the paths rewritten —
// so the shapes asserted here are the ones OpenCode actually sends, not ones
// this repo wishes it sent.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCapturer } from "../plugin.js";
import { captureSession, idempotencyKey, summarizeSession, unreadableSession } from "../scripts/lib.mjs";

const FIXTURE = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "opencode-session.json"), "utf8")) as {
  session: Record<string, unknown>;
  messages: { info: Record<string, unknown>; parts: Record<string, unknown>[] }[];
};
const TOKEN = "mtk_test_secret_token_0123456789";

interface Seen {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingMessage["headers"];
  body: string;
}

let server: Server;
let base: string;
const seen: Seen[] = [];
let status = 201;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(status === 201 ? { id: 42, path: "42-x.md", sha256: "abc" } : { error: { code: "nope" } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { METISTRY_CAPTURE_ON_STOP: "1", METISTRY_URL: base, METISTRY_AGENT_TOKEN_OPENCODE: TOKEN, ...extra };
}

/** A stand-in for the SDK client the plugin is handed. */
function fakeClient(over: { messages?: unknown; session?: unknown; throws?: Error } = {}) {
  const calls: string[] = [];
  return {
    calls,
    client: {
      session: {
        async messages() {
          calls.push("messages");
          if (over.throws) throw over.throws;
          return over.messages ?? FIXTURE.messages;
        },
        async get() {
          calls.push("get");
          return over.session ?? FIXTURE.session;
        },
      },
      app: { log: async () => true },
    },
  };
}

/** Timers under the test's control: nothing here waits for a real quiet window. */
function fakeTimers() {
  const fired: (() => void)[] = [];
  let next = 1;
  const live = new Map<number, () => void>();
  return {
    timers: {
      set(fn: () => void) {
        const id = next++;
        live.set(id, fn);
        return id;
      },
      clear(id: number) {
        live.delete(id);
      },
    },
    /** Run every armed timer, the way 90 seconds of quiet would. */
    async tick() {
      for (const [id, fn] of [...live]) {
        live.delete(id);
        fired.push(fn);
        fn();
      }
      await new Promise((r) => setTimeout(r, 25));
    },
    live,
  };
}

function frontmatter(note: string): Record<string, string | number | null> {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(note);
  if (!m) throw new Error("no frontmatter");
  const out: Record<string, string | number | null> = {};
  for (const line of m[1]!.split("\n")) {
    const [k, ...rest] = line.split(": ");
    out[k!] = JSON.parse(rest.join(": ")) as string | number | null;
  }
  return out;
}

describe("summarizing a real OpenCode session", () => {
  const summary = summarizeSession(FIXTURE.messages, { session: FIXTURE.session })!;

  it("counts the turns OpenCode actually sent (one prompt, three assistant steps)", () => {
    expect(summary.turns).toBe(1);
    expect(summary.assistantMessages).toBe(3);
    expect(summary.sessionId).toBe(FIXTURE.session.id);
  });

  it("records the project, the repo name, the model and the OpenCode version", () => {
    expect(summary.project).toBe("/Users/example/Development/demo");
    expect(summary.repo).toBe("demo");
    expect(summary.models).toEqual(["opencode/ling-3.0-flash-fin-free"]);
    expect(summary.version).toBe("1.18.30");
    expect(summary.agent).toBe("build");
    expect(summary.branch).toBeNull(); // OpenCode sends none, and a branch is never guessed
  });

  it("counts tools and the files their `filePath` named, most-used first", () => {
    expect(summary.tools).toEqual([
      { name: "read", count: 2 },
      { name: "glob", count: 1 },
    ]);
    expect(summary.files).toContain("/Users/example/Development/demo/README.md");
    expect(summary.filesTruncated).toBe(false);
  });

  it("takes the first prompt and the last response, and nothing in between", () => {
    expect(summary.firstPrompt).toBe("Read README.md and then reply with exactly: done");
    expect(summary.lastAssistant).toBe("done");
  });

  it("derives start, end and duration from the message clock, in ISO", () => {
    expect(summary.started).toMatch(/^2026-\d\d-\d\dT/);
    expect(summary.ended).toMatch(/^2026-\d\d-\d\dT/);
    expect(Date.parse(summary.ended!)).toBeGreaterThanOrEqual(Date.parse(summary.started!));
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("sums cost and tokens across every assistant message", () => {
    expect(summary.costUsd).toBe(0);
    expect(summary.inputTokens).toBeGreaterThan(0);
    expect(summary.outputTokens).toBeGreaterThan(0);
  });

  it("is a pure function of the transcript: same messages in, same key out", () => {
    const again = summarizeSession(FIXTURE.messages, { session: FIXTURE.session })!;
    expect(idempotencyKey(again, "opencode")).toBe(idempotencyKey(summary, "opencode"));
  });
});

describe("summarizing the awkward cases", () => {
  it("returns null for a session with no conversation in it", () => {
    expect(summarizeSession([], { session: { id: "ses_1" } })).toBeNull();
    expect(summarizeSession(null as unknown as [], {})).toBeNull();
  });

  it("does not count an injected (synthetic) user message as a turn", () => {
    const messages = [
      { info: { id: "m1", sessionID: "ses_2", role: "user", time: { created: 1 } }, parts: [{ type: "text", text: "system context", synthetic: true }] },
      { info: { id: "m2", sessionID: "ses_2", role: "user", time: { created: 2 } }, parts: [{ type: "text", text: "the real question" }] },
      { info: { id: "m3", sessionID: "ses_2", role: "assistant", time: { created: 3, completed: 4 }, providerID: "p", modelID: "m", tokens: { input: 1, output: 2, cache: { read: 0, write: 0 } } }, parts: [{ type: "text", text: "the answer" }] },
    ];
    const s = summarizeSession(messages, { session: { id: "ses_2", directory: "/Users/example/Development/demo" } })!;
    expect(s.turns).toBe(1);
    expect(s.firstPrompt).toBe("the real question");
    expect(s.inputTokens).toBe(1);
    expect(s.outputTokens).toBe(2);
  });

  it("takes the files an apply_patch reports, and caps the list", () => {
    const parts = [{ type: "patch", hash: "h", files: Array.from({ length: 60 }, (_, i) => `/Users/example/Development/demo/f${i}.ts`) }];
    const s = summarizeSession([{ info: { id: "m", sessionID: "ses_3", role: "assistant", time: { created: 1 } }, parts }], { session: { id: "ses_3" } })!;
    expect(s.files).toHaveLength(40);
    expect(s.filesTruncated).toBe(true);
  });

  it("survives a message list full of fields it has never seen", () => {
    const junk = [{ info: { role: "assistant", time: {}, tokens: null, cost: "free" }, parts: [{ type: "tool", state: { input: { filePath: 7 } } }, null, "nonsense"] }];
    const s = summarizeSession(junk as never, { session: {} })!;
    expect(s.assistantMessages).toBe(1);
    expect(s.files).toEqual([]);
    expect(s.tools).toEqual([{ name: "(unnamed)", count: 1 }]);
    expect(s.costUsd).toBeNull();
  });
});

describe("a session whose transcript could not be read", () => {
  const s = unreadableSession("ses_missing", { directory: "/Users/example/Development/demo", reason: "boom" });

  it("says so in the note rather than reporting a session with zero turns", () => {
    expect(s.turns).toBeNull();
    expect(s.notCaptured).toContain("could not be read");
    expect(s.notCaptured).toContain("boom");
  });

  it("keys on the session id alone, so a retry is an exact no-op", () => {
    expect(idempotencyKey(s, "opencode")).toBe(idempotencyKey(unreadableSession("ses_missing"), "opencode"));
  });
});

describe("delivery", () => {
  it("POSTs /capture with the bearer, the key header and the session frontmatter", async () => {
    seen.length = 0;
    const summary = summarizeSession(FIXTURE.messages, { session: FIXTURE.session })!;
    const r = await captureSession({ summary, env: env() });
    expect(r.delivered).toBe("console");

    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.url).toBe("/capture");
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    const body = JSON.parse(seen[0]!.body) as { note: string; filename: string };
    expect(seen[0]!.headers["idempotency-key"]).toBe(idempotencyKey(summary, "opencode"));
    expect(body.filename).toMatch(/^opencode-session-\d{8}T\d{6}Z-ses_/);
    const fm = frontmatter(body.note);
    expect(fm.kind).toBe("session");
    expect(fm.source).toBe("opencode");
    expect(fm.session_id).toBe(FIXTURE.session.id);
    expect(fm.turns).toBe(1);
    expect(body.note).not.toContain(TOKEN);
  });

  it("writes the note to METISTRY_CAPTURE_DIR at 0600 when the console cannot be reached, and never prints the token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "metistry-opencode-capture-"));
    const summary = summarizeSession(FIXTURE.messages, { session: FIXTURE.session })!;
    const r = await captureSession({ summary, env: { ...env({ METISTRY_CAPTURE_DIR: dir }), METISTRY_URL: "http://127.0.0.1:1" } });
    expect(r.delivered).toBe("file");
    expect(r.reason).not.toContain(TOKEN);
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(statSync(join(dir, files[0]!)).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, files[0]!), "utf8")).toContain(`source: "opencode"`);
  });

  it("refuses to guess a console: no URL and no token is an error, not a silent drop", async () => {
    const summary = summarizeSession(FIXTURE.messages, { session: FIXTURE.session })!;
    await expect(captureSession({ summary, env: { METISTRY_CAPTURE_ON_STOP: "1" } })).rejects.toThrow(/METISTRY_URL is not set/);
  });
});

describe("the quiet window that stands in for a session-end event", () => {
  it("does nothing at all unless METISTRY_CAPTURE_ON_STOP=1", async () => {
    const t = fakeTimers();
    const { client, calls } = fakeClient();
    const c = createCapturer({ client, env: { METISTRY_URL: base }, timers: t.timers });
    expect(await c.onEvent({ type: "session.idle", properties: { sessionID: "ses_x" } })).toBe("off");
    expect(t.live.size).toBe(0);
    expect(calls).toEqual([]);
  });

  it("arms on session.idle, re-arms on the next one, and captures once when the window elapses", async () => {
    seen.length = 0;
    const t = fakeTimers();
    const { client } = fakeClient();
    const c = createCapturer({ client, env: env(), timers: t.timers });
    expect(await c.onEvent({ type: "session.idle", properties: { sessionID: FIXTURE.session.id as string } })).toBe("armed");
    expect(await c.onEvent({ type: "session.idle", properties: { sessionID: FIXTURE.session.id as string } })).toBe("armed");
    expect(t.live.size).toBe(1); // re-armed, not queued twice
    await t.tick();
    expect(seen).toHaveLength(1);
  });

  it("ignores every other event, and an idle with no session id", async () => {
    const t = fakeTimers();
    const { client } = fakeClient();
    const c = createCapturer({ client, env: env(), timers: t.timers });
    for (const e of [{ type: "session.created" }, { type: "message.updated" }, { type: "session.idle", properties: {} }, {}, null]) {
      expect(await c.onEvent(e as never)).toBe("ignored");
    }
    expect(t.live.size).toBe(0);
  });

  it("drops a pending capture when the session is deleted", async () => {
    const t = fakeTimers();
    const { client, calls } = fakeClient();
    const c = createCapturer({ client, env: env(), timers: t.timers });
    await c.onEvent({ type: "session.idle", properties: { sessionID: "ses_gone" } });
    expect(await c.onEvent({ type: "session.deleted", properties: { sessionID: "ses_gone" } })).toBe("cancelled");
    await t.tick();
    expect(calls).toEqual([]);
  });

  it("flush captures what is still armed, and a second flush is not a second note", async () => {
    seen.length = 0;
    const t = fakeTimers();
    const { client } = fakeClient();
    const c = createCapturer({ client, env: env(), timers: t.timers });
    await c.onEvent({ type: "session.idle", properties: { sessionID: FIXTURE.session.id as string } });
    const first = await c.flush();
    expect(first[0]!.state).toBe("console");
    await c.onEvent({ type: "session.idle", properties: { sessionID: FIXTURE.session.id as string } });
    const second = await c.flush();
    expect(second[0]!.state).toBe("unchanged");
    expect(seen).toHaveLength(1);
  });

  it("writes a `## Not captured` note when the client will not give up the messages", async () => {
    seen.length = 0;
    const { client } = fakeClient({ throws: new Error("client exploded") });
    const c = createCapturer({ client, directory: "/Users/example/Development/demo", env: env(), timers: fakeTimers().timers });
    const r = await c.capture("ses_broken");
    expect(r.state).toBe("console");
    const body = JSON.parse(seen[0]!.body) as { note: string };
    expect(body.note).toContain("## Not captured");
    expect(body.note).toContain("client exploded");
    expect(frontmatter(body.note).turns).toBeNull();
  });

  it("never throws at OpenCode, whatever the console answers", async () => {
    status = 500;
    const { client } = fakeClient();
    const c = createCapturer({ client, env: env(), timers: fakeTimers().timers });
    const r = await c.capture(FIXTURE.session.id as string);
    expect(r.state).toBe("failed");
    status = 201;
    const hooks = await (await import("../plugin.js")).MetistryPlugin({ client, directory: "/tmp" } as never);
    await expect(hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_y" } } } as never)).resolves.toBeUndefined();
  });
});
