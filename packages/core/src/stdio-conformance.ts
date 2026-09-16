// stdout is the protocol (plan-refresh R5, rivet review ADOPT 5).
//
// For a component whose wire is stdio — an MCP server on a stdio transport, a
// Swift helper speaking JSON lines to its Node parent — stdout is not a place
// to write. One `print("starting…")`, one library that logs to the console on
// import, one uncaught warning, and the peer is reading a frame that is not a
// frame. The failure is silent at the source and confusing at the far end:
// mcp-apple-fm's `Helper` currently drops unparseable lines on the floor, so a
// chatty helper looks like a hung one.
//
// Invariant 8 says misuse tests ship with the interface. This is that test,
// made reusable: spawn the thing with a deliberately bare environment, send it
// a request, and require every byte it put on stdout to be a protocol frame.
// Logs go to stderr, which this deliberately does not police — stderr may say
// anything.

import { spawn } from "node:child_process";

export interface StdoutViolation {
  /** 1-based line number in the child's stdout */
  line: number;
  /** the offending text, truncated — a violation report is not a log dump */
  text: string;
  why: string;
}

/** A frame is one complete JSON value on its own line: MCP's stdio transport and both Swift helpers speak this. */
export function isJsonLineFrame(line: string): boolean {
  if (line.trim() === "") return false;
  try {
    const v = JSON.parse(line);
    return typeof v === "object" && v !== null;
  } catch {
    return false;
  }
}

const TRUNCATE = 200; // limit: fixed — the width of a readable assertion message, not a knob

/**
 * Every line of `stdout` that is not a protocol frame. A trailing newline is
 * not a violation; a blank line in the middle of the stream is, because a peer
 * framing on newlines has to decide what to do with it.
 */
export function stdoutViolations(stdout: string, isFrame: (line: string) => boolean = isJsonLineFrame): StdoutViolation[] {
  if (stdout === "") return [];
  const lines = stdout.split("\n");
  if (lines[lines.length - 1] === "") lines.pop(); // the final frame's own terminator
  const out: StdoutViolation[] = [];
  lines.forEach((line, i) => {
    if (isFrame(line)) return;
    out.push({
      line: i + 1,
      text: line.length > TRUNCATE ? `${line.slice(0, TRUNCATE)}…` : line,
      why: line.trim() === "" ? "blank line on the protocol stream" : "not a protocol frame — logs go to stderr",
    });
  });
  return out;
}

export interface StdioConformanceOptions {
  command: string;
  args?: string[] | undefined;
  /**
   * The child's whole environment. Deliberately required and deliberately
   * small: a bridge that only behaves when the operator's environment is
   * present has not been tested, it has been accommodated.
   */
  env?: NodeJS.ProcessEnv | undefined;
  cwd?: string | undefined;
  /** Written to stdin, each already framed. One request is enough to prove the rule. */
  requests?: string[] | undefined;
  /** How long to let it talk before SIGKILL. */
  timeoutMs?: number | undefined;
  isFrame?: ((line: string) => boolean) | undefined;
}

export interface StdioConformanceResult {
  stdout: string;
  stderr: string;
  /** null when the child had to be killed on the timeout */
  exitCode: number | null;
  violations: StdoutViolation[];
  /** the parsed frames, in order — a caller may want to assert on them too */
  frames: unknown[];
  /** true when the child said nothing on stdout at all, which is conformant but usually not what a caller meant to assert */
  silent: boolean;
}

/** Spawn, speak, and report what came back on each stream. Never throws on a non-zero exit: an error frame is still a frame. */
export async function checkStdioConformance(opts: StdioConformanceOptions): Promise<StdioConformanceResult> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const isFrame = opts.isFrame ?? isJsonLineFrame;
  const child = spawn(opts.command, opts.args ?? [], {
    env: opts.env ?? {},
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (d: string) => (stdout += d));
  child.stderr.on("data", (d: string) => (stderr += d));

  const exitCode = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(null);
    }, timeoutMs);
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    for (const r of opts.requests ?? []) child.stdin.write(r.endsWith("\n") ? r : `${r}\n`);
    child.stdin.end();
  });

  const violations = stdoutViolations(stdout, isFrame);
  const frames = stdout
    .split("\n")
    .filter((l) => isFrame(l))
    .map((l) => JSON.parse(l) as unknown);
  return { stdout, stderr, exitCode, violations, frames, silent: stdout.trim() === "" };
}

/** One message naming every line that broke the rule — what an assertion prints when it fails. */
export function renderStdoutViolations(label: string, violations: StdoutViolation[]): string {
  return [
    `${label}: stdout is the protocol, and ${violations.length} line(s) on it are not frames:`,
    ...violations.map((v) => `  line ${v.line}: ${JSON.stringify(v.text)} — ${v.why}`),
    "",
    "Move them to stderr. A peer framing this stream cannot tell a log line from a truncated frame.",
  ].join("\n");
}
