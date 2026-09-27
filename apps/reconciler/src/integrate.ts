// Integrate before pushing (§2.21, T10-3). The owner may commit and push at
// any time — from another clone, on GitHub, in a terminal in this very
// working tree — so a push is never a bare `git push` again. Before every
// push the committer fetches, and this module brings the remote's commits
// into the local branch, by exactly one of:
//
//   * nothing to do — the remote has nothing we lack;
//   * fast-forward — only the remote moved;
//   * rebase — both moved, and every local-only commit is the reconciler's
//     own, a single-parent act that was never published; they are replayed
//     onto the remote so history stays a line of acts;
//   * merge — both moved, and something local is the owner's (or was
//     published, or is itself a merge): their commits are history, and
//     history is never rewritten.
//
// A conflict stops. Nothing is guessed, nothing is overwritten, nothing is
// half-done: the whole result is computed OFF the working tree with
// `git merge-tree --write-tree` and `git commit-tree` (git ≥ 2.38), and a
// conflict is known before anything is touched, so there is never a
// rebase or merge to abort. The working tree then moves in ONE git command
// that refuses rather than overwrite a local change — `merge --ff-only`
// for a fast-forward or a merge commit, `reset --keep` for a rebase — and
// a refusal is reported as the conflict it is ("your uncommitted edit is
// in the way"), never forced.
//
// Nothing here pushes or fetches: the committer owns the network and the
// locks; this module is the pure-git decision and the one tree step.

import { GitError, type Git, type GitAuthor, type GitIdentity } from "./git.js";

export type IntegrateOutcome = "up_to_date" | "fast_forward" | "rebased" | "merged";

/** Why a sync stopped. `diverged`: both sides changed the same lines. `local_changes`: an edit nobody has committed is in the way. `unrelated`: the remote shares no history with this vault. */
export type ConflictReason = "diverged" | "local_changes" | "unrelated";

/** One side's latest commit touching a conflicted path. */
export interface SideCommit {
  sha: string;
  author: string;
  subject: string;
}

export interface IntegrateConflict {
  reason: ConflictReason;
  /** The paths in the way, sorted; at most `MAX_CONFLICT_PATHS`. */
  paths: string[];
  /** How many paths there were before the cap. */
  path_count: number;
  /** Where the two histories last agreed ("" for `unrelated`) — also the episode's identity. */
  base: string;
  local: { sha: string; ahead: number };
  remote: { sha: string; behind: number };
  /** For the first few paths: the latest commit on each side that touched it. */
  sides: Array<{ path: string; local: SideCommit | null; remote: SideCommit | null }>;
}

export type IntegrateResult =
  /** `ahead`: local commits the remote still lacks, after. `behind`: remote commits this brought in. `changed`: the files it changed. */
  | { outcome: IntegrateOutcome; head: string; ahead: number; behind: number; changed: string[] }
  | { outcome: "conflict"; conflict: IntegrateConflict };

export interface IntegrateInput {
  /** The local branch tip, read AFTER the last flush. */
  head: string;
  /** The remote's tip, just fetched. */
  incoming: string;
  /** `<remote>/<branch>`, for messages. */
  remoteRef: string;
  /** The remote-tracking tip BEFORE this fetch: a commit it reaches was published, and is never rebased. Null = no record. */
  published: string | null;
  /** Is this commit the reconciler's own act (its identity, as the committer stamps it)? */
  ours: (c: RawCommit) => boolean;
  /** Who makes a merge commit, and the trailer lines it carries (`Brain-Source: reconciler`). */
  mergeIdentity: GitIdentity;
  mergeTrailers?: string[] | undefined;
}

export const MAX_CONFLICT_PATHS = 50; // limit: fixed — a report names paths; past this it counts them
const MAX_SIDE_DETAIL = 10; // limit: fixed — per-path commit lookups are two git calls each

/** A commit object, parsed: enough to replay it faithfully. */
export interface RawCommit {
  sha: string;
  parents: string[];
  author: GitAuthor;
  committer: GitAuthor;
  message: string;
  /** Headers we cannot reproduce with `commit-tree` (a signature, a non-UTF-8 encoding) — such a commit is merged, never replayed. */
  exotic: boolean;
}

export async function readCommit(git: Git, sha: string): Promise<RawCommit> {
  const raw = await git.run(["cat-file", "commit", sha]);
  const split = raw.indexOf("\n\n");
  const head = split < 0 ? raw : raw.slice(0, split);
  const message = split < 0 ? "" : raw.slice(split + 2);
  const parents: string[] = [];
  let author: GitAuthor | null = null;
  let committer: GitAuthor | null = null;
  let exotic = false;
  for (const line of head.split("\n")) {
    if (line.startsWith("parent ")) parents.push(line.slice(7).trim());
    else if (line.startsWith("author ")) author = person(line.slice(7));
    else if (line.startsWith("committer ")) committer = person(line.slice(10));
    else if (/^(gpgsig|gpgsig-sha256|encoding|mergetag) /.test(line)) exotic = true;
  }
  if (!author || !committer) throw new Error(`commit ${sha} has no author or committer line`);
  return { sha, parents, author, committer, message, exotic };
}

