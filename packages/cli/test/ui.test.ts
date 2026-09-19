// The presentation layer's own tests (docs/ops/cli-style.md). Every one of
// these builds its own Ui with an explicit env and stream — the process's
// default Ui is `main()`'s to configure, and a test that read it would pass
// or fail on whether the suite happened to run in a terminal.
import { describe, expect, it } from "vitest";
import { ICONS, colorLevel, createUi, padTo, statusName, strip, supportsUnicode, terminalWidth, visibleWidth, MAX_WIDTH, MIN_WIDTH } from "../src/ui.js";

const tty = { write: () => true, isTTY: true, columns: 80 };
const pipe = { write: () => true, isTTY: false };
const utf8 = { LANG: "en_US.UTF-8" } as NodeJS.ProcessEnv;
const ascii = { LANG: "C" } as NodeJS.ProcessEnv;

describe("colour detection", () => {
  it("a TTY gets colour; a pipe never does", () => {
    expect(colorLevel({ stream: tty, env: utf8 })).toBe(1);
    expect(colorLevel({ stream: pipe, env: utf8 })).toBe(0);
    expect(createUi({ stream: pipe, env: utf8 }).strong("x")).toBe("x");
    expect(createUi({ stream: tty, env: utf8 }).strong("x")).toBe("[1mx[0m");
  });

  it("NO_COLOR, TERM=dumb and --no-color each turn it off on a TTY", () => {
    expect(colorLevel({ stream: tty, env: { ...utf8, NO_COLOR: "1" } })).toBe(0);
    expect(colorLevel({ stream: tty, env: { ...utf8, NO_COLOR: "" } })).toBe(1); // empty is not set (no-color.org)
    expect(colorLevel({ stream: tty, env: { ...utf8, TERM: "dumb" } })).toBe(0);
    expect(colorLevel({ stream: tty, env: utf8, noColor: true })).toBe(0);
  });

  it("FORCE_COLOR colours a pipe; FORCE_COLOR=0 does not", () => {
    expect(colorLevel({ stream: pipe, env: { ...utf8, FORCE_COLOR: "1" } })).toBe(1);
    expect(colorLevel({ stream: pipe, env: { ...utf8, FORCE_COLOR: "2" } })).toBe(2);
    expect(colorLevel({ stream: pipe, env: { ...utf8, FORCE_COLOR: "0" } })).toBe(0);
  });

  it("--json is never coloured, whatever the terminal or FORCE_COLOR says", () => {
    expect(colorLevel({ stream: tty, env: { ...utf8, FORCE_COLOR: "3" }, json: true })).toBe(0);
    const ui = createUi({ stream: tty, env: utf8, json: true });
    expect(ui.status("ok")).toBe(strip(ui.status("ok")));
    expect(ui.isTTY).toBe(false); // …so no spinner animates into the document either
  });

  it("a 256-colour terminal gets the 256-colour palette", () => {
    expect(colorLevel({ stream: tty, env: { ...utf8, TERM: "xterm-256color" } })).toBe(2);
    expect(colorLevel({ stream: tty, env: { ...utf8, COLORTERM: "truecolor" } })).toBe(2);
    expect(createUi({ stream: tty, env: { ...utf8, TERM: "xterm-256color" } }).paint("ok", "x")).toBe("[38;5;78mx[0m");
    expect(createUi({ stream: tty, env: { ...utf8, TERM: "xterm" } }).paint("ok", "x")).toBe("[32mx[0m");
  });
});

describe("icons", () => {
  it("UTF-8 locale gets the glyphs; anything else gets the ASCII fallbacks", () => {
    expect(supportsUnicode(utf8)).toBe(true);
    expect(supportsUnicode(ascii)).toBe(false);
    expect(supportsUnicode({ TERM_PROGRAM: "Apple_Terminal" })).toBe(true); // a Mac terminal that leaves LANG unset
    expect(supportsUnicode({ LANG: "en_US.UTF-8", TERM: "dumb" })).toBe(false);

    const u = createUi({ stream: pipe, env: utf8 });
    const a = createUi({ stream: pipe, env: ascii });
    expect([u.icon("ok"), u.icon("fail"), u.icon("warn")]).toEqual(["✓", "✗", "⚠"]);
    expect([a.icon("ok"), a.icon("fail"), a.icon("warn")]).toEqual(["[ok]", "[x]", "[!]"]);
    expect([a.icon("on"), a.icon("off"), a.icon("arrow"), a.icon("cycle")]).toEqual(["[*]", "[-]", "->", "[~]"]);
  });

  it("status icons are padded to one width, so a column of them lines up", () => {
    const a = createUi({ stream: pipe, env: ascii });
    const widths = new Set(["ok", "degraded", "failed", "absent"].map((s) => a.statusIcon(s).length));
    expect(widths).toEqual(new Set([4]));
    expect(a.status("degraded")).toBe("[!]  degraded");
  });

  it("the set is closed: seven icons, no emoji", () => {
    expect(Object.keys(ICONS)).toEqual(["ok", "fail", "warn", "on", "off", "arrow", "cycle"]);
    // one code point each, all below the emoji blocks — a glyph a monospace
    // font draws in one column, never a colour emoji that draws in two
    for (const { unicode } of Object.values(ICONS)) {
      expect([...unicode]).toHaveLength(1);
      expect(unicode.codePointAt(0)).toBeLessThan(0x1f000);
    }
  });
});

