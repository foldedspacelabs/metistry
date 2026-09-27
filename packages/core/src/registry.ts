// Registry<Kind> — the one way a kind of unit is found (plan §2.7).
//
// Everything extendable is a kind with a manifest schema (manifest.ts) and a
// registry built FROM MANIFESTS, not from a list in code. Product units
// (`seed/`, `routines/`, `collectors/`, `packages/mcp-*`) and the owner's
// extensions (`.metistry/extensions/<name>/`) go through the same registry, so
// an extension is never a second-class path and a product unit is never
// special-cased.
//
// The rules, each decided in §2.7 and each tested:
//
//   * **A unit is a directory with a `manifest.yaml`** whose `type` is this
//     registry's kind. A directory without one is not a unit; a unit of
//     another kind belongs to another registry (the extensions directory holds
//     every kind, so each registry takes its own).
//   * **A manifest that fails is skipped with its reason, never fatal** — the
//     runner's rule (apps/console/src/runner.ts `loadSchedules`). One bad unit
//     never takes the others down, and the reason is data doctor can print.
//   * **`schema: 1`.** A missing version, or an unknown major, is a skip that
//     names the version.
//   * **Overlay by name** (D4): an extension with a product unit's name wins,
//     and the unit records what it replaced so doctor can say so; Reset to
//     Default removes the extension. Two units of the SAME origin with one
//     name are ambiguous — the second is skipped with a reason rather than
//     silently ordered.
//   * **Code comes only from the product** (T4-5). For a kind whose units
//     are code (`extension: overlay` — collectors, routines) an extension may
//     replace a product unit's manifest and nothing more; one naming no
//     product unit is skipped, because code from an extension runs only as a
//     process (§5). `unitCode`/`joinCode` find a unit's code by NAME in the
//     product's own tree.
//
// `buildRegistry` is the pure part (candidates in, registry out) so the rules
// are testable without a disk; `loadRegistry` reads directories into
// candidates. Paths are the caller's — nothing here assumes where an instance
// lives (invariant 7).

import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { resolveInstanceLayout } from "./instance-layout.js";
import { schemaVersionIssue, validateManifest, type Manifest, type ManifestType } from "./manifest.js";

/** Where a unit came from. Product units ship in the repo (reviewed code); extensions are the owner's hand (M15). */
export const UNIT_ORIGINS = ["product", "extension"] as const;
export type UnitOrigin = (typeof UNIT_ORIGINS)[number];

/**
 * What an extension may do with a kind (§2.7, "code from an extension never
 * runs inside the console"):
 *
 *   * `unit` — the kind is data. An extension may add a unit of it, or
 *     replace a product unit of the same name (D4).
 *   * `overlay` — the kind's units are product CODE described by a manifest
 *     (a collector, a routine). An extension may replace a product unit's
 *     manifest — its schedule, what it declares — and the code that runs is
 *     still the product's. An extension naming no product unit has no code
 *     to run: extension code runs only as a process (plan §5, after this
 *     program), so it is skipped with that reason rather than scheduled as
 *     nothing.
 */
export const EXTENSION_MODES = ["unit", "overlay"] as const;
export type ExtensionMode = (typeof EXTENSION_MODES)[number];

/** A kind a registry holds: its `type` value and the validator for its manifest. */
export interface RegistryKind<T extends { name: string }> {
  readonly kind: string;
  /** Default `unit`. */
  readonly extensions?: ExtensionMode;
  validate(input: unknown): { ok: true; manifest: T } | { ok: false; errors: string[] };
}

/** One manifest a registry considers: where it was found, and its parsed content (or why it could not be read). */
export interface UnitCandidate {
  path: string;
  origin: UnitOrigin;
  /** The unit's directory name, when the source requires it to equal the manifest's `name`. */
  dirName?: string;
  input?: unknown;
  /** Set when the file could not be read or parsed; `input` is then ignored. */
  unreadable?: string;
}

export interface RegistryUnit<T> {
  name: string;
  manifest: T;
  origin: UnitOrigin;
  path: string;
  /** The product unit this extension replaced (D4 overlay) — doctor says so. */
  replaced?: { origin: UnitOrigin; path: string };
}

export interface RegistrySkip {
  path: string;
  origin: UnitOrigin;
  /** The manifest's name, when it got far enough to have one. */
  name?: string;
  reason: string;
}

