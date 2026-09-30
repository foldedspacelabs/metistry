// Generated tools (T4-10): an API, a feed and a files connection reached
// through the tools Metistry makes for them, by the same pool and the same
// door as an MCP server — every service a loopback fixture, every folder a
// temporary one.
//
// The misuse this file holds: a path that leaves the connection (a scheme,
// `//host`, `..`, a symbolic link out of the folder); a caller naming a
// secret in its arguments (refused for MCP connections too); a query
// parameter the connection sets, replaced by a caller; a redirect; a tool
// the file does not list; Never; Ask First without the owner's approval.

import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ConnectionPool, ConnectionRefused, apiUrl, checkConnection, generatedToolsFor, globMatcher, htmlText, parseFeed, type ConnectionCatalog } from "../src/index.js";
import { FAKE_STDIO, catalogOf, secretsWith } from "./helpers.js";

const TOKEN = "api_" + "Wq3Er8Ty1Ui6Op4As9Df2Gh7";

interface Seen {
  method: string;
  url: string;
  auth: string | undefined;
  body: string;
  contentType: string | undefined;
}

const RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Changelog</title>
<item><guid>r-3</guid><title>Release 3</title><link>https://example.test/r3</link><pubDate>Tue, 29 Sep 2026 10:00:00 GMT</pubDate><description><![CDATA[<p>Adds <b>feeds</b> &amp; files.</p>]]></description></item>
<item><guid>r-2</guid><title>Release 2</title><link>https://example.test/r2</link><description>Fixes the calendar.</description></item>
</channel></rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Notes</title>
<entry><id>urn:note:1</id><title>First note</title><link rel="alternate" href="https://example.test/n1"/><updated>2026-09-30T08:00:00Z</updated><summary>About the proxy.</summary></entry>
</feed>`;

let server: ReturnType<typeof createServer>;
let base: string;
let host: string;
const seen: Seen[] = [];

beforeAll(async () => {
  server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    seen.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization, body, contentType: req.headers["content-type"] });
    const u = new URL(req.url ?? "/", "http://x");
    if (u.pathname === "/feed.xml") return void res.writeHead(200, { "content-type": "application/rss+xml" }).end(RSS);
    if (u.pathname === "/atom.xml") return void res.writeHead(200, { "content-type": "application/atom+xml" }).end(ATOM);
    if (u.pathname === "/page") return void res.writeHead(200, { "content-type": "text/html" }).end("<html><head><style>x{}</style><script>alert(1)</script></head><body><h1>Title</h1><p>Hello&nbsp;there</p></body></html>");
    if (u.pathname === "/api/v1/moved") return void res.writeHead(302, { location: "https://elsewhere.example/" }).end();
    if (u.pathname.startsWith("/api/v1")) {
      return void res.writeHead(u.pathname.endsWith("/missing") ? 404 : 200, { "content-type": "application/json" }).end(
        JSON.stringify({ method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), echo: req.headers.authorization ?? null }),
      );
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
  host = `127.0.0.1:${port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const pools: ConnectionPool[] = [];
afterEach(async () => {
  for (const p of pools.splice(0)) await p.close();
  seen.splice(0);
});

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "metistry-generated-"));
  await mkdir(join(scratch, "docs/sub"), { recursive: true });
  await writeFile(join(scratch, "docs/readme.md"), "# Readme\nThe proxy speaks MCP.\n");
  await writeFile(join(scratch, "docs/notes.txt"), "nothing here\nthe PROXY again\n");
  await writeFile(join(scratch, "docs/sub/deep.md"), "deep proxy line\n");
  await writeFile(join(scratch, "docs/.hidden"), "proxy secret-ish\n");
  await writeFile(join(scratch, "docs/image.bin"), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]));
  await writeFile(join(scratch, "docs/skip-me.log"), "proxy log\n");
  await writeFile(join(scratch, "outside.txt"), "outside the folder\n");
  await symlink(join(scratch, "outside.txt"), join(scratch, "docs/escape.txt"));
});

function poolOf(catalog: ConnectionCatalog, values: Record<string, string> = {}): ConnectionPool {
  const store = secretsWith(values);
  const p = new ConnectionPool({ catalog: async () => ({ baseDir: scratch, ...catalog }), secrets: { value: async (n) => (await store).value(n) }, connectTimeoutMs: 10_000 });
  pools.push(p);
  return p;
}

