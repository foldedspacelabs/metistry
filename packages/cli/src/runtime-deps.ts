// The BUNDLED RUNTIME — `<product>/runtime/` — Node, Postgres 17 + pgvector
// and git, built by `ops/release/build-runtime-deps.sh` and shipped as its
// own release asset (docs/ops/bundled-runtime.md; the decision is in
// docs/product/desktop-app-plan.md, "Bundled runtime", ratified 2026-09-09).
//
// The Mac app unpacks it inside Metistry.app; an install without the app
// gets it here, through the SAME path as the product's runtime pack:
// resolve the release, read its checksums.txt, download, verify the sha256,
// and only then unpack. A mismatch leaves whatever `runtime/` was already
// there untouched.
//
//   <product-dir>/
//     runtime/
//       .release          the product version this tree came from
//       manifest.json     versions, per-binary sha256, build date
//       node/bin/node
//       postgres/bin/…    what packages/cli/src/postgres.ts's `bundled`
//                         candidate resolves to, ahead of Homebrew
//       git/bin/git       the reconciler's git; prefixed onto its plist's PATH
//
// `runtime/` is derived, gitignored, and per os-arch. Invariant 1 holds: it
// is rebuildable from the release, so nothing here needs backing up.

import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CHECKSUMS_ASSET, downloadTo, downloadViaGh, fetchText, parseChecksums, releaseRepo, releaseTarget, resolveRelease } from "./release.js";
import { StepFailed, type StepRunner } from "./steps.js";

export const RUNTIME_DIRNAME = "runtime";
/** Written after a successful unpack: the product version whose deps pack this is. */
export const RUNTIME_RELEASE_FILE = ".release";
export const RUNTIME_MANIFEST_FILE = "manifest.json";

/** Set `METISTRY_RUNTIME_DEPS=0` to keep `up`/`update` off the network entirely (an air-gapped or Homebrew-served install). */
export function runtimeDepsEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.METISTRY_RUNTIME_DEPS !== "0";
}

export function runtimeDir(productDir: string): string {
  return join(productDir, RUNTIME_DIRNAME);
}
export function runtimeGitBin(productDir: string): string {
  return join(runtimeDir(productDir), "git", "bin");
}
export function runtimeNodeBin(productDir: string): string {
  return join(runtimeDir(productDir), "node", "bin", "node");
}
export function runtimeManifestPath(productDir: string): string {
  return join(runtimeDir(productDir), RUNTIME_MANIFEST_FILE);
}

/** The one asset name the build script, the release workflow and this module must agree on (a test asserts all three). */
export function runtimeDepsAssetName(version: string, target: string): string {
  return `metistry-runtime-deps-${version.replace(/^v/, "")}-${target}.tar.gz`;
}

/** Only darwin-arm64 has a deps pack today: it is the Mac app's runtime, and Linux hosts run the compose shape. */
export const RUNTIME_DEPS_TARGETS = new Set(["darwin-arm64"]);

export interface RuntimeManifest {
  schema?: number;
  target?: string;
  built_at?: string;
  signed?: boolean;
  components?: Record<string, { version?: string; disabled?: string }>;
  binaries?: Record<string, string>;
}

/** `runtime/manifest.json`, or undefined when there is no bundled runtime (or it is unreadable). */
export async function readRuntimeManifest(productDir: string): Promise<RuntimeManifest | undefined> {
  try {
    return JSON.parse(await readFile(runtimeManifestPath(productDir), "utf8")) as RuntimeManifest;
  } catch {
    return undefined;
  }
}

/** The product version the installed `runtime/` came from, or undefined. */
export async function installedRuntimeVersion(productDir: string): Promise<string | undefined> {
  try {
    const v = (await readFile(join(runtimeDir(productDir), RUNTIME_RELEASE_FILE), "utf8")).trim();
    return v === "" ? undefined : v;
  } catch {
    return undefined;
  }
}

/** `node 22.23.2, postgres 17.11, pgvector 0.8.6, git 2.55.0` — one line for `up`, `update` and `doctor`. */
export function describeRuntime(m: RuntimeManifest | undefined): string {
  const c = m?.components;
  if (!c) return "no runtime/manifest.json";
  return Object.entries(c)
    .map(([name, v]) => `${name} ${v?.version ?? "?"}`)
    .join(", ");
}

/** The PATH a launchd job gets by default — nothing is inherited from the operator's shell. */
export const LAUNCHD_BASE_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

/**
 * `<product>/runtime/git/bin:/usr/bin:…` when a bundled git is there, and
 * undefined when it is not — so a checkout with Xcode's git on PATH gets no
 * PATH entry in its plists at all, exactly as before.
 */
export function pathWithRuntimeGit(productDir: string, exists: (p: string) => boolean = existsSync, base = LAUNCHD_BASE_PATH): string | undefined {
  const bin = runtimeGitBin(productDir);
  return exists(join(bin, "git")) ? `${bin}:${base}` : undefined;
}

