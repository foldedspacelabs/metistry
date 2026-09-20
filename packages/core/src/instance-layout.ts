// The instance directory's shape, in one place (owner's ruling 2026-09-17).
//
// The instance directory IS the Obsidian vault. The user opens the instance
// repo in Obsidian and sees their notes at the root — `Journal/`, `Me/`,
// `now.md` — with nothing of the machinery in the way. Everything that is
// not knowledge lives under `.metistry/`, and Obsidian ignores dot-prefixed
// folders, which is the whole reason for the dot:
//
//   <instance>/
//     .metistry/
//       identity.yaml  rules.yaml  compute.yaml  deployment.yaml  metistry.lock
//       agents/  routines/  queries/  targets/  extensions/  instance-migrations/
//       state/            gitignored: .env, models/, sockets, everything runtime
//     .obsidian/          workspace* gitignored
//     Inbox/              captures (Inbox/.large/ gitignored)
//     Journal/ Me/ now.md …   vault content, TitleCase, at the root
//     Artifacts/          owner-visible content, NOT indexed as knowledge
//     CLAUDE.md           the assistant's operating instructions
//     README.md
//
// Every component reads its paths from here rather than spelling them, so
// the layout is one edit and not ninety. Nothing in this module touches the
// filesystem except `detectLayout`, which only asks whether two names exist.

import { existsSync } from "node:fs";
import { basename, join } from "node:path";

/**
 * The one spelling of every path inside an instance directory, POSIX and
 * instance-relative. Frozen: a caller that wants a different layout is
 * describing a different product.
 */
export const INSTANCE_LAYOUT = Object.freeze({
  /** Everything that is not knowledge. Dot-prefixed so Obsidian never renders it. */
  metistryDir: ".metistry",
  /** Derived, gitignored: the `.env`, Postgres data, downloaded models, sockets (invariant 1). */
  stateDir: ".metistry/state",

  identity: ".metistry/identity.yaml",
  rules: ".metistry/rules.yaml",
  compute: ".metistry/compute.yaml",
  deployment: ".metistry/deployment.yaml",
  instances: ".metistry/instances.yaml",
  sources: ".metistry/sources.yaml",
  /** The D4 system-prompt overlay. Not the same file as the root CLAUDE.md. */
  assistantPrompt: ".metistry/assistant-prompt.md",
  lock: ".metistry/metistry.lock",

  queriesDir: ".metistry/queries",
  agentsDir: ".metistry/agents",
  routinesDir: ".metistry/routines",
  targetsDir: ".metistry/targets",
  extensionsDir: ".metistry/extensions",
  instanceMigrationsDir: ".metistry/instance-migrations",

  /** Captures, as ordinary vault content (docs/ops/inbox.md). */
  inboxDir: "Inbox",
  /** Captures git should not carry (METISTRY_INBOX_MAX_TRACKED_BYTES); gitignored, still visible in Obsidian. */
  largeInboxDir: "Inbox/.large",
  /** Owner-visible content, at the root — but not knowledge: nothing indexes it. */
  artifactsDir: "Artifacts",
  /** The assistant's operating instructions, in the user's hand (invariant 2). */
  assistantInstructions: "CLAUDE.md",
  readme: "README.md",

  obsidianDir: ".obsidian",
  gitDir: ".git",
} as const);

export type InstancePathKey = keyof typeof INSTANCE_LAYOUT;

/**
 * The config directories the instance owns, by their bare name. Each is
 * stamped under `.metistry/` and each is protected — they define how the
 * system behaves, so they are the user's hand (invariant 2).
 */
export const INSTANCE_CONFIG_DIRS = Object.freeze(["queries", "agents", "routines", "targets", "extensions", "instance-migrations"] as const);

/** The `.gitignore` a fresh instance is stamped with: derived state, Obsidian's per-machine workspace, oversized captures. */
export const INSTANCE_GITIGNORE_LINES = Object.freeze([
  `${INSTANCE_LAYOUT.stateDir}/`,
  `${INSTANCE_LAYOUT.obsidianDir}/workspace*`,
  `${INSTANCE_LAYOUT.largeInboxDir}/`,
] as const);

