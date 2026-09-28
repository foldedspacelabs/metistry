// Approve on an Ask First connection call (T4-9): the owner's answer runs the
// payload the proxy built and previewed — never the client's — and a confirm
// token runs once. Against the real scratch database, the real console and
// its real `/mcp`, with a fake pooled client standing in for the connection,
// so what reached "upstream" is exactly what the pool was asked for.
//
// The two bold tests of the ticket:
//
//   * **an approved call runs the server's payload, never the client's** —
//     neither what the Approve's body says, nor a row whose arguments were
//     changed after the preview;
//   * **a replayed confirm token is refused** — a second Approve, the same
//     token copied into another request, and the agent presenting it itself
//     all run nothing.
//
// Plus C45 on this path (a refusal leaves the request pending, with why) and
// the Approve door's misuse set (U2) on a connection call row.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { mintToken } from "@foldedspacelabs/metistry-core";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";
import type { ConnectionsProxy, ProxiedConnection } from "@foldedspacelabs/metistry-mcp-brain";
import { makeServer } from "../src/server.js";
import * as store from "../src/auth-store.js";
import * as agents from "../src/agents.js";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url)); // METISTRY_DB_* only (docs/ops/testing.md)
const policy = { idleDays: 30, maxDays: 365 };

const TRACKER: ProxiedConnection = {
  name: "tracker",
  type: "mcp",
  description: "an issue tracker",
  status: "ok",
  offer_to_agents: false, // the assistant's own: the switch is about lending (C115)
  tools: [
    { name: "comment_issue", group: "changes", mode: "ask" },
    { name: "close_issue", group: "changes", mode: "ask" },
  ],
};

type CallReq = Parameters<ConnectionsProxy["call"]>[0];

