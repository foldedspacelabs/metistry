// `metistry agents autonomy` (docs/ops/actions.md). One of exactly two doors a
// WIDENING may come through, so what it refuses and what it preserves matter
// more than what it prints: an unknown kind never reaches the console, and
// setting one kind never erases the §4.21 narrowing sitting beside it.
import { describe, expect, it } from "vitest";
import { agentAutonomy, isEmptyChange, mergeAutonomy, parseAutonomyFlags, renderAutonomy } from "../src/agents.js";

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
    expect(renderAutonomy(v)).toContain("dispatch     propose");
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