/** The same lines as a file body. */
export const INSTANCE_GITIGNORE = `${INSTANCE_GITIGNORE_LINES.join("\n")}\n`;

/**
 * Root entries that are in the directory but not in the knowledge walk:
 * the machinery, git, Obsidian's own config, and `Artifacts/` — owner-visible
 * content that no indexer has ever read and that stays out of it (a binary
 * bundle is not a note).
 */
export const NON_VAULT_ROOTS = Object.freeze([
  INSTANCE_LAYOUT.metistryDir,
  INSTANCE_LAYOUT.obsidianDir,
  INSTANCE_LAYOUT.gitDir,
  INSTANCE_LAYOUT.artifactsDir,
] as const);

/**
 * How "the whole vault" is spelled in a grant or a crew scope.
 *
 * Before the flat layout this was the vault directory's name with a trailing
 * slash (`Knowledge/`). With the vault AT the instance root there is no name
 * to say, so the bare vault is `/` — the one prefix that trims to the empty
 * string, which every prefix test (`underAreas`, the SQL `areaFilter`) reads
 * as "everything, root notes included". The console admits it for internal
 * principals only: for an external agent an area grant is a prefix, and
 * "everything" is not an area.
 */
export const VAULT_ROOT_AREA = "/";

/**
 * **The one shape of a vault area prefix.** One or more TitleCase segments
 * from the vault root (CLAUDE.md's casing rule — Obsidian renders these, and
 * `areas/` in one file with `Areas/` in another works on macOS and breaks in a
 * container). No traversal, no leading or trailing slash, and no way to spell
 * `.metistry/`, which does not start with an uppercase letter: the machinery
 * is not grantable.
 */
export const AREA_PREFIX_RE = /^[A-Z][A-Za-z0-9 _.'-]*(\/[A-Z][A-Za-z0-9 _.'-]*)*$/;

export const MAX_AREA_PREFIX_LEN = 200;  // limit: fixed — AREA_PREFIX_RE's shape bounds it; a longer string is not a vault path

/**
 * **The SHAPE alone**: `AREA_PREFIX_RE`, the length bound, and the explicit
 * `..` refusal. Nothing here says who may hold the area or what a reader
 * would find under it — that is `validAgentAreaGrant` below.
 *
 * Keeping the shape separate is the owner's ruling of 2026-09-19 (D): what
 * an AGENT may be granted is a narrower question than what a vault prefix
 * IS, and folding the narrower one in here made "is this a vault prefix"
 * answer "no" for `Artifacts/…` — a sentence the owner's own surfaces have
 * no business saying about their own directory.
 */
export function validAreaPrefix(area: unknown): area is string {
  return (
    typeof area === "string" &&
    area.length > 0 &&
    area.length <= MAX_AREA_PREFIX_LEN &&
    AREA_PREFIX_RE.test(area) &&
    !area.includes("..")
  );
}

/**
 * **The one shape of an area an AGENT may be granted** — the shape above,
 * plus `isVaultPath`: content a knowledge read path would actually serve.
 *
 * The extra condition exists because the shape alone admits
 * `Artifacts/Reports`, which is TitleCase and is not knowledge. Every read
 * path an agent has refuses `Artifacts/` (mcp-brain's `canSeeUnder`), so
 * granting it was always an INERT grant that reads in the registry like a
 * real one — and an inert grant is worse than a refusal, because the owner
 * believes they gave access they did not give.
 *
 * **It is a rule about agents, not about the owner** (ruled 2026-09-19 D:
 * "the owner should always have access to everything; agents should only
 * have access to what they're granted"). The owner's own access to
 * `Artifacts/` is the artifacts door — `GET /api/artifacts/…`, the
 * artifacts service over the vault bridge — and nothing on this predicate's
 * path touches it. Do not reach for this function to answer "may the owner
 * see X": the answer there is yes.
 *
 * It lives in core because TWO doors ask the agent question and their
 * answers must be the same one: the console's `validateGrants` (the owner's
 * hand on `PUT /api/agents/:id/grants`, where the grant an agent will hold
 * is typed) and mcp-brain's `request_access` (an agent asking for a prefix
 * it does not hold). A second regex that agreed today is a refusal that
 * drifts apart later — which is the one way an agent could name an area the
 * grants validator would never have admitted.
 *
 * "Everything" is deliberately NOT expressible here: the bare vault is
 * `VAULT_ROOT_AREA`, admitted by the console for internal rows alone, and no
 * agent may ask for it.
 */
