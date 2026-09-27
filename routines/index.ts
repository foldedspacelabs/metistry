// The routine registry (plan §2.7) — the collectors' shape, built from
// manifests rather than a list in code. A product routine is a directory with
// a manifest and a `run.ts`; the console's runner loads every
// `routines/*/manifest.yaml` through core's `Registry`, overlays the owner's
// extensions by name (D4), and finds each unit's code here by its NAME.
// Adding a routine is adding its directory — there is no line to add here.
//
// An extension may replace a routine's manifest, and the product's `run`
// still runs under it; one naming no product routine is skipped with that
// reason (code from an extension runs only as a process, plan §5). A routine
// with no code at all is an assignment in `scheduled.yaml` (§2.5), not a unit
// of this registry.

import { joinCode, loadKind, unitCode, type CodedUnit, type KindRoots, type Manifest, type MissingCode, type RegistrySkip } from "@foldedspacelabs/metistry-core";
import type { Db, RoutineCtx } from "./morning-brief/run.js";

export type RoutineRun = (db: Db, ctx?: RoutineCtx) => Promise<number>;
export type RoutineManifest = Extract<Manifest, { type: "routine" }>;

export interface RegisteredRoutine {
  name: string;
  run(db: Db, ctx?: RoutineCtx): Promise<number>;
}

/** This package's compiled tree (or its source, under its own tests): where `<name>/run.js` is. */
const CODE_BASE = new URL(".", import.meta.url);

/** The product's `run` for the routine `name`, or why there is none. */
export function routineCode(name: string): Promise<RoutineRun | MissingCode> {
  return unitCode<RoutineRun>(CODE_BASE, name);
}

export interface LoadedRoutines {
  /** Every routine that loaded, with its manifest and code, sorted by name. */
  routines: CodedUnit<RoutineManifest, RoutineRun>[];
  /** Every one that did not, with why. */
  skipped: RegistrySkip[];
}

/** Load the routine registry from these roots and join each unit to its product code. Never throws. */
export async function loadRoutines(roots: KindRoots): Promise<LoadedRoutines> {
  const { units, skipped } = await joinCode(await loadKind("routine", roots), routineCode);
  return { routines: units, skipped };
}

export type { Db, RoutineCtx };
// What `plan-tomorrow` needs and no collector does — the named-query store and
// the vault bridge. Exported so the console's runner can widen the ctx it
// hands every component in ONE type, rather than each caller guessing.
export type { PlanCtx, PlanVault } from "./plan-tomorrow/run.js";
// What the Update Check needs: the runtime's own version, to compare the newest release with.
export type { UpdateCheckCtx } from "./update-check/run.js";
// The `PlanVault` → `TemplateReader` adapter, shared so the runner builds the
// SAME `ctx.reader` every routine gets rather than reimplementing it —
// `knowledge-fold`'s `FoldCtx` has no `vault` field of its own, only `reader`.
export { vaultReader, type VaultReadable } from "./vault-reader.js";
// Purge Now (`POST /api/sessions/purge`, T3-9) is the scheduled
// `session-purge` routine's own delete on demand — the console's door calls
// these rather than holding a second copy of what "purge" means.
export { purgeArchive, purgePreview, type PurgeCounts, type PurgePreview, type UnfoldedSession } from "./session-purge/run.js";
// What the Standup routine takes beyond `PlanCtx`: its resolved Scheduled
// config (`template`, `skip_without_calendar_event`). Absent until the runner
// hands config on, and then the manifest's defaults apply.
export type { StandupCtx } from "./standup/run.js";
