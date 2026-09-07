// One injectable seam for every subprocess the CLI runs (git, launchctl,
// docker). Tests hand in a fake; production uses execFile — never a shell,
// so no argument is ever interpolated into a command line.

import { execFile } from "node:child_process";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Exec = (cmd: string, args: string[], opts?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }) => Promise<ExecResult>;

export const realExec: Exec = (cmd, args, opts = {}) =>
  new Promise((resolvePromise) => {
    execFile(
      cmd,
      args,
      { cwd: opts.cwd, env: opts.env ?? process.env, timeout: opts.timeoutMs ?? 15_000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { code?: number | string }) | null;
        // ENOENT (binary missing) and a non-zero exit both land here; keep them distinguishable via code.
        const code = e ? (typeof e.code === "number" ? e.code : e.code === "ENOENT" ? 127 : 1) : 0;
        resolvePromise({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
