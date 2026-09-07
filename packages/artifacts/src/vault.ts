// The vault client contract (plan §6 D5): the shape of the reconciler's
// vault bridge, as this module needs it. Injected — the package never
// touches a filesystem or git itself; the host decides whether that is an
// HTTP call to a reconciler, an in-process fake, or something else.
//
// Every mutation carries a commit intent; `group` is what turns a
// multi-file publish into ONE commit (the reconciler batches by
// (principal, group)). Errors are thrown as VaultError with a core
// ErrorCode so the service can pass them through the uniform envelope.

import { createHash } from "node:crypto";
import type { ErrorCode } from "@foldedspacelabs/metistry-core";

export interface VaultIntent {
  /** Lowercase slug the caller is trusted for — becomes the commit author, stamped by the vault. */
  principal: string;
  message: string;
  /** Batches several writes into one commit; absent, the principal is the group. */
  group?: string | undefined;
}

export interface VaultFile {
  path: string;
  content: Buffer;
  sha256: string;
  bytes: number;
}

export interface VaultEntry {
  path: string;
  kind: "file" | "dir";
  bytes?: number | undefined;
}

export interface VaultLogEntry {
  sha: string;
  author: string;
  date: string;
  subject: string;
}

export interface VaultWriteResult {
  path: string;
  sha256: string;
  bytes: number;
  created: boolean;
}

export interface VaultDiff {
  diff: string;
  from: string;
  to: string;
}

export class VaultError extends Error {
  constructor(
    readonly code: ErrorCode,
    message?: string,
  ) {
    super(message ?? `vault: ${code}`);
  }
}

