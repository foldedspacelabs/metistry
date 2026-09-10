// Environment + product-checkout discovery. The CLI is config-from-env like
// everything else (invariant 7); `.env` is read the way ops/scripts do it —
// exported into the process for UNSET variables only, never overriding a
// value the caller already set.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { envNotices, envPaths, productEnvFile, resolveInstanceDir, type EnvPaths } from "./instance.js";

/** Parse a dotenv-shaped file: KEY=value lines, `#` comments, optional `export `, matching outer quotes stripped. */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m || !m[1]) continue;
    let v = (m[2] ?? "").trim();
    if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

/**
 * Lines in a dotenv file that THIS parser reads one way and `/bin/sh` reads
 * another.
 *
 * Four launchd jobs (reconciler, watchdog, and the two TCC bridges) load
 * their environment with `sh -c "set -a; . <file>; set +a; exec …"`, which
 * does not parse the file — it RUNS it. `KEY=/Users/x/Library/Application
 * Support/…` is then the command `Support/…` with `KEY` in its
 * environment, the job exits 1, and the only clue is
 * `/bin/sh: /Users/x/Library/Application: No such file or directory` in a
 * log (2026-09-10 launchd trial — and `~/Library/Application Support` is
 * exactly where the Mac app puts an instance).
 *
 * A value is safe when it is quoted, or when it contains no whitespace and
 * no shell metacharacter. Anything else is reported by name so `up` can
 * refuse with a remediation instead of leaving four jobs respawning.
 */
export function shellUnsafeEnvLines(text: string): { key: string; line: number }[] {
  const out: { key: string; line: number }[] = [];
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m?.[1]) return;
    const v = (m[2] ?? "").trim();
    if (v === "") return;
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return;
    if (/[\s"'`$&|;<>()*?\\!#~]/.test(v)) out.push({ key: m[1], line: i + 1 });
  });
  return out;
}

/** Load one dotenv-shaped file into `env` for variables that are unset. Returns the number applied; 0 when the file is absent. */
export function loadEnvFile(file: string, env: NodeJS.ProcessEnv = process.env): number {
  if (!existsSync(file)) return 0;
  let n = 0;
  for (const [k, v] of Object.entries(parseDotEnv(readFileSync(file, "utf8")))) {
    if (env[k] === undefined) {
      env[k] = v;
      n++;
    }
  }
  return n;
}

/** Load `<dir>/.env`. Kept for callers that mean a specific directory's file. */
export function loadDotEnv(dir: string, env: NodeJS.ProcessEnv = process.env): number {
  return loadEnvFile(join(dir, ".env"), env);
}

export interface LoadedEnv {
  /** files actually read, in the order they were applied (earlier wins — nothing already set is overwritten) */
  files: string[];
  applied: number;
  /** the instance this install serves, once known */
  instanceDir?: string;
  /** where `.env` now belongs, and what is still being read from the old place */
  paths?: EnvPaths;
  /** deprecation lines worth printing once, at the top of a command's output */
  notices: string[];
}

/**
 * An install's environment, wherever it lives. `<instance>/state/.env`
 * first, the product checkout's `.env` after it — the checkout's file is
 * still where a terminal install may declare `METISTRY_INSTANCE_DIR`, so
 * it is PARSED for that pointer before either file is applied, which keeps
 * the instance's own values winning even when the pointer only exists in
 * the deprecated file.
 */
export function loadInstallEnv(opts: { productDir?: string | undefined; env?: NodeJS.ProcessEnv | undefined; instanceDir?: string | undefined; envFile?: string | undefined } = {}): LoadedEnv {
  const env = opts.env ?? process.env;
  let instanceDir = resolveInstanceDir(env, opts.instanceDir);
  if (!instanceDir && opts.productDir) {
    const product = productEnvFile(opts.productDir);
    if (existsSync(product)) {
      const pointer = parseDotEnv(readFileSync(product, "utf8")).METISTRY_INSTANCE_DIR;
      if (pointer) instanceDir = resolveInstanceDir({}, pointer);
    }
  }
  // downstream (`up`, the lock path, `stateRoot`) reads the variable, not our
  // local: an `--instance` that disagreed with the environment would split them
  if (instanceDir) env.METISTRY_INSTANCE_DIR = instanceDir;
  const paths = envPaths({ ...(instanceDir ? { instanceDir } : {}), ...(opts.productDir ? { productDir: opts.productDir } : {}), ...(opts.envFile ? { explicit: opts.envFile } : {}) });
  const files: string[] = [];
  let applied = 0;
  for (const f of paths?.read ?? []) {
    const n = loadEnvFile(f, env);
    files.push(f);
    applied += n;
  }
  return { files, applied, ...(instanceDir ? { instanceDir } : {}), ...(paths ? { paths } : {}), notices: paths ? envNotices(paths) : [] };
}

/** A product checkout is the directory holding both `seed/identity.yaml` and the workspace `package.json` named "metistry". */
export function isProductCheckout(dir: string): boolean {
  if (!existsSync(join(dir, "seed", "identity.yaml")) || !existsSync(join(dir, "package.json"))) return false;
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name === "metistry";
  } catch {
    return false;
  }
}

/** Walk up from `from` until a product checkout is found. */
export function findCheckoutAbove(from: string): string | undefined {
  let dir = resolve(from);
  for (;;) {
    if (isProductCheckout(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Where this package's own files live (dist/ → the package root). */
export function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

/** This package's version — what `metistry.lock` pins (the product release the instance runs). */
export function productVersion(): string {
  try {
    return String(JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf8")).version);
  } catch {
    return "0.0.0";
  }
}

/**
 * Resolution order (README.md): `--product-dir`, then `METISTRY_PRODUCT_DIR`,
 * then the checkout this package sits inside (a workspace install), then
 * the current directory's enclosing checkout. Undefined means "not in a
 * checkout" — init still works from the bundled seed; doctor cannot (there
 * are no manifests to walk).
 */
export function resolveProductDir(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): string | undefined {
  if (explicit) return resolve(explicit);
  if (env.METISTRY_PRODUCT_DIR) return resolve(env.METISTRY_PRODUCT_DIR);
  return findCheckoutAbove(packageRoot()) ?? findCheckoutAbove(cwd);
}

/** The seed directory: the checkout's `seed/` when there is one, else the copy bundled into this package at build time. */
export function resolveSeedDir(productDir: string | undefined): string {
  if (productDir && existsSync(join(productDir, "seed", "identity.yaml"))) return join(productDir, "seed");
  const bundled = join(packageRoot(), "seed");
  if (existsSync(join(bundled, "identity.yaml"))) return bundled;
  throw new Error("no seed/ found: set METISTRY_PRODUCT_DIR to a Metistry checkout (or pass --product-dir)");
}
