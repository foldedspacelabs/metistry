// T7-3b — More in the PWA (screen 18 §1, §5): the More list in the Mac's order,
// and More ▸ Agents — read and granted from the phone, defined on the Mac. The
// permissions table becomes one row per resource with Read and Write lines
// (pwa-reads.test.ts holds its words to the CLI's and the Kit's).
//
// Built first against the recorded `GET /api/agents` fixture (U9).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentHtml, agentListHtml, agentRowHtml, groupAgents, mountMore } from "../web/more.js";
import { control, fakeBrowser } from "./pwa-fake-dom.js";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const AGENTS = JSON.parse(read("../../macos/tests/kit/fixtures/get-api-agents.json")) as { body: { agents: Record<string, unknown>[]; access_requests?: unknown[] } };
const HTML = read("../web/index.html").replace(/<!--[\s\S]*?-->/g, "");
const agents = AGENTS.body.agents as { id: string; kind: string; revoked: boolean }[];

afterEach(() => vi.unstubAllGlobals());

describe("the More list", () => {
  it("Activity and Agents, then Usage and Settings — Scheduled joins when the PWA has it to open (T3-3's route)", () => {
    const more = /<section id="more" hidden>[\s\S]*?<\/section>/.exec(HTML)?.[0] ?? "";
    expect([...more.matchAll(/data-view="([^"]+)"/g)].map((m) => m[1])).toEqual(["feed", "agents", "usage", "settings"]);
    // the client-api table still lists GET /api/scheduled as T3-3's, not served: no row to a view that cannot load
    expect(read("../../../docs/ops/client-api.md")).toMatch(/\| `GET \/api\/scheduled` \|[^\n]*\| T3-3 \|/);
  });
});

describe("More ▸ Agents: Yours and Connected, each a push", () => {
  it("groups the recorded registry: the assistant and helpers are yours; the rest are connected", () => {
    const groups = groupAgents(agents);
    const byName = Object.fromEntries(groups.map(([head, list]) => [head, list.map((a: { id: string }) => a.id)]));
    expect(byName.Yours).toContain("assistant");
    for (const a of agents.filter((x) => x.kind === "external" && !x.revoked)) expect(byName.Connected, a.id).toContain(a.id);
    for (const a of agents.filter((x) => x.revoked)) expect(byName.Revoked, a.id).toContain(a.id);
  });

  it("a row is its presence, its name and its line; what it asked for says so, and where to answer", () => {
    const row = agentRowHtml(agents.find((a) => a.id === "cursor")!, { state: "working", last_seen_at: null }, [{ area: "Areas/Finance", reason: "x", proposal_id: 9 }]);
    expect(row).toContain('<span class="chip state-working">working</span>');
    expect(row).toContain('<span class="mono agent-name">cursor</span>');
    expect(row).toContain("waiting on you: access to Areas/Finance");
    expect(row).toContain('data-act="agent" data-id="cursor"');
  });

  it("no door to define one: the list says where that is done, and has no register form", () => {
    expect(agentListHtml(agents)).not.toMatch(/<form|Register/);
    expect(HTML).toContain("New agents are defined on the Mac.");
    expect(HTML).not.toContain('id="agent-create"');
  });

  it("the agent, pushed: the one table as Read and Write lines, its actions in Allow · Ask First · Never", () => {
    const cursor = agents.find((a) => a.id === "cursor")!;
    const html = agentHtml(cursor, undefined, []);
    expect(html).toContain("<h3>What It May Do</h3>");
    expect(html).toContain('<span class="perm-res">Knowledge</span><span class="perm-line"><span class="perm-k">Read</span> <span>Projects, Areas/Ops (approved in Needs You · #4)</span></span><span class="perm-line"><span class="perm-k">Write</span> <span>—</span></span>');
    expect(html).toContain("⏱ Ask First — it comes to you before it happens. Anything not listed is not granted.");
    expect(html).toContain("<h3>Actions</h3>");
    expect(html).toMatch(/Never \(default for observe\)/);
    expect(html).not.toMatch(/\bdeny\b|\bpropose —|On · Ask · Off/);
  });

  it("the grants form speaks the same three words", () => {
    const src = read("../web/more.js");
    expect(src).toContain('<option value="deny">Never — refuse it at the tool</option>');
    expect(src).toContain('<option value="propose">Ask First — it asks, you answer in Needs You</option>');
    expect(src).toContain('<option value="allow">Allow — run it (act within scope only)</option>');
  });

  it("mounted: a tap pushes the agent; Edit Permissions opens the grants form; Save is the three PUTs it always was", async () => {
    const b = fakeBrowser({
      respond: (c) => (c.path === "/api/agents" ? { body: AGENTS.body } : c.path.startsWith("/api/q/agent_presence") ? { body: { rows: [{ id: "cursor", state: "idle", last_seen_at: null, spend_today_usd: "0.10" }] } } : { body: { ok: true } }),
    });
    const shown: unknown[] = [];
    const view = mountMore({ $: b.$, api: b.api, show: (v: string, o: unknown) => { shown.push([v, o]); } });
    await view.agents();
    expect(b.$("agent-list").innerHTML).toContain("<h3>Yours</h3>");
    await b.$("agents").fire("click", { target: control({ act: "agent", id: "cursor" }) });
    expect(shown).toEqual([["agent", { title: "cursor" }]]);
    await view.agent();
    expect(b.$("agent-body").innerHTML).toContain("$0.10 today");
    await b.$("agent").fire("click", { target: control({ act: "edit" }) });
    expect(b.$("agent-grants").hidden).toBe(false);
    expect(b.$("agent-tier").value).toBe("areas");
    b.$("agent-level").value = "observe";
    await b.$("agent-grants").fire("submit", { preventDefault() {} });
    expect(b.writes().map((w) => [w.method, w.path])).toEqual([
      ["PUT", "/api/agents/cursor/grants"],
      ["PUT", "/api/agents/cursor/projects"],
      ["PUT", "/api/agents/cursor/autonomy"],
    ]);
    expect(b.writes()[0]!.body).toEqual({ tier: "areas", areas: ["Projects", "Areas/Ops"], queries: true });
  });

  it("Revoke is confirmed with its consequence named, and a refusal is said in the server's words", async () => {
    const MSG = "agent cursor is the one you are using";
    const b = fakeBrowser({ respond: (c) => (c.path === "/api/agents" ? { body: AGENTS.body } : c.method === "POST" ? { status: 409, body: { error: { code: "conflict", message: MSG } } } : { body: { rows: [] } }) });
    const asked: string[] = [];
    vi.stubGlobal("confirm", (m: string) => { asked.push(m); return true; });
    const view = mountMore({ $: b.$, api: b.api, show: () => {} });
    await view.agents();
    await b.$("agents").fire("click", { target: control({ act: "agent", id: "cursor" }) });
    await view.agent();
    await b.$("agent").fire("click", { target: control({ act: "revoke" }) });
    expect(asked[0]).toMatch(/^Revoke cursor\? Its token stops working now, and this cannot be undone/);
    expect(b.writes()).toEqual([{ path: "/api/agents/cursor/revoke", method: "POST", headers: {}, body: undefined }]);
    expect(b.$("agent-msg").textContent).toBe(MSG);
  });

  it("escapes what an agent wrote about itself", () => {
    const evil = { id: "x", display_name: "<img src=x onerror=alert(1)>", kind: "external", revoked: false, permissions: [], scope: {} };
    expect(agentHtml(evil, undefined, [{ area: "<b>a</b>", reason: "<i>r</i>", proposal_id: 1 }])).not.toMatch(/<img|<b>a|<i>r/);
  });
});
