// The task line — §1.1–§1.4 of docs/product/daily-flow-spec.md (P1-1).
//
// A user's todo is a `- [ ]` line in a vault note (D1), and the fields on it
// are ENGLISH-SHAPED TRAILING TOKENS (D2): `due friday`, `p1`, `size l`,
// `@Jim`, `every weekday`, `someday`. Not Dataview's `[due:: 2026-09-22]`, which renders
// as literal bracketed text; not the Tasks plugin's emoji, whose diff is
// unreadable and whose glyph table belongs to someone else. This file READS
// all three and EMITS exactly one.
//
// Three properties carry the design:
//
//   * THE TRAILING RUN. Fields are a run at the END of the line: the anchor
//     first, then recognised field tokens while they keep matching, stopping
//     at the first token that is not a field. Everything to its left is the
//     task's text, verbatim. That single rule is what makes the grammar safe
//     to type without thinking — `Ask @Jim about the pricing deck` assigns
//     nobody, because `deck` is not a field and the run never reaches `@Jim`.
//   * NOTHING IS WRITTEN (D3). Normalisation happens in the index. This
//     module resolves `due friday` to a date and hands it back; the bytes on
//     disk stay the user's. The one thing Metistry ever adds to a line is the
//     `^mt-…` anchor, and its only writers are the plugin and whatever
//     creates a line from scratch — never a routine. The one exception is
//     the owner's own doors (design-build-plan §2.11): the Tick door's
//     `setTaskChecked` flips the box and writes or removes one `done <date>`
//     (T2-4), and the Defer door's `setTaskScheduled` writes one `do <date>`
//     or one `someday` (T2-5, K6), and the Link door's `setTaskRef` adds one
//     `linear:`/`gh:` ref (T4-25) — each nothing else, and each refusing any
//     line where it cannot prove that by re-parsing its own output.
//   * A FIELD IT CANNOT READ IS NEVER GUESSED. `due nextweek` sets no date;
//     it sets `parse_warning`, which the day's plan renders as one visible
//     line naming the token. A wrong date is worse than no date.
//
// Pure: no filesystem, no database, no vault, no clock of its own. Relative
// dates resolve against a supplied `now` and a time zone (`METISTRY_TZ`,
// invariant 7), and the date they were resolved against comes back as
// `parsed_on` — so a line parsed on one day is never silently re-read as a
// different date on another.
//
// The result maps one-to-one onto `vault_tasks` (§1.5): `due`,
// `scheduled_for`, `start_on`, `done_on`, `priority`, `size`, `type`,
// `assigned`, `project`, `waiting`, `someday`, `ext_refs`, `work_id`,
// `source`, `parse_warning`, `parsed_on`, and `recurrence` → (`recur_rule`,
// `recur_next`). Three columns are deliberately NOT here because they are
// facts about the index rather than about the line: `done_on_observed`,
// `duplicate_of` and `first_seen_on`. `assigned` comes back as the person's
// NAME as written; resolving it to a `People/…md` path needs the vault, so
// that is the indexer's (P1-4), and `text_norm` — the dedupe key — is here
// because it is a pure function of the text.

import { createHash } from "node:crypto";
import { optionalEnv } from "./config.js";

// --- the closed vocabularies --------------------------------------------------

/** P1–P4 (D5): four levels, 1 most important. Unset sorts as 3 and is never written back as one. */
export const TASK_PRIORITIES = [1, 2, 3, 4] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

/** What an unset priority SORTS as (`coalesce(priority, 3)`), not a value the parser ever stores. */
export const UNSET_PRIORITY = 3; // limit: fixed — D5: the middle of a four-point scale, so a user only ever types a departure from normal

/** Both spellings of the same four levels (D5), so neither has to win. */
export const PRIORITY_ALIASES: Readonly<Record<string, TaskPriority>> = {
  p1: 1, p2: 2, p3: 3, p4: 4,
  critical: 1, high: 2, normal: 3, low: 4,
};

export const TASK_SIZES = ["s", "m", "l"] as const;
export type TaskSize = (typeof TASK_SIZES)[number];

export const SIZE_ALIASES: Readonly<Record<string, TaskSize>> = {
  s: "s", m: "m", l: "l", small: "s", medium: "m", large: "l",
};

/** Size ORDER, for `size <= m` in the filter vocabulary. The minutes a size is worth are `Me/profile.md`'s, never a literal here (§6.2). */
export const SIZE_RANK: Readonly<Record<TaskSize, number>> = { s: 1, m: 2, l: 3 };

/**
 * The link schemes a task line may carry (§1.3 "links"). Closed on purpose:
 * a general `<word>:<word>` token would swallow ordinary prose that happens
 * to end in a colon, and a new scheme is a product decision — one line here
 * plus whatever collector joins on it.
 *
 * `work:418` is not in this list because it is not a reference: it is the
 * promotion pointer (§3) and lands in `work_id`.
 */
export const EXT_REF_SCHEMES = ["linear", "gh"] as const;

/** The recurrence units of §4. `weekday` means Monday–Friday; there is no RRULE and there will not be one. */
export const RECUR_UNITS = ["day", "weekday", "week", "month", "year"] as const;
export type RecurUnit = (typeof RECUR_UNITS)[number];

/** Which compatibility reader fired on a line. Present so a caller can say "read, never emitted" and mean it. */
export const TASK_COMPAT_READERS = ["dataview", "tasks-emoji"] as const;
export type TaskCompatReader = (typeof TASK_COMPAT_READERS)[number];

// --- the anchor (§1.2) --------------------------------------------------------

/** `^mt-<8 Crockford base32>`, stored without the caret. Obsidian block ids admit Latin letters, numbers and dashes — `^mt_7x2k` is not legal and is not minted. */
export const ANCHOR_PREFIX = "mt-";
export const ANCHOR_LENGTH = 8; // limit: fixed — §1.2's block id: 8 Crockford base32 characters, minted once and never re-minted
/** Crockford base32: no I, L, O or U, so nothing a human retypes can be read two ways. */
export const ANCHOR_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

const CANONICAL_ANCHOR_RE = /^mt-[0-9a-hjkmnp-tv-z]{8}$/;
/** True for an anchor in the canonical shape — what a minter must produce. The reader below is deliberately looser, because it is reading, not minting. */
export const isTaskAnchor = (s: string): boolean => CANONICAL_ANCHOR_RE.test(s);

/** Read side: any `^mt-…` at the end of the line, so a hand-typed or older anchor is still an identity rather than stray text. */
const TRAILING_ANCHOR_RE = /\s*\^(mt-[0-9a-z]{2,16})\s*$/i;

// --- shapes -------------------------------------------------------------------

export interface TaskRecurrence {
  /** The `every …` clause verbatim, exactly as `vault_tasks.recur_rule` stores it. */
  rule: string;
  unit: RecurUnit;
  /** `every 2 weeks` → 2. Only meaningful once a previous instance exists; see `nextRecurrence`. */
  interval: number;
  /** `every week due friday` → 5 (0 = Sunday). */
  pin_weekday: number | null;
  /** `every month due 28` → 28. */
  pin_day: number | null;
  /** `recur_next`: the next day this rule is due, on or after the parse date. */
  next: string;
}

