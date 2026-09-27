// `GET /api/variables` (design-build-plan §2.14, T4-4) over real sockets against
// the scratch database (docs/ops/testing.md), reading a scratch instance
// directory under the OS temp dir.
//
// Bold (the ticket's own): **a key-shaped value is refused** — a hand-edited
// variables.yaml carrying one does not load, the route answers 400 naming the
// variable, and neither the body nor the ledger row repeats the value. U2's
// misuse tests: 401 with no credential, 403 for an agent bearer and for the
// capture owner token, and the local owner token (and a passkey session)
// reach it.
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { mintToken } from "@foldedspacelabs/metistry-core";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";
import { makeServer } from "../src/server.js";
import * as store from "../src/auth-store.js";
import * as agents from "../src/agents.js";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url));
const policy = { idleDays: 30, maxDays: 365 };
const MARK = "itest-variables-route";
const suffix = mintToken(6).toLowerCase().replaceAll(/[^a-z0-9]/g, "").slice(0, 6) || "x";
/** A GitHub token's shape, built so no scanner mistakes this file for a leak. */
const KEY = "gh" + "p_" + "aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0";

type Server = ReturnType<typeof makeServer>;

async function instanceDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "metistry-variables-instance-"));
  await mkdir(join(dir, ".metistry"), { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(join(dir, rel, ".."), { recursive: true });
    await writeFile(join(dir, rel), text);
  }
  return dir;
}

const view = (dir: string) => ({ instanceDir: dir, file: join(dir, ".metistry/variables.yaml") });

