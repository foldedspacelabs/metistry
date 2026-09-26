// The section grammar (design-build-plan §2.13, C102): Metistry writes one
// region of a note the owner owns, and a write that cannot prove the rest of
// the note is byte-for-byte what it was does not happen. The cases that
// matter most are the refusals — every way a note can hold markers that are
// not exactly one clean pair — and the property under every write: the bytes
// outside the markers never change.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { NOTE_SECTIONS, errorEnvelope, isNoteSectionName, scanNoteSection, sectionMissingMessage, statusFor, writeNoteSection, type NoteSectionScan } from "../src/index.js";

const OPEN = NOTE_SECTIONS.day.open;
const CLOSE = NOTE_SECTIONS.day.close;
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const B = (s: string) => Buffer.from(s, "utf8");
const scan = (s: string | Buffer) => scanNoteSection(typeof s === "string" ? B(s) : s, "day");
const missing = (s: string | Buffer) => {
  const r = scan(s);
  expect(r.state, JSON.stringify(r)).toBe("missing");
  return r as Extract<NoteSectionScan, { state: "missing" }>;
};

/** The bytes outside the region: before the inner start + after the inner end. */
function outside(bytes: Buffer): Buffer {
  const r = scanNoteSection(bytes, "day");
  if (r.state !== "present") throw new Error(`no section: ${JSON.stringify(r)}`);
  return Buffer.concat([bytes.subarray(0, r.innerStart), bytes.subarray(r.innerEnd)]);
}
function outerOf(bytes: Buffer): string {
  const r = scanNoteSection(bytes, "day");
  if (r.state === "missing") throw new Error(`missing: ${r.reason}`);
  return r.outerSha256;
}

const NOTE = `---\nsource: user\n---\n# 2026-09-26\n\n## Notes\n\nmine\n\n${OPEN}\nold plan\n${CLOSE}\n\n## After\n\nalso mine\n`;

describe("the grammar", () => {
  it("names a closed set of sections, and `section_missing` is a 409 in the uniform envelope", () => {
    expect(isNoteSectionName("day")).toBe(true);
    for (const v of ["Day", "metistry:day", "toString", "__proto__", "", 1, null]) expect(isNoteSectionName(v), String(v)).toBe(false);
    expect(OPEN).toBe("<!-- metistry:day -->");
    expect(CLOSE).toBe("<!-- /metistry:day -->");
    expect(statusFor("section_missing")).toBe(409);
    expect(errorEnvelope("section_missing").error.code).toBe("section_missing");
  });

  it("finds exactly one pair and hashes everything but the region — the marker lines are the owner's too", () => {
    const bytes = B(NOTE);
    const r = scan(bytes);
    expect(r.state).toBe("present");
    if (r.state !== "present") return;
    expect(bytes.subarray(r.innerStart, r.innerEnd).toString()).toBe("old plan\n");
    const before = bytes.subarray(0, r.innerStart).toString();
    expect(before.endsWith(`${OPEN}\n`)).toBe(true);
    expect(bytes.subarray(r.innerEnd).toString().startsWith(`${CLOSE}\n`)).toBe(true);
    expect(r.outerSha256).toBe(sha(Buffer.concat([bytes.subarray(0, r.innerStart), bytes.subarray(r.innerEnd)])));
  });

  it("an empty region, CRLF lines, trailing spaces on a marker line and a close on the last line all still read as one pair", () => {
    expect(scan(`${OPEN}\n${CLOSE}`).state).toBe("present");
    expect(scan(`a\r\n${OPEN}\r\nx\r\n${CLOSE}\r\nb\r\n`).state).toBe("present");
    expect(scan(`${OPEN}  \nx\n${CLOSE}\t\n`).state).toBe("present");
  });

  it("no marker anywhere is the first write: the outer hash is the whole file's — `GET /vault/read`'s sha256", () => {
    const text = "# 2026-09-26\n\nmine, and a mention of metistry:day that is not a marker\n";
    expect(scan(text)).toEqual({ state: "absent", outerSha256: sha(text) });
    expect(scan("")).toEqual({ state: "absent", outerSha256: sha("") });
  });
});

