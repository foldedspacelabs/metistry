#!/usr/bin/env node
// The workspace test runner: every package's `test` script, each against a
// scratch database of its own.
//
// Until this existed the root `pnpm test` was `test-db.sh && pnpm -r
// --workspace-concurrency=1 run test`: one scratch database, and every
// package's DB-backed suites writing into it in turn. Vitest runs a package's
// files in parallel, and a `--no-file-parallelism` appended to the pnpm line
// never reached vitest at all (pnpm -r forwards extra arguments to no one).
// Each suite owned its rows by marker (docs/ops/testing.md), yet the W4 wave
// saw the same cross-suite flakes again — morning-brief, tasks'
// `external_ref`, reply-review's FK, linear-order, push-needs-you — because
// suites in different packages still shared one row space, and a marker only
// protects the rows a suite remembers to mark.
//
// So each package gets its own copy: `ops/scripts/test-db.sh` still builds
// and migrates the shared scratch database, `METISTRY_TEST_DB_NAME`; this
// script then, per package, creates `<that name>_<package>` as a TEMPLATE copy
// of it (schema and seed rows, no sibling's leftovers — and no second run of
// the migrations), runs the package's `test` script with
// `METISTRY_TEST_DB_NAME` pointed at the copy, and drops the copy after. The
// databases are made and dropped only through core's `recreateScratchDb` /
// `dropScratchDb`, so every name is validated the way `testDb()` validates
// it and never an install's. Packages run one at a time by default
// (`--concurrency 1`, what `--workspace-concurrency=1` did); with their
// databases apart they may run side by side (`--concurrency 2`).
//
// Run: pnpm test                                   (test-db.sh, then this)
//      pnpm test -- --concurrency 2 --only tasks --only artifacts
// Direct vitest runs are unchanged: `METISTRY_TEST_DB_NAME=<shared> vitest
// run` in a package still uses the shared database test-db.sh built.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PG_IDENT_MAX = 63; // limit: fixed — Postgres NAMEDATALEN - 1; a longer name is silently truncated to a different one

