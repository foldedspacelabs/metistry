// resolveActor (T4-6; plan §2.4, docs/ops/actors.md): one resolver composes
// every actor from what already exists — the registry row, a crew's manifest,
// identity.yaml, compute.yaml. Pure, so every case is a table of sources.
import { describe, expect, it } from "vitest";
import {
  ASSISTANT_AGENT_ID,
  ActorPermissionRefused,
  EMPTY_SCOPE,
  crewCompute,
  crewPermissionRows,
  crewToolGroups,
  describeScope,
  emptyCompute,
  externalPermissionRows,
  parseCompute,
  resolveActor,
  resolveCrewAssignment,
  scopeOfRegistryRow,
  validateManifest,
  type ActorCrewSource,
  type ActorGrantHistory,
  type ActorRegistryRow,
  type ActorSources,
  type AgentManifest,
  type Compute,
  type PermissionRow,
} from "../src/index.js";

const COMPUTE: Compute = parseCompute(`
providers:
  lmstudio:
    kind: openai-compatible
    base_url: http://127.0.0.1:1234/v1
    locality: on_machine
  openrouter:
    kind: openai-compatible
    base_url: https://openrouter.ai/api/v1
    locality: off_machine
    auth: { secret: METISTRY_OPENROUTER_API_KEY }
    zdr: true
    data_policy: { allow: [Projects], deny_sources: [comms], max_brief_bytes: 65536 }
assignments:
  default: { model: lmstudio/gemma, effort: medium }
  crews:
    legacy-assigned: { model: openrouter/anthropic/claude-sonnet-5, effort: high }
`);

const row = (over: Partial<ActorRegistryRow> & { id: string }): ActorRegistryRow => ({
  kind: "external",
  display_name: over.id,
  grants: { tier: "none", areas: [] },
  projects: [],
  autonomy: {},
  grant_source: "registry",
  revoked: false,
  pending: false,
  ...over,
});

function crewSource(name: string, over: Partial<AgentManifest> = {}): ActorCrewSource {
  const r = validateManifest({ name, type: "agent", area: "research", model: "lmstudio/gemma", uses: ["report", "knowledge", "knowledge"], scope: ["Projects"], max_turns: 8, budget_usd_per_run: 0.3, ...over });
  if (!r.ok || r.manifest.type !== "agent") throw new Error(JSON.stringify(r));
  return {
    manifest: r.manifest,
    prompt: "You research one question.",
    file: { path: `.metistry/agents/research/${name}.md`, origin: "instance", sha256: "a".repeat(64) },
  };
}

const IDENTITY = { name: "Aide", mention: "@aide", mark: null };
const ASSISTANT_FILES = [
  { path: ".metistry/identity.yaml", origin: "instance" as const, sha256: "1".repeat(64) },
  { path: "seed/assistant-prompt.md", origin: "product" as const, sha256: "2".repeat(64) },
];

function sources(rows: ActorRegistryRow[], crews: ActorCrewSource[] = [], history: Record<string, ActorGrantHistory> = {}, compute: Compute = COMPUTE): ActorSources {
  return {
    assistant: { id: ASSISTANT_AGENT_ID, identity: IDENTITY, files: ASSISTANT_FILES },
    registry: (id) => rows.find((r) => r.id === id),
    crew: (id) => crews.find((c) => c.manifest.name === id),
    compute,
    connections: () => [],
    grantHistory: (id) => history[id] ?? { approved: [], routines: [] },
  };
}

const ASSISTANT_ROW = row({ id: ASSISTANT_AGENT_ID, kind: "internal", display_name: "assistant (internal)", grants: { tier: "areas", areas: ["/"] }, grant_source: "environment" });

