// Live changes over the wire (design-build-plan §2.20, T2-18): migration
// 0035's triggers, the console's one LISTEN, and `GET /api/events` behind the
// owner gate — over real sockets against the scratch database
// (docs/ops/testing.md). The rules without a database are events.test.ts.
//
// Other suites write the same tables while this one runs (vitest runs files
// in parallel against one scratch database), so every assertion about what a
// stream carries is about THIS file's rows, picked out by id — except the
// replay test, which uses a hub of its own and is exact.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { EVENT_CATALOGUE, mintToken, startRun, finishRun } from "@foldedspacelabs/metistry-core";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";
import { runConsoleSession } from "@foldedspacelabs/metistry-cli/dist/console-client.js";
import { routines } from "@metistry-apps/routines";
import { makeServer } from "../src/server.js";
import { EventHub, EVENTS_CHANNEL, payloadRefusal, startEventFeed, type EventFeed } from "../src/events.js";
import * as store from "../src/auth-store.js";
import * as agents from "../src/agents.js";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url));
const policy = { idleDays: 30, maxDays: 365 };
const MARK = "itest-events";
const suffix = mintToken(6).toLowerCase().replaceAll(/[^a-z0-9]/g, "").slice(0, 6) || "x";
/** Written into every body-bearing column this file touches: it must never appear on the stream. */
const SECRET = `SECRET-${suffix}-the-body-itself`;
const TURN_META = "com.foldedspacelabs.metistry/turn_id";

interface Frame {
  id?: string;
  event: string;
  data: unknown;
  raw: string;
}

/** An open `GET /api/events`, parsed the WHATWG way (F-12's `sseFrames` is the same reading). */
interface Stream {
  status: number;
  contentType: string | null;
  body: string;
  frames: Frame[];
  /** The last `id:` the stream set — including an id-only frame, which dispatches nothing. */
  lastId: () => string | undefined;
  comments: () => number;
  waitFor: (pred: (f: Frame) => boolean, ms?: number) => Promise<Frame>;
  ended: Promise<void>;
  close: () => void;
}

async function openStream(url: string, headers: Record<string, string>): Promise<Stream> {
  const abort = new AbortController();
  const res = await fetch(url, { headers, signal: abort.signal });
  const frames: Frame[] = [];
  let lastId: string | undefined;
  let comments = 0;
  const waiters = new Set<() => void>();
  const wake = () => {
    for (const w of [...waiters]) w();
  };
  const contentType = res.headers.get("content-type");
  if (!(contentType ?? "").startsWith("text/event-stream") || !res.body) {
    const body = await res.text();
    return { status: res.status, contentType, body, frames, lastId: () => lastId, comments: () => comments, waitFor: () => Promise.reject(new Error("not a stream")), ended: Promise.resolve(), close: () => abort.abort() };
  }
  const reader = res.body.getReader();
  const ended = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    let id: string | undefined;
    let type = "";
    let data: string[] = [];
    let raw: string[] = [];
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (line === "") {
            if (data.length > 0) {
              const text = data.join("\n");
              frames.push({ ...(id !== undefined ? { id } : {}), event: type || "message", data: JSON.parse(text), raw: raw.join("\n") });
            }
            type = "";
            data = [];
            raw = [];
            wake();
            continue;
          }
          if (line.startsWith(":")) {
            comments++;
            continue;
          }
          raw.push(line);
          const colon = line.indexOf(":");
          const field = colon === -1 ? line : line.slice(0, colon);
          const v = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
          if (field === "id") lastId = id = v;
          else if (field === "event") type = v;
          else if (field === "data") data.push(v);
        }
      }
    } catch {
      /* aborted */
    } finally {
      wake();
    }
  })();
  let finished = false;
  void ended.then(() => (finished = true));
  const waitFor = (pred: (f: Frame) => boolean, ms = 3000): Promise<Frame> =>
    new Promise((resolve, reject) => {
      const check = () => {
        const hit = frames.find(pred);
        if (hit) {
          waiters.delete(check);
          clearTimeout(t);
          resolve(hit);
        } else if (finished) {
          waiters.delete(check);
          clearTimeout(t);
          reject(new Error(`the stream ended without it; heard ${frames.map((f) => f.event).join(", ")}`));
        }
      };
      const t = setTimeout(() => {
        waiters.delete(check);
        reject(new Error(`not heard within ${ms} ms; heard ${frames.map((f) => `${f.event} ${JSON.stringify(f.data)}`).join(", ")}`));
      }, ms);
      waiters.add(check);
      check();
    });
  return { status: res.status, contentType, body: "", frames, lastId: () => lastId, comments: () => comments, waitFor, ended, close: () => abort.abort() };
}

