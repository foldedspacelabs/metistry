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
import { join } from "node:path";

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
 * Invariant 2 lives here. It is enforced at the tool (the reconciler refuses
 * the write), never by asking the assistant nicely.
 */
export function isProtectedPath(rel: string): boolean {
  if (typeof rel !== "string" || rel === "") return false;
  const segments = segmentsOf(rel);
  if (segments[0] !== INSTANCE_LAYOUT.metistryDir) {
    return segments.length === 1 && (PROTECTED_ROOT_FILES as readonly string[]).includes(segments[0]!);
  }
  return segments[1] !== "state";
}

/**
 * True when `rel` is knowledge — content the reconciler walks, indexes and
 * embeds. False for the machinery (`.metistry/`), git, Obsidian's config,
 * `Artifacts/`, and anything inside a dot-directory (`Inbox/.large/` is
 * captures git does not carry, not notes).
 *
 * Note: the root `CLAUDE.md` and `README.md` ARE vault paths — Obsidian
 * renders them and the user reads them there. They are protected, so the
 * assistant cannot write them; being indexed is a separate question and the
 * honest answer is yes.
 */
export function isVaultPath(rel: string): boolean {
  if (typeof rel !== "string" || rel === "") return false;
  const segments = rel.split("/");
  if (segments.some((s) => s === "" || s === "." || s === ".." || s.startsWith("."))) return false;
  return segments[0] !== INSTANCE_LAYOUT.artifactsDir;
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
