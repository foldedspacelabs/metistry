// `GET /api/connections` and `GET /api/connections/:name` (design-build-plan
// §2.1, §2.6; T4-8a) over real sockets against the scratch database
// (docs/ops/testing.md), reading a scratch instance directory under the OS
// temp dir.
//
// U2's misuse tests, for each door: 401 with no credential, 403 for an agent
// bearer and for the capture owner token, and the local owner token (and a
// passkey session) reach it. The routes' own: a row carries names, never a
// value — a file with a key pasted into it shows its name and why, and
// nothing it holds; nothing is dialled by a read; no instance directory is
// a 503; an unknown or malformed name is the family's 404.
import { existsSync } from "node:fs";
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
import type { ConnectionsView } from "../src/connections-route.js";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url));
const policy = { idleDays: 30, maxDays: 365 };
const MARK = "itest-connections-route";
const suffix = mintToken(6).toLowerCase().replaceAll(/[^a-z0-9]/g, "").slice(0, 6) || "x";
/** A GitHub token's shape, built so no scanner mistakes this file for a leak. */
const KEY = "gh" + "p_" + "aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0";

type Server = ReturnType<typeof makeServer>;

async function instanceDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "metistry-connections-instance-"));
  await mkdir(join(dir, ".metistry"), { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(join(dir, rel, ".."), { recursive: true });
    await writeFile(join(dir, rel), text);
  }
  return dir;
}

