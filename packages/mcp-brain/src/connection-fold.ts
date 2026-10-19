// The fold `connections_call` applies to a large upstream answer (plan §2.6;
// X-132, the Context Mode review's CM-6 — allowed by the owner 2026-10-04).
//
// `connections_call` used to return an upstream answer whole: one "GitHub
// Issues (20)" listing is 58.9 KB ≈ 14.7k tokens, carried in the caller's
// context for the rest of its session and re-billed on every turn. This is
// the one tool-output path Metistry owns, so it is folded HERE, at the tool
// — not by a prompt asking the upstream to be brief, and not by a proxy in
// the caller's provider path (both refused by the review, §4 and §6).
//
// The fold is a PURE FUNCTION of the redacted text and the configuration,
// applied once: the same answer folds to the same bytes every time, so a
// client's prompt cache sees one stable prefix rather than a different
// summary per call. Nothing here reads a model, a clock or a random source.
// Three shapes, in order, and the first that fits is the one:
//
//   1. a JSON array over `arrayOver` items → its first `arrayKeep`, its last
//      and the count (what a listing tool answers: issues, events, rows);
//   2. otherwise, runs of a repeated line become one line and a count (what
//      a log or a build answers);
//   3. and whatever is still over `thresholdBytes` gets a head and a tail,
//      with the bytes between them named.
//
// The whole answer is kept for the caller to page (connection-answers.ts):
// pages are cut over the SAME text this folds, at code-point boundaries, so a
// page never splits a character and every byte of the answer is on exactly
// one page.
//
// Every number is configuration (R4): the host reads `METISTRY_CONNECTION_
// FOLD_BYTES`, `…_FOLD_ARRAY_OVER`, `…_FOLD_ARRAY_KEEP` and
// `…_ANSWER_KEEP_HOURS` with these as the fallbacks (apps/console/src/main.ts).

/** The host's fold settings — every number a decision the owner can move without a release. */
export interface ConnectionFold {
  /** an answer at or under this many bytes on the wire comes whole; over it, folded — and a page is this long */
  thresholdBytes: number;
  /** a JSON array with more than this many items is folded… */
  arrayOver: number;
  /** …to its first this many items, its last and the count */
  arrayKeep: number;
  /** how long the whole answer stays readable by page; a fraction is a fraction of an hour */
  keepHours: number;
}

/** 8 KiB ≈ 2k tokens: four times the review's folded target, and well under the one listing that motivated the ticket. The host passes its own (`METISTRY_CONNECTION_FOLD_BYTES`). */
export const DEFAULT_CONNECTION_FOLD_BYTES = 8192;
/** A listing is folded past this many items. The host passes its own (`METISTRY_CONNECTION_FOLD_ARRAY_OVER`). */
export const DEFAULT_CONNECTION_FOLD_ARRAY_OVER = 20;
/** …to this many of its first items. The host passes its own (`METISTRY_CONNECTION_FOLD_ARRAY_KEEP`). */
export const DEFAULT_CONNECTION_FOLD_ARRAY_KEEP = 5;
/** A folded answer is readable by page for a day — longer than any session that asked for it, shorter than anything worth backing up. The host passes its own (`METISTRY_CONNECTION_ANSWER_KEEP_HOURS`). */
export const DEFAULT_CONNECTION_ANSWER_KEEP_HOURS = 24;

export const DEFAULT_CONNECTION_FOLD: ConnectionFold = {
  thresholdBytes: DEFAULT_CONNECTION_FOLD_BYTES,
  arrayOver: DEFAULT_CONNECTION_FOLD_ARRAY_OVER,
  arrayKeep: DEFAULT_CONNECTION_FOLD_ARRAY_KEEP,
  keepHours: DEFAULT_CONNECTION_ANSWER_KEEP_HOURS,
};

/** What an upstream answered, redacted — the pool's `CallOutcome` without its bookkeeping. */
export interface AnswerLike {
  content: unknown[];
  structuredContent?: unknown;
}

/** UTF-8 bytes on the wire. */
export const byteLength = (s: string): number => Buffer.byteLength(s, "utf8");

/** The answer as the wire carries it — what the caller would have paid for whole. */
export function wireBytes(a: AnswerLike): number {
  return byteLength(JSON.stringify({ content: a.content, ...(a.structuredContent !== undefined ? { structuredContent: a.structuredContent } : {}) }));
}

function isTextBlock(b: unknown): b is { type: "text"; text: string } {
  return typeof b === "object" && b !== null && (b as { type?: unknown }).type === "text" && typeof (b as { text?: unknown }).text === "string";
}

/**
 * The ONE text a fold and its pages are over. Text blocks are joined as text
 * — the usual answer, and what a listing tool's JSON lives in. An answer with
 * no text block but structured content is that content as JSON; anything else
 * (an image, a resource) is its blocks as JSON, so no byte of it is lost to
 * the pages even when the fold cannot say more than "folded".
 */