export interface ParsedTaskLine {
  /** Leading whitespace and the list marker, kept so `formatTaskLine` puts the line back where it was. */
  indent: string;
  marker: string;
  checked: boolean;
  dropped: boolean;
  /** The line minus its fields and anchor, verbatim. */
  text: string;
  /** Lowercased, punctuation-stripped, whitespace-collapsed — the duplicate key of §2.3. */
  text_norm: string;
  anchor: string | null;
  due: string | null;
  scheduled_for: string | null;
  start_on: string | null;
  done_on: string | null;
  priority: TaskPriority | null;
  size: TaskSize | null;
  type: string | null;
  /** The person as written (`Jim`, `Jim Fallon`). Resolving it to a `People/…md` path needs the vault and is the indexer's. */
  assigned: string | null;
  /** `@[[Jim Fallon]]` — a real wikilink, which is what lands the edge in `knowledge_links` for free. */
  assigned_is_wikilink: boolean;
  project: string | null;
  waiting: boolean;
  /**
   * The `someday` token (K6, T2-5): deliberately not for any day — deferred
   * without a date. The one spelling written is the bare word; the Tasks
   * plugin has no such field and a `#someday` tag is the user's own, so
   * neither is read as this.
   */
  someday: boolean;
  recurrence: TaskRecurrence | null;
  source: string | null;
  ext_refs: string[];
  work_id: number | null;
  /** Every token the parser could not read, joined — one visible line in the day's plan, never a guess. */
  parse_warning: string | null;
  /** The same tokens, verbatim and separate, so `formatTaskLine` can put back what it could not understand. */
  unreadable: string[];
  /** Which compatibility readers fired. Nothing Metistry writes ever produces one of these. */
  compat: TaskCompatReader[];
  /** The date the relative tokens were resolved against (`vault_tasks.parsed_on`). */
  parsed_on: string;
}

export interface TaskDateOptions {
  /** The instant to resolve relative dates against. Default: now. */
  now?: Date | undefined;
  /**
   * An IANA zone. Default `METISTRY_TZ`, then `TZ` (the container sets it FROM
   * `METISTRY_TZ`), then UTC — guessing the host's zone would make the same
   * line parse differently on two machines. A missing `METISTRY_TZ` is
   * `metistry doctor`'s to report, not a reason to refuse a line.
   */
  timeZone?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}

// --- dates, against METISTRY_TZ ----------------------------------------------
//
// Hand-rolled against `Intl`, which is the only tz database in the runtime and
// needs no dependency. Everything below works on a civil (y, m, d) triple:
// once the user's calendar date is known, day arithmetic has no DST to trip
// over, which is exactly why the conversion happens once, at the top.

interface Civil {
  y: number;
  m: number;
  d: number;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");
const toISO = (c: Civil): string => `${String(c.y).padStart(4, "0")}-${pad2(c.m)}-${pad2(c.d)}`;
const utcOf = (c: Civil): number => Date.UTC(c.y, c.m - 1, c.d);
const civilOf = (ms: number): Civil => {
  const d = new Date(ms);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
};
const addDays = (c: Civil, n: number): Civil => civilOf(utcOf(c) + n * 86_400_000);
/** 0 = Sunday, matching `Date#getUTCDay` and the weekday table below. */
const weekdayOf = (c: Civil): number => new Date(utcOf(c)).getUTCDay();
const daysInMonth = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();
const isRealDate = (c: Civil): boolean =>
  c.m >= 1 && c.m <= 12 && c.d >= 1 && c.d <= daysInMonth(c.y, c.m);

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"] as const;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;

const monthIndex = (word: string): number => {
  const w = word.toLowerCase();
  const i = MONTHS.findIndex((m) => m === w || m.slice(0, 3) === w);
  return i === -1 ? -1 : i + 1;
};
const weekdayIndex = (word: string): number => {
  const w = word.toLowerCase();
  return WEEKDAYS.findIndex((d) => d === w || d.slice(0, 3) === w);
};

function zoneOf(opts: TaskDateOptions): string {
  if (opts.timeZone) return opts.timeZone;
  const env = opts.env ?? process.env;
  return optionalEnv("METISTRY_TZ", optionalEnv("TZ", "UTC", env), env);
}

/**
 * The calendar date in `timeZone` at `now` — the user's today, not UTC's.
 * Throws on a zone the runtime does not know, because a component running in
 * a zone nobody can name is misconfigured and should say so once, loudly
 * (`config.ts`'s habit), rather than silently answer in UTC forever.
 */
export function calendarDate(now: Date, timeZone: string): string {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
  } catch {
    throw new Error(`not a time zone this runtime knows: "${timeZone}" (METISTRY_TZ; see .env.example)`);
  }
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

const parseISO = (s: string): Civil | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m?.[1] || !m[2] || !m[3]) return null;
  const c = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
  return isRealDate(c) ? c : null;
};

/** The one place "what day is it for this user" is answered. */
export function taskToday(opts: TaskDateOptions = {}): string {
  return calendarDate(opts.now ?? new Date(), zoneOf(opts));
}

/**
 * The date vocabulary, shared by the line parser and the filter vocabulary so
 * one date language exists (D15's instinct applied to values):
 *
 *   `2026-09-22` · `today` · `tomorrow` · `yesterday` · a weekday name or its
 *   three-letter form (the NEXT such day, never today — §1.3) · `next week`
 *   /`next month`/`next year`/`next friday` · `22 sep` · `sep 22` · `+3d` ·
 *   `+2w`.
 *
 * Anything else returns null, and null becomes a parse warning rather than a
 * date. `next week` is seven days out and `next month` is the same day in the
 * next month (clamped to its length), stated here because the alternative
 * readings — "Monday of next week", "the 1st" — are guesses.
 */
export function resolveTaskDate(value: string, opts: TaskDateOptions = {}): string | null {
  const today = parseISO(taskToday(opts));
  if (!today) return null;
  return resolveAgainst(value, today);
}

function resolveAgainst(value: string, today: Civil): string | null {
  const v = value.trim().toLowerCase().replace(/\s+/g, " ");
  if (v === "") return null;

  const iso = parseISO(v);
  if (iso) return toISO(iso);

  if (v === "today") return toISO(today);
  if (v === "tomorrow") return toISO(addDays(today, 1));
  if (v === "yesterday") return toISO(addDays(today, -1));

  const wd = weekdayIndex(v);
  if (wd !== -1) return toISO(nextWeekday(today, wd, false));

  const next = /^next (\S+)$/.exec(v);
  if (next?.[1]) {
    const word = next[1];
    if (word === "week") return toISO(addDays(today, 7));
    if (word === "month") return toISO(addMonths(today, 1));
    if (word === "year") return toISO(addMonths(today, 12));
    const nwd = weekdayIndex(word);
    if (nwd !== -1) return toISO(nextWeekday(today, nwd, false));
    return null;
  }

  const rel = /^\+(\d{1,3})([dw])$/.exec(v);
  if (rel?.[1] && rel[2]) return toISO(addDays(today, Number(rel[1]) * (rel[2] === "w" ? 7 : 1)));

  const dayFirst = /^(\d{1,2}) ([a-z]{3,9})$/.exec(v);
  if (dayFirst?.[1] && dayFirst[2]) {
    const mi = monthIndex(dayFirst[2]);
    if (mi !== -1) return onOrAfterToday(today, mi, Number(dayFirst[1]));
  }
  const monthFirst = /^([a-z]{3,9}) (\d{1,2})$/.exec(v);
  if (monthFirst?.[1] && monthFirst[2]) {
    const mi = monthIndex(monthFirst[1]);
    if (mi !== -1) return onOrAfterToday(today, mi, Number(monthFirst[2]));
  }
  return null;
}

/**
 * Move a `YYYY-MM-DD` by whole days. The filter vocabulary turns `due < today`
 * into `due <= today - 1 day` with it, which is exact rather than approximate:
 * these are calendar dates, so a strict bound IS the next day's inclusive one.
 */
export function addTaskDays(date: string, days: number): string | null {
  const c = parseISO(date);
  return c ? toISO(addDays(c, days)) : null;
}

/** A weekday name means the NEXT one (§1.3); a recurrence pin includes today, or `every week due friday` would skip the Friday it was typed on. */
function nextWeekday(today: Civil, weekday: number, includeToday: boolean): Civil {
  const delta = (weekday - weekdayOf(today) + 7) % 7;
  return addDays(today, delta === 0 && !includeToday ? 7 : delta);
}