describe.skipIf(!hasDb)("GET /api/variables", () => {
  let pool: pg.Pool;
  let queries: QueryStore;
  const servers: Server[] = [];
  let base: string;
  let baseNone: string;
  let sessionCookie: string;
  let ownerToken: string;
  let agentToken: string;
  const localOwnerToken = mintToken();
  const agentId = `itest-variables-${suffix}`;
  const passkeyIds: string[] = [];

  async function listen(extra: Partial<Parameters<typeof makeServer>[2]>): Promise<string> {
    const server = makeServer(pool, queries, {
      origin: "http://127.0.0.1:0",
      inboxDir: await mkdtemp(join(tmpdir(), "metistry-variables-route-")),
      policy,
      secureCookies: false,
      localOwner: { token: localOwnerToken, trusted: [] },
      ...extra,
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
    queries = new QueryStore(pool);
    await queries.loadDir(fileURLToPath(new URL("../../../seed/queries", import.meta.url)));
    const dir = await instanceDir({
      ".metistry/variables.yaml": "# the org's shared names\nvariables:\n  team_name: Platform\n  company: Acme\n",
      ".metistry/agents/example/researcher.md": "---\nname: researcher\n---\nYou work for {{ variable.company }} on {{ variable.team_name }}.\n",
      ".metistry/connections/github.yaml": "name: github\nvariables: [team_name]\n",
    });
    base = await listen({ variables: view(dir) });
    baseNone = await listen({});

    const pkId = `${MARK}-${mintToken(8)}`;
    passkeyIds.push(pkId);
    await store.storePasskey(pool, { id: pkId, publicKey: new Uint8Array([1]), signCount: 0, transports: [], origin: "t", label: MARK });
    sessionCookie = `metistry_session=${await store.issueSession(pool, pkId, policy)}`;
    ownerToken = await store.mintOwnerToken(pool, MARK);
    agentToken = (await agents.createAgent(pool, { id: agentId, display_name: "itest variables route" })).token;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM runs WHERE component = 'console' AND kind = 'variables'`).catch(() => undefined);
    await pool.query(`DELETE FROM agents WHERE id = $1`, [agentId]).catch(() => undefined);
    await pool.query(`DELETE FROM owner_tokens WHERE label = $1`, [MARK]).catch(() => undefined);
    await pool.query(`DELETE FROM auth_sessions WHERE passkey_id = ANY($1)`, [passkeyIds]).catch(() => undefined);
    await pool.query(`DELETE FROM passkeys WHERE id = ANY($1)`, [passkeyIds]).catch(() => undefined);
    for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
    await pool.end();
  });

  async function get(at: string, headers: Record<string, string> = {}): Promise<{ status: number; text: string; body: any }> {
    const r = await fetch(`${at}/api/variables`, { headers });
    const text = await r.text();
    return { status: r.status, text, body: JSON.parse(text) };
  }

  it("U2: no credential is the uniform 401", async () => {
    const r = await get(base);
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: { code: "unauthenticated", message: "authentication required" } });
  });

  it("U2: an agent bearer and the capture owner token are the uniform 403 — and learn no value", async () => {
    for (const bearer of [agentToken, ownerToken]) {
      const r = await get(base, { authorization: `Bearer ${bearer}` });
      expect(r.status).toBe(403);
      expect(r.body).toEqual({ error: { code: "forbidden", message: "not granted" } });
      expect(r.text).not.toContain("Platform");
    }
  });

  it("U2: the local owner token reaches it, and so does a passkey session (reach owner)", async () => {
    expect((await get(base, { authorization: `Bearer ${localOwnerToken}` })).status).toBe(200);
    expect((await get(base, { cookie: sessionCookie })).status).toBe(200);
  });

  it("names, values, who reads each one and where it is used", async () => {
    const r = await get(base, { authorization: `Bearer ${localOwnerToken}` });
    expect(r.status).toBe(200);
    expect(r.body.variables).toEqual([
      { name: "company", value: "Acme", read_by: ["agent:researcher"], used_in: [".metistry/agents/example/researcher.md"] },
      {
        name: "team_name",
        value: "Platform",
        read_by: ["agent:researcher", "connection:github"],
        used_in: [".metistry/agents/example/researcher.md", ".metistry/connections/github.yaml"],
      },
    ]);
    expect(Object.keys(r.body).sort()).toEqual(["as_of", "variables"]);
  });

  it("**a key-shaped value is refused**: a hand-edited file carrying one is a 400 naming the variable — the value is in neither the body nor the ledger", async () => {
    const dir = await instanceDir({ ".metistry/variables.yaml": `variables:\n  team_name: Platform\n  deploy: "${KEY}"\n` });
    const leaky = await listen({ variables: view(dir) });
    const r = await get(leaky, { authorization: `Bearer ${localOwnerToken}` });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("invalid_request");
    expect(r.body.error.message).toMatch(/variables\.yaml does not validate — deploy: .*Store as Secret/);
    expect(r.text).not.toContain(KEY);
    // nor does the good row ride along: the file does not load at all
    expect(r.text).not.toContain("Platform");
    const { rows } = await pool.query(`SELECT meta::text AS meta FROM runs WHERE component = 'console' AND kind = 'variables' ORDER BY id DESC LIMIT 1`);
    expect(rows[0]?.meta).toBeDefined();
    expect(rows[0]?.meta).not.toContain(KEY);
  });

  it("a {{ secret.x }} smuggled into a value, or a schedule, does not load either", async () => {
    for (const text of [`variables:\n  header: "{{ secret.github_write }}"\n`, `variables:\n  standup_time: "09:15"\n`]) {
      const leaky = await listen({ variables: view(await instanceDir({ ".metistry/variables.yaml": text })) });
      const r = await get(leaky, { authorization: `Bearer ${localOwnerToken}` });
      expect(r.status).toBe(400);
    }
  });

  it("no instance directory: 503 not_available naming what is missing; no variables.yaml yet: none", async () => {
    const none = await get(baseNone, { authorization: `Bearer ${localOwnerToken}` });
    expect(none.status).toBe(503);
    expect(none.body.error.code).toBe("not_available");
    expect(none.body.error.message).toContain("METISTRY_INSTANCE_DIR");

    const empty = await listen({ variables: view(await instanceDir({})) });
    const r = await get(empty, { authorization: `Bearer ${localOwnerToken}` });
    expect(r.status).toBe(200);
    expect(r.body.variables).toEqual([]);
  });
});
