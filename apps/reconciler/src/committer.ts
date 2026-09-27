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
// Sync (§2.21, T10-3): the owner may commit and push at any time, so a push
// is never a bare `git push`. `push()` commits what is pending and sweeps,
// fetches, integrates (integrate.ts: fast-forward, rebase only our own
// never-published acts, else merge — never force), and only then pushes; a
// conflict stops everything but local commits, sets `vault.state =
// conflict` and hands one Needs You report to `hooks.record`. So does a
// remote that changed a protected path (`protected_path_from_remote`):
// refused whole, one report per offending commit. While the
// OWNER has a merge or rebase in progress in the working tree, nothing here
// stages, commits or integrates — the tree is theirs until they finish.
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
import { isVaultPath } from "@foldedspacelabs/metistry-core";
import { Git, GitError, type GitIdentity } from "./git.js";
import { integrate, type IntegrateConflict, type IntegrateOutcome, type RawCommit } from "./integrate.js";
import { isConflictFile } from "./notes.js";

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
  /** Sweep edits made outside the bridge into a `user` commit before integrating (`METISTRY_COMMIT_EXTERNAL_EDITS`). */
  sweepExternalEdits?: boolean;
  /** Fetch-integrate-push rounds when the remote moves between our fetch and our push (default 3). */
  maxPushAttempts?: number;
}

export interface FlushResult {
  commits: Array<{ sha: string; principal: string; group: string; paths: string[] }>;
  skipped: number; // acts whose paths had nothing staged (write-then-revert)
  failed: number;
  /** The owner's operation in progress (`merge`, `rebase`, …): nothing was staged or committed, the queue waits. */
  paused?: string;
}

export interface PushResult {
  attempted: boolean;
  ok: boolean;
  remote?: string;
  error?: string;
  /** How the remote's commits came in, when a fetch ran (§2.21 rule 2). */
  integrated?: IntegrateOutcome | "conflict";
  /** Local commits the remote lacks, after integrating. */
  ahead?: number;
  /** Remote commits brought in. */
  behind?: number;
  /** Files the integrate changed — each is re-walked. */
  changed?: number;
  /** Whether a push went out. */
  pushed?: boolean;
  /** The owner's operation in progress: nothing was fetched, integrated or pushed. */
  paused?: string;
}

/** A conflict, as the vault's sync state carries it and the Needs You report names it. */
export interface SyncConflict extends IntegrateConflict {
  remote_name: string;
  branch: string;
  /** When this episode began — kept across the attempts that find it still there. */
  since: string;
}

/** `vault.state` (§2.21): `conflict` from the first integrate that stops until the next clean one. */
export interface VaultSyncStatus {
  state: "clean" | "conflict";
  conflict: SyncConflict | null;
}

/**
 * One sync act, for the audit trail: a `runs` row of kind `vault_sync`,
 * the `vault.sync {state}` event's source (§2.20). `pull` is an integrate
 * that brought commits in (or a fetch that failed), `push` a push, and
 * `conflict` an integrate that stopped — which also carries the conflict,
 * so the recorder can raise its one report.
 */
export interface SyncRecord {
  state: "pull" | "push" | "conflict";
  ok: boolean;
  error?: string;
  remote: string;
  branch: string;
  meta: Record<string, unknown>;
  conflict?: SyncConflict;
}

export interface SyncHooks {
  /** Record one sync act. Never allowed to fail a sync: errors are logged. */
  record?(e: SyncRecord): Promise<void>;
  /** An integrate changed these files: re-walk them (§2.21 rule 5). */
  integrated?(changed: string[]): void;
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
  public lastPull: { at: number; result: PushResult } | null = null;
  /** `vault.state` — see `VaultSyncStatus`. */
  public vault: VaultSyncStatus = { state: "clean", conflict: null };
  /** Set by main.ts once the index and the database exist. */
  public hooks: SyncHooks = {};

  // The tree gate: bridge mutations run concurrently with each other, and
  // never while an integrate moves the working tree (`holdingTree`) — a
  // write that landed between git's "is this file clean?" and git's write
  // would otherwise be overwritten, and its 200 would be a lie.
  private treeHold: Promise<void> | null = null;
  private mutations = 0;
  private drained: (() => void) | null = null;

  constructor(
    public readonly git: Git,
    private readonly cfg: CommitterConfig,
  ) {}

  /** Run a working-tree mutation (vault.ts write/delete/rename), waiting while an integrate holds the tree. */
  async withTree<T>(fn: () => Promise<T>): Promise<T> {
    while (this.treeHold) await this.treeHold;
    this.mutations++;
    try {
      return await fn();
    } finally {
      this.mutations--;
      if (this.mutations === 0) this.drained?.();
    }
  }