export function answerText(a: AnswerLike): string {
  const blocks = a.content;
  if (blocks.length > 0 && blocks.every(isTextBlock)) return blocks.map((b) => b.text).join("\n");
  if (blocks.length === 0 && a.structuredContent !== undefined) return JSON.stringify(a.structuredContent);
  return JSON.stringify(blocks);
}

export type FoldHow = "array" | "lines" | "cap";

export interface Folded {
  text: string;
  /** which shapes applied, in order — the audit's `meta.fold` */
  how: FoldHow[];
}

/** `text` as a JSON array, or undefined — a cheap test before the parse, so prose never pays for one. */
function asArray(text: string): unknown[] | undefined {
  const t = text.trim();
  if (!t.startsWith("[") || !t.endsWith("]")) return undefined;
  try {
    const v: unknown = JSON.parse(t);
    return Array.isArray(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Runs of one identical line become the line and a count. Blank runs say so, so a folded log still reads. */
export function collapseRepeatedLines(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    let n = 1;
    while (i + n < lines.length && lines[i + n] === line) n += 1;
    if (n >= 3) out.push(line === "" ? `[×${n} blank lines]` : `${line}  [×${n}]`);
    else for (let k = 0; k < n; k += 1) out.push(line);
    i += n;
  }
  return out.join("\n");
}

/** The longest prefix of `s` within `max` UTF-8 bytes, cut at a code point. */
export function headBytes(s: string, max: number): string {
  let bytes = 0;
  let i = 0;
  while (i < s.length) {
    const cp = s.codePointAt(i)!;
    const w = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (bytes + w > max) break;
    bytes += w;
    i += cp >= 0x10000 ? 2 : 1;
  }
  return s.slice(0, i);
}

/** The longest suffix of `s` within `max` UTF-8 bytes, cut at a code point. */
export function tailBytes(s: string, max: number): string {
  let bytes = 0;
  let i = s.length;
  while (i > 0) {
    // a low surrogate ends a pair: step over both halves
    const low = s.charCodeAt(i - 1);
    const pair = low >= 0xdc00 && low <= 0xdfff && i >= 2;
    const cp = pair ? s.codePointAt(i - 2)! : low;
    const w = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (bytes + w > max) break;
    bytes += w;
    i -= pair ? 2 : 1;
  }
  return s.slice(i);
}

/** Three quarters head, one quarter tail — the start says what the answer is, the end says how it finished. */
const HEAD_SHARE = 0.75; // limit: fixed — a proportion of the configured threshold, not a size of its own

/** Head and tail within `cap` bytes, the bytes between them named. */
export function headAndTail(text: string, cap: number): string {
  const head = headBytes(text, Math.floor(cap * HEAD_SHARE));
  const tail = tailBytes(text, cap - byteLength(head));
  const omitted = byteLength(text) - byteLength(head) - byteLength(tail);
  if (omitted <= 0) return text;
  return `${head}\n…[${omitted} bytes folded — the whole answer is on its pages]…\n${tail}`;
}

/**
 * The fold: a pure function of the text and the settings. Applied once, to
 * the redacted text, by `connections_call`; never to a page.
 */
export function foldText(text: string, cfg: ConnectionFold): Folded {
  const how: FoldHow[] = [];
  let out = text;
  const items = asArray(text);
  if (items && items.length > cfg.arrayOver) {
    out = JSON.stringify({ folded: "array", count: items.length, first: items.slice(0, cfg.arrayKeep), last: items[items.length - 1] });
    how.push("array");
  } else {
    const collapsed = collapseRepeatedLines(text);
    if (collapsed !== text) {
      out = collapsed;
      how.push("lines");
    }
  }
  if (byteLength(out) > cfg.thresholdBytes) {
    out = headAndTail(out, cfg.thresholdBytes);
    how.push("cap");
  }
  return { text: out, how };
}

/**
 * The answer's pages: consecutive, each within `pageBytes`, cut at code
 * points, together the whole text — the same cut every time, so page 3 is
 * page 3 on every read. An empty answer is one empty page.
 */
export function pagesOf(text: string, pageBytes: number): string[] {
  const pages: string[] = [];
  let rest = text;
  while (rest.length > 0) {
    const page = headBytes(rest, pageBytes);
    // a single code point wider than the page would never advance; a page is at least one character
    const take = page.length > 0 ? page : rest.slice(0, rest.codePointAt(0)! >= 0x10000 ? 2 : 1);
    pages.push(take);
    rest = rest.slice(take.length);
  }
  return pages.length > 0 ? pages : [""];
}

/** A folded answer's page reference as the caller sends it: `<handle>/<n>`, n from 1. */
export function parsePageRef(page: string): { handle: number; page: number } | undefined {
  const m = /^(\d{1,15})\/(\d{1,9})$/.exec(page);
  if (!m) return undefined;
  return { handle: Number(m[1]), page: Number(m[2]) };
}
