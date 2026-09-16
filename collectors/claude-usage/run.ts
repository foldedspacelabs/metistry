// claude-usage: daily rollup of assistant turns from `runs` into `metrics`
// by model. cost_usd is what the provider billed for the turn, as the engine
// recorded it (`packages/core/src/cost.ts`). Trailing window replaced
// atomically each run (in-flight turns finish late), so the series is
// idempotent.
//
// KEPT AT ITS NAME on purpose (PR 1b). It reads local data only and needs no
// credential, so it degrades to nothing on an engine-less install rather than
// failing; the `claude.*` metric names are DATA that existing installs
// already carry, and renaming them would be a migration with no benefit to
// the reader. Nothing here names a plan or a login.

export interface Db {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

export interface ClaudeUsageCtx {
  claudeUsageDays?: number; // trailing window, default 3
  now?: Date;
}

const NAMES = ["claude.tokens_in", "claude.tokens_out", "claude.cost_usd", "claude.cache_read", "claude.cache_write"] as const;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** One pass. Returns metric rows written. */
export async function run(db: Db, ctx: ClaudeUsageCtx = {}): Promise<number> {
  const now = ctx.now ?? new Date();
  const days = ctx.claudeUsageDays ?? 3;
  const start = isoDay(new Date(now.getTime() - days * 86_400_000));

  const { rows } = await db.query(
    `SELECT (ts AT TIME ZONE 'UTC')::date AS day, coalesce(model, 'unknown') AS model,
            count(*) AS turns,
            coalesce(sum(tokens_in), 0) AS tokens_in,
            coalesce(sum(tokens_out), 0) AS tokens_out,
            coalesce(sum(cost_usd), 0) AS cost_usd,
            coalesce(sum((meta->>'cache_read')::numeric), 0) AS cache_read,
            coalesce(sum((meta->>'cache_write')::numeric), 0) AS cache_write
     FROM runs
     WHERE kind = 'turn' AND component = 'assistant' AND ts >= $1::date
     GROUP BY 1, 2`,
    [start],
  );

  await db.query("BEGIN");
  try {
    await db.query(`DELETE FROM metrics WHERE name = ANY($1::text[]) AND ts >= $2::date`, [NAMES, start]);
    let n = 0;
    for (const r of rows) {
      const day = r.day instanceof Date ? isoDay(r.day) : String(r.day);
      const labels = JSON.stringify({ model: r.model, day, turns: Number(r.turns) });
      for (const [name, value] of [
        ["claude.tokens_in", Number(r.tokens_in)],
        ["claude.tokens_out", Number(r.tokens_out)],
        ["claude.cost_usd", Number(r.cost_usd)],
        ["claude.cache_read", Number(r.cache_read)],
        ["claude.cache_write", Number(r.cache_write)],
      ] as const) {
        await db.query(`INSERT INTO metrics (ts, name, value, labels) VALUES ($1::date, $2, $3, $4)`, [day, name, value, labels]);
        n++;
      }
    }
    await db.query("COMMIT");
    return n;
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  }
}
