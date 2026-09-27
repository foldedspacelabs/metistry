// The vault's sync policy, scheduled (design-build-plan §2.21, T10-2): WHEN
// the sole committer pushes and pulls, and what `GET /vault/status` reports.
// HOW it syncs — commit and sweep, fetch, integrate, never force, a conflict
// stops — is the committer's (T10-3, committer.ts + integrate.ts); this file
// only decides when to call `committer.push()` and `committer.pull()`.
//
// The policy is `deployment.yaml`'s `vault:` block (core's vault-sync.ts),
// read here and re-read whenever the file changes — `metistry vault
// settings` writes it through this very bridge, so a new policy is in force
// on the next tick with no restart. `METISTRY_PUSH_SCHEDULE` still
// overrides `push` for one release.
//
//   push after_commit   a flush that made commits pushes; commits still
//                       unpushed (a push that failed, or left from before a
//                       restart) are retried on the tick, no more often than
//                       every five minutes, and only while there are some
//   push {every: N}     push every N, when there is something to push
//   push manual         never push; the owner pushes by hand
//   pull {every: N}     fetch and integrate every N (the first tick included)
//
// While a conflict stands (`committer.vault.state = conflict`) nothing is
// pushed on the schedule — rule 3, "stop pushing" — and the pull schedule's
// integrate is what clears it once the owner has resolved it.
//
// The audit rows: the committer records every push, pull and conflict as a
// `vault_sync` run (sync-record.ts); this file adds the one it cannot see —
// `commit`, one row per flush that made commits — so `vault.sync` fires for
// all four states F-1 froze.

