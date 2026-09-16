// Seed queries (seed/queries/*.yaml) are the console's default read path
// (invariant 3, D4 overlay). Two guarantees: every query the PWA calls is
// present and compiles with its defaults (no db needed), and — when a
// scratch db is available (ops/scripts/test-db.sh) — every seed query
// actually executes against the migrated schema, so a column typo fails
// here instead of on the dashboard.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { QueryStore, type SqlExecutor } from "@foldedspacelabs/metistry-queries";

try {
  for (const line of readFileSync(new URL("../../../.env", import.meta.url), "utf8").split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m && m[1] && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {}

const SEED_DIR = fileURLToPath(new URL("../../../seed/queries", import.meta.url));

// what the PWA (app.js) and the routines lean on
const REQUIRED = [
  "open_work",
  "prs_for_review",
  "claude_usage_daily",
  "aws_costs_daily",
  "aws_costs_recent",
  "projects_overview",
  "projects_rollup",
  "runs_summary",
  "activity_feed",
  "agent_presence",
  "reply_feedback_summary",
  "spend", // the budget's read path (invariant 3) — the engine runs it before every billable call
  "board",
  "board_projects",
];

describe("seed queries", () => {
  it("load, include every query the console calls, and compile with defaults", async () => {
    const calls: { text: string; values: unknown[] }[] = [];
    const executor: SqlExecutor = {
      async query(text, values) {
        calls.push({ text, values });
        return { rows: [] };
      },
    };
    const store = new QueryStore(executor);
    const n = await store.loadDir(SEED_DIR);
    expect(n).toBeGreaterThanOrEqual(REQUIRED.length);
    for (const name of REQUIRED) expect(store.names()).toContain(name);
    for (const name of store.names()) {
      await store.run(name); // defaults only — every param must have one
      const call = calls.at(-1)!;
      expect(call.text, name).not.toMatch(/(?<![:\w]):[a-z]/); // no leftover :param
      for (const v of call.values) expect(typeof v, `${name} bind`).not.toBe("undefined");
    }
  });
});

const hasDb = !!process.env.METISTRY_DB_PASSWORD;

describe.skipIf(!hasDb)("seed queries against the migrated schema", () => {
  let pool: pg.Pool;
  let store: QueryStore;

  beforeAll(async () => {
    pool = new pg.Pool({
      host: process.env.METISTRY_DB_HOST ?? "127.0.0.1",
      user: process.env.METISTRY_DB_USER ?? "metistry",
      database: process.env.METISTRY_TEST_DB_NAME ?? "metistry_test", // scratch db (ops/scripts/test-db.sh)
      password: process.env.METISTRY_DB_PASSWORD,
    });
    store = new QueryStore(pool);
    await store.loadDir(SEED_DIR);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("every seed query executes with its defaults", async () => {
    for (const name of store.names()) {
      const { rows } = await store.run(name);
      expect(Array.isArray(rows), name).toBe(true);
    }
  });

  it("projects_overview rolls up per area like the brief; runs_summary counts the last 24h", async () => {
    const tag = `seedq-${Date.now()}`;
    await pool.query(
      `INSERT INTO work (title, area, kind, status, external_ref) VALUES
         ($1, $2, 'issue', 'open',        'gh:' || $2 || '#1'),
         ($1, $2, 'issue', 'in_progress', 'gh:' || $2 || '#2'),
         ($1, $2, 'issue', 'blocked',     'gh:' || $2 || '#3'),
         ($1, $2, 'issue', 'closed',      'gh:' || $2 || '#4')`, // external_ref is unique — per-run refs
      [`${tag} title`, tag],
    );
    await pool.query(
      `INSERT INTO runs (component, kind, ok, cost_usd) VALUES
         ($1, 'collector_run', true, NULL), ($1, 'collector_run', false, NULL),
         ($1, 'turn', true, 0.25), ($1, 'capture', true, NULL)`,
      [tag],
    );
    const { rows } = await store.run("projects_overview", { limit: 100 });
    const area = rows.find((r) => r.area === tag)!;
    expect(area).toBeDefined();
    expect(Number(area.open)).toBe(3);
    expect(Number(area.in_progress)).toBe(1);
    expect(Number(area.blocked)).toBe(1);
    expect(Number(area.closed_7d)).toBe(1);
    expect(area.latest).toHaveLength(3);

    const s = (await store.run("runs_summary", { hours: 1 })).rows[0]!;
    expect(Number(s.runs_ok)).toBeGreaterThanOrEqual(1);
    expect(Number(s.runs_failed)).toBeGreaterThanOrEqual(1);
    expect(Number(s.failures)).toBeGreaterThanOrEqual(1);
    expect(Number(s.turns)).toBeGreaterThanOrEqual(1);
    expect(Number(s.captures)).toBeGreaterThanOrEqual(1);
    expect(Number(s.spend_usd)).toBeGreaterThanOrEqual(0.25);
  });

  it("claude_usage_daily computes cache_hit_rate = cache_read / (cache_read + tokens_in + cache_write) per model-day, null with no cache metrics", async () => {
    const tag = `cud-${Date.now()}`;
    const day = "2020-01-15"; // outside any real window; days param below is huge so it's still included
    const labels = (extra: Record<string, unknown>) => JSON.stringify({ model: tag, turns: 1, ...extra });
    await pool.query(
      `INSERT INTO metrics (ts, name, value, labels) VALUES
         ($1::date, 'claude.tokens_in', 100, $2::jsonb),
         ($1::date, 'claude.tokens_out', 20, $2::jsonb),
         ($1::date, 'claude.cost_usd', 0.01, $2::jsonb),
         ($1::date, 'claude.cache_read', 300, $2::jsonb),
         ($1::date, 'claude.cache_write', 100, $2::jsonb)`,
      [day, labels({})],
    );
    const noCacheTag = `${tag}-nocache`;
    await pool.query(
      `INSERT INTO metrics (ts, name, value, labels) VALUES
         ($1::date, 'claude.tokens_in', 50, $2::jsonb),
         ($1::date, 'claude.cost_usd', 0.002, $2::jsonb)`,
      [day, JSON.stringify({ model: noCacheTag, turns: 1 })],
    );
    const { rows } = await store.run("claude_usage_daily", { days: 100000 });
    const row = rows.find((r) => r.model === tag)!;
    expect(row).toBeDefined();
    expect(Number(row.cache_read)).toBe(300);
    expect(Number(row.cache_write)).toBe(100);
    expect(Number(row.cache_hit_rate)).toBeCloseTo(300 / (300 + 100 + 100)); // 0.6
    const noCacheRow = rows.find((r) => r.model === noCacheTag)!;
    expect(noCacheRow).toBeDefined();
    expect(noCacheRow.cache_hit_rate).toBeNull();
  });

  // docs/product/desktop-app-plan.md "The window" — Activity feed: a fixture
  // row from every unioned source must come back through one filtered call.
  it("activity_feed unions a fixture row from every source (runs, proposals, work.history, outbound_messages)", async () => {
    const tag = `actfeed-${Date.now()}`;

    await pool.query(`INSERT INTO runs (component, kind, ok, tool) VALUES ($1, 'tool', true, 'test-tool')`, [tag]);
    await pool.query(`INSERT INTO runs (component, kind, ok) VALUES ($1, 'collector_run', false)`, [tag]); // failure-only kind
    await pool.query(`INSERT INTO runs (component, kind, ok) VALUES ($1, 'collector_run', true)`, [tag]); // must NOT appear (ok)

    const { rows: propRows } = await pool.query(
      `INSERT INTO proposals (kind, source_agent, trust, payload) VALUES ('knowledge', $1, 'internal', $2::jsonb) RETURNING id`,
      [tag, JSON.stringify({ title: `${tag} proposal` })],
    );
    await pool.query(`UPDATE proposals SET decision = 'allow', decided_at = now() WHERE id = $1`, [propRows[0]!.id]);

    const historyEntry = JSON.stringify([{ ts: new Date().toISOString(), agent: tag, op: "create", note: `${tag} note` }]);
    await pool.query(`INSERT INTO work (title, kind, status, history) VALUES ($1, 'task', 'open', $2::jsonb)`, [`${tag} title`, historyEntry]);

    const alertText = `${tag} alert text`;
    await pool.query(`INSERT INTO outbound_messages (thread, text, kind) VALUES ('default', $1, 'alert')`, [alertText]);

    const { rows } = await store.run("activity_feed", { hours: 1, limit: 500, agent: tag });
    const kinds = new Set(rows.map((r) => r.kind));
    expect(kinds.has("tool")).toBe(true);
    expect(kinds.has("collector_run")).toBe(true);
    expect(kinds.has("proposal_created")).toBe(true);
    expect(kinds.has("proposal_decided")).toBe(true);
    expect(kinds.has("work_history")).toBe(true);
    expect(rows.filter((r) => r.kind === "collector_run")).toHaveLength(1); // the ok=true row is excluded
    for (const r of rows) expect(String(r.detail).length).toBeLessThanOrEqual(200);

    // outbound_messages carry no agent identity (actor = 'assistant'), so check them unfiltered.
    const unfiltered = (await store.run("activity_feed", { hours: 1, limit: 500 })).rows;
    expect(unfiltered.some((r) => r.kind === "alert" && r.detail === alertText)).toBe(true);
  });

  // docs/product/desktop-app-plan.md "The window" — Agents panel: the state
  // machine on fixtures covering each branch once.
  it("agent_presence computes working/queued/interrupted/over-cap/idle from fixtures", async () => {
    const suf = Date.now();
    const ids = {
      working: `sqw-${suf}`,
      queued: `sqq-${suf}`,
      interrupted: `sqi-${suf}`,
      overCap: `sqo-${suf}`,
      idle: `sqd-${suf}`,
    };
    for (const id of Object.values(ids)) {
      await pool.query(`INSERT INTO agents (id, display_name, kind, token_hash) VALUES ($1, $1, 'external', $2)`, [id, `${id}-token`]);
    }

    await pool.query(
      `INSERT INTO work (title, kind, status, claimed_by, lease_expires_at) VALUES ($1, 'task', 'in_progress', $2, now() + interval '5 minutes')`,
      [`${ids.working} claim`, ids.working],
    );
    await pool.query(`INSERT INTO work (title, kind, status, owner) VALUES ($1, 'review', 'open', $2)`, [`${ids.queued} bundle`, ids.queued]);
    await pool.query(
      `INSERT INTO work (title, kind, status, claimed_by, lease_expires_at) VALUES ($1, 'task', 'in_progress', $2, now() - interval '5 minutes')`,
      [`${ids.interrupted} claim`, ids.interrupted],
    );
    const overCapHistory = JSON.stringify([{ ts: new Date().toISOString(), agent: ids.overCap, op: "create", note: "over_cap: agent_cap 3/3" }]);
    await pool.query(`INSERT INTO work (title, kind, status, meta, history) VALUES ($1, 'review', 'blocked', $2::jsonb, $3::jsonb)`, [
      `${ids.overCap} bundle`,
      JSON.stringify({ bundle: { from: ids.overCap } }),
      overCapHistory,
    ]);

    const { rows } = await store.run("agent_presence", { limit: 100000 });
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(ids.working)?.state).toBe("working");
    expect(byId.get(ids.queued)?.state).toBe("queued");
    expect(byId.get(ids.interrupted)?.state).toBe("interrupted");
    expect(byId.get(ids.overCap)?.state).toBe("over-cap");
    expect(byId.get(ids.idle)?.state).toBe("idle");
    expect(byId.get(ids.working)?.current_claims).toHaveLength(1);
    expect(byId.get(ids.interrupted)?.interrupted_claims).toHaveLength(1);
    expect(byId.get(ids.overCap)?.blocked_bundles).toHaveLength(1);
  });

  // docs/ops/board.md — the board view (Hermes note §4/§6a, phase 1). One
  // fixture per derived column, plus the two rows that must NOT move: a
  // collected `issue` (never claimable, so it has no board state) and an
  // over-cap queued bundle (blocked, but releasing itself — not a human's
  // problem). If a predicate drifts, exactly one of these lands in the
  // wrong column.
  const BOARD_ORDER = ["backlog", "assigned", "in_progress", "needs_you", "done", "reported"];

  it("board buckets one fixture per column, flags what wants a human, and limits PER column", async () => {
    const tag = `boardq-${Date.now()}`;
    const mk = async (label: string, cols: string, vals: unknown[]) => {
      const { rows } = await pool.query(
        `INSERT INTO work (title, project, kind, ${cols}) VALUES ($1, $2, $3, ${vals.map((_, i) => `$${i + 4}`).join(", ")}) RETURNING id`,
        [`${tag} ${label}`, tag, label === "collected" ? "issue" : label === "queued" ? "review" : "task", ...vals],
      );
      return Number(rows[0]!.id);
    };
    const id = {
      backlog: await mk("backlog", "status", ["open"]),
      overdue: await mk("overdue", "status, due", ["open", "2020-01-01"]),
      assigned: await mk("assigned", "status, owner", ["open", `${tag}-agent`]),
      working: await mk("working", "status, claimed_by, lease_expires_at", ["in_progress", `${tag}-agent`, new Date(Date.now() + 300_000)]),
      interrupted: await mk("interrupted", "status, claimed_by, lease_expires_at", ["in_progress", `${tag}-agent`, new Date(Date.now() - 300_000)]),
      blocked: await mk("blocked", "status", ["blocked"]),
      queued: await mk("queued", "status, meta", ["blocked", JSON.stringify({ bundle: { queued: "agent_cap" } })]),
      done: await mk("done", "status, closed_at", ["closed", new Date()]),
      reported: await mk("reported", "status, closed_at", ["closed", new Date()]),
      collected: await mk("collected", "status", ["open"]),
    };
    // the one confirmed work→output join: crew-drain stamps meta.work_id at
    // start and merges `reports` at finish (apps/assistant/src/crew-drain.ts)
    await pool.query(`INSERT INTO runs (component, kind, ok, started_at, finished_at, meta) VALUES ($1, 'crew_run', true, now(), now(), $2::jsonb)`, [
      tag,
      JSON.stringify({ work_id: id.reported, reports: 1 }),
    ]);
    // a run with no reports must NOT promote `done` to `reported`
    await pool.query(`INSERT INTO runs (component, kind, ok, started_at, finished_at, meta) VALUES ($1, 'crew_run', true, now(), now(), $2::jsonb)`, [
      tag,
      JSON.stringify({ work_id: id.done, reports: 0 }),
    ]);

    const { rows } = await store.run("board", { project: tag, limit: 50 });
    const col = new Map(rows.map((r) => [Number(r.id), r.column]));
    expect(col.get(id.backlog)).toBe("backlog");
    expect(col.get(id.overdue)).toBe("backlog");
    expect(col.get(id.assigned)).toBe("assigned"); // owner set, never claimed — the "assigned but not started" state
    expect(col.get(id.working)).toBe("in_progress");
    expect(col.get(id.interrupted)).toBe("in_progress"); // a lapsed lease is still in_progress on the row; the flag says it stalled
    expect(col.get(id.blocked)).toBe("needs_you");
    expect(col.get(id.queued)).toBe("needs_you");
    expect(col.get(id.done)).toBe("done");
    expect(col.get(id.reported)).toBe("reported");
    expect(col.has(id.collected)).toBe(false); // kind `issue` — a collector owns its status, so it has no board state

    const esc = new Map(rows.map((r) => [Number(r.id), r.escalated]));
    expect(esc.get(id.interrupted)).toBe(true); // lease lapsed mid-flight
    expect(esc.get(id.blocked)).toBe(true); // blocked with no route back to open — only the user's hand
    expect(esc.get(id.overdue)).toBe(true); // past due
    expect(esc.get(id.queued)).toBe(false); // over-cap, releases itself when a slot frees
    expect(esc.get(id.working)).toBe(false);
    expect(esc.get(id.backlog)).toBe(false);
    expect(esc.get(id.done)).toBe(false);

    const reported = rows.find((r) => Number(r.id) === id.reported)!;
    expect(reported.last_report_at).not.toBeNull();
    expect(rows.find((r) => Number(r.id) === id.done)!.last_report_at).toBeNull();
    expect(reported.project).toBe(tag);
    expect(Number(reported.age_hours)).toBeGreaterThanOrEqual(0);
    expect(rows.find((r) => Number(r.id) === id.working)!.claimed_by).toBe(`${tag}-agent`);
    expect(rows.find((r) => Number(r.id) === id.queued)!.kind).toBe("review");

    // ordered by column (board order, not alphabetical) then updated_at desc
    const seen = rows.map((r) => BOARD_ORDER.indexOf(String(r.column)));
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(seen).not.toContain(-1);

    // `limit` is per column, not per result set: backlog, in_progress and
    // needs_you each hold two fixtures, so limit 1 drops one from each and
    // every column still shows its most recent card. A busy column never
    // crowds another out.
    const capped = (await store.run("board", { project: tag, limit: 1 })).rows;
    const counts = new Map<string, number>();
    for (const r of capped) counts.set(String(r.column), (counts.get(String(r.column)) ?? 0) + 1);
    for (const [c, n] of counts) expect(n, c).toBe(1);
    expect([...counts.keys()].sort()).toEqual([...BOARD_ORDER].sort()); // all six survive
  });

  it("board_projects groups the same predicate by project × column for the cross-project view", async () => {
    const tag = `boardp-${Date.now()}`;
    await pool.query(
      `INSERT INTO work (title, project, kind, status, created_at) VALUES
         ($1, $2, 'task', 'open',    now() - interval '10 hours'),
         ($1, $2, 'task', 'open',    now() - interval '1 hour'),
         ($1, $2, 'task', 'blocked', now() - interval '2 hours')`,
      [`${tag} card`, tag],
    );
    const rows = (await store.run("board_projects", { limit: 100000 })).rows.filter((r) => r.project === tag);
    const byCol = new Map(rows.map((r) => [String(r.column), r]));
    expect([...byCol.keys()].sort()).toEqual(["backlog", "needs_you"]);
    expect(Number(byCol.get("backlog")!.cards)).toBe(2);
    expect(Number(byCol.get("backlog")!.escalations)).toBe(0);
    expect(Number(byCol.get("backlog")!.oldest_age_hours)).toBeGreaterThanOrEqual(10);
    expect(Number(byCol.get("needs_you")!.cards)).toBe(1);
    expect(Number(byCol.get("needs_you")!.escalations)).toBe(1); // blocked and not queued — a human has to move it
    expect(byCol.get("needs_you")!.last_activity).not.toBeNull();

    // the counts must match the cards, or the filter's labels lie
    const cards = (await store.run("board", { project: tag, limit: 50 })).rows;
    for (const [c, r] of byCol) expect(cards.filter((k) => k.column === c)).toHaveLength(Number(r.cards));
  });
});
