// `metistry update` — move an install forward (plan §4.16: "bumps
// metistry.lock, pulls the pinned artifacts, runs migrations"). In today's
// mode the product is a git checkout: fetch + fast-forward, install +
// build, migrate under the advisory lock, rebuild/restart what changed,
// then pin the result into the INSTANCE repo's metistry.lock — through the
// reconciler bridge, because the reconciler is the instance repo's sole
// committer (docs/ops/reconciler.md). In release mode (the lock says
// `source: release`, or `--channel release`) there is no checkout: the
// release's runtime pack is downloaded, sha256-verified, unpacked under
// `releases/<version>/` and pointed at by `current` (release.ts), the
// versioned images are pulled, never built, and everything after the
// switch runs against `current` — so `--rollback` is a symlink flip.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { INSTANCE_LAYOUT, LEGACY_VAULT_DIR, TEMPLATES_DIR, detectLayout, intEnv, usesCompose, type Deployment, type InstanceLayoutShape, type KeychainBackend } from "@foldedspacelabs/metistry-core";
import { writeCliShim } from "./cli-shim.js";
import { SEED_VAULT_DIR } from "./init.js";
import { loadDeployment } from "./deployment.js";
import { doctor, renderTable, type DoctorDeps, type DoctorReport } from "./doctor.js";
import { productVersion } from "./env.js";
import { envPaths, readInstanceId } from "./instance.js";
import { applyPorts, loadNamespace } from "./namespace.js";
import type { Exec } from "./exec.js";
import { rollbackApp, updateApp, type UpdateAppResult } from "./mac-app.js";
import { labelFor, loadPlistTemplates, loadSupervisedTemplates, type PlistTemplate } from "./launchd.js";
import { SUPERVISOR_SERVICE } from "./supervisor.js";
import { instanceLockPath, readLock, serializeLock, type LockFile, type LockSource } from "./lock.js";
import { ensureOwnerBridgeToken, OWNER_BRIDGE_TOKEN, protectedRel, writeProtected, type ProtectedWrite } from "./protected-write.js";
import { listMigrationFiles, MIGRATION_LOCK_KEY, openMigrationSession, runMigrations, type MigrateResult, type MigrationSession } from "./migrate.js";
import { currentVersion, installRelease, rollbackRelease, releaseTarget, runtimePackCommit, type InstallReleaseResult } from "./release.js";
import { installRuntimeDeps, runtimeDepsEnabled, RUNTIME_DIRNAME, type InstallRuntimeDepsResult } from "./runtime-deps.js";
import { MIGRATE_SCOPE_COMMAND, migrateScope, type MigrateScopeResult } from "./secrets.js";
import { StepFailed, StepRunner } from "./steps.js";
import { type Ui } from "./ui.js";
import { closingDoctor, composeUp, COMPOSE_TIMEOUT_MS, nodeFor, runDirFor } from "./up.js";

export interface UpdateOptions {
  productDir: string;
  env?: NodeJS.ProcessEnv | undefined;
  exec?: Exec | undefined;
  out?: ((line: string) => void) | undefined;
  dryRun?: boolean | undefined;
  skipBuild?: boolean | undefined;
  skipMigrate?: boolean | undefined;
  platform?: NodeJS.Platform | undefined;
  uid?: number | undefined;
  /** the release this checkout is — default: this package's version */
  version?: string | undefined;
  /** override metistry.lock's product.source for this run (`--channel git|release`) */
  channel?: LockSource | undefined;
  /** release mode: install this release instead of the latest (`--version 0.2.0`) */
  releaseVersion?: string | undefined;
  /** release mode: flip `current` back to the previous release instead of installing a new one */
  rollback?: boolean | undefined;
  /** release mode: the runtime pack's os-arch (default: this host's) */
  target?: string | undefined;
  /** `--allow-legacy`: pin a version past 0.8.x onto an instance that has not run `metistry migrate-layout` yet */
  allowLegacy?: boolean | undefined;
  /** `--env-file`: the dotenv file this install runs from (default: `<instance>/state/.env`, falling back to the checkout's) */
  envFile?: string | undefined;
  now?: Date | undefined;
  fetchFn?: typeof fetch | undefined;
  /** test seam: a single-session db handle for the migration runner (null = no db configured) */
  openSession?: ((env: NodeJS.ProcessEnv) => Promise<(MigrationSession & { end(): Promise<void> }) | null>) | undefined;
  doctorFn?: ((deps: DoctorDeps) => Promise<DoctorReport>) | undefined;
  doctorDeps?: Partial<DoctorDeps> | undefined;
  /**
   * How the closing doctor runs. `child` (the default) runs the UPDATED
   * product's own CLI — `node <run-dir>/packages/cli/dist/main.js doctor
   * --json` — so the new manifests are validated by the new schema;
   * `in-process` runs this process's `doctorFn`, which is the PRE-update code.
   * Injecting `doctorFn` or `doctorDeps` (a test's fakes, which a child
   * process cannot receive) selects `in-process` unless this says otherwise.
   */
  closingDoctor?: "child" | "in-process" | undefined;
  /** test seam: the vault bridge's owner bearer, minted once for an install that has none */
  mintOwnerToken?: (() => string) | undefined;
  /** test seam: the login Keychain the shared-scope migration reads and writes (default: `security`, on darwin) */
  keychain?: KeychainBackend | undefined;
  /**
   * release mode, launchd shape, macOS: the Mac app to move with the release
   * (`--app-path`). undefined = `METISTRY_APP_PATH`, else /Applications/Metistry.app,
   * else ~/Applications/Metistry.app; null = `--no-app`, leave it alone (mac-app.ts).
   */
  appPath?: string | null | undefined;
  /** `--relaunch`: quit a running copy of the app and reopen it after the swap — never without this */
  relaunch?: boolean | undefined;
  /** test seam: the wait between polls after `--relaunch` quits the app */
  appSleep?: ((ms: number) => Promise<void>) | undefined;
  /** default true; `false` is a test seam — see `up`'s `cliShim` (cli-shim.ts). `update` writes the same shim `up` does: it shares nothing else with `up`, but a checkout that only ever runs `update` still gets one. */
  cliShim?: boolean | undefined;
}

