// The sole committer (D5). Writes land on the working tree immediately
// (vault.ts); what lands HERE is the commit intent. The queue is flushed
// on an interval into one commit per (principal, group), staged with
// `git add -A -- <touched paths>` so nothing outside the intent rides
// along, authored as `<prefix> <principal>` stamped server-side — a request
// can name a principal, never an author. Push is best-effort on a schedule
// and never blocks a flush.

import { Git, GitError, type GitIdentity } from "./git.js";

export interface CommitIntent {
  paths: string[]; // vault-relative
  principal: string;
  message: string;
  group?: string | undefined;
  enqueuedAt: number;
}

export interface CommitterConfig {
  authorPrefix: string; // "Metistry" → author "Metistry assistant"
  authorEmail: string;
  /** Extra trailer line per commit, e.g. `Brain-Source`. */
  sourceTrailer?: string;
  maxRetries?: number;
}

export interface FlushResult {
  commits: Array<{ sha: string; principal: string; group: string; paths: string[] }>;
  skipped: number; // groups whose paths had nothing staged (write-then-revert)
  failed: number;
}

export interface PushResult {
  attempted: boolean;
  ok: boolean;
  remote?: string;
  error?: string;
}

const MAX_MESSAGE = 4000;

export function authorFor(cfg: CommitterConfig, principal: string): GitIdentity {
  return { name: `${cfg.authorPrefix} ${principal}`, email: cfg.authorEmail };
}

export class Committer {
  private queue: CommitIntent[] = [];
  private retries = new Map<string, number>();
  private chain: Promise<unknown> = Promise.resolve();
  public lastFlush: { at: number; result: FlushResult } | null = null;
  public lastPush: { at: number; result: PushResult } | null = null;

  constructor(
    public readonly git: Git,
    private readonly cfg: CommitterConfig,
  ) {}

  get depth(): number {
    return this.queue.length;
  }

  /** Paths currently awaiting a commit (the reconcile sweep skips these). */
  pendingPaths(): Set<string> {
    const s = new Set<string>();
    for (const i of this.queue) for (const p of i.paths) s.add(p);
    return s;
  }

  enqueue(intent: Omit<CommitIntent, "enqueuedAt">): void {
    this.queue.push({ ...intent, message: intent.message.slice(0, MAX_MESSAGE), enqueuedAt: Date.now() });
  }

  /** Serialize every git-mutating operation; concurrent flushes would race the index. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  flush(): Promise<FlushResult> {
    return this.exclusive(() => this.flushNow());
  }

  private async flushNow(): Promise<FlushResult> {
    const result: FlushResult = { commits: [], skipped: 0, failed: 0 };
    if (this.queue.length === 0) return result;
    const batch = this.queue;
    this.queue = [];

    // one commit per (principal, group); group defaults to the principal
    const groups = new Map<string, CommitIntent[]>();
    for (const i of batch) {
      const key = `${i.principal}\0${i.group ?? ""}`;
      const list = groups.get(key) ?? [];
      list.push(i);
      groups.set(key, list);
    }

    for (const [key, intents] of groups) {
      const principal = intents[0]!.principal;
      const group = intents[0]!.group ?? principal;
      const paths = [...new Set(intents.flatMap((i) => i.paths))].sort();
      try {
        await this.git.run(["add", "-A", "--", ...paths]);
        const staged = await this.git.raw(["diff", "--cached", "--quiet", "--", ...paths]);
        if (staged.code === 0) {
          result.skipped++; // nothing to commit for this group (write then revert)
          this.retries.delete(key);
          continue;
        }
        const message = composeMessage(intents, principal, this.cfg.sourceTrailer);
        await this.git.run(["commit", "-q", "--only", "-m", message, "--", ...paths], { identity: authorFor(this.cfg, principal) });
        const sha = (await this.git.head()) ?? "";
        result.commits.push({ sha, principal, group, paths });
        this.retries.delete(key);
      } catch (err) {
        // all-or-nothing: unstage this group's paths and retry on the next flush
        result.failed++;
        await this.git.raw(["reset", "-q", "--", ...paths]);
        const n = (this.retries.get(key) ?? 0) + 1;
        const max = this.cfg.maxRetries ?? 5;
        const detail = err instanceof GitError ? err.message : String(err);
        if (n <= max) {
          this.retries.set(key, n);
          this.queue.push(...intents);
          console.error(`reconciler: commit for ${principal}/${group} failed (attempt ${n}/${max}): ${detail}`);
        } else {
          this.retries.delete(key);
          console.error(`reconciler: dropping commit intent for ${principal}/${group} after ${max} failures: ${detail}`);
        }
      }
    }
    this.lastFlush = { at: Date.now(), result };
    return result;
  }

  /** Push the current branch if a remote exists. Never throws; never blocks a flush. */
  push(timeoutMs = 120_000): Promise<PushResult> {
    return this.exclusive(async () => {
      const r = await this.pushNow(timeoutMs);
      this.lastPush = { at: Date.now(), result: r };
      return r;
    });
  }

  private async pushNow(timeoutMs: number): Promise<PushResult> {
    const remotes = await this.git.remotes();
    if (remotes.length === 0) return { attempted: false, ok: true };
    const remote = remotes.includes("origin") ? "origin" : remotes[0]!;
    const branch = await this.git.currentBranch();
    if (!branch) return { attempted: false, ok: true, remote };
    if ((await this.git.head()) === null) return { attempted: false, ok: true, remote };
    const r = await this.git.raw(["push", "-q", remote, `${branch}:${branch}`], { timeoutMs });
    if (r.code !== 0) {
      const error = r.stderr.trim().split("\n").slice(-1)[0] ?? "push failed";
      console.error(`reconciler: push to ${remote} failed: ${error}`);
      return { attempted: true, ok: false, remote, error };
    }
    return { attempted: true, ok: true, remote };
  }
}

/** Subject = the first intent's message; further distinct messages become body bullets. */
export function composeMessage(intents: CommitIntent[], principal: string, trailer?: string): string {
  const messages = [...new Set(intents.map((i) => i.message.trim()).filter(Boolean))];
  const subject = (messages[0] ?? `Update ${intents.flatMap((i) => i.paths).length} file(s)`).split("\n")[0]!.slice(0, 200);
  const rest = messages.slice(1);
  const firstBody = (messages[0] ?? "").split("\n").slice(1).join("\n").trim();
  const parts = [subject];
  const body = [firstBody, ...rest.map((m) => `- ${m.replace(/\n+/g, " ")}`)].filter(Boolean).join("\n");
  if (body) parts.push("", body);
  if (trailer) parts.push("", `${trailer}: ${principal}`);
  return parts.join("\n");
}
