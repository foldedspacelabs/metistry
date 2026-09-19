// The knowledge read path's filter, on its own — a misuse test before it is
// a feature test (invariant 8).
//
// The thing being held here is not obvious from the routes: the reconciler's
// `GET /vault/read` does NOT gate on `isVaultPath`. It confines a path to the
// instance repo and stops, because `metistry update` and `metistry compute`
// write `.metistry/metistry.lock` and `.metistry/compute.yaml` through the
// same bridge and a read gate would break the write path. So `.metistry/`,
// `Artifacts/` and the root `CLAUDE.md` are reachable over that bridge with
// the console's own bearer, and it is THIS file that makes them unreachable
// over `/api/knowledge/page`.
import { readFile } from "node:fs/promises";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { VaultError } from "@foldedspacelabs/metistry-artifacts";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import {
  NO_SCOPE,
  OWNER_SCOPE,
  canSee,
  filterHits,
  filterPages,
  grantedScope,
  knowledgeRoutes,
  vaultBridgeSearch,
  type KnowledgeScope,
  type KnowledgeSearchHit,
} from "../src/knowledge-routes.js";

const hit = (path: string): KnowledgeSearchHit => ({ path, title: path, description: null, snippet: "…", score: 1, source: "keyword" });

describe("canSee: vault content first, then the scope", () => {
  it("admits ordinary vault pages for the owner", () => {
    for (const p of ["Areas/Health/sleep.md", "Journal/2026-09-18.md", "Me/profile.md", "now.md", "Areas/CLAUDE.md"]) {
      expect(canSee(p, OWNER_SCOPE), p).toBe(true);
    }
  });

  // The owner may read every one of these — with a text editor, or
  // `metistry compute show`. None of them is KNOWLEDGE, and none of them
  // comes out of the knowledge route.
  it("refuses everything the vault walk itself refuses, for the owner too", () => {
    for (const p of [
      ".metistry/compute.yaml",
      ".metistry/state/.env",
      ".metistry/agents/ops/writer.md",
      "Artifacts/report.pdf",
      "CLAUDE.md",
      "README.md",
      ".obsidian/workspace.json",
      ".git/config",
    ]) {
      expect(canSee(p, OWNER_SCOPE), p).toBe(false);
    }
  });

  it("refuses traversal, absolute paths, backslashes, NULs and the empty string", () => {
    for (const p of ["../etc/passwd", "Areas/../../etc/passwd", "/etc/passwd", "Areas//x.md", "./x.md", "Areas\\x.md", "Areas/x\0.md", ""]) {
      expect(canSee(p, OWNER_SCOPE), JSON.stringify(p)).toBe(false);
    }
    expect(canSee(`Areas/${"x".repeat(600)}.md`, OWNER_SCOPE)).toBe(false);
    expect(canSee(undefined as unknown as string, OWNER_SCOPE)).toBe(false);
  });

  it("narrows to the scope's areas when it has any — prefix semantics, not substring", () => {
    const scope = { areas: ["Areas/Health", "Journal/"] };
    expect(canSee("Areas/Health/sleep.md", scope)).toBe(true);
    expect(canSee("Areas/Health", scope)).toBe(true);
    expect(canSee("Journal/2026-09-18.md", scope)).toBe(true);
    expect(canSee("Areas/Healthcare/billing.md", scope)).toBe(false); // the sibling a substring match would leak
    expect(canSee("Areas/Finance/tax.md", scope)).toBe(false);
    expect(canSee("now.md", scope)).toBe(false);
  });

  it("still refuses non-vault paths inside a granted area", () => {
    expect(canSee(".metistry/compute.yaml", { areas: [".metistry"] })).toBe(false);
    expect(canSee("Artifacts/x.pdf", { areas: ["Artifacts"] })).toBe(false);
  });
});

describe("filterHits: an excluded path is dropped, never flagged", () => {
  it("removes out-of-scope hits and says nothing about them", () => {
    const hits = [hit("Areas/Health/sleep.md"), hit(".metistry/compute.yaml"), hit("Areas/Finance/tax.md"), hit("CLAUDE.md")];
    expect(filterHits(hits, { areas: ["Areas/Health"] }).map((h) => h.path)).toEqual(["Areas/Health/sleep.md"]);
    // The owner's scope still loses the two that are not knowledge.
    expect(filterHits(hits, OWNER_SCOPE).map((h) => h.path)).toEqual(["Areas/Health/sleep.md", "Areas/Finance/tax.md"]);
  });

  it("leaves no trace of the count it removed in the hit list itself", () => {
    const out = filterHits([hit(".metistry/state/.env")], OWNER_SCOPE);
    expect(out).toEqual([]);
    expect(JSON.stringify(out)).not.toContain("metistry");
  });
});

