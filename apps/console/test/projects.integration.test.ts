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
import { loadTestEnv } from "@foldedspacelabs/metistry-core/test-env";

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
    pool = new pg.Pool({
      host: process.env.METISTRY_DB_HOST ?? "127.0.0.1",
      port: Number(process.env.METISTRY_DB_PORT ?? 5432),
      user: process.env.METISTRY_DB_USER ?? "metistry",
      database: process.env.METISTRY_TEST_DB_NAME ?? "metistry_test",
      password: process.env.METISTRY_DB_PASSWORD,
    });
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
    expect(p).toMatchObject({ id: P, mode: "autonomous", daily_budget_usd: null, max_open_bundles: 20, open_tasks: 0, bundles_in_flight: 0, bundles_queued: 0, open_threads: 0, pending_reviews: 0, spend_today_usd: 0, last_mode_change: null });
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

  it("PUT /api/agents/:id/autonomy stores the narrowing (validated, audited) and the registry lists it; a revoked or unknown agent is 404", async () => {
    const r = await json("PUT", `/api/agents/${agentId}/autonomy`, { may_dispatch_to: ["qa"], accept_from: ["user"], max_open_bundles: 2 });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, autonomy: { may_dispatch_to: ["qa"], accept_from: ["user"], max_open_bundles: 2 } });
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