export function validAgentAreaGrant(area: unknown): area is string {
  return validAreaPrefix(area) && isVaultPath(area);
}

/** The refusal both doors say when `validAreaPrefix` is false — one sentence, so the owner's form and an agent's tool teach the same shape. */
export const AREA_PREFIX_REFUSAL = "area must be a TitleCase vault prefix (e.g. Areas/Fsl)";

/** Root files that are the user's hand alone, outside `.metistry/`. */
export const PROTECTED_ROOT_FILES = Object.freeze([INSTANCE_LAYOUT.assistantInstructions, INSTANCE_LAYOUT.readme] as const);

/** `<instanceDir>/<the layout's path for `key`>`, with trailing slashes on the directory normalised away. */
export function instancePath(instanceDir: string, key: InstancePathKey): string {
  return join(instanceDir.replace(/\/+$/, ""), ...INSTANCE_LAYOUT[key].split("/"));
}

/** `<instanceDir>/.metistry/<...rest>` — for names the layout does not enumerate (a state subdirectory, a query file). */
export function metistryPath(instanceDir: string, ...rest: string[]): string {
  return join(instanceDir.replace(/\/+$/, ""), INSTANCE_LAYOUT.metistryDir, ...rest);
}

/** `<instanceDir>/.metistry/state/<...rest>`. */
export function statePath(instanceDir: string, ...rest: string[]): string {
  return join(instanceDir.replace(/\/+$/, ""), ...INSTANCE_LAYOUT.stateDir.split("/"), ...rest);
}

function segmentsOf(rel: string): string[] {
  return rel.replace(/^\/+|\/+$/g, "").split("/");
}

/**
 * The §4.7 protected set, as one rule: everything under `.metistry/` is the
 * user's hand — except `.metistry/state/`, which is derived and nobody's
 * record — plus the two root files that define how the system behaves.
 *
 * AND the same machinery where a LEGACY instance still keeps it: at the
 * instance root, because `metistry migrate-layout` has not run yet. The
 * legacy names are protected unconditionally rather than behind a detected
 * shape, for two reasons. This function gets a path and nothing else — the
 * reconciler calls it per write, `mcp-brain` calls it with no instance
 * directory in reach — so threading a shape here would mean threading one
 * through every write path. And the set is strictly safer on a flat
 * instance: every one of these names is lowercase machinery that the flat
 * layout has no business holding at its root, so refusing writes to it
 * costs a flat instance nothing and closes the hole on a legacy one.
 *
 * Invariant 2 lives here. It is enforced at the tool (the reconciler refuses
 * the write), never by asking the assistant nicely.
 */
export function isProtectedPath(rel: string): boolean {
  if (typeof rel !== "string" || rel === "") return false;
  const segments = segmentsOf(rel);
  if (segments[0] === INSTANCE_LAYOUT.metistryDir) return segments[1] !== "state";
  if (segments.length === 1 && (PROTECTED_ROOT_FILES as readonly string[]).includes(segments[0]!)) return true;
  return (LEGACY_MACHINERY_ROOTS as readonly string[]).includes(segments[0]!);
}