function person(s: string): GitAuthor | null {
  const m = /^(.*) <([^>]*)> (\d+ [+-]\d{4})$/.exec(s.trim());
  return m ? { name: m[1]!, email: m[2]!, date: m[3]! } : null;
}

/** `git merge-tree --write-tree`: the merged tree, or the conflicted paths. Never touches the index or the working tree. */
async function mergeTree(git: Git, ours: string, theirs: string): Promise<{ tree: string; conflicts: string[] | null }> {
  const r = await git.raw(["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", ours, theirs]);
  if (r.code !== 0 && r.code !== 1) throw new GitError(["merge-tree"], r);
  const parts = r.stdout.split("\0").filter(Boolean);
  const tree = parts[0] ?? "";
  if (!/^[0-9a-f]{40,64}$/.test(tree)) throw new GitError(["merge-tree"], r);
  return { tree, conflicts: r.code === 1 ? [...new Set(parts.slice(1))].sort() : null };
}

async function treeOf(git: Git, rev: string): Promise<string> {
  return (await git.run(["rev-parse", "--verify", "-q", `${rev}^{tree}`])).trim();
}

async function commitTree(git: Git, tree: string, parents: string[], message: string, who: { author: GitAuthor; committer: GitIdentity }): Promise<string> {
  const out = await git.run(["commit-tree", tree, ...parents.flatMap((p) => ["-p", p])], { input: message, author: who.author, committer: who.committer });
  return out.trim();
}

/**
 * Replay `commits` (oldest first, each single-parent, a line) onto `onto`,
 * off the working tree. Returns the new tip, or null when one of them does
 * not apply cleanly on its own (the caller merges instead — a merge of the
 * whole is still clean, or it would never have got here).
 *
 * Each step is a cherry-pick: a three-way merge whose base is the commit's
 * PARENT. `merge-tree` picks its base itself (`--merge-base` is git 2.40,
 * and a Debian-based image may carry 2.39), so each step's "ours" is a
 * throwaway scaffold commit whose parents are the previous step's result
 * and the commit just replayed: then the best common ancestor of the
 * scaffold and the next commit is exactly that next commit's parent — for
 * the first step, the fork point itself. The scaffolds are never
 * referenced and git's gc takes them. A commit that changes nothing once
 * replayed (its change is already upstream) is dropped, as `git rebase`
 * drops it.
 */
async function replay(git: Git, commits: RawCommit[], onto: string): Promise<string | null> {
  let tip = onto;
  let scaffold = onto;
  let tipTree = await treeOf(git, onto);
  for (const c of commits) {
    const m = await mergeTree(git, scaffold, c.sha);
    if (m.conflicts) return null;
    scaffold = await commitTree(git, m.tree, [scaffold, c.sha], "integrate scaffold\n", { author: c.committer, committer: c.committer });
    if (m.tree === tipTree) continue; // nothing left of this act once replayed
    const committer: GitIdentity = { name: c.committer.name, email: c.committer.email };
    tip = await commitTree(git, m.tree, [tip], c.message, { author: c.author, committer });
    tipTree = m.tree;
  }
  return tip;
}

async function count(git: Git, args: string[]): Promise<number> {
  return Number((await git.run(["rev-list", "--count", ...args])).trim()) || 0;
}

/** Paths whose content differs between two commits. */
async function changedBetween(git: Git, from: string, to: string): Promise<string[]> {
  const out = await git.run(["diff", "--name-only", "--no-renames", "-z", from, to]);
  return out.split("\0").filter(Boolean).sort();
}

/** Every path the working tree or index holds differently from HEAD, untracked files included — what a tree step must never overwrite. */
async function dirtyPaths(git: Git): Promise<Set<string>> {
  const s = new Set<string>();
  for (const e of await git.status()) {
    if (e.code === "!!") continue;
    s.add(e.path);
    if (e.from) s.add(e.from);
  }
  return s;
}

async function lastTouch(git: Git, range: string, path: string): Promise<SideCommit | null> {
  const r = await git.raw(["log", "-1", "--format=%H%x1f%an%x1f%s", range, "--", path]);
  const line = r.code === 0 ? r.stdout.trim() : "";
  if (!line) return null;
  const [sha = "", author = "", subject = ""] = line.split("\x1f");
  return { sha, author, subject };
}

