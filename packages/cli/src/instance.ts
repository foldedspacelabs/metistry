// An instance directory is self-contained (owner-ratified 2026-09-09,
// docs/product/desktop-app-plan.md). The vault, identity, rules, queries,
// routines, `metistry.lock`, `inbox/` and the launchd shape's derived
// `state/` already live there; this module is the rest of it:
//
//   * `<instance>/state/.env` — the derived environment file. It used to
//     live in the PRODUCT checkout, which made one checkout serve exactly
//     one instance. The product-dir `.env` is still read as a deprecated
//     fallback so a running install keeps working until its next
//     `metistry secrets sync --to env`.
//   * `instance_id` in `identity.yaml` — a UUID minted at `init`, the
//     account this instance's Keychain items are filed under, and how the
//     Mac app tells several instance directories apart.
//
// Nothing here writes a secret into the instance REPO: `state/` is
// gitignored by the seed `metistry init` stamps.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { writeProtected } from "./protected-write.js";
import type { StepRunner } from "./steps.js";

/** Derived, gitignored state under the instance dir: Postgres data, the assistant's transcripts, and now `.env`. */
export const STATE_DIRNAME = "state";
export const ENV_FILENAME = ".env";
export const IDENTITY_FILENAME = "identity.yaml";

/** Trailing slashes make `<dir>//state` — normalise once, here. */
export function normalizeDir(dir: string): string {
  return dir.replace(/\/+$/, "");
}

export function instanceStateDir(instanceDir: string): string {
  return join(normalizeDir(instanceDir), STATE_DIRNAME);
}

/** Where an instance's derived `.env` belongs. */
export function instanceEnvFile(instanceDir: string): string {
  return join(instanceStateDir(instanceDir), ENV_FILENAME);
}

/** The product checkout's `.env` — deprecated as an install's environment, still read as a fallback. */
export function productEnvFile(productDir: string): string {
  return join(normalizeDir(productDir), ENV_FILENAME);
}

/** `--instance <dir>`, else `METISTRY_INSTANCE_DIR`. Undefined when neither says. */
export function resolveInstanceDir(env: NodeJS.ProcessEnv = process.env, explicit?: string | undefined): string | undefined {
  const dir = explicit ?? env.METISTRY_INSTANCE_DIR;
  return dir ? normalizeDir(dir) : undefined;
}

export interface EnvPathsInput {
  instanceDir?: string | undefined;
  productDir?: string | undefined;
  /** `--env-file <path>`: an explicit target wins over everything and is never called deprecated. */
  explicit?: string | undefined;
  exists?: ((p: string) => boolean) | undefined;
}

export interface EnvPaths {
  /** Files to read, in precedence order — the first to set a variable wins. */
  read: string[];
  /** Where `secrets sync --to env` writes, whether or not it exists yet. */
  write: string;
  /** A product-dir `.env` that is being used even though the environment now belongs to the instance. */
  legacy?: string;
  /** True when `write` does not exist yet but `legacy` does — the next `secrets sync --to env` migrates it. */
  pendingMove: boolean;
}

/**
 * Where this install's `.env` is. The instance's own file wins; the product
 * checkout's is read after it (so `METISTRY_INSTANCE_DIR` can still be
 * declared there — that is how a terminal install bootstraps the pointer)
 * and reported as deprecated.
 */
export function envPaths(input: EnvPathsInput): EnvPaths | undefined {
  const exists = input.exists ?? existsSync;
  if (input.explicit) return { read: [input.explicit], write: input.explicit, pendingMove: false };
  const product = input.productDir ? productEnvFile(input.productDir) : undefined;
  if (!input.instanceDir) {
    if (!product) return undefined;
    return { read: exists(product) ? [product] : [], write: product, pendingMove: false };
  }
  const own = instanceEnvFile(input.instanceDir);
  const read: string[] = [];
  if (exists(own)) read.push(own);
  const legacy = product && exists(product) ? product : undefined;
  if (legacy) read.push(legacy);
  return { read, write: own, ...(legacy ? { legacy } : {}), pendingMove: !exists(own) && legacy !== undefined };
}

/** One line per deprecation worth saying out loud; empty when the install is already self-contained. */
export function envNotices(paths: EnvPaths): string[] {
  if (!paths.legacy) return [];
  return paths.pendingMove
    ? [`${paths.legacy} is the product checkout's — an instance's environment belongs at ${paths.write}. \`metistry secrets sync --to env\` moves it (the old file is left in place, never deleted).`]
    : [`${paths.legacy} is still being read as a fallback and is deprecated — everything an install needs is now in ${paths.write}; delete it once nothing reports it missing.`];
}

