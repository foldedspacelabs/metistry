// The access rules, on their own — a misuse test before it is a feature test
// (invariant 8). Moved here verbatim from `apps/console/test/
// knowledge-routes.test.ts` by P0 of docs/research/
// 2026-09-19-grants-and-access-simplified.md §4: the rules moved to `core`, so
// the cases that hold them did too. Every assertion is unchanged.
//
// The thing being held here is not obvious from the routes that call it: the
// reconciler's `GET /vault/read` does NOT gate on `isVaultPath`. It confines a
// path to the instance repo and stops, because `metistry update` and
// `metistry compute` write `.metistry/metistry.lock` and
// `.metistry/compute.yaml` through the same bridge and a read gate would break
// the write path. So `.metistry/`, `Artifacts/` and the root `CLAUDE.md` are
// reachable over that bridge with the console's own bearer, and it is THIS
// predicate that makes them unreachable over `/api/knowledge/page` and over
// `/mcp`'s knowledge tools.
import { describe, expect, it } from "vitest";
import { NO_SCOPE, OWNER_SCOPE, canSee, filterHits, filterPages, grantedScope } from "../src/index.js";

/** The console's search hit, structurally — `filterHits` is generic over anything carrying a `path`. */
interface Hit {
  path: string;
  title: string;
  description: string | null;
  snippet: string;
  score: number;
  source: "keyword" | "semantic" | "both";
}

const hit = (path: string): Hit => ({ path, title: path, description: null, snippet: "…", score: 1, source: "keyword" });

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
