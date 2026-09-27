// Watchdog probes — model-free by construction: nothing here calls a model
// provider, so "the key expired" and "the assistant is dead" are still
// reportable. Direct db access is the named invariant-3 exception (the
// watchdog must be able to say the console itself is down). All probes
// return the frozen check() shape.
//
// Alert texts are deduped by exact string (alert.ts), so remediation lines
// name WHAT is wrong and the fix, never a changing number — counts and
// ages ride in `meta` for the log.

import { runCheck, type CheckResult } from "@foldedspacelabs/metistry-core";
import { loadScheduled, type ScheduledComponent } from "./manifests.js";
import { checkBridge, summarizeBridges, type BridgeOutcome, type BridgeTarget } from "./bridges.js";

export interface Db {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

export interface ProbeConfig {
  consoleUrl: string; // e.g. http://127.0.0.1:8080
  stuckNewMin: number; // inbound sitting in 'new' longer than this = assistant dead/backlogged
  stuckProcessingMin: number;
  inflightRunMin: number; // two-phase runs older than this with no finish = hung call (CRIT-8)
  hourlyCostUsd: number; // cost-runaway line
  collectorsDir: string; // manifests the console's runner schedules from (repo paths — the watchdog is on the host)
  routinesDir: string;
  /** the instance's `.metistry/extensions/` — an owner's overlay moves a schedule for the watchdog too (plan §2.7) */
  extensionsDir?: string | undefined;
  silenceFactor: number; // a collector is silent after this × its manifest interval with no runs row
  startedAt: Date; // "never ran" is measured from watchdog start, so a fresh install doesn't alert on cycle one
  bridges: BridgeTarget[]; // configured host bridges (bridges.ts: bridgesFromEnv)
  fmMinCaptures: number; // rule-default captures needed before "the FM tier never fires" is a claim
  fmWindowHours: number;
  /**
   * The assistant is deliberately not running: the supervisor's child list
   * has no `assistant`, because this install has no engine — no
   * `assignments.default` in compute.yaml, or no key for the provider it
   * names (docs/ops/assistant-tools.md, "Running without an engine"). A queue that
   * nobody is draining is then the expected state, not a dead engine, so
   * assistant-drain reports `absent` instead of alerting every cycle.
   * Absent/false = probe as always (the compose shape, and Linux, where
   * there is no child list to read).
   */
  assistantAbsent?: boolean;
}

// ---- decision logic, pure (unit-tested with fakes) -------------------------

export interface SilenceInput extends ScheduledComponent {
  lastRunAt: Date | null;
}

export interface SilentComponent {
  name: string;
  schedule: string;
  limitSec: number;
  silentSec: number;
  neverRan: boolean;
}

/** Silent = no runs row inside factor × interval. Never-ran counts from `since` (watchdog start), not the epoch. */
export function silentComponents(components: SilenceInput[], now: Date, since: Date, factor: number): SilentComponent[] {
  const out: SilentComponent[] = [];
  for (const c of components) {
    const ref = c.lastRunAt ?? since;
    const silentSec = Math.floor((now.getTime() - ref.getTime()) / 1000);
    const limitSec = factor * c.intervalSec;
    if (silentSec > limitSec) {
      out.push({ name: c.name, schedule: c.schedule, limitSec, silentSec, neverRan: c.lastRunAt === null });
    }
  }
  return out;
}

export interface FmTierCounts {
  /** captures the rules could not place (reason "default", non-empty note) that stayed deterministic — exactly what the FM tier exists to refine */
  ruleDefault: number;
  /** captures the apple-fm tier actually classified */
  fm: number;
}

/** The tier "never fires" when enough rule-default captures exist and the deterministic fallbacks outnumber apple-fm's. */
export function fmTierNeverFires(counts: FmTierCounts, minCaptures: number): boolean {
  return counts.ruleDefault >= minCaptures && counts.ruleDefault > counts.fm;
}

function humanSec(sec: number): string {
  if (sec % 86400 === 0) return `${sec / 86400}d`;
  if (sec % 3600 === 0) return `${sec / 3600}h`;
  return `${Math.round(sec / 60)}m`;
}

// ---- the probes ------------------------------------------------------------

export async function runProbes(db: Db, cfg: ProbeConfig, fetchFn = fetch): Promise<CheckResult[]> {
  let bridgeOutcomes: BridgeOutcome[] = []; // bridge-degraded fills this; fm-tier-never-fires reads apple-fm's entry

  return [
    await runCheck("db", "SELECT 1 round-trip", async () => {
      await db.query("SELECT 1");
    }),

    await runCheck("console", `GET ${cfg.consoleUrl}/health`, async () => {
      const r = await fetchFn(`${cfg.consoleUrl}/health`, { signal: AbortSignal.timeout(5000) });
      if (!r.ok) throw new Error(`console /health returned ${r.status} — check the console service/container`);
    }),

    await runCheck(
      "assistant-drain",
      cfg.assistantAbsent
        ? "the assistant is not a supervisor child (no engine in compute.yaml) — a waiting queue is expected"
        : `no inbound stuck >${cfg.stuckNewMin}m new / >${cfg.stuckProcessingMin}m processing`,
      async () => {
        const { rows } = await db.query(
          `SELECT
           count(*) FILTER (WHERE status = 'new' AND ts < now() - make_interval(mins => $1)) AS stuck_new,
           count(*) FILTER (WHERE status = 'processing' AND ts < now() - make_interval(mins => $2)) AS stuck_proc
         FROM inbound_messages`,
          [cfg.stuckNewMin, cfg.stuckProcessingMin],
        );
        const { stuck_new, stuck_proc } = rows[0];
        // nothing is draining the queue ON PURPOSE: say so once, in the row,
        // and raise no alert (alert.ts: `absent` is not a failure)
        if (cfg.assistantAbsent) {
          return {
            status: "absent",
            remediation: "no engine, so the supervisor does not start the assistant — turns wait in the queue until `metistry compute assign default <provider/model>` gives it one (docs/ops/assistant-tools.md)",
            meta: { waiting_new: Number(stuck_new), waiting_processing: Number(stuck_proc) },
          };
        }
        if (Number(stuck_new) > 0) throw new Error(`${stuck_new} message(s) unclaimed — assistant down? restart the assistant service`);
        if (Number(stuck_proc) > 0) throw new Error(`${stuck_proc} message(s) stuck processing — assistant hung mid-turn`);
      },
    ),

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

    // PoC-11 named "collector staleness" as a watchdog duty: a runner that
    // died, or a collector that throws before startRun, leaves the data
    // quietly stale while every other probe stays green.
    await runCheck("silent-collector", `every scheduled collector/routine has a runs row within ${cfg.silenceFactor}× its manifest interval`, async () => {
      const { scheduled, skipped } = await loadScheduled(cfg);
      const skips = skipped.length > 0 ? { skipped: Object.fromEntries(skipped.map((s) => [s.name ?? s.path, s.reason])) } : {};
      if (scheduled.length === 0) return { status: "absent", meta: { scheduled: 0, ...skips } };
      const { rows } = await db.query(
        `SELECT component, kind, max(ts) AS last FROM runs
         WHERE kind IN ('collector_run', 'routine_run') GROUP BY component, kind`,
      );
      const last = new Map<string, Date>(rows.map((r) => [`${r.component}/${r.kind}`, new Date(r.last)]));
      const silent = silentComponents(
        scheduled.map((s) => ({ ...s, lastRunAt: last.get(`${s.name}/${s.runKind}`) ?? null })),
        new Date(),
        cfg.startedAt,
        cfg.silenceFactor,
      );
      const meta = { scheduled: scheduled.length, silent: Object.fromEntries(silent.map((s) => [s.name, s.silentSec])), ...skips };
      if (silent.length === 0) return { meta };
      const who = silent
        .map((s) => (s.neverRan ? `${s.name} (never ran since watchdog start; schedule "${s.schedule}")` : `${s.name} (no run in >${humanSec(s.limitSec)}; schedule "${s.schedule}")`))
        .join(", ");
      return {
        status: "failed",
        remediation: `${who} — the console's runner is not running it: check the console container log (docker compose logs console) and that the manifest still loads`,
        meta,
      };
    }),

    await runCheck("bridge-degraded", `GET /check on ${cfg.bridges.map((b) => b.name).join(", ") || "(no bridges configured)"} answers status ok`, async () => {
      bridgeOutcomes = await Promise.all(cfg.bridges.map((b) => checkBridge(b, fetchFn)));
      return summarizeBridges(bridgeOutcomes);
    }),

    // The model tier degrades ABSENT on any failure (inbox-drain), which is
    // right for a collector and invisible for an operator: a bad token in
    // the console container and a healthy bridge look identical from the
    // data alone. This probe is the difference between "configured" and
    // "used".
    //
    // The count is "tier is anything but deterministic", not "tier is
    // apple-fm": since PR 4 the tier recorded on a proposal is the PROVIDER
    // that classified it, whatever compute.yaml called it, and a probe that
    // pinned one spelling would report a healthy custom-named provider as a
    // failure.
    await runCheck("fm-tier-never-fires", `the on-device model tier classified some rule-default capture in the last ${cfg.fmWindowHours}h (bridge healthy, ≥${cfg.fmMinCaptures} candidates)`, async () => {
      const afm = bridgeOutcomes.find((o) => o.name === "apple-fm");
      if (!afm) return { status: "absent", meta: { configured: false } };
      if (afm.state !== "ok") return { meta: { bridge: afm.state, skipped: "bridge not healthy — bridge-degraded reports it" } };
      const { rows } = await db.query(
        `SELECT
           count(*) FILTER (WHERE payload->>'tier' <> 'deterministic') AS fm,
           count(*) FILTER (WHERE payload->>'tier' = 'deterministic'
                              AND payload->'classification'->>'reason' = 'default'
                              AND coalesce(trim(payload->>'note'), '') <> '') AS rule_default
         FROM proposals
         WHERE kind = 'knowledge' AND payload ? 'tier' AND ts > now() - make_interval(hours => $1)`,
        [cfg.fmWindowHours],
      );
      const counts: FmTierCounts = { ruleDefault: Number(rows[0].rule_default), fm: Number(rows[0].fm) };
      if (!fmTierNeverFires(counts, cfg.fmMinCaptures)) return { meta: { ...counts } };
      return {
        status: "degraded",
        remediation:
          `apple-fm answers /check but inbox-drain never reaches it: in the last ${cfg.fmWindowHours}h the deterministic fallbacks outnumber model classifications (≥${cfg.fmMinCaptures} rule-default captures seen) — ` +
          `check that compute.yaml declares the provider inbox-drain's manifest pins (\`metistry compute providers add --from applefm\`), that METISTRY_BRIDGE_TOKEN_APPLE_FM is in the console's env, and the console log for /v1/chat/completions errors`,
        meta: { ...counts },
      };
    }),
  ];
}
