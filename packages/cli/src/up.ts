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
import { launchAgentsDir, launchdCommands, loadPlistTemplates, nodeOnPath, renderPlist, renderSystemdUnit, type PlistTemplate, type PlistValues } from "./launchd.js";
import { instanceLockPath, readLock, type LockFile, type LockSource } from "./lock.js";
import { currentLink, imageEnv, imageRef, IMAGE_SERVICES } from "./release.js";
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
  /** test seam: the deployment shape, normally read from deployment.yaml */
  deployment?: Deployment | undefined;
  /** test seam: filesystem probes (the Postgres toolchain, an initialised data dir) */
  exists?: ((p: string) => boolean) | undefined;
  /** test seam: the password generated for a fresh Postgres */
  mintPassword?: (() => string) | undefined;
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

// ---- the launchd shape's per-service values ---------------------------------

/** The root the instance's derived state hangs off: the instance repo when there is one, else the checkout. */
export function stateRoot(productDir: string, env: NodeJS.ProcessEnv): string {
  return env.METISTRY_INSTANCE_DIR?.replace(/\/+$/, "") || productDir;
}

export interface ShapeValues extends ShapeContext {
  node: string;
  /** rendered into the db plist; undefined when no toolchain was found (the db section reports that) */
  pgBin?: string | undefined;
  /** the data directory `up` prepared; defaults to the one under `stateRoot(productDir)` */
  pgData?: string | undefined;
  home: string;
}

/**
 * What each plist template needs beyond `__REPO__`/`__NODE__`. The host jobs
 * that exist in both shapes (reconciler, watchdog, the TCC bridges) take
 * neither an env dict nor extra placeholders — they source `.env`
 * themselves, exactly as they did before.
 */
export function plistValuesFor(t: PlistTemplate, v: ShapeValues): PlistValues {
  const base = { repo: v.productDir, node: v.node };
  switch (t.service) {
    case "console":
      return { ...base, env: consoleEnv(v) };
    case "assistant": {
      const p = sandboxParams({ productDir: v.productDir, nodeBin: v.node, stateDir: v.stateDir, consolePort: consolePort(v.env), tmpDir: tmpDirOf(v.env) });
      // every path parameter is the REAL path: the kernel matches the
      // profile's subpaths after resolving symlinks (/tmp → /private/tmp)
      return { ...base, env: assistantEnv(v), extra: { NODE_PREFIX: p.NODE_PREFIX, PRODUCT_DIR: p.PRODUCT_DIR, STATE_DIR: p.STATE_DIR, TMP_DIR: p.TMP_DIR, CONSOLE_TCP: p.CONSOLE_TCP } };
    }
    case "db":
      return { ...base, extra: { PG_BIN: v.pgBin ?? "", PG_DATA: v.pgData ?? pgDataDir(stateRoot(v.productDir, v.env)) } };
    default:
      return base;
  }
}

/** The plists whose EnvironmentVariables dict holds this install's secrets, so they are written 0600. */
export const SECRET_BEARING_SERVICES = new Set(["console", "assistant"]);

