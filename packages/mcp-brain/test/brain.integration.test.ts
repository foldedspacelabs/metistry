// The bridge against the real (scratch) database, driven by the real MCP
// client over Streamable HTTP — misuse tests first (invariant 8): the
// principal is injected, so every trust rule is exercised by swapping
// tokens, never by asking the tools nicely. Skipped without a db.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { TasksService } from "@foldedspacelabs/metistry-tasks";
import { EmbedUnavailableError, mintToken } from "@foldedspacelabs/metistry-core";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { createBrainServer, EAGER_TOOL_NAMES, sha256Text, TURN_ID_META_KEY, type AgentPrincipal, type VaultWriteRequest } from "../src/index.js";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url)); // METISTRY_DB_* only, and nothing of the operator's install (docs/ops/testing.md)
const PA = "itest-brain-a";
const PB = "itest-brain-b";
const ALICE = "itest-brain-alice";
const BOB = "itest-brain-bob";
const HUB = "itest-brain-hub";
const AREA = "Areas/Itest";
const EMBED_MODEL = "itest-embed";
const EMBED_DIM = 768;

/** Deterministic stand-in for a real embedding: a normalized bag of words. */
function fakeVector(text: string): number[] {
  const v = new Array<number>(EMBED_DIM).fill(0);
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let h = 2166136261;
    for (let i = 0; i < word.length; i++) h = Math.imul(h ^ word.charCodeAt(i), 16777619);
    v[Math.abs(h) % EMBED_DIM] += 1;
  }
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}
const vectorOf = (text: string) => `[${fakeVector(text).join(",")}]`;

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
  let embedderDown = false; // the injected query embedder, switched off to prove the degrade
  const writes: VaultWriteRequest[] = []; // the injected writer records what would reach the vault bridge

  const grant = (token: string, p: AgentPrincipal) => principals.set(token, p);

  async function connect(token: string): Promise<Client> {
    const client = new Client({ name: "itest", version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }),
    );
    return client;
  }

  async function call(client: Client, name: string, args: Record<string, unknown> = {}, meta?: Record<string, unknown>): Promise<Parsed> {
    const r = (await client.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) })) as { isError?: boolean; content: { type: string; text: string }[] };
    const text = r.content[0]!.text;
    const nl = text.indexOf("\n");
    return { isError: !!r.isError, body: JSON.parse(nl === -1 ? text : text.slice(0, nl)), nudge: nl === -1 ? null : text.slice(nl + 1) };
  }

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
    await pool.query(`DELETE FROM work WHERE project IN ($1, $2)`, [PA, PB]);
    await pool.query(`DELETE FROM proposals WHERE source_agent IN ($1, $2, $3)`, [ALICE, BOB, HUB]);
    await pool.query(`DELETE FROM runs WHERE component IN ($1, $2, $3)`, [ALICE, BOB, HUB]);
    await pool.query(`DELETE FROM inbox WHERE source_agent IN ($1, $2, $3)`, [ALICE, BOB, HUB]);
    // `Knowledge/…` too: a scratch db that ran this suite before the
    // 2026-09-17 layout still holds rows under the old prefix, and they would
    // show up in every unscoped search below
    await pool.query(
      `DELETE FROM knowledge_files WHERE path LIKE 'Areas/Itest%' OR path LIKE 'Areas/Other/Gamma%'
         OR path LIKE 'Knowledge/Areas/Itest%' OR path LIKE 'Knowledge/Areas/Other/Gamma%'`,
    );
    await pool.query(
      `INSERT INTO knowledge_files (path, title, description, draft) VALUES
        ('Areas/Itest/Alpha.md', 'Alpha note', 'about alpha', false),
        ('Areas/Itest/Sub/Beta.md', NULL, NULL, false),
        ('Areas/Itest/Draft.md', 'Alpha draft', 'unsettled alpha', true),
        ('Areas/Other/Gamma.md', 'Gamma alpha', NULL, false)`,
    );

    const queries = new QueryStore(pool);
    queries.load(`
name: itest_numbers
description: fixture query for queries_list/queries_run tests
params:
  n: { type: int, default: 3 }
sql: SELECT generate_series(1, :n) AS n
cache_ttl: 0
`);

    const brain = createBrainServer({
      db: pool,
      queries,
      authenticate: async (req) => {
        const m = /^Bearer\s+(\S+)$/.exec(req.headers.authorization ?? "");
        return (m?.[1] && principals.get(m[1])) || null;
      },
      tasks: new TasksService(pool),
      inboxDir: `/tmp/metistry-test-inbox-brain-${Date.now()}`,
      readKnowledge: async (path) => (vault ? (vault[path] ?? null) : null),
      // Fakes standing in for the reconciler's GET /vault/list and GET
      // /vault/search?mode=keyword — a directory listing and a substring
      // search over the SAME in-memory `vault` map knowledge_read uses,
      // for knowledge_list / knowledge_grep.
      listKnowledge: async (prefix, depth) => {
        if (!vault) return [];
        const seen = new Map<string, "file" | "dir">();
        for (const path of Object.keys(vault)) {
          if (prefix && path !== prefix && !path.startsWith(`${prefix}/`)) continue;
          const rest = prefix ? path.slice(prefix.length + 1) : path;
          const segs = rest.split("/");
          let acc = prefix;
          for (let i = 0; i < segs.length && i < depth; i++) {
            acc = acc ? `${acc}/${segs[i]}` : segs[i]!;
            seen.set(acc, i === segs.length - 1 ? "file" : "dir");
          }
        }
        return [...seen.entries()].map(([path, kind]) => ({ path, kind }));
      },
      searchVaultKeyword: async (q, limit) => {
        if (!vault) return [];
        const needle = q.toLowerCase();
        return Object.entries(vault)
          .filter(([path, content]) => path.toLowerCase().includes(needle) || content.toLowerCase().includes(needle))
          .slice(0, limit)
          .map(([path]) => ({ path }));
      },
      // A deterministic stand-in for nomic-embed-text: a normalized
      // bag-of-words vector. It only has to be stable and to put lexically
      // related text closer, which is all an ordering assertion needs.
      embedder: {
        model: EMBED_MODEL,
        embedOne: async (q: string) => {
          if (embedderDown) throw new EmbedUnavailableError("stub embedder is down");
          return fakeVector(q);
        },
      },
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
    expect(tools.map((t) => t.name)).toEqual([...EAGER_TOOL_NAMES]);
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

    // create outside membership is refused as not granted (a project you are not in is a write across the boundary).
    // You NAMED the project, so this one is allowed to say which and who adds you — unlike every tasks_* by id,
    // where a row outside your projects does not exist for you (below).
    const bad = await call(alice, "tasks_create", { title: "sneak", project: PB });
    expect(bad).toMatchObject({ isError: true, body: { error: { code: "forbidden", message: expect.stringMatching(/^not granted — .* is not a member of project `.*`/) } } });

    const a1 = await call(alice, "tasks_create", { title: "A1", project: PA, idempotency_key: `${PA}-a1` });
    expect(a1.isError).toBe(false);
    expect(a1.body.task).toMatchObject({ title: "A1", project: PA, status: "open", created_by: ALICE });
    const again = await call(alice, "tasks_create", { title: "A1 retry", project: PA, idempotency_key: `${PA}-a1` });
    expect(again.body.task.id).toBe(a1.body.task.id); // idempotent
    const b1 = await call(bob, "tasks_create", { title: "B1", project: PB });
    const aId = a1.body.task.id as number;
    const bId = b1.body.task.id as number;

    // listing: each sees only its own projects
    expect((await call(alice, "tasks_list")).body.tasks.map((t: any) => t.id)).toEqual([aId]);
    expect((await call(bob, "tasks_list")).body.tasks.map((t: any) => t.id)).toEqual([bId]);
    expect(await call(alice, "tasks_list", { project: PB })).toMatchObject({ isError: true, body: { error: { code: "not_found" } } });

    // every holder verb on a task outside the boundary is uniformly not_found
    for (const [tool, args] of [
      ["tasks_claim", { id: bId }],
      ["tasks_renew", { id: bId }],
      ["tasks_update", { id: bId, note: "x" }],
      ["tasks_release", { id: bId }],
      ["tasks_close", { id: bId }],
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
      const all = await call(hub, "tasks_list");
      expect(ours(all.body.tasks)).toEqual([aId, bId]);
      expect(all.body.tasks.every((t: any) => t.project !== null)).toBe(true);
      expect(all.nudge).toContain(`1 task ready in project ${PA} — call tasks_list`);
      expect(all.nudge).toContain(`1 task ready in project ${PB} — call tasks_list`);
      expect((await call(hub, "tasks_list", { project: PB })).body.tasks.map((t: any) => t.id)).toEqual([bId]);
      const created = await call(hub, "tasks_create", { title: "H1", project: PB, idempotency_key: `${PB}-h1` });
      expect(created.isError).toBe(false);
      expect(created.body.task).toMatchObject({ project: PB, created_by: HUB });
      await pool.query(`DELETE FROM work WHERE id = $1`, [created.body.task.id]); // keep the later nudge arithmetic exact

      // a task with NO project is invisible even to the every-project principal (a project is the unit of coordination)
      const orphan = Number((await pool.query(`INSERT INTO work (title, kind, status) VALUES ('orphan', 'task', 'open') RETURNING id`)).rows[0].id);
      expect((await call(hub, "tasks_list")).body.tasks.map((t: any) => t.id)).not.toContain(orphan);
      expect((await call(hub, "tasks_claim", { id: orphan })).body.error.code).toBe("not_found");
      await pool.query(`DELETE FROM work WHERE id = $1`, [orphan]);

      // narrowed internal: PA only — PB is not_found / forbidden exactly as for alice
      expect((await call(narrow, "tasks_list")).body.tasks.map((t: any) => t.id)).toEqual([aId]);
      expect((await call(narrow, "tasks_claim", { id: bId })).body.error.code).toBe("not_found");
      expect((await call(narrow, "tasks_create", { title: "sneak", project: PB })).body.error.code).toBe("forbidden");

      // the rule is kind-gated: an external principal with an empty list still sees nothing
      expect((await call(nobody, "tasks_list")).body).toEqual({ filter: "ready", tasks: [] });
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
    const mine = await call(alice, "tasks_list", { filter: "mine" });
    expect(mine.body).toEqual({ filter: "mine", tasks: [] });
    expect(mine.nudge).toBe(`nudge: 1 task ready in project ${PA} — call tasks_list`);
    expect((await call(bob, "tasks_list", { filter: "mine" })).nudge).toBe(`nudge: 1 task ready in project ${PB} — call tasks_list`);

    const claim = await call(alice, "tasks_claim", { id: Number(aId), lease_seconds: 60 });
    expect(claim.body).toMatchObject({ ok: true, task: { id: Number(aId), claimed_by: ALICE, status: "in_progress" } });
    // the ready nudge is gone; the lease (60s < the 120s warning line) is flagged instead
    expect(claim.nudge).toMatch(new RegExp(`^nudge: claim on task #${aId} expires in \\d+s — call tasks_renew$`));

    const hb = await call(alice, "tasks_renew", { id: Number(aId), lease_seconds: 900 });
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

  it("tasks_close: closes a held task in one call — same effect as tasks_update status closed, holder-only, refused once already closed", async () => {
    const alice = await connect("tok-alice");
    const bob = await connect("tok-bob");
    const created = await call(alice, "tasks_create", { title: "close me", project: PA, idempotency_key: `${PA}-close-1` });
    const id = created.body.task.id as number;
    await call(alice, "tasks_claim", { id });

    // out of scope (bob is not in PA): not_found, same as tasks_update
    expect((await call(bob, "tasks_close", { id })).body.error.code).toBe("not_found");

    const closed = await call(alice, "tasks_close", { id, note: "shipped" });
    expect(closed.body).toMatchObject({ ok: true, task: { id, status: "closed", claimed_by: null, lease_expires_at: null } });
    expect(closed.body.task.history.at(-1)).toMatchObject({ agent: ALICE, op: "update", status: "closed", note: "shipped" });

    // already closed: a data outcome (not an error envelope), same shape tasks_update would give
    const again = await call(alice, "tasks_close", { id });
    expect(again).toMatchObject({ isError: false, body: { ok: false, reason: "closed" } });

    await alice.close();
    await bob.close();
  });

  it("**an agent may set a description at create and never edit it** (T1-1, C85) — tasks_update has no such key, so no call reaches the column", async () => {
    const alice = await connect("tok-alice");
    const stored = async (id: number) => (await pool.query(`SELECT description FROM work WHERE id = $1`, [id])).rows[0]!.description as string | null;

    // the schema says so before anything is called: create takes it, update does not
    const { tools } = await alice.listTools();
    const props = (name: string) => (tools.find((t) => t.name === name)!.inputSchema as { properties: Record<string, { maxLength?: number }> }).properties;
    expect(props("tasks_create").description).toMatchObject({ maxLength: 2000 });
    expect(Object.keys(props("tasks_update"))).not.toContain("description");

    const created = await call(alice, "tasks_create", { title: "described by alice", project: PA, idempotency_key: `${PA}-desc-1`, description: "Why the fold skips drafts." });
    expect(created.isError).toBe(false);
    const id = created.body.task.id as number;
    expect(created.body.task.description).toBe("Why the fold skips drafts.");
    expect(await stored(id)).toBe("Why the fold skips drafts.");

    // an idempotent retry is the same create — it does not become an edit
    await call(alice, "tasks_create", { title: "described by alice", project: PA, idempotency_key: `${PA}-desc-1`, description: "a rewrite through the retry" });
    expect(await stored(id)).toBe("Why the fold skips drafts.");

    // the holder, mid-task, tries to rewrite it: alone the key is not a change at all …
    expect((await call(alice, "tasks_claim", { id })).body.ok).toBe(true);
    const alone = await call(alice, "tasks_update", { id, description: "rewritten by the agent" });
    expect(alone).toMatchObject({ isError: true, body: { error: { code: "invalid_request" } } });
    // … and riding on a legitimate note it is dropped before the service sees it
    const riding = await call(alice, "tasks_update", { id, note: "halfway", description: "rewritten by the agent" });
    expect(riding.body).toMatchObject({ ok: true, task: { id, description: "Why the fold skips drafts." } });
    expect(await stored(id)).toBe("Why the fold skips drafts.");

    // over the cap at create is refused by the schema, and no row is written
    const before = (await pool.query(`SELECT count(*)::int AS n FROM work WHERE project = $1`, [PA])).rows[0]!.n;
    const long = (await alice.callTool({ name: "tasks_create", arguments: { title: "too much", project: PA, description: "d".repeat(2001) } })) as { isError?: boolean };
    expect(long.isError).toBe(true);
    expect((await pool.query(`SELECT count(*)::int AS n FROM work WHERE project = $1`, [PA])).rows[0]!.n).toBe(before);

    // tidy so later list/nudge assertions stay exact
    await call(alice, "tasks_close", { id });
    await alice.close();
  });

  it("sanitizer: bidi/zero-width stripped and no leading slash on anything rendered, while the row keeps what was stored", async () => {
    const alice = await connect("tok-alice");
    const raw = "/clear ‮evil​ title";
    const created = await call(alice, "tasks_create", { title: raw, project: PA, idempotency_key: `${PA}-sanit` });
    expect(created.body.task.title).toBe("clear evil title");
    const stored = await pool.query(`SELECT title FROM work WHERE id = $1`, [created.body.task.id]);
    expect(stored.rows[0].title).toBe(raw); // the boundary is on the way OUT to an agent, not a rewrite of the record
    const listed = await call(alice, "tasks_list", { project: PA });
    expect(listed.body.tasks.map((t: any) => t.title)).toEqual(["clear evil title"]);
    // tidy so later nudge assertions stay exact
    await call(alice, "tasks_claim", { id: created.body.task.id });
    await call(alice, "tasks_update", { id: created.body.task.id, status: "closed" });
    await alice.close();
  });

  it("requests_create: a `report` request row with server-side provenance; idempotent on key; same title within 24h suppressed", async () => {
    const alice = await connect("tok-alice");
    const first = await call(alice, "requests_create", { title: "Found a thing", body: "details", kind: "finding", refs: ["gh:x/y#1"], idempotency_key: "rep-1" });
    expect(first.isError).toBe(false);
    expect(first.body.deduplicated).toBe(false);
    const id = first.body.id as number;
    const row = (await pool.query(`SELECT kind, source_agent, trust, decision, payload FROM proposals WHERE id = $1`, [id])).rows[0];
    expect(row).toMatchObject({ kind: "report", source_agent: ALICE, trust: "external", decision: "pending" });
    expect(row.payload).toMatchObject({ title: "Found a thing", body: "details", kind: "finding", refs: ["gh:x/y#1"], idempotency_key: "rep-1", provenance: { agent: ALICE, via: "mcp-brain" } });

    expect(await call(alice, "requests_create", { title: "different title", body: "retry", idempotency_key: "rep-1" })).toMatchObject({ body: { id, deduplicated: "idempotency_key" } });
    expect(await call(alice, "requests_create", { title: "Found a thing", body: "again", idempotency_key: "rep-2" })).toMatchObject({ body: { id, deduplicated: "title" } });
    // another agent's identical title is NOT a duplicate — dedupe is per agent
    const bob = await connect("tok-bob");
    const bobs = await call(bob, "requests_create", { title: "Found a thing", body: "bob's" });
    expect(bobs.body.deduplicated).toBe(false);
    expect(bobs.body.id).not.toBe(id);
    // secret-named fields never reach the queue
    const leaky = await call(alice, "requests_create", { title: "creds", body: "x", refs: ["api_key=abc"], idempotency_key: "rep-3" });
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
      ["knowledge_read", { path: "Areas/Itest/Alpha.md" }],
      ["knowledge_read", { path: "Areas/Itest/Nope.md" }], // absent AND ungranted: still "not granted"
    ] as const) {
      // "not granted", and nothing past it that could tell an absent page from an ungranted one:
      // tier `none` may not list, so no area is ever named (the 2026-09-19 boundary).
      expect(await call(alice, tool, args), tool).toMatchObject({ isError: true, body: { error: { code: "forbidden", message: expect.stringMatching(/^not granted/) } } });
    }
    await alice.close();

    grant("tok-index", { id: ALICE, grants: { tier: "index", areas: [] }, projects: [] });
    const idx = await connect("tok-index");
    const s = await call(idx, "knowledge_search", { query: "ALPHA" });
    expect(s.body.tier).toBe("index");
    expect(s.body.mode).toBe("keyword"); // nothing embedded yet: the default is keyword, not empty
    expect(s.body.hits).toEqual([
      { path: "Areas/Itest/Alpha.md", title: "Alpha note", description: "about alpha", score: 1 },
      { path: "Areas/Other/Gamma.md", title: "Gamma alpha", description: null, score: 0.5 },
    ]); // the draft matched "alpha" and is invisible
    expect((await call(idx, "knowledge_search", { query: "beta" })).body.hits).toEqual([{ path: "Areas/Itest/Sub/Beta.md", title: "Beta", description: null, score: 1 }]);
    // an explicit mode with nothing embedded answers in keyword and says so, rather than failing or returning empty
    const askedSemantic = await call(idx, "knowledge_search", { query: "ALPHA", mode: "semantic" });
    expect(askedSemantic.isError).toBe(false);
    expect(askedSemantic.body).toMatchObject({ mode: "keyword", degraded: expect.stringContaining("no embeddings stored") });
    expect((await call(idx, "knowledge_search", { query: "%" })).body.hits).toEqual([]); // LIKE metacharacters are literal
    // Alpha is a real, settled row this tier can already see in the hits
    // above — so the refusal names the area rather than the bare string
    // (ruled 2026-09-19, PR #216 judgement call B).
    const scoped = await call(idx, "knowledge_read", { path: "Areas/Itest/Alpha.md" });
    expect(scoped).toMatchObject({
      isError: true,
      body: { error: { code: "forbidden", message: expect.stringContaining(`\`${AREA}\``) }, reason: "scope_required", grantedScope: AREA },
    });
    expect(scoped.body.error.message).toContain("request_access");
    // a path merely shaped like one, never indexed, confirms nothing — the
    // uniform "not granted" holds, with no area named either way
    const guessed = await call(idx, "knowledge_read", { path: "Areas/Itest/DoesNotExist.md" });
    expect(guessed).toMatchObject({ isError: true, body: { error: { code: "forbidden", message: "not granted" } } });
    expect(JSON.stringify(guessed.body)).not.toContain("grantedScope");
    // a draft is invisible at every tier (never listed, never searched) —
    // guessing its exact path must not confirm it exists either
    const draftGuess = await call(idx, "knowledge_read", { path: "Areas/Itest/Draft.md" });
    expect(draftGuess).toMatchObject({ isError: true, body: { error: { code: "forbidden", message: "not granted" } } });
    expect(JSON.stringify(draftGuess.body)).not.toContain("grantedScope");
    await idx.close();

    grant("tok-areas", { id: ALICE, grants: { tier: "areas", areas: [AREA] }, projects: [] });
    const ar = await connect("tok-areas");
    expect((await call(ar, "knowledge_search", { query: "alpha" })).body.hits.map((h: any) => h.path)).toEqual(["Areas/Itest/Alpha.md"]); // Gamma is outside the grant
    expect(await call(ar, "knowledge_read", { path: "Areas/Other/Gamma.md" })).toMatchObject({ isError: true, body: { error: { code: "forbidden", message: "not granted" } } });
    expect(await call(ar, "knowledge_read", { path: "Areas/Itest/../Other/Gamma.md" })).toMatchObject({ isError: true, body: { error: { code: "invalid_request" } } });
    expect(await call(ar, "knowledge_read", { path: "Areas/Itest/Draft.md" })).toMatchObject({ isError: true, body: { error: { code: "not_found" } } }); // drafts: invisible
    expect(await call(ar, "knowledge_read", { path: "Areas/Itest/Missing.md" })).toMatchObject({ isError: true, body: { error: { code: "not_found" } } });
    // the index knows the note; the vault reader has nothing for it → not_found (reader-less deployments answer not_available, see the unit suite)
    expect(await call(ar, "knowledge_read", { path: "Areas/Itest/Alpha.md" })).toMatchObject({ isError: true, body: { error: { code: "not_found" } } });
    vault = { "Areas/Itest/Alpha.md": "---\ntitle: Alpha note\n---\n/not a command​ here" };
    const read = await call(ar, "knowledge_read", { path: "Areas/Itest/Alpha.md" });
    expect(read.isError).toBe(false);
    expect(read.body).toEqual({ path: "Areas/Itest/Alpha.md", title: "Alpha note", content: "---\ntitle: Alpha note\n---\n/not a command here", sha256: sha256Text(vault["Areas/Itest/Alpha.md"]!) });
    await ar.close();

    // every read AND every refusal is a runs row on the agent, carrying the grant it was judged under (§4.11 "every read logged")
    const { rows } = await pool.query(
      `SELECT tool, ok, error, meta FROM runs WHERE component = $1 AND kind = 'tool' AND tool LIKE 'knowledge_%' ORDER BY id`,
      [ALICE],
    );
    expect(rows.length).toBeGreaterThanOrEqual(12);
    expect(rows[0]).toMatchObject({ tool: "knowledge_search", ok: false, error: "forbidden", meta: { via: "mcp-brain", tier: "none" } });
    const okRead = rows.find((r) => r.tool === "knowledge_read" && r.ok === true);
    expect(okRead?.meta).toMatchObject({ tier: "areas", areas: [AREA], path: "Areas/Itest/Alpha.md" });
  });

  it("knowledge_search modes: semantic/hybrid rank, the grant still filters in SQL, a dead embedder degrades to keyword", async () => {
    // The reconciler owns these rows in production; here they are seeded
    // directly so the bridge's SQL — not the reconciler — is what is tested.
    // Gamma is deliberately the CLOSEST note and outside the area grant.
    const chunks: Array<[string, string]> = [
      ["Areas/Other/Gamma.md", "plumber basement tank replacement"],
      ["Areas/Itest/Alpha.md", "the tank down in the basement is old and the plumber quoted a replacement for it sometime next spring"],
      ["Areas/Itest/Sub/Beta.md", "an unrelated note about nothing much at all"],
      ["Areas/Itest/Draft.md", "plumber basement tank replacement, but unsettled"],
    ];
    const open: Array<{ close(): Promise<void> }> = [];
    try {
      for (const [path, text] of chunks) {
        await pool.query(
          `INSERT INTO embeddings (path, chunk_index, content, model, dim, embedding, content_hash)
           VALUES ($1, 0, $2, $3, $4, $5::vector, $6)
           ON CONFLICT (path, chunk_index, model) DO UPDATE SET embedding = EXCLUDED.embedding`,
          [path, text, EMBED_MODEL, EMBED_DIM, vectorOf(text), sha256Text(text)],
        );
      }

      grant("tok-mode-index", { id: ALICE, grants: { tier: "index", areas: [] }, projects: [] });
      const idx = await connect("tok-mode-index");
      open.push(idx);
      const q = "plumber basement tank replacement";

      // semantic: ranked by the vectors, drafts still absent, every hit scored
      const sem = await call(idx, "knowledge_search", { query: q, mode: "semantic" });
      expect(sem.isError).toBe(false);
      expect(sem.body.mode).toBe("semantic");
      expect(sem.body.hits.map((h: any) => h.path)).not.toContain("Areas/Itest/Draft.md");
      expect(sem.body.hits[0].path).toBe("Areas/Other/Gamma.md"); // the closest chunk
      expect(sem.body.hits[0].score).toBeGreaterThan(sem.body.hits[1].score);
      // an index grant sees titles and descriptions — never the chunk text that produced the match
      expect(Object.keys(sem.body.hits[0]).sort()).toEqual(["description", "path", "score", "title"]);

      // hybrid: fuses, and asking for nothing at all now picks hybrid
      const hyb = await call(idx, "knowledge_search", { query: q, mode: "hybrid" });
      expect(hyb.body.mode).toBe("hybrid");
      expect(hyb.body.hits.length).toBeGreaterThan(0);
      expect(hyb.body.hits.every((h: any) => h.score > 0 && h.score < 1)).toBe(true); // RRF, not a similarity
      expect((await call(idx, "knowledge_search", { query: q })).body.mode).toBe("hybrid");

      // the grant filters in SQL: Gamma is the best vector match and stays invisible
      grant("tok-mode-areas", { id: ALICE, grants: { tier: "areas", areas: [AREA] }, projects: [] });
      const ar = await connect("tok-mode-areas");
      open.push(ar);
      for (const mode of ["semantic", "hybrid"] as const) {
        const r = await call(ar, "knowledge_search", { query: q, mode });
        expect(r.body.hits.map((h: any) => h.path).sort(), mode).toEqual(["Areas/Itest/Alpha.md", "Areas/Itest/Sub/Beta.md"]);
      }

      // a dead embedder costs the ranking, never the answer
      embedderDown = true;
      const dead = await call(ar, "knowledge_search", { query: "alpha", mode: "semantic" });
      embedderDown = false;
      expect(dead.isError).toBe(false);
      expect(dead.body).toMatchObject({ mode: "keyword", degraded: expect.stringContaining("embedder unavailable") });
      expect(dead.body.hits.map((h: any) => h.path)).toEqual(["Areas/Itest/Alpha.md"]);

      // the mode that actually ran is on the audit row, next to the one asked for
      const { rows } = await pool.query(
        `SELECT meta FROM runs WHERE component = $1 AND tool = 'knowledge_search' AND meta ? 'mode' ORDER BY id DESC LIMIT 1`,
        [ALICE],
      );
      expect(rows[0]!.meta).toMatchObject({ mode: "keyword", requested: "semantic" });
    } finally {
      // later suites in this file assume a keyword-only index
      embedderDown = false;
      await pool.query(`DELETE FROM embeddings WHERE model = $1`, [EMBED_MODEL]);
      for (const c of open) await c.close();
    }
  });

  it("knowledge_write: internal only (external → not granted, nothing reaches the vault); bare vault grant (/) reads root notes and searches everything; provenance + CAS round trip; audited", async () => {
    const path = "Areas/Itest/Written.md";
    // an external agent with the widest imaginable grant still cannot write
    grant("tok-alice-wide", { id: ALICE, grants: { tier: "areas", areas: ["/"] }, projects: [] });
    const alice = await connect("tok-alice-wide");
    expect(await call(alice, "knowledge_write", { path, content: "# Alice was here\n", message: "alice" })).toMatchObject({ isError: true, body: { error: { code: "forbidden", message: "not granted" } } });
    await alice.close();
    expect(writes).toHaveLength(0);

    // the instance's own assistant under the bare vault grant (the console's internal default)
    grant("tok-hub-vault", { id: HUB, kind: "internal", grants: { tier: "areas", areas: ["/"] }, projects: [] });
    const hub = await connect("tok-hub-vault");
    // ...searches the whole index (the trailing-slash prefix is honoured in SQL), drafts still invisible
    expect((await call(hub, "knowledge_search", { query: "alpha" })).body.hits.map((h: any) => h.path)).toEqual(["Areas/Itest/Alpha.md", "Areas/Other/Gamma.md"]);

    // create-only write: stamped, queued, intent in the principal's name
    const writeTurn = `itest-turn-${mintToken(8)}`;
    const created = await call(hub, "knowledge_write", { path, content: "# Written\n\nby the assistant\n", message: "itest: first write", expected_sha256: "" }, { [TURN_ID_META_KEY]: writeTurn });
    expect(created.isError).toBe(false);
    expect(created.body).toMatchObject({ path, created: true, queued: true, provenance: { source: HUB } });
    expect(writes).toHaveLength(1);
    // the act, not the agent, keys the commit (§2.21): the reply's turn and this call's runs row
    expect(writes[0]).toMatchObject({ path, intent: { principal: HUB, message: "itest: first write", turn: writeTurn, run: expect.stringMatching(/^\d+$/) }, expected_sha256: "" });
    expect(writes[0]!.intent.group).toBeUndefined();
    const { rows: writeRun } = await pool.query(`SELECT meta->>'turn_id' AS turn_id FROM runs WHERE id = $1`, [Number(writes[0]!.intent.run)]);
    expect(writeRun[0]?.turn_id).toBe(writeTurn);
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
    expect(rows[1]!.meta).toMatchObject({ kind: "internal", tier: "areas", areas: ["/"], path, created: true, provenance: { source: HUB } });
    expect(rows[1]!.meta.args.content).toMatch(/^<\d+ chars>$/);
    expect(rows[3]!.meta.current_sha256).toBe(updated.body.sha256);
  });

  it("knowledge_list: none forbidden; index browses globally; areas scoped to granted prefixes, aggregated when the prefix is omitted; drafts excluded either way", async () => {
    // knowledge_list/knowledge_grep source their listing/content from the
    // SAME in-memory `vault` map as knowledge_read — populate the paths
    // this test (and the knowledge_grep test right after it) needs; earlier
    // tests only ever populated Alpha.md and Written.md.
    vault = {
      ...vault,
      "Areas/Itest/Alpha.md": "# Alpha\n\nThis note mentions banana twice: banana, banana are tasty.\n",
      // A pathologically backtracking line for knowledge_grep's `(a+)+$`
      // test: a long run of "a" with no matching tail forces the classic
      // exponential blowup — deterministic enough to reliably exceed the
      // worker's timeout guard.
      "Areas/Itest/Sub/Beta.md": `# Beta\n\nNo fruit here, just words.\n${"a".repeat(40)}!\n`,
      "Areas/Itest/Draft.md": "# Draft\n\nbanana appears in the draft too, but must never surface.\n",
      "Areas/Other/Gamma.md": "# Gamma\n\nbanana outside the itest grant entirely.\n",
    };

    const none = await connect("tok-alice");
    expect(await call(none, "knowledge_list", {})).toMatchObject({ isError: true, body: { error: { code: "forbidden", message: expect.stringMatching(/^not granted/) } } });
    await none.close();

    grant("tok-fs-index", { id: ALICE, grants: { tier: "index", areas: [] }, projects: [] });
    const idx = await connect("tok-fs-index");
    const globalList = await call(idx, "knowledge_list", { prefix: "Areas/Itest" });
    expect(globalList.isError).toBe(false);
    const idxPaths = globalList.body.entries.map((e: any) => e.path);
    expect(idxPaths).toContain("Areas/Itest/Alpha.md");
    expect(idxPaths).not.toContain("Areas/Itest/Draft.md"); // drafts excluded even at tier index
    const alphaEntry = globalList.body.entries.find((e: any) => e.path === "Areas/Itest/Alpha.md");
    expect(alphaEntry).toMatchObject({ kind: "file", title: "Alpha note" });
    await idx.close();

    grant("tok-fs-areas", { id: ALICE, grants: { tier: "areas", areas: [AREA] }, projects: [] });
    const ar = await connect("tok-fs-areas");
    // a prefix outside the grant is forbidden, exactly like knowledge_read
    expect(await call(ar, "knowledge_list", { prefix: "Areas/Other" })).toMatchObject({ isError: true, body: { error: { code: "forbidden", message: "not granted" } } });
    // an omitted prefix aggregates across every granted area (only one here)
    const scoped = await call(ar, "knowledge_list", { depth: 5 });
    expect(scoped.isError).toBe(false);
    const scopedPaths = scoped.body.entries.map((e: any) => e.path).sort();
    expect(scopedPaths).toContain("Areas/Itest/Alpha.md");
    expect(scopedPaths).toContain("Areas/Itest/Sub/Beta.md");
    expect(scopedPaths).toContain("Areas/Itest/Sub"); // the intermediate directory, breadth-limited by depth
    expect(scopedPaths).not.toContain("Areas/Itest/Draft.md");
    expect(scopedPaths.some((p: string) => p.startsWith("Areas/Other"))).toBe(false); // Gamma is outside the grant
    const beta = scoped.body.entries.find((e: any) => e.path === "Areas/Itest/Sub/Beta.md");
    expect(beta).toMatchObject({ kind: "file", title: "Beta" }); // no frontmatter title: falls back to the basename
    await ar.close();
  });

  it("knowledge_grep: forbidden at none AND index (content needs an areas grant, like knowledge_read); regex over settled content, scoped, drafts excluded, capped; an overly expensive pattern is refused rather than left to hang", async () => {
    // vault content (Alpha/Beta/Draft/Gamma) was set up by the knowledge_list test just above.

    const none = await connect("tok-alice");
    expect(await call(none, "knowledge_grep", { pattern: "banana" })).toMatchObject({ isError: true, body: { error: { code: "forbidden", message: expect.stringMatching(/^not granted/) } } });
    await none.close();

    grant("tok-fs-index", { id: ALICE, grants: { tier: "index", areas: [] }, projects: [] });
    const idx = await connect("tok-fs-index");
    expect(await call(idx, "knowledge_grep", { pattern: "banana" })).toMatchObject({ isError: true, body: { error: { code: "forbidden", message: expect.stringMatching(/^not granted/) } } });
    await idx.close();

    grant("tok-fs-areas", { id: ALICE, grants: { tier: "areas", areas: [AREA] }, projects: [] });
    const ar = await connect("tok-fs-areas");

    // a prefix outside the grant is forbidden before any content is touched
    expect(await call(ar, "knowledge_grep", { pattern: "banana", prefix: "Areas/Other" })).toMatchObject({ isError: true, body: { error: { code: "forbidden", message: "not granted" } } });

    // matches Alpha (2 lines... actually 1 line, "banana" appears 3x on one line) but never Draft (excluded) or Gamma (outside the grant)
    const hits = await call(ar, "knowledge_grep", { pattern: "banana" });
    expect(hits.isError).toBe(false);
    const paths = new Set(hits.body.hits.map((h: any) => h.path));
    expect(paths.has("Areas/Itest/Alpha.md")).toBe(true);
    expect(paths.has("Areas/Itest/Draft.md")).toBe(false);
    expect(paths.has("Areas/Other/Gamma.md")).toBe(false);
    expect(hits.body.hits[0]).toMatchObject({ path: "Areas/Itest/Alpha.md", line: expect.any(Number), text: expect.stringContaining("banana") });

    // a case with no matches anywhere in the grant
    expect((await call(ar, "knowledge_grep", { pattern: "xyz-nomatch-zyx" })).body.hits).toEqual([]);

    // a syntactically invalid regex is refused up front
    expect(await call(ar, "knowledge_grep", { pattern: "(unterminated" })).toMatchObject({ isError: true, body: { error: { code: "invalid_request" } } });

    // a catastrophically backtracking pattern is killed by the worker timeout, not left to hang the request
    const evil = await call(ar, "knowledge_grep", { pattern: "(a+)+$" });
    expect(evil).toMatchObject({ isError: true, body: { error: { code: "invalid_request", message: expect.stringContaining("too long") } } });

    await ar.close();

    const { rows } = await pool.query(`SELECT component, ok, error, meta FROM runs WHERE kind = 'tool' AND tool = 'knowledge_grep' AND component = $1 ORDER BY id DESC LIMIT 1`, [ALICE]);
    expect(rows[0]).toMatchObject({ ok: false, error: "invalid_request" }); // the last call recorded — even a refusal is audited
  }, 10_000);

  it("resources: metistry:// URIs mirror knowledge_read's tier rule — none/index see nothing, areas lists and reads under its grant", async () => {
    const none = await connect("tok-alice");
    expect((await none.listResources()).resources).toEqual([]);
    await expect(none.readResource({ uri: "metistry://Areas/Itest/Alpha.md" })).rejects.toThrow();
    await none.close();

    grant("tok-fs-index", { id: ALICE, grants: { tier: "index", areas: [] }, projects: [] });
    const idx = await connect("tok-fs-index");
    expect((await idx.listResources()).resources).toEqual([]); // index has titles, never resource content
    await idx.close();

    grant("tok-fs-areas", { id: ALICE, grants: { tier: "areas", areas: [AREA] }, projects: [] });
    const ar = await connect("tok-fs-areas");
    const { resources } = await ar.listResources();
    const uris = resources.map((r) => r.uri);
    expect(uris).toContain("metistry://Areas/Itest/Alpha.md");
    expect(uris).not.toContain("metistry://Areas/Itest/Draft.md"); // drafts excluded
    expect(uris.every((u) => u.startsWith("metistry://Areas/Itest/"))).toBe(true); // never Other/Gamma

    const read = await ar.readResource({ uri: "metistry://Areas/Itest/Alpha.md" });
    expect(read.contents[0]).toMatchObject({ uri: "metistry://Areas/Itest/Alpha.md", mimeType: "text/markdown", text: expect.stringContaining("banana") });
    await expect(ar.readResource({ uri: "metistry://Areas/Other/Gamma.md" })).rejects.toThrow(); // outside the grant
    await ar.close();
  });

  it("misuse matrix: every knowledge_* surface (search, read, list, grep, resources) derives its gating from the SAME knowledgeScope — tiers × draft/settled × inside/outside prefix", async () => {
    // Fixture reused from the knowledge_list/knowledge_grep/resources tests just above:
    // Alpha = settled, inside the grant; Draft = draft, inside the grant; Gamma = settled, outside the grant.
    const inside = "Areas/Itest/Alpha.md";
    const draft = "Areas/Itest/Draft.md";
    const outside = "Areas/Other/Gamma.md";

    grant("tok-matrix-none", { id: ALICE, grants: { tier: "none", areas: [] }, projects: [] });
    grant("tok-matrix-index", { id: ALICE, grants: { tier: "index", areas: [] }, projects: [] });
    grant("tok-matrix-areas", { id: ALICE, grants: { tier: "areas", areas: [AREA] }, projects: [] });

    // --- tier none: EVERY tool surface refuses with the identical "not granted" wording (never "not found") ---
    const none = await connect("tok-matrix-none");
    for (const [tool, args] of [
      ["knowledge_search", { query: "alpha" }],
      ["knowledge_read", { path: inside }],
      ["knowledge_list", {}],
      ["knowledge_grep", { pattern: "alpha" }],
    ] as const) {
      expect(await call(none, tool, args), `${tool} @ tier none`).toMatchObject({ isError: true, body: { error: { code: "forbidden", message: expect.stringMatching(/^not granted/) } } });
    }
    // resources have no tool envelope, but the same tier rule holds: nothing listed, nothing readable
    expect((await none.listResources()).resources).toEqual([]);
    await expect(none.readResource({ uri: `metistry://${inside}` })).rejects.toThrow();
    await none.close();

    // --- tier index: titles/paths ARE visible (search, list); content is NOT (read, grep, resources all refuse/empty) ---
    const idx = await connect("tok-matrix-index");
    expect((await call(idx, "knowledge_search", { query: "alpha" })).body.hits.map((h: any) => h.path)).toContain(inside);
    expect((await call(idx, "knowledge_list", { prefix: "Areas/Itest" })).body.entries.map((e: any) => e.path)).toContain(inside);
    // knowledge_read on a page it can already SEE (ruled 2026-09-19, PR #216
    // judgement call B): not the bare "not granted" — a structured refusal
    // naming the area that would unlock it, since existence is not a new leak.
    const scopedRead = await call(idx, "knowledge_read", { path: inside });
    expect(scopedRead).toMatchObject({
      isError: true,
      body: { error: { code: "forbidden", message: expect.stringContaining(AREA) }, reason: "scope_required", grantedScope: AREA },
    });
    // knowledge_grep is tier-gated before any single path is looked at — it
    // is a content surface at every tier below `areas`, no exception, unchanged.
    expect(await call(idx, "knowledge_grep", { pattern: "alpha" }), "knowledge_grep @ tier index").toMatchObject({
      isError: true,
      body: { error: { code: "forbidden", message: expect.stringMatching(/^not granted/) } },
    });
    expect((await idx.listResources()).resources).toEqual([]); // resources carry the same "titles, never content" line
    await idx.close();

    // --- tier areas: drafts are invisible (not_found, not forbidden) and outside-the-grant is forbidden — identically, on every surface ---
    const ar = await connect("tok-matrix-areas");

    // draft: exists, inside the grant, but unsettled — every content surface treats it as absent
    expect(await call(ar, "knowledge_read", { path: draft })).toMatchObject({ isError: true, body: { error: { code: "not_found" } } });
    expect((await call(ar, "knowledge_list", { prefix: AREA, depth: 5 })).body.entries.map((e: any) => e.path)).not.toContain(draft);
    expect((await call(ar, "knowledge_grep", { pattern: "banana" })).body.hits.map((h: any) => h.path)).not.toContain(draft);
    expect((await call(ar, "knowledge_search", { query: "alpha" })).body.hits.map((h: any) => h.path)).not.toContain(draft);
    expect((await ar.listResources()).resources.map((r) => r.uri)).not.toContain(`metistry://${draft}`);
    await expect(ar.readResource({ uri: `metistry://${draft}` })).rejects.toThrow();

    // outside the grant: settled, but not under any granted prefix — forbidden ("not granted") wherever a path/prefix is a caller argument
    for (const [tool, args] of [
      ["knowledge_read", { path: outside }],
      ["knowledge_list", { prefix: "Areas/Other" }],
      ["knowledge_grep", { pattern: "banana", prefix: "Areas/Other" }],
    ] as const) {
      expect(await call(ar, tool, args), `${tool} outside the grant`).toMatchObject({ isError: true, body: { error: { code: "forbidden", message: "not granted" } } });
    }
    // knowledge_search never takes a prefix argument — the grant filters it out in SQL instead of refusing the call
    expect((await call(ar, "knowledge_search", { query: "alpha" })).body.hits.map((h: any) => h.path)).not.toContain(outside);
    expect((await ar.listResources()).resources.map((r) => r.uri)).not.toContain(`metistry://${outside}`);
    await expect(ar.readResource({ uri: `metistry://${outside}` })).rejects.toThrow();

    await ar.close();
  });

  it("queries_list/queries_run: internal always ok, external needs a `queries` grant, unknown is not_found, rows cap at 200", async () => {
    const hub = await connect("tok-hub");
    const list = await call(hub, "queries_list");
    expect(list.isError).toBe(false);
    expect(list.body.queries).toContainEqual({ name: "itest_numbers", description: "fixture query for queries_list/queries_run tests", params: { n: { type: "int", default: 3 } } });

    const ran = await call(hub, "queries_run", { name: "itest_numbers", params: { n: 3 } });
    expect(ran.isError).toBe(false);
    expect(ran.body).toMatchObject({ name: "itest_numbers", params: { n: 3 }, rows: [{ n: 1 }, { n: 2 }, { n: 3 }], row_count: 3 });
    expect(ran.body.as_of).toEqual(expect.any(String));
    expect(ran.body.truncated).toBeUndefined();

    const unknown = await call(hub, "queries_run", { name: "not-a-real-query" });
    expect(unknown).toMatchObject({ isError: true, body: { error: { code: "not_found" } } });

    // turn_id: in NO tool's schema any more (turn-id.ts — 938 definition
    // tokens for a field that is not a parameter), carried by the call's
    // `_meta` instead. It still lands in runs.meta.turn_id, which is the join
    // key activity_feed exposes, so the correlation is what is asserted here
    // rather than the carrier.
    // Unique per run, not a fixed literal: the scratch database is shared with every
    // other suite (console's console-routes.integration.test.ts writes its own
    // turn_id fixtures against the same `runs` table), so a hand-picked literal here
    // can collide with somebody else's and make this test count their row instead.
    const lastTurnId = async (tool: string): Promise<string | null> => {
      const { rows } = await pool.query(`SELECT meta->>'turn_id' AS turn_id FROM runs WHERE component = $1 AND tool = $2 ORDER BY id DESC LIMIT 1`, [HUB, tool]);
      return rows[0]!.turn_id;
    };

    const turnId = `itest-turn-${mintToken(8)}`;
    await call(hub, "queries_list", {}, { [TURN_ID_META_KEY]: turnId });
    expect(await lastTurnId("queries_list")).toBe(turnId);

    // One release of compatibility, tolerated and NOT advertised: a client
    // still passing it as an argument correlates exactly as before — the
    // message is rewritten at the door, so the argument never reaches a schema
    // that would strip it, and the call is not refused for carrying it.
    const legacyId = `itest-turn-${mintToken(8)}`;
    const legacy = await call(hub, "queries_list", { turn_id: legacyId });
    expect(legacy.isError).toBe(false);
    expect(await lastTurnId("queries_list")).toBe(legacyId);

    // A malformed handle is dropped, never a refusal: the work asked for has
    // nothing to do with whether the caller's bookkeeping label parsed.
    const junk = await call(hub, "queries_list", { turn_id: "not a valid handle" }, { [TURN_ID_META_KEY]: 42 });
    expect(junk.isError).toBe(false);
    expect(await lastTurnId("queries_list")).toBeNull();
    await hub.close();

    // external, no grant: forbidden — uniform whether or not a store is even wired (queries-tools.ts checks the grant first)
    const alice1 = await connect("tok-alice");
    expect((await call(alice1, "queries_list")).body).toEqual({ error: { code: "forbidden", message: expect.stringMatching(/^not granted/) } });
    // …in the SAME words: one sentence per reason, not one per tool (P3).
    expect((await call(alice1, "queries_run", { name: "itest_numbers" })).body).toEqual((await call(alice1, "queries_list")).body);
    await alice1.close();

    // grant queries: true — the SAME token, principal upgraded server-side, never asserted by the caller
    grant("tok-alice", { id: ALICE, grants: { tier: "none", areas: [], queries: true }, projects: [PA] });
    const alice2 = await connect("tok-alice");
    const capped = await call(alice2, "queries_run", { name: "itest_numbers", params: { n: 250 } });
    expect(capped.isError).toBe(false);
    expect(capped.body).toMatchObject({ row_count: 200, truncated: true });
    expect(capped.body.rows).toHaveLength(200);
    await alice2.close();
    grant("tok-alice", { id: ALICE, grants: { tier: "none", areas: [] }, projects: [PA] }); // restore alice's plain grant for the rest of the suite
  });

  it("every tool call is a two-phase runs row on the agent (kind=tool), with args summarized and bodies clipped", async () => {
    // the artifacts module is not wired in this suite (its own suite covers it): each artifact_* call is a recorded not_available
    const ar = await connect("tok-alice");
    const artId = "art_01J00000000000000000000000";
    const verId = "ver_01J00000000000000000000000";
    const cmtId = "cmt_01J00000000000000000000000";
    for (const [name, args] of [
      ["artifacts_publish", { project: PA, slug: "x", files: [{ path: "a.md", content: "a" }], idempotency_key: "k", message: "m" }],
      ["artifacts_get", { id: artId }],
      ["artifacts_list", {}],
      ["artifacts_comment", { artifact: artId, version: verId, body: "b" }],
      ["artifacts_resolve", { id: cmtId }],
      ["artifacts_review", { artifact: artId, version: verId, thread_ids: [cmtId], to_agent: BOB }],
      // the room tools ride the same service, so an unwired deployment refuses them the same way
      ["tasks_comment", { work_id: 1, body: "b" }],
      ["tasks_thread", { work_id: 1 }],
    ] as const) {
      expect((await call(ar, name, args)).body.error.code, name).toBe("not_available");
    }
    // agents_delegate is the assistant's alone: an external agent is told not granted before any dispatcher is consulted (none is wired here) — still a recorded refusal
    expect((await call(ar, "agents_delegate", { crew: "researcher", brief: "b" })).body).toEqual({ error: { code: "forbidden", message: expect.stringMatching(/^not granted — `agents_delegate` belongs to the instance assistant alone/) } });
    // request_access is alice's to call at any tier (she is tier `none` here):
    // it writes a request and grants nothing, and it is recorded like the rest
    expect((await call(ar, "request_access", { area: "Areas/Recorded", reason: "recording one of every eager tool" })).body).toMatchObject({ area: "Areas/Recorded" });
    await ar.close();
    const { rows } = await pool.query(
      `SELECT tool, ok, finished_at IS NOT NULL AS finished, meta FROM runs WHERE component = $1 AND kind = 'tool' ORDER BY id`,
      [ALICE],
    );
    const tools = new Set(rows.map((r) => r.tool));
    for (const t of EAGER_TOOL_NAMES) expect(tools.has(t), t).toBe(true);
    expect(rows.every((r) => r.finished && r.ok !== null)).toBe(true);
    const rep = rows.find((r) => r.tool === "requests_create" && r.ok);
    expect(rep.meta.args.body).toBe("<7 chars>");
    expect(rep.meta).toMatchObject({ proposal_id: expect.any(Number), deduplicated: false });
    const cap = rows.find((r) => r.tool === "capture" && r.meta.args.content_base64);
    expect(cap.meta.args.content_base64).toMatch(/^<\d+ chars>$/);
  });
});
