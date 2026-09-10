// `metistry migrate-shape <launchd|compose>` — the ONE verb that moves a
// live install between the two deployment shapes (open decision 15), with
// the data.
//
// Why this is not a flag on `deployment set-shape`. `set-shape` writes one
// line of `deployment.yaml` through the reconciler and REFUSES while
// anything is still running under the current shape — it is a config verb,
// and its refusal is the thing that stops someone flipping the file out
// from under a running Postgres. A migration has to run against a live
// install (that is where the data is), take a dump, stop the old shape,
// flip the file, start the new one and restore. Folding that into
// `set-shape` would mean a config write that also moves data and a refusal
// that has to be disabled to do the job it exists to guard. So: a separate
// verb, which CALLS `setDeploymentShape` for the file write rather than
// reimplementing the protected-write path (invariant 2 — `deployment.yaml`
// is a §4.7 protected path and the reconciler is the instance repo's sole
// committer, D5).
//
// Everything runs through the shared StepRunner (steps.ts), so `--dry-run`
// is the same code path with execution turned off and the tests assert the
// exact argv order.
//
// The data does NOT move on its own: the two shapes keep their databases in
// different places (a Docker named volume versus `<instance>/state/pg`), so
// this is dump → fresh initdb → restore. Invariant 1 is what makes even a
// failed restore survivable — git is the record, Postgres is derived — but
// a migration that lost the trend lines anyway would be a bad migration, so
// the dump is verified before anything is stopped and the row counts are
// compared before it is called done.

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Deployment, DeploymentShape } from "@foldedspacelabs/metistry-core";
import { loadDeployment, dbPort } from "./deployment.js";
import { setDeploymentShape } from "./deployment-report.js";
import { doctor, renderTable, type DoctorDeps, type DoctorReport } from "./doctor.js";
import type { Exec } from "./exec.js";
import { labelFor, loadPlistTemplates, launchAgentsDir, renderPlist, withEnvironmentVariables, type PlistTemplate } from "./launchd.js";
import { loadNamespace } from "./namespace.js";
import { findPgToolchain, pgCandidates, pgSocketDir, type PgToolchain } from "./postgres.js";
import { runtimeDir, runtimeNodeBin, RUNTIME_DIRNAME } from "./runtime-deps.js";
import { StepFailed, StepRunner } from "./steps.js";
import { composeEnvArgs, instanceLock, runDirFor, stateRoot, up, type UpOptions, type UpResult } from "./up.js";

/** The services that actually change supervisor. `reconciler` and `watchdog` are host jobs in either shape (invariant 6). */
export const SHAPE_SERVICES = ["db", "console", "assistant"] as const;

/**
 * The file whose presence means "this product carries #117's launchd
 * fixes". `ops/sandbox/assistant.sb` is the assistant's ONLY confinement
 * once the container boundary is given up, and every runtime pack up to and
 * including v0.5.0 shipped without it (`pack-runtime.sh` grew the copy —
 * and the guard — 14 seconds after the v0.5.0 tag was cut). A release
 * without it produces a launchd shape whose assistant job cannot start at
 * all, so it is a refusal rather than a warning.
 *
 * Checked as a FILE rather than as a version comparison on purpose: the
 * question is "does this product tree contain the thing", which survives
 * re-cuts, backports and a git checkout that was never released.
 */
export const SANDBOX_PROFILE_REL = join("ops", "sandbox", "assistant.sb");

/** `pg_dump`/`pg_restore` are not in `PG_BINARIES` (nothing else calls them), so this verb checks for them itself. */
export const MIGRATE_PG_BINARIES = ["pg_dump", "pg_restore", "psql"] as const;

/**
 * Exact per-table row counts for every table in `public`, as
 * `name=count` lines. `pg_stat_user_tables.n_live_tup` would be one query
 * instead of this mouthful, but it is an ESTIMATE and a freshly restored
 * database has not been analysed — the whole point here is to prove the
 * restore moved every row, so the count has to be a real `count(*)`.
 */
export const TABLE_COUNTS_SQL =
  "SELECT table_name || '=' || (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', table_schema, table_name), false, true, '')))[1]::text " +
  "FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name";

