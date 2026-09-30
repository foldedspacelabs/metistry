// The permissions table (T4-6; plan §2.4, screen 7 §4.1, C58): Resource ×
// Read × Write, one line per resource, and ABSENCE IS THE DENIAL.
//
// Two halves, both bold in the ticket:
//
//   * the ENUMERATION: every ruled tool and every action kind has exactly one
//     placement (`TOOL_PERMISSION_CELLS`, `ACTION_PERMISSION_CELLS`), and that
//     data IS docs/ops/actors.md's table — parsed here, so the document and
//     the code cannot drift, the way may-surface.test.ts pins RULED_TOOLS to
//     the bridge's TOOL_NAMES;
//   * the RENDERING: `describePermissions` draws what `may()` admits and
//     nothing else — Knowledge Write never appears for a non-assistant role,
//     `null` and `[]` never read the same, and every entry is backed by a
//     door that would say yes.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ACTION_KINDS,
  ACTION_PERMISSION_CELLS,
  CREW_TOOL_GROUPS,
  PERMISSION_RESOURCES,
  PERMISSION_RESOURCE_LABEL,
  ROLES,
  RULED_TOOLS,
  TOOL_PERMISSION_CELLS,
  PERMISSION_CONNECTION_WORDS,
  describePermissions,
  may,
  permissionRowText,
  type PermissionRow,
  type Principal,
  type Role,
  type Scope,
} from "../src/index.js";

const ALL_GROUPS = Object.keys(CREW_TOOL_GROUPS);
const RESOURCE_OF_WORD: Record<string, string> = { Knowledge: "knowledge", Work: "work", Artifacts: "artifacts", Inbox: "inbox", Queries: "queries", Agents: "agents" };

/** One principal per role, as wide as that role ever gets — the widest is the one that could leak. */
const WIDE_SCOPE: Scope = { tier: "areas", areas: ["Areas/Health", "Projects"], queries: true, projects: ["alpha"], autonomy: { level: "act_within_scope", actions: { dispatch: "allow" } } };
const principal = (role: Role, scope: Scope = WIDE_SCOPE, extra: Partial<Principal> = {}): Principal => ({
  id: `${role}-1`,
  role,
  scope,
  source: role === "assistant" ? "environment" : role === "crew" ? { manifest: ".metistry/agents/research/scout.md" } : "registry",
  ...(role === "crew" ? { uses: ALL_GROUPS } : {}),
  ...extra,
});
const row = (rows: readonly PermissionRow[], kind: string) => rows.find((r) => r.resource.kind === kind);
const keys = (rows: readonly PermissionRow[], kind: string, column: "read" | "write") => (row(rows, kind)?.[column] ?? []).map((e) => e.key);

// ---------------------------------------------------------------------------
// The enumeration
// ---------------------------------------------------------------------------

