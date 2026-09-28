// The collector registry (plan §2.7) — built from manifests, never from a
// list in code. A collector is a directory with a manifest and a `run.ts`
// (invariant 5); the console's runner loads every `collectors/*/manifest.yaml`
// through core's `Registry`, overlays the owner's extensions by name (D4),
// and finds each unit's code here by its NAME. Adding a collector is adding
// its directory — there is no line to add in this file.
//
// Code is only ever the product's: an extension may replace a collector's
// manifest (`extension: overlay` in core's REGISTRY_KINDS), and the product's
// `run` still runs under it; an extension naming no product collector is
// skipped with that reason, because code from an extension runs only as a
// process (plan §5), not in the console.

import { joinCode, loadKind, unitCode, type CodedUnit, type KindRoots, type Manifest, type MissingCode, type RegistrySkip } from "@foldedspacelabs/metistry-core";
import type { CollectorCtx, Db } from "./inbox-drain/run.js";

export type CollectorRun = (db: Db, ctx?: CollectorCtx) => Promise<number>;
export type CollectorManifest = Extract<Manifest, { type: "collector" }>;

export interface RegisteredCollector {
  name: string;
  /** parsed from the manifest's schedule by the runner */
  run(db: Db, ctx?: CollectorCtx): Promise<number>;
}

/** This package's compiled tree (or its source, under its own tests): where `<name>/run.js` is. */
const CODE_BASE = new URL(".", import.meta.url);

/** The product's `run` for the collector `name`, or why there is none. */
export function collectorCode(name: string): Promise<CollectorRun | MissingCode> {
  return unitCode<CollectorRun>(CODE_BASE, name);
}

export interface LoadedCollectors {
  /** Every collector that loaded, with its manifest and code, sorted by name. */
  collectors: CodedUnit<CollectorManifest, CollectorRun>[];
  /** Every one that did not, with why — the registry's skips and any unit with no product code. */
  skipped: RegistrySkip[];
}

/** Load the collector registry from these roots and join each unit to its product code. Never throws. */
export async function loadCollectors(roots: KindRoots): Promise<LoadedCollectors> {
  const { units, skipped } = await joinCode(await loadKind("collector", roots), collectorCode);
  return { collectors: units, skipped };
}

export type { Db, CollectorCtx };

// The Devin conventions the console's dispatcher shares with these
// collectors — ONE base URL and ONE `external_ref` format in the repo, not a
// copy on each side of the round trip (targets/devin-sessions).
export { DEVIN_API } from "./devin-knowledge/run.js";
export {
  REF_PREFIX as DEVIN_REF_PREFIX,
  devinRef,
  parseDevinRef,
  SOURCE_AGENT as DEVIN_SOURCE_AGENT,
  type DevinWorkMeta,
} from "./devin-sessions/run.js";

// The Linear sync's Add to Today (T4-24): the service a `task` request's
// primary answer calls, through the capture service. Exported for the
// console door that answers `{door: "today"}`.
export {
  TODAY_PRINCIPAL as LINEAR_TODAY_PRINCIPAL,
  TODAY_SOURCE as LINEAR_TODAY_SOURCE,
  TodayRefused as LinearTodayRefused,
  addIssueToToday,
  todayLine as linearTodayLine,
  type AddToTodayResult,
} from "./linear/today.js";

// Close in Linear (T4-26): the service behind
// `POST /api/trackers/:connection/issues/:key/complete`, and the console's
// opener for a tracker connection by name — the connection's tool mode for
// `complete_issue` is the owner's Ask First · Allow · Never.
export {
  COMPLETE_REFUSAL_CODES as LINEAR_COMPLETE_REFUSAL_CODES,
  CompleteRefused as LinearCompleteRefused,
  completeLinearIssue,
  linearTrackerOpener,
  type CompleteRefusalCode as LinearCompleteRefusalCode,
  type CompleteResult as LinearCompleteResult,
  type OpenedTracker,
  type TrackerOpener,
} from "./linear/complete.js";
