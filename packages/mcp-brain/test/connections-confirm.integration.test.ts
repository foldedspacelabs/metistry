// Preview-then-confirm on the connections proxy (T4-9), against the real
// scratch database with a fake proxy — so what reached "upstream" is exactly
// what the proxy was asked for, and the confirm records and rate limits are
// the real SQL on the real `runs` table.
//
// The policy boundary, each a refusal or a count of calls the proxy saw:
//
//   * **Never never runs** — with or without a token;
//   * **Ask First previews and waits** — a Needs You row, nothing dialled, and
//     no caller's token can run it;
//   * **Allow runs after confirm** — a Changes tool answers a preview first,
//     and runs once for the arguments it previewed;
//   * **a replayed confirm token is refused** — the second presentation runs
//     nothing, and neither does a token presented for other arguments, by
//     another caller, or after its time;
//   * **rate limits come from `runs`**.
//
// The owner's Approve of an Ask First call is apps/console's
// connection-call.integration.test.ts: that is where the server's payload,
// never the client's, is held.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { TasksService } from "@foldedspacelabs/metistry-tasks";
import { CONFIRM_TOKEN_RE, confirmTokenDigest, mintToken } from "@foldedspacelabs/metistry-core";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";
import { createBrainServer, proposeAction, type AgentPrincipal, type ConnectionLimits, type ConnectionsProxy, type ProxiedConnection } from "../src/index.js";

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
    { name: "run_workflow", group: "starts_agent", mode: "on" },
    { name: "comment_issue", group: "changes", mode: "ask" },
    { name: "delete_repo", group: "changes", mode: "off" },
  ],
};

type CallReq = Parameters<ConnectionsProxy["call"]>[0];

function fakeProxy(): ConnectionsProxy & { calls: CallReq[] } {
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
      return { content: [{ type: "text", text: `ran ${req.tool}` }], isError: false, secrets: [] };
    },
  };
}

interface Parsed {
  isError: boolean;
  body: any;
}

