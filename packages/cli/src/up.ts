// `metistry up` — an install goes from "a product checkout + .env" to
// running: the compose services, every launchd job ops/launchd ships
// (macOS; Linux gets the systemd equivalents printed as a follow-up), then
// `doctor` decides the exit code. Two modes, read from the instance's
// metistry.lock: `git` builds the images from the checkout, `release`
// pulls the pinned ones and never builds (plan §4.16).

import { existsSync } from "node:fs";
import { join } from "node:path";
import { doctor, renderTable, type DoctorDeps, type DoctorReport } from "./doctor.js";
import type { Exec } from "./exec.js";
import { launchAgentsDir, launchdCommands, loadPlistTemplates, nodeOnPath, renderPlist, renderSystemdUnit } from "./launchd.js";
import { instanceLockPath, readLock, type LockFile, type LockSource } from "./lock.js";
import { currentLink, imageEnv, imageRef, IMAGE_SERVICES } from "./release.js";
import { StepFailed, StepRunner } from "./steps.js";

export interface UpOptions {
  productDir: string;
  env?: NodeJS.ProcessEnv | undefined;
  exec?: Exec | undefined;
  out?: ((line: string) => void) | undefined;
  dryRun?: boolean | undefined;
  /** default true */
  compose?: boolean | undefined;
  /** default true */
  launchd?: boolean | undefined;
  platform?: NodeJS.Platform | undefined;
  uid?: number | undefined;
  home?: string | undefined;
  /** the node binary the plists exec — `__NODE__` (default: the one running this) */
  node?: string | undefined;
  /** test seam for the closing doctor run */
  doctorFn?: ((deps: DoctorDeps) => Promise<DoctorReport>) | undefined;
  doctorDeps?: Partial<DoctorDeps> | undefined;
}

export interface UpResult {
  code: number;
  source: LockSource;
  /** every command/write, in order (dry-run prints exactly this) */
  commands: string[];
}

/** The instance's metistry.lock, when there is an instance dir holding one. */
export async function instanceLock(env: NodeJS.ProcessEnv): Promise<LockFile | undefined> {
  const p = instanceLockPath(env);
  return p ? await readLock(p) : undefined;
}

/** git unless the instance's lock says release; no lock (or no instance dir) is today's mode — a checkout. */
export async function productSource(env: NodeJS.ProcessEnv): Promise<LockSource> {
  return (await instanceLock(env))?.product.source ?? "git";
}

/**
 * Where the product's files actually are. In release mode that is the
 * `current` symlink (`<product-dir>/current` -> `releases/<version>`) once
 * one exists; everywhere else it is the product dir itself — so a checkout,
 * and a release install that predates the symlink, are unchanged.
 */
export function runDirFor(productDir: string, source: LockSource): string {
  return source === "release" && existsSync(currentLink(productDir)) ? currentLink(productDir) : productDir;
}

/** Compose timeouts are generous on purpose: a cold `--build` compiles two images. */
export const COMPOSE_TIMEOUT_MS = 30 * 60 * 1000;

export async function composeUp(r: StepRunner, productDir: string, source: LockSource, version?: string | undefined): Promise<void> {
  if (source === "release") {
    // the released, versioned images — docker-compose.yml reads
    // METISTRY_<SERVICE>_IMAGE and falls back to the dev tags a checkout builds
    const env = version ? { ...r.env, ...imageEnv(version, r.env) } : r.env;
    if (version) r.note(`images: ${IMAGE_SERVICES.map((s) => imageRef(s, version, r.env)).join(", ")}`);
    await r.run("docker", ["compose", "pull"], { cwd: productDir, env, timeoutMs: COMPOSE_TIMEOUT_MS, inherit: true, comment: version ? `pinned to ${version}` : "metistry.lock pins released images" });
    await r.run("docker", ["compose", "up", "-d", "--no-build"], { cwd: productDir, env, timeoutMs: COMPOSE_TIMEOUT_MS, inherit: true });
  } else {
    await r.run("docker", ["compose", "up", "-d", "--build"], { cwd: productDir, timeoutMs: COMPOSE_TIMEOUT_MS, inherit: true });
  }
}

