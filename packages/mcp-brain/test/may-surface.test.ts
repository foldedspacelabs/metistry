// **The whole tool surface × every role, decided in one place.**
//
// §4 of docs/research/2026-09-19-grants-and-access-simplified.md calls this
// the single most valuable artefact of the exercise, and it is the misuse test
// invariant 8 asks to ship with the interface. Two halves:
//
// 1. Every `(tool, role)` pair is DECIDED by `may()` — no pair throws, no pair
//    falls through to the fail-closed default, and every refusal names a
//    reason from the closed enum. A tool added without a rule in `core`'s
//    admission table fails here rather than quietly becoming "refused for
//    everyone" (or, worse, allowed).
// 2. **No tool body decides for itself.** The comparisons that used to be
//    scattered across eleven files — `principal.kind !== "internal"`,
//    `scope.tier === "none"`, `grants.queries === true` — appear in exactly
//    one file in this package: `src/principal.ts`, the credential → principal
//    mapping. Everything else asks.
//
// **Half 2 is a grep over the source, not a runtime assertion**, and that is a
// deliberate trade rather than a shortcut. A runtime version would have to
// drive all 27 tools through an MCP client for all five roles with a database,
// a vault bridge, a query store, an artifacts service and a crew dispatcher
// behind each — and would still only prove that the refusals it happened to
// reach were `may`'s, never that a branch nobody exercised is not a private
// rule. The grep proves the stronger, structural thing: the comparison is not
// in the file. What it cannot catch is a rule spelled some other way (a
// lookup table, a `switch`), so it is a tripwire, not a proof — and the
// golden file in `packages/core/test/access.golden.json` is the other half of
// the net, because a private rule with a new sentence has no entry there.

import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CREW_NEVER_TOOLS, CREW_TOOL_GROUPS, ROLES, REASONS, allowedTools, crewToolsFor, may, type Principal, type Role } from "@foldedspacelabs/metistry-core";
import { TOOL_NAMES } from "../src/index.js";
import { principalOf } from "../src/principal.js";

const SRC = new URL("../src/", import.meta.url);

/** Every tool group a manifest may name — the widest `uses` a crew can be written with. */
const ALL_GROUPS = Object.keys(CREW_TOOL_GROUPS);

/**
 * One principal per role, each as wide as that role ever gets — the assistant
 * with the bare vault its `.env` default gives it, an agent with a real grant,
 * a crew with its manifest scope and every tool group, the capture token with
 * nothing. Widest on purpose: the property below is "somebody may use this
 * tool", and a deliberately narrow principal would make an unruled tool look
 * ruled.
 */
const WIDEST: Record<Role, Principal> = {
  owner: { id: "owner", role: "owner", scope: { tier: "areas", areas: null, queries: true, projects: null, autonomy: { level: "act_within_scope" } }, source: "registry" },
  assistant: { id: "assistant", role: "assistant", scope: { tier: "areas", areas: ["/"], queries: true, projects: null, autonomy: { level: "act_within_scope" } }, source: "environment" },
  agent: { id: "scout", role: "agent", scope: { tier: "areas", areas: ["Areas/Health"], queries: true, projects: ["alpha"], autonomy: { level: "act_within_scope" } }, source: "registry" },
  crew: { id: "writer", role: "crew", scope: { tier: "areas", areas: ["Areas/Health"], queries: true, projects: ["alpha"], autonomy: { level: "act_within_scope" } }, source: { manifest: "agents/ops/writer.md" }, uses: ALL_GROUPS },
  tool: { id: "owner_token", role: "tool", scope: { tier: "none", areas: [], queries: false, projects: [] }, source: "registry" },
};

/** The same, with nothing granted — the fail-closed end of every axis, which for a crew includes an empty `uses`: no groups is no tools. */
const NARROWEST: Record<Role, Principal> = Object.fromEntries(
  ROLES.map((role) => [role, { id: role, role, scope: { tier: "none" as const, areas: [], queries: false, projects: [] }, source: "registry" as const, uses: [] }]),
) as Record<Role, Principal>;

