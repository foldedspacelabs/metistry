// Release mode for `metistry update` (plan §4.16: "code flows downward as
// releases, never as git merges"). An install whose metistry.lock says
// `source: release` has no checkout to pull — it downloads the runtime
// pack the release workflow built, verifies its sha256 against the
// release's checksums.txt, unpacks it beside the previous one and moves a
// `current` symlink:
//
//   <product-dir>/
//     releases/0.2.0/     the pack, unpacked (this release)
//     releases/0.1.0/      the one before — kept, so --rollback is a symlink flip
//     releases/.previous   the version `current` pointed at before the last switch
//     current -> releases/0.2.0
//
// Everything after the switch (migrations, compose, kickstart, the lock,
// doctor) runs against `current`, so a rollback needs no re-download and
// changes nothing else. Every fetch goes through the injected `fetch` —
// no http dependency, and the tests serve a whole fake release.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { realExec, type Exec } from "./exec.js";
import { StepFailed, type StepRunner } from "./steps.js";

/** The product's GitHub repo — `METISTRY_RELEASE_REPO` retargets a fork without touching code (invariant 7). */
export const DEFAULT_RELEASE_REPO = "foldedspacelabs/metistry";
/** Where the release workflow pushes the app images; `<prefix>-console:<version>`. */
export const DEFAULT_IMAGE_PREFIX = "ghcr.io/foldedspacelabs/metistry";
/** Compose services whose image is a released, versioned one (db is upstream pgvector). */
export const IMAGE_SERVICES = ["console", "assistant"] as const;

export const RELEASES_DIRNAME = "releases";
export const CURRENT_LINK = "current";
export const PREVIOUS_FILE = ".previous";
export const CHECKSUMS_ASSET = "checksums.txt";
/** How many unpacked releases stay on disk: the running one and the one to roll back to. */
export const KEEP_RELEASES = 2;
/** Written at the pack's root by `ops/release/pack-runtime.sh`; unpacking strips the tarball's one top-level dir, so this lands directly in a release's dir. */
export const RUNTIME_PACK_MANIFEST = "metistry-runtime.json";

export function releasesDir(productDir: string): string {
  return join(productDir, RELEASES_DIRNAME);
}
export function currentLink(productDir: string): string {
  return join(productDir, CURRENT_LINK);
}
export function releaseDir(productDir: string, version: string): string {
  return join(releasesDir(productDir), version);
}

/** `darwin-arm64` — the runtime pack carries production node_modules and the signed TCC helpers, so it is per os-arch. */
export function releaseTarget(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  const os = platform === "win32" ? "windows" : platform;
  return `${os}-${arch}`;
}

/** The one asset name the workflow, the pack script and this module must agree on (a test asserts all three). */
export function runtimeAssetName(version: string, target: string): string {
  return `metistry-runtime-${version.replace(/^v/, "")}-${target}.tar.gz`;
}

/** `0.14.0` vs `0.13.2` → 1; undefined when either is not a plain x.y.z (never a guess). */
export function compareVersions(a: string, b: string): number | undefined {
  const parse = (v: string) => /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim())?.slice(1).map(Number);
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return a.trim() === b.trim() ? 0 : undefined;
  for (let i = 0; i < 3; i++) if (x[i]! !== y[i]!) return x[i]! > y[i]! ? 1 : -1;
  return 0;
}

/**
 * How many of the newest releases an unpinned update looks through for one
 * that carries this platform's runtime pack, before it gives up. A release
 * whose workflow failed publishes with no assets and — immutable releases —
 * can never be repaired under its tag (docs/ops/releases.md), so "Latest"
 * alone is not enough to go on.
 */
export const RELEASE_WALK_LIMIT = 10;

export function releaseRepo(env: NodeJS.ProcessEnv, override?: string | undefined): string {
  return override ?? env.METISTRY_RELEASE_REPO ?? DEFAULT_RELEASE_REPO;
}

export function imageRef(service: string, version: string, env: NodeJS.ProcessEnv = process.env): string {
  return `${env.METISTRY_IMAGE_PREFIX ?? DEFAULT_IMAGE_PREFIX}-${service}:${version}`;
}

