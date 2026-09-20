// **A crew's toolset, enforced at the door** (P2 of
// docs/research/2026-09-19-grants-and-access-simplified.md §2.2). Misuse
// first, as invariant 8 asks: the interesting question is what a crew gets
// when it calls a tool its manifest never named — and, since the answer used
// to come from the process that dispatched the run, whether it still comes
// when that process is not in the loop at all.
//
// Nothing here uses `apps/assistant`'s tool host: the calls below go straight
// from an MCP client to `createBrainServer`, with no `allow` set anywhere.
// That is the whole point. Before P2 every one of these calls succeeded (or
// failed for an unrelated reason); the only thing that had ever refused them
// was a `Set.has` in the caller.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { TasksService } from "@foldedspacelabs/metistry-tasks";
import { createBrainServer, type AgentPrincipal, type Db } from "../src/index.js";

/** Answers the few statements the runs rows and the nudge need; records every one, so "did the body run" is answerable. */
function fakeDb(): Db & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    async query(text) {
      log.push(text.trim().split(/\s+/).slice(0, 3).join(" "));
      if (text.startsWith("INSERT INTO runs")) return { rows: [{ id: 1 }] };
      return { rows: [] };
    },
  };
}

const GRANTS = { tier: "areas" as const, areas: ["Areas/Health"] };

/** The crew the console's registry would hand over: scope and toolset from its manifest, both resolved server-side. */
const writer: AgentPrincipal = { id: "writer", kind: "crew", uses: ["knowledge", "requests"], manifest: "agents/ops/writer.md", grants: GRANTS, projects: ["alpha"] };
/** The same row without a manifest this console can read — a revoked crew, a file that failed to parse. */
const orphan: AgentPrincipal = { id: "orphan", kind: "crew", grants: GRANTS, projects: ["alpha"] };
/** An external agent with the identical grants and projects: the control. Its refusals must not have moved. */
const scout: AgentPrincipal = { id: "scout", grants: GRANTS, projects: ["alpha"] };

describe("a crew's `uses` is enforced at /mcp, not in the caller", () => {
  let server: Server;
  let base: string;
  let db: ReturnType<typeof fakeDb>;
  const byToken = new Map<string, AgentPrincipal>([
    ["writer", writer],
    ["orphan", orphan],
    ["scout", scout],
  ]);

  /** One call, one client, no allowlist on this side of the wire. */
  async function call(token: string, name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; body: any }> {
    const client = new Client({ name: "crew-uses", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(base), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    try {
      const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
      const text = r.content[0]!.text;
      const nl = text.indexOf("\n");
      return { isError: r.isError === true, body: JSON.parse(nl === -1 ? text : text.slice(0, nl)) };
    } finally {
      await client.close();
    }
  }

  beforeAll(async () => {
    db = fakeDb();
    const brain = createBrainServer({
      db,
      // The credential decides, and the console resolves a crew's toolset
      // from the manifest it loaded — never from anything in the request.
      authenticate: async (req) => byToken.get(String(req.headers.authorization ?? "").replace(/^Bearer\s+/, "")) ?? null,
      tasks: new TasksService(db),
      inboxDir: "/tmp/metistry-crew-uses",
    });
    server = createServer((req, res) => void brain.handle(req, res));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("refuses a tool outside the manifest's groups with the uniform envelope, naming what the crew does hold", async () => {
    const r = await call("writer", "tasks_comment", { work_id: 1, body: "speaking in a room I was never given" });
    expect(r.isError).toBe(true);
    expect(r.body.error.code).toBe("forbidden");
    expect(r.body.error.message).toContain("tasks_comment is not in this crew's toolset");
    expect(r.body.error.message).toContain("knowledge, requests");
    expect(r.body.error.message).toContain("docs/ops/crews.md");
    // the envelope is the ordinary one: nothing new on the wire (invariant 8)
    expect(Object.keys(r.body)).toEqual(["error"]);
  });

  it("refuses every group the manifest did not name, and admits every tool of the ones it did", async () => {
    // `rooms`, `tasks`, `artifacts`, `capture` and `actions` are the five
    // groups nothing else on this surface gates — they are exactly the ones
    // that were held by the client filter alone (§2.2).
    for (const [name, args] of [
      ["capture", { note: "x" }],
      ["tasks_list", {}],
      ["tasks_create", { project: "alpha", title: "t" }],
      ["artifacts_list", { project: "alpha" }],
      ["tasks_thread", { work_id: 1 }],
    ] as const) {
      const r = await call("writer", name, args);
      expect(r.isError, name).toBe(true);
      expect(r.body.error, name).toMatchObject({ code: "forbidden", message: expect.stringContaining("not in this crew's toolset") });
    }
    // …and a tool it DOES hold is past this gate and reaches its own rule:
    // whatever these answer (an empty index here), it is never the toolset.
    for (const [name, args] of [
      ["knowledge_read", { path: "Areas/Health/sleep.md" }],
      ["requests_create", { title: "t", body: "b" }],
    ] as const) {
      const held = await call("writer", name, args);
      expect(held.body.error?.code, name).not.toBe("forbidden");
      expect(String(held.body.error?.message ?? ""), name).not.toContain("toolset");
    }
  });

  it("holds NO tools for a crew whose manifest this console cannot read — absent is empty, never everything", async () => {
    for (const name of ["capture", "knowledge_read", "tasks_list"]) {
      const r = await call("orphan", name, name === "capture" ? { note: "x" } : name === "knowledge_read" ? { path: "Areas/Health/sleep.md" } : {});
      expect(r.isError, name).toBe(true);
      expect(r.body.error.message, name).toContain("orphan holds no tool groups");
    }
  });

  it("cannot be widened from the request: neither a tool argument nor a header makes a bearer something else", async () => {
    // `kind`, `uses` and `agent` are not parameters of any tool; passing them
    // is the whole of what a crafted call can do, and it changes nothing —
    // identity and the toolset both come from the credential (§4.19).
    const r = await call("writer", "tasks_comment", { work_id: 1, body: "x", kind: "internal", uses: ["rooms"], agent: "assistant" });
    expect(r.isError).toBe(true);
    expect(r.body.error.message).toContain("not in this crew's toolset");
    expect(r.body.error.message).toContain("knowledge, requests"); // still the manifest's, not the body's
  });

  it("records the refusal as a runs row on the crew's own id and never runs the body", async () => {
    const before = db.log.length;
    const r = await call("writer", "capture", { note: "this would have landed in the inbox" });
    expect(r.isError).toBe(true);
    const wrote = db.log.slice(before);
    expect(wrote.filter((l) => l.startsWith("INSERT INTO runs"))).toHaveLength(1); // opened
    expect(wrote.filter((l) => l.startsWith("UPDATE runs"))).toHaveLength(1); // and closed, ok = false
    expect(wrote.filter((l) => l.startsWith("INSERT INTO inbox"))).toHaveLength(0); // the body never ran
  });

  it("changes nothing for an external agent with the identical grants — the gate decides only for a crew", async () => {
    // The same two calls the crew was refused. Whatever these answer, it is
    // the tool's own rule (membership, a missing service), never the toolset.
    for (const [name, args] of [
      ["tasks_comment", { work_id: 1, body: "x" }],
      ["capture", { note: "x" }],
    ] as const) {
      const r = await call("scout", name, args);
      expect(String(r.body.error?.message ?? ""), name).not.toContain("toolset");
    }
  });
});
