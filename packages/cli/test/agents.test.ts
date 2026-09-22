// `metistry agents autonomy` (docs/ops/actions.md). One of exactly two doors a
// WIDENING may come through, so what it refuses and what it preserves matter
// more than what it prints: an unknown kind never reaches the console, and
// setting one kind never erases the §4.21 narrowing sitting beside it.
import { describe, expect, it } from "vitest";
import { agentAutonomy, agentsList, isEmptyChange, mergeAutonomy, parseAutonomyFlags, renderAgents, renderAutonomy } from "../src/agents.js";
import { createUi } from "../src/ui.js";

const env = { METISTRY_LOCAL_OWNER_TOKEN: "owner-token-value", METISTRY_CONSOLE_URL: "http://127.0.0.1:9" } as NodeJS.ProcessEnv;

describe("parseAutonomyFlags", () => {
  it("reads repeated and comma-separated kinds — the shared parser keeps only the last of a repeated flag", () => {
    expect(parseAutonomyFlags(["agents", "autonomy", "r", "--allow", "comment", "--allow", "capture"])).toEqual({
      actions: { comment: "allow", capture: "allow" },
    });
    expect(parseAutonomyFlags(["--allow", "comment,capture", "--deny", "dispatch", "--level", "act_within_scope"])).toEqual({
      level: "act_within_scope",
      actions: { comment: "allow", capture: "allow", dispatch: "deny" },
    });
    expect(parseAutonomyFlags(["--level=propose", "--propose=task_update"])).toEqual({ level: "propose", actions: { task_update: "propose" } });
    // last mention of one kind wins, which is the only sane reading of `--allow x --deny x`
    expect(parseAutonomyFlags(["--allow", "comment", "--deny", "comment"]).actions).toEqual({ comment: "deny" });
  });

  it("refuses an unknown kind or level with the closed list, and never falls back silently", () => {
    expect(() => parseAutonomyFlags(["--allow", "send_email"])).toThrow(/unknown action kind "send_email"/);
    expect(() => parseAutonomyFlags(["--level", "autonomous"])).toThrow(/--level must be one of/);
    expect(() => parseAutonomyFlags(["--allow"])).toThrow(/--allow needs a value/);
    expect(() => parseAutonomyFlags(["--allow", "--json"])).toThrow(/--allow needs a value/);
  });

  it("no flags is a read", () => {
    expect(isEmptyChange(parseAutonomyFlags(["agents", "autonomy", "researcher", "--json"]))).toBe(true);
    expect(isEmptyChange(parseAutonomyFlags(["--deny", "dispatch"]))).toBe(false);
  });
});

describe("mergeAutonomy", () => {
  it("keeps every key this command does not own — a kind change must not drop a narrowing", () => {
    const stored = { may_dispatch_to: ["helper"], max_open_bundles: 2, level: "propose" as const, actions: { dispatch: "deny" as const } };
    expect(mergeAutonomy(stored, { actions: { comment: "allow" } })).toEqual({
      may_dispatch_to: ["helper"],
      max_open_bundles: 2,
      level: "propose",
      actions: { dispatch: "deny", comment: "allow" },
    });
  });

  it("adds nothing when nothing was asked for", () => {
    expect(mergeAutonomy({ max_open_bundles: 1 }, { actions: {} })).toEqual({ max_open_bundles: 1 });
  });
});