describe.skipIf(!hasDb)("Approve on a connection call (integration)", () => {
  let pool: pg.Pool;
  let base: string;
  let server: ReturnType<typeof makeServer>;
  let cookie: string;
  let dir: string;
  let agentToken: string;
  let captureToken: string;
  const localOwnerToken = mintToken(32);
  const suffix = mintToken(4).toLowerCase().replaceAll(/[^a-z0-9]/g, "").slice(0, 6) || "x";
  const agentId = `conn-itest-${suffix}`;
  const calls: CallReq[] = [];
  /** What the next pool call does: answer, or refuse the way the pool refuses before dialling, or fail after it dialled. */
  let next: "answer" | "refuse" | "fail" = "answer";
  let rpcId = 1;

  const proxy: ConnectionsProxy = {
    async list() {
      return [TRACKER];
    },
    async tools() {
      return [];
    },
    async call(req) {
      calls.push(req);
      if (next === "refuse") throw Object.assign(new Error("connection tracker refused (tool_off): comment_issue is set to Never"), { name: "ConnectionRefused", code: "tool_off" });
      if (next === "fail") throw new Error("upstream timed out");
      return { content: [{ type: "text", text: `commented on ${String(req.args.issue)}` }], isError: false, secrets: ["tracker_token"] };
    },
  };

  const answer = (id: number, body: Record<string, unknown>, headers: Record<string, string> = { cookie }) =>
    fetch(`${base}/api/proposals/${id}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

  /** The agent asks, over its own `/mcp`: an Ask First call answers pending and raises one request. */
  async function ask(args: Record<string, unknown>, tool = "comment_issue"): Promise<number> {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${agentToken}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method: "tools/call", params: { name: "connections_call", arguments: { connection: "tracker", tool, arguments: args } } }),
    });
    const body = JSON.parse(((await res.json()) as { result: { content: { text: string }[] } }).result.content[0]!.text.split("\n")[0]!);
    expect(body.status, JSON.stringify(body)).toBe("pending");
    return Number(body.proposal_id);
  }

  const row = async (id: number) => (await pool.query(`SELECT decision, payload FROM proposals WHERE id = $1`, [id])).rows[0]!;

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
    dir = await mkdtemp(join(tmpdir(), "metistry-conn-"));
    server = makeServer(pool, new QueryStore(pool), {
      origin: "http://127.0.0.1:0",
      inboxDir: join(dir, "inbox"),
      policy,
      secureCookies: false,
      localOwner: { token: localOwnerToken, trusted: [] },
      connectionsProxy: proxy,
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const pkId = `conn-${mintToken(8)}`;
    await store.storePasskey(pool, { id: pkId, publicKey: new Uint8Array([1]), signCount: 0, transports: [], origin: "t", label: "conn-test" });
    cookie = `metistry_session=${await store.issueSession(pool, pkId, policy)}`;
    captureToken = await store.mintOwnerToken(pool, `itest-conn-${suffix}`);
    ({ token: agentToken } = await agents.createAgent(pool, { id: agentId, display_name: "connection call itest" }));
    // the instance's own assistant reaches every connection; its token is the user's environment (§4.11)
    await pool.query(`UPDATE agents SET kind = 'internal' WHERE id = $1`, [agentId]);
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await pool.end();
    await rm(dir, { recursive: true, force: true });
  });

  it("an approved call runs the server's payload, never the client's — whatever the Approve's body carries", async () => {
    calls.length = 0;
    const id = await ask({ issue: 42, body: "this test is flaky" });
    expect(calls).toEqual([]); // asking ran nothing
    // a client that tries to steer the call: other args, another tool, a whole action, a claimed approval
    const res = await answer(id, {
      decision: "allow",
      args: { issue: 1, body: "rm -rf" },
      tool: "close_issue",
      action: { kind: "connection_call", args: { connection: "tracker", tool: "close_issue", args: { issue: 1 }, confirm_token: "A".repeat(43) } },
      approved: true,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.action).toMatchObject({ kind: "connection_call", connection: "tracker", tool: "comment_issue", is_error: false });
    expect(calls).toEqual([{ connection: "tracker", tool: "comment_issue", args: { issue: 42, body: "this test is flaky" }, approved: true }]);

    // settled, with the result on it, and the call audited as a connection_call on the agent's behalf
    const settled = await row(id);
    expect(settled.decision).toBe("allow");
    expect(settled.payload.result).toMatchObject({ connection: "tracker", tool: "comment_issue", by: "user", on_behalf_of: agentId });
    const run = (await pool.query(`SELECT component, tool, ok, meta FROM runs WHERE id = $1`, [body.action.connection_run])).rows[0]!;
    expect(run).toMatchObject({ component: agentId, tool: "approve", ok: true });
    expect(run.meta).toMatchObject({ connection: "tracker", connection_tool: "comment_issue", mode: "approved", proposal: id, principal: "user", dialled: true, secrets: ["tracker_token"] });
    // the preview's token is spent
    const preview = (await pool.query(`SELECT meta FROM runs WHERE id = $1`, [settled.payload.preview_run])).rows[0]!;
    expect(preview.meta.confirm.redeemed_at).toBeTruthy();
  });

  it("a row whose arguments changed after the preview runs nothing, and stays pending with why", async () => {
    calls.length = 0;
    const id = await ask({ issue: 7, body: "harmless" });
    // the stored payload rewritten — by hand, or by anything that is not the proxy
    await pool.query(`UPDATE proposals SET payload = jsonb_set(payload, '{action,args,args}', '{"issue": 7, "body": "something else"}') WHERE id = $1`, [id]);
    const res = await answer(id, { decision: "allow" });
    expect(res.status).toBe(409);
    expect((await res.json()).error.message).toContain("not the ones the agent's call previewed");
    expect(calls).toEqual([]);
    const pending = await row(id);
    expect(pending.decision).toBe("pending");
    expect(pending.payload.error).toMatchObject({ code: "conflict", refused: "confirm_other_payload" });
  });

  it("a replayed confirm token is refused: a second Approve, a copy of the request, and the agent itself all run nothing", async () => {
    calls.length = 0;
    const id = await ask({ issue: 9, body: "once" });
    const stored = (await row(id)).payload;

    // the same request copied into a second row — every field, token and preview included
    const { rows } = await pool.query(`INSERT INTO proposals (kind, source_agent, trust, payload) VALUES ('action', $1, 'internal', $2::jsonb) RETURNING id`, [agentId, JSON.stringify(stored)]);
    const copy = Number(rows[0]!.id);
    // the copy first: its token belongs to the original request, so it redeems nothing
    const early = await answer(copy, { decision: "allow" });
    expect(early.status).toBe(409);
    expect((await early.json()).error.message).toContain("not issued for this request");
    expect(calls).toEqual([]);

    expect((await answer(id, { decision: "allow" })).status).toBe(200);
    expect(calls).toHaveLength(1);
    // a second Approve of the settled request
    expect((await answer(id, { decision: "allow" })).status).toBe(409);
    // and the copy again, now the token is spent
    const late = await answer(copy, { decision: "allow" });
    expect(late.status).toBe(409);
    expect(calls).toHaveLength(1);
    expect((await row(copy)).decision).toBe("pending");

    // the agent presenting the owner's token on its own door
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${agentToken}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: rpcId++,
        method: "tools/call",
        params: { name: "connections_call", arguments: { connection: "tracker", tool: "comment_issue", arguments: { issue: 9, body: "once" }, confirm_token: stored.action.args.confirm_token } },
      }),
    });
    const refused = JSON.parse(((await res.json()) as { result: { content: { text: string }[] } }).result.content[0]!.text.split("\n")[0]!);
    expect(refused.error.code).toBe("forbidden");
    expect(calls).toHaveLength(1);
  });

  it("Decline and Revise run nothing, and a declined request's token never runs later", async () => {
    calls.length = 0;
    const declined = await ask({ issue: 3, body: "no" });
    expect((await answer(declined, { decision: "deny" })).status).toBe(200);
    const revised = await ask({ issue: 4, body: "maybe" });
    expect((await answer(revised, { decision: "accept_with_changes", feedback: "not this one" })).status).toBe(200);
    expect(calls).toEqual([]);
    expect((await answer(declined, { decision: "allow" })).status).toBe(409);
    expect(calls).toEqual([]);
  });

  it("C45: a refusal before dialling leaves it pending and gives the token back; a call that was sent keeps it spent", async () => {
    calls.length = 0;
    const id = await ask({ issue: 11, body: "retry me" });
    next = "refuse";
    const refused = await answer(id, { decision: "allow" });
    expect(refused.status).toBe(404);
    expect((await refused.json()).error.message).toContain("before anything was sent");
    expect((await row(id)).decision).toBe("pending");
    // fixed: Approve again runs it, once
    next = "answer";
    expect((await answer(id, { decision: "allow" })).status).toBe(200);
    expect(calls).toHaveLength(2);

    const sent = await ask({ issue: 12, body: "maybe it happened" });
    next = "fail";
    const failed = await answer(sent, { decision: "allow" });
    expect(failed.status).toBe(503);
    expect((await failed.json()).error.message).toContain("not repeated");
    next = "answer";
    expect((await answer(sent, { decision: "allow" })).status).toBe(409); // the token went with the call that was sent
    expect(calls).toHaveLength(3);
    expect((await row(sent)).decision).toBe("pending");
  });

  it("U2: the Approve door on a connection call — 401 with no credential, 403 for an agent bearer and the capture owner token, the local owner reaches it", async () => {
    calls.length = 0;
    const id = await ask({ issue: 21, body: "doors" });
    const none = await answer(id, { decision: "allow" }, {});
    expect(none.status).toBe(401);
    expect(await none.json()).toEqual({ error: { code: "unauthenticated", message: "authentication required" } });
    for (const bearer of [agentToken, captureToken]) {
      const r = await answer(id, { decision: "allow" }, { authorization: `Bearer ${bearer}` });
      expect(r.status).toBe(403);
      expect(await r.json()).toEqual({ error: { code: "forbidden", message: "not granted" } });
    }
    expect(calls).toEqual([]);
    expect((await row(id)).decision).toBe("pending");
    const owner = await answer(id, { decision: "allow" }, { authorization: `Bearer ${localOwnerToken}` });
    expect(owner.status).toBe(200);
    expect(calls).toHaveLength(1);
  });
});
