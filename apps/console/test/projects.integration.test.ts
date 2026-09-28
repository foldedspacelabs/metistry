// Projects (§4.19 rollup, §4.21 controls) through the console: misuse
// first (invariant 8) — the management gate admits a passkey session ONLY;
// then the rollup (members from the registry, a project row made lazily by
// membership), the user's toggle recorded as runs kind project_admin, and
// the agent autonomy route. Skipped without a db.
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { mintToken } from "@foldedspacelabs/metistry-core";
import { makeServer } from "../src/server.js";
import * as store from "../src/auth-store.js";
import * as agents from "../src/agents.js";
import { validateProjectPatch } from "../src/projects.js";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url)); // METISTRY_DB_* only, and nothing of the operator's install (docs/ops/testing.md)
const policy = { idleDays: 30, maxDays: 365 };
const SEED_DIR = fileURLToPath(new URL("../../../seed/queries", import.meta.url));

describe("project patch + autonomy validation (pure)", () => {
  it("accepts the toggle, budget, cap, title; refuses unknown keys, bad modes, out-of-range numbers, and an empty patch", () => {
    expect(validateProjectPatch({ mode: "review" })).toEqual({ mode: "review" });
    expect(validateProjectPatch({ daily_budget_usd: 12.345, max_open_bundles: 5, title: "  Drey  ", area: null })).toEqual({ daily_budget_usd: 12.35, max_open_bundles: 5, title: "Drey", area: null });
    expect(validateProjectPatch({ daily_budget_usd: null })).toEqual({ daily_budget_usd: null });
    for (const bad of [{}, { mode: "off" }, { widen: true }, { daily_budget_usd: -1 }, { daily_budget_usd: "5" }, { max_open_bundles: 1.5 }, { max_open_bundles: 5000 }, { title: "x".repeat(121) }, [], null, "review"]) {
      expect(() => validateProjectPatch(bad), JSON.stringify(bad)).toThrow(agents.AgentError);
    }
  });

  it("grants (T1-13): an agent area grant, validated the same as PUT /api/agents/:id/grants — the bare vault and anything outside the vault's content are refused", () => {
    expect(validateProjectPatch({ grants: { tier: "areas", areas: ["Areas/Fsl"] } })).toEqual({ grants: { tier: "areas", areas: ["Areas/Fsl"] } });
    expect(validateProjectPatch({ grants: { tier: "none" } })).toEqual({ grants: { tier: "none", areas: [] } });
    for (const bad of [
      { grants: { tier: "areas", areas: ["/"] } }, // the bare vault — internal rows only, never a project's
      { grants: { tier: "areas", areas: [".metistry/state"] } }, // machinery — not vault content
      { grants: { tier: "areas", areas: ["Artifacts/Reports"] } }, // artifacts — not vault content
      { grants: { tier: "areas", areas: ["Areas/../Me"] } }, // traversal
      { grants: { tier: "areas", areas: ["areas/fsl"] } }, // wrong case — TitleCase only
      { grants: { tier: "widen" } },
    ]) {
      expect(() => validateProjectPatch(bad), JSON.stringify(bad)).toThrow(agents.AgentError);
    }
  });

  it("autonomy: agent ids (plus `user` in accept_from), a cap 0..1000, no unknown keys — and absent keys stay absent", () => {
    expect(agents.validateAutonomy({})).toEqual({});
    expect(agents.validateAutonomy({ may_dispatch_to: ["qa", "qa"], accept_from: ["user", "alice"], max_open_bundles: 0 })).toEqual({ may_dispatch_to: ["qa"], accept_from: ["user", "alice"], max_open_bundles: 0 });
    expect(agents.validateAutonomy({ may_dispatch_to: [] })).toEqual({ may_dispatch_to: [] });
    for (const bad of [{ may_dispatch_to: "qa" }, { accept_from: ["Bad Id"] }, { max_open_bundles: -1 }, { max_open_bundles: 1001 }, { widen: true }, null, []]) {
      expect(() => agents.validateAutonomy(bad), JSON.stringify(bad)).toThrow(agents.AgentError);
    }
  });
});