export interface UpdateResult {
  code: number;
  source: LockSource;
  commands: string[];
  /** the lock as written (or as it would be, in a dry run) */
  lock?: LockFile;
  /** launchd labels kickstarted because their code changed */
  restarted: string[];
  migrations?: MigrateResult;
  /** release mode only: the release now behind `current` */
  release?: InstallReleaseResult;
  /** release mode only: what happened to `<product>/runtime/` (Node, Postgres + pgvector, git) */
  runtimeDeps?: InstallRuntimeDepsResult;
  /** release mode on a launchd Mac: what happened to the Mac app (mac-app.ts) */
  app?: UpdateAppResult;
  /** the directory the rest of the update ran against (`<product-dir>/current` in release mode) */
  runDir: string;
  /** the seed templates the vault lacked, copied in by this run (`Templates/Brief.md`, …) — never one it already had */
  seededTemplates?: SeedTemplatesResult;
  /** the shared-scope migration (plan §2.14), when it ran — names only */
  sharedScope?: MigrateScopeResult;
}

export { RECONCILER_LABEL } from "./protected-write.js";

// ---- the legacy-layout gate ----------------------------------------------------
//
// 0.8.x is the last line that can read a legacy instance. The readers resolve
// both layouts (core's `resolveInstanceLayout`) precisely so that an instance
// which has not run `metistry migrate-layout` keeps working on THIS line —
// and that resolution is compatibility, not a second supported layout. An
// update that pins a later version would move an install onto code nobody
// has run against `Knowledge/` and a root `identity.yaml`.
//
// So the gate is here, at the one verb that moves the pin, and it is a
// refusal rather than a warning: the whole point of enforcing at the tool is
// that "you should migrate first" in a release note is not a control.

/** The last minor line that reads a legacy instance. */
export const LEGACY_LAYOUT_LAST_MINOR = "0.8";

/** `0.8.1` → `[0, 8]`; undefined when `version` is not a plain semver triple (a tag, a hash, `<latest>`). */
function majorMinor(version: string): [number, number] | undefined {
  const m = /^v?(\d+)\.(\d+)(?:\.|$)/.exec(version.trim());
  return m ? [Number(m[1]), Number(m[2])] : undefined;
}

/** True when `version` is later than the last line that reads a legacy instance. An unparseable version is NOT past it — a refusal has to be sure. */
export function pastLegacyLayoutSupport(version: string): boolean {
  const target = majorMinor(version);
  const last = majorMinor(LEGACY_LAYOUT_LAST_MINOR)!;
  if (!target) return false;
  return target[0] > last[0] || (target[0] === last[0] && target[1] > last[1]);
}

/**
 * The one line to print and stop on, or null when this update may proceed.
 * Pure, so the refusal's exact wording is a test rather than a screenshot.
 */
export function legacyLayoutRefusal(opts: { shape: InstanceLayoutShape; instanceDir: string; version: string; allowLegacy?: boolean | undefined }): string | null {
  if (opts.shape !== "legacy" || opts.allowLegacy === true) return null;
  if (!pastLegacyLayoutSupport(opts.version)) return null;
  return (
    `${opts.instanceDir} is on the legacy instance layout (the vault in ${LEGACY_VAULT_DIR}/, the config files at the instance root) and this update would pin ${opts.version}, ` +
    `past the ${LEGACY_LAYOUT_LAST_MINOR}.x line that reads it. Run this first:\n` +
    `  metistry migrate-layout --dry-run   # every move and every row count, nothing run\n` +
    `  metistry migrate-layout\n` +
    `Then \`metistry update\` again. \`--allow-legacy\` pins it anyway (docs/ops/instance-layout.md).`
  );
}

/**
 * The version in `<dir>/package.json` — the CHECKOUT's, which after a pull is
 * the version this update moves the install onto. `productVersion()` cannot
 * answer this: it reads the package this process is running FROM, which is
 * still the pre-pull code.
 */
export async function checkoutVersion(dir: string): Promise<string | undefined> {
  try {
    const v = (JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as { version?: unknown }).version;
    return typeof v === "string" && v !== "" ? v : undefined;
  } catch {
    return undefined;
  }
}

/** `git rev-parse HEAD` in a checkout; undefined when it is not one (or git is missing). */
export async function gitHead(dir: string, exec: Exec): Promise<string | undefined> {
  if (!existsSync(join(dir, ".git"))) return undefined;
  const r = await exec("git", ["rev-parse", "HEAD"], { cwd: dir });
  return r.code === 0 ? r.stdout.trim() : undefined;
}

