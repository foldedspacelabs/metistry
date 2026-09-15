// Collectors against the real (scratch) database. The fake-db unit tests
// prove control flow; only Postgres can prove the SQL — a partial unique
// index needs its predicate repeated in ON CONFLICT, and the fake happily
// accepted the statement Postgres rejected. Skipped without a db.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { startRun, finishRun } from "@foldedspacelabs/metistry-core";
import { run as githubState } from "../github-state/run.js";
import { run as claudeUsage } from "../claude-usage/run.js";
import { PRINCIPAL, readWatermark, run as devinKnowledge } from "../devin-knowledge/run.js";

try {
  for (const line of readFileSync(new URL("../../.env", import.meta.url), "utf8").split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m && m[1] && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {}

const hasDb = !!process.env.METISTRY_DB_PASSWORD;

describe.skipIf(!hasDb)("collectors (real db)", () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = new pg.Pool({
      host: process.env.METISTRY_DB_HOST ?? "127.0.0.1",
      port: Number(process.env.METISTRY_DB_PORT ?? 5432),
      user: process.env.METISTRY_DB_USER ?? "metistry",
      database: process.env.METISTRY_TEST_DB_NAME ?? "metistry_test", // scratch db (ops/scripts/test-db.sh)
      password: process.env.METISTRY_DB_PASSWORD,
    });
    await pool.query(`DELETE FROM work WHERE external_ref LIKE 'gh:itest/%'`);
    await pool.query(`DELETE FROM runs WHERE component = 'assistant' AND kind = 'turn'`); // scratch db: other suites' drain turns would land in the window
    await pool.query(`DELETE FROM metrics WHERE name LIKE 'claude.%'`);
    await pool.query(`DELETE FROM inbox WHERE idempotency_principal = $1`, [PRINCIPAL]);
    await pool.query(`DELETE FROM runs WHERE component = 'devin-knowledge'`);
  });
  // The scratch db is shared with every other suite in the run, so rows this
  // one made must not survive it: routines' weekly-review renders whatever
  // `runs` holds, and three stray devin-knowledge rows failed it once.
  afterAll(async () => {
    await pool.query(`DELETE FROM runs WHERE component = 'devin-knowledge'`);
    await pool.query(`DELETE FROM inbox WHERE idempotency_principal = $1`, [PRINCIPAL]);
    await pool.end();
  });

  it("github-state upserts through the partial unique index, then closes what vanished (recording merged state)", async () => {
    const page = (items: any[]) => (async (url: string) => ({
      ok: true,
      json: async () =>
        url.endsWith("/user")
          ? { login: "me" }
          : url.includes("/reviews?")
            ? []
            : url.includes("/pulls?")
              ? [{ number: 2, user: { login: "other" }, requested_reviewers: [{ login: "me" }] }]
              : /\/pulls\/\d+$/.test(url)
                ? { merged_at: "2026-09-03T00:00:00Z" } // #2 vanishes on the rerun below: it was merged
                : items,
    })) as unknown as typeof fetch;
    const ctx = { githubToken: "t", githubRepos: ["itest/repo"] };
    const base = { state: "open", html_url: "", updated_at: "2026-09-01T00:00:00Z" };
    await githubState(pool, { ...ctx, fetchFn: page([{ number: 1, title: "one", ...base }, { number: 2, title: "two", pull_request: {}, ...base }]) });
    await githubState(pool, { ...ctx, fetchFn: page([{ number: 1, title: "one (renamed)", ...base }]) }); // rerun: upsert, not duplicate
    const { rows } = await pool.query(
      `SELECT external_ref, title, status, kind, meta->>'needs_my_review' AS nmr, meta->>'merged' AS merged, meta->>'merged_at' AS merged_at
       FROM work WHERE external_ref LIKE 'gh:itest/%' ORDER BY external_ref`,
    );
    expect(rows).toEqual([
      { external_ref: "gh:itest/repo#1", title: "one (renamed)", status: "open", kind: "issue", nmr: null, merged: null, merged_at: null },
      { external_ref: "gh:itest/repo#2", title: "two", status: "closed", kind: "pr", nmr: "true", merged: "true", merged_at: "2026-09-03T00:00:00Z" },
    ]);
  });

  it("claude-usage rolls assistant turns into per-model daily metrics, idempotently, including cache read/write", async () => {
    const turn = (model: string, tin: number, tout: number, cost: number, ts: string, cacheRead: number, cacheWrite: number) =>
      pool.query(
        `INSERT INTO runs (ts, component, kind, model, tokens_in, tokens_out, cost_usd, ok, meta, started_at, finished_at)
         VALUES ($1, 'assistant', 'turn', $2, $3, $4, $5, true, $6::jsonb, $1, $1)`,
        [ts, model, tin, tout, cost, JSON.stringify({ itest: "1", cache_read: cacheRead, cache_write: cacheWrite })],
      );
    await turn("haiku", 100, 400, 0.01, "2026-09-05T10:00:00Z", 200, 50);
    await turn("haiku", 50, 100, 0.005, "2026-09-05T22:00:00Z", 0, 0);
    await turn("sonnet", 2000, 300, 0.09, "2026-09-05T23:30:00Z", 4000, 0);
    const ctx = { now: new Date("2026-09-06T12:00:00Z") };
    expect(await claudeUsage(pool, ctx)).toBe(10);
    expect(await claudeUsage(pool, ctx)).toBe(10); // rerun replaces, never accumulates
    const { rows } = await pool.query(
      `SELECT ts::date::text AS day, labels->>'model' AS model, name, value::float AS value
       FROM metrics WHERE name LIKE 'claude.%' ORDER BY model, name`,
    );
    expect(rows).toEqual([
      { day: "2026-09-05", model: "haiku", name: "claude.cache_read", value: 200 },
      { day: "2026-09-05", model: "haiku", name: "claude.cache_write", value: 50 },
      { day: "2026-09-05", model: "haiku", name: "claude.cost_usd", value: 0.015 },
      { day: "2026-09-05", model: "haiku", name: "claude.tokens_in", value: 150 },
      { day: "2026-09-05", model: "haiku", name: "claude.tokens_out", value: 500 },
      { day: "2026-09-05", model: "sonnet", name: "claude.cache_read", value: 4000 },
      { day: "2026-09-05", model: "sonnet", name: "claude.cache_write", value: 0 },
      { day: "2026-09-05", model: "sonnet", name: "claude.cost_usd", value: 0.09 },
      { day: "2026-09-05", model: "sonnet", name: "claude.tokens_in", value: 2000 },
      { day: "2026-09-05", model: "sonnet", name: "claude.tokens_out", value: 300 },
    ]);
  });

  // devin-knowledge writes through `captureToInbox`, whose retry safety is a
  // PARTIAL unique index on (idempotency_principal, idempotency_key) — the
  // one thing a fake db cannot prove. Two passes over the same note must
  // leave one row, and the watermark must survive on the runs row the
  // runner's `finishRun` then merges its own meta into.
  it("devin-knowledge captures once per note version and carries a watermark on its runs row", async () => {
    const inboxDir = mkdtempSync(join(tmpdir(), "metistry-devin-itest-"));
    const note = (updated: number, body: string) => ({
      note_id: "itest-1",
      name: "Deploy runbook",
      body,
      trigger: "when deploying",
      folder_path: "/Engineering",
      pinned_repo: "itest/api",
      is_enabled: true,
      updated_at: updated,
    });
    const fetchFor = (updated: number, body: string) =>
      (async (url: string) =>
        new URL(url).pathname === "/v3/self"
          ? { ok: true, status: 200, json: async () => ({ org_id: "org-itest" }) }
          : { ok: true, status: 200, json: async () => ({ items: [note(updated, body)], has_next_page: false, end_cursor: null }) }) as unknown as typeof fetch;

    // pass 1, inside a runs row exactly as the console's runner opens one
    const ctx = { devinApiKey: "cog_itest", inboxDir };
    let runId = await startRun(pool, { component: "devin-knowledge", kind: "collector_run" });
    expect(await devinKnowledge(pool, { ...ctx, fetchFn: fetchFor(1_700_000_000, "v1") })).toBe(1);
    await finishRun(pool, runId, { ok: true, meta: { processed: 1 } });
    expect(await readWatermark(pool)).toBe(1_700_000_000);

    // pass 2, same version: the unique index turns the insert into a replay
    runId = await startRun(pool, { component: "devin-knowledge", kind: "collector_run" });
    expect(await devinKnowledge(pool, { ...ctx, fetchFn: fetchFor(1_700_000_000, "v1") })).toBe(0);
    await finishRun(pool, runId, { ok: true, meta: { processed: 0 } });

    // pass 3, edited note: a new version is a new key, so one more row
    runId = await startRun(pool, { component: "devin-knowledge", kind: "collector_run" });
    expect(await devinKnowledge(pool, { ...ctx, fetchFn: fetchFor(1_700_000_900, "v2") })).toBe(1);
    await finishRun(pool, runId, { ok: true, meta: { processed: 1 } });

    const { rows } = await pool.query(
      `SELECT source, source_agent, mime, idempotency_key, note FROM inbox
       WHERE idempotency_principal = $1 ORDER BY idempotency_key`,
      [PRINCIPAL],
    );
    expect(rows.map((r) => r.idempotency_key)).toEqual(["knowledge:itest-1:1700000000", "knowledge:itest-1:1700000900"]);
    expect(rows.every((r) => r.source === "devin" && r.source_agent === null && r.mime === "text/markdown")).toBe(true);
    expect(String(rows[1].note)).toContain(`devin_id: "itest-1"`);
    expect(String(rows[1].note)).toContain("v2");
    // the watermark rode through finishRun's `meta || …` merge, alongside `processed`
    expect(await readWatermark(pool)).toBe(1_700_000_900);
    const { rows: meta } = await pool.query(
      `SELECT meta FROM runs WHERE component = 'devin-knowledge' AND kind = 'collector_run' ORDER BY id DESC LIMIT 1`,
    );
    expect(meta[0].meta).toMatchObject({ processed: 1, since: 1_700_000_900, since_iso: "2023-11-14T22:28:20.000Z" });
  });
});
