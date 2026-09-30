// The console's connections proxy, wired (T4-10; owner ruling 2026-09-30,
// Q10 — open since #374, when no live console built a pool and both proxy
// tools answered `not_available` outside tests). The same construction
// main.ts uses (`consoleConnections`): a real `ConnectionPool` over a
// scratch instance's catalog, values from the environment `metistry secrets
// sync --to env` writes, mounted on the real `/mcp` against the scratch
// database. Every service is a loopback fixture.
//
// What it holds: the assistant reaches a connection end to end — the
// listing, the generated tools fetched lazily and never on the eager
// surface, a call answered with the service's data, its secret filled at
// the door from the delivered environment and redacted on the way back, and
// the call audited as a `connection_call` row; a borrower that was lent
// nothing is told there is no such connection.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { mintToken } from "@foldedspacelabs/metistry-core";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";
import { makeServer } from "../src/server.js";
import { consoleConnections } from "../src/connections-proxy.js";
import * as agents from "../src/agents.js";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url)); // METISTRY_DB_* only (docs/ops/testing.md)
const policy = { idleDays: 30, maxDays: 365 };
const KEY = "svc_" + "Tq7Wz2Xc9Vb4Nm1Lk6Jh3Gf8";

describe.skipIf(!hasDb)("the console's connections proxy (integration)", () => {
  let db: pg.Pool;
  let base: string;
  let server: ReturnType<typeof makeServer>;
  let service: ReturnType<typeof createServer>;
  let dir: string;
  let assistantToken: string;
  let borrowerToken: string;
  const suffix = mintToken(4).toLowerCase().replaceAll(/[^a-z0-9]/g, "").slice(0, 6) || "x";
  const assistantId = `pool-itest-a-${suffix}`;
  const borrowerId = `pool-itest-b-${suffix}`;
  const pools: Array<{ close(): Promise<void> }> = [];
  let rpc = 1;

  async function tool(token: string, name: string, args: Record<string, unknown> = {}): Promise<{ error?: { code: string; message: string } } & Record<string, unknown>> {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: rpc++, method: "tools/call", params: { name, arguments: args } }),
    });
    const text = ((await res.json()) as { result: { content: { text: string }[] } }).result.content[0]!.text;
    return JSON.parse(text.split("\n")[0]!);
  }

  beforeAll(async () => {
    service = createServer((req, res) => {
      if (req.url === "/feed.xml") return void res.writeHead(200, { "content-type": "application/rss+xml" }).end(`<rss version="2.0"><channel><item><guid>a</guid><title>Pool wired</title><description>The console builds one.</description></item></channel></rss>`);
      if (req.url?.startsWith("/api/")) return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ path: req.url, you_sent: req.headers.authorization ?? null }));
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => service.listen(0, "127.0.0.1", r));
    const origin = `http://127.0.0.1:${(service.address() as AddressInfo).port}`;
    const host = origin.slice("http://".length);

    dir = await mkdtemp(join(tmpdir(), "metistry-console-pool-"));
    await mkdir(join(dir, ".metistry/connections"), { recursive: true });
    await writeFile(join(dir, ".metistry/identity.yaml"), `name: Aide\ninstance_id: "22222222-3333-4444-8555-666666666666"\n`);
    await writeFile(
      join(dir, ".metistry/connections/news.yaml"),
      `name: news\ntype: feed\nprovider: custom\nreach: { http: { url: "${origin}/feed.xml" } }\ntools:\n  list_items: { group: reads, mode: on }\n  get_item: { group: reads, mode: ask }\n  search_items: { group: reads, mode: off }\n`,
    );
    await writeFile(
      join(dir, ".metistry/connections/svc.yaml"),
      `name: svc\ntype: api\nprovider: custom\nreach: { http: { url: "${origin}/api", auth: { scheme: bearer, secret: svc_token } } }\nsecrets: [svc_token]\ntools:\n  get: { group: reads, mode: on }\n  request: { group: changes, mode: ask }\n`,
    );
    await writeFile(join(dir, ".metistry/secrets.yaml"), `secrets:\n  svc_token: { hosts: ["${host}"], grants: { "connection:svc": on } }\n`);

    // exactly what main.ts builds, with the environment `secrets sync --to env` writes
    const wired = consoleConnections({ instanceDir: dir }, { env: { METISTRY_SECRET_SVC_TOKEN: KEY }, version: "test" });
    pools.push(wired.pool);

    db = await testDb(pg.Pool);
    server = makeServer(db, new QueryStore(db), { origin: "http://127.0.0.1:0", inboxDir: join(dir, "inbox"), policy, secureCookies: false, connectionsProxy: wired.proxy });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    ({ token: assistantToken } = await agents.createAgent(db, { id: assistantId, display_name: "pool itest assistant" }));
    await db.query(`UPDATE agents SET kind = 'internal' WHERE id = $1`, [assistantId]);
    ({ token: borrowerToken } = await agents.createAgent(db, { id: borrowerId, display_name: "pool itest borrower" }));
  });

  afterAll(async () => {
    for (const p of pools) await p.close();
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => service.close(() => r()));
    await db.end();
    await rm(dir, { recursive: true, force: true });
  });

  it("lists the instance's connections, and fetches a generated type's tools only when asked — never on the eager surface", async () => {
    const eager = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${assistantToken}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: rpc++, method: "tools/list", params: {} }),
    });
    const names = ((await eager.json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
    expect(names).toContain("connections_call");
    for (const generated of ["list_items", "get_item", "search_items", "get", "request", "read_file"]) expect(names).not.toContain(generated);

    const all = await tool(assistantToken, "connections_list");
    expect((all.connections as Array<{ name: string }>).map((c) => c.name).sort()).toEqual(["news", "svc"]);
    const news = await tool(assistantToken, "connections_list", { connection: "news" });
    // Never is not offered; the others with Metistry's own definitions
    expect((news.tools as Array<{ name: string }>).map((t) => t.name).sort()).toEqual(["get_item", "list_items"]);
  });

  it("**runs a call through the pool**: a feed read, and an API read whose key is filled at the door from the delivered environment and redacted on the way back", async () => {
    const items = await tool(assistantToken, "connections_call", { connection: "news", tool: "list_items" });
    expect(JSON.stringify(items)).toContain("Pool wired");

    const got = await tool(assistantToken, "connections_call", { connection: "svc", tool: "get", arguments: { path: "issues" } });
    const text = JSON.stringify(got);
    expect(text).toContain("/api/issues");
    expect(text).toContain("Bearer ***REDACTED secret.svc_token***");
    expect(text).not.toContain(KEY);

    const row = (await db.query(`SELECT component, ok, meta FROM runs WHERE kind = 'connection_call' AND component = $1 AND meta->>'connection' = 'svc' ORDER BY id DESC LIMIT 1`, [assistantId])).rows[0]!;
    expect(row).toMatchObject({ ok: true });
    expect(row.meta).toMatchObject({ connection: "svc", connection_tool: "get", secrets: ["svc_token"] });
  });

  it("a borrower that was lent nothing is told there is no such connection — nothing is dialled for it", async () => {
    const r = await tool(borrowerToken, "connections_call", { connection: "svc", tool: "get", arguments: {} });
    expect(r.error).toMatchObject({ code: "not_found", message: "no such connection: svc" });
  });
});
