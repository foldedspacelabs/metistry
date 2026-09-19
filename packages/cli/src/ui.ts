// The CLI's whole presentation layer: colour, icons, spinners, alignment and
// wrapping. Hand-rolled — a handful of SGR codes and a `padEnd` do not
// justify a dependency this project would maintain for years (CLAUDE.md),
// and the same argument already made `parseArgs` and the router local.
//
// ---- style guide (docs/ops/cli-style.md is the long form) -----------------
//
//  1. Colour is decoration, never information. Every line reads the same
//     with `NO_COLOR=1`: the status word is always spelled out beside its
//     icon, and nothing is distinguished by hue alone.
//  2. Never colour machine output. `--json` turns colour off at the source
//     (`createUi({ json: true })`), so a redirected `--json` document and a
//     TTY one are byte-identical.
//  3. Colour only when stdout is a terminal that wants it: not a TTY,
//     `NO_COLOR`, `TERM=dumb` or `--no-color` all mean plain text.
//     `FORCE_COLOR` is the override for a pipe that is really a terminal.
//  4. One icon per status, from ICONS and nowhere else. No emoji: this
//     output is read in Terminal, in a launchd log and in a GitHub issue.
//     A terminal whose locale is not UTF-8 gets `[ok] [x] [!]` instead.
//  5. Status words are a closed vocabulary — ok, degraded, failed, skipped,
//     n/a — with one colour each. `absent` and `unknown` are spellings of
//     `n/a`; a verb keeps its own word in the text and borrows the colour.
//  6. Secondary text is dimmed, never dropped: remediation, paths, counts,
//     the command behind a step.
//  7. Deprecation notices are dimmed and printed ONCE, after the output
//     they qualify — never as the first thing on the screen.
//  8. Wrap prose at the terminal's width, clamped to [60, 100]. Tables and
//     key/value blocks align on the plain text, so a coloured cell is the
//     same width as an uncoloured one.
//  9. A spinner animates only on a TTY. Everywhere else the step prints one
//     final line, and that line is the same one the TTY ends up showing.

/** The sink a spinner animates on. `process.stdout` satisfies it. */
export interface UiStream {
  write(s: string): unknown;
  isTTY?: boolean | undefined;
  columns?: number | undefined;
}

export interface CreateUiOptions {
  stream?: UiStream | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  /** the verb is printing a machine-readable document: colour off, unconditionally */
  json?: boolean | undefined;
  /** `--no-color` */
  noColor?: boolean | undefined;
}

/** 0 = plain text, 1 = the 16 ANSI colours, 2 = the 256-colour palette. */
export type ColorLevel = 0 | 1 | 2;

/** The closed status vocabulary (style guide 5). */
export type StatusName = "ok" | "degraded" | "failed" | "skipped" | "n/a";

/** Every word a verb may report, mapped onto the five that have a colour. */
const STATUS_ALIASES: Record<string, StatusName> = {
  ok: "ok",
  healthy: "ok",
  running: "ok",
  pass: "ok",
  degraded: "degraded",
  warn: "degraded",
  pending: "degraded",
  failed: "failed",
  fail: "failed",
  error: "failed",
  skipped: "skipped",
  dry_run: "skipped",
  absent: "n/a",
  unknown: "n/a",
  "n/a": "n/a",
};

/** The word a verb printed, in the vocabulary — `n/a` for anything unrecognised, never a guess at a colour. */
export function statusName(word: string): StatusName {
  return STATUS_ALIASES[word.trim().toLowerCase()] ?? "n/a";
}

/** Semantic roles only — no call site names a hue (docs/product/design/tokens.json takes the same line). */
export type Role = StatusName | "heading" | "key" | "accent";

const PALETTE: Record<Role, { basic: number; xterm: number }> = {
  ok: { basic: 32, xterm: 78 },
  degraded: { basic: 33, xterm: 179 },
  failed: { basic: 31, xterm: 203 },
  skipped: { basic: 34, xterm: 110 },
  "n/a": { basic: 90, xterm: 245 },
  heading: { basic: 36, xterm: 81 },
  key: { basic: 90, xterm: 245 },
  accent: { basic: 36, xterm: 81 },
};