// `GET /api/knowledge/pages` runs a named query and hands its rows back
// unprojected — an instance may overlay `knowledge_pages.yaml` with columns
// of its own (D4), and a projection here would swallow them. So the ONE
// thing the list insists on is a `path` whose scope it can decide.
describe("filterPages: the same drop, over a named query's rows", () => {
  const row = (path: unknown, extra: Record<string, unknown> = {}) => ({ path, area: "Areas/Health", title: "t", ...extra });

  it("keeps a row's every column and drops the rows the scope does not cover", () => {
    const rows = [row("Areas/Health/sleep.md", { modified: "2026-09-18T00:00:00Z", instance_column: 7 }), row("Areas/Finance/tax.md"), row("now.md")];
    expect(filterPages(rows, { areas: ["Areas/Health"] })).toEqual([
      { path: "Areas/Health/sleep.md", area: "Areas/Health", title: "t", modified: "2026-09-18T00:00:00Z", instance_column: 7 },
    ]);
    expect(filterPages(rows, OWNER_SCOPE).map((r) => r.path)).toEqual(["Areas/Health/sleep.md", "Areas/Finance/tax.md", "now.md"]);
  });

  // The indexer's walk would never write these rows — but a row predating a
  // narrowing, or an overlay query with a looser WHERE, could. The list is
  // not the query's word for what is knowledge; `canSee` is.
  it("drops an indexed row that is not vault CONTENT, for the owner too", () => {
    const rows = [row(".metistry/state/.env"), row("Artifacts/report.pdf"), row("CLAUDE.md"), row("Knowledge/Areas/legacy.md"), row("Areas/Health/sleep.md")];
    expect(filterPages(rows, OWNER_SCOPE).map((r) => r.path)).toEqual(["Knowledge/Areas/legacy.md", "Areas/Health/sleep.md"]);
    expect(JSON.stringify(filterPages([row(".metistry/state/.env")], OWNER_SCOPE))).not.toContain("metistry");
  });

  it("drops a row whose path it cannot judge, rather than passing it — fails closed", () => {
    for (const bad of [undefined, null, 42, { toString: () => "Areas/Health/sleep.md" }, ["Areas/Health/sleep.md"]]) {
      expect(filterPages([row(bad)], OWNER_SCOPE), JSON.stringify(bad)).toEqual([]);
    }
    expect(filterPages([{ area: "Areas/Health" }], OWNER_SCOPE)).toEqual([]); // a query that forgot `path` returns nothing, never everything
  });
});

describe("vaultBridgeSearch: the bridge client", () => {
  it("passes q, limit and an explicit mode, and omits mode when the caller did not choose one", async () => {
    const calls: string[] = [];
    const fetchFn = vi.fn(async (url: string | URL) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ q: "sleep", mode: "keyword", hits: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const search = vaultBridgeSearch({ url: "http://127.0.0.1:7811/", token: "t", fetch: fetchFn });

    await search("sleep", "semantic", 5);
    expect(calls[0]).toBe("http://127.0.0.1:7811/vault/search?q=sleep&limit=5&mode=semantic");
    await search("sleep", null, 20);
    expect(calls[1]).toBe("http://127.0.0.1:7811/vault/search?q=sleep&limit=20"); // "choose for me" at the bridge
  });

  it("maps the bridge's envelope onto a VaultError rather than throwing a bare status", async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ error: { code: "not_available", message: "no embedder configured" } }), { status: 503 })) as unknown as typeof fetch;
    const search = vaultBridgeSearch({ url: "http://127.0.0.1:7811", token: "t", fetch: fetchFn });
    await expect(search("x", "hybrid", 5)).rejects.toBeInstanceOf(VaultError);
  });
});

// ---------------------------------------------------------------------------
// The scope the routes are HANDED. Everything above tests the filter; this
// tests what gets put into it, which is the half that decides whether the
// filter is doing anything at all.