describe.skipIf(!hasDb)("projects routes (integration)", () => {
  let pool: pg.Pool;
  let base: string;
  let server: ReturnType<typeof makeServer>;
  let cookie: string;
  let ownerToken: string;
  let agentToken: string;
  const suffix = mintToken(4).toLowerCase().replaceAll(/[^a-z0-9]/g, "").slice(0, 6) || "x";
  const agentId = `itest-proj-${suffix}`;
  const P = `itest-proj-${suffix}`;

  const json = (method: string, path: string, body?: unknown, headers: Record<string, string> = { cookie }) =>
    fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
    const queries = new QueryStore(pool);
    await queries.loadDir(SEED_DIR); // exactly what main.ts does: the rollup is a seed query (invariant 3)
    server = makeServer(pool, queries, { origin: "https://console.test", inboxDir: `/tmp/metistry-test-inbox-proj-${Date.now()}`, policy, secureCookies: false });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const pkId = `proj-${mintToken(8)}`;
    await store.storePasskey(pool, { id: pkId, publicKey: new Uint8Array([1]), signCount: 0, transports: [], origin: "t", label: "proj-test" });
    cookie = `metistry_session=${await store.issueSession(pool, pkId, policy)}`;
    ownerToken = await store.mintOwnerToken(pool, "proj-test");
    ({ token: agentToken } = await agents.createAgent(pool, { id: agentId, display_name: "proj itest" }));
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await pool.end();
  });

  it("management gate: no credential → 401; owner token and agent token → uniform 403 on projects and autonomy routes", async () => {
    for (const [method, path] of [["GET", "/api/projects"], ["PUT", `/api/projects/${P}`], ["PUT", `/api/agents/${agentId}/autonomy`]] as const) {
      const body = method === "PUT" ? { mode: "review" } : undefined;
      expect((await json(method, path, body, {})).status, `${method} ${path} anon`).toBe(401);
      expect((await json(method, path, body, { authorization: `Bearer ${ownerToken}` })).status, `${method} ${path} owner token`).toBe(403);
      expect((await json(method, path, body, { authorization: `Bearer ${agentToken}` })).status, `${method} ${path} agent token`).toBe(403);
    }
  });

  it("membership makes the project row (lazily) and the rollup lists it with its members and defaults", async () => {
    expect((await json("PUT", `/api/agents/${agentId}/projects`, { projects: [P] })).status).toBe(200);
    const r = await json("GET", "/api/projects");
    expect(r.status).toBe(200);
    const { projects } = await r.json();
    const p = projects.find((x: { id: string }) => x.id === P);
    expect(p).toMatchObject({ id: P, mode: "autonomous", daily_budget_usd: null, max_open_bundles: 20, open_tasks: 0, bundles_in_flight: 0, bundles_queued: 0, open_threads: 0, pending_reviews: 0, spend_today_usd: 0, last_mode_change: null, grants: { tier: "none", areas: [] } });
    // members = agentIsMember's rule: this agent, plus any internal agent with no project list (a member of every project) another suite may have made
    expect(p.members).toContain(agentId);
    expect(p.members.filter((m: string) => m.startsWith("itest-proj-"))).toEqual([agentId]);
  });

  it("PUT toggles the kill switch (and budget/cap): the change is a runs row of kind project_admin with the transition, and the rollup shows why", async () => {
    const r = await json("PUT", `/api/projects/${P}`, { mode: "review", daily_budget_usd: 5, max_open_bundles: 2, title: "Itest" });
    expect(r.status).toBe(200);
    expect((await r.json()).project).toMatchObject({ id: P, mode: "review", daily_budget_usd: 5, max_open_bundles: 2, title: "Itest" });
    const runs = await pool.query(`SELECT component, ok, meta FROM runs WHERE kind = 'project_admin' AND meta->>'project' = $1 ORDER BY id`, [P]);
    expect(runs.rows).toHaveLength(1);
    expect(runs.rows[0]).toMatchObject({ component: "console", ok: true, meta: expect.objectContaining({ project: P, principal: "user", from: "autonomous", to: "review", reason: "toggle", changes: expect.objectContaining({ mode: "review", daily_budget_usd: 5 }) }) });
    const { projects } = await (await json("GET", "/api/projects")).json();
    const p = projects.find((x: { id: string }) => x.id === P);
    expect(p).toMatchObject({ mode: "review", daily_budget_usd: 5, max_open_bundles: 2, title: "Itest", last_mode_change: expect.objectContaining({ to: "review", by: "user", reason: "toggle" }) });
    // back to autonomous; a budget-only change records no transition
    expect((await json("PUT", `/api/projects/${P}`, { mode: "autonomous" })).status).toBe(200);
    expect((await json("PUT", `/api/projects/${P}`, { daily_budget_usd: null })).status).toBe(200);
    const again = await pool.query(`SELECT meta->>'to' AS "to" FROM runs WHERE kind = 'project_admin' AND meta->>'project' = $1 ORDER BY id`, [P]);
    expect(again.rows.map((x) => x.to)).toEqual(["review", "autonomous", null]);
    // a PUT on a slug nobody used yet is how a budget lands before the first agent joins
    const fresh = `${P}-new`;
    expect((await json("PUT", `/api/projects/${fresh}`, { daily_budget_usd: 1 })).status).toBe(200);
    expect((await pool.query(`SELECT daily_budget_usd::float8 AS b FROM projects WHERE id = $1`, [fresh])).rows[0]).toEqual({ b: 1 });
    // misuse: bad body, unknown key, non-slug id
    expect((await json("PUT", `/api/projects/${P}`, { mode: "off" })).status).toBe(400);
    expect((await json("PUT", `/api/projects/${P}`, { widen: true })).status).toBe(400);
    expect((await json("PUT", `/api/projects/Not-A-Slug`, { mode: "review" })).status).toBe(404);
    await pool.query(`DELETE FROM projects WHERE id = $1`, [fresh]);
  });

  it("PUT stores the project's own grant (0032) and returns it; a grant outside the vault's content is refused (T1-13's test)", async () => {
    const r = await json("PUT", `/api/projects/${P}`, { grants: { tier: "areas", areas: ["Areas/Fsl"] } });
    expect(r.status).toBe(200);
    expect((await r.json()).project).toMatchObject({ id: P, grants: { tier: "areas", areas: ["Areas/Fsl"] } });
    expect((await pool.query(`SELECT grants FROM projects WHERE id = $1`, [P])).rows[0]).toEqual({ grants: { tier: "areas", areas: ["Areas/Fsl"] } });
    // …and the list serves it beside the rollup (T6-8: *every member gets these*)
    const listed = (await (await json("GET", "/api/projects")).json()).projects.find((x: { id: string }) => x.id === P);
    expect(listed.grants).toEqual({ tier: "areas", areas: ["Areas/Fsl"] });
    // a grant outside the vault's content: machinery, artifacts, and the bare vault (internal rows only) are all refused before anything is written
    for (const areas of [[".metistry/state"], ["Artifacts/Reports"], ["/"]]) {
      const bad = await json("PUT", `/api/projects/${P}`, { grants: { tier: "areas", areas } });
      expect(bad.status, JSON.stringify(areas)).toBe(400);
    }
    expect((await pool.query(`SELECT grants FROM projects WHERE id = $1`, [P])).rows[0]).toEqual({ grants: { tier: "areas", areas: ["Areas/Fsl"] } }); // unchanged by the refused writes
  });

  // T4-7 (D13, screen 13): every member inherits the project's own grant,
  // resolved at the door per request and never written into its row — so
  // leaving the project is the whole of losing it. Asserted where it bites:
  // the principal the door builds, /mcp's own refusals, and the table
  // GET /api/agents draws.
  it("a member inherits its project's grant, marked via project — and **leaving the project removes the inherited reach**", async () => {
    const Q = `${P}-inherit`;
    const member = `${agentId}-member`;
    const { token } = await agents.createAgent(pool, { id: member, display_name: "inherits" });
    const bearer = { authorization: `Bearer ${token}` };
    expect((await json("PUT", `/api/agents/${member}/grants`, { tier: "areas", areas: ["Areas/Own"] })).status).toBe(200);
    expect((await json("PUT", `/api/projects/${Q}`, { grants: { tier: "areas", areas: ["Areas/Shared"], queries: true } })).status).toBe(200);

    let nextId = 1;
    const tool = async (name: string, args: unknown) => {
      const r = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...bearer },
        body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } }),
      });
      expect(r.status).toBe(200);
      const result = (await r.json()).result;
      return { isError: result.isError === true, text: String(result.content[0].text) };
    };
    /** The knowledge door's answer for a page under the project's area: `forbidden` outside the reach, and past the gate `not_found` (no such page in this vault). */
    const refusedForScope = async () => {
      const read = await tool("knowledge_read", { path: "Areas/Shared/plan.md" });
      expect(read.isError).toBe(true);
      const code = JSON.parse(read.text.split("\n")[0]!).error.code;
      expect(["forbidden", "not_found"]).toContain(code);
      return code === "forbidden";
    };
    const principal = () => agents.authenticateAgent(pool, { headers: bearer });
    const lines = async () => {
      const row = (await (await json("GET", "/api/agents")).json()).agents.find((a: { id: string }) => a.id === member);
      return { grants: row.grants, knowledge: row.permissions.find((l: { resource: { kind: string } }) => l.resource.kind === "knowledge")?.read, queries: row.permissions.find((l: { resource: { kind: string } }) => l.resource.kind === "queries") };
    };

    // not a member: the project's grant is not its reach
    expect((await principal())?.grants).toEqual({ tier: "areas", areas: ["Areas/Own"] });
    expect(await refusedForScope()).toBe(true);
    expect((await tool("queries_list", {})).isError).toBe(true);

    // joining is a grant: the union, at the door
    expect((await json("PUT", `/api/agents/${member}/projects`, { projects: [Q] })).status).toBe(200);
    expect((await principal())?.grants).toEqual({ tier: "areas", areas: ["Areas/Own", "Areas/Shared"], queries: true });
    expect(await refusedForScope()).toBe(false);
    expect((await tool("queries_list", {})).isError).toBe(false);
    // …and in the table, where only the inherited lines carry the project; the row's own grant is unchanged
    const joined = await lines();
    expect(joined.grants).toEqual({ tier: "areas", areas: ["Areas/Own"] });
    expect(joined.knowledge).toEqual([
      { key: "Areas/Own", label: "Areas/Own", asks: false, provenance: { kind: "base", source: "registry" } },
      { key: "Areas/Shared", label: "Areas/Shared", asks: false, provenance: { kind: "project", project: Q } },
    ]);
    expect(joined.queries?.read).toEqual([{ key: "named", label: "Named queries", asks: false, provenance: { kind: "project", project: Q } }]);
    expect((await pool.query(`SELECT grants FROM agents WHERE id = $1`, [member])).rows[0].grants).toEqual({ tier: "areas", areas: ["Areas/Own"] }); // never written back

    // the owner narrows the PROJECT: every member narrows with it, on the next request
    expect((await json("PUT", `/api/projects/${Q}`, { grants: { tier: "none" } })).status).toBe(200);
    expect((await principal())?.grants).toEqual({ tier: "areas", areas: ["Areas/Own"] });
    expect((await json("PUT", `/api/projects/${Q}`, { grants: { tier: "areas", areas: ["Areas/Shared"], queries: true } })).status).toBe(200);
    expect(await refusedForScope()).toBe(false);

    // leaving the project removes the inherited reach — the door, /mcp and the table all at once
    expect((await json("PUT", `/api/agents/${member}/projects`, { projects: [] })).status).toBe(200);
    expect((await principal())?.grants).toEqual({ tier: "areas", areas: ["Areas/Own"] });
    expect(await refusedForScope()).toBe(true);
    expect((await tool("queries_list", {})).isError).toBe(true);
    const left = await lines();
    expect(left.knowledge.map((e: { key: string }) => e.key)).toEqual(["Areas/Own"]);
    expect(left.queries).toBeUndefined();
    await pool.query(`DELETE FROM projects WHERE id = $1`, [Q]);
  });

  it("PUT /api/agents/:id/autonomy stores the narrowing (validated, audited) and the registry lists it; a revoked or unknown agent is 404", async () => {
    const r = await json("PUT", `/api/agents/${agentId}/autonomy`, { may_dispatch_to: ["qa"], accept_from: ["user"], max_open_bundles: 2 });
    expect(r.status).toBe(200);
    // the answer carries the RESOLVED action table too (docs/ops/actions.md);
    // with no level every kind propose_action raises is deny, so a §4.21-only
    // change widens nothing; connection_call is Ask First at every level (T4-9)
    expect(await r.json()).toEqual({
      ok: true,
      autonomy: { may_dispatch_to: ["qa"], accept_from: ["user"], max_open_bundles: 2 },
      actions: { dispatch: "deny", task_update: "deny", comment: "deny", capture: "deny", connection_call: "propose" },
    });
    const list = await (await json("GET", "/api/agents")).json();
    expect(list.agents.find((a: { id: string }) => a.id === agentId).autonomy).toEqual({ may_dispatch_to: ["qa"], accept_from: ["user"], max_open_bundles: 2 });
    expect((await json("PUT", `/api/agents/${agentId}/autonomy`, { may_dispatch_to: ["Bad Id"] })).status).toBe(400);
    expect((await json("PUT", `/api/agents/${agentId}/autonomy`, { widen: true })).status).toBe(400);
    expect((await json("PUT", `/api/agents/${agentId}/autonomy`, {})).status).toBe(200); // blank = no narrowing
    const nobody = `${agentId}-nobody`;
    expect((await json("PUT", `/api/agents/${nobody}/autonomy`, {})).status).toBe(404);
    const audit = await pool.query(`SELECT ok, meta->>'agent' AS agent FROM runs WHERE kind = 'agent_admin' AND tool = 'autonomy' AND meta->>'agent' IN ($1, $2) ORDER BY id`, [agentId, nobody]);
    expect(audit.rows).toEqual([{ ok: true, agent: agentId }, { ok: true, agent: agentId }, { ok: false, agent: nobody }]);
  });
});
