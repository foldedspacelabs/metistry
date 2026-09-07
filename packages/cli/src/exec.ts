// One injectable seam for every subprocess the CLI runs (git, launchctl,
// docker, pnpm). Tests hand in a fake; production uses execFile/spawn —
// never a shell, so no argument is ever interpolated into a command line.

import { execFile, spawn } from "node:child_process";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  timeoutMs?: number | undefined;
  /** Stream the child's stdio to ours (long builds: `docker compose up --build`, `pnpm -r build`). stdout/stderr come back empty. */
  inherit?: boolean | undefined;
}

export type Exec = (cmd: string, args: string[], opts?: ExecOptions) => Promise<ExecResult>;

export const realExec: Exec = (cmd, args, opts = {}) =>
  new Promise((resolvePromise) => {
    if (opts.inherit) {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: "inherit" });
      } catch (err) {
        resolvePromise({ code: (err as NodeJS.ErrnoException).code === "ENOENT" ? 127 : 1, stdout: "", stderr: String(err) });
        return;
      }
      const timer = opts.timeoutMs ? setTimeout(() => child.kill("SIGTERM"), opts.timeoutMs) : undefined;
      child.on("error", (err) => {
        if (timer) clearTimeout(timer);
        resolvePromise({ code: (err as NodeJS.ErrnoException).code === "ENOENT" ? 127 : 1, stdout: "", stderr: err.message });
      });
      child.on("exit", (code, signal) => {
        if (timer) clearTimeout(timer);
        resolvePromise({ code: code ?? (signal ? 1 : 0), stdout: "", stderr: signal ? `killed by ${signal}` : "" });
      });
      return;
    }
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

/** Render a command the way a person would type it, for --dry-run and progress lines (display only — never executed). */
export function formatCommand(cmd: string, args: string[], cwd?: string): string {
  const quote = (s: string) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
  return `${cwd ? `(cd ${quote(cwd)} && ` : ""}${[cmd, ...args].map(quote).join(" ")}${cwd ? ")" : ""}`;
}
