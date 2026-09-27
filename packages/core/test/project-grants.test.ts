// Project grants, inherited (T4-7; D13, screen 13): a member's effective
// reach is its own grant ∪ the grants of the projects it is IN, and every
// line the projects added is marked "via project". The union is pure
// (`inheritGrants`), so the door and the permissions table call one function
// — and the ticket's bold test, leaving the project removes the inherited
// reach, is a property of that function: membership is its input.
import { describe, expect, it } from "vitest";
import {
  ASSISTANT_AGENT_ID,
  INHERITED_QUERIES,
  INHERITED_TITLES,
  describePermissions,
  emptyCompute,
  inheritGrants,
  may,
  permissionProvenanceText,
  permissionRowText,
  resolveActor,
  scopeOfRegistryRow,
  validateManifest,
  type ActorCrewSource,
  type ActorRegistryRow,
  type ActorSources,
  type GrantEnvelope,
  type Principal,
  type ProjectGrant,
} from "../src/index.js";

const NONE: GrantEnvelope = { tier: "none", areas: [] };
const OWN: GrantEnvelope = { tier: "areas", areas: ["Areas/Ops"] };
const PROJECTS: ProjectGrant[] = [
  { project: "drey", grants: { tier: "areas", areas: ["Areas/Finance", "Areas/Ops/Runbooks"], queries: true } },
  { project: "kite", grants: { tier: "areas", areas: ["Resources/Kite"] } },
  { project: "quiet", grants: { tier: "none", areas: [] } },
];

/** May this envelope's holder read `path` at the knowledge door? `may()` decides, as the door does. */
function reads(grants: GrantEnvelope, path: string): boolean {
  const p: Principal = { id: "cursor", role: "agent", scope: scopeOfRegistryRow({ kind: "external", grants, projects: [], autonomy: {} }), source: "registry" };
  return may(p, "read", { kind: "knowledge", door: "read", path, exists: true }).ok;
}

