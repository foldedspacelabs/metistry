// Close in Linear and Done in Linear (design-build-plan §2.1, §2.3, §2.6;
// T4-26), over real sockets against the scratch database. The tracker
// connection is a scratch instance's, opened by the console's own opener
// (`linearTrackerOpener`) through the egress door; Linear is an in-process
// fake that records every request — so "nothing was sent" is a count.
//
// The ticket's own test, bold in its Tests line: **no sync path writes a
// vault file** — here, the door and Today's *Done in Linear* over a vault
// that counts writes (the sync's half is collectors/test/linear-complete).
// Plus U2's four, the owner's Never enforced at the tool, and the body.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { memoryVault, type MemoryVault } from "@foldedspacelabs/metistry-artifacts";
import { mintToken, raiseMirror } from "@foldedspacelabs/metistry-core";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";
import { linearTrackerOpener } from "@metistry-apps/collectors";
import { makeServer } from "../src/server.js";
import { TRACKER_COMPLETE_ROUTE, isTrackerCompleteRoute, trackerClosedForDay } from "../src/tracker-complete-route.js";
import * as store from "../src/auth-store.js";
import * as agents from "../src/agents.js";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url));
const policy = { idleDays: 30, maxDays: 365 };
const MARK = "itest-tracker";
const suffix = mintToken(6).toLowerCase().replaceAll(/[^a-z0-9]/g, "").slice(0, 6) || "x";
const SEED = fileURLToPath(new URL("../../../seed", import.meta.url));
const ZONE = "UTC";
const DAY = "2001-03-04";
// a team key of this run's own, so a concurrent test's rows are never these
const TEAM = `T${suffix.replaceAll(/[^a-z]/g, "").toUpperCase().slice(0, 5) || "X"}`;
const KEY = ["lin", "api", "Fx7Qw2Er9Ty4Ui1Op6As3Df8Gh5Jk0Lz"].join("_"); // key-shaped, built at run time
const DIR = `Journal/itest-tracker-${suffix}`;

const CONNECTION = (tools = "") => `name: linear\ntype: tracker\nprovider: linear\nreach:\n  http:\n    url: https://api.linear.app/graphql\n    auth: { scheme: api_key, header: Authorization, secret: linear_api_key }\nsecrets: [linear_api_key]\n${tools}`;
const SECRETS = 'secrets:\n  linear_api_key:\n    hosts: [api.linear.app]\n    grants: { "connection:linear": on }\n';

function instance(connection = CONNECTION()): string {
  const dir = mkdtempSync(join(tmpdir(), "metistry-tracker-"));
  mkdirSync(join(dir, ".metistry", "connections"), { recursive: true });
  writeFileSync(join(dir, ".metistry", "connections", "linear.yaml"), connection);
  writeFileSync(join(dir, ".metistry", "secrets.yaml"), SECRETS);
  return dir;
}

interface Sent {
  url: string;
  authorization: string | null;
  operation: string;
  variables: Record<string, unknown>;
}

/** A fake Linear: every issue open until a MetistryCompleteIssue moves it to Done. */
function fakeLinear() {
  const sent: Sent[] = [];
  const closed = new Set<string>();
  const issue = (id: string, done: boolean) => {
    const key = id.startsWith("uuid-") ? id.slice(5) : id;
    return {
      id: `uuid-${key}`,
      identifier: key,
      title: `Issue ${key}`,
      url: `https://linear.app/example/issue/${key}`,
      priority: 0,
      priorityLabel: "No priority",
      dueDate: null,
      updatedAt: "2001-03-04T00:00:00.000Z",
      description: null,
      state: done ? { name: "Done", type: "completed" } : { name: "Todo", type: "unstarted" },
      team: { key: TEAM, name: "Team", states: { nodes: [{ id: "st-done", name: "Done", type: "completed", position: 1 }] } },
      creator: null,
      assignee: { name: "Me", isMe: true },
    };
  };
  const fetchFn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const body = JSON.parse(String(init.body ?? "{}")) as { query?: string; variables?: Record<string, unknown> };
    const operation = /(?:query|mutation)\s+(\w+)/.exec(body.query ?? "")?.[1] ?? "";
    const variables = body.variables ?? {};
    sent.push({ url: String(input), authorization: new Headers(init.headers).get("authorization"), operation, variables });
    const id = String(variables.id ?? "");
    const key = id.startsWith("uuid-") ? id.slice(5) : id;
    if (operation === "MetistryIssueToComplete") return Response.json({ data: { issue: issue(id, closed.has(key)) } });
    if (operation === "MetistryCompleteIssue") {
      closed.add(key);
      return Response.json({ data: { issueUpdate: { success: true, issue: issue(id, true) } } });
    }
    return Response.json({ errors: [{ message: "unexpected" }] });
  }) as typeof fetch;
  return { fetch: fetchFn, sent, closed };
}

