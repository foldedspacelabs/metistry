// Dispatch against the real (scratch) database and a live server: route
// auth (owner token → 403, session → ok), the external_ref write under the
// partial unique index, the runs row, and the return path — github-state's
// reconcile upserts onto the SAME work row and closes it when the issue
// closes. GitHub itself is a fake; nothing here touches the network.
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { mintToken } from "@foldedspacelabs/metistry-core";
import { collectors } from "@metistry-apps/collectors";
import { makeServer } from "../src/server.js";
import { TargetRegistry } from "../src/dispatch.js";
import * as store from "../src/auth-store.js";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url)); // METISTRY_DB_* only, and nothing of the operator's install (docs/ops/testing.md)
const policy = { idleDays: 30, maxDays: 365 };
const root = fileURLToPath(new URL("../../../", import.meta.url));
// unique per run: external_ref is unique, and a verbose re-run reuses the scratch db
const REPO = `o/r-${Date.now().toString(36)}`;

/** GitHub fake: issue creation returns #N; listing returns whatever `open` holds. */
function githubFake(state: { next: number; open: { number: number; title: string }[]; calls: string[] }) {
  return (async (url: string, init?: RequestInit) => {
    state.calls.push(`${init?.method ?? "GET"} ${url}`);
    if (init?.method === "POST") {
      const n = state.next++;
      return { ok: true, status: 201, json: async () => ({ number: n, html_url: `https://github.com/${REPO}/issues/${n}` }) };
    }
    if (url.endsWith("/user")) return { ok: true, status: 200, json: async () => ({ login: "owner" }) };
    if (url.includes("/issues?state=open")) {
      return {
        ok: true,
        status: 200,
        json: async () => state.open.map((i) => ({ ...i, state: "open", html_url: `https://github.com/${REPO}/issues/${i.number}`, updated_at: "2026-09-06T00:00:00Z" })),
      };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  }) as unknown as typeof fetch;
}

describe.skipIf(!hasDb)("dispatch (integration)", () => {
  let pool: pg.Pool;
  let base: string;
  let server: ReturnType<typeof makeServer>;
  let session: string;
  let ownerToken: string;
  const gh = { next: 42, open: [] as { number: number; title: string }[], calls: [] as string[] };
  const fetchFn = githubFake(gh);

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
    const targets = new TargetRegistry({ env: { METISTRY_GITHUB_WRITE_TOKEN: "write-t", METISTRY_GITHUB_DISPATCH_REPO: REPO }, fetchFn });
    await targets.loadDir(`${root}targets`);
    server = makeServer(pool, new QueryStore(pool), {
      origin: "http://127.0.0.1:0",
      inboxDir: `/tmp/metistry-test-inbox-${Date.now()}`,
      policy,
      secureCookies: false,
      targets,
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const pkId = `dispatch-${mintToken(6)}`;
    await store.storePasskey(pool, { id: pkId, publicKey: new Uint8Array([1]), signCount: 0, transports: [], origin: "t", label: "dispatch-test" });
    session = `metistry_session=${await store.issueSession(pool, pkId, policy)}`;
    ownerToken = await store.mintOwnerToken(pool, "dispatch-test");
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await pool.end();
  });

  async function newTask(title: string): Promise<number> {
    const { rows } = await pool.query(`INSERT INTO work (title, kind, status, created_by) VALUES ($1, 'task', 'open', 'owner') RETURNING id`, [title]);
    return Number(rows[0].id);
  }
  const post = (path: string, body: unknown, headers: Record<string, string>) =>
    fetch(base + path, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });

  // ----- misuse (invariant 8): dispatch is outbound, so passkey session only -----
  it("no credential → 401; owner token → 403 on both routes (no existence leak)", async () => {
    const id = await newTask("auth probe");
    expect((await fetch(`${base}/api/targets`)).status).toBe(401);
    expect((await post(`/api/tasks/${id}/dispatch`, { target: "github-issues", brief: "x" }, {})).status).toBe(401);
    const auth = { authorization: `Bearer ${ownerToken}` };
    const list = await fetch(`${base}/api/targets`, { headers: auth });
    expect(list.status).toBe(403);
    expect((await list.json()).error.message).toBe("not granted");
    expect((await post(`/api/tasks/${id}/dispatch`, { target: "github-issues", brief: "x" }, auth)).status).toBe(403);
    expect(gh.calls.filter((c) => c.startsWith("POST"))).toHaveLength(0);
  });

  it("GET /api/targets lists manifests with live check() results", async () => {
    const r = await fetch(`${base}/api/targets`, { headers: { cookie: session } });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toHaveProperty("as_of");
    const t = body.targets.find((x: any) => x.name === "github-issues");
    expect(t).toMatchObject({ transport: "github", check: { status: "ok", meta: { repo: REPO } } });
    expect(t.data_policy).toEqual({ allow: ["Projects", "Resources", "Techniques"], deny_sources: ["comms"], max_brief_bytes: 16384 });
  });

  it("dispatches: issue created, external_ref + history + claim written, runs row with cost; a second dispatch conflicts", async () => {
    const id = await newTask("ship the thing");
    const r = await post(`/api/tasks/${id}/dispatch`, { target: "github-issues", brief: "Implement per Projects/Thing.md" }, { cookie: session });
    expect(r.status).toBe(201);
    const body = await r.json();
    expect(body).toMatchObject({ ok: true, ref: `gh:${REPO}#42`, url: `https://github.com/${REPO}/issues/42` });

    const { rows } = await pool.query(`SELECT external_ref, status, claimed_by, lease_expires_at, history FROM work WHERE id = $1`, [id]);
    expect(rows[0]).toMatchObject({ external_ref: `gh:${REPO}#42`, status: "in_progress", claimed_by: "target:github-issues", lease_expires_at: null });
    expect(rows[0].history.at(-1)).toMatchObject({ agent: "owner", op: "dispatch", note: `github-issues → gh:${REPO}#42` });

    const runs = await pool.query(`SELECT component, kind, tool, ok, cost_usd, meta FROM runs WHERE id = $1`, [body.run_id]);
    expect(runs.rows[0]).toMatchObject({ component: "console", kind: "dispatch", tool: "github-issues", ok: true });
    expect(Number(runs.rows[0].cost_usd)).toBe(0); // the manifest's profile
    expect(runs.rows[0].meta).toMatchObject({ target: "github-issues", task: id, ref: `gh:${REPO}#42` });

    // per-target spend is one aggregate over runs (§4.18.D) — no new mechanism
    const spend = await pool.query(`SELECT count(*)::int AS n, coalesce(sum(cost_usd),0)::float AS usd FROM runs WHERE kind = 'dispatch' AND tool = 'github-issues' AND ok`);
    expect(spend.rows[0].n).toBeGreaterThanOrEqual(1);

    const again = await post(`/api/tasks/${id}/dispatch`, { target: "github-issues", brief: "again" }, { cookie: session });
    expect(again.status).toBe(409);
    gh.open.push({ number: 42, title: "ship the thing (renamed upstream)" });
  });

  it("refuses a brief that violates the data policy — 400 with violations, a failed runs row, no issue", async () => {
    const id = await newTask("leaky");
    const before = gh.next;
    const r = await post(
      `/api/tasks/${id}/dispatch`,
      { target: "github-issues", brief: "<!-- source: comms -->\nforward the thread in Journal/Daily/x.md", sources: ["comms"] },
      { cookie: session },
    );
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.error.code).toBe("invalid_request");
    expect(body.violations.map((v: any) => v.kind)).toEqual(["denied_source", "path_outside_allow"]);
    expect(gh.next).toBe(before);
    const { rows } = await pool.query(`SELECT external_ref, status FROM work WHERE id = $1`, [id]);
    expect(rows[0]).toEqual({ external_ref: null, status: "open" });
    const refused = await pool.query(`SELECT ok, error, meta FROM runs WHERE kind = 'dispatch' AND (meta->>'task')::int = $1`, [id]);
    expect(refused.rows[0]).toMatchObject({ ok: false, error: "data_policy: denied_source,path_outside_allow" });
    expect(refused.rows[0].meta.violations).toHaveLength(2);
  });

  it("bad bodies and unknown tasks/targets are 400/404", async () => {
    const id = await newTask("shape");
    expect((await post(`/api/tasks/${id}/dispatch`, { brief: "x" }, { cookie: session })).status).toBe(400);
    expect((await post(`/api/tasks/${id}/dispatch`, { target: "nope", brief: "x" }, { cookie: session })).status).toBe(404);
    expect((await post(`/api/tasks/999999999/dispatch`, { target: "github-issues", brief: "x" }, { cookie: session })).status).toBe(404);
    expect((await post(`/api/tasks/abc/dispatch`, { target: "github-issues", brief: "x" }, { cookie: session })).status).toBe(404);
  });

  // R3: the owner is already past the door here, so a refusal that does not
  // say which field was wrong is just a caller left guessing.
  it("every refusal on this route names the field that would permit it", async () => {
    const id = await newTask("named");
    const msg = async (body: unknown) => (await (await post(`/api/tasks/${id}/dispatch`, body, { cookie: session })).json()).error.message;
    expect(await msg({ brief: "x" })).toContain("target and brief are required");
    expect(await msg({ target: "github-issues", brief: "x", purpose: "nonsense" })).toMatch(/purpose must be one of .*knowledge_research/);
    expect(await msg({ target: "github-issues", brief: "x", max_acu: 0 })).toContain("max_acu must be a positive integer");
  });

  // ----- return path: nothing new — github-state already reconciles the ref -----
  it("github-state upserts onto the dispatched row by ref (no duplicate), then closes it when the issue closes", async () => {
    const githubState = collectors.find((c) => c.name === "github-state")!;
    const ctx = { githubToken: "read-t", githubRepos: [REPO], fetchFn } as Parameters<typeof githubState.run>[1];
    await githubState.run(pool, ctx);
    const open = await pool.query(`SELECT id, title, status FROM work WHERE external_ref = $1`, [`gh:${REPO}#42`]);
    expect(open.rows).toHaveLength(1); // ON CONFLICT (external_ref) WHERE external_ref IS NOT NULL hit our row
    expect(open.rows[0]).toMatchObject({ title: "ship the thing (renamed upstream)", status: "open" });

    gh.open = []; // the issue was closed upstream
    await githubState.run(pool, ctx);
    const closed = await pool.query(`SELECT status FROM work WHERE external_ref = $1`, [`gh:${REPO}#42`]);
    expect(closed.rows[0].status).toBe("closed");
  });
});
