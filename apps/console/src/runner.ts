// Minimal routine runner (SHOULD-8): schedules collectors from their
// manifests, gates on the runs table (per-collector last-run — survives
// restarts, no double-run storms), executes under a two-phase runs row.
// Cron support is deliberately narrow: */N minutes, 0 */N hours, @hourly,
// @daily, @weekly — widen when a manifest actually needs more. Every
// shipped manifest must parse: the console refuses to start otherwise
// (it crash-looped once on an unparsed schedule — manifests.test.ts).

import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { startRun, finishRun, validateManifest } from "@foldedspacelabs/metistry-core";
import type { RegisteredCollector, Db, CollectorCtx } from "@metistry-apps/collectors";

export function scheduleToSeconds(schedule: string): number {
  if (schedule === "@hourly") return 3600;
  if (schedule === "@daily") return 86400;
  if (schedule === "@weekly") return 604800;
  const m = /^\*\/(\d+) \* \* \* \*$/.exec(schedule);
  if (m?.[1]) return Number(m[1]) * 60;
  const h = /^0 \*\/(\d+) \* \* \*$/.exec(schedule); // every N hours
  if (h?.[1]) return Number(h[1]) * 3600;
  throw new Error(`runner cannot schedule "${schedule}" yet — supported: */N minutes, 0 */N hours, @hourly, @daily, @weekly`);
}

export interface ScheduledCollector extends RegisteredCollector {
  intervalSec: number;
  runKind: "collector_run" | "routine_run";
}

export async function loadSchedules(
  registered: RegisteredCollector[],
  collectorsDir: string,
): Promise<ScheduledCollector[]> {
  const out: ScheduledCollector[] = [];
  for (const c of registered) {
    const manifest = validateManifest(parseYaml(await readFile(`${collectorsDir}/${c.name}/manifest.yaml`, "utf8")));
    if (!manifest.ok) throw new Error(`${c.name}: invalid manifest: ${manifest.errors.join("; ")}`);
    const m = manifest.manifest;
    if (m.type !== "collector" && m.type !== "routine") throw new Error(`${c.name}: not schedulable (type ${m.type})`);
    if (m.schedule === undefined) throw new Error(`${c.name}: no schedule`);
    out.push({ ...c, intervalSec: scheduleToSeconds(m.schedule), runKind: m.type === "routine" ? "routine_run" : "collector_run" });
  }
  return out;
}

/** Run every collector that's due (last finished run older than its interval). */
export async function tick(db: Db, scheduled: ScheduledCollector[], ctx: CollectorCtx = {}): Promise<void> {
  for (const c of scheduled) {
    const { rows } = await db.query(
      `SELECT max(ts) AS last FROM runs WHERE component = $1 AND kind = $2`,
      [c.name, c.runKind],
    );
    const last = rows[0]?.last ? new Date(rows[0].last).getTime() : 0;
    if (Date.now() - last < c.intervalSec * 1000) continue;
    const runId = await startRun(db, { component: c.name, kind: c.runKind });
    try {
      const n = await c.run(db, ctx);
      await finishRun(db, runId, { ok: true, meta: { processed: n } });
    } catch (err) {
      await finishRun(db, runId, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
}

export function startRunner(db: Db, scheduled: ScheduledCollector[], ctx: CollectorCtx = {}, everyMs = 60_000): NodeJS.Timeout {
  return setInterval(() => tick(db, scheduled, ctx).catch((e) => console.error("runner:", e)), everyMs);
}