async function conflictOf(git: Git, reason: ConflictReason, paths: string[], base: string, head: string, incoming: string, ahead: number, behind: number): Promise<IntegrateResult> {
  const sorted = [...new Set(paths)].sort();
  const shown = sorted.slice(0, MAX_CONFLICT_PATHS);
  const sides: IntegrateConflict["sides"] = [];
  for (const p of shown.slice(0, MAX_SIDE_DETAIL)) {
    sides.push({
      path: p,
      local: base ? await lastTouch(git, `${base}..${head}`, p) : null,
      remote: base ? await lastTouch(git, `${base}..${incoming}`, p) : null,
    });
  }
  return {
    outcome: "conflict",
    conflict: { reason, paths: shown, path_count: sorted.length, base, local: { sha: head, ahead }, remote: { sha: incoming, behind }, sides },
  };
}

/**
 * Decide and — unless it conflicts — perform the integration of `incoming`
 * into the current branch. The caller holds the tree (no bridge write lands
 * while this runs) and has flushed its queue.
 */
export async function integrate(git: Git, input: IntegrateInput): Promise<IntegrateResult> {
  const { head, incoming } = input;
  if (head === incoming) return { outcome: "up_to_date", head, ahead: 0, behind: 0, changed: [] };

  const lr = (await git.run(["rev-list", "--left-right", "--count", `${incoming}...${head}`])).trim().split(/\s+/);
  const behind = Number(lr[0]) || 0;
  const ahead = Number(lr[1]) || 0;
  if (behind === 0) return { outcome: "up_to_date", head, ahead, behind: 0, changed: [] };

  const baseR = await git.raw(["merge-base", head, incoming]);
  const base = baseR.code === 0 ? baseR.stdout.trim() : "";
  if (!base) return conflictOf(git, "unrelated", [], "", head, incoming, ahead, behind);

  let target: string;
  let outcome: IntegrateOutcome;
  if (ahead === 0) {
    target = incoming;
    outcome = "fast_forward";
  } else {
    const whole = await mergeTree(git, head, incoming);
    if (whole.conflicts) return conflictOf(git, "diverged", whole.conflicts, base, head, incoming, ahead, behind);

    // Rebase only what was never published and is wholly ours (rule 2).
    const local = (await git.run(["rev-list", "--reverse", "--topo-order", `${incoming}..${head}`])).split("\n").filter(Boolean);
    const commits: RawCommit[] = [];
    for (const sha of local) commits.push(await readCommit(git, sha));
    const unpublished = input.published === null || (await count(git, [head, `^${incoming}`, `^${input.published}`])) === local.length;
    const line = commits.every((c, i) => c.parents.length === 1 && (i === 0 || c.parents[0] === commits[i - 1]!.sha));
    const rebaseable = unpublished && line && commits.every((c) => !c.exotic && input.ours(c));

    const replayed = rebaseable ? await replay(git, commits, incoming) : null;
    if (replayed) {
      target = replayed;
      outcome = "rebased";
    } else {
      const trailers = input.mergeTrailers?.length ? `\n\n${input.mergeTrailers.join("\n")}` : "";
      const message = `Merge ${input.remoteRef}\n\nIntegrate ${behind} commit${behind === 1 ? "" : "s"} from ${input.remoteRef} before pushing ${ahead}.${trailers}\n`;
      target = await commitTree(git, whole.tree, [head, incoming], message, { author: input.mergeIdentity, committer: input.mergeIdentity });
      outcome = "merged";
    }
  }

  // The one step that touches the working tree. Checked first, so the
  // report can name what is in the way; git checks again and refuses on its
  // own if something moved in between.
  const changed = await changedBetween(git, head, target);
  const dirty = await dirtyPaths(git);
  const blocked = changed.filter((p) => dirty.has(p));
  if (blocked.length > 0) return conflictOf(git, "local_changes", blocked, base, head, incoming, ahead, behind);
  const step = outcome === "rebased" ? ["reset", "-q", "--keep", target] : ["merge", "--ff-only", "-q", target];
  const r = await git.raw(step);
  if (r.code !== 0) {
    // Refused, and nothing moved. An edit that landed between the check and
    // the step is a conflict like any other; anything else (the owner's git
    // holding index.lock) is a failed sync, tried again on the next one.
    const now = await dirtyPaths(git);
    const inWay = changed.filter((p) => now.has(p));
    if (inWay.length > 0) return conflictOf(git, "local_changes", inWay, base, head, incoming, ahead, behind);
    throw new GitError(step, r);
  }
  const after = (await git.head()) ?? target;
  const aheadAfter = await count(git, [after, `^${incoming}`]);
  return { outcome, head: after, ahead: aheadAfter, behind, changed };
}