describe("every ruled tool maps to exactly one cell (the enumeration)", () => {
  it("TOOL_PERMISSION_CELLS is keyed by exactly RULED_TOOLS — nothing missing, nothing extra", () => {
    expect(Object.keys(TOOL_PERMISSION_CELLS).sort()).toEqual([...RULED_TOOLS].sort());
  });

  it("every action kind has its cells, and every cell is a Write verb", () => {
    expect(Object.keys(ACTION_PERMISSION_CELLS).sort()).toEqual([...ACTION_KINDS].sort());
    for (const kind of ACTION_KINDS) {
      // connection_call alone fills none: a connection is its own row, and its Ask First tools carry the ⏱ there (T4-9)
      if (kind === "connection_call") expect(ACTION_PERMISSION_CELLS[kind], kind).toEqual([]);
      else expect(ACTION_PERMISSION_CELLS[kind].length, kind).toBeGreaterThan(0);
      for (const c of ACTION_PERMISSION_CELLS[kind]) {
        expect(c.column, kind).toBe("write");
        expect(typeof c.entries, kind).toBe("object");
      }
    }
  });

  it("every placement names a resource of the table, and exactly propose_action gates the actions", () => {
    const actions: string[] = [];
    for (const [name, pl] of Object.entries(TOOL_PERMISSION_CELLS)) {
      if (pl.placement === "cell") expect(PERMISSION_RESOURCES, name).toContain(pl.cell.resource);
      if (pl.placement === "actions") actions.push(name);
      if (pl.placement === "none") expect(pl.why.length, name).toBeGreaterThan(20);
    }
    expect(actions).toEqual(["propose_action"]);
  });

  it("is docs/ops/actors.md's table, row for row: the same tools and actions, each in the same cell with the same key and label", () => {
    const doc = readFileSync(join(import.meta.dirname, "..", "..", "..", "docs", "ops", "actors.md"), "utf8");
    const start = doc.indexOf("| Tool or action | Row · column | Entry key → label |");
    expect(start, "the mapping table is missing from docs/ops/actors.md").toBeGreaterThan(-1);
    const lines = doc.slice(start).split("\n").slice(2);
    const seen = new Map<string, string>();
    for (const line of lines) {
      if (!line.startsWith("|")) break;
      const [who, where, what] = line.split(" | ").map((c) => c.replace(/^\|\s*|\s*\|$/g, ""));
      const action = who!.startsWith("action ");
      const cells = [...where!.matchAll(/(Knowledge|Work|Artifacts|Inbox|Queries|Agents) · (Read|Write)/g)].map((m) => `${RESOURCE_OF_WORD[m[1]!]}.${m[2]!.toLowerCase()}`);
      const verb = /`([a-z_*/]+)` → \*([^*]+)\*/.exec(what ?? "");
      for (const m of who!.matchAll(/`([a-z_]+)`/g)) {
        const name = m[1]!;
        const key = action ? `action ${name}` : name;
        expect(seen.has(key), `${key} appears twice in the document's table`).toBe(false);
        if (action) {
          const code = ACTION_PERMISSION_CELLS[name as (typeof ACTION_KINDS)[number]];
          expect(code, key).toBeDefined();
          expect(code.map((c) => `${c.resource}.${c.column}`), key).toEqual(cells);
          for (const c of code) if (typeof c.entries === "object") expect([c.entries.key, c.entries.label], key).toEqual([verb?.[1], verb?.[2]]);
          seen.set(key, where!);
          continue;
        }
        const pl = TOOL_PERMISSION_CELLS[name];
        expect(pl, `${name} is in the document but has no placement in code`).toBeDefined();
        if (/not in the table/.test(where!)) expect(pl!.placement, name).toBe("none");
        else if (/none of its own/.test(where!)) expect(pl!.placement, name).toBe("actions");
        else {
          expect(pl!.placement, name).toBe("cell");
          if (pl!.placement !== "cell") continue;
          expect([`${pl!.cell.resource}.${pl!.cell.column}`], name).toEqual(cells);
          if (typeof pl!.cell.entries === "object") expect([pl!.cell.entries.key, pl!.cell.entries.label], name).toEqual([verb?.[1], verb?.[2]]);
        }
        seen.set(key, where!);
      }
    }
    // …and the document covers every ruled tool and every action kind, exactly once each.
    expect([...seen.keys()].filter((k) => !k.startsWith("action ")).sort()).toEqual([...RULED_TOOLS].sort());
    expect([...seen.keys()].filter((k) => k.startsWith("action ")).map((k) => k.slice(7)).sort()).toEqual([...ACTION_KINDS].sort());
  });

  it("the row labels come in the table's resource order", () => {
    expect(Object.keys(PERMISSION_RESOURCE_LABEL)).toEqual([...PERMISSION_RESOURCES]);
  });
});

// ---------------------------------------------------------------------------
// The rendering
// ---------------------------------------------------------------------------

