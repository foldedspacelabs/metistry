// The Mac app half of `metistry update` (release mode, launchd shape, macOS).
//
// The runtime pack and the app ship in the same release, and until now only
// the pack moved: `update` left `/Applications/Metistry.app` on whatever
// version Sparkle last installed, so an owner who updated from the terminal
// ran a new product under an old front end. This moves the app with it, the
// same way the pack moves:
//
//   Metistry-<version>.dmg   downloaded from the SAME release, its sha256
//                            checked against checksums.txt by the same code
//                            path as the pack (release.ts downloadVerified)
//   hdiutil attach           read-only, no Finder window, at a private mountpoint
//   the bundle               copied beside the installed one (same volume, so
//                            the swap is two renames), then checked: bundle id,
//                            CFBundleShortVersionString == the release, and
//                            its signature (codesign + Gatekeeper when signed)
//   the swap                 Metistry.app → Metistry.app.previous, the new one
//                            into place; one previous kept for --rollback
//
// It never escalates (no sudo, no authorization prompt), never kills a
// running app unless asked (`--relaunch`), and never fails the update: the
// product has already moved by the time it runs, and an app left one
// version behind is a doctor row, not a broken install.

import { existsSync } from "node:fs";
import { access, constants, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Exec } from "./exec.js";
import { downloadVerified, releaseRepo, resolveRelease } from "./release.js";
import { StepFailed, type StepRunner } from "./steps.js";

/** Info.plist's CFBundleIdentifier (apps/macos/resources/Info.plist) — an app at the path that is not this is never touched. */
export const APP_BUNDLE_ID = "com.foldedspacelabs.metistry";
export const APP_BUNDLE_NAME = "Metistry.app";
/** The one previous copy kept beside the app, for `metistry update --rollback`. Not `.app`, so Launch Services never lists it as a second Metistry. */
export const APP_PREVIOUS_SUFFIX = ".previous";
export const SYSTEM_APPLICATIONS = "/Applications";

/** The release asset the `macos-app` job uploads (.github/workflows/release.yml, ops/release/build-app.sh). */
export function appDmgAssetName(version: string): string {
  return `Metistry-${version.replace(/^v/, "")}.dmg`;
}

export function previousAppPath(appPath: string): string {
  return `${appPath.replace(/\/+$/, "")}${APP_PREVIOUS_SUFFIX}`;
}

/**
 * Where to look for the app when no `--app-path` is given: `METISTRY_APP_PATH`
 * when set (the override a doctor run shares with `update`, invariant 7), else
 * `/Applications/Metistry.app` then `~/Applications/Metistry.app` — the second
 * being where the sudo-free alternative below puts it.
 */
