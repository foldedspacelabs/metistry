// `metistry init <dir>` — stamps an instance repo (plan §4.16) exactly the
// way the 2026-09-06 by-hand bootstrap did (docs/ops/reconciler.md, now
// docs/ops/cli.md): its own git repo, `Knowledge/` from seed, identity +
// rules, the empty config dirs, README, .gitignore, `metistry.lock`, one
// initial commit. Interactive-free: the assistant's name comes from
// `--name` and lands in identity.yaml — the ONLY place it lives (CLAUDE.md).
//
// Secrets: the reconciler bearer and the console's local owner token are
// minted and PRINTED, never written. The instance repo is a git repo the
// user may push anywhere; nothing secret may ever be stamped into it.

import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { COMPUTE_FILENAME, mintToken } from "@foldedspacelabs/metistry-core";
import { realExec, type Exec } from "./exec.js";
import { mintInstanceId, withInstanceId } from "./instance.js";
import { LOCK_FILENAME, serializeLock, type LockFile, type LockSource } from "./lock.js";

export interface InitOptions {
  dir: string;
  /** Assistant name written into identity.yaml; absent = the seed's default stays. */
  name?: string | undefined;
  /** Proceed into a non-empty directory (existing files are overwritten where names collide). */
  force?: boolean | undefined;
  /** The product's seed/ directory (env.ts resolveSeedDir). */
  seedDir: string;
  /** Product release pinned into metistry.lock. */
  version: string;
  /** Product commit pinned into metistry.lock ("unknown" when init runs from the bundled seed, with no checkout). */
  productCommit?: string | undefined;
  /** How the product got here (docs/ops/cli.md): a git checkout `update` fast-forwards, or a pinned release. */
  productSource?: LockSource | undefined;
  exec?: Exec | undefined;
  now?: Date | undefined;
  mint?: (() => string) | undefined;
  /** test seam: the instance_id minted into identity.yaml */
  mintInstanceId?: (() => string) | undefined;
}

export interface InitResult {
  dir: string;
  /** The assistant's name as it now stands in identity.yaml. */
  assistantName: string;
  /** This instance directory's stable identity — the Keychain account its own secrets are filed under. */
  instanceId: string;
  commit: string;
  /** `.env` lines the user adds to the PRODUCT checkout next — printed, never written. */
  envLines: string[];
}

/** Tracked config dirs the instance owns (§4.16); `inbox/` is created too but is gitignored, so it carries no placeholder. */
export const INSTANCE_DIRS = ["queries", "agents", "routines", "extensions", "instance-migrations"] as const;
// `state/` holds this instance's derived state — the Postgres data
// directory, the assistant's SDK transcripts, and the generated `.env`.
// Invariant 1: git is the record, Postgres is derived, so none of it
// belongs in the instance repo — and `.env` holds secrets, which must
// never be committable at all.
export const GITIGNORE = "inbox/\nstate/\n.obsidian/workspace*\n";
export const COMMIT_AUTHOR = { name: "Metistry", email: "metistry@localhost" } as const;

