// `GET /api/commands`'s derivation, on its own. The rule under test is not
// "does it produce a list" — it is **what it refuses to guess**: a
// `fast_path` rule is a regex, most regexes are sentences rather than
// commands, and a menu that invented `/what` out of `^what's my status` would
// offer the user something the router does not route.
import { describe, expect, it } from "vitest";
import { agentList, commandList, literalCommands } from "../src/commands.js";
import { loadRules } from "../src/router.js";

const rules = (body: string) =>
  loadRules(
    `${body}
tiers:
  fast:    { model: haiku, effort: low }
  default: { model: haiku, effort: medium }
  deep:    { model: opus,  effort: high }
commands:
  deep_alias: deep
`,
  );

describe("literalCommands: only the two shapes that are unambiguous", () => {
  it("reads a single literal command, with or without a boundary", () => {
    expect(literalCommands("^/status")).toEqual({ names: ["/status"], takes_argument: false });
    expect(literalCommands("^/status\\b")).toEqual({ names: ["/status"], takes_argument: false });
    expect(literalCommands("^\\/status\\b")).toEqual({ names: ["/status"], takes_argument: false });
    expect(literalCommands("^/open-work\\b")).toEqual({ names: ["/open-work"], takes_argument: false });
  });

  it("reads an alternation of literals, sorted and de-duplicated", () => {
    expect(literalCommands("^/(status|open)\\b")).toEqual({ names: ["/open", "/status"], takes_argument: false });
    expect(literalCommands("^/(open|open|status)")).toEqual({ names: ["/open", "/status"], takes_argument: false });
  });

  it("marks a command that needs text after it", () => {
    expect(literalCommands("^/note\\s+([\\s\\S]+)$")).toEqual({ names: ["/note"], takes_argument: true });
  });

  // The whole point. Each of these MATCHES real messages; none of them is a
  // command anybody types, and none may appear in a menu.
  it("yields nothing for a rule that is a sentence, a character class, or an optional group", () => {
    for (const pattern of [
      "^what('| i)?s (my |the )?(status|open work|workload)\\b",
      "^/s[ua]m", //          two spellings — we will not pick one
      "^/st(at)?us", //       a nested optional group is not one word
      "^/(status|open work)", // a branch with a space is not a command
      "^/(status|[a-z]+)", //  one unreadable branch poisons the whole rule
      "status$", //           not anchored at a slash at all
      "^/", //                no name
      "", //                  nothing
    ]) {
      expect(literalCommands(pattern), pattern).toEqual({ names: [], takes_argument: false });
    }
  });
});

describe("commandList: the router's own three, plus what rules.yaml spells", () => {
  const describeQuery = (name: string) => (name === "open_work" ? "Work items not yet closed, newest first" : undefined);

  it("lists /note, the deep alias and /model from the router, never from a literal here", () => {
    const list = commandList(rules("fast_path: []"), describeQuery);
    expect(list.map((c) => c.id)).toEqual(["/deep", "/model", "/note"]); // alphabetical: deterministic order
    expect(list.find((c) => c.id === "/note")).toMatchObject({ routes_to: "note", tier: null, model: null, takes_argument: true });
    expect(list.find((c) => c.id === "/deep")).toMatchObject({ routes_to: "model_override", tier: "deep", model: "opus", effort: "high" });
    expect(list.find((c) => c.id === "/model")?.description).toContain("deep, default, fast");
  });

  it("follows the instance's own deep_alias rather than the word 'deep'", () => {
    const list = commandList(
      loadRules(`fast_path: []
tiers:
  default: { model: haiku, effort: medium }
  deep:    { model: opus,  effort: high }
commands:
  deep_alias: think
`),
      describeQuery,
    );
    expect(list.map((c) => c.id)).toContain("/think");
    expect(list.map((c) => c.id)).not.toContain("/deep");
  });

  it("takes a fast path's description from the named query, so nothing is kept in sync by hand", () => {
    const list = commandList(rules('fast_path:\n  - { match: "^/(status|open)\\\\b", query: open_work }'), describeQuery);
    expect(list.find((c) => c.id === "/status")).toMatchObject({
      routes_to: "fast_path",
      query: "open_work",
      description: "Work items not yet closed, newest first",
      tier: null,
    });
    expect(list.find((c) => c.id === "/open")?.query).toBe("open_work");
  });

  it("says so when the query a rule names is not loaded — rather than describing it anyway", () => {
    const list = commandList(rules('fast_path:\n  - { match: "^/ghost", query: not_loaded }'), describeQuery);
    expect(list.find((c) => c.id === "/ghost")?.description).toContain("not loaded in this deployment");
  });

  it("gives first-match-wins to the router's rules, as the router does", () => {
    const list = commandList(
      rules('fast_path:\n  - { match: "^/open", query: open_work }\n  - { match: "^/open", query: board }'),
      describeQuery,
    );
    expect(list.filter((c) => c.id === "/open")).toHaveLength(1);
    expect(list.find((c) => c.id === "/open")?.query).toBe("open_work");
  });

  it("is stable and alphabetical whatever order the rules are in", () => {
    const a = commandList(rules('fast_path:\n  - { match: "^/zulu", query: open_work }\n  - { match: "^/alpha", query: open_work }'), describeQuery);
    const b = commandList(rules('fast_path:\n  - { match: "^/alpha", query: open_work }\n  - { match: "^/zulu", query: open_work }'), describeQuery);
    expect(a.map((c) => c.id)).toEqual(b.map((c) => c.id));
    expect(a.map((c) => c.id)).toEqual(["/alpha", "/deep", "/model", "/note", "/zulu"]);
  });

  it("carries the tier map in force, so a compute.yaml reassignment shows without a restart", () => {
    const r = rules("fast_path: []");
    r.tiers = { ...r.tiers, deep: { model: "openrouter/anthropic/claude-opus-4", effort: "high" } };
    expect(commandList(r, describeQuery).find((c) => c.id === "/deep")?.model).toBe("openrouter/anthropic/claude-opus-4");
  });
});

describe("agentList: the registry, with presence", () => {
  const rows = [
    { id: "drey", display_name: "Drey", kind: "external", last_seen_at: new Date("2026-09-18T10:00:00Z") },
    { id: "ops-bot", kind: "external", last_seen_at: null },
    { id: "gone", kind: "external", revoked: true, last_seen_at: new Date() },
    { id: "waiting", kind: "external", pending: true, last_seen_at: new Date() },
  ];

  it("drops revoked rows, marks presence from a real authentication, and sorts by id", () => {
    expect(agentList(rows)).toEqual([
      { id: "@drey", description: "Drey", kind: "external", present: true, last_seen_at: "2026-09-18T10:00:00.000Z" },
      { id: "@ops-bot", description: "external", kind: "external", present: false, last_seen_at: null },
      { id: "@waiting", description: "external", kind: "external", present: false, last_seen_at: expect.any(String) },
    ]);
  });

  // S2: a pending enrolment authenticates nothing until the owner approves
  // it, so the composer must not show it as reachable.
  it("never calls a pending enrolment present, even when it has a last_seen_at", () => {
    expect(agentList(rows).find((a) => a.id === "@waiting")?.present).toBe(false);
  });
});
