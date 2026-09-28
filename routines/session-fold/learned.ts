// What the fold's turn answered, read back — model-free, and strict (C79).
//
// The assistant answers the fold's turn with ONE fenced ```learned block, a
// JSON list of what it would propose. That answer is a SUGGESTION and nothing
// more: it is parsed here, each item is checked against the turns the fold
// actually showed, and what survives becomes a request in the owner's Needs
// You. Nothing here — and nothing the assistant can say — writes `Me/`.
//
// The checks are the control, not the prompt's wording (CLAUDE.md, "enforce
// at the tool"):
//
//   * **A closed set of kinds** — preference, lesson, profile. Each lands in
//     one file, fixed here: preferences and lessons in `Me/Working Style.md`,
//     profile facts in `Me/profile.md`. The model never names a path.
//   * **Only a turn this fold showed.** An item cites its turn by handle, and
//     a handle the brief did not carry is dropped — the fold cannot be talked
//     into citing a session it never read.
//   * **The owner's words, verbatim.** A preference and a profile fact carry
//     a `quote`, and it must be found in what the OWNER typed in that turn —
//     not in the assistant's reply, not in a tool result. What is written for
//     a preference is the owner's own span, as they typed it (their casing,
//     their words), never the model's paraphrase.
//   * **The profile's exact shape** (`profileValue`): a value that would need
//     a guess is dropped, never clamped.
//
// A dropped item is counted with its reason in the routine's `runs` row, so
// "the fold proposed nothing" and "the fold proposed three things that were
// all refused" are different, visible facts.

import { PROFILE_PATH, WORKING_STYLE_PATH, isProfileFactKey, profileValue, profileYaml, type ProfileFactKey, type ProfileValue } from "./edits.js";

export const LEARNED_KINDS = ["preference", "lesson", "profile"] as const;
export type LearnedKind = (typeof LEARNED_KINDS)[number];
const isLearnedKind = (k: unknown): k is LearnedKind => typeof k === "string" && (LEARNED_KINDS as readonly string[]).includes(k);

export const MAX_ITEMS = 10; // limit: fixed — one fold's proposals are read by a person in one sitting; more is noise the owner has to decline
export const MAX_QUOTE_CHARS = 280; // limit: fixed — a quote is a sentence the owner typed, not a paragraph
export const MIN_QUOTE_CHARS = 3; // limit: fixed — "ok" is not a preference
export const MAX_LESSON_CHARS = 200; // limit: fixed — a lesson is one line of Working Style

/** One turn the fold showed, as the harvest checks an item against it. */
export interface FoldTurn {
  /** `session_archive.id` — the handle the brief shows as `#<id>`. */
  id: number;
  session_id: string;
  turn_id: string;
  thread: string;
  ts: string;
  /** Everything the OWNER typed in this turn — the only text a quote may come from. */
  owner: string;
}

/** An item that passed every check: what would be written, where, and the turn it came from. */
export interface LearnedItem {
  kind: LearnedKind;
  /** The file it lands in — fixed by its kind, never by the model. */
  path: typeof WORKING_STYLE_PATH | typeof PROFILE_PATH;
  /** What Approve writes: a preference's quote, a lesson's text, or a profile key's line. */
  line: string;
  /** The owner's words, as they typed them — the evidence, shown on the request. Absent only on a lesson that quotes nothing. */
  quote?: string | undefined;
  key?: ProfileFactKey | undefined;
  value?: ProfileValue | undefined;
  /** Provenance (screen-12 §5.3): the session and turn it came from. */
  archive_id: number;
  session_id: string;
  turn_id: string;
  thread: string;
  ts: string;
}

export interface DroppedItem {
  /** Its position in the block, from 0. */
  index: number;
  reason: string;
}

export type ParsedBlock =
  | { state: "none" } // no ```learned block at all
  | { state: "invalid"; why: string } // a block that is not a JSON list
  | { state: "list"; items: unknown[] };

const BLOCK_RE = /```learned[ \t]*\r?\n([\s\S]*?)\r?\n?```/g;

/** The LAST ```learned block of a reply, parsed. */
export function parseLearnedBlock(reply: string): ParsedBlock {
  const blocks = [...reply.matchAll(BLOCK_RE)];
  const last = blocks.at(-1);
  if (last === undefined) return { state: "none" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(last[1] ?? "");
  } catch (err) {
    return { state: "invalid", why: `not JSON (${err instanceof Error ? err.message : String(err)})` };
  }
  return Array.isArray(parsed) ? { state: "list", items: parsed } : { state: "invalid", why: "not a JSON list" };
}

