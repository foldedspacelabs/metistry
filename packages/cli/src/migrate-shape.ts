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
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Deployment, DeploymentShape } from "@foldedspacelabs/metistry-core";
import { consolePort, dbPort, loadDeployment } from "./deployment.js";
import { setDeploymentShape } from "./deployment-report.js";
import { doctor, renderTable, type DoctorDeps, type DoctorReport } from "./doctor.js";
import type { Exec } from "./exec.js";
import { labelFor, launchdCommands, loadPlistTemplates, launchAgentsDir, renderPlist, withEnvironmentVariables, SUPERVISOR_PLIST_FILE, type PlistTemplate } from "./launchd.js";
import { readSupervisorConfig, serializeSupervisorConfig, supervisorConfigPath, SUPERVISOR_SERVICE } from "./supervisor.js";
import { loadNamespace } from "./namespace.js";
import { findPgToolchain, pgCandidates, pgSocketDir, type PgToolchain } from "./postgres.js";
import { runtimeDir, runtimeNodeBin, RUNTIME_DIRNAME } from "./runtime-deps.js";
import { StepFailed, StepRunner } from "./steps.js";
import { awaitBootout, composeEnvArgs, instanceLock, runDirFor, stateRoot, up, type UpOptions, type UpResult } from "./up.js";

/** The services that actually change supervisor. `reconciler` and `watchdog` are host jobs in either shape (invariant 6). */
export const SHAPE_SERVICES = ["db", "console", "assistant"] as const;

/**
 * Stopped FIRST, before the dump is taken.
 *
 * Everything that writes to the database. `pg_dump` is a consistent
 * snapshot of the moment it runs, so any row written between the dump and
 * `docker compose stop db` lives in the volume and is silently absent from
 * the restored database — a small window, and a real one: the rehearsal
 * caught the console recording a `runs` row inside it. Quiescing the
 * writers first closes it, and it is also what makes the row counts taken
 * beside the dump mean anything.
 *
 * The reconciler is deliberately NOT here: it is a host job in either shape,
 * it holds no database connection it cannot re-open, and it is what commits
 * the `deployment.yaml` write two steps later.
 */
export const WRITER_SERVICES = ["console", "assistant"] as const;

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

/** Every base table in `public`, one per line — asked of the SOURCE, and the list both count queries are then built from. */
export const TABLE_LIST_SQL =
  "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name";

/**
 * Exact per-table row counts as `name=count` lines, as ONE query over a
 * known table list.
 *
 * The obvious one-liner is `query_to_xml` over `information_schema` — and
 * it is what the first cut used, until the rehearsal ran it against the
 * bundled Postgres and got `unsupported XML feature: this functionality
 * requires the server to be built with libxml support`. The bundled runtime
 * is built deliberately minimal (`--without-icu --without-readline
 * --with-zlib`, and no libxml), so anything this verb runs on BOTH sides of
 * the migration has to be plain SQL. `pg_stat_user_tables.n_live_tup` is
 * the other tempting shortcut and is an ESTIMATE, which proves nothing
 * about a freshly restored database that has never been analysed.
 *
 * Building the same text for both sides has a second payoff: a table that
 * did not survive the restore fails the query outright rather than quietly
 * dropping out of a comparison.
 */
export function tableCountsSql(tables: string[]): string {
  const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;
  return `${tables.map((t) => `SELECT ${lit(`${t}=`)} || count(*) FROM ${ident(t)}`).join(" UNION ALL ")} ORDER BY 1`;
}

/**
 * What the plan says in place of the count query during a `--dry-run`.
 *
 * The real query is generated from the table list the source database hands
 * back, and a dry run never asks it — so the alternative to a line like this
 * is a plan with a step silently missing from it.
 */
