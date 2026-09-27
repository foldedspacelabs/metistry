// The reach gate (design-build-plan §2.1, F-13): a route the client API
// table files under `local` is the owner ON THIS MAC, proved by the local
// owner token alone. A passkey session — even one from 127.0.0.1 — is
// refused `403 local_only` naming the Mac app, before any handler runs; the
// local owner token from anywhere but a loopback peer is the uniform 401 it
// always was; and `metistry connect`, which mints through these routes with
// the local owner token, still works end to end.
//
// Over real sockets against the scratch database (docs/ops/testing.md). The
// conformance test (client-api.conformance.integration.test.ts) holds every
// row's reach generally; this file is the ticket's own misuse tests, with
// bodies that WOULD succeed, so a refusal here is the gate and not a 400.
import { rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { CLIENT_API, isLocalRoute, mintToken, routeKey, tokenHash } from "@foldedspacelabs/metistry-core";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";
import { connect } from "@foldedspacelabs/metistry-cli";
import { makeServer } from "../src/server.js";
import * as store from "../src/auth-store.js";
import * as agents from "../src/agents.js";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url));
const policy = { idleDays: 30, maxDays: 365 };
const MARK = "itest-reach-gate";
const suffix = mintToken(6).toLowerCase().replaceAll(/[^a-z0-9]/g, "").slice(0, 6) || "x";

/** One of this host's real, non-loopback IPv4 addresses — the peer a request over it genuinely has. */
const external = Object.values(networkInterfaces())
  .flatMap((a) => a ?? [])
  .find((a) => a.family === "IPv4" && !a.internal)?.address;

/** The served `local` rows, with a path a handler would accept for `agentId`. */
const LOCAL = CLIENT_API.filter((r) => r.served && isLocalRoute(r));
const pathFor = (path: string, agentId: string) => path.replace(":id", agentId).replace(":name", ROUTINE);
/** A New Routine the scratch overlay holds, so the assignment door has one to change (T3-3). */
const ROUTINE = "probe-digest";