const text = (out: { content: unknown[] }) => JSON.parse((out.content[0] as { text: string }).text) as Record<string, unknown>;

function api(tools: Record<string, { group: string; mode: string }> = { get: { group: "reads", mode: "on" }, request: { group: "changes", mode: "on" } }) {
  return {
    name: "svc",
    type: "api",
    provider: "custom",
    reach: { http: { url: `${base}/api/v1?team=core`, auth: { scheme: "bearer", secret: "svc_token" } } },
    secrets: ["svc_token"],
    tools,
  };
}
const apiSecrets = () => `secrets:\n  svc_token: { hosts: ["${host}"], grants: { "connection:svc": on } }\n`;

describe("the tools Metistry generates, by type and reach", () => {
  it("api: get (Reads) and request (Changes things); feed: three Reads; files: three Reads by path, read_page by URL", () => {
    const g = (type: string, reach: Record<string, unknown>) => generatedToolsFor({ type, reach } as never).map((t) => `${t.name}:${t.group}`);
    expect(g("api", { http: {} })).toEqual(["get:reads", "request:changes"]);
    expect(g("feed", { http: {} })).toEqual(["list_items:reads", "get_item:reads", "search_items:reads"]);
    expect(g("files", { path: {} })).toEqual(["list_files:reads", "read_file:reads", "search_files:reads"]);
    expect(g("files", { http: {} })).toEqual(["read_page:reads"]);
    expect(g("mcp", { http: {} })).toEqual([]);
  });

  it("the pool offers the listed ones, not Never — without dialling anything", async () => {
    const p = poolOf(catalogOf([api({ get: { group: "reads", mode: "on" }, request: { group: "changes", mode: "off" } })], { secrets: apiSecrets() }));
    const tools = await p.tools("svc");
    expect(tools.map((t) => [t.name, t.mode])).toEqual([["get", "on"]]);
    expect(tools[0]!.inputSchema).toMatchObject({ type: "object", properties: { path: { type: "string" } } });
    expect(seen).toEqual([]);
  });
});

