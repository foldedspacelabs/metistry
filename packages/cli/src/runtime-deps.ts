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
//       remote/<tool>/    a PROVIDER TOOL PACK (plan §2.23, X-112): tailscale,
//                         cloudflared or zrok — its own release asset, fetched
//                         ONLY when the owner picks that provider, through the
//                         same verify-then-unpack path (below, "provider tool
//                         packs"); never in the DMG or the deps pack
//
// `runtime/` is derived, gitignored, and per os-arch. Invariant 1 holds: it
// is rebuildable from the release, so nothing here needs backing up.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CHECKSUMS_ASSET, compareVersions, downloadAsset, parseChecksums, releaseRepo, releaseTarget, resolveRelease, type ResolvedRelease } from "./release.js";
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

// ---- the verified download ----------------------------------------------------------
// The one path every pack takes — the runtime deps pack and each provider
// tool pack: the release's checksums.txt first, then the asset, and nothing
// is trusted until the two agree. A mismatch discards the download, so what
// was already on disk is never touched.

/**
 * Download `<asset>` of `rel` into `staging` and verify it against the
 * release's `checksums.txt`. Returns the verified file's path; throws
 * StepFailed (with the staging dir removed) when the release has no
 * checksums, no line for the asset, or the bytes do not match.
 * `unchangedWhat` names what the caller leaves alone, for the message.
 */
export async function downloadVerifiedAsset(
  r: StepRunner,
  opts: { fetchFn: typeof fetch; env: NodeJS.ProcessEnv; rel: ResolvedRelease; asset: string; staging: string; unchangedWhat: string },
): Promise<{ path: string; bytes: number; sha256: string }> {
  const { fetchFn, env, rel, asset, staging } = opts;
  const repo = releaseRepo(env);
  const sumsUrl = rel.assets[CHECKSUMS_ASSET];
  if (!sumsUrl && rel.via !== "gh") throw new StepFailed(`release ${rel.tag} has no ${CHECKSUMS_ASSET} — refusing to unpack an unverifiable ${asset}`);
  r.action(`download ${asset} from ${rel.tag} and verify its sha256 against ${CHECKSUMS_ASSET}`);
  await downloadAsset(r, { fetchFn, repo, rel, name: CHECKSUMS_ASSET, dir: staging, env });
  const want = parseChecksums(await readFile(join(staging, CHECKSUMS_ASSET), "utf8"))[asset];
  if (!want) {
    await rm(staging, { recursive: true, force: true });
    throw new StepFailed(`${CHECKSUMS_ASSET} of ${rel.tag} has no line for ${asset} — refusing to unpack an unverifiable ${asset}`);
  }
  const got = await downloadAsset(r, { fetchFn, repo, rel, name: asset, dir: staging, env });
  if (got.sha256 !== want) {
    await rm(staging, { recursive: true, force: true });
    throw new StepFailed(`${asset} failed its checksum (expected ${want}, got ${got.sha256}) — the download was discarded and ${opts.unchangedWhat} is unchanged`);
  }
  r.note(`${asset}: ${got.bytes} bytes, sha256 ${got.sha256.slice(0, 12)}… verified`);
  return { path: join(staging, asset), ...got };
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

  const rel = await resolveRelease({ fetchFn, version: opts.version, env, exec: r.exec });
  const asset = runtimeDepsAssetName(rel.version, target);
  const have = await installedRuntimeVersion(productDir);
  if (!opts.force && have === rel.version && existsSync(runtimeManifestPath(productDir))) {
    return { version: rel.version, dir, installed: false, reason: `runtime/ is already the ${rel.version} pack` };
  }

  if (!rel.assets[asset]) return { version: rel.version, dir, installed: false, reason: `release ${rel.tag} carries no ${asset}` };

  const staging = join(productDir, ".runtime-download");
  const got = await downloadVerifiedAsset(r, { fetchFn, env, rel, asset, staging, unchangedWhat: `${RUNTIME_DIRNAME}/` });

  // only now is the existing runtime replaced — the pack's single top-level
  // `runtime/` lands as <product>/runtime/. The provider tool packs under
  // runtime/remote/ are NOT part of this asset and are carried across.
  const remote = join(dir, REMOTE_DIRNAME);
  const keep = join(productDir, ".runtime-remote-keep");
  await rm(keep, { recursive: true, force: true });
  if (existsSync(remote)) await rename(remote, keep);
  await rm(dir, { recursive: true, force: true });
  await mkdir(productDir, { recursive: true });
  await r.run("tar", ["-xzf", got.path, "-C", productDir], { timeoutMs: 10 * 60_000 });
  await rm(staging, { recursive: true, force: true });
  if (!existsSync(runtimeManifestPath(productDir))) {
    if (existsSync(keep)) {
      await mkdir(dir, { recursive: true });
      await rename(keep, remote);
    }
    throw new StepFailed(`${asset} unpacked without a ${RUNTIME_DIRNAME}/${RUNTIME_MANIFEST_FILE} — it is not a runtime deps pack`);
  }
  if (existsSync(keep)) {
    await rm(remote, { recursive: true, force: true });
    await rename(keep, remote);
  }
  await writeFile(join(dir, RUNTIME_RELEASE_FILE), `${rel.version}\n`);
  r.note(`${RUNTIME_DIRNAME}/: ${describeRuntime(await readRuntimeManifest(productDir))}`);
  return { version: rel.version, dir, installed: true };
}