describe("**two pairs, one marker, or markers inside a code block → section_missing**", () => {
  it("two pairs", () => {
    expect(missing(`${OPEN}\na\n${CLOSE}\n\n${OPEN}\nb\n${CLOSE}\n`).reason).toBe("more_than_one_pair");
    expect(missing(`${OPEN}\n${OPEN}\na\n${CLOSE}\n`).reason).toBe("more_than_one_pair");
  });

  it("one marker — an opener alone, a closer alone, or two of one kind", () => {
    expect(missing(`mine\n${OPEN}\nplan\n`)).toMatchObject({ reason: "unpaired", line: 2 });
    expect(missing(`mine\nplan\n${CLOSE}\n`)).toMatchObject({ reason: "unpaired", line: 3 });
    expect(missing(`${OPEN}\nplan\n${OPEN}\n`).reason).toBe("unpaired");
  });

  it("markers inside a code block — backticks, tildes, a longer fence, an unclosed fence", () => {
    expect(missing(`mine\n\`\`\`\n${OPEN}\nplan\n${CLOSE}\n\`\`\`\n`)).toMatchObject({ reason: "in_code_block", line: 3 });
    expect(missing(`~~~ md\n${OPEN}\nplan\n${CLOSE}\n~~~\n`).reason).toBe("in_code_block");
    // a four-backtick fence is not closed by three
    expect(missing(`\`\`\`\`\n\`\`\`\n${OPEN}\nplan\n${CLOSE}\n\`\`\`\`\n`).reason).toBe("in_code_block");
    // a tilde does not close a backtick fence
    expect(missing(`\`\`\`\n~~~\n${OPEN}\nx\n${CLOSE}\n`).reason).toBe("in_code_block");
    // never closed: the fence runs to the end of the note
    expect(missing(`\`\`\`js\nlet a;\n${OPEN}\nplan\n${CLOSE}\n`).reason).toBe("in_code_block");
    // a closer indented four spaces is code, not a closer
    expect(missing(`\`\`\`\n    \`\`\`\n${OPEN}\nx\n${CLOSE}\n`).reason).toBe("in_code_block");
    // only one of the pair in a block is the same refusal
    expect(missing(`${OPEN}\nplan\n\`\`\`\n${CLOSE}\n\`\`\`\n`).reason).toBe("in_code_block");
  });

  it("a marker quoted in a code block is refused even beside a clean pair — which one was meant is the guess this never makes", () => {
    expect(missing(`${OPEN}\nplan\n${CLOSE}\n\nHow the section works:\n\`\`\`\n${OPEN}\n\`\`\`\n`).reason).toBe("in_code_block");
  });

  it("…while a fence that opens and closes before the markers, or an inline backtick run, leaves them outside", () => {
    expect(scan(`\`\`\`\ncode\n\`\`\`\n${OPEN}\nx\n${CLOSE}\n`).state).toBe("present");
    expect(scan(`\`\`\`\`\n\`\`\`\n\`\`\`\`\n${OPEN}\nx\n${CLOSE}\n`).state).toBe("present");
    // an info string with a backtick is not a fence (CommonMark)
    expect(scan(`\`\`\` a\`b\n${OPEN}\nx\n${CLOSE}\n`).state).toBe("present");
  });
});

describe("every other way a note can hold markers that are not one clean pair", () => {
  it("out of order", () => {
    expect(missing(`${CLOSE}\nplan\n${OPEN}\n`)).toMatchObject({ reason: "out_of_order", line: 1 });
  });

  it("malformed: annotated, indented, mis-cased, inline in prose, two on a line, split across lines", () => {
    for (const bad of [
      `<!-- metistry:day · updated 5:14 PM -->\nx\n${CLOSE}\n`,
      `  ${OPEN}\nx\n${CLOSE}\n`,
      `<!-- Metistry:Day -->\nx\n${CLOSE}\n`,
      `<!--metistry:day-->\nx\n${CLOSE}\n`,
      `see ${OPEN} here\n${OPEN}\nx\n${CLOSE}\n`,
      `${OPEN}${CLOSE}\n`,
      `${OPEN}\nx\n<!--\n/metistry:day -->\n`,
      `> ${OPEN}\nx\n${CLOSE}\n`,
    ]) {
      expect(missing(bad).reason, JSON.stringify(bad)).toBe("malformed");
    }
  });

  it("a marker in the frontmatter", () => {
    expect(missing(`---\nnote: ${OPEN}\n---\n${OPEN}\nx\n${CLOSE}\n`)).toMatchObject({ reason: "in_frontmatter", line: 2 });
  });

  it("a heading with its markers gone is a deleted section, not a new one", () => {
    expect(missing("# 2026-09-26\n\n## Today · Metistry\n\nwhat the owner kept\n")).toMatchObject({ reason: "heading_without_markers", line: 3 });
    expect(missing("### Today · Metistry ###\n").reason).toBe("heading_without_markers");
    // the words in prose, or in a code block, are not the heading
    expect(scan("I read Today · Metistry every morning\n").state).toBe("absent");
    expect(scan("```\n## Today · Metistry\n```\n").state).toBe("absent");
  });

  it("no section and a note that ends inside an unclosed fence: appending would write code", () => {
    expect(missing("mine\n```\nunfinished\n").reason).toBe("ends_in_code_block");
  });

  it("a different section's name is not this one's marker", () => {
    expect(scan("<!-- metistry:day-plan -->\n").state).toBe("absent");
  });

  it("the refusal's sentence says what was wrong, where, and that nothing was written", () => {
    const m = sectionMissingMessage("Journal/2026-09-26.md", "day", "in_code_block", 12);
    expect(m).toContain("Journal/2026-09-26.md");
    expect(m).toContain("inside a code block (line 12)");
    expect(m).toContain("Nothing was written");
    expect(m).toContain(OPEN);
  });
});