/** `{ METISTRY_CONSOLE_IMAGE: "ghcr.io/…-console:0.2.0", … }` — docker-compose.yml reads these, defaulting to the dev tags. */
export function imageEnv(version: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return Object.fromEntries(IMAGE_SERVICES.map((s) => [`METISTRY_${s.toUpperCase()}_IMAGE`, imageRef(s, version, env)]));
}

export interface ResolvedRelease {
  /** without the leading v */
  version: string;
  tag: string;
  /** asset name → download url (browser_download_url; on a private repo this 404s for anything but a browser session — use `assetIds` + the authenticated API instead when a token is configured) */
  assets: Record<string, string>;
  /** asset name → GitHub's numeric id, for `GET /releases/assets/<id>` (the one path that reads a private repo's asset bytes with a token) */
  assetIds: Record<string, number>;
  /** which path answered: the direct GitHub API call, or the `gh` CLI fallback */
  via: "api" | "gh";
}

interface GhRelease {
  tag_name?: string;
  draft?: boolean;
  prerelease?: boolean;
  assets?: { name?: string; id?: number; browser_download_url?: string }[];
}

function assetMaps(assets: GhRelease["assets"]): { assets: Record<string, string>; assetIds: Record<string, number> } {
  const urls: Record<string, string> = {};
  const ids: Record<string, number> = {};
  for (const a of assets ?? []) {
    if (a.name && a.browser_download_url) urls[a.name] = a.browser_download_url;
    if (a.name && typeof a.id === "number") ids[a.name] = a.id;
  }
  return { assets: urls, assetIds: ids };
}

/** `gh --version` exits 0, so this also doubles as "gh is on PATH". */
async function ghAvailable(exec: Exec): Promise<boolean> {
  try {
    return (await exec("gh", ["--version"])).code === 0;
  } catch {
    return false;
  }
}

/** `gh api repos/<repo>/releases/(tags/<tag>|latest)` — same shape as the direct API response, so callers don't care which path answered. */
async function resolveViaGh(exec: Exec, repo: string, want: string | undefined): Promise<ResolvedRelease> {
  const path = want ? `repos/${repo}/releases/tags/${want}` : `repos/${repo}/releases/latest`;
  const r = await exec("gh", ["api", path]);
  if (r.code !== 0) {
    const detail = (r.stderr || r.stdout).trim().split("\n").slice(-3).join("; ");
    throw new StepFailed(`gh api ${path} failed${detail ? ` (${detail})` : ""} — check \`gh auth status\` and that ${repo} is the right repo`);
  }
  let body: GhRelease;
  try {
    body = JSON.parse(r.stdout) as GhRelease;
  } catch {
    throw new StepFailed(`gh api ${path} did not return JSON`);
  }
  const tag = body.tag_name;
  if (typeof tag !== "string" || tag === "") throw new StepFailed(`gh api ${path} returned a release with no tag_name`);
  return { version: tag.replace(/^v/, ""), tag, ...assetMaps(body.assets), via: "gh" };
}

/**
 * The latest release, or the one tagged `v<version>`. Read-only and
 * unauthenticated by default; `METISTRY_GITHUB_TOKEN` (the read-only PAT
 * the github-state collector already uses) lifts the anonymous rate limit
 * and is the only way to see a private repo's releases — a fine-grained
 * PAT needs `Contents: read` on the repo for that, not just Issues/PRs.
 *
 * A 403 that is not an exhausted rate limit (checked via
 * `x-ratelimit-remaining`, since GitHub answers both cases with 403) means
 * the token cannot see this repo's releases. Rather than fail outright,
 * fall back to the `gh` CLI when it is on PATH and already logged in —
 * `gh`'s own credential is independent of `METISTRY_GITHUB_TOKEN`.
 */
