// Roll back (design-build-plan §2.21, T10-6). History is preserved, always:
// a rollback is a NEW commit that puts files back — `git revert` for one
// commit, one commit restoring every changed path's content at a date, or
// one file as it was before its last change — and undoing it is reverting
// that commit in turn. Nothing here resets, checks out, rebases or forces;
// every git call goes through git.ts, which refuses those argvs outright
// (`refusedGitArgs`), so this module could not rewrite history if it tried.
//
// The whole result is computed OFF the working tree, the way integrate.ts
// computes a merge: `git merge-tree --write-tree` for the three-way step,
// a scratch index (`GIT_INDEX_FILE`, never the repo's own) for the one
// tree edit, `git commit-tree` for the commit. The working tree then moves
// in ONE git command that refuses rather than overwrite a local change —
// `merge --ff-only` onto the new commit — and an uncommitted edit in the
// way is a conflict, never overwritten.
//
// **Planned against a pinned HEAD.** The preview a Needs You request shows
// is computed against the history as it stood (`head`); Approve replays that
// same change on top of whatever has landed since (a three-way merge whose
// base is the pinned head). A later write to the same lines is a conflict;
// a change set that is no longer the one previewed (`expect`) is refused
// `stale` — the owner approved what they saw, nothing else.
//
// **Configuration is the owner's hand (invariant 2).** Every `.metistry/`
// path, the root `CLAUDE.md` and `README.md` (paths.ts `isProtectedFromRemote`,
// case-folded) is LEFT AS IT IS unless the caller asked `include_config` —
// and the bridge admits that only from the owner-class bearer (server.ts).
// Such paths are reported as `skipped_config`, never silently dropped.
// `.metistry/state/` and `.metistry/instance-migrations/` are never touched
// by anyone: the first is derived and gitignored, the second the schema's.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INSTANCE_LAYOUT } from "@foldedspacelabs/metistry-core";
import { SOURCE_TRAILER, type Committer } from "./committer.js";
import { GitError, type Git, type GitIdentity } from "./git.js";
import { readCommit } from "./integrate.js";
import { confine, isProtectedFromRemote, validPrincipal } from "./paths.js";
import { COMMIT_ID, type Outcome } from "./vault.js";

/** What a rollback undoes: one commit, everything since a moment, or one file (before its last change, or as of a moment). */
export type RevertTarget = { kind: "commit"; commit: string } | { kind: "to"; to: string } | { kind: "file"; file: string; to?: string | undefined };

/** A commit as a preview names it. `author` is the principal the committer stamped (`Brain-Source:`), else git's author. */
export interface RevertCommit {
  sha: string;
  subject: string;
  author: string;
  date: string;
}

export type RevertChange = "added" | "modified" | "deleted";

export interface RevertFile {
  path: string;
  /** What the rollback commit does to it, against the vault as it is now. */
  change: RevertChange;
}

export interface RevertPlan {
  target: RevertTarget;
  /** The history it was planned against — pin it, and Approve reverts exactly this. */
  head: string;
  /** What the files go back to: the reverted commit's parent, the last commit at the moment; null when the file did not exist yet. */
  base: RevertCommit | null;
  /** The commits whose changes it undoes, newest first, at most `MAX_LISTED`. */
  reverts: RevertCommit[];
  revert_count: number;
  /** Every file the rollback commit changes. */
  files: RevertFile[];
  /** Configuration it changes — only ever with `include_config`, from the owner-class bearer. */
  config: string[];
  /** Configuration the history would change, left as it is. */
  skipped_config: string[];
  /** The commit message it writes. */
  message: string;
}

interface Planned extends RevertPlan {
  /** The tree the rollback commit records, and its parent (HEAD now). */
  tree: string;
  parent: string;
}

export interface RevertOptions {
  /** The pinned history (a preview's `head`); absent = HEAD now. */
  head?: string | undefined;
  /** Change configuration too. The bridge admits it from the owner-class bearer only. */
  includeConfig: boolean;
  /** Compute and report, change nothing. */
  dryRun: boolean;
  /** The change set the owner approved: a plan that differs is refused `stale`. */
  expect?: RevertExpect | undefined;
  /** One line the caller adds to the message (*Approved in Needs You, request #62*). */
  note?: string | undefined;
}