// ---- installing the pack ---------------------------------------------------------

export interface InstallRuntimeDepsOptions {
  productDir: string;
  fetchFn: typeof fetch;
  env: NodeJS.ProcessEnv;
  /** pin a release instead of taking the latest */
  version?: string | undefined;
  target?: string | undefined;
  /** re-download even when `runtime/.release` already says this version */
  force?: boolean | undefined;
}

export interface InstallRuntimeDepsResult {
  /** the product release the pack came from (or the one already installed) */
  version?: string | undefined;
  dir: string;
  installed: boolean;
  /** why nothing was installed, when `installed` is false */
  reason?: string | undefined;
}

/**
 * Resolve → download → verify → unpack into `<product>/runtime/`. Deliberately
 * forgiving about ABSENCE and unforgiving about CORRUPTION: a release with no
 * deps asset (linux-x64, or any release cut before this existed) is a note and
 * `installed: false`, while a checksum mismatch throws and leaves the existing
 * `runtime/` in place.
 */
export async function installRuntimeDeps(r: StepRunner, opts: InstallRuntimeDepsOptions): Promise<InstallRuntimeDepsResult> {
  const { productDir, fetchFn, env } = opts;
  const dir = runtimeDir(productDir);
  const target = opts.target ?? releaseTarget();
  if (!RUNTIME_DEPS_TARGETS.has(target)) {
    return { dir, installed: false, reason: `no bundled runtime is built for ${target} (only ${[...RUNTIME_DEPS_TARGETS].join(", ")})` };
  }

  const repo = releaseRepo(env);
  const rel = await resolveRelease({ fetchFn, version: opts.version, env, exec: r.exec });
  const asset = runtimeDepsAssetName(rel.version, target);
  const have = await installedRuntimeVersion(productDir);
  if (!opts.force && have === rel.version && existsSync(runtimeManifestPath(productDir))) {
    return { version: rel.version, dir, installed: false, reason: `runtime/ is already the ${rel.version} pack` };
  }

  const url = rel.assets[asset];
  if (!url) return { version: rel.version, dir, installed: false, reason: `release ${rel.tag} carries no ${asset}` };
  const sumsUrl = rel.assets[CHECKSUMS_ASSET];
  if (!sumsUrl && rel.via !== "gh") throw new StepFailed(`release ${rel.tag} has no ${CHECKSUMS_ASSET} — refusing to unpack an unverifiable runtime`);

  const staging = join(productDir, ".runtime-download");
  const tarball = join(staging, asset);
  r.action(`download ${asset} from ${rel.tag} and verify its sha256 against ${CHECKSUMS_ASSET}`);
  let sumsText: string;
  if (rel.via === "gh") {
    await downloadViaGh(r, repo, rel.tag, CHECKSUMS_ASSET, staging);
    sumsText = await readFile(join(staging, CHECKSUMS_ASSET), "utf8");
  } else {
    sumsText = await fetchText(fetchFn, sumsUrl!, CHECKSUMS_ASSET);
  }
  const want = parseChecksums(sumsText)[asset];
  if (!want) throw new StepFailed(`${CHECKSUMS_ASSET} of ${rel.tag} has no line for ${asset} — refusing to unpack an unverifiable runtime`);

  const got = rel.via === "gh" ? await downloadViaGh(r, repo, rel.tag, asset, staging) : await downloadTo(fetchFn, url, tarball);
  if (got.sha256 !== want) {
    await rm(staging, { recursive: true, force: true });
    throw new StepFailed(`${asset} failed its checksum (expected ${want}, got ${got.sha256}) — the download was discarded and ${RUNTIME_DIRNAME}/ is unchanged`);
  }
  r.note(`${asset}: ${got.bytes} bytes, sha256 ${got.sha256.slice(0, 12)}… verified`);

  // only now is the existing runtime replaced — the pack's single top-level
  // `runtime/` lands as <product>/runtime/
  await rm(dir, { recursive: true, force: true });
  await mkdir(productDir, { recursive: true });
  await r.run("tar", ["-xzf", tarball, "-C", productDir], { timeoutMs: 10 * 60_000 });
  await rm(staging, { recursive: true, force: true });
  if (!existsSync(runtimeManifestPath(productDir))) throw new StepFailed(`${asset} unpacked without a ${RUNTIME_DIRNAME}/${RUNTIME_MANIFEST_FILE} — it is not a runtime deps pack`);
  await writeFile(join(dir, RUNTIME_RELEASE_FILE), `${rel.version}\n`);
  r.note(`${RUNTIME_DIRNAME}/: ${describeRuntime(await readRuntimeManifest(productDir))}`);
  return { version: rel.version, dir, installed: true };
}
