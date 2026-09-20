// The template engine — §6 of docs/product/daily-flow-spec.md (P1-6).
//
// A template is a markdown file in the vault's `Templates/` (D12), which the
// user edits in Obsidian, carrying directives that a routine substitutes when
// it renders a machine-owned file. Eight verbs and one block form (D13); no
// expressions, no arithmetic, no conditionals, no recursion. A ninth verb is a
// product decision, not a config line, which is why `TEMPLATE_VERBS` is a
// frozen list and every key each verb admits is enumerated in `VERB_KEYS`.
//
// WHAT THIS FILE MAY NOT DO, and how it is stopped rather than asked:
//
//  * **It never builds SQL.** `where:`/`order:` go to `compileTaskFilter`
//    (`task-filter.ts`, P1-2) and come back as BIND PARAMS of one named query,
//    which is invariant 3 intact — the engine holds a `run(name, params)` seam
//    and cannot reach Postgres any other way.
//
//    TWO `where:` VOCABULARIES, because there are two tables and one would be
//    a lie. `{{ tasks where: … }}` is §6.2's predicate language over
//    `vault_tasks`, compiled by `compileTaskFilter` to every param
//    `TASK_FILTER_PARAM_SPEC` declares, plus the context params the CALLER
//    owns and the text never does (`today`, `me`). `{{ work where: … }}` is a
//    FLAG LIST — `day_work`'s board states, joined by one `and`/`or` — and
//    `parseWorkWhere` below is its whole parser: named flags only, anything
//    else refused rather than escaped, the same misuse rule. Widening the task
//    filter to cover both would mean a `where:` that compiles against tasks
//    and means nothing against work. `recurring`, `requests` and the ageing
//    measure take no `where:` at all; their queries have none.
//  * **It never calls a model.** `prose` is the only directive that reaches
//    one, and what this file produces for it is a REQUEST OBJECT the fold
//    routine fulfils on the turn it already takes (§6.3.3). A routine calls no
//    model (invariant 4), and this engine is what routines render with.
//  * **It never recurses.** `include` splices literal text; directives inside
//    an included file are not evaluated, and a template that includes itself
//    renders a note instead of a loop (§6.3.2).
//  * **It never mints an anchor into a file it does not own.** §4's
//    materialised recurring instance is written only when the render's
//    `source` is the user's own hand (`Journal/<date>.md`, created from
//    `Templates/Daily.md`); every other caller — every routine — gets the same
//    rule as a PROPOSAL line with no checkbox and no `^mt-…` (D4: never by a
//    routine).
//  * **It fails visibly and never fatally.** Every §6.4 row renders a note the
//    user can read and the file still renders, because a day with no plan
//    because the calendar was down is the worst possible outcome.
//
// §6.5 — WHEN A CHANGE TAKES EFFECT: the next run. Nothing here is cached
// across calls; there is no module-level state at all, and `renderTemplate`
// re-parses the text it is handed every time. Editing `Templates/Plan.md` at
// 18:00 changes the plan written at 19:00 because the routine reads the file
// again, and this engine has no opinion about that.
//
// Pure except for the seams: the query runner, the calendar provider and the
// vault reader are all injected, so the whole engine tests against fakes and a
// null provider is a rendered note rather than a crash.

import { createHash, randomBytes } from "node:crypto";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { intEnv } from "./config.js";
import { TASK_QUERY_NAME, compileTaskFilter, type TaskFilterParams } from "./task-filter.js";
import {
  ANCHOR_ALPHABET,
  ANCHOR_LENGTH,
  ANCHOR_PREFIX,
  addTaskDays,
  nextRecurrence,
  parseTaskLine,
  resolveTaskDate,
  taskToday,
  type TaskDateOptions,
} from "./task-line.js";

// --- the ceiling --------------------------------------------------------------

/** Stamped into the provenance footer, so a rendered file names its own engine. Bumped when what a directive renders changes shape. */
export const TEMPLATE_ENGINE_VERSION = 1;

/** Where templates live (D12): a vault folder Obsidian can see, not `.metistry/`. TitleCase, like everything at the vault root. */
export const TEMPLATES_DIR = "Templates";

/** §6.2's eight verbs. A ninth is a product decision. */
export const TEMPLATE_VERBS = ["date", "tasks", "recurring", "calendar", "work", "requests", "include", "prose"] as const;
export type TemplateVerb = (typeof TEMPLATE_VERBS)[number];

/** The one block form: `{{ section "Title" if_empty: "hide" }}` … `{{ /section }}`. */
export const TEMPLATE_BLOCK_VERB = "section";

/** The named queries the four query-backed directives read through (§6.2, P1-5). No component talks to Postgres another way. */
export const RECURRING_QUERY = "vault_tasks_recurring";
export const WORK_QUERY = "day_work";
export const REQUESTS_QUERY = "pending_requests";

/**
 * `prose` is legal only in a template whose output the assistant owns (D14) —
 * `ownershipRefusal` admits exactly one non-self source, and it is this one
 * (`packages/mcp-brain/src/knowledge-write.ts`). The check is on the render's
 * declared `source`, so `Templates/Plan.md` rendered by `plan-tomorrow`
 * refuses it every time, at render time, by construction.
 */
export const FOLD_SOURCE = "knowledge-fold";

/**
 * The one `source` that may MATERIALISE a recurring instance (§4, D4): the
 * user's own hand, creating today's note from `Templates/Daily.md`. Every
 * other caller is a routine, and no routine writes a task line into a note the
 * user owns — so a routine gets the rule as a proposal instead.
 */
export const USER_SOURCE = "user";

/** `day_work`'s flag vocabulary — what `{{ work where: … }}` may say. Closed, like the task filter's. */
export const WORK_FLAGS = ["waiting_on_me", "blocked", "in_progress", "open", "unclaimed", "closed", "due", "overdue"] as const;
export type WorkFlag = (typeof WORK_FLAGS)[number];

/** Every key each verb admits. Anything else renders §6.4's "can't read" note; nothing is ignored silently. */
const VERB_KEYS: Readonly<Record<TemplateVerb | "section", readonly string[]>> = Object.freeze({
  date: ["format", "offset"],
  tasks: ["where", "order", "limit", "as"],
  recurring: ["due", "limit"],
  calendar: ["day"],
  work: ["where", "limit", "day"],
  requests: ["limit", "kind"],
  include: [],
  prose: ["using"],
  section: ["if_empty"],
});

/** Which verbs need the `"positional"` slot filled. */
const NEEDS_POSITIONAL: ReadonlySet<string> = new Set(["include", "prose", "section"]);

/**
 * The one verb that may appear INSIDE a line of prose. §6.2 says one directive
 * per line, and every list-shaped verb obeys that — but the seeded templates
 * put the day in their heading (`# Plan — {{ date format: "YYYY-MM-DD" }}`)
 * and a date is a scalar, not a block. Every other verb used inline renders
 * §6.4's note, so `{{ tasks }}` cannot appear halfway through a sentence.
 */
const INLINE_VERBS: ReadonlySet<string> = new Set(["date"]);

/** `as:` — the shapes a task list renders in. */
export const TASK_RENDER_FORMS = ["list", "table"] as const;
export type TaskRenderForm = (typeof TASK_RENDER_FORMS)[number];

/** `if_empty:` — what a section does when nothing inside it produced anything. */
export const SECTION_EMPTY_MODES = ["hide", "show"] as const;
export type SectionEmptyMode = (typeof SECTION_EMPTY_MODES)[number];

/** §6.3.5's cap. `METISTRY_TEMPLATE_MAX_BYTES` overrides it; a directive that would exceed it truncates with `…and N more`. */
export const DEFAULT_TEMPLATE_MAX_BYTES = 16 * 1024;
/** §4's per-render bound on materialised recurrences. `METISTRY_RECURRING_MAX_PER_DAY` overrides it. */
export const DEFAULT_RECURRING_MAX_PER_DAY = 12;

