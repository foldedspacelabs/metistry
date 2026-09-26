// A section Metistry keeps inside a note the OWNER owns — "one writer per
// region" (design-build-plan §2.13; C102, K5, ruled 2026-09-25).
//
// `Journal/<date>.md` is the owner's. Metistry writes exactly one region of
// it: the bytes between `<!-- metistry:day -->` and `<!-- /metistry:day -->`.
// Everything else — including the two marker lines themselves — is the
// owner's, and a write that cannot prove it left every one of those bytes
// alone does not happen. Broken markers stop the write rather than being
// guessed at: "Metistry never guesses where the owner's text ends"
// (screen-05-today §15.5.1).
//
// This file is the GRAMMAR, and it is pure: no filesystem, no vault, no
// clock. The reconciler's section operation (`POST /vault/section`,
// apps/reconciler) is the only thing that writes with it, and it adds the
// policy — which path, which principal, which credential. It lives in core
// rather than the reconciler because a caller has to compute the same
// `expected_outer_sha` the bridge checks — the Morning Brief and Close the
// Day each read the note and hash what they saw — and a parser implemented
// twice is two parsers.
//
// **Bytes, not strings.** The note is the owner's and may hold anything; a
// decode→encode round trip would "repair" invalid UTF-8 and change bytes
// outside the markers. Lines are split on 0x0A — which never occurs inside a
// multi-byte UTF-8 sequence — and composition is slicing. Decoding is only
// ever used to RECOGNISE a line.

import { createHash } from "node:crypto";

export interface NoteSectionSpec {
  /** The opening marker, alone on its own line. */
  readonly open: string;
  /** The closing marker, alone on its own line. */
  readonly close: string;
  /** The heading written above the markers the first time — "appended the first time if the note has none". */
  readonly heading: string;
}

/**
 * Every section Metistry may keep inside an owner's note. Closed: a new one
 * is a product change (invariant 10's instinct), and the reconciler's
 * `SECTION_WRITERS` names who may write each.
 *
 * The markers are exact. An annotated opener (`<!-- metistry:day · updated
 * 5:14 PM -->`) is a malformed marker, not a variant: the time stamp belongs
 * in the section's body, which is the one place a writer controls.
 */
export const NOTE_SECTIONS = Object.freeze({
  day: Object.freeze({ open: "<!-- metistry:day -->", close: "<!-- /metistry:day -->", heading: "## Today · Metistry" }),
} satisfies Record<string, NoteSectionSpec>);

export type NoteSectionName = keyof typeof NOTE_SECTIONS;
export const NOTE_SECTION_NAMES: readonly NoteSectionName[] = Object.freeze(Object.keys(NOTE_SECTIONS) as NoteSectionName[]);

export function isNoteSectionName(v: unknown): v is NoteSectionName {
  return typeof v === "string" && Object.hasOwn(NOTE_SECTIONS, v);
}

/**
 * Why a note has no section this operation will write — the wire code is
 * always `section_missing`; the reason is for the sentence the owner reads
 * (Close's `note` request, the Morning Brief's `runs` row).
 */
export const SECTION_MISSING_REASONS = [
  "unpaired", // an opener with no closer, a closer with no opener, or two of one kind
  "more_than_one_pair", // the markers appear more than twice
  "out_of_order", // the closer comes before the opener
  "malformed", // a marker that is not alone on its line exactly as written: annotated, indented, mis-cased, split across lines, or two on one line
  "in_code_block", // a marker inside a fenced code block
  "in_frontmatter", // a marker inside the YAML frontmatter
  "heading_without_markers", // the heading is there and the markers are not: they were deleted, this is not a first write
  "ends_in_code_block", // no section yet, but the note ends inside an unclosed code block — an appended section would be code
] as const;
export type SectionMissingReason = (typeof SECTION_MISSING_REASONS)[number];

