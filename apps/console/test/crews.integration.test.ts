// Crews against the real (scratch) database and a live server: registry
// sync is idempotent (a second sync writes nothing and never touches the
// token hash), a changed manifest re-syncs, a removed one revokes, a
// foreign id is never hijacked; agents_delegate over /mcp is the internal
// assistant's alone, refuses a brief outside scope with NO work row, and
// queues a clean one as the durable row the assistant container drains.
// Skipped without a db.
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { mintToken, tokenHash } from "@foldedspacelabs/metistry-core";
import { memoryVault, type MemoryVault } from "@foldedspacelabs/metistry-artifacts";
import { makeServer } from "../src/server.js";
import { TargetRegistry } from "../src/dispatch.js";
import * as agents from "../src/agents.js";
import { CrewRegistry, syncCrews, parseCrewFile } from "../src/crews.js";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url)); // METISTRY_DB_* only, and nothing of the operator's install (docs/ops/testing.md)
const policy = { idleDays: 30, maxDays: 365 };
const root = fileURLToPath(new URL("../../../", import.meta.url));
const suffix = mintToken(4).toLowerCase().replaceAll(/[^a-z0-9]/g, "").slice(0, 6) || "x";
const crewA = `itest-crew-a-${suffix}`;
const crewB = `itest-crew-b-${suffix}`;
const intent = { principal: "user", message: "t" };

/** What the manifest says this crew is for — H8: it has to reach `agents_delegate`'s own definition, not just the registry. */
const DESCRIBED = "Reads the granted notes and reports what it finds";

function crewFile(name: string, patch: Record<string, unknown> = {}): string {
  const fm = { name, type: "agent", area: "itest", model: "haiku", description: DESCRIBED, uses: ["brain-read", "brain-report"], scope: ["Projects"], projects: [], ...patch };
  return `---\n${Object.entries(fm).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n")}\n---\nYou work for {{name}}. Report what you find.\n`;
}