// ---- provider tool packs: runtime/remote/<tool>/ ------------------------------------
// Plan §2.23 (ruled 2026-09-30, "Metistry may bundle or install provider
// tools"), X-112. One pack per tool, ONE RELEASE ASSET EACH, built by
// ops/release/build-remote-packs.sh and signed with the runtime pack's rule.
// Three things hold:
//
//   fetched on choice   `metistry remote set <provider>` fetches the pack its
//                       provider needs — through an adapter's `configure`,
//                       via remote/packs.ts. Nothing here runs at install,
//                       and `update` only moves forward a pack that is
//                       ALREADY here (updateRemotePacks). A provider the
//                       owner did not pick fetches nothing.
//   verified, or nothing  the same checksums.txt rule as every pack, and then
//                       the pack's OWN manifest: it names the tool, and every
//                       Mach-O it lists hashes to what it says. A mismatch of
//                       either kind — a tampered tarball, a wrong checksum —
//                       leaves runtime/remote/ exactly as it was: the pack is
//                       unpacked beside the tree and swapped in only once it
//                       has passed.
//   never backwards     a pack from an OLDER release than the one installed
//                       is refused unless forced: a pinned old release could
//                       carry a tool with a published flaw.
//
// `METISTRY_RUNTIME_DEPS=0` keeps this off the network too; the adapter then
// names the manual install (remote/packs.ts).

export const REMOTE_DIRNAME = "remote";
/** The tools a pack exists for, in the chooser's order of their providers. ngrok cannot be bundled (its terms); port forwarding is in-process. */
export const REMOTE_TOOLS = ["tailscale", "cloudflared", "zrok"] as const;
export type RemoteTool = (typeof REMOTE_TOOLS)[number];

export function isRemoteTool(v: string): v is RemoteTool {
  return (REMOTE_TOOLS as readonly string[]).includes(v);
}

/** `<product>/runtime/remote` — every tool pack lives under it. */
export function remoteDir(productDir: string): string {
  return join(runtimeDir(productDir), REMOTE_DIRNAME);
}
/** `<product>/runtime/remote/<tool>` */
export function remoteToolDir(productDir: string, tool: RemoteTool): string {
  return join(remoteDir(productDir), tool);
}
export function remotePackManifestPath(productDir: string, tool: RemoteTool): string {
  return join(remoteToolDir(productDir, tool), RUNTIME_MANIFEST_FILE);
}

/** The one asset name the build script, the release workflow and this module must agree on (a test asserts all three). */
export function remotePackAssetName(tool: RemoteTool, version: string, target: string): string {
  return `metistry-remote-${tool}-${version.replace(/^v/, "")}-${target}.tar.gz`;
}

/** `remote/<tool>/manifest.json`, as ops/release/build-remote-packs.sh writes it. */
export interface RemotePackManifest {
  schema?: number;
  tool?: string;
  /** the TOOL's version (1.104.1), not the product's */
  version?: string;
  target?: string;
  built_at?: string;
  signed?: boolean;
  origin?: string;
  source_sha256?: string;
  license?: string;
  /** relative path → sha256, one per Mach-O */
  binaries?: Record<string, string>;
}

export async function readRemotePackManifest(productDir: string, tool: RemoteTool): Promise<RemotePackManifest | undefined> {
  try {
    return JSON.parse(await readFile(remotePackManifestPath(productDir, tool), "utf8")) as RemotePackManifest;
  } catch {
    return undefined;
  }
}

