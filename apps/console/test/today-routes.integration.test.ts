// Today's three routes (design-build-plan §2.1, §2.10; ticket T2-7):
// `GET /api/today?date=`, `GET /api/vault-tasks?where=` and
// `PUT /api/today/order`. Over real sockets against the scratch database
// (docs/ops/testing.md); the vault is the in-memory one.
//
// The ticket's own: **order keys outside the day are refused** — a real key
// from another day, a work row the day does not hold, a key nobody has —
// and nothing is written. Plus U2's four on each route, and the composition
// the F-7 fixture describes (apps/macos/tests/kit/fixtures/get-api-today.json).
//
// The day is 2001-02-03 so that no other suite's rows (they share the
// scratch database, and use today's dates) are owed on or before it; the
// work rows every suite shares are filtered to this file's own ids.
import { readFileSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { memoryVault, type MemoryVault } from "@foldedspacelabs/metistry-artifacts";
import { calendarDate, compileTaskFilter, mintToken } from "@foldedspacelabs/metistry-core";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";
import { makeServer } from "../src/server.js";
import { DAY_FILES, todayPreset } from "../src/today-routes.js";
import * as store from "../src/auth-store.js";
import * as agents from "../src/agents.js";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url));
const policy = { idleDays: 30, maxDays: 365 };
const MARK = "itest-today";
const suffix = mintToken(6).toLowerCase().replaceAll(/[^a-z0-9]/g, "").slice(0, 6) || "x";
const DIR = `Journal/itest-today-${suffix}`;
const ZONE = "America/New_York";
const DAY = "2001-02-03";
const PREV = "2001-02-02";
const NEXT = "2001-02-04";
const FIXTURE = JSON.parse(readFileSync(fileURLToPath(new URL("../../macos/tests/kit/fixtures/get-api-today.json", import.meta.url)), "utf8")) as { body: Record<string, unknown> };

type Body = Record<string, any>;