/**
 * The Developer-ID-signed Swift helper bundles (D3), which the runtime pack
 * does NOT carry — `pack-runtime.sh` copies each `mcp-<name>/helper`, but the
 * `.app` bundles inside it are gitignored build output that no release
 * runner builds, so a release ships the sources and the Info.plist and
 * nothing executable (verified against the installed v0.5.0 pack).
 *
 * Under the compose shape this never showed, because the two host bridge
 * jobs were rendered with `__REPO__` = the git checkout, which is where the
 * hand-built bundles live. Re-rendering them against `current/` would point
 * both at a path that does not exist.
 *
 * So for THIS cutover the two jobs keep pointing at the bundles that
 * already hold the TCC grant — same bundle id, same certificate chain,
 * therefore the same TCC designated requirement, therefore no re-grant
 * (docs/ops/apple-signing.md §3). Shipping prebuilt signed helpers in the
 * pack is the real fix and is recorded as a follow-up.
 *
 * Two different mechanisms, because the two bridges find their helper two
 * different ways:
 *
 *   eventkit-helper  the helper IS the launchd job — the path is in the
 *                    plist's ProgramArguments, so that plist is re-rendered
 *                    with `__REPO__` = the bundle's directory.
 *   apple-fm         the node bridge spawns its helper from a path relative
 *                    to its own dist/ (`packages/mcp-apple-fm/src/main.ts`),
 *                    overridable by METISTRY_AFM_HELPER — so the override
 *                    goes into that job's EnvironmentVariables.
 */
export interface TccHelper {
  /** the plist service whose job needs the pin */
  service: string;
  /** the bundle, relative to a product tree */
  bundle: string;
  /** the executable inside the bundle */
  exe: string;
  /** set this variable in the job's environment instead of re-rendering __REPO__ */
  envVar?: string;
}

export const TCC_HELPERS: TccHelper[] = [
  {
    service: "eventkit-helper",
    bundle: join("packages", "mcp-eventkit", "helper", "ek-helper.app"),
    exe: join("Contents", "MacOS", "ek-helper"),
  },
  {
    service: "apple-fm",
    bundle: join("packages", "mcp-apple-fm", "helper", "afm-helper.app"),
    exe: join("Contents", "MacOS", "afm-helper"),
    envVar: "METISTRY_AFM_HELPER",
  },
];

export interface MigrateShapeOptions {
  productDir: string;
  /** the shape to end up in */
  target: DeploymentShape;
  env?: NodeJS.ProcessEnv | undefined;
  exec?: Exec | undefined;
  out?: ((line: string) => void) | undefined;
  dryRun?: boolean | undefined;
  platform?: NodeJS.Platform | undefined;
  uid?: number | undefined;
  home?: string | undefined;
  /** `--env-file`: the dotenv file this install runs from */
  envFile?: string | undefined;
  /** passed through to `up` — a namespaced instance keeps its own labels and ports */
  namespace?: boolean | undefined;
  fetchFn?: typeof fetch | undefined;
  /** test seam: filesystem probes */
  exists?: ((p: string) => boolean) | undefined;
  /** test seam: the timestamp the dump file is named after */
  now?: (() => Date) | undefined;
  /** test seam: the `up` this plan runs for the new shape */
  upFn?: ((opts: UpOptions) => Promise<UpResult>) | undefined;
  /** test seam: the protected write of deployment.yaml */
  setShapeFn?: typeof setDeploymentShape | undefined;
  /** test seam for the closing doctor */
  doctorFn?: ((deps: DoctorDeps) => Promise<DoctorReport>) | undefined;
  doctorDeps?: Partial<DoctorDeps> | undefined;
}

export interface MigrateShapeResult {
  code: number;
  /** where the dump landed (launchd direction only) */
  dump?: string | undefined;
  /** every command/write/action, in order — `--dry-run` prints exactly this */
  commands: string[];
}

/** `20260910T160403Z` — sortable, no punctuation a filesystem or a shell cares about. */
export function stamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

/** `<instance>/state/migrate` — derived, gitignored, beside `state/pg`. Dumps are kept, never pruned by this verb. */
export function migrateDir(root: string): string {
  return join(root, "state", "migrate");
}

/** `pg_restore --list` output is a TOC; the entry lines start with a number. Anything else is a header comment. */
export function tocEntryCount(listing: string): number {
  return listing.split("\n").filter((l) => /^\d+;/.test(l)).length;
}