const REASON_TEXT: Readonly<Record<SectionMissingReason, string>> = Object.freeze({
  unpaired: "has one of its markers without the other",
  more_than_one_pair: "has its markers more than once",
  out_of_order: "has its closing marker before its opening one",
  malformed: "has a marker that is not alone on its own line, exactly as written",
  in_code_block: "has a marker inside a code block",
  in_frontmatter: "has a marker inside the frontmatter",
  heading_without_markers: "has the section's heading but not its markers",
  ends_in_code_block: "ends inside a code block that is never closed, so a section added at the end would be code",
});

/** The sentence a refusal carries: what was wrong, where, that nothing was written, and what the markers look like. */
export function sectionMissingMessage(path: string, name: NoteSectionName, reason: SectionMissingReason, line: number | null): string {
  const spec = NOTE_SECTIONS[name];
  const at = line === null ? "" : ` (line ${line})`;
  return `${path}: the ${name} section could not be found — the note ${REASON_TEXT[reason]}${at}. Nothing was written. The section is the text between ${spec.open} and ${spec.close}, each alone on its own line, outside any code block, once.`;
}

export type NoteSectionScan =
  /** Exactly one well-formed pair. `innerStart`/`innerEnd` are byte offsets of the region between the marker lines. */
  | { state: "present"; innerStart: number; innerEnd: number; outerSha256: string }
  /** No marker anywhere and no orphaned heading: the first write appends the heading and the markers. The outer hash is the whole file's. */
  | { state: "absent"; outerSha256: string }
  | { state: "missing"; reason: SectionMissingReason; line: number | null };

interface Line {
  /** Byte offset of the line's first byte. */
  start: number;
  /** Byte offset just past its terminator (`\n`), or the file's end. */
  end: number;
  /** The line's content, terminator and a trailing `\r` removed — for recognising it, never for writing. */
  text: string;
}

