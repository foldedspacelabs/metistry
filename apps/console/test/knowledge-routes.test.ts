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
import * as core from "@foldedspacelabs/metistry-core";
import {
  NO_SCOPE,
  OWNER_SCOPE,
  canSee,
  filterHits,
  filterPages,
  grantedScope,
  knowledgeRoutes,
  vaultBridgeSearch,
  type KnowledgeSearchHit,
} from "../src/knowledge-routes.js";
import type { Principal } from "@foldedspacelabs/metistry-core";

// The routes take the PRINCIPAL since P4 of
// docs/research/2026-09-19-grants-and-access-simplified.md §4 — not a scope.
// The reason is the whole of that phase: what the owner gets on a path this
// door does not serve is not a narrower scope, it is a CLASSIFICATION, and a
// scope cannot say which credential it came from.
const OWNER: Principal = { id: "owner", role: "owner", scope: { tier: "areas", areas: null, queries: true, projects: null }, source: "registry" };
const NOBODY: Principal = { id: "owner_token", role: "tool", scope: { tier: "none", areas: [], queries: false, projects: [] }, source: "registry" };
const granted = (areas: string[]): Principal => ({ id: "scout", role: "agent", scope: { tier: "areas", areas, queries: false, projects: [] }, source: "registry" });

const hit = (path: string): KnowledgeSearchHit => ({ path, title: path, description: null, snippet: "…", score: 1, source: "keyword" });