describe("an API connection", () => {
  it("get: under the connection's URL, its own query kept, the key filled at the door, redacted on the way back", async () => {
    const p = poolOf(catalogOf([api()], { secrets: apiSecrets() }), { svc_token: TOKEN });
    const out = await p.call({ connection: "svc", tool: "get", args: { path: "issues/42", query: { state: "open" } } });
    expect(out.isError).toBe(false);
    expect(seen[0]).toMatchObject({ method: "GET", url: "/api/v1/issues/42?team=core&state=open", auth: `Bearer ${TOKEN}` });
    const r = text(out);
    expect(r.status).toBe(200);
    expect((r.json as Record<string, unknown>).echo).toBe("Bearer ***REDACTED secret.svc_token***");
    expect(out.secrets).toEqual(["svc_token"]);
  });

  it("request: a JSON body as JSON; an HTTP error is a tool error, not a thrown one", async () => {
    const p = poolOf(catalogOf([api()], { secrets: apiSecrets() }), { svc_token: TOKEN });
    const out = await p.call({ connection: "svc", tool: "request", args: { method: "POST", path: "issues", body: { title: "x" } } });
    expect(seen[0]).toMatchObject({ method: "POST", url: "/api/v1/issues?team=core", body: '{"title":"x"}', contentType: "application/json" });
    expect(text(out).status).toBe(200);
    const missing = await p.call({ connection: "svc", tool: "get", args: { path: "missing" } });
    expect(missing.isError).toBe(true);
    expect(text(missing).status).toBe(404);
  });

  it("**a path that leaves the connection is refused before anything is sent** — a scheme, //host, a leading /, .., an encoded climb", async () => {
    const p = poolOf(catalogOf([api()], { secrets: apiSecrets() }), { svc_token: TOKEN });
    for (const path of ["https://evil.example/x", "//evil.example/x", "/admin", "../v2/users", "a/../../x", "%2e%2e/x", "a%2fb"]) {
      const out = await p.call({ connection: "svc", tool: "get", args: { path } });
      expect(out.isError, path).toBe(true);
      expect(text(out).error, path).toBe("invalid_argument");
    }
    expect(seen).toEqual([]);
    expect(() => apiUrl(`${base}/api/v1?team=core`, "x", { team: "other" })).toThrow(/the connection's own/);
  });

  it("a redirect is not followed — other_host, and the key never goes there", async () => {
    const p = poolOf(catalogOf([api()], { secrets: apiSecrets() }), { svc_token: TOKEN });
    await expect(p.call({ connection: "svc", tool: "get", args: { path: "moved" } })).rejects.toMatchObject({ code: "other_host" });
  });

  it("**a caller naming a secret in its arguments is refused, for generated tools and for an MCP server alike** — nothing is sent", async () => {
    const p = poolOf(catalogOf([api()], { secrets: apiSecrets() }), { svc_token: TOKEN });
    for (const args of [{ method: "POST", path: "issues", body: { title: "{{ secret.svc_token }}" } }, { method: "POST", path: "x", body: "{{secret.svc_token}}" }, { method: "POST", path: "x", body: "{{ secrets.svc_token }}" }]) {
      await expect(p.call({ connection: "svc", tool: "request", args })).rejects.toMatchObject({ code: "secret_reference" });
    }
    expect(seen).toEqual([]);
    const mcp = {
      name: "local",
      type: "mcp",
      provider: "custom",
      reach: { command: { command: process.execPath, args: [FAKE_STDIO], cwd: "." } },
      tools: { echo: { group: "reads", mode: "on" } },
    };
    const q = poolOf(catalogOf([mcp]));
    await expect(q.call({ connection: "local", tool: "echo", args: { text: "{{ secret.github_write }}" } })).rejects.toMatchObject({ code: "secret_reference" });
    expect(q.size).toBe(0); // the command was never started
  });

  it("the owner's policy holds: unlisted and Never are refused, Ask First waits for the owner's approval", async () => {
    const p = poolOf(catalogOf([api({ get: { group: "reads", mode: "ask" }, request: { group: "changes", mode: "off" } })], { secrets: apiSecrets() }), { svc_token: TOKEN });
    await expect(p.call({ connection: "svc", tool: "request", args: { method: "POST" } })).rejects.toMatchObject({ code: "tool_off" });
    await expect(p.call({ connection: "svc", tool: "get", args: {} })).rejects.toMatchObject({ code: "needs_approval" });
    await expect(p.call({ connection: "svc", tool: "delete_everything", args: {} })).rejects.toMatchObject({ code: "tool_not_listed" });
    expect(seen).toEqual([]);
    const approved = await p.call({ connection: "svc", tool: "get", args: {}, approved: true });
    expect(text(approved).status).toBe(200);
  });

  it("a tool the file lists that Metistry does not generate is refused before anything is sent", async () => {
    const p = poolOf(catalogOf([api({ run_sql: { group: "changes", mode: "on" } })], { secrets: apiSecrets() }), { svc_token: TOKEN });
    const err = await p.call({ connection: "svc", tool: "run_sql", args: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectionRefused);
    expect((err as ConnectionRefused).code).toBe("tool_not_listed");
    expect(seen).toEqual([]);
  });
});

describe("a feed", () => {
  const feed = (path: string) => ({ name: "news", type: "feed", provider: "custom", reach: { http: { url: `${base}${path}` } }, tools: { list_items: { group: "reads", mode: "on" }, get_item: { group: "reads", mode: "on" }, search_items: { group: "reads", mode: "on" } } });

  it("lists, gets and searches RSS items — the summary's HTML reduced to text", async () => {
    const p = poolOf(catalogOf([feed("/feed.xml")]));
    const list = text(await p.call({ connection: "news", tool: "list_items", args: { limit: 1 } }));
    expect(list.total).toBe(2);
    expect(list.items).toEqual([{ id: "r-3", title: "Release 3", link: "https://example.test/r3", published: "Tue, 29 Sep 2026 10:00:00 GMT", summary: "Adds feeds & files." }]);
    expect(text(await p.call({ connection: "news", tool: "get_item", args: { id: "r-2" } })).item).toMatchObject({ title: "Release 2", summary: "Fixes the calendar." });
    const hits = text(await p.call({ connection: "news", tool: "search_items", args: { query: "CALENDAR" } }));
    expect((hits.items as Array<{ id: string }>).map((i) => i.id)).toEqual(["r-2"]);
    const none = await p.call({ connection: "news", tool: "get_item", args: { id: "nope" } });
    expect(none.isError).toBe(true);
  });

  it("reads Atom too, and refuses what is not a feed", async () => {
    const p = poolOf(catalogOf([feed("/atom.xml")]));
    expect(text(await p.call({ connection: "news", tool: "list_items", args: {} })).items).toEqual([{ id: "urn:note:1", title: "First note", link: "https://example.test/n1", published: "2026-09-30T08:00:00Z", summary: "About the proxy." }]);
    expect(() => parseFeed("<html><body/></html>")).toThrow(/not a feed/);
    expect(() => parseFeed('<!DOCTYPE x [<!ENTITY a "b">]><rss/>')).toThrow(/not a feed this reader can read/);
  });

  it("check(): reaches the feed once and lists the generated tools", async () => {
    const cat = catalogOf([feed("/feed.xml")]);
    const p = poolOf(cat);
    const r = await checkConnection(p, cat, "news");
    expect(r.status).toBe("ok");
    expect(r.meta).toMatchObject({ tools_seen: 3, listed: 3, missing: [], unlisted: [] });
  });
});

describe("a files connection", () => {
  const files = (extra: Record<string, unknown> = {}) => ({
    name: "docs",
    type: "files",
    provider: "custom",
    reach: { path: { path: "docs", skip: ["*.log"], ...extra } },
    tools: { list_files: { group: "reads", mode: "on" }, read_file: { group: "reads", mode: "on" }, search_files: { group: "reads", mode: "on" } },
  });

  it("lists one level — hidden files, skipped patterns and symbolic links left out; reads a text file", async () => {
    const p = poolOf(catalogOf([files()]));
    const list = text(await p.call({ connection: "docs", tool: "list_files", args: {} }));
    expect((list.entries as Array<{ path: string }>).map((e) => e.path)).toEqual(["image.bin", "notes.txt", "readme.md", "sub"]);
    expect(text(await p.call({ connection: "docs", tool: "read_file", args: { path: "readme.md" } }))).toMatchObject({ path: "readme.md", text: "# Readme\nThe proxy speaks MCP.\n" });
    const deep = text(await p.call({ connection: "docs", tool: "list_files", args: { path: "sub" } }));
    expect(deep.entries).toEqual([{ path: "sub/deep.md", type: "file", size: 16 }]);
  });

  it("**never outside the folder** — .., an absolute path and a symbolic link that leads out are refused; a binary file is not read", async () => {
    const p = poolOf(catalogOf([files()]));
    for (const path of ["../outside.txt", "/etc/hosts", "sub/../../outside.txt", "escape.txt"]) {
      const out = await p.call({ connection: "docs", tool: "read_file", args: { path } });
      expect(out.isError, path).toBe(true);
      expect(JSON.stringify(out.content)).not.toContain("outside the folder");
    }
    expect(text(await p.call({ connection: "docs", tool: "read_file", args: { path: "image.bin" } })).error).toBe("binary");
    expect((await p.call({ connection: "docs", tool: "read_file", args: { path: "skip-me.log" } })).isError).toBe(true);
    expect((await p.call({ connection: "docs", tool: "read_file", args: { path: ".hidden" } })).isError).toBe(true);
  });

  it("searches the text files it may read — not hidden, skipped, binary or linked-out ones", async () => {
    const p = poolOf(catalogOf([files({ include: ["*.md", "*.txt"] })]));
    const r = text(await p.call({ connection: "docs", tool: "search_files", args: { query: "proxy" } }));
    expect(r.matches).toEqual([
      { path: "notes.txt", line: 2, text: "the PROXY again" },
      { path: "readme.md", line: 2, text: "The proxy speaks MCP." },
      { path: "sub/deep.md", line: 1, text: "deep proxy line" },
    ]);
  });

  it("a web page is read as its text", async () => {
    const page = { name: "page", type: "files", provider: "custom", reach: { http: { url: `${base}/page` } }, tools: { read_page: { group: "reads", mode: "on" } } };
    const p = poolOf(catalogOf([page]));
    expect(text(await p.call({ connection: "page", tool: "read_page", args: {} })).text).toBe("Title\nHello there");
    expect(htmlText("<p>a</p><script>b</script>c")).toBe("a\nc");
  });

  it("globs: * inside a name, ** across folders, a pattern without / matches a name anywhere", () => {
    expect(globMatcher("*.md")("a/b/c.md")).toBe(true);
    expect(globMatcher("docs/*.md")("docs/sub/c.md")).toBe(false);
    expect(globMatcher("docs/**/*.md")("docs/sub/c.md")).toBe(true);
    expect(globMatcher("docs/**/*.md")("docs/c.md")).toBe(true);
    expect(globMatcher("a?c")("abc")).toBe(true);
  });
});
