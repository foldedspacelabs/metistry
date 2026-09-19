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
import { describe, expect, it, vi } from "vitest";
import { VaultError } from "@foldedspacelabs/metistry-artifacts";
import { OWNER_SCOPE, canSee, filterHits, filterPages, vaultBridgeSearch, type KnowledgeSearchHit } from "../src/knowledge-routes.js";

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