describe.skipIf(!hasDb)("the reach gate: `local` routes are the owner on this Mac", () => {
  let pool: pg.Pool;
  let queries: QueryStore;
  let server: ReturnType<typeof makeServer>;
  let base: string;
  let sessionCookie: string;
  let ownerToken: string;
  let agentToken: string;
  const localOwnerToken = mintToken();
  const agentId = `itest-reach-${suffix}`; // an existing row: the target of `rotate`, and the bearer the agent probes present
  const minted: string[] = [agentId];
  const passkeyIds: string[] = [];
  const inboxDirs: string[] = [];
  let overlay: Buffer = Buffer.from(`routines:\n  ${ROUTINE}:\n    actor: someone-else\n    task: "Draft the digest"\n    schedule: { days: [mon], at: ["09:00"] }\n`);

  /** A body each local route would accept — a fresh id to register, nothing for rotate, an assignment for the Scheduled door. */
  function bodyFor(r: (typeof LOCAL)[number]): Record<string, unknown> {
    if (routeKey(r) === "PUT /api/scheduled/routines/:name/assignment") {
      return { actor: agentId, task: "Summarise the week's Projects/ changes.", grants: { read: ["Projects"] }, schedule: { days: ["fri"], at: ["16:00"] } };
    }
    if (routeKey(r) === "POST /api/agents") {
      const id = `itest-reach-new-${suffix}-${minted.length}`;
      minted.push(id);
      return { id, display_name: "reach gate probe", kind: "external" };
    }
    return {};
  }

  async function storedHash(id: string): Promise<string | null> {
    const { rows } = await pool.query(`SELECT token_hash FROM agents WHERE id = $1`, [id]);
    return (rows[0]?.token_hash as string | undefined) ?? null;
  }

  async function config(extra: Partial<Parameters<typeof makeServer>[2]> = {}): Promise<Parameters<typeof makeServer>[2]> {
    const inboxDir = await mkdtemp(join(tmpdir(), "metistry-reach-gate-"));
    inboxDirs.push(inboxDir);
    return {
      origin: "http://127.0.0.1:0",
      inboxDir,
      policy,
      secureCookies: false,
      localOwner: { token: localOwnerToken, trusted: [] }, // loopback only, as on the launchd shape
      // a scratch overlay holding one New Routine, in memory — the assignment door's target
      scheduled: {
        components: [],
        overlay: {
          read: async () => overlay,
          write: async (content) => void (overlay = content),
        },
        timeZone: "Etc/UTC",
      },
      ...extra,
    };
  }

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
    queries = new QueryStore(pool);
    server = makeServer(pool, queries, await config());
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const pkId = `${MARK}-${mintToken(8)}`;
    passkeyIds.push(pkId);
    await store.storePasskey(pool, { id: pkId, publicKey: new Uint8Array([1]), signCount: 0, transports: [], origin: "t", label: MARK });
    sessionCookie = `metistry_session=${await store.issueSession(pool, pkId, policy)}`;
    ownerToken = await store.mintOwnerToken(pool, MARK);
    agentToken = (await agents.createAgent(pool, { id: agentId, display_name: "itest reach gate" })).token;
    await pool.query(`DELETE FROM agents WHERE id = 'devin'`); // `metistry connect devin` below mints it fresh
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM agents WHERE id = ANY($1) OR id = 'devin'`, [minted]);
    await pool.query(`DELETE FROM owner_tokens WHERE label = $1`, [MARK]).catch(() => undefined);
    await pool.query(`DELETE FROM auth_sessions WHERE passkey_id = ANY($1)`, [passkeyIds]).catch(() => undefined);
    await pool.query(`DELETE FROM passkeys WHERE id = ANY($1)`, [passkeyIds]).catch(() => undefined);
    await new Promise<void>((r) => server.close(() => r()));
    await pool.end();
    for (const dir of inboxDirs) rmSync(dir, { recursive: true, force: true });
  });

  async function post(at: string, path: string, headers: Record<string, string>, body: unknown, method = "POST"): Promise<{ status: number; body: { error?: { code: string; message: string }; token?: string } }> {
    const r = await fetch(at + path, { method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as { error?: { code: string; message: string }; token?: string } };
  }

  it("the table files minting a bearer under `local` — and Purge Now, which cannot be undone (T3-9)", () => {
    expect(LOCAL.map(routeKey)).toEqual(["POST /api/agents", "POST /api/agents/:id/rotate", "POST /api/sessions/purge", "PUT /api/scheduled/routines/:name/assignment"]);
  });

  it("**a passkey session from 127.0.0.1 is refused on every local route** — 403 local_only, naming the Mac app, and nothing is minted", async () => {
    // Rows after this one only: another suite in this package (sessions-purge)
    // can be refused on a `local` route at the same moment, so "the newest N
    // rows" is not this test's rows.
    const since = Number((await pool.query(`SELECT coalesce(max(id), 0) AS id FROM runs`)).rows[0].id);
    for (const r of LOCAL) {
      const before = await storedHash(agentId);
      const overlayBefore = overlay;
      const body = bodyFor(r);
      const p = await post(base, pathFor(r.path, agentId), { cookie: sessionCookie }, body, r.method);
      expect(overlay, `${routeKey(r)}: the assignment was not written`).toBe(overlayBefore);
      expect(p.status, routeKey(r)).toBe(403);
      expect(p.body.error?.code, routeKey(r)).toBe("local_only");
      expect(p.body.error?.message, routeKey(r)).toContain("Mac app");
      expect(p.body.error?.message, routeKey(r)).toContain(routeKey(r));
      expect(p.body.token, routeKey(r)).toBeUndefined();
      // the handler never ran: no row registered, no bearer rotated
      if (typeof body.id === "string") expect(await storedHash(body.id), routeKey(r)).toBeNull();
      expect(await storedHash(agentId), routeKey(r)).toBe(before);
    }
    // …and the refusal is on the ledger, with the route and the credential kind
    const { rows } = await pool.query(
      `SELECT meta FROM runs WHERE component = 'console' AND kind = 'auth' AND tool = 'local_only' AND id > $1 ORDER BY id`,
      [since],
    );
    expect([...new Set(rows.map((x) => x.meta.route))].sort()).toEqual(LOCAL.map(routeKey).sort());
    for (const x of rows) expect(x.meta.via).toBe("session");
  });

  it("a passkey session is still the owner everywhere else in the agent registry", async () => {
    const list = await fetch(`${base}/api/agents`, { headers: { cookie: sessionCookie } });
    expect(list.status).toBe(200);
    const grants = await fetch(`${base}/api/agents/${agentId}/grants`, {
      method: "PUT",
      headers: { cookie: sessionCookie, "content-type": "application/json" },
      body: JSON.stringify({ tier: "none" }),
    });
    expect(grants.status).toBe(200);
  });

  it("U2: no credential is the uniform 401; an agent bearer and the capture owner token are the uniform 403 — never local_only", async () => {
    for (const r of LOCAL) {
      const path = pathFor(r.path, agentId);
      const none = await post(base, path, {}, bodyFor(r), r.method);
      expect(none.status, routeKey(r)).toBe(401);
      expect(none.body).toEqual({ error: { code: "unauthenticated", message: "authentication required" } });
      for (const bearer of [agentToken, ownerToken]) {
        const p = await post(base, path, { authorization: `Bearer ${bearer}` }, bodyFor(r), r.method);
        expect(p.status, routeKey(r)).toBe(403);
        expect(p.body, routeKey(r)).toEqual({ error: { code: "forbidden", message: "not granted" } });
      }
    }
  });

  it("U2: the local owner token from a loopback peer reaches every local route", async () => {
    for (const r of LOCAL) {
      const before = await storedHash(agentId);
      const p = await post(base, pathFor(r.path, agentId), { authorization: `Bearer ${localOwnerToken}` }, bodyFor(r), r.method);
      expect([200, 201], `${routeKey(r)}: ${JSON.stringify(p.body)}`).toContain(p.status);
      // the two mint routes answer a bearer; Purge Now's empty body is its preview (sessions-purge.integration.test.ts);
      // the assignment door answers the routine as it now stands (scheduled-routes.integration.test.ts)
      if (routeKey(r) === "PUT /api/scheduled/routines/:name/assignment") expect(overlay.toString("utf8")).toContain(`actor: ${agentId}`);
      else if (routeKey(r) !== "POST /api/sessions/purge") expect(typeof p.body.token, routeKey(r)).toBe("string");
      if (routeKey(r) === "POST /api/agents/:id/rotate") {
        expect(await storedHash(agentId)).toBe(tokenHash(p.body.token!));
        expect(await storedHash(agentId)).not.toBe(before);
        agentToken = p.body.token!; // the old one stopped working; later tests present the new one
      }
    }
  });

  it("a passkey cookie riding beside the local owner token is still a passkey session — the gate fails closed", async () => {
    const p = await post(base, pathFor("/api/agents/:id/rotate", agentId), { cookie: sessionCookie, authorization: `Bearer ${localOwnerToken}` }, {});
    expect(p.status).toBe(403);
    expect(p.body.error?.code).toBe("local_only");
  });

  it.skipIf(!external)("**the local owner token from a non-loopback peer is refused as today** — the uniform 401, audited", async () => {
    // A second server on 0.0.0.0, reached over one of this host's real
    // interfaces: the peer address is genuinely not loopback.
    const exposed = makeServer(pool, queries, await config());
    await new Promise<void>((r) => exposed.listen(0, "0.0.0.0", r));
    const remote = `http://${external}:${(exposed.address() as AddressInfo).port}`;
    try {
      for (const r of LOCAL) {
        const before = await storedHash(agentId);
        const body = bodyFor(r);
        const stolen = await post(remote, pathFor(r.path, agentId), { authorization: `Bearer ${localOwnerToken}` }, body, r.method);
        const spoofed = await post(remote, pathFor(r.path, agentId), { authorization: `Bearer ${localOwnerToken}`, "x-forwarded-for": "127.0.0.1", "x-real-ip": "127.0.0.1" }, body, r.method);
        const unknown = await post(remote, pathFor(r.path, agentId), { authorization: `Bearer ${mintToken()}` }, body, r.method);
        for (const p of [stolen, spoofed, unknown]) {
          expect(p.status, routeKey(r)).toBe(401);
          expect(p.body, routeKey(r)).toEqual(unknown.body); // indistinguishable from a token nobody minted
        }
        if (typeof body.id === "string") expect(await storedHash(body.id)).toBeNull();
        expect(await storedHash(agentId)).toBe(before);
      }
      const { rows } = await pool.query(`SELECT meta FROM runs WHERE component = 'console' AND kind = 'auth' AND tool = 'owner_token_remote' ORDER BY id DESC LIMIT 1`);
      expect(String(rows[0]?.meta.remote)).not.toMatch(/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/);
    } finally {
      await new Promise<void>((r) => exposed.close(() => r()));
    }
  });

  it("**`metistry connect` still works** — it mints and rotates through the local routes with the local owner token", async () => {
    // `devin` is the connect tool whose bearer is pasted into a form, so the
    // verb needs no Keychain and runs on any platform CI does.
    const env = { METISTRY_CONSOLE_URL: base, METISTRY_LOCAL_OWNER_TOKEN: localOwnerToken };
    const first = await connect({ tool: "devin", env, platform: "linux" });
    expect(first.created).toBe(true);
    expect(first.paste?.bearer).toMatch(/^Bearer \S+$/);
    expect(await storedHash("devin")).toBe(tokenHash(first.paste!.bearer!.slice("Bearer ".length)));

    const again = await connect({ tool: "devin", env, platform: "linux" });
    expect(again.created).toBe(false);
    expect(again.paste?.bearer).toBeUndefined(); // an existing row is never shown a secret

    const rotated = await connect({ tool: "devin", env, platform: "linux", rotate: true });
    expect(rotated.rotated).toBe(true);
    expect(await storedHash("devin")).toBe(tokenHash(rotated.paste!.bearer!.slice("Bearer ".length)));
  });
});
