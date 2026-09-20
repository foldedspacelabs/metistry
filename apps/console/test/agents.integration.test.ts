// External-agent registry: misuse tests (CRIT-7 two token classes, §4.11
// grants attach server-side, §4.19 identity from the credential) against
// the real scratch database and a live server. Skipped without a db.
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { mintToken, tokenHash } from "@foldedspacelabs/metistry-core";
import { makeServer } from "../src/server.js";
import * as store from "../src/auth-store.js";
import * as agents from "../src/agents.js";
import { run as inboxDrain } from "../../../collectors/inbox-drain/run.js";
import { loadTestEnv } from "@foldedspacelabs/metistry-core/test-env";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url)); // METISTRY_DB_* only, and nothing of the operator's install (docs/ops/testing.md)
const policy = { idleDays: 30, maxDays: 365 };

describe("agent grants validation (pure)", () => {
  it("accepts the three tiers with TitleCase vault prefixes", () => {
    expect(agents.validateGrants({ tier: "none" })).toEqual({ tier: "none", areas: [] });
    expect(agents.validateGrants({ tier: "index", areas: [] })).toEqual({ tier: "index", areas: [] });
    expect(agents.validateGrants({ tier: "areas", areas: [" Areas/Fsl ", "Projects/Drey Dev", "Areas/Fsl"] }))
      .toEqual({ tier: "areas", areas: ["Areas/Fsl", "Projects/Drey Dev"] });
  });

  it("accepts an optional `queries` boolean (mcp-brain's queries_list/queries_run grant, a separate axis from tier), default omitted (false)", () => {
    expect(agents.validateGrants({ tier: "none" })).toEqual({ tier: "none", areas: [] }); // default: no `queries` key at all
    expect(agents.validateGrants({ tier: "none", queries: false })).toEqual({ tier: "none", areas: [] });
    expect(agents.validateGrants({ tier: "none", queries: true })).toEqual({ tier: "none", areas: [], queries: true });
    expect(agents.validateGrants({ tier: "areas", areas: ["Areas/Fsl"], queries: true })).toEqual({ tier: "areas", areas: ["Areas/Fsl"], queries: true });
    expect(() => agents.validateGrants({ tier: "none", queries: "yes" })).toThrow(agents.AgentError);
  });

  it("rejects lowercase roots, the machinery, traversal, and the bare vault", () => {
    // `.metistry/` is unspellable here: an area starts with an uppercase letter
    for (const bad of ["areas/Fsl", "Areas/fsl", "inbox/", "/Areas", "/", "Areas/../secrets", "Areas/Fsl/", "../Areas", ".metistry/queries"]) {
      expect(() => agents.validateGrants({ tier: "areas", areas: [bad] }), bad).toThrow(agents.AgentError);
      expect(() => agents.validateGrants({ tier: "areas", areas: [bad] }, { kind: "external" }), bad).toThrow(agents.AgentError);
    }
    expect(() => agents.validateGrants({ tier: "admin" })).toThrow(agents.AgentError);
    expect(() => agents.validateGrants({ tier: "none", areas: ["Areas/Fsl"] })).toThrow(agents.AgentError); // areas only with tier=areas
    expect(() => agents.validateGrants({ tier: "areas", areas: [] })).toThrow(agents.AgentError);
    expect(() => agents.validateGrants({ tier: "areas", areas: "Areas/Fsl" })).toThrow(agents.AgentError);
  });

  it("the bare vault (`/`) is admitted for kind=internal only, normalized, and still refused everything else", () => {
    // internal: the whole vault is spelled `/` — there is no directory name to say any more
    expect(agents.validateGrants({ tier: "areas", areas: ["/"] }, { kind: "internal" })).toEqual({ tier: "areas", areas: ["/"] });
    expect(agents.validateGrants({ tier: "areas", areas: [" / ", "/", "Areas/Fsl"] }, { kind: "internal" })).toEqual({ tier: "areas", areas: ["/", "Areas/Fsl"] });
    expect(agents.ASSISTANT_DEFAULT_AREAS).toEqual(["/"]);
    // internal is not a blank cheque: the other rules hold
    for (const bad of ["//", "./", "areas", "Areas/../x", "inbox/", ".metistry/"]) {
      expect(() => agents.validateGrants({ tier: "areas", areas: [bad] }, { kind: "internal" }), bad).toThrow(agents.AgentError);
    }
    // external (explicit or default): never
    expect(() => agents.validateGrants({ tier: "areas", areas: ["/"] }, { kind: "external" })).toThrow(/TitleCase vault prefix/);
    expect(() => agents.validateGrants({ tier: "areas", areas: ["/"] })).toThrow(agents.AgentError);
  });

  // The widening an approved access request applies (ruled 2026-09-19). Pure,
  // so the rule is readable without a server: what it adds, what it refuses to
  // add twice, and the axis it never touches.
  it("widenedGrants adds exactly the requested prefix, never `queries`, and never an area already covered", () => {
    expect(agents.widenedGrants({ tier: "none", areas: [] }, "Areas/Fsl")).toEqual({ tier: "areas", areas: ["Areas/Fsl"] });
    expect(agents.widenedGrants({ tier: "index", areas: [] }, "Areas/Fsl")).toEqual({ tier: "areas", areas: ["Areas/Fsl"] });
    expect(agents.widenedGrants({ tier: "areas", areas: ["Areas/Fsl"] }, "Projects/Drey")).toEqual({ tier: "areas", areas: ["Areas/Fsl", "Projects/Drey"] });
    // already covered by a prefix it holds: nothing to add
    expect(agents.widenedGrants({ tier: "areas", areas: ["Areas/Fsl"] }, "Areas/Fsl")).toEqual({ tier: "areas", areas: ["Areas/Fsl"] });
    expect(agents.widenedGrants({ tier: "areas", areas: ["Areas/Fsl"] }, "Areas/Fsl/Deeper")).toEqual({ tier: "areas", areas: ["Areas/Fsl"] });
    // `queries` is a separate axis: carried across, never granted
    expect(agents.widenedGrants({ tier: "index", areas: [], queries: true }, "Areas/Fsl")).toEqual({ tier: "areas", areas: ["Areas/Fsl"], queries: true });
    expect(agents.widenedGrants({ tier: "index", areas: [] }, "Areas/Fsl")).not.toHaveProperty("queries");
    // whatever it produces is what the grants validator would admit anyway
    expect(agents.validateGrants(agents.widenedGrants({ tier: "none", areas: [] }, "Areas/Fsl"))).toEqual({ tier: "areas", areas: ["Areas/Fsl"] });
  });

  it("accessArea reads the area off a payload and re-validates it — a row is data, not a decision", () => {
    expect(agents.accessArea({ area: "Areas/Fsl" })).toBe("Areas/Fsl");
    for (const payload of [{ area: "areas/fsl" }, { area: "../etc" }, { area: "/" }, { area: ".metistry/state" }, { area: "Artifacts/X" }, { area: 7 }, {}, null, "Areas/Fsl"]) {
      expect(agents.accessArea(payload), JSON.stringify(payload)).toBeUndefined();
    }
  });

  it("projects are slugs", () => {
    expect(agents.validateProjects(["drey", "fsl-2026", "drey"])).toEqual(["drey", "fsl-2026"]);
    expect(() => agents.validateProjects(["Drey"])).toThrow(agents.AgentError);
    expect(() => agents.validateProjects("drey")).toThrow(agents.AgentError);
  });
});