/** The product release a tool's pack came from (`runtime/remote/<tool>/.release`), or undefined when none is installed. */
export async function installedRemotePackRelease(productDir: string, tool: RemoteTool): Promise<string | undefined> {
  try {
    const v = (await readFile(join(remoteToolDir(productDir, tool), RUNTIME_RELEASE_FILE), "utf8")).trim();
    return v === "" ? undefined : v;
  } catch {
    return undefined;
  }
}

export interface InstalledRemotePack {
  tool: RemoteTool;
  dir: string;
  /** the product release it came from */
  release: string | undefined;
  manifest: RemotePackManifest;
}

/** Every tool pack present under runtime/remote/ (a directory with a readable manifest), in REMOTE_TOOLS order. */
export async function installedRemotePacks(productDir: string): Promise<InstalledRemotePack[]> {
  const out: InstalledRemotePack[] = [];
  for (const tool of REMOTE_TOOLS) {
    const manifest = await readRemotePackManifest(productDir, tool);
    if (!manifest) continue;
    out.push({ tool, dir: remoteToolDir(productDir, tool), release: await installedRemotePackRelease(productDir, tool), manifest });
  }
  return out;
}

export interface InstallRemotePackOptions {
  productDir: string;
  tool: RemoteTool;
  fetchFn: typeof fetch;
  env: NodeJS.ProcessEnv;
  /** pin a release instead of taking the latest */
  version?: string | undefined;
  target?: string | undefined;
  /** re-download even when the pack is already this release's — and the one way past the no-downgrade rule */
  force?: boolean | undefined;
}

export type RemotePackSkipReason = "off-network" | "no-target" | "already" | "no-asset" | "downgrade";

export interface InstallRemotePackResult {
  tool: RemoteTool;
  dir: string;
  /** the product release the pack came from (or the one already installed) */
  version?: string | undefined;
  installed: boolean;
  /** why nothing was installed, when `installed` is false — and which kind of nothing */
  reason?: string | undefined;
  skipped?: RemotePackSkipReason | undefined;
}

/**
 * Walk an unpacked pack and prove it is what its manifest says: exactly one
 * top-level `remote/<tool>/`, a manifest naming that tool, and every binary
 * the manifest lists present and hashing to its recorded sha256. Returns the
 * refusal, or undefined when it holds.
 */
export async function verifyUnpackedRemotePack(unpacked: string, tool: RemoteTool): Promise<string | undefined> {
  const top = await readdir(unpacked).catch(() => [] as string[]);
  if (top.length !== 1 || top[0] !== REMOTE_DIRNAME) return `the tarball's top level is ${top.length ? top.join(", ") : "empty"}, not a single ${REMOTE_DIRNAME}/`;
  const tools = await readdir(join(unpacked, REMOTE_DIRNAME));
  if (tools.length !== 1 || tools[0] !== tool) return `the tarball holds ${REMOTE_DIRNAME}/${tools.join(", ")}, not ${REMOTE_DIRNAME}/${tool} alone`;
  const dir = join(unpacked, REMOTE_DIRNAME, tool);
  let m: RemotePackManifest;
  try {
    m = JSON.parse(await readFile(join(dir, RUNTIME_MANIFEST_FILE), "utf8")) as RemotePackManifest;
  } catch {
    return `no readable ${REMOTE_DIRNAME}/${tool}/${RUNTIME_MANIFEST_FILE} — it is not a provider tool pack`;
  }
  if (m.tool !== tool) return `its manifest names ${m.tool ?? "no tool"}, not ${tool}`;
  if (!m.binaries || Object.keys(m.binaries).length === 0) return `its manifest lists no binaries`;
  for (const [rel, want] of Object.entries(m.binaries)) {
    if (rel.startsWith("/") || rel.split("/").includes("..")) return `its manifest names a binary outside the pack (${rel})`;
    let got: string;
    try {
      got = createHash("sha256").update(await readFile(join(dir, rel))).digest("hex");
    } catch {
      return `${rel} is listed in its manifest but missing from the pack`;
    }
    if (got !== want.toLowerCase()) return `${rel} does not hash to what the manifest records (expected ${want.slice(0, 12)}…, got ${got.slice(0, 12)}…) — the pack was tampered with`;
  }
  return undefined;
}

/**
 * Resolve → download → verify against checksums.txt → unpack BESIDE the tree
 * → verify the pack's own manifest → swap into `runtime/remote/<tool>/`.
 * Absence is a note (`installed: false` with its reason); corruption throws
 * and leaves `runtime/remote/` exactly as it was.
 */
