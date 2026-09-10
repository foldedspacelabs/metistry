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
import { usesCompose, type Deployment } from "@foldedspacelabs/metistry-core";
import { assistantEnv, consoleEnv, consolePort, dbPort, loadDeployment, type ShapeContext } from "./deployment.js";
import { doctor, renderTable, type DoctorDeps, type DoctorReport } from "./doctor.js";
import type { Exec } from "./exec.js";
import { GIT_SPAWNING_SERVICES, LABEL_PREFIX, launchAgentsDir, launchdCommands, loadPlistTemplates, nodeOnPath, renderPlist, renderSystemdUnit, withEnvironmentVariables, type PlistTemplate, type PlistValues } from "./launchd.js";
import { shellUnsafeEnvLines } from "./env.js";
import { ensureInstanceId, envPaths } from "./instance.js";
import { allocateBase, applyPorts, loadNamespace, portEnv, PORTED_SERVICES, portsFile, portsOf, serializeNamespace, suffixFor, type Namespace } from "./namespace.js";
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
  /** `--env-file`: the dotenv file this install runs from (default: `<instance>/state/.env`, falling back to the checkout's) */
  envFile?: string | undefined;
  /** test seam: the deployment shape, normally read from deployment.yaml */
  deployment?: Deployment | undefined;
  /** `--namespace`: allocate this instance its own launchd label suffix and port block (writes `<instance>/state/ports.yaml` once) */
  namespace?: boolean | undefined;
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
    case "console":
      return { ...base, env: consoleEnv(v) };
    case "assistant": {
      const p = sandboxParams({ productDir: v.productDir, nodeBin: v.node, stateDir: v.stateDir, consolePort: consolePort(v.env), dbPort: dbPort(v.env), tmpDir: tmpDirOf(v.env) });
      // every path parameter is the REAL path: the kernel matches the
      // profile's subpaths after resolving symlinks (/tmp → /private/tmp)
      return { ...base, env: assistantEnv(v), extra: { NODE_PREFIX: p.NODE_PREFIX, PRODUCT_DIR: p.PRODUCT_DIR, STATE_DIR: p.STATE_DIR, TMP_DIR: p.TMP_DIR, CONSOLE_TCP: p.CONSOLE_TCP, DB_TCP: p.DB_TCP } };
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

/** How long `up` waits for `launchctl bootout` to finish before bootstrapping the same label again (25 × 200ms = 5s). */
export const BOOTOUT_TRIES = 25;
export const BOOTOUT_INTERVAL_MS = 200;

/**
 * Wait until `launchctl print gui/<uid>/<label>` stops finding the job.
 *
 * `bootout` is asynchronous: it returns while launchd is still tearing the
 * job down, and a `bootstrap` of the same label in that window fails with
 * `Bootstrap failed: 5: Input/output error`. Polling `print` is the only
 * thing launchctl offers that answers "is it gone yet". A timeout is NOT
 * an error here — the bootstrap that follows will report the real problem
 * with launchd's own words rather than ours.
 */
export async function awaitBootout(r: StepRunner, label: string, uid: number, sleep: (ms: number) => Promise<void> = (ms) => new Promise((res) => setTimeout(res, ms))): Promise<boolean> {
  if (r.dryRun) {
    r.note(`wait for gui/${uid}/${label} to be gone before bootstrapping it (bootout is asynchronous)`);
    return true;
  }
  for (let i = 0; i < BOOTOUT_TRIES; i++) {
    const p = await r.exec("launchctl", ["print", `gui/${uid}/${label}`], { env: r.env });
    if (p.code !== 0) return true;
    await sleep(BOOTOUT_INTERVAL_MS);
  }
  r.note(`gui/${uid}/${label} is still loaded ${(BOOTOUT_TRIES * BOOTOUT_INTERVAL_MS) / 1000}s after bootout — bootstrapping anyway`);
  return false;
}

/** The plists whose EnvironmentVariables dict holds this install's secrets, so they are written 0600. */
export const SECRET_BEARING_SERVICES = new Set(["console", "assistant"]);

/** Render every template into ~/Library/LaunchAgents and (re)bootstrap it; on anything but macOS, print the systemd units instead. */
export async function installLaunchd(r: StepRunner, productDir: string, le: LaunchdEnv, deployment: Deployment, values: ShapeValues): Promise<void> {
  const templates = await loadPlistTemplates(productDir, deployment.shape, values.namespace?.labelSuffix);
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
  const dir = launchAgentsDir(le.home);
  for (const t of templates) {
    const target = join(dir, t.file);
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
    const extraEnv = { ...(gitPath ?? {}), ...(nsPorts ?? {}) };
    const from = `ops/launchd/${t.file}, __REPO__=${productDir}, __NODE__=${le.node}, __ENV_FILE__=${values.envFile}${v.env ? `, ${Object.keys(v.env).length} EnvironmentVariables from ${values.envFile}` : ""}${gitPath ? `, PATH=${values.gitPath}` : ""}${nsPorts ? `, ${Object.keys(nsPorts).length} namespaced ports` : ""}`;
    const rendered = renderPlist(t.template, v);
    await r.write(target, Object.keys(extraEnv).length > 0 ? withEnvironmentVariables(rendered, extraEnv) : rendered, from);
    // the console's and the assistant's dicts carry db passwords, bridge
    // tokens and CLAUDE_CODE_OAUTH_TOKEN; ~/Library/LaunchAgents is 0755, so
    // the file itself has to be the boundary
    if (SECRET_BEARING_SERVICES.has(t.service)) await r.run("chmod", ["600", target], { comment: "the env dict holds secrets" });
    for (const c of launchdCommands(t.label, target, le.uid)) {
      if (c.awaitGone) {
        await awaitBootout(r, t.label, le.uid);
        continue;
      }
      await r.run(c.cmd, c.args, { tolerateFailure: c.tolerateFailure, comment: c.tolerateFailure ? "ok if not loaded" : undefined });
    }
  }
}

// ---- the launchd shape's Postgres --------------------------------------------

/** How long `up` waits for the freshly bootstrapped server to answer before letting doctor report it. */
export const PG_READY_TRIES = 15;

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
  for (let i = 1; i <= PG_READY_TRIES; i++) {
    const res = await r.run(ready.cmd, ready.args, { tolerateFailure: true, ...(i === 1 ? { comment: `up to ${PG_READY_TRIES} tries while launchd starts the server` } : {}) });
    if (res.code === 0) break;
    if (i === PG_READY_TRIES) throw new StepFailed(`postgres did not answer on ${section.plan.socketDir} after ${PG_READY_TRIES} tries — log: /tmp/metistry-db.log`);
    await sleep(1000);
  }
  for (const s of planPostgresDatabase(section.plan)) await runPgStep(r, s);
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
  const values: ShapeValues = {
    // the product's files: `current` in release mode, so the plists exec the
    // running release and a rollback stays a symlink flip
    productDir: runDir,
    ...instanceDir,
    env,
    shape: deployment.shape,
    // derived state hangs off the install root, never off a release: a version
    // flip must not orphan the assistant's state or the Postgres data dir
    stateDir: assistantStateDir({ ...instanceDir, productDir: opts.productDir }),
    node: le.node,
    envFile,
    home: le.home,
  };
  r.note(`product: ${runDir} (${source === "release" ? `pinned release${lock ? ` ${lock.product.version}` : ""} — images pulled, not built` : "git checkout — images built from source"})`);
  r.note(`shape: ${deployment.shape} — from ${loaded.from}`);
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
      await installLaunchd(r, runDir, le, deployment, values);
      if (pg) {
        r.section("database");
        await finishPostgres(r, pg);
      }
    }
  } catch (err) {
    if (!(err instanceof StepFailed)) throw err;
    failure = err;
    r.out(`metistry up: ${err.message}`);
  }

  // doctor runs even after a failed step — its table is the diagnosis; the failure keeps the exit code
  const doctorCode = await closingDoctor(r, runDir, opts.doctorDeps, opts.doctorFn ?? doctor);
  return { code: failure ? failure.code || 1 : doctorCode, source, commands: r.commands };
}

/** A Postgres superuser password: 256 bits of randomness, alphanumeric so no conf or connection string ever needs to quote it. */
function mintPassword(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(43);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
}
