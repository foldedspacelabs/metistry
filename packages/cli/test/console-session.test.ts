// `metistry console session --stdio` — `console call` held open (F-12). What
// matters: the token is resolved once and never printed, a non-loopback
// console is refused before a line is read, every request gets exactly one
// terminal line matched by id (never by order), and a stream is frames until
// it is cancelled.
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { runConsoleSession, type SessionId } from "../src/console-client.js";
import type { Exec } from "../src/exec.js";
import { main } from "../src/main.js";

const TOKEN = "session-owner-token-never-printed";
const LOOPBACK = { METISTRY_CONSOLE_URL: "http://127.0.0.1:18080", METISTRY_LOCAL_OWNER_TOKEN: TOKEN };

/** stdin, driven by the test: push lines, then end. */
function input() {
  const queue: string[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  const iterable: AsyncIterable<string> = {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (queue.length > 0) {
          yield queue.shift() as string;
          continue;
        }
        if (ended) return;
        await new Promise<void>((r) => (wake = r));
      }
    },
  };
  const poke = () => {
    const w = wake;
    wake = undefined;
    w?.();
  };
  return {
    iterable,
    send: (o: unknown) => {
      queue.push(typeof o === "string" ? o : JSON.stringify(o));
      poke();
    },
    end: () => {
      ended = true;
      poke();
    },
  };
}

/** stdout, parsed — and a way to wait for a line matching a predicate. */
function output() {
  const raw: string[] = [];
  const waiters: Array<{ match: (o: Record<string, unknown>) => boolean; resolve: (o: Record<string, unknown>) => void }> = [];
  return {
    raw,
    get lines() {
      return raw.map((l) => JSON.parse(l) as Record<string, unknown>);
    },
    write: (line: string) => {
      raw.push(line);
      const o = JSON.parse(line) as Record<string, unknown>;
      for (const w of [...waiters]) {
        if (w.match(o)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(o);
        }
      }
    },
    next(match: (o: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
      const seen = raw.map((l) => JSON.parse(l) as Record<string, unknown>).find(match);
      if (seen) return Promise.resolve(seen);
      return new Promise((resolve) => waiters.push({ match, resolve }));
    },
  };
}

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

type Handler = (req: Seen, signal: AbortSignal | undefined) => Promise<Response> | Response;

function fakeFetch(handler: Handler) {
  const seen: Seen[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const req: Seen = { url: String(url), method: init?.method ?? "GET", headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body as string | undefined };
    seen.push(req);
    return handler(req, init?.signal ?? undefined);
  }) as unknown as typeof fetch;
  return { fetchFn, seen };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** An SSE response whose frames the test pushes, and which ends when the request is aborted or the test closes it. */
function sseResponse(signal: AbortSignal | undefined) {
  const enc = new TextEncoder();
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (c) => void (ctl = c) });
  signal?.addEventListener("abort", () => {
    try {
      ctl.error(new DOMException("aborted", "AbortError"));
    } catch {
      /* already closed */
    }
  });
  return {
    response: new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
    push: (text: string) => ctl.enqueue(enc.encode(text)),
    close: () => ctl.close(),
  };
}

function start(handler: Handler, env: NodeJS.ProcessEnv = LOOPBACK) {
  const i = input();
  const o = output();
  const f = fakeFetch(handler);
  const done = runConsoleSession({ env, platform: "linux", input: i.iterable, write: o.write, fetchFn: f.fetchFn });
  return { ...i, out: o, seen: f.seen, done };
}

const terminal = (id: SessionId) => (o: Record<string, unknown>) => o.id === id && ("status" in o || "error" in o || "ended" in o);

