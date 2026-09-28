// Send to Linear (design-build-plan §2.1, T4-25): two doors, one service each.
//
//   POST /api/trackers/:connection/issues {task_key, title?, team?}  files the
//     issue through the Linear connection — idempotent by task key;
//   POST /api/vault-tasks/:task_key/link {ref, seen_text}             writes
//     `linear:<KEY>` on the line — 409-guarded, as Tick is.
//
// Over real sockets against the scratch database (docs/ops/testing.md); the
// vault is the in-memory one, so every write the Link door makes is visible
// byte for byte; Linear is a stateful fake behind the console's own opener
// (`instanceSyncOpener` over a scratch instance under os.tmpdir()), so the
// key is filled at the real egress door — never the real API.
//
// The ticket's own: **a link on a changed line is refused and the issue is
// not created twice**. Plus U2's four for each door.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { memoryVault, sha256Hex, type MemoryVault } from "@foldedspacelabs/metistry-artifacts";
import { mintToken } from "@foldedspacelabs/metistry-core";
import { instanceSyncOpener, trackerIssueId, type SyncOpener } from "@foldedspacelabs/metistry-connections";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";
import { makeServer } from "../src/server.js";
import * as store from "../src/auth-store.js";
import * as agents from "../src/agents.js";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url));
const policy = { idleDays: 30, maxDays: 365 };
const MARK = "itest-linear-send";
const suffix = mintToken(6).toLowerCase().replaceAll(/[^a-z0-9]/g, "").slice(0, 6) || "x";
const DIR = `Journal/itest-send-${suffix}`;
const SEED_DIR = fileURLToPath(new URL("../../../seed", import.meta.url));
// a personal key's shape, built at run time so no key-shaped literal is in the tree
const KEY = ["lin", "api", "Mn4Bv6Cx8Za0Sd2Fg4Hj6Kl8Qw0Er2Ty4Ui6Op8As"].join("_");

interface Call {
  url: string;
  authorization: string | null;
  operation: string;
  variables: Record<string, any>;
}

/** A Linear that keeps what it is sent: issues by id, a create refused when its id is taken. */
function fakeLinear() {
  const state = {
    teams: [{ id: "team-met", key: "MET", name: "Metistry" }] as { id: string; key: string; name: string }[],
    issues: new Map<string, Record<string, unknown>>(),
    calls: [] as Call[],
    n: 41,
  };
  const fetchFn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const body = JSON.parse(String(init.body)) as { query: string; variables: Record<string, any> };
    const operation = /(?:query|mutation)\s+(\w+)/.exec(body.query)?.[1] ?? "";
    state.calls.push({ url: String(input), authorization: new Headers(init.headers).get("authorization"), operation, variables: body.variables });
    if (operation === "MetistryIssuesById") return Response.json({ data: { issues: { nodes: (body.variables.ids as string[]).flatMap((id) => (state.issues.has(id) ? [state.issues.get(id)] : [])) } } });
    if (operation === "MetistryViewerTeams") return Response.json({ data: { viewer: { teams: { nodes: state.teams } } } });
    if (operation === "MetistryIssueCreate") {
      const input = body.variables.input as { id: string; teamId: string; title: string };
      if (state.issues.has(input.id)) return Response.json({ errors: [{ message: "Entity already exists", extensions: { code: "INVALID_INPUT" } }] });
      const team = state.teams.find((t) => t.id === input.teamId)!;
      const key = `${team.key}-${++state.n}`;
      const issue = {
        id: input.id,
        identifier: key,
        title: input.title,
        url: `https://linear.app/fsl/issue/${key.toLowerCase()}/x`,
        priority: 0,
        priorityLabel: "No priority",
        dueDate: null,
        updatedAt: "2026-09-28T12:00:00.000Z",
        description: null,
        state: { name: "Backlog", type: "backlog" },
        team: { key: team.key, name: team.name },
        creator: { name: "Me" },
        assignee: null,
      };
      state.issues.set(input.id, issue);
      return Response.json({ data: { issueCreate: { success: true, issue } } });
    }
    return Response.json({ errors: [{ message: `unexpected ${operation}` }] });
  }) as typeof fetch;
  return { state, fetch: fetchFn, creates: () => state.calls.filter((c) => c.operation === "MetistryIssueCreate") };
}

