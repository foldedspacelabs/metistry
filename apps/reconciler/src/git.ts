// The one place in the product where git runs (D5). Always `execFile` with
// an argument array — no shell, so no path or message can be interpreted.
// Paths handed to git are always preceded by `--` so a path starting with
// `-` is a path, never a flag. Identity is stamped from env per call, never
// read from the repo's config or a request.
//
// And nothing here can rewrite history (§2.21 rule 1): `refusedGitArgs`
// is checked before every exec, so a force, a hard reset or a deleting
// refspec is not a thing a caller forgets not to do — it is a thing this
// class cannot run.

import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { CREDENTIAL_HELPER_RESET, GIT_ASKPASS_PATH_VAR, GIT_ASKPASS_TOKEN_VAR, GIT_ASKPASS_USER_VAR } from "@foldedspacelabs/metistry-core";

export interface GitIdentity {
  name: string;
  email: string;
}

/** An author as a commit records it: `date` is git's internal `<unix seconds> <±hhmm>`, kept verbatim so a rebased act keeps its time. */
export interface GitAuthor extends GitIdentity {
  date?: string;
}

export interface GitOptions {
  /** Author AND committer — a new commit made by this process. */
  identity?: GitIdentity;
  /** Overrides the author alone (a rebased act keeps whoever made it, and when). */
  author?: GitAuthor;
  /** Overrides the committer alone. */
  committer?: GitIdentity;
  /** Written to git's stdin (a commit message for `commit-tree`, verbatim). */
  input?: string;
  timeoutMs?: number;
}

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class GitError extends Error {
  constructor(
    public readonly args: string[],
    public readonly result: GitResult,
  ) {
    super(`git ${args[0] ?? ""} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
  }
}

/**
 * Everything the egress door and the confined credential path add to a git
 * call, as two pure functions — because the whole of the design is in this
 * pair of decisions and a test that could only observe them through a
 * subprocess would be testing git rather than us.
 *
 * `METISTRY_GIT_ASKPASS` is the switch. It is set by `metistry up` on the
 * confined reconciler and on nothing else, so its presence is exactly
 * "this install has no shell for a credential helper" — and the reset and
 * the shim move together, because a reset with no askpass is an install
 * that cannot authenticate at all.
 */
export function gitCredentialEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const askpass = env[GIT_ASKPASS_PATH_VAR]?.trim();
  if (!askpass) return {};
  // The credential reaches git through the ENVIRONMENT and never through
  // argv — `ps` shows argv to every process on the Mac, and a push runs
  // every hour. The shim reads exactly these two and can open no file.
  return {
    GIT_ASKPASS: askpass,
    ...(env[GIT_ASKPASS_USER_VAR] ? { [GIT_ASKPASS_USER_VAR]: env[GIT_ASKPASS_USER_VAR] } : {}),
    ...(env[GIT_ASKPASS_TOKEN_VAR] ? { [GIT_ASKPASS_TOKEN_VAR]: env[GIT_ASKPASS_TOKEN_VAR] } : {}),
  };
}

/**
 * The `-c` flags every call carries.
 *
 * `commit.gpgsign=false` / `tag.gpgsign=false`: an automated committer must
 * never sign as the user.
 *
 * `http.proxy`: the supervisor's egress proxy, when this install confines
 * the reconciler. A flag rather than `HTTPS_PROXY` because the environment
 * above is a deliberate allowlist and one explicit flag is easier to read in
 * a log than a variable curl may or may not honour. With the profile in
 * force it is the ONLY way out — a direct connect is refused by the kernel,
 * and a host the allowlist does not name comes back as
 * `fatal: … CONNECT tunnel failed, response 403`.
 *
 * `credential.helper=`: git's documented RESET of the helper list, and only
 * when there is an askpass to take its place. Measured — a confined push
 * whose repo still names osxkeychain dies on the helper before askpass is
 * ever reached:
 *   fatal: cannot exec 'git credential-osxkeychain get': Operation not permitted
 * An unconfined install gets no reset and keeps using the Keychain helper
 * exactly as it always did.
 */
export function gitConfigFlags(env: NodeJS.ProcessEnv = process.env): string[] {
  const proxy = env.METISTRY_GIT_HTTP_PROXY?.trim();
  const askpass = env[GIT_ASKPASS_PATH_VAR]?.trim();
  return [
    "-c",
    "commit.gpgsign=false",
    "-c",
    "tag.gpgsign=false",
    ...(proxy ? ["-c", `http.proxy=${proxy}`] : []),
    ...(askpass ? ["-c", CREDENTIAL_HELPER_RESET] : []),
  ];
}

/**
 * The history-rewriting argv this process may never run (§2.21 rule 1:
 * "never force, never rewrite published history"), or null when `args` is
 * none of them. Checked in `Git.raw` before anything is exec'd, so the ban
 * holds for every caller, present and future — a refusal is a code path,
 * never a sentence (U3).
 *
 * Refused: any `--force*` / `-f`, `--hard`, `--mirror`; a push or fetch
 * refspec that forces (`+…`) or deletes (`:…`), `push --delete`/`-d`/
 * `--prune`/`--all`; a `reset` that moves the branch without git's own
 * keep-local-changes check (`--soft`, `--mixed`, `--merge`, or a commit with
 * no mode) — `reset -q -- <paths>` (unstage) and `reset --keep <commit>`
 * (the rebase of never-published acts) are the two forms this app uses; a
 * `merge` that is not `--ff-only` (a real merge is built with `merge-tree`
 * and `commit-tree`, off the working tree); and the subcommands that
 * discard work or history outright. Paths after `--` and the value of
 * `-m` are data, never flags, and are not read.
 */
export function refusedGitArgs(args: readonly string[]): string | null {
  const sub = args[0] ?? "";
  if (NEVER_RUN.has(sub)) return `git ${sub} is never run by the reconciler`;
  const flags: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") break;
    if (a === "-m") {
      i++; // the message is data
      continue;
    }
    flags.push(a);
  }
  for (const a of flags) {
    if (a === "-f" || a.startsWith("--force") || a === "--hard" || a === "--mirror") return `${a} is never run by the reconciler`;
  }
  if (sub === "push" || sub === "fetch") {
    const bad = flags.find((a) => a.startsWith("+") || a.startsWith(":") || (sub === "push" && ["--delete", "-d", "--prune", "--all"].includes(a)));
    if (bad) return `git ${sub} ${bad} would force or delete a ref`;
  }
  if (sub === "reset") {
    const mode = flags.find((a) => ["--soft", "--mixed", "--merge", "--keep"].includes(a));
    if (mode && mode !== "--keep") return `git reset ${mode} moves the branch without keeping local changes`;
    const pathForm = args.includes("--");
    if (!mode && !pathForm) return "git reset with a commit and no --keep moves the branch";
  }
  if (sub === "merge" && !flags.includes("--ff-only")) return "git merge is only ever --ff-only here (a merge commit is built with merge-tree)";
  return null;
}

const NEVER_RUN = new Set(["rebase", "filter-branch", "update-ref", "reflog", "gc", "prune", "clean", "stash", "checkout", "switch", "restore", "branch", "replace"]);

/** An operation the OWNER has in progress in the working tree, by the marker git leaves for it. */
const OPERATION_MARKERS: ReadonlyArray<readonly [string, string]> = [
  ["MERGE_HEAD", "merge"],
  ["rebase-merge", "rebase"],
  ["rebase-apply", "rebase"],
  ["CHERRY_PICK_HEAD", "cherry-pick"],
  ["REVERT_HEAD", "revert"],
  ["BISECT_LOG", "bisect"],
];

export class Git {
  constructor(
    public readonly root: string,
    private readonly timeoutMs = 60_000,
  ) {}

  /** Run git; resolves with the exit code (never throws on non-zero). A refused argv (`refusedGitArgs`) never reaches git: it resolves as exit 128. */
  async raw(args: string[], opts: GitOptions = {}): Promise<GitResult> {
    const r = await this.exec(args, opts);
    return { code: r.code, stdout: r.stdout.toString("utf8"), stderr: r.stderr };
  }

  /**
   * Run git and keep stdout as BYTES — a blob read out of history must come
   * back exactly as it was committed (an image, a PDF, a note with a stray
   * invalid sequence), which a string decode would silently mangle. Same
   * refusal check, same environment, same `-c` flags as `raw`.
   */
  rawBytes(args: string[], opts: GitOptions = {}): Promise<{ code: number; stdout: Buffer; stderr: string }> {
    return this.exec(args, opts);
  }

  /** The one exec: stdout always arrives as bytes, and `raw` decodes it (what `String(stdout)` did before). */
  private exec(args: string[], opts: GitOptions): Promise<{ code: number; stdout: Buffer; stderr: string }> {
    const refused = refusedGitArgs(args);
    if (refused) return Promise.resolve({ code: 128, stdout: Buffer.alloc(0), stderr: `refused: ${refused}` });
    const env: NodeJS.ProcessEnv = {
      // a minimal, explicit environment: no user config, no prompts, no hooks surprises
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? "/",
      LANG: "C",
      LC_ALL: "C",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      ...(process.env.SSH_AUTH_SOCK ? { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK } : {}),
      ...gitCredentialEnv(),
    };
    const author: GitAuthor | undefined = opts.author ?? opts.identity;
    const committer = opts.committer ?? opts.identity;
    if (author) {
      env.GIT_AUTHOR_NAME = author.name;
      env.GIT_AUTHOR_EMAIL = author.email;
      if (author.date) env.GIT_AUTHOR_DATE = author.date;
    }
    if (committer) {
      env.GIT_COMMITTER_NAME = committer.name;
      env.GIT_COMMITTER_EMAIL = committer.email;
    }
    const argv = [...gitConfigFlags(), ...args];
    return new Promise((resolve) => {
      const child = execFile(
        "git",
        argv,
        { cwd: this.root, env, timeout: opts.timeoutMs ?? this.timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: "buffer" },
        (err, stdout, stderr) => {
          const code = err && typeof (err as any).code === "number" ? (err as any).code : err ? 1 : 0;
          const out = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout));
          resolve({ code, stdout: out, stderr: String(stderr) + (err && (err as any).killed ? " (timed out)" : "") });
        },
      );
      if (opts.input !== undefined) child.stdin?.end(opts.input);
      else child.stdin?.end();
    });
  }

  /** Run git; throws GitError on non-zero exit. */
  async run(args: string[], opts: GitOptions = {}): Promise<string> {
    const r = await this.raw(args, opts);
    if (r.code !== 0) throw new GitError(args, r);
    return r.stdout;
  }

  async isRepo(): Promise<boolean> {
    const r = await this.raw(["rev-parse", "--show-toplevel"]);
    return r.code === 0;
  }

  /** HEAD commit sha, or null on an unborn branch (fresh `git init`). */
  async head(): Promise<string | null> {
    const r = await this.raw(["rev-parse", "--verify", "-q", "HEAD"]);
    return r.code === 0 ? r.stdout.trim() : null;
  }

  async remotes(): Promise<string[]> {
    const r = await this.raw(["remote"]);
    return r.code === 0 ? r.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : [];
  }

  async currentBranch(): Promise<string | null> {
    const r = await this.raw(["symbolic-ref", "--short", "-q", "HEAD"]);
    return r.code === 0 ? r.stdout.trim() : null;
  }

  /** A revision's commit sha, or null when it does not resolve. */
  async commitOf(rev: string): Promise<string | null> {
    const r = await this.raw(["rev-parse", "--verify", "-q", `${rev}^{commit}`]);
    return r.code === 0 ? r.stdout.trim() : null;
  }

  /**
   * The operation the owner has in progress in this working tree — a merge
   * they are resolving, a rebase, a cherry-pick — or null. While one is,
   * the index and HEAD are theirs: the committer stages nothing, commits
   * nothing and integrates nothing until it is finished (§2.21 rule 3 —
   * "resolved in Obsidian or a terminal").
   */
  async operationInProgress(): Promise<string | null> {
    const r = await this.raw(["rev-parse", ...OPERATION_MARKERS.flatMap(([m]) => ["--git-path", m])]);
    if (r.code !== 0) return null;
    const paths = r.stdout.split("\n").filter(Boolean);
    for (let i = 0; i < OPERATION_MARKERS.length && i < paths.length; i++) {
      const p = paths[i]!;
      const ok = await access(isAbsolute(p) ? p : join(this.root, p)).then(
        () => true,
        () => false,
      );
      if (ok) return OPERATION_MARKERS[i]![1];
    }
    return null;
  }

  /** Working-tree changes under `paths` as porcelain entries (status code + path). */
  async status(paths: string[] = []): Promise<Array<{ code: string; path: string; from?: string }>> {
    const out = await this.run(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...paths]);
    const entries: Array<{ code: string; path: string; from?: string }> = [];
    const parts = out.split("\0");
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (!p) continue;
      const code = p.slice(0, 2);
      const path = p.slice(3);
      if (code[0] === "R" || code[0] === "C") {
        // renamed/copied: the next NUL-separated token is the source path
        const from = parts[++i] ?? "";
        entries.push({ code, path, from });
      } else entries.push({ code, path });
    }
    return entries;
  }
}