describe("console session: the door", () => {
  it("refuses a non-loopback console before reading a line or sending the token", async () => {
    const i = input();
    const o = output();
    const f = fakeFetch(() => json({}));
    i.send({ id: 1, method: "GET", path: "/api/whoami" });
    await expect(
      runConsoleSession({ env: { METISTRY_CONSOLE_URL: "https://metis.example", METISTRY_LOCAL_OWNER_TOKEN: TOKEN }, platform: "linux", input: i.iterable, write: o.write, fetchFn: f.fetchFn }),
    ).rejects.toThrow(/is not loopback.*`console session` refuses/);
    expect(f.seen).toEqual([]);
    expect(o.raw).toEqual([]);
  });

  it("the CLI: a non-loopback console exits 1 with the reason on stderr and nothing on stdout", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const f = fakeFetch(() => json({}));
    const prev = { url: process.env.METISTRY_CONSOLE_URL, tok: process.env.METISTRY_LOCAL_OWNER_TOKEN };
    process.env.METISTRY_CONSOLE_URL = "http://10.0.0.5:8080";
    process.env.METISTRY_LOCAL_OWNER_TOKEN = TOKEN;
    try {
      const i = input();
      i.send({ id: 1, method: "GET", path: "/api/whoami" });
      const code = await main(["console", "session", "--stdio"], { out: (s) => out.push(s), err: (s) => err.push(s), fetchFn: f.fetchFn, platform: "linux", sessionInput: i.iterable });
      expect(code).toBe(1);
      expect(err.join("\n")).toMatch(/^metistry console session: http:\/\/10\.0\.0\.5:8080 is not loopback/m);
      expect(out).toEqual([]);
      expect(f.seen).toEqual([]);
      expect(err.join("\n")).not.toContain(TOKEN);
    } finally {
      if (prev.url === undefined) delete process.env.METISTRY_CONSOLE_URL;
      else process.env.METISTRY_CONSOLE_URL = prev.url;
      if (prev.tok === undefined) delete process.env.METISTRY_LOCAL_OWNER_TOKEN;
      else process.env.METISTRY_LOCAL_OWNER_TOKEN = prev.tok;
    }
  });

  it("with no token anywhere, says how to get one and reads nothing", async () => {
    const i = input();
    const o = output();
    await expect(runConsoleSession({ env: { METISTRY_CONSOLE_URL: "http://127.0.0.1:1" }, platform: "linux", input: i.iterable, write: o.write })).rejects.toThrow(/METISTRY_LOCAL_OWNER_TOKEN is not set/);
    expect(o.raw).toEqual([]);
  });

  it("the CLI: --stdio is required, and nothing else follows `session`", async () => {
    for (const argv of [["console", "session"], ["console", "session", "extra", "--stdio"]]) {
      const err: string[] = [];
      expect(await main(argv, { out: () => undefined, err: (s) => err.push(s) })).toBe(2);
      expect(err.join("\n")).toContain("metistry console session --stdio");
    }
  });

  it("sends the bearer on every request, resolved once — and the token never appears in output", async () => {
    // A console that echoes the credential back in every place it could:
    // a body, an error envelope, a stream frame.
    const s = start((req, signal) => {
      const auth = req.headers.authorization ?? "";
      if (req.url.endsWith("/api/events")) {
        const sse = sseResponse(signal);
        queueMicrotask(() => {
          sse.push(`id: 1\nevent: work.changed\ndata: {"work_id":7,"echo":"${auth}"}\n\n`);
          sse.close();
        });
        return sse.response;
      }
      if (req.url.endsWith("/boom")) throw new TypeError(`fetch failed while holding ${auth}`);
      if (req.url.endsWith("/bad")) return json({ error: { code: "invalid_request", message: `you sent ${auth}` } }, 400);
      return new Response(`plain text ${auth}`, { status: 200 });
    });
    s.send({ id: 1, method: "GET", path: "/api/whoami" });
    s.send({ id: 2, method: "GET", path: "/bad" });
    s.send({ id: 3, method: "GET", path: "/boom" });
    s.send({ id: 4, method: "GET", path: "/api/events", stream: true });
    await Promise.all([1, 2, 3, 4].map((id) => s.out.next(terminal(id))));
    s.end();
    await s.done;
    expect(s.seen).toHaveLength(4);
    for (const r of s.seen) expect(r.headers.authorization).toBe(`Bearer ${TOKEN}`);
    const all = s.out.raw.join("\n");
    expect(all).not.toContain(TOKEN);
    expect(all).toContain("[redacted]");
    // every one of the four echoes was caught, not just the first
    expect(s.out.raw.filter((l) => l.includes("[redacted]"))).toHaveLength(4);
  });
});