const MAX_DATE_OFFSET_DAYS = 3650; // limit: fixed — `offset:` moves a rendered date by days, not by decades; ten years is already past any plan
const MAX_CARRY_ORDINAL = 99; // limit: fixed — the carry-over counter is a nudge ("carried, 3rd time"); past two digits the number has stopped being the point
const MAX_PROSE_PROMPT_CHARS = 200; // limit: fixed — a `prose` slot is a sentence the fold answers in three lines, not a brief; longer is a skill, not a directive
const MAX_DIRECTIVE_CHARS = 400; // limit: fixed — matches task-filter's own `where:` ceiling; a longer line is prose that happens to contain braces
const OVERFLOW_NOTE = "…and N more"; // the fold's own convention (docs/ops/knowledge-fold.md)

// --- what a caller passes in --------------------------------------------------

/** `QueryStore`-shaped (`packages/queries`): the engine's ONLY read path, so a fake satisfies it in tests and nothing here can reach a database. */
export interface TemplateQueries {
  run(name: string, params: Record<string, string | number | boolean>): Promise<{ rows: Record<string, unknown>[] }>;
}

/** One calendar event, as the eventkit bridge's `GET /events` returns it (`packages/mcp-eventkit/helper/ek-helper.swift`). */
export interface CalendarEvent {
  title?: string | undefined;
  start?: string | undefined;
  end?: string | undefined;
  all_day?: boolean | undefined;
  location?: string | undefined;
  calendar?: string | undefined;
}

/** The eventkit bridge client, injected. Null is a fact the plan renders (§6.4), never a failed run. */
export interface CalendarProvider {
  events(day: string): Promise<CalendarEvent[]>;
}

/** `GET /vault/read`, injected. Returns null for a path the vault does not hold. */
export interface TemplateReader {
  read(path: string): Promise<string | null>;
}

export interface TemplateContext extends TaskDateOptions {
  /** `Templates/Plan.md` — named in every failure note and in the provenance footer. */
  templatePath: string;
  /**
   * The writer of the file being rendered, as `source:` will spell it in that
   * file's frontmatter: `plan-tomorrow`, `standup-draft`, `knowledge-fold`, or
   * `user` for a note the user creates by hand. It decides two things and
   * nothing else: whether `prose` is legal (§6.3.3) and whether `recurring`
   * may materialise (§4, D4).
   */
  source: string;
  queries: TemplateQueries;
  /** Absent or null → §6.4's "no calendar" note, and the file still renders. */
  calendar?: CalendarProvider | null | undefined;
  /** Absent or null → `include` renders a note; nothing else needs the vault. */
  reader?: TemplateReader | null | undefined;
  /**
   * The owner's own person page (`People/Matt Colf.md`), for the
   * `assigned_to_me` flag. The caller's, never the template's: `me` is a
   * context param of `vault_tasks_query`, and a `where:` string cannot reach
   * it. Absent, the flag means "delegated to nobody", which is what the query
   * does with a blank one.
   */
  me?: string | undefined;
  /** Extra frontmatter keys for the rendered file. `source:` is always the context's and cannot be overridden into a lie. */
  frontmatter?: Record<string, unknown> | undefined;
  /** The instant stamped into the provenance footer. Default: now. */
  renderedAt?: Date | undefined;
  /** Injected so a test can pin one; the default is 8 Crockford base32 characters of `randomBytes` (§1.2). */
  newAnchor?: (() => string) | undefined;
  /** `METISTRY_TEMPLATE_MAX_BYTES` wins over this; both default to 16 KB. */
  maxBytes?: number | undefined;
  /** `METISTRY_RECURRING_MAX_PER_DAY` wins over this; both default to 12. */
  recurringMax?: number | undefined;
}

// --- what a caller gets back --------------------------------------------------

/** One §6.4 failure: the note as it was rendered into the file, plus the machine-readable half for `meta.template_warnings`. */
export interface TemplateWarning {
  /** 1-based, in the template file — the number the note carries and `metistry templates check` prints. */
  line: number;
  /** The verb, or the raw directive text when it had no readable verb. */
  directive: string;
  message: string;
  /** `> ⚠️ metistry: … (Templates/Plan.md:12)` — exactly the line in the file. */
  note: string;
}

/**
 * A `prose` slot, for the fold routine to fulfil (§6.3.3): it collects these
 * into ONE numbered list on the turn it already takes, and writes the file
 * with the slots filled through `knowledge_write` — the write it already does,
 * to a file it already owns. The engine never calls a model.
 */
export interface ProseRequest {
  /** 1-based, in render order — the number the fold's list uses. */
  index: number;
  /** What to write. Bounded (`MAX_PROSE_PROMPT_CHARS`): a sentence, not a brief. */
  prompt: string;
  /** The handle it should read, dates already resolved (`Journal/Fold/2026-09-19`). Null when the directive named none. */
  using: string | null;
  /** The comment the rendered file carries. The fold replaces the whole LINE holding it. */
  marker: string;
  line: number;
}

/** §6.4's last two rows: the run records one of these and writes NOTHING. */
export const TEMPLATE_MISSING = "template_missing";
export const TEMPLATE_UNREADABLE = "template_unreadable";
export type TemplateSkip = typeof TEMPLATE_MISSING | typeof TEMPLATE_UNREADABLE;

export interface TemplateRender {
  markdown: string;
  warnings: TemplateWarning[];
  proseRequests: ProseRequest[];
  /** Set → the caller writes nothing and records this on the run (§6.4). `markdown` is then empty. */
  skipped?: TemplateSkip;
  /** The size cap bit: true → something was cut, with `…and N more` where it was cut. */
  truncated: boolean;
}

export type FindingSeverity = "error" | "note";

/** What `validateTemplate` reports, and what `metistry templates check` prints. */
export interface TemplateFinding {
  line: number;
  severity: FindingSeverity;
  message: string;
}

export interface TemplateValidation {
  ok: boolean;
  findings: TemplateFinding[];
}

// --- the scanner --------------------------------------------------------------

interface RawDirective {
  body: string;
  start: number;
  end: number;
}

/**
 * Every `{{ … }}` on one line, with quotes honoured so the nested date in
 * `using: "Journal/Fold/{{date offset: -1}}"` does not end the outer directive
 * at its own braces.
 */
function findDirectives(line: string): { ok: true; found: RawDirective[] } | { ok: false; message: string } {
  const found: RawDirective[] = [];
  let i = 0;
  while (i < line.length) {
    const open = line.indexOf("{{", i);
    if (open === -1) break;
    let j = open + 2;
    let depth = 1;
    let quoted = false;
    for (; j < line.length; j++) {
      const c = line[j];
      if (c === '"') {
        quoted = !quoted;
        continue;
      }
      if (quoted) continue;
      if (line.startsWith("{{", j)) {
        depth += 1;
        j += 1;
        continue;
      }
      if (line.startsWith("}}", j)) {
        depth -= 1;
        if (depth === 0) break;
        j += 1;
        continue;
      }
    }
    if (depth !== 0) return { ok: false, message: "an unclosed `{{`" };
    found.push({ body: line.slice(open + 2, j), start: open, end: j + 2 });
    i = j + 2;
  }
  return { ok: true, found };
}

interface Tok {
  quoted: boolean;
  text: string;
}

