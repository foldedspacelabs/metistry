// `GET /api/secrets` (design-build-plan §2.14, T4-1) over real sockets against
// the scratch database (docs/ops/testing.md). The Keychain is core's
// `memoryKeychain()` — never the login Keychain — shared by two consoles for
// two instances, exactly as two instances on one Mac share the real one.
//
// Bold (the ticket's own): **`GET /api/secrets` never carries a value**, and
// **one instance can never read another's item** — B's console, handed a
// copy of A's secrets.yaml, reports A's secret absent. U2's misuse tests:
// 401 with no credential, 403 for an agent bearer and for the capture owner
// token, and the local owner token (and a passkey session) reach it.
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { InstanceSecrets, SECRET_USE_META_KEY, memoryKeychain, mintToken, type KeychainBackend } from "@foldedspacelabs/metistry-core";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";
import { makeServer } from "../src/server.js";
import * as store from "../src/auth-store.js";
import * as agents from "../src/agents.js";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url));
const policy = { idleDays: 30, maxDays: 365 };
const MARK = "itest-secrets-route";
const suffix = mintToken(6).toLowerCase().replaceAll(/[^a-z0-9]/g, "").slice(0, 6) || "x";

const ID_A = "11111111-2222-4333-8444-555555555555";
const ID_B = "66666666-7777-4888-9999-aaaaaaaaaaaa";
const VALUE = "ghp_SENTINEL-must-never-leave-the-keychain";
/** A secret name no other test's ledger rows will name, so *last used* is this file's alone. */
const NAME = `github_write_${suffix}`;

const POLICY = `# names and policy only
secrets:
  ${NAME}:
    hosts: [api.github.com]
    grants:
      connection:github: on
      agent:devin: ask
    expires: 2026-12-31
  zeta_${suffix}:
    hosts: []
`;

type Server = ReturnType<typeof makeServer>;

