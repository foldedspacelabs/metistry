// Reading a `security` call the way the real tool does, so a fake Keychain
// can answer it. A write is `security -i` with ONE command line on stdin
// (keychain.ts), so a fake that looked only at argv would see `["-i"]` and
// nothing else. `args` is what `security` executes; `argv` is the process's
// real argv — the thing `ps` shows, and the thing every "the value never
// travels in argv" assertion must be about.
import type { Exec, ExecOptions } from "../src/exec.js";

/**
 * security(1)'s interactive-mode tokenizer (SecurityTool's `split_line`):
 * whitespace separates arguments, `"…"` and `'…'` quote, and a backslash
 * escapes the next character inside or outside quotes. Enough of it to read
 * back what keychain.ts writes; the real tokenizer is exercised against a
 * scratch keychain in keychain.darwin.test.ts.
 */
export function splitSecurityLine(line: string): string[] {
  const out: string[] = [];
  let cur: string | undefined;
  let quote: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === "\\" && i + 1 < line.length) {
      cur = (cur ?? "") + line[++i];
    } else if (quote) {
      if (c === quote) quote = undefined;
      else cur = (cur ?? "") + c;
    } else if (c === '"' || c === "'") {
      quote = c;
      cur = cur ?? "";
    } else if (/\s/.test(c)) {
      if (cur !== undefined) out.push(cur);
      cur = undefined;
    } else {
      cur = (cur ?? "") + c;
    }
  }
  if (quote) throw new Error(`unterminated ${quote} in a security -i line`);
  if (cur !== undefined) out.push(cur);
  return out;
}

export interface SecurityCall {
  /** what `security` executes: argv, or for `security -i` the command line on stdin */
  args: string[];
  /** the process's real argv */
  argv: string[];
  /** a write's `-w` value, read from stdin — never from argv */
  value?: string;
}

export function decodeSecurity(argv: string[], opts: ExecOptions = {}): SecurityCall {
  if (argv[0] !== "-i") return { args: argv, argv };
  const lines = String(opts.stdin ?? "")
    .split("\n")
    .filter((l) => l !== "");
  if (lines.length !== 1) throw new Error(`security -i: expected exactly one command line on stdin, got ${lines.length}`);
  const args = splitSecurityLine(lines[0]!);
  const w = args.indexOf("-w");
  return { args, argv, ...(w >= 0 && w + 1 < args.length ? { value: args[w + 1]! } : {}) };
}

/**
 * A login Keychain in a Map, keyed by account and service, behind the `exec`
 * seam. `refuse` makes the write of one service fail the way a locked
 * Keychain does. `calls` is every `security` invocation, argv included, so a
 * test can prove a value never travelled there.
 */
export function fakeKeychain(seed: Record<string, string> = {}, refuse?: (service: string) => boolean) {
  const store = new Map(Object.entries(seed));
  const calls: Array<{ args: string[]; argv: string[] }> = [];
  const exec: Exec = async (cmd, argv, opts: ExecOptions = {}) => {
    const { args, value } = cmd === "security" ? decodeSecurity(argv, opts) : { args: argv, value: undefined };
    calls.push({ args, argv });
    const service = args[args.indexOf("-s") + 1] ?? "";
    const at = `${args[args.indexOf("-a") + 1] ?? ""}/${service}`;
    if (args[0] === "add-generic-password") {
      if (refuse?.(service)) return { code: 36, stdout: "", stderr: "User interaction is not allowed." };
      store.set(at, value ?? "");
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "find-generic-password") {
      if (!store.has(at)) return { code: 44, stdout: "", stderr: "not found" };
      return { code: 0, stdout: args.includes("-w") ? `${store.get(at)}\n` : "", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: `unexpected ${args[0]}` };
  };
  return { exec, store, calls };
}
