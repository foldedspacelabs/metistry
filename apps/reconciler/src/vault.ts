// Vault operations against the working tree. Reads never touch git (so a
// write is visible the instant it lands — C3); history (log/diff/show) does.
// Every path passes confine() first; every mutation checks the principal's
// authority on the path, then lands on disk atomically and enqueues a
// commit intent with the committer. Nothing here composes a shell command.

import { mkdir, readdir, readFile, realpath, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { NON_VAULT_ROOTS, isProtectedPath, isVaultPath, sectionMissingMessage, writeNoteSection, type ErrorCode, type NoteSectionName } from "@foldedspacelabs/metistry-core";
import { Committer, RUN_TRAILER, SOURCE_TRAILER, TURN_TRAILER, validActId } from "./committer.js";
import { Git } from "./git.js";
import { SECTION_PATHS, confine, isProtected, sectionWriteAllowed, validPrincipal, writeAllowed, type CallerClass, type Confined } from "./paths.js";
import { basenameTitle, conflictOriginal, isConflictFile, isMarkdown, parseFrontmatter, sha256 } from "./notes.js";

export interface Intent {
  /**
   * Whose name the commit is in — ATTRIBUTION, from the request body. What
   * the caller may DO is its `CallerClass`, which comes from the credential
   * and is passed separately (paths.ts). A body has never been allowed to
   * name the git author; since 2026-09-20 it cannot name the authority
   * either.
   */
  principal: string;
  message: string;
  group?: string | undefined;
  /** `runs.id` of the run behind this write — the `Metistry-Run:` trailer and, with no turn, the act. */
  run?: string | undefined;
  /** The turn handle — the `Metistry-Turn:` trailer and the act (committer.ts `actOf`). */
  turn?: string | undefined;
}

/**
 * `caseOf` rides on a refusal whose path was refused only for its casing
 * while another spelling exists (paths.ts `confine`) — the reader's route
 * turns it into `not_found` with a hint; the reads themselves stay
 * case-exact.
 */
export type Outcome<T> = { ok: true; value: T } | { ok: false; code: ErrorCode; message?: string; caseOf?: string };

// ---- Resolve a conflict (plan §2.11, T2-10) ----------------------------------

/**
 * Which side of a sync conflict the owner keeps: `mine` is the note as it
 * stands, `theirs` is the sync tool's copy — *the Other* in the review
 * (indexer.ts `conflictPayload`). The Mac app's `ConflictSide` spells the same
 * two words.
 */
export const CONFLICT_SIDES = ["mine", "theirs"] as const;
export type ConflictSide = (typeof CONFLICT_SIDES)[number];

/** A conflict as it stands on disk — the four fields the review's `payload.conflict` carries: the copy, the note it is a copy of, and each file's hash (null: not there). */
export interface ConflictState {
  path: string;
  original: string | null;
  sha256: string | null;
  original_sha256: string | null;
}

export interface ConflictSettled {
  /** The note that remains. */
  path: string;
  /** The copy, now gone from the working tree. */
  copy: string;
  kept: ConflictSide;
  /** The remaining note's content hash and size. */
  sha256: string;
  bytes: number;
  /** The commit that put the discarded side into history before it was discarded; null when history already held it (or there was nothing to discard). */
  recorded: string | null;
}

/** A settle, or why not. `current: null` is "not in conflict" — settled already, or never a conflict at all. */
export type ResolveOutcome = Outcome<ConflictSettled> | { ok: false; code: "conflict"; message: string; current: ConflictState | null };

/** Settling a conflict is the owner's act, always (§2.11: "vault bridge as `user`"). */
const OWNER_PRINCIPAL = "user";

export interface VaultConfig {
  maxBytes: number;
}

// Directories the walk never descends into. The vault root is the instance
// directory itself now, so this is the whole "not knowledge" list:
// `.metistry/` (the machinery), git, Obsidian's own config and trash, and
// `Artifacts/` — owner-visible content nothing indexes (core's NON_VAULT_ROOTS).
const SKIP_DIRS = new Set([...NON_VAULT_ROOTS, ".trash", "node_modules"]);

function fail<T>(code: ErrorCode, message?: string): Outcome<T> {
  return message ? { ok: false, code, message } : { ok: false, code };
}

export function parseIntent(input: unknown): Outcome<Intent> {
  if (!input || typeof input !== "object") return fail("invalid_request", "intent required");
  const i = input as Record<string, unknown>;
  if (!validPrincipal(i.principal)) return fail("invalid_request", "intent.principal must be a lowercase slug");
  if (typeof i.message !== "string" || !i.message.trim()) return fail("invalid_request", "intent.message required");
  if (i.group !== undefined && (typeof i.group !== "string" || !/^[a-z0-9][a-z0-9._:-]{0,79}$/i.test(i.group))) {
    return fail("invalid_request", "intent.group must be a short slug");
  }
  // `run` / `turn` become trailer lines, so their shape is the whole defence
  // against a forged trailer: no newline, no colon, nothing but an id. A
  // bigint `runs.id` may arrive as a JSON number.
  const run = typeof i.run === "number" && Number.isSafeInteger(i.run) && i.run > 0 ? String(i.run) : i.run;
  if (run !== undefined && !validActId(run)) return fail("invalid_request", "intent.run must be a runs id");
  if (i.turn !== undefined && !validActId(i.turn)) return fail("invalid_request", "intent.turn must be a turn id");
  return {
    ok: true,
    value: {
      principal: i.principal,
      message: i.message.trim(),
      group: typeof i.group === "string" ? i.group : undefined,
      run: run as string | undefined,
      turn: i.turn as string | undefined,
    },
  };
}

/** What a commit did to one file, as `git log --name-status` letters it. */
export type FileChange = "added" | "modified" | "deleted" | "renamed" | "copied" | "type_changed";

export interface LogEntry {
  sha: string;
  author: string;
  date: string;
  subject: string;
  /** `Brain-Source:` — the principal the committer wrote for; null on a commit it did not make. */
  source: string | null;
  /** `Metistry-Run:` values, one per run coalesced into the commit (T10-1). */
  runs: string[];
  /** `Metistry-Turn:` values, likewise. */
  turns: string[];
  /** With a path only: the file's name at this commit (across a rename, the OLD name). */
  path?: string;
  /** With a path only: what this commit did to it. Absent on a merge that did not change it. */
  change?: FileChange;
}

export interface VersionEntry extends LogEntry {
  path: string;
  content: Buffer;
  sha256: string;
  bytes: number;
}

/** A commit id as a client may name one: hex only, abbreviated or full, sha-1 or sha-256. Anything else — a ref, `HEAD~1`, an option — is not a revision this door takes. */
export const COMMIT_ID = /^[0-9a-fA-F]{7,64}$/;

// A record separator before each commit and a unit separator between its
// fields, the subject LAST so a separator inside it cannot shift a trailer.
const LOG_FORMAT = [
  "%x1e%H",
  "%an",
  "%aI",
  `%(trailers:key=${SOURCE_TRAILER},valueonly,separator=%x2C)`,
  `%(trailers:key=${RUN_TRAILER},valueonly,separator=%x2C)`,
  `%(trailers:key=${TURN_TRAILER},valueonly,separator=%x2C)`,
  "%s",
].join("%x1f");

const CHANGES: Record<string, FileChange> = { A: "added", M: "modified", D: "deleted", R: "renamed", C: "copied", T: "type_changed" };

/**
 * `git log --format=LOG_FORMAT`, with `--follow --name-status -z` when `rel`
 * is set. Newest first, so the name a rename reports as its OLD side is the
 * file's name for every older record until the next rename.
 */
export function parseLog(out: string, rel: string | null): LogEntry[] {
  const entries: LogEntry[] = [];
  let current = rel;
  for (const record of out.split("\x1e")) {
    if (!record.trim()) continue;
    const nul = record.indexOf("\0");
    const header = (nul >= 0 ? record.slice(0, nul) : record).replace(/\n+$/, "");
    const [sha = "", author = "", date = "", source = "", runs = "", turns = "", ...subject] = header.split("\x1f");
    const entry: LogEntry = {
      sha,
      author,
      date,
      subject: subject.join("\x1f"),
      source: firstOf(source, validPrincipal),
      runs: listOf(runs),
      turns: listOf(turns),
    };
    if (rel !== null && current !== null) {
      const tokens = nul >= 0 ? record.slice(nul + 1).replace(/^\n/, "").split("\0").filter(Boolean) : [];
      const letter = tokens[0]?.[0];
      if (letter && CHANGES[letter]) {
        const two = letter === "R" || letter === "C";
        entry.path = (two ? tokens[2] : tokens[1]) ?? current;
        entry.change = CHANGES[letter];
        current = (two ? tokens[1] : entry.path) ?? current;
      } else entry.path = current;
    }
    entries.push(entry);
  }
  return entries;
}

/**
 * Every path one `--name-status -z` record names, old and new sides both —
 * unlike `parseLog`'s own walk, which assumes the single followed file
 * `--follow` restricts a commit to. The whole-tree log carries no pathspec,
 * so one commit's record may hold any number of (status, path) or (status,
 * old, new) groups; this walks all of them rather than just the first.
 * Read-only bookkeeping for `commitsTouchingProtected` below — never exposed
 * on an entry, so it cannot become a second, drifting copy of `parseLog`'s
 * shape.
 */
function nameStatusPaths(tokens: string[]): string[] {
  const paths: string[] = [];
  for (let i = 0; i < tokens.length; ) {
    const letter = tokens[i]?.[0];
    if (!letter || !CHANGES[letter]) {
      i++;
      continue;
    }
    const two = letter === "R" || letter === "C";
    if (tokens[i + 1] !== undefined) paths.push(tokens[i + 1]!);
    if (two && tokens[i + 2] !== undefined) paths.push(tokens[i + 2]!);
    i += two ? 3 : 2;
  }
  return paths;
}

/**
 * The whole-tree log's own narrowing (ruling 1, X-6): every commit sha that
 * touched a §4.7 protected path, from the SAME raw `--name-status -z` output
 * `parseLog` reads — a second pass over it, not a second git call. Only
 * meaningful when `log()` asked for `--name-status` on a whole-tree query,
 * which it does exactly when it is about to need this (a non-owner caller).
 */
function commitsTouchingProtected(raw: string): Set<string> {
  const shas = new Set<string>();
  for (const record of raw.split("\x1e")) {
    if (!record.trim()) continue;
    const nul = record.indexOf("\0");
    if (nul < 0) continue; // no file list at all — nothing changed, or --name-status was not asked for
    const sha = record.slice(0, nul).replace(/\n+$/, "").split("\x1f")[0] ?? "";
    const tokens = record.slice(nul + 1).replace(/^\n/, "").split("\0").filter(Boolean);
    if (sha && nameStatusPaths(tokens).some((p) => isProtectedPath(p))) shas.add(sha);
  }
  return shas;
}

function listOf(raw: string): string[] {
  return [...new Set(raw.split(",").map((v) => v.trim()).filter((v) => validActId(v)))];
}

function firstOf(raw: string, valid: (v: unknown) => boolean): string | null {
  const v = raw.split(",")[0]?.trim() ?? "";
  return v && valid(v) ? v : null;
}

export class Vault {
  constructor(
    public readonly root: string,
    public readonly git: Git,
    public readonly committer: Committer,
    private readonly cfg: VaultConfig,
  ) {}

  private async confined(p: unknown): Promise<Outcome<Confined>> {
    const c = await confine(this.root, p);
    if (c.ok) return { ok: true, value: c.path };
    return c.caseOf !== undefined ? { ok: false, code: c.code, caseOf: c.caseOf } : fail(c.code);
  }

  /** Current bytes + hash, or null if absent. Directories read as "absent". */
  private async current(abs: string): Promise<{ bytes: Buffer; sha256: string } | null> {
    try {
      const st = await stat(abs);
      if (!st.isFile()) return null;
      const bytes = await readFile(abs);
      return { bytes, sha256: sha256(bytes) };
    } catch (err: any) {
      if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return null;
      throw err;
    }
  }

  async read(path: unknown): Promise<Outcome<{ path: string; content: string; sha256: string; bytes: number }>> {
    const r = await this.readBytes(path);
    if (!r.ok) return r;
    return { ok: true, value: { path: r.value.path, content: r.value.content.toString("utf8"), sha256: r.value.sha256, bytes: r.value.bytes } };
  }

  /** The raw bytes (artifacts can be images/PDFs — utf8 would mangle them). */
  async readBytes(path: unknown): Promise<Outcome<{ path: string; content: Buffer; sha256: string; bytes: number }>> {
    const c = await this.confined(path);
    if (!c.ok) return c;
    const cur = await this.current(c.value.abs);
    if (!cur) return fail("not_found");
    return { ok: true, value: { path: c.value.rel, content: cur.bytes, sha256: cur.sha256, bytes: cur.bytes.length } };
  }

  /** Files (and directories) under a prefix, breadth-limited by depth. Prefix "" = repo root. */
  async list(prefix: unknown, depth: number): Promise<Outcome<Array<{ path: string; kind: "file" | "dir"; bytes?: number }>>> {
    let base = this.root;
    let rel = "";
    if (prefix !== undefined && prefix !== "" && prefix !== null) {
      const c = await this.confined(prefix);
      if (!c.ok) return c;
      base = c.value.abs;
      rel = c.value.rel;
    }
    try {
      const st = await stat(base);
      if (!st.isDirectory()) return fail("invalid_request", "prefix is not a directory");
    } catch {
      return fail("not_found");
    }
    const out: Array<{ path: string; kind: "file" | "dir"; bytes?: number }> = [];
    const walk = async (dir: string, relDir: string, d: number) => {
      const entries = await readdir(dir, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const e of entries) {
        if (SKIP_DIRS.has(e.name) || e.isSymbolicLink()) continue;
        const r = relDir ? `${relDir}/${e.name}` : e.name;
        if (e.isDirectory()) {
          out.push({ path: r, kind: "dir" });
          if (d < depth) await walk(join(dir, e.name), r, d + 1);
        } else if (e.isFile()) {
          const s = await stat(join(dir, e.name));
          out.push({ path: r, kind: "file", bytes: s.size });
        }
        if (out.length >= 5000) return;
      }
    };
    await walk(base, rel, 1);
    return { ok: true, value: out };
  }

  /**
   * Every regular file in the vault as instance-relative paths. The walk
   * starts at the instance ROOT — that directory IS the Obsidian vault — and
   * skips `.metistry/`, `.obsidian/`, `.git/`, `Artifacts/` and every other
   * dot-directory (`Inbox/.large/` is captures git does not carry, not notes).
   *
   * `isVaultPath` also drops the root `CLAUDE.md` and `README.md`: the
   * assistant's operating instructions and the repo readme are the user's
   * files, not notes, and indexing them would put them into search and in
   * front of the fold.
   */
  async walkVault(): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string, relDir: string) => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith(".") || e.isSymbolicLink()) continue;
        const r = relDir ? `${relDir}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(join(dir, e.name), r);
        else if (e.isFile() && isVaultPath(r)) out.push(r);
      }
    };
    await walk(this.root, "");
    return out.sort();
  }

  /**
   * Keyword search over settled notes: case-insensitive substring on
   * path, title, and body; `status: draft` notes and conflict files are
   * excluded before matching, so the exclusion is structural.
   */
  async search(q: string, limit: number): Promise<Array<{ path: string; title: string; description: string | null; snippet: string }>> {
    const needle = q.toLowerCase();
    const hits: Array<{ path: string; title: string; description: string | null; snippet: string }> = [];
    if (!needle) return hits;
    for (const rel of await this.walkVault()) {
      if (!isMarkdown(rel) || isConflictFile(rel)) continue;
      const text = await readFile(join(this.root, rel), "utf8");
      const { meta, body } = parseFrontmatter(text);
      if (meta.draft) continue;
      const title = meta.title ?? basenameTitle(rel);
      const hay = body.toLowerCase();
      const idx = hay.indexOf(needle);
      const inTitle = title.toLowerCase().includes(needle) || rel.toLowerCase().includes(needle);
      if (idx < 0 && !inTitle) continue;
      const start = Math.max(0, idx - 80);
      const snippet = idx >= 0 ? body.slice(start, idx + needle.length + 120).replace(/\s+/g, " ").trim() : body.slice(0, 200).replace(/\s+/g, " ").trim();
      hits.push({ path: rel, title, description: meta.description, snippet });
      if (hits.length >= limit) break;
    }
    return hits;
  }

  /**
   * Commit history, newest first — the whole tree, or one path followed
   * across renames. Every entry carries the commit's own provenance trailers
   * (§2.21, T10-1) as the committer wrote them: `source` (`Brain-Source:`),
   * `runs` and `turns`. Provenance for READING history, never authority — an
   * owner's hand-made commit can say anything in a trailer, so a value that is
   * not the shape the committer writes is dropped rather than passed on.
   *
   * With a path, each entry also says what the commit did to the file and
   * what the file was CALLED then (`--follow` crosses a rename, and the old
   * name is the one `show` needs for an older commit).
   *
   * **Narrowed to the owner (ruled 2026-09-27, X-6).** `.metistry/`'s own
   * history is the CLI's, with the owner's hand on it (`show`'s docstring) —
   * this door agreed with that for BYTES from day one but not for the fact
   * that a commit happened, so a whole-tree read or a path-scoped one could
   * still hand any caller a protected commit's subject and trailers. For
   * every caller but `owner`: a path that is itself `isProtectedPath` is
   * `forbidden`, exactly as `show` refuses it (a subject about a file you may
   * not be told exists is the same leak as its bytes); a whole-tree read
   * drops any commit that touched a protected path at all, rather than
   * redacting it — a dropped entry says nothing, a redacted one still says
   * "something happened here". `Artifacts/` is deliberately NOT swept in
   * (unlike `show`'s blanket "not a vault note"): the console's artifacts
   * service resolves a version's commit through exactly this door with its
   * own (non-owner) bearer, and `Artifacts/` was never the confidentiality
   * boundary `.metistry/` is.
   */
  async log(path: unknown, limit: number, caller: CallerClass): Promise<Outcome<LogEntry[]>> {
    const args = ["log", `--max-count=${limit}`, `--format=${LOG_FORMAT}`];
    let rel: string | null = null;
    const owner = caller === "owner";
    if (path !== undefined && path !== "" && path !== null) {
      const c = await this.confined(path);
      if (!c.ok) return c;
      rel = c.value.rel;
      if (!owner && isProtectedPath(rel)) return fail("forbidden", `${rel} is not a vault note — file history is served for notes only`);
      args.push("--follow", "--name-status", "-z", "--", rel);
    } else if (!owner) {
      // Only fetched for the narrowing below — the owner's whole-tree query
      // stays exactly the git call it always was.
      args.push("--name-status", "-z");
    }
    if ((await this.git.head()) === null) return { ok: true, value: [] };
    const raw = await this.git.run(args);
    let entries = parseLog(raw, rel);
    if (rel === null && !owner) {
      const hidden = commitsTouchingProtected(raw);
      entries = entries.filter((e) => !hidden.has(e.sha));
    }
    return { ok: true, value: entries };
  }

  /**
   * One note's bytes at one commit (§2.21 rollback, T10-4): what
   * `GET /api/knowledge/version` shows and what a restore (T10-5) would write
   * back. Read-only, and refused before git runs at all for:
   *
   *   * a path that is not a vault note — `.metistry/` and every other
   *     protected path, `Artifacts/`, a dot-directory, the root
   *     `CLAUDE.md`/`README.md` (`forbidden`). The history of the machinery
   *     is the CLI's, with the owner's hand on it, never this door's;
   *   * a revision that is not a commit id (`invalid_request`) — `HEAD~1`, a
   *     branch name, `--output=…` and every other option-shaped string are
   *     refused by shape, so nothing but hex reaches git's argv.
   *
   * A well-formed id that names no commit, a commit that is not on this
   * branch's history (a fetched-but-unintegrated remote commit is not "the
   * vault's history" yet), or a file absent at that commit is `not_found`.
   * The bytes come from `git cat-file blob`, never `git show`, so no
   * textconv driver the repo or the user's config names can rewrite them.
   */
  async show(path: unknown, rev: unknown): Promise<Outcome<VersionEntry>> {
    const c = await this.confined(path);
    if (!c.ok) return c;
    const rel = c.value.rel;
    if (isProtectedPath(rel) || !isVaultPath(rel)) return fail("forbidden", `${rel} is not a vault note — file history is served for notes only`);
    if (typeof rev !== "string" || !COMMIT_ID.test(rev)) return fail("invalid_request", "bad revision — sha must be a commit id (7 to 64 hex characters)");
    if ((await this.git.head()) === null) return fail("not_found", "the vault has no commits yet");
    const sha = await this.git.commitOf(rev.toLowerCase());
    if (!sha) return fail("not_found", `no commit ${rev}`);
    // On this branch: `HEAD..<sha>` is every commit reachable from <sha> and
    // not from HEAD — empty exactly when <sha> is HEAD or one of its ancestors.
    const beyond = await this.git.raw(["log", "--max-count=1", "--format=%H", `HEAD..${sha}`]);
    if (beyond.code !== 0 || beyond.stdout.trim() !== "") return fail("not_found", `${rev} is not in this vault's history`);
    const entry = await this.blobAt(sha, rel);
    if (!entry) return fail("not_found", `${rel} does not exist at ${sha.slice(0, 12)}`);
    if (entry.size > this.cfg.maxBytes) return fail("invalid_request", `${rel} at ${sha.slice(0, 12)} is ${entry.size} bytes — over the ${this.cfg.maxBytes}-byte cap`);
    const blob = await this.git.rawBytes(["cat-file", "blob", entry.oid]);
    if (blob.code !== 0) throw new Error(`git cat-file blob ${entry.oid} failed (${blob.code}): ${blob.stderr.trim()}`);
    const [meta] = parseLog(await this.git.run(["log", "--max-count=1", `--format=${LOG_FORMAT}`, sha]), null);
    if (!meta) throw new Error(`git log ${sha} returned nothing`);
    return { ok: true, value: { ...meta, path: rel, sha, content: blob.stdout, sha256: sha256(blob.stdout), bytes: blob.stdout.length } };
  }

  /** The regular file at `rel` in `commit`'s tree, or null — a directory, a symlink or a submodule there is no file to show. */
  private async blobAt(commit: string, rel: string): Promise<{ oid: string; size: number } | null> {
    const r = await this.git.raw(["ls-tree", "-l", "-z", commit, "--", rel]);
    if (r.code !== 0) return null;
    for (const line of r.stdout.split("\0")) {
      const tab = line.indexOf("\t");
      if (tab < 0 || line.slice(tab + 1) !== rel) continue;
      const [mode, type, oid, size] = line.slice(0, tab).trim().split(/\s+/);
      if (type !== "blob" || (mode !== "100644" && mode !== "100755") || !oid || !size) return null;
      return { oid, size: Number(size) };
    }
    return null;
  }

  /** Unified diff of a path (or the whole tree) between two revisions; `to` absent = the working tree. */
  async diff(path: unknown, from: string | null, to: string | null): Promise<Outcome<{ diff: string; from: string; to: string }>> {
    const rev = (r: string | null) => (r && /^[A-Za-z0-9_./^~-]{1,120}$/.test(r) && !r.startsWith("-") ? r : null);
    const f = rev(from);
    const t = rev(to);
    if ((from && !f) || (to && !t)) return fail("invalid_request", "bad revision");
    if ((await this.git.head()) === null) return { ok: true, value: { diff: "", from: f ?? "HEAD", to: t ?? "worktree" } };
    const args = ["diff", "--no-color", "--no-ext-diff"];
    args.push(f ?? "HEAD");
    if (t) args.push(t);
    if (path !== undefined && path !== "" && path !== null) {
      const c = await this.confined(path);
      if (!c.ok) return c;
      args.push("--", c.value.rel);
    }
    const r = await this.git.raw(args);
    if (r.code !== 0) return fail("not_found");
    return { ok: true, value: { diff: r.stdout, from: f ?? "HEAD", to: t ?? "worktree" } };
  }

  // Every mutation runs inside the committer's tree gate: never while an
  // integrate is moving the working tree (§2.21), so the compare-and-swap
  // below and git's own "is this file clean?" can never interleave.

  /**
   * Compare-and-swap write: `expectedSha` (hex) must equal the current
   * content hash, or "" to require absence; undefined skips the check.
   * Lands atomically (temp + rename) and enqueues the intent.
   */
  write(path: unknown, content: Buffer, intent: Intent, caller: CallerClass, expectedSha?: string): Promise<Outcome<{ path: string; sha256: string; bytes: number; created: boolean }>> {
    return this.committer.withTree(() => this.writeNow(path, content, intent, caller, expectedSha));
  }

  delete(path: unknown, intent: Intent, caller: CallerClass, expectedSha?: string): Promise<Outcome<{ path: string }>> {
    return this.committer.withTree(() => this.deleteNow(path, intent, caller, expectedSha));
  }

  /** git-mv semantics: the move lands on disk; the commit stages both sides so git records a rename. */
  rename(from: unknown, to: unknown, intent: Intent, caller: CallerClass): Promise<Outcome<{ from: string; to: string }>> {
    return this.committer.withTree(() => this.renameNow(from, to, intent, caller));
  }

  private async writeNow(path: unknown, content: Buffer, intent: Intent, caller: CallerClass, expectedSha?: string): Promise<Outcome<{ path: string; sha256: string; bytes: number; created: boolean }>> {
    const c = await this.confined(path);
    if (!c.ok) return c;
    if (!writeAllowed(c.value.rel, intent.principal, caller)) return fail("forbidden");
    if (content.length > this.cfg.maxBytes) return fail("invalid_request", `content exceeds ${this.cfg.maxBytes} bytes`);
    const cur = await this.current(c.value.abs);
    if (expectedSha !== undefined && (cur?.sha256 ?? "") !== expectedSha) return fail("conflict");
    try {
      const st = await stat(c.value.abs);
      if (st.isDirectory()) return fail("invalid_request", "path is a directory");
    } catch {}
    await mkdir(dirname(c.value.abs), { recursive: true });
    const tmp = join(dirname(c.value.abs), `.${randomBytes(6).toString("hex")}.tmp`);
    await writeFile(tmp, content);
    await rename(tmp, c.value.abs);
    this.committer.enqueue({ paths: [c.value.rel], principal: intent.principal, message: intent.message, group: intent.group, run: intent.run, turn: intent.turn });
    return { ok: true, value: { path: c.value.rel, sha256: sha256(content), bytes: content.length, created: cur === null } };
  }

  /**
   * The section operation (plan §2.13): replace the bytes between a note's
   * section markers and prove every other byte is what the caller saw.
   *
   * Refuses, in this order: a path this section does not live in
   * (`invalid_request`); a principal the credential may not claim or the
   * section does not list (`forbidden` — `sectionWriteAllowed`); a note that
   * does not exist (`not_found` — the section never creates the owner's
   * note, whose template is theirs to apply); a note without exactly one
   * clean pair (`section_missing`); an outer hash that is not
   * `expectedOuterSha` (`conflict`); a body that carries a marker or would
   * hide one (`invalid_request`); and a result over the size cap.
   *
   * The file is re-read after the new bytes are staged and before they are
   * renamed into place: an owner's edit that lands in between is a
   * `conflict`, not an overwrite. (It narrows the window to a rename, which
   * is as close as a filesystem the owner also writes lets anything get.)
   *
   * `act` is the §2.21 act key, as on every other write: the Morning Brief
   * passes its run so the brief file and the section are one commit.
   */
  section(
    path: unknown,
    section: NoteSectionName,
    body: string,
    principal: string,
    caller: CallerClass,
    expectedOuterSha: string,
    act: { run?: string | undefined; turn?: string | undefined } = {},
  ): Promise<Outcome<{ path: string; section: NoteSectionName; sha256: string; bytes: number; outer_sha256: string; appended: boolean }>> {
    return this.committer.withTree(() => this.sectionNow(path, section, body, principal, caller, expectedOuterSha, act));
  }

  private async sectionNow(
    path: unknown,
    section: NoteSectionName,
    body: string,
    principal: string,
    caller: CallerClass,
    expectedOuterSha: string,
    act: { run?: string | undefined; turn?: string | undefined } = {},
  ): Promise<Outcome<{ path: string; section: NoteSectionName; sha256: string; bytes: number; outer_sha256: string; appended: boolean }>> {
    const c = await this.confined(path);
    if (!c.ok) return c;
    const rel = c.value.rel;
    if (!SECTION_PATHS[section](rel)) return fail("invalid_request", `the ${section} section lives only in Journal/<date>.md`);
    if (!sectionWriteAllowed(rel, section, principal, caller)) return fail("forbidden");
    const cur = await this.current(c.value.abs);
    if (!cur) return fail("not_found", `${rel} does not exist — the section operation never creates the owner's note`);
    const out = writeNoteSection(cur.bytes, section, body, expectedOuterSha);
    if (!out.ok) {
      if (out.code === "section_missing") return fail("section_missing", sectionMissingMessage(rel, section, out.reason, out.line));
      if (out.code === "conflict") return fail("conflict", `${rel} changed outside its ${section} section since it was read — read it again`);
      return fail("invalid_request", out.message);
    }
    if (out.content.length > this.cfg.maxBytes) return fail("invalid_request", `the note would exceed ${this.cfg.maxBytes} bytes`);
    const tmp = join(dirname(c.value.abs), `.${randomBytes(6).toString("hex")}.tmp`);
    await writeFile(tmp, out.content);
    const again = await this.current(c.value.abs);
    if (!again || again.sha256 !== cur.sha256) {
      await unlink(tmp).catch(() => {});
      return fail("conflict", `${rel} changed while the section was being written — read it again`);
    }
    await rename(tmp, c.value.abs);
    this.committer.enqueue({ paths: [rel], principal, message: `${out.appended ? "add" : "update"} the ${section} section of ${rel}`, run: act.run, turn: act.turn });
    return { ok: true, value: { path: rel, section, sha256: sha256(out.content), bytes: out.content.length, outer_sha256: out.outerSha256, appended: out.appended } };
  }

  private async deleteNow(path: unknown, intent: Intent, caller: CallerClass, expectedSha?: string): Promise<Outcome<{ path: string }>> {
    const c = await this.confined(path);
    if (!c.ok) return c;
    if (!writeAllowed(c.value.rel, intent.principal, caller)) return fail("forbidden");
    const cur = await this.current(c.value.abs);
    if (!cur) return fail("not_found");
    if (expectedSha !== undefined && cur.sha256 !== expectedSha) return fail("conflict");
    await unlink(c.value.abs);
    await pruneEmptyDirs(this.root, dirname(c.value.abs));
    this.committer.enqueue({ paths: [c.value.rel], principal: intent.principal, message: intent.message, group: intent.group, run: intent.run, turn: intent.turn });
    return { ok: true, value: { path: c.value.rel } };
  }

  /**
   * Settle a sync-conflict copy (plan §2.11 *Resolve a conflict*, T2-10):
   * keep the note as it stands and drop the copy, or take the copy's bytes
   * as the note and drop the copy. Always as `user`; one note changes.
   *
   * Refuses, in this order:
   *
   * - a path that is not knowledge (`forbidden`), or that confine() refuses;
   * - **a path the reconciler does not have in `conflict`** — no index row
   *   saying so (`inConflict`), a name that is not a sync tool's copy, or a
   *   copy that is gone — as `conflict` with `current: null`: settled from
   *   another device, or never a conflict at all. Nothing is written;
   * - a copy that names no note (`invalid_request`), and *Keep Mine* when
   *   there is no mine to keep (`invalid_request`: take the other, or settle
   *   it in Obsidian);
   * - **`expectedSha` that is not the side being discarded as it stands** —
   *   the copy's hash to keep mine, the note's to take the other, `""` when
   *   that side does not exist — as `conflict` with the current hashes. What
   *   the owner gives up must be what the owner saw.
   *
   * **The discarded side stays in history** (C136: that is what makes the
   * act undoable after the client's own ten seconds). A copy was never
   * committed — the sweep leaves conflict copies alone — and a note may
   * carry edits the sweep has not reached, so whichever side is about to be
   * discarded is committed first, as `user`, and the settle is refused
   * (`not_available`, nothing discarded) if history cannot be made to hold it.
   * Then, inside the tree gate, both files are hashed again and the settle is
   * refused `conflict` if either moved, before a byte changes.
   *
   * One settle at a time: two at once for the same copy would each pass the
   * check the other is about to falsify.
   */
  resolveConflict(path: unknown, keep: ConflictSide, expectedSha: string, caller: CallerClass, inConflict: (rel: string) => Promise<boolean>): Promise<ResolveOutcome> {
    const next = this.settling.then(() => this.resolveNow(path, keep, expectedSha, caller, inConflict));
    this.settling = next.catch(() => undefined);
    return next;
  }

  private settling: Promise<unknown> = Promise.resolve();

  private async resolveNow(path: unknown, keep: ConflictSide, expectedSha: string, caller: CallerClass, inConflict: (rel: string) => Promise<boolean>): Promise<ResolveOutcome> {
    const c = await this.confined(path);
    if (!c.ok) return c;
    const copy = c.value.rel;
    if (!isVaultPath(copy)) return fail("forbidden");
    const notInConflict = (why: string): ResolveOutcome => ({ ok: false, code: "conflict", message: `${copy} is not in conflict — ${why}`, current: null });
    if (!isConflictFile(copy) || !(await inConflict(copy))) return notInConflict("it was settled, or it never was");
    const original = conflictOriginal(copy);
    if (original === null) return fail("invalid_request", `${copy} names no note it is a copy of — settle it in Obsidian`);
    const o = await this.confined(original);
    if (!o.ok) return o;
    if (!isVaultPath(original) || !writeAllowed(copy, OWNER_PRINCIPAL, caller) || !writeAllowed(original, OWNER_PRINCIPAL, caller)) return fail("forbidden");

    const read = async () => ({ theirs: await this.current(c.value.abs), mine: await this.current(o.value.abs) });
    const state = (s: { theirs: { sha256: string } | null; mine: { sha256: string } | null }): ConflictState => ({ path: copy, original, sha256: s.theirs?.sha256 ?? null, original_sha256: s.mine?.sha256 ?? null });
    const moved = (message: string, now: Awaited<ReturnType<typeof read>>): ResolveOutcome => ({ ok: false, code: "conflict", message, current: state(now) });

    const before = await read();
    if (!before.theirs) return notInConflict("the copy is gone");
    if (keep === "mine" && !before.mine) return fail("invalid_request", `there is no ${original} to keep — take the other, or settle it in Obsidian`);
    const discardedRel = keep === "mine" ? copy : original;
    const discarded = keep === "mine" ? before.theirs : before.mine;
    if ((discarded?.sha256 ?? "") !== expectedSha) return moved(`${discardedRel} is not what you saw — look at both sides again before discarding one`, before);

    let recorded: string | null = null;
    if (discarded) {
      const r = await this.recordInHistory(discardedRel, original);
      if (!r.ok) return r;
      recorded = r.value;
    }

    return this.committer.withTree(async (): Promise<ResolveOutcome> => {
      const now = await read();
      if (!now.theirs) return notInConflict("the copy is gone");
      if (now.theirs.sha256 !== before.theirs!.sha256 || (now.mine?.sha256 ?? null) !== (before.mine?.sha256 ?? null)) {
        return moved(`${original} or its copy changed while the conflict was being settled — look again`, now);
      }
      const kept = keep === "theirs" ? now.theirs : now.mine!;
      if (keep === "theirs") {
        const tmp = join(dirname(o.value.abs), `.${randomBytes(6).toString("hex")}.tmp`);
        await writeFile(tmp, now.theirs.bytes);
        await rename(tmp, o.value.abs);
      }
      // A copy history never held is just gone: `git add` of a path git has
      // never seen is an error, not an empty change. (Keep Mine recorded it
      // above, so there its removal is always a change to commit.)
      const copyTracked = (await this.git.raw(["ls-files", "--error-unmatch", "--", copy])).code === 0;
      await unlink(c.value.abs);
      this.committer.enqueue({
        paths: [...(keep === "theirs" ? [original] : []), ...(copyTracked ? [copy] : [])],
        principal: OWNER_PRINCIPAL,
        message: `Settle the conflict on ${original}: ${keep === "mine" ? "keep mine" : "take the other"}`,
      });
      return { ok: true, value: { path: original, copy, kept: keep, sha256: kept.sha256, bytes: kept.bytes.length, recorded } };
    });
  }

  /**
   * Make history hold one file exactly as it stands: commit it now, as
   * `user`, through the sole committer — or nothing, when HEAD already has
   * these bytes. Returns the commit (null: nothing to commit). Refused
   * `not_available` when git is mid-merge or mid-rebase (the committer would
   * wait, and the file would be discarded unrecorded) or when the file is
   * still not held afterwards — gitignored, or a flush that failed.
   */
  private async recordInHistory(rel: string, original: string): Promise<Outcome<string | null>> {
    const op = await this.git.operationInProgress();
    if (op) return fail("not_available", `the vault is mid-${op} — finish it, then settle the conflict on ${original}; nothing was discarded`);
    if (await this.heldByHistory(rel)) return { ok: true, value: null };
    this.committer.enqueue({ paths: [rel], principal: OWNER_PRINCIPAL, message: `Record ${rel} before the conflict on ${original} is settled` });
    const flushed = await this.committer.flush();
    if (!(await this.heldByHistory(rel))) {
      return fail("not_available", `${rel} could not be committed${flushed.paused ? ` (the vault is mid-${flushed.paused})` : ""}, so it would not be in history — nothing was discarded; try again`);
    }
    return { ok: true, value: flushed.commits.find((cm) => cm.paths.includes(rel))?.sha ?? null };
  }

  /** Tracked, and the working tree's bytes are HEAD's. */
  private async heldByHistory(rel: string): Promise<boolean> {
    const tracked = await this.git.raw(["ls-files", "--error-unmatch", "--", rel]);
    return tracked.code === 0 && (await this.git.status([rel])).length === 0;
  }

  private async renameNow(from: unknown, to: unknown, intent: Intent, caller: CallerClass): Promise<Outcome<{ from: string; to: string }>> {
    const a = await this.confined(from);
    if (!a.ok) return a;
    const b = await this.confined(to);
    if (!b.ok) return b;
    if (!writeAllowed(a.value.rel, intent.principal, caller) || !writeAllowed(b.value.rel, intent.principal, caller)) return fail("forbidden");
    if (isProtected(b.value.rel) && intent.principal !== "user") return fail("forbidden");
    const cur = await this.current(a.value.abs);
    if (!cur) return fail("not_found");
    if (a.value.rel === b.value.rel) return fail("invalid_request", "from and to are the same path");
    if (await this.current(b.value.abs)) return fail("conflict"); // never clobber by rename
    await mkdir(dirname(b.value.abs), { recursive: true });
    await rename(a.value.abs, b.value.abs);
    await pruneEmptyDirs(this.root, dirname(a.value.abs));
    this.committer.enqueue({ paths: [a.value.rel, b.value.rel], principal: intent.principal, message: intent.message, group: intent.group, run: intent.run, turn: intent.turn });
    return { ok: true, value: { from: a.value.rel, to: b.value.rel } };
  }
}

/** Remove now-empty directories up to (not including) the repo root. */
async function pruneEmptyDirs(repoRoot: string, dir: string): Promise<void> {
  const root = await realpath(repoRoot); // abs paths from confine() are realpath-based
  let cur = dir;
  while (cur.startsWith(root) && cur !== root) {
    try {
      const entries = await readdir(cur);
      if (entries.length > 0) return;
      await rm(cur, { recursive: false });
    } catch {
      return;
    }
    cur = dirname(cur);
  }
}