describe("resolveActor — the rules, in order", () => {
  it("1. the assistant's id always resolves to the assistant — with its row, and without one", () => {
    const live = resolveActor(ASSISTANT_AGENT_ID, sources([ASSISTANT_ROW]));
    expect(live?.kind).toBe("assistant");
    if (live?.kind !== "assistant") return;
    expect(live.displayName).toBe("Aide");
    expect(live.definition).toEqual({ kind: "assistant", identity: IDENTITY, files: ASSISTANT_FILES });
    expect(live.compute).toEqual({ kind: "router" });
    expect(live.limits).toBeNull();
    expect(live.tools.groups).toBeNull();
    expect(live.permissions.scope).toMatchObject({ tier: "areas", areas: ["/"], projects: null });

    for (const s of [sources([]), sources([{ ...ASSISTANT_ROW, revoked: true }])]) {
      const off = resolveActor(ASSISTANT_AGENT_ID, s);
      expect(off?.kind).toBe("assistant");
      expect(off?.permissions.scope).toEqual(EMPTY_SCOPE);
      expect(off?.permissions.lines).toEqual([]);
      expect(off?.permissions.source).toBe("environment");
    }
  });

  it("the assistant never renders as a grant: its source is configuration whatever the row says, and every line is base-from-environment or an approval", () => {
    for (const grant_source of ["registry", null, "environment"] as const) {
      const a = resolveActor(ASSISTANT_AGENT_ID, sources([{ ...ASSISTANT_ROW, grant_source }], [], { [ASSISTANT_AGENT_ID]: { approved: [{ area: "/", proposalId: null }], routines: [] } }));
      expect(a?.permissions.source, String(grant_source)).toBe("environment");
      for (const l of a!.permissions.lines) {
        for (const e of [...l.read, ...l.write]) {
          expect(e.provenance.kind === "base" ? e.provenance.source : e.provenance.kind, `${l.label} ${e.key}`).toMatch(/^(environment|approved)$/);
        }
      }
      // the whole vault, said as that — never "folders: /"
      expect(a!.permissions.lines[0]!.read.map((e) => e.label)).toEqual(["The whole vault"]);
      // and the one-line triple a principal built from it reads "configuration, not a grant"
      const view = describeScope({ id: a!.id, role: a!.permissions.role, scope: a!.permissions.scope, source: a!.permissions.source });
      expect(view.from).toMatch(/^configuration, not a grant/);
    }
  });

  it("2. no row, or a revoked row, is no actor", () => {
    expect(resolveActor("ghost", sources([]))).toBeNull();
    expect(resolveActor("gone", sources([row({ id: "gone", revoked: true })]))).toBeNull();
  });

  it("3. a pending row resolves, so the owner deciding sees what it would hold", () => {
    const a = resolveActor("devin", sources([row({ id: "devin", pending: true, grants: { tier: "areas", areas: ["Projects"] } })]));
    expect(a?.kind).toBe("external");
    expect(a?.permissions.lines.map((l) => l.label)).toEqual(["Knowledge", "Inbox"]);
  });

  it("4. by kind: internal is the assistant, a crew needs its manifest, anything else is external", () => {
    // a second internal row (the door that made one is now closed) is still drawn as what the door treats it as
    expect(resolveActor("other", sources([row({ id: "other", kind: "internal" })]))?.kind).toBe("assistant");
    expect(resolveActor("scout", sources([row({ id: "scout", kind: "crew" })]))).toBeNull();
    expect(resolveActor("scout", sources([row({ id: "scout", kind: "crew" })], [crewSource("scout")]))?.kind).toBe("crew");
    const odd = resolveActor("odd", sources([row({ id: "odd", kind: "robot" })]));
    expect(odd?.kind).toBe("external");
    expect(odd?.permissions.role).toBe("agent");
  });
});

