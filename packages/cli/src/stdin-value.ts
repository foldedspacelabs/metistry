// A secret VALUE arrives on stdin and nowhere else — the one rule `secrets
// set|replace` and `remote set` (a pasted provider token, plan §2.23) share.
//
// Never argv: an argument lands in shell history, in `ps`, in a launchd log
// and in the Mac app's subprocess trace. Never a flag value for the same
// reason. So: piped stdin, read to EOF, when this process is not a terminal
// (a script, the Mac app); one hidden line at a prompt when it is — otherwise
// the owner types the value, presses Enter, and the command hangs forever
// waiting for an EOF a terminal never sends.
//
// Streams are parameters, so the pieces unit-test with fakes and never touch
// a real terminal; `readSecretValue` wires the real ones in.

import { secretValueIssue } from "@foldedspacelabs/metistry-core";
import { StepFailed } from "./steps.js";

/** Read a whole stream to EOF. Trimmed: a trailing newline from a paste is not part of the value. A terminal's stdin only ends on Ctrl-D, so a caller that may be in a terminal prompts first (`readTextInput`, `promptHiddenLine`). */
export async function readStdin(stream: AsyncIterable<Buffer | string> = process.stdin): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString("utf8").trim();
}

/**
 * A terminal this process is attached to: the stream the owner types into and
 * the one a prompt is written on. Present only when stdin IS a terminal —
 * every terminal read in the CLI asks `realTerminal()` and takes the piped
 * path when it answers nothing. A parameter so a test can hand in a fake
 * "terminal" and watch exactly what reaches its stderr, and what does not.
 */
export interface Terminal {
  stdin: HiddenLineStdin & AsyncIterable<Buffer | string>;
  stderr: HiddenLineStderr;
}

/** This process's terminal, or `undefined` when stdin is piped, redirected or closed (a script, the Mac app, CI). */
export function realTerminal(): Terminal | undefined {
  return process.stdin.isTTY === true ? { stdin: process.stdin, stderr: process.stderr } : undefined;
}

/** The minimum a readable stream needs for `readHiddenLine` — a structural type so a fake stdin in a test never has to impersonate all of `NodeJS.ReadStream`. */
export interface HiddenLineStdin {
  on(event: "data", listener: (chunk: string) => void): unknown;
  off(event: "data", listener: (chunk: string) => void): unknown;
  setRawMode?(mode: boolean): unknown;
  resume?(): unknown;
  pause?(): unknown;
  setEncoding?(encoding: BufferEncoding): unknown;
  isRaw?: boolean;
}

/** The minimum a writable stream needs for `readHiddenLine` to report cancellation. */
export interface HiddenLineStderr {
  write(chunk: string): unknown;
}

/**
 * Read exactly one line from `stdin` with the terminal's echo off — not one
 * typed character reaches `stderr` (or anywhere else): this is what makes a
 * pasted secret "hidden" rather than merely unprompted. Backspace/DEL erases
 * the previous character; Enter (`\r` or `\n`) ends the line; Ctrl-C restores
 * the terminal and exits the process at 130, the way a shell reports a
 * SIGINT'd read; Ctrl-D on an empty line ends it as empty, the same as a
 * blank paste followed by Enter.
 */
export async function readHiddenLine(stdin: HiddenLineStdin, stderr: HiddenLineStderr, exit: (code: number) => never = (code) => process.exit(code)): Promise<string> {
  const wasRaw = stdin.isRaw === true;
  stdin.setRawMode?.(true);
  stdin.setEncoding?.("utf8");
  stdin.resume?.();
  let buf = "";
  return await new Promise<string>((resolve) => {
    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode?.(wasRaw);
      stdin.pause?.();
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\u0003") {
          // Ctrl-C: the owner changed their mind mid-paste — leave the
          // terminal as it was found and stop, rather than store a half-typed
          // value or keep blocking with no way out.
          cleanup();
          stderr.write("\ncancelled\n");
          exit(130);
          return;
        }
        if (ch === "\r" || ch === "\n") {
          cleanup();
          resolve(buf);
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          buf = buf.slice(0, -1);
          continue;
        }
        if (ch === "\u0004") {
          // Ctrl-D: EOF. On an empty line that is "no value" (a blank
          // Enter); mid-line it is not a key this reader gives meaning to.
          if (buf.length === 0) {
            cleanup();
            resolve("");
            return;
          }
          continue;
        }
        buf += ch;
      }
    };
    stdin.on("data", onData);
  });
}

/** The TTY path: prompt on STDERR (never stdout, which `--json` reads), read one hidden line, then restore the cursor to its own line for whatever prints next. */
export async function promptHiddenLine(name: string, term: Terminal = { stdin: process.stdin, stderr: process.stderr }): Promise<string> {
  term.stderr.write(`Paste the value for ${name} and press Enter (input is hidden): `);
  const value = await readHiddenLine(term.stdin, term.stderr);
  term.stderr.write("\n");
  return value;
}

/**
 * A block of text that is neither secret nor one line — a request body, an
 * operating prompt. Piped, it is read to EOF as always. In a terminal a
 * silent read would sit waiting for a Ctrl-D nobody was told about, so it
 * says so first — on STDERR, never stdout, which `--json` and a pipeline
 * read — and then reads with the terminal's own echo on: unlike a token, a
 * body is something the owner wants to see as they type it.
 */
export async function readTextInput(what: string, terminal?: Terminal | null): Promise<string> {
  const term = terminal === undefined ? realTerminal() : (terminal ?? undefined); // `null` = a test's "no terminal"
  if (!term) return await readStdin();
  term.stderr.write(`Type or paste ${what}, then press Ctrl-D on an empty line to finish (what you type is shown):\n`);
  return await readStdin(term.stdin);
}

export interface ReadSecretValueOptions {
  /** test seam: where the value is read — stands in for both the pipe and the prompt, so a test never touches a real stream */
  readSecret?: (() => Promise<string>) | undefined;
  /** test seam: whether stdin is a terminal (default `process.stdin.isTTY`) */
  isTTY?: boolean | undefined;
}

/**
 * Where a secret's value comes from — the pipe or the hidden prompt — trimmed
 * and checked by core's `secretValueIssue` (empty, or a value that is clearly
 * something else). The refusal names stdin as the only way in; it never
 * repeats what was read.
 */
export async function readSecretValue(name: string, opts: ReadSecretValueOptions = {}): Promise<string> {
  const tty = opts.isTTY ?? process.stdin.isTTY === true;
  const read = opts.readSecret ?? (tty ? () => promptHiddenLine(name) : readStdin);
  const value = (await read()).trim();
  const issue = secretValueIssue(value);
  if (issue) throw new StepFailed(`${issue} — pipe the value for ${name} on stdin (it is never taken as an argument)`);
  return value;
}

/**
 * The refusal for a value that arrived as an ARGUMENT (`--token abc`, a
 * stray positional after the provider). Said without the value: the whole
 * point is that it must not be echoed anywhere, this message included.
 */
export function valueInArgvRefusal(what: string, example: string): string {
  return `${what} is never taken as an argument — it would land in shell history and in \`ps\`. Pipe it on stdin (\`${example}\`), or run the command in a terminal and paste it when asked (the input is hidden).`;
}
