// Vault operations against the working tree. Reads never touch git (so a
// write is visible the instant it lands — C3); history (log/diff) does.
// Every path passes confine() first; every mutation checks the principal's
// authority on the path, then lands on disk atomically and enqueues a
// commit intent with the committer. Nothing here composes a shell command.

import { mkdir, readdir, readFile, realpath, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { NON_VAULT_ROOTS, isVaultPath, sectionMissingMessage, writeNoteSection, type ErrorCode, type NoteSectionName } from "@foldedspacelabs/metistry-core";
import { Committer, validActId } from "./committer.js";
import { Git } from "./git.js";
import { SECTION_PATHS, confine, isProtected, sectionWriteAllowed, validPrincipal, writeAllowed, type CallerClass, type Confined } from "./paths.js";
import { basenameTitle, isConflictFile, isMarkdown, parseFrontmatter, sha256 } from "./notes.js";

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

export type Outcome<T> = { ok: true; value: T } | { ok: false; code: ErrorCode; message?: string };

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

export class Vault {
  constructor(
    public readonly root: string,
    public readonly git: Git,
    public readonly committer: Committer,
    private readonly cfg: VaultConfig,
  ) {}

  private async confined(p: unknown): Promise<Outcome<Confined>> {
    const c = await confine(this.root, p);
    return c.ok ? { ok: true, value: c.path } : fail(c.code);
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

  async log(path: unknown, limit: number): Promise<Outcome<Array<{ sha: string; author: string; date: string; subject: string }>>> {
    const args = ["log", `--max-count=${limit}`, "--format=%H%x1f%an%x1f%aI%x1f%s"];
    if (path !== undefined && path !== "" && path !== null) {
      const c = await this.confined(path);
      if (!c.ok) return c;
      args.push("--follow", "--", c.value.rel);
    }
    if ((await this.git.head()) === null) return { ok: true, value: [] };
    const out = await this.git.run(args);
    const value = out
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [sha = "", author = "", date = "", subject = ""] = line.split("\x1f");
        return { sha, author, date, subject };
      });
    return { ok: true, value };
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

  /**
   * Compare-and-swap write: `expectedSha` (hex) must equal the current
   * content hash, or "" to require absence; undefined skips the check.
   * Lands atomically (temp + rename) and enqueues the intent.
   */
  async write(path: unknown, content: Buffer, intent: Intent, caller: CallerClass, expectedSha?: string): Promise<Outcome<{ path: string; sha256: string; bytes: number; created: boolean }>> {
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
   */
  async section(
    path: unknown,
    section: NoteSectionName,
    body: string,
    principal: string,
    caller: CallerClass,
    expectedOuterSha: string,
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
    this.committer.enqueue({ paths: [rel], principal, message: `${out.appended ? "add" : "update"} the ${section} section of ${rel}` });
    return { ok: true, value: { path: rel, section, sha256: sha256(out.content), bytes: out.content.length, outer_sha256: out.outerSha256, appended: out.appended } };
  }

  async delete(path: unknown, intent: Intent, caller: CallerClass, expectedSha?: string): Promise<Outcome<{ path: string }>> {
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

  /** git-mv semantics: the move lands on disk; the commit stages both sides so git records a rename. */
  async rename(from: unknown, to: unknown, intent: Intent, caller: CallerClass): Promise<Outcome<{ from: string; to: string }>> {
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