/** `name=count` lines → a map, so a difference can be reported per table rather than as two walls of text. */
export function parseCounts(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

/** Tables whose count changed (or which appeared/vanished) between the dump and the restore. Empty = the data all came across. */
export function countDiff(before: Record<string, string>, after: Record<string, string>): string[] {
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return names.filter((n) => before[n] !== after[n]).map((n) => `${n}: ${before[n] ?? "(absent)"} → ${after[n] ?? "(absent)"}`);
}

interface Ctx {
  r: StepRunner;
  env: NodeJS.ProcessEnv;
  /** the install root — `.env`, `state/`, `runtime/` live here, never inside a release */
  productDir: string;
  /** the product's files: `current` in release mode */
  runDir: string;
  instanceDir: string;
  envFile: string;
  platform: NodeJS.Platform;
  uid: number;
  home: string;
  labelSuffix: string | undefined;
  composeBase: string[];
  /** COMPOSE_PROJECT_NAME, when this install pins one — see `composeProject` */
  project: string | undefined;
}

/**
 * Which docker compose PROJECT this install's containers belong to.
 *
 * `docker-compose.yml` carries `name: metistry`, so every install on a Mac
 * shares one project unless something says otherwise — and `--namespace`
 * does not: it namespaces launchd labels and ports and nothing else
 * (namespace.ts). That is fine for a single install and actively dangerous
 * for two, because `docker compose stop db console assistant` run from a
 * SECOND install's product tree would stop the FIRST install's containers.
 *
 * Docker's precedence is `-p` > `COMPOSE_PROJECT_NAME` > the file's `name:`,
 * so an install that sets the variable gets its own project — and this
 * passes `-p` explicitly rather than relying on the variable reaching the
 * subprocess, so the project is visible in the printed plan.
 */
export function composeProject(env: NodeJS.ProcessEnv): string | undefined {
  const p = env.COMPOSE_PROJECT_NAME?.trim();
  return p ? p : undefined;
}

/** `docker compose [--env-file …] <args>`, run from the product tree that owns docker-compose.yml — exactly what `up` does. */
function compose(ctx: Ctx, args: string[]): { cmd: string; args: string[]; cwd: string } {
  return { cmd: "docker", args: [...ctx.composeBase, ...args], cwd: ctx.runDir };
}

// ---- preflight ---------------------------------------------------------------

export interface Preflight {
  toolchain: PgToolchain;
  sandboxProfile: string;
}

/**
 * Everything that must be TRUE before a single mutating step runs. Each of
 * these is a refusal with a remediation, not a warning: this verb stops a
 * live install, and the worst possible outcome is stopping it and then
 * discovering the new shape cannot start.
 */
export async function preflightLaunchd(ctx: Ctx, exists: (p: string) => boolean): Promise<Preflight> {
  if (ctx.platform !== "darwin") {
    throw new StepFailed(`the launchd shape is macOS only — this is ${ctx.platform} (docs/ops/deployment-shapes.md, "Linux hosts")`);
  }

  // 1. the bundled runtime. Without it the launchd shape has no Postgres to
  //    initdb into and no node for the plists to exec, and `up` would try to
  //    download one MID-MIGRATION with the old shape already stopped.
  if (!exists(runtimeNodeBin(ctx.productDir))) {
    throw new StepFailed(
      `${runtimeDir(ctx.productDir)} has no node — this install has no bundled runtime, and the launchd shape's jobs exec it ` +
        `(docs/ops/bundled-runtime.md). Run \`metistry update --channel release\` to install one, then re-run. Nothing was changed.`,
    );
  }
  const toolchain = findPgToolchain(pgCandidates(ctx.env, ctx.productDir), exists);
  if (!toolchain) {
    throw new StepFailed(
      `no Postgres ${MIGRATE_PG_BINARIES.join("/")}-capable toolchain found for the launchd shape (looked in ${pgCandidates(ctx.env, ctx.productDir)
        .map((c) => c.bin)
        .join(", ")}). Nothing was changed.`,
    );
  }
  const missing = MIGRATE_PG_BINARIES.filter((b) => !exists(join(toolchain.bin, b)));
  if (missing.length > 0) {
    throw new StepFailed(`${toolchain.bin} has no ${missing.join(", ")} — this migration dumps and restores with them. Nothing was changed.`);
  }
  if (!toolchain.pgvector) {
    throw new StepFailed(
      `pgvector is not installed next to ${toolchain.bin} — the dump restores \`CREATE EXTENSION vector\` and would fail half way. Nothing was changed.`,
    );
  }

  // 2. #117's fix. A pack without the sandbox profile produces an assistant
  //    job that cannot start; see SANDBOX_PROFILE_REL.
  const sandboxProfile = join(ctx.runDir, SANDBOX_PROFILE_REL);
  if (!exists(sandboxProfile)) {
    throw new StepFailed(
      `${sandboxProfile} is missing — this product tree predates the launchd-shape fixes (PR #117), so the assistant's launchd job ` +
        `would have no sandbox profile to exec and could not start at all (docs/ops/deployment-shapes.md). Every runtime pack up to and ` +
        `including v0.5.0 is affected. Install a release whose pack carries ops/sandbox/, then re-run. Nothing was changed.`,
    );
  }
  // 3. a namespaced instance whose compose half is NOT namespaced would stop
  //    the OTHER install's containers — see `composeProject`. This is the one
  //    refusal that protects an install this command was not pointed at.
  if (ctx.labelSuffix && !ctx.project) {
    throw new StepFailed(
      `this instance is namespaced (labels ${labelFor("<service>", ctx.labelSuffix)}) but its docker compose project is not: docker-compose.yml carries ` +
        `\`name: metistry\`, so \`docker compose stop\` here would stop ANOTHER install's containers. Set COMPOSE_PROJECT_NAME in ${ctx.envFile} to this ` +
        `instance's own project and re-run. Nothing was changed.`,
    );
  }

  ctx.r.note(`runtime: ${runtimeDir(ctx.productDir)} — node + ${toolchain.bin} (${toolchain.why}), pgvector present`);
  ctx.r.note(`sandbox profile: ${sandboxProfile} — present, so the assistant job can start under launchd`);
  return { toolchain, sandboxProfile };
}

// ---- the dump ----------------------------------------------------------------

/**
 * `pg_dump` runs INSIDE the running container, with the container's own
 * binaries: the server is `pgvector/pgvector:pg17` and a dump taken by a
 * mismatched client is a class of failure nobody needs at cutover time. The
 * file is then copied out and the container-side copy removed.
 *
 * No password anywhere: the postgres image's `pg_hba.conf` has `local all
 * all trust`, so the in-container socket connection needs none — which is
 * also why this never puts one in an argv `ps` could read (postgres.ts's
 * pwfile rule, same reasoning).
 */
export async function dumpCompose(ctx: Ctx, toolchain: PgToolchain, ts: string): Promise<{ path: string; before: Record<string, string> }> {
  const user = ctx.env.METISTRY_DB_USER || "metistry";
  const database = ctx.env.METISTRY_DB_NAME || "metistry";
  const inContainer = `/tmp/metistry-migrate-${ts}.dump`;
  const path = join(migrateDir(stateRoot(ctx.productDir, ctx.env)), `${ts}.dump`);

  // the counts are taken from the SAME live database the dump comes from,
  // and compared after the restore — the check that the data actually moved
  let before: Record<string, string> = {};
  const counts = compose(ctx, ["exec", "-T", "db", "psql", "-U", user, "-d", database, "-tA", "--no-psqlrc", "-c", TABLE_COUNTS_SQL]);
  const cres = await ctx.r.run(counts.cmd, counts.args, { cwd: counts.cwd, comment: "row counts before the dump" });
  before = parseCounts(cres.stdout);
  if (!ctx.r.dryRun) ctx.r.note(`counts: ${Object.keys(before).length} tables, ${Object.entries(before).map(([k, v]) => `${k}=${v}`).join(" ")}`);

  const dump = compose(ctx, ["exec", "-T", "db", "pg_dump", "-U", user, "-d", database, "--format=custom", "--compress=6", "--file", inContainer]);
  await ctx.r.run(dump.cmd, dump.args, { cwd: dump.cwd, timeoutMs: 30 * 60_000, comment: "the container's own pg_dump — same version as the server" });
  await ctx.r.run("mkdir", ["-p", migrateDir(stateRoot(ctx.productDir, ctx.env))]);
  const cp = compose(ctx, ["cp", `db:${inContainer}`, path]);
  await ctx.r.run(cp.cmd, cp.args, { cwd: cp.cwd, timeoutMs: 30 * 60_000 });
  const rm = compose(ctx, ["exec", "-T", "db", "rm", "-f", inContainer]);
  await ctx.r.run(rm.cmd, rm.args, { cwd: rm.cwd, tolerateFailure: true, comment: "the copy inside the container is not the record" });

  // verify BEFORE anything is stopped: a dump that pg_restore cannot read is
  // a migration that must not start
  const list = await ctx.r.run(join(toolchain.bin, "pg_restore"), ["--list", path], { comment: "the dump must be readable before anything is stopped" });
  if (!ctx.r.dryRun) {
    const entries = tocEntryCount(list.stdout);
    if (entries === 0) throw new StepFailed(`${path} has no restorable entries — refusing to stop a healthy install behind an empty dump`);
    ctx.r.note(`dump verified: ${path}, ${entries} TOC entries`);
  }
  return { path, before };
}

// ---- the TCC helper bundles ----------------------------------------------------

/**
 * Pin the two bridge jobs at the signed helper bundles that already hold
 * the TCC grant (see TCC_HELPERS). Runs AFTER `up` has written every plist,
 * because it is a correction to two of them, and re-bootstraps only those.
 *
 * A bundle that is not there is a NOTE, not a failure: an install with no
 * calendar bridge is a healthy install (doctor reports `absent`), and
 * failing a database migration over a missing Swift binary would be absurd.
 */
export async function pinTccHelpers(ctx: Ctx, templates: PlistTemplate[], node: string, exists: (p: string) => boolean): Promise<string[]> {
  const pinned: string[] = [];
  for (const h of TCC_HELPERS) {
    const t = templates.find((x) => x.service === h.service);
    if (!t) continue;
    const inRelease = join(ctx.runDir, h.bundle, h.exe);
    if (exists(inRelease)) {
      ctx.r.note(`${h.service}: ${inRelease} is in this release — no pin needed`);
      continue;
    }
    const onHost = join(ctx.productDir, h.bundle, h.exe);
    if (!exists(onHost)) {
      ctx.r.note(
        `${h.service}: no signed helper at ${onHost} and none in the release — this bridge will not start. ` +
          `Build it (packages/${h.service === "apple-fm" ? "mcp-apple-fm" : "mcp-eventkit"}/scripts/build-helper.sh) and re-run \`metistry up\`; ` +
          `doctor reports the bridge absent until then.`,
      );
      continue;
    }
    const target = join(launchAgentsDir(ctx.home), t.file);
    if (h.envVar) {
      // the bridge is a node service that resolves its helper relative to its
      // own dist/; the override is one environment entry, so the plist is
      // rendered exactly as `up` rendered it and then gains the variable
      const rendered = renderPlist(t.template, { repo: ctx.runDir, node, envFile: ctx.envFile });
      await ctx.r.write(target, withEnvironmentVariables(rendered, { [h.envVar]: join(ctx.productDir, h.bundle, h.exe) }), `ops/launchd/${t.file}, ${h.envVar}=${onHost} (the signed bundle holding the TCC grant; this release carries none)`);
    } else {
      // the helper IS the job's root process, so the path is in
      // ProgramArguments: render this one template against the tree that has
      // the bundle
      await ctx.r.write(target, renderPlist(t.template, { repo: ctx.productDir, node, envFile: ctx.envFile }), `ops/launchd/${t.file}, __REPO__=${ctx.productDir} (the signed bundle holding the TCC grant; this release carries none)`);
    }
    const label = labelFor(h.service, ctx.labelSuffix);
    await ctx.r.run("launchctl", ["bootout", `gui/${ctx.uid}/${label}`], { tolerateFailure: true, comment: "ok if not loaded" });
    await ctx.r.run("launchctl", ["bootstrap", `gui/${ctx.uid}`, target]);
    await ctx.r.run("launchctl", ["kickstart", "-k", `gui/${ctx.uid}/${label}`]);
    pinned.push(`${h.service} → ${onHost}`);
  }
  return pinned;
}

// ---- the plan ------------------------------------------------------------------

/**
 * `up`'s closing doctor, deferred. Between `up` and the restore the database
 * is EMPTY — every schema-reading probe would fail, and printing that table
 * mid-migration would be alarming and meaningless. The migration runs the
 * real doctor at the end, after the restore, and that verdict is the exit
 * code.
 */
const deferredDoctor = async (d: DoctorDeps): Promise<DoctorReport> => ({
  as_of: new Date().toISOString(),
  product_dir: d.productDir,
  shape: d.deployment?.shape ?? "launchd",
  ok: true,
  rows: [
    {
      kind: "migrate-shape",
      name: "doctor",
      status: "ok",
      latency_ms: 0,
      probe: "deferred — the database is still empty at this point; migrate-shape runs the real doctor after the restore",
    },
  ],
});

export async function migrateShape(opts: MigrateShapeOptions): Promise<MigrateShapeResult> {
  const env = opts.env ?? process.env;
  const r = new StepRunner({ dryRun: opts.dryRun === true, out: opts.out ?? ((s) => process.stdout.write(s + "\n")), exec: opts.exec, env });
  const exists = opts.exists ?? existsSync;
  const lock = await instanceLock(env);
  const source = lock?.product.source ?? "git";
  const runDir = runDirFor(opts.productDir, source);
  const loaded = await loadDeployment(runDir, env);
  const instanceDir = env.METISTRY_INSTANCE_DIR?.replace(/\/+$/, "");
  const ns = await loadNamespace(instanceDir);

  const ctx: Ctx = {
    r,
    env,
    productDir: opts.productDir,
    runDir,
    instanceDir: instanceDir ?? "",
    envFile: opts.envFile ?? (instanceDir ? join(instanceDir, "state", ".env") : join(opts.productDir, ".env")),
    platform: opts.platform ?? process.platform,
    uid: opts.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0),
    home: opts.home ?? env.HOME ?? "",
    labelSuffix: ns?.labelSuffix,
    project: composeProject(env),
    composeBase: [
      "compose",
      ...(composeProject(env) ? ["-p", composeProject(env)!] : []),
      ...composeEnvArgs(runDir, opts.envFile ?? (instanceDir ? join(instanceDir, "state", ".env") : undefined)),
    ],
  };

  r.section(`migrate-shape ${opts.target}`);
  r.note(`product: ${runDir}${source === "release" ? ` (pinned release${lock ? ` ${lock.product.version}` : ""})` : " (git checkout)"}`);
  r.note(`shape now: ${loaded.deployment.shape} — from ${loaded.from}`);
  r.note(`instance: ${instanceDir || "(none)"}`);
  if (ns) r.note(`namespace: labels ${labelFor("<service>", ns.labelSuffix)}, ports ${ns.base}-${ns.base + 7}`);
  r.note(`compose project: ${ctx.project ?? "the file's own `name:` (docker-compose.yml) — this Mac's only Metistry install"}`);

  let dumpPath: string | undefined;
  try {
    if (!instanceDir) {
      throw new StepFailed("migrate-shape needs the instance repo: pass --instance <dir> or set METISTRY_INSTANCE_DIR — deployment.yaml and state/ both live there");
    }
    if (loaded.deployment.shape === opts.target) {
      throw new StepFailed(`this install is already shape: ${opts.target} (from ${loaded.from}) — nothing to migrate`);
    }
    dumpPath =
      opts.target === "launchd" ? await toLaunchd(ctx, opts, exists, loaded.deployment) : await toCompose(ctx, opts, loaded.deployment);
  } catch (err) {
    if (!(err instanceof StepFailed)) throw err;
    r.out(`metistry migrate-shape: ${err.message}`);
    return { code: err.code || 1, ...(dumpPath ? { dump: dumpPath } : {}), commands: r.commands };
  }

  r.section("doctor");
  if (!r.action("metistry doctor")) return { code: 0, ...(dumpPath ? { dump: dumpPath } : {}), commands: r.commands };
  const report = await (opts.doctorFn ?? doctor)({ productDir: runDir, exec: r.exec, env, ...opts.doctorDeps });
  r.out(renderTable(report));
  return { code: report.ok ? 0 : 1, ...(dumpPath ? { dump: dumpPath } : {}), commands: r.commands };
}