// ---- instance_id ---------------------------------------------------------------

/** A v4 UUID, lowercase — the account this instance's Keychain items are filed under. */
export function mintInstanceId(): string {
  return crypto.randomUUID();
}

/** Deliberately strict: an account name that is not a UUID is a hand-edit, and a typo must not silently split an instance's secrets in two. */
export const INSTANCE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function parseInstanceId(identityYaml: string): string | undefined {
  let raw: unknown;
  try {
    raw = (parseYaml(identityYaml) as { instance_id?: unknown })?.instance_id;
  } catch {
    return undefined;
  }
  if (typeof raw !== "string") return undefined;
  const id = raw.trim().toLowerCase();
  return INSTANCE_ID_RE.test(id) ? id : undefined;
}

/** The comment block that explains the key to whoever opens identity.yaml next. */
export const INSTANCE_ID_COMMENT = [
  "",
  "# instance_id — this instance directory's stable identity (minted once by",
  "# `metistry init`, never reused, never edited by hand). Its Keychain items are",
  "# filed under it as the account, so several instance directories on one Mac",
  "# keep their secrets apart (docs/ops/cli.md, \"Instance directories are",
  "# self-contained\").",
].join("\n");

/** Set (or replace) the `instance_id:` line, leaving every other line — comments included — untouched. */
export function withInstanceId(identityYaml: string, id: string): string {
  if (!INSTANCE_ID_RE.test(id)) throw new Error(`${JSON.stringify(id)} is not a UUID`);
  const line = `instance_id: ${JSON.stringify(id)}`;
  if (/^instance_id:.*$/m.test(identityYaml)) return identityYaml.replace(/^instance_id:.*$/m, line);
  const sep = identityYaml === "" || identityYaml.endsWith("\n") ? "" : "\n";
  return `${identityYaml}${sep}${INSTANCE_ID_COMMENT}\n${line}\n`;
}

export function identityPath(instanceDir: string): string {
  return join(normalizeDir(instanceDir), IDENTITY_FILENAME);
}

/** The instance's id, or undefined when the directory has none yet (every instance created before 2026-09-09). */
export async function readInstanceId(instanceDir: string): Promise<string | undefined> {
  const file = identityPath(instanceDir);
  if (!existsSync(file)) return undefined;
  return parseInstanceId(await readFile(file, "utf8"));
}

// ---- minting it onto an instance that predates this ------------------------------

export interface EnsureInstanceIdOptions {
  instanceDir: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  uid: number;
  fetchFn: typeof fetch;
  /** test seam */
  mint?: (() => string) | undefined;
}

export interface EnsureInstanceIdResult {
  id: string;
  /** false when identity.yaml already carried one */
  minted: boolean;
  /** how a minted id reached identity.yaml: through the reconciler, straight to disk, or nowhere */
  how: "existing" | "bridge" | "direct" | "none";
  detail: string;
}

/**
 * The instance's id, minting one into `identity.yaml` when it has none.
 * `identity.yaml` is a §4.7 protected path, so the write goes through the
 * reconciler as `user` exactly as `metistry.lock` does; with no reconciler
 * configured it is written directly, and the result says which happened.
 */
export async function ensureInstanceId(r: StepRunner, opts: EnsureInstanceIdOptions): Promise<EnsureInstanceIdResult> {
  const dir = normalizeDir(opts.instanceDir);
  const existing = await readInstanceId(dir);
  if (existing) return { id: existing, minted: false, how: "existing", detail: `instance_id ${existing} (${identityPath(dir)})` };
  const file = identityPath(dir);
  if (!existsSync(file)) return { id: "", minted: false, how: "none", detail: `${file} does not exist — ${dir} is not an instance directory` };
  const id = (opts.mint ?? mintInstanceId)();
  const content = withInstanceId(await readFile(file, "utf8"), id);
  const delivery = await writeProtected(r, IDENTITY_FILENAME, content, `metistry: mint instance_id ${id}`, {
    env: opts.env,
    platform: opts.platform,
    uid: opts.uid,
    fetchFn: opts.fetchFn,
    instanceDir: dir,
  });
  return { id, minted: true, how: delivery.how, detail: `instance_id ${id} minted — ${delivery.detail}` };
}
