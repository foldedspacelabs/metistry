// Scheduled-component discovery for the silent-collector probe. The
// watchdog runs on the host under launchd, so it reads the same
// collectors/ and routines/ manifests the console's runner reads —
// straight from the repo checkout (METISTRY_COLLECTORS_DIR /
// METISTRY_ROUTINES_DIR) and the instance's extensions, never through the
// console: the probe must still work when the console is the thing that
// died. It loads them through the SAME registries (core's `loadKind`, plan
// §2.7) — overlay by name, skip with a reason, `schema: 1` — so an owner's
// extension that moves a collector's schedule moves the watchdog's
// expectation with it, and a unit the console skips is one the watchdog does
// not wait for. It does not import the collector modules themselves: this
// path stays model-free and dependency-thin (PoC-11). manifests.test.ts
// (console) pins that every product unit has its code, so the two views agree.

import { loadKind, scheduleToSeconds, type RegistrySkip } from "@foldedspacelabs/metistry-core";

export interface ScheduledComponent {
  name: string;
  runKind: "collector_run" | "routine_run";
  schedule: string;
  intervalSec: number;
}

export interface ScheduledDirs {
  /** the product's collectors/ */
  collectorsDir: string;
  /** the product's routines/ */
  routinesDir: string;
  /** the instance's `.metistry/extensions/`; absent = product units only */
  extensionsDir?: string | undefined;
}

/** Every collector and routine the console's runner would schedule, and every one a registry skipped (with why). Missing dirs = nothing. Never throws on a manifest. */
export async function loadScheduled(dirs: ScheduledDirs): Promise<{ scheduled: ScheduledComponent[]; skipped: RegistrySkip[] }> {
  const scheduled: ScheduledComponent[] = [];
  const skipped: RegistrySkip[] = [];
  for (const [kind, home] of [["collector", dirs.collectorsDir], ["routine", dirs.routinesDir]] as const) {
    const reg = await loadKind(kind, { home, extensionsDir: dirs.extensionsDir });
    skipped.push(...reg.skipped);
    for (const u of reg.units()) {
      let intervalSec: number;
      try {
        intervalSec = scheduleToSeconds(u.manifest.schedule);
      } catch (e) {
        skipped.push({ path: u.path, origin: u.origin, name: u.name, reason: (e as Error).message }); // the runner skips it too
        continue;
      }
      scheduled.push({ name: u.name, runKind: kind === "routine" ? "routine_run" : "collector_run", schedule: u.manifest.schedule, intervalSec });
    }
  }
  return { scheduled, skipped };
}
