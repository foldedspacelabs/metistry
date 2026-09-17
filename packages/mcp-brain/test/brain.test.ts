// Unit tests: no database. A fake executor proves control flow the
// integration suite cannot isolate — the reader-less `not_available` path,
// the manifest ↔ tool list lock, and the pure helpers.
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { validateManifest } from "@foldedspacelabs/metistry-core";
import { TasksService } from "@foldedspacelabs/metistry-tasks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { allProjects, computeNudge, createBrainServer, memberOf, resolveAliasCall, sanitizeDeep, TOOL_ALIASES, TOOL_NAMES, underAreas, validKnowledgePath, type AgentPrincipal, type Db } from "../src/index.js";

describe("manifest", () => {
  it("validates through core and exposes exactly the registered tools, in order", () => {
    const parsed = validateManifest(parseYaml(readFileSync(new URL("../manifest.yaml", import.meta.url), "utf8")));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.manifest.type).toBe("bridge");
    if (parsed.manifest.type !== "bridge") return;
    expect(parsed.manifest.discovery).toBe("eager");
    expect(parsed.manifest.exposes.map((t) => t.name)).toEqual([...TOOL_NAMES]);
    // 26 DECLARED, 25 of them eager: `propose_action` is registered only for a
    // credential the owner has given room (docs/ops/actions.md), which is what
    // keeps the eager budget below where it was. Both numbers are asserted, so
    // a tool added without a discovery decision fails here first.
    expect(TOOL_NAMES.length).toBeLessThanOrEqual(26);
    expect(TOOL_NAMES.filter((n) => n !== "propose_action").length).toBeLessThanOrEqual(25);
    expect(parsed.manifest.exposes.map((t) => t.name).filter((n) => Object.hasOwn(TOOL_ALIASES, n))).toEqual([]); // deprecated spellings never reach the listed surface
    expect(parsed.manifest.exposes.every((t) => !t.destructive)).toBe(true); // nothing here mutates the user's world irreversibly: rows, not calendars
  });
});

describe("definition size (docs/research/2026-08-tool-discovery.md's other axis)", () => {
  /** What one principal actually sees listed, and what those definitions cost. */
  async function listedFor(principal: AgentPrincipal): Promise<{ names: string[]; tokens: number }> {
    const db = fakeDb({}, []);
    const brain = createBrainServer({ db, authenticate: async () => principal, tasks: new TasksService(db), inboxDir: "/tmp/unused" });
    const server = createServer((req, res) => void brain.handle(req, res));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const client = new Client({ name: "t", version: "0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(base), { requestInit: { headers: { authorization: "Bearer x" } } }));
      const { tools } = await client.listTools();
      await client.close();
      const chars = JSON.stringify(tools).length;
      // eslint-disable-next-line no-console
      console.log(`mcp-brain tools/list (${principal.id}): ${tools.length} tools, ${chars} chars, ~${Math.ceil(chars / 4)} tokens (PoC-17 lazy-load line: 5000)`);
      return { names: tools.map((t) => t.name), tokens: Math.ceil(chars / 4) }; // chars/4 is the industry's own rule of thumb (§1)
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }

  it("the EAGER definition stays under the >5k-token line that would make discovery: lazy worth its +1-turn cost", async () => {
    const { names, tokens } = await listedFor(alice);
    expect(names).not.toContain("propose_action"); // alice has no autonomy record: the group is not offered at all
    expect(names.length).toBe(25);
    expect(tokens).toBeLessThan(5000);
  });

  it("propose_action rides only on a credential the owner gave room — that is this group's lazy (docs/ops/actions.md)", async () => {
    const actor: AgentPrincipal = { ...alice, id: "actor", autonomy: { level: "propose" } };
    const { names, tokens } = await listedFor(actor);
    expect(names).toContain("propose_action");
    expect(names.length).toBe(26);
    // Crossing the 5k line here is the KNOWN cost of opting in, not a
    // regression: the eager surface above is what every other agent pays, and
    // deferring by credential costs none of the +1 discovery turn a
    // tool_index/execute/batch index would. The bound is a ceiling on the one
    // definition, so the tool cannot grow unnoticed.
    expect(tokens).toBeLessThan(5400);
    // a level that admits nothing is exactly alice again — the refusal is the absence
    const observer: AgentPrincipal = { ...alice, id: "observer", autonomy: { level: "observe", actions: { comment: "allow" } } };
    expect((await listedFor(observer)).names).not.toContain("propose_action");
  });
});

describe("deprecated tool names (one release; aliases.ts)", () => {
  it("every alias resolves to a primary name and none of them is itself listed", () => {
    for (const [old, hit] of Object.entries(TOOL_ALIASES)) {
      expect(TOOL_NAMES, old).toContain(hit.to);
      expect(TOOL_NAMES as readonly string[], old).not.toContain(old);
    }
  });

  it("resolveAliasCall rewrites a tools/call in place, forces the implied argument, and leaves everything else alone", () => {
    const mine = { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "tasks_mine", arguments: { limit: 5 } } };
    expect(resolveAliasCall(mine)).toEqual({ alias: "tasks_mine", to: "tasks_list", id: 7 });
    expect(mine.params).toEqual({ name: "tasks_list", arguments: { limit: 5, filter: "mine" } });

    const ready = { jsonrpc: "2.0", id: "a", method: "tools/call", params: { name: "tasks_list_ready", arguments: { filter: "all" } } };
    expect(resolveAliasCall(ready)?.to).toBe("tasks_list");
    expect(ready.params.arguments).toEqual({ filter: "ready" }); // the old name's meaning wins

    const rep = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "report", arguments: { title: "t", body: "b" } } };
    expect(resolveAliasCall(rep)?.to).toBe("requests_create");
    expect(rep.params.arguments).toEqual({ title: "t", body: "b" }); // no argument invented

    // not an alias, not a call, not an object: untouched
    const primary = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "tasks_list", arguments: {} } };
    expect(resolveAliasCall(primary)).toBeNull();
    expect(primary.params.name).toBe("tasks_list");
    expect(resolveAliasCall({ jsonrpc: "2.0", id: 3, method: "tools/list", params: { name: "report" } })).toBeNull();
    expect(resolveAliasCall(null)).toBeNull();
    expect(resolveAliasCall("report")).toBeNull();
  });
});

