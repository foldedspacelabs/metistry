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
import { DAY_FILES, SAVED_TASK_VIEWS, todayPreset } from "../src/today-routes.js";
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
// Add to Today (X-12): `work` rows of its own, kind `issue`, the shape T4-24's sync leaves.
// Two issues — one the U2 door check presses (its exact capture state is not this file's
// business), one the dedicated tests below own outright, so neither disturbs the other's count.
const LINEAR_TEAM = `T${suffix.toUpperCase()}`;
const LINEAR_KEY = `${LINEAR_TEAM}-1`;
const LINEAR_KEY2 = `${LINEAR_TEAM}-2`;
const LINEAR_KEY_UNKNOWN = `${LINEAR_TEAM}-9`; // never inserted — the 404 case
const LINEAR_REF = `linear:${LINEAR_KEY}`;
const LINEAR_REF2 = `linear:${LINEAR_KEY2}`;
const LINEAR_TITLE2 = `${LINEAR_KEY2} · ${MARK} fixture`;
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
    const task = (name: string, line: number, text: string, f: { due?: string; do?: string; checked?: boolean; done?: string; priority?: number; someday?: boolean; waiting?: boolean; assigned?: string }) =>
      pool.query(
        `INSERT INTO vault_tasks (path, task_key, anchor, line_no, text, text_norm, checked, due, scheduled_for, done_on, priority, someday, waiting, assigned, parsed_on, first_seen_on, last_seen_at)
         VALUES ($1, $2, $2, $3, $4, lower($4), $5, $6, $7, $8, $9, $10, $11, $12, $13, $13, now())`,
        [`${DIR}/${DAY}.md`, K(name), line, text, f.checked ?? false, f.due ?? null, f.do ?? null, f.done ?? null, f.priority ?? null, f.someday ?? false, f.waiting ?? false, f.assigned ?? null, PREV],
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
    // two undated lines that name a person (ruling 14): one the owner owes, one they wait on
    await task("owed", 10, "Send Dana the notes", { assigned: "People/Dana.md" });
    await task("waitingon", 11, "Hear from Sam about the lease", { assigned: "People/Sam.md", waiting: true });

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

    // Add to Today's own rows: an `issue`, as the Linear sync leaves it (T4-24) — not a `task`, so neither appears in `day_work`'s own rows above.
    await pool.query(
      `INSERT INTO work (title, kind, status, created_by, external_ref, meta) VALUES ($1, 'issue', 'open', 'user', $2, '{}'::jsonb), ($3, 'issue', 'open', 'user', $4, '{}'::jsonb)`,
      [`${LINEAR_KEY} · ${MARK} fixture`, LINEAR_REF, LINEAR_TITLE2, LINEAR_REF2],
    );

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
    await pool.query(`DELETE FROM work WHERE external_ref = ANY($1::text[])`, [[LINEAR_REF, LINEAR_REF2]]);
    await pool.query(`DELETE FROM inbox WHERE idempotency_principal = 'tracker:linear' AND idempotency_key = ANY($1::text[])`, [[LINEAR_REF, LINEAR_REF2]]);
    await pool.query(`DELETE FROM runs WHERE kind = 'today_add' AND meta->>'key' = ANY($1::text[])`, [[LINEAR_KEY, LINEAR_KEY2]]);
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
  async function post(path: string, body: unknown, headers: Record<string, string> = local) {
    const r = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
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
    ["POST /api/today/add", (h) => post("/api/today/add", { key: LINEAR_KEY }, h)],
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
      expect(mine(r.body.rows).map((t) => t.task_key)).toEqual([K("waiting"), K("waitingon")]);
    });

    // Ruling 14 (X-14): the saved views are real `where:` strings now — each
    // compiles to one run of vault_tasks_query and the route serves it as typed
    const view = (name: string) => SAVED_TASK_VIEWS.find((v) => v.name === name)!.where;

    it("All's saved views are Slipping, Owed and Waiting on Others, and each compiles", () => {
      expect(SAVED_TASK_VIEWS.map((v) => v.name)).toEqual(["Slipping", "Owed", "Waiting on Others"]);
      for (const v of SAVED_TASK_VIEWS) expect(compileTaskFilter({ where: v.where }, { timeZone: ZONE }).ok, v.name).toBe(true);
    });

    it("Slipping: carried three or more days, overdue, or names a person — the undated, unnamed line is not in it", async () => {
      const r = await q({ where: view("Slipping"), limit: "500" });
      expect(r.status).toBe(200);
      // the day is 2001, so every dated open line is long carried; the ticked lines are out of scope
      expect(mine(r.body.rows).map((t) => t.task_key)).toEqual([K("due"), K("carried"), K("planned"), K("later"), K("someday"), K("waiting"), K("owed"), K("waitingon")]);
      expect(mine(r.body.rows).find((t) => t.task_key === K("owed"))!.row_flags).toContain("names_person");
    });

    it("Owed: names a person and is the owner's move — the line waiting on Sam is not owed", async () => {
      const r = await q({ where: view("Owed") });
      expect(r.status).toBe(200);
      expect(mine(r.body.rows).map((t) => t.task_key)).toEqual([K("owed")]);
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
      for (const where of ["overdue; DROP TABLE vault_tasks", "priority <= p9", "colour = red", "due <= today and waiting or overdue", "not colour", "not due <= today", "carried >= 0", "not waiting; DROP TABLE vault_tasks"]) {
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

  // ---- POST /api/today/add (X-12, ruling 11) -----------------------------------------------
  //
  // `LINEAR_KEY2` is this block's own issue, untouched by the U2 door check above (which
  // presses `LINEAR_KEY` and does not care what state that leaves it in) — so every "nothing
  // was written" assertion here reads a count this block alone can move, and the tests that
  // refuse before a capture run before the one that succeeds.

  describe("POST /api/today/add", () => {
    const add = (body: unknown) => post("/api/today/add", body);
    const captured = async (ref = LINEAR_REF2) => (await pool.query(`SELECT count(*)::int AS n FROM inbox WHERE idempotency_principal = 'tracker:linear' AND idempotency_key = $1`, [ref])).rows[0].n as number;

    it("an issue the sync has not seen is 404, naming it — nothing written", async () => {
      const r = await add({ key: LINEAR_KEY_UNKNOWN });
      expect(r.status).toBe(404);
      expect(r.body.error.code).toBe("not_found");
      expect(r.body.error.message).toContain(LINEAR_KEY_UNKNOWN);
      expect(await captured(`linear:${LINEAR_KEY_UNKNOWN}`)).toBe(0);
    });

    it("a key that is not a Linear key (TEAM-123) is 400, and nothing is written", async () => {
      const r = await add({ key: "not-a-key" });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe("invalid_request");
      expect(await captured("linear:not-a-key")).toBe(0);
    });

    it("**an item added to a day outside Today's window is refused**, and nothing is written", async () => {
      for (const date of [DAY, PREV, NEXT]) {
        const r = await add({ key: LINEAR_KEY2, date });
        expect(r.status, date).toBe(400);
        expect(r.body.error.code, date).toBe("invalid_request");
        expect(r.body.error.message, date).toContain("outside Today's window");
        expect(r.body.error.message, date).toContain(date);
      }
      expect(await captured()).toBe(0);
    });

    it("refuses a body that is not an add — each 400, nothing written", async () => {
      const bad: [unknown, string][] = [
        [{}, "key is required"],
        [{ key: "" }, "key is required"],
        [{ key: 7 }, "key is required"],
        [{ key: LINEAR_KEY2, date: "2001-02-30" }, "date must be a calendar day"],
        [{ key: LINEAR_KEY2, date: "tomorrow" }, "date must be a calendar day"],
        [{ key: LINEAR_KEY2, where: "overdue" }, "unknown field where"],
      ];
      for (const [body, says] of bad) {
        const r = await add(body);
        expect(r.status, JSON.stringify(body)).toBe(400);
        expect(r.body.error.message, JSON.stringify(body)).toContain(says);
      }
      const notJson = await fetch(`${base}/api/today/add`, { method: "POST", headers: { "content-type": "application/json", ...local }, body: "{" });
      expect(notJson.status).toBe(400);
      expect(await captured()).toBe(0);
    });

    it("captures the issue's task line for today, through T4-24's own service", async () => {
      const r = await add({ key: LINEAR_KEY2 });
      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(true);
      expect(r.body.replayed).toBe(false);
      // this harness's sink is a bare `dirSink` (no vault prefix), so the path
      // this test server records is the sink's own timestamped filename, not
      // production's `Inbox/…` (which `vaultSink`'s prefix gives it, main.ts)
      expect(r.body.path).toMatch(new RegExp(`^\\d+-linear-${LINEAR_KEY2}\\.md$`));
      expect(r.body.line).toContain(LINEAR_TITLE2);
      expect(r.body.line).toContain(`linear:${LINEAR_KEY2}`);
      expect(typeof r.body.sha256).toBe("string");
      const inbox = await pool.query(`SELECT source, source_agent, note FROM inbox WHERE idempotency_principal = 'tracker:linear' AND idempotency_key = $1`, [LINEAR_REF2]);
      expect(inbox.rows[0]).toMatchObject({ source: "linear", source_agent: null });
      const audit = await pool.query(`SELECT ok, meta FROM runs WHERE kind = 'today_add' AND tool = 'add' AND meta->>'key' = $1 ORDER BY id DESC LIMIT 1`, [LINEAR_KEY2]);
      expect(audit.rows[0]).toMatchObject({ ok: true, meta: { key: LINEAR_KEY2, outcome: "captured" } });
    });

    it("a second Add to Today for the same issue returns the FIRST capture and writes nothing new", async () => {
      const first = await add({ key: LINEAR_KEY2 });
      const second = await add({ key: LINEAR_KEY2 });
      expect(second.status).toBe(200);
      expect(second.body).toEqual({ ...first.body, replayed: true });
      expect(await captured()).toBe(1);
    });
  });
});
