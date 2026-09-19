// The tiny "plan then act" layer `up` and `update` share: every subprocess
// and every file write goes through here, so `--dry-run` is a mode of the
// SAME code path (print what would run, run nothing) rather than a second
// implementation that drifts. Subprocesses are argument arrays via the
// exec seam — never a shell string with an interpolated env.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { formatCommand, realExec, type Exec, type ExecOptions, type ExecResult } from "./exec.js";

export interface StepRunnerOptions {
  dryRun: boolean;
  out: (line: string) => void;
  exec?: Exec | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  /** test seam: the clock section timings are measured with (default `Date.now`) */
  now?: (() => number) | undefined;
}

export class StepFailed extends Error {
  constructor(
    message: string,
    public readonly code = 1,
  ) {
    super(message);
  }
}

/** One `== section` and how long the steps under it took. */
export interface SectionTiming {
  title: string;
  ms: number;
}

export class StepRunner {
  readonly dryRun: boolean;
  readonly out: (line: string) => void;
  readonly exec: Exec;
  readonly env: NodeJS.ProcessEnv;
  /** commands in the order they ran (or would have) — what the tests assert against */
  readonly commands: string[] = [];
  /** test seam: the clock `timings()` measures with */
  private readonly now: () => number;
  private readonly startedAt: number;
  private readonly sections: SectionTiming[] = [];
  private open: { title: string; at: number } | undefined;

  constructor(opts: StepRunnerOptions) {
    this.dryRun = opts.dryRun;
    this.out = opts.out;
    this.exec = opts.exec ?? realExec;
    this.env = opts.env ?? process.env;
    this.now = opts.now ?? Date.now;
    this.startedAt = this.now();
  }

  /** A heading for a phase of the plan. Closes the previous section's clock. */
  section(title: string): void {
    this.closeSection();
    this.open = { title, at: this.now() };
    this.out(`${this.dryRun ? "[dry-run] " : ""}== ${title}`);
  }

  private closeSection(): void {
    if (!this.open) return;
    this.sections.push({ title: this.open.title, ms: this.now() - this.open.at });
    this.open = undefined;
  }

  /** ms since this runner was made — what a verb prints as its total. */
  elapsedMs(): number {
    return this.now() - this.startedAt;
  }

  /**
   * Every section's elapsed ms, in order, closing whichever is still open.
   * Where the time went is the first question anyone asks of a verb that
   * felt slow, so `up` prints this rather than making it a flag to remember.
   */
  timings(): SectionTiming[] {
    this.closeSection();
    return [...this.sections];
  }

  /** A plain line of explanation. */
  note(line: string): void {
    this.out(`   ${line}`);
  }

  /**
   * Run one command. `tolerateFailure` makes a non-zero exit informational
   * (launchctl bootout of a job that is not loaded); otherwise it throws
   * StepFailed with the command's exit code.
   */
  async run(cmd: string, args: string[], opts: ExecOptions & { tolerateFailure?: boolean | undefined; comment?: string | undefined } = {}): Promise<ExecResult> {
    const shown = formatCommand(cmd, args, opts.cwd);
    this.commands.push(shown);
    this.out(`${this.dryRun ? "[dry-run] " : "$ "}${shown}${opts.comment ? `   # ${opts.comment}` : ""}`);
    if (this.dryRun) return { code: 0, stdout: "", stderr: "" };
    const r = await this.exec(cmd, args, { cwd: opts.cwd, env: opts.env ?? this.env, timeoutMs: opts.timeoutMs, inherit: opts.inherit });
    if (r.code !== 0 && !opts.tolerateFailure) {
      const detail = (r.stderr || r.stdout).trim().split("\n").slice(-3).join("\n");
      throw new StepFailed(`${cmd} ${args[0] ?? ""} exited ${r.code}${detail ? `: ${detail}` : ""}`, r.code);
    }
    return r;
  }

  /** Write a file (creating its directory); a dry run prints the path and the source it would be rendered from. */
  async write(path: string, content: string, from: string): Promise<void> {
    const shown = `write ${path}  (from ${from})`;
    this.commands.push(shown);
    this.out(`${this.dryRun ? "[dry-run] " : "  "}${shown}`);
    if (this.dryRun) return;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }

  /** Record a non-subprocess action (an HTTP call, a db step) in the same list, for the same dry-run treatment. */
  action(description: string): boolean {
    this.commands.push(description);
    this.out(`${this.dryRun ? "[dry-run] " : "  "}${description}`);
    return !this.dryRun;
  }
}