function tokenize(body: string): { ok: true; toks: Tok[] } | { ok: false; message: string } {
  const toks: Tok[] = [];
  let i = 0;
  while (i < body.length) {
    const c = body[i] ?? "";
    if (c === " " || c === "\t") {
      i += 1;
      continue;
    }
    if (c === '"') {
      const close = body.indexOf('"', i + 1);
      if (close === -1) return { ok: false, message: 'an unclosed `"`' };
      toks.push({ quoted: true, text: body.slice(i + 1, close) });
      i = close + 1;
      continue;
    }
    let j = i;
    while (j < body.length && !/[\s"]/.test(body[j] ?? "")) j += 1;
    toks.push({ quoted: false, text: body.slice(i, j) });
    i = j;
  }
  return { ok: true, toks };
}

/** One parsed directive. `keys` is insertion-ordered, which is the order a failure note names them in. */
export interface TemplateDirective {
  verb: string;
  positional: string | null;
  keys: Map<string, string>;
  /** 1-based line in the template file. */
  line: number;
  /** The directive as written, braces included — what a failure note quotes. */
  raw: string;
  /** false → it shares its line with other text, so only `date` is legal (§6.2). */
  alone: boolean;
}

const KEY_RE = /^([a-z][a-z0-9_]*):(.*)$/;

function parseDirective(body: string, line: number, raw: string, alone: boolean): { ok: true; call: TemplateDirective } | { ok: false; message: string } {
  if (raw.length > MAX_DIRECTIVE_CHARS) return { ok: false, message: `a directive longer than ${MAX_DIRECTIVE_CHARS} characters is not a directive` };
  const lexed = tokenize(body);
  if (!lexed.ok) return lexed;
  const toks = lexed.toks;
  const head = toks[0];
  if (!head || head.quoted || head.text === "") return { ok: false, message: "a directive starts with a verb — `{{ tasks … }}`, `{{ /section }}`" };

  const call: TemplateDirective = { verb: head.text.toLowerCase(), positional: null, keys: new Map(), line, raw, alone };
  let i = 1;
  if (toks[1]?.quoted === true) {
    call.positional = toks[1]?.text ?? "";
    i = 2;
  }
  for (; i < toks.length; i++) {
    const tok = toks[i];
    if (!tok) break;
    if (tok.quoted) return { ok: false, message: `expected \`key: value\`, found the bare string \`"${tok.text}"\`` };
    const m = KEY_RE.exec(tok.text);
    if (!m) return { ok: false, message: `expected \`key: value\`, found \`${tok.text}\`` };
    const key = m[1] ?? "";
    let value = m[2] ?? "";
    if (value === "") {
      const next = toks[i + 1];
      if (!next) return { ok: false, message: `\`${key}:\` has no value` };
      value = next.text;
      i += 1;
    }
    if (call.keys.has(key)) return { ok: false, message: `\`${key}:\` is given twice` };
    call.keys.set(key, value);
  }
  return { ok: true, call };
}

type Item =
  | { kind: "literal"; text: string; line: number }
  | { kind: "directive"; call: TemplateDirective; before: string; after: string; eol: boolean }
  | { kind: "broken"; message: string; line: number; raw: string; before: string; after: string; eol: boolean };

/**
 * The template as a flat list, top to bottom. One pass, no tree: `section` is
 * matched by the renderer, which is what keeps "no nesting" a property of the
 * grammar rather than a rule in a prompt.
 */
function scanTemplate(body: string, firstLine: number): Item[] {
  const items: Item[] = [];
  body.split("\n").forEach((line, n) => {
    const lineNo = firstLine + n;
    const found = findDirectives(line);
    if (!found.ok) {
      items.push({ kind: "broken", message: found.message, line: lineNo, raw: line.trim(), before: "", after: "", eol: true });
      return;
    }
    if (found.found.length === 0) {
      items.push({ kind: "literal", text: line, line: lineNo });
      return;
    }
    let cursor = 0;
    found.found.forEach((raw, k) => {
      const before = line.slice(cursor, raw.start);
      cursor = raw.end;
      const last = k === found.found.length - 1;
      const after = last ? line.slice(raw.end) : "";
      const alone = found.found.length === 1 && before.trim() === "" && after.trim() === "";
      const text = line.slice(raw.start, raw.end);
      const parsed = parseDirective(raw.body, lineNo, text, alone);
      if (!parsed.ok) items.push({ kind: "broken", message: parsed.message, line: lineNo, raw: text, before, after, eol: last });
      else items.push({ kind: "directive", call: parsed.call, before, after, eol: last });
    });
  });
  return items;
}

// --- the pure checks (shared by render and validate) --------------------------

const list = (xs: readonly string[]): string => xs.join(", ");

/** A key's value with any `{{ date … }}` inside it already resolved. */
function keyOf(call: TemplateDirective, name: string, opts: TaskDateOptions): string | null {
  const raw = call.keys.get(name);
  if (raw === undefined) return null;
  const interpolated = interpolateDates(raw, opts);
  return interpolated.ok ? interpolated.text : raw;
}

/**
 * Everything about a directive that can be decided without touching a query, a
 * calendar or the vault. `renderTemplate` turns a message into §6.4's visible
 * note; `validateTemplate` turns the same message into a finding with the same
 * line number. One rule, two readers.
 */
function checkDirective(call: TemplateDirective, opts: TaskDateOptions): string | null {
  const { verb } = call;
  if (verb === "/section") {
    return call.positional !== null || call.keys.size > 0 ? "`{{ /section }}` takes nothing — it just closes the block" : null;
  }
  const known = verb === TEMPLATE_BLOCK_VERB || (TEMPLATE_VERBS as readonly string[]).includes(verb);
  if (!known) return `unknown directive \`${verb}\``;
  if (!call.alone && !INLINE_VERBS.has(verb)) return `\`${verb}\` needs a line of its own — only \`date\` renders inside a line (§6.2)`;

  const allowed = VERB_KEYS[verb as TemplateVerb | "section"];
  for (const [key, value] of call.keys) {
    if (!allowed.includes(key)) {
      return `can't read \`${key}: ${value}\` — \`${verb}\` ${allowed.length === 0 ? "takes no keys" : `takes ${list(allowed)}`}`;
    }
  }
  if (NEEDS_POSITIONAL.has(verb) && (call.positional === null || call.positional.trim() === "")) {
    const example =
      verb === "include" ? '{{ include "Me/Working Style.md#Prioritisation" }}'
      : verb === "prose" ? '{{ prose "summarise yesterday in three lines" }}'
      : '{{ section "Things due today" if_empty: "hide" }}';
    return `\`${verb}\` needs its quoted first value — ${example}`;
  }
  if (!NEEDS_POSITIONAL.has(verb) && call.positional !== null) return `\`${verb}\` takes no quoted value, only keys`;

  // Every value may carry a `{{ date … }}` (§6.2's `prose using:` example), and
  // it is resolved here so a broken one is a finding rather than a surprise.
  for (const [key, value] of call.keys) {
    const interpolated = interpolateDates(value, opts);
    if (!interpolated.ok) return `can't read \`${key}: ${value}\` — ${interpolated.message}`;
  }
  if (call.positional !== null) {
    const interpolated = interpolateDates(call.positional, opts);
    if (!interpolated.ok) return `can't read \`"${call.positional}"\` — ${interpolated.message}`;
  }

  const key = (name: string): string | null => keyOf(call, name, opts);
  const countable = (name: string, what: string): string | null => {
    const raw = key(name);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? null : `can't read \`${name}: ${raw}\` — a whole number of ${what}`;
  };
  const dateable = (name: string): string | null => {
    const raw = key(name);
    if (raw === null || resolveTaskDate(raw, opts) !== null) return null;
    return `can't read \`${name}: ${raw}\` — a date, \`today\`, \`tomorrow\`, a weekday or \`+3d\` (§1.3)`;
  };

  switch (verb) {
    case "date": {
      const offset = key("offset");
      if (offset !== null) {
        const n = Number(offset);
        if (!Number.isInteger(n)) return `can't read \`offset: ${offset}\` — a whole number of days`;
        if (Math.abs(n) > MAX_DATE_OFFSET_DAYS) return `can't read \`offset: ${offset}\` — at most ${MAX_DATE_OFFSET_DAYS} days either way`;
      }
      const format = key("format");
      if (format !== null && format.trim() === "") return 'can\'t read `format: ""` — a date format, e.g. `YYYY-MM-DD`';
      return null;
    }
    case "tasks": {
      const as = key("as");
      if (as !== null && !(TASK_RENDER_FORMS as readonly string[]).includes(as)) return `can't read \`as: ${as}\` — ${list(TASK_RENDER_FORMS)}`;
      const badLimit = countable("limit", "rows");
      if (badLimit !== null) return badLimit;
      const where = key("where");
      const order = key("order");
      const limit = key("limit");
      const compiled = compileTaskFilter(
        {
          ...(where !== null ? { where } : {}),
          ...(order !== null ? { order } : {}),
          ...(limit !== null ? { limit: Number(limit) } : {}),
        },
        opts,
      );
      if (compiled.ok) return null;
      const shown = where !== null ? `where: "${where}"` : order !== null ? `order: "${order}"` : `limit: ${limit ?? ""}`;
      return `can't read \`${shown}\` — ${compiled.error}`;
    }
    case "recurring":
      return dateable("due") ?? countable("limit", "rules");
    case "calendar":
      return dateable("day");
    case "work": {
      const where = key("where");
      if (where !== null) {
        const flags = parseWorkWhere(where);
        if (!flags.ok) return `can't read \`where: "${where}"\` — ${flags.error}`;
      }
      return dateable("day") ?? countable("limit", "rows");
    }
    case "requests": {
      const bad = countable("limit", "rows");
      if (bad !== null) return bad;
      const kind = key("kind");
      if (kind !== null && !/^[a-z][a-z0-9_]*$/.test(kind)) return `can't read \`kind: ${kind}\` — a stored proposal kind, e.g. \`decision\``;
      return null;
    }
    case "include": {
      const path = call.positional ?? "";
      return path.includes("..") ? `can't read \`"${path}"\` — a vault path, never a traversal` : null;
    }
    case "prose": {
      const prompt = call.positional ?? "";
      return prompt.length > MAX_PROSE_PROMPT_CHARS ? `\`prose\` takes at most ${MAX_PROSE_PROMPT_CHARS} characters — a sentence, not a brief` : null;
    }
    case TEMPLATE_BLOCK_VERB: {
      const mode = key("if_empty");
      return mode !== null && !(SECTION_EMPTY_MODES as readonly string[]).includes(mode) ? `can't read \`if_empty: ${mode}\` — ${list(SECTION_EMPTY_MODES)}` : null;
    }
    default:
      return `unknown directive \`${verb}\``;
  }
}

// --- `{{ date … }}` inside a value --------------------------------------------

const NESTED_RE = /\{\{([^{}]*)\}\}/g;

/**
 * §6.2's directive-8 example spells `using: "Journal/Fold/{{date offset: -1}}"`,
 * so a value may carry a date — and ONLY a date. `date` is pure: it takes no
 * source, reads nothing and cannot contain another directive, so this is
 * substitution rather than nesting, and "no recursion" survives it intact.
 */
function interpolateDates(value: string, opts: TaskDateOptions): { ok: true; text: string } | { ok: false; message: string } {
  if (!value.includes("{{")) return { ok: true, text: value };
  let failure: string | null = null;
  const text = value.replace(NESTED_RE, (_match, body: string) => {
    const parsed = parseDirective(body, 0, `{{${body}}}`, false);
    if (!parsed.ok) {
      failure ??= parsed.message;
      return "";
    }
    if (parsed.call.verb !== "date") {
      failure ??= `only \`date\` may be written inside a value, not \`${parsed.call.verb}\``;
      return "";
    }
    const rendered = renderDate(parsed.call, opts);
    if (rendered === null) {
      failure ??= "that `date` is not readable";
      return "";
    }
    return rendered;
  });
  if (failure !== null) return { ok: false, message: failure };
  if (text.includes("{{") || text.includes("}}")) return { ok: false, message: "an unclosed `{{`" };
  return { ok: true, text };
}

// --- dates --------------------------------------------------------------------

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const FORMAT_RE = /YYYY|MMMM|MMM|dddd|ddd|YY|MM|DD/g;

/** `2026-09-21` + `"ddd DD MMM"` → the tokens §6.2's `format:` admits; every other character is verbatim. */
export function formatTemplateDate(iso: string, format: string): string {
  const [y = "", m = "", d = ""] = iso.split("-");
  const monthIndex = Number(m) - 1;
  const weekday = new Date(Date.UTC(Number(y), monthIndex, Number(d))).getUTCDay();
  return format.replace(FORMAT_RE, (tok) => {
    switch (tok) {
      case "YYYY": return y;
      case "YY": return y.slice(2);
      case "MMMM": return MONTHS[monthIndex] ?? m;
      case "MMM": return (MONTHS[monthIndex] ?? m).slice(0, 3);
      case "MM": return m;
      case "DD": return d;
      case "dddd": return WEEKDAYS[weekday] ?? "";
      case "ddd": return (WEEKDAYS[weekday] ?? "").slice(0, 3);
      default: return tok;
    }
  });
}

/** The date a `{{ date … }}` names, or null when its keys do not read. */
function renderDate(call: TemplateDirective, opts: TaskDateOptions): string | null {
  const raw = call.keys.get("offset");
  const offset = raw === undefined || raw === "" ? 0 : Number(raw);
  if (!Number.isInteger(offset) || Math.abs(offset) > MAX_DATE_OFFSET_DAYS) return null;
  for (const key of call.keys.keys()) if (key !== "offset" && key !== "format") return null;
  const base = taskToday(opts);
  const iso = offset === 0 ? base : addTaskDays(base, offset);
  if (iso === null) return null;
  return formatTemplateDate(iso, call.keys.get("format") ?? "YYYY-MM-DD");
}

/** The date a `due:`/`day:` key names, resolved against `METISTRY_TZ` and the run's date (§1.3). Defaults to today. */
function dateKey(call: TemplateDirective, name: string, opts: TaskDateOptions): string {
  const raw = keyOf(call, name, opts);
  if (raw === null) return taskToday(opts);
  return resolveTaskDate(raw, opts) ?? taskToday(opts);
}

// --- `{{ work where: … }}` ----------------------------------------------------

/**
 * `day_work`'s flags, joined by one combinator. Deliberately its own small
 * parser rather than `compileTaskFilter`: the two queries filter different
 * tables, and pretending one vocabulary covers both would mean a `where:` that
 * compiles against tasks and means nothing against work.
 */
export function parseWorkWhere(where: string): { ok: true; flags: WorkFlag[]; combine: "and" | "or" } | { ok: false; error: string } {
  const words = where.trim().split(/\s+/).filter((w) => w !== "");
  const flags: WorkFlag[] = [];
  let combine: "and" | "or" | null = null;
  for (let i = 0; i < words.length; i++) {
    const word = (words[i] ?? "").toLowerCase();
    if (i % 2 === 0) {
      if (!(WORK_FLAGS as readonly string[]).includes(word)) return { ok: false, error: `\`work\` knows the flags ${list(WORK_FLAGS)}` };
      flags.push(word as WorkFlag);
    } else {
      if (word !== "and" && word !== "or") return { ok: false, error: `expected \`and\` or \`or\` between flags, found \`${word}\`` };
      if (combine !== null && combine !== word) return { ok: false, error: "cannot mix `and` with `or` — there are no brackets (§6.2)" };
      combine = word;
    }
  }
  if (words.length > 0 && words.length % 2 === 0) return { ok: false, error: `ends with \`${words[words.length - 1] ?? ""}\` and no flag after it` };
  return { ok: true, flags, combine: combine ?? "and" };
}

// --- rows ---------------------------------------------------------------------

const str = (row: Record<string, unknown>, key: string): string | null => {
  const v = row[key];
  if (typeof v === "string") return v === "" ? null : v;
  return typeof v === "number" ? String(v) : null;
};
const num = (row: Record<string, unknown>, key: string): number | null => {
  const v = row[key];
  if (typeof v === "number") return v;
  return typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v)) ? Number(v) : null;
};
const flag = (row: Record<string, unknown>, key: string): boolean => row[key] === true;