/** The mention trigger follows the name: "Metis" → "@metis". */
export function mentionFor(name: string): string {
  return `@${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
}

/** Rewrite the `name:` and `mention:` lines of a seed identity.yaml, keeping every comment and other key untouched. */
export function applyName(identityYaml: string, name: string): string {
  if (!/^name:/m.test(identityYaml)) throw new Error("seed identity.yaml has no top-level `name:` line");
  const quoted = JSON.stringify(name); // YAML double-quoted scalar
  return identityYaml
    .replace(/^name:.*$/m, `name: ${quoted}`)
    .replace(/^mention:.*$/m, `mention: ${JSON.stringify(mentionFor(name))}`);
}

/** The lock `init` writes: the same shape `update` moves (lock.ts). No db yet, so no migrations are recorded. */
export function lockFile(version: string, now: Date, commit = "unknown", source: LockSource = "git"): string {
  const lock: LockFile = { product: { version, commit, source }, updated_at: now.toISOString(), migrations_applied: [] };
  return serializeLock(lock);
}

async function isEmptyDir(dir: string): Promise<boolean> {
  if (!existsSync(dir)) return true;
  return (await readdir(dir)).length === 0;
}

export async function init(opts: InitOptions): Promise<InitResult> {
  const dir = resolve(opts.dir);
  const exec = opts.exec ?? realExec;
  const now = opts.now ?? new Date();
  const mint = opts.mint ?? (() => mintToken());

  if (!(await isEmptyDir(dir)) && !opts.force) {
    throw new Error(`${dir} is not empty — pick another directory or pass --force to stamp into it anyway`);
  }
  if (!existsSync(join(opts.seedDir, "identity.yaml")) || !existsSync(join(opts.seedDir, "Knowledge"))) {
    throw new Error(`${opts.seedDir} is not a Metistry seed/ (identity.yaml + Knowledge/ expected)`);
  }

  await mkdir(dir, { recursive: true });

  // the vault starter (incl. Knowledge/now.md, where brain-commit writes)
  await cp(join(opts.seedDir, "Knowledge"), join(dir, "Knowledge"), { recursive: true });

  // identity — the one place the assistant is named — and the router rules
  let identity = await readFile(join(opts.seedDir, "identity.yaml"), "utf8");
  if (opts.name !== undefined) {
    if (opts.name.trim() === "") throw new Error("--name must not be empty");
    identity = applyName(identity, opts.name.trim());
  }
  // this directory's stable identity, minted once and never reused: the
  // Keychain account its own secrets are filed under, and how the Mac app
  // tells several instance directories apart
  const instanceId = (opts.mintInstanceId ?? mintInstanceId)();
  identity = withInstanceId(identity, instanceId);
  await writeFile(join(dir, "identity.yaml"), identity);
  await cp(join(opts.seedDir, "rules.yaml"), join(dir, "rules.yaml"));
  // compute.yaml — providers, assignments, budgets (docs/ops/compute.md).
  // The seed's copy is entirely commented out, so a fresh instance assigns
  // nothing and rules.yaml's `tiers:` stays the live map; `metistry compute`
  // writes into this file from here on.
  if (existsSync(join(opts.seedDir, COMPUTE_FILENAME))) await cp(join(opts.seedDir, COMPUTE_FILENAME), join(dir, COMPUTE_FILENAME));
  const assistantName = String((parseYaml(identity) as { name?: unknown })?.name ?? "");

  // config-shaped dirs the instance owns; the D4 overlay reads seed defaults
  // until a same-named file appears here, so they start empty
  await mkdir(join(dir, "inbox"), { recursive: true });
  for (const d of INSTANCE_DIRS) {
    await mkdir(join(dir, d), { recursive: true });
    await writeFile(join(dir, d, ".gitkeep"), "");
  }

  await writeFile(
    join(dir, "README.md"),
    `# Instance repo — private. Vault + config; created ${now.toISOString().slice(0, 10)} by \`metistry init\` (product docs/ops/cli.md).\n`,
  );
  await writeFile(join(dir, ".gitignore"), GITIGNORE);
  await writeFile(join(dir, LOCK_FILENAME), lockFile(opts.version, now, opts.productCommit ?? "unknown", opts.productSource ?? "git"));

  // its own repo: never a git relationship with the product (§4.16)
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: COMMIT_AUTHOR.name,
    GIT_AUTHOR_EMAIL: COMMIT_AUTHOR.email,
    GIT_COMMITTER_NAME: COMMIT_AUTHOR.name,
    GIT_COMMITTER_EMAIL: COMMIT_AUTHOR.email,
  };
  const git = async (...args: string[]) => {
    const r = await exec("git", ["-c", "commit.gpgsign=false", ...args], { cwd: dir, env: gitEnv });
    if (r.code !== 0) throw new Error(`git ${args[0]} failed (${r.code}): ${(r.stderr || r.stdout).trim()}`);
    return r.stdout.trim();
  };
  if (!existsSync(join(dir, ".git"))) await git("init", "-q", "-b", "main");
  await git("add", "-A");
  await git("commit", "-q", "-m", "Instance created");
  const commit = await git("rev-parse", "HEAD");

  return {
    dir,
    assistantName,
    instanceId,
    commit,
    envLines: [
      `METISTRY_INSTANCE_DIR=${dir}`,
      `METISTRY_BRIDGE_TOKEN_RECONCILER=${mint()}`,
      "METISTRY_RECONCILER_URL=http://host.docker.internal:7812",
      // the console's local owner door (docs/ops/auth.md): the Mac app and
      // the CLI present this over loopback instead of a passkey ceremony
      `METISTRY_LOCAL_OWNER_TOKEN=${mint()}`,
    ],
  };
}
