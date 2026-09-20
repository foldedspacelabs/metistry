// The one place in the product where git runs (D5). Always `execFile` with
// an argument array — no shell, so no path or message can be interpreted.
// Paths handed to git are always preceded by `--` so a path starting with
// `-` is a path, never a flag. Identity is stamped from env per call, never
// read from the repo's config or a request.

import { execFile } from "node:child_process";

export interface GitIdentity {
  name: string;
  email: string;
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

export class Git {
  constructor(
    public readonly root: string,
    private readonly timeoutMs = 60_000,
  ) {}

  /** Run git; resolves with the exit code (never throws on non-zero). */
  raw(args: string[], opts: { identity?: GitIdentity; timeoutMs?: number } = {}): Promise<GitResult> {
    const env: NodeJS.ProcessEnv = {
      // a minimal, explicit environment: no user config, no prompts, no hooks surprises
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? "/",
      LANG: "C",
      LC_ALL: "C",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      ...(process.env.SSH_AUTH_SOCK ? { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK } : {}),
    };
    if (opts.identity) {
      env.GIT_AUTHOR_NAME = opts.identity.name;
      env.GIT_AUTHOR_EMAIL = opts.identity.email;
      env.GIT_COMMITTER_NAME = opts.identity.name;
      env.GIT_COMMITTER_EMAIL = opts.identity.email;
    }
    // An automated committer must never sign as the user; keep the rest of
    // the user's global config (credential helpers) so push works.
    //
    // …and, when this install confines the reconciler, route HTTP(S)
    // through the supervisor's egress proxy. It is `-c http.proxy` rather
    // than an environment variable because the environment above is a
    // deliberate allowlist — `HTTPS_PROXY` would have to be added to it
    // anyway, and one explicit flag is easier to read in a log than a
    // variable curl may or may not honour. With the profile in force this
    // is the ONLY way out: a direct connect is refused by the kernel, and a
    // host the allowlist does not name comes back as
    // `fatal: … CONNECT tunnel failed, response 403`
    // (packages/core/src/egress.ts; ops/sandbox/reconciler.sb).
    const proxy = process.env.METISTRY_GIT_HTTP_PROXY?.trim();
    const argv = ["-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...(proxy ? ["-c", `http.proxy=${proxy}`] : []), ...args];
    return new Promise((resolve) => {
      execFile(
        "git",
        argv,
        { cwd: this.root, env, timeout: opts.timeoutMs ?? this.timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
        (err, stdout, stderr) => {
          const code = err && typeof (err as any).code === "number" ? (err as any).code : err ? 1 : 0;
          resolve({ code, stdout: String(stdout), stderr: String(stderr) + (err && (err as any).killed ? " (timed out)" : "") });
        },
      );
    });
  }

  /** Run git; throws GitError on non-zero exit. */
  async run(args: string[], opts: { identity?: GitIdentity; timeoutMs?: number } = {}): Promise<string> {
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
