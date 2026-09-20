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
import { existsSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import pg from "pg";
import {
  intEnv,
  optionalEnv,
  requireEnv,
  startRun,
  finishRun,
  instanceFile,
  instanceStatePath,
  keepAwakeReason,
  parseKeepAwake,
  parseSupervisorConfig,
  KEEP_AWAKE_ENV,
  KEEP_AWAKE_STATE_FILENAME,
  type KeepAwake,
} from "@foldedspacelabs/metistry-core";
import { runProbes } from "./probes.js";
import { alertFailures, isFailure } from "./alert.js";
import { bridgesFromEnv } from "./bridges.js";
import { Supervisor, startupSummary } from "./supervisor.js";
import { EgressProxy } from "./egress-proxy.js";
import { listenControl } from "./control.js";
import { KEEP_AWAKE_INTERVAL_SEC_DEFAULT, KeepAwakeLoop } from "./power.js";

/** `--config <path>`, else METISTRY_SUPERVISOR_CONFIG, else "watchdog only". */
export function configPathFrom(argv: string[], env: NodeJS.ProcessEnv): string | undefined {
  const i = argv.indexOf("--config");
  if (i !== -1 && argv[i + 1]) return argv[i + 1];
  return env.METISTRY_SUPERVISOR_CONFIG || undefined;
}

/**
 * This install's root for state and config: the instance directory when the
 * environment names one (it always does under `metistry up` — `instanceVars`
 * sets it), else the checkout the job runs in, which is the same fallback
 * `doctor` uses when it looks for the same file.
 */
function instanceRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.METISTRY_INSTANCE_DIR?.replace(/\/+$/, "") || process.cwd();
}

/**
 * The assistant's name, from identity.yaml — the one place it lives
 * (CLAUDE.md). Read here rather than templated into `supervisor.json` by
 * `metistry up` so that renaming the assistant does not need a re-`up`, and
 * because a name baked into a generated file is a second place for it to live.
 * Unreadable, absent or nameless: "the assistant".
 */
export async function assistantName(root: string): Promise<string | undefined> {
  try {
    const file = instanceFile(root, "identity");
    if (!existsSync(file)) return undefined;
    const raw = parseYaml(await readFile(file, "utf8")) as { name?: unknown } | null;
    return typeof raw?.name === "string" && raw.name.trim() !== "" ? raw.name : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Keeping the Mac awake, when this install's `deployment.yaml` asked for it
 * (docs/ops/deployment-shapes.md, "Keeping the Mac awake"). Started by the
 * SUPERVISOR only: it is the process whose lifetime is the install's, and the
 * pid `caffeinate -w` watches has to be a process that outlives every service.
 *
 * macOS only — `caffeinate` does not exist on Linux and a container holds no
 * assertions (invariant 7: the same code, and a no-op where the platform has
 * nothing to do). `never` starts nothing at all rather than ticking forever to
 * decide not to.
 */
export async function startKeepAwake(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): Promise<KeepAwakeLoop | undefined> {
  const setting: KeepAwake | undefined = parseKeepAwake(env[KEEP_AWAKE_ENV]);
  if (platform !== "darwin") return undefined;
  if (setting === undefined || setting === "never") {
    if (env[KEEP_AWAKE_ENV] !== undefined && setting === undefined) console.error(`[keep-awake] ignoring ${KEEP_AWAKE_ENV}=${env[KEEP_AWAKE_ENV]}: not one of the four values (metistry doctor)`);
    return undefined;
  }
  const root = instanceRoot(env);
  const loop = new KeepAwakeLoop({
    setting,
    supervisorPid: process.pid,
    reason: keepAwakeReason(await assistantName(root)),
    statePath: instanceStatePath(root, "run", KEEP_AWAKE_STATE_FILENAME),
    intervalMs: intEnv("METISTRY_KEEP_AWAKE_INTERVAL_SEC", KEEP_AWAKE_INTERVAL_SEC_DEFAULT, env) * 1000,
  });
  await loop.start();
  return loop;
}

/**
 * The invariant-3 pool, opened once and shared by the two things in this
 * process that hold one: the probe loop and the egress proxy's audit rows.
 *
 * Lazy and forgiving. An install with no `METISTRY_DB_PASSWORD` still gets a
 * supervisor and still gets an egress door that REFUSES correctly — it just
 * cannot write the refusal down, which is a log line rather than a crash.
 */
let sharedPool: pg.Pool | undefined;
export function auditPool(env: NodeJS.ProcessEnv = process.env): pg.Pool | undefined {
  if (sharedPool) return sharedPool;
  if (!env.METISTRY_DB_PASSWORD) return undefined;
  sharedPool = new pg.Pool({
    host: optionalEnv("METISTRY_DB_HOST", "127.0.0.1"),
    port: intEnv("METISTRY_DB_PORT", 5432),
    database: optionalEnv("METISTRY_DB_NAME", "metistry"),
    user: optionalEnv("METISTRY_DB_USER", "metistry"),
    password: requireEnv("METISTRY_DB_PASSWORD"),
    max: 2,
  });
  return sharedPool;
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
  // The egress door, BEFORE any child is spawned: a confined child's profile
  // allows exactly this loopback port and nothing else off the machine, so a
  // proxy that came up second would be a window during which the engine's
  // provider call failed for no reason it could report. Never fatal — see
  // the catch: a supervisor that cannot bind the port still has children to
  // run, and doctor is where the missing door is reported.
  let egress: EgressProxy | undefined;
  if (config.egress) {
    try {
      egress = new EgressProxy(config.egress, { db: auditPool(), log: (l) => console.log(l) });
      await egress.listen();
    } catch (err) {
      egress = undefined;
      console.error(`[egress] the CONNECT proxy did not start on 127.0.0.1:${config.egress.port}: ${err instanceof Error ? err.message : err} — every confined child's off-machine traffic will be refused by its profile`);
    }
  }
  // the assertion is tied to THIS process (`caffeinate -w <our pid>`), so it
  // is taken here, with the children, and dropped with them. Never fatal: the
  // children ARE the install, and failing to keep the Mac awake must not stop
  // it running — doctor reports the row instead.
  let keepAwake: KeepAwakeLoop | undefined;
  try {
    keepAwake = await startKeepAwake();
  } catch (err) {
    console.error("[keep-awake] not started:", err instanceof Error ? err.message : err);
  }
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal} — stopping ${config.children.length} child(ren) in reverse order`);
    void (async () => {
      // released first and recorded as a clean stop, so the gap that follows
      // is never read back as "the Mac slept under us"
      await keepAwake?.stop();
      await sup.shutdown();
      await egress?.close();
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
  // `requireEnv` still throws when there is no password: the probe loop
  // cannot do its work without a db, and that is fatal to the WATCHDOG (the
  // caller catches it and keeps the supervisor's children running)
  requireEnv("METISTRY_DB_PASSWORD");
  const pool = auditPool()!;

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
