// One scope rule for every knowledge read, on both doors (ruled
// 2026-09-19). Misuse first (invariant 8): the principal is injected, so
// every tier is exercised by swapping tokens, and the questions asked are
// the ones an agent would ask if it were trying to get out of its grant.
//
// Two properties, against the REAL seed queries rather than fixtures — the
// files that ship are the files that carry `expose: route`, so a manifest
// that lost the line fails here:
//
// 1. `queries_run` will not serve a route-backed query. Not to an external
//    agent holding `queries: true`, and not to the instance's own internal
//    principal either: the refusal is about the DOOR, not the credential,
//    because the row filter lives on the other one. It is the unknown-query
//    refusal byte for byte, and `queries_list` does not list the name.
// 2. `knowledge_list` is that other door, and it runs the same two named
//    queries through the same `canSeeUnder`. Tier `index` gets titles
//    anywhere and content nowhere; tier `areas` gets its prefixes and the
//    links inside them, both ends; tier `none` gets nothing.
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { TasksService } from "@foldedspacelabs/metistry-tasks";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { createBrainServer, KNOWLEDGE_LINKS_QUERY, KNOWLEDGE_PAGES_QUERY, type AgentPrincipal, type VaultListEntry } from "../src/index.js";
import { loadTestEnv } from "@foldedspacelabs/metistry-core/test-env";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url));

const AGENT = "itest-scope-agent";
const HUB = "itest-scope-hub";
const AREA = "Areas/Scope";
const OUTSIDE = "Areas/Elsewhere";

interface Parsed {
  isError: boolean;
  body: any;
}

/** The seed manifests as they ship — `seed/queries/<name>.yaml`, `expose: route` included. */
function seedQuery(name: string): string {
  return readFileSync(new URL(`../../../seed/queries/${name}.yaml`, import.meta.url), "utf8");
}