/** compose → launchd: the migration proper. */
async function toLaunchd(ctx: Ctx, opts: MigrateShapeOptions, exists: (p: string) => boolean, current: Deployment): Promise<string> {
  const { r } = ctx;

  r.section("preflight");
  const pre = await preflightLaunchd(ctx, exists);
  // the compose db has to be RUNNING — it is what we dump from
  const ps = compose(ctx, ["ps", "-q", "db"]);
  const psr = await r.run(ps.cmd, ps.args, { cwd: ps.cwd, tolerateFailure: true, comment: "the db container is what the dump comes from" });
  if (!r.dryRun && psr.stdout.trim() === "") {
    throw new StepFailed(
      "no running compose `db` container — this migration dumps the live database through it. Start it (`docker compose up -d db`) and re-run, " +
        "or if this install has no data worth keeping, use `metistry deployment set-shape launchd` + `metistry up` instead. Nothing was changed.",
    );
  }

  r.section("dump");
  const ts = stamp((opts.now ?? (() => new Date()))());
  const { path: dumpPath, before } = await dumpCompose(ctx, pre.toolchain, ts);

  r.section("stop compose");
  r.note("the containers and the named volume are LEFT IN PLACE — that is what makes this reversible (`metistry migrate-shape compose`)");
  const stop = compose(ctx, ["stop", ...SHAPE_SERVICES]);
  await r.run(stop.cmd, stop.args, { cwd: stop.cwd, timeoutMs: 10 * 60_000 });

  r.section("deployment.yaml");
  r.note("a §4.7 protected path — written through the reconciler as the `user` principal, the same path `metistry deployment set-shape` uses (invariant 2)");
  const set = await (opts.setShapeFn ?? setDeploymentShape)({
    productDir: ctx.productDir,
    instanceDir: ctx.instanceDir,
    targetShape: "launchd",
    yes: !r.dryRun,
    // the services this would refuse over are the ones we just stopped, with
    // a verified dump in hand — which is exactly the condition --force
    // documents ("the operator saying they already took the dump")
    force: true,
    env: ctx.env,
    platform: ctx.platform,
    uid: ctx.uid,
    fetchFn: opts.fetchFn ?? fetch,
    ...(opts.exec ? { exec: opts.exec } : {}),
    out: r.out,
  });
  r.commands.push(`deployment set-shape launchd (${set.detail})`);
  if (set.refused) throw new StepFailed(`deployment.yaml was not written: ${set.detail}`);
  r.note(set.detail);

  r.section("up (launchd)");
  const upResult = await (opts.upFn ?? up)({
    productDir: ctx.productDir,
    env: ctx.env,
    exec: opts.exec,
    out: r.out,
    dryRun: r.dryRun,
    compose: false,
    platform: ctx.platform,
    uid: ctx.uid,
    home: ctx.home,
    envFile: opts.envFile,
    namespace: opts.namespace,
    // the shape changes; the instance's per-service overrides do NOT — a
    // `services: { assistant: { enabled: false } }` must survive a migration
    deployment: { ...current, shape: "launchd" },
    fetchFn: opts.fetchFn,
    exists: opts.exists,
    doctorFn: deferredDoctor,
  });
  for (const c of upResult.commands) r.commands.push(c);
  if (upResult.code !== 0) {
    throw new StepFailed(
      `\`metistry up\` failed under the launchd shape (exit ${upResult.code}). The dump is at ${dumpPath} and the compose containers and volume are ` +
        `untouched — roll back with \`metistry migrate-shape compose\`.`,
      upResult.code,
    );
  }

  r.section("restore");
  r.note("restored BEFORE any migration runs: the dump carries schema_migrations, so the next `metistry update` finds every file already recorded and applies none");
  const socketDir = pgSocketDir(stateRoot(ctx.productDir, ctx.env));
  const conn = ["-h", socketDir, "-p", String(dbPort(ctx.env)), "-U", ctx.env.METISTRY_DB_USER || "metistry", "-d", ctx.env.METISTRY_DB_NAME || "metistry"];
  await r.run(join(pre.toolchain.bin, "pg_restore"), [...conn, "--no-owner", "--no-privileges", "--exit-on-error", dumpPath], {
    timeoutMs: 60 * 60_000,
    comment: "local socket, --auth-local=trust — no password on a command line",
  });

  const after = await r.run(join(pre.toolchain.bin, "psql"), [...conn, "-tA", "--no-psqlrc", "-c", TABLE_COUNTS_SQL], { comment: "row counts after the restore" });
  if (!r.dryRun) {
    const diff = countDiff(before, parseCounts(after.stdout));
    if (diff.length > 0) {
      throw new StepFailed(
        `the restored database does not match the dump — ${diff.join("; ")}. The dump is at ${dumpPath} and the compose volume is untouched; ` +
          `roll back with \`metistry migrate-shape compose\` and report this.`,
      );
    }
    r.note(`counts match: ${Object.keys(before).length} tables, every row count identical to the compose database`);
  }

  r.section("tcc helpers");
  const templates = await loadPlistTemplates(ctx.runDir, "launchd", ctx.labelSuffix);
  const node = runtimeNodeBin(ctx.productDir);
  const pinned = await pinTccHelpers(ctx, templates, node, exists);
  if (pinned.length > 0) r.note(`pinned at the signed bundles that hold the TCC grant (same bundle id + certificate chain = same designated requirement, so no re-grant): ${pinned.join(", ")}`);

  r.section("restart the services that were waiting on a schema");
  // only the jobs this product tree actually installed: a trial install that
  // removed a plist (or a shape with no assistant) must not fail here on a
  // kickstart of a label launchd has never heard of
  for (const s of ["console", "assistant"]) {
    if (!templates.some((t) => t.service === s)) {
      r.note(`${s}: no plist in ${join(ctx.runDir, "ops", "launchd")} — not installed, so nothing to restart`);
      continue;
    }
    await r.run("launchctl", ["kickstart", "-k", `gui/${ctx.uid}/${labelFor(s, ctx.labelSuffix)}`], { comment: "it started against an empty database" });
  }

  r.note(`dump kept at ${dumpPath} — it is the only copy of the compose database outside the Docker volume, which stays until you run \`docker compose down -v\``);
  return dumpPath;
}

