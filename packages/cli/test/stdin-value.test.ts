// X-127: every terminal read in the CLI behaves like `secrets set` — a token
// is read hidden, a body or a prompt says how it ends, and a pipe is read to
// EOF as it always was. The readers themselves (stdin-value.ts); the verbs
// that call them are tested beside each verb (connect-repo, console-client,
// agents).
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { promptHiddenLine, readStdin, readTextInput } from "../src/stdin-value.js";
import { fakeTerminal } from "./fake-terminal.js";

describe("readStdin — a pipe is read to EOF and trimmed", () => {
  it("joins chunks and drops the trailing newline", async () => {
    expect(await readStdin(Readable.from([Buffer.from('{"a":'), Buffer.from("1}\n")]))).toBe('{"a":1}');
  });
  it("takes string chunks too (a terminal's cooked stdin may hand them)", async () => {
    expect(await readStdin(Readable.from(["a ", "b\n"]))).toBe("a b");
  });
});

describe("readTextInput — a body or a prompt: neither secret nor one line", () => {
  it("piped (no terminal): reads to EOF and writes no prompt anywhere", async () => {
    const real = process.stdin;
    // `null` is "no terminal": the piped path reads the process's own stdin, which this test replaces for its duration
    Object.defineProperty(process, "stdin", { value: Readable.from(["piped body\n"]), configurable: true });
    try {
      expect(await readTextInput("the request body", null)).toBe("piped body");
    } finally {
      Object.defineProperty(process, "stdin", { value: real, configurable: true });
    }
  });

  it("in a terminal: says on STDERR that input ends with Ctrl-D, keeps the echo (never raw mode), and returns what was typed", async () => {
    const t = fakeTerminal();
    const p = readTextInput("the request body", t);
    t.type('{"a":1}\n');
    t.type("\n");
    t.eof();
    expect(await p).toBe('{"a":1}');
    expect(t.stderrText()).toContain("Ctrl-D");
    expect(t.stderrText()).toContain("the request body");
    expect(t.stderrText()).not.toContain('{"a":1}'); // the prompt never repeats what was typed
    expect(t.raw).toEqual([]); // the terminal's own echo was left on
  });
});

describe("promptHiddenLine on a terminal — what a token takes", () => {
  it("prompts on stderr, reads one line with raw mode on, and never echoes a typed character", async () => {
    const t = fakeTerminal();
    const p = promptHiddenLine("the GitHub token", t);
    t.type("ghp_");
    t.type("secret\n");
    expect(await p).toBe("ghp_secret");
    expect(t.stderrText()).toContain("the GitHub token");
    expect(t.stderrText()).not.toContain("ghp_");
    expect(t.raw).toEqual([true, false]);
    expect(t.iterations()).toBe(0); // it never read the stream to EOF — a terminal never sends one
  });
});