/** Text as a quote is compared: NFC, typographic quotes straightened, whitespace collapsed. */
export function normaliseWords(s: string): string {
  return s
    .normalize("NFC")
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, (d) => d) // dashes are the owner's; kept as typed
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The owner's own span for `quote` in `owner`, as THEY wrote it, or null when
 * they never said it. Case is forgiven in the search (a model capitalises a
 * sentence it lifts); the text returned is always the owner's.
 */
export function ownersSpan(owner: string, quote: string): string | null {
  const hay = normaliseWords(owner);
  const needle = normaliseWords(quote)
    .replace(/^["']+|["']+$/g, "")
    .trim();
  if (needle.length < MIN_QUOTE_CHARS) return null;
  // case folding that changes a string's length (a dotted İ) would misplace the span: search exactly instead
  const folds = hay.toLowerCase().length === hay.length && needle.toLowerCase().length === needle.length;
  const at = folds ? hay.toLowerCase().indexOf(needle.toLowerCase()) : hay.indexOf(needle);
  return at === -1 ? null : hay.slice(at, at + needle.length);
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** Check every item of a parsed block against the turns the fold showed. Pure. */
export function checkItems(raw: readonly unknown[], turns: ReadonlyMap<number, FoldTurn>): { items: LearnedItem[]; dropped: DroppedItem[] } {
  const items: LearnedItem[] = [];
  const dropped: DroppedItem[] = [];
  const seen = new Set<string>();
  raw.forEach((entry, index) => {
    const drop = (reason: string): void => void dropped.push({ index, reason });
    if (index >= MAX_ITEMS) return drop(`over_limit: at most ${MAX_ITEMS} items a fold`);
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return drop("not_an_object");
    const e = entry as Record<string, unknown>;
    if (!isLearnedKind(e.kind)) return drop(`unknown_kind: ${JSON.stringify(e.kind)} is not one of ${LEARNED_KINDS.join(", ")}`);
    const kind = e.kind;
    const turn = typeof e.turn === "number" ? turns.get(e.turn) : typeof e.turn === "string" ? turns.get(Number(e.turn.replace(/^#/, ""))) : undefined;
    if (turn === undefined) return drop("unknown_turn: it cites a turn this fold did not show");

    const rawQuote = str(e.quote);
    if (rawQuote !== undefined && normaliseWords(rawQuote).length > MAX_QUOTE_CHARS) return drop(`quote_too_long: at most ${MAX_QUOTE_CHARS} characters`);
    const quote = rawQuote === undefined ? null : ownersSpan(turn.owner, rawQuote);
    if (rawQuote !== undefined && quote === null) return drop("not_the_owners_words: the quote is not in what the owner typed in that turn");

    const at = { archive_id: turn.id, session_id: turn.session_id, turn_id: turn.turn_id, thread: turn.thread, ts: turn.ts };
    let item: LearnedItem;
    if (kind === "preference") {
      if (quote === null) return drop("no_quote: a preference is the owner's own words");
      item = { kind, path: WORKING_STYLE_PATH, line: quote, quote, ...at };
    } else if (kind === "lesson") {
      const text = str(e.text) === undefined ? "" : normaliseWords(str(e.text)!);
      if (text.length < MIN_QUOTE_CHARS || text.length > MAX_LESSON_CHARS) return drop(`bad_text: a lesson is one line of ${MIN_QUOTE_CHARS} to ${MAX_LESSON_CHARS} characters`);
      item = { kind, path: WORKING_STYLE_PATH, line: text, ...(quote !== null ? { quote } : {}), ...at };
    } else {
      if (quote === null) return drop("no_quote: a profile fact is something the owner said");
      if (!isProfileFactKey(e.key)) return drop(`unknown_key: ${JSON.stringify(e.key)} is not a fact Me/profile.md keeps`);
      const value = profileValue(e.key, e.value);
      if (!value.ok) return drop(`bad_value: ${value.why}`);
      item = { kind, path: PROFILE_PATH, line: `${e.key}: ${profileYaml(e.key, value.value)}`, quote, key: e.key, value: value.value, ...at };
    }
    // one proposal per line (and per profile key) a fold — the first wins
    const id = item.kind === "profile" ? `${item.path}#${item.key}` : `${item.path}#${normaliseWords(item.line).toLowerCase()}`;
    if (seen.has(id)) return drop(item.kind === "profile" ? `duplicate: ${item.key} is already proposed in this fold` : "duplicate: the same line twice");
    seen.add(id);
    items.push(item);
  });
  return { items, dropped };
}