export async function resolveRelease(opts: { fetchFn: typeof fetch; repo?: string | undefined; version?: string | undefined; env?: NodeJS.ProcessEnv | undefined; exec?: Exec | undefined }): Promise<ResolvedRelease> {
  const env = opts.env ?? {};
  const repo = releaseRepo(env, opts.repo);
  const api = env.METISTRY_GITHUB_API ?? "https://api.github.com";
  const want = opts.version ? `v${opts.version.replace(/^v/, "")}` : undefined;
  const url = want ? `${api}/repos/${repo}/releases/tags/${want}` : `${api}/repos/${repo}/releases/latest`;
  const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "metistry-cli" };
  const hasToken = Boolean(env.METISTRY_GITHUB_TOKEN);
  if (hasToken) headers.authorization = `Bearer ${env.METISTRY_GITHUB_TOKEN}`;
  const exec = opts.exec ?? realExec;

  let res: Response;
  try {
    res = await opts.fetchFn(url, { headers, signal: AbortSignal.timeout(30_000) });
  } catch (err) {
    throw new StepFailed(`could not reach ${url} (${err instanceof Error ? err.message : String(err)}) — check the network, or pass --channel git if this install is a checkout`);
  }

  if (res.status === 401 || res.status === 403) {
    const remaining = res.headers.get("x-ratelimit-remaining");
    if (res.status === 403 && remaining === "0") {
      throw new StepFailed(`GitHub answered HTTP 403 for ${url} — rate limited (x-ratelimit-remaining: 0)${hasToken ? "; wait for the window to reset" : "; set METISTRY_GITHUB_TOKEN to raise the limit"}`);
    }
    if (await ghAvailable(exec)) return await resolveViaGh(exec, repo, want);
    throw new StepFailed(
      `GitHub answered HTTP ${res.status} for ${url} — ${
        hasToken ? `METISTRY_GITHUB_TOKEN lacks "Contents: read" on ${repo} (a fine-grained PAT needs it granted explicitly — Issues/PRs/Metadata is not enough)` : `no METISTRY_GITHUB_TOKEN is set and ${repo} may be private`
      }, or ${repo} is the wrong repo. Add "Contents: read" to the PAT, or install the gh CLI and run \`gh auth login\` so metistry falls back to it automatically.`,
    );
  }
  if (res.status === 404) throw new StepFailed(want ? `${repo} has no release tagged ${want}` : `${repo} has no releases yet — nothing to update to (the product is still git-mode: --channel git)`);
  if (!res.ok) throw new StepFailed(`GitHub answered HTTP ${res.status} for ${url}`);

  const body = (await res.json()) as GhRelease;
  const tag = body.tag_name;
  if (typeof tag !== "string" || tag === "") throw new StepFailed(`${url} returned a release with no tag_name`);
  return { version: tag.replace(/^v/, ""), tag, ...assetMaps(body.assets), via: "api" };
}

/**
 * `GET /repos/<repo>/releases?per_page=<n>` — the newest `n` releases, drafts
 * and prereleases dropped (an update never lands on either unless pinned with
 * `--version`). Same auth and `gh` fallback as `resolveRelease`; `viaGh`
 * skips straight to `gh` when the resolve already needed it.
 */
async function listReleases(opts: { fetchFn: typeof fetch; repo: string; env: NodeJS.ProcessEnv; exec: Exec; limit: number; viaGh: boolean }): Promise<ResolvedRelease[]> {
  const { repo, env, exec, limit } = opts;
  const toResolved = (body: unknown, via: ResolvedRelease["via"]): ResolvedRelease[] => {
    if (!Array.isArray(body)) throw new StepFailed(`the releases list of ${repo} was not a JSON array`);
    return (body as GhRelease[])
      .filter((b) => !b.draft && !b.prerelease && typeof b.tag_name === "string" && b.tag_name !== "")
      .map((b) => ({ version: b.tag_name!.replace(/^v/, ""), tag: b.tag_name!, ...assetMaps(b.assets), via }));
  };
  const ghPath = `repos/${repo}/releases?per_page=${limit}`;
  const viaGh = async (): Promise<ResolvedRelease[]> => {
    const r = await exec("gh", ["api", ghPath]);
    if (r.code !== 0) throw new StepFailed(`gh api ${ghPath} failed${(r.stderr || r.stdout).trim() ? ` (${(r.stderr || r.stdout).trim().split("\n").slice(-3).join("; ")})` : ""}`);
    try {
      return toResolved(JSON.parse(r.stdout), "gh");
    } catch (err) {
      throw err instanceof StepFailed ? err : new StepFailed(`gh api ${ghPath} did not return JSON`);
    }
  };
  if (opts.viaGh) return viaGh();

  const api = env.METISTRY_GITHUB_API ?? "https://api.github.com";
  const url = `${api}/${ghPath}`;
  const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "metistry-cli" };
  if (env.METISTRY_GITHUB_TOKEN) headers.authorization = `Bearer ${env.METISTRY_GITHUB_TOKEN}`;
  let res: Response;
  try {
    res = await opts.fetchFn(url, { headers, signal: AbortSignal.timeout(30_000) });
  } catch (err) {
    throw new StepFailed(`could not reach ${url} (${err instanceof Error ? err.message : String(err)})`);
  }
  if ((res.status === 401 || res.status === 403) && res.headers.get("x-ratelimit-remaining") !== "0" && (await ghAvailable(exec))) return viaGh();
  if (!res.ok) throw new StepFailed(`GitHub answered HTTP ${res.status} for ${url}`);
  return toResolved(await res.json(), "api");
}