export type IconName = "ok" | "fail" | "warn" | "on" | "off" | "arrow" | "cycle";

/** The whole icon set (style guide 4), each with the ASCII a non-UTF-8 terminal gets. */
export const ICONS: Record<IconName, { unicode: string; ascii: string }> = {
  ok: { unicode: "✓", ascii: "[ok]" },
  fail: { unicode: "✗", ascii: "[x]" },
  warn: { unicode: "⚠", ascii: "[!]" },
  on: { unicode: "●", ascii: "[*]" },
  off: { unicode: "○", ascii: "[-]" },
  arrow: { unicode: "→", ascii: "->" },
  cycle: { unicode: "↻", ascii: "[~]" },
};

const STATUS_ICON: Record<StatusName, IconName> = {
  ok: "ok",
  degraded: "warn",
  failed: "fail",
  skipped: "off",
  "n/a": "off",
};

/** Widest icon in the set, so a status column lines up whichever spelling is in use. */
const ICON_WIDTH = { unicode: 1, ascii: 4 };

const ANSI_RE = /\[[0-9;]*m/g;

/** The text without its colour codes — what every width calculation measures. */
export function strip(s: string): string {
  return s.replace(ANSI_RE, "");
}

/**
 * Printable width: the colour codes do not take a column, and every icon in
 * ICONS is one column in a monospace terminal, so counting code points
 * (never UTF-16 units — `"✓".length` is 1 but an astral character's is 2) is
 * the whole calculation.
 */
export function visibleWidth(s: string): number {
  return [...strip(s)].length;
}

/** `padEnd` that measures the plain text, so a coloured cell is the same width as an uncoloured one. */
export function padTo(s: string, width: number): string {
  const pad = width - visibleWidth(s);
  return pad > 0 ? s + " ".repeat(pad) : s;
}

/**
 * Whether to colour, and how richly.
 *
 * Order matters and is the style guide's: a machine-readable document and an
 * explicit opt-out beat everything, then the terminal's own capabilities,
 * and `FORCE_COLOR` is the escape hatch for a pipe that really is a terminal
 * (a CI log, `less -R`, the before/after captures in a PR).
 */
export function colorLevel(opts: CreateUiOptions = {}): ColorLevel {
  const env = opts.env ?? process.env;
  if (opts.json === true) return 0;
  if (opts.noColor === true) return 0;
  if (typeof env.NO_COLOR === "string" && env.NO_COLOR !== "") return 0;
  if (env.TERM === "dumb") return 0;
  const force = env.FORCE_COLOR;
  if (typeof force === "string" && force !== "") {
    if (force === "0" || force === "false") return 0;
    return force === "2" || force === "3" ? 2 : rich(env) ? 2 : 1;
  }
  if (opts.stream?.isTTY !== true) return 0;
  return rich(env) ? 2 : 1;
}

function rich(env: NodeJS.ProcessEnv): boolean {
  return /256|truecolor|direct/i.test(env.COLORTERM ?? "") || /256color|truecolor|kitty|alacritty|ghostty/i.test(env.TERM ?? "");
}

/**
 * Whether the terminal will render ✓ rather than a replacement box.
 *
 * The locale is the only portable answer; `TERM_PROGRAM` covers the Macs
 * that leave `LANG` unset (a launchd-spawned shell does). Unknown means
 * ASCII — a wrong box is worse than a plain `[ok]`.
 */
export function supportsUnicode(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.TERM === "dumb") return false;
  if (/UTF-?8/i.test(env.LC_ALL ?? env.LC_CTYPE ?? env.LANG ?? "")) return true;
  return env.TERM_PROGRAM === "Apple_Terminal" || env.TERM_PROGRAM === "iTerm.app" || env.TERM_PROGRAM === "vscode" || env.TERM_PROGRAM === "ghostty";
}

/** Prose is wrapped here; narrower than 60 is unreadable, wider than 100 is a wall. */
export const MIN_WIDTH = 60;
export const MAX_WIDTH = 100;

export function terminalWidth(opts: CreateUiOptions = {}): number {
  const env = opts.env ?? process.env;
  const raw = opts.stream?.columns ?? (env.COLUMNS ? Number(env.COLUMNS) : undefined);
  const n = Number.isFinite(raw) && (raw as number) > 0 ? (raw as number) : 80;
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.floor(n)));
}

