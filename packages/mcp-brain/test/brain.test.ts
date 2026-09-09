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
import { allProjects, computeNudge, createBrainServer, memberOf, sanitizeDeep, TOOL_NAMES, underAreas, validKnowledgePath, type AgentPrincipal, type Db } from "../src/index.js";

describe("manifest", () => {
  it("validates through core and exposes exactly the registered tools, in order", () => {
    const parsed = validateManifest(parseYaml(readFileSync(new URL("../manifest.yaml", import.meta.url), "utf8")));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.manifest.type).toBe("bridge");
    if (parsed.manifest.type !== "bridge") return;
    expect(parsed.manifest.discovery).toBe("eager");
    expect(parsed.manifest.exposes.map((t) => t.name)).toEqual([...TOOL_NAMES]);
    expect(TOOL_NAMES.length).toBeLessThanOrEqual(23); // over the PoC-17 tool-COUNT guidance (>20) since knowledge_list/knowledge_grep — the definition-token axis is what actually gates lazy; see "definition size" below
    expect(parsed.manifest.exposes.every((t) => !t.destructive)).toBe(true); // nothing here mutates the user's world irreversibly: rows, not calendars
  });
});

describe("definition size (docs/research/2026-08-tool-discovery.md's other axis)", () => {
  it("the full tools/list definition stays well under the >5k-token line that would make discovery: lazy worth its +1-turn cost", async () => {
    const db = fakeDb({}, []);
    const brain = createBrainServer({ db, authenticate: async () => alice, tasks: new TasksService(db), inboxDir: "/tmp/unused" });
    const server = createServer((req, res) => void brain.handle(req, res));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const client = new Client({ name: "t", version: "0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(base), { requestInit: { headers: { authorization: "Bearer x" } } }));
      const { tools } = await client.listTools();
      await client.close();
      const chars = JSON.stringify(tools).length;
      const approxTokens = Math.ceil(chars / 4); // the industry's own rule of thumb (docs/research/2026-08-tool-discovery.md §1)
      // eslint-disable-next-line no-console
      console.log(`mcp-brain tools/list: ${tools.length} tools, ${chars} chars, ~${approxTokens} tokens (PoC-17 lazy-load line: 5000)`);
      expect(approxTokens).toBeLessThan(5000);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
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
    expect(underAreas("Knowledge/Areas/Fsl/Note.md", ["Knowledge/Areas/Fsl"])).toBe(true);
    expect(underAreas("Knowledge/Areas/Fsl", ["Knowledge/Areas/Fsl"])).toBe(true);
    expect(underAreas("Knowledge/Areas/Fslx/Note.md", ["Knowledge/Areas/Fsl"])).toBe(false);
    expect(underAreas("Knowledge/Areas/Fsl/Note.md", [])).toBe(false);
  });

  it("validKnowledgePath refuses traversal, absolute, non-vault, and casing slips", () => {
    expect(validKnowledgePath("Knowledge/Areas/Fsl/Note.md")).toBe(true);
    for (const bad of ["knowledge/Areas/Fsl/Note.md", "/Knowledge/Areas/x", "Knowledge", "Knowledge/", "Knowledge/Areas/../x", "Knowledge/./x", "inbox/x", ""]) {
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

const alice: AgentPrincipal = { id: "alice", grants: { tier: "areas", areas: ["Knowledge/Areas/Itest"] }, projects: ["p1", "p2"] };

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
      "nudge: 1 task ready in project p1 — call tasks_list_ready; 3 tasks ready in project p2 — call tasks_list_ready; " +
        "claim on task #7 expires in 45s — call tasks_heartbeat; lease on task #8 expired — call tasks_claim to retake it or tasks_release to hand it back",
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
    expect(line).toBe("nudge: 1 task ready in project alpha — call tasks_list_ready; 2 tasks ready in project zeta — call tasks_list_ready; claim on task #10 expires in 1s — call tasks_heartbeat");
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
    const r = (await client.callTool({ name: "knowledge_read", arguments: { path: "Knowledge/Areas/Itest/Alpha.md" } })) as { isError?: boolean; content: { text: string }[] };
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