describe.skipIf(!hasDb)("knowledge scope on /mcp (real db, real MCP client, real seed queries)", () => {
  let pool: pg.Pool;
  let server: Server;
  let serverWithBridge: Server;
  let base: string;
  let baseWithBridge: string;
  const principals = new Map<string, AgentPrincipal>();

  const grant = (token: string, p: AgentPrincipal) => principals.set(token, p);

  async function connect(token: string, origin = base): Promise<Client> {
    const client = new Client({ name: "itest", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    return client;
  }

  async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Parsed> {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text: string }[] };
    const text = r.content[0]!.text;
    const nl = text.indexOf("\n");
    return { isError: !!r.isError, body: JSON.parse(nl === -1 ? text : text.slice(0, nl)) };
  }

  /** One call, one client — every case here is a different credential, so a shared connection would hide a per-principal registration bug. */
  async function once(token: string, tool: string, args: Record<string, unknown> = {}, origin = base): Promise<Parsed> {
    const c = await connect(token, origin);
    try {
      return await call(c, tool, args);
    } finally {
      await c.close();
    }
  }

  beforeAll(async () => {
    pool = new pg.Pool({
      host: process.env.METISTRY_DB_HOST ?? "127.0.0.1",
      port: Number(process.env.METISTRY_DB_PORT ?? 5432),
      user: process.env.METISTRY_DB_USER ?? "metistry",
      database: process.env.METISTRY_TEST_DB_NAME ?? "metistry_test",
      password: process.env.METISTRY_DB_PASSWORD,
    });

    await pool.query(`DELETE FROM knowledge_links WHERE from_path LIKE 'Areas/Scope%' OR from_path LIKE 'Areas/Elsewhere%' OR to_path LIKE 'Areas/Scope%' OR to_path LIKE 'Areas/Elsewhere%'`);
    await pool.query(`DELETE FROM knowledge_files WHERE path LIKE 'Areas/Scope%' OR path LIKE 'Areas/Elsewhere%'`);
    await pool.query(
      `INSERT INTO knowledge_files (path, title, description, draft) VALUES
        ('Areas/Scope/Inside.md',   'Inside',   'a page inside the grant',  false),
        ('Areas/Scope/Second.md',   'Second',   'another page inside',      false),
        ('Areas/Scope/Hidden.md',   'Hidden',   'a draft inside',           true),
        ('Areas/Elsewhere/Out.md',  'Out',      'a page outside the grant', false)`,
    );
    // Inside → Out crosses the grant boundary outward; Out → Inside crosses
    // it inward as a backlink. Both must be invisible to the areas grant:
    // an edge is a disclosure in whichever direction it points.
    await pool.query(
      `INSERT INTO knowledge_links (from_path, to_path, kind) VALUES
        ('Areas/Scope/Inside.md',  'Areas/Scope/Second.md',   'wikilink'),
        ('Areas/Scope/Inside.md',  'Areas/Elsewhere/Out.md',  'wikilink'),
        ('Areas/Elsewhere/Out.md', 'Areas/Scope/Inside.md',   'wikilink')`,
    );

    const queries = new QueryStore(pool);
    queries.load(seedQuery(KNOWLEDGE_PAGES_QUERY));
    queries.load(seedQuery(KNOWLEDGE_LINKS_QUERY));
    queries.load(`
name: itest_scope_generic
description: a generic (default-exposure) query, so "refused" can be told from "no queries work"
params: { n: { type: int, default: 2 } }
sql: SELECT generate_series(1, :n) AS n
cache_ttl: 0
`);

    const authenticate = async (req: { headers: Record<string, unknown> }) => {
      const m = /^Bearer\s+(\S+)$/.exec(String(req.headers.authorization ?? ""));
      return (m?.[1] && principals.get(m[1])) || null;
    };

    // No `listKnowledge`: this deployment has no vault bridge, so the page
    // list comes from the reconciler's INDEX through `knowledge_pages` —
    // the branch the ruling's discovery case actually runs on.
    const brain = createBrainServer({ db: pool, queries, authenticate, tasks: new TasksService(pool), inboxDir: "/tmp/metistry-itest-scope" });
    server = createServer((req, res) => {
      if (req.url === "/mcp") void brain.handle(req, res).catch(() => res.destroy());
      else res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // …and one WITH a bridge, whose lister answers the way the reconciler's
    // `GET /vault/list` does: everything it confined to the instance repo,
    // machinery included. `canList` is what stops those reaching an agent.
    const listKnowledge = async (): Promise<VaultListEntry[]> => [
      { path: "Areas/Scope/Inside.md", kind: "file" },
      { path: "Areas/Elsewhere/Out.md", kind: "file" },
      { path: ".metistry", kind: "dir" },
      { path: ".metistry/state/.env", kind: "file" },
      { path: ".obsidian/workspace.json", kind: "file" },
      { path: "Artifacts/blob.bin", kind: "file" },
      { path: "CLAUDE.md", kind: "file" },
      { path: "now.md", kind: "file" },
    ];
    const bridged = createBrainServer({ db: pool, queries, authenticate, tasks: new TasksService(pool), inboxDir: "/tmp/metistry-itest-scope", listKnowledge });
    serverWithBridge = createServer((req, res) => {
      if (req.url === "/mcp") void bridged.handle(req, res).catch(() => res.destroy());
      else res.writeHead(404).end();
    });
    await new Promise<void>((r) => serverWithBridge.listen(0, "127.0.0.1", r));
    baseWithBridge = `http://127.0.0.1:${(serverWithBridge.address() as AddressInfo).port}`;

    grant("tok-none", { id: AGENT, grants: { tier: "none", areas: [], queries: true }, projects: [] });
    grant("tok-index", { id: AGENT, grants: { tier: "index", areas: [], queries: true }, projects: [] });
    grant("tok-areas", { id: AGENT, grants: { tier: "areas", areas: [AREA], queries: true }, projects: [] });
    grant("tok-hub", { id: HUB, kind: "internal", grants: { tier: "areas", areas: ["/"] }, projects: [] });
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => serverWithBridge.close(() => r()));
    await pool.end();
  });

  // --- 1. queries_run honours `expose` -------------------------------------

  it("queries_run refuses a route-backed query with the unknown-query refusal, byte for byte, for every credential", async () => {
    const unknown = await once("tok-hub", "queries_run", { name: "no_such_thing_here" });
    expect(unknown).toMatchObject({ isError: true, body: { error: { code: "not_found", message: "no such query: no_such_thing_here" } } });

    for (const token of ["tok-hub", "tok-none", "tok-index", "tok-areas"]) {
      for (const name of [KNOWLEDGE_PAGES_QUERY, KNOWLEDGE_LINKS_QUERY]) {
        const r = await once(token, "queries_run", { name });
        // Same code, same message shape, no mention of `expose`, of a route,
        // or of the query existing: a distinguishable refusal would make this
        // tool an oracle for the route-only set.
        expect(r, `${token}/${name}`).toMatchObject({ isError: true, body: { error: { code: "not_found", message: `no such query: ${name}` } } });
        expect(JSON.stringify(r.body)).not.toContain("expose");
        expect(JSON.stringify(r.body)).not.toContain("route");
      }
    }
  });

  it("queries_run still serves a generic query — the refusal above is about the door, not a broken store", async () => {
    const ok = await once("tok-hub", "queries_run", { name: "itest_scope_generic", params: { n: 2 } });
    expect(ok.isError).toBe(false);
    expect(ok.body.rows).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("queries_list does not name a route-backed query — a list that named one would contradict the refusal and publish the set", async () => {
    const list = await once("tok-hub", "queries_list");
    expect(list.isError).toBe(false);
    const names = list.body.queries.map((q: { name: string }) => q.name);
    expect(names).toContain("itest_scope_generic");
    expect(names).not.toContain(KNOWLEDGE_PAGES_QUERY);
    expect(names).not.toContain(KNOWLEDGE_LINKS_QUERY);
  });

  // --- 2. the scoped door ---------------------------------------------------

  it("tier none: nothing at all, and told `not granted` rather than `not found`", async () => {
    expect(await once("tok-none", "knowledge_list")).toMatchObject({ isError: true, body: { error: { code: "forbidden", message: "not granted" } } });
    expect(await once("tok-none", "knowledge_list", { links_for: "Areas/Scope/Inside.md" })).toMatchObject({ isError: true, body: { error: { code: "forbidden", message: "not granted" } } });
    expect(await once("tok-none", "knowledge_list", {}, baseWithBridge)).toMatchObject({ isError: true, body: { error: { code: "forbidden", message: "not granted" } } });
  });

  it("tier index: titles anywhere in the vault index — path, title, description — and content nowhere", async () => {
    const r = await once("tok-index", "knowledge_list");
    expect(r.isError).toBe(false);
    const byPath = new Map(r.body.entries.map((e: any) => [e.path, e]));
    // Discovery across the WHOLE index, the grant's own areas irrelevant:
    // this is the ruling's case — an agent learns a page exists so it can
    // ask for the area that holds it.
    expect(byPath.get("Areas/Scope/Inside.md")).toMatchObject({ title: "Inside", description: "a page inside the grant" });
    expect(byPath.get("Areas/Elsewhere/Out.md")).toMatchObject({ title: "Out", description: "a page outside the grant" });
    expect(byPath.has("Areas/Scope/Hidden.md")).toBe(false); // a draft is invisible at every tier
    // Titles only: no entry carries a byte of the note.
    for (const e of r.body.entries) expect(Object.keys(e as object)).not.toContain("content");
  });

  it("tier index: links are content-shaped, so they need `areas` — the discovery tier is told which area would let it (ruled 2026-09-19, PR #216 judgement call B)", async () => {
    // Inside.md is a real, settled row this tier can already SEE (the
    // previous test) — so the refusal names the area rather than the bare
    // string: it is not a new leak, existence was already visible.
    const r = await once("tok-index", "knowledge_list", { links_for: "Areas/Scope/Inside.md" });
    expect(r).toMatchObject({
      isError: true,
      body: { error: { code: "forbidden", message: expect.stringContaining("`Areas/Scope`") }, reason: "scope_required", grantedScope: "Areas/Scope" },
    });
    expect(r.body.error.message).toContain("request_access"); // names the mechanism, so the refusal is not a dead end

    // A path merely SHAPED like a vault path — never indexed, machinery, or
    // outside the vault-path rule — must not confirm existence either way:
    // no area is ever named for it, tier index included.
    for (const misuse of ["Areas/Scope/NoSuchPage.md", "Areas/Scope/Hidden.md", ".metistry/identity.yaml", "Artifacts/blob.bin", "Areas/Scope/../../etc/passwd"]) {
      const bad = await once("tok-index", "knowledge_list", { links_for: misuse });
      expect(bad, misuse).toMatchObject({ isError: true, body: { error: { code: "forbidden", message: "not granted" } } });
      expect(JSON.stringify(bad.body), misuse).not.toContain("grantedScope");
      expect(JSON.stringify(bad.body), misuse).not.toContain("scope_required");
    }
  });

  it("tier areas: the page list stops at the granted prefixes", async () => {
    const r = await once("tok-areas", "knowledge_list");
    expect(r.isError).toBe(false);
    const paths = r.body.entries.map((e: any) => e.path);
    expect(paths).toContain("Areas/Scope/Inside.md");
    expect(paths).toContain("Areas/Scope/Second.md");
    expect(paths).not.toContain("Areas/Scope/Hidden.md");
    expect(paths.some((p: string) => p.startsWith(OUTSIDE))).toBe(false);
    // …and a prefix argument pointing outside the grant is refused before
    // any row is fetched, rather than coming back conveniently empty.
    expect(await once("tok-areas", "knowledge_list", { prefix: OUTSIDE })).toMatchObject({ isError: true, body: { error: { code: "forbidden", message: "not granted" } } });
  });

  it("tier areas: links inside the grant only — BOTH ends, in both directions", async () => {
    const r = await once("tok-areas", "knowledge_list", { links_for: "Areas/Scope/Inside.md" });
    expect(r.isError).toBe(false);
    expect(r.body.path).toBe("Areas/Scope/Inside.md");
    const edges = r.body.links.map((l: any) => `${l.direction}:${l.path}`);
    expect(edges).toContain("outgoing:Areas/Scope/Second.md");
    // the outgoing edge to Elsewhere and the incoming edge from it are both
    // DROPPED — not flagged, not counted: "there is something here you may
    // not see" is the disclosure the filter exists to prevent
    expect(edges.some((e: string) => e.includes(OUTSIDE))).toBe(false);
    expect(JSON.stringify(r.body)).not.toContain(OUTSIDE);

    // the page ASKED about has to be readable too: "this page has four
    // backlinks" is a fact about that page
    expect(await once("tok-areas", "knowledge_list", { links_for: "Areas/Elsewhere/Out.md" })).toMatchObject({
      isError: true,
      body: { error: { code: "forbidden", message: "not granted" } },
    });
    // and a machinery path is not knowledge, for anyone
    expect(await once("tok-hub", "knowledge_list", { links_for: ".metistry/compute.yaml" })).toMatchObject({
      isError: true,
      body: { error: { code: "forbidden", message: "not granted" } },
    });
  });

  it("the bridge's listing passes the same vault-path rule: no .metistry/, no dot-directory, no Artifacts/, no root CLAUDE.md — at tier index, which browses everything", async () => {
    const r = await once("tok-index", "knowledge_list", {}, baseWithBridge);
    expect(r.isError).toBe(false);
    const paths: string[] = r.body.entries.map((e: any) => e.path);
    expect(paths).toContain("Areas/Scope/Inside.md");
    expect(paths).toContain("now.md"); // a root NOTE is knowledge; the root CLAUDE.md is not
    for (const machinery of [".metistry", ".metistry/state/.env", ".obsidian/workspace.json", "Artifacts/blob.bin", "CLAUDE.md"]) {
      expect(paths, machinery).not.toContain(machinery);
    }
  });

  it("no QueryStore at all: the tool is `not_available`, naming the query — never an unfiltered answer and never a 500", async () => {
    const bare = createBrainServer({
      db: pool,
      authenticate: async (req) => {
        const m = /^Bearer\s+(\S+)$/.exec(String(req.headers.authorization ?? ""));
        return (m?.[1] && principals.get(m[1])) || null;
      },
      tasks: new TasksService(pool),
      inboxDir: "/tmp/metistry-itest-scope",
    });
    const s = createServer((req, res) => {
      if (req.url === "/mcp") void bare.handle(req, res).catch(() => res.destroy());
      else res.writeHead(404).end();
    });
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    const origin = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    try {
      expect(await once("tok-index", "knowledge_list", {}, origin)).toMatchObject({
        isError: true,
        body: { error: { code: "not_available", message: expect.stringContaining(KNOWLEDGE_PAGES_QUERY) } },
      });
      expect(await once("tok-areas", "knowledge_list", { links_for: "Areas/Scope/Inside.md" }, origin)).toMatchObject({
        isError: true,
        body: { error: { code: "not_available", message: expect.stringContaining(KNOWLEDGE_LINKS_QUERY) } },
      });
    } finally {
      await new Promise<void>((r) => s.close(() => r()));
    }
  });
});