describe.skipIf(!hasDb)("agent registry (integration)", () => {
  let pool: pg.Pool;
  let base: string;
  let server: ReturnType<typeof makeServer>;
  let cookie: string;
  let ownerToken: string;
  const suffix = mintToken(4).toLowerCase().replaceAll(/[^a-z0-9]/g, "").slice(0, 6) || "x";
  const agentId = `itest-${suffix}`;
  let agentToken: string;

  const json = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(base + path, {
      method,
      headers: { cookie, "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  beforeAll(async () => {
    pool = new pg.Pool({
      host: process.env.METISTRY_DB_HOST ?? "127.0.0.1",
      port: Number(process.env.METISTRY_DB_PORT ?? 5432),
      user: process.env.METISTRY_DB_USER ?? "metistry",
      database: process.env.METISTRY_TEST_DB_NAME ?? "metistry_test", // scratch db (ops/scripts/test-db.sh)
      password: process.env.METISTRY_DB_PASSWORD,
    });
    server = makeServer(pool, new QueryStore(pool), {
      origin: "http://127.0.0.1:0",
      inboxDir: `/tmp/metistry-test-inbox-agents-${Date.now()}`,
      policy,
      secureCookies: false,
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const pkId = `agents-${mintToken(8)}`;
    await store.storePasskey(pool, { id: pkId, publicKey: new Uint8Array([1]), signCount: 0, transports: [], origin: "t", label: "agents-test" });
    cookie = `metistry_session=${await store.issueSession(pool, pkId, policy)}`;
    ownerToken = await store.mintOwnerToken(pool, "agents-test");
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await pool.end();
  });

  it("mint → authenticate round trip; the list never carries a hash; the mint is audited", async () => {
    expect((await json("POST", "/api/agents", { id: "Bad Id", display_name: "x" })).status).toBe(400);
    expect((await json("POST", "/api/agents", { id: agentId })).status).toBe(400); // display_name required
    const r = await json("POST", "/api/agents", { id: agentId, display_name: "<b>itest</b> agent" });
    expect(r.status).toBe(201);
    const body = await r.json();
    expect(body.id).toBe(agentId);
    expect(typeof body.token).toBe("string");
    agentToken = body.token;
    expect((await json("POST", "/api/agents", { id: agentId, display_name: "dup" })).status).toBe(409);

    const principal = await agents.authenticateAgent(pool, { headers: { authorization: `Bearer ${agentToken}` } });
    // `autonomy` rides the principal like grants do (docs/ops/actions.md): server-side, from the row, empty until the owner sets a level
    expect(principal).toEqual({ id: agentId, kind: "external", grants: { tier: "none", areas: [] }, projects: [], autonomy: {} });
    expect(await agents.authenticateAgent(pool, { headers: { authorization: `Bearer ${mintToken()}` } })).toBeNull();
    expect(await agents.authenticateAgent(pool, { headers: {} })).toBeNull();

    const list = await (await json("GET", "/api/agents")).json();
    const mine = list.agents.find((a: any) => a.id === agentId);
    expect(mine).toMatchObject({ display_name: "<b>itest</b> agent", kind: "external", revoked: false });
    expect(mine.last_seen_at).not.toBeNull(); // authenticate bumped it
    expect(JSON.stringify(list)).not.toContain("token"); // no hash, no token, ever
    const audit = await pool.query(`SELECT ok FROM runs WHERE component='console' AND kind='agent_admin' AND meta->>'agent'=$1 AND meta->>'op'='mint'`, [agentId]);
    expect(audit.rows).toEqual([{ ok: true }]);
  });

  it("agent token: capture works and records provenance; everything else is a uniform 403", async () => {
    const auth = { authorization: `Bearer ${agentToken}` };
    const cap = await fetch(`${base}/capture`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ note: `finding from ${agentId}` }),
    });
    expect(cap.status).toBe(201);
    const { id } = await cap.json();
    const inbox = await pool.query(`SELECT source, source_agent FROM inbox WHERE id = $1`, [id]);
    expect(inbox.rows[0]).toEqual({ source: "http", source_agent: agentId });

    // the drained proposal carries the agent as source_agent at external trust (§4.19)
    await pool.query(`UPDATE inbox SET status = 'classified' WHERE status = 'new' AND id <> $1`, [id]); // other suites' rows: keep this pass small
    await inboxDrain(pool);
    const prop = await pool.query(`SELECT source_agent, trust FROM proposals WHERE payload->>'inbox_id' = $1::text`, [String(id)]);
    expect(prop.rows).toEqual([{ source_agent: agentId, trust: "external" }]);

    for (const [method, path] of [
      ["GET", "/api/agents"],
      ["GET", "/api/proposals"],
      ["GET", "/api/devices"],
      ["GET", "/api/status"],
      ["GET", "/api/q/open_work"],
      ["POST", "/message"],
      ["POST", `/api/agents/${agentId}/rotate`],
      ["GET", "/nope"],
    ] as const) {
      const r = await fetch(base + path, { method, headers: { ...auth, "content-type": "application/json" }, body: method === "POST" ? "{}" : undefined });
      expect(r.status, `${method} ${path}`).toBe(403);
      expect(await r.json()).toEqual({ error: { code: "forbidden", message: "not granted" } });
    }
  });

  // P2 of docs/research/2026-09-19-grants-and-access-simplified.md §2.3: the
  // registry stores three kinds, the principal now carries all three, and the
  // third one (`crew`) brings a toolset with it. Misuse first: what a caller
  // can do to make itself something else is exactly nothing.
  it("takes `kind` from the ROW and from nowhere else: not the body, not a header, not a tool argument", async () => {
    const auth = { authorization: `Bearer ${agentToken}` };
    // a body naming a kind — the route that mints agents refuses `crew`
    // outright: a crew's row comes from a manifest in a protected path, never
    // from an API call
    const minted = await json("POST", "/api/agents", { id: `${agentId}-crew`, display_name: "not a crew", kind: "crew" });
    expect(minted.status).toBe(400);
    expect((await minted.json()).error.message).toContain("external | internal");
    // headers claiming one, on a real external bearer
    const spoofed = await agents.authenticateAgent(pool, {
      headers: { ...auth, "x-agent-kind": "crew", "x-crew-uses": "rooms,tasks" } as Record<string, string>,
    }, () => ({ uses: ["rooms", "tasks"], manifest: "agents/itest/impostor.md" }));
    // the lookup is consulted for a CREW row and nothing else, so an external
    // bearer comes back with no toolset however loudly it asks for one
    expect(spoofed).toEqual({ id: agentId, kind: "external", grants: { tier: "none", areas: [] }, projects: [], autonomy: {} });
    expect(spoofed).not.toHaveProperty("uses");
  });

  it("a crew row authenticates as `crew`, carrying the toolset the console resolved for it — and nothing when it cannot", async () => {
    const crewId = `${agentId}-c`;
    const crewToken = mintToken(32);
    await pool.query(`INSERT INTO agents (id, display_name, kind, token_hash, grants, grant_source) VALUES ($1, $2, 'crew', $3, $4::jsonb, 'manifest')`, [
      crewId, "itest crew", tokenHash(crewToken), JSON.stringify({ tier: "areas", areas: ["Areas/Fsl"] }),
    ]);
    const header = { headers: { authorization: `Bearer ${crewToken}` } };
    const withManifest = await agents.authenticateAgent(pool, header, (id) => (id === crewId ? { uses: ["knowledge"], manifest: `agents/itest/${crewId}.md` } : undefined));
    expect(withManifest).toMatchObject({ id: crewId, kind: "crew", uses: ["knowledge"], manifest: `agents/itest/${crewId}.md` });
    // no loaded manifest, or no crew registry at all: the empty toolset, never
    // the benefit of the doubt
    expect(await agents.authenticateAgent(pool, header, () => undefined)).toMatchObject({ kind: "crew", uses: [] });
    expect(await agents.authenticateAgent(pool, header)).toMatchObject({ kind: "crew", uses: [] });
    await pool.query(`DELETE FROM agents WHERE id = $1`, [crewId]);
  });

  it("the column refuses a fourth kind, so a role nobody ruled on cannot arrive by INSERT (migration 0025)", async () => {
    await expect(
      pool.query(`INSERT INTO agents (id, display_name, kind, token_hash) VALUES ($1, 'wizard', 'wizard', $2)`, [`${agentId}-w`, tokenHash(mintToken(32))]),
    ).rejects.toMatchObject({ code: "23514" }); // check_violation
    // and the same for the source column, whose three values are the three
    // places a row's grants can come from
    await expect(
      pool.query(`INSERT INTO agents (id, display_name, kind, token_hash, grant_source) VALUES ($1, 'x', 'external', $2, 'vibes')`, [`${agentId}-v`, tokenHash(mintToken(32))]),
    ).rejects.toMatchObject({ code: "23514" });
    expect((await pool.query(`SELECT grant_source FROM agents WHERE id = $1`, [agentId])).rows[0]).toEqual({ grant_source: "registry" }); // the owner's hand, recorded
  });

  it("owner token on the registry is FORBIDDEN (management is session-only)", async () => {
    const h = { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" };
    expect((await fetch(`${base}/api/agents`, { headers: h })).status).toBe(403);
    expect((await fetch(`${base}/api/agents`, { method: "POST", headers: h, body: "{}" })).status).toBe(403);
    expect((await fetch(`${base}/api/agents/${agentId}/grants`, { method: "PUT", headers: h, body: "{}" })).status).toBe(403);
    expect((await fetch(`${base}/api/agents/${agentId}/revoke`, { method: "POST", headers: h })).status).toBe(403);
  });

  it("grants attach to the token server-side: validation, then the principal reflects them", async () => {
    // R3: the 400 carries the validator's own message, so `metistry connect
    // <tool> --areas knowledge/…` tells the owner what to fix rather than "400"
    const lower = await json("PUT", `/api/agents/${agentId}/grants`, { tier: "areas", areas: ["knowledge/Areas/Fsl"] });
    expect(lower.status).toBe(400);
    expect((await lower.json()).error).toMatchObject({ code: "invalid_request", message: expect.stringContaining("TitleCase vault prefix") });
    const noAreas = await json("PUT", `/api/agents/${agentId}/grants`, { tier: "areas", areas: [] });
    expect((await noAreas.json()).error.message).toContain("tier=areas needs at least one area");
    expect((await json("PUT", `/api/agents/${agentId}/grants`, { tier: "areas", areas: ["knowledge/Areas/Fsl"] })).status).toBe(400);
    expect((await json("PUT", `/api/agents/${agentId}/grants`, { tier: "areas", areas: ["inbox/secrets"] })).status).toBe(400);
    expect((await json("PUT", `/api/agents/${agentId}/grants`, { tier: "root" })).status).toBe(400);
    expect((await json("PUT", `/api/agents/nobody-${suffix}/grants`, { tier: "index" })).status).toBe(404);
    const ok = await json("PUT", `/api/agents/${agentId}/grants`, { tier: "areas", areas: ["Areas/Fsl"] });
    expect(ok.status).toBe(200);
    expect((await json("PUT", `/api/agents/${agentId}/projects`, { projects: ["Drey"] })).status).toBe(400);
    expect((await json("PUT", `/api/agents/${agentId}/projects`, { projects: ["drey"] })).status).toBe(200);
    // wrong verb for the op falls to 404, not a handler
    expect((await json("POST", `/api/agents/${agentId}/grants`, { tier: "none" })).status).toBe(404);

    const principal = await agents.authenticateAgent(pool, { headers: { authorization: `Bearer ${agentToken}` } });
    expect(principal).toEqual({ id: agentId, kind: "external", grants: { tier: "areas", areas: ["Areas/Fsl"] }, projects: ["drey"], autonomy: {} });
    // rejected payloads never reach the audit log; the accepted ones do
    const audit = await pool.query(`SELECT meta->>'op' AS op FROM runs WHERE kind='agent_admin' AND meta->>'agent'=$1 ORDER BY id`, [agentId]);
    expect(audit.rows.map((r) => r.op)).toEqual(["mint", "grant", "projects"]);
  });

  // Ruled 2026-09-19 (D). The refusal is about AGENTS: every read path an
  // agent has refuses `Artifacts/`, so a grant of it would read in the
  // registry like access and give none. It says nothing about the owner,
  // whose own `Artifacts/` are served by `/api/artifacts` (asserted end to
  // end over a real vault in artifacts.integration.test.ts) and by Finder
  // and git besides.
  it("an agent cannot be granted `Artifacts/` — the grant would be inert, and an inert grant reads like a real one", async () => {
    const before = (await agents.authenticateAgent(pool, { headers: { authorization: `Bearer ${agentToken}` } }))?.grants;
    for (const areas of [["Artifacts"], ["Artifacts/Reports"], ["Areas/Fsl", "Artifacts/Reports"]]) {
      const r = await json("PUT", `/api/agents/${agentId}/grants`, { tier: "areas", areas });
      expect(r.status, areas.join(",")).toBe(400);
      expect((await r.json()).error.message, areas.join(",")).toContain("TitleCase vault prefix");
    }
    expect((await agents.authenticateAgent(pool, { headers: { authorization: `Bearer ${agentToken}` } }))?.grants).toEqual(before); // not one of them landed
  });

  it("grants: `queries` (mcp-brain's queries_list/queries_run access) round-trips through the same route, rejects non-booleans", async () => {
    expect((await json("PUT", `/api/agents/${agentId}/grants`, { tier: "none", queries: "yes" })).status).toBe(400);
    const ok = await json("PUT", `/api/agents/${agentId}/grants`, { tier: "areas", areas: ["Areas/Fsl"], queries: true });
    expect(ok.status).toBe(200);
    expect((await ok.json()).grants).toEqual({ tier: "areas", areas: ["Areas/Fsl"], queries: true });
    const principal = await agents.authenticateAgent(pool, { headers: { authorization: `Bearer ${agentToken}` } });
    expect(principal?.grants).toEqual({ tier: "areas", areas: ["Areas/Fsl"], queries: true });
    // turning it back off drops the key entirely (default shape, byte for byte with a never-granted agent)
    const off = await json("PUT", `/api/agents/${agentId}/grants`, { tier: "areas", areas: ["Areas/Fsl"] });
    expect((await off.json()).grants).toEqual({ tier: "areas", areas: ["Areas/Fsl"] });
  });

  it("ensureInternalAgent: idempotent upsert from configuration — same token keeps the hash, projects re-sync, revocation clears, kind is internal", async () => {
    const id = `itest-internal-${suffix}`;
    const token = mintToken(32);
    const hashOf = async () => (await pool.query(`SELECT token_hash, kind, grants, projects, revoked_at FROM agents WHERE id = $1`, [id])).rows[0];

    expect(await agents.ensureInternalAgent(pool, id, { token })).toEqual({ id, created: true });
    const first = await hashOf();
    expect(first.kind).toBe("internal");
    expect(first.grants).toEqual({ tier: "areas", areas: [...agents.ASSISTANT_DEFAULT_AREAS] }); // the widest valid read
    expect(first.projects).toEqual([]); // = every project, by mcp-brain's internal rule

    // the token authenticates like any agent's, and the principal carries the kind
    const principal = await agents.authenticateAgent(pool, { headers: { authorization: `Bearer ${token}` } });
    expect(principal).toEqual({ id, kind: "internal", grants: { tier: "areas", areas: [...agents.ASSISTANT_DEFAULT_AREAS] }, projects: [], autonomy: {} });

    // second call, same token, new projects: hash unchanged, projects replaced, not "created"
    expect(await agents.ensureInternalAgent(pool, id, { token, projects: ["drey", "drey"] })).toEqual({ id, created: false });
    const second = await hashOf();
    expect(second.token_hash).toBe(first.token_hash);
    expect(second.projects).toEqual(["drey"]);
    expect((await agents.authenticateAgent(pool, { headers: { authorization: `Bearer ${token}` } }))?.projects).toEqual(["drey"]);

    // a rotated token in the environment re-keys the row; the old token dies
    const rotated = mintToken(32);
    await agents.ensureInternalAgent(pool, id, { token: rotated });
    expect(await agents.authenticateAgent(pool, { headers: { authorization: `Bearer ${token}` } })).toBeNull();
    expect((await agents.authenticateAgent(pool, { headers: { authorization: `Bearer ${rotated}` } }))?.id).toBe(id);

    // a UI revoke holds until the configuration says otherwise: ensure clears it (the env var is the switch)
    expect(await agents.revokeAgent(pool, id)).toBe(true);
    expect(await agents.authenticateAgent(pool, { headers: { authorization: `Bearer ${rotated}` } })).toBeNull();
    await agents.ensureInternalAgent(pool, id, { token: rotated });
    expect((await hashOf()).revoked_at).toBeNull();
    expect((await agents.authenticateAgent(pool, { headers: { authorization: `Bearer ${rotated}` } }))?.kind).toBe("internal");

    // configuration is validated like the management API: bad areas / projects / short tokens never land
    await expect(agents.ensureInternalAgent(pool, id, { token: rotated, projects: ["Drey"] })).rejects.toThrow(agents.AgentError);
    await expect(agents.ensureInternalAgent(pool, id, { token: "short" })).rejects.toThrow(agents.AgentError);
    await expect(agents.ensureInternalAgent(pool, "Bad Id", { token: rotated })).rejects.toThrow(agents.AgentError);
    expect(() => agents.validateGrants({ tier: "areas", areas: ["/"] })).toThrow(agents.AgentError); // "everything" is not an area for an external agent; the internal default is exactly that
    // the list never carries a hash for internal agents either
    const list = await (await json("GET", "/api/agents")).json();
    expect(list.agents.find((a: any) => a.id === id)).toMatchObject({ kind: "internal", revoked: false });
    expect(JSON.stringify(list)).not.toContain(rotated);
    // the management API keys the bare-vault rule on the ROW's kind, never on the request: accepted for this internal row, refused for the external agent
    expect((await json("PUT", `/api/agents/${id}/grants`, { tier: "areas", areas: ["/"] })).status).toBe(200);
    expect((await agents.authenticateAgent(pool, { headers: { authorization: `Bearer ${rotated}` } }))?.grants).toEqual({ tier: "areas", areas: ["/"] });
    expect((await json("PUT", `/api/agents/${agentId}/grants`, { tier: "areas", areas: ["/"] })).status).toBe(400);
    expect((await json("PUT", `/api/agents/${id}/grants`, { tier: "areas", areas: ["knowledge/"] })).status).toBe(400);
  });

  it("rotate invalidates the old token; revoke kills the new one and is audited", async () => {
    const old = agentToken;
    const r = await json("POST", `/api/agents/${agentId}/rotate`);
    expect(r.status).toBe(200);
    const { token } = await r.json();
    expect(token).not.toBe(old);
    expect(await agents.authenticateAgent(pool, { headers: { authorization: `Bearer ${old}` } })).toBeNull();
    expect((await fetch(`${base}/capture`, { method: "POST", headers: { authorization: `Bearer ${old}`, "content-type": "application/json" }, body: "{}" })).status).toBe(401);
    const fresh = await agents.authenticateAgent(pool, { headers: { authorization: `Bearer ${token}` } });
    expect(fresh?.grants.tier).toBe("areas"); // grants survive rotation — they belong to the agent, not the secret

    expect((await json("POST", `/api/agents/${agentId}/revoke`)).status).toBe(200);
    expect((await json("POST", `/api/agents/${agentId}/revoke`)).status).toBe(404); // once
    expect(await agents.authenticateAgent(pool, { headers: { authorization: `Bearer ${token}` } })).toBeNull();
    expect((await json("POST", `/api/agents/${agentId}/rotate`)).status).toBe(404); // dead agents don't get new keys
    expect((await json("PUT", `/api/agents/${agentId}/grants`, { tier: "none" })).status).toBe(404);
    const list = await (await json("GET", "/api/agents")).json();
    expect(list.agents.find((a: any) => a.id === agentId).revoked).toBe(true);
    const audit = await pool.query(`SELECT meta->>'op' AS op, ok FROM runs WHERE kind='agent_admin' AND meta->>'agent'=$1 AND meta->>'op' IN ('rotate','revoke') ORDER BY id`, [agentId]);
    expect(audit.rows).toEqual([{ op: "rotate", ok: true }, { op: "revoke", ok: true }, { op: "revoke", ok: false }, { op: "rotate", ok: false }]);
  });
});