describe("inheritGrants — own ∪ the projects it is a member of", () => {
  it("unions the member's own areas with each of its projects' areas, own first, and marks only what the projects added", () => {
    const { grants, via } = inheritGrants(OWN, ["drey", "kite"], PROJECTS);
    // Areas/Ops/Runbooks is under the member's own Areas/Ops: it is the member's, not the project's
    expect(grants).toEqual({ tier: "areas", areas: ["Areas/Ops", "Areas/Finance", "Resources/Kite"], queries: true });
    expect(via).toEqual([
      { key: "Areas/Finance", project: "drey" },
      { key: "Resources/Kite", project: "kite" },
      { key: INHERITED_QUERIES, project: "drey" },
    ]);
  });

  it("**leaving the project removes the inherited reach** — and nothing of the member's own", () => {
    const joined = inheritGrants(OWN, ["drey"], PROJECTS).grants;
    expect(reads(joined, "Areas/Finance/budget.md")).toBe(true);
    const left = inheritGrants(OWN, [], PROJECTS);
    expect(left).toEqual({ grants: OWN, via: [] });
    expect(reads(left.grants, "Areas/Finance/budget.md")).toBe(false);
    expect(reads(left.grants, "Areas/Ops/today.md")).toBe(true); // its own grant is untouched
    // leaving ONE project keeps the other's
    const one = inheritGrants(OWN, ["kite"], PROJECTS).grants;
    expect(one.areas).toEqual(["Areas/Ops", "Resources/Kite"]);
    expect(reads(one, "Areas/Finance/budget.md")).toBe(false);
    expect(one.queries).toBeUndefined();
  });

  it("a project the agent is not in gives it nothing, however wide its grant", () => {
    expect(inheritGrants(NONE, ["kite"], PROJECTS).grants).toEqual({ tier: "areas", areas: ["Resources/Kite"] });
    expect(inheritGrants(NONE, ["elsewhere"], PROJECTS)).toEqual({ grants: NONE, via: [] });
    expect(inheritGrants(NONE, ["quiet"], PROJECTS)).toEqual({ grants: NONE, via: [] }); // a member of a project that grants nothing
  });

  it("an area the member holds itself is never 'via project', even when a project grants it too", () => {
    const { via } = inheritGrants({ tier: "areas", areas: ["Areas/Finance", "Areas/Ops/Runbooks"], queries: true }, ["drey"], PROJECTS);
    expect(via).toEqual([]);
  });

  it("a project's stored grant is re-checked, fail closed: the bare vault, machinery, artifacts, a traversal and an unknown tier inherit nothing", () => {
    const hostile: ProjectGrant[] = [
      { project: "bad", grants: { tier: "areas", areas: ["/", ".metistry/state", "Artifacts/Reports", "Areas/../Me", "areas/lower"] } },
      { project: "odd", grants: { tier: "widen", areas: ["Areas/Finance"], queries: "yes" } },
      { project: "null", grants: null },
    ];
    expect(inheritGrants(NONE, ["bad", "odd", "null"], hostile)).toEqual({ grants: NONE, via: [] });
    // one good area beside the bad ones is the only thing inherited
    const mixed = inheritGrants(NONE, ["bad2"], [{ project: "bad2", grants: { tier: "areas", areas: ["/", "Areas/Finance"] } }]);
    expect(mixed.grants).toEqual({ tier: "areas", areas: ["Areas/Finance"] });
  });

  it("tiers: the widest held — titles only via a project; content beats titles (as an approval on an index grant does)", () => {
    const titles: ProjectGrant[] = [{ project: "lens", grants: { tier: "index", areas: [] } }];
    expect(inheritGrants(NONE, ["lens"], titles)).toEqual({ grants: { tier: "index", areas: [] }, via: [{ key: INHERITED_TITLES, project: "lens" }] });
    expect(inheritGrants({ tier: "index", areas: [] }, ["lens"], titles).via).toEqual([]); // held already
    expect(inheritGrants(OWN, ["lens"], titles)).toEqual({ grants: OWN, via: [] });
    expect(inheritGrants({ tier: "index", areas: [] }, ["kite"], PROJECTS).grants).toEqual({ tier: "areas", areas: ["Resources/Kite"] });
  });
});

describe("describePermissions — an inherited line carries the project as its provenance", () => {
  it("areas, titles and queries each say 'via project <slug>'; the member's own lines stay unmarked", () => {
    const { grants, via } = inheritGrants(OWN, ["drey"], PROJECTS);
    const p: Principal = { id: "cursor", role: "agent", scope: scopeOfRegistryRow({ kind: "external", grants, projects: ["drey"], autonomy: {} }), source: "registry" };
    const rows = describePermissions(p, { history: { approved: [], routines: [], projects: via } });
    const text = rows.map(permissionRowText);
    expect(text.find((r) => r[0] === "Knowledge")).toEqual(["Knowledge", "Areas/Ops, Areas/Finance (via project drey)", "—"]);
    expect(text.find((r) => r[0] === "Queries")).toEqual(["Queries", "Named queries (via project drey)", "—"]);
    expect(permissionProvenanceText({ kind: "project", project: "drey" })).toBe("via project drey");

    const titles = inheritGrants(NONE, ["lens"], [{ project: "lens", grants: { tier: "index", areas: [] } }]);
    const t: Principal = { id: "cursor", role: "agent", scope: scopeOfRegistryRow({ kind: "external", grants: titles.grants, projects: ["lens"], autonomy: {} }), source: "registry" };
    expect(describePermissions(t, { history: { approved: [], routines: [], projects: titles.via } }).map(permissionRowText)[0]).toEqual(["Knowledge", "Titles only (via project lens)", "—"]);
  });
});