describe("agentAutonomy", () => {
  /** A console that answers the two calls this command makes, and records what it was sent. */
  function fakeConsole(stored: Record<string, unknown>) {
    const sent: { path: string; body: unknown; auth: string | undefined }[] = [];
    const fetchFn = (async (url: string | URL, init?: RequestInit) => {
      const path = String(url).replace("http://127.0.0.1:9", "");
      const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
      sent.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined, auth });
      if (path === "/api/agents") {
        return new Response(JSON.stringify({ agents: [{ id: "researcher", display_name: "Researcher", autonomy: stored }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, widened: ["level observe → propose"] }), { status: 200 });
    }) as unknown as typeof fetch;
    return { fetchFn, sent };
  }

  it("shows the RESOLVED table without writing anything", async () => {
    const { fetchFn, sent } = fakeConsole({ level: "act_within_scope" });
    const v = await agentAutonomy("researcher", { actions: {} }, { env, fetchFn });
    expect(sent.map((s) => s.path)).toEqual(["/api/agents"]); // a read is a read
    expect(v.actions).toEqual({ dispatch: "propose", task_update: "allow", comment: "allow", capture: "allow" });
    expect(v.widened).toEqual([]);
    // "propose" is now said as "Ask First" (C46/C47's designer wording), and
    // this row is defaulted — nothing in the record named `dispatch` — so it
    // says that too, not just colour (docs/ops/cli-style.md rule 1).
    expect(renderAutonomy(v)).toContain("dispatch     Ask First (default for act_within_scope)");
  });

  it("carries WHY beside the table (C46/C47): set, defaulted, or clamped — the one place downstream reads it, rather than recomputing", async () => {
    const { fetchFn } = fakeConsole({ level: "propose", actions: { comment: "allow", task_update: "propose" } });
    const v = await agentAutonomy("researcher", { actions: {} }, { env, fetchFn });
    // nothing named it: the level's own default
    expect(v.actionsDetailed.dispatch).toEqual({ mode: "propose", source: "defaulted", ceiling: "propose" });
    // named, and it survives the ceiling unchanged
    expect(v.actionsDetailed.task_update).toEqual({ mode: "propose", source: "set", ceiling: "propose", asked: "propose" });
    // named ABOVE the ceiling — the only case where the owner's own setting is overridden
    expect(v.actionsDetailed.comment).toEqual({ mode: "propose", source: "clamped", ceiling: "propose", asked: "allow" });
    const text = renderAutonomy(v);
    expect(text).toContain("dispatch     Ask First (default for propose)");
    expect(text).toContain("task_update  Ask First");
    expect(text).not.toContain("task_update  Ask First ("); // `set` is plain — no parenthetical
    expect(text).toContain("comment      Ask First (asked Allow — propose's ceiling is Ask First)");
  });

  it("merges onto the stored record and PUTs the whole thing, with the owner token in the header and nowhere else", async () => {
    const { fetchFn, sent } = fakeConsole({ max_open_bundles: 2 });
    const v = await agentAutonomy("researcher", parseAutonomyFlags(["--level", "propose", "--deny", "dispatch"]), { env, fetchFn });
    const put = sent.find((s) => s.path.endsWith("/autonomy"))!;
    expect(put.body).toEqual({ max_open_bundles: 2, level: "propose", actions: { dispatch: "deny" } });
    expect(put.auth).toBe("Bearer owner-token-value");
    expect(JSON.stringify(sent.map((s) => s.path))).not.toContain("owner-token-value");
    expect(v.widened).toEqual(["level observe → propose"]);
    expect(renderAutonomy(v)).toContain("widened");
  });

  it("surfaces the console's own refusal rather than writing a second sentence", async () => {
    const fetchFn = (async (url: string | URL) =>
      String(url).endsWith("/api/agents")
        ? new Response(JSON.stringify({ agents: [{ id: "researcher", display_name: "R", autonomy: {} }] }), { status: 200 })
        : new Response(JSON.stringify({ error: { code: "conflict", message: "researcher's autonomy changed while this change was being checked" } }), { status: 409 })) as unknown as typeof fetch;
    await expect(agentAutonomy("researcher", { level: "propose", actions: {} }, { env, fetchFn })).rejects.toThrow(/changed while this change was being checked/);
  });

  it("refuses an agent that is not registered, or is revoked, before it sends anything", async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ agents: [{ id: "gone", display_name: "G", revoked: true }] }), { status: 200 })) as unknown as typeof fetch;
    await expect(agentAutonomy("researcher", { level: "propose", actions: {} }, { env, fetchFn })).rejects.toThrow(/no agent "researcher"/);
    await expect(agentAutonomy("gone", { level: "propose", actions: {} }, { env, fetchFn })).rejects.toThrow(/revoked/);
  });
});