// **The scope rules themselves are `core`'s** since P0 of
// docs/research/2026-09-19-grants-and-access-simplified.md §4, and so are
// their ~20 cases: `packages/core/test/access.test.ts` holds them, assertions
// unchanged. What is left here is the half that is this file's — that the
// routes call THAT predicate and not one of their own, and that the answers
// reach the wire in the shape the clients read.
describe("the routes decide with core's predicate, not one of their own", () => {
  it("re-exports the identical function objects — not a copy that agrees today", () => {
    expect(canSee).toBe(core.canSee);
    expect(filterHits).toBe(core.filterHits);
    expect(filterPages).toBe(core.filterPages);
    expect(grantedScope).toBe(core.grantedScope);
    expect(OWNER_SCOPE).toBe(core.OWNER_SCOPE);
    expect(NO_SCOPE).toBe(core.NO_SCOPE);
  });

  // One case per surface, as a tripwire: if a route ever grew a filter of its
  // own, the routes below would still pass and this would not.
  it("filters what a route returns by exactly what core would admit", () => {
    const scope = { areas: ["Areas/Health"] };
    const paths = ["Areas/Health/sleep.md", "Areas/Finance/tax.md", ".metistry/compute.yaml", "CLAUDE.md"];
    expect(filterHits(paths.map(hit), scope).map((h) => h.path)).toEqual(paths.filter((p) => core.canSee(p, scope)));
    expect(filterPages(paths.map((path) => ({ path })), scope).map((r) => r.path)).toEqual(paths.filter((p) => core.canSee(p, scope)));
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
async function pagesRoute(principal: Principal, rows: Record<string, unknown>[], qs = ""): Promise<{ status: number; body: any; params: unknown[] }> {
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
  await knowledgeRoutes(new IncomingMessage(new Socket()), c.res, "GET /api/knowledge/pages", url, { queries: store }, principal, async () => {});
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
    const r = await pagesRoute(OWNER, INDEX);
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
    const r = await pagesRoute(granted(["Areas/Health"]), INDEX);
    expect(r.status).toBe(200);
    expect(r.body.pages.map((p: any) => p.path)).toEqual(["Areas/Health/sleep.md"]);
    // Nothing about what was withheld travels with the answer: no total, no
    // count of drops, and not one of the other paths anywhere in the body.
    const text = JSON.stringify(r.body);
    for (const gone of ["Healthcare", "Finance", "Journal", "now.md", "metistry"]) expect(text, gone).not.toContain(gone);
    expect(r.body).not.toHaveProperty("total");
  });

  it("gives a credential with neither the vault nor grants nothing at all", async () => {
    const r = await pagesRoute(NOBODY, INDEX);
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
    const r = await pagesRoute(granted(["Areas/Health"]), INDEX, "?prefix=Areas/Finance&limit=5&offset=2");
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
async function linksRoute(principal: Principal, rows: Record<string, unknown>[], qs = ""): Promise<{ status: number; body: any; params: unknown[] }> {
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
  await knowledgeRoutes(new IncomingMessage(new Socket()), c.res, "GET /api/knowledge/links", url, { queries: store }, principal, async () => {});
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
    const r = await linksRoute(OWNER, EDGES, "?path=Areas/Health/sleep.md");
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
    const r = await linksRoute(granted(["Areas/Health"]), EDGES, "?path=Areas/Health/sleep.md");
    expect(r.status).toBe(200);
    expect(r.body.links.map((l: any) => l.path)).toEqual(["Areas/Health/taper.md", "Areas/Health/nowhere.md"]);
    const text = JSON.stringify(r.body);
    for (const gone of ["Finance", "Journal", "metistry"]) expect(text, gone).not.toContain(gone);
  });

  // The first end. A path the caller may not see must not be answerable for
  // at all — "this page has four backlinks" is a fact about a page.
  it("answers 404 for a page the scope does not cover, in the words a missing page gets", async () => {
    const outside = await linksRoute(granted(["Areas/Health"]), EDGES, "?path=Areas/Finance/tax.md");
    const machinery = await linksRoute(granted(["Areas/Health"]), EDGES, "?path=.metistry/compute.yaml");
    for (const r of [outside, machinery]) {
      expect(r.status).toBe(404);
      expect(r.body.error.code).toBe("not_found");
      expect(r.body.error.message).toContain("no such page");
      expect(r.params).toEqual([]); // and the query never ran: a refusal costs the cluster nothing
    }
    // The same answer, so the two cannot be compared to tell "refused" from
    // "absent" — and neither is the OWNER's answer, which classifies the
    // machinery and names where it lives instead (P4, below).
    expect(outside.body).toEqual(machinery.body);
    expect((await linksRoute(OWNER, EDGES, "?path=.metistry/compute.yaml")).body).not.toEqual(machinery.body);
  });

  it("requires the path by name, and refuses a limit or offset out of range by name", async () => {
    const missing = await linksRoute(OWNER, EDGES);
    expect(missing.status).toBe(400);
    expect(missing.body.error.message).toContain("path is required");
    for (const [qs, needle] of [
      ["?path=Areas/Health/sleep.md&limit=0", "between 1 and 500"],
      ["?path=Areas/Health/sleep.md&limit=501", "between 1 and 500"],
      ["?path=Areas/Health/sleep.md&offset=-1", "non-negative integer"],
    ] as const) {
      const r = await linksRoute(OWNER, EDGES, qs);
      expect(r.status, qs).toBe(400);
      expect(r.body.error.message, qs).toContain(needle);
    }
  });

  it("says which file is missing when the named query is not loaded, rather than 500ing", async () => {
    const c = capture();
    const url = new URL("http://x/api/knowledge/links?path=Areas/Health/sleep.md");
    await knowledgeRoutes(new IncomingMessage(new Socket()), c.res, "GET /api/knowledge/links", url, {}, OWNER, async () => {});
    const r = c.read();
    expect(r.status).toBe(503);
    expect(r.body.error.message).toContain("knowledge_page_links.yaml");
  });
});

/**
 * The owner's three reads (T1-6) over their REAL manifests, with a fake
 * executor that records every statement it was handed — so "refused" can be
 * asserted as "and no SQL ran", not only as a status code.
 */
async function ownerRoute(file: string, route: string, principal: Principal, rows: Record<string, unknown>[], qs = "", audits: unknown[][] = []): Promise<{ status: number; body: any; params: unknown[]; ran: number }> {
  const params: unknown[][] = [];
  const store = new QueryStore({
    async query(_text, values) {
      params.push(values);
      return { rows };
    },
  });
  store.load(await readFile(new URL(`../../../seed/queries/${file}.yaml`, import.meta.url), "utf8"));
  const c = capture();
  const url = new URL(`http://x${route.slice("GET ".length)}${qs}`);
  await knowledgeRoutes(new IncomingMessage(new Socket()), c.res, route, url, { queries: store }, principal, async (...a) => {
    audits.push(a);
  });
  return { ...c.read(), params: params[0] ?? [], ran: params.length };
}

const OWNER_READS = [
  ["knowledge_fold_latest", "GET /api/knowledge/fold"],
  ["knowledge_drafts", "GET /api/knowledge/drafts"],
  ["knowledge_areas", "GET /api/knowledge/areas"],
] as const;

describe("the fold, the drafts and the areas are the owner's alone", () => {
  // Every principal that is not the owner, at its WIDEST: an agent granted
  // the whole vault with `queries: true`, the assistant itself, a crew
  // member, and the capture token. None of them is the owner, so none of
  // them is handed a draft, whatever server.ts's gate did first.
  const wide = (role: Principal["role"], id: string): Principal => ({ id, role, scope: { tier: "areas", areas: null, queries: true, projects: null }, source: "registry" });
  const OTHERS: Principal[] = [granted(["Areas/Health"]), wide("agent", "everything"), wide("assistant", "assistant"), wide("crew", "crew"), NOBODY];

  it("refuses every other principal the console's uniform 403, and runs no SQL", async () => {
    for (const [file, route] of OWNER_READS) {
      for (const p of OTHERS) {
        const audits: unknown[][] = [];
        const r = await ownerRoute(file, route, p, [{ path: "Areas/Health/secret.md" }], "", audits);
        expect(r.status, `${route} ${p.id}`).toBe(403);
        expect(r.body, `${route} ${p.id}`).toEqual({ error: { code: "forbidden", message: "not granted" } });
        expect(r.ran, `${route} ${p.id}`).toBe(0);
        expect(audits[0]?.[2], `${route} ${p.id}`).toBe(false); // the refusal is audited
      }
    }
  });

  it("answers 503 naming the file when its named query is not loaded", async () => {
    for (const [file, route] of OWNER_READS) {
      const c = capture();
      await knowledgeRoutes(new IncomingMessage(new Socket()), c.res, route, new URL(`http://x${route.slice(4)}`), {}, OWNER, async () => {});
      const r = c.read();
      expect(r.status, route).toBe(503);
      expect(r.body.error.message, route).toContain(`${file}.yaml`);
    }
  });
});

describe("GET /api/knowledge/fold", () => {
  const FOLD = { path: "Journal/Fold/2026-09-28.md", date: "2026-09-28", title: "Fold — 28 September", modified: "2026-09-28T01:00:00.000Z" };
  const ROWS = [
    { ...FOLD, link_path: "Areas/Health/nowhere.md", link_kind: "wikilink", link_title: "nowhere", link_resolved: false },
    { ...FOLD, link_path: "Me/profile.md", link_kind: "wikilink", link_title: "profile", link_resolved: true },
    { ...FOLD, link_path: ".metistry/compute.yaml", link_kind: "wikilink", link_title: "compute", link_resolved: true },
  ];

  it("folds the rows into one fold and its links — Me/ included for the owner, the machinery never", async () => {
    const r = await ownerRoute("knowledge_fold_latest", "GET /api/knowledge/fold", OWNER, ROWS, "?date=2026-09-28");
    expect(r.status).toBe(200);
    expect(r.params).toEqual(["2026-09-28"]);
    expect(r.body.fold).toEqual({
      ...FOLD,
      links: [
        { path: "Areas/Health/nowhere.md", title: "nowhere", kind: "wikilink", resolved: false },
        { path: "Me/profile.md", title: "profile", kind: "wikilink", resolved: true },
      ],
    });
    expect(r.body).toMatchObject({ date: "2026-09-28", as_of: expect.any(String) });
    expect(JSON.stringify(r.body)).not.toContain("metistry/");
  });

  it("is `fold: null` before the first fold, and an empty link list for a fold that names nothing", async () => {
    const none = await ownerRoute("knowledge_fold_latest", "GET /api/knowledge/fold", OWNER, []);
    expect(none.status).toBe(200);
    expect(none.body).toMatchObject({ fold: null, date: null });
    expect(none.params).toEqual([""]); // blank = the newest there is
    const bare = await ownerRoute("knowledge_fold_latest", "GET /api/knowledge/fold", OWNER, [{ ...FOLD, link_path: null, link_kind: null, link_title: null, link_resolved: null }]);
    expect(bare.body.fold).toEqual({ ...FOLD, links: [] });
  });

  it("refuses a date that is not a calendar day, by name, before any SQL runs", async () => {
    for (const qs of ["?date=yesterday", "?date=2026-02-30", "?date=2026-9-28", "?date=2026-09-28T00:00:00Z", "?date=%27%20OR%201=1"]) {
      const r = await ownerRoute("knowledge_fold_latest", "GET /api/knowledge/fold", OWNER, ROWS, qs);
      expect(r.status, qs).toBe(400);
      expect(r.body.error.message, qs).toContain("YYYY-MM-DD");
      expect(r.ran, qs).toBe(0);
    }
  });
});

describe("GET /api/knowledge/drafts", () => {
  const DRAFTS = [
    { path: "Areas/Health/sleep.md", area: "Areas/Health", title: "Sleep", description: "the taper", modified: "2026-09-27T20:00:00.000Z" },
    { path: "Me/profile.md", area: "Me", title: "profile", description: null, modified: "2026-09-27T20:00:00.000Z" },
    { path: ".metistry/rules.yaml", area: ".metistry", title: "rules", description: null, modified: null },
  ];

  it("hands the owner every draft that is knowledge, paged, with no total", async () => {
    const r = await ownerRoute("knowledge_drafts", "GET /api/knowledge/drafts", OWNER, DRAFTS, "?limit=20&offset=0");
    expect(r.status).toBe(200);
    expect(r.params).toEqual([20, 0]);
    expect(r.body.drafts.map((d: any) => d.path)).toEqual(["Areas/Health/sleep.md", "Me/profile.md"]);
    expect(r.body).toMatchObject({ limit: 20, offset: 0, as_of: expect.any(String) });
    expect(r.body).not.toHaveProperty("total");
  });

  it("refuses a limit or offset out of range by name", async () => {
    for (const [qs, needle] of [
      ["?limit=0", "between 1 and 500"],
      ["?limit=501", "between 1 and 500"],
      ["?offset=-1", "non-negative integer"],
    ] as const) {
      const r = await ownerRoute("knowledge_drafts", "GET /api/knowledge/drafts", OWNER, DRAFTS, qs);
      expect(r.status, qs).toBe(400);
      expect(r.body.error.message, qs).toContain(needle);
    }
  });
});

describe("GET /api/knowledge/areas", () => {
  it("lists the areas that are knowledge, and drops a folder that is not — by core's predicate", async () => {
    const AREAS = [
      { area: ".metistry", description: null, pages: 3, last_change: null, named_by_fold: false },
      { area: "Areas/Health", description: "Sleep, labs, and the protein blend", pages: 4, last_change: "2026-09-27T20:00:00.000Z", named_by_fold: true },
      { area: "Artifacts", description: null, pages: 1, last_change: null, named_by_fold: false },
      { area: "Me", description: null, pages: 2, last_change: null, named_by_fold: false },
    ];
    const r = await ownerRoute("knowledge_areas", "GET /api/knowledge/areas", OWNER, AREAS);
    expect(r.status).toBe(200);
    expect(r.params).toEqual([]);
    expect(r.body.areas).toEqual([AREAS[1], AREAS[3]]);
    expect(r.body.as_of).toEqual(expect.any(String));
  });
});

// ---------------------------------------------------------------------------
// Ruled 2026-09-19 (D): "the owner should always have access to everything.
// Agents, however, should only have access to what they're granted. Dropping
// artifacts from the owner's access isn't right."
//
// P4 is where that stops being a special case for `Artifacts/` and becomes
// the rule: `may` refuses the owner NOTHING, and a path this door does not
// serve gets a CLASSIFICATION instead — what it is, and which door has it
// (`needs.door`). Not a 403, and not a 404 pretending it is not there: it is
// there, behind another door. The owner's artifacts are the ARTIFACTS door —
// the service, the versions, the raw-file route with its content types and
// `no-store` (decision #14) — and
// `apps/console/test/artifacts.integration.test.ts` reads one end to end
// over a real vault.
//
// An agent gets NONE of this: the one uniform sentence, the same 404, byte
// for byte, because for them refused and absent must stay indistinguishable.
describe("the owner is classified, never refused; an agent gets the uniform answer", () => {
  const pageRoute = async (principal: Principal, path: string): Promise<{ status: number; body: any }> => {
    const c = capture();
    const url = new URL(`http://x/api/knowledge/page?path=${encodeURIComponent(path)}`);
    await knowledgeRoutes(new IncomingMessage(new Socket()), c.res, "GET /api/knowledge/page", url, {}, principal, async () => {});
    return c.read();
  };

  it("tells the owner where their artifacts actually are, and names that door in `needs`", async () => {
    for (const path of ["Artifacts", "Artifacts/report.pdf", "Artifacts/fsl/site/index.html"]) {
      const r = await pageRoute(OWNER, path);
      // 400, not 404: the caller named a path this door does not serve. A
      // 404 would be this door claiming the file is not there, which it is.
      expect(r.status, path).toBe(400);
      expect(r.body, path).toMatchObject({
        error: { code: "invalid_request", message: expect.stringContaining("/api/artifacts") },
        reason: "not_knowledge",
        needs: { door: "GET /api/artifacts" },
      });
      expect(r.body.error.message, path).toContain("is an artifact, not knowledge");
      expect(r.body.error.message, path).not.toContain("no such page");
    }
  });

  it("says nothing of the kind to an agent — refused and absent stay the same answer", async () => {
    const agent = granted(["Areas/Health"]);
    const refused = await pageRoute(agent, "Artifacts/report.pdf");
    const absent = await pageRoute(agent, "Areas/Finance/tax.md");
    expect(refused.status).toBe(404);
    expect(refused.body).toEqual(absent.body); // byte for byte: no oracle
    expect(refused.body.error.message).toContain("no such page");
    expect(refused.body.error.message).not.toContain("/api/artifacts");
  });

  it("classifies the machinery for the owner too — and serves not one byte of it", async () => {
    // The `.env` is the case worth being explicit about: "the owner has
    // everything" does NOT make this door serve it. No door serves it as a
    // page; it is the file itself, 0600, on the machine that is theirs.
    for (const path of [".metistry/compute.yaml", ".metistry/state/.env", "CLAUDE.md"]) {
      const r = await pageRoute(OWNER, path);
      expect(r.status, path).toBe(400);
      expect(r.body, path).toMatchObject({ reason: "not_knowledge", needs: { door: "the file itself" } });
      expect(r.body.error.message, path).toContain("is machinery, not knowledge");
      expect(r.body.error.message, path).not.toContain("/api/artifacts");
      expect(JSON.stringify(r.body), path).not.toContain("content"); // no bytes, on any path
    }
    // A path that escapes the vault is `outside` before it is anything, so
    // the classification names no door — there is nothing to point at.
    const escaped = await pageRoute(OWNER, "../etc/passwd");
    expect(escaped.status).toBe(400);
    expect(escaped.body.needs ?? null).toBeNull();
    expect(escaped.body.error.message).toContain("is outside the vault");
  });

  it("gives an agent NOTHING P4 gave the owner — same code, same sentence, no reason, no needs", async () => {
    const agent = granted(["Areas/Health"]);
    for (const path of ["Artifacts/report.pdf", ".metistry/state/.env", "CLAUDE.md", "Areas/Finance/tax.md"]) {
      const r = await pageRoute(agent, path);
      expect(r.status, path).toBe(404);
      expect(r.body, path).toEqual({ error: { code: "not_found", message: expect.stringContaining("no such page") } });
      expect(Object.keys(r.body), path).toEqual(["error"]); // no reason, no needs: a hidden refusal says nothing about itself
    }
  });

  it("the link list answers the same way, so the two doors cannot drift", async () => {
    const owner = await linksRoute(OWNER, [], "?path=Artifacts/report.pdf");
    expect(owner.status).toBe(400);
    expect(owner.body.error.message).toContain("/api/artifacts");
    const agent = await linksRoute(granted(["Areas/Health"]), [], "?path=Artifacts/report.pdf");
    expect(agent.status).toBe(404);
    expect(agent.body.error.message).toContain("no such page");
  });

  // The scope decision itself is untouched by the 2026-09-19 validator split:
  // `Artifacts/` is not knowledge for ANY caller on this door, and the
  // sentence above is the only thing that differs between them.
  it("changes no decision: canSee still refuses Artifacts for every scope", () => {
    for (const scope of [OWNER_SCOPE, NO_SCOPE, grantedScope({ grants: { tier: "areas", areas: ["Artifacts"] } })]) {
      expect(canSee("Artifacts/report.pdf", scope)).toBe(false);
    }
  });
});
