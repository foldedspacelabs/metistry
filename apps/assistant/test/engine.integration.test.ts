// The engine against the real schema (scratch db — ops/scripts/test-db.sh,
// NEVER the instance db). Three things only a database can prove:
//
//   1. the cost columns 0015 added actually take what the engine writes;
//   2. `assistant_sessions` holds a turn's history and a session roll ends it
//      in BOTH tables, so a rolled thread cannot be replayed;
//   3. the `spend` named query — the one read path budgets use (invariant 3)
//      — sees those rows and puts them in the right window;
//   4. shadow mode's columns (0020) take what `recordShadow` writes, the
//      `shadow_agreement` query reads them back, and the candidate's spend
//      lands against the CANDIDATE's provider in `spend`.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { checkBudgets, finishRun, parseCompute, resolveAssignment, rollSession, spentFrom, startRun, SPEND_QUERY, type SpendRow } from "@foldedspacelabs/metistry-core";
import { makeOpenAiEngine } from "../src/engine-openai.js";
import { recordShadow, type ShadowRun } from "../src/shadow.js";
import { pgSessionStore } from "../src/sessions.js";
import { NO_TOOLS } from "../src/tools.js";

try {
  for (const line of readFileSync(new URL("../../../.env", import.meta.url), "utf8").split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m && m[1] && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {}

const hasDb = !!process.env.METISTRY_DB_PASSWORD;
const SEED_QUERIES = fileURLToPath(new URL("../../../seed/queries", import.meta.url));

const FILE = `
providers:
  openrouter:
    kind: openai-compatible
    base_url: https://openrouter.ai/api/v1
    locality: off_machine
    auth: { secret: METISTRY_TEST_OPENROUTER_KEY }
    data_policy: { allow: [Knowledge], deny_sources: [], max_brief_bytes: 1024 }
assignments:
  default: { model: openrouter/anthropic/claude-sonnet-5 }
budgets:
  instance: { daily_usd: 1, action: stop }
`;

describe.skipIf(!hasDb)("engine against the scratch db", () => {
  let pool: pg.Pool;
  const component = `engine-it-${Date.now()}`;

  beforeAll(async () => {
    pool = new pg.Pool({
      host: process.env.METISTRY_DB_HOST ?? "127.0.0.1",
      user: process.env.METISTRY_DB_USER ?? "metistry",
      database: process.env.METISTRY_TEST_DB_NAME ?? "metistry_test",
      password: process.env.METISTRY_DB_PASSWORD,
    });
  });
  afterAll(async () => pool.end());

  it("runs carries provider, model, tokens, cache tokens and cost as COLUMNS (0015)", async () => {
    const id = await startRun(pool, { component, kind: "turn", provider: "openrouter", model: "anthropic/claude-sonnet-5", meta: { tier: "default" } });
    await finishRun(pool, id, { ok: true, tokens_in: 2000, tokens_out: 150, cache_read_tokens: 1800, cache_write_tokens: 60, cost_usd: 0.0123, meta: { cost_source: "provider" } });
    const { rows } = await pool.query(`SELECT provider, model, tokens_in, tokens_out, cache_read_tokens, cache_write_tokens, cost_usd, meta FROM runs WHERE id = $1`, [id]);
    expect(rows[0]).toMatchObject({
      provider: "openrouter",
      model: "anthropic/claude-sonnet-5",
      tokens_in: 2000,
      tokens_out: 150,
      cache_read_tokens: 1800,
      cache_write_tokens: 60,
      cost_usd: "0.012300",
    });
    expect(rows[0].meta).toMatchObject({ tier: "default", cost_source: "provider" });
  });

  it("the engine persists its history in assistant_sessions, and a session roll ends it in both tables", async () => {
    const thread = `it-${Date.now()}`;
    const cfg = parseCompute(FILE);
    const assignment = resolveAssignment(cfg, "default")!;
    const reply = {
      choices: [{ message: { role: "assistant", content: "noted" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.001 },
    };
    const fetchFn = (async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => reply, text: async () => "" }) as unknown as Response) as unknown as typeof fetch;
    const engine = makeOpenAiEngine({ tools: () => NO_TOOLS, sessions: pgSessionStore(pool), fetchFn, env: { METISTRY_TEST_OPENROUTER_KEY: "k" } });

    const r = await engine("hello", { model: assignment.model, effort: assignment.effort, assignment, thread });
    const stored = await pool.query(`SELECT thread, provider, model, messages, turns, rolled_at FROM assistant_sessions WHERE id = $1`, [r.session_id]);
    expect(stored.rows[0]).toMatchObject({ thread, provider: "openrouter", model: "anthropic/claude-sonnet-5", turns: 1, rolled_at: null });
    expect(stored.rows[0].messages).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "noted" },
    ]);

    // the roll needs a `sessions` row on the same id — that is the pairing
    await pool.query(`INSERT INTO sessions (id, thread) VALUES ($1, $2)`, [r.session_id, thread]);
    const rolled = await rollSession(pool, thread, "task_closed:#1");
    expect(rolled.rolled).toEqual([r.session_id]);
    const after = await pool.query(`SELECT rolled_at FROM assistant_sessions WHERE id = $1`, [r.session_id]);
    expect(after.rows[0].rolled_at).not.toBeNull();
    expect(await pgSessionStore(pool).load(r.session_id, "openrouter", "anthropic/claude-sonnet-5")).toBeNull();
  });

  it("the `spend` query sees those rows, windows them, and the budget refuses on the result", async () => {
    const queries = new QueryStore(pool);
    await queries.loadDir(SEED_QUERIES);
    expect(queries.names()).toContain(SPEND_QUERY);

    const before = spentFrom(((await queries.run(SPEND_QUERY)).rows as SpendRow[]), "openrouter");
    const id = await startRun(pool, { component, kind: "turn", provider: "openrouter", model: "anthropic/claude-sonnet-5", meta: { tier: "deep" } });
    await finishRun(pool, id, { ok: true, tokens_in: 10, tokens_out: 1, cost_usd: 2.5 });

    const rows = (await queries.run(SPEND_QUERY)).rows as SpendRow[];
    const spent = spentFrom(rows, "openrouter");
    expect(spent.daily).toBeCloseTo(before.daily + 2.5, 6);
    expect(spent.monthly).toBeCloseTo(before.monthly + 2.5, 6);
    expect(rows.some((r) => (r as { tier?: string }).tier === "deep")).toBe(true);

    const cfg = parseCompute(FILE);
    const verdict = checkBudgets({ budgets: cfg.budgets, provider: "openrouter", spent: { instance: spentFrom(rows), provider: spent } });
    expect(verdict.allowed).toBe(false);
    expect(verdict.refusal?.field).toBe("budgets.instance.daily_usd");
  });

  it("the shadow columns take the comparison (0020), the named query reads it back, and the candidate is billed to ITS provider", async () => {
    const turnId = await startRun(pool, { component, kind: "turn", provider: "openrouter", model: "anthropic/claude-sonnet-5", meta: { tier: "default" } });
    await finishRun(pool, turnId, { ok: true, tokens_in: 900, tokens_out: 80, cost_usd: 0.004 });
    const run: ShadowRun = {
      shadow: {
        provider: "candid",
        model: "qwen3.6-35b-a3b",
        text: "three notes mention folds",
        messages: [{ role: "assistant", content: "three notes mention folds" }],
        tool_calls: [{ name: "mcp__brain__knowledge_search", args: { q: "folds" }, executed: false, result_from: "real_run" }],
        turns: 2,
        tokens_in: 900,
        tokens_out: 70,
        cost_usd: 0.000123,
        cost_source: "pricing",
      },
      real: { provider: "openrouter", model: "anthropic/claude-sonnet-5", text: "three notes mention folds", messages: [{ role: "user", content: "folds?" }], tool_calls: ["mcp__brain__knowledge_search"] },
      agreement: { score: 0.875, tool_sequence: true, answer_similarity: 0.75 },
    };
    const shadowRunId = await recordShadow(pool, turnId, run, { component, tier: "default" });

    const stored = await pool.query(`SELECT shadow_provider, shadow_model, shadow_agreement, shadow_cost_usd, shadow_transcript FROM runs WHERE id = $1`, [turnId]);
    expect(stored.rows[0]).toMatchObject({ shadow_provider: "candid", shadow_model: "qwen3.6-35b-a3b", shadow_agreement: "0.875", shadow_cost_usd: "0.000123" });
    // both transcripts, in the one jsonb column
    expect(stored.rows[0].shadow_transcript.shadow.tool_calls[0]).toMatchObject({ executed: false, result_from: "real_run" });
    expect(stored.rows[0].shadow_transcript.real.messages[0]).toEqual({ role: "user", content: "folds?" });

    // the candidate's spend is its own row, under its own provider — which is
    // what makes a per-provider budget honest without changing spend.yaml
    const spendRow = await pool.query(`SELECT kind, provider, model, cost_usd, meta FROM runs WHERE id = $1`, [shadowRunId]);
    expect(spendRow.rows[0]).toMatchObject({ kind: "shadow", provider: "candid", model: "qwen3.6-35b-a3b", cost_usd: "0.000123" });
    expect(spendRow.rows[0].meta).toMatchObject({ shadow_of: turnId, agreement: 0.875 });

    const queries = new QueryStore(pool);
    await queries.loadDir(SEED_QUERIES);
    expect(queries.names()).toContain("shadow_agreement");
    const report = (await queries.run("shadow_agreement", { runs: 50 })).rows as Record<string, unknown>[];
    const mine = report.find((r) => r.shadow_model === "qwen3.6-35b-a3b")!;
    expect(mine).toMatchObject({ shadow_provider: "candid", real_provider: "openrouter", agreement: "0.875", failed: "0" });
    expect(Number(mine.same_tool_sequence)).toBeGreaterThanOrEqual(1);
  });
});