describe("resolveActor — a crew, field by field", () => {
  const scoutRow = row({ id: "scout", kind: "crew", display_name: "scout (crew, research)", grants: { tier: "areas", areas: ["Projects"] }, grant_source: "manifest", projects: ["alpha"] });

  it("composes definition, tools, compute, limits and permissions from the manifest and the row", () => {
    const a = resolveActor("scout", sources([scoutRow], [crewSource("scout", { description: "Finds sources" })]));
    expect(a?.kind).toBe("crew");
    if (a?.kind !== "crew") return;
    expect(a.displayName).toBe("scout"); // the manifest name, not the registry label
    expect(a.definition).toEqual({ kind: "crew", area: "research", description: "Finds sources", prompt: "You research one question.", files: [crewSource("scout").file] });
    expect(a.tools.groups).toEqual(["knowledge", "requests"]); // aliases resolved, deduplicated, in CREW_TOOL_GROUPS order
    expect(a.compute).toEqual({ kind: "model", ref: "lmstudio/gemma", effort: "low" });
    expect(a.limits).toEqual({ maxTurns: 8, budgetUsdPerRun: 0.3 });
    expect(a.permissions.source).toEqual({ manifest: ".metistry/agents/research/scout.md" });
    expect(a.permissions.lines.map((l) => [l.label, l.read.map((e) => e.key), l.write.map((e) => e.key)])).toEqual([["Knowledge", ["Projects"], []]]);
  });

  it("a crew holding no groups has [] — never null, which is the assistant's 'no allowlist'", () => {
    const a = resolveActor("scout", sources([scoutRow], [crewSource("scout", { uses: [] })]));
    expect(a?.tools.groups).toEqual([]);
    expect(a?.permissions.lines).toEqual([]);
    expect(crewToolGroups(["brain-read", "shell"])).toEqual(["knowledge"]);
  });
});

describe("resolveActor — an external agent", () => {
  it("has no definition and no compute; its lines come from its registry row, approvals marked", () => {
    const a = resolveActor(
      "cursor",
      sources([row({ id: "cursor", display_name: "Cursor", grants: { tier: "areas", areas: ["Projects", "Areas/Ops"], queries: true }, projects: ["alpha"] })], [], {
        cursor: { approved: [{ area: "Areas/Ops", proposalId: 42 }], routines: [] },
      }),
    );
    expect(a?.kind).toBe("external");
    if (a?.kind !== "external") return;
    expect([a.definition, a.compute, a.limits, a.tools.groups]).toEqual([null, null, null, null]);
    expect(a.displayName).toBe("Cursor");
    expect(a.permissions.source).toBe("registry");
    expect(a.permissions.lines.map((l) => l.label)).toEqual(["Knowledge", "Work", "Artifacts", "Inbox", "Queries"]);
    expect(a.permissions.lines[0]!.read.map((e) => e.provenance)).toEqual([{ kind: "base", source: "registry" }, { kind: "approved", proposalId: 42 }]);
  });
});