describe("grantedScope: an agent's grants, as a vault scope", () => {
  it("is the granted areas, and only for the tier that may read content", () => {
    expect(grantedScope({ grants: { tier: "areas", areas: ["Areas/Health", "Journal"] } })).toEqual({ areas: ["Areas/Health", "Journal"] });
    // Tiers below `areas` may browse TITLES on the MCP mount; that is not a
    // licence to read pages, and `null` here would be the owner's own scope.
    // `mcp-brain`'s canRead says the same: `tier === "areas" && underAreas(…)`.
    expect(grantedScope({ grants: { tier: "index", areas: ["Areas/Health"] } })).toEqual({ areas: [] });
    expect(grantedScope({ grants: { tier: "none", areas: [] } })).toEqual({ areas: [] });
    for (const tier of ["index", "none"]) {
      expect(grantedScope({ grants: { tier, areas: ["Areas/Health"] } }).areas, tier).not.toBeNull();
      expect(canSee("Areas/Health/sleep.md", grantedScope({ grants: { tier, areas: ["Areas/Health"] } })), tier).toBe(false);
    }
  });

  it("gives the bare vault grant the whole vault, without a case of its own", () => {
    const scope = grantedScope({ grants: { tier: "areas", areas: ["/"] } }); // internal principals only (agents.ts)
    expect(canSee("now.md", scope)).toBe(true);
    expect(canSee("Areas/Finance/tax.md", scope)).toBe(true);
    expect(canSee(".metistry/compute.yaml", scope)).toBe(false); // still not knowledge, for anyone
  });

  it("narrows exactly like the filter it feeds — the sibling prefix is not granted", () => {
    const scope = grantedScope({ grants: { tier: "areas", areas: ["Areas/Health"] } });
    expect(canSee("Areas/Health/sleep.md", scope)).toBe(true);
    expect(canSee("Areas/Healthcare/billing.md", scope)).toBe(false);
    expect(canSee("Journal/2026-09-18.md", scope)).toBe(false);
  });

  // A grants row can be rewritten while a request is in flight (PUT
  // /api/agents/:id/grants). A scope already handed to a route must not widen
  // under it, so the areas are copied rather than aliased.
  it("copies the areas instead of aliasing the grant", () => {
    const grants = { tier: "areas", areas: ["Areas/Health"] };
    const scope = grantedScope({ grants });
    grants.areas.push("Areas/Finance");
    expect(canSee("Areas/Finance/tax.md", scope)).toBe(false);
  });

  it("NO_SCOPE sees nothing and OWNER_SCOPE is the whole vault", () => {
    expect(canSee("Areas/Health/sleep.md", NO_SCOPE)).toBe(false);
    expect(canSee("now.md", NO_SCOPE)).toBe(false);
    expect(canSee("now.md", OWNER_SCOPE)).toBe(true);
  });
});

/** A real ServerResponse over a detached socket — the same harness refusals.test.ts uses, and it exercises the actual writeHead/end path. */
function capture(): { res: ServerResponse; read: () => { status: number; body: any } } {
  const req = new IncomingMessage(new Socket());
  const res = new ServerResponse(req);
  const chunks: Buffer[] = [];
  (res as unknown as { _send: unknown })._send = () => true;
  res.write = ((c: string | Buffer) => {
    chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)));
    return true;
  }) as ServerResponse["write"];
  res.end = ((c?: string | Buffer) => {
    if (c) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)));
    return res;
  }) as ServerResponse["end"];
  return { res, read: () => ({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }) };
}

/**
 * `GET /api/knowledge/pages` over the REAL `knowledge_pages.yaml` manifest —
 * the store, its params and its `expose` are the shipped ones — with a fake
 * executor standing in for the cluster. What is under test is the route's
 * own filter over whatever the index holds, which no database is needed to
 * decide.
 */
async function pagesRoute(scope: KnowledgeScope, rows: Record<string, unknown>[], qs = ""): Promise<{ status: number; body: any; params: unknown[] }> {
  const params: unknown[][] = [];
  const store = new QueryStore({
    async query(_text, values) {
      params.push(values);
      return { rows };
    },
  });
  store.load(await readFile(new URL("../../../seed/queries/knowledge_pages.yaml", import.meta.url), "utf8"));
  const c = capture();
  const url = new URL(`http://x/api/knowledge/pages${qs}`);
  await knowledgeRoutes(new IncomingMessage(new Socket()), c.res, "GET /api/knowledge/pages", url, { queries: store }, scope, async () => {});
  return { ...c.read(), params: params[0] ?? [] };
}

