// The console's window onto `compute.yaml` (C1): load the D4 overlay once at
// startup, then watch it, so an edit made by `metistry compute` or by hand
// takes effect without a restart.
//
// The reload RULES live in core (`ComputeStore`: atomic swap on a valid
// parse, last-good kept on an invalid one) because the assistant needs the
// same ones. What lives here is the wiring core deliberately does not carry:
// chokidar, and the `runs` row an invalid file gets. The assistant's copy is
// the same six lines against its own pool — small enough that sharing it
// would mean a package neither of them wants.

import chokidar from "chokidar";
import { COMPUTE_FILES_DEFAULT, finishRun, optionalEnv, startComputeWatch, startRun, type ComputeReload, type ComputeWatch, type RunExecutor, type WatchSeam } from "@foldedspacelabs/metistry-core";

/**
 * chokidar (pre-approved) rather than `fs.watch`: `git checkout` and every
 * editor's atomic save REPLACE the file, and a raw watch on the old inode
 * goes quiet after the first one. `awaitWriteFinish` is what keeps a
 * half-written save from being read as a broken file.
 */
export const chokidarWatch: WatchSeam = (paths, onChange) => {
  const w = chokidar.watch(paths, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
  });
  w.on("all", () => onChange());
  w.on("error", (err) => console.warn("compute.yaml watch:", err));
  return () => w.close();
};

/** One warning row per invalid reload — the record that says the file in force is not the file on disk. */
export async function recordComputeReload(db: RunExecutor, component: string, r: ComputeReload): Promise<void> {
  if (r.ok) return;
  const id = await startRun(db, { component, kind: "config", tool: "compute_reload", meta: { file: r.failedPath ?? null, in_force: r.path ?? null } });
  await finishRun(db, id, { ok: false, error: `compute.yaml did not parse; the last good configuration is still in force: ${(r.errors ?? []).join("; ")}` });
}

/**
 * Startup: load, log what is in force, and keep watching. An invalid file at
 * startup throws (as rules.yaml does) — only a later one degrades.
 *
 * `onChange` runs after every reload that actually changed something: it is
 * where the caller re-derives whatever it holds off the configuration (the
 * tier map, today).
 */
export async function watchCompute(db: RunExecutor, component: string, onChange?: () => void): Promise<ComputeWatch> {
  const paths = optionalEnv("METISTRY_COMPUTE_FILES", COMPUTE_FILES_DEFAULT);
  const watch = await startComputeWatch({
    paths,
    watch: chokidarWatch,
    onReload: (r) => {
      if (r.ok) {
        if (r.changed) {
          console.log(`compute.yaml reloaded from ${r.path}: ${describe(r)}`);
          onChange?.();
        }
      } else {
        console.warn(`compute.yaml at ${r.failedPath} did not parse — keeping the last good configuration: ${(r.errors ?? []).join("; ")}`);
      }
      void recordComputeReload(db, component, r).catch((e) => console.warn("compute.yaml runs row:", e));
    },
  });
  const cfg = watch.store.current;
  if (watch.store.path) {
    console.log(
      `compute: ${watch.store.path} — providers ${Object.keys(cfg.providers).join(", ") || "(none)"}; ` +
        (cfg.assignments ? `assignments in force (default ${cfg.assignments.default.model})` : "no assignments, so rules.yaml's tiers: is still the live map"),
    );
  } else {
    console.log(`compute: none of ${paths.split(":").filter(Boolean).join(", ")} exists — rules.yaml's tiers: is the live map (docs/ops/compute.md)`);
  }
  return watch;
}

function describe(r: ComputeReload): string {
  return `in force from ${r.path ?? "(none)"}`;
}