function addMonths(c: Civil, n: number): Civil {
  const total = (c.y * 12 + (c.m - 1)) + n;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  return { y, m, d: Math.min(c.d, daysInMonth(y, m)) };
}

/** `22 sep` names a day, not a year: the one that has not happened yet. */
function onOrAfterToday(today: Civil, month: number, day: number): string | null {
  if (day < 1 || day > daysInMonth(today.y, month)) return null;
  const thisYear = { y: today.y, m: month, d: day };
  if (utcOf(thisYear) >= utcOf(today)) return toISO(thisYear);
  const nextYear = { y: today.y + 1, m: month, d: Math.min(day, daysInMonth(today.y + 1, month)) };
  return toISO(nextYear);
}

/**
 * `recur_next` — the next day a rule is due, on or after `from` (a
 * `YYYY-MM-DD`). Pass `after` to ask for the next one STRICTLY after a
 * previous instance's date, which is what the indexer does once an instance
 * exists; with only the line to go on, "every week" is due today, and §4's
 * one-open-instance-per-rule guard is what stops that becoming thirty lines.
 */
export function nextRecurrence(rule: Pick<TaskRecurrence, "unit" | "interval" | "pin_weekday" | "pin_day">, from: string, after?: string): string | null {
  const start = parseISO(from);
  if (!start) return null;
  const floorC = after ? parseISO(after) : null;
  const base = floorC ? addDays(floorC, intervalDays(rule, floorC)) : start;
  const at = utcOf(base) > utcOf(start) ? base : start;
  return toISO(pinned(rule, at));
}

function intervalDays(rule: Pick<TaskRecurrence, "unit" | "interval">, from: Civil): number {
  switch (rule.unit) {
    case "day": return rule.interval;
    case "weekday": return 1;
    case "week": return 7 * rule.interval;
    case "month": return utcDiffDays(from, addMonths(from, rule.interval));
    case "year": return utcDiffDays(from, addMonths(from, 12 * rule.interval));
  }
}

const utcDiffDays = (a: Civil, b: Civil): number => Math.round((utcOf(b) - utcOf(a)) / 86_400_000);

function pinned(rule: Pick<TaskRecurrence, "unit" | "pin_weekday" | "pin_day">, at: Civil): Civil {
  if (rule.unit === "weekday") {
    const wd = weekdayOf(at);
    return wd === 0 ? addDays(at, 1) : wd === 6 ? addDays(at, 2) : at;
  }
  if (rule.pin_weekday !== null) return nextWeekday(at, rule.pin_weekday, true);
  if (rule.pin_day !== null) {
    const day = Math.min(rule.pin_day, daysInMonth(at.y, at.m));
    if (at.d <= day) return { y: at.y, m: at.m, d: day };
    const nextMonth = addMonths({ y: at.y, m: at.m, d: 1 }, 1);
    return { y: nextMonth.y, m: nextMonth.m, d: Math.min(rule.pin_day, daysInMonth(nextMonth.y, nextMonth.m)) };
  }
  return at;
}

// --- text ---------------------------------------------------------------------

/** The dedupe key of §2.3: lowercased, punctuation stripped, whitespace collapsed. Deterministic, no model. */
export const normalizeTaskText = (text: string): string =>
  text.toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, " ").replace(/\s+/g, " ").trim();

// --- the line -----------------------------------------------------------------

/** `- [ ] `, `* [x] `, `+ [-] `. GFM's three bullet markers; `[-]` reads as dropped if present and nothing requires it. */
const LINE_RE = /^([ \t]*)([-*+])[ \t]+\[([ xX-])\](?:[ \t]+(.*))?$/;

/**
 * How far back from the end of the line the trailing run may start. A run is a
 * handful of fields; scanning the whole line for one is how a paragraph pasted
 * into a checkbox becomes quadratic.
 */
const RUN_SCAN_TOKENS = 64; // limit: fixed — the trailing run is fields, not prose; nothing legitimate reaches back further

/** `parse_warning` is one column and one rendered line, not a report. */
const PARSE_WARNING_CHARS = 200; // limit: fixed — it renders as one line in the day's plan (§1.4)

interface Tok {
  text: string;
  lower: string;
  start: number;
  end: number;
}

/** Whitespace-separated, except that `[[A Page]]` and `@[[A Page]]` are one token — a person's name has a space in it. */
function tokenize(body: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < body.length) {
    const ch = body[i] ?? "";
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    const start = i;
    const linkAt = body.startsWith("[[", i) ? i : body.startsWith("@[[", i) ? i + 1 : -1;
    if (linkAt !== -1) {
      const close = body.indexOf("]]", linkAt + 2);
      if (close !== -1) {
        i = close + 2;
        while (i < body.length && !/\s/.test(body[i] ?? "")) i += 1;
        toks.push({ text: body.slice(start, i), lower: body.slice(start, i).toLowerCase(), start, end: i });
        continue;
      }
    }
    while (i < body.length && !/\s/.test(body[i] ?? "")) i += 1;
    toks.push({ text: body.slice(start, i), lower: body.slice(start, i).toLowerCase(), start, end: i });
  }
  return toks;
}

interface Draft {
  due: DateValue | null;
  scheduled_for: string | null;
  start_on: string | null;
  done_on: string | null;
  priority: TaskPriority | null;
  size: TaskSize | null;
  type: string | null;
  assigned: string | null;
  assigned_is_wikilink: boolean;
  project: string | null;
  waiting: boolean;
  someday: boolean;
  recurrence: Omit<TaskRecurrence, "next"> | null;
  source: string | null;
  ext_refs: string[];
  work_id: number | null;
  unreadable: string[];
  dropped: boolean;
}

const emptyDraft = (): Draft => ({
  due: null, scheduled_for: null, start_on: null, done_on: null, priority: null, size: null,
  type: null, assigned: null, assigned_is_wikilink: false, project: null, waiting: false, someday: false,
  recurrence: null, source: null, ext_refs: [], work_id: null, unreadable: [], dropped: false,
});

interface DateValue {
  date: string | null;
  /** Set when the value was a bare weekday name, so a recurrence can take it as a pin instead of a date. */
  weekday: number | null;
  /** Set when the value was a bare day of the month — only meaningful as a recurrence pin (§4). */
  dayOfMonth: number | null;
  raw: string;
}

interface ClauseRead {
  next: number;
  apply: (d: Draft) => void;
}

