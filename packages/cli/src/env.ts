// Environment + product-checkout discovery. The CLI is config-from-env like
// everything else (invariant 7); `.env` is read the way ops/scripts do it —
// exported into the process for UNSET variables only, never overriding a
// value the caller already set.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

/** Load `<dir>/.env` into `env` for variables that are unset. Returns the number applied; 0 when the file is absent. */
export function loadDotEnv(dir: string, env: NodeJS.ProcessEnv = process.env): number {
  const file = join(dir, ".env");
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