/** The suffix a package's database carries: `_` + its unscoped name, lowercase, `metistry-` prefix dropped, anything else `_`. */
export function scratchSuffix(packageName) {
  const unscoped = packageName.replace(/^@[^/]+\//, "");
  const slug = unscoped
    .toLowerCase()
    .replace(/^metistry[-_]/, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!slug) throw new Error(`cannot derive a database suffix from package name ${JSON.stringify(packageName)}`);
  return `_${slug}`;
}

/**
 * The database a package gets: `<base><suffix>`, the base cut back when the
 * two together would pass Postgres's limit — a deliberate, visible cut here
 * rather than the server's silent one, which `testDb()` refuses.
 */
export function packageDbName(base, suffix) {
  const room = PG_IDENT_MAX - suffix.length;
  if (room < "metistry_test_x".length) throw new Error(`suffix ${suffix} leaves no room for a scratch name within ${PG_IDENT_MAX} characters`);
  return (base.length > room ? base.slice(0, room) : base) + suffix;
}

/**
 * Which packages run and where: every workspace package with a `test`
 * script, in the order given, each with its database. Two packages must never
 * resolve to the same database — that is the whole point — so a collision is
 * an error, not a surprise later.
 */
export function plan(packages, base, only = []) {
  const chosen = packages.filter((p) => p.scripts?.test).filter((p) => only.length === 0 || only.some((o) => matchesOnly(p, o)));
  const out = chosen.map((p) => {
    const suffix = scratchSuffix(p.name);
    const database = packageDbName(base, suffix);
    // stem + suffix: what recreateScratchDb is handed (as METISTRY_TEST_DB_NAME and suffix) to make exactly `database`
    return { name: p.name, path: p.path, stem: database.slice(0, -suffix.length), suffix, database };
  });
  const seen = new Map();
  for (const p of out) {
    const other = seen.get(p.database);
    if (other) throw new Error(`packages ${other} and ${p.name} would share the database ${p.database}`);
    seen.set(p.database, p.name);
  }
  if (only.length && out.length === 0) throw new Error(`--only matched no package with a test script: ${only.join(", ")}`);
  return out;
}

function matchesOnly(pkg, o) {
  return pkg.name === o || pkg.name.replace(/^@[^/]+\//, "") === o || pkg.path.split(/[\\/]/).at(-1) === o;
}

export function parseArgs(argv) {
  const opts = { concurrency: 1, only: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--concurrency" || a === "-j") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1) throw new Error(`--concurrency wants a positive integer, got ${JSON.stringify(argv[i])}`);
      opts.concurrency = n;
    } else if (a.startsWith("--concurrency=")) {
      const n = Number(a.slice("--concurrency=".length));
      if (!Number.isInteger(n) || n < 1) throw new Error(`--concurrency wants a positive integer, got ${JSON.stringify(a)}`);
      opts.concurrency = n;
    } else if (a === "--only") {
      const v = argv[++i];
      if (!v) throw new Error("--only wants a package name");
      opts.only.push(v);
    } else if (a.startsWith("--only=")) {
      opts.only.push(a.slice("--only=".length));
    } else {
      throw new Error(`usage: test-workspace.mjs [--concurrency <n>] [--only <package>]... — unknown argument ${JSON.stringify(a)}`);
    }
  }
  return opts;
}

/**
 * The workspace's packages (root excluded), each with its package.json
 * `scripts`, read from `pnpm-workspace.yaml` with the filesystem alone — no
 * pnpm needed, so the unit tests can ask this before CI has installed it. The
 * file's patterns are `<dir>/*` and plain `<dir>`; anything fancier is an
 * error here rather than a package quietly left untested.
 */
export function workspacePackages(root) {
  const out = [];
  for (const pattern of workspacePatterns(readFileSync(join(root, "pnpm-workspace.yaml"), "utf8"))) {
    const dirs = pattern.endsWith("/*")
      ? readdirSync(join(root, pattern.slice(0, -2)), { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => join(root, pattern.slice(0, -2), e.name))
          .sort()
      : [join(root, pattern)];
    for (const dir of dirs) {
      const file = join(dir, "package.json");
      if (!existsSync(file)) continue;
      const manifest = JSON.parse(readFileSync(file, "utf8"));
      if (!manifest.name) throw new Error(`${file} has no name`);
      out.push({ name: manifest.name, path: dir, scripts: manifest.scripts ?? {} });
    }
  }
  return out;
}

/** The `packages:` entries of a pnpm-workspace.yaml: one `- <pattern>` per line, quotes optional. */
export function workspacePatterns(yamlText) {
  const patterns = [];
  let inPackages = false;
  for (const raw of yamlText.split("\n")) {
    const line = raw.replace(/#.*$/, "").trimEnd();
    if (line.trim() === "") continue;
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!/^\s/.test(line)) {
      inPackages = false;
      continue;
    }
    if (!inPackages) continue;
    const m = /^\s*-\s*(?:"([^"]*)"|'([^']*)'|(\S+))\s*$/.exec(line);
    const pattern = m?.[1] ?? m?.[2] ?? m?.[3];
    if (!pattern) throw new Error(`pnpm-workspace.yaml: cannot read a package pattern from ${JSON.stringify(raw)}`);
    if (/[!?[\]{}]/.test(pattern) || (pattern.includes("*") && !pattern.endsWith("/*")) || pattern.slice(0, -2).includes("*")) {
      throw new Error(`pnpm-workspace.yaml: pattern ${JSON.stringify(pattern)} is more than <dir>/* or <dir>, which is all test-workspace.mjs reads`);
    }
    patterns.push(pattern.replace(/\/$/, ""));
  }
  if (patterns.length === 0) throw new Error("pnpm-workspace.yaml names no packages");
  return patterns;
}

/** The child's environment: the scrubbed one this process has, with the two database names pointed at the package's copy. */
export function childEnv(env, database) {
  const out = { ...env, METISTRY_TEST_DB_NAME: database };
  // METISTRY_DB_NAME is allowlisted for a test shell (migrate.sh's guard wants
  // it equal to METISTRY_TEST_DB_NAME); where it was set, keep the two agreed.
  if (env.METISTRY_DB_NAME !== undefined) out.METISTRY_DB_NAME = database;
  return out;
}

/** The package test processes running right now — so a signal to this process reaches them, instead of orphaning a vitest. */
const running = new Set();
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    for (const child of running) child.kill(signal);
    process.exit(128 + (signal === "SIGINT" ? 2 : 15));
  });
}