describe("the route (pure)", () => {
  it("matches the complete door and nothing near it", () => {
    expect(isTrackerCompleteRoute("POST /api/trackers/linear/issues/ENG-1/complete")).toBe(true);
    for (const k of ["GET /api/trackers/linear/issues/ENG-1/complete", "POST /api/trackers/linear/issues/ENG-1", "POST /api/trackers/linear/issues", "POST /api/trackers/linear/issues/ENG-1/reopen", "POST /api/trackers/issues/ENG-1/complete"]) {
      expect(isTrackerCompleteRoute(k), k).toBe(false);
    }
    expect(TRACKER_COMPLETE_ROUTE.exec("POST /api/trackers/linear/issues/ENG-1/complete")?.slice(1)).toEqual(["linear", "ENG-1"]);
  });

  it("Done in Linear names only OPEN lines, only for linear refs, and asks nothing when there are none", async () => {
    const asked: Record<string, unknown>[] = [];
    const queries = {
      async run(name: string, params: Record<string, unknown>) {
        asked.push({ name, ...params });
        return { rows: [{ ref: "linear:ENG-1", connection: "linear", key: "ENG-1", url: "https://linear.app/x/issue/ENG-1", closed_reason: "completed" }, { ref: "linear:ENG-2", connection: "linear", key: "ENG-2", url: null, closed_reason: "canceled" }] };
      },
    } as never;
    expect(await trackerClosedForDay([{ task_key: "a", checked: false, ext_refs: ["gh:o/r#1"] }], queries)).toEqual([]);
    expect(asked).toEqual([]);
    const out = await trackerClosedForDay(
      [
        { task_key: "open", checked: false, dropped: false, ext_refs: ["linear:ENG-1", "gh:o/r#1"] },
        { task_key: "ticked", checked: true, dropped: false, ext_refs: ["linear:ENG-1"] },
        { task_key: "dropped", checked: false, dropped: true, ext_refs: ["linear:ENG-2"] },
        { task_key: "canceled", checked: false, dropped: false, ext_refs: ["linear:ENG-2"] },
      ],
      queries,
    );
    expect(asked).toEqual([{ name: "tracker_closed", refs: "linear:ENG-1,linear:ENG-2" }]);
    expect(out).toEqual([
      { task_key: "open", ref: "linear:ENG-1", connection: "linear", key: "ENG-1", state: "done", url: "https://linear.app/x/issue/ENG-1" },
      { task_key: "canceled", ref: "linear:ENG-2", connection: "linear", key: "ENG-2", state: "canceled", url: null },
    ]);
  });
});