/** `Journal/2026-09-18.md` → `[[Journal/2026-09-18]]` — a link, never a copy (§2.1). */
export const vaultLink = (path: string): string => `[[${path.replace(/\.md$/i, "")}]]`;

const chips = (parts: (string | null)[]): string => {
  const kept = parts.filter((p): p is string => p !== null && p !== "");
  return kept.length === 0 ? "" : ` · ${kept.join(" · ")}`;
};

function taskChips(row: Record<string, unknown>): string {
  const priority = num(row, "priority");
  const carried = num(row, "carried_days");
  const assigned = str(row, "assigned");
  const size = str(row, "size");
  const project = str(row, "project");
  const due = str(row, "due");
  const scheduled = str(row, "scheduled_for");
  const work = num(row, "work_id");
  return chips([
    due === null ? null : `due ${due}`,
    scheduled === null ? null : `do ${scheduled}`,
    priority === null ? null : `p${priority}`,
    size === null ? null : `size ${size.toLowerCase()}`,
    str(row, "type"),
    assigned === null ? null : `@${vaultLink(assigned)}`,
    project === null ? null : `+${project}`,
    carried !== null && carried > 0 ? `carried ${carried}d` : null,
    flag(row, "waiting") ? "waiting" : null,
    work === null ? null : `work:${work}`,
  ]);
}

