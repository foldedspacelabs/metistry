// claude-usage: daily rollup of assistant turns from `runs` into `metrics`
// by model tier. cost_usd is the SDK's API-equivalent figure — on a
// subscription it's headroom consumed, not money billed; the dashboard
// labels it that way. Trailing window replaced atomically each run
// (in-flight turns finish late), so the series is idempotent.

export interface Db {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

export interface ClaudeUsageCtx {
  claudeUsageDays?: number; // trailing window, default 3
  now?: Date;
}

const NAMES = ["claude.tokens_in", "claude.tokens_out", "claude.cost_usd"] as const;
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
            coalesce(sum(cost_usd), 0) AS cost_usd
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