describe("resolveActor — a crew or external member's scope is its row ∪ its projects'", () => {
  const row = (over: Partial<ActorRegistryRow> & { id: string }): ActorRegistryRow => ({
    kind: "external",
    display_name: over.id,
    grants: NONE,
    projects: [],
    autonomy: {},
    grant_source: "registry",
    revoked: false,
    pending: false,
    ...over,
  });
  const scout = (): ActorCrewSource => {
    const r = validateManifest({ name: "scout", type: "agent", area: "research", model: "same_as_assistant", uses: ["knowledge"], scope: ["Resources"], projects: ["kite"], max_turns: 8, budget_usd_per_run: 0.3 });
    if (!r.ok || r.manifest.type !== "agent") throw new Error(JSON.stringify(r));
    return { manifest: r.manifest, prompt: "p", file: { path: ".metistry/agents/research/scout.md", origin: "instance", sha256: "a".repeat(64) } };
  };
  const sources = (rows: ActorRegistryRow[], projectGrants: ProjectGrant[] = PROJECTS): ActorSources => ({
    assistant: { id: ASSISTANT_AGENT_ID, identity: { name: "Aide", mention: null, mark: null }, files: [] },
    registry: (id) => rows.find((r) => r.id === id),
    crew: (id) => (id === "scout" ? scout() : undefined),
    compute: emptyCompute(),
    connections: () => [],
    grantHistory: () => ({ approved: [], routines: [] }),
    projectGrants,
  });
  const knowledge = (id: string, s: ActorSources) => resolveActor(id, s)?.permissions.lines.find((l) => l.resource.kind === "knowledge")?.read.map((e) => [e.key, e.provenance]) ?? [];

  it("an external member: the scope is the union, each inherited area marked; leaving takes the line away", () => {
    const joined = sources([row({ id: "cursor", grants: OWN, projects: ["drey"] })]);
    expect(resolveActor("cursor", joined)?.permissions.scope).toMatchObject({ tier: "areas", areas: ["Areas/Ops", "Areas/Finance"], queries: true });
    expect(knowledge("cursor", joined)).toEqual([
      ["Areas/Ops", { kind: "base", source: "registry" }],
      ["Areas/Finance", { kind: "project", project: "drey" }],
    ]);
    const left = sources([row({ id: "cursor", grants: OWN, projects: [] })]);
    expect(resolveActor("cursor", left)?.permissions.scope).toMatchObject({ tier: "areas", areas: ["Areas/Ops"], queries: false });
    expect(knowledge("cursor", left)).toEqual([["Areas/Ops", { kind: "base", source: "registry" }]]);
  });

  it("a crew member inherits too — through its own `uses`, which still gates the read", () => {
    const s = sources([row({ id: "scout", kind: "crew", grants: { tier: "areas", areas: ["Resources"] }, projects: ["kite", "drey"], grant_source: "manifest" })]);
    expect(knowledge("scout", s)).toEqual([
      ["Resources", { kind: "base", source: { manifest: ".metistry/agents/research/scout.md" } }],
      ["Areas/Finance", { kind: "project", project: "drey" }],
      ["Areas/Ops/Runbooks", { kind: "project", project: "drey" }],
    ]); // Resources/Kite is under its own Resources, so kite adds nothing
  });

  it("the assistant inherits nothing: its reach is configuration, and 'every project' is where it works, not what it joined", () => {
    const narrowed = row({ id: ASSISTANT_AGENT_ID, kind: "internal", grants: { tier: "areas", areas: ["Areas/Health"] }, projects: ["drey"], grant_source: "environment" });
    for (const r of [narrowed, { ...narrowed, projects: [] }]) {
      const a = resolveActor(ASSISTANT_AGENT_ID, sources([r]));
      expect(a?.permissions.scope.areas).toEqual(["Areas/Health"]);
      expect(knowledge(ASSISTANT_AGENT_ID, sources([r])).map(([k]) => k)).toEqual(["Areas/Health"]);
    }
  });

  it("with no project grants loaded the resolution is exactly the row's (the T4-6 behaviour)", () => {
    const s = sources([row({ id: "cursor", grants: OWN, projects: ["drey"] })], []);
    expect(resolveActor("cursor", s)?.permissions.scope).toMatchObject({ tier: "areas", areas: ["Areas/Ops"], queries: false });
  });
});
