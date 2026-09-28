// Defer and report (C59; T4-22), against the real scratch database with a
// fake proxy — so what reached "upstream" is exactly what the proxy was asked
// for, and the request, the confirm record and the run row are the real SQL.
//
// *Ask* means pause when the owner is there and defer when nobody is. The
// run's origin rides in the call's `_meta` (turn-id.ts); the boundary:
//
//   * **an unattended Ask never blocks and never runs** — the answer comes
//     back while the proxy would hang forever, it says `skipped`, nothing is
//     dialled, and the request still lands in Needs You;
//   * **the bit grants nothing** — interactive, absent, malformed or forged
//     in the arguments, an Ask First call still waits for the owner, and a
//     caller's token still cannot run a deferred one;
//   * **it changes nothing but Ask** — a Read at Allow still runs, a Changes
//     tool at Allow still previews for the caller's own confirm;
//   * **deferred asks count** against the caller's Ask First limit.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { TasksService } from "@foldedspacelabs/metistry-tasks";
import { confirmTokenDigest, mintToken } from "@foldedspacelabs/metistry-core";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";
import { INTERACTIVE_META_KEY, TURN_ID_META_KEY, createBrainServer, type AgentPrincipal, type ConnectionLimits, type ConnectionsProxy, type ProxiedConnection } from "../src/index.js";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url));

const suffix = mintToken(4).toLowerCase().replaceAll(/[^a-z0-9]/g, "").slice(0, 6) || "x";
const GITHUB: ProxiedConnection = {
  name: "github",
  type: "mcp",
  description: "GitHub",
  status: "ok",
  offer_to_agents: true,
  tools: [
    { name: "list_issues", group: "reads", mode: "on" },
    { name: "create_issue", group: "changes", mode: "on" },
    { name: "comment_issue", group: "changes", mode: "ask" },
    { name: "run_workflow", group: "starts_agent", mode: "ask" },
  ],
};

type CallReq = Parameters<ConnectionsProxy["call"]>[0];

/** A proxy whose Ask First tools would never answer: a call that reached one would hang the test, which is the point. */
function hangingProxy(): ConnectionsProxy & { calls: CallReq[] } {
  const calls: CallReq[] = [];
  return {
    calls,
    async list() {
      return [GITHUB];
    },
    async tools() {
      return [];
    },
    async call(req) {
      calls.push(req);
      if (GITHUB.tools.find((t) => t.name === req.tool)?.mode === "ask") return new Promise(() => {});
      return { content: [{ type: "text", text: `ran ${req.tool}` }], isError: false, secrets: [] };
    },
  };
}

interface Parsed {
  isError: boolean;
  body: any;
}

/** How the call says who is there: nothing, or a `_meta` value (the wire's own carrier). */
type Origin = { meta?: Record<string, unknown> };
const UNATTENDED = (turn: string): Origin => ({ meta: { [INTERACTIVE_META_KEY]: false, [TURN_ID_META_KEY]: turn } });

