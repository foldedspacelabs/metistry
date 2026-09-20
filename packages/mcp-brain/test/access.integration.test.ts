// `request_access` at the tool (ruled 2026-09-19), against the real scratch
// database. Misuse first (invariant 8): the interesting questions are the
// ones an agent would ask if it were trying to get an area the owner never
// granted, or to make the queue useless by asking a thousand times.
//
// What this proves the tool CANNOT do, which is most of what it is for:
// grant anything, write a row for a crafted prefix, write two rows for one
// pending ask, or be called at all by the principal whose scope is
// configuration rather than a grant.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { TasksService } from "@foldedspacelabs/metistry-tasks";
import { ACCESS_REQUEST_KIND, createBrainServer, EAGER_TOOL_NAMES, type AgentPrincipal } from "../src/index.js";
import { loadTestEnv } from "@foldedspacelabs/metistry-core/test-env";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url));

const AGENT = "itest-access-agent";
const OTHER = "itest-access-other";
const ASSISTANT = "itest-access-hub";
const AREA = "Areas/Access";

interface Parsed {
  isError: boolean;
  body: any;
}

describe.skipIf(!hasDb)("request_access on /mcp (real db, real MCP client)", () => {
  let pool: pg.Pool;
  let server: Server;
  let base: string;
  const principals = new Map<string, AgentPrincipal>();

  /**
   * One call, one client. A refusal that the DECLARED SCHEMA catches (an
   * empty string against `min(1)`) comes back as a JSON-RPC error rather than
   * a tool result — the SDK's own validation, one layer above the body — so
   * it is normalised to the same shape here. Both are refusals at the tool;
   * what matters to these tests is that neither one wrote a row.
   */
  async function once(token: string, tool: string, args: Record<string, unknown> = {}): Promise<Parsed> {
    const client = new Client({ name: "itest", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    try {
      const r = (await client.callTool({ name: tool, arguments: args })) as { isError?: boolean; content: { type: string; text: string }[] };
      const text = r.content[0]!.text;
      const nl = text.indexOf("\n");
      return { isError: !!r.isError, body: JSON.parse(nl === -1 ? text : text.slice(0, nl)) };
    } catch (err) {
      return { isError: true, body: { error: { code: "invalid_request", message: String(err) }, schema: true } };
    } finally {
      await client.close();
    }
  }

  const rowsFor = async (agent: string) =>
    (await pool.query(`SELECT id, kind, trust, decision, payload FROM proposals WHERE kind = $2 AND source_agent = $1 ORDER BY id`, [agent, ACCESS_REQUEST_KIND])).rows;

  beforeAll(async () => {
    pool = new pg.Pool({
      host: process.env.METISTRY_DB_HOST ?? "127.0.0.1",
      port: Number(process.env.METISTRY_DB_PORT ?? 5432),
      user: process.env.METISTRY_DB_USER ?? "metistry",
      database: process.env.METISTRY_TEST_DB_NAME ?? "metistry_test",
      password: process.env.METISTRY_DB_PASSWORD,
    });
    await pool.query(`DELETE FROM proposals WHERE source_agent = ANY($1::text[])`, [[AGENT, OTHER, ASSISTANT]]);

    const authenticate = async (req: { headers: Record<string, unknown> }) => {
      const m = /^Bearer\s+(\S+)$/.exec(String(req.headers.authorization ?? ""));
      return (m?.[1] && principals.get(m[1])) || null;
    };
    const brain = createBrainServer({ db: pool, authenticate, tasks: new TasksService(pool), inboxDir: "/tmp/metistry-itest-access" });
    server = createServer((req, res) => {
      if (req.url === "/mcp") void brain.handle(req, res).catch(() => res.destroy());
      else res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    principals.set("tok-none", { id: AGENT, grants: { tier: "none", areas: [] }, projects: [] });
    principals.set("tok-index", { id: AGENT, grants: { tier: "index", areas: [] }, projects: [] });
    principals.set("tok-other", { id: OTHER, grants: { tier: "index", areas: [] }, projects: [] });
    principals.set("tok-internal", { id: ASSISTANT, kind: "internal", grants: { tier: "areas", areas: ["/"] }, projects: [] });
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await pool.query(`DELETE FROM proposals WHERE source_agent = ANY($1::text[])`, [[AGENT, OTHER, ASSISTANT]]);
    await pool.end();
  });

  it("is offered to every tier, tier `none` included — an agent that can be refused is an agent that may ask", async () => {
    expect(EAGER_TOOL_NAMES).toContain("request_access");
    const r = await once("tok-none", "request_access", { area: "Areas/Capture", reason: "the capture I filed points at a page I cannot read" });
    expect(r.isError).toBe(false);
    expect(r.body).toMatchObject({ area: "Areas/Capture" });
    const row = (await rowsFor(AGENT)).find((x) => x.payload.area === "Areas/Capture");
    // the credential's own tier lands on the row: the owner is answering with what it holds TODAY in front of them
    expect(row).toMatchObject({ kind: ACCESS_REQUEST_KIND, trust: "external", decision: "pending" });
    expect(row.payload).toMatchObject({ area: "Areas/Capture", current_tier: "none", current_areas: [] });
    expect(row.payload.provenance).toMatchObject({ agent: AGENT, via: "mcp-brain" });
  });

  it("writes ONE row and grants NOTHING: the tool has no path to `agents`, and the row stays pending", async () => {
    const before = await pool.query(`SELECT count(*)::int AS n FROM agents`);
    const r = await once("tok-index", "request_access", { area: AREA, reason: "knowledge_read told me the page exists and this is the area" });
    expect(r.isError).toBe(false);
    expect(r.body.replayed).toBeUndefined();
    const rows = (await rowsFor(AGENT)).filter((x) => x.payload.area === AREA);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.decision).toBe("pending");
    expect(rows[0]!.payload).toMatchObject({ current_tier: "index", title: expect.stringContaining(AREA) });
    // nothing anywhere near a grant moved
    expect((await pool.query(`SELECT count(*)::int AS n FROM agents`)).rows[0]!.n).toBe(before.rows[0]!.n);
    expect((await pool.query(`SELECT count(*)::int AS n FROM runs WHERE kind = 'agent_admin' AND meta->>'agent' = $1`, [AGENT])).rows[0]!.n).toBe(0);
  });

  it("asking again for the same area returns the pending row — the queue cannot be flooded", async () => {
    const again = await once("tok-index", "request_access", { area: AREA, reason: "asking a second time, differently worded" });
    expect(again.body).toMatchObject({ area: AREA, replayed: true });
    const rows = (await rowsFor(AGENT)).filter((x) => x.payload.area === AREA);
    expect(rows).toHaveLength(1);
    expect(again.body.id).toBe(Number(rows[0]!.id));
    // …and the FIRST reason is the one the owner reads: a replay does not rewrite the row under them
    expect(rows[0]!.payload.reason).toContain("knowledge_read told me");

    // Concurrency: the partial unique index (migration 0022), not the read
    // above it, is what makes that true. Five at once still make one row.
    const burst = await Promise.all([1, 2, 3, 4, 5].map(() => once("tok-index", "request_access", { area: AREA, reason: "racing" })));
    expect(new Set(burst.map((b) => b.body.id))).toEqual(new Set([Number(rows[0]!.id)]));
    expect((await rowsFor(AGENT)).filter((x) => x.payload.area === AREA)).toHaveLength(1);
  });

  it("dedupe is per (agent, area) and only while PENDING: another agent, another area, and an answered ask each get their own row", async () => {
    const other = await once("tok-other", "request_access", { area: AREA, reason: "a different agent wants the same area" });
    expect(other.body.replayed).toBeUndefined();
    expect(await rowsFor(OTHER)).toHaveLength(1);

    const second = await once("tok-index", "request_access", { area: "Areas/Access/Deeper", reason: "a narrower one" });
    expect(second.body.replayed).toBeUndefined();

    // Once the owner has answered, asking again is a NEW question — the world
    // moved, or the reason did — and it gets a row of its own.
    await pool.query(`UPDATE proposals SET decision = 'deny', decided_at = now() WHERE kind = $2 AND source_agent = $1 AND payload->>'area' = $3`, [AGENT, ACCESS_REQUEST_KIND, AREA]);
    const afterDeny = await once("tok-index", "request_access", { area: AREA, reason: "asking again now that things changed" });
    expect(afterDeny.body.replayed).toBeUndefined();
    expect((await rowsFor(AGENT)).filter((x) => x.payload.area === AREA)).toHaveLength(2);
  });

  it("a crafted area is refused at the tool — the same rule the grants validator uses, so nothing can be asked for that could not be granted", async () => {
    const before = (await rowsFor(AGENT)).length;
    for (const area of [
      "..",
      "../Areas",
      "Areas/../../etc/passwd",
      ".metistry/",
      ".metistry/state",
      "Artifacts/",
      "Artifacts/Reports",
      "areas/health", // lowercase: the casing rule IS the vault boundary
      "Areas/health",
      "/",
      "/etc/passwd",
      "Areas/Access/", // trailing slash: a prefix, not a directory name
      "",
      "   ",
      "Areas/Access ",
      "A".repeat(201),
    ]) {
      const r = await once("tok-index", "request_access", { area, reason: "trying it on" });
      expect(r.isError, area).toBe(true);
      expect(r.body.error.code, area).toBe("invalid_request");
    }
    expect((await rowsFor(AGENT)).length).toBe(before); // not one of them left a row for the owner to mis-answer
  });

  it("a reason is required: the owner is being asked to widen a grant, and an ask with no why is one they cannot answer", async () => {
    const before = (await rowsFor(AGENT)).length;
    for (const reason of ["", "   "]) {
      const r = await once("tok-index", "request_access", { area: "Areas/Reasonless", reason });
      expect(r.isError).toBe(true);
      expect(r.body.error.code).toBe("invalid_request");
    }
    expect((await rowsFor(AGENT)).length).toBe(before);
  });

  it("an INTERNAL principal is refused and told where its scope actually lives — an approved ask would silently revert at the next restart", async () => {
    const r = await once("tok-internal", "request_access", { area: "Areas/Anything", reason: "the assistant asking" });
    expect(r).toMatchObject({ isError: true, body: { error: { code: "forbidden", message: expect.stringContaining("METISTRY_ASSISTANT_AREAS") } } });
    expect(await rowsFor(ASSISTANT)).toHaveLength(0);
  });

  it("every call is one `runs` row, refusals included — a safety mechanism that leaves no trace is not one", async () => {
    const { rows } = await pool.query(
      `SELECT ok, meta->'args'->>'area' AS area FROM runs WHERE component = $1 AND kind = 'tool' AND tool = 'request_access' ORDER BY id`,
      [AGENT],
    );
    expect(rows.length).toBeGreaterThan(5);
    expect(rows.some((r) => r.ok === true)).toBe(true);
    expect(rows.some((r) => r.ok === false)).toBe(true);
    expect(rows.some((r) => r.area === "..")).toBe(true); // the crafted ask is on the record as a crafted ask
  });
});
