// Seed queries (seed/queries/*.yaml) are the console's default read path
// (invariant 3, D4 overlay). Two guarantees: every query the PWA calls is
// present and compiles with its defaults (no db needed), and — when a
// scratch db is available (ops/scripts/test-db.sh) — every seed query
// actually executes against the migrated schema, so a column typo fails
// here instead of on the dashboard.
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { parse } from "yaml";
import { QueryStore, type SqlExecutor } from "@foldedspacelabs/metistry-queries";
import { REQUEST_KINDS, TASK_FILTER_PARAM_SPEC, TASK_QUERY_NAME, compileTaskFilter, finishRun, isRequestKind, requestWordOf, requestWordSql, startRun } from "@foldedspacelabs/metistry-core";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";

loadTestEnv(new URL("../../../.env", import.meta.url)); // METISTRY_DB_* only, and nothing of the operator's install (docs/ops/testing.md)

const SEED_DIR = fileURLToPath(new URL("../../../seed/queries", import.meta.url));
const REPO = fileURLToPath(new URL("../../../", import.meta.url));

// The closed `group` vocabulary activity_feed.yaml derives (screen-02-activity.md
// §3): six, plus `routine` (C43, ruled 2026-09-20). With All, the eight chips.
const FEED_GROUPS = ["capture", "proposal", "decision", "run", "work", "message", "routine"];

// The chips the PWA actually draws, read out of app.js rather than copied —
// so a chip added there that the query has no group for fails a test.
const FEED_CHIP_VALUES = (() => {
  const src = readFileSync(join(REPO, "apps/console/web/app.js"), "utf8");
  const m = /^const FEED_CHIPS = (\[[\s\S]*?\n\]);/m.exec(src);
  if (!m) throw new Error("FEED_CHIPS not found in app.js");
  return (new Function(`return ${m[1]};`)() as [string, string][]).map(([value]) => value);
})();

// what the PWA (app.js) and the routines lean on
const REQUIRED = [
  "open_work",
  "prs_for_review",
  "claude_usage_daily",
  "aws_costs_daily",
  "aws_costs_recent",
  "areas_overview",
  "projects_overview", // C82: kept loaded as an alias for one release — the PWA calls `areas_overview` now
  "projects_rollup",
  "runs_summary",
  "activity_feed",
  "run_detail", // GET /api/runs/:id — what a tap on the feed's `runs:<id>` ref opens
  "agent_presence",
  "reply_feedback_summary",
  "spend", // the budget's read path (invariant 3) — the engine runs it before every billable call
  "cache_report", // OPEN-6's measurement — `metistry compute cache-report` reads it through GET /api/q/cache_report, not a route of its own (invariant 10)
  "route_report", // PoC-20 phase 0's baseline — `metistry compute route-report` reads it the same way, and it is counts only so the generic door is the whole answer
  "board",
  "board_projects",
  "rooms",
  "knowledge_pages", // GET /api/knowledge/pages — a page LIST is derived state, so invariant 3 sends it through here and the route holds no SQL of its own
  "knowledge_page_links", // GET /api/knowledge/links — so is the link graph, which the reconciler parses out of the notes on every walk
  "knowledge_fold_latest", // GET /api/knowledge/fold — which file is the newest fold, and what it links to
  "knowledge_drafts", // GET /api/knowledge/drafts — the owner's drafts, the other half of the column every agent door filters out
  "knowledge_areas", // GET /api/knowledge/areas — the area rollup the Knowledge screen lists
  "secret_last_used", // GET /api/secrets — *last used*, from the names the egress fill stamps on its run (never a value)
  "day_close", // POST /api/today/close — what the day did to the owner's tasks, the section Close the Day writes
];

// The daily flow's five (docs/product/daily-flow-spec.md §11, P1-5). Listed
// apart from REQUIRED because nothing leans on them YET — the template
// engine (P1-6) and `plan-tomorrow` (P1-7) are the callers, and this is the
// list they will find. Pinned so that renaming one is a deliberate act.
const DAILY_FLOW = [
  "vault_tasks_query", // the ONE query the where:/order: vocabulary compiles into (D15)
  "vault_tasks_recurring", // the rule lines, which vault_tasks_query excludes (§4)
  "day_work", // work for a day, with §3's meta.blocked_by resolved beside each row
  "pending_requests", // the Needs You queue, as a read path rather than a routine's own SQL
  "task_ageing", // the measure — the one of the five with no path in it, so the one that is `generic`
];