// ---------------------------------------------------------------------------
// `metistry agents list` (P3 §2.10). The point of the verb is that it renders
// NOTHING of its own: the console sends each row's scope already rendered
// (core's `describeScope`), and the CLI prints it. So what is worth holding
// here is that it prints the server's words, not that it composes good ones.
describe("agents list", () => {
  const SCOPE = {
    id: "researcher",
    role: "agent",
    who: "an agent",
    tier: "areas",
    access: "folders",
    areas: ["Areas/Health"],
    scope: "folders: Areas/Health",
    queries: false,
    projects: ["alpha"],
    uses: null,
    autonomy: { level: "propose", actions: { dispatch: "propose", task_update: "propose", comment: "propose", capture: "propose" } },
    source: "registry",
    from: "the registry — the owner's own hand, durable",
    extras: ["projects: alpha", "autonomy: propose"],
    line: "an agent · folders: Areas/Health · projects: alpha, autonomy: propose",
  };

  const listing = (agents: unknown[], access_requests: unknown[] = []) =>
    (async (url: string | URL, init?: RequestInit) => {
      sent.push({ path: String(url), auth: String((init?.headers as Record<string, string> | undefined)?.authorization ?? "") });
      return new Response(JSON.stringify({ agents, access_requests }), { status: 200 });
    }) as unknown as typeof fetch;
  let sent: { path: string; auth: string }[] = [];

  it("reads the registry over the console, with the owner token in the header and nowhere else", async () => {
    sent = [];
    const rows = await agentsList({
      env,
      fetchFn: listing([{ id: "researcher", display_name: "Researcher", kind: "external", revoked: false, pending: false, last_seen_at: "2026-09-20T10:00:00Z", scope: SCOPE }]),
    });
    expect(sent.map((s) => s.path)).toEqual(["http://127.0.0.1:9/api/agents"]);
    expect(sent[0]!.auth).toBe("Bearer owner-token-value");
    expect(JSON.stringify(sent.map((s) => s.path))).not.toContain("owner-token-value");
    expect(rows).toEqual([expect.objectContaining({ id: "researcher", asked: [] })]);
  });

  it("prints the server's line, verbatim — a second renderer here would be a fifth vocabulary", async () => {
    sent = [];
    const rows = await agentsList({
      env,
      fetchFn: listing(
        [{ id: "researcher", display_name: "Researcher", kind: "external", revoked: false, pending: false, last_seen_at: "2026-09-20T10:00:00Z", scope: SCOPE }],
        [{ agent: "researcher", area: "Areas/Finance", proposal_id: 42 }],
      ),
    });
    const text = renderAgents(rows, createUi({ env: { NO_COLOR: "1" } }));
    expect(text).toContain(SCOPE.line);
    expect(text).toContain("the registry — the owner's own hand, durable");
    expect(text).toContain("seen 2026-09-20");
    expect(text).toContain("asked"); // the ask is visible where the grant is read
    expect(text).toContain("request #42");
  });

  it("says revoked and pending in the closed status vocabulary, and says so when there is nothing", async () => {
    sent = [];
    const rows = await agentsList({
      env,
      fetchFn: listing([
        { id: "gone", display_name: "Gone", kind: "external", revoked: true, pending: false, last_seen_at: null, scope: SCOPE },
        { id: "waiting", display_name: "Waiting", kind: "external", revoked: false, pending: true, last_seen_at: null, scope: SCOPE },
      ]),
    });
    const ui = createUi({ env: { NO_COLOR: "1" } });
    expect(renderAgents(rows, ui)).toContain("revoked");
    expect(renderAgents(rows, ui)).toContain("pending");
    expect(renderAgents([], ui)).toContain("no agents are registered");
  });

  it("says which console refused it rather than printing an empty list", async () => {
    const refused = (async () => new Response("", { status: 401 })) as unknown as typeof fetch;
    await expect(agentsList({ env, fetchFn: refused })).rejects.toThrow(/refused the owner token \(401\)/);
    const down = (async () => {
      throw new Error("ECONNREFUSED owner-token-value");
    }) as unknown as typeof fetch;
    // …and the token never rides out in the error, the way every other verb
    // in this file redacts it.
    await expect(agentsList({ env, fetchFn: down })).rejects.toThrow(/\[redacted\]/);
  });
});