/**
 * True when `rel` is knowledge — content the reconciler walks, indexes and
 * embeds. False for the machinery (`.metistry/`), git, Obsidian's config,
 * `Artifacts/`, and anything inside a dot-directory (`Inbox/.large/` is
 * captures git does not carry, not notes).
 *
 * The root `CLAUDE.md` and `README.md` are false too. Obsidian renders them,
 * and they are the user's to edit — but they are the assistant's operating
 * instructions and the repo's readme, not notes. Indexing them would put the
 * instructions into search results and in front of the fold, which is noise
 * at best and a loop at worst.
 *
 * The legacy machinery at the instance root (`identity.yaml`, `queries/`,
 * `state/`, …) is false as well, for the same reason `.metistry/` is: it is
 * machinery in the one place a not-yet-migrated instance still keeps it.
 * Without this the reconciler's walk — which starts at the instance root
 * since the flat layout — would index a legacy instance's config, its
 * `metistry.lock` and every byte of its gitignored Postgres cluster as
 * notes. `Knowledge/` is deliberately NOT in the set: on a legacy instance
 * that prefix IS the vault.
 */
export function isVaultPath(rel: string): boolean {
  if (typeof rel !== "string" || rel === "") return false;
  const segments = rel.split("/");
  if (segments.some((s) => s === "" || s === "." || s === ".." || s.startsWith("."))) return false;
  if (segments[0] === INSTANCE_LAYOUT.artifactsDir) return false;
  if ((LEGACY_MACHINERY_ROOTS as readonly string[]).includes(segments[0]!)) return false;
  if (segments[0] === LEGACY_INSTANCE_LAYOUT.stateDir) return false;
  return !(segments.length === 1 && (PROTECTED_ROOT_FILES as readonly string[]).includes(segments[0]!));
}

/** Which shape an instance directory is in. `unknown` = not an instance directory (or not stamped yet). */
export type InstanceLayoutShape = "flat" | "legacy" | "unknown";

/**
 * Read the shape off disk. `flat` is this layout; `legacy` is the pre-ruling
 * one (`Knowledge/` for the vault, config at the root). The migration verb
 * branches on this — which is why it exists before the verb does.
 */
export function detectLayout(instanceDir: string, exists: (p: string) => boolean = existsSync): InstanceLayoutShape {
  const dir = instanceDir.replace(/\/+$/, "");
  if (exists(instancePath(dir, "identity"))) return "flat";
  if (exists(join(dir, LEGACY_VAULT_DIR)) || exists(join(dir, "identity.yaml"))) return "legacy";
  return "unknown";
}

/**
 * The pre-2026-09-17 vault directory. Named here (and nowhere else) so the
 * follow-up migration verb has one constant to move FROM, and so a grep for
 * the old literal finds this comment rather than ninety live call sites.
 */
export const LEGACY_VAULT_DIR = "Knowledge";

/**
 * The SAME table, spelled the way an instance that has not run
 * `metistry migrate-layout` still spells it: the vault in `Knowledge/`,
 * every config file and directory at the instance root, `state/` beside
 * them (docs/ops/instance-layout.md, "The legacy layout, for reference").
 *
 * This exists so a reader can go on reading a legacy instance. It is not a
 * second supported layout: `metistry init` has only ever stamped one, the
 * migration verb moves the other onto it, and `metistry update` refuses to
 * carry a legacy instance past 0.8.x. Nothing writes through this table —
 * writers spell the flat layout (`instancePath`), readers resolve
 * (`instanceFile`).
 *
 * `metistryDir` is `""`: the legacy layout had no enclosing directory, so
 * "the machinery directory" IS the instance root. `join()` drops the empty
 * segment, which is exactly right for a path and exactly wrong for a
 * prefix test — use `LEGACY_MACHINERY_ROOTS` for those.
 */