describe("the status vocabulary", () => {
  it("every word a verb prints maps onto one of the five", () => {
    expect(statusName("ok")).toBe("ok");
    expect(statusName("HEALTHY")).toBe("ok");
    expect(statusName("degraded")).toBe("degraded");
    expect(statusName("failed")).toBe("failed");
    expect(statusName("skipped")).toBe("skipped");
    expect(statusName("absent")).toBe("n/a");
    expect(statusName("something nobody defined")).toBe("n/a");
  });

  it("the verb keeps its own word; only the colour comes from the vocabulary", () => {
    const ui = createUi({ stream: tty, env: utf8 });
    expect(strip(ui.status("absent"))).toBe("○ absent");
    expect(ui.status("absent")).toContain("[");
  });
});

describe("layout", () => {
  const ui = createUi({ stream: pipe, env: utf8 });

  it("kv aligns the values into one column", () => {
    expect(ui.kv([["cli", "0.9.0"], ["runtime pack", "0.9.0"]]).split("\n")).toEqual(["  cli           0.9.0", "  runtime pack  0.9.0"]);
  });

  it("kv wraps a long value under its own column, never past the right edge", () => {
    const narrow = createUi({ stream: { write: () => true, isTTY: true, columns: 60 }, env: utf8 });
    const lines = narrow
      .kv([["doctor", "validate every manifest and probe every bridge, service, container and launchd job"]])
      .split("\n")
      .map(strip);
    expect(lines.every((l) => l.length <= 60)).toBe(true);
    expect(lines[0]).toBe("  doctor  validate every manifest and probe every bridge,");
    expect(lines.slice(1).every((l) => l.startsWith(" ".repeat(10)))).toBe(true);
  });

  it("a table has a header rule and aligned columns", () => {
    const lines = ui.table(["service", "shape"], [["db", "launchd"], ["console", "compose"]]).split("\n");
    expect(lines).toEqual(["service  shape", "───────  ───────", "db       launchd", "console  compose"]);
  });

  it("colour does not change a column's width: padding measures the plain text", () => {
    const c = createUi({ stream: tty, env: utf8 });
    const plain = ui.table(["a", "b"], [["x", "y"], ["longer", "z"]]);
    expect(strip(c.table(["a", "b"], [[c.paint("ok", "x"), "y"], ["longer", "z"]]))).toBe(plain);
  });

  it("the last column is ragged: free text is never padded into a wall of spaces", () => {
    expect(ui.table(["a", "b"], [["x", "y"]]).split("\n").at(-1)).toBe("x  y");
  });

  it("wrap folds at the terminal width and hangs the continuation", () => {
    const text = "the reconciler is the instance repo's sole committer and will otherwise sweep this migration into commits of its own halfway through";
    const narrow = createUi({ stream: { write: () => true, isTTY: true, columns: 40 }, env: utf8 });
    const lines = narrow.wrap(text, { indent: 2, hanging: 6 }).split("\n");
    expect(lines.every((l) => l.length <= MIN_WIDTH)).toBe(true); // 40 clamps up to the 60 floor
    expect(lines[0]?.startsWith("  the")).toBe(true);
    expect(lines.slice(1).every((l) => l.startsWith("      "))).toBe(true);
    expect(lines.join(" ").split(/\s+/).filter(Boolean)).toEqual(text.split(" "));
  });

  it("width is clamped to [60, 100] whatever the terminal says", () => {
    expect(terminalWidth({ stream: { write: () => true, columns: 30 } })).toBe(MIN_WIDTH);
    expect(terminalWidth({ stream: { write: () => true, columns: 400 } })).toBe(MAX_WIDTH);
    expect(terminalWidth({ stream: { write: () => true, columns: 88 } })).toBe(88);
    expect(terminalWidth({ stream: { write: () => true } })).toBe(80); // not a terminal: the conventional 80
  });

  it("visibleWidth and padTo ignore the colour codes", () => {
    const c = createUi({ stream: tty, env: utf8 });
    expect(visibleWidth(c.dim("abc"))).toBe(3);
    expect(strip(padTo(c.dim("abc"), 6))).toBe("abc   ");
  });
});

describe("spinner", () => {
  it("animates on a TTY and ends with one line", () => {
    const written: string[] = [];
    const lines: string[] = [];
    const ui = createUi({ stream: { write: (s) => void written.push(s), isTTY: true, columns: 80 }, env: utf8 });
    const s = ui.spinner("probing", (l) => lines.push(l));
    s.update("probing 24 checks");
    s.succeed("24 checks in 1.2s");
    expect(written.length).toBeGreaterThan(0); // frames, each rewriting the line
    expect(written.every((w) => w.startsWith("\r") || w === "")).toBe(true);
    expect(lines).toEqual([`${ui.paint("ok", "✓")} 24 checks in 1.2s`]);
  });

  it("a pipe gets no animation at all — just the one final line", () => {
    const written: string[] = [];
    const lines: string[] = [];
    const ui = createUi({ stream: { write: (s) => void written.push(s), isTTY: false }, env: utf8 });
    const s = ui.spinner("probing", (l) => lines.push(l));
    s.update("still probing");
    s.fail("docker not found");
    expect(written).toEqual([]);
    expect(lines).toEqual(["✗ docker not found"]);
  });

  it("stop() prints nothing: the caller renders its own final line", () => {
    const lines: string[] = [];
    const ui = createUi({ stream: pipe, env: utf8 });
    ui.spinner("probing", (l) => lines.push(l)).stop();
    expect(lines).toEqual([]);
  });
});
