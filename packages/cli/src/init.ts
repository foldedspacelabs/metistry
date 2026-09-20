// `metistry init <dir>` — stamps an instance repo (plan §4.16): its own git
// repo, the vault AT THE ROOT from `seed/vault/`, the config half under
// `.metistry/` (identity, rules, compute, the five config dirs,
// `metistry.lock`), README, .gitignore, one initial commit. Interactive-free:
// the assistant's name comes from `--name` and lands in identity.yaml — the
// ONLY place it lives (CLAUDE.md).
//
// The directory this stamps IS the Obsidian vault (owner's ruling
// 2026-09-17). Every path below comes from core's INSTANCE_LAYOUT; nothing
// here spells one.
//
// Secrets: the reconciler bearer and the console's local owner token are
// minted and PRINTED, never written. The instance repo is a git repo the
// user may push anywhere; nothing secret may ever be stamped into it.

import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  COMPUTE_FILENAME,
  DEFAULT_DEPLOYMENT,
  DEPLOYMENT_FILENAME,
  INSTANCE_CONFIG_DIRS,
  INSTANCE_GITIGNORE,
  INSTANCE_LAYOUT,
  KEEP_AWAKE_CHOICES,
  KEEP_AWAKE_RECOMMENDED,
  instancePath,
  keepAwakeChoice,
  metistryPath,
  mintToken,
  parseDeployment,
  parseKeepAwake,
  type DeploymentShape,
  type KeepAwake,
} from "@foldedspacelabs/metistry-core";
import { applyKeepAwakeToYaml } from "./deployment.js";
import { realExec, type Exec } from "./exec.js";
import { mintInstanceId, withInstanceId } from "./instance.js";
import { LOCK_FILENAME, serializeLock, type LockFile, type LockSource } from "./lock.js";
import { DEFAULT_PORTS, loadNamespace } from "./namespace.js";
import { defaultUi, type Ui } from "./ui.js";

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
  /**
   * Which deployment shape the printed `.env` lines target (`--shape`,
   * docs/ops/deployment-shapes.md). Undefined = guess from `platform`: this
   * is only a printing decision — the instance's actual `deployment.yaml`
   * shape is still set by `metistry deployment set-shape`, unchanged here.
   */
  shape?: DeploymentShape | undefined;
  /** test seam: which OS this is stamping on, for the `shape` guess above. */
  platform?: NodeJS.Platform | undefined;
  exec?: Exec | undefined;
  now?: Date | undefined;
  mint?: (() => string) | undefined;
  /** test seam: the instance_id minted into identity.yaml */
  mintInstanceId?: (() => string) | undefined;
  /**
   * The onboarding question's answer (`--keep-awake`, or the prompt in
   * `main.ts`): whether this install keeps the Mac awake, and on which power.
   * UNDEFINED IS NOT A DEFAULT — it means the question was not answered, and
   * nothing is written, so the install holds nothing. A power assertion
   * overrides the user's own System Settings sleep timer, and that is not
   * something to take without being asked (docs/ops/deployment-shapes.md).
   */
  keepAwake?: KeepAwake | undefined;
}

export interface InitResult {
  dir: string;
  /** The assistant's name as it now stands in identity.yaml. */
  assistantName: string;
  /** This instance directory's stable identity — the Keychain account its own secrets are filed under. */
  instanceId: string;
  commit: string;
  /** the answer that was written to `.metistry/deployment.yaml`, or undefined when the question was not answered */
  keepAwake?: KeepAwake | undefined;
  /** `.env` lines the user adds to the PRODUCT checkout next — printed, never written. */
  envLines: string[];
}

/**
 * The product seed's vault half: what lands at the instance ROOT, because
 * the instance directory IS the Obsidian vault. TitleCase inside (CLAUDE.md
 * casing rule); the name `vault` is lowercase like the rest of the repo.
 */
export const SEED_VAULT_DIR = "vault";
/** The seed's compute.yaml, which lands at `.metistry/compute.yaml`. */
export const SEED_COMPUTE_FILE = COMPUTE_FILENAME;

/**
 * Tracked config dirs the instance owns (§4.16), by bare name — they are
 * stamped under `.metistry/`, and every one of them is protected. The inbox
 * is NOT one of them: it is vault content at `Inbox/` (docs/ops/inbox.md)
 * and comes from `seed/vault/`.
 */
export const INSTANCE_DIRS = INSTANCE_CONFIG_DIRS;
// `.metistry/state/` holds this instance's derived state — the Postgres data
// directory, the assistant's SDK transcripts, downloaded models, and the
// generated `.env`. Invariant 1: git is the record, Postgres is derived, so
// none of it belongs in the instance repo — and `.env` holds secrets, which
// must never be committable at all. `Inbox/.large/` holds captures too big
// for git to carry (METISTRY_INBOX_MAX_TRACKED_BYTES) — Obsidian still sees
// them, the repo stays small. The inbox ITSELF is tracked: a capture is part
// of the record (invariant 1).
export const GITIGNORE = INSTANCE_GITIGNORE;
export const COMMIT_AUTHOR = { name: "Metistry", email: "metistry@localhost" } as const;

