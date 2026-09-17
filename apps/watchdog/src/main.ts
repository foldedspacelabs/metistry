// The watchdog — and, under the launchd shape, the SUPERVISOR it grew into.
//
// Started with `--config <supervisor.json>` (or METISTRY_SUPERVISOR_CONFIG)
// this process is `com.foldedspacelabs.metistry`: the ONE launchd agent the
// core installs, running Postgres, the console, the reconciler, the assistant
// and any enabled bridges as its children (supervisor.ts), and answering
// `metistry restart|stop|start <service>` on a local socket (control.ts).
// Without it — the compose shape, and Linux — it is exactly the watchdog it
// has always been: probes, alerts, nothing else.
//
// The probe loop is unchanged in both modes. It is the invariant-3 exception,
// and it stays in the same process it always ran in.

import { readFile } from "node:fs/promises";
import pg from "pg";
import { intEnv, optionalEnv, requireEnv, startRun, finishRun, parseSupervisorConfig } from "@foldedspacelabs/metistry-core";
import { runProbes } from "./probes.js";
import { alertFailures, isFailure } from "./alert.js";
import { bridgesFromEnv } from "./bridges.js";
import { Supervisor, startupSummary } from "./supervisor.js";
import { listenControl } from "./control.js";

/** `--config <path>`, else METISTRY_SUPERVISOR_CONFIG, else "watchdog only". */
export function configPathFrom(argv: string[], env: NodeJS.ProcessEnv): string | undefined {
  const i = argv.indexOf("--config");
  if (i !== -1 && argv[i + 1]) return argv[i + 1];
  return env.METISTRY_SUPERVISOR_CONFIG || undefined;
}

/** Returns the config it started, so the probe half can read the child set. */
async function runSupervisor(path: string): Promise<{ children: { name: string }[] }> {
  const config = parseSupervisorConfig(JSON.parse(await readFile(path, "utf8")), path);
  // the config's own env: the plist `metistry up` installs carries the same
  // dict, but the one the Mac app embeds in its signed bundle can carry
  // nothing install-specific — so this is the supervisor's environment either
  // way, and the watchdog half finds its db credentials in both paths
  Object.assign(process.env, config.env);
  const sup = new Supervisor(config);
  console.log(startupSummary(config));
  const control = await listenControl(sup);
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal} — stopping ${config.children.length} child(ren) in reverse order`);
    void (async () => {
      await sup.shutdown();
      await control.close();
      process.exit(0);
    })();
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
  await sup.start();
  return config;
}

/**
 * `supervised` is the supervisor's child list when this process IS the
 * supervisor, and undefined otherwise (the compose shape, Linux) — the only
 * honest source for "is the assistant supposed to be running at all?". With
 * no engine in compute.yaml `metistry up` omits the child, and the queue it
 * is not draining must not alert every cycle (probes.ts, `assistantAbsent`).
 */
function startProbing(supervised?: string[]): void {
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
    // silent-collector: manifests read from the checkout (WorkingDirectory in the launchd plist)
    collectorsDir: optionalEnv("METISTRY_COLLECTORS_DIR", "collectors"),
    routinesDir: optionalEnv("METISTRY_ROUTINES_DIR", "routines"), // the PRODUCT's routines/ (cwd-relative); the instance's own live at .metistry/routines
    silenceFactor: intEnv("METISTRY_WATCHDOG_SILENCE_FACTOR", 3),
    startedAt: new Date(),
    // bridge-degraded + fm-tier-never-fires: the same URL/token pairs the console gets
    bridges: bridgesFromEnv(),
    fmMinCaptures: intEnv("METISTRY_WATCHDOG_FM_MIN_CAPTURES", 5),
    fmWindowHours: intEnv("METISTRY_WATCHDOG_FM_WINDOW_HOURS", 24),
    assistantAbsent: supervised !== undefined && !supervised.includes("assistant"),
  };
  const intervalSec = intEnv("METISTRY_WATCHDOG_INTERVAL_SEC", 60);
  let lastHeartbeat = 0;

  console.log(
    `watchdog probing every ${intervalSec}s (console: ${cfg.consoleUrl}; bridges: ${cfg.bridges.map((b) => `${b.name}@${b.url}`).join(", ") || "none"})`,
  );

  setInterval(async () => {
    try {
      const checks = await runProbes(pool, cfg);
      const failures = checks.filter(isFailure);
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
}

const configPath = configPathFrom(process.argv.slice(2), process.env);
let supervised: string[] | undefined;
if (configPath) {
  // children first: the probes are about a running install, and there is not
  // one until Postgres and the console are up
  supervised = (await runSupervisor(configPath)).children.map((c) => c.name);
}
try {
  startProbing(supervised);
} catch (err) {
  // a missing METISTRY_DB_PASSWORD is fatal to the watchdog and must NOT be
  // fatal to the supervisor: the children it just started are the install
  console.error("watchdog probes not started:", err instanceof Error ? err.message : err);
  if (!configPath) process.exit(1);
}