import { readFileSync, statSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import {
  finishRun,
  parseDeployment,
  resolveVaultSync,
  startRun,
  VAULT_SYNC_RUN_KIND,
  type ResolvedVaultSync,
  type VaultStatus,
  type VaultSyncAttempt,
  type VaultSyncBlock,
} from "@foldedspacelabs/metistry-core";
import type { Git } from "./git.js";
import type { PushResult } from "./committer.js";

/** How often the scheduler looks at the clock. Every policy interval is ≥ 1m, so this is resolution, not load. */
export const SYNC_TICK_MS = 15_000; // limit: fixed — resolution of the schedule, not a policy
/** `after_commit`'s catch-up: the least time between two pushes the tick starts on its own. */
export const AFTER_COMMIT_RETRY_MS = 5 * 60_000; // limit: fixed — a retry cadence for an unreachable remote, not the owner's policy

export interface VaultConflict {
  paths: string[];
}

/** The committer's acts the schedule drives. Injected, so a test drives the clock and counts the calls. */
export interface SyncOps {
  /** Commit, sweep, fetch, integrate, push (committer.push). */
  push(): Promise<PushResult>;
  /** Commit, sweep, fetch, integrate (committer.pull). */
  pull(): Promise<PushResult>;
  /** Commits the remote has not got, as of the last fetch; null when there is no remote. */
  ahead(): Promise<number | null>;
  /** The conflict that stopped the last integrate, while it stands. */
  conflict(): VaultConflict | null;
}

/** Records a flush that made commits: a `vault_sync` run with `meta.state = commit`. */
export type CommitRecorder = (commits: number) => Promise<void>;

// ---- the policy file -----------------------------------------------------------

export interface PolicyReading {
  policy: ResolvedVaultSync;
  /** The file does not validate: the last good policy (or the default) is the one running. */
  error?: string;
}

/**
 * `deployment.yaml`'s vault block over the D4 overlay (seed, then the
 * instance), re-read when either file's mtime or size moves. A file that
 * stops validating keeps the LAST GOOD policy running and says why — a typo
 * must not turn pushing off, or on.
 */
export class VaultPolicySource {
  private stamp = "";
  private reading: PolicyReading;

  constructor(
    private readonly files: string[],
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    // the variable is checked HERE, once, so a bad one stops the process at
    // start exactly as it always has rather than on a tick
    this.reading = { policy: resolveVaultSync(undefined, env) };
    this.refresh();
  }

  current(): PolicyReading {
    return this.reading;
  }

  /** Re-read when a file changed; returns whether it did. */
  refresh(): boolean {
    const stamp = this.files.map((f) => statStamp(f)).join("|");
    if (stamp === this.stamp) return false;
    this.stamp = stamp;
    try {
      let block: VaultSyncBlock | undefined;
      for (const f of this.files) {
        const text = readOptional(f);
        if (text === undefined) continue;
        const d = parseDeployment(parseYaml(text), f);
        // later files win per key (the instance over the seed)
        if (d.vault) block = { ...block, ...d.vault };
      }
      this.reading = { policy: resolveVaultSync(block, this.env) };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error(`reconciler: the vault sync policy did not load — keeping the last good one: ${error}`);
      this.reading = { policy: this.reading.policy, error };
    }
    return true;
  }
}

function statStamp(f: string): string {
  try {
    const s = statSync(f);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "-";
  }
}

function readOptional(f: string): string | undefined {
  try {
    return readFileSync(f, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

// ---- the schedule ----------------------------------------------------------------

export class SyncScheduler {
  /** The last push that went out or failed — not a sync that found nothing to send. */
  public lastPush: { at: number; result: PushResult } | null = null;
  private lastPushAt: number;
  private lastPullAt = Number.NEGATIVE_INFINITY;
  private ticking: Promise<void> | null = null;

  constructor(
    private readonly policy: () => ResolvedVaultSync,
    private readonly ops: SyncOps,
    private readonly recordCommits: CommitRecorder,
    private readonly now: () => number = Date.now,
  ) {
    // `every` counts from start, as the old interval did; `after_commit`'s
    // catch-up may run on the first tick (commits left from before a restart)
    this.lastPushAt = this.policy().push_every_sec > 0 ? this.now() : Number.NEGATIVE_INFINITY;
  }

  /** After every flush. A flush that made commits is a `commit` event, and under `after_commit` a push. */
  async afterFlush(commits: number): Promise<void> {
    if (commits <= 0) return;
    try {
      await this.recordCommits(commits);
    } catch (err) {
      // the audit row never takes a sync down with it
      console.error("reconciler: could not record the vault commit:", err instanceof Error ? err.message : err);
    }
    if (this.policy().push === "after_commit" && !this.ops.conflict()) await this.pushNow();
  }

  /** One look at the clock. Overlapping ticks collapse into the one already running. */
  tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    this.ticking = this.tickNow().finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }

  private async tickNow(): Promise<void> {
    const p = this.policy();
    if (this.now() - this.lastPullAt >= p.pull_every_sec * 1000) {
      this.lastPullAt = this.now();
      await this.ops.pull();
    }
    // rule 3: a standing conflict stops pushing; the pull above is what clears it
    if (this.ops.conflict()) return;

    if (p.push_every_sec > 0) {
      if (this.now() - this.lastPushAt >= p.push_every_sec * 1000) {
        // the interval restarts whether or not there was anything to send
        this.lastPushAt = this.now();
        if (await this.hasSomethingToPush()) await this.pushNow();
      }
    } else if (p.push === "after_commit") {
      if (this.now() - this.lastPushAt >= AFTER_COMMIT_RETRY_MS && (await this.hasSomethingToPush())) await this.pushNow();
    }
    // `manual`: nothing, ever
  }

  private async hasSomethingToPush(): Promise<boolean> {
    const n = await this.ops.ahead().catch(() => null);
    return n !== null && n > 0;
  }

  private async pushNow(): Promise<void> {
    this.lastPushAt = this.now();
    const r = await this.ops.push();
    if (r.attempted && (r.pushed === true || !r.ok)) this.lastPush = { at: this.now(), result: r };
  }

  /** The interval main.ts runs. */
  start(everyMs = SYNC_TICK_MS): () => void {
    const t = setInterval(() => {
      this.tick().catch((err) => console.error("reconciler: sync tick failed:", err instanceof Error ? err.message : err));
    }, everyMs);
    return () => clearInterval(t);
  }
}

/** A `runs` row per flush that made commits: `kind = vault_sync`, `meta.state = commit` (§2.20's mapper reads exactly that key). */
export function commitRecorder(db: Parameters<typeof startRun>[0]): CommitRecorder {
  return async (commits) => {
    const id = await startRun(db, { component: "reconciler", kind: VAULT_SYNC_RUN_KIND, meta: { state: "commit", commits } });
    await finishRun(db, id, { ok: true });
  };
}

// ---- git reads -----------------------------------------------------------------

/** The remote pushes go to: `origin` when there is one, else the first; null with none. The committer's own choice. */
export async function pushRemote(git: Git): Promise<string | null> {
  const remotes = await git.remotes();
  if (remotes.length === 0) return null;
  return remotes.includes("origin") ? "origin" : remotes[0]!;
}

/** Ahead and behind the remote-tracking ref, as of the last fetch or push. Null/null with no remote. */
export async function aheadBehind(git: Git): Promise<{ remote: string | null; branch: string | null; ahead: number | null; behind: number | null }> {
  const [remote, branch] = await Promise.all([pushRemote(git), git.currentBranch()]);
  if (!remote || !branch) return { remote, branch, ahead: null, behind: null };
  if ((await git.head()) === null) return { remote, branch, ahead: 0, behind: 0 };
  const tracking = `refs/remotes/${remote}/${branch}`;
  if ((await git.commitOf(tracking)) === null) {
    // the remote has never had this branch (or it was never fetched): everything here is unpushed
    const n = await git.raw(["rev-list", "--count", "HEAD"]);
    return { remote, branch, ahead: n.code === 0 ? Number(n.stdout.trim()) : null, behind: 0 };
  }
  const r = await git.raw(["rev-list", "--left-right", "--count", `HEAD...${tracking}`]);
  if (r.code !== 0) return { remote, branch, ahead: null, behind: null };
  const [a, b] = r.stdout.trim().split(/\s+/).map(Number);
  return { remote, branch, ahead: a ?? null, behind: b ?? null };
}

/** Paths git holds unmerged — a merge the OWNER stopped mid-way (the committer never leaves one). */
export async function unmergedPaths(git: Git): Promise<VaultConflict | null> {
  const r = await git.raw(["diff", "--name-only", "--diff-filter=U", "-z"]);
  if (r.code !== 0) return null;
  const paths = r.stdout.split("\0").filter(Boolean).sort();
  return paths.length ? { paths } : null;
}

/** An error line fit to show: the last line, with any `user:secret@` in a URL masked. */
export function lastLine(text: string, fallback: string): string {
  const line = text.trim().split("\n").slice(-1)[0]?.trim() || fallback;
  return line.replace(/(\w+:\/\/)[^/@\s]+@/g, "$1***@").slice(0, 300);
}

async function lastCommit(git: Git): Promise<VaultStatus["last_commit"]> {
  const r = await git.raw(["log", "-1", "--format=%H%x1f%s%x1f%an%x1f%cI%x1f%(trailers:key=Brain-Source,valueonly,separator=%x2C)"]);
  if (r.code !== 0 || !r.stdout.trim()) return null;
  const [sha, subject, author, at, source] = r.stdout.replace(/\n$/, "").split("\x1f");
  // the principal the reconciler stamped (`Brain-Source:`), else the author as git has it — an owner's own commit
  const principal = (source ?? "").split(",")[0]?.trim();
  return { sha: sha ?? "", subject: subject ?? "", author: principal || (author ?? ""), at: new Date(at ?? "").toISOString() };
}

export interface StatusSources {
  git: Git;
  policy: () => PolicyReading;
  lastPush: () => { at: number; result: PushResult } | null;
  lastPull: () => { at: number; result: PushResult } | null;
  /** The conflict the committer's integrate recorded (`committer.vault`). Unmerged paths in the index count too. */
  conflict?: () => VaultConflict | null;
  now?: () => number;
}

function attempt(a: { at: number; result: PushResult } | null): VaultSyncAttempt | null {
  if (!a || !a.result.attempted) return null;
  return { at: new Date(a.at).toISOString(), ok: a.result.ok, remote: a.result.remote ?? null, ...(a.result.error ? { error: lastLine(a.result.error, a.result.error) } : {}) };
}

/** `GET /vault/status`'s body (core's `vaultStatusSchema`). */
export async function readVaultStatus(s: StatusSources): Promise<VaultStatus> {
  const [ab, commit, unmerged] = await Promise.all([aheadBehind(s.git), lastCommit(s.git), unmergedPaths(s.git)]);
  const reading = s.policy();
  const conflict = s.conflict?.() ?? unmerged;
  return {
    branch: ab.branch,
    remote: ab.remote,
    ahead: ab.ahead,
    behind: ab.behind,
    last_commit: commit,
    last_push: attempt(s.lastPush()),
    last_pull: attempt(s.lastPull()),
    conflict: conflict ? { paths: [...conflict.paths] } : null,
    policy: {
      push: reading.policy.push,
      pull: reading.policy.pull,
      ...(reading.policy.push_override !== undefined ? { push_override: reading.policy.push_override } : {}),
      ...(reading.error ? { error: reading.error } : {}),
    },
    as_of: new Date((s.now ?? Date.now)()).toISOString(),
  };
}
