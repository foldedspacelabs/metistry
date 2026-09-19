// `metistry up` — an install goes from "a product checkout + .env" to
// running. WHAT it starts is the same in every shape; WHERE depends on
// `deployment.yaml` (open decision 15):
//
//   compose  docker compose for db/console/assistant, launchd for the host
//            jobs. The default, and unchanged by this file's existence.
//   launchd  no docker at all: a user-space Postgres is initialised and
//            supervised by launchd, and console, assistant, reconciler and
//            watchdog are launchd jobs — the assistant under the sandbox
//            profile that replaces the container boundary it gives up.
//
// Then `doctor` decides the exit code. Two product modes, read from the
// instance's metistry.lock: `git` builds the images from the checkout,
// `release` pulls the pinned ones and never builds (plan §4.16).

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  COMPUTE_FILENAME,
  KEEP_AWAKE_ENV,
  emptyCompute,
  instanceFile,
  intEnv,
  keepAwakeOf,
  loadCompute,
  servedProviders,
  usesCompose,
  type ChildSpecInput,
  type Compute,
  type Deployment,
} from "@foldedspacelabs/metistry-core";
import { assistantEnv, consoleEnv, consolePort, dbPort, engineAbsentNote, engineStatus, instanceVars, loadDeployment, type ShapeContext } from "./deployment.js";
import { doctor, renderTable, type DoctorDeps, type DoctorReport } from "./doctor.js";
import type { Exec } from "./exec.js";
import {
  awaitBootout,
  GIT_SPAWNING_SERVICES,
  LABEL_PREFIX,
  labelFor,
  launchAgentsDir,
  launchdCommands,
  loadedLabels,
  loadPlistTemplates,
  logPathFor,
  loadSupervisedTemplates,
  SUPERVISOR_PLIST_FILE,
  nodeOnPath,
  parseRegistrar,
  registrarPhrase,
  renderPlist,
  renderSystemdUnit,
  retiredServicesFor,
  withEnvironmentVariables,
  type PlistTemplate,
  type PlistValues,
} from "./launchd.js";
import { writeCliShim } from "./cli-shim.js";
import { pinTccHelpers } from "./tcc-pin.js";
import {
  childFromRenderedPlist,
  launchdBaseEnv,
  mintControlToken,
  readSupervisorConfig,
  serializeSupervisorConfig,
  supervisorBinPath,
  supervisorConfig,
  supervisorConfigPath,
  supervisorLauncherEnvPath,
  serializeLauncherEnv,
  supervisorSocketPath,
  SUPERVISOR_SERVICE,
} from "./supervisor.js";
import { shellUnsafeEnvLines } from "./env.js";
import { ensureInstanceId, envPaths } from "./instance.js";
import { allocateBase, applyPorts, loadNamespace, portEnv, PORTED_SERVICES, portsFile, portsOf, serializeNamespace, suffixFor, type Namespace } from "./namespace.js";
import { llamaServerChild } from "./local-models.js";
import { instanceLockPath, readLock, type LockFile, type LockSource } from "./lock.js";
import { currentLink, imageEnv, imageRef, IMAGE_SERVICES } from "./release.js";
import { installRuntimeDeps, pathWithRuntimeGit, runtimeDepsEnabled, runtimeNodeBin, RUNTIME_DIRNAME } from "./runtime-deps.js";
import {
  applyManagedBlock,
  findPgToolchain,
  pgCandidates,
  pgDataDir,
  pgIsReady,
  pgSocketDir,
  planPostgresBootstrap,
  planPostgresDatabase,
  socketPathTooLong,
  withEnvLine,
  PG_MISSING_REMEDIATION,
  PGVECTOR_MISSING_REMEDIATION,
  type PgPlanInput,
  type PgStep,
} from "./postgres.js";
import { assistantStateDir, sandboxParams, tmpDirOf } from "./sandbox.js";
import { StepFailed, StepRunner, type SectionTiming } from "./steps.js";

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
  /** `--env-file`: the dotenv file this install runs from (default: `<instance>/state/.env`, falling back to the checkout's) */
  envFile?: string | undefined;
  /** test seam: the deployment shape, normally read from deployment.yaml */
  deployment?: Deployment | undefined;
  /** `--namespace`: allocate this instance its own launchd label suffix and port block (writes `<instance>/state/ports.yaml` once) */
  namespace?: boolean | undefined;
  /**
   * `--register-via app`: leave the supervisor's own agent to the Mac app,
   * which registers the copy inside its bundle through
   * `SMAppService.agent(plistName:)` — that is what makes Login Items show
   * ONE item, "Metistry", nested under the app. Everything else `up` does is
   * identical, the config included, so the two paths differ by exactly who
   * bootstraps one plist (docs/ops/mac-app.md).
   */
  registerVia?: "launchd" | "app" | undefined;
  /** test seam: the port probe `--namespace` allocates with */
  portFree?: ((port: number) => Promise<boolean>) | undefined;
  /** test seam: filesystem probes (the Postgres toolchain, an initialised data dir) */
  exists?: ((p: string) => boolean) | undefined;
  /** test seam: the password generated for a fresh Postgres */
  mintPassword?: (() => string) | undefined;
  /** test seam: the fetch the bundled-runtime download uses */
  fetchFn?: typeof fetch | undefined;
  /** the deps pack's os-arch (default: this host's) */
  target?: string | undefined;
  /** test seam for the closing doctor run */
  doctorFn?: ((deps: DoctorDeps) => Promise<DoctorReport>) | undefined;
  doctorDeps?: Partial<DoctorDeps> | undefined;
  /** default true; `false` is a test seam — every real `up` writes the cli shim (cli-shim.ts) */
  cliShim?: boolean | undefined;
}