describe.skipIf(!hasDb)("connections_call: preview, confirm, Ask First and the limits (real db)", () => {
  let pool: pg.Pool;
  const servers: Server[] = [];

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
  });

  afterAll(async () => {
    for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
    await pool.end();
  });

  /** One bridge for one principal, over raw JSON-RPC so the wire is what is asserted. */
  async function brainFor(principal: AgentPrincipal, limits?: ConnectionLimits) {
    const proxy = fakeProxy();
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
    const call = async (args: Record<string, unknown>): Promise<Parsed> => {
      const res = await fetch(base, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer itest-connections-bearer-0123456789" },
        body: JSON.stringify({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name: "connections_call", arguments: args } }),
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
  const lastRun = async (component: string) => (await pool.query(`SELECT ok, error, meta FROM runs WHERE component = $1 AND kind = 'connection_call' ORDER BY id DESC LIMIT 1`, [component])).rows[0]!;

  it("Never never runs — with or without a confirm token in hand", async () => {
    const who = `itest-never-${suffix}`;
    const { call, proxy } = await brainFor(agent(who));
    expect((await call({ connection: "github", tool: "delete_repo" })).body.error).toEqual({ code: "not_found", message: "no such tool: github/delete_repo" });
    // a real token, minted for another tool of the same connection, does not open a tool at Never
    const preview = await call({ connection: "github", tool: "create_issue", arguments: { title: "x" } });
    expect((await call({ connection: "github", tool: "delete_repo", arguments: { title: "x" }, confirm_token: preview.body.confirm_token })).body.error.code).toBe("not_found");
    expect(proxy.calls).toEqual([]);
  });

  it("Allow runs after confirm: a Changes tool previews first, nothing dialled, then runs ONCE for the arguments it previewed", async () => {
    const who = `itest-confirm-${suffix}`;
    const { call, proxy } = await brainFor(agent(who));
    const preview = await call({ connection: "github", tool: "create_issue", arguments: { title: "flake", labels: ["ci"] } });
    expect(preview.isError).toBe(false);
    expect(preview.body).toMatchObject({ status: "preview", tool: "create_issue", arguments: { title: "flake", labels: ["ci"] }, expires_in_sec: 900 });
    const token = String(preview.body.confirm_token);
    expect(token).toMatch(CONFIRM_TOKEN_RE);
    expect(proxy.calls).toEqual([]);
    // the server keeps a digest, never the token
    const record = (await lastRun(who)).meta;
    expect(record).toMatchObject({ mode: "preview", tool_mode: "on", group: "changes", confirm: { mode: "on", digest: confirmTokenDigest(token) } });
    expect(JSON.stringify(record)).not.toContain(token);

    // the same payload in another key order is the same payload
    const ran = await call({ connection: "github", tool: "create_issue", arguments: { labels: ["ci"], title: "flake" }, confirm_token: token });
    expect(ran.isError).toBe(false);
    expect(ran.body).toMatchObject({ connection: "github", tool: "create_issue", content: [{ type: "text", text: "ran create_issue" }] });
    expect(proxy.calls).toHaveLength(1);
    expect(proxy.calls[0]).toMatchObject({ connection: "github", tool: "create_issue", args: { title: "flake", labels: ["ci"] } });
    expect(proxy.calls[0]!.approved).toBeUndefined(); // a caller's confirm is never the owner's approval
    expect((await lastRun(who)).meta).toMatchObject({ mode: "confirmed", dialled: true });

    // Starts an agent is the same rule
    const wf = await call({ connection: "github", tool: "run_workflow", arguments: { ref: "main" } });
    expect(wf.body.status).toBe("preview");
    expect(proxy.calls).toHaveLength(1);
  });

  it("a replayed confirm token is refused — the second presentation runs nothing", async () => {
    const who = `itest-replay-${suffix}`;
    const { call, proxy } = await brainFor(agent(who));
    const args = { connection: "github", tool: "create_issue", arguments: { title: "once" } };
    const token = String((await call(args)).body.confirm_token);
    expect((await call({ ...args, confirm_token: token })).isError).toBe(false);
    const replay = await call({ ...args, confirm_token: token });
    expect(replay.isError).toBe(true);
    expect(replay.body.error.code).toBe("conflict");
    expect(replay.body.error.message).toContain("a token runs once");
    expect((await lastRun(who)).meta.refusal).toBe("confirm_spent");
    expect(proxy.calls).toHaveLength(1);

    // two presentations racing: exactly one runs
    const token2 = String((await call(args)).body.confirm_token);
    const raced = await Promise.all([call({ ...args, confirm_token: token2 }), call({ ...args, confirm_token: token2 })]);
    expect(raced.filter((r) => !r.isError)).toHaveLength(1);
    expect(proxy.calls).toHaveLength(2);
  });

  it("a token runs only what it previewed: other arguments, another caller, or after its time — refused, and spent", async () => {
    const who = `itest-bind-${suffix}`;
    const { call, proxy } = await brainFor(agent(who));
    const args = { connection: "github", tool: "create_issue", arguments: { title: "the one I showed" } };

    // other arguments: refused, and the token is spent by the attempt
    const t1 = String((await call(args)).body.confirm_token);
    const swapped = await call({ ...args, arguments: { title: "something else" }, confirm_token: t1 });
    expect(swapped.body.error.code).toBe("conflict");
    expect((await lastRun(who)).meta.refusal).toBe("confirm_other_payload");
    expect((await call({ ...args, confirm_token: t1 })).body.error.code).toBe("conflict");
    // another tool of the same connection
    const t2 = String((await call(args)).body.confirm_token);
    expect((await call({ ...args, tool: "run_workflow", confirm_token: t2 })).body.error.code).toBe("conflict");

    // another caller holding the token
    const t3 = String((await call(args)).body.confirm_token);
    const thief = await brainFor(agent(`itest-thief-${suffix}`));
    expect((await thief.call({ ...args, confirm_token: t3 })).body.error.code).toBe("conflict");
    expect(thief.proxy.calls).toEqual([]);

    // after its time
    const t4 = String((await call(args)).body.confirm_token);
    await pool.query(`UPDATE runs SET meta = jsonb_set(meta, '{confirm,expires_at}', to_jsonb((now() - interval '1 second')::text)) WHERE meta -> 'confirm' ->> 'digest' = $1`, [confirmTokenDigest(t4)]);
    expect((await call({ ...args, confirm_token: t4 })).body.error.code).toBe("conflict");
    expect((await lastRun(who)).meta.refusal).toBe("confirm_expired");

    // a token nobody minted
    expect((await call({ ...args, confirm_token: "B".repeat(43) })).body.error.code).toBe("conflict");
    expect(proxy.calls).toEqual([]);
  });

  it("Ask First previews and waits: one Needs You row carrying the payload it will run, nothing dialled", async () => {
    const who = `itest-ask-${suffix}`;
    const { call, proxy } = await brainFor(agent(who));
    const asked = await call({ connection: "github", tool: "comment_issue", arguments: { issue: 7, body: "looks flaky" } });
    expect(asked.isError).toBe(false);
    expect(asked.body).toMatchObject({ status: "pending", connection: "github", tool: "comment_issue", preview: "call comment_issue on github" });
    expect(asked.body.confirm_token).toBeUndefined(); // the owner confirms an Ask First call, not the caller
    expect(proxy.calls).toEqual([]);

    const row = (await pool.query(`SELECT kind, decision, source_agent, trust, work_id, payload FROM proposals WHERE id = $1`, [asked.body.proposal_id])).rows[0]!;
    expect(row).toMatchObject({ kind: "action", decision: "pending", source_agent: who, trust: "external", work_id: null });
    expect(row.payload.title).toBe("call comment_issue on github");
    expect(row.payload.action).toMatchObject({ kind: "connection_call", args: { connection: "github", tool: "comment_issue", args: { issue: 7, body: "looks flaky" } } });
    // the run that previewed it holds the record, bound to THIS proposal — written in the same statement
    const run = (await pool.query(`SELECT component, meta FROM runs WHERE id = $1`, [row.payload.preview_run])).rows[0]!;
    expect(run.component).toBe(who);
    expect(run.meta.confirm).toMatchObject({ mode: "ask", digest: confirmTokenDigest(row.payload.action.args.confirm_token), proposal_id: Number(asked.body.proposal_id) });
    expect(run.meta).toMatchObject({ mode: "ask", tool_mode: "ask" });
  });

  it("Ask First never runs on a caller's token — not even the one its own request carries", async () => {
    const who = `itest-askrun-${suffix}`;
    const { call, proxy } = await brainFor(agent(who));
    const args = { connection: "github", tool: "comment_issue", arguments: { issue: 1, body: "b" } };
    const asked = await call(args);
    const stored = (await pool.query(`SELECT payload FROM proposals WHERE id = $1`, [asked.body.proposal_id])).rows[0]!.payload;
    const r = await call({ ...args, confirm_token: stored.action.args.confirm_token });
    expect(r.body.error.code).toBe("forbidden");
    expect(r.body.error.message).toContain("Ask First");
    // …nor presented against an Allow tool of the same connection
    const other = await call({ connection: "github", tool: "create_issue", arguments: { issue: 1, body: "b" }, confirm_token: stored.action.args.confirm_token });
    expect(other.body.error.code).toBe("forbidden");
    expect((await lastRun(who)).meta.refusal).toBe("ask_only");
    expect(proxy.calls).toEqual([]);
    // and the owner's token is still unspent: nothing here touched it
    const run = (await pool.query(`SELECT meta FROM runs WHERE id = $1`, [stored.preview_run])).rows[0]!;
    expect(run.meta.confirm.redeemed_at).toBeUndefined();
  });

  it("the owner can turn one agent's asking off — autonomy.actions.connection_call: deny — and nothing is raised", async () => {
    const who = `itest-noask-${suffix}`;
    const { call, proxy } = await brainFor(agent(who, { level: "act_within_scope", actions: { connection_call: "deny" } }));
    const r = await call({ connection: "github", tool: "comment_issue", arguments: { issue: 1, body: "b" } });
    expect(r.body.error.code).toBe("forbidden");
    expect(r.body.error.message).toContain("autonomy.actions.connection_call is deny");
    expect((await pool.query(`SELECT count(*)::int AS n FROM proposals WHERE source_agent = $1`, [who])).rows[0]!.n).toBe(0);
    expect(proxy.calls).toEqual([]);
  });

  it("a preview whose arguments carry the caller's own bearer is refused before anything is queued", async () => {
    const who = `itest-bearer-${suffix}`;
    const { call } = await brainFor(agent(who));
    const r = await call({ connection: "github", tool: "comment_issue", arguments: { body: "itest-connections-bearer-0123456789" } });
    expect(r.body.error.code).toBe("invalid_request");
    expect((await pool.query(`SELECT count(*)::int AS n FROM proposals WHERE source_agent = $1`, [who])).rows[0]!.n).toBe(0);
  });

  it("rate limits come from runs: dialled calls, and Ask First requests, per caller per connection per hour", async () => {
    const who = `itest-limit-${suffix}`;
    const { call, proxy } = await brainFor(agent(who), { confirmTtlS: 900, callsPerHour: 2, asksPerHour: 1 });
    expect((await call({ connection: "github", tool: "list_issues" })).isError).toBe(false);
    const token = String((await call({ connection: "github", tool: "create_issue", arguments: { t: 1 } })).body.confirm_token);
    expect((await call({ connection: "github", tool: "create_issue", arguments: { t: 1 }, confirm_token: token })).isError).toBe(false);
    const third = await call({ connection: "github", tool: "list_issues" });
    expect(third.body.error.code).toBe("rate_limited");
    expect(third.body.error.message).toContain("METISTRY_CONNECTION_CALLS_PER_HOUR");
    expect((await lastRun(who)).meta).toMatchObject({ refusal: "rate_limited", limit: 2, used: 2 });
    expect(proxy.calls).toHaveLength(2);
    // a preview dials nothing, so it is not limited by the calls it has not made
    expect((await call({ connection: "github", tool: "create_issue", arguments: { t: 2 } })).body.status).toBe("preview");

    expect((await call({ connection: "github", tool: "comment_issue", arguments: { n: 1 } })).body.status).toBe("pending");
    const secondAsk = await call({ connection: "github", tool: "comment_issue", arguments: { n: 2 } });
    expect(secondAsk.body.error.code).toBe("rate_limited");
    expect((await pool.query(`SELECT count(*)::int AS n FROM proposals WHERE source_agent = $1`, [who])).rows[0]!.n).toBe(1);
    // another caller's hour is its own
    const other = await brainFor(agent(`itest-limit2-${suffix}`), { confirmTtlS: 900, callsPerHour: 2, asksPerHour: 1 });
    expect((await other.call({ connection: "github", tool: "list_issues" })).isError).toBe(false);
  });

  it("propose_action never raises a connection call — the payload is the proxy's to build", async () => {
    const who = `itest-propose-${suffix}`;
    const r = await proposeAction(pool, agent(who, { level: "propose" }), undefined, "connection_call", { connection: "github", tool: "comment_issue", args: {}, confirm_token: "A".repeat(43) }, "please");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("invalid_request");
      expect(r.message).toContain("connections_call");
    }
    expect((await pool.query(`SELECT count(*)::int AS n FROM proposals WHERE source_agent = $1`, [who])).rows[0]!.n).toBe(0);
  });
});
