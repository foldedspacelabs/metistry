// The access-request loop, end to end, through the real console server and
// the real agent registry (ruled 2026-09-19): an agent at tier `index` is
// refused a page it can SEE, asks for the area that holds it, the owner
// answers in Needs You, and the read then works.
//
// The point of the suite is the half that must NOT happen. An agent cannot
// answer its own request; a crafted area is refused at both doors; Approve
// widens exactly the prefix that was asked for and nothing beside it; Revise
// grants the owner's prefix instead; Decline, Later and Skip grant nothing at
// all; and a revoked credential cannot be granted anything by any route.
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { mintToken } from "@foldedspacelabs/metistry-core";
import { ACCESS_REQUEST_KIND } from "@foldedspacelabs/metistry-mcp-brain";
import { makeServer } from "../src/server.js";
import * as store from "../src/auth-store.js";
import * as agents from "../src/agents.js";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url));
const policy = { idleDays: 30, maxDays: 365 };

const AREA = "Areas/AccessIt";
const PAGE = `${AREA}/Page.md`;
const NARROWED = "Projects/Narrowed";

describe.skipIf(!hasDb)("access requests, agent to owner and back (integration)", () => {
  let pool: pg.Pool;
  let base: string;
  let server: ReturnType<typeof makeServer>;
  let cookie: string;
  const suffix = mintToken(4).toLowerCase().replaceAll(/[^a-z0-9]/g, "").slice(0, 6) || "x";
  const agentId = `itest-acc-${suffix}`;
  const goneId = `itest-gone-${suffix}`;
  let agentToken: string;
  let goneToken: string;
  let nextId = 1;

  /** The owner's session — the only credential the management surface and triage answer to. */
  const owner = (method: string, path: string, body?: unknown) =>
    fetch(base + path, {
      method,
      headers: { cookie, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  /** One JSON-RPC call on /mcp as an agent, parsed to { isError, body } like the bridge's own suites. */
  async function tool(token: string, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; body: any }> {
    const r = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } }),
    });
    const result = (await r.json()).result as { isError?: boolean; content: { type: string; text: string }[] };
    const text = result.content[0]!.text;
    const nl = text.indexOf("\n");
    return { isError: !!result.isError, body: JSON.parse(nl === -1 ? text : text.slice(0, nl)) };
  }

  const grantsOf = async (id: string) => (await pool.query(`SELECT grants FROM agents WHERE id = $1`, [id])).rows[0]!.grants;
  const proposal = async (id: number) => (await pool.query(`SELECT decision, feedback, payload FROM proposals WHERE id = $1`, [id])).rows[0]!;
  const pendingAsk = async (id: string, area: string) =>
    (await pool.query(`SELECT id FROM proposals WHERE kind = $1 AND source_agent = $2 AND payload->>'area' = $3 AND decision = 'pending'`, [ACCESS_REQUEST_KIND, id, area])).rows[0];

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
    server = makeServer(pool, new QueryStore(pool), {
      origin: "http://127.0.0.1:0",
      inboxDir: `/tmp/metistry-test-inbox-access-${Date.now()}`,
      policy,
      secureCookies: false,
      // stands in for the reconciler's vault bridge: one page, inside the area that is asked for
      readKnowledge: async (path) => (path === PAGE ? "# Page\n\nthe content behind the grant\n" : null),
    });
    await pool.query(
      `INSERT INTO knowledge_files (path, title, description, draft) VALUES ($1, 'Page', 'a page behind a grant', false)
       ON CONFLICT (path) DO UPDATE SET draft = false`,
      [PAGE],
    );
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const pkId = `access-${mintToken(8)}`;
    await store.storePasskey(pool, { id: pkId, publicKey: new Uint8Array([1]), signCount: 0, transports: [], origin: "t", label: "access-test" });
    cookie = `metistry_session=${await store.issueSession(pool, pkId, policy)}`;
    ({ token: agentToken } = await agents.createAgent(pool, { id: agentId, display_name: "access itest" }));
    ({ token: goneToken } = await agents.createAgent(pool, { id: goneId, display_name: "about to be revoked" }));
    // tier index + a `queries` grant: the second axis, which nothing here may widen
    expect((await owner("PUT", `/api/agents/${agentId}/grants`, { tier: "index", queries: true })).status).toBe(200);
    expect((await owner("PUT", `/api/agents/${goneId}/grants`, { tier: "index" })).status).toBe(200);
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await pool.query(`DELETE FROM proposals WHERE source_agent = ANY($1::text[])`, [[agentId, goneId]]);
    await pool.query(`DELETE FROM knowledge_files WHERE path = $1`, [PAGE]);
    await pool.end();
  });

  it("refused → asks → the owner approves → the read works (the whole loop)", async () => {
    // 1. tier `index` can see the title and not the page, and the refusal
    //    names the area AND the tool that asks for it.
    const refused = await tool(agentToken, "knowledge_read", { path: PAGE });
    expect(refused).toMatchObject({ isError: true, body: { reason: "scope_required", grantedScope: AREA } });
    expect(refused.body.error.message).toContain("request_access");

    // 2. the ask. One row, pending, granting nothing.
    const asked = await tool(agentToken, "request_access", { area: AREA, reason: "knowledge_read pointed me here" });
    expect(asked.isError).toBe(false);
    const id = Number(asked.body.id);
    expect(await grantsOf(agentId)).toEqual({ tier: "index", areas: [], queries: true });

    // 3. it reaches BOTH owner surfaces: the queue, and the panel where the
    //    grant is edited (GET /api/agents' `access_requests`).
    const queue = await (await owner("GET", "/api/proposals")).json();
    // `proposals.id` is a bigint, and pg renders one as a string on the wire
    expect(queue.proposals.find((p: any) => Number(p.id) === id)).toMatchObject({ kind: ACCESS_REQUEST_KIND, source_agent: agentId });
    const registry = await (await owner("GET", "/api/agents")).json();
    expect(registry.access_requests).toContainEqual(expect.objectContaining({ proposal_id: id, agent: agentId, area: AREA }));

    // 3b. **One vocabulary** (P3 §2.10). The panel row and the queue card
    //     say the same thing about the same credential, because both are the
    //     SAME rendering — core's `describeScope`, computed server-side and
    //     sent down, rather than two clients recombining tier + areas +
    //     queries into words of their own.
    const row = registry.agents.find((a: any) => a.id === agentId);
    expect(row.scope).toMatchObject({ role: "agent", who: "an agent", tier: "index", access: "titles", queries: true });
    expect(row.scope.line).toBe("an agent · titles · queries, autonomy: observe");
    expect(row.scope.from).toContain("the registry");
    const card = (await proposal(id)).payload;
    expect(card.current_scope).toEqual(row.scope);
    // …and the machine-readable half is still there, unchanged, for a client
    // that wants the fields rather than the sentence.
    expect({ tier: card.current_tier, areas: card.current_areas }).toEqual({ tier: "index", areas: [] });

    // 4. Approve — through the same grants door the owner's own PUT goes
    //    through, with the same `agent_admin` audit row, `via: triage`.
    const allow = await owner("POST", `/api/proposals/${id}`, { decision: "allow" });
    expect(allow.status).toBe(200);
    expect((await allow.json()).granted).toMatchObject({ agent: agentId, area: AREA, grants: { tier: "areas", areas: [AREA], queries: true } });
    expect(await grantsOf(agentId)).toEqual({ tier: "areas", areas: [AREA], queries: true });
    const audit = await pool.query(
      `SELECT ok, meta FROM runs WHERE kind = 'agent_admin' AND tool = 'grant' AND meta->>'agent' = $1 AND meta->>'via' = 'triage' ORDER BY id DESC LIMIT 1`,
      [agentId],
    );
    expect(audit.rows[0]).toMatchObject({ ok: true, meta: expect.objectContaining({ op: "grant", area: AREA, proposal: String(id) }) });
    expect(await proposal(id)).toMatchObject({ decision: "allow", payload: expect.objectContaining({ granted: expect.objectContaining({ area: AREA, by: "user" }) }) });

    // 5. …and the read the agent was refused now answers.
    const read = await tool(agentToken, "knowledge_read", { path: PAGE });
    expect(read.isError).toBe(false);
    expect(read.body.content).toContain("the content behind the grant");
  });

  it("an agent cannot answer its own request: triage is the owner's session, and the ask stays pending", async () => {
    const asked = await tool(agentToken, "request_access", { area: "Areas/Somewhere", reason: "a second ask, to try to answer myself" });
    const id = Number(asked.body.id);
    const before = await grantsOf(agentId);

    for (const [method, path, body] of [
      ["POST", `/api/proposals/${id}`, { decision: "allow" }],
      ["POST", "/api/proposals/batch", { ids: [id], decision: "deny" }],
      ["PUT", `/api/agents/${agentId}/grants`, { tier: "areas", areas: ["Areas/Somewhere"] }],
      ["GET", "/api/agents", undefined],
    ] as const) {
      const r = await fetch(base + path, {
        method,
        headers: { authorization: `Bearer ${agentToken}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      expect(r.status, `${method} ${path}`).toBe(403);
      expect(await r.json(), `${method} ${path}`).toEqual({ error: { code: "forbidden", message: "not granted" } });
    }
    expect(await proposal(id)).toMatchObject({ decision: "pending" });
    expect(await grantsOf(agentId)).toEqual(before);

    // and no tool on the surface answers a proposal either: the ask is a row,
    // and the only door onto deciding it is the owner's session.
    const list = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${agentToken}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "tools/list", params: {} }),
    });
    const names: string[] = (await list.json()).result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("request_access");
    expect(names.filter((n) => /approve|grant|decide|triage|proposal/.test(n))).toEqual([]);

    await owner("POST", `/api/proposals/${id}`, { decision: "skip" }); // put it down; Skip grants nothing either
    expect(await grantsOf(agentId)).toEqual(before);
  });

  it("Revise grants the owner's prefix instead of the one asked for; without one it is a 400 and the row stays pending", async () => {
    const asked = await tool(agentToken, "request_access", { area: "Areas", reason: "give me the whole Areas tree" });
    const id = Number(asked.body.id);

    const noArea = await owner("POST", `/api/proposals/${id}`, { decision: "accept_with_changes", feedback: "narrower please" });
    expect(noArea.status).toBe(400);
    expect((await noArea.json()).error.message).toContain("area");
    expect(await proposal(id)).toMatchObject({ decision: "pending" }); // a refusal leaves the question live

    const crafted = await owner("POST", `/api/proposals/${id}`, { decision: "accept_with_changes", area: "../../etc" });
    expect(crafted.status).toBe(400);
    expect(await proposal(id)).toMatchObject({ decision: "pending" });

    const revised = await owner("POST", `/api/proposals/${id}`, { decision: "accept_with_changes", area: NARROWED });
    expect(revised.status).toBe(200);
    expect((await revised.json()).granted).toMatchObject({ area: NARROWED });
    // exactly the owner's prefix, beside what was already held — never `Areas`
    expect(await grantsOf(agentId)).toEqual({ tier: "areas", areas: [AREA, NARROWED], queries: true });
    expect(await proposal(id)).toMatchObject({ decision: "accept_with_changes" });
    const audit = await pool.query(`SELECT meta FROM runs WHERE kind = 'agent_admin' AND tool = 'grant' AND meta->>'proposal' = $1::text ORDER BY id DESC LIMIT 1`, [String(id)]);
    expect(audit.rows[0]!.meta).toMatchObject({ area: NARROWED, asked: "Areas" }); // what was asked for is on the record beside what was given
  });

  it("Decline and Later grant nothing", async () => {
    const before = await grantsOf(agentId);
    const asked = await tool(agentToken, "request_access", { area: "Areas/Private", reason: "asking for something I should not have" });
    const id = Number(asked.body.id);

    const later = await owner("POST", `/api/proposals/${id}`, { decision: "later" });
    expect(later.status).toBe(200);
    expect(await proposal(id)).toMatchObject({ decision: "pending" }); // a snooze settles nothing
    expect(await grantsOf(agentId)).toEqual(before);

    const deny = await owner("POST", `/api/proposals/${id}`, { decision: "deny", feedback: "that area is not for agents" });
    expect(deny.status).toBe(200);
    expect(await proposal(id)).toMatchObject({ decision: "deny", feedback: "that area is not for agents" });
    expect(await grantsOf(agentId)).toEqual(before); // the refusal is the whole effect
  });

  it("Approve widens by the requested prefix and nothing else: no `queries`, no tier beyond areas, no second area", async () => {
    const before = await grantsOf(agentId);
    expect(before.queries).toBe(true); // the separate axis, held before and after

    // an area already covered by a grant it holds is not added twice
    const covered = await tool(agentToken, "request_access", { area: `${AREA}/Inside`, reason: "already covered by the area grant" });
    const coveredId = Number(covered.body.id);
    expect((await owner("POST", `/api/proposals/${coveredId}`, { decision: "allow" })).status).toBe(200);
    expect(await grantsOf(agentId)).toEqual(before);

    // a genuinely new one appends exactly itself
    const fresh = await tool(agentToken, "request_access", { area: "Projects/Thing", reason: "a new area" });
    expect((await owner("POST", `/api/proposals/${Number(fresh.body.id)}`, { decision: "allow" })).status).toBe(200);
    expect(await grantsOf(agentId)).toEqual({ tier: "areas", areas: [...before.areas, "Projects/Thing"], queries: true });
  });

  it("a revoked agent cannot be granted anything: revocation settles its pending asks, and a planted one is refused", async () => {
    const asked = await tool(goneToken, "request_access", { area: "Areas/Anything", reason: "asking just before revocation" });
    const askId = Number(asked.body.id);
    expect(await pendingAsk(goneId, "Areas/Anything")).toBeDefined();

    const revoked = await owner("POST", `/api/agents/${goneId}/revoke`);
    expect(revoked.status).toBe(200);
    expect((await revoked.json()).access_requests).toContain(askId);
    expect(await proposal(askId)).toMatchObject({ decision: "deny", feedback: agents.REVOKED_FEEDBACK });

    // a row that predates that rule (or raced it) still cannot be approved:
    // the widening is refused and the question is left for the owner to close.
    const planted = await pool.query(
      `INSERT INTO proposals (kind, source_agent, trust, payload) VALUES ($1, $2, 'external', $3::jsonb) RETURNING id`,
      [ACCESS_REQUEST_KIND, goneId, JSON.stringify({ title: "planted", area: "Areas/Anything", reason: "planted" })],
    );
    const plantedId = Number(planted.rows[0]!.id);
    const r = await owner("POST", `/api/proposals/${plantedId}`, { decision: "allow" });
    expect(r.status).toBe(404);
    expect((await r.json()).error.message).toContain("revoked");
    expect(await proposal(plantedId)).toMatchObject({ decision: "pending" });
    expect(await grantsOf(goneId)).toEqual({ tier: "index", areas: [] });
  });

  it("a CREW cannot be widened from the queue — its scope is its manifest, and the approval would vanish at the next sync", async () => {
    // A crew is never offered `request_access` (core's CREW_NEVER_TOOLS);
    // this is the same rule at the door where the grant would move, so a row
    // from one (or from an older build) cannot be approved either.
    const id = `itest-crew-${suffix}`;
    await pool.query(`INSERT INTO agents (id, display_name, kind, token_hash, grants) VALUES ($1, $1, 'crew', $2, '{"tier":"index","areas":[]}'::jsonb)`, [id, mintToken(32)]);
    const planted = await pool.query(
      `INSERT INTO proposals (kind, source_agent, trust, payload) VALUES ($1, $2, 'external', $3::jsonb) RETURNING id`,
      [ACCESS_REQUEST_KIND, id, JSON.stringify({ title: "planted", area: "Areas/Whatever", reason: "planted" })],
    );
    const proposalId = Number(planted.rows[0]!.id);
    const r = await owner("POST", `/api/proposals/${proposalId}`, { decision: "allow" });
    expect(r.status).toBe(403);
    expect((await r.json()).error.message).toContain("manifest");
    expect(await proposal(proposalId)).toMatchObject({ decision: "pending" }); // Decline is the answer, and it is still there to give
    expect(await grantsOf(id)).toEqual({ tier: "index", areas: [] });
    await pool.query(`DELETE FROM proposals WHERE id = $1`, [proposalId]);
    await pool.query(`DELETE FROM agents WHERE id = $1`, [id]);
  });

  // Ruled 2026-09-19 (B): "the assistant should be able to ask." It could
  // not, because `ensureInternalAgent` replaces an internal row's grants
  // from configuration at every start, so an approval would have been undone
  // by the next restart. This is the whole loop with the restart IN it.
  it("an INTERNAL row can be widened from the queue, and the widening survives the next console start", async () => {
    const id = `itest-int-${suffix}`;
    const token = mintToken(32);
    const configured = () => agents.validateGrants({ tier: "areas", areas: ["Areas/Narrow"] }, { kind: "internal" });
    const restart = () => agents.ensureInternalAgent(pool, id, { token, grants: configured() }); // exactly what main.ts does on boot

    await restart();
    expect(await grantsOf(id)).toEqual({ tier: "areas", areas: ["Areas/Narrow"] });

    // the assistant asks, through the same tool every other principal uses
    const planted = await pool.query(
      `INSERT INTO proposals (kind, source_agent, trust, payload) VALUES ($1, $2, 'external', $3::jsonb) RETURNING id`,
      [ACCESS_REQUEST_KIND, id, JSON.stringify({ title: `${id} asks to read Areas/Asked`, area: "Areas/Asked", reason: "the task the owner assigned needs the note in there" })],
    );
    const proposalId = Number(planted.rows[0]!.id);

    const allow = await owner("POST", `/api/proposals/${proposalId}`, { decision: "allow" });
    expect(allow.status).toBe(200);
    expect(await grantsOf(id)).toEqual({ tier: "areas", areas: ["Areas/Narrow", "Areas/Asked"] });
    // the durable record, beside the row the owner answered (migration 0023)
    expect((await pool.query(`SELECT area, proposal_id FROM agent_grant_overrides WHERE agent_id = $1`, [id])).rows).toEqual([{ area: "Areas/Asked", proposal_id: String(proposalId) }]);

    // THE POINT: configuration is re-applied and the approval is still there
    await restart();
    expect(await grantsOf(id)).toEqual({ tier: "areas", areas: ["Areas/Narrow", "Areas/Asked"] });

    // …and configuration is still the floor: narrowing it narrows everything
    // except what was explicitly approved, and never the other way round.
    await agents.ensureInternalAgent(pool, id, { token, grants: agents.validateGrants({ tier: "areas", areas: ["Me"] }, { kind: "internal" }) });
    expect(await grantsOf(id)).toEqual({ tier: "areas", areas: ["Me", "Areas/Asked"] });

    // revoking the credential takes its approvals with it
    expect((await owner("POST", `/api/agents/${id}/revoke`)).status).toBe(200);
    expect((await pool.query(`SELECT count(*)::int AS n FROM agent_grant_overrides WHERE agent_id = $1`, [id])).rows[0]!.n).toBe(0);
    await restart();
    expect(await grantsOf(id)).toEqual({ tier: "areas", areas: ["Areas/Narrow"] });

    await pool.query(`DELETE FROM proposals WHERE source_agent = $1`, [id]);
    await pool.query(`DELETE FROM agents WHERE id = $1`, [id]);
  });

  it("a payload crafted past the tool is re-validated at the decision: the console grants no area its own validator would refuse", async () => {
    const before = await grantsOf(agentId);
    for (const area of ["../../etc/passwd", ".metistry/state", "Artifacts/Reports", "areas/lower", "/", null]) {
      const planted = await pool.query(
        `INSERT INTO proposals (kind, source_agent, trust, payload) VALUES ($1, $2, 'external', $3::jsonb) RETURNING id`,
        [ACCESS_REQUEST_KIND, agentId, JSON.stringify({ title: "planted", ...(area === null ? {} : { area }), reason: "planted by hand" })],
      );
      const id = Number(planted.rows[0]!.id);
      const r = await owner("POST", `/api/proposals/${id}`, { decision: "allow" });
      expect(r.status, String(area)).toBe(400);
      expect(await proposal(id), String(area)).toMatchObject({ decision: "pending" });
      expect(await grantsOf(agentId), String(area)).toEqual(before);
      await pool.query(`DELETE FROM proposals WHERE id = $1`, [id]);
    }
  });
});