/** Workspace packages that publish to npm — what a release install would `npm install` (plan §4.16). */
export async function publishedPackages(productDir: string): Promise<string[]> {
  const dir = join(productDir, "packages");
  if (!existsSync(dir)) return [];
  const names: string[] = [];
  for (const entry of (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = join(dir, entry.name, "package.json");
    if (!existsSync(file)) continue;
    try {
      const pkg = JSON.parse(await readFile(file, "utf8")) as { name?: string; private?: boolean };
      if (pkg.name && !pkg.private) names.push(pkg.name);
    } catch {
      /* not a package */
    }
  }
  return names;
}

// ---- "what changed": a content hash of each host job's code ---------------------

/**
 * For `apps/watchdog/dist/main.js` the tracked tree is `apps/watchdog/dist`;
 * for `…/helper/ek-helper.app/Contents/MacOS/ek-helper` it is the whole
 * `…/helper/ek-helper.app` bundle, so a changed Info.plist or signature
 * counts as changed code and not just the Mach-O. Anything else is itself.
 */
export function trackedPathFor(repoPath: string): string {
  const app = repoPath.indexOf(".app/");
  if (app !== -1) return repoPath.slice(0, app + ".app".length);
  const i = repoPath.indexOf("/dist/");
  return i === -1 ? repoPath : repoPath.slice(0, i + "/dist".length);
}

async function hashInto(h: ReturnType<typeof createHash>, root: string, abs: string): Promise<void> {
  const s = await stat(abs);
  if (s.isDirectory()) {
    for (const name of (await readdir(abs)).sort()) await hashInto(h, root, join(abs, name));
    return;
  }
  h.update(relative(root, abs));
  h.update("\0");
  h.update(await readFile(abs));
  h.update("\0");
}

/** One hex digest per host job over the code it executes (sorted paths + bytes); "missing" when nothing is built yet. */
export async function hashHostJobs(productDir: string, templates: PlistTemplate[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const t of templates) {
    const h = createHash("sha256");
    let any = false;
    for (const rel of [...new Set(t.repoPaths.map(trackedPathFor))].sort()) {
      const abs = join(productDir, rel);
      if (!existsSync(abs)) continue;
      any = true;
      await hashInto(h, productDir, abs);
    }
    out[t.label] = any ? h.digest("hex") : "missing";
  }
  return out;
}

/**
 * The jobs `update` may kickstart, with the launchd shape's children folded
 * in.
 *
 * Under that shape there is ONE agent for the core, and the console, the
 * assistant, the reconciler and the bridges are its children — launchd
 * cannot kickstart them. So the supervisor's entry tracks its children's
 * code as well as its own: when a console build changes, the supervisor is
 * kickstarted and every child comes back on the new code. Blunter than
 * restarting the one child that moved, and it is what "they do not keep
 * running old code until the next `metistry up`" actually requires.
 */
export async function templatesForRestart(runDir: string, shape: Deployment["shape"], labelSuffix: string | undefined, env: NodeJS.ProcessEnv): Promise<PlistTemplate[]> {
  const agents = await loadPlistTemplates(runDir, shape, labelSuffix, env);
  if (shape !== "launchd") return agents;
  const children = await loadSupervisedTemplates(runDir, labelSuffix, env);
  const childPaths = [...new Set(children.flatMap((c) => c.repoPaths))];
  return agents.map((t) => (t.service === SUPERVISOR_SERVICE ? { ...t, repoPaths: [...new Set([...t.repoPaths, ...childPaths])] } : t));
}

// ---- the lock write ----------------------------------------------------------------

export type LockDelivery = ProtectedWrite;

/**
 * Where the new lock goes: through the reconciler when one is configured
 * (metistry.lock is a §4.7 protected path — only the `user` principal may
 * write it), else directly into a local instance dir. protected-write.ts
 * holds the policy, which `identity.yaml`'s `instance_id` shares.
 */
export async function writeLock(r: StepRunner, lock: LockFile, opts: { env: NodeJS.ProcessEnv; platform: NodeJS.Platform; uid: number; fetchFn: typeof fetch; instanceDir?: string | undefined }): Promise<LockDelivery> {
  const rel = protectedRel(opts.instanceDir ?? opts.env.METISTRY_INSTANCE_DIR, "lock");
  const delivery = await writeProtected(r, rel, serializeLock(lock), `metistry update → ${lock.product.version}`, opts);
  if (delivery.how === "none") r.note(`no METISTRY_INSTANCE_DIR — ${rel} not written (metistry init creates the instance repo)`);
  return delivery;
}

// ---- the command --------------------------------------------------------------------

export async function update(opts: UpdateOptions): Promise<UpdateResult> {
  const env = opts.env ?? process.env;
  const r = new StepRunner({ dryRun: opts.dryRun === true, out: opts.out ?? ((s) => process.stdout.write(s + "\n")), exec: opts.exec, env });
  const platform = opts.platform ?? process.platform;
  const uid = opts.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0);
  const version = opts.version ?? productVersion();
  const now = opts.now ?? new Date();
  const fetchFn = opts.fetchFn ?? fetch;
  const openSession = opts.openSession ?? openMigrationSession;
  const productDir = opts.productDir;

  // compose interpolates from `./.env` unless told otherwise, and this
  // install's environment now lives in the instance (`state/.env`)
  const instanceDir = env.METISTRY_INSTANCE_DIR ? { instanceDir: env.METISTRY_INSTANCE_DIR.replace(/\/+$/, "") } : {};
  const envPathsFound = envPaths({ ...instanceDir, productDir, ...(opts.envFile ? { explicit: opts.envFile } : {}) });
  const envFile = envPathsFound?.read[0] ?? envPathsFound?.write;

  const lockPath = instanceLockPath(env);
  const prior = lockPath ? await readLock(lockPath) : undefined;
  const source = opts.channel ?? prior?.product.source ?? "git";
  const restarted: string[] = [];
  /** jobs whose kickstart was tried and failed — never counted as restarted (#287), and never as "nothing changed" either */
  const kickFailed: Array<{ label: string; code: number }> = [];
  let migrations: MigrateResult | undefined;
  let lock: LockFile | undefined;
  let failure: StepFailed | undefined;
  let release: InstallReleaseResult | undefined;
  let runtimeDeps: InstallRuntimeDepsResult | undefined;
  let app: UpdateAppResult | undefined;
  let sharedScope: MigrateScopeResult | undefined;
  let seededTemplates: SeedTemplatesResult | undefined;
  // release mode swings this to `<product-dir>/current` once the switch is done
  let runDir = runDirFor(productDir, source);
  let releaseVersion = version;
  // the shape decides both halves of "restart": whether there are containers at
  // all, and which plists exist (under launchd, console/assistant/db are jobs)
  const loaded = await loadDeployment(runDir, env);
  const deployment = loaded.deployment;
  // A namespaced instance's jobs carry its label suffix, and its Postgres is
  // on its own port. BOTH halves matter here: `update` kickstarts the labels
  // THIS instance installed, and — the dangerous one — its migration runner
  // must connect to THIS instance's database. Without the port block applied,
  // METISTRY_DB_PORT falls back to 5432 and `update` would run this
  // instance's migrations against the DEFAULT install's Postgres (2026-09-10
  // trial: caught only because the two passwords differed).
  const ns = await loadNamespace(env.METISTRY_INSTANCE_DIR);
  const labelSuffix = ns?.labelSuffix;
  if (ns) applyPorts(env, ns);
  // hashed before the build/switch and again after: only jobs whose code moved are kickstarted
  let before = await hashHostJobs(runDir, await templatesForRestart(runDir, deployment.shape, labelSuffix, env));

  // The legacy-layout gate, asked with whatever version is knowable at the
  // time. In release mode that is `--version` (or "latest", which is not a
  // number and so never refuses) and this is the whole check. In git mode
  // the version this run moves the install ONTO is only knowable after the
  // pull — the process is running the pre-pull code — so it is asked again
  // below, with the checkout's own package.json re-read off disk, while
  // nothing has been built, migrated or restarted.
  const gate = (v: string): void => {
    const dir = env.METISTRY_INSTANCE_DIR?.replace(/\/+$/, "");
    if (!dir) return;
    const refusal = legacyLayoutRefusal({ shape: detectLayout(dir), instanceDir: dir, version: v, allowLegacy: opts.allowLegacy });
    if (refusal) throw new StepFailed(refusal);
  };

  // The Mac app follows the release the pack just moved to (mac-app.ts). Only
  // where the app is the install's front end — macOS, launchd shape — and it
  // can never fail the update: the product has already moved.
  const macApp = async (v: string): Promise<UpdateAppResult | undefined> => {
    if (platform !== "darwin") return undefined;
    r.section("app");
    if (deployment.shape !== "launchd") {
      r.note(`shape ${deployment.shape}: the Mac app is not moved by update — Sparkle keeps it current`);
      return undefined;
    }
    const appOpts = { env, appPath: opts.appPath, relaunch: opts.relaunch, sleep: opts.appSleep };
    return opts.rollback ? await rollbackApp(r, appOpts) : await updateApp(r, { ...appOpts, productDir, version: v, fetchFn });
  };

  try {
    gate(opts.releaseVersion ?? version);

    r.section("product");
    r.note(`${productDir} — ${source === "git" ? "git checkout: fast-forward to the remote" : "release: download the pinned runtime pack"}${prior ? ` (lock: ${prior.product.version} @ ${prior.product.commit.slice(0, 7)}, ${prior.updated_at})` : " (no metistry.lock yet)"}`);
    r.note(`shape: ${deployment.shape} — from ${loaded.from}`);
    if (source === "git") {
      if (opts.rollback) throw new StepFailed("--rollback is release mode only — a checkout rolls back with git (git -C <checkout> checkout <tag> && metistry update --skip-migrate)");
      if (existsSync(join(productDir, ".git"))) {
        await r.run("git", ["fetch", "--quiet"], { cwd: productDir, timeoutMs: 120_000 });
        await r.run("git", ["pull", "--ff-only", "--quiet"], { cwd: productDir, timeoutMs: 120_000 });
      } else r.note("not a git checkout (no .git) — nothing to pull");
      // the pull has landed; this is the first moment the new version exists
      // on disk. It is read from the CHECKOUT, not from this process: the
      // running code is the pre-pull code, and `productVersion()` reports
      // that. Undefined (no package.json, no version) does not refuse.
      const pulled = await checkoutVersion(productDir);
      if (pulled) {
        gate(pulled);
        // …and it is also the version this run PINS. `version` is what THIS
        // process was built from — the pre-pull code — so a checkout that
        // fast-forwarded 0.8.1 → 0.9.0 wrote 0.8.1 into metistry.lock and
        // left the install claiming a version it is not running (#198,
        // "not fixed here" #3). Read after the pull, from the checkout.
        if (pulled !== releaseVersion) r.note(`version: ${releaseVersion} → ${pulled} — read from ${productDir}/package.json after the pull (this process is the pre-pull code), and pinned into metistry.lock`);
        releaseVersion = pulled;
      }
    } else if (r.dryRun) {
      // a dry run reaches nothing, GitHub included — so the version it prints is the request, not a resolved tag
      const want = opts.releaseVersion ?? "<latest>";
      if (opts.rollback) r.action(`switch ${productDir}/current (now ${(await currentVersion(productDir)) ?? "unset"}) back to the previous release — no download, and migrations are not reverted`);
      else {
        r.action(`resolve release ${want} of ${env.METISTRY_RELEASE_REPO ?? "foldedspacelabs/metistry"} and download metistry-runtime-${want}-${opts.target ?? releaseTarget(platform)}.tar.gz`);
        r.action(`verify its sha256 against checksums.txt, unpack to ${productDir}/releases/${want}/ and point current at it`);
        r.action(`download metistry-runtime-deps-${want}-${opts.target ?? releaseTarget(platform)}.tar.gz the same way and unpack it to ${productDir}/${RUNTIME_DIRNAME}/ (Node, Postgres + pgvector, git)`);
      }
      app = await macApp(want);
    } else {
      release = opts.rollback ? await rollbackRelease(r, productDir) : await installRelease(r, { productDir, fetchFn, env, version: opts.releaseVersion, ...(opts.target ? { target: opts.target } : {}) });
      releaseVersion = release.version;
      runDir = runDirFor(productDir, source);
      before = await hashHostJobs(runDir, await templatesForRestart(runDir, deployment.shape, labelSuffix, env));
      // the bundled runtime moves with the release — a new Node, Postgres or
      // git arrives inside its deps pack (docs/ops/bundled-runtime.md). A
      // rollback keeps the runtime it has: it is a superset, not a downgrade.
      if (!opts.rollback && runtimeDepsEnabled(env)) {
        runtimeDeps = await installRuntimeDeps(r, { productDir, fetchFn, env, version: releaseVersion, ...(opts.target ? { target: opts.target } : {}) });
        if (!runtimeDeps.installed) r.note(`${RUNTIME_DIRNAME}/: unchanged — ${runtimeDeps.reason}`);
      }
      app = await macApp(releaseVersion);
    }

    const templates = await templatesForRestart(runDir, deployment.shape, labelSuffix, env);

    r.section("build");
    if (opts.skipBuild) r.note("--skip-build: using what is in dist/ now");
    else if (source === "git") {
      await r.run("pnpm", ["install", "--frozen-lockfile"], { cwd: productDir, timeoutMs: COMPOSE_TIMEOUT_MS, inherit: true });
      await r.run("pnpm", ["-r", "build"], { cwd: productDir, timeoutMs: COMPOSE_TIMEOUT_MS, inherit: true });
    } else r.note("release mode: the runtime pack is compiled output — nothing to build");

    r.section("migrations");
    const migrationsDir = join(runDir, "db", "migrations");
    if (opts.skipMigrate) r.note("--skip-migrate: schema_migrations left as it is (doctor will say if anything is pending)");
    else if (opts.rollback) r.note("--rollback: migrations are additive-first and are NOT reverted — the schema stays ahead of the code (docs/ops/releases.md)");
    else {
      const files = await listMigrationFiles(migrationsDir);
      if (r.action(`apply db/migrations/*.sql not yet in schema_migrations (${files.length} on disk) under pg_advisory_lock(${MIGRATION_LOCK_KEY}), one transaction each`)) {
        const session = await openSession(env);
        if (!session) throw new StepFailed("METISTRY_DB_PASSWORD is unset — cannot migrate; set METISTRY_DB_* in .env (or --skip-migrate)");
        try {
          migrations = await runMigrations(session, migrationsDir, (l) => r.note(l));
        } catch (err) {
          throw new StepFailed(err instanceof Error ? err.message : String(err));
        } finally {
          await session.end().catch(() => {});
        }
        r.note(`migrations: ${migrations.applied.length} applied, ${migrations.files.length} total`);
      }
    }

    r.section("restart");
    // BEFORE anything is kickstarted, because the reconciler reads `.env` at
    // start and the lock write below is a §4.7 protected path: the owner
    // bearer has to be in the environment the restarted job inherits, or the
    // install would have to be told to run a command. An install that already
    // has one spends nothing here (docs/ops/auth.md).
    const knownInstanceId = instanceDir.instanceDir ? await readInstanceId(instanceDir.instanceDir).catch(() => undefined) : undefined;
    const ownerBearer = await ensureOwnerBridgeToken(r, {
      env,
      envFile,
      platform,
      // filed under THIS instance's Keychain account when it has an id, so a
      // later `metistry secrets purge` takes it with the instance
      ...(knownInstanceId ? { instanceId: knownInstanceId } : {}),
      ...(opts.mintOwnerToken ? { mint: opts.mintOwnerToken } : {}),
    });
    r.note(ownerBearer.detail);
    if (usesCompose(deployment)) await composeUp(r, runDir, source, source === "release" ? releaseVersion : undefined, envFile);
    else r.note("shape launchd: no containers, so docker is never called — console, assistant and db are kickstarted below with the other host jobs");
    if (platform === "darwin") {
      const after = await hashHostJobs(runDir, templates);
      for (const t of templates) {
        const changed = before[t.label] !== after[t.label];
        if (r.dryRun) {
          // the db job execs the Postgres toolchain, not this repo's code, so it
          // tracks nothing here — an update never bounces the database
          const tracked = [...new Set(t.repoPaths.map(trackedPathFor))];
          await r.run("launchctl", ["kickstart", "-k", `gui/${uid}/${t.label}`], { comment: tracked.length ? `only if ${tracked.join(", ")} changed` : "no product code of its own — never kickstarted by update" });
        }
        else if (changed) {
          // tolerated so one job cannot stop the update, but only a kickstart
          // that SUCCEEDED counts: `restarted` is what the summary reports as
          // "kickstarted", and a job that failed was not
          const k = await r.run("launchctl", ["kickstart", "-k", `gui/${uid}/${t.label}`], { tolerateFailure: true, comment: "code changed" });
          if (k.code === 0) restarted.push(t.label);
          else {
            kickFailed.push({ label: t.label, code: k.code });
            r.note(`${t.label}: kickstart exited ${k.code} — not restarted; \`metistry doctor\` shows its state`);
          }
        }
      }
      // A freshly minted owner bearer is only real once the reconciler has
      // read it. Usually its code moved in the same update and the loop above
      // already bounced it; when it did not, this is the difference between
      // an update that works and one that 401s on its own lock write.
      if (!r.dryRun && ownerBearer.minted) {
        const label = labelFor(deployment.shape === "launchd" ? SUPERVISOR_SERVICE : "reconciler", labelSuffix);
        if (!restarted.includes(label)) {
          const k = await r.run("launchctl", ["kickstart", "-k", `gui/${uid}/${label}`], { tolerateFailure: true, comment: `so it reads the freshly minted ${OWNER_BRIDGE_TOKEN}` });
          if (k.code === 0) restarted.push(label);
          else {
            kickFailed.push({ label, code: k.code });
            r.note(`${label}: kickstart exited ${k.code} — not restarted, so it has not read ${OWNER_BRIDGE_TOKEN} yet`);
          }
        }
      }
      // "nothing changed" only when nothing was TRIED: a job whose code moved
      // and whose kickstart failed is the opposite of nothing changing
      if (!r.dryRun && restarted.length === 0) r.note(kickFailed.length === 0 ? "no host job's code changed — nothing kickstarted" : `nothing kickstarted — ${kickFailed.map((f) => `kickstart of ${f.label} failed (exit ${f.code})`).join("; ")}`);
    } else r.note(`no launchd on ${platform}: restart the host units yourself (systemctl --user restart <unit>)${ownerBearer.minted ? ` — the reconciler must be restarted for ${OWNER_BRIDGE_TOKEN} to take effect, or the lock write below is refused` : ""}`);

    r.section("lock");
    const head = r.dryRun || source === "release" ? undefined : await gitHead(productDir, r.exec);
    // release mode never git-pulls, so there is no HEAD to read — the pack's own
    // manifest (written by pack-runtime.sh) is the only honest source for the commit
    // it was built from; a pack from before that field shipped falls through below.
    const packCommit = !r.dryRun && release ? await runtimePackCommit(release.dir) : undefined;
    lock = {
      product: { version: releaseVersion, commit: head ?? packCommit ?? (source === "git" && r.dryRun ? "<HEAD after pull>" : (prior?.product.commit ?? "unknown")), source },
      updated_at: now.toISOString(),
      migrations_applied: migrations?.recorded ?? prior?.migrations_applied ?? [],
    };
    const delivery = await writeLock(r, lock, { env, platform, uid, fetchFn });
    r.note(delivery.detail);

    // A template a release adds (Templates/Brief.md in 0.14) reached only a
    // FRESH init — `update` never looked at the vault, so an upgraded one
    // never got it and the routine that reads it skipped every morning (W2
    // checkpoint D1). After the lock because, like the lock, it goes through
    // the reconciler as the owner, which the restart above has just handed
    // the owner bearer. Absent files only: the owner's templates are theirs.
    r.section("templates");
    seededTemplates = await seedTemplates(r, { seedDir: join(runDir, "seed"), instanceDir: instanceDir.instanceDir, env, platform, uid, fetchFn });

    // After the lock, because it writes secrets.yaml through the same
    // reconciler as the owner, which the restart above has just given the
    // owner bearer. It can never fail the update: an instance that has not
    // migrated keeps running exactly as before (its .env still carries the
    // values), and every way it can stop short ends in the one command.
    r.section("secrets");
    sharedScope = await updateSharedScope(r, { instanceDir: instanceDir.instanceDir, envFile, exampleFile: join(runDir, ".env.example"), env, platform, uid, fetchFn, exec: opts.exec, keychain: opts.keychain });

    // `update` shares no code path with `up` (it never renders a plist or
    // touches the supervisor), so a checkout that only ever runs `update`
    // still needs this written — but, like everything else in this block,
    // not once a step above has failed (nothing runs "after the failure"
    // except doctor's diagnosis, below).
    if (opts.cliShim !== false) {
      r.section("cli");
      await writeCliShim(r, productDir, instanceDir.instanceDir);
    }
  } catch (err) {
    if (!(err instanceof StepFailed)) throw err;
    failure = err;
    r.out(`${r.ui.paint("failed", `${r.ui.icon("fail")} metistry update`)}: ${err.message}`);
  }

  const mode = opts.closingDoctor ?? (opts.doctorFn || opts.doctorDeps ? "in-process" : "child");
  const doctorCode =
    mode === "child"
      ? await childClosingDoctor(r, { productDir, runDir, envFile: opts.envFile, doctorDeps: opts.doctorDeps, doctorFn: opts.doctorFn ?? doctor })
      : await closingDoctor(r, runDir, opts.doctorDeps, opts.doctorFn ?? doctor);
  const code = failure ? failure.code || 1 : doctorCode;
  r.out("");
  r.out(updateSummary({ ui: r.ui, dryRun: r.dryRun, failure, code, source, version: lock?.product.version ?? releaseVersion, migrations, restarted, kickstartFailed: kickFailed.length, app }));
  return { code, source, runDir, commands: r.commands, ...(lock ? { lock } : {}), restarted, ...(migrations ? { migrations } : {}), ...(release ? { release } : {}), ...(runtimeDeps ? { runtimeDeps } : {}), ...(app ? { app } : {}), ...(sharedScope ? { sharedScope } : {}), ...(seededTemplates ? { seededTemplates } : {}) };
}

