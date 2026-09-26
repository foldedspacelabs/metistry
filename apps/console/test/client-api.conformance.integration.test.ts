// The client API conformance test (design-build-plan §2.1, F-1): the table in
// `packages/core/src/client-api.ts` against the server that claims to serve
// it, over real sockets against the scratch database.
//
//   * every row the table says is served reaches a handler;
//   * every row frozen ahead of its ticket is answered as no route at all;
//   * nothing outside the table is served — every method on every path the
//     table names, and paths it does not;
//   * each served row admits exactly the credential kinds it records, and
//     refuses the others with 401 or 403 — the reach the document states is
//     the reach the gate enforces;
//   * every row's reach, checked for every credential: a served `local` row
//     answers a passkey session `403 local_only`, and no other row or
//     credential ever gets that answer (F-13);
//   * `api_version` is in `/health` and `/api/identity`, and the version
//     header is on every answer.
//
// "Reaches a handler" is not guessable from a 404: `POST /api/proposals/<id>`
// answers 404 for a row it cannot find, exactly as the server answers a path
// it does not route. So the console marks its "no such route" answers
// in-process (`sendUnrouted` in http-util.ts) — never on the wire — and this
// file reads the mark off each response through a `request` listener.
//
// Nothing here can reach the operator's install: `loadTestEnv` scrubs every
// `METISTRY_*` but the scratch database's (docs/ops/testing.md), the inbox is
// a temp directory, and every probe body is one the route refuses before it
// writes anything.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { memoryVault } from "@foldedspacelabs/metistry-artifacts";
import { API_VERSION, API_VERSION_HEADER, CLIENT_API, isLocalRoute, matchRoute, mintToken, routeKey, servedRoute, type ClientPrincipal, type ClientRoute } from "@foldedspacelabs/metistry-core";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";
import { makeServer } from "../src/server.js";
import { wasUnrouted } from "../src/http-util.js";
import * as store from "../src/auth-store.js";
import * as agents from "../src/agents.js";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url));
const policy = { idleDays: 30, maxDays: 365 };
const MARK = "itest-client-api";
const ULID0 = "0".repeat(26);
/** Every credential kind, in the table's order; `anyone` is no credential at all. */
const CREDENTIALS: readonly ClientPrincipal[] = ["anyone", "session", "local_owner", "owner_token", "agent"];
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

/**
 * A concrete path for a template: each parameter gets a value its handler's
 * own grammar accepts (a 12-digit id, a slug, a ULID) and that names no row,
 * so a served route answers from its handler — a 404 for the missing row, a
 * 400 for the empty body — and never from the router.
 */
function sample(path: string): string {
  return path
    .split("/")
    .map((seg) => {
      if (!seg.startsWith(":")) return seg;
      const name = seg.slice(1);
      if (path.startsWith("/api/agents/")) return "probe-agent";
      if (path.startsWith("/api/artifacts/")) return ({ id: `art_${ULID0}`, version: `ver_${ULID0}`, comment: `cmt_${ULID0}` } as Record<string, string>)[name] ?? "probe";
      if (name === "id") return "999999999999";
      if (name === "slug") return "probe-project";
      return "probe";
    })
    .join("/");
}

/** Query strings that keep a served read small; nothing else needs one to be routed. */
const QUERY: Record<string, string> = { "GET /api/runs/export": "?limit=1" };