describe.skipIf(!hasDb)("Close in Linear: POST /api/trackers/:connection/issues/:key/complete — and Done in Linear on Today", () => {
  let pool: pg.Pool;
  let vault: MemoryVault;
  let server: ReturnType<typeof makeServer>;
  let bareServer: ReturnType<typeof makeServer>;
  let base: string;
  let bare: string;
  let linear: ReturnType<typeof fakeLinear>;
  let writes = 0;
  let sessionCookie: string;
  let ownerToken: string;
  let agentToken: string;
  let dir = "";
  const dirs: string[] = [];
  const localOwnerToken = mintToken();
  const agentId = `itest-tracker-${suffix}`;
  const passkeyIds: string[] = [];
  const local = { authorization: `Bearer ${localOwnerToken}` };
  const k = (n: number) => `${TEAM}-${n}`;

  async function post(key: string, body: unknown = {}, headers: Record<string, string> = local, at = base, connection = "linear") {
    const r = await fetch(`${at}/api/trackers/${connection}/issues/${key}/complete`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    return { status: r.status, body: JSON.parse(text) as Record<string, any> };
  }
  const workRow = async (key: string) => (await pool.query(`SELECT status, meta->>'closed_reason' AS closed_reason FROM work WHERE external_ref = $1`, [`linear:${key}`])).rows[0];
  const issueRow = (key: string, status = "open", closedReason?: string) =>
    pool.query(`INSERT INTO work (title, kind, status, external_ref, created_by, meta) VALUES ($1, 'issue', $2, $3, 'user', $4::jsonb)`, [
      `${MARK} ${key}`,
      status,
      `linear:${key}`,
      JSON.stringify({ connection: "linear", id: `uuid-${key}`, key, url: `https://linear.app/example/issue/${key}`, state: closedReason ? "Done" : "Todo", ...(closedReason ? { closed_reason: closedReason } : {}) }),
    ]);

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
    const queries = new QueryStore(pool);
    await queries.loadDir(fileURLToPath(new URL("../../../seed/queries", import.meta.url)));
    vault = memoryVault();
    const write = vault.write.bind(vault);
    vault.write = (async (...args: Parameters<typeof write>) => {
      writes++;
      return write(...args);
    }) as typeof vault.write;
    linear = fakeLinear();
    dir = instance();
    dirs.push(dir);
    // the opener reads the instance afresh on each press: `dir` is swapped between tests to change the owner's setting
    const trackers = (name: string) => linearTrackerOpener({ instanceDir: dir, seedDir: SEED, extensions: false, env: { METISTRY_SECRET_LINEAR_API_KEY: KEY }, fetch: linear.fetch })(name);
    const serve = async (withTrackers: boolean) => {
      const inboxDir = mkdtempSync(join(tmpdir(), "metistry-tracker-inbox-"));
      dirs.push(inboxDir);
      const s = makeServer(pool, queries, { origin: "http://127.0.0.1:0", inboxDir, policy, secureCookies: false, localOwner: { token: localOwnerToken, trusted: [] }, vault, timeZone: ZONE, ...(withTrackers ? { trackers } : {}) });
      await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
      return { s, url: `http://127.0.0.1:${(s.address() as AddressInfo).port}` };
    };
    ({ s: server, url: base } = await serve(true));
    ({ s: bareServer, url: bare } = await serve(false));
    const pkId = `${MARK}-${mintToken(8)}`;
    passkeyIds.push(pkId);
    await store.storePasskey(pool, { id: pkId, publicKey: new Uint8Array([1]), signCount: 0, transports: [], origin: "t", label: MARK });
    sessionCookie = `metistry_session=${await store.issueSession(pool, pkId, policy)}`;
    ownerToken = await store.mintOwnerToken(pool, MARK);
    agentToken = (await agents.createAgent(pool, { id: agentId, display_name: "itest tracker" })).token;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM proposals WHERE source->>'kind' = 'linear' AND source->>'external_ref' LIKE $1`, [`linear:${TEAM}-%`]);
    await pool.query(`DELETE FROM work WHERE external_ref LIKE $1`, [`linear:${TEAM}-%`]);
    await pool.query(`DELETE FROM vault_tasks WHERE path LIKE $1`, [`${DIR}/%`]);
    await pool.query(`DELETE FROM runs WHERE component = 'console' AND kind = 'tracker' AND meta->>'key' LIKE $1`, [`${TEAM}-%`]);
    await pool.query(`DELETE FROM agents WHERE id = $1`, [agentId]);
    await pool.query(`DELETE FROM owner_tokens WHERE label = $1`, [MARK]).catch(() => undefined);
    await pool.query(`DELETE FROM auth_sessions WHERE passkey_id = ANY($1)`, [passkeyIds]).catch(() => undefined);
    await pool.query(`DELETE FROM passkeys WHERE id = ANY($1)`, [passkeyIds]).catch(() => undefined);
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => bareServer.close(() => r()));
    await pool.end();
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  beforeEach(() => {
    dir = dirs[0]!;
  });

  describe("who may close (U2)", () => {
    it("no credential is the uniform 401, and Linear hears nothing", async () => {
      const r = await post(k(1), {}, {});
      expect(r.status).toBe(401);
      expect(linear.sent.filter((s) => s.variables.id === k(1))).toHaveLength(0);
    });

    it("an agent bearer is refused 403 — nothing is sent", async () => {
      const r = await post(k(1), {}, { authorization: `Bearer ${agentToken}` });
      expect(r.status).toBe(403);
      expect(linear.sent).toHaveLength(0);
    });

    it("the capture owner token is refused 403 — capture is its whole reach", async () => {
      const r = await post(k(1), {}, { authorization: `Bearer ${ownerToken}` });
      expect(r.status).toBe(403);
      expect(linear.sent).toHaveLength(0);
    });

    it("the local owner token reaches it, and so does a passkey session", async () => {
      await issueRow(k(2));
      const r = await post(k(2));
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body).toEqual({ ok: true, connection: "linear", key: k(2), ref: `linear:${k(2)}`, url: `https://linear.app/example/issue/${k(2)}`, state: "done", changed: true });
      const s = await post(k(3), {}, { cookie: sessionCookie });
      expect(s.status, JSON.stringify(s.body)).toBe(200);
    });
  });

  it("**closes the issue through the connection's door — the key to api.linear.app only — closes the row, clears the request, and writes no vault file**", async () => {
    await issueRow(k(10));
    const { id: request } = await raiseMirror(pool, { kind: "task", source_agent: "linear", trust: "external", source: { kind: "linear", external_ref: `linear:${k(10)}`, person: null }, payload: { title: k(10) } });
    const before = writes;
    const r = await post(k(10));
    expect(r.status).toBe(200);
    const mine = linear.sent.filter((s) => s.variables.id === `uuid-${k(10)}`);
    expect(mine.map((s) => s.operation)).toEqual(["MetistryIssueToComplete", "MetistryCompleteIssue"]);
    expect(mine.every((s) => s.url === "https://api.linear.app/graphql" && s.authorization === KEY)).toBe(true);
    expect(await workRow(k(10))).toEqual({ status: "closed", closed_reason: "completed" });
    expect((await pool.query(`SELECT decision FROM proposals WHERE id = $1`, [request])).rows[0].decision).toBe("resolved_at_source");
    expect(writes).toBe(before);
    // audited: the key and the secret's name, never its value
    const run = (await pool.query(`SELECT ok, meta FROM runs WHERE component = 'console' AND kind = 'tracker' AND meta->>'key' = $1`, [k(10)])).rows[0];
    expect(run.ok).toBe(true);
    expect(JSON.stringify(run.meta)).not.toContain(KEY);
    // idempotent by nature: again is 200, changed false, only the read sent
    const again = await post(k(10));
    expect(again.body).toMatchObject({ ok: true, state: "done", changed: false });
    expect(linear.sent.filter((s) => s.variables.id === `uuid-${k(10)}`)).toHaveLength(3);
  });

  it("**the owner's Never is enforced at the door: 403, nothing sent, the row still open**", async () => {
    dir = instance(CONNECTION("tools:\n  complete_issue: { group: changes, mode: off }\n"));
    dirs.push(dir);
    await issueRow(k(20));
    const r = await post(k(20));
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ error: { code: "forbidden" }, reason: "tool_off" });
    expect(r.body.error.message).toContain("metistry connections policy linear complete_issue");
    expect(linear.sent.filter((s) => s.variables.id === `uuid-${k(20)}`)).toHaveLength(0);
    expect(await workRow(k(20))).toMatchObject({ status: "open" });
  });

  it("refuses the body, the names and the deployment before anything is sent", async () => {
    const n = linear.sent.length;
    expect((await post(k(30), { state: "canceled" })).status).toBe(400); // the body is {} — no field picks the state
    expect((await post(k(30), [])).status).toBe(400);
    expect((await post("eng-30")).body).toMatchObject({ reason: "bad_key" });
    expect((await post(k(30), {}, local, base, "Linear")).status).toBe(400); // not a connection name
    expect((await post(k(30), {}, local, base, "linear-other")).status).toBe(404);
    expect((await post(k(30), undefined)).status).toBe(200); // no body is the same as {}
    expect(linear.sent.length).toBe(n + 2);
    const r = await post(k(31), {}, local, bare);
    expect(r.status).toBe(503);
    expect(linear.sent.length).toBe(n + 2);
  });

  it("**Done in Linear: an open line whose issue Linear closed is named on Today — the line itself untouched — and a ticked line is not**", async () => {
    const line = (key: string, n: number, checked: boolean) =>
      pool.query(
        `INSERT INTO vault_tasks (path, task_key, anchor, line_no, text, text_norm, checked, due, done_on, ext_refs, parsed_on, first_seen_on, last_seen_at)
         VALUES ($1, $2, $2, $3, $4, lower($4), $5, $6, $7, $8, $6, $6, now())`,
        [`${DIR}/${DAY}.md`, `mt-tr${suffix}${n}`.slice(0, 19), n, `Ship ${key}`, checked, DAY, checked ? DAY : null, [`linear:${key}`]],
      );
    await issueRow(k(40), "closed", "completed");
    await issueRow(k(41), "closed", "completed");
    await issueRow(k(42), "open");
    await line(k(40), 1, false);
    await line(k(41), 2, true);
    await line(k(42), 3, false);
    const before = writes;
    const r = await fetch(`${base}/api/today?date=${DAY}`, { headers: local });
    const body = (await r.json()) as Record<string, any>;
    expect(r.status).toBe(200);
    // another test's rows can share the scratch database's day; these are this run's team's
    expect(body.tracker_closed.filter((e: any) => e.ref.startsWith(`linear:${TEAM}-`))).toEqual([{ task_key: `mt-tr${suffix}1`.slice(0, 19), ref: `linear:${k(40)}`, connection: "linear", key: k(40), state: "done", url: `https://linear.app/example/issue/${k(40)}` }]);
    // the line is still the owner's open line: the one-click Tick is the Tick door, as `user`
    expect(body.tasks.find((t: any) => t.task_key === `mt-tr${suffix}1`.slice(0, 19))).toMatchObject({ checked: false });
    expect(writes).toBe(before);
  });
});