export interface UpResult {
  code: number;
  source: LockSource;
  /** every command/write, in order (dry-run prints exactly this) */
  commands: string[];
  /** how long each `==` section took — printed, and the thing to compare across runs */
  timings: SectionTiming[];
  /** wall clock for the whole verb */
  elapsedMs: number;
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

/** Compose timeouts are generous on purpose: a cold `--build` compiles two images. A slow machine raises METISTRY_COMPOSE_TIMEOUT_MS. */
export const COMPOSE_TIMEOUT_MS = intEnv("METISTRY_COMPOSE_TIMEOUT_MS", 30 * 60 * 1000);

/**
 * `docker compose` reads `./.env` from its project directory for variable
 * interpolation. Once the environment lives in the instance
 * (`<instance>/state/.env`), compose has to be told — otherwise it
 * interpolates from a file the install no longer owns. `--env-file` goes
 * BEFORE the subcommand; passing the product checkout's own `.env`
 * explicitly is a no-op, so this is omitted then.
 */
export function composeEnvArgs(productDir: string, envFile: string | undefined): string[] {
  return envFile && envFile !== join(productDir, ".env") ? ["--env-file", envFile] : [];
}

export async function composeUp(r: StepRunner, productDir: string, source: LockSource, version?: string | undefined, envFile?: string | undefined): Promise<void> {
  const base = ["compose", ...composeEnvArgs(productDir, envFile)];
  if (source === "release") {
    // the released, versioned images — docker-compose.yml reads
    // METISTRY_<SERVICE>_IMAGE and falls back to the dev tags a checkout builds
    const env = version ? { ...r.env, ...imageEnv(version, r.env) } : r.env;
    if (version) r.note(`images: ${IMAGE_SERVICES.map((s) => imageRef(s, version, r.env)).join(", ")}`);
    await r.run("docker", [...base, "pull"], { cwd: productDir, env, timeoutMs: COMPOSE_TIMEOUT_MS, inherit: true, comment: version ? `pinned to ${version}` : "metistry.lock pins released images" });
    await r.run("docker", [...base, "up", "-d", "--no-build"], { cwd: productDir, env, timeoutMs: COMPOSE_TIMEOUT_MS, inherit: true });
  } else {
    await r.run("docker", [...base, "up", "-d", "--build"], { cwd: productDir, timeoutMs: COMPOSE_TIMEOUT_MS, inherit: true });
  }
}

export interface LaunchdEnv {
  platform: NodeJS.Platform;
  uid: number;
  home: string;
  node: string;
}

// ---- the launchd shape's per-service values ---------------------------------

/**
 * The node binary every launchd job execs (`__NODE__`).
 *
 * A bundled runtime's own node WINS. That is the whole point of the
 * bundled runtime (docs/ops/bundled-runtime.md): a clean Mac has no node
 * at all, a launchd job's PATH is `/usr/bin:/bin:…` with no login shell,
 * and pointing the jobs at whatever `node` happened to be on the
 * operator's PATH ties a bundled install to a Homebrew that may not exist
 * and will not exist forever. Falls back to `$(which node)` — a checkout
 * install is unchanged.
 */
export function nodeFor(productDir: string, env: NodeJS.ProcessEnv, exists: (p: string) => boolean = existsSync): { node: string; why: string } {
  const bundled = runtimeNodeBin(productDir);
  if (exists(bundled)) return { node: bundled, why: `bundled ${RUNTIME_DIRNAME}/node/bin/node` };
  return { node: nodeOnPath(env, process.execPath, exists), why: "$(which node)" };
}

/** The root the instance's derived state hangs off: the instance repo when there is one, else the checkout. */
export function stateRoot(productDir: string, env: NodeJS.ProcessEnv): string {
  return env.METISTRY_INSTANCE_DIR?.replace(/\/+$/, "") || productDir;
}

export interface ShapeValues extends ShapeContext {
  node: string;
  /**
   * The true install root — `opts.productDir`, never `current`. `productDir`
   * on this object (from `ShapeContext`) is actually the RUN dir (`current`
   * in release mode), because it is what the plists render `__REPO__` from;
   * the TCC pin needs both, the same way `migrate-shape`'s `Ctx` keeps
   * `productDir` and `runDir` distinct.
   */
  installRoot: string;
  /** `__ENV_FILE__`: `<instance>/state/.env`, or the product checkout's while an install still runs from there */
  envFile: string;
  /** rendered into the db plist; undefined when no toolchain was found (the db section reports that) */
  pgBin?: string | undefined;
  /** the data directory `up` prepared; defaults to the one under `stateRoot(productDir)` */
  pgData?: string | undefined;
  /** `<install>/runtime/git/bin:/usr/bin:…` when a bundled git is installed; undefined otherwise */
  gitPath?: string | undefined;
  /** this instance's namespace (namespace.ts); undefined = the fixed default labels and ports */
  namespace?: Namespace | undefined;
  home: string;
  /** `--register-via app`: the app registers the supervisor's agent from its bundle, so `up` installs every OTHER job and stops there */
  registerVia?: "launchd" | "app" | undefined;
  /** the `Metistry` symlink the supervisor's plist execs; filled by `installSupervisorPlan` */
  supervisorBin?: string | undefined;
  /** `<instance>/state/supervisor.json`; filled by `installSupervisorPlan` */
  supervisorConfig?: string | undefined;
  /**
   * `compute.yaml` as resolved for THIS install (seed + instance overlay).
   * `up` reads it once and passes it down: it decides whether there is an
   * assistant child at all (C2/C3), which provider secrets the engine's env
   * allowlist admits, and which local model server the supervisor starts.
   */
  compute: Compute;
}

/**
 * What each plist template needs beyond `__REPO__`/`__NODE__`. The host jobs
 * that exist in both shapes (reconciler, watchdog, the TCC bridges) take
 * neither an env dict nor extra placeholders — they source `.env`
 * themselves, exactly as they did before.
 */
export function plistValuesFor(t: PlistTemplate, v: ShapeValues): PlistValues {
  const base = { repo: v.productDir, node: v.node, envFile: v.envFile };
  switch (t.service) {
    case SUPERVISOR_SERVICE:
      // the same passthrough the console gets: the supervisor is still the
      // watchdog, and the watchdog probed the db, the console and every
      // bridge from exactly this environment when it sourced `.env` itself
      return {
        ...base,
        env: consoleEnv(v),
        extra: { SUPERVISOR_BIN: v.supervisorBin ?? supervisorBinPath(stateRoot(v.productDir, v.env)), SUPERVISOR_CONFIG: v.supervisorConfig ?? supervisorConfigPath(stateRoot(v.productDir, v.env)) },
      };
    case "console":
      return { ...base, env: consoleEnv(v) };
    case "assistant": {
      const p = sandboxParams({
        productDir: v.productDir,
        nodeBin: v.node,
        stateDir: v.stateDir,
        ...(v.instanceDir ? { instanceDir: v.instanceDir } : {}),
        consolePort: consolePort(v.env),
        dbPort: dbPort(v.env),
        tmpDir: tmpDirOf(v.env),
      });
      // every path parameter is the REAL path: the kernel matches the
      // profile's subpaths after resolving symlinks (/tmp → /private/tmp)
      return {
        ...base,
        env: assistantEnv(v, v.compute),
        // CONFIG_*: the four instance files the engine reads, granted BY
        // NAME (sandbox.ts). Without them the profile's deny-default makes
        // an absolute instance path an EPERM, so the overlay that now finds
        // this install's identity.yaml would crash the job instead.
        extra: { NODE_PREFIX: p.NODE_PREFIX, PRODUCT_DIR: p.PRODUCT_DIR, STATE_DIR: p.STATE_DIR, TMP_DIR: p.TMP_DIR, CONSOLE_TCP: p.CONSOLE_TCP, DB_TCP: p.DB_TCP, CONFIG_IDENTITY: p.CONFIG_IDENTITY, CONFIG_ASSISTANT_PROMPT: p.CONFIG_ASSISTANT_PROMPT, CONFIG_RULES: p.CONFIG_RULES, CONFIG_COMPUTE: p.CONFIG_COMPUTE },
      };
    }
    case "db":
      return { ...base, extra: { PG_BIN: v.pgBin ?? "", PG_DATA: v.pgData ?? pgDataDir(stateRoot(v.productDir, v.env)) } };
    default:
      return base;
  }
}

/**
 * This instance's namespace, allocating one on `--namespace` when it has
 * none yet. Allocation is a probe (is this block free right now?) followed
 * by a write, and it happens EXACTLY ONCE per instance: after that
 * `state/ports.yaml` is the record, so a re-run of `up` on a running
 * instance never sees its own ports as taken and never moves them.
 */
export async function ensureNamespace(
  r: StepRunner,
  opts: { instanceDir?: string | undefined; instanceId?: string | undefined; want: boolean; portFree?: ((port: number) => Promise<boolean>) | undefined },
): Promise<Namespace | undefined> {
  const existing = await loadNamespace(opts.instanceDir);
  if (existing) {
    if (opts.want) r.note(`--namespace: ${portsFile(opts.instanceDir!)} already allocates this instance's block — it is never reallocated`);
    return existing;
  }
  if (!opts.want) return undefined;
  if (!opts.instanceDir) throw new StepFailed("--namespace needs an instance directory: pass --instance <dir> or set METISTRY_INSTANCE_DIR");
  if (!opts.instanceId) throw new StepFailed(`--namespace needs this instance's instance_id, and ${opts.instanceDir}/identity.yaml has none — run \`metistry init\` (or \`metistry secrets sync\`) first`);
  const file = portsFile(opts.instanceDir);
  // the probe runs even in a dry run — it binds nothing and frees what it
  // binds, and a plan that showed the DEFAULT labels while the real run used
  // namespaced ones would be a plan of a different install
  const base = await allocateBase(opts.instanceId, opts.portFree);
  const ns: Namespace = { labelSuffix: suffixFor(opts.instanceId), base, ports: portsOf(base), from: file };
  await r.write(file, serializeNamespace(ns, opts.instanceId), `allocated once: labels ${LABEL_PREFIX}${ns.labelSuffix}.<service>, ports ${base}-${base + PORTED_SERVICES.length - 1}`);
  return ns;
}

// BOOTOUT_TRIES / BOOTOUT_INTERVAL_MS / awaitBootout moved to launchd.ts —
// tcc-pin.ts needs them too, and up.ts already imports tcc-pin.ts.

/** The plists whose EnvironmentVariables dict holds this install's secrets, so they are written 0600. */
export const SECRET_BEARING_SERVICES = new Set(["console", "assistant"]);

/**
 * Render every template into ~/Library/LaunchAgents and (re)bootstrap it; on
 * anything but macOS, print the systemd units instead.
 *
 * Every plist (and `supervisor.json`) is WRITTEN before any of them is
 * bootstrapped, and the TCC pin (tcc-pin.ts) runs in between — not
 * interleaved per-job the way it used to be. `up` runs on every `update`
 * and re-renders the calendar plist and `supervisor.json` from scratch each
 * time; if it bootstrapped a job right after writing it, a release install
 * with no bundled helper would load the un-pinned plist for one kickstart
 * and then need a SECOND one from `pinTccHelpers` to fix it — a fixable
 * ordering bug, not a fundamental one, and this is the fix: write
 * everything, correct the two TCC jobs, THEN bootstrap everything once.
 */
export async function installLaunchd(r: StepRunner, productDir: string, le: LaunchdEnv, deployment: Deployment, values: ShapeValues, exists: (p: string) => boolean = existsSync): Promise<void> {
  const templates = await loadPlistTemplates(productDir, deployment.shape, values.namespace?.labelSuffix, values.env);
  if (templates.length === 0) {
    r.note("no ops/launchd/*.plist in this checkout — nothing to install");
    return;
  }
  if (le.platform !== "darwin") {
    r.note(`no launchd on ${le.platform}: the equivalent systemd user units follow — NOT written (docs/ops/cli.md, "Linux hosts")`);
    r.note("install them by hand: save each to ~/.config/systemd/user/, then systemctl --user daemon-reload && systemctl --user enable --now <unit>");
    for (const t of templates) {
      r.out("");
      r.out(renderSystemdUnit(t, { repo: productDir, node: le.node, envFile: values.envFile }));
    }
    return;
  }
  // an install that predates the supervisor is still running the old agents:
  // boot them out ONCE, or the same services run twice
  await bootoutRetired(r, le, deployment.shape, values.namespace?.labelSuffix, exists);
  // …and the app may already own the one that is left. Asked BEFORE the
  // supervisor plan is written, because the answer decides whether this run
  // also writes the launcher file that agent reads.
  const detected = await detectAppRegistrar(r, templates, le, values);
  // the launchd shape's core is the supervisor's child list, not a plist each
  if (deployment.shape === "launchd") await installSupervisorPlan(r, productDir, le, values);
  const dir = launchAgentsDir(le.home);
  // the app's copy is inside its signed bundle and registered with
  // SMAppService; a second, identical agent in ~/Library/LaunchAgents
  // would be the same install running twice
  const installable = templates.filter((t) => !(t.service === SUPERVISOR_SERVICE && values.registerVia === "app"));
  if (installable.length < templates.length && !detected) {
    const sup = templates.find((t) => t.service === SUPERVISOR_SERVICE)!;
    r.note(
      `--register-via app: ${sup.label} is NOT installed here — the Mac app registers ${SUPERVISOR_PLIST_FILE} from Metistry.app/Contents/Library/LaunchAgents through SMAppService.agent(plistName:), and Login Items shows one item nested under the app (docs/ops/mac-app.md)`,
    );
  }

  for (const t of installable) {
    const target = join(dir, t.file);
    const { rendered, from, secret } = renderJob(t, productDir, le, values);
    await r.write(target, rendered, from);
    // the console's and the assistant's dicts carry db passwords, bridge
    // tokens and the compute provider's API key; ~/Library/LaunchAgents is 0755, so
    // the file itself has to be the boundary
    if (secret) await r.run("chmod", ["600", target], { comment: "the env dict holds secrets" });
  }

  // pin the two TCC bridges at the signed bundles that already hold the
  // grant — see tcc-pin.ts. Every run: the calendar plist and
  // supervisor.json were both just (re)written above, and this must apply
  // BEFORE either is bootstrapped, or the jobs below start un-pinned.
  // `kickstartSupervisor: false` — the bootstrap loop right below is about
  // to kickstart it anyway; no need for the pin to do it a second time.
  const pinned = await pinTccHelpers(
    { r, env: values.env, productDir: values.installRoot, runDir: productDir, home: le.home, uid: le.uid, labelSuffix: values.namespace?.labelSuffix, envFile: values.envFile },
    templates,
    exists,
    false,
  );
  if (pinned.length > 0) {
    r.note(`pinned at the signed bundles that hold the TCC grant (same bundle id + certificate chain = same designated requirement, so no re-grant): ${pinned.join(", ")}`);
  }

  for (const t of installable) {
    const target = join(dir, t.file);
    for (const c of launchdCommands(t.label, target, le.uid)) {
      if (c.awaitGone) {
        await awaitBootout(r, t.label, le.uid);
        continue;
      }
      await r.run(c.cmd, c.args, { tolerateFailure: c.tolerateFailure, comment: c.tolerateFailure ? "ok if not loaded" : undefined });
    }
  }
}

/**
 * Does the Mac app already own `com.foldedspacelabs.metistry`?
 *
 * Two registrars can install the one background item, and only ever one of
 * them at a time (docs/ops/deployment-shapes.md, "Two registrars").
 * `--register-via app` is that said deliberately; this is the safety net for
 * every `up` that follows, because `metistry update` runs one on every
 * release and a person who installed with the app and then ran `metistry up`
 * in a terminal would otherwise end up with the app's agent AND a rendered
 * one under the same label — the same install running twice.
 *
 * The signal is what launchd itself reports (`parseRegistrar`), not a marker
 * either side has to remember to write: live state cannot go stale when the
 * app is dragged to the Trash or the item switched off in System Settings.
 * The probe is a read-only `launchctl print`, so it runs under `--dry-run`
 * too — a dry run that did not ask would print a bootstrap it would not do.
 *
 * Returns true when it flipped THIS run onto the app path.
 */
async function detectAppRegistrar(r: StepRunner, templates: PlistTemplate[], le: LaunchdEnv, values: ShapeValues): Promise<boolean> {
  if (values.registerVia === "app") return false;
  const sup = templates.find((t) => t.service === SUPERVISOR_SERVICE);
  if (!sup) return false;
  // `--dry-run` runs nothing at all, probe included — so it has to SAY that
  // this is the one thing it could not look up, rather than print a bootstrap
  // the real run might skip.
  if (r.dryRun) {
    r.note(`(not asked: whether ${sup.label} is already registered by the Mac app. A real run asks launchd, and skips the two steps below when it is.)`);
    return false;
  }
  const p = await r.exec("launchctl", ["print", `gui/${le.uid}/${sup.label}`], { env: r.env });
  const finding = parseRegistrar(p.code, p.stdout);
  if (finding.registrar !== "app") return false;
  values.registerVia = "app";
  r.note(
    `${sup.label} is already registered by ${registrarPhrase(finding)} — not rendered, not bootstrapped, not kickstarted here; ` +
      `the app's Settings › Services › "Run Metistry in the background" owns it, and the new supervisor.json is picked up by turning that off and on (or \`launchctl kickstart -k gui/${le.uid}/${sup.label}\`).`,
  );
  return true;
}

/**
 * One template, rendered the way `up` has always rendered it: the
 * placeholders, then the entries that are computed rather than templated (a
 * bundled git's PATH, a namespaced install's ports). Shared by the agents
 * `up` installs and the children it hands the supervisor, so a child runs
 * byte-for-byte the command its agent used to.
 */
export function renderJob(t: PlistTemplate, productDir: string, le: LaunchdEnv, values: ShapeValues): { rendered: string; from: string; secret: boolean } {
  const v = plistValuesFor(t, values);
  // a launchd job's PATH is /usr/bin:/bin and nothing else, so a bundled git
  // has to be put there explicitly for the job that spawns one
  const gitPath = values.gitPath && GIT_SPAWNING_SERVICES.has(t.service) ? { PATH: values.gitPath } : undefined;
  // the jobs `up` renders a whole environment for (console, assistant) already
  // have the namespace's ports — it was applied to `env` before this. The
  // ones that source `<instance>/state/.env` themselves see only that file,
  // which knows nothing about this instance's block, so they get it here or
  // they bind the DEFAULT install's ports.
  const nsPorts = values.namespace && !v.env ? portEnv(values.namespace) : undefined;
  // …and the same is true of WHERE THE INSTANCE IS. The console's and the
  // assistant's dicts carry it already (`instanceVars`); the jobs that
  // source `.env` see it only if that file happens to declare the line —
  // `metistry init` prints one, an install that predates it or edits the
  // file by hand may not, and the reconciler then refuses to start while
  // every overlay default falls back to the product's seed. `up` knows the
  // answer, so it says it.
  const instanceEnv = !v.env ? instanceVars(values) : undefined;
  const extraEnv = { ...(gitPath ?? {}), ...(nsPorts ?? {}), ...(instanceEnv ?? {}) };
  const from = `ops/launchd/${t.file}, __REPO__=${productDir}, __NODE__=${le.node}, __ENV_FILE__=${values.envFile}${v.env ? `, ${Object.keys(v.env).length} EnvironmentVariables from ${values.envFile}` : ""}${gitPath ? `, PATH=${values.gitPath}` : ""}${nsPorts ? `, ${Object.keys(nsPorts).length} namespaced ports` : ""}${instanceEnv ? `, ${Object.keys(instanceEnv).map((k) => `+${k}`).join(" ")}` : ""}`;
  const base = renderPlist(t.template, v);
  return { rendered: Object.keys(extraEnv).length > 0 ? withEnvironmentVariables(base, extraEnv) : base, from, secret: SECRET_BEARING_SERVICES.has(t.service) };
}

/**
 * Boot out the agents this shape no longer installs, and delete their
 * plists. Tolerant of every one of them being absent — a fresh install runs
 * this and nothing happens.
 *
 * Under the launchd shape there are EIGHT of them, and on an install that
 * migrated months ago every one is long gone: `up` was spending sixteen
 * subprocesses (a `bootout` and an `rm` each, in series) to discover that,
 * on every `up` and so on every `update`. So ask launchd ONCE — `launchctl
 * list` is a single call that names every loaded label — and pair it with a
 * plain `existsSync` for the plist file.
 *
 * The old unconditional behaviour is the FALLBACK, not the thing removed:
 * when the probe cannot be run (a dry run, or `launchctl list` failing) every
 * label is booted out exactly as before. An `up` that only cleaned up when it
 * noticed would leave a job running on the one Mac where the notice failed,
 * so "could not ask" has to mean "do the work", never "skip it".
 */
export async function bootoutRetired(
  r: StepRunner,
  le: LaunchdEnv,
  shape: Deployment["shape"],
  labelSuffix: string | undefined,
  exists: (p: string) => boolean = existsSync,
): Promise<void> {
  const dir = launchAgentsDir(le.home);
  const retired = retiredServicesFor(shape);
  if (retired.length === 0) return;
  const jobs = retired.map((service) => {
    const label = labelFor(service, labelSuffix);
    return { service, label, plist: join(dir, `${label}.plist`) };
  });
  // a dry run prints the whole unconditional plan: it runs no probe, and a
  // plan that skipped what a real run might do would be a plan of a
  // different install (the same rule `detectAppRegistrar` follows)
  const loaded = r.dryRun ? undefined : await loadedLabels(r);
  const todo = loaded ? jobs.filter((j) => loaded.has(j.label) || exists(j.plist)) : jobs;
  if (todo.length === 0) {
    r.note(`nothing to retire: launchd has none of ${retired.join(", ")} loaded, and ${dir} holds no plist for them (one \`launchctl list\`, not ${jobs.length * 2} commands)`);
    return;
  }
  r.note(
    shape === "launchd"
      ? `retiring the pre-supervisor agents (${todo.map((j) => j.service).join(", ")}) — they are the supervisor's children now`
      : `retiring ${todo.map((j) => j.service).join(", ")} — renamed (eventkit-helper → calendar)`,
  );
  for (const j of todo) {
    await r.run("launchctl", ["bootout", `gui/${le.uid}/${j.label}`], { tolerateFailure: true, comment: "ok if not loaded" });
    await r.run("rm", ["-f", j.plist], { tolerateFailure: true });
  }
}

/**
 * The OPTIONAL local-model children. There is no plist template for these:
 * a `serve:` block in `compute.yaml` is what declares one, so the child is
 * built from the configuration rather than rendered from `ops/launchd/`.
 *
 * Absent by default, and quietly. An install that uses LM Studio, Ollama or
 * no local model at all names no `serve:` block and gets no child — which is
 * why a missing binary or a missing GGUF is a NOTE and not a failure: `up`
 * bringing the whole install down because a model file was moved would be a
 * far worse answer than a console that runs with one fewer provider.
 *
 * `serve: { runtime: applefm }` is filtered out here rather than handled:
 * the Apple FM provider IS the `apple-fm` bridge, which is a supervised
 * service with its own plist already. Its `serve:` block declares ownership
 * (and ties the port to the base URL); it declares no second process.
 */
export async function servedLocalModelChildren(r: StepRunner, productDir: string, values: ShapeValues, base: Record<string, string>): Promise<ChildSpecInput[]> {
  const instanceDir = stateRoot(values.productDir, values.env);
  const served = servedProviders(values.compute);
  const own = served.filter((x) => x.serve.runtime === "llamaserver");
  for (const x of served) {
    if (x.serve.runtime === "applefm") r.note(`providers.${x.name} serves Apple Foundation Models through the apple-fm bridge on 127.0.0.1:${x.serve.port} — already a supervised service, so no extra child`);
  }
  if (own.length === 0) return [];
  if (own.length > 1) {
    throw new StepFailed(`${own.map((x) => x.name).join(", ")} all declare a serve: { runtime: llamaserver } block, and the supervisor has one \`llamaserver\` child — keep the one you want and remove serve: from the others`);
  }
  const { name, serve } = own[0]!;
  if (serve.model_path === undefined) return []; // unreachable: the schema requires it for llamaserver
  const built = llamaServerChild({
    productDir: values.installRoot,
    instanceDir,
    provider: name,
    serve: { ...serve, model_path: serve.model_path },
    env: base,
    log: logPathFor("llamaserver", values.namespace?.labelSuffix),
  });
  if ("skipped" in built) {
    r.note(`no llamaserver child: ${built.skipped}`);
    return [];
  }
  r.note(`llamaserver child: ${built.binary} serving ${built.model} on 127.0.0.1:${serve.port}`);
  return [built.child];
}

/**
 * The supervisor's plan: the `Metistry` symlink its plist execs, and
 * `<instance>/state/supervisor.json` — the child list, each child's argv,
 * environment and log path, and the control socket.
 *
 * The token is REUSED when this install already has a config: `up` may run
 * while the supervisor is up, and a token change would break the control
 * socket for every verb until the kickstart landed.
 */
export async function installSupervisorPlan(r: StepRunner, productDir: string, le: LaunchdEnv, values: ShapeValues): Promise<void> {
  const root = stateRoot(values.productDir, values.env);
  const configPath = supervisorConfigPath(root);
  const socket = supervisorSocketPath(root);
  if (socket.length > 103) {
    throw new StepFailed(`the supervisor's control socket path is ${socket.length} bytes (${socket}) — over the 103-byte unix socket limit; move the instance directory somewhere shorter`);
  }
  const bin = supervisorBinPath(root);
  values.supervisorBin = bin;
  values.supervisorConfig = configPath;

  // No engine, no assistant child: the engine hard-requires one
  // (apps/assistant/src/main.ts) and would crash-loop, which is not what an
  // install with no model looks like — it looks like everything else running
  // and the fold's turns waiting. Read through ONE function (core's
  // `engineStatus`: `assignments.default` plus its provider's secret), the
  // same one doctor reads; the config is rewritten whole on every `up`, so a
  // provider assigned later re-adds the child.
  const templates = (await loadSupervisedTemplates(productDir, values.namespace?.labelSuffix, values.env)).filter(
    (t) => t.service !== "assistant" || engineStatus(values.compute, values.env).ok,
  );
  const base = launchdBaseEnv(values.env);
  const children = templates.map((t) => {
    const { rendered } = renderJob(t, productDir, le, values);
    const ready =
      t.service === "db"
        ? { kind: "tcp" as const, port: dbPort(values.env) }
        : t.service === "console"
          ? { kind: "tcp" as const, port: consolePort(values.env) }
          : undefined;
    return childFromRenderedPlist(t, rendered, base, ready);
  });
  children.push(...(await servedLocalModelChildren(r, productDir, values, base)));

  const existing = await readSupervisorConfig(configPath);
  const token = existing?.token ?? mintControlToken();
  const config = supervisorConfig({ label: labelFor(SUPERVISOR_SERVICE, values.namespace?.labelSuffix), socket, token, env: consoleEnv(values), children });

  await r.run("mkdir", ["-p", join(bin, "..")]);
  // the name is the product: System Settings names a background item after
  // the agent's program, and `node` is not a name a user can act on
  await r.run("ln", ["-sfn", le.node, bin], { comment: `the supervisor's program name — ${le.node}` });
  await r.run("mkdir", ["-p", join(socket, "..")]);
  await r.write(configPath, serializeSupervisorConfig(config), `${children.length} child(ren): ${children.map((c) => c.name).join(", ")}${existing ? " (control token kept)" : ""}`);
  await r.run("chmod", ["600", configPath], { comment: "it holds this install's environment and the control token" });

  // the app path: the agent inside Metistry.app is immutable and identical on
  // every Mac, so the three paths THIS install runs from go in a file its
  // launcher sources
  if (values.registerVia === "app") {
    if (!le.home) throw new StepFailed("--register-via app needs HOME — that is where the app's launcher looks for supervisor.env");
    const launcherEnv = supervisorLauncherEnvPath(le.home);
    await r.run("mkdir", ["-p", join(launcherEnv, "..")]);
    await r.write(launcherEnv, serializeLauncherEnv({ bin, main: join(productDir, "apps", "watchdog", "dist", "main.js"), config: configPath }), "read by Metistry.app/Contents/Resources/MetistrySupervisor");
  }
}

// ---- the launchd shape's Postgres --------------------------------------------

/**
 * How long `up` waits for the freshly bootstrapped server to answer before
 * letting doctor report it: the same 15-second ceiling it has always had, but
 * asked four times a second instead of once. The interval is the whole cost
 * of this step on a healthy install — Postgres is usually up well inside the
 * first second, and a one-second poll rounded that up to a full second of
 * `up` every time.
 */
export const PG_READY_INTERVAL_MS = 250;
export const PG_READY_TRIES = 60;

/** What `preparePostgres` needs to fetch a bundled runtime; absent = never reach the network. */
export interface RuntimeDepsFetch {
  fetchFn: typeof fetch;
  /** the release to take the deps pack from (default: the latest) */
  version?: string | undefined;
  target?: string | undefined;
}

export interface PgSection {
  plan: PgPlanInput;
  /** the password `.env` now holds — set into the environment so the later steps and doctor use it */
  password: string;
}

async function runPgStep(r: StepRunner, s: PgStep): Promise<void> {
  if (s.kind === "run") {
    await r.run(s.cmd, s.args, { ...(s.tolerateFailure ? { tolerateFailure: true } : {}), ...(s.comment ? { comment: s.comment } : {}) });
    return;
  }
  if (s.kind === "write") {
    await r.write(s.path, s.content, s.from);
    return;
  }
  // conf: read what initdb wrote (or what a previous `up` left) and replace only the managed block
  const current = existsSync(s.path) ? await readFile(s.path, "utf8") : "";
  await r.write(s.path, applyManagedBlock(current, s.block), s.from);
}

/**
 * Prepare the data directory before the db plist is bootstrapped: find the
 * binaries, make sure `.env` has a password, initdb once, write the managed
 * conf block. Returns undefined when no toolchain is installed — that is a
 * printed remediation and a failed step, never an install this tool runs on
 * the operator's behalf.
 */
export async function preparePostgres(
  r: StepRunner,
  productDir: string,
  opts: { exists?: ((p: string) => boolean) | undefined; mintPassword: () => string; runtimeDeps?: RuntimeDepsFetch | undefined; envFile?: string | undefined },
): Promise<PgSection> {
  const env = r.env;
  const exists = opts.exists ?? existsSync;
  let toolchain = findPgToolchain(pgCandidates(env, productDir), exists);
  // nothing installed anywhere: in release mode the release itself carries a
  // Postgres — download the deps pack rather than printing `brew install`
  if (!toolchain && opts.runtimeDeps) {
    r.note(`no Postgres found — fetching the bundled runtime into ${RUNTIME_DIRNAME}/ (METISTRY_RUNTIME_DEPS=0 to never do this)`);
    const res = await installRuntimeDeps(r, { productDir, fetchFn: opts.runtimeDeps.fetchFn, env, version: opts.runtimeDeps.version, ...(opts.runtimeDeps.target ? { target: opts.runtimeDeps.target } : {}) });
    if (!res.installed) r.note(`bundled runtime not installed: ${res.reason}`);
    toolchain = findPgToolchain(pgCandidates(env, productDir), exists);
  }
  if (!toolchain) throw new StepFailed(PG_MISSING_REMEDIATION);
  r.note(`postgres: ${toolchain.bin} (${toolchain.why})`);
  if (!toolchain.pgvector) r.note(PGVECTOR_MISSING_REMEDIATION);

  const root = stateRoot(productDir, env);
  const dataDir = pgDataDir(root);
  const socketDir = pgSocketDir(root);
  const port = dbPort(env);
  if (socketPathTooLong(socketDir, port)) {
    throw new StepFailed(`the unix socket path under ${socketDir} exceeds the ${103}-byte limit — move the instance directory somewhere shorter`);
  }

  // the password: whatever .env already has, else one generated once and
  // appended there (never printed, never committed — the instance seed
  // gitignores state/, and a product checkout gitignores .env)
  let password = env.METISTRY_DB_PASSWORD ?? "";
  if (password === "") {
    password = opts.mintPassword();
    const envFile = opts.envFile ?? join(productDir, ".env");
    const current = existsSync(envFile) ? await readFile(envFile, "utf8") : "";
    const next = withEnvLine(current, "METISTRY_DB_PASSWORD", password);
    if (next) {
      await r.write(envFile, next, "generated METISTRY_DB_PASSWORD (not shown; the file is gitignored)");
      // a freshly created `<instance>/state/.env` would otherwise be 0644
      await r.run("chmod", ["600", envFile], { comment: "it holds this install's secrets" });
    }
    env.METISTRY_DB_PASSWORD = password;
  }

  const plan: PgPlanInput = {
    toolchain,
    dataDir,
    socketDir,
    port,
    user: env.METISTRY_DB_USER || "metistry",
    database: env.METISTRY_DB_NAME || "metistry",
    password,
    initialised: exists(join(dataDir, "PG_VERSION")),
  };
  if (plan.initialised) r.note(`${dataDir} is already initialised — initdb is skipped (only the managed conf block is rewritten)`);
  await r.run("mkdir", ["-p", socketDir]);
  for (const s of planPostgresBootstrap(plan)) await runPgStep(r, s);
  return { plan, password };
}

/** After the db job is bootstrapped: wait for the socket, then create the database compose got from POSTGRES_DB. */
export async function finishPostgres(r: StepRunner, section: PgSection, sleep: (ms: number) => Promise<void> = (ms) => new Promise((res) => setTimeout(res, ms))): Promise<void> {
  const ready = pgIsReady(section.plan);
  const capSeconds = (PG_READY_TRIES * PG_READY_INTERVAL_MS) / 1000;
  for (let i = 1; i <= PG_READY_TRIES; i++) {
    const res = await r.run(ready.cmd, ready.args, { tolerateFailure: true, ...(i === 1 ? { comment: `every ${PG_READY_INTERVAL_MS}ms for up to ${capSeconds}s while launchd starts the server` } : {}) });
    if (res.code === 0) break;
    if (i === PG_READY_TRIES) throw new StepFailed(`postgres did not answer on ${section.plan.socketDir} after ${capSeconds}s — log: /tmp/metistry-db.log`);
    await sleep(PG_READY_INTERVAL_MS);
  }
  for (const s of planPostgresDatabase(section.plan)) await runPgStep(r, s);
}

/** `312ms`, `4.1s` — short enough to read at a glance in one line of timings. */
export function fmtMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Where the time went, one line. Always printed rather than hidden behind a
 * flag: "why was that slow?" is the first question anyone asks of `up`, and
 * an answer you have to know to ask for is an answer nobody has.
 */
export function renderTimings(sections: SectionTiming[], totalMs: number): string {
  const parts = sections.map((s) => `${s.title} ${fmtMs(s.ms)}`);
  return `${parts.join(" · ")}${parts.length > 0 ? " — " : ""}total ${fmtMs(totalMs)}`;
}

/**
 * The last line `up` prints: who owns the processes it just started, and the
 * two verbs for the two things a person wants next. launchd (or compose) owns
 * the daemon — the CLI never does, and it says so rather than leaving an
 * operator wondering whether closing the terminal takes the install down.
 */
export function runningNote(shape: Deployment["shape"]): string {
  const owner = shape === "launchd" ? "launchd" : "docker compose";
  return `running under ${owner} — \`metistry down\` stops it, \`metistry logs <service> --follow\` tails`;
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
  // the shape is product configuration, read from the running code; the
  // instance's deployment.yaml still wins over the seed (D4)
  const loaded = opts.deployment ? { deployment: opts.deployment, from: "caller" } : await loadDeployment(runDir, env);
  const deployment = loaded.deployment;
  // the install root, not the release: `runtime/` sits BESIDE releases/, so a
  // version flip never orphans the node the plists exec
  const chosenNode = opts.node ? { node: opts.node, why: "--node" } : nodeFor(opts.productDir, env, opts.exists ?? existsSync);
  const le: LaunchdEnv = {
    platform: opts.platform ?? process.platform,
    uid: opts.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0),
    home: opts.home ?? env.HOME ?? "",
    node: chosenNode.node,
  };
  const instanceDir = env.METISTRY_INSTANCE_DIR ? { instanceDir: env.METISTRY_INSTANCE_DIR.replace(/\/+$/, "") } : {};
  // `.env` belongs to the INSTANCE (`state/.env`); a product-checkout one is
  // still honoured while an install predates the move. `--env-file` is the
  // Mac app's override — it knows which instance it opened.
  const paths = envPaths({ ...instanceDir, productDir: opts.productDir, ...(opts.envFile ? { explicit: opts.envFile } : {}), ...(opts.exists ? { exists: opts.exists } : {}) });
  const envFile = paths?.read[0] ?? paths?.write ?? join(opts.productDir, ".env");
  // compute.yaml, once: the same file `servedLocalModelChildren` reads, the
  // same one doctor reads. A file that does not parse is a NOTE and an
  // engine-less install for this run — `up` bringing the whole install down
  // because one line of YAML is wrong would be the worse answer, and
  // `metistry compute show` says exactly what is wrong.
  const computePaths = env.METISTRY_COMPUTE_FILES ?? `${join(runDir, "seed", COMPUTE_FILENAME)}:${instanceFile(stateRoot(opts.productDir, env), "compute")}`;
  let compute = emptyCompute();
  try {
    compute = (await loadCompute(computePaths)).compute;
  } catch (e) {
    r.note(`compute.yaml did not parse, so this run has no engine and no served local model (${e instanceof Error ? e.message : String(e)}) — \`metistry compute show\``);
  }
  const values: ShapeValues = {
    // the product's files: `current` in release mode, so the plists exec the
    // running release and a rollback stays a symlink flip
    productDir: runDir,
    // the true install root — where a sibling checkout's hand-built TCC
    // helper bundles live, and where a namespaced install's own bundles
    // would (see tcc-pin.ts)
    installRoot: opts.productDir,
    ...instanceDir,
    // deployment.yaml is the record for `keep_awake`, so it is rendered into
    // the environment here rather than being a line anyone can put in `.env`:
    // it reaches the supervisor through the SAME passthrough every other
    // METISTRY_* variable takes (consoleEnv → the plist's dict and
    // supervisor.json's `env`), and there is no second channel to it.
    env: { ...env, [KEEP_AWAKE_ENV]: keepAwakeOf(deployment) },
    shape: deployment.shape,
    // derived state hangs off the install root, never off a release: a version
    // flip must not orphan the assistant's state or the Postgres data dir
    stateDir: assistantStateDir({ ...instanceDir, productDir: opts.productDir }),
    node: le.node,
    ...(opts.registerVia ? { registerVia: opts.registerVia } : {}),
    envFile,
    home: le.home,
    compute,
  };
  r.note(`product: ${runDir} (${source === "release" ? `pinned release${lock ? ` ${lock.product.version}` : ""} — images pulled, not built` : "git checkout — images built from source"})`);
  r.note(`shape: ${deployment.shape} — from ${loaded.from}`);
  // said out loud, because it is a machine-level behaviour and the operator
  // should never discover it from `pmset` (docs/ops/deployment-shapes.md)
  if (le.platform === "darwin") {
    const keepAwake = keepAwakeOf(deployment);
    r.note(
      keepAwake === "never"
        ? "keep-awake: never — nothing holds this Mac awake, and it may idle-sleep with the install paused (`metistry deployment set-keep-awake allow_sleep_on_battery`)"
        : deployment.shape === "launchd"
          ? `keep-awake: ${keepAwake} — the supervisor holds PreventUserIdleSystemSleep while it runs`
          : `keep-awake: ${keepAwake}, but the compose shape has no supervisor to hold it — nothing is held (docs/ops/deployment-shapes.md)`,
    );
  }
  r.note(`node: ${le.node} (${chosenNode.why}) — every launchd job execs this`);
  // the notice itself is main.ts's job (it prints to stderr, once per run);
  // here it is one line of the plan, so the operator sees which file the
  // rendered plists and compose will actually read
  r.note(`env: ${envFile}${paths?.pendingMove ? " — the product checkout's; `metistry secrets sync --to env` moves it to " + paths.write : paths?.legacy ? ` (${paths.legacy} still read as a deprecated fallback)` : ""}`);
  // an instance created before instance_id existed gets one here, so the
  // Mac app and `secrets` can tell this instance from any other on the Mac
  let instanceId: string | undefined;
  if (instanceDir.instanceDir) {
    const id = await ensureInstanceId(r, { instanceDir: instanceDir.instanceDir, env, platform: le.platform, uid: le.uid, fetchFn: opts.fetchFn ?? fetch });
    r.note(id.detail);
    if (id.id) instanceId = id.id;
  }
  // the namespace: one file, allocated once, then read. It is what lets a
  // SECOND instance run beside the first — without it an install keeps the
  // fixed labels and ports it has always had
  const ns = await ensureNamespace(r, { instanceDir: instanceDir.instanceDir, instanceId, want: opts.namespace === true, portFree: opts.portFree });
  if (ns) {
    values.namespace = ns;
    const applied = applyPorts(env, ns);
    r.note(`namespace: labels ${LABEL_PREFIX}${ns.labelSuffix}.<service>, ports ${ns.base}-${ns.base + PORTED_SERVICES.length - 1} — from ${ns.from}`);
    r.note(applied.length ? `namespace → environment: ${applied.join(" ")}` : "namespace → environment: nothing to fill; .env already sets every port and URL");
  }
  // one line, before anything is written: an install with no engine is a
  // shape, not a fault (docs/ops/assistant-tools.md, "Running without an
  // engine"), and the operator should see WHY there is no assistant below
  const engine = engineStatus(values.compute, env);
  if (!engine.ok) r.note(engineAbsentNote(engine.why as string, engine.fix as string));
  let failure: StepFailed | undefined;

