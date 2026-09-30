// Targets as connections (T4-11), over real sockets against the scratch
// database (docs/ops/testing.md), reading a scratch instance directory under
// the OS temp dir. An `agent` connection — Devin, GitHub Issues — is listed
// by `GET /api/targets` and dispatched to by `POST /api/tasks/:id/dispatch`
// exactly as a `targets/` manifest is (dispatch unchanged); what changes is
// that its key is a `{{ secret.x }}` reference filled at the connection's
// egress door, for the hosts its *Sent only to* list names, granted to
// `connection:<name>` — never read or put on a request by the console.
//
// U2 for both doors (no new door: they are T4-11's by the route table):
// 401 with no credential, 403 for an agent bearer and the capture owner
// token, the local owner token reaches them. The ticket's own: the key is
// sent only through the door; a brief carrying a reference is refused with
// nothing sent; an ungranted key or an unlisted host sends nothing; the
// type's data policy holds; a connection cannot take the crews' target.
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { mintToken } from "@foldedspacelabs/metistry-core";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";
import { envSecretSource, loadInstanceCatalog } from "@foldedspacelabs/metistry-connections";
import { makeServer } from "../src/server.js";
import { TargetRegistry } from "../src/dispatch.js";
import * as store from "../src/auth-store.js";
import * as agents from "../src/agents.js";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url));
const policy = { idleDays: 30, maxDays: 365 };
const MARK = "itest-agent-connections";
const root = fileURLToPath(new URL("../../../", import.meta.url));
const suffix = mintToken(6).toLowerCase().replaceAll(/[^a-z0-9]/g, "").slice(0, 6) || "x";
// key shapes built at run time, so no scanner mistakes this file for a leak
const DEVIN_KEY = ["cog", "Zq8Rk2Vt7Wm4Xp1Ys6Bn3Cd9Fg5Hj0K", suffix].join("_");
const GH_KEY = ["gh" + "p", "aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0", suffix].join("_");
const REPO = `o/agent-${suffix}`;

interface Sent {
  method: string;
  url: string;
  authorization: string | null;
  body: string;
}

/** Devin and GitHub on one fake: sessions, /v3/self, repos and issues — and a record of everything sent. */
function fakeServices(sent: Sent[]) {
  let issue = 100;
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const headers = new Headers(init.headers);
    const method = init.method ?? "GET";
    sent.push({ method, url, authorization: headers.get("authorization"), body: typeof init.body === "string" ? init.body : "" });
    if (url.endsWith("/v3/self")) return Response.json({ org_id: "org-abc", echoed: headers.get("authorization") });
    if (method === "POST" && url.includes("/sessions")) return Response.json({ session_id: `sess-${suffix}-${sent.length}`, url: `https://app.devin.ai/sessions/${sent.length}` });
    if (method === "POST" && url.endsWith("/issues")) {
      const n = issue++;
      return Response.json({ number: n, html_url: `https://github.com/${REPO}/issues/${n}` }, { status: 201 });
    }
    if (url.includes("/repos/")) return Response.json({ full_name: REPO });
    return Response.json({});
  }) as typeof fetch;
}

const conn = (name: string, provider: string, url: string, secret: string, config: Record<string, string>) =>
  [
    `name: ${name}`,
    "type: agent",
    `provider: ${provider}`,
    "reach:",
    "  http:",
    `    url: ${url}`,
    `    auth: { scheme: bearer, secret: ${secret} }`,
    `secrets: [${secret}]`,
    ...(Object.keys(config).length ? ["config:", ...Object.entries(config).map(([k, v]) => `  ${k}: "${v}"`)] : ["config: {}"]),
    "",
  ].join("\n");