/**
 * The bind-param shape of `vault_tasks_query` is NOT written here. It is
 * `TASK_FILTER_PARAM_SPEC`, imported from the parser that emits it.
 *
 * This is the CONTRACT between the filter vocabulary's parser
 * (`packages/core/src/task-filter.ts`, P1-2) and the one query it compiles
 * into (D15, `seed/queries/vault_tasks_query.yaml`, P1-5). The two were first
 * written blind to each other and agreed on almost nothing — `due_from`
 * against `due_on_or_before`, `combine` against `match_any`, a
 * comma-separated `flags` string against seven booleans, `sort1` against
 * `order_1` — and every one of those is an `unknown param` at render time,
 * because `QueryStore.run` refuses an undeclared param loudly rather than
 * ignoring it.
 *
 * A COPY of the shape in this file would have caught that drift exactly as
 * well as a copy in the YAML did: not at all. So the pin below compares the
 * manifest against the imported object, and there is no third spelling of it
 * anywhere.
 */

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
    expect(n).toBeGreaterThanOrEqual(REQUIRED.length + DAILY_FLOW.length);
    for (const name of [...REQUIRED, ...DAILY_FLOW]) expect(store.names()).toContain(name);
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
    // The daily flow's four additions follow the page list's rule exactly:
    // every row they return carries a vault PATH and, in three of the four,
    // the text of a line the owner typed in their own notes. Only an
    // endpoint of its own can filter those through the caller's scope, so
    // the generic `/api/q/<name>` and `queries_run` answer them with the
    // refusal they answer an unknown name with. `task_ageing` is the one of
    // the five that is `generic`, and it is generic BY DESIGN rather than by
    // omission: it is counts only — no path, no task text, no person, and no
    // caller-supplied filter to probe the tree with — which is what lets the
    // assistant read the measure through `queries_run` and keeps §1.5's "no
    // new brain tool" true.
    // `vault_task_by_key` (T2-4) is the Tick door's lookup: a path and a line of the owner's own words, for the owner's door alone.
    // `secret_last_used` says which credentials this instance used and when:
    // the Secrets screen's to read through `GET /api/secrets`, not an agent's.
    // `session_detail` (T1-11) is a session's own transcript — the owner's
    // conversation — so it is reachable only through `GET /api/sessions/:id`
    // (T2-17), never the generic door.
    // The owner's three knowledge reads (T1-6): the drafts no agent may ever
    // be handed, the fold's links and the areas — both of which name `Me/`
    // and the owner's journal (#255). Owner-only at their own routes.
    // `board` (T1-2) carries `blocked_by_task` — the text of the owner's own
    // todo line — and `blocked_by`, its vault path: the day_work reason
    // exactly. The owner reads it at `GET /api/q/board` (P4); the counts,
    // `board_projects`, carry neither and stay generic.
    // `route_features` (T9-1) carries the previous message's TEXT for the
    // router's re-ask comparison: the console's own read, never an agent's.
    // `today_order` (T1-9) is the owner's own drag order for a day — no route
    // reads it yet (`GET /api/today` is T2-7's), marked ahead of it the same
    // way `collector_health` is: the write door is owner-only, and a read
    // door that were not would be the asymmetry an agent could ask through.
    // `pending_count` (T1-7, §2.10) is counts only, same as `task_ageing` —
    // but it is *route*, not generic, because what it counts is the
    // owner's OWN unanswered-decision queue: a proposal count is exactly the
    // kind of fact `pending_requests` already keeps off the generic door
    // (an agent with `queries: true` learning how many things the owner has
    // yet to decide, including about that agent's own asks, is the same
    // hole one door narrower). `GET /api/needs-you/count` is its one door.
    // `turn_progress` (T1-15/T2-17) and `routine_history` (T1-15/T3-3) are
    // each the owner's own endpoint too — a turn or a routine's run history
    // is not something the generic door or an agent's `queries_run` needs a
    // second, unscoped way to read. `spend_by_actor` stays `generic`: it is
    // Usage's *Where it went* ranking, nothing scoped to a caller.
    // `people_by_email` (T1-10) maps an address to a page naming someone the
    // owner knows: Today's to read, never an agent's way to probe who the
    // owner knows by address. `day_events` and `calendar_event` (T2-11) are
    // the owner's calendar — who they meet, with links into their People
    // pages and meeting notes: Today's and the meeting-note door's to read.
    // `day_close` (T2-8) is what the day did to the owner's tasks — paths
    // and the text of their own lines — composed into their daily note by
    // Close the Day, the owner's door alone.
    // `connection_calls` (T4-8b, §2.10) says which agent reached which of the
    // owner's services, with which credential names, and when: the audit and
    // a connection's *Used by* — the owner's to read, never an agent's.
    expect(routeBacked.sort()).toEqual([
      "board",
      "calendar_event",
      "collector_health",
      "connection_calls",
      "day_close",
      "day_events",
      "day_work",
      "knowledge_areas",
      "knowledge_drafts",
      "knowledge_fold_latest",
      "knowledge_page_links",
      "knowledge_pages",
      "pending_count",
      "pending_requests",
      "people_by_email",
      "route_features",
      "routine_history",
      "secret_last_used",
      "session_detail",
      "today_order",
      "turn_progress",
      "vault_task_by_key",
      "vault_tasks_query",
      "vault_tasks_recurring",
    ]);
    expect(store.exposure("task_ageing")).toBe("generic");
    expect(store.exposure("spend_by_actor")).toBe("generic");
    for (const name of REQUIRED.filter((n) => !routeBacked.includes(n))) expect(store.exposure(name), name).toBe("generic");
  });

  // D15's whole point: ONE vocabulary, three consumers, and what it compiles
  // to is bind params of one query. So the param list IS the interface, and
  // this is the assertion that keeps the two halves of it the same object.
  it("vault_tasks_query declares exactly TASK_FILTER_PARAM_SPEC — same names, same types, same defaults", async () => {
    const store = new QueryStore({
      async query() {
        return { rows: [] };
      },
    });
    await store.loadDir(SEED_DIR);
    const spec = store.list().find((q) => q.name === TASK_QUERY_NAME)!;
    expect(spec).toBeDefined();
    expect(spec.params).toEqual(TASK_FILTER_PARAM_SPEC);

    // and the other direction, said out loud: every param a real compile
    // emits is a param the manifest declares. `QueryStore.run` refuses an
    // undeclared one, so this is the failure that would otherwise land at
    // render time, on the owner's plan, at 19:00.
    const out = compileTaskFilter(
      { where: "due <= today and priority >= p2", order: "priority, due" },
      { now: new Date("2026-09-20T12:00:00Z"), timeZone: "America/New_York" },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    for (const k of Object.keys(out.params)) expect(Object.keys(spec.params), k).toContain(k);

    // "blank is absent" for every text param, `0` for every int: there are no
    // nulls on this wire and no arrays, so a default that was anything else
    // would make one field's absence mean something different from the rest.
    for (const [k, p] of Object.entries(spec.params)) {
      expect(p.default, `${k} has no default`).toBeDefined();
      if (p.type === "text") expect(p.default, k).toBe("");
      if (p.type === "int" && k !== "limit") expect(p.default, k).toBe(0);
      if (p.type === "boolean") expect(p.default, k).toBe(false);
    }

    // and the names this query used to take, refused — the shape of the
    // failure a drift produces, so nobody has to imagine it. The store does
    // not ignore an unknown param; it throws, with the name in the message.
    for (const stale of ["due_from", "due_to", "combine", "flags", "sort1", "state", "prefix", "area", "source"]) {
      await expect(store.run(TASK_QUERY_NAME, { [stale]: "x" }), stale).rejects.toThrow(`unknown param ${stale}`);
    }
  });

  // The other four, one assertion each: every param has a default (the seed
  // rule), and the two that a routine passes a time window to say so.
  it("the daily flow's other four declare defaults for every param", async () => {
    const store = new QueryStore({
      async query() {
        return { rows: [] };
      },
    });
    await store.loadDir(SEED_DIR);
    const byName = Object.fromEntries(store.list().map((q) => [q.name, q]));
    for (const name of DAILY_FLOW.filter((n) => n !== "vault_tasks_query")) {
      for (const [k, p] of Object.entries(byName[name]!.params)) expect(p.default, `${name}.${k}`).toBeDefined();
    }
    expect(Object.keys(byName["vault_tasks_recurring"]!.params).sort()).toEqual(["due", "limit", "offset", "prefix"]);
    expect(Object.keys(byName["day_work"]!.params).sort()).toEqual(["combine", "day", "flags", "limit", "offset", "project"]);
    expect(Object.keys(byName["pending_requests"]!.params).sort()).toEqual(["include_snoozed", "kind", "limit", "offset"]);
    // no `prefix` on the measure, deliberately: a count over a caller-supplied
    // filter is the directory listing of what was filtered
    expect(Object.keys(byName["task_ageing"]!.params).sort()).toEqual(["days", "today"]);
  });

  // T1-3: the Activity screen's contract with its query. The params are the
  // controls (screen-02-activity.md §3 + §6 fault 6), the columns are the row
  // (§2.1 + `ok`, C19), and the chips are All plus the query's closed `group`
  // vocabulary — read out of app.js, so a chip the SQL cannot resolve fails
  // here (the DB half below proves each one resolves to rows).
  it("activity_feed: the Activity screen's params, columns and eight chips are pinned (T1-3)", async () => {
    const store = new QueryStore({
      async query() {
        return { rows: [] };
      },
    });
    await store.loadDir(SEED_DIR);
    const spec = store.list().find((q) => q.name === "activity_feed")!;
    expect(Object.keys(spec.params).sort()).toEqual(["agent", "hours", "kind", "limit", "project", "since", "turn_id"]);
    for (const [k, p] of Object.entries(spec.params)) expect(p.default, k).toBeDefined();
    const doc = parse(readFileSync(join(SEED_DIR, "activity_feed.yaml"), "utf8")) as { sql: string };
    expect(doc.sql).toContain(`SELECT ts, kind, "group", actor, subject, left(detail, 200) AS detail, ref, turn_id, ok\n`);
    expect([...FEED_CHIP_VALUES].sort()).toEqual(["", ...FEED_GROUPS].sort());
  });

  // F-5. The kind → word mapping is the request type table,
  // packages/core/src/requests.ts, and a YAML file cannot import it — so the
  // query carries the table's own rendering, and this is what makes a hand
  // edit or a stale paste fail instead of drift (the two copies it replaced
  // had drifted: both said *note* for `action`, C80). Whitespace is free so
  // the YAML's indentation is; every other character is the table's.
  it("pending_requests says the owner's word through the request type table's rendering, and has no other mapping", () => {
    const { sql } = parse(readFileSync(join(SEED_DIR, "pending_requests.yaml"), "utf8")) as { sql: string };
    const normal = (text: string) => text.replace(/\s+/g, " ").trim();
    const rendered = requestWordSql("p.kind");
    expect(normal(sql), `paste this into seed/queries/pending_requests.yaml:\n${rendered}`).toContain(normal(rendered));
    // the old mappings are gone: the rendering is the query's only CASE, and
    // nothing outside it compares a kind with a word
    const rest = normal(sql).replace(normal(rendered), "");
    expect(rest).not.toMatch(/\bCASE\b/i);
    expect(rest).not.toMatch(/\bWHEN\b/i);
  });

  // "Every stored kind maps" means every kind the product actually WRITES, not
  // only the ones the table happened to list: a writer the table does not
  // know reads as a report with Dismiss its only answer, which is safe and
  // wrong. So the writers are read here, and a kind written by a shape this
  // cannot read (a bound parameter, a constant from another file) fails too —
  // a kind nobody can see is a kind nobody mapped.
  it("every kind the product writes into proposals is a kind the request type table maps", () => {
    const sources: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (["node_modules", "dist", ".build", "test", "tests"].includes(e.name)) continue;
        const at = join(dir, e.name);
        if (e.isDirectory()) walk(at);
        else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) sources.push(at);
      }
    };
    for (const root of ["apps", "packages", "routines", "collectors"]) walk(join(REPO, root));
    const written = new Map<string, string>();
    const unreadable: string[] = [];
    for (const file of sources) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/INSERT INTO proposals\b([^;`]{0,400})/gi)) {
        // `(kind, …) VALUES ('<kind>'` or `('${CONST}'` with CONST = "<kind>" in the same file; any other shape is unreadable
        const value = /^\s*\(\s*kind\b[^)]*\)\s*VALUES\s*\(\s*([^,)]*)/i.exec(m[1]!)?.[1]?.trim() ?? "";
        const where = `${file.slice(REPO.length)}: ${value || m[0].slice(0, 60)}`;
        const literal = /^'([a-z_]+)'$/.exec(value);
        const constant = /^'\$\{([A-Z_]+)\}'$/.exec(value);
        const resolved = literal?.[1] ?? (constant ? new RegExp(`\\b${constant[1]}\\s*=\\s*"([a-z_]+)"`).exec(text)?.[1] : undefined);
        // A kind passed as a parameter is readable only where the same file
        // refuses, before the insert, any kind the table does not map
        // (packages/core/src/mirrors.ts's `raiseMirror`): the guard is the
        // table itself, so there is nothing for this scan to check.
        if (resolved === undefined && /^\$\d+$/.test(value) && /if \(!isRequestKind\(/.test(text)) continue;
        if (resolved === undefined) unreadable.push(where);
        else written.set(resolved, where);
      }
    }
    expect(unreadable).toEqual([]);
    // the scan is not vacuous: today's writers, the constant-named one included
    for (const k of ["decision", "report", "review", "action", "access_request", "improvement", "knowledge"]) expect([...written.keys()], k).toContain(k);
    for (const [kind, where] of written) expect(isRequestKind(kind), `${kind} written at ${where} is not in REQUEST_KIND_TYPE`).toBe(true);
  });
});

/** The fall-through the router writes: kind `model`, `routed_by: "rule"`, the default tier — PoC-20 phase 0's population. */
const fell = (text: string): Record<string, string> => ({ kind: "model", tier: "default", model: "haiku", effort: "medium", text, routed_by: "rule" });

const hasDb = !!process.env.METISTRY_DB_PASSWORD;

describe.skipIf(!hasDb)("seed queries against the migrated schema", () => {
  let pool: pg.Pool;
  let store: QueryStore;

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
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

  it("areas_overview rolls up per area like the brief; projects_overview is the same rows under its old name (C82); runs_summary counts the last 24h", async () => {
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
    const { rows } = await store.run("areas_overview", { limit: 100 });
    const area = rows.find((r) => r.area === tag)!;
    expect(area).toBeDefined();
    expect(Number(area.open)).toBe(3);
    expect(Number(area.in_progress)).toBe(1);
    expect(Number(area.blocked)).toBe(1);
    expect(Number(area.closed_7d)).toBe(1);
    expect(area.latest).toHaveLength(3);

    // C82: the old name is an alias for one release — same SQL, same rows.
    const aliasRows = (await store.run("projects_overview", { limit: 100 })).rows;
    expect(aliasRows).toEqual(rows);

    const s = (await store.run("runs_summary", { hours: 1 })).rows[0]!;
    expect(Number(s.runs_ok)).toBeGreaterThanOrEqual(1);
    expect(Number(s.runs_failed)).toBeGreaterThanOrEqual(1);
    expect(Number(s.failures)).toBeGreaterThanOrEqual(1);
    expect(Number(s.turns)).toBeGreaterThanOrEqual(1);
    expect(Number(s.captures)).toBeGreaterThanOrEqual(1);
    expect(Number(s.spend_usd)).toBeGreaterThanOrEqual(0.25);
  });

  // Screen 10's request C1 (docs/product/design/screen-10-knowledge.md §6,
  // echoed at C48/C64/C95): the per-collector last-ok time the sources line
  // needs before it can say "current" instead of "freshness unknown". Two
  // timestamps, and neither replaces the other on a recovery — `last_failure`
  // and `last_error` stay put after a fresh success, which is what lets a
  // client draw "last succeeded 2 days ago · token expired" honestly.
  it("collector_health: a failing sync shows last ok and last error, a recovery clears the streak without erasing the failure, and an unrun component returns no row", async () => {
    const tag = `colh-${Date.now()}`;
    await pool.query(
      `INSERT INTO runs (component, kind, ok, error, ts) VALUES
         ($1, 'collector_run', true,  NULL,            now() - interval '4 hours'),
         ($1, 'collector_run', true,  NULL,            now() - interval '3 hours'),
         ($1, 'collector_run', false, 'token expired', now() - interval '2 hours'),
         ($1, 'collector_run', false, 'rate limited',  now() - interval '1 hours'),
         -- a routine_run for the SAME name is a different question and must not leak in
         ($1, 'routine_run',   false, 'unrelated',     now() - interval '30 minutes')`,
      [tag],
    );
    const failing = (await store.run("collector_health", { component: tag })).rows[0]!;
    expect(new Date(failing.last_ok as string).getTime()).toBeLessThan(new Date(failing.last_failure as string).getTime());
    expect(failing.last_error).toBe("rate limited"); // the most recent failure's message, not the first
    expect(Number(failing.streak)).toBe(2); // both failures are since the last ok

    // recovered: the two old failures are still on the row, but the streak is 0
    const recovered = `${tag}-recovered`;
    await pool.query(
      `INSERT INTO runs (component, kind, ok, error, ts) VALUES
         ($1, 'collector_run', false, 'boom', now() - interval '3 hours'),
         ($1, 'collector_run', false, 'boom', now() - interval '2 hours'),
         ($1, 'collector_run', true,  NULL,   now() - interval '1 hours')`,
      [recovered],
    );
    const healthyAgain = (await store.run("collector_health", { component: recovered })).rows[0]!;
    expect(healthyAgain.last_failure).not.toBeNull();
    expect(healthyAgain.last_error).toBe("boom");
    expect(Number(healthyAgain.streak)).toBe(0);

    // never run at all: the same absence `run_detail` gives an unknown id
    expect((await store.run("collector_health", { component: `${tag}-missing` })).rows).toHaveLength(0);
  });

  // T1-10: an attendee's address → the one People page that claims it. The
  // rows are inserted the way the reconciler's walk writes them (lowercased,
  // `apps/reconciler/test/meeting-refs.integration.test.ts` proves that half);
  // this is the read half — normalisation of the ASKED address, and the
  // refusal to choose.
  it("people_by_email: one claimant resolves, case and mailto: aside; two claimants and an unknown address resolve to nothing (never guessed)", async () => {
    const tag = `pbe${Date.now()}`;
    const jim = `People/${tag} Jim Fallon.md`;
    const twinA = `People/${tag} Sam A.md`;
    const twinB = `People/${tag} Sam B.md`;
    await pool.query(
      `INSERT INTO knowledge_files (path, mtime, content_hash, title) VALUES ($1, now(), 'h1', $4), ($2, now(), 'h2', NULL), ($3, now(), 'h3', NULL)`,
      [jim, twinA, twinB, `${tag} Jim Fallon`],
    );
    await pool.query(
      `INSERT INTO people_emails (email, path) VALUES ($1, $2), ($3, $4), ($3, $5)`,
      [`jim@${tag}.example`, jim, `sam@${tag}.example`, twinA, twinB],
    );
    try {
      const one = (await store.run("people_by_email", { email: `jim@${tag}.example` })).rows;
      expect(one).toEqual([{ email: `jim@${tag}.example`, path: jim, title: `${tag} Jim Fallon` }]);
      // the calendar's spelling, not the page's: EventKit hands a mailto: URL, and case varies by sender
      expect((await store.run("people_by_email", { email: ` MAILTO:Jim@${tag.toUpperCase()}.Example ` })).rows.map((r) => r.path)).toEqual([jim]);

      // two pages claim one address: neither is the person
      expect((await store.run("people_by_email", { email: `sam@${tag}.example` })).rows).toHaveLength(0);
      // an attendee no page claims is a plain name — no fallback on a name or a prefix
      expect((await store.run("people_by_email", { email: `jim.fallon@${tag}.example` })).rows).toHaveLength(0);
      expect((await store.run("people_by_email", { email: `jim@${tag}` })).rows).toHaveLength(0);
      expect((await store.run("people_by_email", { email: "%" })).rows).toHaveLength(0);
      expect((await store.run("people_by_email")).rows).toHaveLength(0); // the default, blank
    } finally {
      await pool.query(`DELETE FROM people_emails WHERE path = ANY($1::text[])`, [[jim, twinA, twinB]]);
      await pool.query(`DELETE FROM knowledge_files WHERE path = ANY($1::text[])`, [[jim, twinA, twinB]]);
    }
  });

  // T2-11: one day of the calendar, every source — the rows `GET /api/today`
  // serves as `events` (the F-7 fixture's shape), with an attendee's person
  // page resolved by people_by_email's rule and the meeting note by the
  // first-note rule. `calendar_event` is the same row for one id.
  it("day_events: the day in the owner's zone, every source, attendees to the ONE page that claims them, the first note — and calendar_event agrees", async () => {
    const tag = `dev${Date.now()}`;
    const a = `${tag}-a`;
    const b = `${tag}-b`;
    const jim = `People/${tag} Jim.md`;
    const twinA = `People/${tag} Sam A.md`;
    const twinB = `People/${tag} Sam B.md`;
    const person = (name: string, email: string | null, self = false) => ({ name, email, status: "accepted", role: "required", type: "person", self });
    const ev = (conn: string, id: string, start: string, end: string, title: string, attendees: unknown[] = [], allDay = false) =>
      pool.query(
        `INSERT INTO calendar_events (connection, event_id, starts_at, ends_at, all_day, title, location, attendees, self_status) VALUES ($1, $2, $3, $4, $5, $6, NULL, $7::jsonb, $8)`,
        [conn, id, start, end, allDay, title, JSON.stringify(attendees), attendees.length ? "accepted" : null],
      );
    // New York, 28 September (EDT, UTC-4): the day is 04:00Z to 04:00Z next day
    await ev(a, `${tag}-late`, "2026-09-29T01:00:00Z", "2026-09-29T02:00:00Z", "9 PM in New York"); // on the 28th there, the 29th in UTC
    await ev(a, `${tag}-early`, "2026-09-28T02:00:00Z", "2026-09-28T03:00:00Z", "10 PM the night before"); // the 27th there
    await ev(a, `${tag}-ends-at-midnight`, "2026-09-28T03:00:00Z", "2026-09-28T04:00:00Z", "ends at midnight"); // the 27th's
    await ev(a, `${tag}-point`, "2026-09-28T04:00:00Z", "2026-09-28T04:00:00Z", "zero-length at midnight"); // the 28th's
    await ev(a, `${tag}-allday`, "2026-09-28T04:00:00Z", "2026-09-29T04:00:00Z", "Offsite", [], true);
    await ev(a, `${tag}-standup`, "2026-09-28T13:30:00Z", "2026-09-28T13:45:00Z", "Standup", [person("Jim", "jim@x.example"), person("Sam", "sam@x.example"), person("Pat", "pat@x.example"), person("Me", "me@x.example", true), person("Room", null)]);
    await ev(b, `${tag}-feed`, "2026-09-28T15:00:00Z", "2026-09-28T16:00:00Z", "From another source");
    await pool.query(`INSERT INTO people_emails (email, path) VALUES ('jim@x.example', $1), ('sam@x.example', $2), ('sam@x.example', $3)`, [jim, twinA, twinB]);
    const note = `Journal/Meetings/2026-09-28-${tag}-standup.md`;
    await pool.query(`INSERT INTO vault_meeting_refs (event_id, path) VALUES ($1, $2), ($1, $3), ($1, $4)`, [`${tag}-standup`, note, `${note.slice(0, -3)} 1.md`, `Journal/Meetings/2026/09/2026-09-28-${tag}-standup.md`]);
    try {
      const day = async (params: Record<string, string>) => (await store.run("day_events", params)).rows.filter((r) => String(r.event_id).startsWith(tag));
      const ny = await day({ day: "2026-09-28", tz: "America/New_York" });
      expect(ny.map((r) => r.event_id)).toEqual([`${tag}-allday`, `${tag}-point`, `${tag}-standup`, `${tag}-feed`, `${tag}-late`]);
      const standup = ny.find((r) => r.event_id === `${tag}-standup`)!;
      // exactly the F-7 fixture's keys, no more
      expect(Object.keys(standup).sort()).toEqual(["all_day", "attendees", "connection", "end", "event_id", "location", "note", "self_status", "start", "title"]);
      expect(standup).toMatchObject({ connection: a, title: "Standup", all_day: false, location: null, self_status: "accepted", note });
      expect(new Date(standup.start).toISOString()).toBe("2026-09-28T13:30:00.000Z");
      expect(standup.attendees).toEqual([
        { name: "Jim", email: "jim@x.example", person: jim, self: false }, // one page claims him
        { name: "Sam", email: "sam@x.example", person: null, self: false }, // two do: neither is him
        { name: "Pat", email: "pat@x.example", person: null, self: false }, // none does: a plain name
        { name: "Me", email: "me@x.example", person: null, self: true },
        { name: "Room", email: null, person: null, self: false },
      ]);
      // the same day in UTC is another set; one source alone is that source's rows
      expect((await day({ day: "2026-09-28", tz: "UTC" })).map((r) => r.event_id)).toEqual([`${tag}-allday`, `${tag}-early`, `${tag}-ends-at-midnight`, `${tag}-point`, `${tag}-standup`, `${tag}-feed`]);
      expect((await day({ day: "2026-09-28", tz: "America/New_York", connection: b })).map((r) => r.event_id)).toEqual([`${tag}-feed`]);

      const one = (await store.run("calendar_event", { event_id: `${tag}-standup` })).rows;
      expect(one).toHaveLength(1);
      expect(one[0]).toEqual(standup);
      expect((await store.run("calendar_event", { event_id: `${tag}-nope` })).rows).toHaveLength(0);
      expect((await store.run("calendar_event")).rows).toHaveLength(0); // the default, blank
    } finally {
      await pool.query(`DELETE FROM calendar_events WHERE connection IN ($1, $2)`, [a, b]);
      await pool.query(`DELETE FROM people_emails WHERE path = ANY($1::text[])`, [[jim, twinA, twinB]]);
      await pool.query(`DELETE FROM vault_meeting_refs WHERE event_id = $1`, [`${tag}-standup`]);
    }
  });

  // T1-15/T2-17: the working indicator's data. The join is meta.turn_id,
  // EXACT — the same key `run_detail` joins tool calls on — so a second turn
  // running at the same instant never bleeds into this one's strip, and a
  // finished_at IS NULL row is the one still in flight (the two-phase marker
  // `collector_health` also reads).
  it("turn_progress: joins tool calls by meta.turn_id exactly, shows the in-flight row, and a blank/unknown turn_id returns no rows", async () => {
    const turnId = `tp-${Date.now()}`;
    const other = `${turnId}-other`;
    await pool.query(
      `INSERT INTO runs (component, kind, tool, ok, started_at, finished_at, meta) VALUES
         ($1, 'tool', 'search_notes', true, now() - interval '2 seconds', now() - interval '1 seconds', $2::jsonb),
         ($1, 'tool', 'write_note',   NULL, now() - interval '1 seconds', NULL,                          $2::jsonb),
         ($1, 'tool', 'unrelated',    true, now(),                       now(),                          $3::jsonb)`,
      ["seedq-agent", JSON.stringify({ turn_id: turnId }), JSON.stringify({ turn_id: other })],
    );
    const rows = (await store.run("turn_progress", { turn_id: turnId })).rows;
    expect(rows.map((r) => r.tool)).toEqual(["search_notes", "write_note"]); // oldest first, the other turn excluded
    expect(rows[0]!.finished_at).not.toBeNull();
    expect(rows[1]!.finished_at).toBeNull(); // still running — this is the strip's "current tool"
    expect(rows[1]!.ok).toBeNull();

    expect((await store.run("turn_progress")).rows).toHaveLength(0); // the default, blank turn_id
    expect((await store.run("turn_progress", { turn_id: `${turnId}-nope` })).rows).toHaveLength(0);
  });

  // Ruling 28 (X-23): a connections_call is still a call the turn made — the
  // strip must not go quiet while an agent waits on a connection. It joins
  // the same exact meta.turn_id key as any other tool row, and the query
  // returns nothing beyond id/tool/timing/ok/error/duration — no argument or
  // secret rides along, whatever the row's own `meta` (connection,
  // connection_tool) held.
  it("turn_progress: a connection_call run appears beside ordinary tool calls, with no argument or secret value", async () => {
    const turnId = `tpcc-${Date.now()}`;
    const meta = { turn_id: turnId, via: "mcp-brain", connection: `${turnId}-gh`, connection_tool: "list_issues", args: { connection: `${turnId}-gh`, tool: "list_issues" } };
    await pool.query(
      `INSERT INTO runs (component, kind, tool, ok, started_at, finished_at, meta) VALUES
         ($1, 'tool',            'search_notes',    true, now() - interval '2 seconds', now() - interval '1 seconds', $2::jsonb),
         ($1, 'connection_call', 'connections_call', true, now() - interval '1 seconds', now(),                       $3::jsonb)`,
      ["seedq-agent", JSON.stringify({ turn_id: turnId }), JSON.stringify(meta)],
    );
    const rows = (await store.run("turn_progress", { turn_id: turnId })).rows;
    expect(rows.map((r) => r.tool)).toEqual(["search_notes", "connections_call"]); // oldest first
    expect(rows[1]).toMatchObject({ ok: true, error: null });
    const blob = JSON.stringify(rows);
    expect(blob).not.toContain("connection_tool");
    expect(blob).not.toContain(`${turnId}-gh`);
    expect(blob).not.toContain("list_issues");
  });

  // T1-15/T3-3: Scheduled's per-routine history. `outcome` is meta.outcome
  // (T1-4's shared vocabulary) and `steps` is meta.processed (the runner's
  // own per-tick count) — a routine's own detailed row carries neither the
  // runner's `processed` key, so `steps` reads NULL rather than a false 0.
  it("routine_history: outcome and steps from meta, newest first, scoped to one component and capped by limit", async () => {
    const tag = `rh-${Date.now()}`;
    await pool.query(
      `INSERT INTO runs (component, kind, ok, cost_usd, ts, meta) VALUES
         ($1, 'routine_run', true,  0.01, now() - interval '2 hours', $2::jsonb),
         ($1, 'routine_run', true,  NULL, now() - interval '1 hours', $3::jsonb),
         ($1, 'routine_run', false, NULL, now(),                      $4::jsonb),
         -- a different component must not leak in
         ($5, 'routine_run', true,  NULL, now(),                      $2::jsonb)`,
      [
        tag,
        JSON.stringify({ processed: 3, outcome: "acted" }),
        JSON.stringify({ outcome: "silent" }), // the runner's silent tick has no `processed` of note
        JSON.stringify({ outcome: "skipped:template_missing" }), // a routine's own detailed skip row
        `${tag}-other`,
      ],
    );
    const rows = (await store.run("routine_history", { component: tag, limit: 50 })).rows;
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.outcome)).toEqual(["skipped:template_missing", "silent", "acted"]); // newest first
    expect(rows.map((r) => r.ok)).toEqual([false, true, true]);
    const acted = rows.find((r) => r.outcome === "acted")!;
    expect(Number(acted.steps)).toBe(3);
    expect(Number(acted.cost_usd)).toBeCloseTo(0.01);
    const silent = rows.find((r) => r.outcome === "silent")!;
    expect(silent.steps).toBeNull(); // no `processed` recorded — NULL, never a false 0

    expect((await store.run("routine_history", { component: tag, limit: 1 })).rows).toHaveLength(1);
    expect((await store.run("routine_history", { component: `${tag}-missing` })).rows).toHaveLength(0);
  });

  // T3-3: a sync's history is its `collector_run` rows (and Inbox Sort's and
  // Usage Rollup's, which present as routines); the runner's own bookkeeping
  // (`kind = 'runner'`) is not; a Run Now is marked by `meta.trigger`.
  it("routine_history: a sync's collector_run rows too, never the runner's bookkeeping, and Run Now marked by trigger", async () => {
    const tag = `rh-sync-${Date.now()}`;
    await pool.query(
      `INSERT INTO runs (component, kind, tool, ok, ts, meta) VALUES
         ($1, 'collector_run', NULL,            true,  now() - interval '1 hours', '{"processed":2}'::jsonb),
         ($1, 'collector_run', NULL,            true,  now(),                      '{"processed":0,"trigger":"run_now"}'::jsonb),
         ($1, 'runner',        'schedule_held', false, now(),                      '{}'::jsonb)`,
      [tag],
    );
    const rows = (await store.run("routine_history", { component: tag, limit: 50 })).rows;
    expect(rows.map((r) => [r.trigger, Number(r.steps), r.outcome])).toEqual([["run_now", 0, null], [null, 2, null]]);
  });

  // T4-8b (§2.10): every call through the connections proxy, as mcp-brain
  // writes it — kind connection_call, the connection and the upstream tool in
  // meta, the secret names it carried. Each param narrows, and a blank one
  // matches everything.
  it("connection_calls: one row per proxied call, newest first, filtered by connection, principal, since and ok, secret names only", async () => {
    const tag = `cc-${Date.now()}`;
    const other = `${tag}-other`;
    await pool.query(
      `INSERT INTO runs (component, kind, tool, ok, error, ts, duration_ms, meta) VALUES
         ($1, 'connection_call', 'connections_call', true,  NULL,        now() - interval '2 hours', 41, $3::jsonb),
         ($1, 'connection_call', 'connections_call', false, 'not_found', now() - interval '1 hours', 2,  $4::jsonb),
         ($2, 'connection_call', 'connections_call', true,  NULL,        now(),                      17, $5::jsonb),
         -- an ordinary tool call must not appear, whatever its meta says
         ($1, 'tool',            'queries_run',      true,  NULL,        now(),                      3,  $3::jsonb)`,
      [
        tag,
        other,
        JSON.stringify({ connection: `${tag}-gh`, connection_tool: "list_issues", secrets: ["github_token"], is_error: false }),
        JSON.stringify({ connection: `${tag}-jira`, connection_tool: "list_issues" }),
        JSON.stringify({ connection: `${tag}-gh`, connection_tool: "search_code", is_error: true }),
      ],
    );
    const mine = (await store.run("connection_calls", { principal: tag })).rows;
    expect(mine.map((r) => r.connection)).toEqual([`${tag}-jira`, `${tag}-gh`]); // newest first; the tool row is not a connection call
    expect(mine[1]).toMatchObject({ principal: tag, tool: "list_issues", ok: true, is_error: false, error: null, ms: 41, secrets: ["github_token"] });
    expect(mine[0]).toMatchObject({ ok: false, error: "not_found", secrets: [] });
    const gh = (await store.run("connection_calls", { connection: `${tag}-gh` })).rows;
    expect(gh.map((r) => [r.principal, r.tool, r.is_error])).toEqual([
      [other, "search_code", true],
      [tag, "list_issues", false],
    ]);
    expect((await store.run("connection_calls", { principal: tag, ok: "false" })).rows.map((r) => r.connection)).toEqual([`${tag}-jira`]);
    expect((await store.run("connection_calls", { principal: tag, ok: "true" })).rows.map((r) => r.connection)).toEqual([`${tag}-gh`]);
    const since = new Date(Date.now() - 90 * 60_000).toISOString();
    expect((await store.run("connection_calls", { principal: tag, since })).rows.map((r) => r.connection)).toEqual([`${tag}-jira`]);
    expect((await store.run("connection_calls", { principal: tag, limit: 1 })).rows).toHaveLength(1);
    expect((await store.run("connection_calls", { principal: `${tag}-missing` })).rows).toHaveLength(0);
  });

  // T1-15: Usage's *Where it went* — the same $0/unpriced accounting `spend`
  // uses (invariant 3), grouped by actor instead of by day/provider/model.
  it("spend_by_actor: totals per actor over the window, unpriced calls counted but priced at $0, excluded when there is no cost at all", async () => {
    const tag = `sba-${Date.now()}`;
    await pool.query(
      `INSERT INTO runs (component, kind, ok, tokens_in, tokens_out, cost_usd, meta) VALUES
         ($1, 'turn', true, 1000, 100, 0.02, $2::jsonb),
         ($1, 'turn', true,  500,  50, 0.01, $2::jsonb),
         ($1, 'turn', true,  200,  20, 0,    $3::jsonb),
         ($1, 'tool', true, NULL, NULL, NULL, $2::jsonb)`, // no cost recorded at all — excluded entirely
      [tag, JSON.stringify({ cost_source: "provider" }), JSON.stringify({ cost_source: "unknown" })],
    );
    // `cache_ttl: 60` (like `runs_summary`'s dashboard tile): every param
    // combination below is chosen NOT to be `days: 31` — the "every seed
    // query executes with its defaults" test above already ran this query
    // with its default params before any fixture existed, and that empty
    // answer is still live in the cache for its exact key.
    const rows = (await store.run("spend_by_actor", { days: 45 })).rows;
    const mine = rows.find((r) => r.actor === tag)!;
    expect(mine).toBeDefined();
    expect(Number(mine.calls)).toBe(3); // the uncosted tool call is not one of them
    expect(Number(mine.calls_unpriced)).toBe(1);
    expect(Number(mine.tokens_in)).toBe(1700);
    expect(Number(mine.cost_usd)).toBeCloseTo(0.03);

    // the window is a window
    await pool.query(`UPDATE runs SET ts = now() - interval '60 days' WHERE component = $1`, [tag]);
    expect((await store.run("spend_by_actor", { days: 10 })).rows.find((r) => r.actor === tag)).toBeUndefined();
  });

  // OPEN-6's measurement (docs/research/2026-09-cost-optimization.md
  // addendum). The assertions that matter are the three the report's verdict
  // rests on: the denominator, the NULL/0 distinction, and "every engine
  // turn" meaning crews and shadows too rather than the chat tier alone.
  it("cache_report: hit ratio over the whole billed prompt, NULL ≠ 0, and every engine turn", async () => {
    const tag = `cr-${Date.now()}`;
    const model = `${tag}/model`;
    // A group with a stable prefix: 10_000 prompt tokens of which 9_000 came
    // out of the cache, over two turns. `tokens_in` INCLUDES cache_read
    // (core's usageFromResponse), so the ratio is 9000/10000, not 9000/19000.
    await pool.query(
      `INSERT INTO runs (component, kind, ok, provider, model, tokens_in, tokens_out, cache_read_tokens, cache_write_tokens, cost_usd, meta)
       VALUES
         ($1, 'turn',     true, $2, $3, 5000, 100, 4500, 200, 0.01, $4::jsonb),
         ($1, 'turn',     true, $2, $3, 5000, 100, 4500,   0, 0.01, $4::jsonb)`,
      [tag, tag, model, JSON.stringify({ tier: "default", caching: "auto", cost_source: "provider" })],
    );
    // A crew run on the same provider/model: a DIFFERENT group (its own tier),
    // and it has to be in the report at all — the crews carry the long briefs.
    await pool.query(
      `INSERT INTO runs (component, kind, ok, provider, model, tokens_in, tokens_out, cache_read_tokens, cache_write_tokens, cost_usd, meta)
       VALUES ($1, 'crew_run', true, $2, $3, 8000, 50, 0, 8000, 0.05, $4::jsonb)`,
      [tag, tag, model, JSON.stringify({ tier: `crew:${tag}`, caching: "auto", cost_source: "provider" })],
    );
    // Reported NOTHING about the cache (NULL), on a provider whose block says
    // caching is off. Counted as a turn, not as a turn that reported.
    await pool.query(
      `INSERT INTO runs (component, kind, ok, provider, model, tokens_in, tokens_out, cost_usd, meta)
       VALUES ($1, 'turn', true, $2, $3, 1000, 10, 0, $4::jsonb)`,
      [tag, `${tag}-local`, model, JSON.stringify({ tier: "routine", caching: "off", cost_source: "unknown" })],
    );
    // In flight: a provider stamped at startRun with no token count yet. Not
    // a reading, and must not dilute one.
    await pool.query(`INSERT INTO runs (component, kind, ok, provider, model) VALUES ($1, 'turn', NULL, $2, $3)`, [tag, tag, model]);

    const rows = (await store.run("cache_report", { days: 1 })).rows.filter((r) => String(r.provider).startsWith(tag));
    expect(rows).toHaveLength(3); // chat tier, crew tier, the off-machine one — never the in-flight row

    const chat = rows.find((r) => r.tier === "default")!;
    expect(chat).toMatchObject({ provider: tag, model, caching: "auto" });
    expect(Number(chat.turns)).toBe(2);
    expect(Number(chat.turns_reporting)).toBe(2);
    expect(Number(chat.turns_hit)).toBe(2);
    expect(Number(chat.tokens_in)).toBe(10_000);
    expect(Number(chat.cache_read)).toBe(9_000);
    expect(Number(chat.cache_write)).toBe(200);
    expect(Number(chat.hit_ratio)).toBeCloseTo(0.9); // cache_read / tokens_in — NOT cache_read / (tokens_in + cache_read)
    expect(Number(chat.cost_usd)).toBeCloseTo(0.02);
    expect(Number(chat.turns_unpriced)).toBe(0);

    // The crew's prefix is being WRITTEN every turn and never read: this is
    // the shape the verdict calls out, and it is money spent at a premium.
    const crew = rows.find((r) => String(r.tier).startsWith("crew:"))!;
    expect(Number(crew.turns_reporting)).toBe(1);
    expect(Number(crew.turns_hit)).toBe(0);
    expect(Number(crew.cache_read)).toBe(0);
    expect(Number(crew.cache_write)).toBe(8_000);
    expect(Number(crew.hit_ratio)).toBe(0);

    // NULL is a different finding from 0: this provider answered nothing at
    // all, so it reports no turns — a row that coalesced NULL to 0 would say
    // "the cache missed" about a provider that was never asked.
    const off = rows.find((r) => r.provider === `${tag}-local`)!;
    expect(Number(off.turns)).toBe(1);
    expect(Number(off.turns_reporting)).toBe(0);
    expect(Number(off.cache_read)).toBe(0);
    expect(Number(off.hit_ratio)).toBe(0);
    expect(off.caching).toBe("off");
    expect(Number(off.turns_unpriced)).toBe(1);

    // the window is a window: nothing outside it
    await pool.query(`UPDATE runs SET ts = now() - interval '30 days' WHERE component = $1`, [tag]);
    expect((await store.run("cache_report", { days: 7 })).rows.filter((r) => String(r.provider).startsWith(tag))).toHaveLength(0);
  });

  // PoC-20 phase 0's baseline
  // (docs/research/2026-09-21-intent-classification-tier.md §5.2). Run in a
  // SCHEMA OF ITS OWN, which no other query here needs: `route_report` is an
  // aggregate over the whole of `inbound_messages` with no tag column to
  // filter on, and vitest runs this file alongside `server.integration`,
  // which POSTs real messages through a real router into the same scratch
  // database. A per-test schema on a dedicated connection makes the numbers
  // below exact instead of "at least" — and it takes no lock any other
  // session can wait on, which a `DELETE FROM inbound_messages` would.
  it("route_report: the four kinds derived from three, `unrouted` is not a fall-through, and no message body in any row", async () => {
    const schema = `rr_${Date.now()}`;
    const client = await pool.connect();
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`CREATE TABLE ${schema}.inbound_messages (LIKE public.inbound_messages INCLUDING ALL)`);
      await client.query(`CREATE TABLE ${schema}.runs (LIKE public.runs INCLUDING ALL)`); // the policy's rows read `runs`, which route-record.integration writes concurrently
      await client.query(`SET search_path TO ${schema}, public`);
      const isolated = new QueryStore({ query: (text, values) => client.query(text, values) });
      await isolated.loadDir(SEED_DIR);

      // Empty first, because "no rows" is the reading a fresh install gets
      // and because it is where the zero rows are visible: every kind and
      // every length bucket is a row at 0, never an absence (§4.3: "a
      // never-firing tier must be visible … a row, not a silence").
      const empty = (await isolated.run("route_report", { days: 30 })).rows;
      expect(empty.filter((r) => r.row_kind === "kind").map((r) => r.label)).toEqual(["note", "fast_path", "override", "default", "policy"]);
      expect(empty.filter((r) => r.row_kind === "length").map((r) => r.label)).toEqual(["<=5 words", "6-15 words", "16-40 words", ">40 words"]);
      for (const r of empty) expect(Number(r.n), String(r.label)).toBe(0);
      expect(empty.find((r) => r.row_kind === "total")).toMatchObject({ routed: "0", unrouted: "0", fall_through: "0" });
      expect(empty.filter((r) => r.row_kind === "tier" || r.row_kind === "rule" || r.row_kind === "first_word")).toHaveLength(0);

      // Exactly the shapes `apps/console/src/router.ts:24-27` writes and
      // `server.ts:616-621` files — `text` and all, which is why the last
      // assertion in this test matters.
      const long = `the ${"quick brown fox ".repeat(15)}end`; // 47 words
      const medium = `when is the review meeting and who is coming to it and do i need to read anything first before then`; // 21 words
      const rows: [string, unknown][] = [
        ["/note buy milk", { kind: "note", text: "buy milk", routed_by: "rule" }],
        ["/status", { kind: "fast_path", query: "open_work", routed_by: "rule" }],
        ["/open", { kind: "fast_path", query: "board", routed_by: "rule" }],
        ["/deep think about the roadmap", { kind: "model", tier: "deep", model: "opus", effort: "high", text: "think about the roadmap", routed_by: "override" }],
        ["a picked tier from the composer", { kind: "model", tier: "fast", model: "haiku", effort: "low", text: "a picked tier from the composer", routed_by: "override" }],
        ["what did i do yesterday", fell("what did i do yesterday")],
        ["what is up", fell("what is up")],
        ["remind me to call the dentist tomorrow morning before the standup", fell("remind me to call the dentist tomorrow morning before the standup")],
        ["/todo pick up the parcel", fell("/todo pick up the parcel")],
        ["matt@example.com asked about it", fell("matt@example.com asked about it")],
        [medium, fell(medium)],
        [long, fell(long)],
      ];
      for (const [text, route] of rows) {
        await client.query(`INSERT INTO ${schema}.inbound_messages (thread, text, meta) VALUES ('rr', $1, $2::jsonb)`, [text, JSON.stringify({ route })]);
      }
      // The console files this when it loaded no ruleset at all
      // (`server.ts:616`: `cfg.rules ? … : null`). It is the router saying
      // NOTHING, and counting it as a fall-through would overstate the one
      // number this whole PoC turns on.
      await client.query(`INSERT INTO ${schema}.inbound_messages (thread, text) VALUES ('rr', 'filed with no ruleset loaded')`);

      const got = (await isolated.run("route_report", { days: 1 })).rows;
      const of = (kind: string): Record<string, number> =>
        Object.fromEntries(got.filter((r) => r.row_kind === kind).map((r) => [String(r.label), Number(r.n)]));

      expect(got.find((r) => r.row_kind === "total")).toMatchObject({ messages: "13", routed: "12", unrouted: "1", fall_through: "7" });
      // `override` is kind=model + routed_by=override and `default` is
      // kind=model + routed_by=rule: the fourth kind does not exist on the
      // wire, and getting that wrong is the difference between a 58% reading
      // and a 75% one.
      expect(of("kind")).toEqual({ note: 1, fast_path: 2, override: 2, default: 7, policy: 0 });
      expect(Number(got.find((r) => r.row_kind === "kind" && r.label === "default")!.share)).toBeCloseTo(7 / 12, 4);
      // shares of the ROUTED messages, so they sum to 1 — the unrouted row is
      // not in any of them
      expect(got.filter((r) => r.row_kind === "kind").reduce((a, r) => a + Number(r.share), 0)).toBeCloseTo(1, 4);

      // no tier on `note` or `fast_path`: they reach no model, so they name none
      expect(of("tier")).toEqual({ default: 7, deep: 1, fast: 1 });
      // a fast_path rule has no name in rules.yaml — the named query it
      // answers from is its identity
      expect(of("rule")).toEqual({ open_work: 1, board: 1 });

      expect(of("length")).toEqual({ "<=5 words": 4, "6-15 words": 1, "16-40 words": 1, ">40 words": 1 });
      for (const r of got.filter((r) => r.row_kind === "length" || r.row_kind === "first_word")) {
        expect(Number(r.denominator), String(r.label)).toBe(7); // over the FALL-THROUGHS, not the routed set
      }

      // The fence, which is what makes `expose: generic` honest: one
      // lower-cased token; a command-shaped one kept, because "he keeps
      // typing /todo and there is no such command" is the finding; anything
      // that is not a word or a command — an address here — folded into
      // `(other)` before it is counted.
      expect(of("first_word")).toEqual({ what: 2, "(other)": 1, "/todo": 1, remind: 1, the: 1, when: 1 });

      // And the property the whole exposure rests on: not one cell of this
      // report carries a line the owner typed, `meta.route.text`'s copy of it
      // included.
      const cells = JSON.stringify(got);
      for (const needle of ["buy milk", "dentist", "quick brown fox", "review meeting", "matt@example.com", "roadmap"]) {
        expect(cells, needle).not.toContain(needle);
      }

      // the window is a window
      await client.query(`UPDATE ${schema}.inbound_messages SET ts = now() - interval '45 days'`);
      expect((await isolated.run("route_report", { days: 7 })).rows.find((r) => r.row_kind === "total")).toMatchObject({ messages: "0" });
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      client.release();
    }
  });

  // The policy's record (T9-1, docs/ops/dynamic-router.md §6): route_report
  // over `runs` of kind `route`. Its own schema for the same reason as above —
  // route-record.integration writes real route rows into the shared `runs`.
  it("route_report: the policy's rows — every closed-vocabulary label at zero, each over its own denominator, no text", async () => {
    const schema = `rp_${Date.now()}`;
    const client = await pool.connect();
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`CREATE TABLE ${schema}.inbound_messages (LIKE public.inbound_messages INCLUDING ALL)`);
      await client.query(`CREATE TABLE ${schema}.runs (LIKE public.runs INCLUDING ALL)`);
      await client.query(`SET search_path TO ${schema}, public`);
      const isolated = new QueryStore({ query: (text, values) => client.query(text, values) });
      await isolated.loadDir(SEED_DIR);
      const labels = (rows: Record<string, unknown>[], kind: string) => rows.filter((r) => r.row_kind === kind).map((r) => String(r.label));

      // **every new label is emitted at zero** — the ones this query can know
      const empty = (await isolated.run("route_report", { days: 30 })).rows;
      expect(labels(empty, "policy_outcome")).toEqual(["not_consulted", "counterfactual", "absent", "chosen", "no_match", "out_of_bounds", "timeout", "failed"]);
      expect(labels(empty, "policy_row")).toEqual(["(no match)"]);
      expect(labels(empty, "policy_operation").sort()).toEqual(["answer", "retrieve:knowledge", "retrieve:queries", "tools"]);
      expect(labels(empty, "policy_bounded_by").sort()).toEqual(["command:note", "crew_registry", "failed", "override", "queries", "session", "timeout"]);
      expect(labels(empty, "policy_override")).toEqual(["agrees", "disagrees"]);
      expect(labels(empty, "policy_latency")).toEqual(["p50", "p95"]);
      expect(labels(empty, "policy_miss")).toEqual(["miss"]);
      expect(labels(empty, "policy_tier")).toEqual([]); // tiers are the owner's names — seen, never invented
      expect(labels(empty, "policy_shadow")).toEqual([]);
      for (const r of empty.filter((r) => String(r.row_kind).startsWith("policy_"))) {
        expect(Number(r.n), `${r.row_kind} ${r.label}`).toBe(0);
        expect(Number(r.denominator), `${r.row_kind} ${r.label}`).toBe(0);
        expect(r.share, `${r.row_kind} ${r.label}`).toBeNull();
      }

      // Rows of exactly the shape consultRoute writes (router.ts), text and all where a route would carry it — it must not reach a cell.
      const served = (tier: string, routed_by = "rule") => ({ kind: "model", tier, operation: "tools", routed_by });
      const row = async (tool: string, ok: boolean, duration: number, meta: Record<string, unknown>, ts = "now()") => {
        const { rows } = await client.query(
          `INSERT INTO ${schema}.runs (ts, component, kind, tool, ok, duration_ms, started_at, finished_at, meta)
           VALUES (${ts}, 'console', 'route', $1, $2, $3, ${ts}, ${ts}, $4::jsonb) RETURNING id`,
          [tool, ok, duration, JSON.stringify({ v: 1, thread: "rp", phase: "shadow", ...meta })],
        );
        return rows[0].id;
      };
      await row("note", true, 3, { message_id: 1, served: { kind: "note", routed_by: "rule" }, policy: { outcome: "not_consulted", bounded_by: ["command:note"] } });
      await row("fast_path", true, 4, { message_id: 2, served: { kind: "fast_path", query: "open_work" }, policy: { outcome: "not_consulted", bounded_by: ["fast_path:open_work"] } });
      await row("default", true, 10, { message_id: 3, served: served("default"), policy: { outcome: "absent", bounded_by: [] } });
      await row("default", true, 20, { message_id: 4, served: served("default"), policy: { outcome: "chosen", row: "small-talk", chosen: { operation: "answer", tier: "fast" }, bounded_by: [], would_serve: { operation: "answer", tier: "fast" } } });
      await row("default", true, 30, { message_id: 5, served: served("default"), policy: { outcome: "chosen", row: "small-talk", chosen: { operation: "answer", tier: "fast" }, bounded_by: [], would_serve: { operation: "answer", tier: "fast" } } });
      await row("default", true, 40, { message_id: 6, served: served("default"), policy: { outcome: "chosen", row: "the-record", chosen: { operation: "retrieve:knowledge", tier: "default" }, bounded_by: [] } });
      await row("default", true, 50, { message_id: 7, served: served("default"), policy: { outcome: "chosen", row: "status", chosen: { operation: "fast_path:open_work" }, bounded_by: [] } });
      await row("default", true, 60, { message_id: 8, served: served("default"), policy: { outcome: "no_match", bounded_by: [], would_serve: { operation: "tools", tier: "default" } } });
      await row("default", true, 70, { message_id: 9, served: served("default"), policy: { outcome: "out_of_bounds", row: "by-complexity", chosen: { operation: "tools", tier: "deep" }, bounded_by: ["session"] } });
      await row("default", false, 400, { message_id: 10, served: served("default"), policy: { outcome: "timeout", bounded_by: ["timeout"] } });
      await row("default", false, 5, { message_id: 11, served: served("default"), policy: { outcome: "failed", bounded_by: ["failed"] } });
      await row("override", true, 80, { message_id: 12, served: served("deep", "override"), policy: { outcome: "counterfactual", answer: "chosen", bounded_by: ["override"], would_serve: { operation: "tools", tier: "deep" } } });
      await row("override", true, 90, { message_id: 13, served: served("deep", "override"), policy: { outcome: "counterfactual", answer: "no_match", bounded_by: ["override"], would_serve: { operation: "tools", tier: "default" } } });
      // a row still in flight has no outcome and is not counted anywhere
      await client.query(`INSERT INTO ${schema}.runs (component, kind, tool, ok, started_at, meta) VALUES ('console', 'route', 'default', NULL, now(), '{"v":1,"message_id":14}')`);
      // stage-2 shadow on two of the messages the policy sent to `fast`
      for (const [id, agreement] of [[4, 0.8], [5, 0.6]] as const) {
        await client.query(
          `INSERT INTO ${schema}.runs (component, kind, ok, shadow_model, shadow_agreement, meta) VALUES ('assistant', 'turn', true, 'cand', $1, $2::jsonb)`,
          [agreement, JSON.stringify({ message_id: String(id), thread: "rp", text: "a private sentence that must not surface" })],
        );
      }

      const got = (await isolated.run("route_report", { days: 1 })).rows;
      const of = (kind: string): Record<string, number> => Object.fromEntries(got.filter((r) => r.row_kind === kind).map((r) => [String(r.label), Number(r.n)]));
      const denom = (kind: string) => [...new Set(got.filter((r) => r.row_kind === kind).map((r) => Number(r.denominator)))];

      expect(of("policy_outcome")).toEqual({ not_consulted: 2, counterfactual: 2, absent: 1, chosen: 4, no_match: 1, out_of_bounds: 1, timeout: 1, failed: 1 });
      expect(denom("policy_outcome")).toEqual([13]); // every FINISHED route row
      expect(of("policy_row")).toEqual({ "(no match)": 1, "small-talk": 2, "the-record": 1, status: 1 });
      expect(denom("policy_row")).toEqual([5]); // chosen + no_match
      expect(of("policy_operation")).toEqual({ answer: 2, "retrieve:knowledge": 1, "retrieve:queries": 0, tools: 0, "fast_path:open_work": 1 });
      expect(denom("policy_operation")).toEqual([4]);
      expect(of("policy_tier")).toEqual({ "default → fast": 2, "default → default": 1, "default → fast_path": 1 });
      expect(of("policy_bounded_by")).toEqual({ "command:note": 1, "fast_path:open_work": 1, override: 2, session: 1, crew_registry: 0, queries: 0, timeout: 1, failed: 1 });
      expect(denom("policy_bounded_by")).toEqual([13]);
      expect(of("policy_override")).toEqual({ agrees: 1, disagrees: 1 });
      expect(denom("policy_override")).toEqual([2]);
      // p50/p95 over the 11 consultations (not the note, not the fast path): 5,10,…,400
      expect(of("policy_latency")).toEqual({ p50: 50, p95: 245 });
      expect(denom("policy_latency")).toEqual([11]);
      const shadowRow = got.find((r) => r.row_kind === "policy_shadow")!;
      expect(shadowRow).toMatchObject({ label: "fast" });
      expect(Number(shadowRow.n)).toBe(2);
      expect(Number(shadowRow.share)).toBeCloseTo(0.7, 3);
      expect(of("policy_miss")).toEqual({ miss: 0 }); // nothing is policy-served before T9-4
      expect(of("kind").policy).toBe(0);

      const cells = JSON.stringify(got);
      expect(cells).not.toContain("private sentence");
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      client.release();
    }
  });

  // The router's thread facts (docs/ops/dynamic-router.md §2): one row
  // always, and the numbers the cheap features are computed from.
  it("route_features: one row for any thread; the active session, the last five finished turns, and the previous message before exclude_id", async () => {
    const thread = `rf-${randomUUID()}`;
    const fresh = (await store.run("route_features", { thread, exclude_id: 0 })).rows;
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatchObject({ session_active: false, session_turns: 0, session_provider: null, session_model: null, recent_failures: 0, prev_ts: null, prev_text: null });

    const session = randomUUID();
    await pool.query(`INSERT INTO sessions (id, thread, turns) VALUES ($1, $2, 7)`, [session, thread]);
    await pool.query(`INSERT INTO assistant_sessions (id, thread, provider, model) VALUES ($1, $2, 'openrouter', 'anthropic/claude-sonnet-5')`, [session, thread]);
    // six finished turns, newest last: the oldest failure falls outside the five
    const turns: [boolean, Record<string, unknown>][] = [[false, {}], [true, {}], [true, { stopped: "max_turns" }], [false, {}], [true, {}], [true, {}]];
    for (const [i, [ok, extra]] of turns.entries()) {
      await pool.query(
        `INSERT INTO runs (ts, component, kind, ok, meta) VALUES (now() - make_interval(secs => $1), 'assistant', 'turn', $2, $3::jsonb)`,
        [60 - i, ok, JSON.stringify({ thread, ...extra })],
      );
    }
    await pool.query(`INSERT INTO runs (component, kind, ok, meta) VALUES ('assistant', 'turn', NULL, $1::jsonb)`, [JSON.stringify({ thread })]); // in flight: not ended
    const a = await pool.query(`INSERT INTO inbound_messages (thread, text) VALUES ($1, 'the first question') RETURNING id`, [thread]);
    const b = await pool.query(`INSERT INTO inbound_messages (thread, text) VALUES ($1, 'the second question') RETURNING id`, [thread]);

    const [row] = (await store.run("route_features", { thread, exclude_id: Number(b.rows[0].id) })).rows;
    expect(row).toMatchObject({ session_active: true, session_turns: 7, session_provider: "openrouter", session_model: "anthropic/claude-sonnet-5", recent_failures: 2, prev_text: "the first question" });
    // at serve the message is not written yet: 0 excludes nothing and the latest is the previous one
    expect((await store.run("route_features", { thread, exclude_id: 0 })).rows[0]).toMatchObject({ prev_text: "the second question" });
    expect((await store.run("route_features", { thread, exclude_id: Number(a.rows[0].id) })).rows[0]).toMatchObject({ prev_text: null });

    // a rolled session is not the one the drain would resume
    await pool.query(`UPDATE sessions SET status = 'rolled' WHERE id = $1`, [session]);
    expect((await store.run("route_features", { thread, exclude_id: 0 })).rows[0]).toMatchObject({ session_active: false, session_turns: 0, session_provider: null });
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

  // T2-16: a protected write is on the record whichever door made it — the
  // reconciler writes a `config_write` run for each one it accepts, and the
  // feed shows it as the principal's act, in the `run` group.
  it("activity_feed shows a config_write (a rename) as the principal's act, naming the file and the change", async () => {
    const tag = `cfg-${Date.now()}`;
    const meta = { path: ".metistry/identity.yaml", op: "write", caller: "owner", principal: tag, message: "metistry identity set: name Iris → Ada" };
    await pool.query(`INSERT INTO runs (component, kind, ok, tool, meta, finished_at) VALUES ('reconciler', 'config_write', true, 'vault_write', $1::jsonb, now())`, [JSON.stringify(meta)]);
    const rows = (await store.run("activity_feed", { hours: 1, limit: 500, agent: tag })).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "config_write", group: "run", actor: tag, subject: ".metistry/identity.yaml", detail: "metistry identity set: name Iris → Ada" });
    expect(String(rows[0]!.ref)).toMatch(/^runs:\d+$/);
  });

  // Ruling 28 (X-23): a proxied connection call is on the timeline like any
  // other run — in the `run` group, since it is nothing else. The subject
  // and detail name only the connection and the upstream tool (the same
  // fields `connection_calls` reads out of `meta`), never `meta.args` or a
  // secret — mcp-brain's `summarizeArgs`/`redactSecrets` never even puts one
  // there, but the query must not go looking either.
  it("activity_feed shows a connection_call run, with no argument or secret value", async () => {
    const tag = `ccf-${Date.now()}`;
    const meta = { via: "mcp-brain", args: { connection: `${tag}-gh`, tool: "list_issues" }, connection: `${tag}-gh`, connection_tool: "list_issues" };
    await pool.query(
      `INSERT INTO runs (component, kind, ok, tool, meta, finished_at) VALUES ($1, 'connection_call', true, 'connections_call', $2::jsonb, now())`,
      [tag, JSON.stringify(meta)],
    );
    const failMeta = {
      via: "mcp-brain",
      args: { connection: `${tag}-gh`, tool: "search_code", args: { q: "secret_token=abc123" } },
      connection: `${tag}-gh`,
      connection_tool: "search_code",
      detail: "upstream said 500 with token ghp_shouldneverappear",
    };
    await pool.query(
      `INSERT INTO runs (component, kind, ok, error, tool, meta, finished_at) VALUES ($1, 'connection_call', false, 'internal', 'connections_call', $2::jsonb, now())`,
      [tag, JSON.stringify(failMeta)],
    );
    const rows = (await store.run("activity_feed", { hours: 1, limit: 500, agent: tag })).rows;
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.group).toBe("run");
    const ok = rows.find((r) => r.ok === true)!;
    expect(ok).toMatchObject({ kind: "connection_call", subject: `${tag}-gh/list_issues`, detail: `called list_issues on ${tag}-gh` });
    const failed = rows.find((r) => r.ok === false)!;
    expect(failed).toMatchObject({ kind: "connection_call", subject: `${tag}-gh/search_code` });
    expect(failed.detail).toContain("called search_code on");
    expect(failed.detail).toContain("(failed)");
    // never an argument value or a secret, whatever the row's own meta held
    const blob = JSON.stringify(rows);
    expect(blob).not.toContain("secret_token");
    expect(blob).not.toContain("ghp_shouldneverappear");
    expect(blob).not.toContain("upstream said 500");
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
    for (const r of all) expect(FEED_GROUPS).toContain(r.group);

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

  // T1-3 (C43): a routine is its own group, and a row is what the run SAYS
  // happened — read from `ok`/`error` AND `meta.outcome`, because the
  // runner's catch writes a failure with no outcome at all (T1-4). The rows
  // are written through core's startRun/finishRun with the runner's own meta
  // shapes (apps/console/src/runner.ts), so this is the runner's ledger.
  it("activity_feed: a silent tick has no row; a failed routine shows ok = false", async () => {
    const tag = `rt-${Date.now()}`;
    const settle = async (f: Parameters<typeof finishRun>[2], meta: Record<string, unknown> = {}) => {
      const id = await startRun(pool, { component: tag, kind: "routine_run", meta: { scheduled_for: new Date().toISOString(), time_zone: "UTC", ...meta } });
      await finishRun(pool, id, f);
      return id;
    };
    const rowsOf = async () => (await store.run("activity_feed", { hours: 1, limit: 500, agent: tag })).rows;

    // the tick that found nothing to do — the runner's generic row, `silent`
    const silent = await settle({ ok: true, meta: { processed: 0, outcome: "silent" } });
    expect(await rowsOf()).toHaveLength(0);
    expect((await store.run("activity_feed", { hours: 1, limit: 500, kind: "routine" })).rows.map((r) => r.ref)).not.toContain(`runs:${silent}`);

    // the tick that threw: `ok = false`, `error`, and NO `meta.outcome`
    const failed = await settle({ ok: false, error: "vault bridge unreachable", meta: { error_signature: "abc123" } });
    // a schedule the runner could not place, and one that acted and wrote a file
    await settle({ ok: true }, { schedule_refused: "no_working_days", why: "Me/profile.md lists no working days", outcome: "skipped:no_working_days" });
    await settle({ ok: true, meta: { processed: 1, outcome: "acted" } }, { path: "Journal/Plan/2026-09-27.md" });
    // a row from before T1-4, with no outcome: shown, not silently dropped by a NULL comparison
    await settle({ ok: true, meta: { processed: 2 } });

    const rows = await rowsOf();
    expect(rows).toHaveLength(4);
    for (const r of rows) expect(r).toMatchObject({ kind: "routine_run", group: "routine", actor: tag, subject: tag });
    const f = rows.find((r) => r.ref === `runs:${failed}`)!;
    expect(f.ok).toBe(false);
    expect(f.detail).toBe("routine failed vault bridge unreachable");
    expect(rows.filter((r) => r.ok !== false).every((r) => r.ok === true)).toBe(true);
    expect(rows.map((r) => r.detail).sort()).toEqual(
      ["Journal/Plan/2026-09-27.md", "ran · 2 processed", "routine failed vault bridge unreachable", "skipped: no_working_days — Me/profile.md lists no working days"].sort(),
    );

    // in flight is no row — it would vanish again if it settled silent — and
    // a routine row is dated by when it settled, so a long run that finishes
    // after newer rows were painted still arrives through `since`
    const inFlight = await startRun(pool, { component: tag, kind: "routine_run", meta: {} });
    expect((await rowsOf()).map((r) => r.ref)).not.toContain(`runs:${inFlight}`);
    await pool.query(`UPDATE runs SET ts = now() - interval '10 minutes', started_at = now() - interval '10 minutes' WHERE id = $1`, [inFlight]);
    // a cursor painted AFTER the run started (it started ten minutes ago)
    const cursor = new Date(Date.now() - 5 * 60_000).toISOString();
    await finishRun(pool, inFlight, { ok: true, meta: { processed: 3, outcome: "acted" } });
    const late = (await store.run("activity_feed", { hours: 1, limit: 500, agent: tag, since: cursor })).rows;
    expect(late.map((r) => r.ref)).toContain(`runs:${inFlight}`);
  });

  it("activity_feed: `ok` is on every row — the run's own for a run, NULL where the source cannot fail", async () => {
    const tag = `ok-${Date.now()}`;
    await pool.query(`INSERT INTO runs (component, kind, ok, tool, error) VALUES ($1, 'tool', false, 'knowledge_search', 'timeout'), ($1, 'tool', true, 'tasks_update', NULL)`, [tag]);
    await pool.query(`INSERT INTO inbox (source, path, note, status) VALUES ($1, $2, 'a capture', 'new')`, [tag, `Inbox/${tag}.md`]);
    const rows = (await store.run("activity_feed", { hours: 1, limit: 500, agent: tag })).rows;
    expect(rows.find((r) => r.subject === "knowledge_search")!.ok).toBe(false);
    expect(rows.find((r) => r.subject === "tasks_update")!.ok).toBe(true);
    expect(rows.find((r) => r.kind === "capture")!.ok).toBeNull();
    for (const r of rows) expect(Object.keys(r)).toContain("ok");
  });

  it("activity_feed: `turn_id` returns the calls one reply made, whatever the window's limit left out", async () => {
    const tag = `tid-${Date.now()}`;
    const [mine, other] = [`turn-${tag}-a`, `turn-${tag}-b`];
    await pool.query(
      `INSERT INTO runs (component, kind, ok, tool, meta) VALUES
         ($1, 'tool', true, 'knowledge_search', jsonb_build_object('turn_id', $2::text)),
         ($1, 'tool', true, 'tasks_update',     jsonb_build_object('turn_id', $2::text)),
         ($1, 'tool', true, 'knowledge_search', jsonb_build_object('turn_id', $3::text))`,
      [tag, mine, other],
    );
    const rows = (await store.run("activity_feed", { hours: 1, limit: 500, turn_id: mine })).rows;
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.turn_id).toBe(mine);
    // blank is every row, never an error
    expect((await store.run("activity_feed", { hours: 1, limit: 500, agent: tag, turn_id: "" })).rows).toHaveLength(3);
  });

  // The acceptance line: the eight chips resolve. Every chip the PWA draws
  // (read out of app.js) is passed as `kind` exactly as the console passes it,
  // and each answers rows of its own group and no other.
  it("activity_feed: the eight chips resolve — each returns rows, and only its own group's", async () => {
    const tag = `chips-${Date.now()}`;
    await pool.query(`INSERT INTO inbox (source, path, note, status) VALUES ($1, $2, 'chip capture', 'new')`, [tag, `Inbox/${tag}.md`]);
    const { rows: prop } = await pool.query(`INSERT INTO proposals (kind, source_agent, trust, payload) VALUES ('knowledge', $1, 'internal', '{}'::jsonb) RETURNING id`, [tag]);
    await pool.query(`UPDATE proposals SET decision = 'allow', decided_at = now() WHERE id = $1`, [prop[0]!.id]);
    await pool.query(`INSERT INTO runs (component, kind, ok, tool) VALUES ($1, 'tool', true, 'chip-tool')`, [tag]);
    await pool.query(`INSERT INTO runs (component, kind, ok, meta) VALUES ('reconciler', 'config_write', true, jsonb_build_object('principal', $1::text, 'path', '.metistry/identity.yaml'))`, [tag]);
    await pool.query(`INSERT INTO work (title, kind, status, history) VALUES ($1, 'task', 'open', $2::jsonb)`, [`${tag} task`, JSON.stringify([{ ts: new Date().toISOString(), agent: tag, op: "create" }])]);
    await pool.query(`INSERT INTO outbound_messages (thread, text, kind) VALUES ('default', $1, 'brief')`, [`${tag} brief`]);
    await pool.query(`INSERT INTO runs (component, kind, ok, started_at, finished_at, meta) VALUES ($1, 'routine_run', true, now(), now(), '{"outcome":"acted"}')`, [tag]);

    expect(FEED_CHIP_VALUES).toHaveLength(8);
    for (const chip of FEED_CHIP_VALUES) {
      const rows = (await store.run("activity_feed", { hours: 1, limit: 10000, kind: chip })).rows;
      expect(rows.length, `chip "${chip}"`).toBeGreaterThan(0);
      if (chip !== "") for (const r of rows) expect(r.group, `chip "${chip}"`).toBe(chip);
    }
    // a config write is a run (T2-16), under the `run` chip
    const runs = (await store.run("activity_feed", { hours: 1, limit: 10000, kind: "run", agent: tag })).rows;
    expect(runs.map((r) => r.kind).sort()).toEqual(["config_write", "tool"]);
  });

  // T1-8: a mirror closed because its source changed was nobody's decision
  // here — never "you decided resolved_at_source".
  it("activity_feed labels a request resolved at its source as nobody's decision", async () => {
    const tag = `ras-${Date.now()}`;
    await pool.query(
      `INSERT INTO proposals (kind, source_agent, trust, payload, source, decision, decided_at) VALUES ('report', $1, 'internal', '{}'::jsonb, $2::jsonb, 'resolved_at_source', now())`,
      [tag, JSON.stringify({ kind: "github", external_ref: `gh:${tag}#1` })],
    );
    const rows = (await store.run("activity_feed", { hours: 1, limit: 500, agent: tag, kind: "decision" })).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.detail).toBe("resolved at its source (github) — nobody decided it here");

    // with the receipt resolveAtSource writes (T4-23), it says what happened there
    await pool.query(
      `INSERT INTO proposals (kind, source_agent, trust, payload, source, decision, decided_at) VALUES ('pull_request', $1, 'external', $2::jsonb, $3::jsonb, 'resolved_at_source', now())`,
      [tag, JSON.stringify({ cleared: { what: "You approved it on GitHub", where: "github" } }), JSON.stringify({ kind: "github", external_ref: `gh:${tag}#2` })],
    );
    const withReceipt = (await store.run("activity_feed", { hours: 1, limit: 500, agent: tag, kind: "decision" })).rows.map((r) => r.detail);
    expect(withReceipt).toContain("resolved at its source (github): You approved it on GitHub — nobody decided it here");
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
  //
  // FIVE columns since T1-2 (C2, C38, C39): Reported folded into Done as the
  // `reported` flag, and every value is the word its label says.
  const BOARD_ORDER = ["backlog", "assigned", "in_progress", "blocked", "done"];

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

    // one room, on the blocked card — the Blocked card is the one that most
    // wants somewhere to answer (docs/ops/threads.md) — with a root and two
    // replies, so `thread_count` is the room's MESSAGE count, not 1
    await pool.query(
      `INSERT INTO artifact_comments (id, work_id, body, author_principal, author_kind) VALUES ($1, $2, 'why is this stuck?', 'user', 'human')`,
      [`cmt_${tag}`, id.blocked],
    );
    for (const [n, who, kind] of [["a", `${tag}-agent`, "agent"], ["b", "user", "human"]] as const) {
      await pool.query(
        `INSERT INTO artifact_comments (id, work_id, body, author_principal, author_kind, parent_id) VALUES ($1, $2, 'a reply', $3, $4, $5)`,
        [`cmt_${tag}_${n}`, id.blocked, who, kind, `cmt_${tag}`],
      );
    }

    // blocked-by (§3, ported from day_work): the blocked card waits on an
    // OPEN human todo, the backlog card names one already ticked, and the
    // assigned card names a line the index does not have. The ref is the one
    // spelling `vault:<path>#^<anchor>`.
    const todo = async (anchor: string, text: string, checked: boolean) =>
      pool.query(
        `INSERT INTO vault_tasks (path, task_key, anchor, line_no, text, text_norm, checked, parsed_on, first_seen_on, last_seen_at)
         VALUES ($1, $2, $2, 3, $3, lower($3), $4, current_date, current_date, now())`,
        [`Journal/${tag}.md`, anchor, text, checked],
      );
    await todo(`mt-${tag}-open`, `${tag} call the plumber`, false); // tagged: other tests count open lines by their text
    await todo(`mt-${tag}-done`, `${tag} sign the form`, true);
    const blockOn = (workId: number, anchor: string) =>
      pool.query(`UPDATE work SET meta = meta || jsonb_build_object('blocked_by', $2::text) WHERE id = $1`, [workId, `vault:Journal/${tag}.md#^${anchor}`]);
    await blockOn(id.blocked, `mt-${tag}-open`);
    await blockOn(id.backlog, `mt-${tag}-done`);
    await blockOn(id.assigned, `mt-${tag}-nowhere`);

    const { rows } = await store.run("board", { project: tag, limit: 50 });
    const col = new Map(rows.map((r) => [Number(r.id), r.column]));
    expect(col.get(id.backlog)).toBe("backlog");
    expect(col.get(id.overdue)).toBe("backlog");
    expect(col.get(id.assigned)).toBe("assigned"); // owner set, never claimed — the "assigned but not started" state
    expect(col.get(id.working)).toBe("in_progress");
    expect(col.get(id.interrupted)).toBe("in_progress"); // a lapsed lease is still in_progress on the row; the flag says it stalled
    expect(col.get(id.blocked)).toBe("blocked");
    expect(col.get(id.queued)).toBe("blocked");
    expect(col.get(id.done)).toBe("done");
    expect(col.get(id.reported)).toBe("done"); // Reported is a flag on a Done card, not a column (C39)
    expect(new Set(rows.map((r) => r.column))).toEqual(new Set(BOARD_ORDER)); // five, and only five

    // `reported`: closed AND a report came back. The run with `reports: 0`
    // leaves its card unflagged — a crew that produced nothing does not look
    // like one that produced a finding.
    const flag = new Map(rows.map((r) => [Number(r.id), r.reported]));
    expect(flag.get(id.reported)).toBe(true);
    expect(flag.get(id.done)).toBe(false);
    for (const k of ["backlog", "assigned", "working", "blocked"] as const) expect(flag.get(id[k]), k).toBe(false);
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
    expect(thread.get(id.blocked)).toBe(true); // the room opened above
    expect(thread.get(id.backlog)).toBe(false);
    const count = new Map(rows.map((r) => [Number(r.id), r.thread_count]));
    expect(count.get(id.blocked)).toBe(3); // root + two replies — the glyph's number
    expect(count.get(id.backlog)).toBe(0); // zero, never null: Has Thread filters on it

    // blocked-by, resolved beside the card — the same three answers day_work gives
    const card = (k: keyof typeof id) => rows.find((r) => Number(r.id) === id[k])!;
    expect(card("blocked")).toMatchObject({ blocked_by: `vault:Journal/${tag}.md#^mt-${tag}-open`, blocked_by_task: `${tag} call the plumber`, blocked_by_task_open: true });
    expect(card("backlog")).toMatchObject({ blocked_by_task: `${tag} sign the form`, blocked_by_task_open: false }); // ticked: still named, no longer waiting
    expect(card("assigned")).toMatchObject({ blocked_by: `vault:Journal/${tag}.md#^mt-${tag}-nowhere`, blocked_by_task: null, blocked_by_task_open: null }); // the ref, with no text
    expect(card("working")).toMatchObject({ blocked_by: null, blocked_by_task: null, blocked_by_task_open: null });
    // and it surfaces, never gates: the backlog card is still in Backlog
    expect(col.get(id.backlog)).toBe("backlog");

    // description (T1-1, C85): the card detail's first section rides the row;
    // a card nobody described says so with null, never an empty string
    await pool.query(`UPDATE work SET description = $2 WHERE id = $1`, [id.working, `${tag} what the work is about`]);
    const described = (await store.run("board", { project: tag, limit: 50 })).rows;
    expect(described.find((r) => Number(r.id) === id.working)!.description).toBe(`${tag} what the work is about`);
    expect(described.find((r) => Number(r.id) === id.backlog)!.description).toBeNull();

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

    // `limit` is per column, not per result set: backlog, in_progress,
    // blocked and done each hold two fixtures, so limit 1 drops one from each and
    // every column still shows its most recent card. A busy column never
    // crowds another out.
    const capped = (await store.run("board", { project: tag, limit: 1 })).rows;
    const counts = new Map<string, number>();
    for (const r of capped) counts.set(String(r.column), (counts.get(String(r.column)) ?? 0) + 1);
    for (const [c, n] of counts) expect(n, c).toBe(1);
    expect([...counts.keys()].sort()).toEqual([...BOARD_ORDER].sort()); // all five survive
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
    expect([...byCol.keys()].sort()).toEqual(["backlog", "blocked"]);
    expect(Number(byCol.get("backlog")!.cards)).toBe(2);
    expect(Number(byCol.get("backlog")!.escalations)).toBe(0);
    expect(Number(byCol.get("backlog")!.oldest_age_hours)).toBeGreaterThanOrEqual(10);
    expect(Number(byCol.get("blocked")!.cards)).toBe(1);
    expect(Number(byCol.get("blocked")!.escalations)).toBe(1); // blocked and not queued — a human has to move it
    expect(byCol.get("blocked")!.last_activity).not.toBeNull();

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

  // The owner's three knowledge reads (design-build-plan §2.10, T1-6). The
  // fold's rows sit at year 9999 so that "the newest fold there is" is this
  // test's on a scratch database every other suite shares — nothing else
  // writes a `Journal/Fold/` row, and nothing could write a later one.
  const kmk = (path: string, title: string | null, draft = false, status = "clean", description: string | null = title ? `${title} description` : null) =>
    pool.query(`INSERT INTO knowledge_files (path, title, description, draft, status, mtime, indexed_at) VALUES ($1, $2, $3, $4, $5, now(), now())`, [path, title, description, draft, status]);
  const klink = (from: string, to: string, kind = "wikilink") =>
    pool.query(`INSERT INTO knowledge_links (from_path, to_path, kind) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [from, to, kind]);
  const FOLDS = ["Journal/Fold/9999-12-29.md", "Journal/Fold/9999-12-30.md", "Journal/Fold/9999-12-31.md", "Journal/Fold/9999-12-31-notes.md"];

  it("knowledge_fold_latest: newest by the date in the NAME, drafts skipped, links kept or dropped as the graph does", async () => {
    const tag = `Kf${Date.now()}`;
    const area = `Areas/${tag}`;
    await kmk("Journal/Fold/9999-12-29.md", "Fold — 29");
    await kmk("Journal/Fold/9999-12-30.md", "Fold — 30");
    await kmk("Journal/Fold/9999-12-31.md", "Fold — 31", true); // a draft fold is not a fact yet: skipped, not served
    await kmk("Journal/Fold/9999-12-31-notes.md", "not a fold"); // the owner's own note in there: not the shape, so not a fold
    await kmk(`${area}/sleep.md`, "Sleep");
    await kmk(`${area}/secret.md`, "Secret", true);
    await klink("Journal/Fold/9999-12-30.md", `${area}/sleep.md`);
    await klink("Journal/Fold/9999-12-30.md", `${area}/sleep.md`, "embed");
    await klink("Journal/Fold/9999-12-30.md", `${area}/nowhere.md`); // unresolved: kept, marked
    await klink("Journal/Fold/9999-12-30.md", `${area}/secret.md`); // to a draft: dropped
    await klink("Journal/Fold/9999-12-31.md", `${area}/sleep.md`); // from the draft fold: never seen

    try {
      const newest = (await store.run("knowledge_fold_latest", {})).rows;
      expect(newest.map((r) => [r.path, r.date, r.title, r.link_path, r.link_kind, r.link_title, r.link_resolved])).toEqual([
        ["Journal/Fold/9999-12-30.md", "9999-12-30", "Fold — 30", `${area}/nowhere.md`, "wikilink", "nowhere", false],
        ["Journal/Fold/9999-12-30.md", "9999-12-30", "Fold — 30", `${area}/sleep.md`, "embed", "Sleep", true],
        ["Journal/Fold/9999-12-30.md", "9999-12-30", "Fold — 30", `${area}/sleep.md`, "wikilink", "Sleep", true],
      ]);
      expect(JSON.stringify(newest)).not.toContain("secret.md");
      expect(newest[0]!.modified).not.toBeNull();
      // `date` bounds it — on or before — and a fold that links nowhere is ONE row with the link columns NULL
      expect((await store.run("knowledge_fold_latest", { date: "9999-12-30" })).rows.map((r) => r.path)).toEqual(Array(3).fill("Journal/Fold/9999-12-30.md"));
      const bare = (await store.run("knowledge_fold_latest", { date: "9999-12-29" })).rows;
      expect(bare).toEqual([expect.objectContaining({ path: "Journal/Fold/9999-12-29.md", date: "9999-12-29", link_path: null, link_kind: null, link_title: null, link_resolved: null })]);
      // before the first fold there is no row at all — the route's `fold: null`
      expect((await store.run("knowledge_fold_latest", { date: "0001-01-01" })).rows).toEqual([]);
    } finally {
      await pool.query(`DELETE FROM knowledge_links WHERE from_path = ANY($1) OR to_path LIKE $2`, [FOLDS, `%${tag}%`]);
      await pool.query(`DELETE FROM knowledge_files WHERE path = ANY($1) OR path LIKE $2`, [FOLDS, `%${tag}%`]);
    }
  });

  it("knowledge_drafts: the drafts and only the drafts — never a conflict, never a settled page — in byte order of path", async () => {
    const tag = `Kd${Date.now()}`;
    const area = `Areas/${tag}`;
    await kmk(`${area}/b-draft.md`, "B draft", true);
    await kmk(`${area}/a-draft.md`, null, true); // no frontmatter title → the basename
    await kmk(`${area}/torn.md`, "Torn", true, "conflict"); // the indexer marks a conflict `draft` too: it is still not one
    await kmk(`${area}/sleep.md`, "Sleep"); // settled: the page list's, not this one's
    await kmk(`Me/${tag}.md`, "Mine", true); // the owner's own folder: a draft there is still theirs to see
    try {
      const mine = (rows: Record<string, unknown>[]) => rows.filter((r) => String(r.path).includes(tag));
      const all = mine((await store.run("knowledge_drafts", { limit: 500 })).rows);
      expect(all.map((r) => r.path)).toEqual([`${area}/a-draft.md`, `${area}/b-draft.md`, `Me/${tag}.md`]); // byte order: `Areas/` before `Me/`
      expect(all[0]).toMatchObject({ area, title: "a-draft", description: null });
      expect(all[1]).toMatchObject({ area, title: "B draft", description: "B draft description" });
      expect(all[2]).toMatchObject({ area: "Me" });
      for (const r of all) expect(r.modified).not.toBeNull();
      expect(Object.keys(all[0]!).sort()).toEqual(["area", "description", "modified", "path", "title"]);
    } finally {
      await pool.query(`DELETE FROM knowledge_files WHERE path LIKE $1`, [`%${tag}%`]);
    }
  });

  it("knowledge_areas: one row per derived area — README's description, settled count, last change, named by the newest fold", async () => {
    const tag = `Ka${Date.now()}`;
    const area = `Areas/${tag}`;
    const sibling = `Areas/${tag}care`;
    await kmk(`${area}/README.md`, "Index", false, "clean", "Sleep, labs, and the protein blend");
    await kmk(`${area}/sleep.md`, "Sleep");
    await kmk(`${area}/2026/taper.md`, "Taper"); // deeper than two segments: still this area
    await kmk(`${area}/secret.md`, "Secret", true); // a draft: not counted
    await kmk(`${area}/torn.md`, "Torn", false, "conflict"); // unsettled: not counted
    await kmk(`${sibling}/billing.md`, "Billing"); // no README: no description, and still an area
    await kmk(`${sibling}/README.md`, "Care", true, "clean", "a draft's description is not a fact"); // a DRAFT index page describes nothing
    await kmk(`${tag}.md`, "root"); // a vault-root file belongs to no area
    await kmk("Journal/Fold/9999-12-30.md", "Fold");
    await klink("Journal/Fold/9999-12-30.md", `${area}/2026/taper.md`);
    await klink("Journal/Fold/9999-12-30.md", `${sibling}/README.md`); // to a draft: names nothing
    await pool.query(`UPDATE knowledge_files SET mtime = '2026-09-20T12:00:00Z' WHERE path LIKE $1`, [`${area}/%`]);
    await pool.query(`UPDATE knowledge_files SET mtime = '2026-09-27T08:00:00Z' WHERE path = $1`, [`${area}/sleep.md`]);
    await pool.query(`UPDATE knowledge_files SET mtime = '2026-09-28T08:00:00Z' WHERE path = $1`, [`${area}/secret.md`]); // newer, and a draft: not the last change
    try {
      const rows = (await store.run("knowledge_areas", {})).rows;
      const mine = rows.filter((r) => String(r.area).includes(tag));
      expect(mine.map((r) => r.area)).toEqual([area, sibling]);
      expect(mine[0]).toEqual({ area, description: "Sleep, labs, and the protein blend", pages: 3, last_change: new Date("2026-09-27T08:00:00Z"), named_by_fold: true });
      expect(mine[1]).toMatchObject({ area: sibling, description: null, pages: 1, named_by_fold: false });
      expect(rows.some((r) => r.area === null)).toBe(false); // the root file is in no area
      expect(rows.find((r) => r.area === "Journal")).toMatchObject({ named_by_fold: false }); // the fold's own folder is not named by it linking elsewhere
      // byte order over the whole result, so the list is the same on every cluster
      const names = rows.map((r) => String(r.area));
      expect(names).toEqual([...names].sort((a, b) => (Buffer.from(a) < Buffer.from(b) ? -1 : 1)));
    } finally {
      await pool.query(`DELETE FROM knowledge_links WHERE from_path = ANY($1) OR to_path LIKE $2`, [FOLDS, `%${tag}%`]);
      await pool.query(`DELETE FROM knowledge_files WHERE path = ANY($1) OR path LIKE $2`, [FOLDS, `%${tag}%`]);
    }
  });

  // ---------------------------------------------------------------------
  // The daily flow (docs/product/daily-flow-spec.md §11, P1-5). Rows are
  // inserted BY HAND here: the parser-driven population is the indexer's
  // (P1-4), and what these assert is the read — the filtering, the
  // ordering, and the three rules that live in the SQL rather than in a
  // caller (a rule line is not a task, `or` never widens the scope, and the
  // path order is byte order).
  // ---------------------------------------------------------------------

  const DAY = "2026-09-20"; // fixed: nothing here may depend on the clock

  /** One vault_tasks row, with the NOT NULLs filled and everything else the caller's. */
  const task = (pool: pg.Pool, o: Record<string, unknown>) => {
    const row: Record<string, unknown> = {
      checked: false,
      dropped: false,
      parsed_on: DAY,
      first_seen_on: DAY,
      last_seen_at: new Date(),
      ...o,
    };
    const keys = Object.keys(row);
    return pool.query(
      `INSERT INTO vault_tasks (${keys.join(", ")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")})`,
      keys.map((k) => row[k]),
    );
  };

  it("vault_tasks_query: TASK_FILTER_PARAM_SPEC's bind params, the scope `or` cannot widen, and a total order", async () => {
    const tag = `vtq-${Date.now()}`;
    const mine = `${tag}`;
    const anchor = `mt-${tag.slice(-8)}`;
    await task(pool, { path: `${mine}/a.md`, task_key: anchor, anchor, line_no: 1, text: "Call the dentist", text_norm: "call the dentist", due: "2026-09-18", priority: 1 });
    await task(pool, { path: `${mine}/a.md`, task_key: "k2", line_no: 2, text: "Draft the Q4 plan", text_norm: "draft the q4 plan", due: "2026-09-30", priority: 2, size: "L", type: "planning", project: "drey", area: "Areas/Work", source: "template:recurring" });
    // a RULE line: never a row of this query (§4)
    await task(pool, { path: `${mine}/a.md`, task_key: "k3", line_no: 3, text: "Water the plants", text_norm: "water the plants", recur_rule: "every week", recur_next: DAY });
    await task(pool, { path: `${mine}/b.md`, task_key: "k4", line_no: 1, text: "Send Jim the brand deck", text_norm: "send jim the brand deck", assigned: "People/Jim Fallon.md", waiting: true, scheduled_for: "2026-09-19", size: "S", area: "Areas/Work/Drey", source: "meeting:Journal/Meetings/2026-09-19-sync.md" });
    await task(pool, { path: `${mine}/b.md`, task_key: "k5", line_no: 2, text: "Send the contract", text_norm: "send the contract", checked: true, done_on: "2026-09-19" });
    // §2.3: the same task typed twice — two rows, linked, never merged. Its
    // area is a SUBSTRING of the one above and must not answer to it.
    await task(pool, { path: `${mine}/b.md`, task_key: "k6", line_no: 3, text: "Call the dentist", text_norm: "call the dentist", duplicate_of: anchor, area: "Areas/Workshop", source: "meetings:not-a-meeting" });
    // a sibling path that a SUBSTRING prefix would wrongly swallow
    await task(pool, { path: `${mine}-other/c.md`, task_key: "k7", line_no: 1, text: "Elsewhere", text_norm: "elsewhere", due: DAY });

    const lines = (rows: Record<string, unknown>[]) => rows.map((r) => `${r.path}:${r.line_no}`);
    const all = await store.run(TASK_QUERY_NAME, { today: DAY, path_prefix: mine, limit: 500 });

    // the rule line is gone, the ticked line is gone, and with no `order:` at
    // all the order is the vault's own — path in BYTE order, then line —
    // which is also the tie-break under every `order:`
    expect(lines(all.rows)).toEqual([`${mine}/a.md:1`, `${mine}/a.md:2`, `${mine}/b.md:1`, `${mine}/b.md:3`]);
    // D5: unset priority IS normal, so it sorts and filters as 3
    expect(all.rows.map((r) => r.priority_effective)).toEqual([1, 2, 3, 3]);
    expect(all.rows[3]).toMatchObject({ priority: null, priority_effective: 3 });

    // segment-wise prefix: `<tag>-other/` is NOT under `<tag>`
    expect(lines(all.rows).some((p) => p.includes("-other"))).toBe(false);
    expect(lines((await store.run(TASK_QUERY_NAME, { today: DAY, path_prefix: `${mine}-other`, limit: 500 })).rows)).toEqual([`${mine}-other/c.md:1`]);

    // the flags of §6.2, computed here and not by the caller
    expect(all.rows[0]!.row_flags).toEqual(expect.arrayContaining(["overdue", "carried", "assigned_to_me"]));
    expect(all.rows[2]!.row_flags).toEqual(expect.arrayContaining(["waiting", "carried"]));
    expect(all.rows[2]!.row_flags).not.toContain("assigned_to_me"); // delegated to Jim
    expect(all.rows[3]!.row_flags).toContain("unscheduled");
    expect(Number(all.rows[0]!.carried_days)).toBe(2);
    expect(Number(all.rows[0]!.age_days)).toBe(0); // `carried` is "owed earlier"; `age` is "has been sitting" — two questions

    const at = (p: Record<string, unknown>) => store.run(TASK_QUERY_NAME, { today: DAY, path_prefix: mine, limit: 500, ...p }).then((r) => lines(r.rows));

    // one BOOLEAN per flag, not a comma-separated set
    expect(await at({ overdue: true })).toEqual([`${mine}/a.md:1`]);
    expect(await at({ waiting: true })).toEqual([`${mine}/b.md:1`]);
    expect(await at({ unscheduled: true })).toEqual([`${mine}/b.md:3`]);
    expect(await at({ carried: true })).toEqual([`${mine}/a.md:1`, `${mine}/b.md:1`]);
    // AND is the default: both flags must hold, and no row is both
    expect(await at({ waiting: true, assigned_to_me: true })).toEqual([]);
    // `match_any`: either is enough — this is what `waiting or overdue` compiles to
    expect(await at({ waiting: true, overdue: true, match_any: true })).toEqual([`${mine}/a.md:1`, `${mine}/b.md:1`]);
    expect(await at({ due_on_or_before: DAY, waiting: true, match_any: true })).toEqual([`${mine}/a.md:1`, `${mine}/b.md:1`]);

    // three inclusive date params per field; the parser folded `<` and `>`
    // and resolved every relative token before binding
    expect(await at({ due_on_or_after: "2026-09-19" })).toEqual([`${mine}/a.md:2`]);
    expect(await at({ due_on_or_before: "2026-09-18" })).toEqual([`${mine}/a.md:1`]);
    expect(await at({ due_on: "2026-09-18" })).toEqual([`${mine}/a.md:1`]);
    expect(await at({ do_on: "2026-09-19" })).toEqual([`${mine}/b.md:1`]);
    expect(await at({ do_on_or_after: "2026-09-19", do_on_or_before: "2026-09-19" })).toEqual([`${mine}/b.md:1`]);

    // priority bounds are NUMERIC: `<= 2` is p1 or p2, i.e. MORE important
    expect(await at({ priority_max: 2 })).toEqual([`${mine}/a.md:1`, `${mine}/a.md:2`]);
    expect(await at({ priority_min: 2 })).toEqual([`${mine}/a.md:2`, `${mine}/b.md:1`, `${mine}/b.md:3`]);
    expect(await at({ priority_eq: 1 })).toEqual([`${mine}/a.md:1`]);

    // size: the letter, or a bound on s=1 m=2 l=3
    expect(await at({ size: "l" })).toEqual([`${mine}/a.md:2`]); // case-insensitive: the index stores `L`
    expect(await at({ size_rank_max: 1 })).toEqual([`${mine}/b.md:1`]);
    expect(await at({ size_rank_min: 3 })).toEqual([`${mine}/a.md:2`]);

    expect(await at({ type: "planning" })).toEqual([`${mine}/a.md:2`]);
    expect(await at({ project: "drey" })).toEqual([`${mine}/a.md:2`]);
    expect(await at({ assigned: "People/Jim Fallon.md" })).toEqual([`${mine}/b.md:1`]);
    // `area_prefix` takes the value and its CHILDREN, and `Areas/Workshop` is
    // neither — the prefix is matched segment-wise, never as a substring
    expect(await at({ area_prefix: "Areas/Work" })).toEqual([`${mine}/a.md:2`, `${mine}/b.md:1`]);
    expect(await at({ area_prefix: "Areas/Workshop" })).toEqual([`${mine}/b.md:3`]);
    // `source_prefix` takes `meeting` and every `meeting:<path>`, and stops
    // at the colon — `meetings:…` is a different source
    expect(await at({ source_prefix: "meeting" })).toEqual([`${mine}/b.md:1`]);
    expect(await at({ source_prefix: "template" })).toEqual([`${mine}/a.md:2`]);

    // THE NULL BUG, pinned: every nullable column compares under
    // `coalesce(…, false)`, because NULL is how the clause array spells "the
    // caller did not ask". Without it, `size: l` comes back with every task
    // that has no size at all — the filter undone by the rows it excludes.
    expect(await at({ size: "l" })).not.toContain(`${mine}/a.md:1`);
    expect(await at({ type: "planning" })).not.toContain(`${mine}/b.md:3`);
    expect(await at({ due_on_or_before: "2999-01-01" })).not.toContain(`${mine}/b.md:3`); // no due date is not "due before everything"

    // `match_any` widens the PREDICATE, never the SCOPE: no combinator
    // reaches a ticked line, a rule line, or a path outside the prefix
    expect(await at({ overdue: true, match_any: true, done_on_or_after: "2026-09-19" })).toEqual([`${mine}/a.md:1`]);
    expect(await at({ status: "done" })).toEqual([`${mine}/b.md:2`]);
    expect(await at({ status: "waiting" })).toEqual([`${mine}/b.md:1`]);
    expect(await at({ status: "any" })).toHaveLength(5); // still no rule line
    expect((await store.run(TASK_QUERY_NAME, { today: DAY, path_prefix: mine, status: "any", limit: 500 })).rows.some((r) => r.text === "Water the plants")).toBe(false);

    // §2.3: both places counted, neither merged
    expect(Number(all.rows[0]!.places)).toBe(2);
    expect(Number(all.rows[3]!.places)).toBe(2);
    expect(all.rows[3]!.duplicate_of).toBe(anchor);

    // `order:` — three slots, each optionally desc, then the byte-ordered
    // path tie-break that makes the order total
    expect(await at({ order_1: "priority", order_2: "due" })).toEqual([`${mine}/a.md:1`, `${mine}/a.md:2`, `${mine}/b.md:1`, `${mine}/b.md:3`]);
    expect(await at({ order_1: "due" })).toEqual([`${mine}/a.md:1`, `${mine}/a.md:2`, `${mine}/b.md:1`, `${mine}/b.md:3`]); // no due sorts last (9999-12-31)
    expect(await at({ order_1: "due", order_1_desc: true })).toEqual([`${mine}/b.md:1`, `${mine}/b.md:3`, `${mine}/a.md:2`, `${mine}/a.md:1`]);
    expect(await at({ order_1: "priority", order_1_desc: true })).toEqual([`${mine}/b.md:1`, `${mine}/b.md:3`, `${mine}/a.md:2`, `${mine}/a.md:1`]);
    // an unrecognised slot sorts nothing and falls through to the next — the
    // parser refuses one at render time, so the database has no opinion
    expect(await at({ order_1: "nonsense", order_2: "due" })).toEqual(await at({ order_1: "due" }));

    // offset walks that same total order — (path, line_no, task_key) cannot tie
    const windows = await Promise.all([0, 1, 2, 3, 4].map((offset) => at({ limit: 1, offset })));
    expect(windows.flat()).toEqual(lines(all.rows));

    // §3's other direction: a work row naming this line surfaces here and
    // gates nothing — depends_on and claimability are untouched
    const { rows: w } = await pool.query(
      `INSERT INTO work (title, kind, status, project, external_ref, meta) VALUES ($1, 'task', 'open', $2, $3, $4::jsonb) RETURNING id`,
      ["Book the follow-up", tag, `probe:${tag}`, JSON.stringify({ blocked_by: `vault:${mine}/a.md#^${anchor}` })],
    );
    const blocking = await store.run(TASK_QUERY_NAME, { today: DAY, path_prefix: mine, blocking_agent: true, limit: 500 });
    expect(lines(blocking.rows)).toEqual([`${mine}/a.md:1`]);
    expect(blocking.rows[0]).toMatchObject({ blocks_work_id: String(w[0]!.id), blocks_work_title: "Book the follow-up", blocks_work_status: "open" });
    expect(blocking.rows[0]!.row_flags).toContain("blocking_agent");

    await pool.query(`DELETE FROM work WHERE project = $1`, [tag]);
    await pool.query(`DELETE FROM vault_tasks WHERE path LIKE $1`, [`${tag}%`]);
  });

  // Ruling 14 (X-14): the carry count, `names_person` and `not <flag>`, as
  // the query judges them — and Slipping and Owed through `compileTaskFilter`
  // into ONE `QueryStore.run` each, with no translation in between.
  it("vault_tasks_query: the carry count, names_person and not_<flag> — Slipping and Owed are one parameterised run each", async () => {
    const tag = `vtq-r14-${Date.now()}`;
    const me = `${tag}/People/Me.md`;
    // carried days are `today - coalesce(do, due)` for an open line
    await task(pool, { path: `${tag}/s.md`, task_key: "c1", line_no: 1, text: "Carried one day", text_norm: "carried one day", scheduled_for: "2026-09-19" });
    await task(pool, { path: `${tag}/s.md`, task_key: "c3", line_no: 2, text: "Carried three days", text_norm: "carried three days", scheduled_for: "2026-09-17" });
    await task(pool, { path: `${tag}/s.md`, task_key: "o5", line_no: 3, text: "Overdue by five", text_norm: "overdue by five", due: "2026-09-15" });
    await task(pool, { path: `${tag}/s.md`, task_key: "owed", line_no: 4, text: "Send Jim the deck", text_norm: "send jim the deck", assigned: "People/Jim Fallon.md", due: "2026-09-25" });
    await task(pool, { path: `${tag}/s.md`, task_key: "wait", line_no: 5, text: "Hear back from Jim", text_norm: "hear back from jim", assigned: "People/Jim Fallon.md", waiting: true });
    await task(pool, { path: `${tag}/s.md`, task_key: "self", line_no: 6, text: "My own line", text_norm: "my own line", assigned: me });
    await task(pool, { path: `${tag}/s.md`, task_key: "plain", line_no: 7, text: "Nothing special", text_norm: "nothing special" });
    try {
      const run = (p: Record<string, unknown>) => store.run(TASK_QUERY_NAME, { today: DAY, path_prefix: tag, limit: 500, ...p });
      const keys = async (p: Record<string, unknown>) => (await run(p)).rows.map((r) => String(r.task_key));

      // the carry count, inclusive, and a line that is not carried counts 0
      expect(await keys({ carried_min: 3 })).toEqual(["c3", "o5"]);
      expect(await keys({ carried_max: 1 })).toEqual(["c1", "owed", "wait", "self", "plain"]);
      expect(await keys({ carried_eq: 3 })).toEqual(["c3"]);
      expect(await keys({ carried_min: 2, carried_max: 4 })).toEqual(["c3"]);
      expect(await keys({ order_1: "carried", order_1_desc: true, limit: 2 })).toEqual(["o5", "c3"]);

      // names_person: someone who is not the owner — with `me` blank, anyone named
      expect(await keys({ names_person: true })).toEqual(["owed", "wait", "self"]);
      expect(await keys({ names_person: true, me })).toEqual(["owed", "wait"]);
      const all = await run({ me });
      expect(all.rows.find((r) => r.task_key === "owed")!.row_flags).toContain("names_person");
      expect(all.rows.find((r) => r.task_key === "self")!.row_flags).not.toContain("names_person");
      // it is exactly the rows `assigned_to_me` does not hold
      expect(await keys({ names_person: true, me })).toEqual(await keys({ not_assigned_to_me: true, me }));

      // not_<flag>: NOT of the same column, under either joiner
      expect(await keys({ not_carried: true })).toEqual(["owed", "wait", "self", "plain"]);
      expect(await keys({ not_waiting: true, names_person: true })).toEqual(["owed", "self"]);
      expect(await keys({ overdue: true, not_unscheduled: true, match_any: true })).toEqual(["c1", "c3", "o5", "owed"]);

      // Slipping and Owed, as a caller runs them: compiled, then one run
      const view = async (where: string) => {
        const out = compileTaskFilter({ where }, { now: new Date(`${DAY}T12:00:00Z`), timeZone: "UTC" });
        if (!out.ok) throw new Error(out.error);
        return (await store.run(TASK_QUERY_NAME, { ...out.params, today: DAY, me, path_prefix: tag, limit: 500 })).rows.map((r) => String(r.task_key));
      };
      expect(await view("carried >= 3 or overdue or names_person")).toEqual(["c3", "o5", "owed", "wait"]);
      expect(await view("names_person and not waiting")).toEqual(["owed"]);
    } finally {
      await pool.query(`DELETE FROM vault_tasks WHERE path LIKE $1`, [`${tag}%`]);
    }
  });

  // D15 END TO END, which is the whole point of P1-2 and P1-5 being one
  // contract: a `where:`/`order:` a user could type in a template goes
  // through `compileTaskFilter` and straight into `QueryStore.run` with NO
  // name translation anywhere between them. If a param were renamed on
  // either side this test throws `unknown param`, which is exactly what the
  // renderer would have done at 19:00.
  it("compileTaskFilter → QueryStore.run: `due <= today and priority >= P2 order priority, due` with no translation in between", async () => {
    const tag = `vtq-e2e-${Date.now()}`;
    await task(pool, { path: `${tag}/e.md`, task_key: "e1", line_no: 1, text: "Overdue, priority unset", text_norm: "overdue priority unset", due: "2026-09-18" });
    await task(pool, { path: `${tag}/e.md`, task_key: "e2", line_no: 2, text: "Due today, p1", text_norm: "due today p1", due: DAY, priority: 1 });
    await task(pool, { path: `${tag}/e.md`, task_key: "e3", line_no: 3, text: "Due today, p2", text_norm: "due today p2", due: DAY, priority: 2 });
    await task(pool, { path: `${tag}/e.md`, task_key: "e4", line_no: 4, text: "Due next week, p4", text_norm: "due next week p4", due: "2026-09-30", priority: 4 });
    await task(pool, { path: `${tag}/e.md`, task_key: "e5", line_no: 5, text: "No due date at all, p4", text_norm: "no due date at all p4", priority: 4 });

    const out = compileTaskFilter(
      { where: "due <= today and priority >= P2", order: "priority, due" },
      { now: new Date(`${DAY}T12:00:00Z`), timeZone: "UTC" }, // `today` resolves where the timezone is known, never in SQL
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // the compiled shape, spelled out once: an inclusive bound the parser
    // folded, a NUMERIC priority bound, two order slots, and `and`
    expect(out.params).toMatchObject({
      due_on_or_before: DAY,
      due_on: "",
      priority_min: 2,
      priority_max: 0,
      order_1: "priority",
      order_2: "due",
      match_any: false,
      limit: 50,
    });
    // the context params are the CALLER's and the compile never touches them
    expect(out.params).toMatchObject({ today: "", me: "", path_prefix: "", offset: 0 });

    const { rows } = await store.run(TASK_QUERY_NAME, { ...out.params, today: DAY, path_prefix: tag });
    // p2 before the unset (which is p3, D5); the p1 is MORE important than
    // p2 and `priority >= P2` is numeric, so it is out; next week is not
    // due yet; and the line with NO due date does not answer a due bound at
    // all — `coalesce(…, false)`, the NULL bug this contract was written
    // over.
    expect(rows.map((r) => r.task_key)).toEqual(["e3", "e1"]);
    expect(rows.map((r) => r.due)).toEqual([DAY, "2026-09-18"]); // ISO text, never a JS Date at the process's midnight

    await pool.query(`DELETE FROM vault_tasks WHERE path LIKE $1`, [`${tag}%`]);
  });

  it("vault_tasks_query: the `someday` flag (K6, T2-5) — `where: \"someday\"` finds exactly the lines the owner deferred to no day", async () => {
    const tag = `vtq-someday-${Date.now()}`;
    await task(pool, { path: `${tag}/s.md`, task_key: "s1", line_no: 1, text: "Learn the cello", text_norm: "learn the cello", someday: true });
    await task(pool, { path: `${tag}/s.md`, task_key: "s2", line_no: 2, text: "Pay rent", text_norm: "pay rent", scheduled_for: "2026-09-19" });
    await task(pool, { path: `${tag}/s.md`, task_key: "s3", line_no: 3, text: "Nobody has looked at this", text_norm: "nobody has looked at this" });

    const out = compileTaskFilter({ where: "someday" }, { now: new Date(`${DAY}T12:00:00Z`), timeZone: "UTC" });
    if (!out.ok) throw new Error(out.error);
    const r = await store.run(TASK_QUERY_NAME, { ...out.params, today: DAY, path_prefix: tag });
    expect(r.rows.map((x) => x.task_key)).toEqual(["s1"]);
    expect(r.rows[0]).toMatchObject({ someday: true, scheduled_for: null });
    // the chip and the filter judge the same column
    expect(r.rows[0]!.row_flags).toContain("someday");
    // and it does not change what `unscheduled` means: a someday line with no date is both
    const unscheduled = await store.run(TASK_QUERY_NAME, { today: DAY, path_prefix: tag, unscheduled: true });
    expect(unscheduled.rows.map((x) => x.task_key)).toEqual(["s1", "s3"]);
    const all = await store.run(TASK_QUERY_NAME, { today: DAY, path_prefix: tag });
    expect(all.rows.find((x) => x.task_key === "s3")!.row_flags).not.toContain("someday");
  });

  it("vault_tasks_recurring: rule lines only, the still-open instance beside each, and a rule that could not be read comes back first", async () => {
    const tag = `vtr-${Date.now()}`;
    await task(pool, { path: `${tag}/r.md`, task_key: "rule-week", line_no: 1, text: "Water the plants", text_norm: "water the plants", recur_rule: "every week", recur_next: DAY, size: "S" });
    await task(pool, { path: `${tag}/r.md`, task_key: "rule-later", line_no: 2, text: "Pay the card", text_norm: "pay the card", recur_rule: "every month", recur_next: "2026-09-28" });
    await task(pool, { path: `${tag}/r.md`, task_key: "rule-unread", line_no: 3, text: "Something", text_norm: "something", recur_rule: "every fortnite", parse_warning: "every fortnite" });
    // the week rule's previous instance, still unchecked — §4's "one open
    // instance per rule, ever"
    await task(pool, { path: `${tag}/2026-09-13.md`, task_key: "inst-1", line_no: 4, text: "Water the plants", text_norm: "water the plants", recur_parent: "rule-week", source: "template:recurring", first_seen_on: "2026-09-13" });
    // and one it already closed, which must not count as open
    await task(pool, { path: `${tag}/2026-09-06.md`, task_key: "inst-0", line_no: 4, text: "Water the plants", text_norm: "water the plants", recur_parent: "rule-week", checked: true, done_on: "2026-09-06", first_seen_on: "2026-09-06" });

    const { rows } = await store.run("vault_tasks_recurring", { due: DAY, prefix: tag, limit: 50 });
    // the unreadable rule first (recur_next IS NULL sorts first, carrying its
    // warning), then what is due; the rule not due yet is absent
    expect(rows.map((r) => r.task_key)).toEqual(["rule-unread", "rule-week"]);
    expect(rows[0]).toMatchObject({ recur_next: null, parse_warning: "every fortnite" });
    expect(rows[1]).toMatchObject({
      recur_rule: "every week",
      recur_next: DAY,
      open_instance_path: `${tag}/2026-09-13.md`,
      open_instance_task_key: "inst-1",
      open_instance_since: "2026-09-13",
    });
    expect(Number(rows[1]!.open_instance_age_days)).toBe(7);
    expect(Number(rows[1]!.instances)).toBe(2);
    expect(Number(rows[1]!.instances_done)).toBe(1);
    expect(rows[0]!.open_instance_path).toBeNull(); // nothing materialised from a rule nobody could read

    // the instances themselves are ordinary tasks, and the rules are not
    const open = await store.run(TASK_QUERY_NAME, { today: DAY, path_prefix: tag, limit: 50 });
    expect(open.rows.map((r) => r.task_key)).toEqual(["inst-1"]);
    expect(open.rows[0]!.row_flags).toContain("recurring"); // an INSTANCE of a rule — the only sense a row here can be recurring

    await pool.query(`DELETE FROM vault_tasks WHERE path LIKE $1`, [`${tag}%`]);
  });

  it("day_work: meta.blocked_by resolved beside the row, surfacing and never gating; closed rows only on the day", async () => {
    const tag = `dw-${Date.now()}`;
    const anchor = `mt-${tag.slice(-8)}`;
    await task(pool, { path: `${tag}/a.md`, task_key: anchor, anchor, line_no: 1, text: "Call the dentist", text_norm: "call the dentist" });
    const mk = (title: string, o: Record<string, unknown> = {}) =>
      pool.query(
        `INSERT INTO work (title, kind, status, project, external_ref, due, closed_at, depends_on, meta)
         VALUES ($1, 'task', $2, $3, $4, $5, $6, '{}', $7::jsonb) RETURNING id`,
        [title, o.status ?? "open", tag, `probe:${tag}:${title}`, o.due ?? null, o.closed_at ?? null, JSON.stringify(o.meta ?? {})],
      );
    const blocked = (await mk("Book the follow-up", { meta: { blocked_by: `vault:${tag}/a.md#^${anchor}` } })).rows[0]!.id;
    await mk("Dangling", { meta: { blocked_by: `vault:${tag}/gone.md#^mt-nothing` } });
    await mk("Held", { status: "blocked" });
    await mk("Shipped yesterday", { status: "closed", closed_at: `${DAY}T10:00:00Z` });
    await mk("Shipped last week", { status: "closed", closed_at: "2026-09-10T10:00:00Z" });

    const titles = (rows: Record<string, unknown>[]) => rows.map((r) => r.title);
    const all = await store.run("day_work", { day: DAY, project: tag, limit: 50 });
    // scope: everything open, PLUS what closed on the day — never what
    // closed a week ago
    expect(titles(all.rows).sort()).toEqual(["Book the follow-up", "Dangling", "Held", "Shipped yesterday"]);

    const waiting = await store.run("day_work", { day: DAY, project: tag, flags: "waiting_on_me", limit: 50 });
    expect(titles(waiting.rows)).toEqual(["Book the follow-up"]);
    expect(waiting.rows[0]).toMatchObject({
      id: String(blocked),
      blocked_by: `vault:${tag}/a.md#^${anchor}`,
      blocked_by_path: `${tag}/a.md`,
      blocked_by_anchor: anchor,
      blocked_by_task: "Call the dentist",
      blocked_by_task_open: true,
    });
    // it SURFACES and never gates: `depends_on` is still empty and the row is
    // still claimable, which is the whole of §3's design
    const { rows: raw } = await pool.query(`SELECT depends_on, claimed_by, status FROM work WHERE id = $1`, [blocked]);
    expect(raw[0]).toMatchObject({ depends_on: [], claimed_by: null, status: "open" });

    // a ref pointing at a line the index does not hold is a path with no
    // text, never a silently dropped row
    const dangling = all.rows.find((r) => r.title === "Dangling")!;
    expect(dangling).toMatchObject({ blocked_by_path: `${tag}/gone.md`, blocked_by_task: null, blocked_by_task_open: null });
    expect(dangling.row_flags).not.toContain("waiting_on_me");

    // and the blocking todo closing is what clears it — no second mechanism
    await pool.query(`UPDATE vault_tasks SET checked = true, done_on = $1 WHERE anchor = $2`, [DAY, anchor]);
    expect((await store.run("day_work", { day: DAY, project: tag, flags: "waiting_on_me", limit: 50 })).rows).toHaveLength(0);

    expect(titles((await store.run("day_work", { day: DAY, project: tag, flags: "blocked", limit: 50 })).rows)).toEqual(["Held"]);
    expect(titles((await store.run("day_work", { day: DAY, project: tag, flags: "closed", limit: 50 })).rows)).toEqual(["Shipped yesterday"]);
    // AND needs both; OR needs either
    expect((await store.run("day_work", { day: DAY, project: tag, flags: "blocked,closed", limit: 50 })).rows).toHaveLength(0);
    expect(titles((await store.run("day_work", { day: DAY, project: tag, flags: "blocked,closed", combine: "or", limit: 50 })).rows).sort()).toEqual(["Held", "Shipped yesterday"]);

    await pool.query(`DELETE FROM work WHERE project = $1`, [tag]);
    await pool.query(`DELETE FROM vault_tasks WHERE path LIKE $1`, [`${tag}%`]);
  });

  it("pending_requests: pending and not snoozed, the user's word for the type, and never the payload", async () => {
    const tag = `pr-${Date.now()}`;
    const mk = (kind: string, payload: unknown, o: { decision?: string; snoozed?: string } = {}) =>
      pool.query(
        `INSERT INTO proposals (kind, source_agent, trust, payload, decision, snoozed_until)
         VALUES ($1, $2, 'internal', $3::jsonb, $4, $5) RETURNING id`,
        [kind, tag, JSON.stringify(payload), o.decision ?? "pending", o.snoozed ?? null],
      );
    await mk("report", { classification: { action: "Call the dentist" }, suggested_work: { title: "Call the dentist" }, secret: "must not travel" });
    await mk("access_request", { area: "Areas/Health" });
    await mk("decision", { title: "Enrol this agent?" }, { snoozed: "2099-01-01T00:00:00Z" });
    await mk("knowledge", { title: "Answered already" }, { decision: "allow" });

    const mine = (rows: Record<string, unknown>[]) => rows.filter((r) => r.source_agent === tag);
    const shown = mine((await store.run("pending_requests", { limit: 500 })).rows);
    // oldest first; the snoozed row has left the queue and the decided one
    // was never in it
    expect(shown.map((r) => r.kind)).toEqual(["report", "access_request"]);
    expect(shown[0]).toMatchObject({ request_type: "report", title: "Call the dentist", has_suggested_work: true, snoozed_until: null });
    // `access_request` and `grant_elevation` are both "access" — the user has
    // one word for this (routines/morning-brief/run.ts's requestType)
    expect(shown[1]).toMatchObject({ request_type: "access", title: "access request", has_suggested_work: false });
    // handles, never the payload
    expect(JSON.stringify(shown)).not.toContain("must not travel");
    expect(Object.keys(shown[0]!)).not.toContain("payload");

    // `later` is not an answer, and it is not an absence either
    const withSnoozed = mine((await store.run("pending_requests", { include_snoozed: true, limit: 500 })).rows);
    expect(withSnoozed.map((r) => r.request_type)).toEqual(["report", "access", "question"]);
    expect(withSnoozed[2]!.snoozed_until).not.toBeNull();
    expect(mine((await store.run("pending_requests", { kind: "report", limit: 500 })).rows)).toHaveLength(1);

    await pool.query(`DELETE FROM proposals WHERE source_agent = $1`, [tag]);
  });

  // The sidebar row and the Dock badge (T1-7, §2.10, §2.12): always exactly
  // one row, a snoozed proposal never moves it, and its `waiting` never
  // disagrees with the same pending-and-not-snoozed filter run by hand — the
  // same filter `GET /api/proposals` applies, so this is the ticket's
  // acceptance ("matches GET /api/proposals' length") checked at the SQL
  // level rather than over HTTP.
  it("pending_count: always one row, a snoozed proposal is not counted, and `waiting` is exactly the pending-and-not-snoozed filter's count", async () => {
    const tag = `pc-${Date.now()}`;
    const mk = (o: { decision?: string; snoozed?: string } = {}) =>
      pool.query(
        `INSERT INTO proposals (kind, source_agent, trust, payload, decision, snoozed_until) VALUES ('report', $1, 'internal', '{}'::jsonb, $2, $3) RETURNING id`,
        [tag, o.decision ?? "pending", o.snoozed ?? null],
      );
    const rawCount = async () =>
      Number(
        (
          await pool.query(
            `SELECT count(*)::int AS n FROM proposals WHERE decision = 'pending' AND (snoozed_until IS NULL OR snoozed_until <= now())`,
          )
        ).rows[0]!.n,
      );

    // one row, always — even before this test adds anything of its own
    const before = (await store.run("pending_count")).rows;
    expect(before).toHaveLength(1);
    expect(before[0]!.waiting).toBe(await rawCount());

    // a pending, unsnoozed row: the count moves by exactly one
    await mk();
    const withPending = (await store.run("pending_count")).rows;
    expect(withPending).toHaveLength(1);
    expect(withPending[0]!.waiting).toBe((before[0]!.waiting as number) + 1);
    expect(withPending[0]!.waiting).toBe(await rawCount());
    expect(withPending[0]!.oldest_ts).not.toBeNull();

    // a row snoozed into the future: `later` is not an answer, but it has
    // left the queue until its instant arrives — the count does not move
    await mk({ snoozed: "2099-01-01T00:00:00Z" });
    const withSnoozed = (await store.run("pending_count")).rows;
    expect(withSnoozed).toHaveLength(1);
    expect(withSnoozed[0]!.waiting).toBe(withPending[0]!.waiting);
    expect(withSnoozed[0]!.waiting).toBe(await rawCount());

    // a decided row: also not pending, also does not move it
    await mk({ decision: "allow" });
    const withDecided = (await store.run("pending_count")).rows;
    expect(withDecided[0]!.waiting).toBe(withPending[0]!.waiting);
    expect(withDecided[0]!.waiting).toBe(await rawCount());

    await pool.query(`DELETE FROM proposals WHERE source_agent = $1`, [tag]);
    // back to the baseline once this test's own rows are gone
    expect((await store.run("pending_count")).rows[0]!.waiting).toBe(before[0]!.waiting);
  });

  it("pending_requests: every stored kind reads as the request type table says — action as action — and a kind it does not know as a report", async () => {
    const tag = `prk-${Date.now()}`;
    const kinds = [...REQUEST_KINDS, "sync_conflict"];
    for (const kind of kinds) {
      await pool.query(`INSERT INTO proposals (kind, source_agent, trust, payload) VALUES ($1, $2, 'internal', '{}'::jsonb)`, [kind, tag]);
    }
    const rows = (await store.run("pending_requests", { limit: 500 })).rows.filter((r) => r.source_agent === tag);
    expect(rows.map((r) => r.kind)).toEqual(kinds);
    // the SQL and the table agree on every kind, and so does the title's fallback
    for (const r of rows) expect(r, String(r.kind)).toMatchObject({ request_type: requestWordOf(String(r.kind)), title: `${requestWordOf(String(r.kind))} request` });
    expect(rows.find((r) => r.kind === "action")).toMatchObject({ request_type: "action", title: "action request" }); // C80: not note
    expect(rows.find((r) => r.kind === "knowledge")).toMatchObject({ request_type: "note", title: "note request" }); // the word, not the kind, in the title too
    expect(rows.find((r) => r.kind === "sync_conflict")).toMatchObject({ request_type: "report", title: "report request" });
    // and the `kind` filter still takes a stored kind, never a word
    expect((await store.run("pending_requests", { kind: "action", limit: 500 })).rows.filter((r) => r.source_agent === tag)).toHaveLength(1);
    expect((await store.run("pending_requests", { kind: "note", limit: 500 })).rows.filter((r) => r.source_agent === tag)).toHaveLength(0);

    await pool.query(`DELETE FROM proposals WHERE source_agent = $1`, [tag]);
  });

  // Last, because it is the one query with no filter to scope it by — which
  // is the point of it (a count over a caller-supplied filter is the
  // directory listing `knowledge_pages` refuses to publish), and the reason
  // it is the only one of the five that is `expose: generic`.
  it("task_ageing: the measure only — buckets, totals, and a source KIND that can never be a path", async () => {
    await pool.query(`DELETE FROM vault_tasks`);
    const tag = `ta-${Date.now()}`;
    await task(pool, { path: `${tag}/a.md`, task_key: "t1", line_no: 1, text: "Fresh", text_norm: "fresh", first_seen_on: DAY });
    await task(pool, { path: `${tag}/a.md`, task_key: "t2", line_no: 2, text: "Three days", text_norm: "three days", first_seen_on: "2026-09-17", due: "2026-09-18" });
    await task(pool, { path: `${tag}/a.md`, task_key: "t3", line_no: 3, text: "A month", text_norm: "a month", first_seen_on: "2026-08-15", waiting: true, assigned: "People/Jim Fallon.md" });
    await task(pool, { path: `${tag}/a.md`, task_key: "t4", line_no: 4, text: "From a meeting", text_norm: "from a meeting", first_seen_on: "2026-09-19", source: `meeting:${tag}/Journal/Meetings/secret-topic.md` });
    await task(pool, { path: `${tag}/a.md`, task_key: "t5", line_no: 5, text: "Closed", text_norm: "closed", checked: true, done_on: "2026-09-19", first_seen_on: "2026-09-18" });
    await task(pool, { path: `${tag}/a.md`, task_key: "t6", line_no: 6, text: "A rule", text_norm: "a rule", recur_rule: "every week", recur_next: DAY });
    await task(pool, { path: `${tag}/a.md`, task_key: "t7", line_no: 7, text: "Unreadable", text_norm: "unreadable", parse_warning: "due nextweek", first_seen_on: DAY });

    const { rows } = await store.run("task_ageing", { today: DAY, days: 7 });
    const total = rows.find((r) => r.row_kind === "total")!;
    expect(rows[0]).toBe(total); // the total reads first
    expect(total).toMatchObject({ label: null });
    expect(Number(total.n)).toBe(5); // five open non-rule lines
    expect(Number(total.recurrence_rules)).toBe(1); // counted on its own line, never mixed in
    expect(Number(total.overdue)).toBe(1);
    expect(Number(total.carried)).toBe(1);
    expect(Number(total.waiting)).toBe(1);
    expect(Number(total.delegated)).toBe(1);
    expect(Number(total.parse_warnings)).toBe(1);
    expect(Number(total.unscheduled)).toBe(4);
    expect(Number(total.done_in_window)).toBe(1);
    expect(Number(total.created_in_window)).toBe(5); // six non-rule lines, one of them first seen 2026-08-15
    expect(Number(total.oldest_open_days)).toBe(36);
    expect(Number(total.completion_rate)).toBeCloseTo(1 / 5);

    const buckets = rows.filter((r) => r.row_kind === "age");
    expect(buckets.map((b) => [b.label, Number(b.n)])).toEqual([
      ["today", 2],
      ["1-3d", 2],
      ["31-90d", 1],
    ]);

    // the KIND, never the value: `meeting:<path>` must not put a vault path
    // into an aggregate the generic door serves
    const sources = rows.filter((r) => r.row_kind === "source");
    expect(sources.map((s) => s.label).sort()).toEqual(["meeting", "typed"]);
    expect(JSON.stringify(rows)).not.toContain("secret-topic");
    expect(JSON.stringify(rows)).not.toContain(tag);
    expect(JSON.stringify(rows)).not.toContain("Jim");

    await pool.query(`DELETE FROM vault_tasks`);
  });

  // T1-11's own test line: "expired rows are not returned" — session_detail
  // (migration 0030) is the owner's own transcript, so a row the writer's
  // 30-day retention (T3-9) has passed must never come back, no matter which
  // session or turn is asked for. Also covers the query's other two reads:
  // `turn_id` narrows to one turn, and an unknown session returns nothing —
  // both without an error, the `run_detail` "0 names no row" pattern.
  it("session_detail: expired rows are not returned, `turn_id` narrows to one turn, and an unknown session returns nothing", async () => {
    const session = randomUUID();
    const fresh = { turn_id: "turn-fresh", ts: "now()", expires: "now() + interval '1 day'" };
    const stale = { turn_id: "turn-stale", ts: "now() - interval '31 days'", expires: "now() - interval '1 day'" };
    for (const t of [fresh, stale]) {
      await pool.query(
        `INSERT INTO session_archive (session_id, thread, turn_id, ts, system_prompt, messages, tool_calls, expires_at)
         VALUES ($1, 'default', $2, ${t.ts}, 'system prompt', $3::jsonb, '[]'::jsonb, ${t.expires})`,
        [session, t.turn_id, JSON.stringify([{ role: "user", content: t.turn_id }])],
      );
    }

    // the expired turn never comes back, session-wide …
    const all = (await store.run("session_detail", { session_id: session })).rows;
    expect(all.map((r) => r.turn_id)).toEqual(["turn-fresh"]);

    // … nor when asked for BY turn_id — an expired row is gone, not merely hidden from the list
    expect((await store.run("session_detail", { session_id: session, turn_id: "turn-stale" })).rows).toHaveLength(0);

    // turn_id narrows to exactly one turn
    const one = (await store.run("session_detail", { session_id: session, turn_id: "turn-fresh" })).rows;
    expect(one).toHaveLength(1);
    expect(one[0]).toMatchObject({ session_id: session, thread: "default", turn_id: "turn-fresh", system_prompt: "system prompt" });
    expect(one[0]!.folded_at).toBeNull();

    // an unknown session, and the all-blank default, are both an honest empty result — never an error
    expect((await store.run("session_detail", { session_id: randomUUID() })).rows).toHaveLength(0);
    expect((await store.run("session_detail")).rows).toHaveLength(0);

    await pool.query(`DELETE FROM session_archive WHERE session_id = $1`, [session]);
  });
});