  try {
    if (opts.compose === false) {
      r.note("--no-compose: containers left as they are");
    } else if (usesCompose(deployment)) {
      r.section("compose");
      await composeUp(r, runDir, source, lock?.product.version, envFile);
    } else {
      r.note("shape launchd: no containers, so docker is never called");
    }

    if (opts.launchd === false) {
      r.note("--no-launchd: host jobs left as they are");
    } else {
      if (le.platform === "darwin" && !le.home) throw new StepFailed("HOME is unset — cannot find ~/Library/LaunchAgents");
      // the jobs that source this file do it with `sh`, which RUNS it — a
      // value with a space in it must be quoted or four jobs respawn forever
      // with a one-line shell error as their only symptom
      if (le.platform === "darwin" && existsSync(envFile)) {
        const unsafe = shellUnsafeEnvLines(await readFile(envFile, "utf8"));
        if (unsafe.length > 0) {
          throw new StepFailed(
            `${envFile} has ${unsafe.length} value(s) that \`sh\` would not read the way metistry does: ${unsafe.map((u) => `${u.key} (line ${u.line})`).join(", ")}. ` +
              `The reconciler, watchdog and TCC bridge jobs load this file with \`set -a; . <file>\`, so a value containing a space or a shell metacharacter must be quoted — ` +
              `write KEY="the value" and re-run. Nothing was installed.`,
          );
        }
      }
      let pg: PgSection | undefined;
      if (deployment.shape === "launchd" && le.platform === "darwin") {
        r.section("postgres");
        // a release install may fetch its own Postgres (the bundled runtime);
        // a checkout never does — that operator has Homebrew and a plan
        const runtimeDeps: RuntimeDepsFetch | undefined =
          source === "release" && runtimeDepsEnabled(env) && !r.dryRun
            ? { fetchFn: opts.fetchFn ?? fetch, ...(lock?.product.version ? { version: lock.product.version } : {}), ...(opts.target ? { target: opts.target } : {}) }
            : undefined;
        // the install root, not the release: `.env`, `state/pg` and any
        // bundled runtime/postgres live where the install does
        pg = await preparePostgres(r, opts.productDir, { exists: opts.exists, mintPassword: opts.mintPassword ?? mintPassword, runtimeDeps, envFile });
        values.pgBin = pg.plan.toolchain.bin;
        values.pgData = pg.plan.dataDir;
        await r.run("mkdir", ["-p", values.stateDir], { comment: "the assistant's state dir — HOME, and the only path its sandbox may write" });
      }
      // the bundled git, if this install has one, goes on the front of the
      // reconciler's PATH — a clean Mac has no git until Xcode CLT is installed
      values.gitPath = pathWithRuntimeGit(opts.productDir, opts.exists ?? existsSync);
      if (values.gitPath) r.note(`git: ${values.gitPath.split(":")[0]} (bundled) — prefixed onto the reconciler's PATH`);
      r.section("launchd");
      await installLaunchd(r, runDir, le, deployment, values, opts.exists ?? existsSync);
      if (pg) {
        r.section("database");
        await finishPostgres(r, pg);
      }
    }

    // the cli shim: independent of compose/launchd, but — like everything
    // else in this block — NOT written once a step above has failed
    // (nothing runs "after the failure" except doctor's diagnosis, below).
    // Last, so it sees whatever installLaunchd's `ln -sfn` just did to the
    // launchd shape's supervisor symlink (cli-shim.ts).
    if (opts.cliShim !== false) {
      r.section("cli");
      await writeCliShim(r, opts.productDir, instanceDir.instanceDir);
    }
  } catch (err) {
    if (!(err instanceof StepFailed)) throw err;
    failure = err;
    r.out(`metistry up: ${err.message}`);
  }

  // doctor runs even after a failed step — its table is the diagnosis; the failure keeps the exit code
  const doctorCode = await closingDoctor(r, runDir, opts.doctorDeps, opts.doctorFn ?? doctor);
  const timings = r.timings();
  r.section("timings");
  r.note(renderTimings(timings, r.elapsedMs()));
  r.note(runningNote(deployment.shape));
  return { code: failure ? failure.code || 1 : doctorCode, source, commands: r.commands, timings, elapsedMs: r.elapsedMs() };
}

/** A Postgres superuser password: 256 bits of randomness, alphanumeric so no conf or connection string ever needs to quote it. */
function mintPassword(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(43);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
}