export function appCandidates(env: NodeJS.ProcessEnv): string[] {
  if (env.METISTRY_APP_PATH) return [env.METISTRY_APP_PATH];
  return [join(SYSTEM_APPLICATIONS, APP_BUNDLE_NAME), ...(env.HOME ? [join(env.HOME, "Applications", APP_BUNDLE_NAME)] : [])];
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

export interface BundleInfo {
  id?: string | undefined;
  version?: string | undefined;
}

/** CFBundleIdentifier + CFBundleShortVersionString, read with `plutil` (read-only; nothing is parsed out of prose). */
export async function readBundleInfo(exec: Exec, appPath: string): Promise<BundleInfo> {
  const plist = join(appPath, "Contents", "Info.plist");
  if (!existsSync(plist)) return {};
  const key = async (k: string): Promise<string | undefined> => {
    const r = await exec("plutil", ["-extract", k, "raw", "-o", "-", plist]);
    const v = r.stdout.trim();
    return r.code === 0 && v !== "" ? v : undefined;
  };
  return { id: await key("CFBundleIdentifier"), version: await key("CFBundleShortVersionString") };
}

/** `codesign -dv` exits non-zero for "code object is not signed at all" — the only question asked of it here. */
export async function isSigned(exec: Exec, appPath: string): Promise<boolean> {
  const r = await exec("codesign", ["-dv", appPath]);
  return r.code === 0;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** PIDs whose command line is THIS bundle's executable — never "any process named Metistry", so a scratch bundle never matches the real one. */
export async function runningPids(exec: Exec, appPath: string): Promise<number[]> {
  const r = await exec("pgrep", ["-f", `^${escapeRegex(join(appPath, "Contents", "MacOS"))}/`]);
  if (r.code !== 0) return [];
  return r.stdout
    .split("\n")
    .map((l) => Number.parseInt(l.trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 0);
}

async function writable(dir: string): Promise<boolean> {
  try {
    await access(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** The one resolved app, or why there is none. `explicit` = the owner named it (`--app-path`), so it may be installed fresh. */
export async function resolveAppPath(exec: Exec, env: NodeJS.ProcessEnv, override: string | null | undefined): Promise<{ path: string; info: BundleInfo; explicit: boolean } | { skip: string }> {
  if (override === null) return { skip: "--no-app: the Mac app is left as it is" };
  if (override !== undefined) {
    const path = override.replace(/\/+$/, "");
    if (!existsSync(path)) return { path, info: {}, explicit: true };
    const info = await readBundleInfo(exec, path);
    if (info.id !== APP_BUNDLE_ID) return { skip: `${path} is not Metistry (bundle id ${info.id ?? "unreadable"}, want ${APP_BUNDLE_ID}) — left untouched` };
    return { path, info, explicit: true };
  }
  const candidates = appCandidates(env);
  const notOurs: string[] = [];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const info = await readBundleInfo(exec, path);
    if (info.id === APP_BUNDLE_ID) return { path, info, explicit: false };
    notOurs.push(`${path} (bundle id ${info.id ?? "unreadable"})`);
  }
  if (notOurs.length > 0) return { skip: `${notOurs.join(", ")} is not ${APP_BUNDLE_ID} — left untouched` };
  return { skip: `no ${APP_BUNDLE_NAME} in ${candidates.map(dirname).join(" or ")} — nothing to update (install the DMG once; \`metistry update\` and Sparkle keep it current after that, or pass --app-path)` };
}

export interface UpdateAppOptions {
  productDir: string;
  /** the release the runtime pack just moved to — the app follows it, never "latest" on its own */
  version: string;
  fetchFn: typeof fetch;
  env: NodeJS.ProcessEnv;
  /** `--app-path`; null = `--no-app`; undefined = the default candidates */
  appPath?: string | null | undefined;
  /** `--relaunch`: quit a running copy (SIGTERM, to exactly this bundle's pids) and reopen it after the swap */
  relaunch?: boolean | undefined;
  /** test seam: where the DMG is mounted (default: a fresh dir under the OS temp dir) */
  mountRoot?: string | undefined;
  /** test seam: the wait between "is it gone yet?" polls after a relaunch's SIGTERM */
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

export type AppStatus = "installed" | "current" | "rolled-back" | "skipped" | "failed";

export interface UpdateAppResult {
  status: AppStatus;
  /** the app's version now (or, in a dry run, the one it would be) */
  version?: string | undefined;
  /** what it was before this run */
  from?: string | undefined;
  path?: string | undefined;
  /** the line the summary reads */
  detail: string;
  /** a running copy: relaunched, or still on the old code until the owner reopens it */
  running?: "relaunched" | "needs-relaunch" | undefined;
}

function notWritableHint(dir: string, appPath: string, env: NodeJS.ProcessEnv, version: string): string {
  const home = env.HOME ? join(env.HOME, "Applications", APP_BUNDLE_NAME) : `~/Applications/${APP_BUNDLE_NAME}`;
  return (
    `${dir} is not writable by this user, so ${appPath} was NOT updated (metistry never asks for sudo). Without sudo:\n` +
    `  metistry update --app-path ${home}   # installs ${version} into your own Applications folder\n` +
    `then drag the old ${appPath} to the Trash in Finder (Finder asks an administrator for that, not metistry).`
  );
}

/**
 * Download, verify and swap in the release's app. Never throws: every way it
 * stops short is a note and `status: "failed" | "skipped"`, and
 * the installed app is either the old one, untouched, or the new one, whole.
 */
export async function updateApp(r: StepRunner, o: UpdateAppOptions): Promise<UpdateAppResult> {
  const exec = r.exec;
  const resolved = await resolveAppPath(exec, o.env, o.appPath);
  if ("skip" in resolved) {
    r.note(`app: ${resolved.skip}`);
    return { status: "skipped", detail: resolved.skip };
  }
  const { path: appPath, info } = resolved;
  const want = o.version.replace(/^v/, "");
  const from = info.version;
  const asset = appDmgAssetName(want);

  if (from !== undefined) {
    const cmp = compareVersions(from, want);
    if (cmp === 0) {
      r.note(`app already ${from} (${appPath}) — nothing to download`);
      return { status: "current", version: from, from, path: appPath, detail: `app already ${from}` };
    }
    if (cmp !== undefined && cmp > 0) {
      const detail = `app ${from} is newer than release ${want} — left as it is (Sparkle may have moved it; \`metistry update --rollback\` restores ${previousAppPath(appPath)})`;
      r.note(`app: ${detail}`);
      return { status: "skipped", version: from, from, path: appPath, detail };
    }
  }

  const parent = dirname(appPath);
  if (r.dryRun) {
    r.action(`download ${asset} from the same release and verify its sha256 against checksums.txt`);
    r.action(`hdiutil attach -nobrowse -readonly it; copy ${APP_BUNDLE_NAME} beside ${appPath}; check bundle id ${APP_BUNDLE_ID}, CFBundleShortVersionString == ${want}, and its signature (codesign --verify --deep --strict + spctl --assess when signed)`);
    r.action(`swap: ${appPath} (${from ?? "not installed"}) → ${basename(previousAppPath(appPath))}, ${want} into place; detach`);
    if (existsSync(parent) && !(await writable(parent))) r.note(`app: ${notWritableHint(parent, appPath, o.env, want)}`);
    return { status: "installed", version: want, ...(from ? { from } : {}), path: appPath, detail: `app ${from ?? "∅"} → ${want} (dry run)` };
  }

  let pids: number[] = [];
  try {
    if (resolved.explicit && !existsSync(parent)) await mkdir(parent, { recursive: true });
    if (!(await writable(parent))) {
      const detail = notWritableHint(parent, appPath, o.env, want);
      r.note(`app: ${detail}`);
      return { status: "skipped", ...(from ? { version: from, from } : {}), path: appPath, detail: `${parent} is not writable — app left at ${from ?? "nothing"}` };
    }

    const rel = await resolveRelease({ fetchFn: o.fetchFn, version: want, env: o.env, exec });
    if (!rel.assets[asset]) {
      const detail = `release ${rel.tag} carries no ${asset} — app left at ${from ?? "nothing"} (Sparkle's feed is the other way in)`;
      r.note(`app: ${detail}`);
      return { status: "skipped", ...(from ? { version: from, from } : {}), path: appPath, detail };
    }
    // read before the swap: a copy running now is running the OLD code
    pids = await runningPids(exec, appPath);
    const staging = join(o.productDir, ".app-download");
    r.action(`download ${asset} from ${rel.tag} and verify its sha256 against checksums.txt`);
    const dmg = await downloadVerified(r, { fetchFn: o.fetchFn, repo: releaseRepo(o.env), rel, name: asset, dir: staging, env: o.env, what: "app", unchanged: appPath });
    try {
      await swapInFromDmg(r, { dmg: dmg.path, appPath, want, installedSigned: from !== undefined ? await isSigned(exec, appPath) : false, mountRoot: o.mountRoot });
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  } catch (err) {
    // a refusal (StepFailed) or the filesystem saying no (EACCES on a
    // root-owned bundle, a full disk): either way the product has already
    // moved, so this is a line in the summary and never the update's exit code
    const message = err instanceof Error ? err.message : String(err);
    r.note(`app: NOT updated — ${message}. ${appPath} is ${from ? `still ${from}` : "not installed"}; the rest of the update is unaffected`);
    return { status: "failed", ...(from ? { version: from, from } : {}), path: appPath, detail: `app not updated (${message.split("\n")[0]})` };
  }

  r.note(`app: ${appPath} ${from ?? "∅"} → ${want}${from ? ` (the old one kept at ${previousAppPath(appPath)} for --rollback)` : ""}`);
  const running = await afterSwap(r, { appPath, pids, relaunch: o.relaunch, sleep: o.sleep });
  return { status: "installed", version: want, ...(from ? { from } : {}), path: appPath, detail: `app ${from ?? "∅"} → ${want}`, ...(running ? { running } : {}) };
}

async function swapInFromDmg(r: StepRunner, o: { dmg: string; appPath: string; want: string; installedSigned: boolean; mountRoot?: string | undefined }): Promise<void> {
  const mountpoint = await mkdtemp(join(o.mountRoot ?? tmpdir(), "metistry-app-mount-"));
  const incoming = join(dirname(o.appPath), `.${basename(o.appPath)}.incoming`);
  let attached = false;
  try {
    await r.run("hdiutil", ["attach", "-nobrowse", "-readonly", "-noautoopen", "-mountpoint", mountpoint, o.dmg], { timeoutMs: 5 * 60_000 });
    attached = true;
    const src = join(mountpoint, APP_BUNDLE_NAME);
    if (!existsSync(src)) throw new StepFailed(`${basename(o.dmg)} has no ${APP_BUNDLE_NAME} at its root`);
    // copied BESIDE the installed app — the same volume, so the swap below is
    // two renames and never a half-copied bundle at the real path
    await rm(incoming, { recursive: true, force: true });
    await r.run("ditto", [src, incoming], { timeoutMs: 10 * 60_000 });
    await verifyBundle(r, incoming, o.want, o.installedSigned);
    const prev = previousAppPath(o.appPath);
    await rm(prev, { recursive: true, force: true });
    const had = existsSync(o.appPath);
    if (had) await rename(o.appPath, prev);
    try {
      await rename(incoming, o.appPath);
    } catch (err) {
      if (had) await rename(prev, o.appPath).catch(() => {});
      throw new StepFailed(`could not move the new bundle into place (${err instanceof Error ? err.message : String(err)}) — the old one was put back`);
    }
  } finally {
    await rm(incoming, { recursive: true, force: true }).catch(() => {});
    if (attached) {
      const d = await r.run("hdiutil", ["detach", mountpoint, "-quiet"], { tolerateFailure: true, timeoutMs: 60_000 });
      if (d.code !== 0) await r.run("hdiutil", ["detach", mountpoint, "-force", "-quiet"], { tolerateFailure: true, timeoutMs: 60_000 });
    }
    await rm(mountpoint, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Bundle id, version, signature — on the COPY that is about to be installed,
 * so what was checked is what lands. A signed bundle must pass codesign's
 * strict deep verify AND Gatekeeper; an unsigned one (a local build without
 * a Developer ID) is allowed, said out loud — but never over a signed one,
 * which would trade a notarized app for one nobody vouched for.
 */
export async function verifyBundle(r: StepRunner, app: string, want: string, installedSigned: boolean): Promise<{ signed: boolean }> {
  const info = await readBundleInfo(r.exec, app);
  if (info.id !== APP_BUNDLE_ID) throw new StepFailed(`the DMG's bundle id is ${info.id ?? "unreadable"}, not ${APP_BUNDLE_ID} — refusing to install it`);
  if (info.version !== want) throw new StepFailed(`the DMG's app is ${info.version ?? "unversioned"} (CFBundleShortVersionString), not the release's ${want} — refusing to install it`);
  const signed = await isSigned(r.exec, app);
  if (!signed) {
    if (installedSigned) throw new StepFailed(`the release's app is unsigned and the installed one is signed — refusing to replace a signed app with an unsigned one`);
    r.note(`app: ${want} is UNSIGNED (a local build with no Developer ID) — codesign and Gatekeeper assessment skipped`);
    return { signed: false };
  }
  await r.run("codesign", ["--verify", "--deep", "--strict", app], { timeoutMs: 5 * 60_000 });
  await r.run("spctl", ["--assess", "--type", "execute", app], { timeoutMs: 5 * 60_000 });
  return { signed: true };
}

async function afterSwap(r: StepRunner, o: { appPath: string; pids: number[]; relaunch?: boolean | undefined; sleep?: ((ms: number) => Promise<void>) | undefined }): Promise<UpdateAppResult["running"]> {
  if (o.pids.length === 0) return undefined;
  if (!o.relaunch) {
    r.note(`app: Metistry is running (pid ${o.pids.join(", ")}) on the old code — quit and reopen it to run the new one (\`--relaunch\` does that for you next time)`);
    return "needs-relaunch";
  }
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
  await r.run("kill", ["-TERM", ...o.pids.map(String)], { tolerateFailure: true, comment: "--relaunch: quit exactly this bundle's copy" });
  for (let i = 0; i < 20 && (await runningPids(r.exec, o.appPath)).length > 0; i++) await sleep(500);
  const open = await r.run("open", [o.appPath], { tolerateFailure: true });
  if (open.code !== 0) {
    r.note(`app: quit, but \`open ${o.appPath}\` exited ${open.code} — open it yourself`);
    return "needs-relaunch";
  }
  return "relaunched";
}

/**
 * `metistry update --rollback`'s app half: swap `Metistry.app.previous` back
 * in, and keep what was installed as the new previous — so a second rollback
 * rolls forward again, the way the product's `current`/`.previous` does.
 */
export async function rollbackApp(r: StepRunner, o: { env: NodeJS.ProcessEnv; appPath?: string | null | undefined; relaunch?: boolean | undefined; sleep?: ((ms: number) => Promise<void>) | undefined }): Promise<UpdateAppResult> {
  const resolved = await resolveAppPath(r.exec, o.env, o.appPath);
  if ("skip" in resolved) {
    r.note(`app: ${resolved.skip}`);
    return { status: "skipped", detail: resolved.skip };
  }
  const { path: appPath, info } = resolved;
  const prev = previousAppPath(appPath);
  const prevInfo = await readBundleInfo(r.exec, prev);
  if (prevInfo.id !== APP_BUNDLE_ID) {
    const detail = `no previous app at ${prev} — the app stays ${info.version ?? "as it is"}`;
    r.note(`app: ${detail}`);
    return { status: "skipped", ...(info.version ? { version: info.version } : {}), path: appPath, detail };
  }
  if (!r.action(`swap ${appPath} (${info.version ?? "?"}) with ${basename(prev)} (${prevInfo.version ?? "?"})`)) {
    return { status: "rolled-back", ...(prevInfo.version ? { version: prevInfo.version } : {}), ...(info.version ? { from: info.version } : {}), path: appPath, detail: `app ${info.version ?? "?"} → ${prevInfo.version ?? "?"} (dry run)` };
  }
  if (!(await writable(dirname(appPath)))) {
    const detail = `${dirname(appPath)} is not writable by this user — the app was not rolled back (metistry never asks for sudo)`;
    r.note(`app: ${detail}`);
    return { status: "skipped", ...(info.version ? { version: info.version } : {}), path: appPath, detail };
  }
  const pids = await runningPids(r.exec, appPath);
  const tmp = `${appPath}.rollback`;
  try {
    await rm(tmp, { recursive: true, force: true });
    await rename(appPath, tmp);
    try {
      await rename(prev, appPath);
    } catch (err) {
      await rename(tmp, appPath).catch(() => {});
      throw err;
    }
    await rename(tmp, prev);
  } catch (err) {
    const detail = `app not rolled back (${err instanceof Error ? err.message : String(err)})`;
    r.note(`app: ${detail}`);
    return { status: "failed", ...(info.version ? { version: info.version } : {}), path: appPath, detail };
  }
  r.note(`app: rolled back ${appPath} ${info.version ?? "?"} → ${prevInfo.version ?? "?"} (${info.version ?? "the newer one"} kept at ${prev})`);
  const running = await afterSwap(r, { appPath, pids, relaunch: o.relaunch, sleep: o.sleep });
  return { status: "rolled-back", ...(prevInfo.version ? { version: prevInfo.version } : {}), ...(info.version ? { from: info.version } : {}), path: appPath, detail: `app ${info.version ?? "?"} → ${prevInfo.version ?? "?"}`, ...(running ? { running } : {}) };
}
