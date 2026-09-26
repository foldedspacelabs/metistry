// Path confinement and the §4.7 protected set — the write surface's whole
// policy, enforced here so no caller (assistant, console, a stranger's
// agent) can route around it. Every rule is a test in test/paths.test.ts.

import { lstat, readdir, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { INSTANCE_LAYOUT, JOURNAL_DIR, NON_VAULT_ROOTS, PROTECTED_ROOT_FILES, isProtectedPath, isUserOwnedPath, type NoteSectionName } from "@foldedspacelabs/metistry-core";

export type PathRefusal =
  | "invalid_request" // malformed / traversal / absolute / bad casing / control chars
  | "forbidden"; // .git, .metistry/instance-migrations/, symlink component, outside the repo

export interface Confined {
  /** Vault-relative POSIX path exactly as it will be stored. */
  rel: string;
  /** Absolute path inside the repo working tree. */
  abs: string;
  /** Path components. */
  segments: string[];
}

const MAX_PATH = 500;  // limit: fixed — the vault path contract every bridge validates against
const MAX_SEGMENT = 255;  // limit: fixed — every filesystem we target stops at 255 bytes per component
// Every path an agent may touch: no control characters, no backslashes
// (Windows separators are not paths here), no leading/trailing whitespace
// in a segment (Obsidian/macOS both mangle those).
const BAD_CHARS = /[\x00-\x1f\x7f\\]/;

/**
 * §4.7 protected paths — the user's hand only. The set is no longer a list
 * of filenames: since the 2026-09-17 layout it is a PLACE. Everything under
 * `.metistry/` defines how the system behaves, except `.metistry/state/`,
 * which is derived; plus the two root files (`CLAUDE.md`, `README.md`).
 * Stated once in core (isProtectedPath) and enforced here.
 */
export const PROTECTED_ROOT = INSTANCE_LAYOUT.metistryDir;
export { PROTECTED_ROOT_FILES };

/** Never writable by anyone through the bridge: git's own state and the schema dir. */
const NEVER_WRITABLE_SEGMENTS = new Set([".git"]);
const NEVER_WRITABLE_PREFIXES = [INSTANCE_LAYOUT.instanceMigrationsDir];

/**
 * Root names whose casing the bridge pins. On a case-insensitive filesystem
 * `inbox/x.md` and `Inbox/x.md` are the same file; on a Linux container they
 * are two. The general sibling/realpath checks in `confine` catch a collision
 * with something that EXISTS — this catches the first write, before the
 * directory is there to collide with.
 */
const PINNED_ROOTS = new Map<string, string>(
  [...NON_VAULT_ROOTS, INSTANCE_LAYOUT.inboxDir, ...PROTECTED_ROOT_FILES].map((n) => [n.toLowerCase(), n]),
);

export const PRINCIPAL_RE = /^[a-z][a-z0-9-]{0,39}$/;
/** The one principal allowed to change how the system behaves (§4.7). */
export const USER_PRINCIPAL = "user";

// ---- the caller's authority, which comes from the CREDENTIAL ----------------
//
// `intent.principal` is a field in the request body, and a body is written by
// whoever is calling. Until 2026-09-20 it was also the whole of the §4.7
// check: a caller that wrote `"principal": "user"` got the user's authority
// over `.metistry/`, so every holder of the one shared bearer — the console,
// which multiplexes every agent on this install, as much as the owner's CLI —
// COULD rewrite `rules.yaml`, an agent definition, a named query or
// `CLAUDE.md`. Nothing did. That is not the same sentence as nothing can
// (owner's ruling, 2026-09-20).
//
// So the bridge now reads two things per mutation, and only one of them comes
// from the body:
//
//   the CREDENTIAL says what this caller IS      → CallerClass
//   the BODY says whose name the commit is in    → intent.principal
//
// The second is attribution and is bounded by the first; the first is
// authority and cannot be spoken. `docs/ops/auth.md` states the rule.

/** Which bearer a request presented, and therefore what it may do. */
export type CallerClass =
  /** `METISTRY_BRIDGE_TOKEN_RECONCILER_USER` — the local owner's hand: the CLI's protected-path writer (`metistry update`, `deployment set-shape`, …). */
  | "owner"
  /** `METISTRY_BRIDGE_TOKEN_RECONCILER` — the console, and everything it fronts: the assistant's `knowledge_write`, captures, artifacts, routines. */
  | "console";

export interface CallerAuthority {
  /** The `intent.principal` values this credential may claim. `"any"` = the multiplexer's whole range — the console stamps the principal from ITS own authenticated caller. */
  principals: "any" | readonly string[];
  /** The §4.7 protected paths this credential may write: `"all"`, or an enumerated set (possibly empty). */
  protectedPaths: "all" | readonly string[];
}

/**
 * The whole authority table, in one place a reviewer can read in ten seconds.
 *
 * **owner** — minted for the CLI alone and deliberately kept out of the
 * console's environment (`consoleEnv`'s denylist, packages/cli/src/deployment.ts).
 * It may claim `user` and nothing else: a leaked owner bearer must not be able
 * to forge an agent into the git record either.
 *
 * **console** — may claim any principal, because it IS the multiplexer: it
 * writes as `user` for the owner's own click (a capture, an artifact version,
 * a comment), as `assistant`, and as `agent:<id>` for a crew. What it may not
 * do is change how the system behaves — except on exactly TWO paths, which
 * are the two owner-authenticated doors the console already ships (invariant
 * 10: a closed, enumerated set, each one a product change to add):
 *
 *   `.metistry/assistant-prompt.md` — §4.10 self-modification. The owner
 *   allows an `improvement` proposal in triage and the console appends the
 *   suggested section to the prompt overlay as `user`
 *   (apps/console/src/prompt-overlay.ts).
 *
 *   `.metistry/compute.yaml` — the Compute pane's two writes,
 *   `POST /api/compute/assign` and `/budget`, gated on the `user` principal
 *   and calling the SAME function `metistry compute` calls
 *   (apps/console/src/compute-routes.ts). Without this the phone could see
 *   what a turn cost and could not move it to a cheaper model, which is the
 *   gap that route exists to close.
 *
 * Both are listed HERE rather than left to the console's restraint, which is
 * the entire point: the bridge is incapable of the other twenty-odd protected
 * paths — `identity.yaml`, `rules.yaml`, `deployment.yaml`, `metistry.lock`,
 * `queries/`, `agents/`, `routines/`, `targets/`, `extensions/`, `CLAUDE.md`,
 * `README.md` — no matter what the console asks for or claims to be. Moving
 * either door to the CLI would shrink this list; nothing may grow it without
 * a product change landing in this table.
 *
 * The legacy spellings (`assistant-prompt.md` / `compute.yaml` at the
 * instance root, on an instance that has not run `metistry migrate-layout`)
 * are deliberately NOT here: `metistry update` refuses to carry a legacy
 * instance past 0.8.x, and both callers write the flat spelling.
 */
export const CALLER_AUTHORITY: Readonly<Record<CallerClass, CallerAuthority>> = Object.freeze({
  owner: { principals: [USER_PRINCIPAL], protectedPaths: "all" },
  console: { principals: "any", protectedPaths: [INSTANCE_LAYOUT.assistantPrompt, INSTANCE_LAYOUT.compute] },
});

/** May this credential commit in that principal's name? */
export function mayClaim(caller: CallerClass, principal: string): boolean {
  const allowed = CALLER_AUTHORITY[caller].principals;
  return allowed === "any" || allowed.includes(principal);
}

/** Syntactic check — no filesystem. Returns the segments or a refusal. */
export function parseVaultPath(input: unknown): { ok: true; segments: string[]; rel: string } | { ok: false; code: PathRefusal } {
  if (typeof input !== "string" || input.length === 0 || input.length > MAX_PATH) return { ok: false, code: "invalid_request" };
  if (BAD_CHARS.test(input)) return { ok: false, code: "invalid_request" };
  if (input.startsWith("/") || input.startsWith("~")) return { ok: false, code: "invalid_request" }; // absolute / home
  if (/^[A-Za-z]:/.test(input)) return { ok: false, code: "invalid_request" }; // drive letter
  const segments = input.split("/");
  for (const s of segments) {
    if (s === "" || s === "." || s === "..") return { ok: false, code: "invalid_request" };
    if (s.length > MAX_SEGMENT || s !== s.trim()) return { ok: false, code: "invalid_request" };
    if (NEVER_WRITABLE_SEGMENTS.has(s.toLowerCase())) return { ok: false, code: "forbidden" };
  }
  // Casing rule (CLAUDE.md), now at the ROOT: the instance directory is the
  // vault, so `Inbox`, `Artifacts` and `.metistry` are spelled exactly that
  // way or not at all.
  const first = segments[0]!;
  const pinned = PINNED_ROOTS.get(first.toLowerCase());
  if (pinned !== undefined && pinned !== first) return { ok: false, code: "invalid_request" };
  const rel = segments.join("/");
  if (NEVER_WRITABLE_PREFIXES.some((p) => rel === p || rel.startsWith(`${p}/`))) return { ok: false, code: "forbidden" };
  return { ok: true, segments, rel };
}

/** True iff `rel` is in the §4.7 protected set. One rule, stated in core. */
export function isProtected(rel: string): boolean {
  return isProtectedPath(rel);
}

/**
 * Confine a request path to the repo working tree. Beyond the syntactic
 * rules: every EXISTING component is lstat'ed and must not be a symlink,
 * and the realpath of the existing prefix must equal its nominal path —
 * which also catches a case-mismatched prefix on a case-insensitive
 * filesystem (`areas/…` when `Areas/` exists).
 */
export async function confine(repoRoot: string, input: unknown): Promise<{ ok: true; path: Confined } | { ok: false; code: PathRefusal }> {
  const parsed = parseVaultPath(input);
  if (!parsed.ok) return parsed;
  const root = await realpath(repoRoot);
  let cur = root;
  let existingDepth = 0;
  for (const seg of parsed.segments) {
    const next = join(cur, seg);
    let st;
    try {
      st = await lstat(next);
    } catch {
      // The rest does not exist yet — fine for a write, the caller decides.
      // But a sibling that differs only by case would fork the tree on a
      // case-sensitive fs (Linux container) and silently merge on a
      // case-insensitive one (macOS): refuse on both, by rule not by fs.
      const siblings = await readdir(cur).catch(() => [] as string[]);
      if (siblings.some((e) => e !== seg && e.toLowerCase() === seg.toLowerCase())) return { ok: false, code: "invalid_request" };
      break;
    }
    if (st.isSymbolicLink()) return { ok: false, code: "forbidden" };
    cur = next;
    existingDepth++;
  }
  // exact-case existence check on the existing prefix
  if (existingDepth > 0) {
    const real = await realpath(cur);
    // differs only by case → a casing error; differs otherwise → something escaped
    if (real !== cur) return { ok: false, code: real.toLowerCase() === cur.toLowerCase() ? "invalid_request" : "forbidden" };
  }
  const abs = join(root, ...parsed.segments);
  if (!abs.startsWith(root + sep)) return { ok: false, code: "forbidden" };
  return { ok: true, path: { rel: parsed.rel, abs, segments: parsed.segments } };
}

/**
 * Write authorization on a confined path: the caller's authority AND the
 * claimed principal, never one without the other.
 *
 * A protected path needs both halves — the commit still has to be in the
 * user's name (§4.7, so history reads honestly), and the credential still has
 * to be one that may write that path. The never-writable set (`.git`,
 * `instance-migrations/`) is refused for everyone before this is reached.
 *
 * `Me/` and the user's own journal (`isUserOwnedPath`, core) get the same
 * treatment as a protected path, one step down: not the machinery, so any
 * `principal` may still CLAIM them, but only `user` may WRITE them, whatever
 * `caller` is asking on whose behalf. This is the other half of the rule
 * `mayKnowledge`'s `write` door states for `knowledge_write` — a routine's
 * own commit (`plan-tomorrow`, the fold's routine half) reaches the vault
 * through this function directly, never through `may()`, so the tool-level
 * refusal alone would have left this door open.
 */
export function writeAllowed(rel: string, principal: string, caller: CallerClass): boolean {
  if (!mayClaim(caller, principal)) return false;
  if (isProtected(rel)) {
    if (principal !== USER_PRINCIPAL) return false;
    const allowed = CALLER_AUTHORITY[caller].protectedPaths;
    return allowed === "all" || allowed.includes(rel);
  }
  if (isUserOwnedPath(rel)) return principal === USER_PRINCIPAL;
  return true;
}

// ---- one writer per REGION: the section operation (plan §2.13, C102) --------
//
// `Journal/<date>.md` is the owner's, and `writeAllowed` keeps refusing every
// non-user write to it — whole-file write, delete, rename from or onto it.
// The one exception is a REGION of it, and it is not an exception to that
// function but a second, narrower door beside it: `POST /vault/section`
// replaces the bytes between the section's markers and nothing else, after
// proving the rest of the note is what the caller saw (core's
// `writeNoteSection`). These two tables are that door's whole policy.

/** `Journal/YYYY-MM-DD.md` for a real calendar day — the owner's daily note, and not `Journal/Plan/…` or `Journal/Meetings/…`. */
export function isDailyNotePath(rel: string): boolean {
  const m = new RegExp(`^${JOURNAL_DIR}/(\\d{4})-(\\d{2})-(\\d{2})\\.md$`).exec(rel);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

/** Which notes each section may live in. */
export const SECTION_PATHS: Readonly<Record<NoteSectionName, (rel: string) => boolean>> = Object.freeze({
  day: isDailyNotePath,
});

/**
 * Who may write each section — plan §2.13's writer column, and nobody else:
 * `morning-brief` at 7:00 AM (model-free: the plan, the meetings, the
 * standup's embed) and `user` at Close the Day. Not `assistant`, not an
 * agent, not another routine: "generated prose never enters the owner's own
 * note" is this list, not a sentence in a prompt. A new writer is a product
 * change landing here.
 */
export const SECTION_WRITERS: Readonly<Record<NoteSectionName, readonly string[]>> = Object.freeze({
  day: Object.freeze([USER_PRINCIPAL, "morning-brief"]),
});

/**
 * May this credential, claiming this principal, write this section of this
 * note? The credential bounds the claim exactly as it does for every other
 * mutation (`mayClaim`: the owner bearer is `user` and nothing else); the
 * section's writer list bounds it again; and a protected path is never a
 * section's home whatever the tables above ever say.
 */
export function sectionWriteAllowed(rel: string, section: NoteSectionName, principal: string, caller: CallerClass): boolean {
  if (!mayClaim(caller, principal)) return false;
  if (isProtected(rel)) return false;
  if (!SECTION_PATHS[section](rel)) return false;
  return SECTION_WRITERS[section].includes(principal);
}

export function validPrincipal(p: unknown): p is string {
  return typeof p === "string" && PRINCIPAL_RE.test(p);
}
