// A fake terminal for the CLI's terminal reads (stdin-value.ts `Terminal`).
// `type()` is what the owner typing at it looks like to the hidden reader (a
// `data` event); `typeLine()`/`eof()` is what the cooked, echoing reader sees
// (an async-iterable stdin that ends on Ctrl-D). `stderr` records every
// prompt; nothing else a verb prints is routed here, so a test can say
// precisely what reached the terminal and what reached stdout.
import { EventEmitter } from "node:events";
import type { Terminal } from "../src/stdin-value.js";

export interface FakeTerminal extends Terminal {
  /** every chunk written to the terminal's stderr, in order */
  chunks: string[];
  /** stderr as one string */
  stderrText(): string;
  /** raw-mode transitions, to prove the terminal was left as found */
  raw: boolean[];
  /** the owner types `s` (delivered to a hidden reader as a `data` event, and queued for an iterating one) */
  type(s: string): void;
  /** Ctrl-D: end the iterating reader's input */
  eof(): void;
  /** how many times anything iterated the stdin (the echoing path) — 0 on the hidden path */
  iterations(): number;
}

export function fakeTerminal(): FakeTerminal {
  const emitter = new EventEmitter();
  const queue: string[] = [];
  let ended = false;
  let wake: (() => void) | undefined;
  let iterated = 0;
  const chunks: string[] = [];
  const raw: boolean[] = [];
  const stdin = Object.assign(emitter, {
    isRaw: false,
    setRawMode(m: boolean) {
      stdin.isRaw = m;
      raw.push(m);
    },
    resume() {},
    pause() {},
    setEncoding() {},
    async *[Symbol.asyncIterator](): AsyncGenerator<string> {
      iterated++;
      for (;;) {
        while (queue.length > 0) yield queue.shift()!;
        if (ended) return;
        await new Promise<void>((r) => (wake = r));
      }
    },
  });
  return {
    stdin: stdin as unknown as Terminal["stdin"],
    stderr: { write: (c: string) => chunks.push(c) },
    chunks,
    stderrText: () => chunks.join(""),
    raw,
    type(s) {
      emitter.emit("data", s);
      queue.push(s);
      wake?.();
    },
    eof() {
      ended = true;
      wake?.();
    },
    iterations: () => iterated,
  };
}