describe.skipIf(!hasDb)("Today: GET /api/today, GET /api/vault-tasks, PUT /api/today/order", () => {
  let pool: pg.Pool;
  let vault: MemoryVault;
  let server: ReturnType<typeof makeServer>;
  let base: string;
  let sessionCookie: string;
  let ownerToken: string;
  let agentToken: string;
  const localOwnerToken = mintToken();
  const agentId = `itest-today-${suffix}`;
  const passkeyIds: string[] = [];
  const inboxDirs: string[] = [];
  const workIds: Record<string, string> = {};
  const K = (name: string) => `mt-t${suffix}${name}`.slice(0, 19); // an anchor: mt- + ≤16 of [0-9a-z]

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
    const queries = new QueryStore(pool);
    await queries.loadDir(fileURLToPath(new URL("../../../seed/queries", import.meta.url)));
    vault = memoryVault();
    const inboxDir = await mkdtemp(join(tmpdir(), "metistry-today-"));
    inboxDirs.push(inboxDir);
    server = makeServer(pool, queries, {
      origin: "http://127.0.0.1:0",
      inboxDir,
      policy,
      secureCookies: false,
      localOwner: { token: localOwnerToken, trusted: [] },
      vault,
      timeZone: ZONE,
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const pkId = `${MARK}-${mintToken(8)}`;
    passkeyIds.push(pkId);
    await store.storePasskey(pool, { id: pkId, publicKey: new Uint8Array([1]), signCount: 0, transports: [], origin: "t", label: MARK });
    sessionCookie = `metistry_session=${await store.issueSession(pool, pkId, policy)}`;
    ownerToken = await store.mintOwnerToken(pool, MARK);
    agentToken = (await agents.createAgent(pool, { id: agentId, display_name: "itest today" })).token;

    // the walk's rows: what the index would hold for one day note after one pass
    const task = (name: string, line: number, text: string, f: { due?: string; do?: string; checked?: boolean; done?: string; priority?: number; someday?: boolean; waiting?: boolean }) =>
      pool.query(
        `INSERT INTO vault_tasks (path, task_key, anchor, line_no, text, text_norm, checked, due, scheduled_for, done_on, priority, someday, waiting, parsed_on, first_seen_on, last_seen_at)
         VALUES ($1, $2, $2, $3, $4, lower($4), $5, $6, $7, $8, $9, $10, $11, $12, $12, now())`,
        [`${DIR}/${DAY}.md`, K(name), line, text, f.checked ?? false, f.due ?? null, f.do ?? null, f.done ?? null, f.priority ?? null, f.someday ?? false, f.waiting ?? false, PREV],
      );
    await task("due", 1, "Send Dana the fixture format", { due: DAY, priority: 2 });
    await task("carried", 2, "Renew the passport", { due: PREV, priority: 1 });
    await task("planned", 3, "Draft the Q4 plan", { do: DAY });
    await task("later", 4, "Book the room for Thursday", { due: NEXT });
    await task("undated", 5, "Read the paper someone sent", {});
    await task("someday", 6, "Learn the cello", { due: PREV, someday: true });
    await task("donetoday", 7, "Call the dentist", { due: DAY, checked: true, done: DAY });
    await task("donebefore", 8, "Pay the plumber", { due: PREV, checked: true, done: PREV });
    await task("waiting", 9, "Hear back from the landlord", { due: NEXT, waiting: true });

    const work = async (name: string, status: string, extra: { due?: string; closed_at?: string; blocked_by?: string } = {}) => {
      const { rows } = await pool.query(
        `INSERT INTO work (title, kind, status, created_by, due, closed_at, meta) VALUES ($1, 'task', $2, 'user', $3, $4, $5::jsonb) RETURNING id`,
        [`${MARK} ${name} ${suffix}`, status, extra.due ?? null, extra.closed_at ?? null, JSON.stringify(extra.blocked_by ? { blocked_by: extra.blocked_by } : {})],
      );
      workIds[name] = String(rows[0].id);
    };
    await work("due", "in_progress", { due: DAY });
    await work("blocked", "blocked", { blocked_by: `vault:${DIR}/${DAY}.md#^${K("due")}` });
    await work("closedtoday", "closed", { closed_at: `${DAY}T15:00:00Z` });
    await work("undated", "in_progress");
    await work("later", "open", { due: NEXT });

    // one meeting on the day in the owner's zone, one the evening before, as a calendar sync leaves them
    await pool.query(
      `INSERT INTO calendar_events (connection, event_id, starts_at, ends_at, title, attendees, self_status) VALUES
         ('itest-today', $1, $3, $4, 'Standup', '[{"name": "Dana", "email": "dana@example.com", "self": false}]'::jsonb, 'accepted'),
         ('itest-today', $2, $5, $6, 'Dinner', '[]'::jsonb, NULL)`,
      [`evt-${suffix}-day`, `evt-${suffix}-eve`, `${DAY}T14:30:00Z`, `${DAY}T14:45:00Z`, `${PREV}T23:00:00Z`, `${DAY}T01:00:00Z`],
    );

    // two of the day's three machine files are written
    await vault.write(DAY_FILES.brief(DAY), Buffer.from("# Brief\n"), { principal: "morning-brief", message: "seed" });
    await vault.write(DAY_FILES.plan(DAY), Buffer.from("# Plan\n"), { principal: "plan-tomorrow", message: "seed" });
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM vault_tasks WHERE path LIKE $1`, [`${DIR}/%`]);
    await pool.query(`DELETE FROM work WHERE id = ANY($1::bigint[])`, [Object.values(workIds)]);
    await pool.query(`DELETE FROM calendar_events WHERE connection = 'itest-today'`);
    await pool.query(`DELETE FROM today_order WHERE day IN ($1::date, $2::date, $3::date)`, [DAY, NEXT, PREV]);
    await pool.query(`DELETE FROM runs WHERE kind = 'today_order' AND meta->>'day' IN ($1, $2, $3)`, [DAY, NEXT, PREV]);
    await pool.query(`DELETE FROM agents WHERE id = $1`, [agentId]);
    await pool.query(`DELETE FROM owner_tokens WHERE label = $1`, [MARK]).catch(() => undefined);
    await pool.query(`DELETE FROM auth_sessions WHERE passkey_id = ANY($1)`, [passkeyIds]).catch(() => undefined);
    await pool.query(`DELETE FROM passkeys WHERE id = ANY($1)`, [passkeyIds]).catch(() => undefined);
    await new Promise<void>((r) => server.close(() => r()));
    await pool.end();
    for (const dir of inboxDirs) rmSync(dir, { recursive: true, force: true });
  });

  const local = { authorization: `Bearer ${localOwnerToken}` };
  async function get(path: string, headers: Record<string, string> = local) {
    const r = await fetch(`${base}${path}`, { headers });
    return { status: r.status, body: (await r.json()) as Body };
  }
  async function put(body: unknown, headers: Record<string, string> = local) {
    const r = await fetch(`${base}/api/today/order`, { method: "PUT", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as Body };
  }
  const stored = async (day = DAY) => (await pool.query(`SELECT task_key FROM today_order WHERE day = $1::date ORDER BY position`, [day])).rows.map((r) => String(r.task_key));
  const mine = (rows: Body[]) => rows.filter((r) => String(r.path ?? "").startsWith(`${DIR}/`));
  const myWork = (rows: Body[]) => rows.filter((r) => Object.values(workIds).includes(String(r.id)));
  const nameOf = (id: string) => Object.entries(workIds).find(([, v]) => v === id)?.[0];

  // ---- U2: the four, on each of the three --------------------------------------------------

  const doors: [string, (h: Record<string, string>) => Promise<{ status: number; body: Body }>][] = [
    ["GET /api/today", (h) => get(`/api/today?date=${DAY}`, h)],
    ["GET /api/vault-tasks", (h) => get(`/api/vault-tasks?where=${encodeURIComponent(`due <= ${DAY}`)}`, h)],
    ["PUT /api/today/order", (h) => put({ date: NEXT, task_keys: [] }, h)],
  ];
  describe.each(doors)("who may reach %s (U2)", (_route, call) => {
    it("no credential is the uniform 401", async () => {
      const r = await call({});
      expect(r.status).toBe(401);
      expect(r.body).toEqual({ error: { code: "unauthenticated", message: "authentication required" } });
    });
    it("an agent bearer is refused 403 with the canonical answer", async () => {
      const r = await call({ authorization: `Bearer ${agentToken}` });
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe("forbidden");
    });
    it("the capture owner token is refused 403 — capture is its whole reach", async () => {
      const r = await call({ authorization: `Bearer ${ownerToken}` });
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe("forbidden");
    });
    it("the local owner token reaches it, and so does a passkey session (reach `owner`)", async () => {
      expect((await call(local)).status).toBe(200);
      expect((await call({ cookie: sessionCookie })).status).toBe(200);
    });
  });

  it("the refused credentials wrote no order", async () => {
    await put({ date: NEXT, task_keys: [] }, { authorization: `Bearer ${agentToken}` });
    expect(await stored(NEXT)).toEqual([]);
  });

  // ---- GET /api/today ----------------------------------------------------------------------

  describe("GET /api/today composes the day", () => {
    it("answers in the F-7 fixture's shape: the same top-level fields", async () => {
      const r = await get(`/api/today?date=${DAY}`);
      expect(r.status).toBe(200);
      expect(Object.keys(r.body).sort()).toEqual(Object.keys(FIXTURE.body).sort());
      expect(r.body.date).toBe(DAY);
      expect(Number.isNaN(Date.parse(r.body.as_of))).toBe(false);
    });

    it("tasks: open lines owed on or before the day in priority order, then lines ticked on it — never a later day, an undated line, someday, or an older tick", async () => {
      const { body } = await get(`/api/today?date=${DAY}`);
      const keys = mine(body.tasks).map((t) => t.task_key);
      // p1 carried, p2 due, unset (3) planned; then the tick of the day
      expect(keys).toEqual([K("carried"), K("due"), K("planned"), K("donetoday")]);
      const due = mine(body.tasks).find((t) => t.task_key === K("due"))!;
      // a task row is vault_tasks_query's row as it stands — every field the fixture names
      for (const field of Object.keys((FIXTURE.body.tasks as Body[])[0]!)) expect(due, field).toHaveProperty(field);
      expect(mine(body.tasks).find((t) => t.task_key === K("carried"))!.row_flags).toEqual(expect.arrayContaining(["overdue", "carried"]));
    });

    it("the preset is the one filter language: each half compiles with compileTaskFilter", () => {
      const p = todayPreset(DAY);
      expect(compileTaskFilter(p.open, { timeZone: ZONE }).ok).toBe(true);
      expect(compileTaskFilter(p.done, { timeZone: ZONE }).ok).toBe(true);
    });

    it("work: waiting on the owner, blocked, due, overdue and closed on the day — not an undated in-progress row or a later one", async () => {
      const { body } = await get(`/api/today?date=${DAY}`);
      const names = myWork(body.work).map((w) => nameOf(String(w.id))).sort();
      expect(names).toEqual(["blocked", "closedtoday", "due"]);
      const blocked = myWork(body.work).find((w) => nameOf(String(w.id)) === "blocked")!;
      expect(blocked.blocked_by_task).toBe("Send Dana the fixture format");
      expect(blocked.row_flags).toEqual(expect.arrayContaining(["waiting_on_me", "blocked"]));
      for (const field of Object.keys((FIXTURE.body.work as Body[])[0]!)) expect(blocked, field).toHaveProperty(field);
    });

    it("events: the day's meetings in the owner's zone — the evening before is not on it", async () => {
      const { body } = await get(`/api/today?date=${DAY}`);
      const ours = (body.events as Body[]).filter((e) => e.connection === "itest-today");
      expect(ours.map((e) => e.event_id)).toEqual([`evt-${suffix}-day`]);
      expect(ours[0]!.title).toBe("Standup");
      for (const field of Object.keys((FIXTURE.body.events as Body[])[0]!)) expect(ours[0], field).toHaveProperty(field);
    });

    it("brief, standup, plan: the paths of the files that are there, null for the one that is not", async () => {
      const { body } = await get(`/api/today?date=${DAY}`);
      expect(body.brief).toBe(`Journal/Brief/${DAY}.md`);
      expect(body.standup).toBeNull();
      expect(body.plan).toBe(`Journal/Plan/${DAY}.md`);
    });

    it("no date is today in METISTRY_TZ (the configured zone, never TZ)", async () => {
      const { status, body } = await get("/api/today");
      expect(status).toBe(200);
      expect([calendarDate(new Date(), ZONE), calendarDate(new Date(Date.now() - 5000), ZONE)]).toContain(body.date);
    });

    it("a date that is not a calendar day, or another parameter, is 400", async () => {
      expect((await get("/api/today?date=2001-02-30")).status).toBe(400);
      expect((await get("/api/today?date=tomorrow")).status).toBe(400);
      const r = await get(`/api/today?date=${DAY}&where=overdue`);
      expect(r.status).toBe(400);
      expect(r.body.error.message).toContain("where");
    });
  });

  // ---- PUT /api/today/order ----------------------------------------------------------------

  describe("PUT /api/today/order", () => {
    it("stores the owner's order, and GET /api/today serves it", async () => {
      const order = [`work:${workIds.blocked}`, K("planned"), K("due")];
      const r = await put({ date: DAY, task_keys: order });
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ ok: true, date: DAY, order });
      expect(await stored()).toEqual(order);
      expect((await get(`/api/today?date=${DAY}`)).body.order).toEqual(order);
      const audit = await pool.query(`SELECT ok, meta FROM runs WHERE kind = 'today_order' AND tool = 'order' AND meta->>'day' = $1 ORDER BY id DESC LIMIT 1`, [DAY]);
      expect(audit.rows[0]).toMatchObject({ ok: true, meta: { day: DAY, outcome: "stored", keys: 3 } });
      expect(JSON.stringify(audit.rows[0].meta)).not.toContain(K("due")); // the count, never the keys
    });

    it("replaces the day's order whole: a key left out loses its place; the same body twice is the same order; [] clears", async () => {
      await put({ date: DAY, task_keys: [K("due"), K("carried"), K("donetoday")] });
      await put({ date: DAY, task_keys: [K("carried"), K("due")] });
      expect(await stored()).toEqual([K("carried"), K("due")]);
      await put({ date: DAY, task_keys: [K("carried"), K("due")] });
      expect(await stored()).toEqual([K("carried"), K("due")]);
      expect((await put({ date: DAY, task_keys: [] })).status).toBe(200);
      expect(await stored()).toEqual([]);
    });

    it("**order keys outside the day are refused**, named, and nothing is written", async () => {
      await put({ date: DAY, task_keys: [K("due")] });
      const outside = [
        K("later"), // a real line — owed on the next day
        K("donebefore"), // a real line — ticked the day before
        K("someday"), // a real line — deferred to no day
        K("undated"), // a real line — owed on no day
        `work:${workIds.later}`, // a real work row — due the next day
        `work:${workIds.undated}`, // a real work row — the Board's, not the day's
        "mt-nobodyhasthis", // a key no line has
        "work:999999999999", // a work row that does not exist
      ];
      for (const key of outside) {
        const r = await put({ date: DAY, task_keys: [K("carried"), key] });
        expect(r.status, key).toBe(400);
        expect(r.body.error.code, key).toBe("invalid_request");
        expect(r.body.error.message, key).toContain(key);
        expect(r.body.outside, key).toEqual([key]);
        expect(await stored(), key).toEqual([K("due")]);
      }
      const refused = await pool.query(`SELECT count(*)::int AS n FROM runs WHERE kind = 'today_order' AND tool = 'order' AND NOT ok AND meta->>'day' = $1 AND meta->>'outcome' = 'outside_day'`, [DAY]);
      expect(refused.rows[0].n).toBeGreaterThanOrEqual(outside.length);
    });

    it("a key of this day is outside an earlier day: the day in the body is the day judged", async () => {
      const r = await put({ date: PREV, task_keys: [K("carried"), K("due")] });
      expect(r.status).toBe(400);
      expect(r.body.outside).toEqual([K("due")]);
      expect(await stored(PREV)).toEqual([]);
      // …and a later day holds it, carried, beside that day's own line
      expect((await put({ date: NEXT, task_keys: [K("later"), K("due")] })).status).toBe(200);
      expect(await stored(NEXT)).toEqual([K("later"), K("due")]);
    });

    it("refuses a body that is not an order — each 400, nothing written", async () => {
      await put({ date: DAY, task_keys: [K("due")] });
      const bad: [unknown, string][] = [
        [[K("due")], "JSON object"],
        [{ task_keys: [K("due")] }, "date"],
        [{ date: "2001-02-30", task_keys: [K("due")] }, "date"],
        [{ date: DAY }, "task_keys must be an array"],
        [{ date: DAY, task_keys: K("due") }, "task_keys must be an array"],
        [{ date: DAY, task_keys: [K("due"), 7] }, "not a key"],
        [{ date: DAY, task_keys: ["drop table today_order"] }, "not a key"],
        [{ date: DAY, task_keys: ["work:0"] }, "not a key"],
        [{ date: DAY, task_keys: [K("due"), K("due")] }, "more than once"],
        [{ date: DAY, task_keys: [K("due")], position: 1 }, "unknown field position"],
        [{ date: DAY, task_keys: Array.from({ length: 1001 }, (_, i) => `mt-x${i}`) }, "at most 1000"],
      ];
      for (const [body, says] of bad) {
        const r = await put(body);
        expect(r.status, JSON.stringify(body).slice(0, 80)).toBe(400);
        expect(r.body.error.message, JSON.stringify(body).slice(0, 80)).toContain(says);
      }
      const notJson = await fetch(`${base}/api/today/order`, { method: "PUT", headers: { "content-type": "application/json", ...local }, body: "{" });
      expect(notJson.status).toBe(400);
      expect(await stored()).toEqual([K("due")]);
    });
  });

  // ---- GET /api/vault-tasks ----------------------------------------------------------------

  describe("GET /api/vault-tasks", () => {
    const q = (params: Record<string, string>) => get(`/api/vault-tasks?${new URLSearchParams(params)}`);

    it("compiles where and order with compileTaskFilter and answers vault_tasks_query's rows", async () => {
      const r = await q({ where: `due <= ${DAY}`, order: "priority" });
      expect(r.status).toBe(200);
      expect(Object.keys(r.body).sort()).toEqual(["as_of", "more", "rows", "where"]);
      expect(r.body.where).toBe(`due <= ${DAY}`);
      // the raw filter, not Today's preset: the someday line with a date is in it (unset priority sorts as 3)
      expect(mine(r.body.rows).map((t) => t.task_key)).toEqual([K("carried"), K("due"), K("someday")]);
    });

    it("Waiting on Others is the `waiting` flag", async () => {
      const r = await q({ where: "waiting" });
      expect(r.status).toBe(200);
      expect(mine(r.body.rows).map((t) => t.task_key)).toEqual([K("waiting")]);
    });

    it("the saved views' flags run: carried or overdue; someday finds the deferred line", async () => {
      const slipping = await q({ where: "carried or overdue" });
      expect(slipping.status).toBe(200);
      expect(mine(slipping.body.rows).map((t) => t.task_key)).toEqual(expect.arrayContaining([K("carried"), K("someday")]));
      const someday = await q({ where: "someday" });
      expect(mine(someday.body.rows).map((t) => t.task_key)).toEqual([K("someday")]);
    });

    it("pages: `more` says there is another page, and offset reaches it", async () => {
      const where = `due <= ${NEXT} or do <= ${NEXT}`;
      const all = mine((await q({ where, limit: "500" })).body.rows);
      expect(all.length).toBeGreaterThanOrEqual(5);
      const first = await q({ where, limit: "2" });
      expect(first.body.rows).toHaveLength(2);
      expect(first.body.more).toBe(true);
    });

    it("a filter outside the grammar is 400 with the parser's refusal, naming the token — never guessed or passed through", async () => {
      for (const where of ["overdue; DROP TABLE vault_tasks", "priority <= p9", "colour = red", "due <= today and waiting or overdue"]) {
        const r = await q({ where });
        expect(r.status, where).toBe(400);
        expect(r.body.error.code, where).toBe("invalid_request");
        const expected = compileTaskFilter({ where }, { timeZone: ZONE });
        expect(expected.ok, where).toBe(false);
        if (!expected.ok) expect(r.body.error.message, where).toBe(expected.error);
      }
    });

    it("limit, offset and unknown parameters are checked", async () => {
      expect((await q({ limit: "0" })).status).toBe(400);
      expect((await q({ limit: "501" })).status).toBe(400);
      expect((await q({ limit: "2.5" })).status).toBe(400);
      expect((await q({ offset: "-1" })).status).toBe(400);
      expect((await q({ path_prefix: "Journal" })).status).toBe(400); // the scope is the route's, never the caller's
      expect((await q({ where: "x".repeat(501) })).status).toBe(400);
    });
  });
});
