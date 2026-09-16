// Tests never see the operator's instance.
//
// A product checkout's `.env` is a RUNNING install's environment: it carries
// `METISTRY_INSTANCE_DIR`, the reconciler's URL and the reconciler's bridge
// token. A test that loads the whole file and then calls a CLI verb is not
// talking to a fixture — it is talking to the live system, and no amount of
// `--instance <tmpdir>` saves it, because the write path reads the bridge out
// of the environment and POSTs to whatever answers.
//
// That is not hypothetical: on 2026-09-15 a `metistry compute providers add`
// case in packages/cli, pointed at a temp instance directory, reached the
// operator's running reconciler and had it commit `compute.yaml` into their
// private instance repo.
//
// So the rule is enforced here rather than remembered: one loader, an
// allowlist of the only variables a test may inherit (how to reach the
// scratch Postgres), and a guard that fails a test run the moment anything
// else appears. Documented in docs/ops/testing.md.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The only `METISTRY_*` variables a test may inherit: how to reach the
 * scratch database (`ops/scripts/test-db.sh`) and which one it is. Nothing
 * that names a directory, a bridge, a token or an origin.
 */
export const TEST_ENV_ALLOWED = /^METISTRY_(DB_[A-Z0-9_]+|TEST_DB_NAME)$/;

/**
 * The two exceptions, and conditional ones. `METISTRY_INSTANCE_DIR` because
 * the CLI writes the resolved instance directory back into `process.env`, so
 * a test that legitimately passed `--instance <temp dir>` will have set it;
 * `METISTRY_PRODUCT_DIR` because pinning it at a sandbox is how a harness
 * stops the CLI resolving the checkout it happens to be running inside.
 * Under `os.tmpdir()` either is a fixture; anywhere else it is the
 * operator's install.
 */
export const TEST_ENV_TEMP_ONLY = ["METISTRY_INSTANCE_DIR", "METISTRY_PRODUCT_DIR"] as const;

export function isAllowedTestVar(name: string): boolean {
  return TEST_ENV_ALLOWED.test(name);
}

/** `os.tmpdir()` and its realpath — macOS hands out `/var/folders/…` for a `/private/var/…` directory. */
function tmpRoots(tmp: string): string[] {
  const roots = [resolve(tmp)];
  try {
    const real = realpathSync(tmp);
    if (!roots.includes(real)) roots.push(real);
  } catch {
    /* no such directory: the one root stands */
  }
  return roots;
}

/** True when `dir` is inside the temp root — i.e. a fixture rather than a real instance. */
export function isTempPath(dir: string, tmp: string = tmpdir()): boolean {
  const p = resolve(dir);
  return tmpRoots(tmp).some((root) => p === root || p.startsWith(root + sep));
}

/**
 * Delete every `METISTRY_*` variable the allowlist does not name. Returns the
 * names removed, sorted, so a caller can say what it took away.
 */
export function scrubTestEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const removed: string[] = [];
  for (const name of Object.keys(env)) {
    if (!name.startsWith("METISTRY_") || isAllowedTestVar(name)) continue;
    removed.push(name);
    delete env[name];
  }
  return removed.sort();
}

export interface TestEnvResult {
  /** true when the scratch database is reachable — suites gate on this with `describe.skipIf(!hasDb)` */
  hasDb: boolean;
  /** allowlisted names taken from the dotenv file */
  loaded: string[];
  /** names deleted from the environment because they were not allowlisted */
  removed: string[];
}

/**
 * Load the allowlisted half of a dotenv file and scrub the rest of the
 * environment. Absent file, unreadable file, malformed line: all fine, the
 * scrub still happens. `file` is a path or a `new URL("…/.env",
 * import.meta.url)`.
 */
export function loadTestEnv(file: string | URL, env: NodeJS.ProcessEnv = process.env): TestEnvResult {
  const removed = scrubTestEnv(env);
  const loaded: string[] = [];
  const path = typeof file === "string" ? file : fileURLToPath(file);
  if (existsSync(path)) {
    try {
      for (const raw of readFileSync(path, "utf8").split("\n")) {
        const line = raw.trim();
        if (line === "" || line.startsWith("#")) continue;
        const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
        if (!m?.[1] || !isAllowedTestVar(m[1])) continue;
        let v = (m[2] ?? "").trim();
        if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) v = v.slice(1, -1);
        if (env[m[1]] === undefined) {
          env[m[1]] = v;
          loaded.push(m[1]);
        }
      }
    } catch {
      /* unreadable: the scrub is what mattered */
    }
  }
  return { hasDb: !!env.METISTRY_DB_PASSWORD, loaded: loaded.sort(), removed };
}

export interface TestEnvViolation {
  name: string;
  /** the value, unless it is secret-shaped — a violation report must not become a secret leak */
  value: string;
  why: string;
}

/** Every reason this environment is not isolated. Empty means it is. */
export function testEnvViolations(env: NodeJS.ProcessEnv = process.env, tmp: string = tmpdir()): TestEnvViolation[] {
  const out: TestEnvViolation[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith("METISTRY_") || isAllowedTestVar(name)) continue;
    const shown = /TOKEN|SECRET|KEY|PASSWORD/.test(name) ? "<redacted>" : (value ?? "");
    if ((TEST_ENV_TEMP_ONLY as readonly string[]).includes(name)) {
      if (isTempPath(value ?? "", tmp)) continue;
      out.push({ name, value: shown, why: `resolves outside ${tmp} — that is a real directory on this machine, not a fixture` });
      continue;
    }
    out.push({ name, value: shown, why: "not on the test allowlist (only METISTRY_DB_* and METISTRY_TEST_DB_NAME are)" });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Throw when the environment a test just ran in could have reached the
 * operator's install. The message names every variable and what to do, since
 * "something leaked" is not actionable at 2am.
 */
export function assertTestEnvIsolated(env: NodeJS.ProcessEnv = process.env, tmp: string = tmpdir()): void {
  const violations = testEnvViolations(env, tmp);
  if (violations.length === 0) return;
  const lines = violations.map((v) => `  ${v.name}=${v.value} — ${v.why}`);
  throw new Error(
    [
      "test environment is not isolated — a verb run here could reach the operator's install:",
      ...lines,
      "",
      "Most often this is a test passing the real checkout as --product-dir: the CLI then reads that checkout's .env,",
      "which is a running install's environment. Point --product-dir at a temp directory instead (docs/ops/testing.md).",
    ].join("\n"),
  );
}
