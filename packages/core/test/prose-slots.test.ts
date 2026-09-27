// A routine's prose slots and the one way they are filled (C103, T3-6):
// `fillProseSlots` is what `knowledge_write` runs on a file in a routine's
// own folder, so every refusal here is a door the assistant cannot use.
import { describe, expect, it } from "vitest";
import { MAX_PROSE_LINE_CHARS, PROSE_PENDING, fillProseSlots, pendingProseSlots, proseMarker, writtenMarker } from "../src/prose-slots.js";

const FILE = [
  "---",
  "source: morning-brief",
  "---",
  "# Morning Brief — 2026-09-28",
  "",
  `${proseMarker(1)} ${PROSE_PENDING}`,
  "",
  "## Next Up",
  "",
  "- 9:30 AM–10:00 AM · Design review · with Jim Fallon",
  `  - ${proseMarker(2)} ${PROSE_PENDING}`,
  "",
  "<!-- rendered by morning-brief from Templates/Brief.md (sha256 abc…) at 2026-09-28T11:00Z by metistry-template/1 -->",
  "",
].join("\n");

/** FILE with slot lines replaced as the assistant would. */
function withSlots(fills: Record<number, string>, base = FILE): string {
  return base
    .split("\n")
    .map((line) => {
      for (const [n, text] of Object.entries(fills)) {
        const marker = proseMarker(Number(n));
        if (line.includes(marker)) return `${line.slice(0, line.indexOf(marker))}${text}`;
      }
      return line;
    })
    .join("\n");
}

describe("pendingProseSlots", () => {
  it("finds each marker line with the bytes before it", () => {
    expect(pendingProseSlots(FILE)).toEqual([
      { index: 1, line: 5, prefix: "" },
      { index: 2, line: 10, prefix: "  - " },
    ]);
  });

  it("a number on two lines, two markers on one line, or a mangled marker is no slot at all", () => {
    const dup = `${FILE}\n${proseMarker(1)} again\n`;
    expect(pendingProseSlots(dup).map((s) => s.index)).toEqual([2]);
    expect(pendingProseSlots(`${proseMarker(3)} ${proseMarker(4)}\n`)).toEqual([]);
    expect(pendingProseSlots("<!--metistry:prose 5--> x\n<!-- metistry:prose 05 --> y\n<!-- Metistry:prose 6 -->\n")).toEqual([]);
  });
});

