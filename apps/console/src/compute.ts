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
import {
  DEFAULT_TIER,
  finishRun,
  optionalEnv,
  overlayFilesFromEnv,
  resolveAssignment,
  startComputeWatch,
  startRun,
  type Compute,
  type ComputeReload,
  type ComputeWatch,
  type ResolvedAssignment,
  type RunExecutor,
  type WatchSeam,
} from "@foldedspacelabs/metistry-core";

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
  // The overlay's instance half is resolved against METISTRY_INSTANCE_DIR,
  // never against this process's working directory (core's
  // `overlayFilesFromEnv`). Under the launchd shape that directory is the
  // PRODUCT checkout, so the old relative default read the SEED's
  // compute.yaml: no providers for the console, and no assignments for the
  // engine — which then refuses to start.
  const paths = optionalEnv("METISTRY_COMPUTE_FILES", overlayFilesFromEnv(process.env, "compute"));
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

/**
 * The non-ZDR warning (C13, the owner's ruling): an `off_machine` assignment
 * on a provider that does not claim zero data retention writes ONE warning
 * `runs` row and then WORKS. Informed choice, never a block — and the row is
 * what makes it informed, because the badge in the app and the weekly review
 * both read it.
 *
 * Once per (provider, model, day): a warning repeated on every turn is not a
 * warning, it is noise, and the second one tells you nothing the first did
 * not. The day is the natural window — it is how long a decision to keep
 * using a provider stays fresh.
 */
export async function warnNonZdr(db: RunExecutor, component: string, assignment: ResolvedAssignment, now: Date = new Date()): Promise<boolean> {
  if (assignment.config.locality !== "off_machine" || assignment.config.zdr === true) return false;
  const key = `${assignment.provider}/${assignment.model}:${now.toISOString().slice(0, 10)}`;
  const { rows } = await db.query(`SELECT 1 FROM runs WHERE kind = 'config' AND tool = 'non_zdr' AND meta->>'window_key' = $1 LIMIT 1`, [key]);
  if (rows.length > 0) return false;
  const id = await startRun(db, {
    component,
    kind: "config",
    tool: "non_zdr",
    provider: assignment.provider,
    model: assignment.model,
    meta: { window_key: key, assignment: assignment.from, ref: assignment.ref },
  });
  await finishRun(db, id, {
    ok: false,
    error:
      `${assignment.from} runs on ${assignment.ref}, and compute.yaml does not set providers.${assignment.provider}.zdr: true — ` +
      `prompts and completions sent to it may be retained by the provider. This is a warning, not a block: the assignment stands. ` +
      `Set zdr: true once you have confirmed the provider's policy, or assign this tier to an on_machine provider.`,
  });
  return true;
}

/**
 * Every off-machine assignment in force, warned once each. Called at startup
 * and after every reload that changed something, so a NEW non-ZDR assignment
 * is announced the moment it is written rather than at the next turn.
 */
export async function warnNonZdrAssignments(db: RunExecutor, component: string, cfg: Compute): Promise<number> {
  const names = cfg.assignments ? [DEFAULT_TIER, ...Object.keys(cfg.assignments.tiers), ...Object.keys(cfg.assignments.crews).map((c) => `crew:${c}`)] : [];
  let warned = 0;
  for (const name of names) {
    const a = resolveAssignment(cfg, name);
    if (a && (await warnNonZdr(db, component, a))) warned++;
  }
  return warned;
}