/** Render every template into ~/Library/LaunchAgents and (re)bootstrap it; on anything but macOS, print the systemd units instead. */
export async function installLaunchd(r: StepRunner, productDir: string, le: LaunchdEnv, deployment: Deployment, values: ShapeValues): Promise<void> {
  const templates = await loadPlistTemplates(productDir, deployment.shape);
  if (templates.length === 0) {
    r.note("no ops/launchd/*.plist in this checkout — nothing to install");
    return;
  }
  if (le.platform !== "darwin") {
    r.note(`no launchd on ${le.platform}: the equivalent systemd user units follow — NOT written (docs/ops/cli.md, "Linux hosts")`);
    r.note("install them by hand: save each to ~/.config/systemd/user/, then systemctl --user daemon-reload && systemctl --user enable --now <unit>");
    for (const t of templates) {
      r.out("");
      r.out(renderSystemdUnit(t, { repo: productDir, node: le.node }));
    }
    return;
  }
  const dir = launchAgentsDir(le.home);
  for (const t of templates) {
    const target = join(dir, t.file);
    const v = plistValuesFor(t, values);
    const from = `ops/launchd/${t.file}, __REPO__=${productDir}, __NODE__=${le.node}${v.env ? `, ${Object.keys(v.env).length} EnvironmentVariables from .env` : ""}`;
    await r.write(target, renderPlist(t.template, v), from);
    // the console's and the assistant's dicts carry db passwords, bridge
    // tokens and CLAUDE_CODE_OAUTH_TOKEN; ~/Library/LaunchAgents is 0755, so
    // the file itself has to be the boundary
    if (SECRET_BEARING_SERVICES.has(t.service)) await r.run("chmod", ["600", target], { comment: "the env dict holds secrets" });
    for (const c of launchdCommands(t.label, target, le.uid)) {
      await r.run(c.cmd, c.args, { tolerateFailure: c.tolerateFailure, comment: c.tolerateFailure ? "ok if not loaded" : undefined });
    }
  }
}

// ---- the launchd shape's Postgres --------------------------------------------

/** How long `up` waits for the freshly bootstrapped server to answer before letting doctor report it. */
export const PG_READY_TRIES = 15;

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
export async function preparePostgres(r: StepRunner, productDir: string, opts: { exists?: ((p: string) => boolean) | undefined; mintPassword: () => string }): Promise<PgSection> {
  const env = r.env;
  const exists = opts.exists ?? existsSync;
  const toolchain = findPgToolchain(pgCandidates(env, productDir), exists);
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
  // appended there (never printed, never committed — .env is gitignored)
  let password = env.METISTRY_DB_PASSWORD ?? "";
  if (password === "") {
    password = opts.mintPassword();
    const envFile = join(productDir, ".env");
    const current = existsSync(envFile) ? await readFile(envFile, "utf8") : "";
    const next = withEnvLine(current, "METISTRY_DB_PASSWORD", password);
    if (next) await r.write(envFile, next, "generated METISTRY_DB_PASSWORD (not shown; .env is gitignored)");
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
  const le: LaunchdEnv = {
    platform: opts.platform ?? process.platform,
    uid: opts.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0),
    home: opts.home ?? env.HOME ?? "",
    node: opts.node ?? nodeOnPath(env),
  };
  const instanceDir = env.METISTRY_INSTANCE_DIR ? { instanceDir: env.METISTRY_INSTANCE_DIR.replace(/\/+$/, "") } : {};
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
    home: le.home,
  };
  r.note(`product: ${runDir} (${source === "release" ? `pinned release${lock ? ` ${lock.product.version}` : ""} — images pulled, not built` : "git checkout — images built from source"})`);
  r.note(`shape: ${deployment.shape} — from ${loaded.from}`);
  let failure: StepFailed | undefined;

  try {
    if (opts.compose === false) {
      r.note("--no-compose: containers left as they are");
    } else if (usesCompose(deployment)) {
      r.section("compose");
      await composeUp(r, runDir, source, lock?.product.version);
    } else {
      r.note("shape launchd: no containers, so docker is never called");
    }

    if (opts.launchd === false) {
      r.note("--no-launchd: host jobs left as they are");
    } else {
      if (le.platform === "darwin" && !le.home) throw new StepFailed("HOME is unset — cannot find ~/Library/LaunchAgents");
      let pg: PgSection | undefined;
      if (deployment.shape === "launchd" && le.platform === "darwin") {
        r.section("postgres");
        // the install root, not the release: `.env`, `state/pg` and any
        // bundled runtime/postgres live where the install does
        pg = await preparePostgres(r, opts.productDir, { exists: opts.exists, mintPassword: opts.mintPassword ?? mintPassword });
        values.pgBin = pg.plan.toolchain.bin;
        values.pgData = pg.plan.dataDir;
        await r.run("mkdir", ["-p", values.stateDir], { comment: "the assistant's state dir — HOME, and the only path its sandbox may write" });
      }
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
