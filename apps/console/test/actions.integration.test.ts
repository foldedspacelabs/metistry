// Executable `action` proposals and the autonomy levels that gate them
// (docs/ops/actions.md — ADOPT 6 of the 2026-09-16 Taskuary review; agent-room
// A3 / plan-refresh OPEN-2).
//
// Misuse first, as everywhere else in this tree, because every interesting
// property here is a refusal: a denied kind refused at the tool with the field
// named; a kind nobody put in the enum; a service that says no leaving the
// proposal pending rather than half-applied; an agent running something on its
// own at a level that does not permit it; a widening arriving anywhere but the
// user's own hand.
//
// The positive case is checked the only way it is worth checking — by looking
// at what the SERVICE did (an inbox row, a moved work row) and at the audit
// trail, not at the response body.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { mintToken } from "@foldedspacelabs/metistry-core";
import { loadTestEnv } from "@foldedspacelabs/metistry-core/test-env";
import { makeServer } from "../src/server.js";
import * as store from "../src/auth-store.js";
import * as agents from "../src/agents.js";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url)); // METISTRY_DB_* only (docs/ops/testing.md)
const policy = { idleDays: 30, maxDays: 365 };

describe.skipIf(!hasDb)("actions + autonomy (integration)", () => {
  let pool: pg.Pool;
  let base: string;
  let server: ReturnType<typeof makeServer>;
  let cookie: string;
  let dir: string;
  const suffix = mintToken(4).toLowerCase().replaceAll(/[^a-z0-9]/g, "").slice(0, 6) || "x";
  const agentId = `act-itest-${suffix}`;
  let agentToken: string;
  let rpcId = 1;

  const json = (method: string, path: string, body?: unknown) =>
    fetch(base + path, {
      method,
      headers: { cookie, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  /**
   * One raw JSON-RPC call at the agent surface, so the wire is what is
   * asserted. Two shapes of refusal come back from `/mcp` and both count: a
   * TOOL result carrying our error envelope, and a JSON-RPC error — which is
   * what an unregistered tool or an argument the tool's own schema refuses
   * produces, before any handler runs.
   */
  const rpc = async (name: string, args: Record<string, unknown>): Promise<{ isError?: boolean; rpcError?: string; body: Record<string, unknown> }> => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${agentToken}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method: "tools/call", params: { name, arguments: args } }),
    });
    const answer = (await res.json()) as { result?: { isError?: boolean; content: { text: string }[] }; error?: { message: string } };
    if (!answer.result) return { isError: true, rpcError: answer.error?.message ?? "rpc error", body: {} };
    const text = answer.result.content[0]!.text.split("\n")[0]!;
    // an unregistered tool, or an argument the tool's own schema refuses, comes
    // back as protocol text rather than our envelope — still a refusal, and
    // still before any handler ran
    if (!text.startsWith("{")) return { isError: true, rpcError: text, body: {} };
    return { ...(answer.result.isError ? { isError: true } : {}), body: JSON.parse(text) };
  };

  const listedTools = async (): Promise<string[]> => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${agentToken}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method: "tools/list", params: {} }),
    });
    return ((await res.json()).result.tools as { name: string }[]).map((t) => t.name);
  };

  /** Set the agent's autonomy the way the owner's own route does. */
  const setLevel = async (autonomy: Record<string, unknown>): Promise<Response> => json("PUT", `/api/agents/${agentId}/autonomy`, autonomy);

  /** One pending `action` proposal with whatever payload the case needs. */
  async function planted(action: unknown): Promise<number> {
    const { rows } = await pool.query(
      `INSERT INTO proposals (ts, kind, source_agent, trust, payload)
       VALUES (now() - interval '1 minute', 'action', $1, 'external', $2::jsonb) RETURNING id`,
      [agentId, JSON.stringify({ title: "planted", action, reason: "test" })],
    );
    return Number(rows[0].id);
  }

  async function newTask(title: string): Promise<number> {
    const { rows } = await pool.query(`INSERT INTO work (title, kind, status) VALUES ($1, 'task', 'open') RETURNING id`, [title]);
    return Number(rows[0].id);
  }

  beforeAll(async () => {
    pool = new pg.Pool({
      host: process.env.METISTRY_DB_HOST ?? "127.0.0.1",
      port: Number(process.env.METISTRY_DB_PORT ?? 5432),
      user: process.env.METISTRY_DB_USER ?? "metistry",
      database: process.env.METISTRY_TEST_DB_NAME ?? "metistry_test",
      password: process.env.METISTRY_DB_PASSWORD,
    });
    dir = await mkdtemp(join(tmpdir(), "metistry-act-"));
    server = makeServer(pool, new QueryStore(pool), {
      origin: "http://127.0.0.1:0",
      inboxDir: join(dir, "inbox"),
      policy,
      secureCookies: false,
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const pkId = `act-${mintToken(8)}`;
    await store.storePasskey(pool, { id: pkId, publicKey: new Uint8Array([1]), signCount: 0, transports: [], origin: "t", label: "act-test" });
    cookie = `metistry_session=${await store.issueSession(pool, pkId, policy)}`;
    ({ token: agentToken } = await agents.createAgent(pool, { id: agentId, display_name: "action itest" }));
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await pool.end();
    await rm(dir, { recursive: true, force: true });
  });

  // ---- the gate ------------------------------------------------------------------

  it("an agent with no level is not even OFFERED the tool — the refusal is the absence", async () => {
    expect(await listedTools()).not.toContain("propose_action");
    // and calling it anyway is the MCP "unknown tool" error, not a half-answer
    const r = await rpc("propose_action", { kind: "capture", args: { note: "n" }, reason: "why" });
    expect(r.isError).toBe(true);
    expect(r.rpcError).toBeDefined(); // the tool does not exist for this credential: refused before a handler, not by one
    expect((await pool.query(`SELECT count(*) AS n FROM proposals WHERE kind = 'action' AND source_agent = $1`, [agentId])).rows[0].n).toBe("0");
  });

  it("deny refuses at the tool, names the field that would permit it, and writes no row", async () => {
    expect((await setLevel({ level: "propose", actions: { dispatch: "deny" } })).status).toBe(200);
    expect(await listedTools()).toContain("propose_action");
    const r = await rpc("propose_action", { kind: "dispatch", args: { work_id: 1, target: "devin", brief: "b" }, reason: "please" });
    expect(r.isError).toBe(true);
    expect(r.body).toMatchObject({ error: { code: "forbidden" } });
    expect(String((r.body.error as { message: string }).message)).toContain(`autonomy.actions.dispatch is deny for ${agentId}`);
    expect((await pool.query(`SELECT count(*) AS n FROM proposals WHERE kind = 'action' AND source_agent = $1`, [agentId])).rows[0].n).toBe("0");
  });

  it("the enum is closed at the tool AND at the decision: an unknown kind is a 400 either way", async () => {
    // the kind enum is in the tool's own schema, so the SDK refuses it before
    // the handler — and an admitted kind with unnamed args is refused by the
    // closed per-kind schema inside it
    for (const kind of ["send_email", "git_push", "shell", "grant"]) {
      const r = await rpc("propose_action", { kind, args: {}, reason: "please" });
      expect(r.isError, kind).toBe(true);
      expect(r.rpcError, kind).toBeDefined();
    }
    const malformed = await rpc("propose_action", { kind: "capture", args: { note: "n", principal: "user" }, reason: "please" });
    expect(malformed.isError).toBe(true);
    expect(malformed.body).toMatchObject({ error: { code: "invalid_request" } });
    // a row planted with a kind nobody validated is refused at allow, not executed best-effort
    const id = await planted({ kind: "send_email", args: { to: "a@b.c" } });
    const res = await json("POST", `/api/proposals/${id}`, { decision: "allow" });
    expect(res.status).toBe(400);
    expect(String((await res.json()).error.message)).toContain("kind must be one of");
    expect((await pool.query(`SELECT decision FROM proposals WHERE id = $1`, [id])).rows[0].decision).toBe("pending");
  });

  it("propose lands PENDING and nothing happens until the user answers", async () => {
    // counted for THIS suite's agent, never the whole table: sibling files
    // write their own inbox rows into the shared scratch db while this runs,
    // and a global count is their race, not this test's property
    const captured = async () => (await pool.query(`SELECT count(*) AS n FROM inbox WHERE source_agent = $1`, [agentId])).rows[0].n;
    const before = await captured();
    const r = await rpc("propose_action", { kind: "capture", args: { note: "a thought worth keeping" }, reason: "it came up twice" });
    expect(r.isError).toBeUndefined();
    expect(r.body).toMatchObject({ status: "pending", action: "capture" });
    const row = (await pool.query(`SELECT kind, decision, source_agent, trust, payload FROM proposals WHERE id = $1`, [r.body.proposal_id])).rows[0];
    expect(row).toMatchObject({ kind: "action", decision: "pending", source_agent: agentId, trust: "external" });
    expect(row.payload.action).toEqual({ kind: "capture", args: { note: "a thought worth keeping" } });
    expect(row.payload.title).toBe("capture a note"); // deterministic, from core — the queue title is not prose
    expect(await captured()).toBe(before); // nothing ran
  });

  // ---- allow executes, through the same service ------------------------------------

  it("allow runs it through the same service the human route uses, records who asked, and audits both", async () => {
    const r = await rpc("propose_action", { kind: "capture", args: { note: "allow me", filename: "allowed.md" }, reason: "worth keeping" });
    const id = Number(r.body.proposal_id);
    const res = await json("POST", `/api/proposals/${id}`, { decision: "allow" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.action).toMatchObject({ kind: "capture" });

    // the SERVICE did it: a real inbox row, with the asking agent as provenance
    const inbox = (await pool.query(`SELECT source, source_agent, note FROM inbox WHERE id = $1`, [body.action.inbox_id])).rows[0];
    expect(inbox).toMatchObject({ source: "action", source_agent: agentId, note: "allow me" });

    // the row is settled and carries the result, so the timeline can say what happened
    const row = (await pool.query(`SELECT decision, payload FROM proposals WHERE id = $1`, [id])).rows[0];
    expect(row.decision).toBe("allow");
    expect(row.payload.result).toMatchObject({ inbox_id: body.action.inbox_id, by: "user", on_behalf_of: agentId });

    // three audit rows: the execution, the action's own triage row naming who
    // asked, and the ordinary triage verb every decision writes
    const runs = await pool.query(`SELECT kind, tool, ok, meta FROM runs WHERE meta->>'proposal' = $1 ORDER BY id`, [String(id)]);
    expect(runs.rows.map((x) => `${x.kind}/${x.tool}`)).toEqual(["action/action:capture", "triage/action:capture", "triage/allow"]);
    expect(runs.rows.every((x) => x.ok === true)).toBe(true);
    expect(runs.rows.filter((x) => x.meta.on_behalf_of === agentId)).toHaveLength(2);
  });

  it("a service that refuses leaves the proposal PENDING with the error — never half-applied", async () => {
    const id = await planted({ kind: "task_update", args: { work_id: 999_999_999, patch: { status: "blocked" } } });
    const res = await json("POST", `/api/proposals/${id}`, { decision: "allow" });
    expect(res.status).toBe(404);
    const row = (await pool.query(`SELECT decision, decided_at, payload FROM proposals WHERE id = $1`, [id])).rows[0];
    expect(row.decision).toBe("pending");
    expect(row.decided_at).toBeNull();
    expect(row.payload.error).toMatchObject({ code: "not_found" });
    expect(row.payload.result).toBeUndefined();
    // the refusal is a runs row too: a safety mechanism that leaves no trace is not visible
    const runs = await pool.query(`SELECT kind, ok FROM runs WHERE meta->>'proposal' = $1 ORDER BY id`, [String(id)]);
    expect(runs.rows.every((x) => x.ok === false)).toBe(true);
    // and it can still be answered once the world changes — or put down
    expect((await json("POST", `/api/proposals/${id}`, { decision: "skip" })).status).toBe(200);
  });

  it("task_update goes through the board's own arm, with the board's own refusal sentence", async () => {
    const work = await newTask("act itest board");
    const r = await rpc("propose_action", { kind: "task_update", args: { work_id: work, patch: { owner: "crew:researcher" } }, reason: "they own this area" });
    const id = Number(r.body.proposal_id);
    // the proposal is linked to the row it is about, so staleness and the room join it
    expect(Number((await pool.query(`SELECT work_id FROM proposals WHERE id = $1`, [id])).rows[0].work_id)).toBe(work);
    expect((await json("POST", `/api/proposals/${id}`, { decision: "allow" })).status).toBe(200);
    const task = (await pool.query(`SELECT owner, history FROM work WHERE id = $1`, [work])).rows[0];
    expect(task.owner).toBe("crew:researcher");
    // the history says the user did it, and the note says on whose behalf
    const last = task.history.at(-1);
    expect(last.agent).toBe("user");
    expect(String(last.note)).toContain(`asked by ${agentId}`);
  });

  // ---- auto-execution --------------------------------------------------------------

  it("act_within_scope executes on emit, decides the row `auto`, and NEVER puts it in the queue", async () => {
    expect((await setLevel({ level: "act_within_scope" })).status).toBe(200);
    const work = await newTask("act itest auto");
    const r = await rpc("propose_action", { kind: "task_update", args: { work_id: work, patch: { title: "renamed by an agent" } }, reason: "the old title was wrong" });
    expect(r.isError).toBeUndefined();
    expect(r.body).toMatchObject({ status: "executed" });
    expect((await pool.query(`SELECT title FROM work WHERE id = $1`, [work])).rows[0].title).toBe("renamed by an agent");
    const row = (await pool.query(`SELECT decision, decided_at, payload FROM proposals WHERE id = $1`, [r.body.proposal_id])).rows[0];
    expect(row.decision).toBe("auto"); // not `allow`: nobody decided it
    expect(row.decided_at).not.toBeNull();
    expect(row.payload.result).toMatchObject({ by: "auto", on_behalf_of: agentId });
    // and it is not in Needs You — an answered question must not ask again
    const pending = await json("GET", "/api/proposals");
    expect((await pending.json()).proposals.map((p: { id: number }) => p.id)).not.toContain(Number(r.body.proposal_id));
  });

  it("dispatch stays human even at act_within_scope: off-machine is not something a level buys", async () => {
    const work = await newTask("act itest dispatch");
    const r = await rpc("propose_action", { kind: "dispatch", args: { work_id: work, target: "github-issues", brief: "have a look" }, reason: "needs a machine" });
    expect(r.body).toMatchObject({ status: "pending" });
    expect((await pool.query(`SELECT external_ref FROM work WHERE id = $1`, [work])).rows[0].external_ref).toBeNull();
  });

  // ---- widening --------------------------------------------------------------------

  it("a widening is admitted only through the user's own route, and is recorded and alerted", async () => {
    await setLevel({}); // back to nothing
    const before = (await pool.query(`SELECT count(*) AS n FROM runs WHERE kind = 'agent_admin' AND tool = 'autonomy_widened'`)).rows[0].n;

    // the store refuses a widening from any caller that does not say it is the owner's hand
    await expect(agents.setAutonomy(pool, agentId, { level: "act_within_scope" })).rejects.toMatchObject({ code: "forbidden" });
    expect((await pool.query(`SELECT autonomy FROM agents WHERE id = $1`, [agentId])).rows[0].autonomy).toEqual({});

    // …and a NARROWING from the same caller is fine, which is the point of the asymmetry
    await expect(agents.setAutonomy(pool, agentId, { max_open_bundles: 1 })).resolves.toMatchObject({ ok: true, widened: [] });

    // through the console as the user, it lands — and says what it raised
    const res = await setLevel({ max_open_bundles: 1, level: "propose" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.widened).toContain("level observe → propose");
    expect(body.actions).toMatchObject({ dispatch: "propose", capture: "propose" });

    const runs = await pool.query(`SELECT meta FROM runs WHERE kind = 'agent_admin' AND tool = 'autonomy_widened' AND meta->>'agent' = $1`, [agentId]);
    expect(runs.rows.length).toBeGreaterThan(0);
    expect(Number((await pool.query(`SELECT count(*) AS n FROM runs WHERE kind = 'agent_admin' AND tool = 'autonomy_widened'`)).rows[0].n)).toBeGreaterThan(Number(before));
    const alert = await pool.query(`SELECT text FROM outbound_messages WHERE kind = 'alert' AND text LIKE $1 ORDER BY id DESC LIMIT 1`, [`agent ${agentId} was given more room:%`]);
    expect(alert.rows).toHaveLength(1);

    // a narrowing raises neither: quiet is correct when the bar went DOWN
    const narrow = await setLevel({ level: "observe" });
    expect((await narrow.json()).widened).toBeUndefined();
  });

  it("refuses a record it cannot name: an unknown key, an unknown kind, an unknown mode", async () => {
    for (const bad of [{ sudo: true }, { level: "god" }, { actions: { send_email: "allow" } }, { actions: { capture: "sometimes" } }, { actions: "all" }]) {
      const res = await setLevel(bad as Record<string, unknown>);
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(String((await res.json()).error.message).length).toBeGreaterThan(10); // the field is named, never "invalid request"
    }
  });
});
