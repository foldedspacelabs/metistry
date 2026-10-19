// X-131: what an agent is handed about the owner's earlier sessions in a
// repository (Context Mode Q3, 2026-10-04). No database: the named-query
// runner is a stub that plays recent_sessions the way the SQL does, so these
// tests hold the CALLER's half of the rule — and the rule that no
// agent-written reply is ever returned as text.
import { describe, expect, it } from "vitest";
import {
  FIRST_PROMPT_CHARS,
  MAX_FILES,
  SESSION_HANDLE_KEYS,
  callerInProjectOf,
  projectSlugForPage,
  recentSessionsForCaller,
  selectSessionHandles,
  toSessionHandle,
  type NamedQueryRunner,
} from "../src/index.js";

const row = (over: Record<string, unknown> = {}) => ({
  path: "Inbox/claude-code-session-a.md",
  date: new Date("2026-10-17T10:00:00Z"),
  tool: "claude-code",
  repo: "metistry",
  branch: "main",
  turns: 3,
  files: ["src/a.ts", "src/b.ts"],
  first_prompt: "Fix the loader test",
  folded: true,
  ...over,
});

/** A stub of the two named queries: records every call; honours `unfolded` the way the SQL does. */
function stub(opts: { projectPage?: string | null; rows: Record<string, unknown>[] }) {
  const calls: { name: string; params: Record<string, string | number | boolean> }[] = [];
  const run: NamedQueryRunner = async (name, params) => {
    calls.push({ name, params });
    if (name === "project_for_repo") return opts.projectPage ? [{ path: opts.projectPage, title: "T", description: null, remote: "x" }] : [];
    if (name === "recent_sessions") return opts.rows.filter((r) => r.folded === true || params.unfolded === true);
    throw new Error(`unexpected query ${name}`);
  };
  return { run, calls };
}

const FOLDED = row();
const WAITING = row({ path: "Inbox/claude-code-session-b.md", first_prompt: "STILL-WAITING-FOR-THE-FOLD", folded: false });

describe("projectSlugForPage", () => {
  it("is the project page's file name as a slug, and nothing else", () => {
    expect(projectSlugForPage("Projects/Metistry.md")).toBe("metistry");
    expect(projectSlugForPage("Projects/Drey Mascot.md")).toBe("drey-mascot");
    for (const no of ["Projects/Drey/Notes.md", "Areas/Metistry.md", "Projects/.md", "Projects/123.md", "Projects/Metistry.txt", "", null, undefined]) {
      expect(projectSlugForPage(no as string), String(no)).toBeNull();
    }
  });
  it("matches a caller only when both sides name a project", () => {
    expect(callerInProjectOf("Projects/Metistry.md", ["metistry"])).toBe(true);
    expect(callerInProjectOf("Projects/Metistry.md", ["other"])).toBe(false);
    expect(callerInProjectOf("Projects/Metistry.md", [])).toBe(false);
    expect(callerInProjectOf(null, ["metistry"])).toBe(false);
    expect(callerInProjectOf("Projects/Drey/Notes.md", ["drey"])).toBe(false);
  });
});

