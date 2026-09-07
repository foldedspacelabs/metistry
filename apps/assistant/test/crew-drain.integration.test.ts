// The crew queue against the real (scratch) db with a fake runner: a queued
// row is claimed, run with the crew's model/tools/turns and a token minted
// for THAT run (its hash is the crew's row while the run is live and dies
// after), recorded as a crew_run row on the crew's id, and closed; a second
// run gets a different token; failures retry with a backoff then park as
// blocked; a budget stop parks at once. Skipped without a db.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { mintToken, tokenHash } from "@foldedspacelabs/metistry-core";
import { claimCrewRow, drainCrewOne, issueRunToken } from "../src/crew-drain.js";
import { buildCrewOptions, type CrewRunInput, type CrewRunResult, type CrewSnapshot } from "../src/crew.js";

try {
  for (const line of readFileSync(new URL("../../../.env", import.meta.url), "utf8").split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m && m[1] && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {}

const hasDb = !!process.env.METISTRY_DB_PASSWORD;
const suffix = mintToken(4).toLowerCase().replaceAll(/[^a-z0-9]/g, "").slice(0, 6) || "x";
const crewId = `itest-runner-${suffix}`;

const snapshot: CrewSnapshot = {
  name: crewId,
  area: "itest",
  model: "sonnet",
  uses: ["brain-read", "brain-report"],
  skills: [],
  scope: ["Knowledge/Projects"],
  projects: [],
  manages: [],
  max_turns: 5,
  budget_usd_per_run: 0.1,
  prompt: "You work for {{name}}.",
  sha256: "c".repeat(64),
};

describe.skipIf(!hasDb)("crew drain (integration)", () => {
  let pool: pg.Pool;
  const cfg = { brainUrl: "http://console:8080/mcp", identity: { name: "Tester" }, leaseSeconds: 60, maxAttempts: 2, retryBackoffSeconds: 120 };

  beforeAll(async () => {
    pool = new pg.Pool({
      host: process.env.METISTRY_DB_HOST ?? "127.0.0.1",
      port: Number(process.env.METISTRY_DB_PORT ?? 5432),
      user: process.env.METISTRY_DB_USER ?? "metistry",
      database: process.env.METISTRY_TEST_DB_NAME ?? "metistry_test",
      password: process.env.METISTRY_DB_PASSWORD,
    });
    // the console's registration, minimally: a crew row whose hash is of a token nobody holds
    await pool.query(`INSERT INTO agents (id, display_name, kind, token_hash, grants, projects) VALUES ($1, 'itest crew', 'crew', $2, '{"tier":"areas","areas":["Knowledge/Projects"]}', '{}')`, [crewId, tokenHash(mintToken(32))]);
    // park other suites' crew rows so this suite drains only its own
    await pool.query(`UPDATE work SET status = 'closed' WHERE kind = 'task' AND owner LIKE 'crew:%' AND status <> 'closed' AND owner <> $1`, [`crew:${crewId}`]);
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM work WHERE owner = $1`, [`crew:${crewId}`]);
    await pool.query(`DELETE FROM runs WHERE component = $1`, [crewId]);
    await pool.query(`DELETE FROM agents WHERE id = $1`, [crewId]);
    await pool.end();
  });

  async function enqueue(brief: string, meta: Record<string, unknown> = {}, crew: unknown = snapshot): Promise<number> {
    const { rows } = await pool.query(
      `INSERT INTO work (title, kind, status, owner, created_by, meta) VALUES ($1, 'task', 'open', $2, 'assistant', $3::jsonb) RETURNING id`,
      [`[crew:${crewId}] ${brief.slice(0, 40)}`, `crew:${crewId}`, JSON.stringify({ target: "local-crew", crew, brief, brief_sha: "d".repeat(64), dispatch_run_id: 1, allow: ["Knowledge/Projects"], ...meta })],
    );
    return Number(rows[0].id);
  }
  const hashOf = async () => (await pool.query(`SELECT token_hash FROM agents WHERE id = $1`, [crewId])).rows[0].token_hash as string;
  const workRow = async (id: number) => (await pool.query(`SELECT status, claimed_by, lease_expires_at, closed_at, meta, history FROM work WHERE id = $1`, [id])).rows[0];

  const ok: CrewRunResult = { outcome: "ok", session_id: "s1", num_turns: 4, tokens_in: 900, tokens_out: 120, cost_usd: 0.031, tools_used: { mcp__brain__knowledge_read: 2, mcp__brain__report: 1 }, text_chars: 50 };

  it("claims the row, runs with the crew's options and a token that authenticates ONLY during the run, records a crew_run row on the crew id, closes the row", async () => {
    const id = await enqueue("Summarize Knowledge/Projects/X.md", { task_id: 77 });
    const hashBefore = await hashOf();
    let seen: CrewRunInput | null = null;
    let liveHashDuringRun = "";
    const run = async (input: CrewRunInput) => {
      seen = input;
      liveHashDuringRun = await hashOf();
      return ok;
    };
    expect(await drainCrewOne(pool, cfg, run)).toBe(true);

    // the runner got the snapshot, the brief, the handle, the brain URL and a fresh bearer
    const s = seen!;
    expect(s.crew).toEqual(snapshot);
    expect(s.brief).toBe("Summarize Knowledge/Projects/X.md");
    expect(s.task_id).toBe(77);
    expect(s.brain.url).toBe("http://console:8080/mcp");
    expect(s.identity).toEqual({ name: "Tester" });
    const o = buildCrewOptions(s);
    expect(o).toMatchObject({ model: "sonnet", maxTurns: 5, maxBudgetUsd: 0.1, allowedTools: ["mcp__brain__knowledge_search", "mcp__brain__knowledge_read", "mcp__brain__report"] });
    expect((o.mcpServers as any).brain.headers.Authorization).toBe(`Bearer ${s.brain.token}`);
    expect(o.systemPrompt).toMatch(/^You work for Tester\./);

    // single-run credential: minted for this run (its hash IS the row while live), dead afterwards
    expect(liveHashDuringRun).toBe(tokenHash(s.brain.token));
    expect(liveHashDuringRun).not.toBe(hashBefore);
    expect(await hashOf()).not.toBe(tokenHash(s.brain.token));

    const row = await workRow(id);
    expect(row).toMatchObject({ status: "closed", claimed_by: null, lease_expires_at: null });
    expect(row.closed_at).not.toBeNull();
    expect(row.meta.attempts).toBe(1);
    expect(row.history.at(-1)).toMatchObject({ agent: `crew:${crewId}`, op: "update", status: "closed", note: expect.stringMatching(/^crew run #\d+: ok, 4 turns, 1 report, \$0\.0310$/) });

    const run_ = (await pool.query(`SELECT component, kind, model, ok, tokens_in, tokens_out, cost_usd::float8 AS cost_usd, meta, finished_at IS NOT NULL AS finished FROM runs WHERE component = $1 AND kind = 'crew_run' AND (meta->>'work_id')::bigint = $2`, [crewId, id])).rows[0];
    expect(run_).toMatchObject({ component: crewId, kind: "crew_run", model: "sonnet", ok: true, tokens_in: 900, tokens_out: 120, cost_usd: 0.031, finished: true });
    expect(run_.meta).toMatchObject({ work_id: id, brief_sha: "d".repeat(64), task_id: 77, attempt: 1, crew_sha: "c".repeat(64), outcome: "ok", num_turns: 4, reports: 1, tools_used: ok.tools_used, uses: ["brain-read", "brain-report"] });
  });

  it("a second run gets a different token, and the first one's hash is nowhere", async () => {
    const tokens: string[] = [];
    const run = async (input: CrewRunInput) => {
      tokens.push(input.brain.token);
      return ok;
    };
    await enqueue("run two");
    await drainCrewOne(pool, cfg, run);
    await enqueue("run three");
    await drainCrewOne(pool, cfg, run);
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).not.toBe(tokens[1]);
    const current = await hashOf();
    expect(current).not.toBe(tokenHash(tokens[0]!));
    expect(current).not.toBe(tokenHash(tokens[1]!));
    // the console's authenticateAgent is a hash lookup on this column: neither token authenticates now
    expect((await pool.query(`SELECT id FROM agents WHERE token_hash = ANY($1::text[]) AND revoked_at IS NULL`, [tokens.map(tokenHash)])).rows).toEqual([]);
  });

  it("an infrastructure failure retries after the backoff (claim kept, lease = backoff), then parks as blocked at the attempt cap; the token is burned each time", async () => {
    const id = await enqueue("flaky");
    const boom = async () => {
      throw new Error("sdk exploded");
    };
    expect(await drainCrewOne(pool, cfg, boom)).toBe(true);
    let row = await workRow(id);
    expect(row).toMatchObject({ status: "in_progress", claimed_by: `crew:${crewId}` });
    expect(row.meta.attempts).toBe(1);
    expect(new Date(row.lease_expires_at).getTime()).toBeGreaterThan(Date.now() + 100_000); // ~120s backoff
    expect(row.history.at(-1).note).toMatch(/attempt 1 failed \(sdk exploded\); retry after 120s/);
    // not re-picked while the lease/backoff holds
    expect(await claimCrewRow(pool, 60, 2)).toBeNull();
    // lapse it by hand: the next pass retries, hits the cap, parks
    await pool.query(`UPDATE work SET lease_expires_at = now() - interval '1 second' WHERE id = $1`, [id]);
    expect(await drainCrewOne(pool, cfg, boom)).toBe(true);
    row = await workRow(id);
    expect(row).toMatchObject({ status: "blocked" });
    expect(row.meta.attempts).toBe(2);
    expect(row.history.at(-1).note).toMatch(/failed 2× — last: sdk exploded/);
    const runs = await pool.query(`SELECT ok, error, meta->>'attempt' AS attempt FROM runs WHERE component = $1 AND kind = 'crew_run' AND (meta->>'work_id')::bigint = $2 ORDER BY id`, [crewId, id]);
    expect(runs.rows).toEqual([{ ok: false, error: "sdk exploded", attempt: "1" }, { ok: false, error: "sdk exploded", attempt: "2" }]);
    expect(await claimCrewRow(pool, 60, 2)).toBeNull(); // blocked rows are never re-picked
  });

  it("a budget or turn stop is final: the run is recorded ok=false with the outcome, the row parks as blocked, nothing retries", async () => {
    const id = await enqueue("expensive");
    const stopped: CrewRunResult = { ...ok, outcome: "max_budget", num_turns: 5, cost_usd: 0.11, errors: ["budget exceeded"] };
    await drainCrewOne(pool, cfg, async () => stopped);
    const row = await workRow(id);
    expect(row.status).toBe("blocked");
    expect(row.history.at(-1).note).toMatch(/max_budget, 5 turns, 1 report, \$0\.1100 — budget exceeded/);
    const r = (await pool.query(`SELECT ok, error, meta->>'outcome' AS outcome FROM runs WHERE component = $1 AND kind = 'crew_run' AND (meta->>'work_id')::bigint = $2`, [crewId, id])).rows[0];
    expect(r).toEqual({ ok: false, error: "crew run max_budget: budget exceeded", outcome: "max_budget" });
  });

  it("a row the runner cannot honour parks with the reason and never mints: no snapshot, a write tool in the snapshot, a revoked crew, no brain URL", async () => {
    const calls: string[] = [];
    const run = async (input: CrewRunInput) => {
      calls.push(input.crew.name);
      return ok;
    };
    const noSnap = await enqueue("no snapshot", {}, null);
    await drainCrewOne(pool, cfg, run);
    expect((await workRow(noSnap)).history.at(-1).note).toMatch(/crew run refused: crew snapshot missing/);
    const writer = await enqueue("writer", {}, { ...snapshot, uses: ["knowledge_write"] });
    await drainCrewOne(pool, cfg, run);
    expect((await workRow(writer)).history.at(-1).note).toMatch(/never available to a crew/);
    const noBrain = await enqueue("no brain");
    await drainCrewOne(pool, { ...cfg, brainUrl: undefined }, run);
    expect((await workRow(noBrain)).history.at(-1).note).toMatch(/METISTRY_BRAIN_URL is unset/);
    await pool.query(`UPDATE agents SET revoked_at = now() WHERE id = $1`, [crewId]);
    const hashBefore = await hashOf();
    const revoked = await enqueue("revoked crew");
    await drainCrewOne(pool, cfg, run);
    expect((await workRow(revoked)).history.at(-1).note).toMatch(/not registered or is revoked/);
    expect(await issueRunToken(pool, crewId)).toBeNull();
    expect(await hashOf()).toBe(hashBefore); // a revoked row is never re-keyed
    expect(calls).toEqual([]);
    expect(await drainCrewOne(pool, cfg, run)).toBe(false); // queue empty
  });
});