/**
 * The onboarding question, and the whole of "informed consent" in this
 * product: four choices, each printed with what it COSTS, the recommendation
 * named, and the one we advise against last and marked.
 *
 * It is a function of core's `KEEP_AWAKE_CHOICES` rather than prose typed out
 * here, so the CLI, the docs and the Mac app cannot describe the same choice
 * differently.
 */
export function keepAwakeQuestion(ui: Ui = defaultUi()): string[] {
  const wrapped = (text: string, indent: number): string[] => ui.wrap(text, { indent }).split("\n").map(ui.dim);
  const lines = [
    ui.heading("Keep this Mac awake while Metistry runs?"),
    "",
    ...wrapped(
      "Metistry only works while this Mac is awake: captures from your phone, scheduled collectors and " +
        "the assistant's queue all wait while it sleeps. It can hold the Mac awake for you — the screen " +
        "still sleeps, and a closed laptop lid still sleeps.",
      2,
    ),
    "",
  ];
  KEEP_AWAKE_CHOICES.forEach((choice, i) => {
    // the tag is the only colour in the block, and it borrows the status
    // vocabulary rather than inventing one: green for the recommendation,
    // amber for the one we advise against (docs/ops/cli-style.md rule 5)
    const tags = [choice.recommended ? "recommended" : "", choice.notRecommended ? "not recommended" : ""].filter(Boolean).join(", ");
    lines.push(`  ${ui.strong(`${i + 1}) ${choice.label}`)}${tags ? ` ${ui.paint(choice.recommended ? "ok" : "degraded", `(${tags})`)}` : ""}`);
    lines.push(...wrapped(choice.consequence, 5));
    lines.push(ui.dim(`     deployment.yaml: keep_awake: ${choice.value}`));
    lines.push("");
  });
  lines.push(ui.dim("  You can change this later: `metistry deployment set-keep-awake <value> --yes`."));
  return lines;
}

/** Reads one line. `main.ts` supplies the terminal's; a test supplies a script. */
export type Ask = (prompt: string) => Promise<string>;

/**
 * Ask it, accepting either the number or the value's own name, with Enter
 * taking the recommendation. Three unreadable answers is an error rather than
 * a silent default: this choice changes how the machine behaves, so guessing
 * at it is exactly the thing not to do.
 */
export async function askKeepAwake(ask: Ask, out: (line: string) => void, opts: { ui?: Ui | undefined; attempts?: number | undefined } = {}): Promise<KeepAwake> {
  const ui = opts.ui ?? defaultUi();
  const attempts = opts.attempts ?? 3;
  for (const line of keepAwakeQuestion(ui)) out(line);
  const numbered = KEEP_AWAKE_CHOICES.map((c) => c.value);
  for (let i = 0; i < attempts; i++) {
    const raw = (await ask(`Choice [1-${numbered.length}, Enter for ${keepAwakeChoice(KEEP_AWAKE_RECOMMENDED).label.toLowerCase()}]: `)).trim();
    if (raw === "") return KEEP_AWAKE_RECOMMENDED;
    const byNumber = Number.parseInt(raw, 10);
    if (Number.isInteger(byNumber) && byNumber >= 1 && byNumber <= numbered.length) return numbered[byNumber - 1]!;
    const byName = parseKeepAwake(raw);
    if (byName) return byName;
    out(ui.paint("degraded", `  ${JSON.stringify(raw)} is not one of them — answer 1-${numbered.length}, or ${numbered.join(" / ")}.`));
  }
  throw new Error(`no usable answer to the keep-awake question after ${attempts} tries — rerun with \`--keep-awake <${numbered.join("|")}>\``);
}

/**
 * The shape this install ALREADY has, from the product's seed, because the
 * file `init` writes for the keep-awake answer must carry it: a
 * deployment.yaml with only `keep_awake` in it parses with `shape` defaulted
 * to compose and would quietly move the install. The answer to one question is
 * never a decision about the other.
 */