describe("every tool × every role is decided by may(), and by nothing else", () => {
  it("decides all 27 × 5 pairs without throwing, with a reason from the enum", () => {
    const undecided: string[] = [];
    for (const name of TOOL_NAMES) {
      for (const role of ROLES) {
        for (const table of [WIDEST, NARROWEST]) {
          const d = may(table[role], "act", { kind: "tool", name });
          if (typeof d.ok !== "boolean") undecided.push(`${name} × ${role}: not a decision`);
          if (!d.ok && !REASONS.includes(d.reason)) undecided.push(`${name} × ${role}: reason ${d.reason} is not in the enum`);
          if (!d.ok && typeof d.message !== "string") undecided.push(`${name} × ${role}: message is not a string`);
        }
      }
    }
    expect(undecided).toEqual([]);
    expect(TOOL_NAMES.length * ROLES.length).toBe(27 * 5);
  });

  // The fail-closed default in `mayUseTool` refuses EVERY role, so a tool
  // added to TOOL_NAMES without a rule beside it comes out usable by nobody —
  // which this catches, and which a "no exceptions thrown" test would not.
  it("leaves no tool usable by nobody: every name has a role that may hold it", () => {
    const orphaned = TOOL_NAMES.filter((name) => !ROLES.some((role) => may(WIDEST[role], "act", { kind: "tool", name }).ok));
    expect(orphaned).toEqual([]);
  });

  it("refuses a name it has never heard of, for every role — the default is closed", () => {
    for (const role of ROLES) {
      const d = may(WIDEST[role], "act", { kind: "tool", name: "shell_exec" });
      expect(d.ok, role).toBe(false);
    }
  });

  // The three rules that are about the ROLE rather than the grant, stated as
  // properties rather than by example: they are the ones §2.2 and §2.3 found
  // being re-derived in three files each.
  it("holds the one-writer and one-dispatcher rules for every non-assistant role, however wide its grant", () => {
    for (const role of ROLES) {
      const mayWrite = may(WIDEST[role], "act", { kind: "tool", name: "knowledge_write" }).ok;
      const mayDelegate = may(WIDEST[role], "act", { kind: "tool", name: "agents_delegate" }).ok;
      expect([role, mayWrite, mayDelegate]).toEqual([role, role === "assistant", role === "assistant"]);
    }
  });

  // --- the crew's own allowlist (P2 §2.2) ---------------------------------
  //
  // The half of the surface that used to be decided in the process that
  // dispatched the run. Stated as properties over the whole tool list,
  // because "the door holds `uses`" is only true if it is true for all 27.

  it("admits a crew exactly the tools its `uses` groups expand to, and refuses every other name at the door", () => {
    const writer: Principal = { ...WIDEST.crew, uses: ["knowledge", "requests"] };
    const held = new Set(crewToolsFor(writer.uses!));
    const wrong = TOOL_NAMES.filter((name) => may(writer, "act", { kind: "toolset", name }).ok !== held.has(name));
    expect(wrong).toEqual([]);
    expect([...held].sort()).toEqual(["knowledge_grep", "knowledge_list", "knowledge_read", "knowledge_search", "requests_create"]);
    // …and the refusal is the uniform one, naming what the crew DOES hold so
    // the model has something to do other than try the next tool.
    const d = may(writer, "act", { kind: "toolset", name: "tasks_comment" });
    expect(d.ok).toBe(false);
    if (d.ok) return;
    expect({ code: d.code, reason: d.reason }).toEqual({ code: "forbidden", reason: "not_in_uses" });
    expect(d.message).toContain("knowledge, requests");
  });

  it("gives a crew with no groups — or none this console can read — no tools at all, rather than all of them", () => {
    for (const uses of [[], undefined]) {
      const orphan: Principal = { ...WIDEST.crew, uses };
      expect(allowedTools(orphan)).toEqual([]);
      expect(TOOL_NAMES.filter((name) => may(orphan, "act", { kind: "toolset", name }).ok)).toEqual([]);
    }
  });

  it("never lets a `uses` list reach a never-tool, whatever it names — the groups are the table, not a review", () => {
    const everything: Principal = { ...WIDEST.crew, uses: [...ALL_GROUPS, ...CREW_NEVER_TOOLS] };
    for (const name of CREW_NEVER_TOOLS) {
      expect(may(everything, "act", { kind: "toolset", name }).ok, name).toBe(false);
      expect(may(everything, "act", { kind: "tool", name }).ok, name).toBe(false);
    }
  });

  it("decides nothing for the four roles that carry no allowlist: their refusals are the tool's own rule", () => {
    for (const role of ROLES.filter((r) => r !== "crew")) {
      expect(allowedTools(WIDEST[role]), role).toBeNull();
      const refusedByToolset = TOOL_NAMES.filter((name) => !may(NARROWEST[role], "act", { kind: "toolset", name }).ok);
      expect(refusedByToolset, role).toEqual([]);
    }
  });

  it("answers the same about a (crew, tool) pair whichever way it is asked — the door's question cannot disagree with the tool's", () => {
    const writer: Principal = { ...WIDEST.crew, uses: ["tasks", "capture"] };
    for (const name of TOOL_NAMES) {
      if (may(writer, "act", { kind: "toolset", name }).ok) continue;
      const viaTool = may(writer, "act", { kind: "tool", name });
      expect(viaTool.ok, name).toBe(false);
      if (!viaTool.ok) expect(viaTool.reason, name).toBe("not_in_uses");
    }
  });

  it("maps this bridge's credential onto the principal may() decides on", () => {
    expect(principalOf({ id: "a", kind: "internal", grants: { tier: "areas", areas: ["/"] }, projects: [] })).toMatchObject({
      role: "assistant",
      source: "environment",
      scope: { tier: "areas", areas: ["/"], queries: false, projects: null },
    });
    expect(principalOf({ id: "b", grants: { tier: "index", areas: [], queries: true }, projects: ["alpha"] })).toMatchObject({
      role: "agent",
      source: "registry",
      scope: { tier: "index", queries: true, projects: ["alpha"] },
    });
    // P2: the registry's third stored kind arrives intact, carrying the
    // toolset and the manifest it was declared in. `source` finally has a
    // value that is not a prose reconstruction of `kind` (§2.7).
    expect(
      principalOf({ id: "writer", kind: "crew", uses: ["knowledge"], manifest: "agents/ops/writer.md", grants: { tier: "areas", areas: ["Areas/Health"] }, projects: ["alpha"] }),
    ).toMatchObject({
      role: "crew",
      source: { manifest: "agents/ops/writer.md" },
      uses: ["knowledge"],
      scope: { tier: "areas", areas: ["Areas/Health"], projects: ["alpha"] },
    });
    // The three kinds the column stores map onto three of the five roles;
    // `owner` and `tool` are the console's own credentials and no agent
    // bearer can become one.
    expect(["external", "internal", "crew", undefined].map((kind) => principalOf({ id: "c", ...(kind ? { kind: kind as "crew" } : {}), grants: { tier: "none", areas: [] }, projects: [] }).role)).toEqual([
      "agent",
      "assistant",
      "crew",
      "agent",
    ]);
    // A crew's `uses` is COPIED onto the principal, so a manifest re-sync
    // mid-request cannot widen a decision already being made.
    const uses = ["knowledge"];
    const p = principalOf({ id: "writer", kind: "crew", uses, grants: { tier: "none", areas: [] }, projects: [] });
    uses.push("tasks");
    expect(p.uses).toEqual(["knowledge"]);
    expect(p.source).toBe("registry"); // no manifest given: the row is all this console knows about it
  });
});

