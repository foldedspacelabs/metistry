// `metistry.lock` — the product release an instance runs (plan §4.16). One
// shape, written by `init` and moved by `update`; documented in
// docs/ops/cli.md. It lives in the INSTANCE repo (a §4.7 protected path —
// only the `user` principal may write it through the reconciler bridge).

import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";

export type LockSource = "git" | "release";

export interface LockFile {
  product: {
    /** the cli package's version — the release the instance runs */
    version: string;
    /** product commit at the time of writing; "unknown" when there is no git checkout (a release install) */
    commit: string;
    /** git = the product is a checkout that `update` fast-forwards; release = pinned published artifacts */
    source: LockSource;
  };
  /** ISO-8601 */
  updated_at: string;
  /** every db/migrations file recorded in schema_migrations at the time of writing (empty at init — no db yet) */
  migrations_applied: string[];
}

export const LOCK_FILENAME = "metistry.lock";

export function serializeLock(lock: LockFile): string {
  const q = (s: string) => JSON.stringify(s); // YAML double-quoted scalar: safe for any commit/version string
  return [
    "# metistry.lock — the product release this instance runs (plan §4.16).",
    "# `metistry update` moves the pin; edit by hand only to roll back.",
    "product:",
    `  version: ${q(lock.product.version)}`,
    `  commit: ${q(lock.product.commit)}`,
    `  source: ${lock.product.source}`,
    `updated_at: ${q(lock.updated_at)}`,
    ...(lock.migrations_applied.length === 0 ? ["migrations_applied: []"] : ["migrations_applied:", ...lock.migrations_applied.map((m) => `  - ${q(m)}`)]),
    "",
  ].join("\n");
}

/** Strict: anything that is not the documented shape is an error, never a guess (a hand-edited lock is a rollback, and a typo there must not silently become "git"). */
export function parseLock(text: string): LockFile {
  const raw = parseYaml(text) as unknown;
  const bad = (why: string) => new Error(`${LOCK_FILENAME}: ${why} (docs/ops/cli.md documents the shape)`);
  if (!raw || typeof raw !== "object") throw bad("not a mapping");
  const r = raw as Record<string, unknown>;
  const p = r.product;
  if (p === undefined && typeof r.version === "string" && r.version !== "") {
    // the pre-2026-09-07 shape (`version:` + `created:`) an earlier `metistry init` wrote: read as a git pin, rewritten on the next update
    const created = typeof r.created === "string" || r.created instanceof Date ? new Date(r.created) : new Date(0);
    return { product: { version: r.version, commit: "unknown", source: "git" }, updated_at: (Number.isNaN(created.getTime()) ? new Date(0) : created).toISOString(), migrations_applied: [] };
  }
  if (!p || typeof p !== "object") throw bad("missing product:");
  const pr = p as Record<string, unknown>;
  if (typeof pr.version !== "string" || pr.version === "") throw bad("product.version must be a string");
  if (typeof pr.commit !== "string" || pr.commit === "") throw bad("product.commit must be a string");
  if (pr.source !== "git" && pr.source !== "release") throw bad("product.source must be git or release");
  if (typeof r.updated_at !== "string" || Number.isNaN(Date.parse(r.updated_at))) throw bad("updated_at must be an ISO-8601 date");
  const m = r.migrations_applied;
  if (!Array.isArray(m) || m.some((x) => typeof x !== "string")) throw bad("migrations_applied must be a list of filenames");
  return { product: { version: pr.version, commit: pr.commit, source: pr.source }, updated_at: r.updated_at, migrations_applied: m as string[] };
}

/** The lock lives in the instance repo: `$METISTRY_INSTANCE_DIR/metistry.lock`. undefined when no instance dir is configured. */
export function instanceLockPath(env: NodeJS.ProcessEnv): string | undefined {
  const dir = env.METISTRY_INSTANCE_DIR;
  return dir ? `${dir.replace(/\/+$/, "")}/${LOCK_FILENAME}` : undefined;
}

/** undefined when the file does not exist; throws on a malformed one. */
export async function readLock(path: string): Promise<LockFile | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  return parseLock(text);
}