describe.skipIf(!hasDb)("GET /api/events (real db, real sockets)", () => {
  let pool: pg.Pool;
  let queries: QueryStore;
  let hub: EventHub;
  let feed: EventFeed;
  let base: string;
  let sessionCookie: string;
  let ownerToken: string;
  let agentToken: string;
  const localOwnerToken = mintToken();
  const agentId = `itest-ev-${suffix}`;
  const passkeyIds: string[] = [];
  const servers: ReturnType<typeof makeServer>[] = [];
  const streams: Stream[] = [];

  const asLocal = () => ({ authorization: `Bearer ${localOwnerToken}` });

  async function serve(extra: Partial<Parameters<typeof makeServer>[2]>): Promise<string> {
    const s = makeServer(pool, queries, {
      origin: "http://127.0.0.1:0",
      inboxDir: await mkdtemp(join(tmpdir(), "metistry-events-")),
      policy,
      secureCookies: false,
      localOwner: { token: localOwnerToken, trusted: [] },
      ...extra,
    });
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  }

  async function open(at: string, headers: Record<string, string>): Promise<Stream> {
    const s = await openStream(`${at}/api/events`, headers);
    streams.push(s);
    return s;
  }

  async function mintSession(): Promise<{ cookie: string; id: number }> {
    const pkId = `${MARK}-${mintToken(8)}`;
    passkeyIds.push(pkId);
    await store.storePasskey(pool, { id: pkId, publicKey: new Uint8Array([1]), signCount: 0, transports: [], origin: "t", label: MARK });
    const token = await store.issueSession(pool, pkId, policy);
    const { rows } = await pool.query(`SELECT max(id) AS id FROM auth_sessions WHERE passkey_id = $1`, [pkId]);
    return { cookie: `metistry_session=${token}`, id: Number(rows[0].id) };
  }

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
    queries = new QueryStore(pool);
    hub = new EventHub();
    feed = startEventFeed({ hub, db: pool, connect: () => pool.connect(), log: () => undefined });
    await feed.ready;
    expect(feed.listening).toBe(true);
    base = await serve({ events: hub });
    ({ cookie: sessionCookie } = await mintSession());
    ownerToken = await store.mintOwnerToken(pool, MARK);
    agentToken = (await agents.createAgent(pool, { id: agentId, display_name: "itest events" })).token;
  });

  afterAll(async () => {
    for (const s of streams) s.close();
    hub?.closeAll();
    await feed?.stop();
    for (const s of servers) {
      s.closeAllConnections();
      await new Promise<void>((r) => s.close(() => r()));
    }
    await pool.query(`DELETE FROM agents WHERE id = $1`, [agentId]).catch(() => undefined);
    await pool.query(`DELETE FROM owner_tokens WHERE label = $1`, [MARK]).catch(() => undefined);
    await pool.query(`DELETE FROM auth_sessions WHERE passkey_id = ANY($1)`, [passkeyIds]).catch(() => undefined);
    await pool.query(`DELETE FROM passkeys WHERE id = ANY($1)`, [passkeyIds]).catch(() => undefined);
    await pool.end();
  });

  // ---------------------------------------------------------------- U2's four

  it("U2: no credential is 401", async () => {
    const s = await open(base, {});
    expect(s.status).toBe(401);
    expect(JSON.parse(s.body).error.code).toBe("unauthenticated");
  });

  it("U2: **an agent bearer is refused** — the uniform 403, never a stream, with or without Last-Event-ID", async () => {
    for (const extra of [{}, { "last-event-id": hub.head }]) {
      const s = await open(base, { authorization: `Bearer ${agentToken}`, ...extra });
      expect(s.status).toBe(403);
      expect(s.contentType).toMatch(/^application\/json/);
      expect(JSON.parse(s.body)).toEqual({ error: { code: "forbidden", message: "not granted" } });
    }
  });

  it("U2: the capture owner token is 403 — it captures, it does not watch", async () => {
    const s = await open(base, { authorization: `Bearer ${ownerToken}` });
    expect(s.status).toBe(403);
    expect(JSON.parse(s.body).error.code).toBe("forbidden");
  });

  it("U2: the local owner token reaches it — and so does a passkey session", async () => {
    for (const headers of [asLocal(), { cookie: sessionCookie }]) {
      const s = await open(base, headers);
      expect(s.status).toBe(200);
      expect(s.contentType).toMatch(/^text\/event-stream/);
      // a fresh subscriber is handed the cursor it would resume from, before anything happens
      await expect.poll(() => s.lastId()).toBeDefined();
      expect(Number(s.lastId())).toBeGreaterThan(0);
      s.close();
    }
  });

  // ---------------------------------------------------------------- the ticket's own

  it("**a payload never carries a body — only ids and counts**: the seven tables, written with bodies in them, stream ids", async () => {
    const s = await open(base, asLocal());
    await expect.poll(() => s.lastId()).toBeDefined();

    const one = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows[0];
    const work = Number((await one(`INSERT INTO work (title, kind, claimed_by, lease_expires_at) VALUES ($1, 'task', $2, now() + interval '1 hour') RETURNING id`, [SECRET, agentId])).id);
    const inbox = Number((await one(`INSERT INTO inbox (source, path, note) VALUES ('http', $1, $2) RETURNING id`, [`Inbox/${suffix}.md`, SECRET])).id);
    const proposal = Number((await one(`INSERT INTO proposals (kind, source_agent, trust, payload) VALUES ('report', $1, 'external', $2) RETURNING id`, [agentId, JSON.stringify({ title: SECRET, summary: SECRET })])).id);
    const reply = Number((await one(`INSERT INTO outbound_messages (thread, text) VALUES ('default', $1) RETURNING id`, [SECRET])).id);
    const comment = String((await one(`INSERT INTO artifact_comments (id, work_id, body, author_principal, author_kind) VALUES ($1, $2, $3, 'user', 'human') RETURNING id`, [`cmt_${suffix.toUpperCase()}`, work, SECRET])).id);
    const runId = await startRun(pool, { component: agentId, kind: "tool", tool: "knowledge_search", meta: { args: { query: SECRET }, turn_id: `turn-${suffix}` } });
    await finishRun(pool, runId, { ok: false, error: SECRET, meta: { note: SECRET } });
    await pool.query(`UPDATE agents SET display_name = $2 WHERE id = $1`, [agentId, SECRET]);

    const mine: [string, (d: Record<string, unknown>) => boolean][] = [
      ["work.changed", (d) => d.work_id === work],
      ["presence.changed", (d) => d.agent_id === agentId],
      ["capture.new", (d) => d.inbox_id === inbox],
      ["needs_you.changed", () => true],
      ["message.new", (d) => d.message_id === reply],
      ["thread.changed", (d) => d.work_id === work],
      ["run.started", (d) => d.run_id === runId],
      ["run.finished", (d) => d.run_id === runId],
      ["turn.progress", (d) => d.turn_id === `turn-${suffix}`],
    ];
    for (const [type, match] of mine) await s.waitFor((f) => f.event === type && match(f.data as Record<string, unknown>));

    const allowed = new Map(EVENT_CATALOGUE.map((e) => [e.type, e.payload.replace(/[{}?\s]/g, "").split(/[,|]/).filter(Boolean)]));
    for (const f of s.frames) {
      expect(f.raw, f.event).not.toContain(SECRET);
      expect(payloadRefusal(f.event, f.data), `${f.event} ${JSON.stringify(f.data)}`).toBeUndefined();
      for (const k of Object.keys(f.data as object)) expect(allowed.get(f.event as never), `${f.event} carries ${k}`).toContain(k);
    }
    // a count is not a body: the waiting count is a number, never the queue
    const waiting = s.frames.filter((f) => f.event === "needs_you.changed").map((f) => (f.data as { waiting: unknown }).waiting);
    for (const w of waiting) expect(Number.isInteger(w)).toBe(true);
    expect(proposal).toBeGreaterThan(0);
    expect(comment).toMatch(/^cmt_/);
    s.close();
  });

  it("the notice itself is {table, op, id} and nothing else — on every one of the seven tables, insert and update", async () => {
    const c = await pool.connect();
    const heard: { table: string; op: string; id: unknown; raw: string }[] = [];
    c.on("notification", (m) => {
      if (m.channel === EVENTS_CHANNEL && m.payload) heard.push({ ...JSON.parse(m.payload), raw: m.payload });
    });
    try {
      await c.query(`LISTEN ${EVENTS_CHANNEL}`);
      const one = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows[0];
      const mine: Record<string, unknown> = {};
      mine.work = Number((await one(`INSERT INTO work (title, kind) VALUES ($1, 'task') RETURNING id`, [SECRET])).id);
      await pool.query(`UPDATE work SET title = $2 WHERE id = $1`, [mine.work, `${SECRET}-2`]);
      mine.runs = await startRun(pool, { component: "itest", kind: "probe", meta: { secret: SECRET } });
      await finishRun(pool, mine.runs as number, { ok: false, error: SECRET });
      mine.inbox = Number((await one(`INSERT INTO inbox (source, path, note) VALUES ('http', $1, $2) RETURNING id`, [`Inbox/notice-${suffix}.md`, SECRET])).id);
      await pool.query(`UPDATE inbox SET note = $2 WHERE id = $1`, [mine.inbox, `${SECRET}-2`]);
      mine.proposals = Number((await one(`INSERT INTO proposals (kind, source_agent, trust, payload) VALUES ('report', 'itest', 'internal', $1) RETURNING id`, [JSON.stringify({ title: SECRET })])).id);
      await pool.query(`UPDATE proposals SET feedback = $2 WHERE id = $1`, [mine.proposals, SECRET]);
      mine.outbound_messages = Number((await one(`INSERT INTO outbound_messages (thread, text) VALUES ('default', $1) RETURNING id`, [SECRET])).id);
      await pool.query(`UPDATE outbound_messages SET text = $2 WHERE id = $1`, [mine.outbound_messages, `${SECRET}-2`]);
      mine.artifact_comments = String((await one(`INSERT INTO artifact_comments (id, work_id, body, author_principal, author_kind) VALUES ($1, $2, $3, 'user', 'human') RETURNING id`, [`cmt_N${suffix.toUpperCase()}`, mine.work, SECRET])).id);
      await pool.query(`UPDATE artifact_comments SET body = $2 WHERE id = $1`, [mine.artifact_comments, `${SECRET}-2`]);
      mine.agents = agentId;
      await pool.query(`UPDATE agents SET display_name = $2 WHERE id = $1`, [agentId, `${SECRET}-agent`]);

      const ours = () => heard.filter((n) => mine[n.table] === n.id);
      await expect.poll(() => new Set(ours().map((n) => `${n.table}:${n.op}`)).size, { timeout: 3000 }).toBe(13); // six tables × insert and update, and the agent's update
      for (const n of heard) {
        expect(n.raw).not.toContain(SECRET);
        expect(Object.keys(JSON.parse(n.raw)).sort()).toEqual(["id", "op", "table"]);
      }
    } finally {
      await c.query(`UNLISTEN ${EVENTS_CHANNEL}`).catch(() => undefined);
      c.release();
    }
  });

  it("the triggers stay quiet on a no-op update and throttle a heartbeat — and never fail the write they ride on", async () => {
    const c = await pool.connect();
    const mineHeard: { table: string; op: string; id: unknown }[] = [];
    const r = await startRun(pool, { component: "itest", kind: "probe" });
    c.on("notification", (m) => {
      const n = JSON.parse(m.payload ?? "{}");
      if ((n.table === "runs" && n.id === r) || (n.table === "agents" && n.id === agentId)) mineHeard.push(n);
    });
    try {
      await c.query(`LISTEN ${EVENTS_CHANNEL}`);
      await pool.query(`UPDATE runs SET ok = true, finished_at = now() WHERE id = $1`, [r]); // a change: heard
      await pool.query(`UPDATE runs SET ok = true WHERE id = $1`, [r]); // nothing moved: silent
      await pool.query(`UPDATE agents SET last_seen_at = '2000-01-01T00:00:00Z' WHERE id = $1`, [agentId]); // another minute than any it was seen in: heard
      await pool.query(`UPDATE agents SET last_seen_at = '2000-01-01T00:00:30Z' WHERE id = $1`, [agentId]); // the same minute: throttled
      await pool.query(`UPDATE agents SET last_seen_at = '2000-01-01T00:02:00Z' WHERE id = $1`, [agentId]); // a new minute: heard
      await pool.query(`SELECT pg_sleep(0.3)`);
      await expect.poll(() => mineHeard.length).toBe(3);
      expect(mineHeard.map((n) => n.table)).toEqual(["runs", "agents", "agents"]);
    } finally {
      await c.query(`UNLISTEN ${EVENTS_CHANNEL}`).catch(() => undefined);
      c.release();
    }
  });

  it("accept: **a tool call in a chat turn reaches a subscriber within a second**", async () => {
    const s = await open(base, asLocal());
    await expect.poll(() => s.lastId()).toBeDefined();
    const turnId = `turn-accept-${suffix}`;
    const t0 = Date.now();
    // the engine's own shape (apps/assistant/src/tools.ts): the turn rides in the call's _meta
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${agentToken}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "tasks_list", arguments: {}, _meta: { [TURN_META]: turnId } } }),
    });
    expect(res.status).toBe(200);
    await res.text();
    const f = await s.waitFor((x) => x.event === "turn.progress" && (x.data as { turn_id: string }).turn_id === turnId, 1000);
    const ms = Date.now() - t0;
    expect(ms).toBeLessThan(1000);
    expect(f.data).toEqual({ turn_id: turnId });
    await s.waitFor((x) => x.event === "run.started" && (x.data as { turn_id?: string }).turn_id === turnId, 1000);
    console.log(`accept: tool call → turn.progress on the stream in ${ms} ms`);
    s.close();
  });

  it("the Update Check's finding reaches a subscriber as release.available", async () => {
    const s = await open(base, asLocal());
    await expect.poll(() => s.lastId()).toBeDefined();
    const fetchFn = (async () => new Response(JSON.stringify({ tag_name: "v99.0.0" }), { status: 200 })) as typeof fetch;
    const updateCheck = routines.find((r) => r.name === "update-check")!;
    expect(await updateCheck.run(pool, { runtimeVersion: "0.11.0", fetchFn, env: {} } as Parameters<typeof updateCheck.run>[1])).toBe(1);
    const f = await s.waitFor((x) => x.event === "release.available", 2000);
    expect(f.data).toEqual({ version: "99.0.0" });
    await s.waitFor((x) => x.event === "routine.status" && (x.data as { name: string }).name === "update-check", 2000);
    s.close();
  });

  it("**a reconnect with Last-Event-ID replays exactly the missed events** — then carries on live", async () => {
    // a hub of its own, fed by nothing but this test, so "exactly" can be exact
    const own = new EventHub({ firstId: 7000 });
    const at = await serve({ events: own });
    const first = await open(at, asLocal());
    await expect.poll(() => first.lastId()).toBe("7000");
    own.publish("work.changed", { work_id: 1 });
    own.publish("capture.new", { inbox_id: 2 });
    own.publish("needs_you.changed", { waiting: 3 });
    await first.waitFor((f) => f.id === "7003");
    const seen = first.lastId()!;
    first.close();
    await expect.poll(() => own.streams).toBe(0);

    // while nobody listens
    own.publish("message.new", { message_id: 4, thread: "default" });
    own.publish("work.changed", { work_id: 5 });
    own.publish("thread.changed", { artifact_id: "art_01M3FY9WJ7M4N2ZAJFNZBVH8KK" });

    const again = await open(at, { ...asLocal(), "last-event-id": seen });
    await again.waitFor((f) => f.id === "7006");
    own.publish("presence.changed", { agent_id: "cursor" });
    await again.waitFor((f) => f.id === "7007");
    expect(again.frames.map((f) => [f.id, f.event, f.data])).toEqual([
      ["7004", "message.new", { message_id: 4, thread: "default" }],
      ["7005", "work.changed", { work_id: 5 }],
      ["7006", "thread.changed", { artifact_id: "art_01M3FY9WJ7M4N2ZAJFNZBVH8KK" }],
      ["7007", "presence.changed", { agent_id: "cursor" }],
    ]);
    again.close();

    // a gap the ring no longer holds — or an id from another console — is a resync, numbered at the head
    for (const stale of ["6999", "123456789"]) {
      const s = await open(at, { ...asLocal(), "last-event-id": stale });
      const r = await s.waitFor((f) => f.event === "resync");
      expect(r).toMatchObject({ id: own.head, data: {} });
      expect(s.frames).toHaveLength(1);
      s.close();
    }
  });

  it("the Mac's transport gets the same frames: `console session --stdio` with stream: true and last_event_id (F-12)", async () => {
    const own = new EventHub({ firstId: 8000 });
    const at = await serve({ events: own });
    own.publish("work.changed", { work_id: 1 });
    own.publish("work.changed", { work_id: 2 });

    const lines: Record<string, unknown>[] = [];
    let push!: (line: string | null) => void;
    const queue: (string | null)[] = [];
    let notify: (() => void) | undefined;
    push = (line) => {
      queue.push(line);
      notify?.();
    };
    const input = (async function* () {
      for (;;) {
        while (queue.length === 0) await new Promise<void>((r) => (notify = r));
        const next = queue.shift()!;
        if (next === null) return;
        yield next;
      }
    })();
    const session = runConsoleSession({
      env: { METISTRY_CONSOLE_URL: at, METISTRY_LOCAL_OWNER_TOKEN: localOwnerToken },
      platform: "linux",
      input,
      write: (line) => void lines.push(JSON.parse(line)),
    });
    push(JSON.stringify({ id: "ev", method: "GET", path: "/api/events", stream: true, last_event_id: "8001" }));
    await expect.poll(() => lines.filter((l) => l.event).length).toBe(1); // the replay: exactly 8002
    own.publish("capture.new", { inbox_id: 3 });
    await expect.poll(() => lines.filter((l) => l.event).length).toBe(2);
    push(JSON.stringify({ id: "ev", cancel: true }));
    await expect.poll(() => lines.some((l) => l.ended)).toBe(true);
    push(null);
    await session;
    expect(lines).toEqual([
      { id: "ev", event: { id: "8002", type: "work.changed", data: { work_id: 2 } } },
      { id: "ev", event: { id: "8003", type: "capture.new", data: { inbox_id: 3 } } },
      { id: "ev", ended: "cancelled" },
    ]);
    expect(JSON.stringify(lines)).not.toContain(localOwnerToken);
  });

  it("a revoked session's stream ends at the next heartbeat — the credential is asked again, not once", async () => {
    const own = new EventHub({ heartbeatMs: 50 });
    const at = await serve({ events: own });
    const { cookie, id } = await mintSession();
    const s = await open(at, { cookie });
    expect(s.status).toBe(200);
    await expect.poll(() => s.comments()).toBeGreaterThan(0); // heartbeats arrive
    expect(await store.revokeSession(pool, id)).toBe(true);
    await expect(Promise.race([s.ended.then(() => "ended"), new Promise((r) => setTimeout(() => r("still open"), 2000))])).resolves.toBe("ended");
    await expect.poll(() => own.streams).toBe(0);
  });

  it("refuses a stream past the cap with 429 naming the knob, and serves the next once one closes", async () => {
    const own = new EventHub({ maxStreams: 1 });
    const at = await serve({ events: own });
    const a = await open(at, asLocal());
    expect(a.status).toBe(200);
    const b = await open(at, asLocal());
    expect(b.status).toBe(429);
    expect(JSON.parse(b.body).error).toMatchObject({ code: "rate_limited" });
    expect(JSON.parse(b.body).error.message).toContain("METISTRY_EVENTS_MAX_STREAMS");
    a.close();
    await expect.poll(() => own.streams).toBe(0);
    const c = await open(at, asLocal());
    expect(c.status).toBe(200);
    c.close();
  });

  it("with no hub wired the route is 503 not_available, never a hanging stream", async () => {
    const at = await serve({});
    const s = await open(at, asLocal());
    expect(s.status).toBe(503);
    expect(JSON.parse(s.body).error.code).toBe("not_available");
  });
});