export const LEGACY_INSTANCE_LAYOUT = Object.freeze({
  metistryDir: "",
  stateDir: "state",

  identity: "identity.yaml",
  rules: "rules.yaml",
  compute: "compute.yaml",
  deployment: "deployment.yaml",
  instances: "instances.yaml",
  sources: "sources.yaml",
  assistantPrompt: "assistant-prompt.md",
  lock: "metistry.lock",

  queriesDir: "queries",
  agentsDir: "agents",
  routinesDir: "routines",
  targetsDir: "targets",
  extensionsDir: "extensions",
  instanceMigrationsDir: "instance-migrations",

  inboxDir: `${LEGACY_VAULT_DIR}/Inbox`,
  largeInboxDir: `${LEGACY_VAULT_DIR}/Inbox/.large`,
  artifactsDir: "Artifacts",
  assistantInstructions: "CLAUDE.md",
  readme: "README.md",

  obsidianDir: ".obsidian",
  gitDir: ".git",
} as const satisfies Record<InstancePathKey, string>);

/**
 * Every root NAME that is machinery rather than knowledge on a legacy
 * instance — the set `metistry migrate-layout` moves under `.metistry/`
 * (`METISTRY_MOVES`), minus `state`, which the two predicates treat
 * separately because it is derived rather than protected.
 *
 * `eval` has no flat key (bake-off fixtures and transcripts, docs/poc/poc18-bakeoff)
 * and is in the set for the same reason the verb moves it: instance-repo
 * content, not notes.
 */
export const LEGACY_MACHINERY_ROOTS = Object.freeze([
  LEGACY_INSTANCE_LAYOUT.identity,
  LEGACY_INSTANCE_LAYOUT.rules,
  LEGACY_INSTANCE_LAYOUT.compute,
  LEGACY_INSTANCE_LAYOUT.deployment,
  LEGACY_INSTANCE_LAYOUT.instances,
  LEGACY_INSTANCE_LAYOUT.sources,
  LEGACY_INSTANCE_LAYOUT.assistantPrompt,
  LEGACY_INSTANCE_LAYOUT.lock,
  LEGACY_INSTANCE_LAYOUT.queriesDir,
  LEGACY_INSTANCE_LAYOUT.agentsDir,
  LEGACY_INSTANCE_LAYOUT.routinesDir,
  LEGACY_INSTANCE_LAYOUT.targetsDir,
  LEGACY_INSTANCE_LAYOUT.extensionsDir,
  LEGACY_INSTANCE_LAYOUT.instanceMigrationsDir,
  "eval",
] as const);

/** One instance directory's shape and the path table that goes with it. */
export interface ResolvedInstanceLayout {
  shape: InstanceLayoutShape;
  /** `INSTANCE_LAYOUT` for `flat` and `unknown`, `LEGACY_INSTANCE_LAYOUT` for `legacy`. */
  layout: Readonly<Record<InstancePathKey, string>>;
  /** `<instanceDir>/<this shape's path for `key`>`. */
  path(key: InstancePathKey): string;
  /** `<instanceDir>/<this shape's state dir>/<...rest>`. */
  state(...rest: string[]): string;
}

/**
 * The shape of `instanceDir` and how to spell every path in it. ONE read of
 * the filesystem (`detectLayout`, two existence tests) and every path after
 * it is a string join.
 *
 * `unknown` resolves to the flat table: a directory that is not an instance
 * yet is one `metistry init` will stamp flat, so "where would this file go"
 * has exactly one answer. That also keeps a reader pointed at an empty
 * directory reporting the flat path in its error message, which is the path
 * the operator needs to see.
 */
export function resolveInstanceLayout(instanceDir: string, exists: (p: string) => boolean = existsSync): ResolvedInstanceLayout {
  const dir = instanceDir.replace(/\/+$/, "");
  const shape = detectLayout(dir, exists);
  const layout = shape === "legacy" ? LEGACY_INSTANCE_LAYOUT : INSTANCE_LAYOUT;
  return {
    shape,
    layout,
    path: (key) => join(dir, ...layout[key].split("/").filter(Boolean)),
    state: (...rest) => join(dir, ...layout.stateDir.split("/").filter(Boolean), ...rest),
  };
}

