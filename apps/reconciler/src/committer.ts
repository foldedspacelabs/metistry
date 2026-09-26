// The sole committer (D5). Writes land on the working tree immediately
// (vault.ts); what lands HERE is the commit intent. The queue is flushed
// on an interval into ONE COMMIT PER ACT (§2.21, T10-1): a write, an agent
// turn, a routine run, or a sweep — so `git log` reads as the list of
// things that happened, not as a list of flush windows. Each commit is
// staged with `git add -A -- <touched paths>` so nothing outside the act
// rides along, authored as `<prefix> <principal>` stamped server-side — a
// request can name a principal, never an author. Push is best-effort on a
// schedule and never blocks a flush.
//
// What makes an act (`actOf`), first match wins:
//   1. an explicit `group` — a caller batching its own writes (an artifact
//      version is one group);
//   2. the turn id — every write one agent reply makes (a host is built per
//      reply, so this is also one routine run's writes);
//   3. the run id — a `runs` row with no turn around it;
//   4. otherwise the write itself: a fresh key per intent.
// Acts of one principal that touched the SAME path in one window are
// coalesced into one commit carrying every act's trailers: the working tree
// only holds the last bytes, and committing them under the first act's
// message while the second act commits nothing would misattribute the edit.
//
// Trailers (provenance for reading history, never an authorization signal):
//   Brain-Source: <principal>
//   Metistry-Run: <runs.id>     one per distinct run, where known
//   Metistry-Turn: <turn id>    one per distinct turn, where known

import { basename } from "node:path";
import { Git, GitError, type GitIdentity } from "./git.js";

export interface CommitIntent {
  paths: string[]; // vault-relative
  principal: string;
  message: string;
  /** The act key (see `actOf`); always set once queued. */
  group?: string | undefined;
  /** `runs.id` of the run that made this write, when the caller knows it. */
  run?: string | undefined;
  /** The turn correlation handle (`runs.meta.turn_id`), when there is one. */
  turn?: string | undefined;
  enqueuedAt: number;
}

export interface CommitterConfig {
  authorPrefix: string; // "Metistry" → author "Metistry assistant"
  authorEmail: string;
  /** The principal trailer's name, e.g. `Brain-Source`. */
  sourceTrailer?: string;
  maxRetries?: number;
}

export interface FlushResult {
  commits: Array<{ sha: string; principal: string; group: string; paths: string[] }>;
  skipped: number; // acts whose paths had nothing staged (write-then-revert)
  failed: number;
}

export interface PushResult {
  attempted: boolean;
  ok: boolean;
  remote?: string;
  error?: string;
}

const MAX_MESSAGE = 4000;  // limit: fixed — a commit message, not a document; git's own conventions bound it

/** The trailer names for the act's ids. Fixed: history is read by tools that grep for them. */
export const RUN_TRAILER = "Metistry-Run";
export const TURN_TRAILER = "Metistry-Turn";

/**
 * What a run or turn id may look like to become a trailer: the turn handle's
 * own shape (mcp-brain `validTurnId`), which a `runs.id` bigint also fits.
 * Anything else — above all a newline, which would let a caller forge a
 * trailer — is refused at the wire (vault.ts `parseIntent`) and dropped here.
 */
export function validActId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

export function authorFor(cfg: CommitterConfig, principal: string): GitIdentity {
  return { name: `${cfg.authorPrefix} ${principal}`, email: cfg.authorEmail };
}

/** The act an intent belongs to, or undefined when it is an act on its own. */
export function actOf(intent: { group?: string | undefined; run?: string | undefined; turn?: string | undefined }): string | undefined {
  if (intent.group) return intent.group;
  if (validActId(intent.turn)) return `turn:${intent.turn}`;
  if (validActId(intent.run)) return `run:${intent.run}`;
  return undefined;
}

/**
 * The sweep's message: the subject names its files — up to two by name,
 * more by count (*Edits from Obsidian: 3 notes*) — and the body lists every
 * path, so the commit says what it holds without opening it.
 */
export function sweepMessage(paths: string[]): string {
  const sorted = [...paths].sort();
  const allNotes = sorted.every((p) => /\.md$/i.test(p));
  const nameOf = (p: string) => (/\.md$/i.test(p) ? basename(p).replace(/\.md$/i, "") : basename(p));
  const n = sorted.length;
  const counted = `${n} ${allNotes ? "note" : "file"}${n === 1 ? "" : "s"}`;
  const named = sorted.map(nameOf).join(", ");
  const subject = `Edits from Obsidian: ${n <= 2 && named.length <= 60 ? named : counted}`;
  return [subject, "", ...sorted.map((p) => `- ${p}`)].join("\n");
}

