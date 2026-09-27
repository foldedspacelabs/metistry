// The Scheduled doors (design-build-plan §2.1, §2.5; T3-3), over real sockets
// against the scratch database, with the product's own routine and collector
// manifests loaded exactly as the console loads them.
//
// Misuse first (invariant 8, U2): no credential, an agent bearer and the
// capture owner token are refused on every Scheduled route; the local owner
// token reaches every one; **the assignment route refuses a passkey
// session**. Then the ticket's own: **a product manifest is never written**
// (every write any door makes lands on `.metistry/scheduled.yaml` and nowhere
// else, and every manifest's bytes are what they were), **a paused routine's
// Run Now says why**, and the file's rules — validated, never half-applied,
// comments kept, an invalid file never rewritten.
//
// The overlay lives in an in-memory vault standing in for the reconciler's
// bridge (the one writer), and is read back from it — so what a door answers
// is what the next read of the file says.
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { memoryVault } from "@foldedspacelabs/metistry-artifacts";
import { CLIENT_API, isLocalRoute, mintToken, routeKey, type PreflightMiss } from "@foldedspacelabs/metistry-core";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";
import { loadCollectors } from "@metistry-apps/collectors";
import { loadRoutines } from "@metistry-apps/routines";
import { makeServer } from "../src/server.js";
import { loadSchedules, overlayFromText, runNow, type ScheduledCollector } from "../src/runner.js";
import { SCHEDULED_PATH } from "../src/profile-tidy.js";
import type { ScheduledAdmin } from "../src/scheduled-routes.js";
import * as store from "../src/auth-store.js";
import * as agents from "../src/agents.js";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url));
const policy = { idleDays: 30, maxDays: 365 };
const MARK = "itest-scheduled";
const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const suffix = mintToken(6).toLowerCase().replaceAll(/[^a-z0-9]/g, "").slice(0, 6) || "x";
/** A routine of this suite's own, so Run Now's rows are nobody else's. */
const PROBE = `probe-${suffix}`;
/** One that needs an engine, for the budget half of preflight. */
const COSTLY = `costly-${suffix}`;
const NOW = new Date("2026-09-28T13:05:00Z");

const SCHEDULED_ROWS = CLIENT_API.filter((r) => r.served && r.path.startsWith("/api/scheduled"));

