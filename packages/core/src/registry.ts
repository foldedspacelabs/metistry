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
//
// `buildRegistry` is the pure part (candidates in, registry out) so the rules
// are testable without a disk; `loadRegistry` reads directories into
// candidates. Paths are the caller's — nothing here assumes where an instance
// lives (invariant 7).

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { schemaVersionIssue, validateManifest, type Manifest, type ManifestType } from "./manifest.js";

/** Where a unit came from. Product units ship in the repo (reviewed code); extensions are the owner's hand (M15). */
export const UNIT_ORIGINS = ["product", "extension"] as const;
export type UnitOrigin = (typeof UNIT_ORIGINS)[number];

/** A kind a registry holds: its `type` value and the validator for its manifest. */
export interface RegistryKind<T extends { name: string }> {
  readonly kind: string;
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
  return {
    kind: type,
    validate(input) {
      const r = validateManifest(input);
      if (!r.ok) return r;
      if (r.manifest.type !== type) return { ok: false, errors: [`type: expected ${type}, got ${r.manifest.type}`] };
      return { ok: true, manifest: r.manifest as Extract<Manifest, { type: K }> };
    },
  };
}