/**
 * `<instanceDir>/<key>` as THIS directory spells it — flat, or legacy when
 * it has not been migrated yet. Every READER goes through here; a writer
 * that stamps or moves the layout spells it with `instancePath` /
 * `metistryPath`, because there is only one layout to write.
 */
export function instanceFile(instanceDir: string, key: InstancePathKey, exists: (p: string) => boolean = existsSync): string {
  return resolveInstanceLayout(instanceDir, exists).path(key);
}

/** `<instanceDir>/<state dir>/<...rest>` as THIS directory spells it (`.metistry/state/` or the legacy `state/`). */
export function instanceStatePath(instanceDir: string, ...rest: string[]): string {
  return resolveInstanceLayout(instanceDir).state(...rest);
}

// ---- the D4 overlay defaults ---------------------------------------------
//
// `identity.yaml`, `assistant-prompt.md`, `rules.yaml` and `compute.yaml`
// each ship a copy in the product's `seed/` and are overlaid by the
// instance's own file: colon-separated candidates, LAST EXISTING FILE WINS
// (docs/ops/assistant-tools.md).
//
// The instance half has to be ABSOLUTE. Spelled relative — the old
// `seed/identity.yaml:.metistry/identity.yaml` — it names the instance's
// file only when the process happens to be RUNNING in the instance
// directory, and no service ever is: every plist sets
// `WorkingDirectory=__REPO__`, the product checkout. So the second
// candidate silently missed and the engine answered as the SEED identity
// (found by the 2026-09-17 legacy verification, #198's "not fixed here" #1).
// Resolving through `instanceFile` also finds a legacy instance's root
// `identity.yaml` without the caller knowing which layout it is in.

/** The product's seed directory, as every service's default names it: relative to the checkout, which is each job's working directory. */
export const SEED_DIR = "seed";

/**
 * The product's copy of one config file — `seed/identity.yaml`,
 * `seed/rules.yaml`, … — derived from the layout's own spelling so the two
 * halves of an overlay can never name different files. `seedDir` is
 * absolute when the caller knows the checkout (`metistry up` does), which
 * is what removes the last cwd dependency from a launchd job.
 */
export function seedFile(key: InstancePathKey, seedDir: string = SEED_DIR): string {
  return `${seedDir.replace(/\/+$/, "")}/${basename(INSTANCE_LAYOUT[key])}`;
}

/**
 * The D4 overlay default for one config file: the product's seed copy, then
 * this instance's own, as THIS instance spells it.
 *
 * No instance directory = the seed alone. A process that has not been told
 * where the instance is has no instance file to overlay, and saying that
 * here keeps every caller from inventing a relative path that resolves
 * against whatever cwd it happens to have.
 */
export function overlayFiles(
  key: InstancePathKey,
  instanceDir?: string | undefined,
  opts: { seedDir?: string | undefined; exists?: ((p: string) => boolean) | undefined } = {},
): string {
  const seed = seedFile(key, opts.seedDir ?? SEED_DIR);
  const dir = instanceDir?.replace(/\/+$/, "");
  return dir ? `${seed}:${instanceFile(dir, key, opts.exists ?? existsSync)}` : seed;
}

/**
 * The same default, read off an environment: `METISTRY_INSTANCE_DIR` and
 * `METISTRY_SEED_DIR`, both set by `metistry up` for every child.
 *
 * Every service resolves its overlays through THIS function, so the engine,
 * the console's router and the reconciler cannot end up reading config from
 * two different places — which is exactly what happened while each spelled
 * its own default.
 */
export function overlayFilesFromEnv(env: NodeJS.ProcessEnv, key: InstancePathKey): string {
  const seedDir = env.METISTRY_SEED_DIR?.trim();
  return overlayFiles(key, env.METISTRY_INSTANCE_DIR?.trim() || undefined, { ...(seedDir ? { seedDir } : {}) });
}