export interface RevertExpect {
  files: string[];
  reverts: string[];
  skipped_config: string[];
}

export interface RevertResult extends RevertPlan {
  dry_run: boolean;
  /** The rollback commit, when one was made. */
  sha?: string;
}

export const MAX_LISTED = 200; // limit: fixed — a preview names commits; past this it counts them
const MAX_IN_MESSAGE = 20; // limit: fixed — the commit body lists the first commits it undoes

function fail<T>(code: "invalid_request" | "forbidden" | "not_found" | "conflict", message: string): Outcome<T> {
  return { ok: false, code, message };
}

// ---- the target, as a request names it ---------------------------------------

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MOMENT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** A calendar day (`YYYY-MM-DD`) or an ISO 8601 moment with its offset — nothing else reaches git's argv. */
export function validMoment(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const d = DAY.exec(v);
  if (d) {
    const [y, m, day] = [Number(d[1]), Number(d[2]), Number(d[3])];
    const at = new Date(Date.UTC(y, m - 1, day));
    return at.getUTCFullYear() === y && at.getUTCMonth() === m - 1 && at.getUTCDate() === day;
  }
  return MOMENT.test(v) && !Number.isNaN(Date.parse(v));
}

/** `--before=` for git: a day means the END of that day (the vault as that day left it), in this process's time zone; a moment is itself. */
export function beforeArg(to: string): string {
  // git's date parser reads seconds; a fraction is dropped (a commit's time has none)
  return DAY.test(to) ? `--before=${to} 23:59:59` : `--before=${to.replace(/\.\d{1,3}/, "")}`;
}

/**
 * Exactly one of `commit`, `to` or `file` — or `file` with `to` (one file as
 * of a moment). Shapes only: the commit must be a commit id (never a ref or
 * `HEAD~1`), the moment a day or an ISO timestamp, the file a string (it is
 * confined when planned).
 */
export function parseRevertTarget(body: Record<string, unknown>): Outcome<RevertTarget> {
  const has = (k: string) => body[k] !== undefined && body[k] !== null;
  const usage = "name what to roll back: {commit} | {to: <YYYY-MM-DD or ISO timestamp>} | {file} | {file, to}";
  if (has("commit")) {
    if (has("to") || has("file")) return fail("invalid_request", usage);
    if (typeof body.commit !== "string" || !COMMIT_ID.test(body.commit)) return fail("invalid_request", "commit must be a commit id — 7 to 64 hex characters");
    return { ok: true, value: { kind: "commit", commit: body.commit.toLowerCase() } };
  }
  if (has("to") && !validMoment(body.to)) return fail("invalid_request", "to must be a calendar day (YYYY-MM-DD) or an ISO 8601 timestamp with its offset");
  if (has("file")) {
    if (typeof body.file !== "string" || body.file.trim() === "") return fail("invalid_request", "file must be a vault-relative path");
    return { ok: true, value: { kind: "file", file: body.file, ...(has("to") ? { to: body.to as string } : {}) } };
  }
  if (has("to")) return { ok: true, value: { kind: "to", to: body.to as string } };
  return fail("invalid_request", usage);
}

/** The target as the wire names it back. */
export function targetBody(t: RevertTarget): Record<string, string> {
  if (t.kind === "commit") return { commit: t.commit };
  if (t.kind === "to") return { to: t.to };
  return { file: t.file, ...(t.to ? { to: t.to } : {}) };
}

// ---- which paths are configuration --------------------------------------------

/** Configuration: the owner's hand. Everything under `.metistry/`, the root `CLAUDE.md`/`README.md` — case-folded, as the remote check is. */
export function isConfigPath(rel: string): boolean {
  return isProtectedFromRemote(rel);
}

/** Never changed by a rollback, whoever asks: derived state, the schema's own migrations, git's directory. */
export function isNeverReverted(rel: string): boolean {
  const lower = rel.toLowerCase();
  const under = (dir: string) => lower === dir.toLowerCase() || lower.startsWith(`${dir.toLowerCase()}/`);
  return under(INSTANCE_LAYOUT.stateDir) || under(INSTANCE_LAYOUT.instanceMigrationsDir) || lower.split("/").includes(".git");
}