export async function installRemotePack(r: StepRunner, opts: InstallRemotePackOptions): Promise<InstallRemotePackResult> {
  const { productDir, tool, fetchFn, env } = opts;
  const dir = remoteToolDir(productDir, tool);
  if (!runtimeDepsEnabled(env)) {
    return { tool, dir, installed: false, skipped: "off-network", reason: `METISTRY_RUNTIME_DEPS=0 keeps Metistry off the network, so the ${tool} pack is not fetched` };
  }
  const target = opts.target ?? releaseTarget();
  if (!RUNTIME_DEPS_TARGETS.has(target)) {
    return { tool, dir, installed: false, skipped: "no-target", reason: `no ${tool} pack is built for ${target} (only ${[...RUNTIME_DEPS_TARGETS].join(", ")})` };
  }

  const rel = await resolveRelease({ fetchFn, version: opts.version, env, exec: r.exec });
  const asset = remotePackAssetName(tool, rel.version, target);
  const have = await installedRemotePackRelease(productDir, tool);
  if (have !== undefined && existsSync(remotePackManifestPath(productDir, tool))) {
    if (!opts.force && have === rel.version) return { tool, dir, version: rel.version, installed: false, skipped: "already", reason: `${REMOTE_DIRNAME}/${tool} is already the ${rel.version} pack` };
    if (!opts.force && compareVersions(rel.version, have) === -1) {
      return {
        tool,
        dir,
        version: have,
        installed: false,
        skipped: "downgrade",
        reason: `${REMOTE_DIRNAME}/${tool} is the ${have} pack and ${rel.tag} is older — not moved backwards (an older release could carry a tool with a published flaw); \`metistry update\` to a newer release is the way forward`,
      };
    }
  }
  if (!rel.assets[asset]) return { tool, dir, version: rel.version, installed: false, skipped: "no-asset", reason: `release ${rel.tag} carries no ${asset}` };

  const staging = join(productDir, `.remote-download-${tool}`);
  await rm(staging, { recursive: true, force: true });
  const got = await downloadVerifiedAsset(r, { fetchFn, env, rel, asset, staging, unchangedWhat: `${RUNTIME_DIRNAME}/${REMOTE_DIRNAME}/` });

  // unpack BESIDE the tree, then prove the pack is what it claims before
  // anything that was there is touched
  const unpacked = join(staging, "unpacked");
  await mkdir(unpacked, { recursive: true });
  await r.run("tar", ["-xzf", got.path, "-C", unpacked], { timeoutMs: 10 * 60_000 });
  const refusal = await verifyUnpackedRemotePack(unpacked, tool);
  if (refusal) {
    await rm(staging, { recursive: true, force: true });
    throw new StepFailed(`${asset} was discarded: ${refusal} — ${RUNTIME_DIRNAME}/${REMOTE_DIRNAME}/ is unchanged`);
  }
  const fresh = join(unpacked, REMOTE_DIRNAME, tool);
  await writeFile(join(fresh, RUNTIME_RELEASE_FILE), `${rel.version}\n`);

  // the swap: the old tree steps aside, the verified one takes its place, the
  // old one goes — two renames inside one directory, so a failure between them
  // leaves either the old pack or the new one, never a half of each
  const old = `${dir}.old`;
  await rm(old, { recursive: true, force: true });
  await mkdir(dirname(dir), { recursive: true });
  if (existsSync(dir)) await rename(dir, old);
  await rename(fresh, dir);
  await rm(old, { recursive: true, force: true });
  await rm(staging, { recursive: true, force: true });
  const m = await readRemotePackManifest(productDir, tool);
  r.note(`${RUNTIME_DIRNAME}/${REMOTE_DIRNAME}/${tool}/: ${tool} ${m?.version ?? "?"}${m?.signed ? ", signed" : ", unsigned"} (release ${rel.version})`);
  return { tool, dir, version: rel.version, installed: true };
}

/**
 * `metistry update`'s half: move forward every tool pack that is ALREADY
 * under runtime/remote/ to the release just installed. A tool whose pack is
 * not here is never fetched — that is `remote set`'s choice to make — so an
 * install with no provider reaches for nothing. Each pack's outcome is
 * returned; a corrupt download throws as `installRemotePack` does.
 */
export async function updateRemotePacks(r: StepRunner, opts: Omit<InstallRemotePackOptions, "tool">): Promise<InstallRemotePackResult[]> {
  const out: InstallRemotePackResult[] = [];
  for (const have of await installedRemotePacks(opts.productDir)) {
    out.push(await installRemotePack(r, { ...opts, tool: have.tool }));
  }
  return out;
}
