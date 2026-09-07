// Vault operations against the working tree. Reads never touch git (so a
// write is visible the instant it lands — C3); history (log/diff) does.
// Every path passes confine() first; every mutation checks the principal's
// authority on the path, then lands on disk atomically and enqueues a
// commit intent with the committer. Nothing here composes a shell command.

import { mkdir, readdir, readFile, realpath, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import type { ErrorCode } from "@foldedspacelabs/metistry-core";
import { Committer } from "./committer.js";
import { Git } from "./git.js";
import { confine, isProtected, validPrincipal, writeAllowed, type Confined } from "./paths.js";
import { basenameTitle, isConflictFile, isMarkdown, parseFrontmatter, sha256 } from "./notes.js";

export interface Intent {
  principal: string;
  message: string;
  group?: string | undefined;
}

export type Outcome<T> = { ok: true; value: T } | { ok: false; code: ErrorCode; message?: string };

export interface VaultConfig {
  maxBytes: number;
}

const SKIP_DIRS = new Set([".git", ".obsidian", ".trash", "node_modules"]);

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
  return { ok: true, value: { principal: i.principal, message: i.message.trim(), group: typeof i.group === "string" ? i.group : undefined } };
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
    const c = await this.confined(path);
    if (!c.ok) return c;
    const cur = await this.current(c.value.abs);
    if (!cur) return fail("not_found");
    return { ok: true, value: { path: c.value.rel, content: cur.bytes.toString("utf8"), sha256: cur.sha256, bytes: cur.bytes.length } };
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

  /** Every regular file under `Knowledge/` as vault-relative paths (symlinks and dot-dirs skipped). */
  async walkKnowledge(): Promise<string[]> {
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
        const r = `${relDir}/${e.name}`;
        if (e.isDirectory()) await walk(join(dir, e.name), r);
        else if (e.isFile()) out.push(r);
      }
    };
    await walk(join(this.root, "Knowledge"), "Knowledge");
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
    for (const rel of await this.walkKnowledge()) {
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
  async write(path: unknown, content: Buffer, intent: Intent, expectedSha?: string): Promise<Outcome<{ path: string; sha256: string; bytes: number; created: boolean }>> {
    const c = await this.confined(path);
    if (!c.ok) return c;
    if (!writeAllowed(c.value.rel, intent.principal)) return fail("forbidden");
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
    this.committer.enqueue({ paths: [c.value.rel], principal: intent.principal, message: intent.message, group: intent.group });
    return { ok: true, value: { path: c.value.rel, sha256: sha256(content), bytes: content.length, created: cur === null } };
  }

  async delete(path: unknown, intent: Intent, expectedSha?: string): Promise<Outcome<{ path: string }>> {
    const c = await this.confined(path);
    if (!c.ok) return c;
    if (!writeAllowed(c.value.rel, intent.principal)) return fail("forbidden");
    const cur = await this.current(c.value.abs);
    if (!cur) return fail("not_found");
    if (expectedSha !== undefined && cur.sha256 !== expectedSha) return fail("conflict");
    await unlink(c.value.abs);
    await pruneEmptyDirs(this.root, dirname(c.value.abs));
    this.committer.enqueue({ paths: [c.value.rel], principal: intent.principal, message: intent.message, group: intent.group });
    return { ok: true, value: { path: c.value.rel } };
  }

  /** git-mv semantics: the move lands on disk; the commit stages both sides so git records a rename. */
  async rename(from: unknown, to: unknown, intent: Intent): Promise<Outcome<{ from: string; to: string }>> {
    const a = await this.confined(from);
    if (!a.ok) return a;
    const b = await this.confined(to);
    if (!b.ok) return b;
    if (!writeAllowed(a.value.rel, intent.principal) || !writeAllowed(b.value.rel, intent.principal)) return fail("forbidden");
    if (isProtected(b.value.rel) && intent.principal !== "user") return fail("forbidden");
    const cur = await this.current(a.value.abs);
    if (!cur) return fail("not_found");
    if (a.value.rel === b.value.rel) return fail("invalid_request", "from and to are the same path");
    if (await this.current(b.value.abs)) return fail("conflict"); // never clobber by rename
    await mkdir(dirname(b.value.abs), { recursive: true });
    await rename(a.value.abs, b.value.abs);
    await pruneEmptyDirs(this.root, dirname(a.value.abs));
    this.committer.enqueue({ paths: [a.value.rel, b.value.rel], principal: intent.principal, message: intent.message, group: intent.group });
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
