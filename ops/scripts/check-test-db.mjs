#!/usr/bin/env node
// No test builds its own Postgres connection.
//
// `testDb()` in `@foldedspacelabs/metistry-core/test-env` is the only way a
// test gets one: it refuses unless METISTRY_TEST_DB_NAME names a scratch
// database that no install on this machine is configured with, connects with
// host/port/user/password from METISTRY_DB_* and nothing else, and checks
// `current_database()` before handing the pool over. A guard like that is
// worth exactly as much as the ways around it, and the way around it is one
// line — a suite constructing a pool of its own. Until 2026-09-26 every
// suite did, most without a port, all defaulting the database name; on a Mac
// whose live install listens on 5432, METISTRY_DB_PASSWORD alone sent a suite
// at the install's Postgres. So this check holds every test file to it:
//
//   * no `new pg.Pool(` / `new pg.Client(` — nor through a default or
//     namespace import of "pg" under another name, nor a named import
//     (`import { Pool } from "pg"`, `const { Client } = pg`), aliased or not;
//   * no call to the product's own env-driven openers (`openDbFromEnv`,
//     `openMigrationSession`, `makePool`) except with `{}` or `testDbEnv(…)`
//     — handed `process.env`, each would open whatever METISTRY_DB_NAME says,
//     and for an install that is the install's database.
//
// A test file is any file under a `test/`, `tests/` or `__tests__/` directory,
// or named `*.test.*` / `*.spec.*`, outside node_modules and build output.
// docs/ops/testing.md.
//
//   node ops/scripts/check-test-db.mjs   exit 1 with one line per problem
//
// No dependency: node's fs and path only.

import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".build", ".claude", "coverage", ".turbo"]);
const TEST_DIRS = new Set(["test", "tests", "__tests__"]);
const SOURCE = /\.[cm]?[jt]sx?$/;
const TEST_NAME = /\.(test|spec)\.[cm]?[jt]sx?$/;
const OPENERS = ["openDbFromEnv", "openMigrationSession", "makePool"];

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Is this repo-relative path a test file? */
export function isTestFile(rel) {
  const parts = rel.split(/[\\/]/);
  if (!SOURCE.test(parts.at(-1) ?? "")) return false;
  return TEST_NAME.test(parts.at(-1) ?? "") || parts.slice(0, -1).some((p) => TEST_DIRS.has(p));
}

/**
 * The local names under which a file holds the "pg" module itself (`pg`
 * always, plus any default/namespace import or require of it), and the local
 * names bound to its `Pool` / `Client` classes.
 */
export function pgBindings(text) {
  const namespaces = new Set(["pg"]);
  const classes = new Set();
  const addNamed = (list) => {
    for (const item of list.split(",")) {
      const m = /^\s*(?:type\s+)?(Pool|Client)\s*(?:(?:as|:)\s*([A-Za-z_$][\w$]*))?\s*$/.exec(item);
      if (m && !/^\s*type\s/.test(item)) classes.add(m[2] ?? m[1]);
    }
  };
  // import pg from "pg" · import * as pg from "pg" · import pg, { Pool } from "pg" · import { Pool as P } from "pg"
  for (const m of text.matchAll(/import\s+(?!type\s)([^;]*?)\s+from\s+["']pg["']/g)) {
    const clause = m[1];
    const ns = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(clause);
    if (ns) namespaces.add(ns[1]);
    const def = /^\s*([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(clause);
    if (def) namespaces.add(def[1]);
    const named = /\{([^}]*)\}/.exec(clause);
    if (named) addNamed(named[1]);
  }
  // const pg = require("pg") · const { default: pg } = await import("pg") · const { Pool } = require("pg")
  for (const m of text.matchAll(/(?:const|let|var)\s+(\{[^}]*\}|[A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?(?:require|import)\s*\(\s*["']pg["']\s*\)/g)) {
    if (m[1].startsWith("{")) {
      const inner = m[1].slice(1, -1);
      const def = /\bdefault\s*:\s*([A-Za-z_$][\w$]*)/.exec(inner);
      if (def) namespaces.add(def[1]);
      addNamed(inner.replace(/\bdefault\s*:\s*[A-Za-z_$][\w$]*\s*,?/, ""));
    } else namespaces.add(m[1]);
  }
  // const { Pool, Client: C } = pg
  for (const m of text.matchAll(/(?:const|let|var)\s+\{([^}]*)\}\s*=\s*([A-Za-z_$][\w$]*)\s*[;\n]/g)) {
    if (namespaces.has(m[2])) addNamed(m[1]);
  }
  return { namespaces, classes };
}

/**
 * Every way this file opens a Postgres connection without `testDb`.
 * @returns {{ line: number, what: string }[]}
 */
export function findViolations(text) {
  const { namespaces, classes } = pgBindings(text);
  const construct = [
    ...[...namespaces].map((ns) => new RegExp(`\\bnew\\s+${esc(ns)}\\s*\\.\\s*(?:Pool|Client)\\b`)),
    ...[...classes].map((c) => new RegExp(`\\bnew\\s+${esc(c)}\\s*\\(`)),
  ];
  const opener = new RegExp(`\\b(${OPENERS.join("|")})\\s*\\((?!\\s*(?:\\{\\s*\\}\\s*\\)|testDbEnv\\s*\\())`);
  const out = [];
  text.split("\n").forEach((line, i) => {
    const hit = construct.map((re) => re.exec(line)).find(Boolean);
    if (hit) out.push({ line: i + 1, what: `\`${hit[0].trim()}…\` — a test builds its Postgres connection with testDb(pg.Pool), never its own` });
    const call = opener.exec(line);
    if (call) out.push({ line: i + 1, what: `\`${call[1]}(…)\` handed something other than {} or testDbEnv() — it would open whatever METISTRY_DB_NAME says` });
  });
  return out;
}

/** Every test file under `root`, repo-relative, sorted. */
export function testFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(join(dir, e.name));
      } else if (e.isFile()) {
        const rel = relative(root, join(dir, e.name)).split(sep).join("/");
        if (isTestFile(rel)) out.push(rel);
      }
    }
  };
  walk(root);
  return out.sort();
}

/** Everything the CLI prints, for a checkout rooted at `root`. */
export function run(root) {
  const files = testFiles(root);
  const problems = [];
  let guarded = 0;
  for (const rel of files) {
    const text = readFileSync(join(root, rel), "utf8");
    if (/\b(?:testDb|recreateScratchDb)\s*\(/.test(text)) guarded++;
    for (const v of findViolations(text)) problems.push(`${rel}:${v.line}: ${v.what}`);
  }
  if (problems.length) {
    return { ok: false, lines: [...problems, "", `test db: ${problems.length} problem(s) — a test's only way into Postgres is testDb() from @foldedspacelabs/metistry-core/test-env (docs/ops/testing.md)`] };
  }
  return { ok: true, lines: [`test db: ok — ${files.length} test files, none opens Postgres on its own; ${guarded} go through testDb()`] };
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const { ok, lines } = run(root);
  (ok ? console.log : console.error)(lines.join("\n"));
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
