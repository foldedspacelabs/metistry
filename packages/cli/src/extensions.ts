// `metistry extensions add | remove | list` (M15, plan §2.7).
//
// An extension is the owner's own unit of a registry kind — a provider
// template, a connection type, a target, or a replacement manifest for a
// product collector or routine — living in `.metistry/extensions/<name>/`
// and loaded through the SAME registry as the product's units (core's
// `loadKind`). `.metistry/extensions/**` is a §4.7 protected path: it
// defines what the product loads, so every write here is the owner's hand,
// through the reconciler with the owner-class bearer (protected-write.ts) —
// the console's bearer is refused on it by the reconciler's authority table.
//
// **Data only, enforced here** (§2.7, "in this program"): `add` copies one
// flat directory of manifest and documentation files, and refuses anything
// that could run — a script, an executable, a symbolic link, a nested tree.
// Code from an extension runs only as a process (§5), after this program.
//
// **Would it load?** is the one test `add` applies: the unit is put through
// its kind's registry beside the product's units and the owner's others,
// exactly as the product will load it, and a unit the registry would skip is
// refused with the registry's reason and nothing is written. That is where
// the closed vocabularies hold — a capability, a field kind, an action kind,
// a TCC grant: an extension names values from them and cannot add one,
// because the schema refuses the manifest and no registry takes a kind that
// could declare one.

import { existsSync } from "node:fs";
import { lstat, readdir, readFile, rm, rmdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  MANIFEST_FILE,
  buildRegistry,
  describeExtensions,
  extensionsDirFor,
  isRegistryKind,
  kindHome,
  kindSources,
  manifestKind,
  readCandidates,
  REGISTRY_KINDS,
  resolveInstanceLayout,
  unclaimedReason,
  type ExtensionEntry,
  type KindRoots,
  type RegistryKindName,
  type UnitCandidate,
} from "@foldedspacelabs/metistry-core";
import { realExec, type Exec } from "./exec.js";
import { deleteProtected, protectedRel, writeProtected, type ProtectedWrite } from "./protected-write.js";
import { StepFailed, StepRunner } from "./steps.js";

export const EXTENSION_VERBS = ["list", "add", "remove"] as const;
export type ExtensionVerb = (typeof EXTENSION_VERBS)[number];

export function parseExtensionVerb(v: string | undefined): ExtensionVerb | undefined {
  return (EXTENSION_VERBS as readonly string[]).includes(v ?? "list") ? ((v ?? "list") as ExtensionVerb) : undefined;
}

/** What a data-only extension may carry: its manifest, more YAML, and documentation. Nothing that runs. */
export const DATA_FILE_EXTENSIONS = [".yaml", ".yml", ".md", ".txt"] as const;

// limit: fixed — a data-only unit is a manifest and its notes; anything near this is not one, and it lands in the instance's git history
export const MAX_EXTENSION_BYTES = 1024 * 1024;

const UNIT_NAME = /^[a-z][a-z0-9-]*$/;

export interface ExtensionsOptions {
  /** the instance repo: `.metistry/extensions/` is in it */
  instanceDir: string;
  /** the product checkout (`collectors/`, `routines/`, `targets/`) — what an extension may replace */
  productDir?: string | undefined;
  /** the product's `seed/` (`compute-templates/`, `connection-types/`) */
  seedDir?: string | undefined;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  uid: number;
  exec?: Exec | undefined;
  fetchFn?: typeof fetch | undefined;
  /** print the plan and change nothing */
  dryRun?: boolean | undefined;
  out: (line: string) => void;
}

/** The registry roots this CLI reads — the product's, and the owner's legacy target overlay. */
function roots(opts: ExtensionsOptions): Omit<KindRoots, "home" | "overlays"> & { overlays: Partial<Record<RegistryKindName, readonly string[]>> } {
  return {
    ...(opts.productDir ? { productDir: opts.productDir } : {}),
    ...(opts.seedDir ? { seedDir: opts.seedDir } : {}),
    // `.metistry/targets/` predates extensions and is still the owner's (the console reads both)
    overlays: { target: [resolveInstanceLayout(opts.instanceDir).path("targetsDir")] },
  };
}

// ---- list ---------------------------------------------------------------------

export interface ExtensionsListResult {
  dir: string;
  exists: boolean;
  extensions: ExtensionEntry[];
}

export async function extensionsList(opts: ExtensionsOptions): Promise<ExtensionsListResult> {
  const dir = extensionsDirFor(opts.instanceDir);
  return { dir, exists: existsSync(dir), extensions: await describeExtensions({ ...roots(opts), extensionsDir: dir }) };
}