// ---- seed templates the vault lacks ---------------------------------------------------

export interface SeedTemplatesResult {
  /** vault-relative paths written (or, in a dry run, that would be) — each one the vault did not have */
  copied: string[];
  /** seed templates the vault already had: left byte for byte as they are */
  kept: string[];
}

/**
 * Copy every `seed/vault/Templates/*.md` the instance's vault does NOT have.
 *
 * `metistry init` stamps the seed's templates once; a template a later
 * release adds therefore reached only fresh installs, and the routine that
 * reads it skipped on every upgraded one (W2 checkpoint D1: `Templates/Brief.md`,
 * `skipped:template_missing` every morning). This is the other half of
 * init's `keepExisting`: what is genuinely missing is copied, and a file that
 * is there — whatever it says, edited or not — is never touched. The owner's
 * templates are theirs (invariant 2).
 *
 * Each copy goes through the reconciler as `user` when a bridge is
 * configured, create-only (the bridge's own compare-and-swap refuses to
 * replace a file that appeared in between), else directly into a local vault
 * — the same policy as every other file `update` writes (protected-write.ts).
 * Idempotent: a second run finds nothing missing and writes nothing. It never
 * fails the update — a template it could not write is named, with the rerun.
 */
export async function seedTemplates(
  r: StepRunner,
  o: { seedDir: string; instanceDir: string | undefined; env: NodeJS.ProcessEnv; platform: NodeJS.Platform; uid: number; fetchFn: typeof fetch },
): Promise<SeedTemplatesResult> {
  const result: SeedTemplatesResult = { copied: [], kept: [] };
  let failed = 0;
  const dir = o.instanceDir?.replace(/\/+$/, "");
  if (!dir) {
    r.note("templates: no METISTRY_INSTANCE_DIR — no vault to seed");
    return result;
  }
  const shape = detectLayout(dir);
  if (shape !== "flat") {
    r.note(`templates: ${dir} is on the ${shape} layout — not seeded (\`metistry migrate-layout\` first; the vault is at the instance root after it)`);
    return result;
  }
  const from = join(o.seedDir, SEED_VAULT_DIR, TEMPLATES_DIR);
  let names: string[];
  try {
    names = (await readdir(from)).filter((f) => f.endsWith(".md")).sort();
  } catch {
    r.note(`templates: no seed templates at ${from} — nothing to seed`);
    return result;
  }
  for (const name of names) {
    const rel = `${TEMPLATES_DIR}/${name}`;
    if (existsSync(join(dir, rel))) {
      result.kept.push(rel);
      continue;
    }
    try {
      const content = await readFile(join(from, name), "utf8");
      const delivery = await writeProtected(r, rel, content, `metistry update: seed ${rel} (the vault did not have it)`, {
        env: o.env,
        platform: o.platform,
        uid: o.uid,
        fetchFn: o.fetchFn,
        instanceDir: dir,
        createOnly: true,
      });
      if (delivery.kept) result.kept.push(rel);
      else result.copied.push(rel);
      r.note(`templates: ${delivery.kept ? "kept" : "seeded"} ${rel} — ${delivery.detail}`);
    } catch (err) {
      if (!(err instanceof StepFailed)) throw err;
      failed++;
      r.note(`templates: ${rel} was NOT seeded (${err.message}) — the update is unaffected; rerun \`metistry update\` once that is fixed`);
    }
  }
  if (result.copied.length === 0 && failed === 0) r.note(`templates: the vault has all ${names.length} seed template(s) — nothing copied`);
  return result;
}