async function manifestHashes(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const kind of ["routines", "collectors"]) {
    for (const d of await readdir(join(REPO, kind), { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const p = join(REPO, kind, d.name, "manifest.yaml");
      try {
        out.set(p, createHash("sha256").update(await readFile(p)).digest("hex"));
      } catch {
        /* no manifest in that directory */
      }
    }
  }
  return out;
}

describe.skipIf(!hasDb)("the Scheduled doors", () => {
  let pool: pg.Pool;
  let server: ReturnType<typeof makeServer>;
  let base: string;
  let sessionCookie: string;
  let ownerToken: string;
  let agentToken: string;
  const localOwnerToken = mintToken();
  const agentId = `itest-sched-${suffix}`;
  const passkeyIds: string[] = [];
  const vault = memoryVault();
  /** Every path any door asked the bridge to write. */
  const writes: { path: string; principal: string }[] = [];
  let probeRuns = 0;
  let budget: PreflightMiss | null = null;
  let components: ScheduledCollector[];

  const readOverlay = async (): Promise<Buffer | null> => (await vault.read(SCHEDULED_PATH))?.content ?? null;
  const setOverlay = async (text: string): Promise<void> => {
    const cur = await vault.read(SCHEDULED_PATH);
    if (cur) await vault.delete(SCHEDULED_PATH, { principal: "user", message: "reset" });
    if (text !== "") await vault.write(SCHEDULED_PATH, Buffer.from(text), { principal: "user", message: "seed" });
  };
  const overlayText = async (): Promise<string> => (await readOverlay())?.toString("utf8") ?? "";

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
    const queries = new QueryStore(pool);
    await queries.loadDir(join(REPO, "seed/queries"));
    const loaded = [
      ...(await loadSchedules((await loadCollectors({ home: join(REPO, "collectors") })).collectors)),
      ...(await loadSchedules((await loadRoutines({ home: join(REPO, "routines") })).routines)),
    ];
    const probe: ScheduledCollector = {
      name: PROBE,
      dir: `routines/${PROBE}`,
      schedule: { every: "1h" },
      runKind: "routine_run",
      requires: { env: [], reachable: [], engine: false },
      unit: { name: PROBE, section: "routines", displayName: "Probe", schedule: { every: "1h" }, config: {}, raise: {} },
      run: async () => (probeRuns++, 1),
    };
    const costly: ScheduledCollector = {
      ...probe,
      name: COSTLY,
      dir: `routines/${COSTLY}`,
      requires: { env: [], reachable: [], engine: false },
      unit: { ...probe.unit!, name: COSTLY, displayName: "Costly" },
      run: async () => {
        throw new Error("a blocked routine must never run");
      },
    };
    components = [...loaded, probe, costly];
    const overlayRead = async () => overlayFromText((await readOverlay())?.toString("utf8") ?? "");
    const admin: ScheduledAdmin = {
      components,
      overlay: {
        read: readOverlay,
        write: async (content, expected, message) => {
          writes.push({ path: SCHEDULED_PATH, principal: "user" });
          await vault.write(SCHEDULED_PATH, content, { principal: "user", message }, expected);
        },
      },
      profile: async () => ({ timezone: "America/New_York", working_days: ["mon", "tue", "wed", "thu", "fri"] }),
      timeZone: "Etc/UTC",
      runNow: (name) =>
        runNow(pool, components, name, {}, {
          env: {},
          scheduled: overlayRead,
          // the budget half of preflight, asked only of the component that would spend
          budget: async () => budget,
        }),
      actorExists: async (id) => id === agentId || id === "researcher",
      now: () => NOW,
    };
    server = makeServer(pool, queries, {
      origin: "http://127.0.0.1:0",
      inboxDir: join(tmpdir(), `metistry-itest-scheduled-${suffix}`),
      policy,
      secureCookies: false,
      localOwner: { token: localOwnerToken, trusted: [] },
      scheduled: admin,
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const pkId = `${MARK}-${mintToken(8)}`;
    passkeyIds.push(pkId);
    await store.storePasskey(pool, { id: pkId, publicKey: new Uint8Array([1]), signCount: 0, transports: [], origin: "t", label: MARK });
    sessionCookie = `metistry_session=${await store.issueSession(pool, pkId, policy)}`;
    ownerToken = await store.mintOwnerToken(pool, MARK);
    agentToken = (await agents.createAgent(pool, { id: agentId, display_name: "itest scheduled" })).token;
  });

  beforeEach(async () => {
    await setOverlay("");
    writes.length = 0;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM runs WHERE component = ANY($1)`, [[PROBE, COSTLY]]);
    await pool.query(`DELETE FROM agents WHERE id = $1`, [agentId]);
    await pool.query(`DELETE FROM owner_tokens WHERE label = $1`, [MARK]).catch(() => undefined);
    await pool.query(`DELETE FROM auth_sessions WHERE passkey_id = ANY($1)`, [passkeyIds]).catch(() => undefined);
    await pool.query(`DELETE FROM passkeys WHERE id = ANY($1)`, [passkeyIds]).catch(() => undefined);
    await new Promise<void>((r) => server.close(() => r()));
    await pool.end();
  });

  const LOCAL = { authorization: `Bearer ${localOwnerToken}` };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function call(method: string, path: string, headers: Record<string, string> = LOCAL, body?: unknown): Promise<{ status: number; body: any }> {
    const bodied = body !== undefined;
    const r = await fetch(base + path, { method, headers: { ...headers, ...(bodied ? { "content-type": "application/json" } : {}) }, ...(bodied ? { body: JSON.stringify(body) } : {}) });
    const text = await r.text();
    return { status: r.status, body: text === "" ? null : JSON.parse(text) };
  }
  const sample = (path: string) => path.replace(":name", path.includes("/syncs/") ? "github-state" : "morning-brief");
  const bodyOf = (method: string) => (method === "GET" || method === "DELETE" ? undefined : {});

  // ---- U2 --------------------------------------------------------------------------

  it("serves the eleven Scheduled rows of the table, one of them local", () => {
    expect(SCHEDULED_ROWS).toHaveLength(11);
    expect(SCHEDULED_ROWS.filter(isLocalRoute).map(routeKey)).toEqual(["PUT /api/scheduled/routines/:name/assignment"]);
  });

  it("U2: no credential is the uniform 401; an agent bearer and the capture owner token are the uniform 403 — and nothing is written", async () => {
    for (const r of SCHEDULED_ROWS) {
      const none = await call(r.method, sample(r.path), {}, bodyOf(r.method));
      expect(none.status, routeKey(r)).toBe(401);
      expect(none.body).toEqual({ error: { code: "unauthenticated", message: "authentication required" } });
      for (const bearer of [agentToken, ownerToken]) {
        const p = await call(r.method, sample(r.path), { authorization: `Bearer ${bearer}` }, bodyOf(r.method));
        expect(p.status, routeKey(r)).toBe(403);
        expect(p.body, routeKey(r)).toEqual({ error: { code: "forbidden", message: "not granted" } });
      }
    }
    expect(writes).toEqual([]);
    expect(probeRuns).toBe(0);
  });

  it("U2: the local owner token reaches every Scheduled route; a passkey session every owner one", async () => {
    for (const r of SCHEDULED_ROWS) {
      for (const headers of isLocalRoute(r) ? [LOCAL] : [LOCAL, { cookie: sessionCookie }]) {
        const p = await call(r.method, sample(r.path), headers, bodyOf(r.method));
        expect([401, 403], `${routeKey(r)}: ${JSON.stringify(p.body)}`).not.toContain(p.status);
      }
    }
  });

  it("**the assignment route refuses a passkey session** — 403 local_only naming the Mac app, and nothing is written", async () => {
    await setOverlay(`routines:\n  weekly-digest:\n    actor: researcher\n    task: Summarise the week\n    schedule: { days: [fri], at: ["16:00"] }\n`);
    const before = await overlayText();
    const body = { actor: agentId, task: "Something else entirely", schedule: { days: ["mon"], at: ["07:00"] } };
    const p = await call("PUT", "/api/scheduled/routines/weekly-digest/assignment", { cookie: sessionCookie }, body);
    expect(p.status).toBe(403);
    expect(p.body.error.code).toBe("local_only");
    expect(p.body.error.message).toContain("Mac app");
    expect(await overlayText()).toBe(before);
    expect(writes).toEqual([]);
    // the same change from the Mac lands
    const mac = await call("PUT", "/api/scheduled/routines/weekly-digest/assignment", LOCAL, body);
    expect(mac.status).toBe(200);
    expect(mac.body.routine).toMatchObject({ name: "weekly-digest", source: "assignment", actor: agentId, task: "Something else entirely" });
  });

  // ---- reads ----------------------------------------------------------------------

  it("lists every routine and sync with the layer each field came from", async () => {
    await setOverlay(`# the owner's own words\nroutines:\n  standup:\n    schedule: { days: [mon, wed], at: ["09:30"] }\nsyncs:\n  github-state:\n    connection: github\n    every: 1h\n`);
    const r = await call("GET", "/api/scheduled");
    expect(r.status).toBe(200);
    const names = r.body.routines.map((x: { name: string }) => x.name);
    for (const n of ["morning-brief", "standup", "knowledge-fold", "plan-tomorrow", "reply-review", "weekly-review", "inbox-drain", "claude-usage"]) expect(names).toContain(n);
    const brief = r.body.routines.find((x: { name: string }) => x.name === "morning-brief");
    expect(brief).toMatchObject({ kind: "routine", source: "product", title: "Morning Brief", is_default: true, schedule: { value: { days: "working_days", at: ["07:00"] }, origin: "default" }, held: null });
    expect(brief.days).toEqual({ value: ["mon", "tue", "wed", "thu", "fri"], origin: "profile" });
    expect(brief.time_zone).toEqual({ value: "America/New_York", origin: "profile" });
    expect(brief.next_run).toBe("2026-09-29T11:00:00.000Z"); // Tuesday 07:00 in New York
    const standup = r.body.routines.find((x: { name: string }) => x.name === "standup");
    expect(standup).toMatchObject({ is_default: false, schedule: { value: { days: ["mon", "wed"], at: ["09:30"] }, origin: "yours" } });
    expect(standup.config.template).toEqual({ value: "Templates/Standup.md", origin: "default" });
    const gh = r.body.syncs.find((x: { name: string }) => x.name === "github-state");
    expect(gh).toMatchObject({ kind: "sync", connection: "github", title: "GitHub", every: { value: "1h", origin: "yours" } });
    expect(gh.raise).toEqual({ review_requested: { value: true, origin: "default" }, assigned: { value: true, origin: "default" } });
    expect(r.body.timezone).toBe("America/New_York");
    expect(r.body.errors).toEqual([]);
  });

  it("a routine's detail carries its history from routine_history, Run Now marked", async () => {
    await pool.query(`INSERT INTO runs (component, kind, ok, cost_usd, started_at, finished_at, meta) VALUES ($1, 'routine_run', true, 0.0041, now(), now(), '{"outcome":"acted","processed":3,"trigger":"run_now"}')`, [PROBE]);
    const r = await call("GET", `/api/scheduled/routines/${PROBE}`);
    expect(r.status).toBe(200);
    expect(r.body.history[0]).toMatchObject({ ok: true, outcome: "acted", steps: 3, trigger: "run_now", cost_usd: "0.004100" });
    expect(r.body.routine.last_run).toMatchObject({ run_id: r.body.history[0].run_id, outcome: "acted" });
    // a sync is the other door — and a name nothing schedules is a 404
    expect((await call("GET", "/api/scheduled/routines/github-state")).status).toBe(404);
    expect((await call("GET", "/api/scheduled/syncs/no-such-sync")).status).toBe(404);
  });

  // ---- writes ---------------------------------------------------------------------

  it("PUT schedule writes the overlay, keeps the owner's comments, and refuses the closed shape's outsiders with nothing written", async () => {
    await setOverlay(`# keep me\nroutines:\n  weekly-review:\n    paused: true   # and me\n`);
    const ok = await call("PUT", "/api/scheduled/routines/morning-brief/schedule", LOCAL, { days: ["mon", "tue", "wed", "thu", "fri"], at: ["06:30"] });
    expect(ok.status).toBe(200);
    expect(ok.body.routine.schedule).toEqual({ value: { days: ["mon", "tue", "wed", "thu", "fri"], at: ["06:30"] }, origin: "yours" });
    const text = await overlayText();
    expect(text).toContain("# keep me");
    expect(text).toContain("# and me");
    expect(text).toContain('"06:30"');
    for (const bad of [{ every: "10m" }, { days: "weekdays", at: ["08:00"] }, { days: ["mon"], at: ["8:00"] }, "0 8 * * 1-5", { every: "1h", days: ["mon"], at: ["08:00"] }]) {
      const before = await overlayText();
      const r = await call("PUT", "/api/scheduled/routines/morning-brief/schedule", LOCAL, bad);
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect(await overlayText()).toBe(before);
    }
  });

  it("pause, then resume and Reset to Default: each lands once, and the entry goes when nothing is left in it", async () => {
    const p = await call("POST", "/api/scheduled/routines/weekly-review/pause", LOCAL, {});
    expect(p.status).toBe(200);
    expect(p.body.routine).toMatchObject({ paused: { value: true, origin: "yours" }, next_run: null, is_default: false });
    expect(await call("POST", "/api/scheduled/routines/weekly-review/pause", LOCAL, {})).toMatchObject({ status: 200 });
    expect(writes).toHaveLength(1); // the second pause changed nothing, so nothing was written
    const r = await call("POST", "/api/scheduled/routines/weekly-review/resume", LOCAL, {});
    expect(r.body.routine).toMatchObject({ paused: { value: false, origin: "default" }, is_default: true });
    expect(await overlayText()).not.toContain("weekly-review");

    await call("PUT", "/api/scheduled/routines/weekly-review/schedule", LOCAL, { days: ["sat"], at: ["10:00"] });
    const reset = await call("DELETE", "/api/scheduled/routines/weekly-review");
    expect(reset.status).toBe(200);
    expect(reset.body).toMatchObject({ ok: true, reset: true, routine: { is_default: true, schedule: { value: { days: ["sun"], at: ["18:00"] }, origin: "default" } } });
    expect(await overlayText()).not.toContain("weekly-review");
    expect((await call("DELETE", "/api/scheduled/routines/weekly-review")).body.reset).toBe(false);
    expect((await call("POST", "/api/scheduled/routines/weekly-review/pause", LOCAL, { paused: true })).status).toBe(400); // a field is refused, not ignored
  });

  it("**a product manifest is never written** — every door's every write is .metistry/scheduled.yaml, and the manifests are byte for byte what they were", async () => {
    const before = await manifestHashes();
    expect(before.size).toBeGreaterThan(8);
    const vaultWrite = vault.write.bind(vault);
    const paths: string[] = [];
    vault.write = async (path, content, intent, expected) => (paths.push(path), vaultWrite(path, content, intent, expected));
    try {
      await setOverlay(`routines:\n  weekly-digest:\n    actor: researcher\n    task: Summarise the week\n    schedule: { days: [fri], at: ["16:00"] }\nsyncs:\n  github-state:\n    connection: github\n`);
      paths.length = 0;
      const steps: [string, string, unknown][] = [
        ["PUT", "/api/scheduled/routines/standup/schedule", { days: ["mon"], at: ["08:15"] }],
        ["POST", "/api/scheduled/routines/standup/pause", {}],
        ["POST", "/api/scheduled/routines/standup/resume", {}],
        ["DELETE", "/api/scheduled/routines/standup", undefined],
        ["PUT", "/api/scheduled/routines/weekly-digest/assignment", { actor: "researcher", task: "Summarise it again", schedule: { days: ["fri"], at: ["17:00"] } }],
        ["PUT", "/api/scheduled/syncs/github-state", { every: "1h", raise: { assigned: false } }],
      ];
      for (const [method, path, body] of steps) expect((await call(method, path, LOCAL, body)).status, `${method} ${path}`).toBe(200);
      // …and a product routine's assignment is refused outright: what it runs is its manifest's
      const product = await call("PUT", "/api/scheduled/routines/morning-brief/assignment", LOCAL, { actor: "researcher", task: "Anything", schedule: { days: ["mon"], at: ["07:00"] } });
      expect(product.status).toBe(400);
      expect(product.body.error.message).toContain("a manifest is never written");
      expect(paths.length).toBeGreaterThan(0);
      expect([...new Set(paths)]).toEqual([SCHEDULED_PATH]);
    } finally {
      vault.write = vaultWrite;
    }
    expect(await manifestHashes()).toEqual(before);
  });

  it("an invalid file is never rewritten — every write is refused naming it, and the list shows its errors", async () => {
    const broken = "routines:\n  standup:\n    schedule: { every: 10m }\n";
    await setOverlay(broken);
    for (const [m, p, b] of [
      ["POST", "/api/scheduled/routines/morning-brief/pause", {}],
      ["PUT", "/api/scheduled/routines/morning-brief/schedule", { every: "1h" }],
      ["DELETE", "/api/scheduled/routines/standup", undefined],
    ] as const) {
      const r = await call(m, p, LOCAL, b);
      expect(r.status, p).toBe(400);
      expect(r.body.error.message).toContain("does not validate");
    }
    expect(await overlayText()).toBe(broken);
    const list = await call("GET", "/api/scheduled");
    expect(list.body.errors.join(" ")).toContain("routines.standup.schedule.every");
    expect(list.body.routines.find((x: { name: string }) => x.name === "standup").held).toContain("does not validate");
    expect(list.body.routines.find((x: { name: string }) => x.name === "morning-brief").held).toBeNull();
  });

  it("a New Routine's assignment: read-only grants, a live actor, and only one that exists", async () => {
    await setOverlay(`routines:\n  weekly-digest:\n    actor: researcher\n    task: Summarise the week\n    schedule: { days: [fri], at: ["16:00"] }\n`);
    const before = await overlayText();
    const base = { actor: "researcher", task: "Summarise", schedule: { days: ["fri"], at: ["16:00"] } };
    const write = await call("PUT", "/api/scheduled/routines/weekly-digest/assignment", LOCAL, { ...base, grants: { read: ["Projects"], write: ["Journal/Digest/"] } });
    expect(write.status).toBe(400);
    expect(write.body.error.message).toContain("read-only");
    expect((await call("PUT", "/api/scheduled/routines/weekly-digest/assignment", LOCAL, { ...base, actor: "nobody-here" })).status).toBe(400);
    expect((await call("PUT", "/api/scheduled/routines/weekly-digest/assignment", LOCAL, { ...base, grants: { read: [".metistry"] } })).status).toBe(400);
    expect((await call("PUT", "/api/scheduled/routines/not-yet-made/assignment", LOCAL, base)).status).toBe(404);
    expect(await overlayText()).toBe(before);
    expect((await call("DELETE", "/api/scheduled/routines/weekly-digest")).status).toBe(400); // no default to reset to
    const ok = await call("PUT", "/api/scheduled/routines/weekly-digest/assignment", LOCAL, { ...base, grants: { read: ["Projects"] } });
    expect(ok.status).toBe(200);
    expect(ok.body.routine).toMatchObject({ source: "assignment", title: "Weekly Digest", grants: { read: ["Projects"] }, next_run: null });
    expect(ok.body.routine.held).toContain("T3-8");
  });

  it("a sync's cadence, pause and raise — never its connection, never a rule it does not declare", async () => {
    const none = await call("PUT", "/api/scheduled/syncs/github-state", LOCAL, { every: "1h" });
    expect(none.status).toBe(400);
    expect(none.body.error.message).toContain("names no connection");
    await setOverlay(`syncs:\n  github-state:\n    connection: github\n`);
    const before = await overlayText();
    expect((await call("PUT", "/api/scheduled/syncs/github-state", LOCAL, { connection: "other" })).status).toBe(400);
    expect((await call("PUT", "/api/scheduled/syncs/github-state", LOCAL, { every: "10m" })).status).toBe(400);
    expect((await call("PUT", "/api/scheduled/syncs/github-state", LOCAL, { raise: { merged: true } })).status).toBe(400);
    expect(await overlayText()).toBe(before);
    const ok = await call("PUT", "/api/scheduled/syncs/github-state", LOCAL, { every: "1h", raise: { review_requested: false } });
    expect(ok.status).toBe(200);
    expect(ok.body.sync).toMatchObject({ connection: "github", every: { value: "1h", origin: "yours" }, raise: { review_requested: { value: false, origin: "yours" }, assigned: { value: true, origin: "default" } } });
    const back = await call("PUT", "/api/scheduled/syncs/github-state", LOCAL, { every: null, raise: { review_requested: null } });
    expect(back.body.sync).toMatchObject({ every: { value: "15m", origin: "default" }, raise: { review_requested: { value: true, origin: "default" } } });
  });

  // ---- Run Now ---------------------------------------------------------------------

  it("**a paused routine's Run Now says why** — nothing started, no row; resumed, it runs once under a run_now row", async () => {
    await call("POST", `/api/scheduled/routines/${PROBE}/pause`, LOCAL, {});
    const rowsBefore = Number((await pool.query(`SELECT count(*) FROM runs WHERE component = $1`, [PROBE])).rows[0].count);
    const paused = await call("POST", `/api/scheduled/routines/${PROBE}/run`, LOCAL, {});
    expect(paused.status).toBe(200);
    expect(paused.body).toMatchObject({ ok: false, name: PROBE, run_id: null, started: false, refused: { reason: "paused" } });
    expect(paused.body.refused.message).toMatch(/paused.*Resume/);
    expect(Number((await pool.query(`SELECT count(*) FROM runs WHERE component = $1`, [PROBE])).rows[0].count)).toBe(rowsBefore);
    expect(probeRuns).toBe(0);

    await call("POST", `/api/scheduled/routines/${PROBE}/resume`, LOCAL, {});
    const started = await call("POST", `/api/scheduled/routines/${PROBE}/run`, LOCAL, {});
    expect(started.status).toBe(202);
    expect(started.body).toMatchObject({ ok: true, name: PROBE, started: true, refused: null });
    for (let i = 0; i < 100; i++) {
      const { rows } = await pool.query(`SELECT ok, meta FROM runs WHERE id = $1`, [started.body.run_id]);
      if (rows[0]?.ok !== null) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const { rows } = await pool.query(`SELECT ok, kind, meta FROM runs WHERE id = $1`, [started.body.run_id]);
    expect(rows[0]).toMatchObject({ ok: true, kind: "routine_run", meta: { trigger: "run_now", outcome: "acted" } });
    expect(probeRuns).toBe(1);
  });

  it("Run Now is under the budget preflight: a stop budget refuses it, naming the fix, and nothing runs", async () => {
    const costly = components.find((c) => c.name === COSTLY)!;
    costly.requires = { env: [], reachable: [], engine: true };
    budget = { name: "budgets.instance.daily", why: "today's spend is over the daily stop budget", fix: "raise budgets.instance.daily in .metistry/compute.yaml" };
    try {
      const r = await call("POST", `/api/scheduled/routines/${COSTLY}/run`, LOCAL, {});
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ started: false, refused: { reason: "blocked" } });
      expect(r.body.refused.message).toContain("raise budgets.instance.daily in .metistry/compute.yaml");
      expect(r.body.refused.message).toContain("No run was started");
      expect(Number((await pool.query(`SELECT count(*) FROM runs WHERE component = $1`, [COSTLY])).rows[0].count)).toBe(0);
    } finally {
      budget = null;
      costly.requires = { env: [], reachable: [], engine: false };
    }
    // a sync's Run Now is the sync door; a routine's name there is a 404
    expect((await call("POST", `/api/scheduled/syncs/${PROBE}/run`, LOCAL, {})).status).toBe(404);
  });
});