const PROJECT_TOKEN_RE = /^\+([a-z][a-z0-9-]{0,39})$/; // `projects.id`'s own shape (db/migrations/0011_projects.sql)
const TYPE_SLUG_RE = /^[a-z][a-z0-9_-]{0,39}$/;        // D6: free text, no enum — a slug so it can be grouped on
const PERSON_RE = /^@([\p{L}][\p{L}\p{N}.'’-]*)$/u;
const PERSON_LINK_RE = /^@\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]$/;
const WORK_REF_RE = /^work:(\d{1,12})$/;
const SOURCE_RE = /^[a-z][a-z0-9_-]*(:.{1,200})?$/;

/** Read one date value starting at token `i`. Consumes at least one token when there is one; an unreadable value is still a value, which is what keeps the run going and produces a warning instead of stealing the word for the text. */
function readDateValue(toks: Tok[], i: number, body: string, today: Civil): { next: number; value: DateValue } | null {
  const first = toks[i];
  if (!first) return null;
  const second = toks[i + 1];
  const raw2 = second ? body.slice(first.start, second.end) : "";

  if (second) {
    const two = resolveAgainst(`${first.lower} ${second.lower}`, today);
    if (two) return { next: i + 2, value: { date: two, weekday: null, dayOfMonth: null, raw: raw2 } };
  }
  const one = resolveAgainst(first.lower, today);
  if (one) {
    const wd = weekdayIndex(first.lower);
    return { next: i + 1, value: { date: one, weekday: wd === -1 ? null : wd, dayOfMonth: null, raw: first.text } };
  }
  if (/^\d{1,2}$/.test(first.lower)) {
    const n = Number(first.lower);
    if (n >= 1 && n <= 31) return { next: i + 1, value: { date: null, weekday: null, dayOfMonth: n, raw: first.text } };
  }
  return { next: i + 1, value: { date: null, weekday: null, dayOfMonth: null, raw: first.text } };
}

function readRecurrence(toks: Tok[], i: number, body: string): { next: number; rule: Omit<TaskRecurrence, "next"> } | null {
  const unitAt = (tok: Tok | undefined): RecurUnit | null => {
    if (!tok) return null;
    const w = tok.lower.replace(/s$/, "");
    return (RECUR_UNITS as readonly string[]).includes(w) ? (w as RecurUnit) : null;
  };
  const start = toks[i];
  if (!start) return null;

  const second = toks[i + 1];
  if (!second) return null;

  const one = unitAt(second);
  if (one) return { next: i + 2, rule: rule(one, 1, null, null, body.slice(start.start, second.end)) };

  const wd = weekdayIndex(second.lower);
  if (wd !== -1) return { next: i + 2, rule: rule("week", 1, wd, null, body.slice(start.start, second.end)) };

  const third = toks[i + 2];
  const n = /^\d{1,3}$/.test(second.lower) ? Number(second.lower) : second.lower === "other" ? 2 : 0;
  const unit = unitAt(third);
  if (n > 0 && unit && third) return { next: i + 3, rule: rule(unit, n, null, null, body.slice(start.start, third.end)) };
  return null;

  function rule(unit: RecurUnit, interval: number, pin_weekday: number | null, pin_day: number | null, text: string): Omit<TaskRecurrence, "next"> {
    return { rule: text, unit, interval, pin_weekday, pin_day };
  }
}

/** One clause of the trailing run, or null when the token at `i` is not a field — which is where the run, and the parse, stops. */
function readClause(toks: Tok[], i: number, body: string, today: Civil): ClauseRead | null {
  const tok = toks[i];
  if (!tok) return null;
  const word = tok.lower;

  const dateField = (["due", "do", "start", "done"] as const).find((f) => f === word);
  if (dateField) {
    const read = readDateValue(toks, i + 1, body, today);
    if (!read) return null; // a keyword with nothing after it is a word, not a field
    const { value } = read;
    const raw = `${tok.text} ${value.raw}`;
    return {
      next: read.next,
      apply: (d) => {
        if (dateField === "due") {
          d.due = value;
          return;
        }
        if (!value.date) {
          d.unreadable.push(raw);
          return;
        }
        if (dateField === "do") d.scheduled_for = value.date;
        else if (dateField === "start") d.start_on = value.date;
        else d.done_on = value.date;
      },
    };
  }

  const priority = PRIORITY_ALIASES[word];
  if (priority) return { next: i + 1, apply: (d) => { d.priority = priority; } };

  if (word === "priority") {
    const v = toks[i + 1];
    if (!v) return null;
    const alias = PRIORITY_ALIASES[v.lower] ?? PRIORITY_ALIASES[`p${v.lower}`];
    const raw = body.slice(tok.start, v.end);
    return { next: i + 2, apply: (d) => { if (alias) d.priority = alias; else d.unreadable.push(raw); } };
  }

  if (word === "size") {
    const v = toks[i + 1];
    if (!v) return null;
    const size = SIZE_ALIASES[v.lower];
    const raw = body.slice(tok.start, v.end);
    return { next: i + 2, apply: (d) => { if (size) d.size = size; else d.unreadable.push(raw); } };
  }

  if (word === "type") {
    const v = toks[i + 1];
    if (!v) return null;
    const slug = v.lower;
    const raw = body.slice(tok.start, v.end);
    return { next: i + 2, apply: (d) => { if (TYPE_SLUG_RE.test(slug)) d.type = slug; else d.unreadable.push(raw); } };
  }

  if (word === "source") {
    const v = toks[i + 1];
    if (!v) return null;
    const value = v.text;
    const raw = body.slice(tok.start, v.end);
    return { next: i + 2, apply: (d) => { if (SOURCE_RE.test(value)) d.source = value; else d.unreadable.push(raw); } };
  }

  if (word === "waiting") return { next: i + 1, apply: (d) => { d.waiting = true; } };

  if (word === SOMEDAY_TOKEN) return { next: i + 1, apply: (d) => { d.someday = true; } };

  if (word === "every") {
    const read = readRecurrence(toks, i, body);
    if (read) return { next: read.next, apply: (d) => { d.recurrence = read.rule; } };
    const v = toks[i + 1];
    if (!v) return null;
    const raw = body.slice(tok.start, v.end);
    return { next: i + 2, apply: (d) => { d.unreadable.push(raw); } };
  }

  const link = PERSON_LINK_RE.exec(tok.text);
  if (link?.[1]) {
    const name = link[1].trim();
    return { next: i + 1, apply: (d) => { d.assigned = name; d.assigned_is_wikilink = true; } };
  }
  const person = PERSON_RE.exec(tok.text);
  if (person?.[1]) {
    const name = person[1];
    return { next: i + 1, apply: (d) => { d.assigned = name; d.assigned_is_wikilink = false; } };
  }

  const project = PROJECT_TOKEN_RE.exec(tok.lower);
  if (project?.[1]) {
    const slug = project[1];
    return { next: i + 1, apply: (d) => { d.project = slug; } };
  }

  const work = WORK_REF_RE.exec(tok.lower);
  if (work?.[1]) {
    const id = Number(work[1]);
    return { next: i + 1, apply: (d) => { d.work_id = id; } };
  }

  const scheme = EXT_REF_SCHEMES.find((s) => tok.lower.startsWith(`${s}:`) && tok.text.length > s.length + 1);
  if (scheme) {
    const ref = tok.text;
    return { next: i + 1, apply: (d) => { if (!d.ext_refs.includes(ref)) d.ext_refs.push(ref); } };
  }

  return null;
}

/** The trailing run: the longest suffix of tokens that is fields all the way to the end. Returns the token index the run starts at. */
function runStart(toks: Tok[], body: string, today: Civil): { index: number; applies: ((d: Draft) => void)[] } {
  const floor = Math.max(0, toks.length - RUN_SCAN_TOKENS);
  for (let start = floor; start < toks.length; start += 1) {
    const applies: ((d: Draft) => void)[] = [];
    let i = start;
    let ok = true;
    while (i < toks.length) {
      const clause = readClause(toks, i, body, today);
      if (!clause || clause.next <= i) {
        ok = false;
        break;
      }
      applies.push(clause.apply);
      i = clause.next;
    }
    if (ok) return { index: start, applies };
  }
  return { index: toks.length, applies: [] };
}

// --- the compatibility readers (§1.4) ----------------------------------------
//
// Read on both, emit on neither. A user who already runs Dataview or the Tasks
// plugin is not locked out; nothing in Metistry ever writes these back, and
// `formatTaskLine` has no code path that can produce one.
//
// Native trailing-run fields WIN: if a line carries both `due 2026-09-22` and
// `📅 2026-09-30`, the English one is the one the user typed for us.

const DATAVIEW_RE = /[[(]\s*([a-z][a-z0-9_-]*)\s*::\s*([^\])]*?)\s*[\])]/gi;