/** The two assets an install cannot go without: this platform's pack, and the checksums it is verified against. */
function missingInstallAssets(rel: ResolvedRelease, target: string): string[] {
  return [runtimeAssetName(rel.version, target), CHECKSUMS_ASSET].filter((a) => !rel.assets[a]);
}

export interface InstallableRelease {
  rel: ResolvedRelease;
  /** newer releases passed over because they lack the pack or its checksums, newest first */
  skipped: Array<{ tag: string; missing: string[] }>;
}

/**
 * The release an UNPINNED update installs: GitHub's Latest when it carries
 * this platform's runtime pack and `checksums.txt`, else the newest older
 * release (by version, drafts and prereleases excluded) among the last
 * `RELEASE_WALK_LIMIT` that does. A release whose workflow failed publishes
 * with no assets and can never be repaired under its tag (immutable
 * releases), so taking Latest blindly would wedge every update until the
 * next release is cut. When none of them has a pack, the failure names the
 * Latest release's own gap — the same message a pinned `--version` gives.
 * Pinned versions never come through here: `--version X` means X.
 */
export async function resolveInstallableRelease(opts: {
  fetchFn: typeof fetch;
  env: NodeJS.ProcessEnv;
  target: string;
  exec?: Exec | undefined;
  limit?: number | undefined;
}): Promise<InstallableRelease> {
  const { fetchFn, env, target } = opts;
  const exec = opts.exec ?? realExec;
  const limit = opts.limit ?? RELEASE_WALK_LIMIT;
  const latest = await resolveRelease({ fetchFn, env, exec });
  if (missingInstallAssets(latest, target).length === 0) return { rel: latest, skipped: [] };

  const noPack = (): string => {
    const names = Object.keys(latest.assets).sort();
    const missing = missingInstallAssets(latest, target);
    return missing.includes(runtimeAssetName(latest.version, target))
      ? `release ${latest.tag} has no ${runtimeAssetName(latest.version, target)} (assets: ${names.length ? names.join(", ") : "none"}) — this platform has no runtime pack in that release`
      : `release ${latest.tag} has no ${CHECKSUMS_ASSET} — refusing to install an unverifiable runtime pack`;
  };
  let listed: ResolvedRelease[];
  try {
    listed = await listReleases({ fetchFn, repo: releaseRepo(env), env, exec, limit, viaGh: latest.via === "gh" });
  } catch (err) {
    throw new StepFailed(`${noPack()}, and the older releases could not be listed (${err instanceof Error ? err.message : String(err)})`);
  }
  // Older than Latest only, newest version first: GitHub lists by creation
  // date, and a tag that is not a plain x.y.z has no place in the order.
  const older = listed
    .filter((c) => compareVersions(c.version, latest.version) === -1)
    .sort((a, b) => compareVersions(b.version, a.version) ?? 0)
    .slice(0, Math.max(0, limit - 1));
  const skipped: InstallableRelease["skipped"] = [{ tag: latest.tag, missing: missingInstallAssets(latest, target) }];
  for (const c of older) {
    const missing = missingInstallAssets(c, target);
    if (missing.length === 0) return { rel: c, skipped };
    skipped.push({ tag: c.tag, missing });
  }
  throw new StepFailed(
    `${noPack()}; none of the last ${skipped.length} release(s) (${skipped.map((s) => s.tag).join(", ")}) has a ${target} runtime pack with its ${CHECKSUMS_ASSET} — nothing to install. Pin one explicitly with --version <x.y.z> if an older pack exists`,
  );
}