describe.skipIf(!hasDb)("crews (integration)", () => {
  let pool: pg.Pool;
  let base: string;
  let server: ReturnType<typeof makeServer>;
  let vault: MemoryVault;
  let registry: CrewRegistry;
  let externalToken: string;
  let assistantToken: string;
  let nextId = 1;
  const externalId = `itest-ext-${suffix}`;
  // this suite's own internal principal: agents_delegate gates on kind=internal, not on the id, and the
  // shared INTERNAL_ASSISTANT_ID row is upserted by other suites running in parallel (a token race)
  const assistantId = `itest-asst-${suffix}`;
  // the owner on this Mac, for the registry's reads (GET /api/agents, …/definition)
  const localOwnerToken = mintToken();
  const owner = (path: string) => fetch(`${base}${path}`, { headers: { authorization: `Bearer ${localOwnerToken}` } });

  const rpc = (method: string, params: unknown, token: string) =>
    fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
    });
  const call = async (name: string, args: unknown, token: string) => {
    const r = await rpc("tools/call", { name, arguments: args }, token);
    expect(r.status).toBe(200);
    const result = (await r.json()).result;
    return { isError: result.isError === true, body: JSON.parse(result.content[0].text.split("\n")[0]) };
  };

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
    vault = memoryVault();
    await vault.write(`agents/itest/${crewA}.md`, Buffer.from(crewFile(crewA)), intent);
    await vault.write(`agents/itest/${crewB}.md`, Buffer.from(crewFile(crewB, { projects: ["itest-p"], scope: ["Resources"], autonomy: { max_open_bundles: 2, accept_from: ["user"] } })), intent);
    registry = new CrewRegistry(pool, ["agents"], vault);
    const targets = new TargetRegistry({ env: {} });
    await targets.loadDir(`${root}targets`);
    server = makeServer(pool, new QueryStore(pool), { origin: "http://127.0.0.1:0", inboxDir: `/tmp/metistry-test-inbox-crews-${Date.now()}`, policy, secureCookies: false, targets, crews: registry, localOwner: { token: localOwnerToken, trusted: [] } });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    ({ token: externalToken } = await agents.createAgent(pool, { id: externalId, display_name: "ext" }));
    assistantToken = mintToken(32);
    await agents.ensureInternalAgent(pool, assistantId, { token: assistantToken, display_name: "itest assistant" });
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await pool.query(`DELETE FROM work WHERE owner = ANY($1::text[])`, [[`crew:${crewA}`, `crew:${crewB}`]]);
    await pool.query(`DELETE FROM runs WHERE (kind = 'agent_admin' AND meta->>'agent' = ANY($1::text[])) OR (kind = 'dispatch' AND meta->>'crew' = ANY($1::text[])) OR component = ANY($2::text[])`, [[crewA, crewB, externalId], [assistantId, externalId, crewA, crewB]]);
    await pool.query(`DELETE FROM agents WHERE id = ANY($1::text[])`, [[crewA, crewB, externalId, assistantId]]);
    await pool.end();
  });

  const rowsOf = async () => (await pool.query(`SELECT id, kind, display_name, grants, projects, autonomy, token_hash, revoked_at FROM agents WHERE id = ANY($1::text[]) ORDER BY id`, [[crewA, crewB]])).rows;
  const adminRuns = async () => (await pool.query(`SELECT meta->>'agent' AS agent, meta->>'op' AS op, ok FROM runs WHERE kind = 'agent_admin' AND tool = 'crew_sync' AND meta->>'agent' = ANY($1::text[]) ORDER BY id`, [[crewA, crewB, externalId]])).rows;

  it("first sync registers each manifest as kind=crew with grants from scope (external shape) and projects; audited under agent_admin", async () => {
    const s = await registry.refresh();
    expect(s.registered.sort()).toEqual([crewA, crewB].sort());
    expect(s).toMatchObject({ resynced: [], conflicts: [] });
    const rows = await rowsOf();
    expect(rows.map((r) => r.kind)).toEqual(["crew", "crew"]);
    expect(rows[0]).toMatchObject({ id: crewA, display_name: `${crewA} (crew, itest)`, grants: { tier: "areas", areas: ["Projects"] }, projects: [], autonomy: {}, revoked_at: null });
    expect(rows[1]).toMatchObject({ id: crewB, grants: { tier: "areas", areas: ["Resources"] }, projects: ["itest-p"], autonomy: { max_open_bundles: 2, accept_from: ["user"] } });
    expect(rows.every((r) => /^[0-9a-f]{64}$/.test(r.token_hash))).toBe(true); // a hash of a token nobody holds
    expect((await adminRuns()).filter((r) => r.op === "register").map((r) => r.agent).sort()).toEqual([crewA, crewB].sort());
    // the registry lists them like any agent, minus anything secret
    expect((await agents.listAgents(pool)).filter((a) => a.id === crewA).map((a) => ({ kind: a.kind, grants: a.grants }))).toEqual([{ kind: "crew", grants: { tier: "areas", areas: ["Projects"] } }]);
  });

  it("second sync is a no-op: same rows, same token hashes, no new audit rows", async () => {
    const before = await rowsOf();
    const runsBefore = (await adminRuns()).length;
    const s = await registry.refresh();
    expect(s).toEqual({ registered: [], resynced: [], revoked: [], conflicts: [] });
    expect(await rowsOf()).toEqual(before);
    expect((await adminRuns()).length).toBe(runsBefore);
  });

  // T4-6: a crew is an actor — its definition is its manifest, its compute
  // its `model:`, its permissions the row the door reads, drawn by core.
  it("GET /api/agents draws each crew's permissions, and …/definition serves its manifest, compute and limits (T4-6)", async () => {
    const { agents: rows } = await (await owner("/api/agents")).json();
    const lines = (id: string) => rows.find((a: any) => a.id === id).permissions.map((r: any) => [r.label, r.read.map((e: any) => e.key), r.write.map((e: any) => e.key)]);
    // `uses: [brain-read, brain-report]`: the knowledge group reads its scope; `requests` is asking, which is not a power
    expect(lines(crewA)).toEqual([["Knowledge", ["Projects"], []]]);
    expect(lines(crewB)).toEqual([["Knowledge", ["Resources"], []]]);
    const provenance = rows.find((a: any) => a.id === crewA).permissions[0].read[0].provenance;
    expect(provenance).toEqual({ kind: "base", source: { manifest: `agents/itest/${crewA}.md` } });
    // an internal row is drawn as the assistant: the whole vault, the one writer — and as configuration, never as a grant
    const asst = rows.find((a: any) => a.id === assistantId).permissions;
    expect(asst[0]).toMatchObject({ label: "Knowledge", read: [{ key: "/", label: "The whole vault" }], write: [{ key: "/", label: "The whole vault" }] });
    for (const r of asst) for (const e of [...r.read, ...r.write]) expect(e.provenance, `${r.label} ${e.key}`).toEqual({ kind: "base", source: "environment" });

    const def = await owner(`/api/agents/${crewA}/definition`);
    expect(def.status).toBe(200);
    const body = await def.json();
    const text = crewFile(crewA);
    expect(body).toMatchObject({
      id: crewA,
      definition: {
        kind: "crew",
        area: "itest",
        description: DESCRIBED,
        prompt: "You work for {{name}}. Report what you find.",
        // read through the vault bridge, so the owner's own file, named relative to the instance
        files: [{ path: `agents/itest/${crewA}.md`, origin: "instance", sha256: createHash("sha256").update(text).digest("hex") }],
      },
      // `model: haiku` with no assignments.crews entry: what an unassigned crew always ran on
      compute: { kind: "same_as_assistant" },
      limits: { maxTurns: 12, budgetUsdPerRun: 0.5 },
    });

    // a crew row whose manifest is not loaded is no actor: 404, and no lines
    const orphan = `${crewA}-orphan`;
    await pool.query(`INSERT INTO agents (id, display_name, kind, token_hash, grants, grant_source) VALUES ($1, 'orphan', 'crew', $2, $3::jsonb, 'manifest')`, [orphan, tokenHash(mintToken(32)), JSON.stringify({ tier: "areas", areas: ["Projects"] })]);
    try {
      expect((await owner(`/api/agents/${orphan}/definition`)).status).toBe(404);
      const again = await (await owner("/api/agents")).json();
      expect(again.agents.find((a: any) => a.id === orphan).permissions).toEqual([]);
    } finally {
      await pool.query(`DELETE FROM agents WHERE id = $1`, [orphan]);
    }
  });

  it("a changed manifest re-syncs grants/projects only (hash untouched); a removed one is revoked; a foreign id is a conflict, never overwritten", async () => {
    const before = await rowsOf();
    await vault.write(`agents/itest/${crewA}.md`, Buffer.from(crewFile(crewA, { scope: ["Projects", "Techniques"], projects: ["itest-q"], autonomy: { may_dispatch_to: [crewB] } })), intent);
    await vault.delete(`agents/itest/${crewB}.md`, intent);
    await vault.write(`agents/itest/${externalId}.md`, Buffer.from(crewFile(externalId)), intent); // same slug as the external agent registered above
    const s = await registry.refresh();
    expect(s).toEqual({ registered: [], resynced: [crewA], revoked: [crewB], conflicts: [externalId] });
    const after = await rowsOf();
    expect(after[0]).toMatchObject({ grants: { tier: "areas", areas: ["Projects", "Techniques"] }, projects: ["itest-q"], autonomy: { may_dispatch_to: [crewB] }, token_hash: before[0]!.token_hash, revoked_at: null });
    expect(after[1]!.revoked_at).not.toBeNull();
    const ext = (await pool.query(`SELECT kind, revoked_at FROM agents WHERE id = $1`, [externalId])).rows[0];
    expect(ext).toEqual({ kind: "external", revoked_at: null }); // the external agent's row is exactly as it was
    expect(registry.names()).not.toContain(externalId); // a valid manifest, but not a crew this console can run: dropped, with the reason
    expect(registry.errors.join()).toMatch(new RegExp(`"${externalId}" already belongs to a non-crew registry row`));
    const ops = (await adminRuns()).map((r) => `${r.agent}:${r.op}:${r.ok}`);
    expect(ops).toContain(`${crewA}:resync:true`);
    expect(ops).toContain(`${crewB}:revoke:true`);
    expect(ops).toContain(`${externalId}:conflict:false`);
    // restore B for the dispatch tests
    await vault.delete(`agents/itest/${externalId}.md`, intent);
    await vault.write(`agents/itest/${crewB}.md`, Buffer.from(crewFile(crewB, { projects: ["itest-p"], scope: ["Resources"] })), intent);
    const back = await registry.refresh();
    expect(back.resynced).toEqual([crewB]); // revocation cleared, same hash
    expect((await rowsOf())[1]).toMatchObject({ revoked_at: null, token_hash: before[1]!.token_hash });
  });

  it("agents_delegate: an external agent is told not granted; the assistant's brief outside scope is refused with violations and NO work row", async () => {
    const ext = await call("agents_delegate", { crew: crewA, brief: "read Projects/X.md" }, externalToken);
    expect(ext).toEqual({ isError: true, body: { error: { code: "forbidden", message: expect.stringMatching(/^not granted — `agents_delegate` belongs to the instance assistant alone/) } } });

    const bad = await call("agents_delegate", { crew: crewA, brief: "Compare Projects/X.md with Me/profile.md" }, assistantToken);
    expect(bad.isError).toBe(true);
    expect(bad.body.error.code).toBe("invalid_request");
    expect(bad.body.error.message).toContain("Me/profile.md"); // the assistant sees WHICH path to remove
    expect(bad.body.error.message).toContain("path_outside_allow");
    expect((await pool.query(`SELECT count(*)::int AS n FROM work WHERE owner = $1`, [`crew:${crewA}`])).rows[0].n).toBe(0);
    const refusal = (await pool.query(`SELECT ok, error, meta FROM runs WHERE kind = 'dispatch' AND tool = 'local-crew' AND meta->>'crew' = $1 ORDER BY id DESC LIMIT 1`, [crewA])).rows[0];
    expect(refusal).toMatchObject({ ok: false, error: "data_policy: path_outside_allow" });
    expect(refusal.meta.violations[0]).toMatchObject({ kind: "path_outside_allow", paths: ["Me/profile.md"] });
    // the tool call itself is audited on the assistant, like every tool call
    const toolRun = (await pool.query(`SELECT ok, error FROM runs WHERE component = $1 AND kind = 'tool' AND tool = 'agents_delegate' ORDER BY id DESC LIMIT 1`, [assistantId])).rows[0];
    expect(toolRun).toEqual({ ok: false, error: "invalid_request" });
  });

  it("agents_delegate: a clean brief becomes ONE durable work row (kind task, owner crew:<name>, project NULL, brief + snapshot in meta); idempotent on the key", async () => {
    const brief = "# Summarize the X plan\n\nRead Projects/X.md and report the open questions.";
    const r = await call("agents_delegate", { crew: crewA, brief, task_id: 1, idempotency_key: `itest-${suffix}` }, assistantToken);
    expect(r.isError).toBe(false);
    expect(r.body).toMatchObject({ queued: true, crew: crewA, allow: ["Projects", "Techniques"], deduplicated: false });
    const row = (await pool.query(`SELECT id, kind, status, owner, project, claimed_by, created_by, meta, title FROM work WHERE id = $1`, [r.body.work_id])).rows[0];
    expect(row).toMatchObject({ kind: "task", status: "open", owner: `crew:${crewA}`, project: null, claimed_by: null, created_by: assistantId, title: `[crew:${crewA}] Summarize the X plan` });
    expect(row.meta).toMatchObject({ target: "local-crew", brief, task_id: 1, allow: ["Projects", "Techniques"] });
    expect(row.meta.crew).toMatchObject({ name: crewA, model: "haiku", uses: ["brain-read", "brain-report"], max_turns: 12, budget_usd_per_run: 0.5 });
    expect(row.meta.crew.prompt).toBe("You work for {{name}}. Report what you find.");
    expect(row.meta.brief_sha).toMatch(/^[0-9a-f]{64}$/);
    // the queued row is invisible to the crew's own tasks_* view (project NULL) — it is the runner's, not shared work
    const again = await call("agents_delegate", { crew: crewA, brief, idempotency_key: `itest-${suffix}` }, assistantToken);
    expect(again.body).toMatchObject({ queued: true, work_id: r.body.work_id, deduplicated: true });
    expect((await pool.query(`SELECT count(*)::int AS n FROM work WHERE owner = $1`, [`crew:${crewA}`])).rows[0].n).toBe(1);
    const sent = (await pool.query(`SELECT ok, cost_usd::float8 AS cost_usd, meta FROM runs WHERE kind = 'dispatch' AND tool = 'local-crew' AND (meta->>'work_id')::bigint = $1`, [r.body.work_id])).rows;
    expect(sent[0]).toMatchObject({ ok: true, cost_usd: 0 });
    expect(sent[0].meta).toMatchObject({ crew: crewA, principal: assistantId });
  });

  // H8, 2026-09-17. The assistant saw crew NAMES only, so which crew fits a
  // brief was guesswork the registry corrected by refusal. The `description`
  // was already in the manifest; this is the whole path — vault file →
  // CrewRegistry → the dispatcher's `crews()` → the tool definition served on
  // `/mcp` — held to reaching the field the model fills in.
  it("agents_delegate's tool definition carries each crew's manifest description (H8)", async () => {
    await registry.refresh();
    const r = await rpc("tools/list", {}, assistantToken);
    expect(r.status).toBe(200);
    const tools = (await r.json()).result.tools as Array<{ name: string; inputSchema: { properties?: Record<string, { description?: string }> } }>;
    const crewField = tools.find((t) => t.name === "agents_delegate")?.inputSchema.properties?.crew;
    expect(crewField?.description).toContain(`${crewA} — ${DESCRIBED}`);
    expect(crewField?.description).toContain(`${crewB} — ${DESCRIBED}`);
    expect(crewField?.description).toContain("agents/<area>/<name>.md"); // and it still says what the field IS
  });

  // P2 of docs/research/2026-09-19-grants-and-access-simplified.md §2.2: the
  // crew's own toolset, end to end — vault manifest → CrewRegistry →
  // authenticateAgent → /mcp — with NO client-side allowlist anywhere in the
  // loop (this suite speaks JSON-RPC directly; `apps/assistant`'s tool host,
  // which is where `uses` used to be enforced, is not in the process). The
  // bearer is minted exactly as the drain loop mints one per run.
  it("a crew's `uses` is enforced at the door: a tool its manifest never named is forbidden on /mcp", async () => {
    await registry.refresh();
    const runToken = mintToken(32);
    await pool.query(`UPDATE agents SET token_hash = $2 WHERE id = $1 AND kind = 'crew' AND revoked_at IS NULL`, [crewA, tokenHash(runToken)]);

    // The principal the door builds: the row's OWN kind (no longer collapsed
    // to external) and the toolset resolved from the manifest, server-side.
    const principal = await agents.authenticateAgent(pool, { headers: { authorization: `Bearer ${runToken}` } }, (id) => registry.toolset(id));
    expect(principal).toMatchObject({ id: crewA, kind: "crew", uses: ["brain-read", "brain-report"], manifest: `agents/itest/${crewA}.md` });

    // `capture` and `tasks_list` are the shape §2.2 named: nothing else on
    // this surface gates them, so before P2 the door admitted both and only
    // the caller's filter said no.
    for (const [name, args] of [["capture", { note: "x" }], ["tasks_list", {}]] as const) {
      const r = await call(name, args, runToken);
      expect(r.isError, name).toBe(true);
      expect(r.body.error.code, name).toBe("forbidden");
      expect(r.body.error.message, name).toContain("not in this crew's toolset");
    }
    // A group the manifest DID name is past the gate and answers its own rule.
    const held = await call("knowledge_list", {}, runToken);
    expect(String(held.body.error?.message ?? "")).not.toContain("toolset");
    // The refusal is one `runs` row on the crew's own id, like every other.
    const audit = (await pool.query(`SELECT ok, error FROM runs WHERE component = $1 AND kind = 'tool' AND tool = 'capture' ORDER BY id DESC LIMIT 1`, [crewA])).rows[0];
    expect(audit).toEqual({ ok: false, error: "forbidden" });
    // And nothing in the CALL can widen it: the toolset is the manifest's.
    const spoof = await call("capture", { note: "x", kind: "internal", uses: ["capture"], agent: assistantId }, runToken);
    expect(spoof.body.error.message).toContain("not in this crew's toolset");
    expect((await pool.query(`SELECT count(*)::int AS n FROM inbox WHERE source_agent = $1`, [crewA])).rows[0].n).toBe(0); // the body never ran
  });

  it("unknown crew is not_found for the assistant (naming the registered ones); the parse helper agrees with what was synced", async () => {
    const r = await call("agents_delegate", { crew: "nobody", brief: "x" }, assistantToken);
    expect(r.isError).toBe(true);
    expect(r.body.error).toMatchObject({ code: "not_found", message: expect.stringContaining(crewA) });
    const def = parseCrewFile(crewFile(crewA), "x", { area: "itest", name: crewA });
    expect(def.grants).toEqual({ tier: "areas", areas: ["Projects"] });
  });
});