/** §1.4's one visible line for a token the parser could not read. Never a guess, never silence. */
function parseWarningLine(row: Record<string, unknown>): string | null {
  const warning = str(row, "parse_warning");
  if (warning === null) return null;
  const line = num(row, "line_no");
  return `> ⚠️ couldn't read \`${warning}\` — ${str(row, "path") ?? ""}${line === null ? "" : `:${line}`}`;
}

const taskListItem = (row: Record<string, unknown>): string => `- ${vaultLink(str(row, "path") ?? "")} — ${str(row, "text") ?? ""}${taskChips(row)}`;

function taskTable(rows: Record<string, unknown>[]): string[] {
  const priorityOf = (row: Record<string, unknown>): string => {
    const p = num(row, "priority");
    return p === null ? "" : `p${p}`;
  };
  return [
    "| Task | Due | P | Size | Where |",
    "| --- | --- | --- | --- | --- |",
    ...rows.map((row) =>
      `| ${[
        (str(row, "text") ?? "").replace(/\|/g, "\\|"),
        str(row, "due") ?? "",
        priorityOf(row),
        (str(row, "size") ?? "").toLowerCase(),
        vaultLink(str(row, "path") ?? ""),
      ].join(" | ")} |`,
    ),
  ];
}

function workItem(row: Record<string, unknown>): string {
  const blockedPath = str(row, "blocked_by_path");
  const waiting = flag(row, "blocked_by_task_open") && blockedPath !== null
    ? ` · waiting on ${vaultLink(blockedPath)} — ${str(row, "blocked_by_task") ?? ""}`
    : "";
  return `- work:${num(row, "id") ?? 0} — ${str(row, "title") ?? ""}${chips([str(row, "status"), str(row, "project")])}${waiting}`;
}

function requestItem(row: Record<string, unknown>): string {
  const age = num(row, "age_days");
  return `- ${str(row, "request_type") ?? "request"} — ${str(row, "title") ?? ""}${chips([
    age === null ? null : `${age}d`,
    str(row, "source_agent"),
    flag(row, "has_suggested_work") ? "suggests work" : null,
  ])}`;
}

function clockOf(iso: string | undefined, timeZone: string): string {
  if (iso === undefined || iso === "") return "??:??";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "??:??";
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).format(at);
  } catch {
    return at.toISOString().slice(11, 16);
  }
}

function eventItem(event: CalendarEvent, timeZone: string): string {
  const when = event.all_day === true ? "all day" : `${clockOf(event.start, timeZone)}–${clockOf(event.end, timeZone)}`;
  return `- ${when} ${event.title ?? "(untitled)"}${chips([event.location ?? null, event.calendar ?? null])}`;
}

// --- recurrence ---------------------------------------------------------------

const ORDINALS = ["", "1st", "2nd", "3rd"] as const;
const ordinal = (n: number): string => ORDINALS[n] ?? `${n}th`;

/**
 * "carried, 3rd time" — how many times the rule has come round since the
 * still-open instance first appeared, computed by STEPPING THE RULE rather
 * than dividing by an assumed period. Null when the rule does not parse,
 * because a counter nobody can derive is a number nobody should read.
 */
export function carriedTimes(rule: string, since: string, asof: string): number | null {
  const parsed = parseTaskLine(`- [ ] x ${rule}`)?.recurrence ?? null;
  if (parsed === null) return null;
  let times = 1;
  let cursor = since;
  while (times < MAX_CARRY_ORDINAL) {
    const next = nextRecurrence(parsed, since, cursor);
    if (next === null || next > asof) break;
    times += 1;
    cursor = next;
  }
  return times;
}

/** §1.2's block id: `mt-` + 8 Crockford base32 characters. 256/32 is exact, so the modulo is uniform. */
const defaultAnchor = (): string =>
  `${ANCHOR_PREFIX}${[...randomBytes(ANCHOR_LENGTH)].map((b) => ANCHOR_ALPHABET[b % ANCHOR_ALPHABET.length] ?? "0").join("")}`;

function recurringLine(row: Record<string, unknown>, asof: string, materialise: boolean, mint: () => string): string {
  const text = str(row, "text") ?? "";
  const open = str(row, "open_instance_since");
  if (open !== null) {
    // §4's first structural bound: one open instance per rule, ever. A month
    // away from the vault produces one line, not thirty.
    const times = carriedTimes(str(row, "recur_rule") ?? "", open, asof);
    return `${materialise ? "- [ ] " : "- "}${text} — carried${times !== null && times > 1 ? `, ${ordinal(times)} time` : ""}`;
  }
  if (!materialise) {
    // §4: `plan-tomorrow` PROPOSES and does not materialise — no checkbox, no
    // anchor, nothing a later walk could mistake for the day's instance.
    const next = str(row, "recur_next");
    return `- ${text} — ${str(row, "recur_rule") ?? "recurring"}${next === null ? "" : `, due ${next}`}`;
  }
  const priority = num(row, "priority");
  const assigned = str(row, "assigned");
  const size = str(row, "size");
  const type = str(row, "type");
  const project = str(row, "project");
  const fields = [
    assigned === null ? null : `@${vaultLink(assigned)}`,
    priority === null ? null : `p${priority}`,
    size === null ? null : `size ${size.toLowerCase()}`,
    type === null ? null : `type ${type}`,
    project === null ? null : `+${project}`,
    "source template:recurring",
    `^${mint()}`,
  ].filter((p): p is string => p !== null);
  return `- [ ] ${text} ${fields.join(" ")}`;
}

// --- frontmatter --------------------------------------------------------------

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/;

interface Split {
  frontmatter: string | null;
  body: string;
  /** 1-based line the body starts on, so every note's line number is the number the user sees in Obsidian. */
  firstLine: number;
}

function splitFrontmatter(text: string): Split {
  const m = FRONTMATTER_RE.exec(text);
  if (!m) return { frontmatter: null, body: text, firstLine: 1 };
  const consumed = m[0];
  return { frontmatter: m[1] ?? "", body: text.slice(consumed.length), firstLine: consumed.split("\n").length };
}