/** The Tasks plugin's signifiers. Five priority glyphs collapse onto four levels (D5); `🆔`/`⛔`/`🏁`/`➕` are consumed and dropped because no column here holds them. */
const EMOJI_RE = /([\u{1F4C5}\u{1F4C6}\u{1F5D3}\u{23F3}\u{231B}\u{1F6EB}\u{2705}\u{274C}\u{2795}\u{1F501}\u{1F194}\u{26D4}\u{1F3C1}\u{1F53A}\u{23EB}\u{1F53C}\u{1F53D}\u{23EC}])\uFE0F?\s*([^\u{1F4C5}\u{1F4C6}\u{1F5D3}\u{23F3}\u{231B}\u{1F6EB}\u{2705}\u{274C}\u{2795}\u{1F501}\u{1F194}\u{26D4}\u{1F3C1}\u{1F53A}\u{23EB}\u{1F53C}\u{1F53D}\u{23EC}]*)/gu;

const EMOJI_PRIORITY: Readonly<Record<string, TaskPriority>> = {
  "\u{1F53A}": 1, // 🔺 highest
  "\u{23EB}": 2,  // ⏫ high
  "\u{1F53C}": 3, // 🔼 medium
  "\u{1F53D}": 4, // 🔽 low
  "\u{23EC}": 4,  // ⏬ lowest — four levels, so the two bottom glyphs meet
};

interface Compat {
  body: string;
  readers: TaskCompatReader[];
  apply: (d: Draft) => void;
}

function readCompat(body: string, today: Civil): Compat {
  const readers: TaskCompatReader[] = [];
  const fills: ((d: Draft) => void)[] = [];
  let cut = false;

  const fillDate = (kind: "due" | "do" | "start" | "done", raw: string): void => {
    const date = resolveAgainst(raw, today);
    if (!date) return;
    fills.push((d) => {
      if (kind === "due") d.due ??= { date, weekday: null, dayOfMonth: null, raw };
      else if (kind === "do") d.scheduled_for ??= date;
      else if (kind === "start") d.start_on ??= date;
      else d.done_on ??= date;
    });
  };

  let out = body.replace(DATAVIEW_RE, (match, key: string, value: string) => {
    const k = key.toLowerCase();
    const v = value.trim();
    const known = (): boolean => {
      switch (k) {
        case "due": fillDate("due", v); return true;
        case "scheduled": fillDate("do", v); return true;
        case "start": fillDate("start", v); return true;
        case "completion": case "completed": case "done": fillDate("done", v); return true;
        case "priority": {
          const p = PRIORITY_ALIASES[v.toLowerCase()] ?? PRIORITY_ALIASES[`p${v.toLowerCase()}`];
          if (p) fills.push((d) => { d.priority ??= p; });
          return p !== undefined;
        }
        case "size": {
          const s = SIZE_ALIASES[v.toLowerCase()];
          if (s) fills.push((d) => { d.size ??= s; });
          return s !== undefined;
        }
        case "type": {
          const t = v.toLowerCase();
          if (TYPE_SLUG_RE.test(t)) fills.push((d) => { d.type ??= t; });
          return TYPE_SLUG_RE.test(t);
        }
        case "repeat": case "recurrence": {
          const toks = tokenize(v);
          const read = readRecurrence(toks, 0, v);
          if (read) fills.push((d) => { d.recurrence ??= read.rule; });
          return read !== null;
        }
        default: return false;
      }
    };
    if (!known()) return match; // someone else's field: it is the user's words, and it stays in the text
    if (!readers.includes("dataview")) readers.push("dataview");
    cut = true;
    return "";
  });

  out = out.replace(EMOJI_RE, (_match, glyph: string, value: string) => {
    // Consume the glyph and only what it is FOR: one token for a date, the
    // recurrence phrase for `🔁`, nothing for the priority glyphs. Whatever is
    // left belongs to the user's sentence, not to the plugin's field.
    const toks = tokenize(value);
    /** The date after the glyph, consumed whether or not a column holds it — a date left behind would read as the user's words. */
    const takeDate = (kind: "due" | "do" | "start" | "done" | null): number => {
      if (!toks[0]) return 0;
      const read = readDateValue(toks, 0, value, today);
      if (!read?.value.date) return 0;
      if (kind) fillDate(kind, read.value.date);
      return read.next;
    };
    let taken = 0;
    switch (glyph) {
      case "\u{1F4C5}": case "\u{1F4C6}": case "\u{1F5D3}": taken = takeDate("due"); break;   // 📅 📆 🗓
      case "\u{23F3}": case "\u{231B}": taken = takeDate("do"); break;                        // ⏳ ⌛
      case "\u{1F6EB}": taken = takeDate("start"); break;                                     // 🛫
      case "\u{2705}": taken = takeDate("done"); break;                                       // ✅
      case "\u{274C}": taken = takeDate(null); fills.push((d) => { d.dropped = true; }); break;   // ❌ cancelled — a cancelled date is not a done date
      case "\u{1F501}": {                                                                     // 🔁
        const read = readRecurrence(toks, 0, value);
        if (read) {
          taken = read.next;
          fills.push((d) => { d.recurrence ??= read.rule; });
        }
        break;
      }
      case "\u{2795}": taken = takeDate(null); break;                                         // ➕ created — read, held by no column
      case "\u{1F194}": case "\u{26D4}": case "\u{1F3C1}": taken = toks[0] ? 1 : 0; break;    // 🆔 ⛔ 🏁 — an id this index does not hold
      default: {
        const p = EMOJI_PRIORITY[glyph];
        if (p) fills.push((d) => { d.priority ??= p; });
        break;
      }
    }
    if (!readers.includes("tasks-emoji")) readers.push("tasks-emoji");
    cut = true;
    const rest = toks[taken];
    const leftover = rest ? value.slice(rest.start) : "";
    return leftover === "" ? "" : ` ${leftover}`;
  });

  if (cut) out = out.replace(/[ \t]{2,}/g, " ").trim();
  return { body: out, readers, apply: (d) => { for (const f of fills) f(d); } };
}

// --- the parse ----------------------------------------------------------------

/**
 * Parse one markdown line. Null when the line is not a task list item — every
 * other line in the vault passes through here untouched, so this has to be
 * cheap and certain about what it is not.
 */
export function parseTaskLine(line: string, opts: TaskDateOptions = {}): ParsedTaskLine | null {
  if (typeof line !== "string") return null;
  const m = LINE_RE.exec(line.replace(/\r$/, ""));
  if (!m) return null;
  const [, indent = "", marker = "-", box = " ", rest = ""] = m;

  const parsed_on = taskToday(opts);
  const today = parseISO(parsed_on);
  if (!today) throw new Error(`could not resolve today in time zone "${zoneOf(opts)}"`);

  let body = rest.trimEnd();
  let anchor: string | null = null;
  const anchorMatch = TRAILING_ANCHOR_RE.exec(body);
  if (anchorMatch?.[1]) {
    anchor = anchorMatch[1].toLowerCase();
    body = body.slice(0, anchorMatch.index).trimEnd();
  }

  const compat = readCompat(body, today);
  const toks = tokenize(compat.body);
  const { index, applies } = runStart(toks, compat.body, today);

  const draft = emptyDraft();
  for (const apply of applies) apply(draft);
  compat.apply(draft);

  const runAt = toks[index];
  const text = (runAt ? compat.body.slice(0, runAt.start) : compat.body).trimEnd();

  // `due 28` / `due friday` on a recurrence line is the pin of §4, not a date.
  let due: string | null = null;
  const recurrence = draft.recurrence;
  if (draft.due) {
    const v = draft.due;
    if (recurrence && v.dayOfMonth !== null) recurrence.pin_day = v.dayOfMonth;
    else if (recurrence && v.weekday !== null) recurrence.pin_weekday = v.weekday;
    else if (v.date) due = v.date;
    else draft.unreadable.push(`due ${v.raw}`);
  }

  const warning = draft.unreadable.join("; ").slice(0, PARSE_WARNING_CHARS);

  return {
    indent,
    marker,
    checked: box.toLowerCase() === "x",
    dropped: box === "-" || draft.dropped,
    text,
    text_norm: normalizeTaskText(text),
    anchor,
    due,
    scheduled_for: draft.scheduled_for,
    start_on: draft.start_on,
    done_on: draft.done_on,
    priority: draft.priority,
    size: draft.size,
    type: draft.type,
    assigned: draft.assigned,
    assigned_is_wikilink: draft.assigned_is_wikilink,
    project: draft.project,
    waiting: draft.waiting,
    someday: draft.someday,
    recurrence: recurrence ? { ...recurrence, next: nextRecurrence(recurrence, parsed_on) ?? parsed_on } : null,
    source: draft.source,
    ext_refs: draft.ext_refs,
    work_id: draft.work_id,
    parse_warning: warning === "" ? null : warning,
    unreadable: draft.unreadable,
    compat: compat.readers,
    parsed_on,
  };
}

