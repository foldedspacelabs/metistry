// A routine's prose slots, and the one way they are filled (C103, T3-6;
// design-build-plan §2.13).
//
// The template engine renders `{{ prose "…" }}` as a MARKER LINE — the
// routine calls no model (invariant 4), so it hands the slot on:
//
//     <!-- metistry:prose 1 --> _pending — …_
//
// For the fold, the assistant writes its whole file and fills the slots as it
// goes (`routines/knowledge-fold`). For a routine that writes its OWN file —
// the Morning Brief's `Journal/Brief/<date>.md`, the Standup's
// `Journal/Standup/<date>.md` — the file is the routine's (owner ruling (a),
// W1: a routine's reserved subfolder is written under the routine's own
// principal), and the assistant's one turn may change exactly one thing in
// it: each pending slot's line. That is this file, and it is a MECHANISM —
// `knowledge_write` (mcp-brain) runs `fillProseSlots` on the file on disk and
// the content the assistant sent, and writes only what it returns:
//
//   - every line that is not a pending slot must come back byte for byte —
//     the frontmatter, every rendered list, every heading, the footer;
//   - a slot is ONE line: its text replaces the marker and the placeholder,
//     after whatever came before the marker on that line (a list bullet, an
//     indent), and it cannot open a block — a heading, a fence, a list item, a
//     task line, a table, raw HTML — that would reshape the file around it;
//   - a filled slot keeps a trailing `<!-- metistry:written N -->`, so the
//     file itself says which words were written rather than retrieved (C103)
//     and no later write can mistake the line for a pending one.
//
// Pure: strings in, a string or a refusal out. No vault, no clock.

/** The pending marker the engine renders for slot `n` (1-based). */
export const proseMarker = (n: number): string => `<!-- metistry:prose ${n} -->`;
/** The marker a FILLED slot keeps, at the end of its line: the file says these words were written, not retrieved (C103). */
export const writtenMarker = (n: number): string => `<!-- metistry:written ${n} -->`;
/** What a routine's pending slot reads until its turn fills it (the fold keeps its own wording). */
export const PROSE_PENDING = "_pending — written on this file's one assistant turn_";

export const MAX_PROSE_LINE_CHARS = 1_000; // limit: fixed — a Next Up line or a short paragraph, one line; a page is a knowledge note, not a slot

/** Anything that looks like a prose marker, well formed or not — so a mangled one is never a slot, and never silently kept either. */
const MARKER_LIKE = /<!--\s*metistry\s*:\s*prose\b[^>]*-->/gi;
const MARKER_EXACT = /^<!-- metistry:prose ([1-9]\d{0,2}) -->$/;

export interface ProseSlot {
  /** The slot's number, as the marker spells it. */
  index: number;
  /** 0-based line in the file. */
  line: number;
  /** The bytes before the marker on its line — kept as they are when the slot is filled. */
  prefix: string;
}

/**
 * Every pending slot in `content`: a line holding exactly one well-formed
 * marker. A number that appears on two lines is no slot at all (which line
 * was meant is a guess this does not make), and neither is a line holding two
 * markers or a malformed one.
 */
export function pendingProseSlots(content: string): ProseSlot[] {
  const lines = content.split("\n");
  const found: ProseSlot[] = [];
  const seen = new Map<number, number>();
  lines.forEach((text, line) => {
    const tokens = text.match(MARKER_LIKE) ?? [];
    if (tokens.length !== 1) return;
    const m = MARKER_EXACT.exec(tokens[0]!);
    if (!m) return;
    const index = Number(m[1]);
    seen.set(index, (seen.get(index) ?? 0) + 1);
    found.push({ index, line, prefix: text.slice(0, text.indexOf(tokens[0]!)) });
  });
  return found.filter((s) => seen.get(s.index) === 1);
}

/**
 * Markdown that would start a block rather than continue a line of prose:
 * an ATX heading, a quote, a list item or task box, a fence, a thematic break
 * or setext underline, a table row, raw HTML, an indented code block.
 */
const BLOCK_START = /^(?:#{1,6}(?:\s|$)|>|[-+*](?:\s|$)|\d{1,9}[.)](?:\s|$)|`{3,}|~{3,}|[-*_](?:[ \t]*[-*_]){2,}[ \t]*$|=+[ \t]*$|\||<|\[[ xX-]\])/;
// C0 controls (tab aside) and DEL: nothing a line of prose needs, and each is a way to hide or split a line.
const CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f\u2028\u2029]/;

/** Why `text` cannot be slot `index`'s line, or null when it can. */
export function proseLineProblem(text: string, index: number): string | null {
  if (text === "") return `slot ${index} is empty — write one line, or leave the slot as it was`;
  if (text.startsWith("_pending")) return `slot ${index} still holds its placeholder — replace it with your line`;
  if (text.length > MAX_PROSE_LINE_CHARS) return `slot ${index} is ${text.length} characters — one line of at most ${MAX_PROSE_LINE_CHARS}`;
  if (CONTROL.test(text)) return `slot ${index} holds a line break or a control character — a slot is one line`;
  if (text.includes("<!--") || text.includes("-->")) return `slot ${index} holds an HTML comment — the markers are the file's, not the slot's`;
  if (BLOCK_START.test(text)) return `slot ${index} starts a block (a heading, list item, task box, quote, fence, rule, table or HTML) — a slot is a line of prose`;
  return null;
}

export type ProseFill =
  | { ok: true; content: string; filled: number[] }
  | { ok: false; message: string };

/**
 * `incoming` is `existing` with some pending slots filled — or it is refused.
 * Line by line: an unchanged line passes; a changed line must be a pending
 * slot, must keep that slot's prefix, and what follows (the marker itself may
 * be kept or dropped) must be one line of prose (`proseLineProblem`). The
 * result is `existing` with each filled slot's line rewritten as
 * `prefix + text + " " + writtenMarker(n)` — so what lands is built here from
 * the checked text, never taken from `incoming` wholesale.
 */
export function fillProseSlots(existing: string, incoming: string): ProseFill {
  const before = existing.split("\n");
  const after = incoming.split("\n");
  if (before.length !== after.length) {
    return { ok: false, message: `only pending prose slots may change, one line each — the file has ${before.length} lines and yours has ${after.length}` };
  }
  const slots = new Map(pendingProseSlots(existing).map((s) => [s.line, s]));
  const out = [...before];
  const filled: number[] = [];
  for (let i = 0; i < before.length; i++) {
    if (before[i] === after[i]) continue;
    const slot = slots.get(i);
    if (slot === undefined) return { ok: false, message: `line ${i + 1} is not a pending prose slot — only those lines may change; everything else stays exactly as the routine wrote it` };
    const line = after[i]!;
    if (!line.startsWith(slot.prefix)) return { ok: false, message: `slot ${slot.index} (line ${i + 1}) must keep what comes before its marker (${JSON.stringify(slot.prefix)})` };
    let rest = line.slice(slot.prefix.length);
    const marker = proseMarker(slot.index);
    if (rest.startsWith(marker)) rest = rest.slice(marker.length);
    const text = rest.trim();
    const problem = proseLineProblem(text, slot.index);
    if (problem !== null) return { ok: false, message: problem };
    out[i] = `${slot.prefix}${text} ${writtenMarker(slot.index)}`;
    filled.push(slot.index);
  }
  if (filled.length === 0) return { ok: false, message: "no pending prose slot was filled — nothing to write" };
  return { ok: true, content: out.join("\n"), filled };
}