describe.skipIf(!hasDb)("Send to Linear: the tracker door and the Link door", () => {
  let pool: pg.Pool;
  let queries: QueryStore;
  let vault: MemoryVault;
  let server: ReturnType<typeof makeServer>;
  let base: string;
  let sessionCookie: string;
  let ownerToken: string;
  let agentToken: string;
  let instanceDir: string;
  let inboxDir: string;
  let linear: ReturnType<typeof fakeLinear>;
  /** what the server's opener does for the next request — swapped by a test */
  let opener: SyncOpener | undefined;
  const localOwnerToken = mintToken();
  const agentId = `itest-send-${suffix}`;
  const passkeyIds: string[] = [];
  let n = 0;

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
    queries = new QueryStore(pool);
    await queries.loadDir(fileURLToPath(new URL("../../../seed/queries", import.meta.url)));
    vault = memoryVault();
    instanceDir = mkdtempSync(join(tmpdir(), "metistry-send-"));
    inboxDir = mkdtempSync(join(tmpdir(), "metistry-send-inbox-"));
    mkdirSync(join(instanceDir, ".metistry", "connections"), { recursive: true });
    writeFileSync(
      join(instanceDir, ".metistry", "connections", "linear.yaml"),
      `name: linear\ntype: tracker\nprovider: linear\nreach:\n  http:\n    url: https://api.linear.app/graphql\n    auth: { scheme: api_key, header: Authorization, secret: linear_api_key }\nsecrets: [linear_api_key]\n`,
    );
    writeFileSync(join(instanceDir, ".metistry", "secrets.yaml"), `secrets:\n  linear_api_key:\n    hosts: [api.linear.app]\n    grants: { "connection:linear": on }\n`);
    server = makeServer(pool, queries, {
      origin: "http://127.0.0.1:0",
      inboxDir,
      policy,
      secureCookies: false,
      localOwner: { token: localOwnerToken, trusted: [] },
      vault,
      openTracker: async (req) => (opener ? opener(req) : { ok: false, status: "absent", why: "no opener in this test" }),
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const pkId = `${MARK}-${mintToken(8)}`;
    passkeyIds.push(pkId);
    await store.storePasskey(pool, { id: pkId, publicKey: new Uint8Array([1]), signCount: 0, transports: [], origin: "t", label: MARK });
    sessionCookie = `metistry_session=${await store.issueSession(pool, pkId, policy)}`;
    ownerToken = await store.mintOwnerToken(pool, MARK);
    agentToken = (await agents.createAgent(pool, { id: agentId, display_name: "itest send" })).token;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM vault_tasks WHERE path LIKE $1 OR path LIKE '.metistry/itest-send-%'`, [`${DIR}/%`]);
    await pool.query(`DELETE FROM runs WHERE (kind = 'vault_task' OR kind = 'tracker') AND meta->>'task_key' LIKE 'mt-s%'`).catch(() => undefined);
    await pool.query(`DELETE FROM agents WHERE id = $1`, [agentId]);
    await pool.query(`DELETE FROM owner_tokens WHERE label = $1`, [MARK]).catch(() => undefined);
    await pool.query(`DELETE FROM auth_sessions WHERE passkey_id = ANY($1)`, [passkeyIds]).catch(() => undefined);
    await pool.query(`DELETE FROM passkeys WHERE id = ANY($1)`, [passkeyIds]).catch(() => undefined);
    await new Promise<void>((r) => server.close(() => r()));
    await pool.end();
    rmSync(instanceDir, { recursive: true, force: true });
    rmSync(inboxDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    linear = fakeLinear();
    opener = instanceSyncOpener({ instanceDir, seedDir: SEED_DIR, extensions: false, env: { METISTRY_SECRET_LINEAR_API_KEY: KEY }, fetch: linear.fetch });
  });

  /** A note in the vault and the walk's row for one line of it. */
  async function seed(lines: string[], lineNo: number, taskKey: string, text: string, path = `${DIR}/${++n}.md`): Promise<{ path: string; content: string }> {
    const content = `${lines.join("\n")}\n`;
    await vault.write(path, Buffer.from(content), { principal: "user", message: "seed" });
    await pool.query(
      `INSERT INTO vault_tasks (path, task_key, anchor, line_no, text, text_norm, checked, parsed_on, first_seen_on, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, lower($5), false, current_date, current_date, now())`,
      [path, taskKey, taskKey.startsWith("mt-") ? taskKey : null, lineNo, text],
    );
    return { path, content };
  }

  const bytes = async (path: string) => (await vault.read(path))!.content.toString("utf8");
  const owner = { authorization: `Bearer ${localOwnerToken}` };

  async function post(path: string, body: Record<string, unknown>, headers: Record<string, string> = owner) {
    const r = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as Record<string, any>, replayed: r.headers.get("idempotency-replayed") };
  }
  const send = (body: Record<string, unknown>, headers?: Record<string, string>, connection = "linear") => post(`/api/trackers/${connection}/issues`, body, headers);
  const link = (taskKey: string, body: Record<string, unknown>, headers?: Record<string, string>) => post(`/api/vault-tasks/${encodeURIComponent(taskKey)}/link`, body, headers);

  // ---- the ticket's own ---------------------------------------------------------------------

  it("**a link on a changed line is refused, and the issue is not created twice**", async () => {
    const { path } = await seed(["# Day", "- [ ] Send Dana the fixture format due 2026-09-28 ^mt-sbold001"], 2, "mt-sbold001", "Send Dana the fixture format");

    // the first door: the issue is filed, titled with the line's text
    const created = await send({ task_key: "mt-sbold001" });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({
      ok: true,
      connection: "linear",
      key: "MET-42",
      ref: "linear:MET-42",
      url: "https://linear.app/fsl/issue/met-42/x",
      created: true,
      title: "Send Dana the fixture format",
      task_key: "mt-sbold001",
      path,
    });
    expect(linear.creates()).toHaveLength(1);
    expect(linear.creates()[0]!.variables.input).toEqual({ id: trackerIssueId("linear", path, "mt-sbold001"), teamId: "team-met", title: "Send Dana the fixture format" });

    // the owner edits the line in Obsidian before the link lands
    const edited = "# Day\n- [ ] Send Dana the fixture format by email due 2026-09-28 ^mt-sbold001\n";
    const cur = (await vault.read(path))!;
    await vault.write(path, Buffer.from(edited), { principal: "user", message: "edit" }, cur.sha256);

    // the second door, with what the client drew: refused, nothing written
    const refused = await link("mt-sbold001", { ref: "linear:MET-42", seen_text: "Send Dana the fixture format" });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: { code: "conflict" }, reason: "stale", line: "- [ ] Send Dana the fixture format by email due 2026-09-28 ^mt-sbold001" });
    expect(refused.body.task.text).toBe("Send Dana the fixture format by email");
    expect(await bytes(path)).toBe(edited);

    // the client redraws and sends again: the SAME issue answers, and nothing is created
    const again = await send({ task_key: "mt-sbold001" });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ ok: true, key: "MET-42", ref: "linear:MET-42", created: false });
    expect(linear.creates()).toHaveLength(1);
    expect(linear.state.issues.size).toBe(1);

    // and the link with the line as it stands lands: one ref, nothing else
    const linked = await link("mt-sbold001", { ref: again.body.ref, seen_text: "Send Dana the fixture format by email" });
    expect(linked.status).toBe(200);
    expect(await bytes(path)).toBe("# Day\n- [ ] Send Dana the fixture format by email due 2026-09-28 linear:MET-42 ^mt-sbold001\n");

    // once the line is linked, Send to Linear is refused before Linear is asked anything
    const calls = linear.state.calls.length;
    const linkedAlready = await send({ task_key: "mt-sbold001" });
    expect(linkedAlready.status).toBe(409);
    expect(linkedAlready.body).toMatchObject({ reason: "stale", task: { ext_refs: ["linear:MET-42"] } });
    expect(linear.state.calls.length).toBe(calls);
    expect(linear.creates()).toHaveLength(1);
  });

  it("two presses racing file one issue", async () => {
    await seed(["- [ ] Race the fixture ^mt-srace001"], 1, "mt-srace001", "Race the fixture");
    const [a, b] = await Promise.all([send({ task_key: "mt-srace001" }), send({ task_key: "mt-srace001" })]);
    // in this console the two share one call; across consoles they would meet at Linear (the service's own test)
    for (const r of [a, b]) expect([200, 201]).toContain(r.status);
    expect(a.body.key).toBe(b.body.key);
    expect(linear.creates()).toHaveLength(1);
    expect(linear.state.issues.size).toBe(1);
  });

  it("the key goes to api.linear.app only, filled at the door — never by the caller, never on a URL — and the audit row names the secret, never the text", async () => {
    await seed(["- [ ] Keep the key home ^mt-skey0001"], 1, "mt-skey0001", "Keep the key home");
    expect((await send({ task_key: "mt-skey0001" })).status).toBe(201);
    for (const c of linear.state.calls) {
      expect(c.url).toBe("https://api.linear.app/graphql");
      expect(c.url).not.toContain(KEY);
      expect(c.authorization).toBe(KEY);
    }
    const { rows } = await pool.query(`SELECT ok, meta FROM runs WHERE kind = 'tracker' AND meta->>'task_key' = 'mt-skey0001' ORDER BY id DESC LIMIT 1`);
    expect(rows[0]).toMatchObject({ ok: true, meta: expect.objectContaining({ connection: "linear", task_key: "mt-skey0001", key: "MET-42", outcome: "created", secrets: ["linear_api_key"] }) });
    expect(JSON.stringify(rows[0].meta)).not.toContain("Keep the key");
    expect(JSON.stringify(rows[0].meta)).not.toContain(KEY);
  });

  it("title and team: the caller's title wins, several teams and none named files nothing and lists them", async () => {
    linear.state.teams = [
      { id: "team-met", key: "MET", name: "Metistry" },
      { id: "team-ops", key: "OPS", name: "Operations" },
    ];
    await seed(["- [ ] Pick a team ^mt-steam001"], 1, "mt-steam001", "Pick a team");
    const none = await send({ task_key: "mt-steam001" });
    expect(none.status).toBe(400);
    expect(none.body).toMatchObject({ error: { code: "invalid_request" }, reason: "team_required", teams: [{ key: "MET", name: "Metistry" }, { key: "OPS", name: "Operations" }] });
    const wrong = await send({ task_key: "mt-steam001", team: "SEC" });
    expect(wrong.body).toMatchObject({ reason: "unknown_team" });
    expect(linear.creates()).toHaveLength(0);
    const ok = await send({ task_key: "mt-steam001", team: "OPS", title: "Pick a team\n(for ops)" });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ key: "OPS-42", title: "Pick a team (for ops)" });
  });

  it("the Link door writes exactly the ref, as `user`, with the read's hash — and replays an Idempotency-Key", async () => {
    const lines = ["---", "area: x", "---", "Some prose  with  spaces ", "- [ ] Draft the Q4 plan due 2026-10-01 p1 ^mt-slink001", "\t- [ ] nested"];
    const { path, content } = await seed(lines, 5, "mt-slink001", "Draft the Q4 plan");
    const headers = { ...owner, "idempotency-key": `link-${suffix}` };
    const r = await link("mt-slink001", { ref: "linear:MET-7", seen_text: "Draft the Q4 plan" }, headers);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      ok: true,
      line: "- [ ] Draft the Q4 plan due 2026-10-01 p1 linear:MET-7 ^mt-slink001",
      task: { path, task_key: "mt-slink001", anchor: "mt-slink001", line_no: 5, text: "Draft the Q4 plan", checked: false, done_on: null, ext_refs: ["linear:MET-7"] },
    });
    const after = await bytes(path);
    expect(after.replace(" linear:MET-7", "")).toBe(content);
    const w = (await vault.read(path))!;
    expect(w.sha256).toBe(sha256Hex(after));
    const replay = await link("mt-slink001", { ref: "linear:MET-7", seen_text: "Draft the Q4 plan" }, headers);
    expect(replay).toMatchObject({ status: 200, replayed: "true" });
    expect(await bytes(path)).toBe(after);
    // without the key, a second link is stale — the line already carries it
    expect((await link("mt-slink001", { ref: "linear:MET-7", seen_text: "Draft the Q4 plan" })).status).toBe(409);
    // another linear ref on a linked line is stale too: one issue per line
    const other = await link("mt-slink001", { ref: "linear:MET-8", seen_text: "Draft the Q4 plan" });
    expect(other).toMatchObject({ status: 409, body: { reason: "stale" } });
    expect(await bytes(path)).toBe(after);
    // gh: is the other scheme it writes
    expect((await link("mt-slink001", { ref: "gh:foldedspacelabs/metistry#418", seen_text: "Draft the Q4 plan" })).status).toBe(200);
    expect(await bytes(path)).toContain("p1 linear:MET-7 gh:foldedspacelabs/metistry#418 ^mt-slink001");
  });

  // ---- refusals -----------------------------------------------------------------------------

  describe("refused, nothing filed and nothing written", () => {
    it("a ref that is not linear:<KEY> or gh:<owner>/<repo>#<n>, and a field the door does not take", async () => {
      const { path, content } = await seed(["- [ ] Bad refs ^mt-sbadref1"], 1, "mt-sbadref1", "Bad refs");
      for (const ref of ["linear:met-1", "work:12", "linear:MET-1 p1", "gh:o/r", 7]) {
        expect((await link("mt-sbadref1", { ref, seen_text: "Bad refs" })).status).toBe(400);
      }
      expect((await link("mt-sbadref1", { ref: "linear:MET-1", seen_text: "Bad refs", text: "x" })).status).toBe(400);
      expect((await send({ task_key: "mt-sbadref1", description: "more" })).status).toBe(400);
      expect((await send({ task_key: "not a key" })).status).toBe(400);
      expect((await send({ task_key: "mt-sbadref1", team: "met" })).status).toBe(400);
      expect(await bytes(path)).toBe(content);
      expect(linear.state.calls).toHaveLength(0);
    });

    it("a key whose note is under .metistry/ is refused 403 before anything is read or sent", async () => {
      await seed(["- [ ] Secret ^mt-sprot001"], 1, "mt-sprot001", "Secret", `.metistry/itest-send-${suffix}.md`);
      const r = await send({ task_key: "mt-sprot001" });
      expect(r.status).toBe(403);
      expect(linear.state.calls).toHaveLength(0);
    });

    it("a recurrence rule is not a task", async () => {
      await seed(["- [ ] Water the plants every week due friday ^mt-srule001"], 1, "mt-srule001", "Water the plants");
      expect((await send({ task_key: "mt-srule001" })).status).toBe(400);
      expect(linear.creates()).toHaveLength(0);
    });

    it("no instance is 503; a connection the Linear sync does not read is 404; a provider without `create` is 403", async () => {
      await seed(["- [ ] Where to ^mt-sconn001"], 1, "mt-sconn001", "Where to");
      const real = opener!;
      opener = undefined;
      expect((await send({ task_key: "mt-sconn001" })).status).toBe(503);
      opener = real;
      expect((await send({ task_key: "mt-sconn001" }, owner, "linear-work")).status).toBe(404);
      opener = async (req) => {
        const o = await real(req);
        return o.ok ? { ok: true, sync: { ...o.sync, capabilities: ["read"] } } : o;
      };
      const r = await send({ task_key: "mt-sconn001" });
      expect(r.status).toBe(403);
      expect(r.body.error.message).toContain("create");
      expect(linear.state.calls).toHaveLength(0);
    });

    it("Linear refusing the key is 503, and nothing is claimed filed", async () => {
      await seed(["- [ ] Refused ^mt-s401aaaa"], 1, "mt-s401aaaa", "Refused");
      opener = instanceSyncOpener({ instanceDir, seedDir: SEED_DIR, extensions: false, env: { METISTRY_SECRET_LINEAR_API_KEY: KEY }, fetch: (async () => new Response("no", { status: 401 })) as typeof fetch });
      const r = await send({ task_key: "mt-s401aaaa" });
      expect(r.status).toBe(503);
      expect(r.body.error.message).toMatch(/unauthorized/);
    });
  });

  // ---- U2: the four, for each door ------------------------------------------------------------

  describe("who may send and link (U2)", () => {
    it("no credential is the uniform 401 at both doors", async () => {
      const { path, content } = await seed(["- [ ] U2 none ^mt-su2none0"], 1, "mt-su2none0", "U2 none");
      const a = await send({ task_key: "mt-su2none0" }, {});
      const b = await link("mt-su2none0", { ref: "linear:MET-1", seen_text: "U2 none" }, {});
      for (const r of [a, b]) {
        expect(r.status).toBe(401);
        expect(r.body).toEqual({ error: { code: "unauthenticated", message: "authentication required" } });
      }
      expect(await bytes(path)).toBe(content);
      expect(linear.state.calls).toHaveLength(0);
    });

    it("an agent bearer is refused 403 at both doors", async () => {
      const { path, content } = await seed(["- [ ] U2 agent ^mt-su2agent"], 1, "mt-su2agent", "U2 agent");
      const auth = { authorization: `Bearer ${agentToken}` };
      for (const r of [await send({ task_key: "mt-su2agent" }, auth), await link("mt-su2agent", { ref: "linear:MET-1", seen_text: "U2 agent" }, auth)]) {
        expect(r.status).toBe(403);
        expect(r.body.error.code).toBe("forbidden");
      }
      expect(await bytes(path)).toBe(content);
      expect(linear.state.calls).toHaveLength(0);
    });

    it("the capture owner token is refused 403 at both doors — capture is its whole reach", async () => {
      const { path, content } = await seed(["- [ ] U2 capture ^mt-su2capt0"], 1, "mt-su2capt0", "U2 capture");
      const auth = { authorization: `Bearer ${ownerToken}` };
      for (const r of [await send({ task_key: "mt-su2capt0" }, auth), await link("mt-su2capt0", { ref: "linear:MET-1", seen_text: "U2 capture" }, auth)]) {
        expect(r.status).toBe(403);
        expect(r.body.error.code).toBe("forbidden");
      }
      expect(await bytes(path)).toBe(content);
      expect(linear.state.calls).toHaveLength(0);
    });

    it("the local owner token reaches both doors, and so does a passkey session (reach `owner`)", async () => {
      await seed(["- [ ] U2 local ^mt-su2local"], 1, "mt-su2local", "U2 local");
      const sent = await send({ task_key: "mt-su2local" });
      expect(sent.status).toBe(201);
      expect((await link("mt-su2local", { ref: sent.body.ref, seen_text: "U2 local" })).status).toBe(200);
      const b = await seed(["- [ ] U2 session ^mt-su2sess0"], 1, "mt-su2sess0", "U2 session");
      const viaSession = await send({ task_key: "mt-su2sess0" }, { cookie: sessionCookie });
      expect(viaSession.status).toBe(201);
      expect((await link("mt-su2sess0", { ref: viaSession.body.ref, seen_text: "U2 session" }, { cookie: sessionCookie })).status).toBe(200);
      expect(await bytes(b.path)).toBe(`- [ ] U2 session ${viaSession.body.ref} ^mt-su2sess0\n`);
    });
  });
});