describe("writing the region", () => {
  it("replaces only the bytes between the markers", () => {
    const bytes = B(NOTE);
    const w = writeNoteSection(bytes, "day", "- Plan: [[Journal/Plan/2026-09-26]]\n- 9:00 Standup", outerOf(bytes));
    expect(w.ok).toBe(true);
    if (!w.ok) return;
    expect(w.appended).toBe(false);
    expect(w.content.toString()).toBe(NOTE.replace("old plan\n", "- Plan: [[Journal/Plan/2026-09-26]]\n- 9:00 Standup\n"));
    expect(outside(w.content).equals(outside(bytes))).toBe(true);
    expect(w.outerSha256).toBe(outerOf(bytes));
  });

  it("an empty body empties the region and leaves the markers", () => {
    const bytes = B(NOTE);
    const w = writeNoteSection(bytes, "day", "", outerOf(bytes));
    expect(w.ok && w.content.toString()).toBe(NOTE.replace("old plan\n", ""));
  });

  it("the first write appends the heading and the markers, and the owner's bytes are an untouched prefix", () => {
    for (const [owner, sep] of [
      ["# 2026-09-26\n\nmine\n", "\n"],
      ["# 2026-09-26\n\nmine", "\n\n"],
      ["# 2026-09-26\n\nmine\n\n", ""],
      ["", ""],
    ] as const) {
      const w = writeNoteSection(B(owner), "day", "plan", sha(owner));
      expect(w.ok, owner).toBe(true);
      if (!w.ok) continue;
      expect(w.appended).toBe(true);
      expect(w.content.toString()).toBe(`${owner}${sep}## Today · Metistry\n\n${OPEN}\nplan\n${CLOSE}\n`);
      expect(w.content.subarray(0, Buffer.byteLength(owner)).equals(B(owner))).toBe(true);
      // and the note it leaves is one the next write finds
      expect(scan(w.content).state).toBe("present");
    }
  });

  it("**a mismatched outer hash is refused** — a writer that has not seen the owner's latest edit cannot land", () => {
    const bytes = B(NOTE);
    expect(writeNoteSection(bytes, "day", "x", sha("stale"))).toEqual({ ok: false, code: "conflict" });
    // the whole-file hash is not the outer hash once a section exists
    expect(writeNoteSection(bytes, "day", "x", sha(bytes))).toEqual({ ok: false, code: "conflict" });
    // and an owner edit OUTSIDE the region changes the outer hash; one INSIDE does not
    const seen = outerOf(bytes);
    const editedOutside = B(NOTE.replace("also mine", "also mine, edited"));
    expect(writeNoteSection(editedOutside, "day", "x", seen)).toEqual({ ok: false, code: "conflict" });
    const editedInside = B(NOTE.replace("old plan", "the owner scribbled here"));
    expect(writeNoteSection(editedInside, "day", "x", seen).ok).toBe(true);
  });

  it("section_missing wins over the hash: a broken note is refused whatever the caller saw", () => {
    const broken = `${OPEN}\nx\n`;
    expect(writeNoteSection(B(broken), "day", "y", sha(broken))).toEqual({ ok: false, code: "section_missing", reason: "unpaired", line: 1 });
  });

  it("a body may not carry the section's markers, in any spelling", () => {
    const bytes = B(NOTE);
    for (const body of [`a\n${CLOSE}\nstolen`, `${OPEN}`, "<!-- /METISTRY:DAY -->"]) {
      const w = writeNoteSection(bytes, "day", body, outerOf(bytes));
      expect(w.ok, body).toBe(false);
      expect(!w.ok && w.code).toBe("invalid_request");
    }
  });

  it("a body that opens a fence it never closes is refused — it would swallow the closer and brick the section", () => {
    const bytes = B(NOTE);
    const w = writeNoteSection(bytes, "day", "```\nunclosed", outerOf(bytes));
    expect(!w.ok && w.code).toBe("invalid_request");
    // a balanced one is fine
    expect(writeNoteSection(bytes, "day", "```\nok\n```", outerOf(bytes)).ok).toBe(true);
  });

  it("a `---` in the body cannot close a frontmatter the owner left open and swallow the opener", () => {
    const note = `---\nunclosed: yes\n${OPEN}\nx\n${CLOSE}\n`;
    const bytes = B(note);
    const w = writeNoteSection(bytes, "day", "---", outerOf(bytes));
    expect(!w.ok && w.code).toBe("invalid_request");
  });

  it("bytes that are not UTF-8 outside the markers survive untouched — nothing is decoded and re-encoded", () => {
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe, 0x0a, 0xc3, 0x28, 0x0a]), B(`${OPEN}\nx\n${CLOSE}\n`), Buffer.from([0x80, 0x0a, 0xe2, 0x82])]);
    const w = writeNoteSection(bytes, "day", "café ☕", outerOf(bytes));
    expect(w.ok).toBe(true);
    if (!w.ok) return;
    expect(outside(w.content).equals(outside(bytes))).toBe(true);
  });
});