// ---- the closing doctor, run by the NEW code ------------------------------------------

/** Doctor probes every bridge, job and container; the default exec timeout (15 s) is not enough for that. A slow machine raises METISTRY_CHILD_DOCTOR_TIMEOUT_MS. */
export const CHILD_DOCTOR_TIMEOUT_MS = intEnv("METISTRY_CHILD_DOCTOR_TIMEOUT_MS", 5 * 60 * 1000);

/** The updated product's CLI entry point — the same file the `metistry` shim execs (cli-shim.ts). */
export function updatedCliMain(runDir: string): string {
  return join(runDir, "packages", "cli", "dist", "main.js");
}

/** A `doctor --json` document, or undefined when `stdout` is not one — never a guess at a half-written report. */
export function parseDoctorJson(stdout: string): DoctorReport | undefined {
  try {
    const v = JSON.parse(stdout) as Partial<DoctorReport> | null;
    if (!v || typeof v !== "object" || typeof v.ok !== "boolean" || !Array.isArray(v.rows)) return undefined;
    return v as DoctorReport;
  } catch {
    return undefined;
  }
}

/**
 * `update`'s closing doctor, run as a child process of the UPDATED product's
 * CLI. This process is the pre-update code: its manifest schema, its row
 * set, its idea of what a healthy install looks like are all the version the
 * update just moved AWAY from. Run in-process, an update that changes the
 * manifest schema validates the new manifests with the old schema and ends
 * "updated, and doctor is not happy" although a standalone `metistry doctor`
 * is clean (W1 checkpoint, 0.12.0 → 0.13.0).
 *
 * Same exit semantics as the in-process doctor: 0 when the report is ok, 1
 * otherwise. When there is no CLI to run (nothing built at `runDir`), or it
 * cannot be spawned, or it does not print a report, this falls back to the
 * in-process doctor — and says so, because that answer comes from the old
 * code.
 */