describe.skipIf(!hasDb)("the client API table against the console that serves it", () => {
  let pool: pg.Pool;
  let server: ReturnType<typeof makeServer>;
  let base: string;
  let ownerToken: string;
  let agentToken: string;
  let sessionCookie: string;
  const localOwnerToken = mintToken();
  const agentId = `itest-capi-${mintToken(6).toLowerCase().replaceAll(/[^a-z0-9]/g, "").slice(0, 6) || "x"}`;
  const passkeyIds: string[] = [];
  /** probe id → whether the server answered "no such route" */
  const unrouted = new Map<string, boolean>();
  let probes = 0;

  async function mintSession(): Promise<string> {
    const pkId = `${MARK}-${mintToken(8)}`;
    passkeyIds.push(pkId);
    await store.storePasskey(pool, { id: pkId, publicKey: new Uint8Array([1]), signCount: 0, transports: [], origin: "t", label: MARK });
    return `metistry_session=${await store.issueSession(pool, pkId, policy)}`;
  }

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
    const queries = new QueryStore(pool);
    await queries.loadDir(fileURLToPath(new URL("../../../seed/queries", import.meta.url)));

    // Everything a route family needs to reach its handlers rather than a
    // blanket answer for the whole family: a vault for the artifacts module
    // (without one every /api/artifacts path is the same 503) and a push
    // config (without one every /api/push path is the same 200).
    server = makeServer(pool, queries, {
      origin: "http://127.0.0.1:0",
      inboxDir: await mkdtemp(join(tmpdir(), "metistry-client-api-")),
      policy,
      secureCookies: false,
      localOwner: { token: localOwnerToken, trusted: [] },
      vault: memoryVault(),
      push: { publicKey: "probe-public", privateKey: "probe-private", subject: "mailto:probe@example.invalid" },
      identity: { instance_id: "8b6a3a2e-1111-4222-8333-444455556666", name: "Probe", icon: null },
      version: "0.0.0-test",
    });
    server.prependListener("request", (req: IncomingMessage, res: ServerResponse) => {
      const id = req.headers["x-probe-id"];
      if (typeof id === "string") res.once("finish", () => unrouted.set(id, wasUnrouted(res)));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    sessionCookie = await mintSession();
    ownerToken = await store.mintOwnerToken(pool, MARK);
    agentToken = (await agents.createAgent(pool, { id: agentId, display_name: "itest client api" })).token;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM agents WHERE id = $1`, [agentId]);
    await pool.query(`DELETE FROM owner_tokens WHERE label = $1`, [MARK]).catch(() => undefined);
    await pool.query(`DELETE FROM auth_sessions WHERE passkey_id = ANY($1)`, [passkeyIds]).catch(() => undefined);
    await pool.query(`DELETE FROM passkeys WHERE id = ANY($1)`, [passkeyIds]).catch(() => undefined);
    await new Promise<void>((r) => server.close(() => r()));
    await pool.end();
  });

  async function headersFor(cred: ClientPrincipal, fresh: boolean): Promise<Record<string, string>> {
    if (cred === "session") return { cookie: fresh ? await mintSession() : sessionCookie };
    if (cred === "local_owner") return { authorization: `Bearer ${localOwnerToken}` };
    if (cred === "owner_token") return { authorization: `Bearer ${ownerToken}` };
    if (cred === "agent") return { authorization: `Bearer ${agentToken}` };
    return {};
  }

  /**
   * One request, and what the server did with it. Every body is one a route
   * refuses before writing: an unknown key, and for `/capture` an
   * Idempotency-Key over its 200-character ceiling.
   */
  async function probe(method: string, path: string, cred: ClientPrincipal): Promise<{ status: number; unrouted: boolean; body: string; version: string | null }> {
    const id = String(++probes);
    const bodied = method !== "GET" && method !== "DELETE";
    const r = await fetch(base + path, {
      method,
      headers: {
        ...(await headersFor(cred, path === "/auth/logout")), // logout ends the session it is sent with
        "x-probe-id": id,
        ...(bodied ? { "content-type": "application/json" } : {}),
        ...(path === "/capture" ? { "idempotency-key": "k".repeat(201) } : {}),
      },
      ...(bodied ? { body: JSON.stringify({ __probe__: true }) } : {}),
    });
    const body = await r.text();
    for (let i = 0; i < 50 && !unrouted.has(id); i++) await new Promise((res) => setTimeout(res, 2));
    expect(unrouted.has(id), `${method} ${path}: the server never finished the response`).toBe(true);
    return { status: r.status, unrouted: unrouted.get(id)!, body, version: r.headers.get(API_VERSION_HEADER) };
  }

  const pathOf = (r: ClientRoute) => sample(r.path) + (QUERY[routeKey(r)] ?? "");
  const methodOf = (r: ClientRoute) => (r.method === "*" ? "POST" : r.method);
  /** The credential a row is first probed with: the strongest it admits. */
  const firstAdmitted = (r: ClientRoute): ClientPrincipal => (["local_owner", "session", "owner_token", "agent", "anyone"] as const).find((c) => r.principals.includes(c))!;

  it("every row the table serves reaches a handler", async () => {
    const misses: string[] = [];
    for (const r of CLIENT_API.filter((x) => x.served)) {
      const p = await probe(methodOf(r), pathOf(r), firstAdmitted(r));
      if (p.unrouted) misses.push(`${routeKey(r)} (as ${firstAdmitted(r)}): answered as no route`);
    }
    expect(misses, "rows the table lists as served that nothing serves — serve them, or mark them served: false with their ticket").toEqual([]);
  });

  it("every row frozen ahead of its ticket is not served yet", async () => {
    const early: string[] = [];
    for (const r of CLIENT_API.filter((x) => !x.served)) {
      const p = await probe(methodOf(r), pathOf(r), firstAdmitted(r));
      if (!p.unrouted || p.status !== 404) early.push(`${routeKey(r)} (${r.ticket}): ${p.status}`);
    }
    expect(early, "the server serves a row the table says is not served — set served: true on it").toEqual([]);
  });

  it("nothing outside the table is served: every method on every path it names, and paths it does not", async () => {
    const paths = new Set(CLIENT_API.map((r) => sample(r.path)));
    for (const extra of [
      "/api/bogus",
      "/api/agents/probe-agent/bogus",
      "/api/compute/bogus",
      "/api/knowledge/bogus",
      `/api/artifacts/art_${ULID0}/bogus`,
      "/api/push/bogus",
      "/api/q/a/b",
      "/api/devices/",
      "/api/tasks/1/bogus",
      "/api/work/1/bogus",
      "/nope",
    ]) {
      paths.add(extra);
    }
    const leaks: string[] = [];
    for (const path of paths) {
      for (const method of METHODS) {
        if (matchRoute(method, path)?.route.served) continue; // a served row: the first test's business
        for (const cred of ["local_owner", "session"] as const) {
          const p = await probe(method, path, cred);
          if (!p.unrouted) leaks.push(`${method} ${path} (as ${cred}): ${p.status}`);
        }
      }
    }
    expect(leaks, "the server serves something the table does not list — add its row (packages/core/src/client-api.ts) and its line (docs/ops/client-api.md)").toEqual([]);
  });

  it("each served row admits exactly the credential kinds it records, and refuses the rest with 401 or 403", async () => {
    const wrong: string[] = [];
    for (const r of CLIENT_API.filter((x) => x.served && !x.reach.includes("public"))) {
      for (const cred of CREDENTIALS) {
        const p = await probe(methodOf(r), pathOf(r), cred);
        const admitted = p.status !== 401 && p.status !== 403;
        if (admitted !== r.principals.includes(cred)) wrong.push(`${routeKey(r)} as ${cred}: ${p.status}, table says ${r.principals.includes(cred) ? "admitted" : "refused"}`);
        if (cred === "anyone" && p.status !== 401) wrong.push(`${routeKey(r)} with no credential: ${p.status}, never 401`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("every row's reach is the gate's: `local` refuses a passkey session with local_only, and nothing else ever answers it", async () => {
    // For every row the table lists — served or frozen — and every credential
    // kind. A served `local` row is the owner on this Mac: the local owner
    // token alone, and a passkey session is told `local_only` (the credential
    // it would need). An unserved `local` row is still "not served yet" to the
    // owner, and the capture token and agent bearers keep their uniform 403
    // everywhere — so `local_only` appears exactly where the table says.
    const wrong: string[] = [];
    let localRows = 0;
    for (const r of CLIENT_API) {
      if (r.served && isLocalRoute(r)) localRows++;
      for (const cred of CREDENTIALS) {
        const p = await probe(methodOf(r), pathOf(r), cred);
        let code: unknown;
        try {
          code = (JSON.parse(p.body) as { error?: { code?: unknown } }).error?.code;
        } catch {
          code = undefined;
        }
        const want = r.served && isLocalRoute(r) && cred === "session";
        if ((code === "local_only") !== want) wrong.push(`${routeKey(r)} (${r.reach.join(" · ")}${r.served ? "" : ", not served"}) as ${cred}: ${p.status} ${String(code)}, want ${want ? "403 local_only" : "anything but local_only"}`);
        if (code === "local_only" && p.status !== 403) wrong.push(`${routeKey(r)} as ${cred}: local_only with ${p.status}, never 403`);
      }
    }
    expect(wrong).toEqual([]);
    expect(localRows, "the table serves at least one local row, or this test proves nothing about the gate").toBeGreaterThan(0);
  });

  it("the public rows answer with no credential at all", async () => {
    for (const r of CLIENT_API.filter((x) => x.reach.includes("public"))) {
      const p = await probe(methodOf(r), pathOf(r), "anyone");
      expect(p.unrouted, routeKey(r)).toBe(false);
      // the ceremonies refuse an empty body with their own 401; what matters is that nothing ASKED for a credential first
      expect([200, 400, 401, 503], routeKey(r)).toContain(p.status);
    }
  });

  it("the owner's 404 for an unlisted route names the routes beside it", async () => {
    const p = await probe("GET", "/api/knowledge/backlinks", "local_owner");
    expect(p.status).toBe(404);
    expect(p.unrouted).toBe(true);
    const message = JSON.parse(p.body).error.message as string;
    for (const door of ["GET /api/knowledge/search", "GET /api/knowledge/page", "GET /api/knowledge/pages", "GET /api/knowledge/links"]) expect(message).toContain(door);
    // …and the capture token's answer for the same path is unchanged, byte for byte: a 403 across the family
    const t = await probe("GET", "/api/knowledge/backlinks", "owner_token");
    expect(t.status).toBe(403);
    expect(JSON.parse(t.body)).toEqual({ error: { code: "forbidden", message: "not granted" } });
  });

  it("the table is read before a family's blanket answer: an unlisted spelling never reaches one", async () => {
    // With no VAPID keys, the push family answers every path under
    // /api/push/ with `{"push":"absent"}` — a blanket answer that, before the
    // table was read at dispatch, made `GET /api/push/anything` a 200. The
    // check in server.ts is what stops a spelling the table never had from
    // reaching a handler at all.
    const bare = makeServer(pool, new QueryStore(pool), {
      origin: "http://127.0.0.1:0",
      inboxDir: await mkdtemp(join(tmpdir(), "metistry-client-api-bare-")),
      policy,
      secureCookies: false,
      localOwner: { token: localOwnerToken, trusted: [] },
    });
    const seen = new Map<string, boolean>();
    bare.prependListener("request", (req: IncomingMessage, res: ServerResponse) => {
      res.once("finish", () => seen.set(String(req.url), wasUnrouted(res)));
    });
    await new Promise<void>((r) => bare.listen(0, "127.0.0.1", r));
    try {
      const at = `http://127.0.0.1:${(bare.address() as AddressInfo).port}`;
      const listed = await fetch(`${at}/api/push/vapid-key`, { headers: { cookie: sessionCookie } });
      expect(listed.status).toBe(200);
      expect(await listed.json()).toEqual({ push: "absent" });
      const unlisted = await fetch(`${at}/api/push/anything`, { headers: { cookie: sessionCookie } });
      expect(unlisted.status).toBe(404);
      expect((await unlisted.json()).error.message).toContain("GET /api/push/vapid-key");
      await new Promise((r) => setTimeout(r, 5));
      expect(seen.get("/api/push/anything")).toBe(true);
    } finally {
      await new Promise<void>((r) => bare.close(() => r()));
    }
  });

  // ------------------------------------------------------------ the version

  it("`/health` carries api_version", async () => {
    const r = await fetch(`${base}/health`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, api_version: API_VERSION });
    expect(r.headers.get(API_VERSION_HEADER)).toBe(String(API_VERSION));
  });

  it("`/api/identity` carries api_version, and advertises `events` exactly while the stream is served", async () => {
    const r = await fetch(`${base}/api/identity`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.api_version).toBe(API_VERSION);
    expect(r.headers.get(API_VERSION_HEADER)).toBe(String(API_VERSION));
    expect(body.capabilities.includes("events")).toBe(servedRoute("GET", "/api/events") !== undefined);
  });

  it("every answer carries the version header — refusals and no-route answers included", async () => {
    for (const [method, path, cred] of [
      ["GET", "/api/devices", "anyone"], // 401
      ["GET", "/api/devices", "agent"], // 403
      ["GET", "/api/bogus", "local_owner"], // 404, no route
      ["GET", "/api/devices", "local_owner"], // 200
    ] as const) {
      const p = await probe(method, path, cred);
      expect(p.version, `${method} ${path} as ${cred} (${p.status})`).toBe(String(API_VERSION));
    }
  });
});

describe("the conformance probe's own samples", () => {
  it("fill every parameter of every row", () => {
    for (const r of CLIENT_API) expect(sample(r.path), routeKey(r)).not.toContain(":");
  });

  it("keep a served row's sample on that row", () => {
    // A sample that matched a different row would probe the wrong handler.
    for (const r of CLIENT_API.filter((x) => x.served)) {
      const m = matchRoute(r.method === "*" ? "POST" : r.method, sample(r.path));
      expect(m && routeKey(m.route), routeKey(r)).toBe(routeKey(r));
    }
  });
});