/** `someday` (K6): the bare word, never the design's `#someday` tag — a tag is the user's, and one form is emitted. */
export const SOMEDAY_TOKEN = "someday";

/** `do <date>` — the one spelling of a scheduled day, shared by `formatTaskLine` and the Defer door so the two can never write it differently. */
const doClause = (date: string): string => `do ${date}`;

/**
 * Render the canonical English trailing-token form — the ONE shape Metistry
 * ever writes (the plugin's completion, the daily-note template's recurring
 * instance, the Today view's add). Dates come out resolved, because a line
 * the system writes should not depend on the day it was written.
 *
 * A token the parser could not read is put back verbatim at the end of the
 * run: nothing the user typed is silently dropped by a round trip.
 */
export function formatTaskLine(task: ParsedTaskLine): string {
  const fields: string[] = [];
  if (task.assigned) fields.push(task.assigned_is_wikilink ? `@[[${task.assigned}]]` : `@${task.assigned}`);
  if (task.waiting) fields.push("waiting");
  if (task.due) fields.push(`due ${task.due}`);
  if (task.scheduled_for) fields.push(doClause(task.scheduled_for));
  if (task.someday) fields.push(SOMEDAY_TOKEN);
  if (task.start_on) fields.push(`start ${task.start_on}`);
  if (task.done_on) fields.push(`done ${task.done_on}`);
  if (task.priority) fields.push(`p${task.priority}`);
  if (task.size) fields.push(`size ${task.size}`);
  if (task.type) fields.push(`type ${task.type}`);
  if (task.project) fields.push(`+${task.project}`);
  if (task.recurrence) {
    fields.push(task.recurrence.rule);
    if (task.recurrence.pin_day !== null) fields.push(`due ${task.recurrence.pin_day}`);
    else if (task.recurrence.pin_weekday !== null) fields.push(`due ${WEEKDAYS[task.recurrence.pin_weekday] ?? ""}`);
  }
  if (task.source) fields.push(`source ${task.source}`);
  for (const ref of task.ext_refs) fields.push(ref);
  if (task.work_id !== null) fields.push(`work:${task.work_id}`);
  for (const raw of task.unreadable) fields.push(raw);
  if (task.anchor) fields.push(`^${task.anchor}`);

  const box = task.checked ? "x" : task.dropped ? "-" : " ";
  const body = [task.text, ...fields].filter((p) => p !== "").join(" ");
  return `${task.indent}${task.marker} [${box}]${body === "" ? "" : ` ${body}`}`;
}

// --- the Tick door's one edit (design-build-plan §2.11, T2-4) ----------------
//
// The owner ticks a task in the app and the console writes the line as `user`
// (daily-flow-spec §2.2, ruled Q2). What makes that the owner's hand rather
// than a machine rewriting their note is that the edit is INCAPABLE of
// anything else: it takes a line and a boolean, never a patch, and it can
// produce exactly two byte changes — the box, and one `done <date>` clause at
// the end of the trailing run (before the anchor, which Obsidian needs last).
// Undo is the same function with `false`: the box back to a space and that
// clause removed. Every other outcome is a refusal, and the proof is not the
// splice below but the re-parse after it: the line must read back with every
// field but `checked` and `done_on` exactly as it was.

/** One task line in a note, keyed exactly as the reconciler's walk keys it (`apps/reconciler/src/notes.ts` `extractTasks`). */
export interface LocatedTaskLine {
  task_key: string;
  /** 1-based, in the whole file (frontmatter included), as `vault_tasks.line_no` stores it. */
  line_no: number;
  /** The line's bytes, without its line ending. */
  line: string;
  parsed: ParsedTaskLine;
}

/** The walk's frontmatter fence: a leading `---` block. Its lines are never task lines. */
const TASK_FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
/** An opening or closing ``` / ~~~ fence, at the start of a line. */
const TASK_FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

/** `h:<sha256 of text_norm>:<ordinal>` — the key of a line that carries no anchor (daily-flow-spec §1.5). */
export function taskHashKey(textNorm: string, ordinal: number): string {
  return `h:${createHash("sha256").update(textNorm).digest("hex")}:${ordinal}`;
}

/** What a task key looks like: an anchor, or a hash key. Anything else names no line. */
export const TASK_KEY_RE = /^(?:mt-[0-9a-z]{2,16}|h:[0-9a-f]{64}:\d{1,6})$/;

/**
 * Every task line in a note with the key the index gave it. This is the
 * walk's own algorithm, restated here because the console must find a line
 * by the same identity without importing the reconciler (the dependency arrow
 * points one way); `apps/reconciler/test/task-keys-agree.test.ts` holds the
 * two to the same answers. Frontmatter and fenced code are not task lines; the
 * ordinal counts every identical line, anchored or not; a repeated anchor
 * falls back to its hash key.
 */
export function taskLinesOf(content: string, opts: TaskDateOptions = {}): LocatedTaskLine[] {
  const fm = TASK_FRONTMATTER_RE.exec(content);
  const bodyLine = fm ? 1 + (fm[0].match(/\n/g)?.length ?? 0) : 1;
  const body = fm ? content.slice(fm[0].length) : content;
  const out: LocatedTaskLine[] = [];
  const ordinals = new Map<string, number>();
  const used = new Set<string>();
  let fence: string | null = null;
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const f = TASK_FENCE_RE.exec(line)?.[1];
    if (f) {
      if (fence === null) fence = f[0]!;
      else if (fence === f[0]) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const parsed = parseTaskLine(line, opts);
    if (!parsed) continue;
    const ordinal = ordinals.get(parsed.text_norm) ?? 0;
    ordinals.set(parsed.text_norm, ordinal + 1);
    const hashed = taskHashKey(parsed.text_norm, ordinal);
    const key = parsed.anchor !== null && !used.has(parsed.anchor) ? parsed.anchor : hashed;
    if (used.has(key)) continue;
    used.add(key);
    out.push({ task_key: key, line_no: bodyLine + i, line, parsed });
  }
  return out;
}

/** The line in `content` that holds `taskKey`, or null when no line does any more. */
export function locateTaskLine(content: string, taskKey: string, opts: TaskDateOptions = {}): LocatedTaskLine | null {
  return taskLinesOf(content, opts).find((t) => t.task_key === taskKey) ?? null;
}

/**
 * `content` with line `lineNo` (1-based) replaced by `line`, every other byte
 * — including each line's own ending, `\n` or `\r\n` — untouched.
 */
export function replaceLine(content: string, lineNo: number, line: string): string {
  const lines = content.split("\n");
  const i = lineNo - 1;
  if (i < 0 || i >= lines.length) throw new RangeError(`line ${lineNo} is not in the file`);
  const cr = lines[i]!.endsWith("\r") ? "\r" : "";
  lines[i] = `${line}${cr}`;
  return lines.join("\n");
}

export type TaskCheckRefusal = "not_a_task" | "dropped" | "rule" | "already" | "unsafe";