describe("recentSessionsForCaller", () => {
  it("an unfolded session never reaches an agent outside its project", async () => {
    // not a member of the project the repository maps to
    const outside = stub({ projectPage: "Projects/Metistry.md", rows: [FOLDED, WAITING] });
    const got = await recentSessionsForCaller(outside.run, { repo: "metistry", remote: "github.com/o/metistry", callerProjects: ["drey"] });
    expect(got.map((h) => h.path)).toEqual([FOLDED.path]);
    expect(JSON.stringify(got)).not.toContain("STILL-WAITING");
    expect(outside.calls.find((c) => c.name === "recent_sessions")!.params.unfolded).toBe(false);

    // no project at all for the repository, or two pages claim it (both: project_for_repo answers no row)
    const unmapped = stub({ projectPage: null, rows: [FOLDED, WAITING] });
    expect((await recentSessionsForCaller(unmapped.run, { repo: "metistry", remote: "github.com/o/metistry", callerProjects: ["metistry"] })).map((h) => h.path)).toEqual([FOLDED.path]);
    // the caller sent no remote: no project can be proved
    const noRemote = stub({ projectPage: "Projects/Metistry.md", rows: [FOLDED, WAITING] });
    expect((await recentSessionsForCaller(noRemote.run, { repo: "metistry", callerProjects: ["metistry"] })).map((h) => h.path)).toEqual([FOLDED.path]);
    expect(noRemote.calls.map((c) => c.name)).toEqual(["recent_sessions"]);
    // a caller with no projects
    const nobody = stub({ projectPage: "Projects/Metistry.md", rows: [FOLDED, WAITING] });
    expect((await recentSessionsForCaller(nobody.run, { repo: "metistry", remote: "github.com/o/metistry", callerProjects: [] })).map((h) => h.path)).toEqual([FOLDED.path]);
  });

  it("an agent in the same project is also handed the sessions still waiting for the fold", async () => {
    const inside = stub({ projectPage: "Projects/Metistry.md", rows: [FOLDED, WAITING] });
    const got = await recentSessionsForCaller(inside.run, { repo: "metistry", remote: "github.com/o/metistry", callerProjects: ["metistry", "drey"] });
    expect(got.map((h) => [h.path, h.folded])).toEqual([[FOLDED.path, true], [WAITING.path, false]]);
  });

  it("drops an unfolded row the query returned anyway (a widened query or overlay is not a way past the rule)", async () => {
    const run: NamedQueryRunner = async (name) => (name === "recent_sessions" ? [WAITING, FOLDED] : []);
    const got = await recentSessionsForCaller(run, { repo: "metistry", remote: "github.com/o/metistry", callerProjects: ["metistry"] });
    expect(got.map((h) => h.path)).toEqual([FOLDED.path]); // no project page resolved: not allowed
  });

  it("blank repo asks nothing; the grant narrows both arms", async () => {
    const s = stub({ projectPage: "Projects/Metistry.md", rows: [FOLDED, WAITING] });
    expect(await recentSessionsForCaller(s.run, { repo: "  ", remote: "github.com/o/metistry", callerProjects: ["metistry"] })).toEqual([]);
    expect(s.calls).toEqual([]);
    const got = await recentSessionsForCaller(s.run, { repo: "metistry", remote: "github.com/o/metistry", callerProjects: ["metistry"], canSee: (p) => p === FOLDED.path });
    expect(got.map((h) => h.path)).toEqual([FOLDED.path]);
  });
});

describe("no agent-written reply is returned as text", () => {
  it("copies a fixed list of fields — a row carrying the agent's reply loses it", () => {
    const widened = row({
      last_response: "AGENT-REPLY-TEXT",
      lastAssistant: "AGENT-REPLY-TEXT",
      summary: "AGENT-REPLY-TEXT",
      cwd: "/Users/example/secret",
      session_id: "sid",
    });
    const h = toSessionHandle(widened)!;
    expect(Object.keys(h).sort()).toEqual([...SESSION_HANDLE_KEYS].sort());
    expect(JSON.stringify(h)).not.toContain("AGENT-REPLY-TEXT");
    expect(JSON.stringify(h)).not.toContain("/Users/example/secret");
    expect(JSON.stringify(selectSessionHandles([widened], { allowUnfolded: false }))).not.toContain("AGENT-REPLY-TEXT");
  });

  it("clips the owner's prompt and the file list again, and reads a malformed row as no handle", () => {
    const h = toSessionHandle(row({ first_prompt: "x".repeat(5000), files: Array.from({ length: 500 }, (_, i) => `f${i}.ts`) }))!;
    expect(h.first_prompt.length).toBeLessThanOrEqual(FIRST_PROMPT_CHARS);
    expect(h.files).toHaveLength(MAX_FILES);
    for (const bad of [{}, row({ path: 5 }), row({ tool: null }), row({ date: null })]) expect(toSessionHandle(bad as Record<string, unknown>)).toBeNull();
    expect(toSessionHandle(row({ turns: null, branch: null, files: "nope", folded: undefined }))).toMatchObject({ turns: null, branch: null, files: [], folded: false });
  });
});
