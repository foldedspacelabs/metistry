// Watchdog probes — model-free by construction: nothing here touches
// Anthropic, so "the token expired" and "the assistant is dead" are still
// reportable. Direct db access is the named invariant-3 exception (the
// watchdog must be able to say the console itself is down). All probes
// return the frozen check() shape.

import { runCheck, type CheckResult } from "@foldedspacelabs/metistry-core";

export interface Db {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

export interface ProbeConfig {
  consoleUrl: string; // e.g. http://127.0.0.1:8080
  stuckNewMin: number; // inbound sitting in 'new' longer than this = assistant dead/backlogged
  stuckProcessingMin: number;
  inflightRunMin: number; // two-phase runs older than this with no finish = hung call (CRIT-8)
  hourlyCostUsd: number; // cost-runaway line
}

export async function runProbes(db: Db, cfg: ProbeConfig, fetchFn = fetch): Promise<CheckResult[]> {
  return [
    await runCheck("db", "SELECT 1 round-trip", async () => {
      await db.query("SELECT 1");
    }),

    await runCheck("console", `GET ${cfg.consoleUrl}/health`, async () => {
      const r = await fetchFn(`${cfg.consoleUrl}/health`, { signal: AbortSignal.timeout(5000) });
      if (!r.ok) throw new Error(`console /health returned ${r.status} — check the console service/container`);
    }),

    await runCheck("assistant-drain", `no inbound stuck >${cfg.stuckNewMin}m new / >${cfg.stuckProcessingMin}m processing`, async () => {
      const { rows } = await db.query(
        `SELECT
           count(*) FILTER (WHERE status = 'new' AND ts < now() - make_interval(mins => $1)) AS stuck_new,
           count(*) FILTER (WHERE status = 'processing' AND ts < now() - make_interval(mins => $2)) AS stuck_proc
         FROM inbound_messages`,
        [cfg.stuckNewMin, cfg.stuckProcessingMin],
      );
      const { stuck_new, stuck_proc } = rows[0];
      if (Number(stuck_new) > 0) throw new Error(`${stuck_new} message(s) unclaimed — assistant down? restart the assistant service`);
      if (Number(stuck_proc) > 0) throw new Error(`${stuck_proc} message(s) stuck processing — assistant hung mid-turn`);
    }),

    await runCheck("runs-inflight", `no runs in flight >${cfg.inflightRunMin}m (CRIT-8)`, async () => {
      const { rows } = await db.query(
        `SELECT count(*) AS n FROM runs
         WHERE finished_at IS NULL AND started_at < now() - make_interval(mins => $1)`,
        [cfg.inflightRunMin],
      );
      if (Number(rows[0].n) > 0) throw new Error(`${rows[0].n} call(s) hung in flight — the exact runaway two-phase rows exist to catch`);
    }),

    await runCheck("hourly-cost", `runs cost last hour under $${cfg.hourlyCostUsd}`, async () => {
      const { rows } = await db.query(
        `SELECT coalesce(sum(cost_usd), 0) AS usd FROM runs WHERE ts > now() - interval '1 hour'`,
      );
      if (Number(rows[0].usd) > cfg.hourlyCostUsd) {
        throw new Error(`$${Number(rows[0].usd).toFixed(2)} spent in the last hour (line: $${cfg.hourlyCostUsd}) — cost runaway?`);
      }
    }),

    await runCheck("push-reachability", "at least one live push subscription", async () => {
      const { rows } = await db.query(
        `SELECT count(*) AS n FROM auth_sessions WHERE push_subscription IS NOT NULL AND revoked_at IS NULL`,
      );
      if (Number(rows[0].n) === 0) {
        return { status: "degraded", remediation: "no device can receive alerts — enable notifications in the PWA status tab" };
      }
    }),
  ];
}