describe.skipIf(!hasDb)("GET /api/secrets", () => {
  let pool: pg.Pool;
  let queries: QueryStore;
  const servers: Server[] = [];
  let baseA: string;
  let baseB: string;
  let baseNone: string;
  let sessionCookie: string;
  let ownerToken: string;
  let agentToken: string;
  const localOwnerToken = mintToken();
  const agentId = `itest-secrets-${suffix}`;
  const passkeyIds: string[] = [];
  /** every Keychain call the consoles made: the proof they only ever asked about presence */
  const asked: string[] = [];
  const runIds: number[] = [];

  async function listen(extra: Partial<Parameters<typeof makeServer>[2]>): Promise<string> {
    const server = makeServer(pool, queries, {
      origin: "http://127.0.0.1:0",
      inboxDir: await mkdtemp(join(tmpdir(), "metistry-secrets-route-")),
      policy,
      secureCookies: false,
      localOwner: { token: localOwnerToken, trusted: [] },
      ...extra,
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  async function secretsFile(text: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "metistry-secrets-instance-"));
    await mkdir(join(dir, ".metistry"), { recursive: true });
    const file = join(dir, ".metistry/secrets.yaml");
    await writeFile(file, text);
    return file;
  }

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
    queries = new QueryStore(pool);
    await queries.loadDir(fileURLToPath(new URL("../../../seed/queries", import.meta.url)));

    // ONE Keychain for both instances, as on one Mac; A holds the secret
    const kc = memoryKeychain();
    await new InstanceSecrets(kc, ID_A).set(NAME, VALUE);
    const spied: KeychainBackend = {
      get: async (s, a) => (asked.push(`get ${a}/${s}`), kc.get(s, a)),
      has: async (s, a) => (asked.push(`has ${a}/${s}`), kc.has(s, a)),
      set: async (s, a, v) => (asked.push(`set ${a}/${s}`), kc.set(s, a, v)),
      delete: async (s, a) => (asked.push(`delete ${a}/${s}`), kc.delete(s, a)),
    };
    const file = await secretsFile(POLICY);
    baseA = await listen({ secrets: { file, presence: new InstanceSecrets(spied, ID_A).presence() } });
    // B: a copy of A's policy file, its own presence probe on the same Keychain
    baseB = await listen({ secrets: { file: await secretsFile(POLICY), presence: new InstanceSecrets(spied, ID_B).presence() } });
    baseNone = await listen({});

    const pkId = `${MARK}-${mintToken(8)}`;
    passkeyIds.push(pkId);
    await store.storePasskey(pool, { id: pkId, publicKey: new Uint8Array([1]), signCount: 0, transports: [], origin: "t", label: MARK });
    sessionCookie = `metistry_session=${await store.issueSession(pool, pkId, policy)}`;
    ownerToken = await store.mintOwnerToken(pool, MARK);
    agentToken = (await agents.createAgent(pool, { id: agentId, display_name: "itest secrets route" })).token;

    // the ledger: two fills of NAME (the newest wins), and one malformed row that must not take the list down
    const run = async (ts: string, meta: unknown) =>
      runIds.push(Number((await pool.query(`INSERT INTO runs (ts, component, kind, ok, meta) VALUES ($1, 'egress-proxy', 'egress', true, $2::jsonb) RETURNING id`, [ts, JSON.stringify(meta)])).rows[0].id));
    await run("2026-09-20T10:00:00.000Z", { [SECRET_USE_META_KEY]: [NAME] });
    await run("2026-09-28T13:00:02.000Z", { [SECRET_USE_META_KEY]: [NAME, "someone_else"] });
    await run("2026-09-29T00:00:00.000Z", { [SECRET_USE_META_KEY]: "not-an-array" });
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM runs WHERE id = ANY($1)`, [runIds]).catch(() => undefined);
    await pool.query(`DELETE FROM runs WHERE component = 'console' AND kind = 'secrets'`).catch(() => undefined);
    await pool.query(`DELETE FROM agents WHERE id = $1`, [agentId]).catch(() => undefined);
    await pool.query(`DELETE FROM owner_tokens WHERE label = $1`, [MARK]).catch(() => undefined);
    await pool.query(`DELETE FROM auth_sessions WHERE passkey_id = ANY($1)`, [passkeyIds]).catch(() => undefined);
    await pool.query(`DELETE FROM passkeys WHERE id = ANY($1)`, [passkeyIds]).catch(() => undefined);
    for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
    await pool.end();
  });

  async function get(base: string, headers: Record<string, string> = {}): Promise<{ status: number; text: string; body: any }> {
    const r = await fetch(`${base}/api/secrets`, { headers });
    const text = await r.text();
    return { status: r.status, text, body: JSON.parse(text) };
  }

  it("U2: no credential is the uniform 401", async () => {
    const r = await get(baseA);
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: { code: "unauthenticated", message: "authentication required" } });
  });

  it("U2: an agent bearer and the capture owner token are the uniform 403", async () => {
    for (const bearer of [agentToken, ownerToken]) {
      const r = await get(baseA, { authorization: `Bearer ${bearer}` });
      expect(r.status).toBe(403);
      expect(r.body).toEqual({ error: { code: "forbidden", message: "not granted" } });
      expect(r.text).not.toContain(NAME);
    }
  });

  it("U2: the local owner token reaches it, and so does a passkey session (reach owner)", async () => {
    expect((await get(baseA, { authorization: `Bearer ${localOwnerToken}` })).status).toBe(200);
    expect((await get(baseA, { cookie: sessionCookie })).status).toBe(200);
  });

  it("**never carries a value** — names, hosts, grants, expiry, presence and last used, and nothing else", async () => {
    const r = await get(baseA, { authorization: `Bearer ${localOwnerToken}` });
    expect(r.status).toBe(200);
    expect(r.text).not.toContain(VALUE);
    expect(r.body.secrets).toEqual([
      {
        name: NAME,
        hosts: ["api.github.com"],
        grants: [
          { to: "connection:github", mode: "on" },
          { to: "agent:devin", mode: "ask" },
        ],
        expires: "2026-12-31",
        present: true,
        last_used: "2026-09-28T13:00:02.000Z",
      },
      { name: `zeta_${suffix}`, hosts: [], grants: [], expires: null, present: false, last_used: null },
    ]);
    expect(Object.keys(r.body).sort()).toEqual(["as_of", "secrets"]);
    // the console only ever asked the Keychain whether an item exists — never for its data
    expect(asked.length).toBeGreaterThan(0);
    for (const a of asked) expect(a.startsWith("has "), a).toBe(true);
  });

  it("**one instance can never read another's item**: B's console, with A's policy file word for word, reports it absent", async () => {
    const before = asked.length;
    const r = await get(baseB, { authorization: `Bearer ${localOwnerToken}` });
    expect(r.status).toBe(200);
    expect(r.body.secrets.find((s: { name: string }) => s.name === NAME)?.present).toBe(false);
    expect(r.text).not.toContain(VALUE);
    const bAsked = asked.slice(before);
    expect(bAsked.length).toBeGreaterThan(0);
    for (const a of bAsked) expect(a.startsWith(`has ${ID_B}/`), a).toBe(true);
  });

  it("a file that tries to carry a value does not load: 400 naming the field — and the value is not echoed", async () => {
    const leaky = `secrets:\n  k:\n    value: ${VALUE}\n  j: ${VALUE}\n`;
    const base = await listen({ secrets: { file: await secretsFile(leaky) } });
    const r = await get(base, { authorization: `Bearer ${localOwnerToken}` });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("invalid_request");
    expect(r.body.error.message).toMatch(/secrets\.yaml does not validate/);
    expect(r.text).not.toContain(VALUE);
    const { rows } = await pool.query(`SELECT meta::text AS meta FROM runs WHERE component = 'console' AND kind = 'secrets' ORDER BY id DESC LIMIT 1`);
    expect(rows[0]?.meta).not.toContain(VALUE);
  });

  it("no instance directory: 503 not_available naming what is missing; no Keychain: present is null", async () => {
    const none = await get(baseNone, { authorization: `Bearer ${localOwnerToken}` });
    expect(none.status).toBe(503);
    expect(none.body.error.code).toBe("not_available");
    expect(none.body.error.message).toContain("METISTRY_INSTANCE_DIR");

    const noKeychain = await listen({ secrets: { file: await secretsFile(POLICY) } });
    const r = await get(noKeychain, { authorization: `Bearer ${localOwnerToken}` });
    expect(r.status).toBe(200);
    for (const s of r.body.secrets) expect(s.present).toBeNull();
  });

  it("an instance with no secrets.yaml yet has no secrets", async () => {
    const base = await listen({ secrets: { file: join(await mkdtemp(join(tmpdir(), "metistry-secrets-empty-")), ".metistry/secrets.yaml") } });
    const r = await get(base, { authorization: `Bearer ${localOwnerToken}` });
    expect(r.status).toBe(200);
    expect(r.body.secrets).toEqual([]);
  });
});
