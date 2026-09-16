// artifacts_* through the real MCP client against the scratch db: scope is
// exercised by swapping principals, the boundary by a target outside the
// project, the cap by replying past it. The reader-less/module-less
// deployment answers not_available. Skipped without a db.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { TasksService } from "@foldedspacelabs/metistry-tasks";
import { ArtifactsService, memoryVault, staticDirectory } from "@foldedspacelabs/metistry-artifacts";
import { ALIAS_NAMES, ARTIFACTS_TOOL_NAMES, QUERIES_TOOL_NAMES, createBrainServer, TOOL_NAMES, type AgentPrincipal, type Db } from "../src/index.js";
import { loadTestEnv } from "@foldedspacelabs/metistry-core/test-env";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url)); // METISTRY_DB_* only, and nothing of the operator's install (docs/ops/testing.md)
const P = "itest-brain-art";
const ALICE = "itest-brain-art-alice";
const BOB = "itest-brain-art-bob";
const CAROL = "itest-brain-art-carol";

interface Parsed {
  isError: boolean;
  body: any;
  nudge: string | null;
}

/** A brain with no artifacts/crews/queries wired and a logging fake db — enough to inspect the listed surface. */
async function bareServer(): Promise<{ client: Client; log: string[]; close: () => Promise<void> }> {
  const log: string[] = [];
  const db: Db = {
    async query(text, params) {
      log.push(params ? `${text} ${JSON.stringify(params)}` : text);
      return text.startsWith("INSERT INTO runs") ? { rows: [{ id: 1 }] } : { rows: [] };
    },
  };
  const alice: AgentPrincipal = { id: "a", grants: { tier: "none", areas: [] }, projects: ["p"] };
  const brain = createBrainServer({ db, authenticate: async () => alice, tasks: new TasksService(db), inboxDir: "/tmp/unused" });
  const http = createServer((req, res) => void brain.handle(req, res));
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const client = new Client({ name: "t", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(http.address() as AddressInfo).port}`), { requestInit: { headers: { authorization: "Bearer x" } } }));
  return { client, log, close: async () => { await client.close(); await new Promise<void>((r) => http.close(() => r())); } };
}

describe("tool surface", () => {
  it("the six artifact tools are on the eager surface, contiguous and ahead of agents_delegate then queries_*, and the total stays near the lazy threshold", () => {
    const tail = ARTIFACTS_TOOL_NAMES.length + 1 + QUERIES_TOOL_NAMES.length; // artifacts + agents_delegate + queries_*
    expect(TOOL_NAMES.slice(-tail, -1 - QUERIES_TOOL_NAMES.length)).toEqual([...ARTIFACTS_TOOL_NAMES]);
    expect(TOOL_NAMES.at(-1 - QUERIES_TOOL_NAMES.length)).toBe("agents_delegate");
    expect(TOOL_NAMES.slice(-QUERIES_TOOL_NAMES.length)).toEqual([...QUERIES_TOOL_NAMES]);
    expect(TOOL_NAMES.length).toBeLessThan(24); // over the PoC-17 tool-COUNT guidance (>20) since knowledge_list/knowledge_grep and tasks_close — flagged in manifest.yaml; the definition-token axis (test/brain.test.ts) is what actually gates lazy
  });

  it("the whole eager surface stays inside the PoC-17 definition budget, and deprecated names cost it nothing", async () => {
    const { client, close } = await bareServer();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([...TOOL_NAMES]);
    // The budget PoC-17 measured: past >20 tools / >5k definition tokens a
    // bridge switches to discovery: lazy. chars/4 is the conservative estimate
    // (the word-based one lands ~1.5k lower). Measured 2026-09-09: 19,370
    // chars ≈ 4.8k tokens. This is exactly why the eleven deprecated
    // spellings resolve at call time instead of being registered: a second
    // copy of these schemas would blow the budget on its own.
    const chars = JSON.stringify(tools).length;
    expect(chars / 4).toBeLessThan(5_000);
    for (const alias of ALIAS_NAMES) expect(tools.map((t) => t.name)).not.toContain(alias);
    await close();
  });

  it("a deprecated name is still callable for one release, and lands on the primary tool", async () => {
    const { client, close, log } = await bareServer();
    const r = (await client.callTool({ name: "tasks_mine", arguments: {} })) as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(r.content[0]!.text)).toEqual({ filter: "mine", tasks: [] }); // tasks_mine === tasks_list { filter: "mine" }
    // audited under the PRIMARY name, with the deprecated spelling in meta.alias so the stragglers are countable
    const run = log.find((l) => l.startsWith("INSERT INTO runs"));
    expect(run).toContain('"tasks_list"');
    expect(run).toContain(String.raw`\"alias\":\"tasks_mine\"`); // meta rides as a JSON parameter
    await close();
  });

  it("without the module, artifacts_* answers not_available (a capability gap, recorded)", async () => {
    const log: string[] = [];
    const db: Db = { async query(text) { log.push(text); return text.startsWith("INSERT INTO runs") ? { rows: [{ id: 1 }] } : { rows: [] }; } };
    const alice: AgentPrincipal = { id: "a", grants: { tier: "none", areas: [] }, projects: ["p"] };
    const brain = createBrainServer({ db, authenticate: async () => alice, tasks: new TasksService(db), inboxDir: "/tmp/unused" });
    const server = createServer((req, res) => void brain.handle(req, res));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const client = new Client({ name: "t", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`), { requestInit: { headers: { authorization: "Bearer x" } } }));
    const r = (await client.callTool({ name: "artifacts_list", arguments: {} })) as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0]!.text).error.code).toBe("not_available");
    await client.close();
    await new Promise<void>((r) => server.close(() => r()));
    expect(log.filter((l) => l.startsWith("INSERT INTO runs"))).toHaveLength(1);
    expect((await brain.check()).meta).toMatchObject({ artifacts: "not_available" });
  });
});

describe.skipIf(!hasDb)("artifacts_* (real db, real MCP client)", () => {
  let pool: pg.Pool;
  let server: Server;
  let base: string;
  const principals = new Map<string, AgentPrincipal>();

  async function connect(token: string): Promise<Client> {
    const client = new Client({ name: "itest", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
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
    await pool.query(`DELETE FROM artifact_comments WHERE artifact_id IN (SELECT id FROM artifacts WHERE project = $1)`, [P]);
    await pool.query(`DELETE FROM artifact_versions WHERE artifact_id IN (SELECT id FROM artifacts WHERE project = $1)`, [P]);
    await pool.query(`DELETE FROM artifacts WHERE project = $1`, [P]);
    await pool.query(`DELETE FROM work WHERE project = $1`, [P]);
    await pool.query(`DELETE FROM proposals WHERE source_agent IN ($1, $2, $3)`, [ALICE, BOB, CAROL]);
    await pool.query(`DELETE FROM runs WHERE component IN ($1, $2, $3)`, [ALICE, BOB, CAROL]);
    const tasks = new TasksService(pool);
    const artifacts = new ArtifactsService(pool, memoryVault(), {
      origin: "https://itest.example",
      tasks,
      agents: staticDirectory([
        { id: ALICE, kind: "external", projects: [P], revoked: false },
        { id: BOB, kind: "external", projects: [P], revoked: false },
        { id: CAROL, kind: "external", projects: ["elsewhere"], revoked: false },
      ]),
      pingPongCap: 2,
    });
    const brain = createBrainServer({
      db: pool,
      authenticate: async (req) => {
        const m = /^Bearer\s+(\S+)$/.exec(req.headers.authorization ?? "");
        return (m?.[1] && principals.get(m[1])) || null;
      },
      tasks,
      artifacts,
      inboxDir: `/tmp/metistry-test-inbox-brain-art-${Date.now()}`,
    });
    server = createServer((req, res) => {
      if (req.url === "/mcp") void brain.handle(req, res).catch(() => res.destroy());
      else res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    principals.set("tok-alice", { id: ALICE, grants: { tier: "none", areas: [] }, projects: [P] });
    principals.set("tok-bob", { id: BOB, grants: { tier: "none", areas: [] }, projects: [P] });
    principals.set("tok-carol", { id: CAROL, grants: { tier: "none", areas: [] }, projects: ["elsewhere"] });
    expect((await brain.check()).meta).toMatchObject({ artifacts: "available" });
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await pool.end();
  });

  let artifactId: string;
  let versionId: string;
  let threadId: string;

  it("publish → get → list, scoped to the project; a stale CAS is a conflict; a retry is deduplicated", async () => {
    const alice = await connect("tok-alice");
    const carol = await connect("tok-carol");
    const pub = await call(alice, "artifacts_publish", { project: P, slug: "brief", files: [{ path: "brief.md", content: "# Brief\n\n‮evil" }], expected_current_version: null, idempotency_key: "b-1", message: "brief v1" });
    expect(pub.isError).toBe(false);
    artifactId = pub.body.artifact.id;
    versionId = pub.body.version.id;
    expect(pub.body.links.review).toBe(`https://itest.example/#/artifacts/${artifactId}/${versionId}/review`);
    expect(pub.body.artifact.created_by).toBe(ALICE);

    const again = await call(alice, "artifacts_publish", { project: P, slug: "brief", files: [{ path: "brief.md", content: "x" }], idempotency_key: "b-1", message: "retry" });
    expect(again.body).toMatchObject({ deduplicated: true, version: { id: versionId } });
    const stale = await call(alice, "artifacts_publish", { project: P, slug: "brief", files: [{ path: "brief.md", content: "x" }], expected_current_version: null, idempotency_key: "b-2", message: "stale" });
    expect(stale.isError).toBe(true);
    expect(stale.body.error.code).toBe("conflict");

    const got = await call(alice, "artifacts_get", { id: artifactId, path: "brief.md" });
    expect(got.body.version.id).toBe(versionId);
    expect(got.body.versions).toHaveLength(1);
    expect(got.body.file.content).toBe("# Brief\n\nevil"); // the bidi override was stripped at the text boundary
    expect((await call(alice, "artifacts_list", { project: P })).body.artifacts.map((a: any) => a.id)).toContain(artifactId);

    // carol is not a member: nothing exists for her, and she cannot publish in
    expect((await call(carol, "artifacts_get", { id: artifactId })).body.error.code).toBe("not_found");
    expect((await call(carol, "artifacts_list", {})).body.artifacts).toEqual([]);
    expect((await call(carol, "artifacts_publish", { project: P, slug: "sneak", files: [{ path: "a.md", content: "x" }], idempotency_key: "c-1", message: "m" })).body.error.code).toBe("forbidden");
    await alice.close();
    await carol.close();
  });

  it("comment → reply → the cap demotes the thread; resolve; dispatch inside the project makes one review task the target is nudged about", async () => {
    const alice = await connect("tok-alice");
    const bob = await connect("tok-bob");
    const root = await call(alice, "artifacts_comment", { artifact: artifactId, version: versionId, body: "tighten", path: "brief.md", anchor: { line: 1 } });
    expect(root.body.comment).toMatchObject({ author_principal: ALICE, author_kind: "agent", anchor: { line: 1 } });
    threadId = root.body.comment.id;
    expect((await call(bob, "artifacts_comment", { artifact: artifactId, version: versionId, body: "done", parent: threadId })).body.comment.parent_id).toBe(threadId);
    const capped = await call(alice, "artifacts_comment", { artifact: artifactId, version: versionId, body: "more", parent: threadId });
    expect(capped.body).toMatchObject({ demoted: true, cap: 2 });
    expect((await call(alice, "artifacts_get", { id: artifactId })).body.threads[0].replies).toHaveLength(1);

    const d = await call(alice, "artifacts_review", { artifact: artifactId, version: versionId, thread_ids: [threadId], to_agent: BOB, message: "please" });
    expect(d.body.route).toBe("work");
    expect(d.body.work).toMatchObject({ kind: "review", project: P, owner: BOB });
    const seen = await call(bob, "artifacts_list", { project: P });
    expect(seen.nudge).toContain("1 review bundle queued for you — call tasks_list");
    const ready = await call(bob, "tasks_list", { project: P });
    expect(ready.body.tasks.map((t: any) => t.id)).toContain(d.body.work.id);
    expect((await call(bob, "tasks_claim", { id: d.body.work.id })).body.ok).toBe(true);
    expect((await call(bob, "artifacts_resolve", { id: threadId })).body.comment.state).toBe("resolved");

    // across the boundary: carol is not a member → a proposal, not a task
    const out = await call(alice, "artifacts_review", { artifact: artifactId, version: versionId, thread_ids: [threadId], to_agent: CAROL });
    expect(out.body).toMatchObject({ route: "proposal", reason: "outside_project" });
    const prop = await pool.query(`SELECT kind, source_agent, decision FROM proposals WHERE id = $1`, [out.body.proposal_id]);
    expect(prop.rows[0]).toEqual({ kind: "review", source_agent: ALICE, decision: "pending" });
    const runs = await pool.query(`SELECT count(*)::int AS n FROM runs WHERE component = $1 AND kind = 'tool' AND tool LIKE 'artifacts_%' AND ok`, [ALICE]);
    expect(runs.rows[0]!.n).toBeGreaterThanOrEqual(6);
    await alice.close();
    await bob.close();
  });
});