describe("no tool body carries its own kind/tier comparison", () => {
  /**
   * The comparisons that ARE a policy decision. Spelled out rather than
   * matched loosely, because `e.kind === "file"` (a directory entry) and
   * `t.kind === "review"` (a task) are neither policy nor a principal.
   */
  const FORBIDDEN = [
    'kind === "internal"',
    'kind !== "internal"',
    'kind === "external"',
    'kind !== "external"',
    'kind === "crew"',
    'kind !== "crew"',
    'tier === "none"',
    'tier !== "none"',
    'tier === "areas"',
    'tier !== "areas"',
    'tier === "index"',
    'tier !== "index"',
    "grants.queries",
  ];

  /**
   * `principal.ts` is the credential → principal MAPPING, and reading `kind`
   * exactly once is its whole job (§2.3: three questions, one column, three
   * prose reconstructions — now one function).
   */
  const ALLOWED = new Set(["principal.ts"]);

  it("finds them in src/principal.ts and nowhere else in the package", () => {
    const offenders: string[] = [];
    for (const file of readdirSync(SRC).filter((f) => f.endsWith(".ts"))) {
      if (ALLOWED.has(file)) continue;
      const lines = readFileSync(new URL(file, SRC), "utf8").split("\n");
      lines.forEach((line, i) => {
        // Comments explain the rules; they do not apply them. Line comments,
        // a `/** … */` on one line, and a continuation line of a block
        // comment all come out as nothing.
        const code = line.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
        for (const pattern of FORBIDDEN) {
          if (code.includes(pattern)) offenders.push(`${file}:${i + 1}: ${pattern} — ask may() instead`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it("would catch one if it came back", () => {
    // The assertion above is only worth what its patterns are worth, so this
    // pins that the matcher actually fires on the shape it is looking for.
    const relapse = `if (principal.kind !== "internal") return fail("forbidden");`;
    expect(FORBIDDEN.some((p) => relapse.includes(p))).toBe(true);
  });
});