describe.skipIf(!hasDb)("GET /api/connections, GET /api/connections/:name", () => {
  let pool: pg.Pool;
  let queries: QueryStore;
  const servers: Server[] = [];
  let base: string;
  let baseNone: string;
  let dir: string;
  let sessionCookie: string;
  let ownerToken: string;
  let agentToken: string;
  const localOwnerToken = mintToken();
  const agentId = `itest-connections-${suffix}`;
  const passkeyIds: string[] = [];

  async function listen(extra: Partial<Parameters<typeof makeServer>[2]>): Promise<string> {
    const server = makeServer(pool, queries, {
      origin: "http://127.0.0.1:0",
      inboxDir: await mkdtemp(join(tmpdir(), "metistry-connections-route-")),
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
    dir = await instanceDir({
      ".metistry/connections/github.yaml": [
        "name: github",
        "type: mcp",
        "provider: custom",
        "description: GitHub's MCP server",
        "reach:",
        "  command:",
        "    command: metistry-itest-never-run",
        "    args: [--stdio]",
        "    env:",
        '      GITHUB_PERSONAL_ACCESS_TOKEN: "{{ secret.github_read }}"',
        "      LOG_LEVEL: warn",
        "secrets: [github_read]",
        "tools:",
        "  search_issues: { group: reads, mode: on }",
        "  create_issue: { group: changes }",
        "",
      ].join("\n"),
      ".metistry/connections/linear.yaml": 'name: linear\ntype: mcp\nprovider: linear\nreach: { http: { url: "https://mcp.linear.app/mcp" } }\ntools:\n  list_issues: { group: reads, mode: on }\n',
      ".metistry/connections/leaky.yaml": `name: leaky\ntype: mcp\nprovider: custom\nreach: { http: { url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer ${KEY}" } } }\n`,
      ".metistry/secrets.yaml": 'secrets:\n  github_read:\n    grants: { "connection:github": on }\n',
      ".metistry/scheduled.yaml": "syncs:\n  github-state:\n    connection: github\n",
      ".metistry/extensions/linear/manifest.yaml": [
        "schema: 1",
        "name: linear",
        "type: connection-type",
        "description: Linear — the issues assigned to you. A personal API key, sent to api.linear.app only.",
        "provides: mcp",
        "transports: [http]",
        "fields:",
        "  - { key: workspace, kind: text, label: Workspace, required: false, default: acme }",
        "  - { key: api_key, kind: secret, label: API key, required: false }",
        "tools:",
        "  list_issues: { group: reads }",
        "",
      ].join("\n"),
    });
    const view: ConnectionsView = { instanceDir: dir, presence: { has: async (n) => n === "github_read" } };
    base = await listen({ connections: view });
    baseNone = await listen({});

    const pkId = `${MARK}-${mintToken(8)}`;
    passkeyIds.push(pkId);
    await store.storePasskey(pool, { id: pkId, publicKey: new Uint8Array([1]), signCount: 0, transports: [], origin: "t", label: MARK });
    sessionCookie = `metistry_session=${await store.issueSession(pool, pkId, policy)}`;
    ownerToken = await store.mintOwnerToken(pool, MARK);
    agentToken = (await agents.createAgent(pool, { id: agentId, display_name: "itest connections route" })).token;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM agents WHERE id = $1`, [agentId]).catch(() => undefined);
    await pool.query(`DELETE FROM owner_tokens WHERE label = $1`, [MARK]).catch(() => undefined);
    await pool.query(`DELETE FROM auth_sessions WHERE passkey_id = ANY($1)`, [passkeyIds]).catch(() => undefined);
    await pool.query(`DELETE FROM passkeys WHERE id = ANY($1)`, [passkeyIds]).catch(() => undefined);
    for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
    await pool.end();
  });

  async function get(at: string, path: string, headers: Record<string, string> = {}): Promise<{ status: number; text: string; body: any }> {
    const r = await fetch(`${at}${path}`, { headers });
    const text = await r.text();
    return { status: r.status, text, body: JSON.parse(text) };
  }
  const owner = { authorization: `Bearer ${localOwnerToken}` };
  const DOORS = ["/api/connections", "/api/connections/github"];

  it("U2: no credential is the uniform 401, on both doors", async () => {
    for (const path of DOORS) {
      const r = await get(base, path);
      expect(r.status, path).toBe(401);
      expect(r.body).toEqual({ error: { code: "unauthenticated", message: "authentication required" } });
    }
  });

  it("U2: an agent bearer and the capture owner token are the uniform 403 on both doors — and learn nothing", async () => {
    for (const path of DOORS) {
      for (const bearer of [agentToken, ownerToken]) {
        const r = await get(base, path, { authorization: `Bearer ${bearer}` });
        expect(r.status, path).toBe(403);
        expect(r.body).toEqual({ error: { code: "forbidden", message: "not granted" } });
        expect(r.text).not.toContain("github_read");
      }
    }
  });

  it("U2: the local owner token reaches both doors, and so does a passkey session (reach owner)", async () => {
    for (const path of DOORS) {
      expect((await get(base, path, owner)).status, path).toBe(200);
      expect((await get(base, path, { cookie: sessionCookie })).status, path).toBe(200);
    }
  });

  it("the list: status, reach with names only, tools and modes, used by", async () => {
    const r = await get(base, "/api/connections", owner);
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(["as_of", "connections", "types"]);
    expect(r.body.connections.map((c: { name: string; status: string }) => [c.name, c.status])).toEqual([
      ["github", "ok"],
      ["leaky", "failed"],
      ["linear", "ok"],
    ]);
    expect(r.body.connections[0]).toEqual({
      name: "github",
      type: "mcp",
      provider: "custom",
      description: "GitHub's MCP server",
      status: "ok",
      issues: [],
      reach: { class: "command", command: "metistry-itest-never-run", args: ["--stdio"], cwd: null, env: ["GITHUB_PERSONAL_ACCESS_TOKEN", "LOG_LEVEL"], runs_on: "host" },
      secrets: ["github_read"],
      variables: [],
      tools: [
        { name: "create_issue", group: "changes", mode: "ask" },
        { name: "search_issues", group: "reads", mode: "on" },
      ],
      offer_to_agents: false,
      used_by: [{ kind: "sync", name: "github-state" }],
    });
    // names, never values: no env value, no reference, and never the pasted key
    expect(r.text).not.toContain("warn");
    expect(r.text).not.toContain("{{ secret.github_read");
    expect(r.text).not.toContain(KEY);
  });

  it("the list carries the installed connection types — an extension's, its fields by kind, no value anywhere (T6-13b)", async () => {
    const r = await get(base, "/api/connections", owner);
    expect(r.body.types).toEqual([
      {
        name: "linear",
        title: "Linear",
        description: "Linear — the issues assigned to you. A personal API key, sent to api.linear.app only.",
        origin: "extension",
        provides: "mcp",
        transports: ["http"],
        auth: null,
        capabilities: [],
        fields: [
          { key: "workspace", kind: "text", label: "Workspace", help: null, required: false, default: "acme" },
          { key: "api_key", kind: "secret", label: "API key", help: null, required: false },
        ],
        tools: [{ name: "list_issues", group: "reads" }],
      },
    ]);
    // the same unit rides on the detail's provider_unit
    const one = await get(base, "/api/connections/linear", owner);
    expect(one.body.connection.provider_unit.type).toEqual(r.body.types[0]);
    // an agent bearer learns nothing of the types either (U2: the door is one)
    const agent = await get(base, "/api/connections", { authorization: `Bearer ${agentToken}` });
    expect(agent.status).toBe(403);
    expect(agent.text).not.toContain("workspace");
  });

  it("a file with a key pasted into it is listed by name and why — nothing it holds", async () => {
    const r = await get(base, "/api/connections/leaky", owner);
    expect(r.status).toBe(200);
    expect(r.body.connection).toMatchObject({ name: "leaky", status: "failed", reach: null, tools: [], provider_unit: null });
    expect(r.body.connection.issues.join()).toMatch(/looks like a key/);
    expect(r.text).not.toContain(KEY);
  });

  it("one connection: its file and its provider's unit", async () => {
    const r = await get(base, "/api/connections/linear", owner);
    expect(r.status).toBe(200);
    expect(r.body.connection).toMatchObject({
      name: "linear",
      file: ".metistry/connections/linear.yaml",
      provider_unit: { name: "linear", origin: "extension", provides: "mcp", implementation: "native", tools: [{ name: "list_issues", group: "reads" }] },
    });
  });

  it("a read dials nothing: the command it names is never run", async () => {
    // `metistry-itest-never-run` is on no PATH; a dial would fail and say so.
    // The row is `ok` because a read judges the file — it never starts it.
    const r = await get(base, "/api/connections/github", owner);
    expect(r.body.connection.status).toBe("ok");
    expect(existsSync(join(dir, ".metistry", "state"))).toBe(false);
  });

  it("an unknown or malformed name is the family's 404; no instance directory is a 503 naming what is missing", async () => {
    for (const path of ["/api/connections/nope", "/api/connections/Bad_Name", "/api/connections/..%2Fsecrets"]) {
      const r = await get(base, path, owner);
      expect(r.status, path).toBe(404);
    }
    for (const path of DOORS) {
      const none = await get(baseNone, path, owner);
      expect(none.status).toBe(503);
      expect(none.body.error.code).toBe("not_available");
      expect(none.body.error.message).toContain("METISTRY_INSTANCE_DIR");
    }
  });
});
