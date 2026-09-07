// The bridge against the real (scratch) database, driven by the real MCP
// client over Streamable HTTP — misuse tests first (invariant 8): the
// principal is injected, so every trust rule is exercised by swapping
// tokens, never by asking the tools nicely. Skipped without a db.
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { TasksService } from "@foldedspacelabs/metistry-tasks";
import { createBrainServer, sha256Text, TOOL_NAMES, type AgentPrincipal, type VaultWriteRequest } from "../src/index.js";

try {
  for (const line of readFileSync(new URL("../../../.env", import.meta.url), "utf8").split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m && m[1] && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {}

const hasDb = !!process.env.METISTRY_DB_PASSWORD;
const PA = "itest-brain-a";
const PB = "itest-brain-b";
const ALICE = "itest-brain-alice";
const BOB = "itest-brain-bob";
const HUB = "itest-brain-hub";
const AREA = "Knowledge/Areas/Itest";

interface Parsed {
  isError: boolean;
  body: any;
  nudge: string | null;
}

describe.skipIf(!hasDb)("mcp-brain (real db, real MCP client)", () => {
  let pool: pg.Pool;
  let server: Server;
  let base: string;
  // principals are keyed by token: the bridge never sees a token, only what authenticate() returns
  const principals = new Map<string, AgentPrincipal>();
  let vault: Record<string, string> | null = null; // the injected reader; null = no read path
  const writes: VaultWriteRequest[] = []; // the injected writer records what would reach the vault bridge

  const grant = (token: string, p: AgentPrincipal) => principals.set(token, p);

  async function connect(token: string): Promise<Client> {
    const client = new Client({ name: "itest", version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }),
    );
    return client;
  }

  async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Parsed> {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text: string }[] };
    const text = r.content[0]!.text;
    const nl = text.indexOf("\n");
    return { isError: !!r.isError, body: JSON.parse(nl === -1 ? text : text.slice(0, nl)), nudge: nl === -1 ? null : text.slice(nl + 1) };
  }

  beforeAll(async () => {
    pool = new pg.Pool({
      host: process.env.METISTRY_DB_HOST ?? "127.0.0.1",
      port: Number(process.env.METISTRY_DB_PORT ?? 5432),
      user: process.env.METISTRY_DB_USER ?? "metistry",
      database: process.env.METISTRY_TEST_DB_NAME ?? "metistry_test",
      password: process.env.METISTRY_DB_PASSWORD,
    });
    await pool.query(`DELETE FROM work WHERE project IN ($1, $2)`, [PA, PB]);
    await pool.query(`DELETE FROM proposals WHERE source_agent IN ($1, $2, $3)`, [ALICE, BOB, HUB]);
    await pool.query(`DELETE FROM runs WHERE component IN ($1, $2, $3)`, [ALICE, BOB, HUB]);
    await pool.query(`DELETE FROM inbox WHERE source_agent IN ($1, $2, $3)`, [ALICE, BOB, HUB]);
    await pool.query(`DELETE FROM knowledge_files WHERE path LIKE 'Knowledge/Areas/Itest%' OR path LIKE 'Knowledge/Areas/Other/Gamma%'`);
    await pool.query(
      `INSERT INTO knowledge_files (path, title, description, draft) VALUES
        ('Knowledge/Areas/Itest/Alpha.md', 'Alpha note', 'about alpha', false),
        ('Knowledge/Areas/Itest/Sub/Beta.md', NULL, NULL, false),
        ('Knowledge/Areas/Itest/Draft.md', 'Alpha draft', 'unsettled alpha', true),
        ('Knowledge/Areas/Other/Gamma.md', 'Gamma alpha', NULL, false)`,
    );

    const brain = createBrainServer({
      db: pool,
      authenticate: async (req) => {
        const m = /^Bearer\s+(\S+)$/.exec(req.headers.authorization ?? "");
        return (m?.[1] && principals.get(m[1])) || null;
      },
      tasks: new TasksService(pool),
      inboxDir: `/tmp/metistry-test-inbox-brain-${Date.now()}`,
      readKnowledge: async (path) => (vault ? (vault[path] ?? null) : null),
      writeKnowledge: async (r) => {
        writes.push(r);
        const cur = vault?.[r.path];
        if (r.expected_sha256 !== undefined && (cur === undefined ? "" : sha256Text(cur)) !== r.expected_sha256) {
          return { ok: false, code: "conflict", current_sha256: cur === undefined ? null : sha256Text(cur) };
        }
        (vault ??= {})[r.path] = r.content;
        return { ok: true, path: r.path, sha256: sha256Text(r.content), bytes: Buffer.byteLength(r.content), created: cur === undefined };
      },
    });
    // the reader is "absent" while `vault` is null — modelled by returning null; the not_available case is tested with a reader-less server below
    server = createServer((req, res) => {
      if (req.url === "/mcp") void brain.handle(req, res).catch(() => res.destroy());
      else res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    grant("tok-alice", { id: ALICE, grants: { tier: "none", areas: [] }, projects: [PA] });
    grant("tok-bob", { id: BOB, grants: { tier: "none", areas: [] }, projects: [PB] });
    // the instance's own assistant: internal, no list = every project (scope.ts); a list narrows it like anyone else
    grant("tok-hub", { id: HUB, kind: "internal", grants: { tier: "none", areas: [] }, projects: [] });
    grant("tok-hub-narrow", { id: HUB, kind: "internal", grants: { tier: "none", areas: [] }, projects: [PA] });
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await pool.end();
  });

  it("no bearer / unknown bearer → 401 envelope at the HTTP layer, never an MCP response", async () => {
    const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "x", version: "0" } } };
    for (const headers of [{}, { authorization: "Bearer nope" }, { authorization: "Basic abc" }]) {
      const r = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify(init),
      });
      expect(r.status).toBe(401);
      expect(r.headers.get("www-authenticate")).toContain("Bearer");
      expect(await r.json()).toEqual({ error: { code: "unauthenticated", message: "authentication required" } });
    }
    await expect(connect("nope")).rejects.toThrow();
  });

  it("lists exactly the eager surface, in manifest order, with no agent-identity argument anywhere", async () => {
    const alice = await connect("tok-alice");
    const { tools } = await alice.listTools();
    expect(tools.map((t) => t.name)).toEqual([...TOOL_NAMES]);
    for (const t of tools) {
      const props = Object.keys((t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
      expect(props, t.name).not.toContain("agent");
      expect(props, t.name).not.toContain("agent_id");
    }
    await alice.close();
  });

  it("tasks_* are scoped to the principal's projects; outside = not_found, never listed", async () => {
    const alice = await connect("tok-alice");
    const bob = await connect("tok-bob");

    // create outside membership is refused as not granted (a project you are not in is a write across the boundary)
    const bad = await call(alice, "tasks_create", { title: "sneak", project: PB });
    expect(bad).toMatchObject({ isError: true, body: { error: { code: "forbidden", message: "not granted" } } });

    const a1 = await call(alice, "tasks_create", { title: "A1", project: PA, idempotency_key: `${PA}-a1` });
    expect(a1.isError).toBe(false);
    expect(a1.body.task).toMatchObject({ title: "A1", project: PA, status: "open", created_by: ALICE });
    const again = await call(alice, "tasks_create", { title: "A1 retry", project: PA, idempotency_key: `${PA}-a1` });
    expect(again.body.task.id).toBe(a1.body.task.id); // idempotent
    const b1 = await call(bob, "tasks_create", { title: "B1", project: PB });
    const aId = a1.body.task.id as number;
    const bId = b1.body.task.id as number;

    // listing: each sees only its own projects
    expect((await call(alice, "tasks_list_ready")).body.tasks.map((t: any) => t.id)).toEqual([aId]);
    expect((await call(bob, "tasks_list_ready")).body.tasks.map((t: any) => t.id)).toEqual([bId]);
    expect(await call(alice, "tasks_list_ready", { project: PB })).toMatchObject({ isError: true, body: { error: { code: "not_found" } } });

    // every holder verb on a task outside the boundary is uniformly not_found
    for (const [tool, args] of [
      ["tasks_claim", { id: bId }],
      ["tasks_heartbeat", { id: bId }],
      ["tasks_update", { id: bId, note: "x" }],
      ["tasks_release", { id: bId }],
      ["tasks_claim", { id: 999_999_999 }],
    ] as const) {
      expect(await call(alice, tool, args), tool).toMatchObject({ isError: true, body: { error: { code: "not_found", message: "not found" } } });
    }
    // a cross-project dependency is rejected at write, not filtered at read (§4.21 scope creep)
    expect(await call(alice, "tasks_create", { title: "A2", project: PA, depends_on: [bId] })).toMatchObject({ isError: true, body: { error: { code: "not_found" } } });
    // bob's task is untouched by any of that
    expect((await pool.query(`SELECT status, claimed_by FROM work WHERE id = $1`, [bId])).rows[0]).toEqual({ status: "open", claimed_by: null });

    await alice.close();
    await bob.close();
  });

  it("an internal principal with no project list is in every project; a list narrows it; external + empty stays none", async () => {
    grant("tok-nobody", { id: BOB, grants: { tier: "none", areas: [] }, projects: [] });
    const hub = await connect("tok-hub");
    const narrow = await connect("tok-hub-narrow");
    const nobody = await connect("tok-nobody");
    const aId = Number((await pool.query(`SELECT id FROM work WHERE project = $1 AND title = 'A1'`, [PA])).rows[0].id);
    const bId = Number((await pool.query(`SELECT id FROM work WHERE project = $1 AND title = 'B1'`, [PB])).rows[0].id);
    // the scratch db is shared with other suites' leftovers, so assert on THIS suite's projects, not on the whole list
    const ours = (tasks: any[]) => tasks.filter((t) => [PA, PB].includes(t.project)).map((t) => t.id);
    try {
      // every project: both tasks listed (due first, then oldest), both projects nudged, per-project listing works, create anywhere
      const all = await call(hub, "tasks_list_ready");
      expect(ours(all.body.tasks)).toEqual([aId, bId]);
      expect(all.body.tasks.every((t: any) => t.project !== null)).toBe(true);
      expect(all.nudge).toContain(`1 task ready in project ${PA} — call tasks_list_ready`);
      expect(all.nudge).toContain(`1 task ready in project ${PB} — call tasks_list_ready`);
      expect((await call(hub, "tasks_list_ready", { project: PB })).body.tasks.map((t: any) => t.id)).toEqual([bId]);
      const created = await call(hub, "tasks_create", { title: "H1", project: PB, idempotency_key: `${PB}-h1` });
      expect(created.isError).toBe(false);
      expect(created.body.task).toMatchObject({ project: PB, created_by: HUB });
      await pool.query(`DELETE FROM work WHERE id = $1`, [created.body.task.id]); // keep the later nudge arithmetic exact

      // a task with NO project is invisible even to the every-project principal (a project is the unit of coordination)
      const orphan = Number((await pool.query(`INSERT INTO work (title, kind, status) VALUES ('orphan', 'task', 'open') RETURNING id`)).rows[0].id);
      expect((await call(hub, "tasks_list_ready")).body.tasks.map((t: any) => t.id)).not.toContain(orphan);
      expect((await call(hub, "tasks_claim", { id: orphan })).body.error.code).toBe("not_found");
      await pool.query(`DELETE FROM work WHERE id = $1`, [orphan]);

      // narrowed internal: PA only — PB is not_found / forbidden exactly as for alice
      expect((await call(narrow, "tasks_list_ready")).body.tasks.map((t: any) => t.id)).toEqual([aId]);
      expect((await call(narrow, "tasks_claim", { id: bId })).body.error.code).toBe("not_found");
      expect((await call(narrow, "tasks_create", { title: "sneak", project: PB })).body.error.code).toBe("forbidden");

      // the rule is kind-gated: an external principal with an empty list still sees nothing
      expect((await call(nobody, "tasks_list_ready")).body).toEqual({ tasks: [] });
      expect((await call(nobody, "tasks_claim", { id: aId })).body.error.code).toBe("not_found");
    } finally {
      await hub.close();
      await narrow.close();
      await nobody.close();
    }
  });

  it("nudge: ready tasks appear on every result and disappear when claimed; a short lease warns; identity is stamped server-side", async () => {
    const alice = await connect("tok-alice");
    const bob = await connect("tok-bob");
    const aId = (await pool.query(`SELECT id FROM work WHERE project = $1 AND title = 'A1'`, [PA])).rows[0].id as number;

    // an unrelated tool carries the nudge for alice's project, and bob never sees alice's project
    const mine = await call(alice, "tasks_mine");
    expect(mine.body).toEqual({ tasks: [] });
    expect(mine.nudge).toBe(`nudge: 1 task ready in project ${PA} — call tasks_list_ready`);
    expect((await call(bob, "tasks_mine")).nudge).toBe(`nudge: 1 task ready in project ${PB} — call tasks_list_ready`);

    const claim = await call(alice, "tasks_claim", { id: Number(aId), lease_seconds: 60 });
    expect(claim.body).toMatchObject({ ok: true, task: { id: Number(aId), claimed_by: ALICE, status: "in_progress" } });
    // the ready nudge is gone; the lease (60s < the 120s warning line) is flagged instead
    expect(claim.nudge).toMatch(new RegExp(`^nudge: claim on task #${aId} expires in \\d+s — call tasks_heartbeat$`));

    const hb = await call(alice, "tasks_heartbeat", { id: Number(aId), lease_seconds: 900 });
    expect(hb.body.ok).toBe(true);
    expect(hb.nudge).toBeNull(); // nothing waiting: no line at all

    // bob cannot touch alice's claim even by id: still not_found (scope) — and alice's history names alice, not a payload field
    expect((await call(bob, "tasks_update", { id: Number(aId), status: "closed" })).body.error.code).toBe("not_found");
    const upd = await call(alice, "tasks_update", { id: Number(aId), note: "half done" });
    expect(upd.body.task.history.map((h: any) => h.agent)).toEqual([ALICE, ALICE, ALICE]);
    const closed = await call(alice, "tasks_update", { id: Number(aId), status: "closed" });
    expect(closed.body.task.status).toBe("closed");
    expect(closed.nudge).toBeNull();

    await alice.close();
    await bob.close();
  });

  it("sanitizer: bidi/zero-width stripped and no leading slash on anything rendered, while the row keeps what was stored", async () => {
    const alice = await connect("tok-alice");
    const raw = "/clear ‮evil​ title";
    const created = await call(alice, "tasks_create", { title: raw, project: PA, idempotency_key: `${PA}-sanit` });
    expect(created.body.task.title).toBe("clear evil title");
    const stored = await pool.query(`SELECT title FROM work WHERE id = $1`, [created.body.task.id]);
    expect(stored.rows[0].title).toBe(raw); // the boundary is on the way OUT to an agent, not a rewrite of the record
    const listed = await call(alice, "tasks_list_ready", { project: PA });
    expect(listed.body.tasks.map((t: any) => t.title)).toEqual(["clear evil title"]);
    // tidy so later nudge assertions stay exact
    await call(alice, "tasks_claim", { id: created.body.task.id });
    await call(alice, "tasks_update", { id: created.body.task.id, status: "closed" });
    await alice.close();
  });

  it("report: proposals row with server-side provenance; idempotent on key; same title within 24h suppressed", async () => {
    const alice = await connect("tok-alice");
    const first = await call(alice, "report", { title: "Found a thing", body: "details", kind: "finding", refs: ["gh:x/y#1"], idempotency_key: "rep-1" });
    expect(first.isError).toBe(false);
    expect(first.body.deduplicated).toBe(false);
    const id = first.body.id as number;
    const row = (await pool.query(`SELECT kind, source_agent, trust, decision, payload FROM proposals WHERE id = $1`, [id])).rows[0];
    expect(row).toMatchObject({ kind: "report", source_agent: ALICE, trust: "external", decision: "pending" });
    expect(row.payload).toMatchObject({ title: "Found a thing", body: "details", kind: "finding", refs: ["gh:x/y#1"], idempotency_key: "rep-1", provenance: { agent: ALICE, via: "mcp-brain" } });

    expect(await call(alice, "report", { title: "different title", body: "retry", idempotency_key: "rep-1" })).toMatchObject({ body: { id, deduplicated: "idempotency_key" } });
    expect(await call(alice, "report", { title: "Found a thing", body: "again", idempotency_key: "rep-2" })).toMatchObject({ body: { id, deduplicated: "title" } });
    // another agent's identical title is NOT a duplicate — dedupe is per agent
    const bob = await connect("tok-bob");
    const bobs = await call(bob, "report", { title: "Found a thing", body: "bob's" });
    expect(bobs.body.deduplicated).toBe(false);
    expect(bobs.body.id).not.toBe(id);
    // secret-named fields never reach the queue
    const leaky = await call(alice, "report", { title: "creds", body: "x", refs: ["api_key=abc"], idempotency_key: "rep-3" });
    expect((await pool.query(`SELECT payload FROM proposals WHERE id = $1`, [leaky.body.id])).rows[0].payload.refs).toEqual(["api_key=abc"]); // a ref string is not a secret FIELD
    expect((await pool.query(`SELECT count(*)::int AS n FROM proposals WHERE source_agent = $1 AND kind = 'report'`, [ALICE])).rows[0].n).toBe(2);
    await alice.close();
    await bob.close();
  });

  it("capture: an inbox row exactly like POST /capture, source_agent from the credential", async () => {
    const alice = await connect("tok-alice");
    const r = await call(alice, "capture", { note: "# finding\nfrom mcp", filename: "../../evil.md" });
    expect(r.isError).toBe(false);
    expect(r.body.path).not.toContain("..");
    const row = (await pool.query(`SELECT source, source_agent, mime, note, sha256, status FROM inbox WHERE id = $1`, [r.body.id])).rows[0];
    expect(row).toEqual({ source: "mcp", source_agent: ALICE, mime: "text/markdown", note: "# finding\nfrom mcp", sha256: r.body.sha256, status: "new" });
    expect(await call(alice, "capture", {})).toMatchObject({ isError: true, body: { error: { code: "invalid_request" } } });
    const bin = await call(alice, "capture", { content_base64: Buffer.from("png").toString("base64"), mime: "image/png", note: "a screenshot" });
    expect((await pool.query(`SELECT mime, note FROM inbox WHERE id = $1`, [bin.body.id])).rows[0]).toEqual({ mime: "image/png", note: "a screenshot" });
    await alice.close();
  });

  it("knowledge tiers: none → not granted (never not found); index → titles only, no drafts; areas → scoped search + read", async () => {
    const alice = await connect("tok-alice"); // tier none
    for (const [tool, args] of [
      ["knowledge_search", { query: "alpha" }],
      ["knowledge_read", { path: "Knowledge/Areas/Itest/Alpha.md" }],
      ["knowledge_read", { path: "Knowledge/Areas/Itest/Nope.md" }], // absent AND ungranted: still "not granted"
    ] as const) {
      expect(await call(alice, tool, args), tool).toMatchObject({ isError: true, body: { error: { code: "forbidden", message: "not granted" } } });
    }
    await alice.close();

    grant("tok-index", { id: ALICE, grants: { tier: "index", areas: [] }, projects: [] });
    const idx = await connect("tok-index");
    const s = await call(idx, "knowledge_search", { query: "ALPHA" });
    expect(s.body.tier).toBe("index");
    expect(s.body.hits).toEqual([
      { path: "Knowledge/Areas/Itest/Alpha.md", title: "Alpha note", description: "about alpha" },
      { path: "Knowledge/Areas/Other/Gamma.md", title: "Gamma alpha", description: null },
    ]); // the draft matched "alpha" and is invisible
    expect((await call(idx, "knowledge_search", { query: "beta" })).body.hits).toEqual([{ path: "Knowledge/Areas/Itest/Sub/Beta.md", title: "Beta", description: null }]);
    expect((await call(idx, "knowledge_search", { query: "%" })).body.hits).toEqual([]); // LIKE metacharacters are literal
    expect(await call(idx, "knowledge_read", { path: "Knowledge/Areas/Itest/Alpha.md" })).toMatchObject({ isError: true, body: { error: { code: "forbidden" } } });
    await idx.close();

    grant("tok-areas", { id: ALICE, grants: { tier: "areas", areas: [AREA] }, projects: [] });
    const ar = await connect("tok-areas");
    expect((await call(ar, "knowledge_search", { query: "alpha" })).body.hits.map((h: any) => h.path)).toEqual(["Knowledge/Areas/Itest/Alpha.md"]); // Gamma is outside the grant
    expect(await call(ar, "knowledge_read", { path: "Knowledge/Areas/Other/Gamma.md" })).toMatchObject({ isError: true, body: { error: { code: "forbidden", message: "not granted" } } });
    expect(await call(ar, "knowledge_read", { path: "Knowledge/Areas/Itest/../Other/Gamma.md" })).toMatchObject({ isError: true, body: { error: { code: "invalid_request" } } });
    expect(await call(ar, "knowledge_read", { path: "Knowledge/Areas/Itest/Draft.md" })).toMatchObject({ isError: true, body: { error: { code: "not_found" } } }); // drafts: invisible
    expect(await call(ar, "knowledge_read", { path: "Knowledge/Areas/Itest/Missing.md" })).toMatchObject({ isError: true, body: { error: { code: "not_found" } } });
    // the index knows the note; the vault reader has nothing for it → not_found (reader-less deployments answer not_available, see the unit suite)
    expect(await call(ar, "knowledge_read", { path: "Knowledge/Areas/Itest/Alpha.md" })).toMatchObject({ isError: true, body: { error: { code: "not_found" } } });
    vault = { "Knowledge/Areas/Itest/Alpha.md": "---\ntitle: Alpha note\n---\n/not a command​ here" };
    const read = await call(ar, "knowledge_read", { path: "Knowledge/Areas/Itest/Alpha.md" });
    expect(read.isError).toBe(false);
    expect(read.body).toEqual({ path: "Knowledge/Areas/Itest/Alpha.md", title: "Alpha note", content: "---\ntitle: Alpha note\n---\n/not a command here", sha256: sha256Text(vault["Knowledge/Areas/Itest/Alpha.md"]!) });
    await ar.close();

    // every read AND every refusal is a runs row on the agent, carrying the grant it was judged under (§4.11 "every read logged")
    const { rows } = await pool.query(
      `SELECT tool, ok, error, meta FROM runs WHERE component = $1 AND kind = 'tool' AND tool LIKE 'knowledge_%' ORDER BY id`,
      [ALICE],
    );
    expect(rows.length).toBeGreaterThanOrEqual(12);
    expect(rows[0]).toMatchObject({ tool: "knowledge_search", ok: false, error: "forbidden", meta: { via: "mcp-brain", tier: "none" } });
    const okRead = rows.find((r) => r.tool === "knowledge_read" && r.ok === true);
    expect(okRead?.meta).toMatchObject({ tier: "areas", areas: [AREA], path: "Knowledge/Areas/Itest/Alpha.md" });
  });

  it("knowledge_write: internal only (external → not granted, nothing reaches the vault); bare Knowledge/ grant reads root notes and searches everything; provenance + CAS round trip; audited", async () => {
    const path = "Knowledge/Areas/Itest/Written.md";
    // an external agent with the widest imaginable grant still cannot write
    grant("tok-alice-wide", { id: ALICE, grants: { tier: "areas", areas: ["Knowledge/"] }, projects: [] });
    const alice = await connect("tok-alice-wide");
    expect(await call(alice, "knowledge_write", { path, content: "# Alice was here\n", message: "alice" })).toMatchObject({ isError: true, body: { error: { code: "forbidden", message: "not granted" } } });
    await alice.close();
    expect(writes).toHaveLength(0);

    // the instance's own assistant under the bare vault grant (the console's internal default)
    grant("tok-hub-vault", { id: HUB, kind: "internal", grants: { tier: "areas", areas: ["Knowledge/"] }, projects: [] });
    const hub = await connect("tok-hub-vault");
    // ...searches the whole index (the trailing-slash prefix is honoured in SQL), drafts still invisible
    expect((await call(hub, "knowledge_search", { query: "alpha" })).body.hits.map((h: any) => h.path)).toEqual(["Knowledge/Areas/Itest/Alpha.md", "Knowledge/Areas/Other/Gamma.md"]);

    // create-only write: stamped, queued, intent in the principal's name
    const created = await call(hub, "knowledge_write", { path, content: "# Written\n\nby the assistant\n", message: "itest: first write", expected_sha256: "" });
    expect(created.isError).toBe(false);
    expect(created.body).toMatchObject({ path, created: true, queued: true, provenance: { source: HUB } });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ path, intent: { principal: HUB, message: "itest: first write", group: HUB }, expected_sha256: "" });
    expect(writes[0]!.content).toMatch(new RegExp(`^---\\nsource: ${HUB}\\nupdated: \\d{4}-\\d{2}-\\d{2}\\n---\\n# Written\\n`));

    // read it back (the index knows it), then CAS: the read's sha wins, a stale sha conflicts and names the current one
    await pool.query(`INSERT INTO knowledge_files (path, title, description, draft) VALUES ($1, 'Written', NULL, false) ON CONFLICT (path) DO NOTHING`, [path]);
    const read = await call(hub, "knowledge_read", { path });
    expect(read.isError).toBe(false);
    expect(read.body.sha256).toBe(created.body.sha256);
    const updated = await call(hub, "knowledge_write", { path, content: read.body.content.replace("by the assistant", "by the assistant, twice"), message: "itest: second write", expected_sha256: read.body.sha256 });
    expect(updated.isError).toBe(false);
    expect(updated.body).toMatchObject({ path, created: false });
    expect(writes[1]!.content.match(/^source: /gm)).toHaveLength(1); // merged, not stacked
    const stale = await call(hub, "knowledge_write", { path, content: "x", message: "itest: stale", expected_sha256: read.body.sha256 });
    expect(stale).toMatchObject({ isError: true, body: { error: { code: "conflict", message: expect.stringContaining(updated.body.sha256) } } });
    await hub.close();

    // audit: every call is a runs row on its agent, the refusal included, with the grant it was judged under and the content clipped
    const { rows } = await pool.query(`SELECT component, ok, error, meta FROM runs WHERE kind = 'tool' AND tool = 'knowledge_write' AND component IN ($1, $2) ORDER BY id`, [ALICE, HUB]);
    expect(rows.map((r) => [r.component, r.ok, r.error])).toEqual([
      [ALICE, false, "forbidden"],
      [HUB, true, null],
      [HUB, true, null],
      [HUB, false, "conflict"],
    ]);
    expect(rows[0]!.meta).toMatchObject({ via: "mcp-brain", kind: "external", path });
    expect(rows[1]!.meta).toMatchObject({ kind: "internal", tier: "areas", areas: ["Knowledge/"], path, created: true, provenance: { source: HUB } });
    expect(rows[1]!.meta.args.content).toMatch(/^<\d+ chars>$/);
    expect(rows[3]!.meta.current_sha256).toBe(updated.body.sha256);
  });

  it("every tool call is a two-phase runs row on the agent (kind=tool), with args summarized and bodies clipped", async () => {
    // the artifacts module is not wired in this suite (its own suite covers it): each artifact_* call is a recorded not_available
    const ar = await connect("tok-alice");
    const artId = "art_01J00000000000000000000000";
    const verId = "ver_01J00000000000000000000000";
    const cmtId = "cmt_01J00000000000000000000000";
    for (const [name, args] of [
      ["artifact_publish", { project: PA, slug: "x", files: [{ path: "a.md", content: "a" }], idempotency_key: "k", message: "m" }],
      ["artifact_get", { id: artId }],
      ["artifact_list", {}],
      ["artifact_comment", { artifact: artId, version: verId, body: "b" }],
      ["artifact_comment_resolve", { id: cmtId }],
      ["artifact_dispatch_review", { artifact: artId, version: verId, thread_ids: [cmtId], to_agent: BOB }],
    ] as const) {
      expect((await call(ar, name, args)).body.error.code, name).toBe("not_available");
    }
    // crew_dispatch is the assistant's alone: an external agent is told not granted before any dispatcher is consulted (none is wired here) — still a recorded refusal
    expect((await call(ar, "crew_dispatch", { crew: "researcher", brief: "b" })).body).toEqual({ error: { code: "forbidden", message: "not granted" } });
    await ar.close();
    const { rows } = await pool.query(
      `SELECT tool, ok, finished_at IS NOT NULL AS finished, meta FROM runs WHERE component = $1 AND kind = 'tool' ORDER BY id`,
      [ALICE],
    );
    const tools = new Set(rows.map((r) => r.tool));
    for (const t of TOOL_NAMES) expect(tools.has(t), t).toBe(true);
    expect(rows.every((r) => r.finished && r.ok !== null)).toBe(true);
    const rep = rows.find((r) => r.tool === "report" && r.ok);
    expect(rep.meta.args.body).toBe("<7 chars>");
    expect(rep.meta).toMatchObject({ proposal_id: expect.any(Number), deduplicated: false });
    const cap = rows.find((r) => r.tool === "capture" && r.meta.args.content_base64);
    expect(cap.meta.args.content_base64).toMatch(/^<\d+ chars>$/);
  });
});