/** The loaded units of one kind, with every skip and its reason. */
export interface Registry<T extends { name: string }> {
  readonly kind: string;
  get(name: string): RegistryUnit<T> | undefined;
  has(name: string): boolean;
  /** Unit names, sorted. */
  names(): string[];
  /** Units, sorted by name. */
  units(): RegistryUnit<T>[];
  /** Extensions that replaced a product unit of the same name. */
  overlaid(): RegistryUnit<T>[];
  /** Every candidate of this kind that did not load, with why. */
  readonly skipped: readonly RegistrySkip[];
}

const ORIGIN_RANK: Record<UnitOrigin, number> = { product: 0, extension: 1 };

function typeOf(input: unknown): unknown {
  return input !== null && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>).type : undefined;
}

/**
 * Build a registry from candidates. Candidates whose `type` is another kind
 * are not this registry's and are passed over silently; everything of this
 * kind either loads or is skipped with a reason. Never throws.
 */
export function buildRegistry<T extends { name: string }>(kind: RegistryKind<T>, candidates: readonly UnitCandidate[]): Registry<T> {
  const units = new Map<string, RegistryUnit<T>>();
  const skipped: RegistrySkip[] = [];
  // Product before extension, so an extension meets the product unit it overlays; stable within an origin.
  const ordered = [...candidates].sort((a, b) => ORIGIN_RANK[a.origin] - ORIGIN_RANK[b.origin]);

  for (const c of ordered) {
    const skip = (reason: string, name?: string) => skipped.push({ path: c.path, origin: c.origin, reason, ...(name ? { name } : {}) });
    if (c.unreadable !== undefined) {
      skip(`unreadable: ${c.unreadable}`);
      continue;
    }
    if (typeOf(c.input) !== kind.kind) continue;
    const version = schemaVersionIssue((c.input as Record<string, unknown>).schema);
    if (version) {
      skip(version);
      continue;
    }
    const r = kind.validate(c.input);
    if (!r.ok) {
      skip(`invalid manifest: ${r.errors.join("; ")}`);
      continue;
    }
    const { name } = r.manifest;
    if (c.dirName !== undefined && c.dirName !== name) {
      skip(`manifest name "${name}" must match its directory "${c.dirName}"`, name);
      continue;
    }
    const existing = units.get(name);
    if (kind.extensions === "overlay" && c.origin === "extension" && !existing) {
      skip(
        `no product ${kind.kind} is named "${name}" — a ${kind.kind} is product code, and code from an extension runs only as a process (plan §5), which this Metistry does not load; an extension may only replace a product ${kind.kind}'s manifest`,
        name,
      );
      continue;
    }
    if (existing && existing.origin === c.origin) {
      skip(`duplicate ${c.origin} ${kind.kind} "${name}" — already defined by ${existing.path}`, name);
      continue;
    }
    units.set(name, {
      name,
      manifest: r.manifest,
      origin: c.origin,
      path: c.path,
      ...(existing ? { replaced: { origin: existing.origin, path: existing.path } } : {}),
    });
  }

  const sorted = () => [...units.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return {
    kind: kind.kind,
    get: (name) => units.get(name),
    has: (name) => units.has(name),
    names: () => sorted().map((u) => u.name),
    units: sorted,
    overlaid: () => sorted().filter((u) => u.replaced !== undefined),
    skipped,
  };
}

/** A directory whose immediate subdirectories are units: `<dir>/<unit>/manifest.yaml`. */
export interface RegistrySource {
  dir: string;
  origin: UnitOrigin;
  /**
   * Whether each unit's directory must be named for it. Default true — an
   * extension is removed by its name, so its directory must be that name.
   * False for product trees that prefix directory names (`packages/mcp-brain`
   * holds the bridge `brain`).
   */
  dirNameIsName?: boolean;
}

/** The manifest file every unit directory holds. */
export const MANIFEST_FILE = "manifest.yaml";

/**
 * Read one source's candidates. Never throws: a missing directory has none
 * (overlay directories are optional), and one that cannot be listed is a
 * single unreadable candidate, so the registry reports it as a skip. Symbolic
 * links are not followed — a unit lives in the tree it is loaded from.
 */
export async function readCandidates(source: RegistrySource): Promise<UnitCandidate[]> {
  let dirs: string[];
  try {
    dirs = (await readdir(source.dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return [];
    return [{ path: source.dir, origin: source.origin, unreadable: (err as Error).message }];
  }
  const out: UnitCandidate[] = [];
  for (const dir of dirs.sort()) {
    const path = join(source.dir, dir, MANIFEST_FILE);
    const at = { path, origin: source.origin, ...(source.dirNameIsName === false ? {} : { dirName: dir }) };
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") continue; // a directory without a manifest is not a unit
      out.push({ ...at, unreadable: (err as Error).message });
      continue;
    }
    try {
      out.push({ ...at, input: parseYaml(text) });
    } catch (err) {
      out.push({ ...at, unreadable: `not YAML — ${(err as Error).message.split("\n")[0]}` });
    }
  }
  return out;
}

/** Load a registry from directories: product sources and extension sources, in any order (origin decides precedence). */
export async function loadRegistry<T extends { name: string }>(kind: RegistryKind<T>, sources: readonly RegistrySource[]): Promise<Registry<T>> {
  const candidates: UnitCandidate[] = [];
  for (const s of sources) candidates.push(...(await readCandidates(s)));
  return buildRegistry(kind, candidates);
}

/** The registry kind for one `manifestSchema` type — validation through `validateManifest`, narrowed to that type. */
export function manifestKind<K extends ManifestType>(type: K): RegistryKind<Extract<Manifest, { type: K }>> {
  const spec = (REGISTRY_KINDS as Partial<Record<string, RegistryKindSpec>>)[type];
  return {
    kind: type,
    ...(spec ? { extensions: spec.extension } : {}),
    validate(input) {
      const r = validateManifest(input);
      if (!r.ok) return r;
      if (r.manifest.type !== type) return { ok: false, errors: [`type: expected ${type}, got ${r.manifest.type}`] };
      return { ok: true, manifest: r.manifest as Extract<Manifest, { type: K }> };
    },
  };
}

// ---- the kinds that load through a registry (T4-5) --------------------------

/** Where a kind's product units live, and what an extension may do with it. */
export interface RegistryKindSpec {
  /**
   * `root: product` — under the product checkout; `root: seed` — under its
   * `seed/`, which the published CLI also carries on its own (so provider
   * templates and connection types resolve on an install with no checkout).
   */
  home: { root: "product" | "seed"; dir: string };
  extension: ExtensionMode;
}

/**
 * Every kind that loads through a registry (§2.7's enums-to-registries).
 * A list of KINDS, closed on purpose — a new kind needs a schema and a
 * consumer, so it is a product change — never a list of units: a new unit of
 * any of these is a directory with a manifest, product or extension.
 *
 * Not here, deliberately: `bridge` and `service` (code, so an extension one is
 * a process extension — §5, after this program), and `agent` (defined in
 * `.metistry/agents/`, M12). An extension of those kinds is reported as
 * unclaimed rather than loaded.
 */
export const REGISTRY_KINDS = Object.freeze({
  collector: { home: { root: "product", dir: "collectors" }, extension: "overlay" },
  routine: { home: { root: "product", dir: "routines" }, extension: "overlay" },
  target: { home: { root: "product", dir: "targets" }, extension: "unit" },
  provider: { home: { root: "seed", dir: "compute-templates" }, extension: "unit" },
  "connection-type": { home: { root: "seed", dir: "connection-types" }, extension: "unit" },
} as const satisfies Partial<Record<ManifestType, RegistryKindSpec>>);

export type RegistryKindName = keyof typeof REGISTRY_KINDS;

export function isRegistryKind(v: unknown): v is RegistryKindName {
  return typeof v === "string" && Object.hasOwn(REGISTRY_KINDS, v);
}

/** Where one kind's registry reads from. Every path is the caller's (invariant 7). */
export interface KindRoots {
  /** The product checkout: `collectors/`, `routines/`, `targets/` are under it. */
  productDir?: string | undefined;
  /** The product's `seed/`: `compute-templates/`, `connection-types/`. Default `<productDir>/seed`. */
  seedDir?: string | undefined;
  /** The kind's product directory, when the caller already knows it (the console's `METISTRY_COLLECTORS_DIR`). Wins over the two above. */
  home?: string | undefined;
  /** The owner's own directories for this kind that predate extensions (a target's `.metistry/targets/`) — extension origin. */
  overlays?: readonly string[] | undefined;
  /** The instance's `.metistry/extensions/`. Absent = no extensions (an install that cannot see its instance). */
  extensionsDir?: string | undefined;
}

/** The kind's product directory under these roots, or undefined when they do not say. */
export function kindHome(kind: RegistryKindName, roots: KindRoots): string | undefined {
  if (roots.home !== undefined) return roots.home;
  const { home } = REGISTRY_KINDS[kind];
  if (home.root === "seed") {
    const seed = roots.seedDir ?? (roots.productDir !== undefined ? join(roots.productDir, "seed") : undefined);
    return seed !== undefined ? join(seed, home.dir) : undefined;
  }
  return roots.productDir !== undefined ? join(roots.productDir, home.dir) : undefined;
}

/**
 * A kind's sources: its product directory, then the owner's — any legacy
 * overlay directory, then the extensions directory. Order is for reading
 * only; origin decides precedence (`buildRegistry`). A product tree names
 * its directories for their units too (`collectors/github-state/`), which is
 * what `manifests.test.ts` and doctor already hold every checkout to.
 */
export function kindSources(kind: RegistryKindName, roots: KindRoots): RegistrySource[] {
  const out: RegistrySource[] = [];
  const home = kindHome(kind, roots);
  if (home !== undefined) out.push({ dir: home, origin: "product" });
  for (const dir of roots.overlays ?? []) out.push({ dir, origin: "extension" });
  if (roots.extensionsDir !== undefined) out.push({ dir: roots.extensionsDir, origin: "extension" });
  return out;
}

/** Load one kind's registry: its product units and the owner's, through `buildRegistry`'s rules. Never throws. */
export async function loadKind<K extends RegistryKindName>(kind: K, roots: KindRoots): Promise<Registry<Extract<Manifest, { type: K }>>> {
  return loadRegistry(manifestKind(kind), kindSources(kind, roots));
}

/** `<instance>/.metistry/extensions`, spelled the way that instance spells it. */
export function extensionsDirFor(instanceDir: string): string {
  return resolveInstanceLayout(instanceDir).path("extensionsDir");
}

/**
 * The extensions directory an install's process reads, from its environment:
 * `METISTRY_INSTANCE_DIR`'s `.metistry/extensions/`. Undefined when the process
 * cannot see its instance (the compose console, D5) — it then loads product
 * units only, and says so.
 */
export function extensionsDirFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  const dir = env.METISTRY_INSTANCE_DIR?.trim().replace(/\/+$/, "");
  return dir ? extensionsDirFor(dir) : undefined;
}

// ---- what the extensions directory holds (`metistry extensions list`) --------

/** One unit in `.metistry/extensions/` and what became of it. */
export interface ExtensionEntry {
  /** The unit's directory name (which `extensions remove` takes). */
  name: string;
  path: string;
  /** The manifest's `type` as written; undefined when it could not be read. */
  type?: string;
  /**
   * `loaded` — a unit of its kind, in force · `overlay` — in force, replacing
   * the product unit of the same name (Reset to Default removes it) ·
   * `skipped` — its kind's registry refused it, with `reason` · `unclaimed` —
   * no registry takes its `type`, with `reason`.
   */
  status: "loaded" | "overlay" | "skipped" | "unclaimed";
  reason?: string;
  /** For an overlay: the product unit it replaced. */
  replaced?: string;
}

/**
 * Why no registry takes a unit of this `type`. The extension model's closed
 * list is where this matters (§2.7): a plugin names values from Metistry's
 * vocabularies — action kinds, capabilities, TCC grants, field kinds — and
 * never adds one, so there is no kind an extension could declare to add one.
 */
export function unclaimedReason(type: unknown): string {
  if (type === "bridge" || type === "service") {
    return `a ${type} is code, and code from an extension runs only as a process (plan §5), which this Metistry does not load`;
  }
  if (type === "agent") return "agents are defined in .metistry/agents/ (`metistry agents define`), not as extensions";
  if (typeof type !== "string" || type === "") return "the manifest has no type — every unit says which kind it is";
  return `"${type}" is not a kind of unit an extension may declare (${Object.keys(REGISTRY_KINDS).join(", ")}) — an extension names values from Metistry's closed vocabularies and never adds one (docs/ops/extensions.md)`;
}

/**
 * Every unit in the extensions directory, each put through its kind's
 * registry beside the product units it could replace — the same registry the
 * product loads, so what this reports is what the product does.
 */
export async function describeExtensions(roots: Omit<KindRoots, "home" | "overlays"> & { extensionsDir: string; overlays?: Partial<Record<RegistryKindName, readonly string[]>> }): Promise<ExtensionEntry[]> {
  const candidates = await readCandidates({ dir: roots.extensionsDir, origin: "extension" });
  const out = new Map<string, ExtensionEntry>();
  const nameOf = (c: UnitCandidate) => c.dirName ?? c.path;
  for (const c of candidates) {
    const t = typeOf(c.input);
    if (c.unreadable !== undefined) out.set(c.path, { name: nameOf(c), path: c.path, status: "skipped", reason: `unreadable: ${c.unreadable}` });
    else if (!isRegistryKind(t)) out.set(c.path, { name: nameOf(c), path: c.path, ...(typeof t === "string" ? { type: t } : {}), status: "unclaimed", reason: unclaimedReason(t) });
  }
  for (const kind of Object.keys(REGISTRY_KINDS) as RegistryKindName[]) {
    const mine = candidates.filter((c) => c.unreadable === undefined && typeOf(c.input) === kind);
    if (mine.length === 0) continue;
    const product: UnitCandidate[] = [];
    for (const s of kindSources(kind, { ...roots, extensionsDir: undefined, overlays: roots.overlays?.[kind] })) product.push(...(await readCandidates(s)));
    const reg = buildRegistry(manifestKind(kind), [...product, ...mine]);
    for (const c of mine) {
      const unit = reg.units().find((u) => u.path === c.path);
      const skip = reg.skipped.find((s) => s.path === c.path);
      const at = { name: nameOf(c), path: c.path, type: kind };
      if (unit) out.set(c.path, { ...at, status: unit.replaced ? "overlay" : "loaded", ...(unit.replaced ? { replaced: unit.replaced.path } : {}) });
      else out.set(c.path, { ...at, status: "skipped", reason: skip?.reason ?? "not loaded" });
    }
  }
  return [...out.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// ---- code-backed kinds: a unit and the product code that runs it --------------

/** A unit of a code-backed kind (a collector, a routine), joined to the product function that runs it. */
export type CodedUnit<T, F> = RegistryUnit<T> & { run: F };

/** Why a unit has no code to run — a skip reason, never a throw. */
export interface MissingCode {
  missing: string;
}

const UNIT_NAME = /^[a-z][a-z0-9-]*$/;

/**
 * The `run` export of a product unit's module: `<base>/<name>/run.js`, where
 * `base` is the calling package's own directory (`new URL(".", import.meta.url)`
 * — its compiled `dist/`). This is how a code-backed registry replaces the
 * static import list it used to have: the manifest says the unit exists, this
 * finds its code by NAME, in the product's tree and nowhere else. A name is
 * kebab-case (the manifest schema, checked again here), so no manifest can
 * point it outside `base`; and an extension never supplies a path, only a
 * name the product already has (`extensions: overlay`).
 *
 * `run.ts` is the fallback for a package run from source (its own tests);
 * compiled output never contains one.
 */
export async function unitCode<F>(base: URL, name: string): Promise<F | MissingCode> {
  if (!UNIT_NAME.test(name)) return { missing: `"${name}" is not a unit name` };
  const file = ["run.js", "run.ts"].map((f) => new URL(`${name}/${f}`, base)).find((u) => existsSync(u));
  if (!file) return { missing: `no product code for "${name}" (expected ${new URL(`${name}/run.js`, base).pathname})` };
  let mod: { run?: unknown };
  try {
    mod = (await import(file.href)) as { run?: unknown };
  } catch (err) {
    return { missing: `its code at ${file.pathname} did not load: ${(err as Error).message}` };
  }
  return typeof mod.run === "function" ? (mod.run as F) : { missing: `${file.pathname} exports no run()` };
}

/**
 * Join a code-backed registry's units to their code. `code(name)` is always
 * asked for the unit's NAME, so an extension that replaced a product unit
 * runs the product's code under the extension's manifest; a unit with no code
 * is skipped with the reason, never fatal. Sorted by name, like the registry.
 */
export async function joinCode<T extends { name: string }, F>(
  registry: Registry<T>,
  code: (name: string) => Promise<F | MissingCode>,
): Promise<{ units: CodedUnit<T, F>[]; skipped: RegistrySkip[] }> {
  const units: CodedUnit<T, F>[] = [];
  const skipped: RegistrySkip[] = [...registry.skipped];
  for (const u of registry.units()) {
    const run = await code(u.name);
    if (run !== null && typeof run === "object" && "missing" in (run as object)) {
      skipped.push({ path: u.path, origin: u.origin, name: u.name, reason: (run as MissingCode).missing });
      continue;
    }
    units.push({ ...u, run: run as F });
  }
  return { units, skipped };
}