describe("describePermissions — the table renders may(), never repeats it", () => {
  it("Knowledge Write never appears for a non-assistant role — however wide the grant", () => {
    for (const role of ROLES.filter((r) => r !== "assistant" && r !== "owner")) {
      for (const scope of [WIDE_SCOPE, { ...WIDE_SCOPE, areas: ["/"] }, { ...WIDE_SCOPE, areas: null }]) {
        const rows = describePermissions(principal(role, scope));
        expect(row(rows, "knowledge")?.write ?? [], `${role} ${JSON.stringify(scope.areas)}`).toEqual([]);
      }
    }
    // the one writer
    expect(keys(describePermissions(principal("assistant", { ...WIDE_SCOPE, areas: ["/"] })), "knowledge", "write")).toEqual(["/"]);
  });

  it("a crew never has a Queries or an Agents row, even holding `queries` and every group; an external agent may have Queries, never Agents", () => {
    const crew = describePermissions(principal("crew"));
    expect(row(crew, "queries")).toBeUndefined();
    expect(row(crew, "agents")).toBeUndefined();
    const agent = describePermissions(principal("agent"));
    expect(keys(agent, "queries", "read")).toEqual(["named"]);
    expect(row(agent, "agents")).toBeUndefined();
    expect(keys(describePermissions(principal("assistant")), "agents", "write")).toEqual(["delegate"]);
  });

  it("null and [] render differently: the whole vault vs. no Knowledge entry; all tasks vs. no Work entry", () => {
    const whole = describePermissions(principal("assistant", { tier: "areas", areas: null, queries: false, projects: null }));
    expect(row(whole, "knowledge")!.read).toEqual([{ key: "/", label: "The whole vault", asks: false, provenance: { kind: "base", source: "environment" } }]);
    expect(row(whole, "work")!.read).toEqual([{ key: "*", label: "All tasks", asks: false, provenance: { kind: "base", source: "environment" } }]);
    expect(row(whole, "artifacts")!.read.map((e) => e.label)).toEqual(["All"]);

    const none = describePermissions(principal("assistant", { tier: "areas", areas: [], queries: false, projects: [] }));
    expect(row(none, "knowledge")).toBeUndefined();
    expect(row(none, "work")).toBeUndefined();
    expect(row(none, "artifacts")).toBeUndefined();

    // …and the bare vault spelled as a grant (`/`) is the whole vault too, never a folder named "/"
    const slash = describePermissions(principal("assistant", { tier: "areas", areas: ["/", "Areas/Fsl"], queries: false, projects: [] }));
    expect(row(slash, "knowledge")!.read.map((e) => e.label)).toEqual(["The whole vault"]);
  });

  it("writes never exceed reads, and an area the write door refuses outright is not drawn as writable", () => {
    const rows = describePermissions(principal("assistant", { tier: "areas", areas: ["Areas/Fsl", "Me/Health"], queries: false, projects: [] }));
    expect(keys(rows, "knowledge", "read")).toEqual(["Areas/Fsl", "Me/Health"]);
    expect(keys(rows, "knowledge", "write")).toEqual(["Areas/Fsl"]); // Me/ is the owner's own: one writer, and it is not this one
  });

  it("says each area verbatim, and a titles-only tier as that", () => {
    const areas = describePermissions(principal("agent", { tier: "areas", areas: ["Areas/Health", "Projects/Metistry"], queries: false, projects: [] }));
    expect(row(areas, "knowledge")!.read.map((e) => [e.key, e.label])).toEqual([["Areas/Health", "Areas/Health"], ["Projects/Metistry", "Projects/Metistry"]]);
    const titles = describePermissions(principal("agent", { tier: "index", areas: [], queries: false, projects: [] }));
    expect(row(titles, "knowledge")!.read.map((e) => [e.key, e.label])).toEqual([["titles", "Titles only"]]);
    const nothing = describePermissions(principal("agent", { tier: "none", areas: [], queries: false, projects: [] }));
    expect(nothing.map((r) => r.label)).toEqual(["Inbox"]); // capture is open to every credential
  });

  it("a verb reached two ways asks only if every way asks; an action alone asks at `propose`", () => {
    const propose = { level: "propose" as const };
    const member = describePermissions(principal("agent", { ...WIDE_SCOPE, autonomy: propose }));
    const work = row(member, "work")!.write;
    expect(work.map((e) => [e.key, e.asks])).toEqual([["create", false], ["update", false], ["comment", false], ["dispatch", true]]);
    // no project: the task tools find nothing, so the verbs come only from the actions — and ask
    const outsider = describePermissions(principal("agent", { ...WIDE_SCOPE, projects: [], autonomy: propose }));
    expect(row(outsider, "work")!.write.map((e) => [e.key, e.asks])).toEqual([["update", true], ["comment", true], ["dispatch", true]]);
    expect(row(outsider, "work")!.read).toEqual([]);
    expect(row(outsider, "artifacts")!.write.map((e) => [e.key, e.asks])).toEqual([["comment", true]]);
    expect(row(outsider, "inbox")!.write.map((e) => [e.key, e.asks])).toEqual([["capture", false]]); // the tool is direct; it never asks
    // observe: no action verbs at all
    const observer = describePermissions(principal("agent", { ...WIDE_SCOPE, projects: [], autonomy: { level: "observe" } }));
    expect(row(observer, "work")).toBeUndefined();
  });

  it("marks approved areas with their request, and nothing else", () => {
    const rows = describePermissions(principal("agent", { ...WIDE_SCOPE, areas: ["Areas/Health", "Areas/Finance"] }), {
      history: { approved: [{ area: "Areas/Finance", proposalId: 311 }, { area: "Areas/Gone", proposalId: 12 }], routines: [] },
    });
    expect(row(rows, "knowledge")!.read.map((e) => [e.key, e.provenance])).toEqual([
      ["Areas/Health", { kind: "base", source: "registry" }],
      ["Areas/Finance", { kind: "approved", proposalId: 311 }],
    ]);
  });

  it("draws a routine's per-run read grant only where the read tools would admit it, one entry per (area, routine)", () => {
    const history = { approved: [], routines: [{ routine: "morning-brief", areas: ["Areas/Finance", "Areas/Health"] }, { routine: "weekly", areas: ["Areas/Finance"] }] };
    const reader = principal("crew", { ...WIDE_SCOPE, areas: ["Areas/Health"] }, { uses: ["knowledge"] });
    const read = row(describePermissions(reader, { history }), "knowledge")!.read;
    expect(read.map((e) => [e.key, e.provenance])).toEqual([
      ["Areas/Health", { kind: "base", source: { manifest: ".metistry/agents/research/scout.md" } }],
      ["Areas/Finance", { kind: "routine", routine: "morning-brief" }],
      ["Areas/Finance", { kind: "routine", routine: "weekly" }],
    ]);
    // a crew without `knowledge` in `uses` could not read it even with the grant applied
    const blind = principal("crew", { ...WIDE_SCOPE, tier: "none", areas: [] }, { uses: ["requests"] });
    expect(row(describePermissions(blind, { history }), "knowledge")).toBeUndefined();
    // a per-run grant never reaches Write
    expect(row(describePermissions(reader, { history }), "knowledge")!.write).toEqual([]);
  });

  it("draws a connection per name, its tools by group and mode — off is absent, ask asks, none known is no row", () => {
    const rows = describePermissions(principal("agent"), {
      connections: [
        "unknown-yet",
        { name: "linear", tools: [{ name: "list_issues", group: "reads", mode: "on" }, { name: "create_issue", group: "changes", mode: "ask" }, { name: "delete_issue", group: "changes", mode: "off" }] },
        { name: "calendar", tools: [{ name: "events", group: "reads", mode: "ask" }] },
      ],
    });
    const conns = rows.filter((r) => r.resource.kind === "connection");
    expect(conns.map((r) => r.label)).toEqual(["calendar", "linear"]);
    expect(conns[1]!.read.map((e) => [e.key, e.asks])).toEqual([["list_issues", false]]);
    expect(conns[1]!.write.map((e) => [e.key, e.asks])).toEqual([["create_issue", true]]);
    expect(conns[0]!.read.map((e) => [e.key, e.asks])).toEqual([["events", true]]);
    // after the six resources, never among them
    expect(rows.findIndex((r) => r.resource.kind === "connection")).toBe(rows.length - 2);
  });

  it("**a connection row is reached Through Metistry** (T4-10): every entry says so, and only a connection `may()` admits is drawn — the assistant's every one, a borrower's the offered and granted", () => {
    const tools = [{ name: "list_issues", group: "reads" as const, mode: "on" as const }];
    const all = [
      { name: "gh", offered: true, tools },
      { name: "private", offered: false, tools },
      { name: "cal", offered: true, tools },
    ];
    const lent: Scope = { ...WIDE_SCOPE, connections: ["gh", "private"] };
    const names = (p: Principal) => describePermissions(p, { connections: all }).filter((r) => r.resource.kind === "connection").map((r) => r.label);
    expect(names(principal("assistant"))).toEqual(["cal", "gh", "private"]);
    // offered AND granted: `private` is granted but not offered, `cal` offered but not granted
    expect(names(principal("agent", lent))).toEqual(["gh"]);
    // a crew needs its `connections` group too
    expect(names(principal("crew", lent))).toEqual(["gh"]);
    expect(names(principal("crew", lent, { uses: ALL_GROUPS.filter((g) => g !== "connections") }))).toEqual([]);
    expect(names(principal("tool", lent))).toEqual([]);
    const gh = describePermissions(principal("agent", lent), { connections: all }).find((r) => r.label === "gh")!;
    expect(gh.read.map((e) => e.provenance)).toEqual([{ kind: "proxy" }]);
    // said once, by the row's ⧉ — never repeated on every tool
    expect(permissionRowText(gh)).toEqual(["gh ⧉", "list_issues", "—"]);
    expect(PERMISSION_CONNECTION_WORDS).toBe("reached through Metistry");
  });

  it("every entry is backed by a door that says yes — for every role, widest and narrowest", () => {
    const narrow: Scope = { tier: "none", areas: [], queries: false, projects: [] };
    for (const role of ROLES.filter((r) => r !== "owner")) {
      for (const p of [principal(role), principal(role, narrow, role === "crew" ? { uses: [] } : {})]) {
        for (const r of describePermissions(p)) {
          for (const column of ["read", "write"] as const) {
            for (const e of r[column]) {
              const tools = Object.entries(TOOL_PERMISSION_CELLS).filter(([, pl]) => pl.placement === "cell" && pl.cell.resource === r.resource.kind && pl.cell.column === column).map(([n]) => n);
              const actions = ACTION_KINDS.filter((k) => ACTION_PERMISSION_CELLS[k].some((c) => c.resource === r.resource.kind && c.column === column && typeof c.entries === "object" && c.entries.key === e.key));
              const backed =
                tools.some((n) => may(p, "act", { kind: "tool", name: n }).ok) ||
                (may(p, "act", { kind: "tool", name: "propose_action" }).ok && actions.some((k) => may(p, "act", { kind: "action", door: "propose_action", action: k }).ok));
              expect(backed, `${role}: ${r.label} · ${column} · ${e.key}`).toBe(true);
            }
          }
        }
        // and nothing held has no row: an admitted, drawable tool is on the table
        for (const [name, pl] of Object.entries(TOOL_PERMISSION_CELLS)) {
          if (pl.placement !== "cell" || !may(p, "act", { kind: "tool", name }).ok) continue;
          if (pl.projectScoped && p.scope.projects !== null && p.scope.projects.length === 0) continue;
          if (pl.cell.entries === "areas" && (p.scope.tier === "none" || (pl.cell.column === "write" && p.scope.tier !== "areas"))) continue;
          expect(row(describePermissions(p), pl.cell.resource)?.[pl.cell.column].length ?? 0, `${role}: ${name} is admitted but not drawn`).toBeGreaterThan(0);
        }
      }
    }
  });

  it("holds nothing: [] — a capture token with no grant still has the inbox, which every credential has", () => {
    const tool = describePermissions(principal("tool", { tier: "none", areas: [], queries: false, projects: [] }));
    expect(tool.map((r) => [r.label, r.write.map((e) => e.key)])).toEqual([["Inbox", ["capture"]]]);
    // a crew whose manifest names no groups holds no tools, so nothing at all
    expect(describePermissions(principal("crew", WIDE_SCOPE, { uses: [] }))).toEqual([]);
  });
});

describe("the table in words — the one way a cell is said", () => {
  it("prints label · read · write, a dash for absence, ⏱ for asking first, the provenance where it is not the base, ⧉ on a connection", () => {
    const rows = describePermissions(principal("agent", { ...WIDE_SCOPE, areas: ["Areas/Health", "Areas/Finance"], projects: [], autonomy: { level: "propose" } }), {
      history: { approved: [{ area: "Areas/Finance", proposalId: 311 }], routines: [{ routine: "morning-brief", areas: ["Areas/Ops"] }] },
      connections: [{ name: "linear", tools: [{ name: "create_issue", group: "changes", mode: "ask" }] }],
    });
    expect(rows.map(permissionRowText)).toEqual([
      ["Knowledge", "Areas/Health, Areas/Finance (approved in Needs You · #311), Areas/Ops (during morning-brief only)", "—"],
      ["Work", "—", "Update ⏱, Comment ⏱, Dispatch ⏱"],
      ["Artifacts", "—", "Comment ⏱"],
      ["Inbox", "—", "Capture"],
      ["Queries", "Named queries", "—"],
      ["linear ⧉", "—", "create_issue ⏱"],
    ]);
  });
});