describe("the page list is scoped to the principal that asked for it", () => {
  const INDEX = [
    { path: "Areas/Health/sleep.md", area: "Areas/Health", title: "Sleep" },
    { path: "Areas/Healthcare/billing.md", area: "Areas/Healthcare", title: "Billing" },
    { path: "Areas/Finance/tax.md", area: "Areas/Finance", title: "Tax" },
    { path: "Journal/2026-09-18.md", area: "Journal", title: "Thursday" },
    { path: "now.md", area: null, title: "now" },
    { path: ".metistry/compute.yaml", area: null, title: "machinery" },
  ];

  it("gives the owner their whole vault, and still not the machinery in it", async () => {
    const r = await pagesRoute(OWNER_SCOPE, INDEX);
    expect(r.status).toBe(200);
    expect(r.body.pages.map((p: any) => p.path)).toEqual([
      "Areas/Health/sleep.md",
      "Areas/Healthcare/billing.md",
      "Areas/Finance/tax.md",
      "Journal/2026-09-18.md",
      "now.md",
    ]);
  });

  // The real exercise of the grant path: an agent-shaped principal, handed
  // straight to the route. No console credential reaches here today (an agent
  // bearer is the uniform 403 — CRIT-7), which is exactly why the narrowing
  // has to be held by a test rather than by the call site being lucky.
  it("gives a principal with grants only its own areas — the same rows, one filter apart", async () => {
    const r = await pagesRoute(grantedScope({ grants: { tier: "areas", areas: ["Areas/Health"] } }), INDEX);
    expect(r.status).toBe(200);
    expect(r.body.pages.map((p: any) => p.path)).toEqual(["Areas/Health/sleep.md"]);
    // Nothing about what was withheld travels with the answer: no total, no
    // count of drops, and not one of the other paths anywhere in the body.
    const text = JSON.stringify(r.body);
    for (const gone of ["Healthcare", "Finance", "Journal", "now.md", "metistry"]) expect(text, gone).not.toContain(gone);
    expect(r.body).not.toHaveProperty("total");
  });

  it("gives a credential with neither the vault nor grants nothing at all", async () => {
    const r = await pagesRoute(NO_SCOPE, INDEX);
    expect(r.status).toBe(200);
    expect(r.body.pages).toEqual([]);
  });

  // A narrowed principal's filter argument is not refused by name — that
  // would say which prefixes exist — so it travels to the query as written,
  // and whatever comes back is scoped anyway. The executor here returns every
  // row whatever the binds say (the real SQL is what applies them), which is
  // the point: the scope is not a restatement of the filter, so a query that
  // ignored one — an overlay with a looser WHERE (D4) — still leaks nothing.
  it("passes the caller's filters to the query and scopes every row it gets back regardless", async () => {
    const r = await pagesRoute(grantedScope({ grants: { tier: "areas", areas: ["Areas/Health"] } }), INDEX, "?prefix=Areas/Finance&limit=5&offset=2");
    expect(r.status).toBe(200);
    expect(r.params).toEqual(["", "Areas/Finance", 5, 2]);
    expect(r.body.pages.map((p: any) => p.path)).toEqual(["Areas/Health/sleep.md"]);
    expect(JSON.stringify(r.body.pages)).not.toContain("Finance");
    expect(r.body).toMatchObject({ prefix: "Areas/Finance", area: null, limit: 5, offset: 2 });
  });
});

/**
 * `GET /api/knowledge/links` over the REAL `knowledge_page_links.yaml`, with
 * a fake executor for the cluster — the same harness as the page list above,
 * because the two routes filter through the same predicate and a test that
 * proved it for one would say nothing about the other.
 */
async function linksRoute(scope: KnowledgeScope, rows: Record<string, unknown>[], qs = ""): Promise<{ status: number; body: any; params: unknown[] }> {
  const params: unknown[][] = [];
  const store = new QueryStore({
    async query(_text, values) {
      params.push(values);
      return { rows };
    },
  });
  store.load(await readFile(new URL("../../../seed/queries/knowledge_page_links.yaml", import.meta.url), "utf8"));
  const c = capture();
  const url = new URL(`http://x/api/knowledge/links${qs}`);
  await knowledgeRoutes(new IncomingMessage(new Socket()), c.res, "GET /api/knowledge/links", url, { queries: store }, scope, async () => {});
  return { ...c.read(), params: params[0] ?? [] };
}