export function renderExtensions(r: ExtensionsListResult): string {
  const lines = [`extensions: ${r.dir}${r.exists ? "" : " (none yet)"}`, ""];
  if (r.extensions.length === 0) {
    lines.push("No extensions — every unit in force is the product's. `metistry extensions add <dir>` installs one (docs/ops/extensions.md).");
    return lines.join("\n");
  }
  const rows = r.extensions.map((e) => [
    e.name,
    e.type ?? "?",
    e.status,
    e.status === "overlay" ? `replaces ${e.replaced}` : e.reason ?? "",
  ]);
  const head = ["name", "kind", "status", ""];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((row) => (row[i] ?? "").length)));
  const line = (cells: string[]) => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i] ?? 0))).join("  ").trimEnd();
  lines.push(line(head), line(widths.map((w) => "-".repeat(w))), ...rows.map(line));
  const off = r.extensions.filter((e) => e.status === "skipped" || e.status === "unclaimed").length;
  lines.push("");
  lines.push(off > 0 ? `${off} not loaded — each says why. Fix it, or \`metistry extensions remove <name>\`.` : "Every extension is in force. `remove <name>` on an overlay restores the product's unit (Reset to Default).");
  return lines.join("\n");
}

// ---- add ----------------------------------------------------------------------

export interface ExtensionsAddResult {
  name: string;
  kind: RegistryKindName;
  /** the instance-relative directory it was written to */
  path: string;
  files: string[];
  /** hidden entries in the source that were not copied (`.DS_Store`, `.git/`) */
  ignored: string[];
  /** the product unit this replaces (D4), when it has a product unit's name */
  replaced?: string;
  deliveries: ProtectedWrite[];
}

/** One file `add` would copy, read and checked. */
interface DataFile {
  name: string;
  content: string;
}

/**
 * The source directory's files, if every one is data — or a refusal naming
 * the first that is not. Flat, regular, not executable, a data extension,
 * valid UTF-8, within the size cap. Hidden entries are left behind.
 */
async function dataOnlyFiles(source: string): Promise<{ files: DataFile[]; ignored: string[] }> {
  const st = await lstat(source).catch(() => undefined);
  if (!st) throw new StepFailed(`${source} does not exist`);
  if (st.isSymbolicLink()) throw new StepFailed(`${source} is a symbolic link — name the directory itself`);
  if (!st.isDirectory()) throw new StepFailed(`${source} is not a directory — an extension is a directory with a ${MANIFEST_FILE}`);
  const files: DataFile[] = [];
  const ignored: string[] = [];
  let total = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (const entry of (await readdir(source, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (entry.name.startsWith(".")) {
      ignored.push(entry.isDirectory() ? `${entry.name}/` : entry.name);
      continue;
    }
    const path = join(source, entry.name);
    const est = await lstat(path);
    if (est.isSymbolicLink()) throw new StepFailed(`${entry.name} is a symbolic link — an extension carries its own files, never a link to somewhere else`);
    if (est.isDirectory()) throw new StepFailed(`${entry.name}/ is a directory — a data-only extension is one flat directory (code from an extension runs only as a process, plan §5)`);
    if (!est.isFile()) throw new StepFailed(`${entry.name} is not a regular file`);
    if ((est.mode & 0o111) !== 0) throw new StepFailed(`${entry.name} is executable — a data-only extension carries nothing that runs (plan §2.7)`);
    if (!DATA_FILE_EXTENSIONS.some((ext) => entry.name.toLowerCase().endsWith(ext))) {
      throw new StepFailed(`${entry.name} is not data — an extension carries ${DATA_FILE_EXTENSIONS.join(", ")} files only; code from an extension runs only as a process (plan §5), which this Metistry does not load`);
    }
    total += est.size;
    if (total > MAX_EXTENSION_BYTES) throw new StepFailed(`${source} is over ${MAX_EXTENSION_BYTES} bytes — a data-only extension is a manifest and its notes`);
    let content: string;
    try {
      content = decoder.decode(await readFile(path));
    } catch {
      throw new StepFailed(`${entry.name} is not UTF-8 text`);
    }
    files.push({ name: entry.name, content });
  }
  if (!files.some((f) => f.name === MANIFEST_FILE)) throw new StepFailed(`${source} has no ${MANIFEST_FILE} — an extension is a directory with a manifest (invariant 5)`);
  return { files, ignored };
}

export async function extensionsAdd(opts: ExtensionsOptions & { source: string }): Promise<ExtensionsAddResult> {
  const source = resolve(opts.source);
  const { files, ignored } = await dataOnlyFiles(source);
  const manifestText = files.find((f) => f.name === MANIFEST_FILE)!.content;
  let input: unknown;
  try {
    input = parseYaml(manifestText);
  } catch (err) {
    throw new StepFailed(`${join(source, MANIFEST_FILE)} is not YAML — ${(err as Error).message.split("\n")[0]}`);
  }
  const type = input !== null && typeof input === "object" && !Array.isArray(input) ? (input as { type?: unknown }).type : undefined;
  if (!isRegistryKind(type)) throw new StepFailed(`refused: ${unclaimedReason(type)} — nothing was written`);
  const name = (input as { name?: unknown }).name;
  if (typeof name !== "string" || !UNIT_NAME.test(name)) {
    throw new StepFailed(`refused: the manifest's name ${JSON.stringify(name ?? null)} is not a unit name (lowercase kebab-case) — its directory is named for it — nothing was written`);
  }

  const extensionsDir = extensionsDirFor(opts.instanceDir);
  const dest = join(extensionsDir, name);
  if (existsSync(dest)) throw new StepFailed(`an extension named ${name} is already installed at ${dest} — \`metistry extensions remove ${name}\` first`);

  // Would it load? Its kind's registry, beside the product's units and the
  // owner's others, with this unit where it is about to be written.
  const r0 = roots(opts);
  const kindRoots: KindRoots = { ...r0, overlays: r0.overlays[type] };
  if (REGISTRY_KINDS[type].extension === "overlay" && kindHome(type, kindRoots) === undefined) {
    throw new StepFailed(`refused: a ${type} extension replaces a product ${type}, and there is no product checkout to find ${name} in — pass --product-dir or set METISTRY_PRODUCT_DIR — nothing was written`);
  }
  const candidates: UnitCandidate[] = [];
  for (const s of kindSources(type, kindRoots)) candidates.push(...(await readCandidates(s)));
  candidates.push(...(await readCandidates({ dir: extensionsDir, origin: "extension" })));
  const at = join(dest, MANIFEST_FILE);
  candidates.push({ path: at, origin: "extension", dirName: name, input });
  const reg = buildRegistry(manifestKind(type), candidates);
  const unit = reg.units().find((u) => u.path === at);
  if (!unit) {
    const why = reg.skipped.find((s) => s.path === at)?.reason ?? "its registry did not load it";
    throw new StepFailed(`refused: ${why} — nothing was written`);
  }

  const r = new StepRunner({ dryRun: opts.dryRun === true, out: opts.out, exec: opts.exec ?? realExec, env: opts.env });
  const rel = `${protectedRel(opts.instanceDir, "extensionsDir")}/${name}`;
  const deliveries: ProtectedWrite[] = [];
  for (const f of files) {
    deliveries.push(
      await writeProtected(r, `${rel}/${f.name}`, f.content, `metistry extensions add ${name} (${type})`, {
        env: opts.env,
        platform: opts.platform,
        uid: opts.uid,
        fetchFn: opts.fetchFn ?? fetch,
        instanceDir: opts.instanceDir,
      }),
    );
  }
  return { name, kind: type, path: rel, files: files.map((f) => f.name), ignored, ...(unit.replaced ? { replaced: unit.replaced.path } : {}), deliveries };
}

// ---- remove -------------------------------------------------------------------

export interface ExtensionsRemoveResult {
  name: string;
  kind?: string;
  path: string;
  files: string[];
  /** the product unit back in force now its overlay is gone (Reset to Default) */
  restored?: string;
  deliveries: ProtectedWrite[];
}

/** Every file under `dir`, instance-relative to `dir`, depth first. Links are files here: removed, never followed. */
async function filesUnder(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await filesUnder(join(dir, entry.name), rel)));
    else out.push(rel);
  }
  return out;
}

