// The five SAM adopts that land in the console (S1, S2, S3, S4, S5 —
// docs/plan-refresh-2026-09-13.md §1, docs/research/2026-09-13-google-sam-review.md).
// Misuse first throughout: the interesting property of every one of these
// is what it REFUSES.
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { testDb } from "@foldedspacelabs/metistry-core/test-env";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { mintToken, qualifyAgentId } from "@foldedspacelabs/metistry-core";
import { makeServer } from "../src/server.js";
import * as store from "../src/auth-store.js";
import * as agents from "../src/agents.js";
import { capabilitiesOf } from "../src/identity.js";
import { exportLine, parseExportParams } from "../src/runs-export.js";

try {
  for (const line of readFileSync(new URL("../../../.env", import.meta.url), "utf8").split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m && m[1] && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {}

const hasDb = !!process.env.METISTRY_DB_PASSWORD;
const policy = { idleDays: 30, maxDays: 365 };
const INSTANCE_ID = "8b6a3a2e-1c4d-4f7a-9b2e-0d1c2b3a4e5f";
const PEER_ID = "0a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d";

// ---- S1: what may be advertised, before sign-in (pure) ----------------------------

describe("S1 capabilities (pure)", () => {
  it("advertises only the groups this console actually has wired", () => {
    expect(capabilitiesOf({ hasKnowledge: false, hasArtifacts: false, queryCount: 0, targetCount: 0 })).toEqual(["capture", "tasks"]);
    expect(capabilitiesOf({ hasKnowledge: true, hasArtifacts: true, queryCount: 11, targetCount: 2 })).toEqual([
      "artifacts", "capture", "dispatch", "knowledge", "queries", "tasks",
    ]);
    // a query store with nothing loaded does not advertise `queries`; no targets, no `dispatch`
    expect(capabilitiesOf({ hasKnowledge: true, hasArtifacts: false, queryCount: 0, targetCount: 0 })).toEqual(["capture", "knowledge", "tasks"]);
  });

  it("is coarse: no count, no tool name, and the same order every time", () => {
    const a = capabilitiesOf({ hasKnowledge: true, hasArtifacts: true, queryCount: 99, targetCount: 7 });
    const b = capabilitiesOf({ hasKnowledge: true, hasArtifacts: true, queryCount: 1, targetCount: 1 });
    expect(a).toEqual(b); // the COUNT changed and the advertisement did not
    for (const c of a) expect(c).not.toMatch(/_/); // knowledge_read / queries_run are tool names, never advertised
  });
});

// ---- S5: what the export route will accept (pure) ---------------------------------

describe("S5 export params (pure, misuse)", () => {
  it("refuses a `since` this server could not have minted — never a silent full export", () => {
    for (const bad of ["yesterday", "2026-09-01", "1757556000", "2026-09-01T00:00:00Z|abc", "'; DROP TABLE runs; --", "2026-09-01T00:00:00Z|99999999999999"]) {
      const r = parseExportParams(new URLSearchParams({ since: bad }));
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.field).toBe("since");
    }
  });

  it("accepts a cursor, and a bare timestamp as its `|0` form", () => {
    const withId = parseExportParams(new URLSearchParams({ since: "2026-09-11 02:18:47.001+00|42" }));
    expect(withId.ok && withId.params).toMatchObject({ since_ts: "2026-09-11 02:18:47.001+00", since_id: 42 });
    const bare = parseExportParams(new URLSearchParams({ since: "2026-09-11T02:18:47Z" }));
    expect(bare.ok && bare.params).toMatchObject({ since_ts: "2026-09-11T02:18:47Z", since_id: 0 });
  });

  it("refuses a component that is not a component name, and a limit that is not a positive integer", () => {
    for (const bad of ["Console", "con sole", "console;--", "a".repeat(80)]) {
      const r = parseExportParams(new URLSearchParams({ component: bad }));
      expect(r.ok, bad).toBe(false);
    }
    for (const bad of ["0", "-1", "1.5", "all"]) {
      const r = parseExportParams(new URLSearchParams({ limit: bad }));
      expect(r.ok, bad).toBe(false);
    }
    expect(parseExportParams(new URLSearchParams()).ok).toBe(true); // no params = the whole ledger
  });

  it("a line carries the instance and the QUALIFIED agent (S3), with core's redaction applied", () => {
    const line = exportLine(
      { id: 7, ts: "2026-09-16T00:00:00Z", component: "console", kind: "capture", ok: true, meta: { agent: "cursor", api_key: "sk-live-xyz", nested: { token: "t" } }, cursor: "c|7" },
      INSTANCE_ID,
    );
    expect(line).toMatchObject({ instance_id: INSTANCE_ID, id: 7, source_agent: qualifyAgentId("cursor", INSTANCE_ID), cursor: "c|7" });
    expect(JSON.stringify(line)).not.toContain("sk-live-xyz");
    expect(JSON.stringify(line)).not.toContain('"t"');
  });

  it("no instance_id (a console with no identity.yaml) leaves the bare name — the documented mixed period, never an invented id", () => {
    const line = exportLine({ id: 7, meta: { agent: "cursor" }, cursor: "c|7" }, undefined);
    expect(line.source_agent).toBe("cursor");
    expect(line.instance_id).toBeUndefined();
  });

  it("`user` and `owner` are principals, not agents: no qualified id is invented for them", () => {
    expect(exportLine({ id: 1, meta: { principal: "owner" }, cursor: "c|1" }, INSTANCE_ID).source_agent).toBeUndefined();
    expect(exportLine({ id: 2, meta: { principal: "user" }, cursor: "c|2" }, INSTANCE_ID).source_agent).toBeUndefined();
    expect(exportLine({ id: 3, meta: {}, cursor: "c|3" }, INSTANCE_ID).source_agent).toBeUndefined();
  });
});

// ---- the live server -------------------------------------------------------------

describe.skipIf(!hasDb)("SAM adopts (integration)", () => {
  let pool: pg.Pool;
  let base: string;
  let server: ReturnType<typeof makeServer>;
  let cookie: string;
  let dir: string;
  const suffix = mintToken(4).toLowerCase().replaceAll(/[^a-z0-9]/g, "").slice(0, 6) || "x";
  const localId = `sam-local-${suffix}`;
  const remoteId = `sam-remote-${suffix}`;
  let remoteToken = "";
  let localToken = "";

  const json = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(base + path, {
      method,
      headers: { cookie, "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
    dir = await mkdtemp(join(tmpdir(), "metistry-sam-"));
    const queries = new QueryStore(pool);
    await queries.loadDir(new URL("../../../seed/queries", import.meta.url).pathname);
    server = makeServer(pool, queries, {
      origin: "http://127.0.0.1:0",
      inboxDir: join(dir, "inbox"),
      policy,
      secureCookies: false,
      identity: { instance_id: INSTANCE_ID, name: "Test Instance", icon: "🦉" },
      version: "0.0.0-test",
      instancesFiles: join(dir, "instances.yaml"),
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const pkId = `sam-${mintToken(8)}`;
    await store.storePasskey(pool, { id: pkId, publicKey: new Uint8Array([1]), signCount: 0, transports: [], origin: "t", label: "sam-test" });
    cookie = `metistry_session=${await store.issueSession(pool, pkId, policy)}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await pool.end();
    await rm(dir, { recursive: true, force: true });
  });

  // ---- S1 -------------------------------------------------------------------------

  it("S1: GET /api/identity is public and carries coarse capabilities — and no inventory", async () => {
    const res = await fetch(`${base}/api/identity`); // no cookie, no bearer: the ONE public read
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ instance_id: INSTANCE_ID, name: "Test Instance", icon: "🦉", version: "0.0.0-test" });
    expect(Array.isArray(body.capabilities)).toBe(true);
    expect(body.capabilities).toContain("capture");
    expect(body.capabilities).toContain("tasks");
    expect(body.capabilities).toContain("queries"); // the seed queries are loaded above
    expect(body.capabilities).not.toContain("dispatch"); // no targets configured on this server
    // nothing that would be an inventory: no counts, no tool names, no origins
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/knowledge_read|queries_run|capture_note|tools/);
    expect(Object.keys(body).sort()).toEqual(["api_version", "as_of", "capabilities", "icon", "instance_id", "name", "version"]);
  });

  it("S1: the full tool list is NOT public — /mcp still demands an agent token", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
  });

  // ---- S2 -------------------------------------------------------------------------

  it("S2 (misuse): a pending remote token is refused EXACTLY as an unknown token is", async () => {
    const r = await json("POST", "/api/agents", { id: remoteId, display_name: "Remote Tool", kind: "external", remote: true });
    expect(r.status).toBe(201);
    const body = await r.json();
    remoteToken = body.token;
    expect(body.pending).toBe(true);
    expect(typeof body.proposal_id).toBe("number"); // a Needs You item was raised at enrol time

    // the principal source refuses it outright
    expect(await agents.authenticateAgent(pool, { headers: { authorization: `Bearer ${remoteToken}` } })).toBeNull();

    // and at the doors: byte-identical to what a token that never existed gets
    const unknown = mintToken(32);
    for (const [method, path, body_] of [
      ["POST", "/capture", JSON.stringify({ note: "hello" })],
      ["POST", "/mcp", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })],
    ] as const) {
      const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
      const pendingRes = await fetch(base + path, { method, headers: { ...headers, authorization: `Bearer ${remoteToken}` }, body: body_ });
      const unknownRes = await fetch(base + path, { method, headers: { ...headers, authorization: `Bearer ${unknown}` }, body: body_ });
      expect(pendingRes.status, path).toBe(401);
      expect(unknownRes.status, path).toBe(401);
      expect(await pendingRes.text(), path).toBe(await unknownRes.text());
    }

    // it did not even leak through last_seen_at
    const { rows } = await pool.query(`SELECT last_seen_at, remote, approved_at FROM agents WHERE id = $1`, [remoteId]);
    expect(rows[0]).toMatchObject({ last_seen_at: null, remote: true, approved_at: null });
  });

  it("S2: a LOCAL (loopback) tool is immediate — the gate is remoteness, not agent-ness", async () => {
    const r = await json("POST", "/api/agents", { id: localId, display_name: "Local Tool", kind: "external" });
    expect(r.status).toBe(201);
    const body = await r.json();
    localToken = body.token;
    expect(body.pending).toBe(false);
    expect(await agents.authenticateAgent(pool, { headers: { authorization: `Bearer ${localToken}` } })).toMatchObject({ id: localId });
  });

  it("S2 (misuse): `remote` must be a boolean, and an internal row can never be remote", async () => {
    expect((await json("POST", "/api/agents", { id: `x-${suffix}`, display_name: "x", remote: "yes" })).status).toBe(400);
    expect((await json("POST", "/api/agents", { id: `y-${suffix}`, display_name: "y", kind: "internal", remote: true })).status).toBe(400);
  });

  it("S2: approving is the owner's — an agent token cannot approve itself, and approve is idempotent", async () => {
    // the agent's own (pending) token is 401; the local agent's live token is the uniform 403 every agent gets off its surface
    const asPending = await fetch(`${base}/api/agents/${remoteId}/approve`, { method: "POST", headers: { authorization: `Bearer ${remoteToken}` } });
    expect(asPending.status).toBe(401);
    const asAgent = await fetch(`${base}/api/agents/${remoteId}/approve`, { method: "POST", headers: { authorization: `Bearer ${localToken}` } });
    expect(asAgent.status).toBe(403);
    // still refused
    expect(await agents.authenticateAgent(pool, { headers: { authorization: `Bearer ${remoteToken}` } })).toBeNull();

    const ok = await json("POST", `/api/agents/${remoteId}/approve`);
    expect(ok.status).toBe(200);
    expect((await ok.json()).approved).toBe(true);
    // the same token now authenticates, with the grants it always had
    expect(await agents.authenticateAgent(pool, { headers: { authorization: `Bearer ${remoteToken}` } })).toMatchObject({ id: remoteId, kind: "external" });
    // idempotent, and unknown ids are 404 not 500
    expect((await json("POST", `/api/agents/${remoteId}/approve`)).status).toBe(200);
    expect((await json("POST", `/api/agents/nobody-${suffix}/approve`)).status).toBe(404);
    // approving something that was never remote has nothing to approve
    expect((await json("POST", `/api/agents/${localId}/approve`)).status).toBe(404);

    // the enrolment item was settled by the approval, not left in the queue
    const props = await pool.query(`SELECT decision FROM proposals WHERE payload->'enroll'->>'agent' = $1`, [remoteId]);
    expect(props.rows).toEqual([{ decision: "approve" }]);
    const audit = await pool.query(`SELECT ok FROM runs WHERE kind='agent_admin' AND meta->>'agent'=$1 AND meta->>'op'='approve'`, [remoteId]);
    expect(audit.rows.length).toBeGreaterThanOrEqual(1);
  });

  it("S2: answering the Needs You item does the same thing the route does — `deny` revokes", async () => {
    const id = `sam-deny-${suffix}`;
    const minted = await (await json("POST", "/api/agents", { id, display_name: "Denied Tool", remote: true })).json();
    expect(minted.pending).toBe(true);
    // the queue renders it as a `decision` with its own two options
    const queue = await (await json("GET", "/api/proposals")).json();
    const item = queue.proposals.find((p: any) => String(p.id) === String(minted.proposal_id)); // pg hands bigint ids back as strings
    expect(item).toMatchObject({ kind: "decision", source_agent: id });
    expect(item.payload.options).toEqual(["approve", "deny"]);

    // an option that is not one of ITS options is refused, from the stored row
    expect((await json("POST", `/api/proposals/${minted.proposal_id}`, { decision: "allow" })).status).toBe(400);

    const answered = await json("POST", `/api/proposals/${minted.proposal_id}`, { decision: "deny" });
    expect(answered.status).toBe(200);
    expect((await answered.json()).enrolled).toEqual({ agent: id, approved: false });
    const { rows } = await pool.query(`SELECT revoked_at IS NOT NULL AS revoked FROM agents WHERE id = $1`, [id]);
    expect(rows[0]).toEqual({ revoked: true });
    expect(await agents.authenticateAgent(pool, { headers: { authorization: `Bearer ${minted.token}` } })).toBeNull();
  });

  it("S2: the registry reports pending, and never a token or a hash", async () => {
    const list = await (await json("GET", "/api/agents")).json();
    const remote = list.agents.find((a: any) => a.id === remoteId);
    expect(remote).toMatchObject({ remote: true, pending: false });
    expect(remote.approved_at).not.toBeNull();
    const local = list.agents.find((a: any) => a.id === localId);
    expect(local).toMatchObject({ remote: false, pending: false });
    expect(JSON.stringify(list)).not.toContain("token_hash");
  });

  // ---- S4 -------------------------------------------------------------------------

  it("S4 (misuse): GET /api/instances is the owner's, never an agent's", async () => {
    for (const token of [localToken, remoteToken]) {
      const r = await fetch(`${base}/api/instances`, { headers: { authorization: `Bearer ${token}` } });
      expect(r.status).toBe(403);
    }
    expect((await fetch(`${base}/api/instances`)).status).toBe(401);
  });

  it("S4: serves the instance repo's instances.yaml; an empty registry is not an error", async () => {
    const empty = await json("GET", "/api/instances");
    expect(empty.status).toBe(200);
    expect((await empty.json()).instances).toEqual([]);

    await writeFile(
      join(dir, "instances.yaml"),
      `instances:\n  - instance_id: "${PEER_ID}"\n    name: Second\n    origin: https://second.example.com\n    capabilities: [knowledge, capture]\n`,
    );
    const r = await json("GET", "/api/instances");
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.instances).toEqual([
      { instance_id: PEER_ID, name: "Second", origin: "https://second.example.com", capabilities: ["knowledge", "capture"], resources: [] },
    ]);
  });

  it("S4 (misuse): an invalid registry is a refusal that names the field, never a half-read one", async () => {
    await writeFile(join(dir, "instances.yaml"), `instances:\n  - instance_id: nope\n    name: Bad\n    origin: https://x.example\n`);
    const r = await json("GET", "/api/instances");
    expect(r.status).toBe(400);
    expect((await r.json()).error.message).toMatch(/instance_id/);
    await rm(join(dir, "instances.yaml"), { force: true });
  });

  // ---- S5 -------------------------------------------------------------------------

  it("S5 (misuse): the export is the owner's, and a bad cursor is a 400 not a full dump", async () => {
    for (const token of [localToken, remoteToken]) {
      expect((await fetch(`${base}/api/runs/export`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(403);
    }
    expect((await fetch(`${base}/api/runs/export`)).status).toBe(401);
    const bad = await json("GET", "/api/runs/export?since=yesterday");
    expect(bad.status).toBe(400);
    expect(await bad.text()).not.toContain('"component"'); // no rows leaked with the refusal
  });

  it("S5: a console whose query store has no runs_export refuses with a STATUS, not a stream that dies", async () => {
    const bare = makeServer(pool, new QueryStore(pool), { origin: "http://127.0.0.1:0", inboxDir: join(dir, "inbox"), policy, secureCookies: false });
    await new Promise<void>((r) => bare.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(bare.address() as AddressInfo).port}/api/runs/export`;
    const r = await fetch(url, { headers: { cookie } });
    expect(r.status).toBe(503);
    expect((await r.json()).error.message).toMatch(/runs_export/);
    await new Promise<void>((done) => bare.close(() => done()));
  });

  it("S5: NDJSON, oldest first, instance-qualified, resumable by its own cursor", async () => {
    const component = `sam-export-${suffix}`;
    for (const n of [1, 2, 3]) {
      await pool.query(`INSERT INTO runs (component, kind, tool, ok, meta, started_at, finished_at) VALUES ($1, 'tool', $2, true, $3, now(), now())`, [
        component, `t${n}`, JSON.stringify({ agent: remoteId, api_key: `secret-${n}` }),
      ]);
    }
    const res = await json("GET", `/api/runs/export?component=${component}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-ndjson");
    const text = await res.text();
    const lines = text.trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    const rows = lines.map((l) => JSON.parse(l));
    expect(rows.map((r) => r.tool)).toEqual(["t1", "t2", "t3"]); // oldest first
    for (const r of rows) {
      expect(r.instance_id).toBe(INSTANCE_ID);
      expect(r.source_agent).toBe(qualifyAgentId(remoteId, INSTANCE_ID)); // S3 at the boundary
      expect(r.component).toBe(component);
      expect(typeof r.cursor).toBe("string");
    }
    expect(text).not.toMatch(/secret-\d/); // core's redaction, applied to meta

    // the cursor resumes exactly where the last line stopped
    const resumed = await json("GET", `/api/runs/export?component=${component}&since=${encodeURIComponent(rows[0].cursor)}`);
    expect((await resumed.text()).trimEnd().split("\n").map((l) => JSON.parse(l).tool)).toEqual(["t2", "t3"]);
    const end = await json("GET", `/api/runs/export?component=${component}&since=${encodeURIComponent(rows[2].cursor)}`);
    expect(await end.text()).toBe("");

    // --limit stops early; --until bounds the far end
    const one = await json("GET", `/api/runs/export?component=${component}&limit=1`);
    expect((await one.text()).trimEnd().split("\n")).toHaveLength(1);
    const none = await json("GET", `/api/runs/export?component=${component}&until=2000-01-01T00:00:00Z`);
    expect(await none.text()).toBe("");

    // the export is itself a run (an audit export that is not audited is a hole)
    // four exports ran above; the FIRST one is the full ledger — pin it, or the assertion depends on row order
    const audit = await pool.query(`SELECT ok, meta->>'lines' AS lines FROM runs WHERE kind='export' AND tool='runs' AND meta->>'component'=$1 ORDER BY id ASC LIMIT 1`, [component]);
    expect(audit.rows[0]).toMatchObject({ ok: true, lines: "3" });
  });

  it("S5: paging is invisible — a page boundary does not drop or repeat a row", async () => {
    const component = `sam-page-${suffix}`;
    for (let n = 0; n < 7; n++) {
      await pool.query(`INSERT INTO runs (component, kind, tool, ok, meta, started_at, finished_at) VALUES ($1, 'tool', $2, true, '{}', now(), now())`, [component, `p${n}`]);
    }
    // the same rows, whatever the page size the route happens to use
    const res = await json("GET", `/api/runs/export?component=${component}`);
    const tools = (await res.text()).trimEnd().split("\n").map((l) => JSON.parse(l).tool);
    expect(tools).toEqual(["p0", "p1", "p2", "p3", "p4", "p5", "p6"]);
    expect(new Set(tools).size).toBe(7);
  });
});