describe.skipIf(!hasDb)("connections_call: an unattended Ask is deferred and reported (real db)", () => {
  let pool: pg.Pool;
  const servers: Server[] = [];

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
  });

  afterAll(async () => {
    for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
    await pool.end();
  });

  async function brainFor(principal: AgentPrincipal, limits?: ConnectionLimits) {
    const proxy = hangingProxy();
    const brain = createBrainServer({
      db: pool,
      authenticate: async () => principal,
      tasks: new TasksService(pool),
      inboxDir: "/nonexistent",
      connections: proxy,
      ...(limits ? { connectionLimits: limits } : {}),
    });
    const server = createServer((req, res) => void brain.handle(req, res));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    servers.push(server);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    let id = 1;
    const call = async (args: Record<string, unknown>, origin: Origin = {}): Promise<Parsed> => {
      const res = await fetch(base, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer itest-defer-bearer-0123456789" },
        body: JSON.stringify({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name: "connections_call", arguments: args, ...(origin.meta ? { _meta: origin.meta } : {}) } }),
        signal: AbortSignal.timeout(5_000), // a blocked call fails the test here rather than hanging it
      });
      const answer = (await res.json()) as { result: { isError?: boolean; content: { text: string }[] } };
      return { isError: answer.result.isError === true, body: JSON.parse(answer.result.content[0]!.text.split("\n")[0]!) };
    };
    return { call, proxy };
  }

  const agent = (id: string, autonomy?: AgentPrincipal["autonomy"]): AgentPrincipal => ({
    id,
    grants: { tier: "none", areas: [], connections: ["github"] },
    projects: [],
    ...(autonomy ? { autonomy } : {}),
  });
  const proposalsOf = async (who: string) => (await pool.query(`SELECT id, decision, payload FROM proposals WHERE source_agent = $1 ORDER BY id`, [who])).rows;

  it("an unattended Ask never blocks and never runs: skipped at once, nothing dialled, and the request still lands in Needs You", async () => {
    const who = `itest-defer-${suffix}`;
    const { call, proxy } = await brainFor(agent(who));
    const started = Date.now();
    const r = await call({ connection: "github", tool: "comment_issue", arguments: { issue: 412, body: "flaky on main" } }, UNATTENDED(`turn-${suffix}`));
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(r.isError).toBe(false); // not a refusal: a refusal would make the run look broken
    expect(r.body).toMatchObject({ skipped: true, reason: "waits_for_you", connection: "github", tool: "comment_issue", preview: "call comment_issue on github" });
    expect(r.body.status).toBeUndefined();
    expect(r.body.confirm_token).toBeUndefined();
    expect(proxy.calls).toEqual([]);

    // the request is an ordinary Ask First request, marked as one nobody waited on
    const [row] = await proposalsOf(who);
    expect(Number(row.id)).toBe(Number(r.body.proposal_id));
    expect(row.decision).toBe("pending");
    expect(row.payload.action).toMatchObject({ kind: "connection_call", args: { connection: "github", tool: "comment_issue", args: { issue: 412, body: "flaky on main" } } });
    expect(row.payload.provenance).toMatchObject({ agent: who, via: "connections_call", deferred: true });

    // the row says what happened, keyed by the turn the run will read it back by
    const run = (await pool.query(`SELECT kind, ok, meta FROM runs WHERE id = $1`, [row.payload.preview_run])).rows[0]!;
    expect(run).toMatchObject({ kind: "connection_call", ok: true });
    expect(run.meta).toMatchObject({ mode: "ask", outcome: "deferred", tool_mode: "ask", unattended: true, turn_id: `turn-${suffix}`, proposal_id: Number(r.body.proposal_id) });
    expect(run.meta.dialled).toBeUndefined();
    // …and holds the owner's confirm record, so the owner's Approve can still run it later
    expect(run.meta.confirm).toMatchObject({ mode: "ask", digest: confirmTokenDigest(row.payload.action.args.confirm_token), proposal_id: Number(r.body.proposal_id) });
    expect(run.meta.confirm.redeemed_at).toBeUndefined();
  });

  it("an Ask on a Starts-an-agent tool defers the same way", async () => {
    const who = `itest-defer-agent-${suffix}`;
    const { call, proxy } = await brainFor(agent(who));
    const r = await call({ connection: "github", tool: "run_workflow", arguments: { workflow: "ci" } }, UNATTENDED("t-agent"));
    expect(r.body).toMatchObject({ skipped: true, reason: "waits_for_you" });
    expect(proxy.calls).toEqual([]);
  });

  it("the bit grants nothing: a caller's token cannot run a deferred call, and asking off still raises nothing", async () => {
    const who = `itest-defer-token-${suffix}`;
    const { call, proxy } = await brainFor(agent(who));
    const args = { connection: "github", tool: "comment_issue", arguments: { issue: 1, body: "b" } };
    await call(args, UNATTENDED("t-token"));
    const [stored] = await proposalsOf(who);
    const replay = await call({ ...args, confirm_token: stored.payload.action.args.confirm_token }, UNATTENDED("t-token"));
    expect(replay.body.error.code).toBe("forbidden");
    expect(proxy.calls).toEqual([]);
    expect((await pool.query(`SELECT meta FROM runs WHERE id = $1`, [stored.payload.preview_run])).rows[0]!.meta.confirm.redeemed_at).toBeUndefined();

    const quiet = `itest-defer-deny-${suffix}`;
    const denied = await brainFor(agent(quiet, { level: "act_within_scope", actions: { connection_call: "deny" } }));
    const r = await denied.call(args, UNATTENDED("t-deny"));
    expect(r.body.error.code).toBe("forbidden");
    expect(await proposalsOf(quiet)).toHaveLength(0);
    expect(denied.proxy.calls).toEqual([]);
  });

  it("interactive, absent, malformed or forged in the arguments: the call pauses, exactly as before the bit existed", async () => {
    const who = `itest-pause-${suffix}`;
    const { call, proxy } = await brainFor(agent(who));
    const args = { connection: "github", tool: "comment_issue", arguments: { issue: 2, body: "b" } };
    const origins: Origin[] = [{}, { meta: { [INTERACTIVE_META_KEY]: true } }, { meta: { [INTERACTIVE_META_KEY]: "false" } }, { meta: { interactive: false } }];
    for (const origin of origins) {
      const r = await call(args, origin);
      expect(r.body, JSON.stringify(origin)).toMatchObject({ status: "pending" });
      expect(r.body.skipped).toBeUndefined();
    }
    // a model cannot say it in the arguments: the schema is not where the bit lives
    const forged = await call({ ...args, interactive: false, _meta: { [INTERACTIVE_META_KEY]: false } });
    expect(forged.body.status).toBe("pending");
    const rows = (await pool.query(`SELECT meta FROM runs WHERE component = $1 AND kind = 'connection_call' ORDER BY id`, [who])).rows;
    expect(rows).toHaveLength(5);
    for (const { meta } of rows) {
      expect(meta.outcome).toBeUndefined();
      expect(meta.unattended).toBeUndefined();
    }
    expect(proxy.calls).toEqual([]);
    for (const p of await proposalsOf(who)) expect(p.payload.provenance.deferred).toBeUndefined();
  });

  it("it changes nothing but Ask: unattended, a Read at Allow runs and a Changes tool at Allow previews for its own confirm", async () => {
    const who = `itest-defer-allow-${suffix}`;
    const { call, proxy } = await brainFor(agent(who));
    const read = await call({ connection: "github", tool: "list_issues" }, UNATTENDED("t-allow"));
    expect(read.body).toMatchObject({ connection: "github", tool: "list_issues" });
    const preview = await call({ connection: "github", tool: "create_issue", arguments: { title: "x" } }, UNATTENDED("t-allow"));
    expect(preview.body.status).toBe("preview");
    const ran = await call({ connection: "github", tool: "create_issue", arguments: { title: "x" }, confirm_token: preview.body.confirm_token }, UNATTENDED("t-allow"));
    expect(ran.isError).toBe(false);
    expect(proxy.calls.map((c) => c.tool)).toEqual(["list_issues", "create_issue"]);
    expect(await proposalsOf(who)).toHaveLength(0);
  });

  it("deferred asks count against the caller's Ask First limit", async () => {
    const who = `itest-defer-limit-${suffix}`;
    const { call } = await brainFor(agent(who), { confirmTtlS: 900, callsPerHour: 10, asksPerHour: 1 });
    expect((await call({ connection: "github", tool: "comment_issue", arguments: { n: 1 } }, UNATTENDED("t-limit"))).body.skipped).toBe(true);
    const second = await call({ connection: "github", tool: "comment_issue", arguments: { n: 2 } }, UNATTENDED("t-limit"));
    expect(second.body.error.code).toBe("rate_limited");
    expect(await proposalsOf(who)).toHaveLength(1);
  });
});
