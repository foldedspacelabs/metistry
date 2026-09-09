// The mcp-brain mount at POST /mcp, through the real console server and the
// real agent registry: the console's credential classes decide who is an
// agent principal (CRIT-7), and the bridge does the rest. Raw JSON-RPC over
// fetch so the wire is what is asserted. Skipped without a db.
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { mintToken } from "@foldedspacelabs/metistry-core";
import { TOOL_NAMES } from "@foldedspacelabs/metistry-mcp-brain";
import { makeServer } from "../src/server.js";
import * as store from "../src/auth-store.js";
import * as agents from "../src/agents.js";

try {
  for (const line of readFileSync(new URL("../../../.env", import.meta.url), "utf8").split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m && m[1] && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {}

const hasDb = !!process.env.METISTRY_DB_PASSWORD;
const policy = { idleDays: 30, maxDays: 365 };

describe.skipIf(!hasDb)("POST /mcp (integration)", () => {
  let pool: pg.Pool;
  let base: string;
  let server: ReturnType<typeof makeServer>;
  let cookie: string;
  let ownerToken: string;
  const suffix = mintToken(4).toLowerCase().replaceAll(/[^a-z0-9]/g, "").slice(0, 6) || "x";
  const agentId = `itest-mcp-${suffix}`;
  let agentToken: string;
  let nextId = 1;

  const rpc = (method: string, params: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
    });
  const initParams = { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "itest", version: "0" } };

  beforeAll(async () => {
    pool = new pg.Pool({
      host: process.env.METISTRY_DB_HOST ?? "127.0.0.1",
      port: Number(process.env.METISTRY_DB_PORT ?? 5432),
      user: process.env.METISTRY_DB_USER ?? "metistry",
      database: process.env.METISTRY_TEST_DB_NAME ?? "metistry_test",
      password: process.env.METISTRY_DB_PASSWORD,
    });
    server = makeServer(pool, new QueryStore(pool), {
      origin: "http://127.0.0.1:0",
      inboxDir: `/tmp/metistry-test-inbox-mcp-${Date.now()}`,
      policy,
      secureCookies: false,
      // stands in for the reconciler's vault bridge: one root note, so the grant rule (not the read path) is what this suite proves
      readKnowledge: async (path) => (path === "Knowledge/now.md" ? "# Now\n\nroot note\n" : null),
    });
    await pool.query(`INSERT INTO knowledge_files (path, title, description, draft) VALUES ('Knowledge/now.md', 'now', NULL, false) ON CONFLICT (path) DO UPDATE SET draft = false`);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const pkId = `mcp-${mintToken(8)}`;
    await store.storePasskey(pool, { id: pkId, publicKey: new Uint8Array([1]), signCount: 0, transports: [], origin: "t", label: "mcp-test" });
    cookie = `metistry_session=${await store.issueSession(pool, pkId, policy)}`;
    ownerToken = await store.mintOwnerToken(pool, "mcp-test");
    ({ token: agentToken } = await agents.createAgent(pool, { id: agentId, display_name: "mcp itest" }));
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await pool.query(`DELETE FROM knowledge_files WHERE path = 'Knowledge/now.md'`);
    await pool.end();
  });

  it("no bearer, a passkey session, and an OWNER token are all 401: only an agent credential is an agent principal", async () => {
    for (const headers of [{}, { cookie }, { authorization: `Bearer ${ownerToken}` }, { authorization: `Bearer ${mintToken()}` }]) {
      const r = await rpc("initialize", initParams, headers);
      expect(r.status, JSON.stringify(headers)).toBe(401);
      expect(await r.json()).toEqual({ error: { code: "unauthenticated", message: "authentication required" } });
    }
  });

  it("an agent token lists the eager surface and captures with provenance from the credential", async () => {
    const auth = { authorization: `Bearer ${agentToken}` };
    const init = await rpc("initialize", initParams, auth);
    expect(init.status).toBe(200);
    expect((await init.json()).result.serverInfo.name).toBe("metistry-brain");

    const list = await rpc("tools/list", {}, auth);
    expect(list.status).toBe(200);
    expect((await list.json()).result.tools.map((t: { name: string }) => t.name)).toEqual([...TOOL_NAMES]);

    const cap = await rpc("tools/call", { name: "capture", arguments: { note: "via mcp" } }, auth);
    expect(cap.status).toBe(200);
    const result = (await cap.json()).result;
    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0].text.split("\n")[0]);
    const row = (await pool.query(`SELECT source, source_agent, note FROM inbox WHERE id = $1`, [body.id])).rows[0];
    expect(row).toEqual({ source: "mcp", source_agent: agentId, note: "via mcp" });
    // and the action record names the agent, kind=tool
    const runs = await pool.query(`SELECT tool, ok FROM runs WHERE component = $1 AND kind = 'tool'`, [agentId]);
    expect(runs.rows).toEqual([{ tool: "capture", ok: true }]);

    // a fresh (tier none) agent asking for knowledge is told "not granted", not "not found"
    const ks = await rpc("tools/call", { name: "knowledge_search", arguments: { query: "anything" } }, auth);
    const kr = (await ks.json()).result;
    expect(kr.isError).toBe(true);
    expect(JSON.parse(kr.content[0].text.split("\n")[0])).toEqual({ error: { code: "forbidden", message: "not granted" } });
  });

  it("the agent surface is otherwise unchanged: the same token still captures over HTTP and is 403 on management", async () => {
    const auth = { authorization: `Bearer ${agentToken}`, "content-type": "application/json" };
    expect((await fetch(`${base}/capture`, { method: "POST", headers: auth, body: JSON.stringify({ note: "http" }) })).status).toBe(201);
    expect((await fetch(`${base}/api/agents`, { headers: auth })).status).toBe(403);
  });

  it("the assistant is an agent like any other: registered from configuration, kind=internal, every project, audited under its own id", async () => {
    const token = mintToken(32);
    await agents.ensureInternalAgent(pool, agents.INTERNAL_ASSISTANT_ID, { token, display_name: "itest assistant" });
    const auth = { authorization: `Bearer ${token}` };
    expect((await rpc("initialize", initParams, auth)).status).toBe(200);
    expect(((await (await rpc("tools/list", {}, auth)).json()).result.tools as { name: string }[]).map((t) => t.name)).toEqual([...TOOL_NAMES]);

    // no project list → member of every project: creating in a project nobody granted it succeeds, and it is listed back
    const project = `itest-hub-${suffix}`;
    const created = await rpc("tools/call", { name: "tasks_create", arguments: { title: "hub task", project, idempotency_key: `${project}-1` } }, auth);
    const body = JSON.parse((await created.json()).result.content[0].text.split("\n")[0]);
    expect(body.task).toMatchObject({ project, created_by: agents.INTERNAL_ASSISTANT_ID });
    const listed = JSON.parse((await (await rpc("tools/call", { name: "tasks_list", arguments: { project } }, auth)).json()).result.content[0].text.split("\n")[0]);
    expect(listed.tasks.map((t: { id: number }) => t.id)).toEqual([body.task.id]);
    // the external agent from above still cannot see it (its projects are [])
    const other = JSON.parse((await (await rpc("tools/call", { name: "tasks_list", arguments: { project } }, { authorization: `Bearer ${agentToken}` })).json()).result.content[0].text.split("\n")[0]);
    expect(other).toEqual({ error: { code: "not_found", message: "not found" } });
    // audit rows land on the agent id, kind=tool — the dashboard/runs view of "what the assistant did with its tools"
    const runs = await pool.query(`SELECT tool FROM runs WHERE component = $1 AND kind = 'tool' AND meta->'args'->>'project' = $2 ORDER BY id`, [agents.INTERNAL_ASSISTANT_ID, project]);
    expect(runs.rows.map((r) => r.tool)).toEqual(["tasks_create", "tasks_list"]);
    await pool.query(`DELETE FROM work WHERE project = $1`, [project]);

    // the live-verified gap, closed: under the internal default grant (bare Knowledge/) the assistant reads a ROOT note
    const now = JSON.parse((await (await rpc("tools/call", { name: "knowledge_read", arguments: { path: "Knowledge/now.md" } }, auth)).json()).result.content[0].text.split("\n")[0]);
    expect(now).toMatchObject({ path: "Knowledge/now.md", title: "now", content: "# Now\n\nroot note\n", sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    // ...and the same path is still "not granted" to the external agent (tier none), never "not found"
    const denied = JSON.parse((await (await rpc("tools/call", { name: "knowledge_read", arguments: { path: "Knowledge/now.md" } }, { authorization: `Bearer ${agentToken}` })).json()).result.content[0].text.split("\n")[0]);
    expect(denied).toEqual({ error: { code: "forbidden", message: "not granted" } });
    // knowledge_write is listed for both but is the assistant's alone; here the bridge is absent, so the assistant is told not_available (a capability gap, not a permission)
    const extWrite = JSON.parse((await (await rpc("tools/call", { name: "knowledge_write", arguments: { path: "Knowledge/now.md", content: "x", message: "m" } }, { authorization: `Bearer ${agentToken}` })).json()).result.content[0].text.split("\n")[0]);
    expect(extWrite).toEqual({ error: { code: "forbidden", message: "not granted" } });
    const intWrite = JSON.parse((await (await rpc("tools/call", { name: "knowledge_write", arguments: { path: "Knowledge/now.md", content: "x", message: "m" } }, auth)).json()).result.content[0].text.split("\n")[0]);
    expect(intWrite.error.code).toBe("not_available");
  });

  it("a revoked token is dead on /mcp at once", async () => {
    expect(await agents.revokeAgent(pool, agentId)).toBe(true);
    const r = await rpc("tools/list", {}, { authorization: `Bearer ${agentToken}` });
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: { code: "unauthenticated", message: "authentication required" } });
  });
});