export interface LaunchdEnv {
  platform: NodeJS.Platform;
  uid: number;
  home: string;
  node: string;
}

/** Render every template into ~/Library/LaunchAgents and (re)bootstrap it; on anything but macOS, print the systemd units instead. */
export async function installLaunchd(r: StepRunner, productDir: string, le: LaunchdEnv): Promise<void> {
  const templates = await loadPlistTemplates(productDir);
  if (templates.length === 0) {
    r.note("no ops/launchd/*.plist in this checkout — nothing to install");
    return;
  }
  const values = { repo: productDir, node: le.node };
  if (le.platform !== "darwin") {
    r.note(`no launchd on ${le.platform}: the equivalent systemd user units follow — NOT written (docs/ops/cli.md, "Linux hosts")`);
    r.note("install them by hand: save each to ~/.config/systemd/user/, then systemctl --user daemon-reload && systemctl --user enable --now <unit>");
    for (const t of templates) {
      r.out("");
      r.out(renderSystemdUnit(t, values));
    }
    return;
  }
  const dir = launchAgentsDir(le.home);
  for (const t of templates) {
    const target = join(dir, t.file);
    await r.write(target, renderPlist(t.template, values), `ops/launchd/${t.file}, __REPO__=${productDir}, __NODE__=${le.node}`);
    for (const c of launchdCommands(t.label, target, le.uid)) {
      await r.run(c.cmd, c.args, { tolerateFailure: c.tolerateFailure, comment: c.tolerateFailure ? "ok if not loaded" : undefined });
    }
  }
}

/** The closing doctor: printed in a dry run, executed otherwise; its verdict is the exit code. */
export async function closingDoctor(r: StepRunner, productDir: string, deps: Partial<DoctorDeps> | undefined, doctorFn: (d: DoctorDeps) => Promise<DoctorReport>): Promise<number> {
  r.section("doctor");
  if (!r.action("metistry doctor")) return 0;
  const report = await doctorFn({ productDir, exec: r.exec, env: r.env, ...deps });
  r.out(renderTable(report));
  return report.ok ? 0 : 1;
}

export async function up(opts: UpOptions): Promise<UpResult> {
  const env = opts.env ?? process.env;
  const r = new StepRunner({ dryRun: opts.dryRun === true, out: opts.out ?? ((s) => process.stdout.write(s + "\n")), exec: opts.exec, env });
  const lock = await instanceLock(env);
  const source = lock?.product.source ?? "git";
  // release mode: everything below runs against `current`, so a rollback is a symlink flip
  const runDir = runDirFor(opts.productDir, source);
  const le: LaunchdEnv = {
    platform: opts.platform ?? process.platform,
    uid: opts.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0),
    home: opts.home ?? env.HOME ?? "",
    node: opts.node ?? nodeOnPath(env),
  };
  r.note(`product: ${runDir} (${source === "release" ? `pinned release${lock ? ` ${lock.product.version}` : ""} — images pulled, not built` : "git checkout — images built from source"})`);
  let failure: StepFailed | undefined;

  try {
    if (opts.compose !== false) {
      r.section("compose");
      await composeUp(r, runDir, source, lock?.product.version);
    } else r.note("--no-compose: containers left as they are");

    if (opts.launchd !== false) {
      r.section("launchd");
      if (le.platform === "darwin" && !le.home) throw new StepFailed("HOME is unset — cannot find ~/Library/LaunchAgents");
      await installLaunchd(r, runDir, le);
    } else r.note("--no-launchd: host jobs left as they are");
  } catch (err) {
    if (!(err instanceof StepFailed)) throw err;
    failure = err;
    r.out(`metistry up: ${err.message}`);
  }

  // doctor runs even after a failed step — its table is the diagnosis; the failure keeps the exit code
  const doctorCode = await closingDoctor(r, runDir, opts.doctorDeps, opts.doctorFn ?? doctor);
  return { code: failure ? failure.code || 1 : doctorCode, source, commands: r.commands };
}