export async function childClosingDoctor(
  r: StepRunner,
  o: { productDir: string; runDir: string; envFile?: string | undefined; doctorDeps?: Partial<DoctorDeps> | undefined; doctorFn: (d: DoctorDeps) => Promise<DoctorReport>; exists?: ((p: string) => boolean) | undefined },
): Promise<number> {
  const exists = o.exists ?? existsSync;
  const main = updatedCliMain(o.runDir);
  const inProcess = async (why: string): Promise<number> => {
    r.note(`closing doctor: ${why} — running this process's doctor instead, which is the PRE-update code; if it disagrees with the new release, a standalone \`metistry doctor\` is the truth`);
    const report = await o.doctorFn({ productDir: o.runDir, exec: r.exec, env: r.env, ...o.doctorDeps });
    r.out(renderTable(report, r.ui));
    return report.ok ? 0 : 1;
  };

  r.section("doctor");
  if (r.dryRun) {
    r.action("metistry doctor");
    return 0;
  }
  if (!exists(main)) return inProcess(`no updated CLI at ${main}`);
  // the bundled runtime's node when there is one — a release may have just
  // brought a newer one — else the node on PATH, else this one
  const { node } = nodeFor(o.productDir, r.env, exists);
  const args = [main, "doctor", "--json", "--product-dir", o.runDir, ...(o.envFile ? ["--env-file", o.envFile] : [])];
  let res: { code: number; stdout: string; stderr: string };
  try {
    // exit 1 is "doctor is not happy", a verdict — not a failed step
    res = await r.run(node, args, { tolerateFailure: true, timeoutMs: CHILD_DOCTOR_TIMEOUT_MS, comment: "the updated CLI's doctor: the new manifests, read by the new schema" });
  } catch (err) {
    return inProcess(`could not run the updated CLI (${err instanceof Error ? err.message : String(err)})`);
  }
  const report = parseDoctorJson(res.stdout);
  if (!report) {
    const detail = (res.stderr || res.stdout).trim().split("\n").slice(-1)[0] ?? "";
    return inProcess(`the updated CLI's doctor exited ${res.code} without a report${detail ? ` (${detail.slice(0, 200)})` : ""}`);
  }
  r.out(renderTable(report, r.ui));
  return report.ok ? 0 : 1;
}