/**
 * The rendered file's own frontmatter. The template ships `source: user` so
 * `ownershipRefusal` protects the TEMPLATE (§6.1); the FILE it renders carries
 * the writer's own source, because that string is what `ownershipRefusal`
 * reads later (§7). `tags: [template]` is dropped — a plan is not a template —
 * and `source:` is the context's, never a key a template can overwrite into a
 * lie.
 */
function renderFrontmatter(raw: string | null, ctx: TemplateContext): { text: string; warning: string | null } {
  if (raw === null && ctx.frontmatter === undefined) return { text: "", warning: null };
  let fields: Record<string, unknown> = {};
  let warning: string | null = null;
  if (raw !== null && raw.trim() !== "") {
    let parsed: unknown = null;
    try {
      parsed = parseYaml(raw);
    } catch {
      parsed = null;
    }
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) fields = { ...(parsed as Record<string, unknown>) };
    else warning = "the template's frontmatter is not a set of keys — the rendered file carries only what this render knows";
  }
  const tags = fields["tags"];
  if (Array.isArray(tags)) {
    const kept = tags.filter((t) => t !== "template");
    if (kept.length > 0) fields["tags"] = kept;
    else delete fields["tags"];
  }
  Object.assign(fields, ctx.frontmatter ?? {});
  fields["source"] = ctx.source;
  return { text: `---\n${stringifyYaml(fields).trimEnd()}\n---\n`, warning };
}

// --- the size cap -------------------------------------------------------------

const bytes = (s: string): number => Buffer.byteLength(s, "utf8");

/** Keep whole lines while they fit; what is left becomes `…and N more` (§6.3.5). */
function fit(lines: string[], budget: number): { lines: string[]; dropped: number } {
  const kept: string[] = [];
  let used = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const size = bytes(line) + 1;
    if (used + size > budget && kept.length > 0) return { lines: kept, dropped: lines.length - i };
    used += size;
    kept.push(line);
  }
  return { lines: kept, dropped: 0 };
}

const overflow = (n: number): string => OVERFLOW_NOTE.replace("N", String(n));

/**
 * §6.4's last two rows, as one rule the routine and the CLI both call: a
 * template that is missing, or that is not readable text or is over the cap,
 * produces NO file — a configuration fact, not a failed run.
 */
export function templateSkip(text: string | null | undefined, maxBytes: number): TemplateSkip | null {
  if (text === null || text === undefined) return TEMPLATE_MISSING;
  if (bytes(text) > maxBytes) return TEMPLATE_UNREADABLE;
  // A decoder has already run by the time this is a JS string, so what is left
  // to catch is what a decoder leaves behind: the replacement character, an
  // unpaired surrogate, a NUL. None of them is markdown.
  if (/[� ]/.test(text)) return TEMPLATE_UNREADABLE;
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)) return TEMPLATE_UNREADABLE;
  return null;
}

// --- validate -----------------------------------------------------------------

export interface ValidateOptions extends TaskDateOptions {
  /** When given, `prose` is an ERROR outside a fold template rather than a note (§6.3.3). */
  source?: string | undefined;
  maxBytes?: number | undefined;
}

/**
 * What `metistry templates check` runs, and what the plugin will run in the
 * editor: every directive error in the file, with the line number the user
 * sees in Obsidian. No IO at all — a template is validated without a database,
 * a calendar or a vault, which is what makes "check before the next run"
 * something the owner can do at any moment (§6.5).
 */
export function validateTemplate(text: string, opts: ValidateOptions = {}): TemplateValidation {
  const findings: TemplateFinding[] = [];
  const maxBytes = intEnv("METISTRY_TEMPLATE_MAX_BYTES", opts.maxBytes ?? DEFAULT_TEMPLATE_MAX_BYTES, opts.env ?? process.env);
  const skip = templateSkip(text, maxBytes);
  if (skip !== null) {
    findings.push({
      line: 1,
      severity: "error",
      message: bytes(text ?? "") > maxBytes
        ? `the template is larger than ${maxBytes} bytes — nothing would be written (skipped: ${TEMPLATE_UNREADABLE})`
        : `the template is not readable text — nothing would be written (skipped: ${TEMPLATE_UNREADABLE})`,
    });
    return { ok: false, findings };
  }

  const split = splitFrontmatter(text);
  let open: TemplateDirective | null = null;
  for (const item of scanTemplate(split.body, split.firstLine)) {
    if (item.kind === "literal") continue;
    if (item.kind === "broken") {
      findings.push({ line: item.line, severity: "error", message: item.message });
      continue;
    }
    const { call } = item;
    const problem = checkDirective(call, opts);
    if (problem !== null) {
      findings.push({ line: call.line, severity: "error", message: problem });
      continue;
    }
    if (call.verb === "/section") {
      if (open === null) findings.push({ line: call.line, severity: "error", message: "`{{ /section }}` with no `{{ section … }}` open" });
      else open = null;
      continue;
    }
    if (call.verb === TEMPLATE_BLOCK_VERB) {
      if (open !== null) findings.push({ line: call.line, severity: "error", message: `a section cannot hold another — \`${open.positional ?? ""}\` (line ${open.line}) is still open` });
      else open = call;
      continue;
    }
    if (call.verb === "prose") {
      const foldOwned = opts.source === undefined || opts.source === FOLD_SOURCE;
      findings.push({
        line: call.line,
        severity: foldOwned ? "note" : "error",
        message: foldOwned
          ? "`prose` renders only where the assistant owns the output (`Journal/Fold/`, §6.3)"
          : `\`prose\` is only available in a fold template (§6.3) — this one renders as \`${opts.source ?? ""}\``,
      });
    }
  }
  if (open !== null) findings.push({ line: open.line, severity: "error", message: `\`{{ section "${open.positional ?? ""}" }}\` is never closed — add \`{{ /section }}\`` });
  return { ok: !findings.some((f) => f.severity === "error"), findings };
}

// --- render -------------------------------------------------------------------

interface Frame {
  title: string;
  ifEmpty: SectionEmptyMode;
  parts: string[];
  filled: boolean;
  line: number;
}

interface Out {
  markdown: string;
  /** false → nothing to show; a section set to `hide` vanishes, heading and all. */
  filled: boolean;
  warning?: string | undefined;
  truncated?: boolean | undefined;
}

/**
 * Substitute every directive, top to bottom, one pass. Never throws on a
 * template: every failure is a note in the file and a row in `warnings`, and
 * the caller still has something to write (§6.4).
 */