function runPackage(pkg, env) {
  return new Promise((done) => {
    const started = Date.now();
    const child = spawn("pnpm", ["run", "test"], { cwd: pkg.path, env, stdio: "inherit" });
    running.add(child);
    child.on("error", (e) => {
      running.delete(child);
      done({ ok: false, code: null, error: e, ms: Date.now() - started });
    });
    child.on("exit", (code, signal) => {
      running.delete(child);
      done({ ok: code === 0, code: code ?? signal, ms: Date.now() - started });
    });
  });
}

const fmtMs = (ms) => `${(ms / 1000).toFixed(1)}s`;

export async function main(argv = process.argv.slice(2)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const opts = parseArgs(argv);

  // Core's test-env is the only way a database is named, made or dropped
  // here; pg comes from the CLI's dependency on it (core is driver-free).
  const testEnvDist = join(root, "packages/core/dist/test-env.js");
  if (!existsSync(testEnvDist)) {
    console.error("test-workspace: packages/core/dist/test-env.js is missing — run `pnpm -r build` first (the suites need every dist anyway).");
    return 2;
  }
  const { dropScratchDb, loadTestEnv, recreateScratchDb } = await import(pathToFileURL(testEnvDist).href);
  const pg = createRequire(join(root, "packages/cli/package.json"))("pg");

  // Same two things a test may inherit — METISTRY_DB_* and METISTRY_TEST_DB_NAME
  // — from the checkout's .env, and nothing else of the environment survives
  // into the children (docs/ops/testing.md).
  loadTestEnv(join(root, ".env"));
  const base = process.env.METISTRY_TEST_DB_NAME;
  if (!base) {
    console.error("test-workspace: METISTRY_TEST_DB_NAME is not set — there is no shared scratch database to copy, and this never falls back to a default name. Run it through `pnpm test`, which names one per checkout and builds it with ops/scripts/test-db.sh.");
    return 2;
  }

  const packages = plan(workspacePackages(root), base, opts.only);
  console.log(`test-workspace: ${packages.length} packages, one database each, copied from ${base}, concurrency ${opts.concurrency}`);
  for (const p of packages) console.log(`  ${p.name} → ${p.database}`);

  const results = [];
  const queue = [...packages];
  const worker = async () => {
    for (let pkg = queue.shift(); pkg; pkg = queue.shift()) {
      const dbOpts = { env: { ...process.env, METISTRY_TEST_DB_NAME: pkg.stem }, suffix: pkg.suffix, template: base };
      let result;
      try {
        await recreateScratchDb(pg.Pool, dbOpts);
        console.log(`\n── ${pkg.name} · ${pkg.database}\n`);
        result = await runPackage(pkg, childEnv(process.env, pkg.database));
      } catch (e) {
        result = { ok: false, code: null, error: e, ms: 0 };
      }
      try {
        await dropScratchDb(pg.Pool, dbOpts);
      } catch (e) {
        // the next run's DROP IF EXISTS takes it; say so rather than fail a green suite over housekeeping
        console.error(`test-workspace: could not drop ${pkg.database}: ${e instanceof Error ? e.message : e}`);
      }
      results.push({ ...pkg, ...result });
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency, packages.length) }, worker));

  const failed = results.filter((r) => !r.ok);
  console.log("\ntest-workspace summary");
  for (const r of results) {
    const state = r.ok ? "passed" : r.error ? `error: ${r.error.message}` : `failed (exit ${r.code})`;
    console.log(`  ${r.ok ? "ok  " : "FAIL"} ${r.name}  ${r.database}  ${fmtMs(r.ms)}  ${state}`);
  }
  console.log(`\n${results.length - failed.length} of ${results.length} packages passed`);
  return failed.length === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`test-workspace: ${e instanceof Error ? e.message : e}`);
      process.exit(2);
    },
  );
}
