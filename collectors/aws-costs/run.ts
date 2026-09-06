// aws-costs: daily unblended spend per service from Cost Explorer into
// `metrics` (name `aws.cost_usd`, labels {service, day}). Re-fetches the
// trailing window every run because CE finalizes late (up to ~3 days), and
// replaces those days atomically so the series is idempotent. One request
// per run (CE bills $0.01/request). Degrades absent without credentials.
import type { AwsCredentials } from "./sigv4.js";
import { signV4 } from "./sigv4.js";

export interface Db {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

export interface AwsCostsCtx {
  aws?: AwsCredentials;
  awsCostDays?: number; // trailing window to (re)load, default 3
  fetchFn?: typeof fetch;
  now?: Date; // injectable for tests
}

const METRIC = "aws.cost_usd";
const CE_HOST = "ce.us-east-1.amazonaws.com"; // Cost Explorer is a us-east-1 global endpoint

interface CeResponse {
  ResultsByTime: {
    TimePeriod: { Start: string; End: string };
    Groups: { Keys: string[]; Metrics: { UnblendedCost: { Amount: string; Unit: string } } }[];
  }[];
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export async function fetchCosts(ctx: AwsCostsCtx, start: string, end: string): Promise<CeResponse> {
  const body = JSON.stringify({
    TimePeriod: { Start: start, End: end },
    Granularity: "DAILY",
    Metrics: ["UnblendedCost"],
    GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
  });
  const headers = signV4(
    {
      method: "POST",
      url: `https://${CE_HOST}/`,
      headers: {
        host: CE_HOST,
        "content-type": "application/x-amz-json-1.1",
        "x-amz-target": "AWSInsightsIndexService.GetCostAndUsage",
      },
      body,
      region: "us-east-1",
      service: "ce",
      now: ctx.now ?? new Date(),
    },
    ctx.aws!,
  );
  const res = await (ctx.fetchFn ?? fetch)(`https://${CE_HOST}/`, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`cost explorer: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as CeResponse;
}

/** One pass. Returns metric rows written. */
export async function run(db: Db, ctx: AwsCostsCtx = {}): Promise<number> {
  if (!ctx.aws?.accessKeyId || !ctx.aws.secretAccessKey) return 0; // degrades absent
  const now = ctx.now ?? new Date();
  const days = ctx.awsCostDays ?? 3;
  const end = isoDay(now); // CE End is exclusive → today excluded (partial)
  const start = isoDay(new Date(now.getTime() - days * 86_400_000));

  const data = await fetchCosts(ctx, start, end);
  const rows: { day: string; service: string; usd: number }[] = [];
  for (const r of data.ResultsByTime) {
    for (const g of r.Groups) {
      const usd = Number(g.Metrics.UnblendedCost.Amount);
      if (!Number.isFinite(usd) || usd === 0) continue;
      rows.push({ day: r.TimePeriod.Start, service: g.Keys[0] ?? "unknown", usd });
    }
  }

  // replace the window atomically: the series stays idempotent across reruns
  await db.query("BEGIN");
  try {
    await db.query(`DELETE FROM metrics WHERE name = $1 AND ts >= $2::date AND ts < $3::date`, [METRIC, start, end]);
    for (const r of rows) {
      await db.query(`INSERT INTO metrics (ts, name, value, labels) VALUES ($1::date, $2, $3, $4)`, [
        r.day,
        METRIC,
        r.usd,
        JSON.stringify({ service: r.service, day: r.day }),
      ]);
    }
    await db.query("COMMIT");
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  }
  return rows.length;
}