/**
 * Remove one extension. What referred to it is not touched: a referrer turns
 * `absent` naming the missing unit, and nothing else is deleted (plan §2.7).
 * An overlay's removal is Reset to Default — the product's unit is back.
 */
export async function extensionsRemove(opts: ExtensionsOptions & { name: string }): Promise<ExtensionsRemoveResult> {
  if (!UNIT_NAME.test(opts.name)) throw new StepFailed(`${JSON.stringify(opts.name)} is not an extension name (lowercase kebab-case, as \`metistry extensions list\` shows it)`);
  const extensionsDir = extensionsDirFor(opts.instanceDir);
  const dir = join(extensionsDir, opts.name);
  const st = await lstat(dir).catch(() => undefined);
  if (!st) throw new StepFailed(`no extension named ${opts.name} in ${extensionsDir} (\`metistry extensions list\`)`);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new StepFailed(`${dir} is not an extension directory — remove it by hand`);

  const entry = (await describeExtensions({ ...roots(opts), extensionsDir })).find((e) => e.name === opts.name);
  const files = await filesUnder(dir);
  const r = new StepRunner({ dryRun: opts.dryRun === true, out: opts.out, exec: opts.exec ?? realExec, env: opts.env });
  const rel = `${protectedRel(opts.instanceDir, "extensionsDir")}/${opts.name}`;
  const deliveries: ProtectedWrite[] = [];
  for (const f of files) {
    deliveries.push(
      await deleteProtected(r, `${rel}/${f}`, `metistry extensions remove ${opts.name}`, {
        env: opts.env,
        platform: opts.platform,
        uid: opts.uid,
        fetchFn: opts.fetchFn ?? fetch,
        instanceDir: opts.instanceDir,
      }),
    );
  }
  // git keeps no empty directory, so neither does this: the direct path
  // removes the tree, the bridge path the directory the deletes emptied
  if (!r.dryRun) {
    if (deliveries.every((d) => d.how === "direct")) await rm(dir, { recursive: true, force: true });
    else await rmdir(dir).catch(() => undefined);
  }
  return {
    name: opts.name,
    ...(entry?.type ? { kind: entry.type } : {}),
    path: rel,
    files,
    ...(entry?.status === "overlay" && entry.replaced ? { restored: entry.replaced } : {}),
    deliveries,
  };
}
