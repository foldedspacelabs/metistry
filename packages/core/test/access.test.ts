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
import {
  NO_SCOPE,
  OWNER_SCOPE,
  RESOURCE_CLASSES,
  canSee,
  classify,
  describeScope,
  filterHits,
  filterPages,
  formatRefusal,
  grantedScope,
  isVaultPath,
  underAreas,
  may,
  type Principal,
} from "../src/index.js";

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

  it("keeps a recording's transcript out of every default grant: `Journal` does not reach Journal/Transcripts/, the folder's own grant or the whole vault does (T8-4)", () => {
    const t = "Journal/Transcripts/2026-09-28-20260928-120000-00ab.md";
    const journal = grantedScope({ grants: { tier: "areas", areas: ["Journal"] } });
    expect(canSee("Journal/2026-09-28.md", journal)).toBe(true);
    expect(canSee(t, journal)).toBe(false);
    expect(canSee(t, grantedScope({ grants: { tier: "areas", areas: ["Journal/"] } }))).toBe(false);
    expect(canSee(t, grantedScope({ grants: { tier: "areas", areas: ["Journal/Transcripts"] } }))).toBe(true);
    expect(canSee(t, grantedScope({ grants: { tier: "areas", areas: ["Journal/Transcripts/"] } }))).toBe(true);
    expect(canSee(t, grantedScope({ grants: { tier: "areas", areas: ["/"] } }))).toBe(true); // the owner's own assistant
    expect(canSee(t, OWNER_SCOPE)).toBe(true);
    // a sibling that only shares the prefix is an ordinary Journal path
    expect(canSee("Journal/TranscriptsOld/x.md", journal)).toBe(true);
    expect(underAreas(t, ["Journal"])).toBe(false);
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

// ===========================================================================
// classify() · describeScope() · formatRefusal() — P3/P4
// ===========================================================================

describe("classify: what a path IS, which is not what anybody may do with it", () => {
  it("agrees with isVaultPath exactly, for every shape the vault has", () => {
    const paths = [
      "Areas/Health/sleep.md",
      "now.md",
      "Journal/2026-09-20.md",
      "Inbox/note.md",
      "Inbox/.large/blob.bin",
      "Artifacts",
      "Artifacts/report.pdf",
      ".metistry/compute.yaml",
      ".metistry/state/.env",
      ".obsidian/workspace.json",
      ".git/config",
      "CLAUDE.md",
      "README.md",
      "identity.yaml",
      "state/.env",
      "Areas/../../etc/passwd",
      "/etc/passwd",
      "Areas//double.md",
      "",
    ];
    // The property P4 rests on: the indexer's rule did not change, it was
    // given a name. A `classify` that drifted from `isVaultPath` would index
    // something the knowledge door refuses, or refuse something it indexes.
    for (const p of paths) expect([p, classify(p) === "knowledge"], p).toEqual([p, isVaultPath(p)]);
  });

  it("names the other three, so a refusal can point at the door that has it", () => {
    expect(classify("Artifacts/report.pdf")).toBe("artifact");
    expect(classify("Artifacts")).toBe("artifact");
    expect(classify(".metistry/state/.env")).toBe("machinery");
    expect(classify(".obsidian/workspace.json")).toBe("machinery");
    expect(classify("CLAUDE.md")).toBe("machinery");
    expect(classify("Areas/../../etc/passwd")).toBe("outside");
    expect(classify("/etc/passwd")).toBe("outside");
    expect(classify("")).toBe("outside");
    expect(RESOURCE_CLASSES).toEqual(["knowledge", "artifact", "machinery", "outside"]);
  });

  it("calls an escaping path `outside` before it calls it an artifact", () => {
    // Traversal wins over the prefix: a path that leaves the vault is
    // malformed before it is anything, and an `artifact` answer would put a
    // door's name on it.
    expect(classify("Artifacts/../.metistry/state/.env")).toBe("outside");
  });
});

describe("describeScope: one structure, one triple, every surface", () => {
  const agent: Principal = {
    id: "scout",
    role: "agent",
    scope: { tier: "areas", areas: ["Areas/Health", "Journal"], queries: true, projects: ["alpha"], autonomy: { level: "propose" } },
    source: "registry",
  };

  // A SNAPSHOT, deliberately: the whole point of P3 is that the CLI, the
  // console panel and the Needs You card say the same words, and the way a
  // wording drifts is one surface changing it. Pin the words.
  it("renders an agent's scope as the same line it always renders", () => {
    const v = describeScope(agent);
    expect(v.line).toBe("an agent · folders: Areas/Health, Journal · queries, projects: alpha, autonomy: propose");
    expect(v.access).toBe("folders");
    expect(v.extras).toEqual(["queries", "projects: alpha", "autonomy: propose"]);
    expect(v.from).toBe("the registry — the owner's own hand, durable");
  });

  it("says the owner's whole vault as a vault, never as an empty list", () => {
    const owner: Principal = { id: "owner", role: "owner", scope: { tier: "areas", areas: null, queries: true, projects: null }, source: "registry" };
    const v = describeScope(owner);
    expect(v.areas).toBeNull();
    expect(v.line).toBe("the owner · folders: the whole vault · queries, every project, autonomy: observe");
    // …and a grant of NOTHING reads as nothing. The two must never look the
    // same on a screen: one is the person whose vault it is, the other is a
    // credential that holds no area at all.
    const none: Principal = { id: "x", role: "agent", scope: { tier: "areas", areas: [], queries: false, projects: [] }, source: "registry" };
    expect(describeScope(none).scope).toBe("folders: nothing");
  });

  it("gives a crew its toolset and names the manifest its scope came from", () => {
    const crew: Principal = {
      id: "writer",
      role: "crew",
      scope: { tier: "index", areas: [], queries: false, projects: [] },
      source: { manifest: "agents/ops/writer.md" },
      uses: ["knowledge", "requests"],
    };
    const v = describeScope(crew);
    expect(v.line).toBe("a crew · titles · uses: knowledge, requests, autonomy: observe");
    expect(v.from).toContain("agents/ops/writer.md");
    // Every other role carries no allowlist, which is not an empty one.
    expect(describeScope(agent).uses).toBeNull();
  });

  it("says where the assistant's scope came from, once, instead of three doors reconstructing it", () => {
    const assistant: Principal = { id: "assistant", role: "assistant", scope: { tier: "areas", areas: ["/"], queries: true, projects: null }, source: "environment" };
    expect(describeScope(assistant).from).toContain("configuration, not a grant");
  });

  it("copies the areas and the projects, so a view cannot widen under the row it was read from", () => {
    const areas = ["Areas/Health"];
    const p: Principal = { id: "x", role: "agent", scope: { tier: "areas", areas, queries: false, projects: [] }, source: "registry" };
    const v = describeScope(p);
    areas.push("Areas/Finance");
    expect(v.areas).toEqual(["Areas/Health"]);
  });
});

describe("formatRefusal: the one envelope", () => {
  const agent: Principal = { id: "scout", role: "agent", scope: { tier: "index", areas: [], queries: false, projects: [] }, source: "registry" };

  it("carries reason and needs for a refusal that speaks", () => {
    const d = may(agent, "read", { kind: "knowledge", door: "read", path: "Areas/Health/sleep.md", settled: true });
    expect(formatRefusal(d)).toEqual({
      error: { code: "forbidden", message: expect.stringContaining("`Areas/Health` grant") },
      reason: "scope_required",
      needs: { grant: { tier: "areas", area: "Areas/Health" } },
    });
  });

  it("drops the reason for a refusal that hides, and falls back to the code's canonical message", () => {
    // The page is not settled, so the caller cannot already see it exists
    // and no area may be named — the 2026-09-19 boundary. What comes out is
    // byte-identical to what a page that is not there gets.
    const d = may(agent, "read", { kind: "knowledge", door: "read", path: "Areas/Health/sleep.md" });
    expect(formatRefusal(d)).toEqual({ error: { code: "forbidden", message: "not granted" } });
  });

  it("is null for a decision that is not a refusal", () => {
    expect(formatRefusal({ ok: true })).toBeNull();
  });
});