export async function renderTemplate(text: string, ctx: TemplateContext): Promise<TemplateRender> {
  const env = ctx.env ?? process.env;
  const maxBytes = intEnv("METISTRY_TEMPLATE_MAX_BYTES", ctx.maxBytes ?? DEFAULT_TEMPLATE_MAX_BYTES, env);
  const warnings: TemplateWarning[] = [];
  const proseRequests: ProseRequest[] = [];

  const skip = templateSkip(text, maxBytes);
  if (skip !== null) {
    return {
      markdown: "",
      warnings: [{ line: 1, directive: "", message: `the template is not renderable (${skip})`, note: "" }],
      proseRequests,
      skipped: skip,
      truncated: false,
    };
  }

  const dateOpts: TaskDateOptions = {
    ...(ctx.now !== undefined ? { now: ctx.now } : {}),
    ...(ctx.timeZone !== undefined ? { timeZone: ctx.timeZone } : {}),
    env,
  };
  const split = splitFrontmatter(text);
  const front = renderFrontmatter(split.frontmatter, ctx);

  const parts: string[] = [];
  let frame: Frame | null = null;
  let used = bytes(front.text);
  let truncated = false;
  const pending: string[] = [];

  const note = (line: number, directive: string, message: string): string => {
    const rendered = `> ⚠️ metistry: ${message} (${ctx.templatePath}:${line})`;
    warnings.push({ line, directive, message, note: rendered });
    return rendered;
  };
  const emit = (chunk: string, filled: boolean): void => {
    used += bytes(chunk);
    if (frame) {
      frame.parts.push(chunk);
      if (filled) frame.filled = true;
    } else {
      parts.push(chunk);
    }
  };
  const flush = (): void => {
    while (pending.length > 0) emit(`${pending.shift() ?? ""}\n`, true);
  };

  if (front.warning !== null) emit(`${note(1, "frontmatter", front.warning)}\n`, true);

  for (const item of scanTemplate(split.body, split.firstLine)) {
    if (item.kind === "literal") {
      emit(`${item.text}\n`, item.text.trim() !== "");
      continue;
    }
    if (item.kind === "broken") {
      const rendered = note(item.line, item.raw, `can't read \`${item.raw}\` — ${item.message}`);
      if (item.before.trim() === "" && item.after.trim() === "") emit(`${rendered}\n`, true);
      else {
        emit(`${item.before}${item.after}${item.eol ? "\n" : ""}`, true);
        pending.push(rendered);
      }
      if (item.eol) flush();
      continue;
    }

    const { call } = item;
    const problem = checkDirective(call, dateOpts);

    if (problem === null && call.verb === "/section") {
      if (frame === null) {
        emit(`${note(call.line, call.verb, "`{{ /section }}` with no `{{ section … }}` open")}\n`, true);
        continue;
      }
      const closing = frame;
      frame = null;
      if (closing.filled || closing.ifEmpty !== "hide") {
        emit(`\n## ${closing.title}\n\n`, true);
        for (const part of closing.parts) emit(part, false);
      } else {
        used -= closing.parts.reduce((n, p) => n + bytes(p), 0);
      }
      continue;
    }

    if (problem === null && call.verb === TEMPLATE_BLOCK_VERB) {
      if (frame !== null) {
        emit(`${note(call.line, call.verb, `a section cannot hold another — \`${frame.title}\` (line ${frame.line}) is still open`)}\n`, true);
        continue;
      }
      frame = {
        title: call.positional ?? "",
        ifEmpty: (call.keys.get("if_empty") as SectionEmptyMode | undefined) ?? "show",
        parts: [],
        filled: false,
        line: call.line,
      };
      continue;
    }

    const out: Out = problem !== null
      ? { markdown: "", filled: false, warning: problem }
      : await renderVerb(call, ctx, dateOpts, Math.max(maxBytes - used, 0), proseRequests);
    if (out.truncated === true) truncated = true;

    if (out.warning !== undefined) {
      const rendered = note(call.line, call.verb, out.warning);
      if (call.alone) emit(`${rendered}\n`, true);
      else {
        emit(`${item.before}${item.after}${item.eol ? "\n" : ""}`, true);
        pending.push(rendered);
      }
      if (item.eol) flush();
      continue;
    }

    if (call.alone) emit(`${out.markdown}\n`, out.filled);
    else emit(`${item.before}${out.markdown}${item.after}${item.eol ? "\n" : ""}`, true);
    if (item.eol) flush();
  }

  if (frame !== null) {
    const unclosed = frame;
    frame = null;
    emit(`\n## ${unclosed.title}\n\n`, true);
    for (const part of unclosed.parts) emit(part, false);
    emit(`${note(unclosed.line, TEMPLATE_BLOCK_VERB, `\`{{ section "${unclosed.title}" }}\` is never closed — add \`{{ /section }}\``)}\n`, true);
  }

  let body = parts.join("").replace(/\n{3,}/g, "\n\n").replace(/[ \t]+\n/g, "\n").trim();
  const footer = provenanceFooter(text, ctx);
  const room = maxBytes - bytes(front.text) - bytes(footer) - 2;
  if (bytes(body) > room) {
    const cut = fit(body.split("\n"), room - bytes(`\n${overflow(0)}`));
    body = `${cut.lines.join("\n")}\n${overflow(cut.dropped)}`;
    truncated = true;
  }

  return { markdown: `${front.text}${body}\n${footer}\n`, warnings, proseRequests, truncated };
}

/**
 * §6.3.4 — so "why does my plan look like that" has an answer that names a
 * file, the version of that file, when it was rendered and by which engine.
 */
export function provenanceFooter(templateText: string, ctx: TemplateContext): string {
  const digest = createHash("sha256").update(templateText, "utf8").digest("hex").slice(0, 12);
  const at = (ctx.renderedAt ?? new Date()).toISOString().slice(0, 16);
  return `<!-- rendered by ${ctx.source} from ${ctx.templatePath} (sha256 ${digest}…) at ${at}Z by metistry-template/${TEMPLATE_ENGINE_VERSION} -->`;
}

// --- the eight verbs ----------------------------------------------------------

async function renderVerb(
  call: TemplateDirective,
  ctx: TemplateContext,
  dateOpts: TaskDateOptions,
  budget: number,
  proseRequests: ProseRequest[],
): Promise<Out> {
  switch (call.verb) {
    case "date": {
      const rendered = renderDate(call, dateOpts);
      return rendered === null ? { markdown: "", filled: false, warning: "can't read that `date`" } : { markdown: rendered, filled: true };
    }
    case "tasks": return renderTasks(call, ctx, dateOpts, budget);
    case "recurring": return renderRecurring(call, ctx, dateOpts, budget);
    case "calendar": return renderCalendar(call, ctx, dateOpts, budget);
    case "work": return renderWork(call, ctx, dateOpts, budget);
    case "requests": return renderRequests(call, ctx, budget);
    case "include": return renderInclude(call, ctx, dateOpts, budget);
    case "prose": return renderProse(call, ctx, dateOpts, proseRequests);
    default: return { markdown: "", filled: false, warning: `unknown directive \`${call.verb}\`` };
  }
}

async function queryRows(
  ctx: TemplateContext,
  name: string,
  params: Record<string, string | number | boolean>,
): Promise<{ ok: true; rows: Record<string, unknown>[] } | { ok: false; why: string }> {
  try {
    const result = await ctx.queries.run(name, params);
    return { ok: true, rows: result.rows };
  } catch (e) {
    return { ok: false, why: `the named query \`${name}\` is not available — ${e instanceof Error ? e.message : String(e)}` };
  }
}

function listOut(lines: string[], budget: number, empty: string): Out {
  if (lines.length === 0) return { markdown: empty, filled: false };
  const cut = fit(lines, budget);
  const body = cut.dropped > 0 ? [...cut.lines, overflow(cut.dropped)] : cut.lines;
  return { markdown: body.join("\n"), filled: true, truncated: cut.dropped > 0 };
}

async function renderTasks(call: TemplateDirective, ctx: TemplateContext, dateOpts: TaskDateOptions, budget: number): Promise<Out> {
  const where = keyOf(call, "where", dateOpts);
  const order = keyOf(call, "order", dateOpts);
  const limit = keyOf(call, "limit", dateOpts);
  const compiled = compileTaskFilter(
    {
      ...(where !== null ? { where } : {}),
      ...(order !== null ? { order } : {}),
      ...(limit !== null ? { limit: Number(limit) } : {}),
    },
    dateOpts,
  );
  if (!compiled.ok) return { markdown: "", filled: false, warning: `can't read \`where: "${where ?? ""}"\` — ${compiled.error}` };

  // Every param, always, exactly as `TASK_FILTER_PARAM_SPEC` declares it —
  // bind values, never SQL text (invariant 3) — plus the two context params
  // the query leaves to the caller. `today` travels because `overdue` and
  // `carried` are measured against a DAY, and the day is the instance's
  // (METISTRY_TZ), not the cluster's: a plan written at 19:00 in New York
  // must not read the UTC date the database happens to be on.
  const params: TaskFilterParams = compiled.params;
  const result = await queryRows(ctx, TASK_QUERY_NAME, {
    ...Object.fromEntries(Object.entries(params)),
    today: taskToday(dateOpts),
    ...(ctx.me !== undefined && ctx.me !== "" ? { me: ctx.me } : {}),
  });
  if (!result.ok) return { markdown: "", filled: false, warning: `no tasks — ${result.why}` };

  const form = (keyOf(call, "as", dateOpts) as TaskRenderForm | null) ?? "list";
  const lines = form === "table" ? taskTable(result.rows) : result.rows.map(taskListItem);
  const warningLines = result.rows.map(parseWarningLine).filter((l): l is string => l !== null);
  return listOut(result.rows.length === 0 ? [] : [...lines, ...warningLines], budget, "_no tasks_");
}

