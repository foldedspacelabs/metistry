import pg from "pg";
import { intEnv, optionalEnv, requireEnv, startRun, finishRun } from "@foldedspacelabs/metistry-core";
import { runProbes } from "./probes.js";
import { alertFailures } from "./alert.js";

const pool = new pg.Pool({
  host: optionalEnv("METISTRY_DB_HOST", "127.0.0.1"),
  port: intEnv("METISTRY_DB_PORT", 5432),
  database: optionalEnv("METISTRY_DB_NAME", "metistry"),
  user: optionalEnv("METISTRY_DB_USER", "metistry"),
  password: requireEnv("METISTRY_DB_PASSWORD"),
  max: 2,
});

const cfg = {
  consoleUrl: optionalEnv("METISTRY_CONSOLE_URL", "http://127.0.0.1:8080"),
  stuckNewMin: intEnv("METISTRY_WATCHDOG_STUCK_NEW_MIN", 5),
  stuckProcessingMin: intEnv("METISTRY_WATCHDOG_STUCK_PROC_MIN", 15),
  inflightRunMin: intEnv("METISTRY_WATCHDOG_INFLIGHT_MIN", 15),
  hourlyCostUsd: intEnv("METISTRY_WATCHDOG_HOURLY_USD", 5),
};
const intervalSec = intEnv("METISTRY_WATCHDOG_INTERVAL_SEC", 60);
let lastHeartbeat = 0;

console.log(`watchdog probing every ${intervalSec}s (console: ${cfg.consoleUrl})`);

setInterval(async () => {
  try {
    const checks = await runProbes(pool, cfg);
    const failures = checks.filter((c) => c.status !== "ok");
    const raised = await alertFailures(pool, checks);
    for (const f of failures) console.error(`[${f.name}] ${f.status}: ${f.remediation ?? f.probe}`);
    // one heartbeat runs row per hour, plus a row whenever something failed
    if (failures.length > 0 || Date.now() - lastHeartbeat > 3_600_000) {
      lastHeartbeat = Date.now();
      const id = await startRun(pool, { component: "watchdog", kind: "doctor", meta: { failures: failures.map((f) => f.name), raised } });
      await finishRun(pool, id, { ok: failures.length === 0 });
    }
  } catch (err) {
    // db itself unreachable — stdout is the only honest channel left
    console.error("watchdog cycle failed:", err instanceof Error ? err.message : err);
  }
}, intervalSec * 1000);