/** launchd → compose: the documented rollback. */
async function toCompose(ctx: Ctx, opts: MigrateShapeOptions, current: Deployment): Promise<undefined> {
  const { r } = ctx;
  r.section("rollback to compose");
  r.note("THE DATA DOES NOT COME BACK WITH YOU. The compose volume still holds the database as it was at the cutover; everything written under the");
  r.note("launchd shape since then stays in " + join(stateRoot(ctx.productDir, ctx.env), "state", "pg") + " and is NOT copied over. Dump it first if you want it:");
  r.note(`  ${join(runtimeDir(ctx.productDir), "postgres", "bin", "pg_dump")} -h ${pgSocketDir(stateRoot(ctx.productDir, ctx.env))} -U ${ctx.env.METISTRY_DB_USER || "metistry"} -d ${ctx.env.METISTRY_DB_NAME || "metistry"} -Fc -f <somewhere>`);

  r.section("stop the launchd jobs");
  for (const s of SHAPE_SERVICES) {
    await r.run("launchctl", ["bootout", `gui/${ctx.uid}/${labelFor(s, ctx.labelSuffix)}`], { tolerateFailure: true, comment: "ok if not loaded" });
  }

  r.section("deployment.yaml");
  const set = await (opts.setShapeFn ?? setDeploymentShape)({
    productDir: ctx.productDir,
    instanceDir: ctx.instanceDir,
    targetShape: "compose",
    yes: !r.dryRun,
    force: true,
    env: ctx.env,
    platform: ctx.platform,
    uid: ctx.uid,
    fetchFn: opts.fetchFn ?? fetch,
    ...(opts.exec ? { exec: opts.exec } : {}),
    out: r.out,
  });
  r.commands.push(`deployment set-shape compose (${set.detail})`);
  if (set.refused) throw new StepFailed(`deployment.yaml was not written: ${set.detail}`);
  r.note(set.detail);

  r.section("up (compose)");
  const upResult = await (opts.upFn ?? up)({
    productDir: ctx.productDir,
    env: ctx.env,
    exec: opts.exec,
    out: r.out,
    dryRun: r.dryRun,
    platform: ctx.platform,
    uid: ctx.uid,
    home: ctx.home,
    envFile: opts.envFile,
    deployment: { ...current, shape: "compose" },
    fetchFn: opts.fetchFn,
    exists: opts.exists,
    doctorFn: deferredDoctor,
  });
  for (const c of upResult.commands) r.commands.push(c);
  if (upResult.code !== 0) throw new StepFailed(`\`metistry up\` failed under the compose shape (exit ${upResult.code})`, upResult.code);
  return undefined;
}