describe("the link list scopes BOTH ends of every edge", () => {
  const EDGES = [
    { direction: "outgoing", path: "Areas/Health/taper.md", kind: "wikilink", resolved: true },
    { direction: "outgoing", path: "Areas/Finance/tax.md", kind: "wikilink", resolved: true },
    { direction: "outgoing", path: "Areas/Health/nowhere.md", kind: "wikilink", resolved: false },
    { direction: "incoming", path: "Journal/2026-09-18.md", kind: "wikilink", resolved: true },
    { direction: "incoming", path: ".metistry/compute.yaml", kind: "frontmatter", resolved: true },
  ];

  it("gives the owner every edge that is knowledge, and not the one that is not", async () => {
    const r = await linksRoute(OWNER_SCOPE, EDGES, "?path=Areas/Health/sleep.md");
    expect(r.status).toBe(200);
    expect(r.params).toEqual(["Areas/Health/sleep.md", 100, 0]);
    expect(r.body.links.map((l: any) => l.path)).toEqual([
      "Areas/Health/taper.md",
      "Areas/Finance/tax.md",
      "Areas/Health/nowhere.md",
      "Journal/2026-09-18.md",
    ]);
    // Rows are unprojected: `direction`, `kind` and `resolved` reach the
    // client as the query wrote them, an overlay's own columns included.
    expect(r.body.links[2]).toEqual({ direction: "outgoing", path: "Areas/Health/nowhere.md", kind: "wikilink", resolved: false });
    expect(r.body).toMatchObject({ path: "Areas/Health/sleep.md", limit: 100, offset: 0, as_of: expect.any(String) });
    expect(r.body).not.toHaveProperty("total");
    expect(JSON.stringify(r.body)).not.toContain("metistry/"); // indexed, still not knowledge — the owner's own list loses it too
  });

  // The second end is the one a naive implementation forgets: a page inside
  // the grant can link OUT of it, and a page outside it can link IN.
  it("drops an edge whose other end the scope does not cover, in either direction", async () => {
    const r = await linksRoute(grantedScope({ grants: { tier: "areas", areas: ["Areas/Health"] } }), EDGES, "?path=Areas/Health/sleep.md");
    expect(r.status).toBe(200);
    expect(r.body.links.map((l: any) => l.path)).toEqual(["Areas/Health/taper.md", "Areas/Health/nowhere.md"]);
    const text = JSON.stringify(r.body);
    for (const gone of ["Finance", "Journal", "metistry"]) expect(text, gone).not.toContain(gone);
  });

  // The first end. A path the caller may not see must not be answerable for
  // at all — "this page has four backlinks" is a fact about a page.
  it("answers 404 for a page the scope does not cover, in the words a missing page gets", async () => {
    const outside = await linksRoute(grantedScope({ grants: { tier: "areas", areas: ["Areas/Health"] } }), EDGES, "?path=Areas/Finance/tax.md");
    const machinery = await linksRoute(OWNER_SCOPE, EDGES, "?path=.metistry/compute.yaml");
    for (const r of [outside, machinery]) {
      expect(r.status).toBe(404);
      expect(r.body.error.code).toBe("not_found");
      expect(r.body.error.message).toContain("no such page");
      expect(r.params).toEqual([]); // and the query never ran: a refusal costs the cluster nothing
    }
    // The same answer the page route gives, so the two cannot be compared to
    // tell "refused" from "absent".
    expect(outside.body).toEqual(machinery.body);
  });

  it("requires the path by name, and refuses a limit or offset out of range by name", async () => {
    const missing = await linksRoute(OWNER_SCOPE, EDGES);
    expect(missing.status).toBe(400);
    expect(missing.body.error.message).toContain("path is required");
    for (const [qs, needle] of [
      ["?path=Areas/Health/sleep.md&limit=0", "between 1 and 500"],
      ["?path=Areas/Health/sleep.md&limit=501", "between 1 and 500"],
      ["?path=Areas/Health/sleep.md&offset=-1", "non-negative integer"],
    ] as const) {
      const r = await linksRoute(OWNER_SCOPE, EDGES, qs);
      expect(r.status, qs).toBe(400);
      expect(r.body.error.message, qs).toContain(needle);
    }
  });

  it("says which file is missing when the named query is not loaded, rather than 500ing", async () => {
    const c = capture();
    const url = new URL("http://x/api/knowledge/links?path=Areas/Health/sleep.md");
    await knowledgeRoutes(new IncomingMessage(new Socket()), c.res, "GET /api/knowledge/links", url, {}, OWNER_SCOPE, async () => {});
    const r = c.read();
    expect(r.status).toBe(503);
    expect(r.body.error.message).toContain("knowledge_page_links.yaml");
  });
});
