// The tiny "plan then act" layer `up` and `update` share: every subprocess
// and every file write goes through here, so `--dry-run` is a mode of the
// SAME code path (print what would run, run nothing) rather than a second
// implementation that drifts. Subprocesses are argument arrays via the
// exec seam — never a shell string with an interpolated env.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { formatCommand, realExec, type Exec, type ExecOptions, type ExecResult } from "./exec.js";
import { defaultUi, type Ui } from "./ui.js";

export interface StepRunnerOptions {
  dryRun: boolean;
  out: (line: string) => void;
  exec?: Exec | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  /** test seam: the clock section timings are measured with (default `Date.now`) */
  now?: (() => number) | undefined;
  /** how it is painted — defaults to the one `main()` configured from the flags (docs/ops/cli-style.md) */
  ui?: Ui | undefined;
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
  readonly ui: Ui;
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
    this.ui = opts.ui ?? defaultUi();
  }

  /**
   * The `[dry-run] ` marker, dimmed. Every line of a dry run carries it, so
   * it must not be the brightest thing on the screen — and with colour off
   * it is the same bytes it always was.
   */
  private prefix(running = ""): string {
    return this.dryRun ? this.ui.dim("[dry-run] ") : running;
  }

  /** A heading for a phase of the plan. Closes the previous section's clock. */
  section(title: string): void {
    this.closeSection();
    this.open = { title, at: this.now() };
    this.out(`${this.prefix()}${this.ui.heading(`== ${title}`)}`);
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

  /** A plain line of explanation: secondary to the steps it explains, so dimmed. */
  note(line: string): void {
    this.out(this.ui.dim(`   ${line}`));
  }

  /**
   * An aligned block — the moves a migration is about to make, read as one
   * shape rather than N lines. No `[dry-run] ` marker: a table is the plan,
   * and the plan is the same either way.
   */
  table(head: string[], rows: string[][]): void {
    for (const line of this.ui.table(head, rows, { indent: 3 }).split("\n")) this.out(line);
  }

  /**
   * Run one command. `tolerateFailure` makes a non-zero exit informational
   * (launchctl bootout of a job that is not loaded); otherwise it throws
   * StepFailed with the command's exit code.
   */
  async run(cmd: string, args: string[], opts: ExecOptions & { tolerateFailure?: boolean | undefined; comment?: string | undefined; quiet?: boolean | undefined } = {}): Promise<ExecResult> {
    const shown = formatCommand(cmd, args, opts.cwd);
    this.commands.push(shown);
    // `quiet` is for a step the caller has ALREADY shown — a row in a plan
    // table. It still goes into `commands` (and so into --json and the
    // tests): the ledger is never quiet, only the screen.
    if (opts.quiet === true) {
      if (this.dryRun) return { code: 0, stdout: "", stderr: "" };
      return await this.execOrFail(cmd, args, opts);
    }
    // the command is the payload — in a dry run it IS the whole answer — so
    // it stays plain; the marker and the trailing comment are what dim
    const line = `${this.prefix("$ ")}${shown}${opts.comment ? this.ui.dim(`   # ${opts.comment}`) : ""}`;
    // On a TTY the step spins while it runs and resolves into ONE ✓/✗ line;
    // anywhere else — a pipe, a launchd log, the test suite — it is the same
    // line, printed once, up front. A child that inherits stdout is never
    // spun over: its own output would fight the animation.
    const spinner = !this.dryRun && opts.inherit !== true && this.ui.isTTY ? this.ui.spinner(line, this.out) : undefined;
    if (!spinner) this.out(line);
    if (this.dryRun) return { code: 0, stdout: "", stderr: "" };
    try {
      const r = await this.execOrFail(cmd, args, opts);
      spinner?.succeed(line);
      return r;
    } catch (e) {
      spinner?.fail(line);
      throw e;
    }
  }

  private async execOrFail(cmd: string, args: string[], opts: ExecOptions & { tolerateFailure?: boolean | undefined }): Promise<ExecResult> {
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
    this.out(`${this.prefix("  ")}${shown}`);
    if (this.dryRun) return;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }

  /**
   * Record a non-subprocess action (an HTTP call, a db step) in the same
   * list, for the same dry-run treatment. `quiet` is a step already shown
   * in a plan table: recorded, not printed twice.
   */
  action(description: string, opts: { quiet?: boolean | undefined } = {}): boolean {
    this.commands.push(description);
    if (opts.quiet !== true) this.out(`${this.prefix("  ")}${description}`);
    return !this.dryRun;
  }
}