// ---- git, off the working tree --------------------------------------------------

async function treeOf(git: Git, rev: string): Promise<string> {
  return (await git.run(["rev-parse", "--verify", "-q", `${rev}^{tree}`])).trim();
}

async function isAncestor(git: Git, a: string, b: string): Promise<boolean> {
  return (await git.raw(["merge-base", "--is-ancestor", a, b])).code === 0;
}

/**
 * A three-way merge of two TREES over a base COMMIT, off the working tree.
 * `merge-tree` picks its own base (`--merge-base` is git 2.40, and a
 * Debian-based image may carry 2.39), so each side becomes a throwaway
 * scaffold commit whose one parent is `base` — then their merge base is
 * exactly `base`. The scaffolds are never referenced; git's gc takes them.
 */
async function merge3(git: Git, base: string, ours: string, theirs: string, who: GitIdentity): Promise<{ tree: string; conflicts: string[] | null }> {
  if (ours === theirs) return { tree: ours, conflicts: null };
  const scaffold = async (tree: string) => (await git.run(["commit-tree", tree, "-p", base], { input: "revert scaffold\n", identity: who })).trim();
  const [o, t] = [await scaffold(ours), await scaffold(theirs)];
  const r = await git.raw(["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", o, t]);
  if (r.code !== 0 && r.code !== 1) throw new GitError(["merge-tree"], r);
  const parts = r.stdout.split("\0").filter(Boolean);
  const tree = parts[0] ?? "";
  if (!/^[0-9a-f]{40,64}$/.test(tree)) throw new GitError(["merge-tree"], r);
  return { tree, conflicts: r.code === 1 ? [...new Set(parts.slice(1))].sort() : null };
}

/** The blob at `path` in `rev`, or null (absent, or not a file). */
async function entryAt(git: Git, rev: string, path: string): Promise<{ mode: string; oid: string } | null> {
  const r = await git.raw(["ls-tree", "-z", rev, "--", path]);
  if (r.code !== 0) return null;
  for (const line of r.stdout.split("\0")) {
    const tab = line.indexOf("\t");
    if (tab < 0 || line.slice(tab + 1) !== path) continue;
    const [mode = "", type = "", oid = ""] = line.slice(0, tab).split(" ");
    return type === "blob" ? { mode, oid } : null;
  }
  return null;
}

/**
 * `tree` with each path set to what it is in `from` (removed where `from` is
 * null or has no such file) — in a SCRATCH index under the temp directory,
 * so neither the owner's index nor their working tree is ever touched.
 */