export type TaskCheckEdit =
  | { ok: true; line: string }
  | { ok: false; reason: TaskCheckRefusal; message: string };

/** `- [ ] ` up to the box character: the prefix, and where the one character to flip sits. */
const BOX_RE = /^([ \t]*[-*+][ \t]+\[)([ xX-])\]/;

/** The fields a tick may not change: everything `parseTaskLine` reads but `checked` and `done_on`. */
function unchangedFields(p: ParsedTaskLine): string {
  const { checked: _c, done_on: _d, ...rest } = p;
  return JSON.stringify(rest);
}

/**
 * Tick (`checked: true`) or untick one task line — the Tick door's whole
 * write. Ticking sets the box to `x` and writes `done <date>` at the end of
 * the trailing run (replacing a `done` clause already there); unticking sets
 * it to a space and removes the `done` clause. Nothing else on the line moves.
 *
 * Refused, never approximated: a line that is not a task, a dropped `[-]`
 * line, a recurrence rule (never itself a task, §4), a line already in the
 * asked-for state, and any line where the result does not re-parse to the
 * same task with only `checked` and `done_on` changed — a compatibility
 * marker (`✅ …`) the door did not write, a `done` the run cannot hold.
 */
export function setTaskChecked(line: string, checked: boolean, date: string, opts: TaskDateOptions = {}): TaskCheckEdit {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || parseISO(date) === null) throw new RangeError(`not a calendar date: ${date}`);
  const before = parseTaskLine(line, opts);
  const box = BOX_RE.exec(line);
  const m = LINE_RE.exec(line);
  if (!before || !box || !m || line.includes("\r") || line.includes("\n")) return { ok: false, reason: "not_a_task", message: "the line is not a task line" };
  if (before.dropped) return { ok: false, reason: "dropped", message: "the line is dropped (`[-]`): tick it in the note if it is back" };
  if (before.recurrence) return { ok: false, reason: "rule", message: "the line is a recurrence rule, which is never itself a task — tick the day's instance instead" };
  if (before.checked === checked) return { ok: false, reason: "already", message: checked ? "the line is already ticked" : "the line is not ticked" };

  const boxAt = box[1]!.length;
  const rest = m[4] ?? "";
  const restAt = line.length - rest.length;
  // The trailing run lives before the anchor; the anchor (and whatever
  // whitespace follows the body) is the tail and is never touched.
  const trimmed = rest.trimEnd();
  const anchor = TRAILING_ANCHOR_RE.exec(trimmed);
  const core = anchor ? trimmed.slice(0, anchor.index) : trimmed;
  const tail = rest.slice(core.length);

  const today = parseISO(taskToday(opts));
  if (!today) return { ok: false, reason: "unsafe", message: "could not resolve today" };
  const toks = tokenize(core);
  const run = runStart(toks, core, today);
  let done: { start: number; end: number } | null = null;
  for (let i = run.index; i < toks.length; ) {
    const clause = readClause(toks, i, core, today);
    if (!clause || clause.next <= i) break;
    if (toks[i]!.lower === "done") done = { start: toks[i]!.start, end: toks[clause.next - 1]!.end };
    i = clause.next;
  }

  let edited: string;
  if (checked) {
    edited = done ? `${core.slice(0, done.start)}done ${date}${core.slice(done.end)}` : `${core}${core === "" ? "" : " "}done ${date}`;
  } else if (done) {
    let from = done.start;
    while (from > 0 && (core[from - 1] === " " || core[from - 1] === "\t")) from -= 1;
    let to = done.end;
    if (from === 0) while (to < core.length && (core[to] === " " || core[to] === "\t")) to += 1;
    edited = `${core.slice(0, from)}${core.slice(to)}`;
  } else {
    edited = core;
  }

  const next = `${line.slice(0, boxAt)}${checked ? "x" : " "}${line.slice(boxAt + 1, restAt)}${edited}${tail}`;
  const after = parseTaskLine(next, opts);
  const proven =
    after !== null &&
    after.checked === checked &&
    !after.dropped &&
    after.done_on === (checked ? date : null) &&
    unchangedFields(after) === unchangedFields(before);
  if (!proven) return { ok: false, reason: "unsafe", message: "the line would not read back as the same task with only the box and `done` changed — tick it in the note" };
  return { ok: true, line: next };
}

// --- the Defer door's one edit (design-build-plan §2.11, T2-5; K6) ----------
//
// The owner defers a task in the app: to a day (`do <date>`) or to no day at
// all (`someday`). The same discipline as the Tick door's edit above: a line
// and a deferral in, never a patch; the only bytes it can touch are the `do`
// clauses and `someday` tokens of the trailing run, and the proof is the
// re-parse — every field but `scheduled_for` and `someday` must read back
// exactly as it was. `due` is never moved: it is a hard date the user set.
//
// K6 is why the tokens are English: the design wrote `⏳ <date>` and
// `#someday`, and the parser emits one form (D2/D3), so the door writes
// `formatTaskLine`'s own spelling of each (`doClause`, `SOMEDAY_TOKEN`) and has
// no code path that can produce a glyph. A line whose day came from a Tasks
// plugin `⏳` or a Dataview `[scheduled:: …]` is refused rather than left
// carrying two days that disagree: the door does not rewrite someone else's
// field, and it will not write beside one.