describe("pure helpers", () => {
  it("sanitizeDeep walks arrays/objects, converts dates, leaves numbers", () => {
    const d = new Date("2026-09-06T00:00:00Z");
    expect(sanitizeDeep({ a: "/x​", b: [d, 1, null, { c: "‮ok" }], e: true })).toEqual({
      a: "x",
      b: ["2026-09-06T00:00:00.000Z", 1, null, { c: "ok" }],
      e: true,
    });
  });

  it("underAreas is prefix-by-segment, not by string", () => {
    expect(underAreas("Areas/Fsl/Note.md", ["Areas/Fsl"])).toBe(true);
    expect(underAreas("Areas/Fsl", ["Areas/Fsl"])).toBe(true);
    expect(underAreas("Areas/Fslx/Note.md", ["Areas/Fsl"])).toBe(false);
    expect(underAreas("Areas/Fsl/Note.md", [])).toBe(false);
    // the bare vault grant (`/`) trims to the empty prefix: everything, root notes included
    expect(underAreas("now.md", ["/"])).toBe(true);
    expect(underAreas("Areas/Fsl/Note.md", ["/"])).toBe(true);
  });

  it("validKnowledgePath refuses traversal, absolute, the machinery and Artifacts/", () => {
    expect(validKnowledgePath("Areas/Fsl/Note.md")).toBe(true);
    expect(validKnowledgePath("now.md")).toBe(true); // a root note is a vault path now
    for (const bad of ["/Areas/x", "/", "Areas/", "Areas/../x", "Areas/./x", ".metistry/identity.yaml", ".metistry/state/.env", "Artifacts/bundle-1/x.pdf", ""]) {
      expect(validKnowledgePath(bad), bad).toBe(false);
    }
  });
});

