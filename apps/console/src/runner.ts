// Minimal routine runner (SHOULD-8): schedules collectors from their
// manifests, gates on the runs table (per-collector last-run — survives
// restarts, no double-run storms), executes under a two-phase runs row.
// Cron support is deliberately narrow: */N minutes, @hourly, @daily —
// widen when a manifest actually needs more.

import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { startRun, finishRun, validateManifest } from "@foldedspacelabs/metistry-core";
import type { RegisteredCollector, Db } from "@metistry-apps/collectors";

export function scheduleToSeconds(schedule: string): number {
  if (schedule === "@hourly") return 3600;
  if (schedule === "@daily") return 86400;
  if (schedule === "@weekly") return 604800;
  const m = /^\*\/(\d+) \* \* \* \*$/.exec(schedule);
  if (m?.[1]) return Number(m[1]) * 60;
  throw new Error(`runner cannot schedule "${schedule}" yet — supported: */N minutes, @hourly, @daily, @weekly`);
}

export interface ScheduledCollector extends RegisteredCollector {
  intervalSec: number;
}

export async function loadSchedules(
  registered: RegisteredCollector[],
  collectorsDir: string,
): Promise<ScheduledCollector[]> {
  const out: ScheduledCollector[] = [];
  for (const c of registered) {
    const manifest = validateManifest(parseYaml(await readFile(`${collectorsDir}/${c.name}/manifest.yaml`, "utf8")));
    if (!manifest.ok) throw new Error(`collector ${c.name}: invalid manifest: ${manifest.errors.join("; ")}`);
    if (manifest.manifest.type !== "collector") throw new Error(`${c.name} is not a collector manifest`);
    out.push({ ...c, intervalSec: scheduleToSeconds(manifest.manifest.schedule) });
  }
  return out;
}

/** Run every collector that's due (last finished run older than its interval). */
export async function tick(db: Db, scheduled: ScheduledCollector[]): Promise<void> {
  for (const c of scheduled) {
    const { rows } = await db.query(
      `SELECT max(ts) AS last FROM runs WHERE component = $1 AND kind = 'collector_run'`,
      [c.name],
    );
    const last = rows[0]?.last ? new Date(rows[0].last).getTime() : 0;
    if (Date.now() - last < c.intervalSec * 1000) continue;
    const runId = await startRun(db, { component: c.name, kind: "collector_run" });
    try {
      const n = await c.run(db);
      await finishRun(db, runId, { ok: true, meta: { processed: n } });
    } catch (err) {
      await finishRun(db, runId, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
}

export function startRunner(db: Db, scheduled: ScheduledCollector[], everyMs = 60_000): NodeJS.Timeout {
  return setInterval(() => tick(db, scheduled).catch((e) => console.error("runner:", e)), everyMs);
}