// ---- the shared scope (plan §2.14, T4-3) ---------------------------------------------

/**
 * `metistry secrets migrate-scope`, run by `update` — never able to fail it.
 * A dry run reaches no Keychain; an instance with no id, a host with no
 * Keychain, or a migration that stops short each print why and the exact
 * command to finish it by hand.
 */
export async function updateSharedScope(
  r: StepRunner,
  o: { instanceDir: string | undefined; envFile: string | undefined; exampleFile: string; env: NodeJS.ProcessEnv; platform: NodeJS.Platform; uid: number; fetchFn: typeof fetch; exec?: Exec | undefined; keychain?: KeychainBackend | undefined },
): Promise<MigrateScopeResult | undefined> {
  if (!o.instanceDir) {
    r.note("shared scope: no METISTRY_INSTANCE_DIR — no instance to migrate");
    return undefined;
  }
  const command = `${MIGRATE_SCOPE_COMMAND} --instance ${o.instanceDir}`;
  if (r.dryRun) {
    r.note(`shared scope: would run \`${command}\` — copy the per-user originals into this instance (nothing deleted); a dry run asks the Keychain nothing`);
    return undefined;
  }
  const instanceId = await readInstanceId(o.instanceDir).catch(() => undefined);
  if (!instanceId) {
    r.note(`shared scope: ${o.instanceDir} has no instance_id yet, so there is no account to copy into — once it has one, run \`${command}\``);
    return undefined;
  }
  if (o.platform !== "darwin" && !o.keychain) {
    r.note(`shared scope: no login Keychain on ${o.platform} — nothing to migrate`);
    return undefined;
  }
  try {
    const res = await migrateScope({
      instanceDir: o.instanceDir,
      instanceId,
      envFile: o.envFile,
      exampleFile: o.exampleFile,
      env: o.env,
      platform: o.platform,
      uid: o.uid,
      fetchFn: o.fetchFn,
      exec: o.exec,
      keychain: o.keychain,
      out: (l) => r.note(l),
    });
    if (res.unreadable.length > 0) r.note(`shared scope: ${res.unreadable.map((u) => u.from).join(", ")} not copied — run \`${command}\` from Terminal and allow the Keychain prompt`);
    return res;
  } catch (err) {
    r.note(`shared scope: not migrated (${err instanceof Error ? err.message : String(err)}) — the update is unaffected; run \`${command}\``);
    return undefined;
  }
}