async function renderRecurring(call: TemplateDirective, ctx: TemplateContext, dateOpts: TaskDateOptions, budget: number): Promise<Out> {
  const cap = intEnv("METISTRY_RECURRING_MAX_PER_DAY", ctx.recurringMax ?? DEFAULT_RECURRING_MAX_PER_DAY, ctx.env ?? process.env);
  const asked = keyOf(call, "limit", dateOpts);
  const limit = asked === null ? cap : Math.min(Number(asked), cap);
  const due = dateKey(call, "due", dateOpts);
  // One more than the cap, so "there are more" is a fact rather than a guess.
  const result = await queryRows(ctx, RECURRING_QUERY, { due, limit: limit + 1 });
  if (!result.ok) return { markdown: "", filled: false, warning: `no recurring rules — ${result.why}` };

  // D4: only the user's own hand materialises an instance. A routine proposes.
  const materialise = ctx.source === USER_SOURCE;
  const mint = ctx.newAnchor ?? defaultAnchor;
  const lines = result.rows.slice(0, limit).map((row) => parseWarningLine(row) ?? recurringLine(row, due, materialise, mint));
  if (result.rows.length > limit) lines.push(`…and ${result.rows.length - limit} more recurring (see Work ▸ Today)`);
  return listOut(lines, budget, "_nothing recurring_");
}

async function renderCalendar(call: TemplateDirective, ctx: TemplateContext, dateOpts: TaskDateOptions, budget: number): Promise<Out> {
  const absent = "no calendar — the eventkit bridge is not reachable";
  if (ctx.calendar === undefined || ctx.calendar === null) return { markdown: "", filled: false, warning: absent };
  let events: CalendarEvent[];
  try {
    events = await ctx.calendar.events(dateKey(call, "day", dateOpts));
  } catch {
    return { markdown: "", filled: false, warning: absent };
  }
  const env = ctx.env ?? process.env;
  const zone = ctx.timeZone ?? env["METISTRY_TZ"] ?? env["TZ"] ?? "UTC";
  return listOut(events.map((e) => eventItem(e, zone)), budget, "_nothing on the calendar_");
}

async function renderWork(call: TemplateDirective, ctx: TemplateContext, dateOpts: TaskDateOptions, budget: number): Promise<Out> {
  const where = keyOf(call, "where", dateOpts);
  const parsed = where === null ? ({ ok: true, flags: [], combine: "and" } as const) : parseWorkWhere(where);
  if (!parsed.ok) return { markdown: "", filled: false, warning: `can't read \`where: "${where ?? ""}"\` — ${parsed.error}` };
  const limit = keyOf(call, "limit", dateOpts);
  const result = await queryRows(ctx, WORK_QUERY, {
    day: dateKey(call, "day", dateOpts),
    flags: parsed.flags.join(","),
    combine: parsed.combine,
    ...(limit !== null ? { limit: Number(limit) } : {}),
  });
  if (!result.ok) return { markdown: "", filled: false, warning: `no agent work — ${result.why}` };
  return listOut(result.rows.map(workItem), budget, "_no agent work_");
}

async function renderRequests(call: TemplateDirective, ctx: TemplateContext, budget: number): Promise<Out> {
  const limit = call.keys.get("limit");
  const kind = call.keys.get("kind");
  const result = await queryRows(ctx, REQUESTS_QUERY, {
    ...(limit !== undefined ? { limit: Number(limit) } : {}),
    ...(kind !== undefined ? { kind } : {}),
  });
  if (!result.ok) return { markdown: "", filled: false, warning: `nothing waiting on you — ${result.why}` };
  return listOut(result.rows.map(requestItem), budget, "_nothing waiting on you_");
}

async function renderInclude(call: TemplateDirective, ctx: TemplateContext, dateOpts: TaskDateOptions, budget: number): Promise<Out> {
  const interpolated = interpolateDates(call.positional ?? "", dateOpts);
  const target = (interpolated.ok ? interpolated.text : (call.positional ?? "")).trim();
  const hash = target.indexOf("#");
  const path = (hash === -1 ? target : target.slice(0, hash)).trim();
  const heading = hash === -1 ? "" : target.slice(hash + 1).trim();

  // §6.3.2 — no recursion at all, and the cheapest loop to build is the
  // one-file loop, so it is named rather than left to a depth counter.
  if (path.replace(/\.md$/i, "").toLowerCase() === ctx.templatePath.replace(/\.md$/i, "").toLowerCase()) {
    return { markdown: "", filled: false, warning: "`include` cannot include the template itself — directives are never evaluated inside an included file (§6.3)" };
  }
  if (ctx.reader === undefined || ctx.reader === null) return { markdown: "", filled: false, warning: "no vault reader — `include` is not available" };

  let text: string | null;
  try {
    text = await ctx.reader.read(path);
  } catch {
    text = null;
  }
  if (text === null) return { markdown: "", filled: false, warning: `can't read \`${path}\` — no such file in the vault` };

  let slice = splitFrontmatter(text).body;
  if (heading !== "") {
    const section = sectionOf(slice, heading);
    if (section === null) return { markdown: "", filled: false, warning: `\`${path}\` has no section \`${heading}\`` };
    slice = section;
  }
  const trimmed = slice.trim();
  if (trimmed === "") return { markdown: `_${path} is empty_`, filled: false };
  const cut = fit(trimmed.split("\n"), budget);
  return {
    markdown: cut.dropped > 0 ? `${cut.lines.join("\n")}\n${overflow(cut.dropped)}` : cut.lines.join("\n"),
    filled: true,
    truncated: cut.dropped > 0,
  };
}

/** The body under a `## Heading`, up to the next heading of the same or a higher level. */
export function sectionOf(text: string, heading: string): string | null {
  const lines = text.split(/\r?\n/);
  const want = heading.toLowerCase();
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})\s+(.*?)\s*$/.exec(lines[i] ?? "");
    if (!m) continue;
    if (start === -1) {
      if ((m[2] ?? "").toLowerCase() === want) {
        start = i + 1;
        level = (m[1] ?? "").length;
      }
      continue;
    }
    if ((m[1] ?? "").length <= level) return lines.slice(start, i).join("\n");
  }
  return start === -1 ? null : lines.slice(start).join("\n");
}

function renderProse(call: TemplateDirective, ctx: TemplateContext, dateOpts: TaskDateOptions, proseRequests: ProseRequest[]): Out {
  if (ctx.source !== FOLD_SOURCE) {
    // D14, and it is a mechanism rather than a convention: the engine knows
    // which file it is rendering, `ownershipRefusal` admits exactly one
    // non-self source, and a routine calls no model (invariant 4).
    return { markdown: "", filled: false, warning: "`prose` is only available in a fold template (§6.3)" };
  }
  const index = proseRequests.length + 1;
  const marker = `<!-- metistry:prose ${index} -->`;
  proseRequests.push({
    index,
    prompt: call.positional ?? "",
    using: keyOf(call, "using", dateOpts),
    marker,
    line: call.line,
  });
  return { markdown: `${marker} _pending — the fold writes this slot_`, filled: true };
}
