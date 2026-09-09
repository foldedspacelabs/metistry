// Crew manifests (plan §4.11 scoped escape hatch, Phase 5 "crew definitions
// with their own toolsets"). The schema is the first control: a crew's
// toolset is named in groups, the write tools are not a group, and naming
// them by hand is refused with the reason — before any registry, dispatcher,
// or prompt sees the manifest.
import { describe, expect, it } from "vitest";
import { CREW_NEVER_TOOLS, CREW_TOOL_GROUPS, crewGroupOf, crewToolsFor, validateManifest } from "../src/index.js";

const researcher = {
  name: "researcher",
  type: "agent",
  area: "example",
  model: "haiku",
  description: "Reads the granted areas and reports findings",
  uses: ["brain-read", "brain-report"],
  scope: ["Knowledge/Projects", "Knowledge/Resources"],
  projects: ["example"],
  max_turns: 10,
  budget_usd_per_run: 0.25,
};

function errorsOf(input: unknown): string {
  const r = validateManifest(input);
  return r.ok ? "" : r.errors.join("; ");
}

describe("crew manifest schema", () => {
  it("accepts the plan's shape and fills the defaults", () => {
    const r = validateManifest(researcher);
    expect(r.ok).toBe(true);
    if (!r.ok || r.manifest.type !== "agent") return;
    expect(r.manifest).toMatchObject({ skills: [], manages: [], max_turns: 10, budget_usd_per_run: 0.25 });
    const min = validateManifest({ name: "x", type: "agent", model: "sonnet" });
    expect(min.ok).toBe(true);
    if (!min.ok || min.manifest.type !== "agent") return;
    expect(min.manifest).toMatchObject({ uses: [], scope: [], projects: [], max_turns: 12, budget_usd_per_run: 0.5 });
  });

  it("uses may name groups or their plan aliases, never a write tool or an unknown name", () => {
    for (const ok of [["knowledge"], ["report"], ["capture"], ["tasks"], ["artifacts"], ["brain-read", "brain-report"], []]) {
      expect(errorsOf({ ...researcher, uses: ok }), ok.join()).toBe("");
    }
    for (const never of CREW_NEVER_TOOLS) {
      expect(errorsOf({ ...researcher, uses: [never] })).toMatch(/never available to a crew/);
    }
    expect(errorsOf({ ...researcher, uses: ["knowledge_read"] })).toMatch(/unknown tool group "knowledge_read"/); // groups, not tools
    expect(errorsOf({ ...researcher, uses: ["shell"] })).toMatch(/unknown tool group/);
  });

  it("model is one of the three tiers", () => {
    for (const m of ["haiku", "sonnet", "opus"]) expect(errorsOf({ ...researcher, model: m })).toBe("");
    expect(errorsOf({ ...researcher, model: "gpt-5" })).toMatch(/model/);
    expect(errorsOf({ ...researcher, model: undefined })).toMatch(/model/);
  });

  it("scope is Knowledge/ prefixes below the root, no traversal, no trailing slash", () => {
    expect(errorsOf({ ...researcher, scope: ["Knowledge/Areas/Fsl"] })).toBe("");
    for (const bad of ["Knowledge", "Knowledge/", "knowledge/Areas", "Areas/fsl", "Knowledge/../x", "Knowledge/Projects/"]) {
      expect(errorsOf({ ...researcher, scope: [bad] }), bad).toMatch(/scope/);
    }
  });

  it("names, areas, projects, skills and manages are lowercase slugs; caps are bounded", () => {
    expect(errorsOf({ ...researcher, name: "Researcher" })).toMatch(/name/);
    expect(errorsOf({ ...researcher, area: "Example" })).toMatch(/area/);
    expect(errorsOf({ ...researcher, projects: ["Drey"] })).toMatch(/projects/);
    expect(errorsOf({ ...researcher, skills: ["Brief Writer"] })).toMatch(/skills/);
    expect(errorsOf({ ...researcher, manages: ["QA"] })).toMatch(/manages/);
    expect(errorsOf({ ...researcher, max_turns: 0 })).toMatch(/max_turns/);
    expect(errorsOf({ ...researcher, max_turns: 201 })).toMatch(/max_turns/);
    expect(errorsOf({ ...researcher, budget_usd_per_run: -1 })).toMatch(/budget_usd_per_run/);
    expect(errorsOf({ ...researcher, budget_usd_per_run: 51 })).toMatch(/budget_usd_per_run/);
  });

  it("autonomy: accepts the §4.21 narrowing block and fills nothing when absent", () => {
    const withAutonomy = { ...researcher, autonomy: { may_dispatch_to: ["scout"], accept_from: ["scout", "user"], max_open_bundles: 3 } };
    const r = validateManifest(withAutonomy);
    expect(r.ok).toBe(true);
    if (!r.ok || r.manifest.type !== "agent") return;
    expect(r.manifest.autonomy).toEqual({ may_dispatch_to: ["scout"], accept_from: ["scout", "user"], max_open_bundles: 3 });
    const bare = validateManifest(researcher);
    expect(bare.ok && bare.manifest.type === "agent" && bare.manifest.autonomy).toBeUndefined();
  });

  it("autonomy: rejects an unknown key instead of silently dropping it (the narrowing must not become a no-op)", () => {
    expect(errorsOf({ ...researcher, autonomy: { may_dispatc_to: ["scout"] } })).toMatch(/autonomy/);
    expect(errorsOf({ ...researcher, autonomy: { may_dispatch_to: ["Scout"] } })).toMatch(/autonomy/); // not an agent id
    expect(errorsOf({ ...researcher, autonomy: { accept_from: ["nobody!"] } })).toMatch(/autonomy/);
    expect(errorsOf({ ...researcher, autonomy: { max_open_bundles: 0 } })).toMatch(/autonomy/); // ≥1: 0 would mean "narrowed to nothing", spell that by omission
    expect(errorsOf({ ...researcher, autonomy: { max_open_bundles: 1.5 } })).toMatch(/autonomy/);
  });

  it("refuses an unknown top-level key instead of stripping it (schema is strict for the agent type)", () => {
    expect(errorsOf({ ...researcher, autonomys: { max_open_bundles: 1 } })).toMatch(/autonomys|unrecognized/i);
    expect(errorsOf({ ...researcher, bogus_field: true })).toMatch(/bogus_field|unrecognized/i);
  });
});

describe("tool groups → allowlist", () => {
  it("resolves aliases and keeps group order, deduplicated", () => {
    expect(crewGroupOf("brain-read")).toBe("knowledge");
    expect(crewGroupOf("brain-report")).toBe("report");
    expect(crewGroupOf("tasks")).toBe("tasks");
    expect(crewGroupOf("knowledge_write")).toBeUndefined();
    expect(crewGroupOf("toString")).toBeUndefined(); // prototype names are not groups
    expect(crewToolsFor(["brain-report", "brain-read", "report"])).toEqual(["knowledge_search", "knowledge_read", "knowledge_list", "knowledge_grep", "report"]);
    expect(crewToolsFor([])).toEqual([]);
  });

  it("no group ever contains a never-tool", () => {
    for (const [group, tools] of Object.entries(CREW_TOOL_GROUPS)) {
      for (const never of CREW_NEVER_TOOLS) expect(tools as readonly string[], group).not.toContain(never);
    }
    expect(crewToolsFor(Object.keys(CREW_TOOL_GROUPS))).not.toContain("knowledge_write");
  });
});
