// `metistry runtime install --from <bundle Resources/metistry> [--to <dir>]`
// — the missing half of "the app as the installer"
// (docs/product/desktop-app-plan.md).
//
// THE DECISION this settles: a signed bundle's
// `Metistry.app/Contents/Resources/metistry/` is a SEED, not the product
// dir. `Resources` cannot be written to (the signature seals it), and
// `metistry update --channel release` must write `releases/<version>/`,
// flip `current` and unpack a new `runtime/`. So on first run the seed is
// COPIED to a writable product dir:
//
//   ~/Library/Application Support/Metistry/product/
//     releases/<version>/     the runtime pack, exactly as `update` unpacks it
//     current -> releases/<version>
//     runtime/                Node, Postgres + pgvector, git
//     .metistry-install.json  what was copied, and from where
//
// and every plist `metistry up` writes points there. `update` then works
// byte-for-byte as it does on a checkout install, and Sparkle updating the
// app ships a NEWER SEED that this verb copies forward on the next launch.
//
// The rejected alternative: Sparkle-only updates, with `metistry update` a
// no-op for app installs. It fails on three counts — the product could only
// move when the whole app did (a migration fix would need a notarized
// build), the terminal and app paths would stop being the same tested path
// (§4.20), and `releases/`/`current`/`--rollback` would exist for checkout
// installs only.
//
// This is a CLI verb rather than app code for the same reason every other
// first-run step is: the app is a front end for the CLI, never a second
// implementation. The terminal path is identical.
//
// IDEMPOTENT, and verified. The seed's `releases/<v>/metistry-runtime.json`
// (written by ops/release/pack-runtime.sh) and `runtime/manifest.json`
// (build-runtime-deps.sh) are read before anything is copied: a seed
// missing either is refused rather than half-copied. Their sha256s are
// recorded, and a second run whose seed hashes to the same thing does
// nothing at all.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, cp, lstat, mkdir, readdir, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CURRENT_LINK, RELEASES_DIRNAME, RUNTIME_PACK_MANIFEST, releaseDir, releasesDir, switchCurrent } from "./release.js";
import { RUNTIME_DIRNAME, RUNTIME_MANIFEST_FILE, RUNTIME_RELEASE_FILE, runtimeDir, runtimeManifestPath } from "./runtime-deps.js";
import { StepFailed, type StepRunner } from "./steps.js";

/** The receipt at the product dir's root: what was installed, from where, and the two manifest digests that make a re-run a no-op. */
export const INSTALL_RECEIPT = ".metistry-install.json";

/** Where a bundled install's WRITABLE product dir lives (the decision above). `METISTRY_PRODUCT_DIR` still overrides everything. */
export function defaultProductDir(home: string): string {
  return join(home, "Library", "Application Support", "Metistry", "product");
}

/** `Metistry.app/Contents/Resources/metistry` — the seed inside the bundle. */
export const BUNDLE_SEED_REL = join("Contents", "Resources", "metistry");

/** Given `/Applications/Metistry.app`, the seed inside it; given the seed itself, itself. So `--from` accepts either. */
export function seedDirOf(from: string): string {
  const inside = join(from, BUNDLE_SEED_REL);
  return existsSync(inside) ? inside : from;
}

export interface SeedDescription {
  dir: string;
  /** the version `current` points at inside the seed */
  version: string;
  releaseDir: string;
  /** sha256 of `releases/<version>/metistry-runtime.json` — the pack's own identity (version, target, commit, built_at) */
  releaseManifestSha256: string;
  /** the commit pack-runtime.sh built from, when the pack records one */
  commit?: string | undefined;
  /** the bundled runtime, when the seed carries one (a --runtime-only bundle need not) */
  runtime?: { dir: string; sha256: string; target?: string | undefined; components: string } | undefined;
}

