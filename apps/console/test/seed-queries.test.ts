// Seed queries (seed/queries/*.yaml) are the console's default read path
// (invariant 3, D4 overlay). Two guarantees: every query the PWA calls is
// present and compiles with its defaults (no db needed), and — when a
// scratch db is available (ops/scripts/test-db.sh) — every seed query
// actually executes against the migrated schema, so a column typo fails
// here instead of on the dashboard.
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { QueryStore, type SqlExecutor } from "@foldedspacelabs/metistry-queries";
import { loadTestEnv } from "@foldedspacelabs/metistry-core/test-env";

loadTestEnv(new URL("../../../.env", import.meta.url)); // METISTRY_DB_* only, and nothing of the operator's install (docs/ops/testing.md)

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
  "run_detail", // GET /api/runs/:id — what a tap on the feed's `runs:<id>` ref opens
  "agent_presence",
  "reply_feedback_summary",
  "spend", // the budget's read path (invariant 3) — the engine runs it before every billable call
  "board",
  "board_projects",
  "rooms",
  "knowledge_pages", // GET /api/knowledge/pages — a page LIST is derived state, so invariant 3 sends it through here and the route holds no SQL of its own
  "knowledge_page_links", // GET /api/knowledge/links — so is the link graph, which the reconciler parses out of the notes on every walk
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

  // `expose` decides which door a query is served through, and the answer is
  // a property of the seed SET rather than of one file: everything the PWA
  // and the routines call has to stay on the generic `/api/q/<name>`, and a
  // query is route-backed only where its own endpoint applies a filter the
  // generic door cannot (`knowledge_pages` scopes every row to the caller).
  // Pinned as a list so that marking another query `route` is a deliberate
  // act with a test to change — and so that dropping the line from
  // `knowledge_pages.yaml`, which re-opens the unscoped door, fails here
  // rather than in a review nobody remembered to do.
  it("serves every seed query through the generic door except the ones with a scoped route of their own", async () => {
    const store = new QueryStore({
      async query() {
        return { rows: [] };
      },
    });
    await store.loadDir(SEED_DIR);
    const routeBacked = store.names().filter((n) => store.exposure(n) === "route");
    expect(routeBacked.sort()).toEqual(["knowledge_page_links", "knowledge_pages"]);
    for (const name of REQUIRED.filter((n) => !routeBacked.includes(n))) expect(store.exposure(name), name).toBe("generic");
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

    // a decision event says what was answered, and that YOU answered it — the
    // decision route is `user`-gated, so `expired` is the only one that is nobody's
    expect(rows.find((r) => r.kind === "proposal_decided")!.detail).toBe("you decided allow");
  });

  // ADOPT 1 (docs/research/2026-09-16-taskuary-review.md): the feed is the
  // TIMELINE. A capture is in it the instant it lands — the accidental
  // latency the review found was that it waited for the `*/5` drain — and the
  // stream is filterable by kind and pullable incrementally.
  it("activity_feed carries inbox captures, derives a group per row, and filters by kind", async () => {
    const tag = `tl-${Date.now()}`;
    await pool.query(`INSERT INTO inbox (source, path, note, status) VALUES ($1, $2, $3, 'new')`, [
      tag,
      `Inbox/${tag}.md`,
      `---\ntitle: "ignored"\nkind: todo\n---\nrenew the cert\nsecond line`,
    ]);
    const capture = (await store.run("activity_feed", { hours: 1, limit: 500, agent: tag })).rows;
    expect(capture).toHaveLength(1);
    expect(capture[0]).toMatchObject({
      kind: "capture",
      group: "capture",
      actor: tag,
      subject: "renew the cert", // the first BODY line, not the frontmatter and not the whole note
      detail: `${tag} · new`, // source · status — the "still being triaged" pill
    });
    expect(String(capture[0]!.ref)).toMatch(/^inbox:\d+$/);

    // a capture with no note falls back to the file name, never to an empty row
    await pool.query(`INSERT INTO inbox (source, path, status) VALUES ($1, $2, 'new')`, [tag, `Inbox/${tag}-photo.heic`]);
    const both = (await store.run("activity_feed", { hours: 1, limit: 500, agent: tag })).rows;
    expect(both.map((r) => r.subject)).toContain(`${tag}-photo.heic`);

    // every row carries a group, and the groups are the closed set the chips read
    const all = (await store.run("activity_feed", { hours: 1, limit: 500 })).rows;
    for (const r of all) expect(["capture", "proposal", "decision", "run", "work", "message"]).toContain(r.group);

    // `kind` matches an exact kind OR a group name
    const byGroup = (await store.run("activity_feed", { hours: 1, limit: 500, kind: "capture" })).rows;
    expect(byGroup.every((r) => r.kind === "capture")).toBe(true);
    expect(byGroup.length).toBeGreaterThanOrEqual(2);
    const byKind = (await store.run("activity_feed", { hours: 1, limit: 500, kind: "proposal_created" })).rows;
    expect(byKind.every((r) => r.kind === "proposal_created")).toBe(true);
    expect((await store.run("activity_feed", { hours: 1, limit: 500, kind: "no-such-kind" })).rows).toHaveLength(0);
  });

  it("activity_feed `since` is inclusive, and blank means the whole window — never an error", async () => {
    const tag = `tls-${Date.now()}`;
    await pool.query(`INSERT INTO runs (component, kind, ok, tool) VALUES ($1, 'tool', true, 'first')`, [tag]);
    const first = (await store.run("activity_feed", { hours: 1, limit: 500, agent: tag })).rows;
    expect(first).toHaveLength(1);
    const cursor = new Date(first[0]!.ts as string).toISOString();

    await pool.query(`INSERT INTO runs (component, kind, ok, tool) VALUES ($1, 'tool', true, 'second')`, [tag]);
    const incremental = (await store.run("activity_feed", { hours: 1, limit: 500, agent: tag, since: cursor })).rows;
    // inclusive: the boundary row comes back with the new one, because two
    // sources can share a microsecond and a strict `>` would drop one forever
    expect(incremental.map((r) => r.subject)).toContain("second");
    expect(incremental.map((r) => r.subject)).toContain("first");
    // strictly after everything: nothing, and still not an error
    const future = new Date(Date.now() + 60_000).toISOString();
    expect((await store.run("activity_feed", { hours: 1, limit: 500, agent: tag, since: future })).rows).toHaveLength(0);
    // the default (blank) is the whole window — casting '' must never throw
    expect((await store.run("activity_feed", { hours: 1, limit: 500, agent: tag, since: "" })).rows).toHaveLength(2);
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

    // one room, on the blocked card — the Needs You card is the one that most
    // wants somewhere to answer (docs/ops/threads.md)
    await pool.query(
      `INSERT INTO artifact_comments (id, work_id, body, author_principal, author_kind) VALUES ($1, $2, 'why is this stuck?', 'user', 'human')`,
      [`cmt_${tag}`, id.blocked],
    );

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

    // has_thread (0016): a card with a room links to it, one without opens its
    // own detail. The panel asks no second endpoint to find that out.
    const thread = new Map(rows.map((r) => [Number(r.id), r.has_thread]));
    expect(thread.get(id.blocked)).toBe(true); // the room opened below
    expect(thread.get(id.backlog)).toBe(false);

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

  // The room view (docs/ops/threads.md): one row per thread across both
  // anchors, with the participants, the agent tail, and — the point of the
  // whole panel — the pending proposal's reason as the "why this came to
  // you" line.
  it("rooms: work and artifact anchors in one list, participants, agent tail, and the escalation reason", async () => {
    const project = `seedq-rooms-${Date.now()}`;
    const { rows: w } = await pool.query(`INSERT INTO work (title, project, kind, status) VALUES ('room fixture', $1, 'task', 'open') RETURNING id`, [project]);
    const workId = Number(w[0]!.id);
    const root = `cmt_${"0".repeat(20)}${String(Date.now()).slice(-6)}`;
    const reply = `cmt_${"1".repeat(20)}${String(Date.now()).slice(-6)}`;
    await pool.query(`INSERT INTO artifact_comments (id, work_id, body, author_principal, author_kind) VALUES ($1, $2, 'scope?', 'user', 'human')`, [root, workId]);
    await pool.query(`INSERT INTO artifact_comments (id, work_id, body, author_principal, author_kind, parent_id) VALUES ($1, $2, 'yes', 'seedq-agent', 'agent', $3)`, [reply, workId, root]);
    await pool.query(`INSERT INTO proposals (kind, source_agent, trust, payload, work_id) VALUES ('review', 'seedq-agent', 'external', $1::jsonb, $2)`, [
      JSON.stringify({ reason: "ping_pong_cap", title: "room needs you" }),
      workId,
    ]);

    const { rows } = await store.run("rooms", { limit: 200, project });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      anchor: "work",
      project,
      state: "open",
      messages: 2,
      agent_tail: 1, // the trailing agent-only run; a human message resets it
      cap: 10,
      escalated: true,
      reason: "ping_pong_cap",
      last_author: "seedq-agent",
    });
    expect(rows[0]!.participants).toEqual(
      expect.arrayContaining([{ principal: "user", kind: "human" }, { principal: "seedq-agent", kind: "agent" }]),
    );
    // the filters the panel offers
    expect((await store.run("rooms", { limit: 200, project, state: "resolved" })).rows).toHaveLength(0);
    expect((await store.run("rooms", { limit: 200, project, anchor: "artifact" })).rows).toHaveLength(0);

    await pool.query(`DELETE FROM proposals WHERE work_id = $1`, [workId]);
    await pool.query(`DELETE FROM artifact_comments WHERE work_id = $1`, [workId]);
    await pool.query(`DELETE FROM work WHERE id = $1`, [workId]);
  });

  // The page list (docs/ops/console-api.md `GET /api/knowledge/pages`). Four
  // things the YAML decides and nothing downstream can undo: what never
  // appears (a draft, an unsettled conflict), how `area` is DERIVED from the
  // path, that `prefix` is segment-wise rather than a substring — the
  // `Areas/Health` / `Areas/Healthcare` pair is the leak a `LIKE 'x%'` would
  // have — and that the window is stable under `offset`.
  it("knowledge_pages: derives the area, filters segment-wise, hides drafts and conflicts, pages stably", async () => {
    const tag = `Kp${Date.now()}`;
    const area = `Areas/${tag}`; // the area under test
    const sibling = `Areas/${tag}care`; // its `Health`/`Healthcare` neighbour
    const mk = async (path: string, title: string | null, draft: boolean, status: string) =>
      pool.query(`INSERT INTO knowledge_files (path, title, description, draft, status, mtime, indexed_at) VALUES ($1, $2, $3, $4, $5, now(), now())`, [
        path,
        title,
        title ? `${title} description` : null,
        draft,
        status,
      ]);
    await mk(`${area}/sleep.md`, "Sleep", false, "clean");
    await mk(`${area}/2026/taper.md`, null, false, "dirty"); // no frontmatter title → the basename
    await mk(`${sibling}/billing.md`, "Billing", false, "clean"); // the neighbour a substring prefix would leak
    await mk(`${area}/secret.md`, "Secret", true, "clean"); // draft: invisible at every tier
    await mk(`${area}/torn.md`, "Torn", false, "conflict"); // unsettled: its title and mtime are not facts yet
    await mk(`Journal/${tag}.md`, null, false, "clean");
    await mk(`${tag}.md`, "Root note", false, "clean"); // a vault-root file has no area

    const mine = (rows: Record<string, unknown>[]) => rows.filter((r) => String(r.path).includes(tag));
    const paths = (rows: Record<string, unknown>[]) => mine(rows).map((r) => r.path);
    const all = mine((await store.run("knowledge_pages", { limit: 500 })).rows);
    expect(all.map((r) => r.path)).toEqual([
      `${area}/2026/taper.md`,
      `${area}/sleep.md`,
      `${sibling}/billing.md`,
      `Journal/${tag}.md`,
      `${tag}.md`,
    ]);
    // The order above is the one assertion that is about the CLUSTER rather
    // than the query: `Areas/<tag>/sleep.md` before `Areas/<tag>care/…` is
    // byte order, and a locale collation (CI's Linux, `en_US.UTF-8`) ignores
    // the `/` and puts `care` first. `COLLATE "C"` in the YAML is what makes
    // the two machines agree — and what stops a client's `offset` window
    // shifting under it when a vault is restored elsewhere. The draft and the
    // conflict are simply not in the list at all.
    expect(all.find((r) => r.path === `${area}/sleep.md`)).toMatchObject({ area, title: "Sleep", description: "Sleep description", status: "clean" });
    expect(all.find((r) => r.path === `${area}/2026/taper.md`)).toMatchObject({ area, title: "taper" }); // the first two segments under Areas/, at any depth
    expect(all.find((r) => r.path === `Journal/${tag}.md`)!.area).toBe("Journal"); // outside Areas/ the top segment IS the area
    expect(all.find((r) => r.path === `${tag}.md`)!.area).toBeNull(); // a root file has none, and says NULL rather than "" so `area=` can still mean "every area"
    for (const r of all) expect(r.modified).not.toBeNull();

    // area: the derived grouping, exact — and it covers the sub-folders
    expect(paths((await store.run("knowledge_pages", { area, limit: 500 })).rows)).toEqual([`${area}/2026/taper.md`, `${area}/sleep.md`]);
    expect(paths((await store.run("knowledge_pages", { area: "Journal", limit: 500 })).rows)).toEqual([`Journal/${tag}.md`]);
    // prefix: segment-wise. `Areas/<tag>` must NOT reach `Areas/<tag>care`.
    expect(paths((await store.run("knowledge_pages", { prefix: area, limit: 500 })).rows)).toEqual([`${area}/2026/taper.md`, `${area}/sleep.md`]);
    expect(paths((await store.run("knowledge_pages", { prefix: `${area}/`, limit: 500 })).rows)).toHaveLength(2); // a trailing slash is the same prefix
    expect(paths((await store.run("knowledge_pages", { prefix: "/", limit: 500 })).rows)).toHaveLength(5); // `/` is the whole vault, as a grant of `/` means
    expect((await store.run("knowledge_pages", { prefix: `${area}/Nope`, limit: 500 })).rows).toHaveLength(0);
    expect((await store.run("knowledge_pages", { area: "no/such/area", limit: 500 })).rows).toHaveLength(0);

    // offset walks the same total order — path is the primary key, so no row
    // can tie and none can jump between windows
    const windows = [
      paths((await store.run("knowledge_pages", { prefix: area, limit: 1, offset: 0 })).rows),
      paths((await store.run("knowledge_pages", { prefix: area, limit: 1, offset: 1 })).rows),
      paths((await store.run("knowledge_pages", { prefix: area, limit: 1, offset: 2 })).rows),
    ];
    expect(windows.flat()).toEqual([`${area}/2026/taper.md`, `${area}/sleep.md`]); // the third window is past the end, and empty rather than wrapped
    expect((await store.run("knowledge_pages", { prefix: area, limit: 1, offset: 99 })).rows).toHaveLength(0);

    await pool.query(`DELETE FROM knowledge_files WHERE path LIKE $1 OR path LIKE $2`, [`%${tag}%`, `${tag}%`]);
  });

  // The link graph (docs/ops/console-api.md `GET /api/knowledge/links`). What
  // the YAML decides: both directions in ONE list keyed by the other end,
  // an unresolved target kept and marked rather than dropped, a draft or
  // conflict at either end dropped rather than marked, and an order total
  // enough that `offset` cannot repeat or skip an edge.
  it("knowledge_page_links: both directions, drafts dropped, unresolved kept, ordered stably", async () => {
    const tag = `Kl${Date.now()}`;
    const area = `Areas/${tag}`;
    const me = `${area}/sleep.md`;
    const mk = (path: string, title: string | null, draft = false, status = "clean") =>
      pool.query(`INSERT INTO knowledge_files (path, title, description, draft, status, mtime, indexed_at) VALUES ($1, $2, $3, $4, $5, now(), now())`, [
        path,
        title,
        title ? `${title} description` : null,
        draft,
        status,
      ]);
    const link = (from: string, to: string, kind = "wikilink") =>
      pool.query(`INSERT INTO knowledge_links (from_path, to_path, kind) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [from, to, kind]);

    await mk(me, "Sleep");
    await mk(`${area}/taper.md`, "Taper");
    await mk(`${area}/secret.md`, "Secret", true); // a draft: invisible at every tier
    await mk(`${area}/torn.md`, "Torn", false, "conflict"); // unsettled: not a fact yet
    await mk(`Journal/${tag}.md`, null); // no frontmatter title → the basename
    // outgoing
    await link(me, `${area}/taper.md`);
    await link(me, `${area}/taper.md`, "embed"); // same target, second kind — a distinct edge
    await link(me, `${area}/nowhere.md`); // unresolved: nothing lives there yet
    await link(me, `${area}/secret.md`); // to a draft
    // incoming
    await link(`Journal/${tag}.md`, me);
    await link(`${area}/torn.md`, me); // from an unsettled conflict
    await link(`${area}/secret.md`, me); // from a draft — a backlink must not disclose it

    const rows = (r: { rows: Record<string, unknown>[] }) => r.rows.map((x) => [x.direction, x.path, x.kind]);
    const all = await store.run("knowledge_page_links", { path: me, limit: 500 });
    expect(rows(all)).toEqual([
      // outgoing first, then by path in BYTE order, then by kind
      ["outgoing", `${area}/nowhere.md`, "wikilink"],
      ["outgoing", `${area}/taper.md`, "embed"],
      ["outgoing", `${area}/taper.md`, "wikilink"],
      ["incoming", `Journal/${tag}.md`, "wikilink"],
    ]);
    // the draft and the conflict are gone from BOTH directions, and nothing
    // in the answer says they were there
    expect(JSON.stringify(all.rows)).not.toContain("secret.md");
    expect(JSON.stringify(all.rows)).not.toContain("torn.md");
    // an unresolved target is kept, marked, and titled from its own path
    expect(all.rows[0]).toMatchObject({ resolved: false, title: "nowhere", description: null, status: null });
    expect(all.rows[2]).toMatchObject({ resolved: true, title: "Taper", description: "Taper description", status: "clean" });
    expect(all.rows[3]).toMatchObject({ resolved: true, title: tag }); // no frontmatter title → the basename, decided here

    // offset walks that same total order — (direction, path, kind) is the
    // table's primary key read the other way round, so no edge can tie
    const windows = [0, 1, 2, 3, 4].map((offset) => store.run("knowledge_page_links", { path: me, limit: 1, offset }));
    expect((await Promise.all(windows)).flatMap((w) => rows(w))).toEqual(rows(all));

    // the same edges seen from the other end: `taper.md` links nowhere, and
    // the two kinds of edge pointing AT it are two rows, not one
    const back = await store.run("knowledge_page_links", { path: `${area}/taper.md`, limit: 500 });
    expect(rows(back)).toEqual([
      ["incoming", me, "embed"],
      ["incoming", me, "wikilink"],
    ]);
    expect((await store.run("knowledge_page_links", { path: "", limit: 500 })).rows).toEqual([]); // blank = no page, so no links — never the whole graph
    expect((await store.run("knowledge_page_links", { path: `${area}/no-such-note.md`, limit: 500 })).rows).toEqual([]);

    await pool.query(`DELETE FROM knowledge_links WHERE from_path LIKE $1 OR to_path LIKE $1`, [`%${tag}%`]);
    await pool.query(`DELETE FROM knowledge_files WHERE path LIKE $1`, [`%${tag}%`]);
  });
});