export interface Spinner {
  /** change the label without ending the step */
  update(label: string): void;
  /** stop the animation and print one `✓ <label>` line */
  succeed(label?: string): void;
  /** stop the animation and print one `✗ <label>` line */
  fail(label?: string): void;
  /** stop the animation and print nothing (the caller prints its own line) */
  stop(): void;
}

export interface TableOptions {
  /** column indexes that are NOT padded (the last free-text column, usually) */
  ragged?: number[] | undefined;
  /** spaces between columns */
  gap?: number | undefined;
  indent?: number | undefined;
}

export interface KvOptions {
  indent?: number | undefined;
  gap?: number | undefined;
}

export interface Ui {
  readonly level: ColorLevel;
  readonly color: boolean;
  readonly unicode: boolean;
  readonly width: number;
  readonly isTTY: boolean;

  /** paint `text` in a semantic role; the text itself is never changed */
  paint(role: Role, text: string): string;
  strong(text: string): string;
  dim(text: string): string;
  /** a section heading: `preflight`, `manifests`, `db` */
  heading(text: string): string;
  icon(name: IconName): string;
  /** the status icon, padded so a column of them lines up */
  statusIcon(word: string): string;
  /** `✓ ok` / `[!] degraded` — the icon and the verb's own word, coloured together */
  status(word: string): string;
  /** aligned two columns: keys dimmed, values as given */
  kv(rows: Array<[string, string]>, opts?: KvOptions): string;
  /** a table with a header rule */
  table(head: string[], rows: string[][], opts?: TableOptions): string;
  /** a paragraph wrapped at the terminal width, optionally hanging-indented */
  wrap(text: string, opts?: { indent?: number | undefined; hanging?: number | undefined }): string;
  /** a horizontal rule `width` wide (or the terminal's width) */
  rule(width?: number): string;
  /** one dimmed secondary line (a deprecation, a hint) */
  note(text: string): string;
  /** a long step: animated on a TTY, one final line everywhere */
  spinner(label: string, out?: (line: string) => void): Spinner;
}

const FRAMES_UNICODE = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FRAMES_ASCII = ["-", "\\", "|", "/"];
const FRAME_MS = 90;

