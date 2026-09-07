// Scheduled-component discovery for the silent-collector probe. The
// watchdog runs on the host under launchd, so it reads the same
// collectors/ and routines/ manifests the console's loadSchedules reads —
// straight from the repo checkout (METISTRY_COLLECTORS_DIR /
// METISTRY_ROUTINES_DIR), never through the console: the probe must still
// work when the console is the thing that died. Discovery is by directory,
// not by importing the collector registry — the registry pulls in every
// collector module, and this path stays model-free and dependency-thin
// (PoC-11). manifests.test.ts (console) already pins "every shipped
// manifest is registered", so the two views agree.

import { readdir, readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { validateManifest, scheduleToSeconds } from "@foldedspacelabs/metistry-core";

export interface ScheduledComponent {
  name: string;
  runKind: "collector_run" | "routine_run";
  schedule: string;
  intervalSec: number;
}

/** Every collector/routine manifest under `dir` with a parseable schedule. Missing dir = nothing scheduled. */
export async function loadScheduled(dir: string): Promise<ScheduledComponent[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err: any) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
  const out: ScheduledComponent[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let raw: string;
    try {
      raw = await readFile(`${dir}/${entry.name}/manifest.yaml`, "utf8");
    } catch {
      continue; // not a component directory
    }
    const r = validateManifest(parseYaml(raw));
    if (!r.ok) throw new Error(`${dir}/${entry.name}: invalid manifest: ${r.errors.join("; ")}`);
    const m = r.manifest;
    if (m.type !== "collector" && m.type !== "routine") continue;
    out.push({
      name: m.name,
      runKind: m.type === "routine" ? "routine_run" : "collector_run",
      schedule: m.schedule,
      intervalSec: scheduleToSeconds(m.schedule),
    });
  }
  return out;
}
