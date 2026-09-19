# CLI output style

`packages/cli/src/ui.ts` is the CLI's whole presentation layer — colour,
icons, spinners, alignment, wrapping — and this is the guide it implements.
It is hand-rolled: a handful of SGR codes and a `padEnd` do not justify a
dependency this project would maintain for years (CLAUDE.md), the same
argument that already made `parseArgs` and the router local.

The point is not decoration. `metistry doctor` is read at the moment
something is wrong, `metistry update` while a machine is half-upgraded. What
those want is a shape the eye can skim: one status per row, one colour per
status, the noise dimmed and the answer not.

## The rules

1. **Colour is decoration, never information.** Every line reads the same
   with `NO_COLOR=1`. The status word is always spelled out beside its icon;
   nothing is distinguished by hue alone. (Also what makes the output
   accessible to anyone who cannot separate red from green.)
2. **Never colour machine output.** `--json` turns colour off at the source
   (`createUi({ json: true })`), so a `--json` document is byte-identical
   whether it goes to a terminal, a pipe or the Mac app's subprocess reader.
   The Mac app parses several of these (`apps/macos/sources/kit/compute-model.swift`);
   an escape sequence in that stream is a bug, not a style question.
3. **Colour only when the terminal wants it.** In order:
   `--json` → off, `--no-color` → off, `NO_COLOR` (non-empty) → off,
   `TERM=dumb` → off, `FORCE_COLOR` (anything but `0`) → on, stdout is not a
   TTY → off, otherwise on. `FORCE_COLOR=2` or a `TERM`/`COLORTERM` naming
   256 colours picks the 256-colour palette; everything else uses the 16
   ANSI ones.
4. **One icon per status, from `ICONS` and nowhere else.**

   | icon | ASCII  | means |
   | ---- | ------ | ----- |
   | `✓`  | `[ok]` | ok |
   | `✗`  | `[x]`  | failed |
   | `⚠`  | `[!]`  | degraded |
   | `●`  | `[*]`  | running / present |
   | `○`  | `[-]`  | not running / skipped / n/a |
   | `→`  | `->`   | a move, a remediation, "becomes" |
   | `↻`  | `[~]`  | restarted, retried, in flight |

   **No emoji beyond this set.** This output is read in Terminal, in a
   launchd log and pasted into a GitHub issue. A terminal whose locale is not
   UTF-8 (`LC_ALL`/`LC_CTYPE`/`LANG` says nothing about UTF-8, and
   `TERM_PROGRAM` is not a Mac terminal we know) gets the ASCII column —
   unknown means ASCII, because a replacement box is worse than `[ok]`.
5. **A closed status vocabulary, one colour each.**

   | word | colour | meaning |
   | --- | --- | --- |
   | `ok` | green | it works |
   | `degraded` | amber | it runs and needs a hand — never an exit code of its own |
   | `failed` | red | it does not work |
   | `skipped` | blue | deliberately not done (`--skip-build`, `--dry-run`) |
   | `n/a` | grey | not knowable here (no db configured, a launchd job on Linux) |

   `absent` and `unknown` are spellings of `n/a`; `healthy`, `running` and
   `pass` are spellings of `ok` (`ui.ts` STATUS_ALIASES). A verb keeps its own
   word in the text and borrows the colour — `doctor` still prints `absent`,
   because that is what its `--json` says.
6. **Secondary text is dimmed, never dropped.** Remediation, paths, counts,
   the command behind a step, a table's header and rule. Dimming is how the
   answer gets to be the bright thing on the screen.
7. **Deprecation notices are dimmed and printed once, at the end.** A notice
   about a fallback `.env` is not what you asked the command; it goes to
   stderr after the output it qualifies, once, dimmed
   (`main()` collects `LoadedEnv.notices` and flushes them in a `finally`).
8. **Wrap prose at the terminal's width, clamped to [60, 100].** Tables and
   key/value blocks align on the *plain* text (`padTo` measures with the
   colour codes stripped), so a coloured cell is the same width as an
   uncoloured one.
9. **A spinner animates only on a TTY.** Everywhere else the step prints one
   final line — and it is the same line the TTY ends up showing, so a
   redirected log and a watched terminal say the same thing. Spinners never
   hold the event loop open (`unref`), and never wrap a step whose child
   process inherits stdout.

## Using it

```ts
import { createUi, defaultUi } from "./ui.js";

const ui = configureUi({ json: flags.json === true, noColor: flags["no-color"] === true });

ui.heading("db");
ui.status("degraded");                     // ⚠ degraded, in amber
ui.kv([["cli", "0.9.0"], ["lock", "0.9.0 (git)"]]);
ui.table(["service", "shape"], rows);      // header + rule, aligned
ui.wrap(prose, { indent: 4 });
ui.note("…is deprecated");                 // dimmed
const s = ui.spinner("probing 24 checks", out);
s.succeed("24 checks in 1.2s");
```

Render functions take a `Ui` as their last argument, defaulting to
`defaultUi()` — the one `main()` configured from the flags. Tests build their
own with `createUi({ env, stream })` and never touch the default;
`resetUi()` exists for the one test that wants to.

## What is NOT in here

No progress bars, no boxes, no full-screen redraw, no alternate screen
buffer, no hyperlinks. A CLI that repaints is a CLI whose output cannot be
piped, and every verb here is something the Mac app or a script may run
instead of a person.