export function createUi(opts: CreateUiOptions = {}): Ui {
  const env = opts.env ?? process.env;
  const stream = opts.stream;
  const level = colorLevel({ ...opts, env });
  const color = level > 0;
  const unicode = supportsUnicode(env);
  const width = terminalWidth({ ...opts, env });
  const isTTY = stream?.isTTY === true && opts.json !== true;
  const iconWidth = unicode ? ICON_WIDTH.unicode : ICON_WIDTH.ascii;

  const sgr = (open: string, text: string): string => (color ? `[${open}m${text}[0m` : text);
  const paint = (role: Role, text: string): string => {
    if (!color) return text;
    const p = PALETTE[role];
    return sgr(level === 2 ? `38;5;${p.xterm}` : String(p.basic), text);
  };
  const dim = (text: string): string => sgr("2", text);
  const strong = (text: string): string => sgr("1", text);
  const icon = (name: IconName): string => (unicode ? ICONS[name].unicode : ICONS[name].ascii);

  const statusIcon = (word: string): string => {
    const name = statusName(word);
    return paint(name, padTo(icon(STATUS_ICON[name]), iconWidth));
  };
  const status = (word: string): string => {
    const name = statusName(word);
    return `${statusIcon(word)} ${paint(name, word)}`;
  };

  const kv = (rows: Array<[string, string]>, o: KvOptions = {}): string => {
    const indent = " ".repeat(o.indent ?? 2);
    const gap = " ".repeat(o.gap ?? 2);
    const w = Math.max(0, ...rows.map(([k]) => visibleWidth(k)));
    return rows.map(([k, v]) => `${indent}${padTo(paint("key", k), w)}${gap}${v}`.trimEnd()).join("\n");
  };

  const table = (head: string[], rows: string[][], o: TableOptions = {}): string => {
    const indent = " ".repeat(o.indent ?? 0);
    const gap = " ".repeat(o.gap ?? 2);
    const ragged = new Set(o.ragged ?? [head.length - 1]);
    const widths = head.map((h, i) => Math.max(visibleWidth(h), ...rows.map((r) => visibleWidth(r[i] ?? ""))));
    const line = (cells: string[], pad: (s: string, i: number) => string) =>
      `${indent}${cells.map((c, i) => (ragged.has(i) ? c : pad(c, i))).join(gap)}`.trimEnd();
    const bar = unicode ? "─" : "-";
    return [
      line(head.map((h) => dim(h)), (c, i) => padTo(c, widths[i] ?? 0)),
      line(
        widths.map((w) => dim(bar.repeat(w))),
        (c, i) => padTo(c, widths[i] ?? 0),
      ),
      ...rows.map((r) => line(r, (c, i) => padTo(c, widths[i] ?? 0))),
    ].join("\n");
  };

  const wrap = (text: string, o: { indent?: number | undefined; hanging?: number | undefined } = {}): string => {
    const first = " ".repeat(o.indent ?? 0);
    const rest = " ".repeat(o.hanging ?? o.indent ?? 0);
    const limit = Math.max(20, width - Math.max(first.length, rest.length));
    const out: string[] = [];
    for (const paragraph of text.split("\n")) {
      let line = "";
      for (const word of paragraph.split(/\s+/).filter((w) => w !== "")) {
        if (line === "") line = word;
        else if (visibleWidth(line) + 1 + visibleWidth(word) <= limit) line += ` ${word}`;
        else {
          out.push(line);
          line = word;
        }
      }
      out.push(line);
    }
    return out.map((l, i) => `${i === 0 ? first : rest}${l}`.trimEnd()).join("\n");
  };

  const rule = (w?: number): string => dim((unicode ? "─" : "-").repeat(Math.max(1, w ?? width)));
  const note = (text: string): string => dim(text);
  const heading = (text: string): string => strong(paint("heading", text));

  const spinner = (label: string, outLine?: (line: string) => void): Spinner => {
    const print = outLine ?? ((l: string) => void stream?.write(`${l}\n`));
    let text = label;
    let timer: ReturnType<typeof setInterval> | undefined;
    let frame = 0;
    const frames = unicode ? FRAMES_UNICODE : FRAMES_ASCII;
    const clear = () => {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      if (stream && isTTY) stream.write("\r[2K");
    };
    const draw = () => {
      if (!stream) return;
      const f = frames[frame++ % frames.length] ?? "";
      stream.write(`\r[2K${paint("accent", f)} ${dim(text)}`);
    };
    if (isTTY && stream) {
      draw();
      timer = setInterval(draw, FRAME_MS);
      // never the reason a command's process stays alive
      (timer as unknown as { unref?: () => void }).unref?.();
    }
    const finish = (name: IconName, role: Role, l?: string) => {
      clear();
      print(`${paint(role, padTo(icon(name), iconWidth))} ${l ?? text}`);
    };
    return {
      update(l: string) {
        text = l;
        if (isTTY) draw();
      },
      succeed(l?: string) {
        finish("ok", "ok", l);
      },
      fail(l?: string) {
        finish("fail", "failed", l);
      },
      stop() {
        clear();
      },
    };
  };

  return { level, color, unicode, width, isTTY, paint, strong, dim, heading, icon, statusIcon, status, kv, table, wrap, rule, note, spinner };
}

// ---- the process's one Ui --------------------------------------------------
//
// `main()` sets it from the parsed flags before anything renders, so every
// helper that is handed no Ui of its own (StepRunner, a render function
// called from `up`) still honours `--json` and `--no-color`. Explicit is
// better where a seam already exists: the render functions all take a Ui.

let current: Ui | undefined;

/** Fix the process's default Ui from the flags `main()` parsed. Returns it. */
export function configureUi(opts: CreateUiOptions = {}): Ui {
  current = createUi({ stream: opts.stream ?? process.stdout, ...opts });
  return current;
}

/** The default Ui: whatever `configureUi` last set, else one detected from `process.stdout`. */
export function defaultUi(): Ui {
  return (current ??= createUi({ stream: process.stdout }));
}

/** Tests only: forget the configured default. */
export function resetUi(): void {
  current = undefined;
}