// A fake executor: answers the few statements the nudge path and runs need.
function fakeDb(ready: Record<string, number>, held: { id: number; project: string; lease: Date }[]): Db & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    async query(text, values) {
      log.push(text.trim().split(/\s+/).slice(0, 3).join(" "));
      if (text.startsWith("INSERT INTO runs")) return { rows: [{ id: 1 }] };
      if (text.startsWith("UPDATE runs")) return { rows: [] };
      if (text.includes("FROM work w") && text.includes("w.status = 'open'")) {
        const project = values?.[0] as string | null;
        const row = (p: string, i: number) => ({ id: i + 1, title: `t${i}`, project: p, kind: "task", status: "open", depends_on: [], history: [] });
        if (project === null) return { rows: Object.entries(ready).flatMap(([p, n]) => Array.from({ length: n }, (_, i) => row(p, i))) }; // unfiltered read
        return { rows: Array.from({ length: ready[project] ?? 0 }, (_, i) => row(project, i)) };
      }
      if (text.includes("w.claimed_by = $1")) {
        return { rows: held.map((h) => ({ id: h.id, title: "x", project: h.project, kind: "task", status: "in_progress", lease_expires_at: h.lease, depends_on: [], history: [] })) };
      }
      if (text.includes("FROM knowledge_files")) return { rows: [{ path: values?.[0], title: "T", draft: false }] };
      return { rows: [] };
    },
  };
}

const alice: AgentPrincipal = { id: "alice", grants: { tier: "areas", areas: ["Areas/Itest"] }, projects: ["p1", "p2"] };

describe("nudge (server-side, deterministic)", () => {
  it("counts ready tasks per project in sorted order, warns on short and expired leases, ignores held tasks outside the projects", async () => {
    const now = Date.parse("2026-09-06T12:00:00Z");
    const db = fakeDb({ p2: 3, p1: 1 }, [
      { id: 7, project: "p1", lease: new Date(now + 45_000) },
      { id: 8, project: "p1", lease: new Date(now - 1_000) },
      { id: 9, project: "p1", lease: new Date(now + 600_000) },
      { id: 10, project: "other", lease: new Date(now + 1_000) },
    ]);
    const line = await computeNudge(new TasksService(db), alice, { leaseWarningSeconds: 120 }, now);
    expect(line).toBe(
      "nudge: 1 task ready in project p1 — call tasks_list; 3 tasks ready in project p2 — call tasks_list; " +
        "claim on task #7 expires in 45s — call tasks_renew; lease on task #8 expired — call tasks_claim to retake it or tasks_release to hand it back",
    );
  });

  it("is absent when nothing is waiting", async () => {
    expect(await computeNudge(new TasksService(fakeDb({}, [])), alice, { leaseWarningSeconds: 120 })).toBeNull();
  });

  it("an every-project (internal, no list) principal is nudged for every project from one unfiltered read, and for every lease it holds", async () => {
    const now = Date.parse("2026-09-06T12:00:00Z");
    const hub: AgentPrincipal = { id: "assistant", kind: "internal", grants: { tier: "none", areas: [] }, projects: [] };
    const db = fakeDb({ zeta: 2, alpha: 1 }, [{ id: 10, project: "other", lease: new Date(now + 1_000) }]);
    const line = await computeNudge(new TasksService(db), hub, { leaseWarningSeconds: 120 }, now);
    expect(line).toBe("nudge: 1 task ready in project alpha — call tasks_list; 2 tasks ready in project zeta — call tasks_list; claim on task #10 expires in 1s — call tasks_renew");
    expect(db.log.filter((l) => l.startsWith("SELECT id, title,")).length).toBe(2); // one ready read + one held read, not one per project
  });
});

describe("project scope rule (scope.ts)", () => {
  const ext = (projects: string[]): AgentPrincipal => ({ id: "x", grants: { tier: "none", areas: [] }, projects });
  const int = (projects: string[]): AgentPrincipal => ({ id: "assistant", kind: "internal", grants: { tier: "none", areas: [] }, projects });

  it("external: exactly the list; empty = none", () => {
    expect(memberOf(ext(["p1"]), "p1")).toBe(true);
    expect(memberOf(ext(["p1"]), "p2")).toBe(false);
    expect(memberOf(ext([]), "p1")).toBe(false);
    expect(allProjects(ext([]))).toBe(false);
  });

  it("internal: empty = every project, a list narrows; a null project is never a member for anyone", () => {
    expect(allProjects(int([]))).toBe(true);
    expect(memberOf(int([]), "anything")).toBe(true);
    expect(allProjects(int(["p1"]))).toBe(false);
    expect(memberOf(int(["p1"]), "p2")).toBe(false);
    expect(memberOf(int([]), null)).toBe(false);
    expect(memberOf(ext(["p1"]), null)).toBe(false);
  });
});