async function withEntries(git: Git, tree: string, entries: Array<{ path: string; from: string | null }>): Promise<string> {
  if (entries.length === 0) return tree;
  const dir = await mkdtemp(join(tmpdir(), "metistry-revert-"));
  const indexFile = join(dir, "index");
  try {
    await git.run(["read-tree", tree], { indexFile });
    const zero = "0".repeat(tree.length);
    const lines: string[] = [];
    for (const e of entries) {
      const at = e.from ? await entryAt(git, e.from, e.path) : null;
      lines.push(at ? `${at.mode} ${at.oid}\t${e.path}` : `0 ${zero}\t${e.path}`);
    }
    await git.run(["update-index", "-z", "--index-info"], { indexFile, input: `${lines.join("\0")}\0` });
    return (await git.run(["write-tree"], { indexFile })).trim();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Every file that differs between two trees, with the destination's mode (`--raw`, no renames: a rename is a delete and an add). */
async function diffTrees(git: Git, from: string, to: string): Promise<Array<{ path: string; status: string; mode: string }>> {
  if (from === to) return [];
  const out = await git.run(["diff-tree", "-r", "--raw", "--no-renames", "-z", from, to]);
  const parts = out.split("\0");
  const rows: Array<{ path: string; status: string; mode: string }> = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = parts[i]!;
    const path = parts[i + 1]!;
    if (!meta.startsWith(":")) break;
    const [, dstMode = "", , , status = ""] = meta.slice(1).split(" ");
    rows.push({ path, status: status.charAt(0), mode: dstMode });
  }
  return rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

const COMMIT_FORMAT = ["%H", "%an", "%aI", `%(trailers:key=${SOURCE_TRAILER},valueonly,separator=%x2C)`, "%s"].join("%x1f");

/** Commits as a preview names them, newest first. */
async function commitsIn(git: Git, range: string[], paths: string[] = []): Promise<{ listed: RevertCommit[]; count: number }> {
  const tail = paths.length ? ["--", ...paths] : [];
  const count = Number((await git.run(["rev-list", "--count", ...range, ...tail])).trim()) || 0;
  if (count === 0) return { listed: [], count };
  const out = await git.run(["log", `--max-count=${MAX_LISTED}`, `--format=%x1e${COMMIT_FORMAT}`, ...range, ...tail]);
  const listed = out
    .split("\x1e")
    .filter((r) => r.trim())
    .map((r) => {
      const [sha = "", an = "", date = "", source = "", ...subject] = r.replace(/\n+$/, "").split("\x1f");
      const principal = source.split(",")[0]?.trim() ?? "";
      return { sha, author: validPrincipal(principal) ? principal : an, date, subject: subject.join("\x1f") };
    });
  return { listed, count };
}

async function commitInfo(git: Git, sha: string): Promise<RevertCommit> {
  return (await commitsIn(git, ["--max-count=1", sha])).listed[0] ?? { sha, subject: "", author: "", date: "" };
}

/** The last commit on the branch's own line at or before a moment, or null. */
async function commitAt(git: Git, head: string, to: string): Promise<string | null> {
  const out = (await git.run(["rev-list", "-1", "--first-parent", beforeArg(to), head])).trim();
  return out || null;
}

// ---- the plan ------------------------------------------------------------------

const CONFIG_HINT = "configuration is rolled back only on the Mac, by the owner's own hand: `metistry vault rollback --include-config`";

/**
 * What the rollback would change, computed without changing anything. Held
 * inside `Committer.holdHistory` by `revert()`, so HEAD cannot move under it.
 */
export async function planRevert(git: Git, root: string, target: RevertTarget, opts: { head?: string | undefined; includeConfig: boolean; scaffold: GitIdentity }): Promise<Outcome<Planned>> {
  const cur = await git.head();
  if (cur === null) return fail("not_found", "the vault has no commits yet — there is nothing to roll back");
  let head = cur;
  if (opts.head !== undefined) {
    const pinned = await git.commitOf(opts.head);
    if (!pinned || !(await isAncestor(git, pinned, cur))) return fail("conflict", "stale: the history this rollback was previewed against is no longer this vault's — ask for the rollback again");
    head = pinned;
  }
  const headTree = await treeOf(git, head);

  // 1. the change, as if HEAD were still `head`
  let theirs: string;
  let base: RevertCommit | null;
  let reverts: { listed: RevertCommit[]; count: number };
  if (target.kind === "commit") {
    const sha = await git.commitOf(target.commit);
    if (!sha || !(await isAncestor(git, sha, head))) return fail("not_found", `${target.commit} is not a commit in this vault's history`);
    const c = await readCommit(git, sha);
    const parent = c.parents[0];
    if (!parent) return fail("invalid_request", "that is the vault's first commit — undoing it would empty the vault; roll back a file, or --to a date after it");
    const m = await merge3(git, sha, headTree, await treeOf(git, parent), opts.scaffold);
    if (m.conflicts) {
      return fail("conflict", `${sha.slice(0, 12)} cannot be undone on its own — later commits changed the same lines of ${m.conflicts.slice(0, 5).join(", ")}${m.conflicts.length > 5 ? ` and ${m.conflicts.length - 5} more` : ""}; roll those files back one at a time, or --to a date`);
    }
    theirs = m.tree;
    base = await commitInfo(git, parent);
    reverts = { listed: [await commitInfo(git, sha)], count: 1 };
  } else if (target.kind === "to") {
    const at = await commitAt(git, head, target.to);
    if (!at) return fail("invalid_request", `nothing in this vault's history is as old as ${target.to}`);
    if (at === head) return fail("invalid_request", `nothing has been committed since ${target.to} — there is nothing to roll back`);
    theirs = await treeOf(git, at);
    base = await commitInfo(git, at);
    reverts = await commitsIn(git, [`${at}..${head}`]);
  } else {
    const c = await confine(root, target.file);
    if (!c.ok) return fail(c.code, c.code === "forbidden" ? `${String(target.file)} is not a path a rollback may change` : "file must be a vault-relative path");
    const rel = c.path.rel;
    if (isNeverReverted(rel)) return fail("forbidden", `${rel} is never rolled back — it is derived, or the schema's`);
    if (isConfigPath(rel) && !opts.includeConfig) return fail("forbidden", `${rel} is configuration — ${CONFIG_HINT}`);
    let from: string | null;
    if (target.to) {
      from = await commitAt(git, head, target.to);
      if (!from) return fail("invalid_request", `nothing in this vault's history is as old as ${target.to}`);
    } else {
      const last = (await git.run(["log", "-1", "--format=%H", head, "--", rel])).trim();
      if (!last) return fail("not_found", `${rel} has no history in this vault`);
      from = (await readCommit(git, last)).parents[0] ?? null;
    }
    theirs = await withEntries(git, headTree, [{ path: rel, from }]);
    base = from ? await commitInfo(git, from) : null;
    reverts = await commitsIn(git, [from ? `${from}..${head}` : head], [rel]);
  }

  // 2. configuration stays as it is unless the owner's own hand asked
  const touched = (await diffTrees(git, headTree, theirs)).map((r) => r.path);
  const configPaths = touched.filter(isConfigPath);
  const skipped = opts.includeConfig ? touched.filter(isNeverReverted) : configPaths;
  theirs = await withEntries(git, theirs, skipped.map((path) => ({ path, from: head })));

  // 3. onto the vault as it is now — the same change, over whatever landed since
  let tree = theirs;
  if (cur !== head) {
    const m = await merge3(git, head, await treeOf(git, cur), theirs, opts.scaffold);
    if (m.conflicts) return fail("conflict", `stale: ${m.conflicts.slice(0, 5).join(", ")} changed after this rollback was previewed — ask for it again`);
    tree = m.tree;
  }
  const rows = await diffTrees(git, await treeOf(git, cur), tree);

  // Defence in depth: whatever the steps above computed, a path this caller
  // may not change is never in the commit.
  const barred = rows.find((r) => isNeverReverted(r.path) || (!opts.includeConfig && isConfigPath(r.path)));
  if (barred) return fail("forbidden", `${barred.path} is configuration — ${CONFIG_HINT}`);
  const odd = rows.find((r) => r.mode === "120000" || r.mode === "160000");
  if (odd) return fail("invalid_request", `${odd.path} would come back as a ${odd.mode === "120000" ? "symbolic link" : "submodule"} — the vault holds files only; restore it by hand`);
  if (rows.length === 0) {
    return fail("invalid_request", skipped.length && !opts.includeConfig ? `nothing to roll back but configuration (${skipped.slice(0, 5).join(", ")}) — ${CONFIG_HINT}` : "nothing to roll back — the vault already has these files as they were");
  }
  const files: RevertFile[] = rows.map((r) => ({ path: r.path, change: r.status === "A" ? "added" : r.status === "D" ? "deleted" : "modified" }));
  const config = opts.includeConfig ? files.map((f) => f.path).filter(isConfigPath) : [];
  const plan: Planned = { target, head, base, reverts: reverts.listed, revert_count: reverts.count, files, config, skipped_config: skipped, message: "", tree, parent: cur };
  return { ok: true, value: plan };
}

/** The rollback commit's message: what it undoes, what it left alone, and the trailer. */
export function revertMessage(p: RevertPlan, note: string | undefined, sourceLine: string | null): string {
  const t = p.target;
  const first = p.reverts[0];
  let subject: string;
  const body: string[] = [];
  if (t.kind === "commit") {
    subject = `Revert "${(first?.subject ?? t.commit).slice(0, 150)}"`;
    body.push(`This reverts commit ${first?.sha ?? t.commit}.`);
  } else {
    subject = t.kind === "to" ? `Roll back to ${t.to}` : `Roll back ${t.file}${t.to ? ` to ${t.to}` : ""}`;
    const n = p.files.length;
    body.push(
      p.base
        ? `Puts ${n} file${n === 1 ? "" : "s"} back as ${n === 1 ? "it was" : "they were"} at ${p.base.sha.slice(0, 12)} (${p.base.date}), undoing ${p.revert_count} commit${p.revert_count === 1 ? "" : "s"}:`
        : `Removes ${n === 1 ? "it" : "them"} — ${n === 1 ? "it" : "they"} did not exist before ${p.revert_count} commit${p.revert_count === 1 ? "" : "s"}:`,
    );
    for (const c of p.reverts.slice(0, MAX_IN_MESSAGE)) body.push(`- ${c.sha.slice(0, 12)} ${c.subject.replace(/\s+/g, " ").slice(0, 120)}`);
    if (p.revert_count > MAX_IN_MESSAGE) body.push(`- … and ${p.revert_count - MAX_IN_MESSAGE} more`);
  }
  if (p.skipped_config.length) body.push("", `Left as they are (configuration): ${p.skipped_config.join(", ")}`);
  if (p.config.length) body.push("", `Configuration included (--include-config): ${p.config.join(", ")}`);
  const line = note?.replace(/\s+/g, " ").trim().slice(0, 300);
  if (line) body.push("", line);
  return [subject, "", ...body, ...(sourceLine ? ["", sourceLine] : [])].join("\n") + "\n";
}

const sorted = (xs: readonly string[]) => [...xs].sort();
const same = (a: readonly string[], b: readonly string[]) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

/** The plan as the wire carries it — never the tree or the parent. */
function view({ tree: _tree, parent: _parent, ...plan }: Planned): RevertPlan {
  return plan;
}

/**
 * Plan, and — unless `dryRun` — make the rollback commit and move the branch
 * onto it by fast-forward. Holds history for the whole of it
 * (`Committer.holdHistory`): every pending act is committed first, no bridge
 * write lands meanwhile, no sync runs meanwhile.
 *
 * The caller (server.ts) has already refused every principal but `user`, and
 * `includeConfig` from anything but the owner-class bearer.
 */
export function revert(git: Git, root: string, committer: Committer, target: RevertTarget, opts: RevertOptions): Promise<Outcome<RevertResult>> {
  return committer.holdHistory(async (): Promise<Outcome<RevertResult>> => {
    const op = await git.operationInProgress();
    if (op) return fail("conflict", `a ${op} is in progress in the vault — finish it in Obsidian or a terminal, then roll back`);
    const planned = await planRevert(git, root, target, { head: opts.head, includeConfig: opts.includeConfig, scaffold: committer.identityFor("reconciler") });
    if (!planned.ok) return planned;
    const p = planned.value;
    p.message = revertMessage(p, opts.note, committer.sourceLine("user"));
    if (opts.dryRun) return { ok: true, value: { ...view(p), dry_run: true } };

    const e = opts.expect;
    if (e && !(same(e.files, p.files.map((f) => f.path)) && same(e.reverts, p.reverts.map((c) => c.sha)) && same(e.skipped_config, p.skipped_config))) {
      return fail("conflict", "stale: the rollback would now change something other than what was approved — ask for it again");
    }

    // An uncommitted edit (Obsidian, an editor) to a file the rollback changes
    // is the owner's work: in the way, never overwritten.
    const dirty = new Set<string>();
    for (const s of await git.status()) {
      if (s.code === "!!") continue;
      dirty.add(s.path);
      if (s.from) dirty.add(s.from);
    }
    const blocked = p.files.map((f) => f.path).filter((f) => dirty.has(f));
    if (blocked.length) return fail("conflict", `uncommitted edits to ${blocked.slice(0, 5).join(", ")} are in the way — they are yours and were not touched; let them commit (a few seconds), then roll back`);

    const user = committer.identityFor("user");
    const sha = (await git.run(["commit-tree", p.tree, "-p", p.parent], { input: p.message, identity: user })).trim();
    const step = await git.raw(["merge", "--ff-only", "-q", sha]);
    if (step.code !== 0) {
      // Refused, and nothing moved: an edit landed between the check and the step.
      return fail("conflict", `the rollback could not be applied without overwriting a change in the working tree (${step.stderr.trim().split("\n").slice(-1)[0] ?? "git refused"}) — nothing was changed; try again`);
    }
    return { ok: true, value: { ...view(p), dry_run: false, sha } };
  });
}