describe("fillProseSlots — only the pending lines, one line of prose each", () => {
  it("fills slots, keeps each prefix, and marks the words written — built from the checked text, not taken whole", () => {
    const out = fillProseSlots(FILE, withSlots({ 1: "Four things today; the lease comparables moved.", 2: "Bring the Q3 numbers — Jim asked last week." }));
    expect(out).toEqual({ ok: true, content: expect.any(String), filled: [1, 2] });
    if (!out.ok) return;
    const lines = out.content.split("\n");
    expect(lines[5]).toBe(`Four things today; the lease comparables moved. ${writtenMarker(1)}`);
    expect(lines[10]).toBe(`  - Bring the Q3 numbers — Jim asked last week. ${writtenMarker(2)}`);
    // every other line is the file's, byte for byte
    expect(lines.filter((_, i) => i !== 5 && i !== 10)).toEqual(FILE.split("\n").filter((_, i) => i !== 5 && i !== 10));
    // a filled slot is no longer pending: nothing can fill it twice
    expect(pendingProseSlots(out.content)).toEqual([]);
    expect(fillProseSlots(out.content, out.content)).toEqual({ ok: false, message: expect.stringContaining("no pending prose slot") });
  });

  it("the marker may be kept or dropped; a slot left alone stays pending", () => {
    const out = fillProseSlots(FILE, withSlots({ 2: `${proseMarker(2)} One line.` }));
    expect(out).toMatchObject({ ok: true, filled: [2] });
    if (out.ok) expect(pendingProseSlots(out.content).map((s) => s.index)).toEqual([1]);
  });

  it("**refuses any change outside a pending slot** — frontmatter, a heading, a meeting line, the footer", () => {
    for (const [from, to] of [
      ["source: morning-brief", "source: assistant"],
      ["## Next Up", "## Next Up (edited)"],
      ["- 9:30 AM–10:00 AM · Design review · with Jim Fallon", "- 9:30 AM–10:00 AM · Design review · cancelled"],
      ["<!-- rendered by", "<!-- written by"],
    ] as const) {
      const out = fillProseSlots(FILE, withSlots({ 1: "Fine." }).replace(from, to));
      expect(out.ok, to).toBe(false);
      if (!out.ok) expect(out.message).toMatch(/is not a pending prose slot/);
    }
  });

  it("refuses a different number of lines — a slot is one line, and nothing may be added or removed", () => {
    expect(fillProseSlots(FILE, withSlots({ 1: "Two\nlines." }))).toMatchObject({ ok: false, message: expect.stringContaining("lines") });
    expect(fillProseSlots(FILE, `${withSlots({ 1: "Fine." })}- [ ] a task I made up\n`)).toMatchObject({ ok: false });
    expect(fillProseSlots(FILE, withSlots({ 1: "Fine." }).replace("## Next Up\n", ""))).toMatchObject({ ok: false });
  });

  it("refuses a slot line that drops what came before its marker", () => {
    expect(fillProseSlots(FILE, withSlots({ 2: "x" }).replace("  - x", "x"))).toMatchObject({ ok: false, message: expect.stringContaining("must keep what comes before its marker") });
  });

  it("refuses slot text that would reshape the file: a block, a task box, a comment, a control character, the placeholder, too long", () => {
    const bad: [string, RegExp][] = [
      ["# A heading", /starts a block/],
      ["## Next Up", /starts a block/],
      ["> a quote", /starts a block/],
      ["- a list item", /starts a block/],
      ["1. a numbered item", /starts a block/],
      ["[ ] a task box", /starts a block/],
      ["[x] done", /starts a block/],
      ["```", /starts a block/],
      ["~~~js", /starts a block/],
      ["---", /starts a block/],
      ["| a | table |", /starts a block/],
      ["<div>html</div>", /starts a block/],
      ["=====", /starts a block/],
      ["fine <!-- metistry:prose 9 --> sneaky", /HTML comment/],
      ["closes a comment -->", /HTML comment/],
      ["<!-- /metistry:day -->", /HTML comment|starts a block/],
      ["tab\tis fine but a \u0000 is not", /control character/],
      ["a line\u2028separator", /control character/],
      ["_pending — written on this file's one assistant turn_", /placeholder/],
      ["x".repeat(MAX_PROSE_LINE_CHARS + 1), /characters/],
    ];
    for (const [text, why] of bad) {
      for (const slot of [1, 2]) {
        const out = fillProseSlots(FILE, withSlots({ [slot]: text }));
        expect(out.ok, `${slot}: ${text}`).toBe(false);
        if (!out.ok) expect(out.message, `${slot}: ${text}`).toMatch(why);
      }
    }
    // the prefix is a bullet: text that would make it `  - [ ] …` is a task line, refused
    expect(fillProseSlots(FILE, withSlots({ 2: "[ ] pay the invoice" }))).toMatchObject({ ok: false });
    // …while ordinary punctuation, emphasis and links are prose
    for (const ok of ["**Bring** the numbers.", "_Quiet day._", "“Ask about [[Jim Fallon]]'s lease.”", "3 things matter today.", "(tentative) keep it short"]) {
      expect(fillProseSlots(FILE, withSlots({ 1: ok })).ok, ok).toBe(true);
    }
  });

  it("an empty slot is refused rather than written — leave the marker instead", () => {
    expect(fillProseSlots(FILE, withSlots({ 1: "   " }))).toMatchObject({ ok: false, message: expect.stringContaining("empty") });
  });
});