// A deterministic PRNG — the property is checked over many shapes of note,
// and a failure must reproduce.
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const OWNER_LINES = [
  "- [ ] call the plumber due friday",
  "## Notes",
  "",
  "   ",
  "plain prose with *emphasis* and a [[Link]]",
  "a line with a CR\r",
  "café — ünïcødé ☕",
  "```js\nconst a = 1;\n```",
  "~~~\nquoted\n~~~",
  "> a quote",
  "<!-- the owner's own comment -->",
  "metistry:day mentioned in passing",
  "## Today · Metistry is a phrase, not a heading, when it is here",
  "\t- indented",
];
const BODIES = ["", "one line", "two\nlines\n", "- [[Journal/Plan/2026-09-26]]\n- 9:00 Standup · Zoom\n", "```\nbalanced\n```", "trailing spaces   ", "☕ ✅ — done at 5:14 PM\n\n", "\r\nCRLF body\r\n"];

describe("**bytes outside the markers are identical after every write** (a property, over generated notes)", () => {
  it("holds for 300 notes × 4 successive writes each, whatever the note holds", () => {
    const rand = prng(20260926);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
    let checked = 0;
    for (let n = 0; n < 300; n++) {
      const before = Array.from({ length: Math.floor(rand() * 8) }, () => pick(OWNER_LINES));
      const after = Array.from({ length: Math.floor(rand() * 8) }, () => pick(OWNER_LINES));
      const fm = rand() < 0.5 ? "---\nsource: user\n---\n" : "";
      const raw = rand() < 0.2 ? Buffer.from([0xff, 0x0a]) : Buffer.alloc(0);
      const tail = rand() < 0.5 ? "\n" : "";
      let bytes = Buffer.concat([B(fm), raw, B([...before, OPEN, "seed", CLOSE, ...after].join("\n") + tail)]);
      const first = scanNoteSection(bytes, "day");
      expect(first.state, bytes.toString()).toBe("present");
      const fixed = outside(bytes);
      for (let k = 0; k < 4; k++) {
        const w = writeNoteSection(bytes, "day", pick(BODIES), outerOf(bytes));
        expect(w.ok, `${bytes.toString()}\n--- write ${k}`).toBe(true);
        if (!w.ok) break;
        expect(outside(w.content).equals(fixed), bytes.toString()).toBe(true);
        bytes = w.content;
        checked++;
      }
    }
    expect(checked).toBe(1200);
  });

  it("…and after a first write appends, every later write keeps the appended note's outside too", () => {
    const rand = prng(7);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
    for (let n = 0; n < 100; n++) {
      // generated notes with no fence left open, so the append is always allowed
      const owner = B(Array.from({ length: Math.floor(rand() * 6) }, () => pick(OWNER_LINES.filter((l) => !l.startsWith("##")))).join("\n"));
      const first = writeNoteSection(owner, "day", pick(BODIES), sha(owner));
      expect(first.ok, owner.toString()).toBe(true);
      if (!first.ok) continue;
      expect(first.content.subarray(0, owner.length).equals(owner)).toBe(true);
      const fixed = outside(first.content);
      let bytes = first.content;
      for (let k = 0; k < 3; k++) {
        const w = writeNoteSection(bytes, "day", pick(BODIES), outerOf(bytes));
        expect(w.ok).toBe(true);
        if (!w.ok) break;
        expect(w.appended).toBe(false);
        expect(outside(w.content).equals(fixed)).toBe(true);
        bytes = w.content;
      }
    }
  });
});
