// External-agent registry: misuse tests (CRIT-7 two token classes, §4.11
// grants attach server-side, §4.19 identity from the credential) against
// the real scratch database and a live server. Skipped without a db.
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { mintToken } from "@foldedspacelabs/metistry-core";
import { makeServer } from "../src/server.js";
import * as store from "../src/auth-store.js";
import * as agents from "../src/agents.js";
import { run as inboxDrain } from "../../../collectors/inbox-drain/run.js";

try {
  for (const line of readFileSync(new URL("../../../.env", import.meta.url), "utf8").split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m && m[1] && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {}

const hasDb = !!process.env.METISTRY_DB_PASSWORD;
const policy = { idleDays: 30, maxDays: 365 };

describe("agent grants validation (pure)", () => {
  it("accepts the three tiers with TitleCase Knowledge/ prefixes", () => {
    expect(agents.validateGrants({ tier: "none" })).toEqual({ tier: "none", areas: [] });
    expect(agents.validateGrants({ tier: "index", areas: [] })).toEqual({ tier: "index", areas: [] });
    expect(agents.validateGrants({ tier: "areas", areas: [" Knowledge/Areas/Fsl ", "Knowledge/Projects/Drey Dev", "Knowledge/Areas/Fsl"] }))
      .toEqual({ tier: "areas", areas: ["Knowledge/Areas/Fsl", "Knowledge/Projects/Drey Dev"] });
  });

  it("rejects lowercase knowledge/, non-Knowledge paths, traversal, and bare Knowledge", () => {
    for (const bad of ["knowledge/Areas/Fsl", "Knowledge/areas/fsl", "inbox/", "/Knowledge/Areas", "Knowledge", "Knowledge/", "Knowledge/../secrets", "Knowledge/Areas/Fsl/", "../Knowledge/Areas"]) {
      expect(() => agents.validateGrants({ tier: "areas", areas: [bad] }), bad).toThrow(agents.AgentError);
    }
    expect(() => agents.validateGrants({ tier: "admin" })).toThrow(agents.AgentError);
    expect(() => agents.validateGrants({ tier: "none", areas: ["Knowledge/Areas/Fsl"] })).toThrow(agents.AgentError); // areas only with tier=areas
    expect(() => agents.validateGrants({ tier: "areas", areas: [] })).toThrow(agents.AgentError);
    expect(() => agents.validateGrants({ tier: "areas", areas: "Knowledge/Areas/Fsl" })).toThrow(agents.AgentError);
  });

  it("projects are slugs", () => {
    expect(agents.validateProjects(["drey", "fsl-2026", "drey"])).toEqual(["drey", "fsl-2026"]);
    expect(() => agents.validateProjects(["Drey"])).toThrow(agents.AgentError);
    expect(() => agents.validateProjects("drey")).toThrow(agents.AgentError);
  });
});

describe.skipIf(!hasDb)("agent registry (integration)", () => {
  let pool: pg.Pool;
  let base: string;
  let server: ReturnType<typeof makeServer>;
  let cookie: string;
  let ownerToken: string;
  const suffix = mintToken(4).toLowerCase().replaceAll(/[^a-z0-9]/g, "").slice(0, 6) || "x";
  const agentId = `itest-${suffix}`;
  let agentToken: string;

  const json = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(base + path, {
      method,
      headers: { cookie, "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  beforeAll(async () => {
    pool = new pg.Pool({
      host: process.env.METISTRY_DB_HOST ?? "127.0.0.1",
      port: Number(process.env.METISTRY_DB_PORT ?? 5432),
      user: process.env.METISTRY_DB_USER ?? "metistry",
      database: process.env.METISTRY_TEST_DB_NAME ?? "metistry_test", // scratch db (ops/scripts/test-db.sh)
      password: process.env.METISTRY_DB_PASSWORD,
    });
    server = makeServer(pool, new QueryStore(pool), {
      origin: "http://127.0.0.1:0",
      inboxDir: `/tmp/metistry-test-inbox-agents-${Date.now()}`,
      policy,
      secureCookies: false,
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const pkId = `agents-${mintToken(8)}`;
    await store.storePasskey(pool, { id: pkId, publicKey: new Uint8Array([1]), signCount: 0, transports: [], origin: "t", label: "agents-test" });
    cookie = `metistry_session=${await store.issueSession(pool, pkId, policy)}`;
    ownerToken = await store.mintOwnerToken(pool, "agents-test");
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await pool.end();
  });

  it("mint → authenticate round trip; the list never carries a hash; the mint is audited", async () => {
    expect((await json("POST", "/api/agents", { id: "Bad Id", display_name: "x" })).status).toBe(400);
    expect((await json("POST", "/api/agents", { id: agentId })).status).toBe(400); // display_name required
    const r = await json("POST", "/api/agents", { id: agentId, display_name: "<b>itest</b> agent" });
    expect(r.status).toBe(201);
    const body = await r.json();
    expect(body.id).toBe(agentId);
    expect(typeof body.token).toBe("string");
    agentToken = body.token;
    expect((await json("POST", "/api/agents", { id: agentId, display_name: "dup" })).status).toBe(409);

    const principal = await agents.authenticateAgent(pool, { headers: { authorization: `Bearer ${agentToken}` } });
    expect(principal).toEqual({ id: agentId, kind: "external", grants: { tier: "none", areas: [] }, projects: [] });
    expect(await agents.authenticateAgent(pool, { headers: { authorization: `Bearer ${mintToken()}` } })).toBeNull();
    expect(await agents.authenticateAgent(pool, { headers: {} })).toBeNull();

    const list = await (await json("GET", "/api/agents")).json();
    const mine = list.agents.find((a: any) => a.id === agentId);
    expect(mine).toMatchObject({ display_name: "<b>itest</b> agent", kind: "external", revoked: false });
    expect(mine.last_seen_at).not.toBeNull(); // authenticate bumped it
    expect(JSON.stringify(list)).not.toContain("token"); // no hash, no token, ever
    const audit = await pool.query(`SELECT ok FROM runs WHERE component='console' AND kind='agent_admin' AND meta->>'agent'=$1 AND meta->>'op'='mint'`, [agentId]);
    expect(audit.rows).toEqual([{ ok: true }]);
  });

  it("agent token: capture works and records provenance; everything else is a uniform 403", async () => {
    const auth = { authorization: `Bearer ${agentToken}` };
    const cap = await fetch(`${base}/capture`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ note: `finding from ${agentId}` }),
    });
    expect(cap.status).toBe(201);
    const { id } = await cap.json();
    const inbox = await pool.query(`SELECT source, source_agent FROM inbox WHERE id = $1`, [id]);
    expect(inbox.rows[0]).toEqual({ source: "http", source_agent: agentId });

    // the drained proposal carries the agent as source_agent at external trust (§4.19)
    await pool.query(`UPDATE inbox SET status = 'classified' WHERE status = 'new' AND id <> $1`, [id]); // other suites' rows: keep this pass small
    await inboxDrain(pool);
    const prop = await pool.query(`SELECT source_agent, trust FROM proposals WHERE payload->>'inbox_id' = $1::text`, [String(id)]);
    expect(prop.rows).toEqual([{ source_agent: agentId, trust: "external" }]);

    for (const [method, path] of [
      ["GET", "/api/agents"],
      ["GET", "/api/proposals"],
      ["GET", "/api/devices"],
      ["GET", "/api/status"],
      ["GET", "/api/q/open_work"],
      ["POST", "/message"],
      ["POST", `/api/agents/${agentId}/rotate`],
      ["GET", "/nope"],
    ] as const) {
      const r = await fetch(base + path, { method, headers: { ...auth, "content-type": "application/json" }, body: method === "POST" ? "{}" : undefined });
      expect(r.status, `${method} ${path}`).toBe(403);
      expect(await r.json()).toEqual({ error: { code: "forbidden", message: "not granted" } });
    }
  });

  it("owner token on the registry is FORBIDDEN (management is session-only)", async () => {
    const h = { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" };
    expect((await fetch(`${base}/api/agents`, { headers: h })).status).toBe(403);
    expect((await fetch(`${base}/api/agents`, { method: "POST", headers: h, body: "{}" })).status).toBe(403);
    expect((await fetch(`${base}/api/agents/${agentId}/grants`, { method: "PUT", headers: h, body: "{}" })).status).toBe(403);
    expect((await fetch(`${base}/api/agents/${agentId}/revoke`, { method: "POST", headers: h })).status).toBe(403);
  });

  it("grants attach to the token server-side: validation, then the principal reflects them", async () => {
    expect((await json("PUT", `/api/agents/${agentId}/grants`, { tier: "areas", areas: ["knowledge/Areas/Fsl"] })).status).toBe(400);
    expect((await json("PUT", `/api/agents/${agentId}/grants`, { tier: "areas", areas: ["inbox/secrets"] })).status).toBe(400);
    expect((await json("PUT", `/api/agents/${agentId}/grants`, { tier: "root" })).status).toBe(400);
    expect((await json("PUT", `/api/agents/nobody-${suffix}/grants`, { tier: "index" })).status).toBe(404);
    const ok = await json("PUT", `/api/agents/${agentId}/grants`, { tier: "areas", areas: ["Knowledge/Areas/Fsl"] });
    expect(ok.status).toBe(200);
    expect((await json("PUT", `/api/agents/${agentId}/projects`, { projects: ["Drey"] })).status).toBe(400);
    expect((await json("PUT", `/api/agents/${agentId}/projects`, { projects: ["drey"] })).status).toBe(200);
    // wrong verb for the op falls to 404, not a handler
    expect((await json("POST", `/api/agents/${agentId}/grants`, { tier: "none" })).status).toBe(404);

    const principal = await agents.authenticateAgent(pool, { headers: { authorization: `Bearer ${agentToken}` } });
    expect(principal).toEqual({ id: agentId, kind: "external", grants: { tier: "areas", areas: ["Knowledge/Areas/Fsl"] }, projects: ["drey"] });
    // rejected payloads never reach the audit log; the accepted ones do
    const audit = await pool.query(`SELECT meta->>'op' AS op FROM runs WHERE kind='agent_admin' AND meta->>'agent'=$1 ORDER BY id`, [agentId]);
    expect(audit.rows.map((r) => r.op)).toEqual(["mint", "grant", "projects"]);
  });

  it("ensureInternalAgent: idempotent upsert from configuration — same token keeps the hash, projects re-sync, revocation clears, kind is internal", async () => {
    const id = `itest-internal-${suffix}`;
    const token = mintToken(32);
    const hashOf = async () => (await pool.query(`SELECT token_hash, kind, grants, projects, revoked_at FROM agents WHERE id = $1`, [id])).rows[0];

    expect(await agents.ensureInternalAgent(pool, id, { token })).toEqual({ id, created: true });
    const first = await hashOf();
    expect(first.kind).toBe("internal");
    expect(first.grants).toEqual({ tier: "areas", areas: [...agents.ASSISTANT_DEFAULT_AREAS] }); // the widest valid read
    expect(first.projects).toEqual([]); // = every project, by mcp-brain's internal rule

    // the token authenticates like any agent's, and the principal carries the kind
    const principal = await agents.authenticateAgent(pool, { headers: { authorization: `Bearer ${token}` } });
    expect(principal).toEqual({ id, kind: "internal", grants: { tier: "areas", areas: [...agents.ASSISTANT_DEFAULT_AREAS] }, projects: [] });

    // second call, same token, new projects: hash unchanged, projects replaced, not "created"
    expect(await agents.ensureInternalAgent(pool, id, { token, projects: ["drey", "drey"] })).toEqual({ id, created: false });
    const second = await hashOf();
    expect(second.token_hash).toBe(first.token_hash);
    expect(second.projects).toEqual(["drey"]);
    expect((await agents.authenticateAgent(pool, { headers: { authorization: `Bearer ${token}` } }))?.projects).toEqual(["drey"]);

    // a rotated token in the environment re-keys the row; the old token dies
    const rotated = mintToken(32);
    await agents.ensureInternalAgent(pool, id, { token: rotated });
    expect(await agents.authenticateAgent(pool, { headers: { authorization: `Bearer ${token}` } })).toBeNull();
    expect((await agents.authenticateAgent(pool, { headers: { authorization: `Bearer ${rotated}` } }))?.id).toBe(id);

    // a UI revoke holds until the configuration says otherwise: ensure clears it (the env var is the switch)
    expect(await agents.revokeAgent(pool, id)).toBe(true);
    expect(await agents.authenticateAgent(pool, { headers: { authorization: `Bearer ${rotated}` } })).toBeNull();
    await agents.ensureInternalAgent(pool, id, { token: rotated });
    expect((await hashOf()).revoked_at).toBeNull();
    expect((await agents.authenticateAgent(pool, { headers: { authorization: `Bearer ${rotated}` } }))?.kind).toBe("internal");

    // configuration is validated like the management API: bad areas / projects / short tokens never land
    await expect(agents.ensureInternalAgent(pool, id, { token: rotated, projects: ["Drey"] })).rejects.toThrow(agents.AgentError);
    await expect(agents.ensureInternalAgent(pool, id, { token: "short" })).rejects.toThrow(agents.AgentError);
    await expect(agents.ensureInternalAgent(pool, "Bad Id", { token: rotated })).rejects.toThrow(agents.AgentError);
    expect(() => agents.validateGrants({ tier: "areas", areas: ["Knowledge/"] })).toThrow(agents.AgentError); // "everything" is not an area; the default list is the widest valid read
    // the list never carries a hash for internal agents either
    const list = await (await json("GET", "/api/agents")).json();
    expect(list.agents.find((a: any) => a.id === id)).toMatchObject({ kind: "internal", revoked: false });
    expect(JSON.stringify(list)).not.toContain(rotated);
  });

  it("rotate invalidates the old token; revoke kills the new one and is audited", async () => {
    const old = agentToken;
    const r = await json("POST", `/api/agents/${agentId}/rotate`);
    expect(r.status).toBe(200);
    const { token } = await r.json();
    expect(token).not.toBe(old);
    expect(await agents.authenticateAgent(pool, { headers: { authorization: `Bearer ${old}` } })).toBeNull();
    expect((await fetch(`${base}/capture`, { method: "POST", headers: { authorization: `Bearer ${old}`, "content-type": "application/json" }, body: "{}" })).status).toBe(401);
    const fresh = await agents.authenticateAgent(pool, { headers: { authorization: `Bearer ${token}` } });
    expect(fresh?.grants.tier).toBe("areas"); // grants survive rotation — they belong to the agent, not the secret

    expect((await json("POST", `/api/agents/${agentId}/revoke`)).status).toBe(200);
    expect((await json("POST", `/api/agents/${agentId}/revoke`)).status).toBe(404); // once
    expect(await agents.authenticateAgent(pool, { headers: { authorization: `Bearer ${token}` } })).toBeNull();
    expect((await json("POST", `/api/agents/${agentId}/rotate`)).status).toBe(404); // dead agents don't get new keys
    expect((await json("PUT", `/api/agents/${agentId}/grants`, { tier: "none" })).status).toBe(404);
    const list = await (await json("GET", "/api/agents")).json();
    expect(list.agents.find((a: any) => a.id === agentId).revoked).toBe(true);
    const audit = await pool.query(`SELECT meta->>'op' AS op, ok FROM runs WHERE kind='agent_admin' AND meta->>'agent'=$1 AND meta->>'op' IN ('rotate','revoke') ORDER BY id`, [agentId]);
    expect(audit.rows).toEqual([{ op: "rotate", ok: true }, { op: "revoke", ok: true }, { op: "revoke", ok: false }, { op: "rotate", ok: false }]);
  });
});