/** `<sha256>  <filename>` lines (sha256sum/shasum output) → filename → digest. */
export function parseChecksums(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line.trim());
    if (m?.[1] && m[2]) out[m[2].replace(/^\.\//, "")] = m[1].toLowerCase();
  }
  return out;
}

/** Download to `dest` and return its sha256. Nothing is trusted until the caller compares it. */
export async function downloadTo(fetchFn: typeof fetch, url: string, dest: string): Promise<{ bytes: number; sha256: string }> {
  let res: Response;
  try {
    res = await fetchFn(url, { headers: { "user-agent": "metistry-cli" }, signal: AbortSignal.timeout(30 * 60_000) });
  } catch (err) {
    throw new StepFailed(`download failed for ${url} (${err instanceof Error ? err.message : String(err)})`);
  }
  if (!res.ok) throw new StepFailed(`download failed for ${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await mkdir(join(dest, ".."), { recursive: true });
  await writeFile(dest, buf);
  return { bytes: buf.byteLength, sha256: createHash("sha256").update(buf).digest("hex") };
}

/**
 * `gh release download <tag> --pattern <asset> --dir <dir>` — the fallback
 * asset fetch for when `METISTRY_GITHUB_TOKEN` cannot even see the repo's
 * releases (so its `browser_download_url`s would 403 too): `gh`'s own
 * login, not the token, does the authenticating. Returns the file's sha256
 * the same way `downloadTo` does, so callers don't care which path ran.
 */
export async function downloadViaGh(r: StepRunner, repo: string, tag: string, asset: string, dir: string): Promise<{ bytes: number; sha256: string }> {
  await mkdir(dir, { recursive: true });
  await r.run("gh", ["release", "download", tag, "--repo", repo, "--pattern", asset, "--dir", dir, "--clobber"], { timeoutMs: 30 * 60_000 });
  const dest = join(dir, asset);
  const buf = await readFile(dest);
  return { bytes: buf.byteLength, sha256: createHash("sha256").update(buf).digest("hex") };
}

/**
 * `GET /repos/<repo>/releases/assets/<id>` with `Accept: application/octet-stream`
 * and the bearer token — the one path that reads a PRIVATE repo's asset
 * bytes with a token; `browser_download_url` needs a browser session there
 * and 404s for a token (GitHub's docs). GitHub answers with a 302 to a
 * signed, time-limited S3 URL: the redirect is followed manually and the
 * Authorization header is deliberately NOT resent on it — S3 doesn't
 * recognise a GitHub token, and forwarding one to a third-party host is a
 * needless credential leak.
 */
async function downloadAssetViaApi(fetchFn: typeof fetch, env: NodeJS.ProcessEnv, repo: string, id: number, dest: string): Promise<{ bytes: number; sha256: string }> {
  const api = env.METISTRY_GITHUB_API ?? "https://api.github.com";
  const url = `${api}/repos/${repo}/releases/assets/${id}`;
  const headers: Record<string, string> = { accept: "application/octet-stream", "user-agent": "metistry-cli", authorization: `Bearer ${env.METISTRY_GITHUB_TOKEN}` };
  let res: Response;
  try {
    res = await fetchFn(url, { headers, redirect: "manual", signal: AbortSignal.timeout(30_000) });
  } catch (err) {
    throw new StepFailed(`download failed for ${url} (${err instanceof Error ? err.message : String(err)})`);
  }
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get("location");
    if (!loc) throw new StepFailed(`download failed for ${url}: HTTP ${res.status} redirect with no Location header`);
    return await downloadTo(fetchFn, loc, dest); // unauthenticated — the signed URL carries its own credential
  }
  if (!res.ok) throw new StepFailed(`download failed for ${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await mkdir(join(dest, ".."), { recursive: true });
  await writeFile(dest, buf);
  return { bytes: buf.byteLength, sha256: createHash("sha256").update(buf).digest("hex") };
}

/**
 * Download one asset of a resolved release (the runtime pack, the deps
 * pack, or `checksums.txt`) to `<dir>/<name>` — the single path
 * `installRelease` and `installRuntimeDeps` both go through, so a private
 * repo works the same for either pack:
 *
 *  - `via: "gh"` (the resolve itself needed `gh`): `gh release download`,
 *    unchanged.
 *  - a token is configured: the authenticated asset API, by id — the only
 *    path that can read a private repo's asset bytes with a token.
 *  - no token: the plain `browser_download_url` (the public-repo case).
 *
 * Either of the last two falls back to `gh release download` on a 404, the
 * same way an unauthorised RESOLVE already did — so a repo whose token has
 * a scope gap still gets its bytes as long as `gh` is logged in.
 */
export async function downloadAsset(r: StepRunner, opts: { fetchFn: typeof fetch; repo: string; rel: ResolvedRelease; name: string; dir: string; env: NodeJS.ProcessEnv }): Promise<{ bytes: number; sha256: string }> {
  const { rel, name, dir, env, repo, fetchFn } = opts;
  if (rel.via === "gh") return downloadViaGh(r, repo, rel.tag, name, dir);

  const dest = join(dir, name);
  const token = env.METISTRY_GITHUB_TOKEN;
  try {
    if (token) {
      const id = rel.assetIds[name];
      if (id === undefined) throw new StepFailed(`${rel.tag} has no asset id for ${name} — cannot download it through the authenticated API`);
      return await downloadAssetViaApi(fetchFn, env, repo, id, dest);
    }
    const url = rel.assets[name];
    if (!url) throw new StepFailed(`release ${rel.tag} has no ${name}`);
    return await downloadTo(fetchFn, url, dest);
  } catch (err) {
    if (err instanceof StepFailed && /HTTP 404/.test(err.message) && (await ghAvailable(r.exec))) {
      r.note(`${name}: download 404'd — falling back to \`gh release download\``);
      return await downloadViaGh(r, repo, rel.tag, name, dir);
    }
    throw err;
  }
}

/**
 * Download one asset of a resolved release into `dir` and check it against
 * the release's `checksums.txt` — the gate the runtime pack and the Mac app's
 * DMG both go through, so neither is trusted on a different rule. A mismatch
 * discards `dir` and names what was left `unchanged`; an asset the checksums
 * do not list is refused, never installed unverified.
 */
export async function downloadVerified(
  r: StepRunner,
  o: { fetchFn: typeof fetch; repo: string; rel: ResolvedRelease; name: string; dir: string; env: NodeJS.ProcessEnv; what: string; unchanged: string },
): Promise<{ path: string; bytes: number; sha256: string }> {
  const { rel, name, dir } = o;
  if (!rel.assets[CHECKSUMS_ASSET] && rel.via !== "gh") throw new StepFailed(`release ${rel.tag} has no ${CHECKSUMS_ASSET} — refusing to install an unverifiable ${o.what}`);
  await downloadAsset(r, { fetchFn: o.fetchFn, repo: o.repo, rel, name: CHECKSUMS_ASSET, dir, env: o.env });
  const want = parseChecksums(await readFile(join(dir, CHECKSUMS_ASSET), "utf8"))[name];
  if (!want) throw new StepFailed(`${CHECKSUMS_ASSET} of ${rel.tag} has no line for ${name} — refusing to install an unverifiable ${o.what}`);
  const got = await downloadAsset(r, { fetchFn: o.fetchFn, repo: o.repo, rel, name, dir, env: o.env });
  if (got.sha256 !== want) {
    await rm(dir, { recursive: true, force: true });
    throw new StepFailed(`${name} failed its checksum (expected ${want}, got ${got.sha256}) — the download was discarded and ${o.unchanged} is unchanged`);
  }
  r.note(`${name}: ${got.bytes} bytes, sha256 ${got.sha256.slice(0, 12)}… verified`);
  return { path: join(dir, name), ...got };
}

/** The version `current` points at, or undefined when nothing is installed yet. */
export async function currentVersion(productDir: string): Promise<string | undefined> {
  try {
    const target = await readlink(currentLink(productDir));
    const name = target.replace(/\/+$/, "").split("/").pop();
    return name && name !== CURRENT_LINK ? name : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The commit `pack-runtime.sh` was built from, read from the installed
 * pack's own `metistry-runtime.json` — undefined for a pack built before
 * that field shipped (e.g. 0.3.0/0.3.1), never fabricated.
 */
export async function runtimePackCommit(dir: string): Promise<string | undefined> {
  try {
    const manifest = JSON.parse(await readFile(join(dir, RUNTIME_PACK_MANIFEST), "utf8")) as { commit?: unknown };
    return typeof manifest.commit === "string" && manifest.commit !== "" ? manifest.commit : undefined;
  } catch {
    return undefined;
  }
}

/** The version to roll back to: what `current` pointed at before the last switch. */
export async function previousVersion(productDir: string): Promise<string | undefined> {
  try {
    const v = (await readFile(join(releasesDir(productDir), PREVIOUS_FILE), "utf8")).trim();
    return v === "" ? undefined : v;
  } catch {
    return undefined;
  }
}

/**
 * Point `current` at `<version>`, recording what it pointed at before.
 * The symlink target is RELATIVE (`releases/<version>`) so a product dir
 * stays movable, and the swap goes through a temp link + rename so there
 * is no window where `current` does not exist.
 */
export async function switchCurrent(productDir: string, version: string, opts: { previous?: string | undefined } = {}): Promise<void> {
  const dir = releaseDir(productDir, version);
  if (!existsSync(dir)) throw new StepFailed(`${dir} is not unpacked — cannot point ${CURRENT_LINK} at ${version}`);
  const prior = opts.previous ?? (await currentVersion(productDir));
  const tmp = join(productDir, `.${CURRENT_LINK}.tmp`);
  await rm(tmp, { force: true });
  await symlink(join(RELEASES_DIRNAME, version), tmp);
  await rename(tmp, currentLink(productDir));
  if (prior && prior !== version) await writeFile(join(releasesDir(productDir), PREVIOUS_FILE), `${prior}\n`);
}

/** Delete unpacked releases that are neither `current` nor the rollback target (KEEP_RELEASES on disk). */
export async function pruneReleases(productDir: string, keep: string[]): Promise<string[]> {
  const dir = releasesDir(productDir);
  if (!existsSync(dir)) return [];
  const kept = new Set(keep.filter(Boolean));
  const removed: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || kept.has(e.name) || e.name.startsWith(".")) continue;
    await rm(join(dir, e.name), { recursive: true, force: true });
    removed.push(e.name);
  }
  return removed;
}

export interface InstallReleaseOptions {
  productDir: string;
  fetchFn: typeof fetch;
  env: NodeJS.ProcessEnv;
  /** pin a release instead of taking the latest */
  version?: string | undefined;
  target?: string | undefined;
  /** re-download and re-unpack even when this version is already `current` */
  force?: boolean | undefined;
}

export interface InstallReleaseResult {
  version: string;
  /** absolute path of the unpacked release (what `current` now points at) */
  dir: string;
  /** false when the version was already installed and current */
  installed: boolean;
  previous?: string | undefined;
}

/**
 * Resolve → download → verify → unpack → switch. Refuses on a checksum
 * mismatch WITHOUT touching `current`: a tampered or truncated asset
 * leaves the running release exactly where it was.
 */
export async function installRelease(r: StepRunner, opts: InstallReleaseOptions): Promise<InstallReleaseResult> {
  const { productDir, fetchFn, env } = opts;
  const target = opts.target ?? releaseTarget();
  const repo = releaseRepo(env);
  // `--version X` is X, or a failure — never a substitute. Unpinned, the
  // newest release that actually carries this platform's pack.
  const pinned = Boolean(opts.version);
  const found = pinned ? { rel: await resolveRelease({ fetchFn, version: opts.version, env, exec: r.exec }), skipped: [] } : await resolveInstallableRelease({ fetchFn, env, target, exec: r.exec });
  const rel = found.rel;
  if (rel.via === "gh") r.note(`${repo}: METISTRY_GITHUB_TOKEN was unauthorized for the Releases API — resolved and downloading via \`gh\` instead`);
  if (found.skipped.length) {
    // a missing pack is the headline; checksums alone missing is named as such
    for (const s of found.skipped) r.note(`${s.tag} has no ${s.missing.includes(CHECKSUMS_ASSET) && s.missing.length === 1 ? CHECKSUMS_ASSET : `pack for ${target}`} — installing ${rel.tag}`);
  }
  const asset = runtimeAssetName(rel.version, target);
  const before = await currentVersion(productDir);

  // an unpinned update never moves backwards: the newest release with a pack
  // being older than what runs means there is nothing newer to go to
  if (!pinned && before && compareVersions(rel.version, before) === -1 && existsSync(releaseDir(productDir, before))) {
    r.note(`already on the newest release with a pack: running ${before}, and the newest release carrying a ${target} pack is ${rel.version} — nothing to download (pin one with --version to go back on purpose)`);
    return { version: before, dir: releaseDir(productDir, before), installed: false, previous: await previousVersion(productDir) };
  }

  if (!opts.force && before === rel.version && existsSync(releaseDir(productDir, rel.version))) {
    r.note(`already running ${rel.version} (${CURRENT_LINK} -> ${RELEASES_DIRNAME}/${rel.version}) — nothing to download`);
    return { version: rel.version, dir: releaseDir(productDir, rel.version), installed: false, ...(before ? { previous: await previousVersion(productDir) } : {}) };
  }

  const url = rel.assets[asset];
  if (!url) {
    const names = Object.keys(rel.assets).sort();
    throw new StepFailed(`release ${rel.tag} has no ${asset} (assets: ${names.length ? names.join(", ") : "none"}) — this platform has no runtime pack in that release`);
  }
  if (!rel.assets[CHECKSUMS_ASSET]) throw new StepFailed(`release ${rel.tag} has no ${CHECKSUMS_ASSET} — refusing to install an unverifiable runtime pack`);

  const staging = join(releasesDir(productDir), ".download");
  r.action(`download ${asset} from ${rel.tag} and verify its sha256 against ${CHECKSUMS_ASSET}`);
  const tarball = (await downloadVerified(r, { fetchFn, repo, rel, name: asset, dir: staging, env, what: "runtime pack", unchanged: CURRENT_LINK })).path;

  const dir = releaseDir(productDir, rel.version);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  // the pack's single top-level metistry-<version>/ is stripped: releases/<version>/ IS the product dir
  await r.run("tar", ["-xzf", tarball, "-C", dir, "--strip-components=1"], { timeoutMs: 10 * 60_000 });
  await rm(staging, { recursive: true, force: true });

  await switchCurrent(productDir, rel.version, { previous: before });
  const removed = await pruneReleases(productDir, [rel.version, before ?? ""]);
  if (removed.length) r.note(`pruned older releases: ${removed.join(", ")} (${KEEP_RELEASES} kept)`);
  r.note(`${CURRENT_LINK} -> ${RELEASES_DIRNAME}/${rel.version}${before ? ` (was ${before}, kept for --rollback)` : ""}`);
  return { version: rel.version, dir, installed: true, ...(before ? { previous: before } : {}) };
}

/** `metistry update --rollback`: flip `current` back to the previous release. No download, and migrations are NOT reverted (additive-first). */
export async function rollbackRelease(r: StepRunner, productDir: string): Promise<InstallReleaseResult> {
  const from = await currentVersion(productDir);
  const to = await previousVersion(productDir);
  if (!to) throw new StepFailed(`no previous release recorded in ${RELEASES_DIRNAME}/${PREVIOUS_FILE} — there is nothing to roll back to`);
  if (!existsSync(releaseDir(productDir, to))) throw new StepFailed(`${releaseDir(productDir, to)} is gone — the rollback target was pruned or deleted`);
  await switchCurrent(productDir, to, { previous: from });
  r.note(`rolled back: ${CURRENT_LINK} -> ${RELEASES_DIRNAME}/${to}${from ? ` (was ${from})` : ""}`);
  r.note("migrations are additive-first and are NOT reverted — a schema newer than the code is expected after a rollback (docs/ops/releases.md)");
  return { version: to, dir: releaseDir(productDir, to), installed: true, ...(from ? { previous: from } : {}) };
}