  /** Hold the tree: no new mutation starts, and the ones in flight finish first. */
  private async holdingTree<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    this.treeHold = new Promise<void>((r) => (release = r));
    try {
      if (this.mutations > 0) await new Promise<void>((r) => (this.drained = r));
      return await fn();
    } finally {
      this.drained = null;
      this.treeHold = null;
      release();
    }
  }

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

  /**
   * The sweep itself: every vault path the working tree has changed that no
   * pending intent claims, queued as one `user` act. `.metistry/` is the
   * owner's hand (invariant 2) and never rides along; `Artifacts/` is not
   * knowledge; a sync-conflict copy is flagged by the index, never
   * committed. Returns how many paths were queued. Run by the reconcile
   * walk, and before every integrate (§2.21 rule 2).
   */
  async sweepExternalEdits(): Promise<string[]> {
    const pending = this.pendingPaths();
    const touched = new Set<string>();
    for (const e of await this.git.status(["."])) {
      if (e.code === "!!") continue;
      for (const p of [e.path, e.from]) {
        if (p && isVaultPath(p) && !pending.has(p) && !isConflictFile(p)) touched.add(p);
      }
    }
    const paths = [...touched].sort();
    this.enqueueSweep(paths);
    return paths;
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
    const op = await this.git.operationInProgress();
    if (op) {
      // The owner is mid-merge or mid-rebase: staging a path now would mark
      // their conflict resolved with whatever bytes are on disk. Wait.
      result.paused = op;
      this.lastFlush = { at: Date.now(), result };
      return result;
    }
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

  /**
   * Integrate, then push the current branch if a remote exists (§2.21):
   * commit what is pending and sweep, fetch, integrate, push — never
   * forced. Never throws; never blocks a flush for longer than the network.
   */
  push(timeoutMs = 120_000): Promise<PushResult> {
    return this.exclusive(async () => {
      const r = await this.syncSafely(true, timeoutMs);
      this.lastPush = { at: Date.now(), result: r };
      return r;
    });
  }

  /** Fetch and integrate, without pushing — the pull schedule's act (§2.21 rule 2; scheduled by T10-2's `vault.pull`). */
  pull(timeoutMs = 120_000): Promise<PushResult> {
    return this.exclusive(async () => {
      const r = await this.syncSafely(false, timeoutMs);
      this.lastPull = { at: Date.now(), result: r };
      return r;
    });
  }

  /** A sync never throws: an unexpected git failure (a git too old for `merge-tree --write-tree`, say) is a failed sync with its message, and nothing was moved. */
  private async syncSafely(push: boolean, timeoutMs: number): Promise<PushResult> {
    try {
      return await this.syncNow(push, timeoutMs);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error(`reconciler: sync failed: ${error}`);
      return { attempted: true, ok: false, error };
    }
  }

  /** The reconciler's own commit: author and committer are both the identity it stamps (`<prefix> <principal>`, the configured email). */
  isOurs(c: Pick<RawCommit, "author" | "committer">): boolean {
    const mine = (p: GitIdentity) => p.email === this.cfg.authorEmail && p.name.startsWith(`${this.cfg.authorPrefix} `);
    return mine(c.author) && mine(c.committer);
  }

  private async syncNow(push: boolean, timeoutMs: number): Promise<PushResult> {
    const remotes = await this.git.remotes();
    if (remotes.length === 0) return { attempted: false, ok: true };
    const remote = remotes.includes("origin") ? "origin" : remotes[0]!;
    const branch = await this.git.currentBranch();
    if (!branch) return { attempted: false, ok: true, remote };
    if ((await this.git.head()) === null) return { attempted: false, ok: true, remote };
    const op = await this.git.operationInProgress();
    if (op) return { attempted: false, ok: true, remote, paused: op };

    // 1. what this process owes history comes first: the queue, and the sweep
    if (this.cfg.sweepExternalEdits) await this.sweepExternalEdits();
    await this.flushNow();

    const remoteRef = `${remote}/${branch}`;
    const attempts = Math.max(1, this.cfg.maxPushAttempts ?? 3);
    let behind = 0;
    let changed = 0;
    let integrated: IntegrateOutcome = "up_to_date";
    for (let attempt = 1; ; attempt++) {
      // 2. fetch — the remote-tracking tip BEFORE it says what was already published
      const published = await this.git.commitOf(`refs/remotes/${remote}/${branch}`);
      // --write-fetch-head: FETCH_HEAD is how we read the tip, whatever `fetch.writeFetchHEAD` says
      const f = await this.git.raw(["fetch", "-q", "--no-tags", "--write-fetch-head", remote, `refs/heads/${branch}`], { timeoutMs });
      let incoming: string | null = null;
      if (f.code === 0) incoming = await this.git.commitOf("FETCH_HEAD");
      else if (!/couldn't find remote ref/i.test(f.stderr)) {
        const error = lastLine(f.stderr, "fetch failed");
        console.error(`reconciler: fetch from ${remote} failed: ${error}`);
        await this.record({ state: "pull", ok: false, error, remote, branch, meta: { stage: "fetch" } });
        return { attempted: true, ok: false, remote, error: `fetch: ${error}` };
      }

      // 3. integrate, holding the tree
      let ahead: number;
      if (incoming === null) {
        // the remote has no such branch yet: nothing to bring in, and the push creates it
        ahead = Number((await this.git.run(["rev-list", "--count", "HEAD"])).trim()) || 0;
      } else {
        const at = incoming;
        const res = await this.holdingTree(async () => {
          // the owner may have started a merge of their own while the fetch was on the wire
          const op = await this.git.operationInProgress();
          if (op) return { outcome: "paused" as const, op };
          await this.flushNow(); // writes that landed while the fetch was on the wire
          const head = (await this.git.head())!;
          return integrate(this.git, {
            head,
            incoming: at,
            remoteRef,
            published,
            ours: (c) => this.isOurs(c),
            mergeIdentity: authorFor(this.cfg, "reconciler"),
            mergeTrailers: this.cfg.sourceTrailer ? [`${this.cfg.sourceTrailer}: reconciler`] : [],
          });
        });
        if (res.outcome === "paused") return { attempted: true, ok: true, remote, paused: res.op };
        if (res.outcome === "conflict") {
          const c = res.conflict;
          const since = this.vault.conflict?.base === c.base ? this.vault.conflict.since : new Date().toISOString();
          const conflict: SyncConflict = { ...c, remote_name: remote, branch, since };
          this.vault = { state: "conflict", conflict };
          const error = conflictSummary(conflict);
          console.error(`reconciler: sync with ${remoteRef} stopped: ${error}`);
          await this.record({ state: "conflict", ok: false, error, remote, branch, conflict, meta: { reason: c.reason, paths: c.paths, base: c.base, ahead: c.local.ahead, behind: c.remote.behind, ...(c.commits ? { commits: c.commits.map((x) => x.sha), commit_count: c.commit_count } : {}) } });
          return { attempted: true, ok: false, remote, error: `conflict: ${error}`, integrated: "conflict", ahead: c.local.ahead, behind: c.remote.behind, pushed: false };
        }
        if (this.vault.state === "conflict") console.log(`reconciler: sync with ${remoteRef} is clean again`);
        this.vault = { state: "clean", conflict: null };
        ahead = res.ahead;
        if (res.outcome !== "up_to_date") {
          integrated = res.outcome;
          behind += res.behind;
          changed += res.changed.length;
          await this.record({ state: "pull", ok: true, remote, branch, meta: { integrated: res.outcome, behind: res.behind, ahead: res.ahead, changed: res.changed.length, head: res.head } });
          if (res.changed.length > 0) {
            try {
              this.hooks.integrated?.(res.changed);
            } catch (err) {
              console.error(`reconciler: re-walk after integrate failed to start: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        }
      }

      const base: PushResult = { attempted: true, ok: true, remote, integrated, ahead, behind, changed, pushed: false };
      if (!push || ahead === 0) return base;

      // 4. push — a plain fast-forward of the remote branch; git refuses anything else, and so do we
      const p = await this.git.raw(["push", "-q", remote, `${branch}:${branch}`], { timeoutMs });
      if (p.code === 0) {
        await this.record({ state: "push", ok: true, remote, branch, meta: { pushed: ahead, integrated, behind } });
        return { ...base, ahead: 0, pushed: true };
      }
      const error = lastLine(p.stderr, "push failed");
      // the remote moved between our fetch and our push: fetch and integrate again
      if (attempt < attempts && /\[rejected\]|non-fast-forward|fetch first/.test(p.stderr)) continue;
      console.error(`reconciler: push to ${remote} failed: ${error}`);
      await this.record({ state: "push", ok: false, error, remote, branch, meta: { ahead, attempts: attempt } });
      return { ...base, ok: false, error };
    }
  }

  private async record(e: SyncRecord): Promise<void> {
    if (!this.hooks.record) return;
    try {
      await this.hooks.record(e);
    } catch (err) {
      console.error(`reconciler: recording the vault ${e.state} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function lastLine(stderr: string, fallback: string): string {
  return stderr.trim().split("\n").filter(Boolean).slice(-1)[0] ?? fallback;
}

/** One line for logs, `check()` and the push result: what stopped the sync and where. */
export function conflictSummary(c: Pick<SyncConflict, "reason" | "paths" | "path_count" | "remote_name" | "branch">): string {
  const where = `${c.remote_name}/${c.branch}`;
  const named = c.paths.slice(0, 3).join(", ") + (c.path_count > 3 ? ` and ${c.path_count - 3} more` : "");
  if (c.reason === "unrelated") return `${where} shares no history with this vault`;
  if (c.reason === "local_changes") return `uncommitted edits to ${named} are in the way of ${where}`;
  if (c.reason === "protected_path_from_remote") return `${where} changed protected configuration (${named}), which only your hand may change`;
  return `${named} changed both here and on ${where}`;
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