async function sha256Of(file: string): Promise<string> {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

/**
 * Give the owner write on every file and directory of a freshly copied
 * tree. A signed bundle's `Resources` are read-only and `cp` preserves
 * modes, so without this the product dir inherits 0555 DIRECTORIES and
 * `metistry update` cannot delete a release to install the next one over
 * it — the exact failure this whole verb exists to avoid. Done in-process
 * rather than by shelling out to `chmod -R`, so it is part of the
 * operation and the tests can prove it.
 */
export async function makeWritable(path: string): Promise<number> {
  const s = await lstat(path);
  if (s.isSymbolicLink()) return 0;
  let n = 0;
  if (s.isDirectory()) {
    // the directory itself first: a 0555 directory cannot be traversed for writing
    await chmod(path, s.mode | 0o700);
    n++;
    for (const name of await readdir(path)) n += await makeWritable(join(path, name));
    return n;
  }
  await chmod(path, s.mode | 0o200);
  return n + 1;
}

/** The version a seed's `current` symlink names; a seed with no `current` is not one this verb will copy. */
export async function seedVersion(seedDir: string): Promise<string | undefined> {
  try {
    const target = await readlink(join(seedDir, CURRENT_LINK));
    const name = target.replace(/\/+$/, "").split("/").pop();
    return name && name !== CURRENT_LINK ? name : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read the seed and refuse anything that is not one — BEFORE a byte is
 * copied, so a half-installed product dir is not a state this verb can
 * produce. The pack manifest is the authority on the version: a `current`
 * symlink naming a directory whose `metistry-runtime.json` says something
 * else is a hand-assembled bundle, not a release.
 */
export async function describeSeed(from: string): Promise<SeedDescription> {
  const dir = seedDirOf(from);
  if (!existsSync(dir)) throw new StepFailed(`${from} does not exist — --from wants a Metistry.app or its Contents/Resources/metistry`);
  const version = await seedVersion(dir);
  if (!version) {
    throw new StepFailed(
      `${dir} has no ${CURRENT_LINK} symlink — it is not a bundled product seed (a signed bundle's ${BUNDLE_SEED_REL} carries ${RELEASES_DIRNAME}/<version>/ and ${CURRENT_LINK}; ops/release/build-app.sh builds it)`,
    );
  }
  const rel = releaseDir(dir, version);
  const manifest = join(rel, RUNTIME_PACK_MANIFEST);
  if (!existsSync(manifest)) throw new StepFailed(`${manifest} is missing — refusing to install a runtime pack that carries no ${RUNTIME_PACK_MANIFEST} to verify it against`);
  let packed: { version?: unknown; commit?: unknown; target?: unknown };
  try {
    packed = JSON.parse(await readFile(manifest, "utf8")) as typeof packed;
  } catch (err) {
    throw new StepFailed(`${manifest} is not JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  if (typeof packed.version !== "string" || packed.version.replace(/^v/, "") !== version) {
    throw new StepFailed(`${manifest} says version ${JSON.stringify(packed.version)} but ${CURRENT_LINK} points at ${RELEASES_DIRNAME}/${version} — the bundle was assembled by hand`);
  }
  if (!existsSync(join(rel, "packages", "cli", "dist", "main.js"))) {
    throw new StepFailed(`${rel} has no packages/cli/dist/main.js — the seed carries no CLI, so nothing installed from it could run`);
  }

  const rtDir = join(dir, RUNTIME_DIRNAME);
  let runtime: SeedDescription["runtime"];
  if (existsSync(rtDir)) {
    const rtManifest = runtimeManifestPath(dir);
    if (!existsSync(rtManifest)) throw new StepFailed(`${rtDir} exists but ${rtManifest} does not — refusing to install an unverifiable bundled runtime`);
    const parsed = JSON.parse(await readFile(rtManifest, "utf8")) as { target?: unknown; components?: Record<string, { version?: string }> };
    runtime = {
      dir: rtDir,
      sha256: await sha256Of(rtManifest),
      target: typeof parsed.target === "string" ? parsed.target : undefined,
      components: Object.entries(parsed.components ?? {})
        .map(([n, v]) => `${n} ${v?.version ?? "?"}`)
        .join(", "),
    };
  }

  return {
    dir,
    version,
    releaseDir: rel,
    releaseManifestSha256: await sha256Of(manifest),
    ...(typeof packed.commit === "string" && packed.commit !== "" ? { commit: packed.commit } : {}),
    ...(runtime ? { runtime } : {}),
  };
}

export interface InstallReceipt {
  schema: 1;
  installed_at: string;
  /** the bundle seed this came out of */
  from: string;
  version: string;
  release: { manifest_sha256: string; commit?: string };
  runtime?: { manifest_sha256: string; target?: string };
}

export function receiptPath(productDir: string): string {
  return join(productDir, INSTALL_RECEIPT);
}

export async function readReceipt(productDir: string): Promise<InstallReceipt | undefined> {
  try {
    return JSON.parse(await readFile(receiptPath(productDir), "utf8")) as InstallReceipt;
  } catch {
    return undefined;
  }
}

/**
 * Nothing to do when the receipt says this exact seed is already installed
 * AND the tree it describes is still there. Both halves matter: a receipt
 * alone would skip re-installing over a product dir someone deleted half of.
 */
export function upToDate(receipt: InstallReceipt | undefined, seed: SeedDescription, productDir: string): boolean {
  if (!receipt || receipt.version !== seed.version) return false;
  if (receipt.release.manifest_sha256 !== seed.releaseManifestSha256) return false;
  if ((receipt.runtime?.manifest_sha256 ?? undefined) !== seed.runtime?.sha256) return false;
  if (!existsSync(releaseDir(productDir, seed.version))) return false;
  if (!existsSync(join(productDir, CURRENT_LINK))) return false;
  if (seed.runtime && !existsSync(runtimeManifestPath(productDir))) return false;
  return true;
}

export interface RuntimeInstallOptions {
  /** `--from`: a Metistry.app, or its Contents/Resources/metistry */
  from: string;
  /** `--to`: the writable product dir (default: ~/Library/Application Support/Metistry/product) */
  to?: string | undefined;
  home?: string | undefined;
  /** re-copy even when the receipt says this seed is already installed */
  force?: boolean | undefined;
  now?: Date | undefined;
}

export interface RuntimeInstallResult {
  productDir: string;
  seed: SeedDescription;
  version: string;
  /** false when the same seed was already installed — the idempotent no-op */
  installed: boolean;
  reason?: string | undefined;
}

/**
 * Copy the seed into a writable product dir. Order matters: the release
 * tree, then `runtime/`, then `current`, then the receipt LAST — so a
 * receipt exists only once everything it claims does, and an interrupted
 * run is simply re-done rather than mistaken for a finished one.
 */
export async function installRuntime(r: StepRunner, opts: RuntimeInstallOptions): Promise<RuntimeInstallResult> {
  const home = opts.home ?? r.env.HOME ?? "";
  if (!opts.to && !home) throw new StepFailed("HOME is unset and no --to was given — cannot find ~/Library/Application Support");
  const productDir = (opts.to ?? defaultProductDir(home)).replace(/\/+$/, "");
  const seed = await describeSeed(opts.from);

  r.note(`seed: ${seed.dir} — ${seed.version}${seed.commit ? ` (${seed.commit.slice(0, 7)})` : ""}, pack manifest sha256 ${seed.releaseManifestSha256.slice(0, 12)}…`);
  r.note(
    seed.runtime
      ? `bundled runtime: ${seed.runtime.components || "no components recorded"}${seed.runtime.target ? ` (${seed.runtime.target})` : ""}, manifest sha256 ${seed.runtime.sha256.slice(0, 12)}…`
      : `no ${RUNTIME_DIRNAME}/ in the seed — this install will fall back to METISTRY_PG_BIN or Homebrew for Postgres (docs/ops/deployment-shapes.md)`,
  );
  r.note(`product dir: ${productDir}`);

  const receipt = await readReceipt(productDir);
  if (!opts.force && upToDate(receipt, seed, productDir)) {
    const reason = `${productDir} already holds this seed (${seed.version}, same pack and runtime manifests) — nothing copied`;
    r.note(reason);
    return { productDir, seed, version: seed.version, installed: false, reason };
  }
  if (receipt && receipt.version !== seed.version) r.note(`replacing ${receipt.version} (installed ${receipt.installed_at}) — the older release tree is left in place for --rollback`);

  const dest = releaseDir(productDir, seed.version);
  if (!r.action(`copy ${seed.releaseDir} -> ${dest}${seed.runtime ? `, ${seed.runtime.dir} -> ${runtimeDir(productDir)}` : ""}, point ${CURRENT_LINK} at ${RELEASES_DIRNAME}/${seed.version}, write ${INSTALL_RECEIPT}`)) {
    return { productDir, seed, version: seed.version, installed: false, reason: "dry run" };
  }

  await mkdir(releasesDir(productDir), { recursive: true });
  // the bundle's copy is read-only (it came out of a signed .app), so the
  // destination is dereferenced and made writable — `update` has to be able
  // to delete this tree to install the next release over it
  await rm(dest, { recursive: true, force: true });
  // verbatimSymlinks, NOT dereference: the pack's node_modules is pnpm's, a
  // tree of RELATIVE symlinks into `.pnpm/`. Dereferencing turns
  // `apps/console/node_modules/<dep>` into a real directory and severs it
  // from `.pnpm/<dep>@v/node_modules/`, where that dep's own dependencies
  // live — the install then dies at the first `require` with
  // ERR_MODULE_NOT_FOUND. `metistry update` unpacks a tarball, which
  // preserves links; this copy has to do the same thing.
  await cp(seed.releaseDir, dest, { recursive: true, verbatimSymlinks: true });
  r.note(`${dest}: made writable (${await makeWritable(dest)} paths) — a signed bundle's Resources are read-only and the product dir must not be`);

  if (seed.runtime) {
    const rt = runtimeDir(productDir);
    await rm(rt, { recursive: true, force: true });
    // NOT dereferenced: runtime/postgres/lib is a symlink farm (libpq's
    // versioned names), and flattening it breaks the install-name rewrites
    await cp(seed.runtime.dir, rt, { recursive: true, verbatimSymlinks: true });
    await makeWritable(rt);
    // `runtime/.release` is what runtime-deps.ts compares a release against,
    // so a bundled runtime and a downloaded one are indistinguishable to it
    await writeFile(join(rt, RUNTIME_RELEASE_FILE), `${seed.version}\n`);
    if (!existsSync(join(rt, RUNTIME_MANIFEST_FILE))) throw new StepFailed(`${join(rt, RUNTIME_MANIFEST_FILE)} did not survive the copy — the bundled runtime is not installed`);
  }

  await switchCurrent(productDir, seed.version);

  const out: InstallReceipt = {
    schema: 1,
    installed_at: (opts.now ?? new Date()).toISOString(),
    from: seed.dir,
    version: seed.version,
    release: { manifest_sha256: seed.releaseManifestSha256, ...(seed.commit ? { commit: seed.commit } : {}) },
    ...(seed.runtime ? { runtime: { manifest_sha256: seed.runtime.sha256, ...(seed.runtime.target ? { target: seed.runtime.target } : {}) } } : {}),
  };
  await writeFile(receiptPath(productDir), `${JSON.stringify(out, null, 2)}\n`);
  r.note(`installed: ${productDir}/${CURRENT_LINK} -> ${RELEASES_DIRNAME}/${seed.version}; receipt ${INSTALL_RECEIPT}`);
  r.note(`next: METISTRY_PRODUCT_DIR=${productDir} metistry up --instance <dir>   (and \`metistry update --channel release\` updates the product from here on)`);
  return { productDir, seed, version: seed.version, installed: true };
}

/** Belt and braces for a caller that only wants the path: the same default the verb writes to. */
export async function currentSymlinkTarget(productDir: string): Promise<string | undefined> {
  try {
    return await readlink(join(productDir, CURRENT_LINK));
  } catch {
    return undefined;
  }
}

/** `switchCurrent` is release.ts's; re-exported so the app's docs have one name to point at. */
export { switchCurrent };