export interface VaultClient {
  /** Bytes + content hash, or null when the path does not exist. */
  read(path: string): Promise<VaultFile | null>;
  /** Compare-and-swap on `expectedSha256` when given ("" = must not exist). Lands on the working tree at once; committed on the next flush. */
  write(path: string, content: Buffer, intent: VaultIntent, expectedSha256?: string): Promise<VaultWriteResult>;
  /** Remove a path. A path that is already absent is not an error. */
  delete(path: string, intent: VaultIntent): Promise<void>;
  /** Files and directories under a prefix; a missing prefix lists as empty. */
  list(prefix: string, depth?: number): Promise<VaultEntry[]>;
  /** Commit history for a path (or the whole tree when null), newest first. */
  log(path: string | null, limit?: number): Promise<VaultLogEntry[]>;
  /** Unified diff between two revisions; `to` null = the working tree. */
  diff(path: string | null, from: string | null, to: string | null): Promise<VaultDiff>;
  /**
   * Commit the queue now. Optional: the service calls it after every
   * publish so one version is one commit even when two publishes land
   * inside one flush interval (the committer would otherwise fold the
   * second into the first's commit and skip it). Failure is tolerated —
   * the interval flush still lands the commit.
   */
  flush?(): Promise<unknown>;
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// --- in-memory implementation ----------------------------------------------

/**
 * An in-memory vault with the reconciler's semantics, minus git: writes
 * land at once and are queued as intents; `flush()` turns the queue into
 * one pseudo-commit per (principal, group), exactly like the committer,
 * so `log()` and `diff()` behave the way the service expects. For tests
 * and for running the module with no repository at all.
 */
export interface MemoryVault extends VaultClient {
  flush(): Promise<{ commits: Array<{ sha: string; principal: string; group: string; paths: string[] }> }>;
  readonly files: ReadonlyMap<string, Buffer>;
  readonly pending: number;
}

interface PendingIntent {
  paths: string[];
  principal: string;
  message: string;
  group: string;
}

interface Commit {
  sha: string;
  author: string;
  date: string;
  subject: string;
  paths: string[];
  snapshot: Map<string, Buffer>;
}

export function memoryVault(): MemoryVault {
  const files = new Map<string, Buffer>();
  const queue: PendingIntent[] = [];
  const commits: Commit[] = []; // oldest first

  const enqueue = (path: string, intent: VaultIntent) => queue.push({ paths: [path], principal: intent.principal, message: intent.message, group: intent.group ?? intent.principal });
  const under = (path: string, prefix: string | null) => prefix === null || path === prefix || path.startsWith(`${prefix}/`);
  const checkPath = (p: string) => {
    if (!p || p.startsWith("/") || p.split("/").some((s) => s === "" || s === "." || s === ".." || s.toLowerCase() === ".git")) throw new VaultError("invalid_request", "bad path");
  };

  return {
    get files() {
      return files;
    },
    get pending() {
      return queue.length;
    },
    async read(path) {
      checkPath(path);
      const content = files.get(path);
      return content ? { path, content, sha256: sha256Hex(content), bytes: content.length } : null;
    },
    async write(path, content, intent, expectedSha256) {
      checkPath(path);
      const cur = files.get(path);
      if (expectedSha256 !== undefined && (cur ? sha256Hex(cur) : "") !== expectedSha256) throw new VaultError("conflict");
      files.set(path, Buffer.from(content));
      enqueue(path, intent);
      return { path, sha256: sha256Hex(content), bytes: content.length, created: cur === undefined };
    },
    async delete(path, intent) {
      checkPath(path);
      if (!files.has(path)) return;
      files.delete(path);
      enqueue(path, intent);
    },
    async list(prefix, depth = 1) {
      const base = prefix.replace(/\/+$/, "");
      const seen = new Set<string>();
      const out: VaultEntry[] = [];
      for (const [p, c] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
        if (base && !p.startsWith(`${base}/`)) continue;
        const rest = base ? p.slice(base.length + 1) : p;
        const segs = rest.split("/");
        for (let d = 1; d < Math.min(segs.length, depth + 1); d++) {
          const dir = (base ? `${base}/` : "") + segs.slice(0, d).join("/");
          if (!seen.has(dir)) {
            seen.add(dir);
            out.push({ path: dir, kind: "dir" });
          }
        }
        if (segs.length <= depth) out.push({ path: p, kind: "file", bytes: c.length });
      }
      return out;
    },
    async log(path, limit = 20) {
      return [...commits]
        .reverse()
        .filter((c) => c.paths.some((p) => under(p, path)))
        .slice(0, limit)
        .map(({ sha, author, date, subject }) => ({ sha, author, date, subject }));
    },
    async diff(path, from, to) {
      const at = (rev: string | null): Map<string, Buffer> | null => {
        if (rev === null) return files;
        const c = commits.find((x) => x.sha === rev || x.sha.startsWith(rev));
        return c ? c.snapshot : null;
      };
      const a = from === null ? (commits.at(-1)?.snapshot ?? new Map()) : at(from);
      const b = at(to);
      if (!a || !b) throw new VaultError("not_found", "bad revision");
      const lines: string[] = [];
      for (const p of [...new Set([...a.keys(), ...b.keys()])].sort()) {
        if (!under(p, path)) continue;
        const x = a.get(p);
        const y = b.get(p);
        if (x && y && x.equals(y)) continue;
        lines.push(`--- ${x ? `a/${p}` : "/dev/null"}`, `+++ ${y ? `b/${p}` : "/dev/null"}`);
        if (x) for (const l of x.toString("utf8").split("\n")) lines.push(`-${l}`);
        if (y) for (const l of y.toString("utf8").split("\n")) lines.push(`+${l}`);
      }
      return { diff: lines.length ? `${lines.join("\n")}\n` : "", from: from ?? "HEAD", to: to ?? "worktree" };
    },
    async flush() {
      const groups = new Map<string, PendingIntent[]>();
      for (const i of queue.splice(0)) {
        const k = `${i.principal}\0${i.group}`;
        groups.set(k, [...(groups.get(k) ?? []), i]);
      }
      const made: Array<{ sha: string; principal: string; group: string; paths: string[] }> = [];
      for (const intents of groups.values()) {
        const { principal, group } = intents[0]!;
        const paths = [...new Set(intents.flatMap((i) => i.paths))].sort();
        const subject = intents[0]!.message.split("\n")[0]!.slice(0, 200);
        const sha = sha256Hex(`${commits.length}:${principal}:${group}:${paths.join(",")}:${Date.now()}`).slice(0, 40);
        commits.push({ sha, author: `Metistry ${principal}`, date: new Date().toISOString(), subject, paths, snapshot: new Map(files) });
        made.push({ sha, principal, group, paths });
      }
      return { commits: made };
    },
  };
}