export class Committer {
  private queue: CommitIntent[] = [];
  private retries = new Map<string, number>();
  private seq = 0;
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

  /** Queue one act's paths. The act key is resolved now, so a retried act keeps it. */
  enqueue(intent: Omit<CommitIntent, "enqueuedAt">): void {
    const group = actOf(intent) ?? `write:${++this.seq}`;
    this.queue.push({
      ...intent,
      group,
      run: validActId(intent.run) ? intent.run : undefined,
      turn: validActId(intent.turn) ? intent.turn : undefined,
      message: intent.message.slice(0, MAX_MESSAGE),
      enqueuedAt: Date.now(),
    });
  }

  /** Queue a sweep of edits made outside the bridge: one `user` act, its subject naming the files. */
  enqueueSweep(paths: string[]): void {
    if (paths.length === 0) return;
    this.enqueue({ paths: [...paths].sort(), principal: "user", group: `sync:${++this.seq}`, message: sweepMessage(paths) });
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

    for (const { key, principal, group, intents } of actsOf(batch)) {
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

/**
 * The batch as acts, in queue order: one per (principal, act key), then acts
 * of the same principal that share a path merged into the earliest (see the
 * header). Exported for the tests.
 */
export function actsOf(batch: CommitIntent[]): Array<{ key: string; principal: string; group: string; intents: CommitIntent[] }> {
  const acts: Array<{ key: string; principal: string; group: string; intents: CommitIntent[] }> = [];
  const byKey = new Map<string, number>();
  const owner = new Map<string, number>(); // `${principal}\0${path}` → index into acts
  for (const i of batch) {
    const group = i.group ?? i.principal;
    const key = `${i.principal}\0${group}`;
    let at = byKey.get(key);
    if (at === undefined) {
      at = acts.length;
      acts.push({ key, principal: i.principal, group, intents: [] });
      byKey.set(key, at);
    }
    acts[at]!.intents.push(i);
  }
  // coalesce: a path claimed by two acts of one principal folds the later act into the earlier
  const parent = acts.map((_, n) => n);
  const find = (n: number): number => (parent[n] === n ? n : (parent[n] = find(parent[n]!)));
  acts.forEach((a, n) => {
    for (const p of a.intents.flatMap((i) => i.paths)) {
      const k = `${a.principal}\0${p}`;
      const prev = owner.get(k);
      if (prev === undefined) owner.set(k, n);
      else {
        const [x, y] = [find(prev), find(n)];
        if (x !== y) parent[Math.max(x, y)] = Math.min(x, y);
      }
    }
  });
  const out: typeof acts = [];
  const rootAt = new Map<number, number>();
  acts.forEach((a, n) => {
    const r = find(n);
    const at = rootAt.get(r);
    if (at === undefined) {
      rootAt.set(r, out.length);
      out.push({ ...a, intents: [...a.intents] });
    } else out[at]!.intents.push(...a.intents);
  });
  return out;
}

/**
 * Subject = the first intent's message; further distinct messages become
 * body bullets; then the trailers — `<sourceTrailer>: <principal>`, one
 * `Metistry-Run:` per distinct run and one `Metistry-Turn:` per distinct turn.
 */
export function composeMessage(intents: CommitIntent[], principal: string, trailer?: string): string {
  const messages = [...new Set(intents.map((i) => i.message.trim()).filter(Boolean))];
  const subject = (messages[0] ?? `Update ${intents.flatMap((i) => i.paths).length} file(s)`).split("\n")[0]!.slice(0, 200);
  const rest = messages.slice(1);
  const firstBody = (messages[0] ?? "").split("\n").slice(1).join("\n").trim();
  const parts = [subject];
  const body = [firstBody, ...rest.map((m) => `- ${m.replace(/\n+/g, " ")}`)].filter(Boolean).join("\n");
  if (body) parts.push("", body);
  const distinct = (xs: Array<string | undefined>) => [...new Set(xs.filter(validActId))];
  const trailers = [
    ...(trailer ? [`${trailer}: ${principal}`] : []),
    ...distinct(intents.map((i) => i.run)).map((r) => `${RUN_TRAILER}: ${r}`),
    ...distinct(intents.map((i) => i.turn)).map((t) => `${TURN_TRAILER}: ${t}`),
  ];
  if (trailers.length) parts.push("", trailers.join("\n"));
  return parts.join("\n");
}