function asBuffer(bytes: Uint8Array): Buffer {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function linesOf(buf: Buffer): Line[] {
  const out: Line[] = [];
  let start = 0;
  while (start < buf.length) {
    const nl = buf.indexOf(0x0a, start);
    const end = nl === -1 ? buf.length : nl + 1;
    let contentEnd = nl === -1 ? buf.length : nl;
    if (contentEnd > start && buf[contentEnd - 1] === 0x0d) contentEnd--;
    out.push({ start, end, text: buf.toString("utf8", start, contentEnd) });
    start = end;
  }
  return out;
}

/**
 * Anything that LOOKS like one of this section's markers, however it is
 * spelled — so a mis-cased, annotated or split marker is recognised and
 * refused, never silently treated as the owner's prose. The lookahead keeps
 * `metistry:day-plan` (another name) from matching `day`, and still sees
 * `<!--metistry:day-->`.
 */
function markerToken(name: NoteSectionName): RegExp {
  return new RegExp(String.raw`<!--\s*\/?\s*metistry\s*:\s*${name}(?!\w|-(?!->))`, "gi");
}

function countMatches(text: string, re: RegExp): number {
  re.lastIndex = 0;
  return text.match(re)?.length ?? 0;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The section's heading at any ATX level (the owner may have demoted it), optional closing hashes. */
function headingRe(spec: NoteSectionSpec): RegExp {
  const text = spec.heading.replace(/^#+[ \t]+/, "");
  return new RegExp(String.raw`^ {0,3}#{1,6}[ \t]+${escapeRe(text)}(?:[ \t]+#+)?[ \t]*$`);
}

// CommonMark fences: up to three spaces of indent, three or more of one
// character; a backtick fence's info string holds no backtick; the closer is
// the same character, at least as long, followed by nothing but spaces.
// Unclosed, a fence runs to the end of the note.
const OPEN_FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const CLOSE_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/** Index of the first line after the frontmatter (0 when there is none) — `---` on line one, closed by the next `---` line. */
function frontmatterEnd(lines: Line[]): number {
  if (lines[0]?.text !== "---") return 0;
  for (let i = 1; i < lines.length; i++) if (lines[i]!.text === "---") return i + 1;
  return 0;
}

function sha256(...parts: Uint8Array[]): string {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest("hex");
}

/**
 * Find the section, or say exactly why there is none this operation will
 * write. Strict on purpose: every occurrence of the marker, anywhere in the
 * note — prose, frontmatter, a code block — must be one of the two lines of
 * the one pair. A marker the owner quoted in a code block is still refused,
 * because "which of these did they mean" is the guess this exists not to make.
 *
 * **The outer hash.** With the section present it is SHA-256 over the bytes
 * before the region and the bytes after it, concatenated — the marker lines
 * included, since they are the owner's too. With it absent, it is the whole
 * file's hash, i.e. `GET /vault/read`'s `sha256`.
 */
export function scanNoteSection(content: Uint8Array, name: NoteSectionName): NoteSectionScan {
  const spec = NOTE_SECTIONS[name];
  const buf = asBuffer(content);
  const lines = linesOf(buf);
  const token = markerToken(name);
  const heading = headingRe(spec);
  const fmEnd = frontmatterEnd(lines);

  let fence: { char: string; len: number } | null = null;
  const opens: number[] = [];
  const closes: number[] = [];
  let seen = 0;
  let bad: { reason: SectionMissingReason; line: number | null } | null = null;
  let headingLine: number | null = null;

  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!.text;
    const inFrontmatter = i < fmEnd;
    const inCode = fence !== null;
    let fenceLine = false;
    if (!inFrontmatter) {
      if (fence === null) {
        const m = OPEN_FENCE.exec(text);
        if (m && !(m[1]![0] === "`" && m[2]!.includes("`"))) {
          fence = { char: m[1]![0]!, len: m[1]!.length };
          fenceLine = true;
        }
      } else {
        const m = CLOSE_FENCE.exec(text);
        if (m && m[1]![0] === fence.char && m[1]!.length >= fence.len) {
          fence = null;
          fenceLine = true;
        }
      }
    }

    const here = countMatches(text, token);
    seen += here;
    if (here > 0) {
      const trimmed = text.replace(/[ \t]+$/, "");
      if (inFrontmatter) bad ??= { reason: "in_frontmatter", line: i + 1 };
      else if (inCode || fenceLine) bad ??= { reason: "in_code_block", line: i + 1 };
      else if (here === 1 && trimmed === spec.open) opens.push(i);
      else if (here === 1 && trimmed === spec.close) closes.push(i);
      else bad ??= { reason: "malformed", line: i + 1 };
    } else if (!inFrontmatter && !inCode && !fenceLine && headingLine === null && heading.test(text)) {
      headingLine = i + 1;
    }
  }

  // A marker split across lines (`<!--\nmetistry:day -->`) is invisible line
  // by line; the whole text still sees it.
  if (bad === null && countMatches(buf.toString("utf8"), token) !== seen) bad = { reason: "malformed", line: null };
  if (bad !== null) return { state: "missing", reason: bad.reason, line: bad.line };

  const total = opens.length + closes.length;
  if (total === 0) {
    if (headingLine !== null) return { state: "missing", reason: "heading_without_markers", line: headingLine };
    if (fence !== null) return { state: "missing", reason: "ends_in_code_block", line: null };
    return { state: "absent", outerSha256: sha256(buf) };
  }
  if (total > 2) return { state: "missing", reason: "more_than_one_pair", line: (opens[1] ?? closes[1] ?? opens[0] ?? closes[0]!) + 1 };
  if (opens.length !== 1 || closes.length !== 1) return { state: "missing", reason: "unpaired", line: (opens[0] ?? closes[0]!) + 1 };
  const o = opens[0]!;
  const c = closes[0]!;
  if (c < o) return { state: "missing", reason: "out_of_order", line: c + 1 };
  const innerStart = lines[o]!.end;
  const innerEnd = lines[c]!.start;
  return { state: "present", innerStart, innerEnd, outerSha256: sha256(buf.subarray(0, innerStart), buf.subarray(innerEnd)) };
}

export type NoteSectionWrite =
  | { ok: true; content: Buffer; appended: boolean; outerSha256: string }
  | { ok: false; code: "section_missing"; reason: SectionMissingReason; line: number | null }
  | { ok: false; code: "conflict" }
  | { ok: false; code: "invalid_request"; message: string };

/** The body as it sits between the markers: its own bytes, plus a newline if it lacks one so the closer stays alone on its line. */
function innerBytes(body: string): Buffer {
  return Buffer.from(body === "" || body.endsWith("\n") ? body : `${body}\n`, "utf8");
}

/**
 * Replace the section's region with `body` — or, when the note has none,
 * append the heading and the markers around it — and PROVE the rest of the
 * note is the bytes it was:
 *
 *   - refuses `section_missing` unless the scan found exactly one pair, or
 *     none at all (the first write);
 *   - refuses `conflict` unless the outer hash is `expectedOuterSha256`, so a
 *     writer that has not seen the owner's latest edit cannot land;
 *   - refuses `invalid_request` for a body that carries a marker;
 *   - and re-scans its own output before handing it back: the region must
 *     sit exactly where it was put, or the body is refused `invalid_request`
 *     — a body that opens a code fence it never closes (or a `---` that
 *     closes an unclosed frontmatter) would hide the closer, and a note this
 *     function cannot write again is a note the next writer is refused on.
 *     The outer bytes are then checked unchanged; by construction that
 *     cannot fail, and it is here so a future change to the composition
 *     cannot quietly fail open.
 */
export function writeNoteSection(current: Uint8Array, name: NoteSectionName, body: string, expectedOuterSha256: string): NoteSectionWrite {
  const spec = NOTE_SECTIONS[name];
  if (countMatches(body, markerToken(name)) > 0) return { ok: false, code: "invalid_request", message: `body must not contain the section's own markers (${spec.open} / ${spec.close})` };
  const scan = scanNoteSection(current, name);
  if (scan.state === "missing") return { ok: false, code: "section_missing", reason: scan.reason, line: scan.line };
  if (scan.outerSha256 !== expectedOuterSha256) return { ok: false, code: "conflict" };

  const buf = asBuffer(current);
  const inner = innerBytes(body);
  let content: Buffer;
  let innerStart: number;
  if (scan.state === "present") {
    innerStart = scan.innerStart;
    content = Buffer.concat([buf.subarray(0, scan.innerStart), inner, buf.subarray(scan.innerEnd)]);
  } else {
    const lines = linesOf(buf);
    const last = lines[lines.length - 1];
    const sep = last === undefined ? "" : buf[buf.length - 1] !== 0x0a ? "\n\n" : last.text.trim() === "" ? "" : "\n";
    const head = Buffer.from(`${sep}${spec.heading}\n\n${spec.open}\n`, "utf8");
    innerStart = buf.length + head.length;
    content = Buffer.concat([buf, head, inner, Buffer.from(`${spec.close}\n`, "utf8")]);
  }

  const after = scanNoteSection(content, name);
  if (after.state !== "present" || after.innerStart !== innerStart || after.innerEnd !== innerStart + inner.length) {
    return { ok: false, code: "invalid_request", message: "body would leave the section unreadable — the markers would no longer be found after this write (a code fence the body opens and never closes?)" };
  }
  const outerKept = scan.state === "present" ? after.outerSha256 === scan.outerSha256 : content.subarray(0, buf.length).equals(buf);
  if (!outerKept) return { ok: false, code: "invalid_request", message: "the write would change bytes outside the section" };
  return { ok: true, content, appended: scan.state === "absent", outerSha256: after.outerSha256 };
}