// An internal principal — allowed() at queries-tools.ts admits it regardless
// of a `queries` grant — so hitting queries_* here proves the STORE-less gap
// (not_available), not the grant-less one (forbidden, covered elsewhere).
const hubInternal: AgentPrincipal = { id: "hub", kind: "internal", grants: { tier: "none", areas: [] }, projects: [] };

describe("reader-less deployment", () => {
  let server: Server;
  let base: string;
  const db = fakeDb({}, []);
  beforeAll(async () => {
    const brain = createBrainServer({
      db,
      authenticate: async (req) => (req.headers.authorization === "Bearer ok" ? alice : req.headers.authorization === "Bearer hub" ? hubInternal : null),
      tasks: new TasksService(db),
      inboxDir: "/tmp/unused",
    });
    server = createServer((req, res) => void brain.handle(req, res));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("knowledge_read answers not_available (a capability gap, distinct from not granted and not found)", async () => {
    const client = new Client({ name: "t", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(base), { requestInit: { headers: { authorization: "Bearer ok" } } }));
    const r = (await client.callTool({ name: "knowledge_read", arguments: { path: "Areas/Itest/Alpha.md" } })) as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0]!.text);
    expect(body.error.code).toBe("not_available");
    expect(body.error.message).toMatch(/not readable from this deployment/);
    await client.close();
    expect(db.log.filter((l) => l.startsWith("INSERT INTO runs"))).toHaveLength(1); // the refusal was still recorded
  });

  it("knowledge_list answers not_available without a vault lister; knowledge_grep answers not_available without a reader — both distinct from not granted", async () => {
    const client = new Client({ name: "t", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(base), { requestInit: { headers: { authorization: "Bearer ok" } } }));
    const list = (await client.callTool({ name: "knowledge_list", arguments: {} })) as { isError?: boolean; content: { text: string }[] };
    expect(list.isError).toBe(true);
    expect(JSON.parse(list.content[0]!.text).error).toMatchObject({ code: "not_available" });
    const grep = (await client.callTool({ name: "knowledge_grep", arguments: { pattern: "x" } })) as { isError?: boolean; content: { text: string }[] };
    expect(grep.isError).toBe(true);
    expect(JSON.parse(grep.content[0]!.text).error).toMatchObject({ code: "not_available" });
    await client.close();
  });

  it("knowledge_list is forbidden at tier none; knowledge_grep is forbidden at tier none AND tier index (it needs content, like knowledge_read)", async () => {
    const client = new Client({ name: "t", version: "0" });
    // hubInternal here carries tier: "none" — reused only for its shape; the check is purely on grants.tier
    await client.connect(new StreamableHTTPClientTransport(new URL(base), { requestInit: { headers: { authorization: "Bearer hub" } } }));
    for (const [name, args] of [
      ["knowledge_list", {}],
      ["knowledge_grep", { pattern: "x" }],
    ] as const) {
      const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
      expect(r.isError, name).toBe(true);
      expect(JSON.parse(r.content[0]!.text).error, name).toEqual({ code: "forbidden", message: "not granted" });
    }
    await client.close();
  });

  it("queries_list/queries_run answer not_available without a QueryStore, even for an internal (allowed) principal", async () => {
    const client = new Client({ name: "t", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(base), { requestInit: { headers: { authorization: "Bearer hub" } } }));
    for (const [name, args] of [["queries_list", {}], ["queries_run", { name: "whatever" }]] as const) {
      const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
      expect(r.isError, name).toBe(true);
      expect(JSON.parse(r.content[0]!.text).error.code, name).toBe("not_available");
    }
    await client.close();
  });

  it("queries_list/queries_run are forbidden for an external principal without a `queries` grant, store or not", async () => {
    const client = new Client({ name: "t", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(base), { requestInit: { headers: { authorization: "Bearer ok" } } }));
    const r = (await client.callTool({ name: "queries_list", arguments: {} })) as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0]!.text).error).toEqual({ code: "forbidden", message: "not granted" });
    await client.close();
  });

  it("check() is degraded, naming the gap, and reports the tool list", async () => {
    const brain = createBrainServer({ db, authenticate: async () => null, tasks: new TasksService(db), inboxDir: "/tmp/unused" });
    const c = await brain.check();
    expect(c).toMatchObject({ name: "brain", status: "degraded", meta: { tools: [...TOOL_NAMES], knowledge_read: "not_available", queries: "not_available" } });
    expect(c.remediation).toMatch(/knowledge_read/);
  });
});