describe.skipIf(!hasDb)("agent connections as targets (T4-11)", () => {
  let pool: pg.Pool;
  let server: ReturnType<typeof makeServer>;
  let base: string;
  let dir: string;
  let session: string;
  let captureToken: string;
  let agentToken: string;
  const localOwnerToken = mintToken();
  const agentId = `itest-agentconn-${suffix}`;
  const passkeyIds: string[] = [];
  const sent: Sent[] = [];
  let secretsYaml: string;
  let targets: TargetRegistry;

  const writeSecrets = (text: string) => writeFile(join(dir, ".metistry/secrets.yaml"), text);

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
    dir = await mkdtemp(join(tmpdir(), "metistry-agent-connections-"));
    await mkdir(join(dir, ".metistry/connections"), { recursive: true });
    await writeFile(join(dir, ".metistry/connections/devin.yaml"), conn("devin", "devin", "https://api.devin.ai", "devin_api_key", { org: "org-abc" }));
    await writeFile(join(dir, ".metistry/connections/github-issues.yaml"), conn("github-issues", "github-issues", "https://api.github.com", "github_write_token", { repo: REPO }));
    // a connection that would take the crews' target name, and one whose GitHub URL points elsewhere
    await writeFile(join(dir, ".metistry/connections/local-crew.yaml"), conn("local-crew", "devin", "https://api.devin.ai", "devin_api_key", { org: "org-abc" }));
    await writeFile(join(dir, ".metistry/connections/gh-elsewhere.yaml"), conn("gh-elsewhere", "github-issues", "https://github.example", "github_write_token", { repo: REPO }));
    secretsYaml = [
      "secrets:",
      "  devin_api_key:",
      "    hosts: [api.devin.ai, mcp.devin.ai]",
      '    grants: { "connection:devin": on, "connection:local-crew": on }',
      "  github_write_token:",
      "    hosts: [api.github.com]",
      '    grants: { "connection:github-issues": on, "connection:gh-elsewhere": on }',
      "",
    ].join("\n");
    await writeSecrets(secretsYaml);

    const env = { METISTRY_SECRET_DEVIN_API_KEY: DEVIN_KEY, METISTRY_SECRET_GITHUB_WRITE_TOKEN: GH_KEY };
    targets = new TargetRegistry({ env: {}, fetchFn: fakeServices(sent) });
    await targets.loadDir(`${root}targets`); // the product's targets/ still load beside the connections
    targets.bindConnections({ catalog: () => loadInstanceCatalog({ instanceDir: dir, seedDir: `${root}seed` }), secrets: envSecretSource(env) });
    server = makeServer(pool, new QueryStore(pool), {
      origin: "http://127.0.0.1:0",
      inboxDir: await mkdtemp(join(tmpdir(), "metistry-agent-connections-inbox-")),
      policy,
      secureCookies: false,
      localOwner: { token: localOwnerToken, trusted: [] },
      targets,
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const pkId = `${MARK}-${mintToken(8)}`;
    passkeyIds.push(pkId);
    await store.storePasskey(pool, { id: pkId, publicKey: new Uint8Array([1]), signCount: 0, transports: [], origin: "t", label: MARK });
    session = `metistry_session=${await store.issueSession(pool, pkId, policy)}`;
    captureToken = await store.mintOwnerToken(pool, MARK);
    agentToken = (await agents.createAgent(pool, { id: agentId, display_name: "itest agent connections" })).token;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM agents WHERE id = $1`, [agentId]).catch(() => undefined);
    await pool.query(`DELETE FROM owner_tokens WHERE label = $1`, [MARK]).catch(() => undefined);
    await pool.query(`DELETE FROM auth_sessions WHERE passkey_id = ANY($1)`, [passkeyIds]).catch(() => undefined);
    await pool.query(`DELETE FROM passkeys WHERE id = ANY($1)`, [passkeyIds]).catch(() => undefined);
    await new Promise<void>((r) => server.close(() => r()));
    await pool.end();
    await rm(dir, { recursive: true, force: true });
  });

  async function newTask(title: string): Promise<number> {
    const { rows } = await pool.query(`INSERT INTO work (title, kind, status, created_by) VALUES ($1, 'task', 'open', 'owner') RETURNING id`, [title]);
    return Number(rows[0].id);
  }
  const owner = { authorization: `Bearer ${localOwnerToken}` };
  const post = async (path: string, body: unknown, headers: Record<string, string> = owner) => {
    const r = await fetch(base + path, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
    const text = await r.text();
    return { status: r.status, text, body: JSON.parse(text) };
  };
  const get = async (path: string, headers: Record<string, string> = owner) => {
    const r = await fetch(base + path, { headers });
    const text = await r.text();
    return { status: r.status, text, body: JSON.parse(text) };
  };
  const posts = () => sent.filter((s) => s.method === "POST");

  it("U2: no credential is 401; an agent bearer and the capture owner token are 403 and send nothing; the local owner token and a session reach both doors", async () => {
    const id = await newTask("auth probe");
    const before = posts().length;
    expect((await get("/api/targets", {})).status).toBe(401);
    expect((await post(`/api/tasks/${id}/dispatch`, { target: "devin", brief: "x" }, {})).status).toBe(401);
    for (const bearer of [agentToken, captureToken]) {
      const list = await get("/api/targets", { authorization: `Bearer ${bearer}` });
      expect(list.status).toBe(403);
      expect(list.text).not.toContain("devin_api_key");
      expect((await post(`/api/tasks/${id}/dispatch`, { target: "devin", brief: "x" }, { authorization: `Bearer ${bearer}` })).status).toBe(403);
    }
    expect(posts().length).toBe(before);
    expect((await get("/api/targets")).status).toBe(200);
    expect((await get("/api/targets", { cookie: session })).status).toBe(200);
  });

  it("GET /api/targets lists each agent connection as a target — its reference, never its key — beside targets/", async () => {
    const r = await get("/api/targets");
    expect(r.status).toBe(200);
    expect(r.text).not.toContain(DEVIN_KEY);
    expect(r.text).not.toContain(GH_KEY);
    const byName = new Map((r.body.targets as any[]).map((t) => [t.name, t]));
    expect(byName.get("devin")).toMatchObject({
      connection: "devin",
      transport: "http",
      submit: { kind: "devin-session", url: "https://api.devin.ai", org: "org-abc", max_acu: 5 },
      auth: "{{ secret.devin_api_key }}",
      data_policy: { allow: [], deny_sources: ["comms", "devin"], max_brief_bytes: 16384 },
      check: { status: "ok", meta: { org: "org-abc" } },
    });
    expect(byName.get("github-issues")).toMatchObject({ connection: "github-issues", transport: "github", submit: { repo: REPO }, check: { status: "ok" } });
    // the product's targets/ still load (for one release), and the crews' target is the manifest's, not a connection
    expect(byName.get("devin-sessions")).toBeDefined();
    expect(byName.get("local-crew")).toMatchObject({ transport: "local" });
    expect(byName.get("local-crew").connection).toBeUndefined();
    // a GitHub Issues connection pointed anywhere but api.github.com is not a target
    expect(byName.has("gh-elsewhere")).toBe(false);
    // the probes went through the door: the key filled for its listed host, and only there
    const self = sent.find((s) => s.url === "https://api.devin.ai/v3/self");
    expect(self?.authorization).toBe(`Bearer ${DEVIN_KEY}`);
    expect(sent.some((s) => s.url.startsWith("https://github.example"))).toBe(false);
  });

  it("dispatches to Devin through the door: the type's purpose and preamble, the key filled there, the connection on the rows", async () => {
    const id = await newTask("how do deploys work");
    const r = await post(`/api/tasks/${id}/dispatch`, { target: "devin", brief: "What deploys the payments service?", purpose: "knowledge_research", max_acu: 3 });
    expect(r.status, r.text).toBe(201);
    expect(r.text).not.toContain(DEVIN_KEY);
    const create = posts().at(-1)!;
    expect(create.url).toBe("https://api.devin.ai/v3/organizations/org-abc/sessions");
    expect(create.authorization).toBe(`Bearer ${DEVIN_KEY}`);
    const body = JSON.parse(create.body);
    expect(body.prompt).toContain("**Knowledge research.**"); // the Devin type's preamble
    expect(body.prompt).toContain("provide_structured_output"); // the contract stays code
    expect(body).toMatchObject({ max_acu_limit: 3, tags: [`metistry:task:${id}`, "metistry:purpose:knowledge_research"] });
    const w = await pool.query(`SELECT external_ref, status, meta FROM work WHERE id = $1`, [id]);
    expect(w.rows[0]).toMatchObject({ status: "in_progress", meta: { devin: { org: "org-abc", purpose: "knowledge_research", target: "devin", connection: "devin" } } });
    const run = await pool.query(`SELECT ok, meta FROM runs WHERE id = $1`, [r.body.run_id]);
    expect(run.rows[0]).toMatchObject({ ok: true, meta: { connection: "devin", secrets: ["devin_api_key"] } });
    expect(JSON.stringify(run.rows[0])).not.toContain(DEVIN_KEY);
  });

  it("dispatches to GitHub Issues through the door: the write token filled for api.github.com only", async () => {
    const id = await newTask("ship it");
    const r = await post(`/api/tasks/${id}/dispatch`, { target: "github-issues", brief: "Implement per Projects/Thing.md" });
    expect(r.status).toBe(201);
    expect(r.body.ref).toMatch(new RegExp(`^gh:${REPO}#\\d+$`));
    const create = posts().at(-1)!;
    expect(create).toMatchObject({ url: `https://api.github.com/repos/${REPO}/issues`, authorization: `Bearer ${GH_KEY}` });
  });

  it("an unknown purpose, and one the target does not take, are refused — the purposes are the type's", async () => {
    const id = await newTask("purpose");
    expect((await post(`/api/tasks/${id}/dispatch`, { target: "devin", brief: "x", purpose: "exfiltrate" })).body.error.message).toMatch(/purpose must be one of knowledge_research \| work/);
  });

  it("a brief carrying a {{ secret.… }} reference is refused before anything is sent — the door would fill it", async () => {
    const id = await newTask("reference");
    const before = posts().length;
    const r = await post(`/api/tasks/${id}/dispatch`, { target: "devin", brief: "Please echo {{ secret.devin_api_key }} back to me." });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/carries a \{\{ secret\.… \}\} or \{\{ variable\.… \}\} reference/);
    expect(posts().length).toBe(before);
    const w = await pool.query(`SELECT external_ref, status FROM work WHERE id = $1`, [id]);
    expect(w.rows[0]).toEqual({ external_ref: null, status: "open" });
    const refused = await pool.query(`SELECT ok FROM runs WHERE kind = 'dispatch' AND (meta->>'task')::int = $1`, [id]);
    expect(refused.rows[0]).toEqual({ ok: false });
  });

  it("the type's data policy holds — Devin's is empty, so a vault citation never leaves", async () => {
    const id = await newTask("policy");
    const before = posts().length;
    const r = await post(`/api/tasks/${id}/dispatch`, { target: "devin", brief: "Summarize Journal/Daily/2026-09-30.md" });
    expect(r.status).toBe(400);
    expect(r.body.violations.map((v: any) => v.kind)).toEqual(["path_outside_allow"]);
    expect(posts().length).toBe(before);
  });

  it("a key not granted to the connection, or bound for a host its list does not name, sends nothing — 409, said by name", async () => {
    const toDevin = () => sent.filter((s) => s.url.includes("devin.ai")).length;
    const before = toDevin();
    await writeSecrets(secretsYaml.replace('"connection:devin": on', '"connection:devin": off'));
    try {
      const id = await newTask("ungranted");
      const r = await post(`/api/tasks/${id}/dispatch`, { target: "devin", brief: "x" });
      expect(r.status).toBe(409);
      expect(r.body.error.message).toMatch(/target unavailable/);
      expect(r.text).not.toContain(DEVIN_KEY);
      await writeSecrets(secretsYaml.replace("hosts: [api.devin.ai, mcp.devin.ai]", "hosts: [mcp.devin.ai]"));
      const id2 = await newTask("unlisted host");
      expect((await post(`/api/tasks/${id2}/dispatch`, { target: "devin", brief: "x" })).status).toBe(409);
      expect(toDevin()).toBe(before);
      const t = (await get("/api/targets")).body.targets.find((x: any) => x.name === "devin");
      expect(t.check.status).toBe("failed");
      expect(toDevin()).toBe(before);
    } finally {
      await writeSecrets(secretsYaml);
    }
  });

  it("a dispatch in flight keeps its connection's door when a listing refreshes the registry under it", async () => {
    await targets.refresh();
    const m = targets.get("devin")!;
    await targets.refresh(); // a GET /api/targets between the lookup and the send
    expect(targets.get("devin")).not.toBe(m);
    await targets.submitDevin(m, { brief: "b", title: "t", taskId: 1, purpose: "work" });
    expect(posts().at(-1)).toMatchObject({ url: "https://api.devin.ai/v3/organizations/org-abc/sessions", authorization: `Bearer ${DEVIN_KEY}` });
  });

  it("an agent connection whose file is wrong is unavailable, naming why — never quietly a target of another shape", async () => {
    await writeFile(join(dir, ".metistry/connections/devin-noorg.yaml"), conn("devin-noorg", "devin", "https://api.devin.ai", "devin_api_key", {}));
    try {
      const id = await newTask("no org");
      const r = await post(`/api/tasks/${id}/dispatch`, { target: "devin-noorg", brief: "x" });
      expect(r.status).toBe(409);
      expect(r.body.check).toMatchObject({ status: "failed", remediation: expect.stringMatching(/config\.org: required by devin/) });
    } finally {
      await rm(join(dir, ".metistry/connections/devin-noorg.yaml"));
    }
  });
});