// The Mac app's transport writes its first request the instant it spawns
// the process. Real stdin is a readline interface, whose async iterator only
// sees lines that arrive after the iterator exists — so a session that
// awaited the target first lost that line, and the call hung to its timeout.
describe("console session: lines written at spawn", () => {
  /** a real readline over a pipe, with lines already written before the session starts */
  function stdinWith(lines: unknown[]) {
    const pipe = new PassThrough();
    for (const l of lines) pipe.write(`${JSON.stringify(l)}\n`);
    return { pipe, rl: createInterface({ input: pipe, crlfDelay: Infinity }) };
  }

  /** the token comes from the (fake) login Keychain, and takes real time to — the Mac app's case, where `.env` does not carry it */
  const slowKeychain: Exec = async (cmd, args) => {
    await new Promise((r) => setTimeout(r, 25));
    return cmd === "security" && args[0] === "find-generic-password" ? { code: 0, stdout: `${TOKEN}\n`, stderr: "" } : { code: 44, stdout: "", stderr: "not found" };
  };

  it("answers a line written synchronously at spawn, before the target resolved", async () => {
    const { pipe, rl } = stdinWith([{ id: "first", method: "GET", path: "/api/whoami" }, { id: "second", method: "GET", path: "/api/status" }]);
    const o = output();
    const f = fakeFetch(() => json({ ok: true }));
    const done = runConsoleSession({ env: { METISTRY_CONSOLE_URL: LOOPBACK.METISTRY_CONSOLE_URL }, platform: "darwin", exec: slowKeychain, input: rl, write: o.write, fetchFn: f.fetchFn });
    await Promise.all([o.next(terminal("first")), o.next(terminal("second"))]);
    pipe.end();
    await done;
    expect(f.seen.map((r) => r.url)).toEqual(["http://127.0.0.1:18080/api/whoami", "http://127.0.0.1:18080/api/status"]);
    for (const r of f.seen) expect(r.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(o.lines.map((l) => [l.id, l.status])).toEqual([
      ["first", 200],
      ["second", 200],
    ]);
  });

  it("a non-loopback console still refuses: no held line is sent or answered, and the token is never printed", async () => {
    const { pipe, rl } = stdinWith([{ id: 1, method: "GET", path: "/api/whoami" }, { id: 2, method: "POST", path: "/api/work", body: {} }]);
    const o = output();
    const f = fakeFetch(() => json({}));
    const refused = runConsoleSession({ env: { METISTRY_CONSOLE_URL: "https://metis.example" }, platform: "darwin", exec: slowKeychain, input: rl, write: o.write, fetchFn: f.fetchFn });
    await expect(refused).rejects.toThrow(/is not loopback.*`console session` refuses/);
    await expect(refused).rejects.not.toThrow(TOKEN);
    pipe.write(`${JSON.stringify({ id: 3, method: "GET", path: "/api/whoami" })}\n`); // a line after the refusal: still nothing
    pipe.end();
    await new Promise((r) => setTimeout(r, 20));
    expect(f.seen).toEqual([]);
    expect(o.raw).toEqual([]);
  });
});

describe("console session: requests", () => {
  it("responses match by id, not by order", async () => {
    // The first request is the slowest; its answer arrives last.
    const delays: Record<string, number> = { "/api/slow": 30, "/api/mid": 15, "/api/fast": 0 };
    const s = start(async (req) => {
      const path = new URL(req.url).pathname;
      await new Promise((r) => setTimeout(r, delays[path] ?? 0));
      return json({ path });
    });
    s.send({ id: "slow", method: "GET", path: "/api/slow" });
    s.send({ id: "mid", method: "GET", path: "/api/mid" });
    s.send({ id: 42, method: "GET", path: "/api/fast" });
    const answers = await Promise.all(["slow", "mid", 42].map((id) => s.out.next(terminal(id))));
    s.end();
    await s.done;
    expect(s.out.lines.map((l) => l.id)).toEqual([42, "mid", "slow"]);
    expect(answers.map((a) => (a.body as { path: string }).path)).toEqual(["/api/slow", "/api/mid", "/api/fast"]);
    for (const a of answers) expect(a.status).toBe(200);
  });

  it("one terminal line per request: a body and an idempotency key ride as they would on console call", async () => {
    const s = start((req) => json({ ok: true }, 201, req.headers["idempotency-key"] ? { "idempotency-replayed": "true" } : {}));
    s.send({ id: 1, method: "post", path: "/capture", body: { text: "hi" }, idempotency_key: "  k-1  " });
    s.send({ id: 2, method: "PATCH", path: "/api/tasks/3", body: { owner: "me" } });
    await Promise.all([1, 2].map((id) => s.out.next(terminal(id))));
    s.end();
    await s.done;
    expect(s.seen[0]).toMatchObject({ method: "POST", body: '{"text":"hi"}', headers: { "idempotency-key": "k-1", "content-type": "application/json" } });
    expect(s.seen[1]?.headers["idempotency-key"]).toBeUndefined();
    expect(s.out.lines.find((l) => l.id === 1)).toEqual({ id: 1, status: 201, body: { ok: true }, replayed: true });
    expect(s.out.lines.find((l) => l.id === 2)).toEqual({ id: 2, status: 201, body: { ok: true } });
  });

  it("a >=400 answer is an ordinary line carrying the console's whole body — a 409's reason survives", async () => {
    const conflict = { error: { code: "conflict", message: "changed since you saw it" }, reason: "stale", decision: "approve", decided_at: "2026-09-26T00:00:00Z" };
    const s = start(() => json(conflict, 409));
    s.send({ id: 1, method: "POST", path: "/api/proposals/9", body: { decision: "approve" } });
    expect(await s.out.next(terminal(1))).toEqual({ id: 1, status: 409, body: conflict });
    s.end();
    await s.done;
  });

  it("refuses a bad line on the line's own id, without a request going out", async () => {
    const s = start(() => json({}));
    s.send("not json");
    s.send({ method: "GET", path: "/api/whoami" });
    s.send({ id: 1, method: "TRACE", path: "/api/whoami" });
    s.send({ id: 2, method: "GET", path: "api/whoami" });
    s.send({ id: 3, method: "GET", path: "//evil.example/steal" });
    s.send({ id: 4, method: "GET", path: "/api/whoami", body: {} });
    s.send({ id: 5, method: "POST", path: "/capture", idempotency_key: "   " });
    s.send({ id: 6, method: "GET", path: "/api/whoami", stream: true });
    s.send({ id: 7, method: "POST", path: "/api/events", stream: true });
    s.send({ id: 8, method: "GET", path: "/api/whoami", last_event_id: "3" });
    s.end();
    await s.done;
    expect(s.seen).toEqual([]);
    const lines = s.out.lines;
    expect(lines).toHaveLength(10);
    for (const l of lines) expect((l.error as { code: string }).code).toBe("invalid_request");
    expect(lines.map((l) => l.id)).toEqual([null, null, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect((lines[8]?.error as { message: string }).message).toContain("only GET /api/events may be a stream");
  });

  it("refuses an id still in flight, and accepts it again once answered", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const s = start(async () => {
      await gate;
      return json({ n: 1 });
    });
    s.send({ id: "x", method: "GET", path: "/api/a" });
    s.send({ id: "x", method: "GET", path: "/api/b" });
    expect(await s.out.next((o) => o.id === "x" && "error" in o)).toMatchObject({ error: { code: "duplicate_id" } });
    release();
    await s.out.next((o) => o.id === "x" && "status" in o);
    s.send({ id: "x", method: "GET", path: "/api/c" });
    s.end();
    await s.done;
    expect(s.out.lines.filter((l) => l.id === "x" && "status" in l)).toHaveLength(2);
  });

  it("an unreachable console is an error line on that id, and the session goes on", async () => {
    const s = start((req) => {
      if (req.url.endsWith("/down")) throw Object.assign(new TypeError("fetch failed"), { cause: { message: "connect ECONNREFUSED 127.0.0.1:18080" } });
      return json({ up: true });
    });
    s.send({ id: 1, method: "GET", path: "/down" });
    s.send({ id: 2, method: "GET", path: "/up" });
    s.end();
    await s.done;
    expect(s.out.lines.find((l) => l.id === 1)).toEqual({ id: 1, error: { code: "unreachable", message: "console unreachable at http://127.0.0.1:18080: connect ECONNREFUSED 127.0.0.1:18080" } });
    expect(s.out.lines.find((l) => l.id === 2)).toMatchObject({ status: 200 });
  });

  it("EOF on stdin still answers what is in flight before the session ends", async () => {
    const s = start(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return json({ late: true });
    });
    s.send({ id: 1, method: "GET", path: "/api/whoami" });
    s.end();
    await s.done;
    expect(s.out.lines).toEqual([{ id: 1, status: 200, body: { late: true } }]);
  });
});

describe("console session: the event stream", () => {
  it("frames until cancelled, then one ended line — and Last-Event-ID rides along", async () => {
    let sse!: ReturnType<typeof sseResponse>;
    const s = start((_req, signal) => {
      sse = sseResponse(signal);
      return sse.response;
    });
    s.send({ id: "ev", method: "GET", path: "/api/events", stream: true, last_event_id: "41" });
    await new Promise((r) => setTimeout(r, 5));
    sse.push(": heartbeat\n\n");
    sse.push('id: 42\nevent: work.changed\ndata: {"work_id":7}\n\n');
    sse.push("id: 43\r\nevent: needs_you.changed\r\ndata: {\"waiting\":");
    sse.push("2}\r\n\r\n");
    await s.out.next((o) => o.id === "ev" && (o.event as { id?: string } | undefined)?.id === "43");
    s.send({ id: "ev", cancel: true });
    await s.out.next(terminal("ev"));
    s.end();
    await s.done;
    expect(s.seen[0]?.headers["last-event-id"]).toBe("41");
    expect(s.out.lines).toEqual([
      { id: "ev", event: { id: "42", type: "work.changed", data: { work_id: 7 } } },
      { id: "ev", event: { id: "43", type: "needs_you.changed", data: { waiting: 2 } } },
      { id: "ev", ended: "cancelled" },
    ]);
  });

  it("a stream the console closes ends as closed; one it never opened is an ordinary answer", async () => {
    const s = start((req, signal) => {
      if (req.url.includes("closes")) {
        const sse = sseResponse(signal);
        queueMicrotask(() => {
          sse.push('id: 1\nevent: resync\ndata: {}\n\n');
          sse.close();
        });
        return sse.response;
      }
      return json({ error: { code: "not_found", message: "not found" } }, 404);
    });
    s.send({ id: 1, method: "GET", path: "/api/events?closes=1", stream: true });
    s.send({ id: 2, method: "GET", path: "/api/events", stream: true });
    await Promise.all([1, 2].map((id) => s.out.next(terminal(id))));
    s.end();
    await s.done;
    expect(s.out.lines.filter((l) => l.id === 1)).toEqual([
      { id: 1, event: { id: "1", type: "resync", data: {} } },
      { id: 1, ended: "closed" },
    ]);
    expect(s.out.lines.filter((l) => l.id === 2)).toEqual([{ id: 2, status: 404, body: { error: { code: "not_found", message: "not found" } } }]);
  });

  it("a fresh subscriber's cursor — an id with no data — reaches the client as {id} alone, so it can resume from an empty stream", async () => {
    let sse!: ReturnType<typeof sseResponse>;
    const s = start((_req, signal) => {
      sse = sseResponse(signal);
      return sse.response;
    });
    s.send({ id: "ev", method: "GET", path: "/api/events", stream: true });
    await new Promise((r) => setTimeout(r, 5));
    // exactly what the console's serve() writes to a subscriber with no Last-Event-ID
    sse.push("retry: 3000\n\n");
    sse.push("id: 1790000000000007\n\n");
    sse.push(": heartbeat\n\n");
    // a later frame with no id: line keeps the last id (WHATWG), and is an event, not a second cursor
    sse.push('id: 1790000000000008\nevent: work.changed\ndata: {"work_id":7}\n\n');
    sse.push('event: needs_you.changed\ndata: {"waiting":1}\n\n');
    await s.out.next((o) => o.id === "ev" && (o.event as { type?: string } | undefined)?.type === "needs_you.changed");
    s.send({ id: "ev", cancel: true });
    await s.out.next(terminal("ev"));
    s.end();
    await s.done;
    expect(s.seen[0]?.headers["last-event-id"]).toBeUndefined();
    expect(s.out.lines).toEqual([
      { id: "ev", event: { id: "1790000000000007" } },
      { id: "ev", event: { id: "1790000000000008", type: "work.changed", data: { work_id: 7 } } },
      { id: "ev", event: { id: "1790000000000008", type: "needs_you.changed", data: { waiting: 1 } } },
      { id: "ev", ended: "cancelled" },
    ]);
  });

  it("EOF on stdin ends an open stream as cancelled rather than hanging", async () => {
    const s = start((_req, signal) => sseResponse(signal).response);
    s.send({ id: 1, method: "GET", path: "/api/events", stream: true });
    await new Promise((r) => setTimeout(r, 5));
    s.end();
    await s.done;
    expect(s.out.lines).toEqual([{ id: 1, ended: "cancelled" }]);
  });
});