export const DRY_RUN_COUNTS = "psql: one count(*) per table from the list above";

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
 *   calendar         the EventKit helper IS the launchd job — the path is in
 *                    the plist's ProgramArguments, so that plist is patched
 *                    with the bundle's directory.
 *   apple-fm         the node bridge spawns its helper from a path relative
 *                    to its own dist/ (`packages/mcp-apple-fm/src/main.ts`),
 *                    overridable by METISTRY_AFM_HELPER — so the override
 *                    goes into that job's environment. Under the supervisor
 *                    that job is a CHILD, so the entry goes into its child
 *                    spec in `<instance>/state/supervisor.json` and the
 *                    supervisor is kickstarted; there is no plist of its own
 *                    to patch any more.
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
    service: "calendar",
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
  /** test seam for awaitReady's back-off; the default really sleeps */
  sleep?: ((ms: number) => Promise<void>) | undefined;
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

/** Tables whose count changed (or which appeared/vanished) between the dump and the restore. Empty = every count identical. */
export function countDiff(before: Record<string, string>, after: Record<string, string>): string[] {
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return names.filter((n) => before[n] !== after[n]).map((n) => `${n}: ${before[n] ?? "(absent)"} → ${after[n] ?? "(absent)"}`);
}

/**
 * The subset of `countDiff` that is a FAILURE: a table that lost rows, or
 * that is not there at all. Growth is not a failure — the console starts
 * under launchd while the database is still empty and records its own
 * startup the moment the restore lands, so `runs` is legitimately one or two
 * ahead by the time this runs. Losing a row never is.
 */