describe("a forbidden row is refused, never filtered (U3)", () => {
  const entry = { key: "x", label: "x", asks: false, provenance: { kind: "base" as const, source: "registry" as const } };
  const knowledgeWrite: PermissionRow = { resource: { kind: "knowledge" }, label: "Knowledge", read: [], write: [entry] };
  const agentsRow: PermissionRow = { resource: { kind: "agents" }, label: "Agents", read: [], write: [entry] };
  const queriesRow: PermissionRow = { resource: { kind: "queries" }, label: "Queries", read: [entry], write: [] };

  it("an external agent's Knowledge Write or Agents row throws", () => {
    expect(() => externalPermissionRows("cursor", [knowledgeWrite])).toThrow(ActorPermissionRefused);
    expect(() => externalPermissionRows("cursor", [agentsRow])).toThrow(/delegating is the instance assistant's alone/);
    expect(externalPermissionRows("cursor", [queriesRow])).toHaveLength(1);
  });

  it("a crew's Queries row throws too", () => {
    expect(() => crewPermissionRows("scout", [queriesRow])).toThrow(/no crew runs a named query/);
    expect(() => crewPermissionRows("scout", [knowledgeWrite])).toThrow(/one writer/);
  });
});

describe("crew compute — what the actor says, and what the runner runs, are one rule", () => {
  const cases: [string, string, Partial<AgentManifest>, unknown][] = [
    ["a pinned reference, with the crew's own effort", "pinned", { model: "openrouter/anthropic/claude-haiku-5", effort: "high" }, { kind: "model", ref: "openrouter/anthropic/claude-haiku-5", effort: "high" }],
    ["same_as_assistant", "same", { model: "same_as_assistant", effort: "high" }, { kind: "same_as_assistant" }],
    ["a legacy alias with assignments.crews.<id>", "legacy-assigned", { model: "haiku" }, { kind: "model", ref: "openrouter/anthropic/claude-sonnet-5", effort: "high" }],
    ["a legacy alias with none — today's behaviour exactly", "legacy-plain", { model: "sonnet" }, { kind: "same_as_assistant" }],
  ];
  for (const [what, id, manifest, want] of cases) {
    it(what, () => {
      const m = crewSource(id, manifest).manifest;
      const said = crewCompute(id, m, COMPUTE);
      expect(said).toEqual(want);
      const ran = resolveCrewAssignment(COMPUTE, id, m);
      expect(ran.ok).toBe(true);
      if (!ran.ok) return;
      // "same as" is the default tier, model and effort — never the router
      if (said.kind === "same_as_assistant") expect([ran.assignment.ref, ran.assignment.effort]).toEqual(["lmstudio/gemma", "medium"]);
      else expect([ran.assignment.ref, ran.assignment.effort]).toEqual([said.ref, said.effort]);
    });
  }

  it("the runner refuses what it cannot run, naming the fix — never something else", () => {
    const unknown = resolveCrewAssignment(COMPUTE, "x", { model: "anthropic/claude-x", effort: "low" });
    expect(unknown).toMatchObject({ ok: false });
    if (!unknown.ok) expect(unknown.reason).toMatch(/declares no provider 'anthropic'.*metistry agents define x --model/);
    const bare = resolveCrewAssignment(emptyCompute(), "x", { model: "same_as_assistant", effort: "low" });
    if (!bare.ok) expect(bare.reason).toMatch(/assigns no assignments\.default/);
    const legacy = resolveCrewAssignment(emptyCompute(), "x", { model: "haiku", effort: "low" });
    if (!legacy.ok) expect(legacy.reason).toMatch(/assigns neither assignments\.crews\.x nor assignments\.default/);
    expect([bare.ok, legacy.ok]).toEqual([false, false]);
    // a pinned reference needs no assignments at all: the definition says what runs
    expect(resolveCrewAssignment(parseCompute("providers:\n  lmstudio: { kind: openai-compatible, base_url: 'http://127.0.0.1:1234/v1', locality: on_machine }\n"), "x", { model: "lmstudio/qwen", effort: "low" })).toMatchObject({
      ok: true,
      assignment: { provider: "lmstudio", model: "qwen", effort: "low", from: "crew:x" },
    });
  });
});

describe("scopeOfRegistryRow — principalOfRow's derivation, once", () => {
  it("copies the grant, reads queries only when true, and gives an internal row with no projects every project", () => {
    expect(scopeOfRegistryRow(row({ id: "a", kind: "internal", grants: { tier: "areas", areas: ["/"] } }))).toEqual({ tier: "areas", areas: ["/"], queries: false, projects: null, autonomy: {} });
    expect(scopeOfRegistryRow(row({ id: "b", grants: { tier: "index", areas: [], queries: true } }))).toMatchObject({ queries: true, projects: [] });
    const g = { tier: "areas" as const, areas: ["Projects"] };
    const s = scopeOfRegistryRow(row({ id: "c", grants: g }));
    g.areas.push("Areas/Leak");
    expect(s.areas).toEqual(["Projects"]);
  });
});