/** A scheduled day in someone else's spelling: the Tasks plugin's `⏳`/`⌛`, Dataview's `[scheduled:: …]`/`(scheduled:: …)` — exactly what `readCompat` reads as one. */
const COMPAT_SCHEDULED_RE = /[\u{23F3}\u{231B}]|[[(]\s*scheduled\s*::/iu;

/** Defer to a day, or to someday. Exactly one. */
export type TaskDeferral = { do: string } | { someday: true };

export type TaskScheduleRefusal = "not_a_task" | "done" | "dropped" | "rule" | "already" | "compat" | "unsafe";

export type TaskScheduleEdit =
  | { ok: true; line: string }
  | { ok: false; reason: TaskScheduleRefusal; message: string };

/** The fields a deferral may not change: everything `parseTaskLine` reads but `scheduled_for` and `someday`. */
function unscheduledFields(p: ParsedTaskLine): string {
  const { scheduled_for: _s, someday: _d, ...rest } = p;
  return JSON.stringify(rest);
}

/**
 * Defer one open task line — the Defer door's whole write.
 *
 * `{do: date}` writes `do <date>`: in place of the run's `do` clause when
 * there is one, else at the end of the trailing run (before the anchor, which
 * Obsidian needs last); a `someday` token on the line goes, because a day was
 * chosen. `{someday: true}` writes `someday` at the end of the run and takes
 * every `do` clause off it. Nothing else on the line moves.
 *
 * Refused, never approximated: not a task line; a ticked line (`done` — it is
 * finished, not waiting); a dropped `[-]` line; a recurrence rule (never
 * itself a task, §4); a line already deferred exactly so; a line whose day
 * came from a compatibility reader (`compat`); and any line where the result
 * does not re-parse to the same task with only `scheduled_for` and `someday`
 * changed (`unsafe`) — a `do` the run cannot hold, a `do` clause it could not
 * read.
 */
export function setTaskScheduled(line: string, when: TaskDeferral, opts: TaskDateOptions = {}): TaskScheduleEdit {
  const date = "do" in when ? when.do : null;
  if (date !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || parseISO(date) === null)) throw new RangeError(`not a calendar date: ${date}`);
  const before = parseTaskLine(line, opts);
  const m = LINE_RE.exec(line);
  if (!before || !m || line.includes("\r") || line.includes("\n")) return { ok: false, reason: "not_a_task", message: "the line is not a task line" };
  if (before.checked) return { ok: false, reason: "done", message: "the line is ticked: it is done, not waiting for a day" };
  if (before.dropped) return { ok: false, reason: "dropped", message: "the line is dropped (`[-]`): bring it back in the note first" };
  if (before.recurrence) return { ok: false, reason: "rule", message: "the line is a recurrence rule, which is never itself a task — defer the day's instance instead" };
  if (date !== null ? before.scheduled_for === date && !before.someday : before.someday && before.scheduled_for === null) {
    return { ok: false, reason: "already", message: date !== null ? `the line is already for ${date}` : "the line is already someday" };
  }

  const rest = m[4] ?? "";
  const restAt = line.length - rest.length;
  const trimmed = rest.trimEnd();
  const anchor = TRAILING_ANCHOR_RE.exec(trimmed);
  const core = anchor ? trimmed.slice(0, anchor.index) : trimmed;
  const tail = rest.slice(core.length);

  const today = parseISO(taskToday(opts));
  if (!today) return { ok: false, reason: "unsafe", message: "could not resolve today" };
  const toks = tokenize(core);
  const run = runStart(toks, core, today);
  const dos: { start: number; end: number }[] = [];
  const somedays: { start: number; end: number }[] = [];
  for (let i = run.index; i < toks.length; ) {
    const clause = readClause(toks, i, core, today);
    if (!clause || clause.next <= i) break;
    const span = { start: toks[i]!.start, end: toks[clause.next - 1]!.end };
    if (toks[i]!.lower === "do") dos.push(span);
    else if (toks[i]!.lower === SOMEDAY_TOKEN) somedays.push(span);
    i = clause.next;
  }
  if (COMPAT_SCHEDULED_RE.test(core)) {
    return { ok: false, reason: "compat", message: "the line's day is a Tasks-plugin `⏳` or a Dataview `[scheduled:: …]` field, which this door does not rewrite — defer it in the note" };
  }

  // Every span to replace or remove, applied right to left so each one's
  // offsets still hold. A removal takes the whitespace before it (or, at the
  // start of the core, after it) so no double space is left behind.
  const edits: { start: number; end: number; with: string | null }[] = [];
  let append: string | null = null;
  if (date !== null) {
    const last = dos.at(-1);
    for (const s of dos) edits.push({ ...s, with: s === last ? doClause(date) : null });
    for (const s of somedays) edits.push({ ...s, with: null });
    if (!last) append = doClause(date);
  } else {
    for (const s of dos) edits.push({ ...s, with: null });
    if (somedays.length === 0) append = SOMEDAY_TOKEN;
  }
  let edited = core;
  for (const e of edits.sort((a, b) => b.start - a.start)) {
    if (e.with !== null) {
      edited = `${edited.slice(0, e.start)}${e.with}${edited.slice(e.end)}`;
      continue;
    }
    let from = e.start;
    while (from > 0 && (edited[from - 1] === " " || edited[from - 1] === "\t")) from -= 1;
    let to = e.end;
    if (from === 0) while (to < edited.length && (edited[to] === " " || edited[to] === "\t")) to += 1;
    edited = `${edited.slice(0, from)}${edited.slice(to)}`;
  }
  if (append !== null) edited = `${edited}${edited === "" ? "" : " "}${append}`;

  // `- [ ]` with nothing after the box has no separator yet; the grammar needs one
  const sep = rest === "" && edited !== "" ? " " : "";
  const next = `${line.slice(0, restAt)}${sep}${edited}${tail}`;
  const after = parseTaskLine(next, opts);
  const proven =
    after !== null &&
    after.scheduled_for === date &&
    after.someday === (date === null) &&
    unscheduledFields(after) === unscheduledFields(before);
  if (!proven) return { ok: false, reason: "unsafe", message: "the line would not read back as the same task with only its day changed — defer it in the note" };
  return { ok: true, line: next };
}

// --- the Link door's one edit (design-build-plan §2.1, T4-25) ---------------
//
// *Send to Linear* is two doors: the tracker creates the issue, then
// `POST /api/vault-tasks/:task_key/link {ref}` writes `linear:<KEY>` on the
// line. The same discipline as the Tick and Defer edits: a line and a ref in,
// never a patch; the only bytes it can add are one space and the ref, at the
// end of the trailing run (before the anchor, which Obsidian needs last); and
// the proof is the re-parse — every field but `ext_refs` must read back
// exactly as it was, and `ext_refs` must be what it was plus this one ref.

/** A ref the Link door writes: `linear:<TEAM-123>` or `gh:<owner>/<repo>#<n>` — the two schemes of `EXT_REF_SCHEMES`, each in the one shape its collector joins on. */
export const TASK_REF_RE = /^(?:linear:[A-Z][A-Z0-9]{0,9}-[1-9][0-9]{0,8}|gh:[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}#[1-9][0-9]{0,9})$/;

export type TaskRefRefusal = "not_a_task" | "rule" | "already" | "linked" | "unsafe";

export type TaskRefEdit =
  | { ok: true; line: string }
  | { ok: false; reason: TaskRefRefusal; message: string };

/** The fields a link may not change: everything `parseTaskLine` reads but `ext_refs`. */
function unlinkedFields(p: ParsedTaskLine): string {
  const { ext_refs: _r, ...rest } = p;
  return JSON.stringify(rest);
}

/**
 * Add one tracker ref to one task line — the Link door's whole write.
 *
 * Refused, never approximated: a ref not in `TASK_REF_RE`'s shape (thrown —
 * a caller's bug, like a bad date); not a task line; a recurrence rule (never
 * itself a task, §4); a line that already carries this ref (`already`); a
 * line that already carries a ref of the same scheme (`linked` — one issue per
 * line, so ticking it names one issue to close); and any line where the
 * result does not re-parse as the same task with only this ref added
 * (`unsafe`). A ticked or dropped line may be linked: a ref is a pointer, not
 * a state.
 */
export function setTaskRef(line: string, ref: string, opts: TaskDateOptions = {}): TaskRefEdit {
  if (!TASK_REF_RE.test(ref)) throw new RangeError(`not a task ref: ${JSON.stringify(ref)}`);
  const before = parseTaskLine(line, opts);
  const m = LINE_RE.exec(line);
  if (!before || !m || line.includes("\r") || line.includes("\n")) return { ok: false, reason: "not_a_task", message: "the line is not a task line" };
  if (before.recurrence) return { ok: false, reason: "rule", message: "the line is a recurrence rule, which is never itself a task — link the day's instance instead" };
  if (before.ext_refs.includes(ref)) return { ok: false, reason: "already", message: `the line already carries ${ref}` };
  const scheme = ref.slice(0, ref.indexOf(":") + 1);
  const same = before.ext_refs.find((r) => r.toLowerCase().startsWith(scheme));
  if (same) return { ok: false, reason: "linked", message: `the line already carries ${same} — one ${scheme.slice(0, -1)} ref per line; change it in the note` };

  const rest = m[4] ?? "";
  const restAt = line.length - rest.length;
  const trimmed = rest.trimEnd();
  const anchor = TRAILING_ANCHOR_RE.exec(trimmed);
  const core = anchor ? trimmed.slice(0, anchor.index) : trimmed;
  const tail = rest.slice(core.length);
  const edited = `${core}${core === "" ? "" : " "}${ref}`;
  // `- [ ]` with nothing after the box has no separator yet; the grammar needs one
  const sep = rest === "" ? " " : "";
  const next = `${line.slice(0, restAt)}${sep}${edited}${tail}`;
  const after = parseTaskLine(next, opts);
  const proven = after !== null && JSON.stringify(after.ext_refs) === JSON.stringify([...before.ext_refs, ref]) && unlinkedFields(after) === unlinkedFields(before);
  if (!proven) return { ok: false, reason: "unsafe", message: "the line would not read back as the same task with only the ref added — link it in the note" };
  return { ok: true, line: next };
}