/**
 * The one line to read when the rest has scrolled past: did it land, on what
 * version, and what moved. Deliberately last, after doctor's own table —
 * this is the verdict, not a heading (docs/ops/cli-style.md).
 */
export function updateSummary(s: {
  ui: Ui;
  dryRun: boolean;
  failure?: StepFailed | undefined;
  code: number;
  source: LockSource;
  version: string;
  migrations?: { applied: string[] } | undefined;
  restarted: string[];
  /** kickstarts that were tried and failed */
  kickstartFailed?: number | undefined;
  /** the Mac app's half, when it ran — a skip is not news, so it is not summarised */
  app?: UpdateAppResult | undefined;
}): string {
  const { ui } = s;
  if (s.dryRun) return `${ui.paint("skipped", `${ui.icon("off")} dry run`)} ${ui.dim(`— ${s.source} ${s.version}, nothing was changed`)}`;
  const verdict = s.failure
    ? ui.paint("failed", `${ui.icon("fail")} update failed`)
    : s.code === 0
      ? ui.paint("ok", `${ui.icon("ok")} update ok`)
      : ui.paint("degraded", `${ui.icon("warn")} updated, and doctor is not happy`);
  const parts = [
    `${s.source} ${s.version}`,
    s.migrations ? `${s.migrations.applied.length} migration(s) applied` : "no migrations",
    s.restarted.length > 0 ? `${s.restarted.length} job(s) kickstarted` : "nothing kickstarted",
    ...((s.kickstartFailed ?? 0) > 0 ? [`${s.kickstartFailed} kickstart(s) failed`] : []),
    ...(s.app && s.app.status !== "skipped" ? [`${s.app.detail}${s.app.running === "needs-relaunch" ? " (reopen it)" : ""}`] : []),
  ];
  return `${verdict} ${ui.dim(`— ${parts.join(", ")}`)}`;
}
