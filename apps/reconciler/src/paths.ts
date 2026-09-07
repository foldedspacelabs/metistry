// Path confinement and the §4.7 protected set — the write surface's whole
// policy, enforced here so no caller (assistant, console, a stranger's
// agent) can route around it. Every rule is a test in test/paths.test.ts.

import { lstat, readdir, realpath } from "node:fs/promises";
import { join, sep } from "node:path";

export type PathRefusal =
  | "invalid_request" // malformed / traversal / absolute / bad casing / control chars
  | "forbidden"; // .git, instance-migrations/, symlink component, outside the repo

export interface Confined {
  /** Vault-relative POSIX path exactly as it will be stored. */
  rel: string;
  /** Absolute path inside the repo working tree. */
  abs: string;
  /** Path components. */
  segments: string[];
}

const MAX_PATH = 500;
const MAX_SEGMENT = 255;
// Every path an agent may touch: no control characters, no backslashes
// (Windows separators are not paths here), no leading/trailing whitespace
// in a segment (Obsidian/macOS both mangle those).
const BAD_CHARS = /[\x00-\x1f\x7f\\]/;

/** §4.7 protected paths — the user's hand only. Prefix match on `instance-migrations/`. */
export const PROTECTED_FILES = new Set([
  "identity.yaml",
  "rules.yaml",
  "sources.yaml",
  "deployment.yaml",
  "metistry.lock",
  "CLAUDE.md",
]);
export const PROTECTED_DIRS = ["instance-migrations", "queries", "agents", "routines", "extensions"];

/** Never writable by anyone through the bridge: git's own state and the schema dir. */
const NEVER_WRITABLE_SEGMENTS = new Set([".git"]);
const NEVER_WRITABLE_DIRS = ["instance-migrations"];

export const PRINCIPAL_RE = /^[a-z][a-z0-9-]{0,39}$/;
/** The one principal allowed to change how the system behaves (§4.7). */
export const USER_PRINCIPAL = "user";

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
  // Casing rule (CLAUDE.md): the vault directory is exactly `Knowledge`.
  // macOS would happily write `knowledge/x.md` into `Knowledge/`; a Linux
  // container would then have two directories. Refuse at the tool.
  const first = segments[0]!;
  if (first.toLowerCase() === "knowledge" && first !== "Knowledge") return { ok: false, code: "invalid_request" };
  if (NEVER_WRITABLE_DIRS.includes(first)) return { ok: false, code: "forbidden" };
  return { ok: true, segments, rel: segments.join("/") };
}

/** True iff `rel` is in the §4.7 protected set (files or directory prefixes). */
export function isProtected(rel: string): boolean {
  if (PROTECTED_FILES.has(rel)) return true;
  const first = rel.split("/")[0]!;
  return PROTECTED_DIRS.includes(first);
}

/**
 * Confine a request path to the repo working tree. Beyond the syntactic
 * rules: every EXISTING component is lstat'ed and must not be a symlink,
 * and the realpath of the existing prefix must equal its nominal path —
 * which also catches a case-mismatched prefix on a case-insensitive
 * filesystem (`Knowledge/areas/…` when `Knowledge/Areas/` exists).
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
 * Write authorization for a principal on a confined path. Protected paths
 * are the user's alone; the never-writable set is refused for everyone.
 */
export function writeAllowed(rel: string, principal: string): boolean {
  if (isProtected(rel)) return principal === USER_PRINCIPAL;
  return true;
}

export function validPrincipal(p: unknown): p is string {
  return typeof p === "string" && PRINCIPAL_RE.test(p);
}