export async function seedShape(seedDir: string): Promise<DeploymentShape> {
  const file = join(seedDir, DEPLOYMENT_FILENAME);
  if (!existsSync(file)) return DEFAULT_DEPLOYMENT.shape;
  try {
    return parseDeployment(parseYaml(await readFile(file, "utf8")), `seed/${DEPLOYMENT_FILENAME}`).shape;
  } catch {
    return DEFAULT_DEPLOYMENT.shape;
  }
}

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
  if (!existsSync(join(opts.seedDir, "identity.yaml")) || !existsSync(join(opts.seedDir, SEED_VAULT_DIR))) {
    throw new Error(`${opts.seedDir} is not a Metistry seed/ (identity.yaml + ${SEED_VAULT_DIR}/ expected)`);
  }

  await mkdir(dir, { recursive: true });

  // the vault starter, AT THE ROOT: now.md (where brain-commit writes),
  // Inbox/, and the CLAUDE.md the user writes their own instructions into
  await cp(join(opts.seedDir, SEED_VAULT_DIR), dir, { recursive: true });
  await mkdir(metistryPath(dir), { recursive: true });

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
  await writeFile(instancePath(dir, "identity"), identity);
  await cp(join(opts.seedDir, "rules.yaml"), instancePath(dir, "rules"));
  // compute.yaml — providers, assignments, budgets (docs/ops/compute.md).
  // The seed's copy is entirely commented out, so a fresh instance assigns
  // nothing and rules.yaml's `tiers:` stays the live map; `metistry compute`
  // writes into this file from here on.
  if (existsSync(join(opts.seedDir, SEED_COMPUTE_FILE))) await cp(join(opts.seedDir, SEED_COMPUTE_FILE), instancePath(dir, "compute"));
  const assistantName = String((parseYaml(identity) as { name?: unknown })?.name ?? "");

  // the vault inbox (docs/ops/inbox.md): seed/vault/ carries its README, and
  // this guarantees the directory exists even for a seed that does not
  await mkdir(instancePath(dir, "inboxDir"), { recursive: true });

  // config-shaped dirs the instance owns, under `.metistry/`; the D4 overlay
  // reads seed defaults until a same-named file appears here, so they start
  // empty
  for (const d of INSTANCE_DIRS) {
    await mkdir(metistryPath(dir, d), { recursive: true });
    await writeFile(metistryPath(dir, d, ".gitkeep"), "");
  }

  // The keep-awake answer, when there is one. `deployment.yaml` is a §4.7
  // protected path, and this is the same moment `init` stamps the other two
  // (identity.yaml, metistry.lock) by hand: there is no repo and no
  // reconciler yet, and the first commit below is what makes them the record.
  if (opts.keepAwake !== undefined) {
    await writeFile(instancePath(dir, "deployment"), applyKeepAwakeToYaml(undefined, opts.keepAwake, await seedShape(opts.seedDir)));
  }

  await writeFile(
    instancePath(dir, "readme"),
    `# Instance repo — private. This directory is the Obsidian vault; the machinery lives in \`.metistry/\`. Created ${now.toISOString().slice(0, 10)} by \`metistry init\` (product docs/ops/cli.md).\n`,
  );
  await writeFile(join(dir, ".gitignore"), GITIGNORE);
  await writeFile(instancePath(dir, "lock"), lockFile(opts.version, now, opts.productCommit ?? "unknown", opts.productSource ?? "git"));

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

  // Which shape the printed lines target (docs/ops/deployment-shapes.md):
  // launchd is what the Mac app installs and what a fresh macOS checkout
  // runs by default (no Docker Desktop hurdle); `--shape compose` keeps the
  // old compose-shaped line for a container install. Namespacing
  // (`metistry up --namespace`) only ever applies to the launchd shape
  // (`docs/ops/deployment-shapes.md`, "A second instance on one Mac") —
  // compose's ports stay the fixed defaults docker-compose.yml publishes.
  const shape: DeploymentShape = opts.shape ?? ((opts.platform ?? process.platform) === "darwin" ? "launchd" : "compose");
  const ns = shape === "launchd" ? await loadNamespace(dir) : undefined;
  const consolePort = shape === "launchd" ? (ns?.ports.console ?? DEFAULT_PORTS.console) : DEFAULT_PORTS.console;
  const reconcilerUrl =
    shape === "launchd" ? `http://127.0.0.1:${ns?.ports.reconciler ?? DEFAULT_PORTS.reconciler}` : "http://host.docker.internal:7812";

  return {
    dir,
    assistantName,
    instanceId,
    commit,
    ...(opts.keepAwake !== undefined ? { keepAwake: opts.keepAwake } : {}),
    envLines: [
      `METISTRY_INSTANCE_DIR=${dir}`,
      `METISTRY_BRIDGE_TOKEN_RECONCILER=${mint()}`,
      // The OWNER class of the same bridge (docs/ops/auth.md): the one
      // credential that may write a §4.7 protected path. Minted separately
      // and never handed to the console — `consoleEnv` denies it by name —
      // so "only the user's hand changes how the system behaves" is a
      // property of the credential rather than of a field in a request body.
      `METISTRY_BRIDGE_TOKEN_RECONCILER_USER=${mint()}`,
      `METISTRY_RECONCILER_URL=${reconcilerUrl}`,
      // the console's canonical origin (docs/ops/auth.md) — required to
      // start (apps/console/src/main.ts requireEnv) in EITHER shape. This is
      // the default for a loopback-only install; a tailnet hostname or an
      // HTTPS reverse proxy replaces it once this instance is reachable off
      // the machine, and passkeys enrolled here bind to whichever origin is
      // configured at enrolment time, so changing it later means re-enrolling.
      `METISTRY_ORIGIN=http://127.0.0.1:${consolePort}`,
      // the console's local owner door (docs/ops/auth.md): the Mac app and
      // the CLI present this over loopback instead of a passkey ceremony
      `METISTRY_LOCAL_OWNER_TOKEN=${mint()}`,
    ],
  };
}