export function countLosses(before: Record<string, string>, after: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [name, was] of Object.entries(before).sort(([a], [b]) => a.localeCompare(b))) {
    const now = after[name];
    if (now === undefined) {
      out.push(`${name}: ${was} → the table is not there`);
      continue;
    }
    if (Number(now) < Number(was)) out.push(`${name}: ${was} → ${now}`);
  }
  return out;
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
export async function dumpCompose(ctx: Ctx, toolchain: PgToolchain, ts: string): Promise<{ path: string; before: Record<string, string>; countsSql: string }> {
  const user = ctx.env.METISTRY_DB_USER || "metistry";
  const database = ctx.env.METISTRY_DB_NAME || "metistry";
  const inContainer = `/tmp/metistry-migrate-${ts}.dump`;
  const path = join(migrateDir(stateRoot(ctx.productDir, ctx.env)), `${ts}.dump`);
  const psql = (sql: string) => compose(ctx, ["exec", "-T", "db", "psql", "-U", user, "-d", database, "-tA", "--no-psqlrc", "-c", sql]);

  // the table list comes from the source, and the SAME generated count query
  // then runs on both sides — see tableCountsSql
  const list = psql(TABLE_LIST_SQL);
  const lres = await ctx.r.run(list.cmd, list.args, { cwd: list.cwd, comment: "the tables whose rows must survive the move" });
  const tables = lres.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  const countsSql = tables.length > 0 ? tableCountsSql(tables) : "";
  let before: Record<string, string> = {};
  if (ctx.r.dryRun) {
    ctx.r.action(`${DRY_RUN_COUNTS}, through the db container — the counts the restore is checked against`);
  } else if (countsSql !== "") {
    const counts = psql(countsSql);
    const cres = await ctx.r.run(counts.cmd, counts.args, { cwd: counts.cwd, comment: "row counts, taken with the writers already stopped" });
    before = parseCounts(cres.stdout);
    ctx.r.note(`counts: ${Object.keys(before).length} tables — ${Object.entries(before).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  } else {
    ctx.r.note("no tables in public — nothing to compare after the restore");
  }

  const dump = compose(ctx, ["exec", "-T", "db", "pg_dump", "-U", user, "-d", database, "--format=custom", "--compress=6", "--file", inContainer]);
  await ctx.r.run(dump.cmd, dump.args, { cwd: dump.cwd, timeoutMs: 30 * 60_000, comment: "the container's own pg_dump — same version as the server" });
  await ctx.r.run("mkdir", ["-p", migrateDir(stateRoot(ctx.productDir, ctx.env))]);
  const cp = compose(ctx, ["cp", `db:${inContainer}`, path]);
  await ctx.r.run(cp.cmd, cp.args, { cwd: cp.cwd, timeoutMs: 30 * 60_000 });
  const rm = compose(ctx, ["exec", "-T", "db", "rm", "-f", inContainer]);
  await ctx.r.run(rm.cmd, rm.args, { cwd: rm.cwd, tolerateFailure: true, comment: "the copy inside the container is not the record" });

  // verify BEFORE anything is stopped: a dump that pg_restore cannot read is
  // a migration that must not start
  const toc = await ctx.r.run(join(toolchain.bin, "pg_restore"), ["--list", path], { comment: "the dump must be readable before anything is stopped" });
  if (!ctx.r.dryRun) {
    const entries = tocEntryCount(toc.stdout);
    if (entries === 0) throw new StepFailed(`${path} has no restorable entries — refusing to stop a healthy install behind an empty dump`);
    ctx.r.note(`dump verified: ${path}, ${entries} TOC entries`);
  }
  return { path, before, countsSql };
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
/** The child spec `up` wrote for this service, when there is one. */
async function supervisorChild(ctx: Ctx, service: string): Promise<{ name: string } | undefined> {
  const config = await readSupervisorConfig(supervisorConfigPath(supervisorStateRoot(ctx))).catch(() => undefined);
  return config?.children.find((c) => c.name === service);
}

function supervisorStateRoot(ctx: Ctx): string {
  return ctx.env.METISTRY_INSTANCE_DIR?.replace(/\/+$/, "") || ctx.productDir;
}

/**
 * Put one variable into a child's environment in `supervisor.json` and
 * kickstart the supervisor so it takes.
 *
 * The same reasoning as patching the plist `up` wrote rather than
 * re-rendering it: the config already carries this instance's namespaced
 * ports and everything else `up` computed, and rebuilding it here could only
 * forget something.
 */
export async function pinSupervisorChild(ctx: Ctx, service: string, envVar: string, value: string): Promise<void> {
  const path = supervisorConfigPath(supervisorStateRoot(ctx));
  const config = await readSupervisorConfig(path);
  if (!config) {
    ctx.r.note(`${service}: no ${path} — nothing to pin (metistry up writes it)`);
    return;
  }
  const next = {
    ...config,
    children: config.children.map((c) => (c.name === service ? { ...c, env: { ...c.env, [envVar]: value } } : c)),
  };
  await ctx.r.write(path, serializeSupervisorConfig(next), `the config up wrote, plus ${service}'s ${envVar}=${value} (the signed bundle holding the TCC grant; this release carries none)`);
  await ctx.r.run("launchctl", ["kickstart", "-k", `gui/${ctx.uid}/${labelFor(SUPERVISOR_SERVICE, ctx.labelSuffix)}`], { comment: `${service} restarts with the pinned helper` });
}

export async function pinTccHelpers(ctx: Ctx, templates: PlistTemplate[], exists: (p: string) => boolean): Promise<string[]> {
  const pinned: string[] = [];
  for (const h of TCC_HELPERS) {
    const t = templates.find((x) => x.service === h.service);
    // under the supervisor a bridge is a child, not an agent: it has no plist
    // in ~/Library/LaunchAgents to patch, and its environment lives in the
    // supervisor's config
    const child = t ? undefined : await supervisorChild(ctx, h.service);
    if (!t && !child) continue;
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
    if (!t) {
      // a child: one entry in its spec, then the supervisor restarts it
      if (!h.envVar) {
        ctx.r.note(`${h.service}: it is a supervisor child with no environment override — nothing to pin`);
        continue;
      }
      await pinSupervisorChild(ctx, h.service, h.envVar, onHost);
      pinned.push(`${h.service} → ${onHost}`);
      continue;
    }
    // PATCH the plist `up` just wrote — never re-render it from the template.
    //
    // `up` puts more into these files than the three placeholders: this
    // instance's namespaced ports for the jobs that source `.env`, and the
    // bundled git on the reconciler's PATH. A re-render here dropped the
    // ports, and the rehearsal's scratch apple-fm bridge went looking for
    // the DEFAULT 7810 — which is the production install's, and it only
    // failed to take it because production had it (`EADDRINUSE`). Patching
    // what `up` wrote cannot forget something `up` knows.
    const target = join(launchAgentsDir(ctx.home), t.file);
    const written = existsSync(target) && !ctx.r.dryRun ? await readFile(target, "utf8") : renderPlist(t.template, { repo: ctx.runDir, node: runtimeNodeBin(ctx.productDir), envFile: ctx.envFile });
    if (h.envVar) {
      // the bridge is a node service that resolves its helper relative to its
      // own dist/; the override is one added environment entry
      await ctx.r.write(target, withEnvironmentVariables(written, { [h.envVar]: onHost }), `the plist up wrote, plus ${h.envVar}=${onHost} (the signed bundle holding the TCC grant; this release carries none)`);
    } else {
      // the helper IS the job's root process — that is what the TCC grant
      // attaches to — so its path is in ProgramArguments, and only there
      const from = join(ctx.runDir, h.bundle);
      const to = join(ctx.productDir, h.bundle);
      if (!written.includes(from)) {
        ctx.r.note(`${h.service}: ${target} does not name ${from} — leaving it alone rather than guessing`);
        continue;
      }
      await ctx.r.write(target, written.split(from).join(to), `the plist up wrote, with ${from} → ${to} (the signed bundle holding the TCC grant; this release carries none)`);
    }
    // the SAME sequence `up` installs a job with, wait included: `bootout` is
    // asynchronous, and bootstrapping the label straight after races launchd
    // and fails `Bootstrap failed: 5: Input/output error` (#117's fourth
    // defect — and this section reproduced it exactly once by hand-rolling
    // the three commands)
    const label = labelFor(h.service, ctx.labelSuffix);
    for (const c of launchdCommands(label, target, ctx.uid)) {
      if (c.awaitGone) {
        await awaitBootout(ctx.r, label, ctx.uid);
        continue;
      }
      await ctx.r.run(c.cmd, c.args, { tolerateFailure: c.tolerateFailure, comment: c.tolerateFailure ? "ok if not loaded" : undefined });
    }
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

  r.section("quiesce the writers");
  r.note("the console and the assistant stop BEFORE the dump: a row written between `pg_dump` and `docker compose stop db` would live in the volume and be absent from the restore");
  const quiesce = compose(ctx, ["stop", ...WRITER_SERVICES]);
  await r.run(quiesce.cmd, quiesce.args, { cwd: quiesce.cwd, timeoutMs: 10 * 60_000 });

  r.section("dump");
  const ts = stamp((opts.now ?? (() => new Date()))());
  const { path: dumpPath, before, countsSql } = await dumpCompose(ctx, pre.toolchain, ts);

  r.section("stop the database");
  r.note("the containers and the named volume are LEFT IN PLACE — that is what makes this reversible (`metistry migrate-shape compose`)");
  const stop = compose(ctx, ["stop", "db"]);
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

  if (r.dryRun) {
    r.action(`${DRY_RUN_COUNTS}, against the restored database — compared with the counts taken beside the dump, and a table that lost rows fails the migration`);
  } else if (countsSql !== "") {
    // the SAME text the compose side ran, so a table that did not survive the
    // restore fails the query rather than quietly dropping out of the diff
    const after = await r.run(join(pre.toolchain.bin, "psql"), [...conn, "-tA", "--no-psqlrc", "-c", countsSql], { comment: "the same count query, against the restored database" });
    const now = parseCounts(after.stdout);
    const lost = countLosses(before, now);
    if (lost.length > 0) {
      throw new StepFailed(
        `the restored database is missing rows the dump had — ${lost.join("; ")}. The dump is at ${dumpPath} and the compose volume is untouched; ` +
          `roll back with \`metistry migrate-shape compose\` and report this.`,
      );
    }
    // a table that GREW is the launchd console recording its own startup
    // between the restore and this query — expected, and not a loss
    const grew = countDiff(before, now);
    r.note(`counts: every one of the ${Object.keys(before).length} tables came across with at least the rows the dump had${grew.length > 0 ? ` (written since the restore: ${grew.join(", ")})` : " — every count identical"}`);
  }

  r.section("tcc helpers");
  const templates = await loadPlistTemplates(ctx.runDir, "launchd", ctx.labelSuffix, ctx.env);
  const pinned = await pinTccHelpers(ctx, templates, exists);
  if (pinned.length > 0) r.note(`pinned at the signed bundles that hold the TCC grant (same bundle id + certificate chain = same designated requirement, so no re-grant): ${pinned.join(", ")}`);

  r.section("restart the services that were waiting on a schema");
  // the console and the assistant came up against an empty database, before
  // the restore. They are the supervisor's children, so ONE kickstart brings
  // both back — launchd knows nothing about them individually.
  const supervisorLabel = labelFor(SUPERVISOR_SERVICE, ctx.labelSuffix);
  if (templates.some((t) => t.service === SUPERVISOR_SERVICE)) {
    await r.run("launchctl", ["kickstart", "-k", `gui/${ctx.uid}/${supervisorLabel}`], { comment: "its children started against an empty database" });
  } else {
    r.note(`no ${SUPERVISOR_PLIST_FILE} in ${join(ctx.runDir, "ops", "launchd")} — nothing to restart`);
  }

  await awaitReady(ctx, opts.fetchFn ?? fetch, opts.sleep);

  r.note(`dump kept at ${dumpPath} — it is the only copy of the compose database outside the Docker volume, which stays until you run \`docker compose down -v\``);
  return dumpPath;
}

/** How long the migration waits for a just-restarted service to answer before letting doctor judge it (20 × 500ms = 10s). */
export const READY_TRIES = 20;
export const READY_INTERVAL_MS = 500;

/**
 * Wait for the services this migration restarted to answer, before running
 * doctor.
 *
 * Without this the verdict is a race the migration usually loses: a job is
 * kickstarted, doctor runs milliseconds later, and it reports
 * `console down (fetch failed)` / `reconciler down (fetch failed)` for
 * processes that are up two seconds after the command exits. A migration
 * whose final word is a false failure is worse than useless — it is the
 * thing that makes an operator roll back a cutover that worked. (Both
 * appeared exactly this way in the rehearsal.)
 *
 * Timing out is NOT an error: doctor still runs, and its remediation says
 * the true thing about whatever is actually wrong.
 */
export async function awaitReady(ctx: Ctx, fetchFn: typeof fetch, sleep: (ms: number) => Promise<void> = (ms) => new Promise((res) => setTimeout(res, ms))): Promise<void> {
  const targets: { name: string; url: string }[] = [{ name: "console", url: `http://127.0.0.1:${consolePort(ctx.env)}/health` }];
  // the reconciler is the D5 committer and is restarted in both directions;
  // it is only probeable when this install configured its URL
  const rec = ctx.env.METISTRY_RECONCILER_URL;
  if (rec) targets.push({ name: "reconciler", url: `${rec.replace(/\/+$/, "")}/check` });

  if (!ctx.r.action(`wait for ${targets.map((t) => t.name).join(" and ")} to answer — doctor's verdict must not be a race with a job kickstarted a moment ago`)) return;
  for (const t of targets) {
    let ok = false;
    for (let i = 0; i < READY_TRIES && !ok; i++) {
      try {
        // any answer at all means the socket is bound; a 401 is doctor's
        // business, not a reason to keep waiting
        await fetchFn(t.url, { signal: AbortSignal.timeout(2000) });
        ctx.r.note(`${t.name}: ${t.url} answered after ${(i * READY_INTERVAL_MS) / 1000}s`);
        ok = true;
      } catch {
        await sleep(READY_INTERVAL_MS);
      }
    }
    if (!ok) ctx.r.note(`${t.name}: ${t.url} did not answer within ${(READY_TRIES * READY_INTERVAL_MS) / 1000}s — doctor below says what is actually wrong`);
  }
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

  await awaitReady(ctx, opts.fetchFn ?? fetch, opts.sleep);
  return undefined;
}
