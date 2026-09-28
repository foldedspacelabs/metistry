// The filter vocabulary — §6.2 of docs/product/daily-flow-spec.md (P1-2).
//
// ONE filter language, three consumers (D15): a template's
// `{{ tasks where: "due <= today or overdue" order: "priority, due" }}`, the
// app's filter chips, and the plugin's suggester. A view the user builds in
// the app can be pasted into a template and back, because there is one parser
// and it is this file.
//
// THE PROPERTY THAT MATTERS: `where:` is not SQL, is never escaped, and is
// never interpolated into SQL. It compiles to BIND PARAMS of one named query
// (`vault_tasks_query`), which is what keeps invariant 3 intact —
// `packages/queries` executes "parameterized, NEVER string interpolation" and
// refuses an unknown param loudly. Anything outside the closed vocabulary is
// REFUSED with a message the renderer shows as §6.4's failure note; nothing
// is passed through, quoted, escaped or best-guessed. Two closed gates, in
// this order: a character class the whole expression must satisfy (so a quote,
// a semicolon, a parenthesis or a comment marker never reaches the parser at
// all), and then a vocabulary in which every field, flag, operator and value
// shape is enumerated here. The SQL-shaped error message is a courtesy; the
// refusal does not depend on recognising SQL.
//
// ---------------------------------------------------------------------------
// THE PARAM SHAPE, for whoever writes `seed/queries/vault_tasks_query.yaml`
// ---------------------------------------------------------------------------
//
// `compileTaskFilter` always returns EVERY param, so the YAML declares every
// one with a default and the query never sees a missing key.
// `TASK_FILTER_PARAM_SPEC` below is that declaration in machine-readable form
// — copy it into the YAML's `params:` and pin the two together with a test.
// Unset is `''` for text, `0` for int, `false` for boolean.
//
//   match_any                                           boolean
//   due_on | due_on_or_before | due_on_or_after         text, YYYY-MM-DD
//   do_on | do_on_or_before | do_on_or_after            text   (scheduled_for)
//   start_on | start_on_or_before | start_on_or_after   text   (start_on)
//   done_on | done_on_or_before | done_on_or_after      text   (done_on)
//   priority_eq | priority_max | priority_min           int, 1..4
//   size | size_rank_max | size_rank_min                text (s|m|l), int 1..3
//   type | assigned | project | area_prefix             text
//   source_prefix | status                              text
//   overdue | unscheduled | waiting | recurring         boolean
//   carried | blocking_agent | assigned_to_me           boolean
//   someday | names_person                              boolean
//   not_<flag>, one per flag above                      boolean (`not <flag>`)
//   carried_eq | carried_min | carried_max              int, days (the carry count)
//   order_1 | order_2 | order_3                         text (a field name)
//   order_1_desc | order_2_desc | order_3_desc          boolean
//   limit                                               int
//
// …and four CONTEXT params, which `where:` can never reach and which the
// CALLER fills. They are in this object rather than beside it because a
// contract split across two objects is a contract with a seam, and the seam
// is exactly where the two halves of P1-2 and P1-5 drifted apart the first
// time: `TASK_FILTER_PARAM_SPEC` is the query's `params:` block, whole.
// `compileTaskFilter` leaves every one of them at its default — nothing a
// user types can move them.
//
//   today          text, YYYY-MM-DD  the day `overdue`, `carried` and the
//                                    ageing counter are measured against;
//                                    blank = the cluster's `current_date`.
//                                    A renderer that resolved `due friday`
//                                    in METISTRY_TZ must pass the same day
//                                    here or the two disagree at midnight.
//   me             text              the owner's own `People/` page, for
//                                    `assigned_to_me`; blank = the instance
//                                    has no owner page and the flag means
//                                    "not delegated to anyone else"
//   path_prefix    text              the CALLER'S SCOPE — a vault path
//                                    prefix, matched segment-wise. Blank (or
//                                    `/`) is the whole vault
//   offset         int               paging; the order is total, so a window
//                                    can neither repeat a row nor skip one
//
// `path_prefix` and `status` SCOPE, and they scope under `and` always:
// `match_any` widens the predicate, never the scope, so an `or` can never
// reach a ticked line or a path outside the caller's. That is what makes
// this query's `expose: route` mean something — the route binds
// `path_prefix` from the principal, and no `where:` the caller writes can
// argue with it.
//
// Dates arrive ALREADY RESOLVED (`today` became `2026-09-18` against
// `METISTRY_TZ` at compile time), so the SQL never does date arithmetic and
// two consumers asking the same question at the same moment bind the same
// values. A strict bound is folded into an inclusive one — `due < today` is
// `due_on_or_before = yesterday` — so the query needs three date params per
// field and no operator ever travels.
//
// Cast an empty text param with `nullif`, never with a bare `::date`: SQL does
// not promise to short-circuit `:p = '' OR due = :p::date`, and `''::date`
// raises.
//
//   WITH f AS (
//     SELECT nullif(:due_on,'')::date         AS due_on,
//            nullif(:due_on_or_before,'')::date AS due_on_or_before,
//            nullif(:type,'')                 AS type,
//            nullif(:priority_eq,0)           AS priority_eq
//            -- …one line per param, all of them
//   )
//   SELECT … FROM vault_tasks t, f
//   WHERE CASE WHEN :match_any THEN (
//              (f.due_on IS NOT NULL AND t.due = f.due_on)
//           OR (f.type   IS NOT NULL AND t.type = f.type)
//           OR :overdue AND (t.due < current_date AND NOT t.checked)
//           -- …one disjunct per param
//         ) ELSE (
//              (f.due_on IS NULL OR t.due = f.due_on)
//          AND (f.type   IS NULL OR t.type = f.type)
//          AND (NOT :overdue OR (t.due < current_date AND NOT t.checked))
//         ) END
//
// `match_any` is the whole predicate's joiner: `and` throughout, or `or`
// throughout. MIXING THEM IS REFUSED — §6.2's grammar has no parentheses and
// no precedence, so `a and b or c` has no defined meaning, and inventing one
// silently is exactly the guess this spec forbids everywhere else.
//
// What each flag means, so the query and the chips agree — and these are the
// query's wording, not an approximation of it (`vault_tasks_query.yaml`
// computes each one once, returns the set it satisfied as `row_flags`, and
// judges the boolean param against that same column):
//   overdue         open, `due` is set, and `due` is before today
//   unscheduled     BOTH `scheduled_for` and `due` are null — the same count
//                   `task_ageing` reports under that name. It carries no
//                   open-ness of its own because `status` already scopes the
//                   rows, and a flag that re-stated the scope would disagree
//                   with it the first time someone passed `status: any`
//   waiting         `waiting` — delegated, and not the user's move (again,
//                   the scope says which rows are eligible)
//   recurring       an INSTANCE of a rule (`recur_parent` is not null). It
//                   cannot mean "is a rule": §4 says a `recur_rule` line is
//                   not a task and this query has no such row at all —
//                   `vault_tasks_recurring` is where the rules are read
//   carried         open, and `coalesce(scheduled_for, due)` is before today
//                   — it was owed on an earlier day. NOT `first_seen_on`,
//                   which is how long it has been SITTING and is the `age`
//                   half of `task_ageing`; the two are different questions
//   blocking_agent  a `work` row names this task as `meta.blocked_by` (§3)
//   assigned_to_me  `assigned` is null, or it is the instance owner's own
//                   `People/` page (`me`)
//   someday         the line carries the `someday` token (K6, T2-5): the
//                   owner deferred it to no day. A flag and not a field —
//                   it has no value to compare. It does not change what
//                   `unscheduled` means: a someday line with no date is
//                   both, because `task_ageing` counts `unscheduled` the
//                   same way and the two must not drift
//   names_person    the line names a person who is not the owner: `assigned`
//                   is set and is not `me` — exactly the rows
//                   `assigned_to_me` does not hold, said positively so a
//                   view can ask for them (ruling 14, X-14). With `waiting`
//                   it is owed BY them (Waiting on Others); without, it is
//                   owed TO them (Owed)
//
// THE CARRY COUNT (ruling 14). `carried` is also a FIELD, compared with a
// whole number of days: how many days the line has been carried past the day
// it was owed on — `today - coalesce(scheduled_for, due)`, the row's
// `carried_days`, the same number the Today chip reads as "carried 3 days".
// Each morning an open line is still owed is one more carry. `carried` alone
// stays the flag (carried at least once); `carried >= 3` is the field.
// Three params, like priority: `carried_eq`, `carried_min`, `carried_max`,
// inclusive, 0 = not filtering — so a bound that lands on 0 (`carried <= 0`,
// `carried = 0`) is REFUSED and points at `not carried`, and `carried >= 0`
// (every line) is refused rather than dropped, because a dropped clause under
// `or` would quietly narrow the view. A line that is not carried counts 0.
//
// NEGATION (ruling 14). `not <flag>` — and only a flag. Each flag has a
// `not_<flag>` boolean beside it, so a negated facet is one more fixed bind
// param and never a value: nothing the caller typed after `not` reaches the
// query except the choice of which closed boolean to set. It joins like any
// clause (`a or not b` is "a, or not b"; the grammar still has no brackets
// and still refuses to mix `and` with `or`). A field is narrowed by its
// operator, not negated (`carried <= 2`, never `not carried >= 3`), so `not`
// before a field is refused, as is `not not`, a bare `not`, and a flag asked
// for together with its own negation.
// `status` is `open` (not checked, not dropped) | `done` | `dropped` |
// `waiting` | `any`; `''` means the query's own default, which is open tasks.
// It SCOPES rather than joining the predicate (see `path_prefix` above).
// `project` is an exact slug (`projects.id` is flat); `area_prefix` and
// `source_prefix` match the value or the value followed by `/` and `:`
// respectively, so `area: Areas/Work` takes its children and
// `source: meeting` takes every `meeting:<path>`.
//
// ORDER BY cannot be a bind param, so the query builds one TEXT sort key per
// sortable field and picks three of them by name. A text key is what lets one
// expression serve any field and what keeps NULL ordering explicit rather
// than lucky:
//
//   priority → lpad(coalesce(t.priority,3)::text, 2, '0')
//   size     → coalesce(case t.size when 's' then '1' when 'm' then '2'
//                                   when 'l' then '3' end, '9')
//   due|do|start|done → coalesce(t.<col>::text, '9999-12-31')
//   the rest → coalesce(t.<col>, '~')
//
//   ORDER BY CASE WHEN NOT :order_1_desc THEN <key(:order_1)> END
//              COLLATE "C" ASC NULLS LAST,
//            CASE WHEN     :order_1_desc THEN <key(:order_1)> END
//              COLLATE "C" DESC NULLS LAST,
//            …slots 2 and 3…, t.path COLLATE "C", t.line_no, t.task_key
//
// `COLLATE "C"` on every text key and on the path tie-break: a locale
// collation ignores punctuation at the primary level, so the same rows page
// differently on a macOS cluster and a Linux one. An EMPTY slot sorts
// nothing and falls through, so `order:` absent means the vault's own order —
// path, then line — which is also the tie-break that makes every order total
// and `limit`/`offset` safe.
//
// Pure, like `task-line.ts`: no database, no vault, no network. It compiles;
// it does not execute.

import {
  PRIORITY_ALIASES,
  SIZE_ALIASES,
  SIZE_RANK,
  addTaskDays,
  resolveTaskDate,
  type TaskDateOptions,
  type TaskPriority,
  type TaskSize,
} from "./task-line.js";

/** The one query every consumer of this vocabulary binds into (D15, §6.2). No component reaches Postgres another way. */
export const TASK_QUERY_NAME = "vault_tasks_query";

/** §6.2's `field` list, closed. A new field is a product decision and a migration, not a config line. */
export const TASK_FILTER_FIELDS = [
  "due", "do", "start", "done", "priority", "size", "type", "assigned", "project", "area", "source", "status", "carried",
] as const;
export type TaskFilterField = (typeof TASK_FILTER_FIELDS)[number];

/** §6.2's `flag` list, closed. Each one is a predicate the query owns; the chips and the plugin offer exactly these. */
export const TASK_FILTER_FLAGS = [
  "overdue", "unscheduled", "waiting", "recurring", "carried", "blocking_agent", "assigned_to_me", "someday", "names_person",
] as const;
export type TaskFilterFlag = (typeof TASK_FILTER_FLAGS)[number];

/** The word that negates the flag after it (ruling 14). Only a flag — a field is narrowed by its operator. */
export const TASK_FILTER_NOT = "not";

/** Each flag's negated bind param: `not overdue` sets `not_overdue`, and that is all `not` can ever do. */
export type TaskFilterNotParam = `not_${TaskFilterFlag}`;
const notParam = (flag: TaskFilterFlag): TaskFilterNotParam => `not_${flag}`;

/** `:` is `=` spelled the way §2.1 spells it (`assigned:[[Jim Fallon]]`), so both forms mean one thing. */
export const TASK_FILTER_OPS = ["<=", "<", "=", ">=", ">", ":"] as const;
export type TaskFilterOp = (typeof TASK_FILTER_OPS)[number];

/** What `status:` may be. `any` is the only way to see closed and dropped rows together. */
export const TASK_STATUSES = ["open", "done", "dropped", "waiting", "any"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** `order:` takes the same field names — one vocabulary, not two. */
export const TASK_ORDER_FIELDS = TASK_FILTER_FIELDS;
export type TaskOrderField = TaskFilterField;

/** Fields whose values are dates, and which therefore take the three date params. */
const DATE_FIELDS = ["due", "do", "start", "done"] as const;
type DateField = (typeof DATE_FIELDS)[number];
const isDateField = (f: TaskFilterField): f is DateField => (DATE_FIELDS as readonly string[]).includes(f);

/** Fields that are names, not quantities: ordering them means nothing, so only `=` is admitted. */
const TEXT_FIELDS = ["type", "assigned", "project", "area", "source", "status"] as const;

/** A carry count: a whole number of days, at most four digits — a line carried for longer than that is not slipping, it is lost. */
const CARRY_RE = /^\d{1,4}$/;

const MAX_WHERE_CHARS = 400; // limit: fixed — a `where:` longer than this is a saved view or an injection attempt, and neither is a filter
const MAX_CLAUSES = 12;      // limit: fixed — one chip per clause; a twelve-chip view is already unreadable
const MAX_ORDER_TERMS = 3;   // limit: fixed — the query has three sort slots (see the ORDER BY recipe above)
const DEFAULT_TASK_LIMIT = 50;  // limit: fixed — one screen of tasks; a template that wants another says `limit:`
const TASK_LIMIT_CEILING = 500; // limit: fixed — above this a list is a report, and a report is a different surface

// --- the compiled shape -------------------------------------------------------

export interface TaskFilterParams {
  match_any: boolean;

  due_on: string;
  due_on_or_before: string;
  due_on_or_after: string;
  do_on: string;
  do_on_or_before: string;
  do_on_or_after: string;
  start_on: string;
  start_on_or_before: string;
  start_on_or_after: string;
  done_on: string;
  done_on_or_before: string;
  done_on_or_after: string;

  /** 1..4, 0 = unset. `priority_max` is a NUMERIC bound, so `priority <= p2` is "p1 or p2" — more important, not less. */
  priority_eq: number;
  priority_max: number;
  priority_min: number;

  size: string;
  /** s=1, m=2, l=3 (`SIZE_RANK`), so `size <= m` is expressible without the query knowing the letters' order. */
  size_rank_max: number;
  size_rank_min: number;

  type: string;
  assigned: string;
  project: string;
  area_prefix: string;
  source_prefix: string;
  status: string;

  overdue: boolean;
  unscheduled: boolean;
  waiting: boolean;
  recurring: boolean;
  carried: boolean;
  blocking_agent: boolean;
  assigned_to_me: boolean;
  someday: boolean;
  names_person: boolean;

  /** `not <flag>` (ruling 14): the flag's predicate must NOT hold. One closed boolean per flag — a negation never carries a value. */
  not_overdue: boolean;
  not_unscheduled: boolean;
  not_waiting: boolean;
  not_recurring: boolean;
  not_carried: boolean;
  not_blocking_agent: boolean;
  not_assigned_to_me: boolean;
  not_someday: boolean;
  not_names_person: boolean;

  /** The carry count, in days (ruling 14): inclusive, 0 = not filtering. A line that is not carried counts 0. */
  carried_eq: number;
  carried_min: number;
  carried_max: number;

  order_1: string;
  order_1_desc: boolean;
  order_2: string;
  order_2_desc: boolean;
  order_3: string;
  order_3_desc: boolean;

  limit: number;

  // --- context: the caller's, never the `where:` text's (see the header) ---

  /** The day `overdue`, `carried` and the ageing counter are measured against. Blank = the cluster's `current_date`. */
  today: string;
  /** The owner's own `People/` page, for `assigned_to_me`. Blank = the instance names no owner page. */
  me: string;
  /** The caller's SCOPE — a vault path prefix, matched segment-wise, always under `and`. Blank (or `/`) = the whole vault. */
  path_prefix: string;
  /** Paging. The query's order is total, so a window can neither repeat a row nor skip one. */
  offset: number;
}

export type TaskFilterClause =
  | { kind: "field"; field: TaskFilterField; op: TaskFilterOp; value: string }
  | { kind: "flag"; flag: TaskFilterFlag; negated: boolean };

export interface TaskOrderTerm {
  field: TaskOrderField;
  desc: boolean;
}

/** The parse, kept beside the params so the app's chips can render what the user asked for without re-reading the string. */
export interface ParsedTaskFilter {
  clauses: TaskFilterClause[];
  join: "and" | "or";
  order: TaskOrderTerm[];
  limit: number;
}

export type TaskFilterResult =
  | { ok: true; params: TaskFilterParams; filter: ParsedTaskFilter }
  | { ok: false; error: string };

export interface TaskFilterInput {
  where?: string | undefined;
  order?: string | undefined;
  limit?: number | undefined;
}

/**
 * Every param at its unset value — what the query's YAML declares as
 * defaults, including the four context params, which `compileTaskFilter`
 * never writes to and a caller fills in by hand:
 *
 *     const out = compileTaskFilter({ where, order }, { env });
 *     if (!out.ok) return failureNote(out.error);          // §6.4
 *     await queries.run(TASK_QUERY_NAME, {
 *       ...out.params, today, me, path_prefix: scope, offset,
 *     });
 */
export function taskFilterParams(): TaskFilterParams {
  return {
    match_any: false,
    due_on: "", due_on_or_before: "", due_on_or_after: "",
    do_on: "", do_on_or_before: "", do_on_or_after: "",
    start_on: "", start_on_or_before: "", start_on_or_after: "",
    done_on: "", done_on_or_before: "", done_on_or_after: "",
    priority_eq: 0, priority_max: 0, priority_min: 0,
    size: "", size_rank_max: 0, size_rank_min: 0,
    type: "", assigned: "", project: "", area_prefix: "", source_prefix: "", status: "",
    overdue: false, unscheduled: false, waiting: false, recurring: false,
    carried: false, blocking_agent: false, assigned_to_me: false, someday: false, names_person: false,
    not_overdue: false, not_unscheduled: false, not_waiting: false, not_recurring: false,
    not_carried: false, not_blocking_agent: false, not_assigned_to_me: false, not_someday: false, not_names_person: false,
    carried_eq: 0, carried_min: 0, carried_max: 0,
    order_1: "", order_1_desc: false, order_2: "", order_2_desc: false, order_3: "", order_3_desc: false,
    limit: DEFAULT_TASK_LIMIT,
    today: "", me: "", path_prefix: "", offset: 0,
  };
}

/**
 * `seed/queries/vault_tasks_query.yaml`'s `params:` block, whole — every
 * compiled param and every context param, with the type and default each is
 * declared with. It is the ONE object because the two halves of this contract
 * were once written blind to each other and every name differed;
 * `apps/console/test/seed-queries.test.ts` now asserts the YAML equals this,
 * so neither side can move without the other.
 */
export const TASK_FILTER_PARAM_SPEC: Readonly<Record<keyof TaskFilterParams, { type: "int" | "text" | "boolean"; default: number | string | boolean }>> =
  Object.freeze(Object.fromEntries(
    Object.entries(taskFilterParams()).map(([k, v]) => [
      k,
      { type: typeof v === "boolean" ? "boolean" : typeof v === "number" ? "int" : "text", default: v },
    ]),
  ) as Record<keyof TaskFilterParams, { type: "int" | "text" | "boolean"; default: number | string | boolean }>);

// --- the tokeniser ------------------------------------------------------------
//
// Gate one. Every character an expression may contain, and nothing else: no
// quote, no semicolon, no parenthesis, no `*`, no `%`, no backslash, no `#`.
// A comment marker cannot form, a string cannot open, a call cannot be
// written. This is not the defence — the closed vocabulary below is — it is
// the door in front of it.

const ALLOWED_CHARS = /^[A-Za-z0-9 \t_\-+:.,<>=[\]/@]*$/;
const SQL_SHAPED = /(^|\s)(select|insert|update|delete|drop|union|alter|truncate|exec|grant|revoke|where|from|join|having)(\s|$)|--|\/\*|;/i;

type TokKind = "word" | "op" | "comma" | "link";
interface FToken {
  kind: TokKind;
  text: string;
}

function tokenizeFilter(input: string): FToken[] | string {
  const toks: FToken[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i] ?? "";
    if (ch === " " || ch === "\t") {
      i += 1;
      continue;
    }
    if (input.startsWith("[[", i)) {
      const close = input.indexOf("]]", i + 2);
      if (close === -1) return "an unclosed `[[`";
      toks.push({ kind: "link", text: input.slice(i + 2, close).trim() });
      i = close + 2;
      continue;
    }
    if (ch === "<" || ch === ">") {
      const two = input[i + 1] === "=";
      toks.push({ kind: "op", text: two ? `${ch}=` : ch });
      i += two ? 2 : 1;
      continue;
    }
    if (ch === "=") {
      toks.push({ kind: "op", text: "=" });
      i += 1;
      continue;
    }
    if (ch === ",") {
      toks.push({ kind: "comma", text: "," });
      i += 1;
      continue;
    }
    // `:` is a word character, not an operator, because a VALUE carries one:
    // `source = template:recurring`, `source = mail:<id>`. The clause parser
    // splits `due:today` back apart when the part before the colon is a field.
    const start = i;
    while (i < input.length && /[A-Za-z0-9_\-+./@:]/.test(input[i] ?? "")) i += 1;
    if (i === start) return `\`${ch}\``; // unreachable while ALLOWED_CHARS holds; a belt behind the braces
    const text = input.slice(start, i);
    toks.push({ kind: text === ":" ? "op" : "word", text });
  }
  return toks;
}

// --- the parse ----------------------------------------------------------------

const VOCABULARY = `fields: ${TASK_FILTER_FIELDS.join(" ")} · flags: ${TASK_FILTER_FLAGS.join(" ")} · \`not <flag>\``;
const refused = (why: string): { ok: false; error: string } => ({ ok: false, error: why });

const isField = (w: string): w is TaskFilterField => (TASK_FILTER_FIELDS as readonly string[]).includes(w);
const isFlag = (w: string): w is TaskFilterFlag => (TASK_FILTER_FLAGS as readonly string[]).includes(w);
const isOp = (t: string): t is TaskFilterOp => (TASK_FILTER_OPS as readonly string[]).includes(t);

function parseWhere(where: string): { ok: true; clauses: TaskFilterClause[]; join: "and" | "or" } | { ok: false; error: string } {
  if (where.length > MAX_WHERE_CHARS) return refused(`\`where:\` is longer than ${MAX_WHERE_CHARS} characters — that is a saved view, not a filter`);
  if (!ALLOWED_CHARS.test(where)) {
    const bad = [...where].find((c) => !ALLOWED_CHARS.test(c)) ?? "";
    const sql = SQL_SHAPED.test(where) ? " — `where:` is a closed filter vocabulary, not SQL" : "";
    return refused(`\`where:\` cannot contain \`${bad}\`${sql} (${VOCABULARY})`);
  }

  const toks = tokenizeFilter(where);
  if (typeof toks === "string") return refused(`\`where:\` has ${toks}`);

  const clauses: TaskFilterClause[] = [];
  let join: "and" | "or" | null = null;
  let i = 0;
  while (i < toks.length) {
    if (clauses.length >= MAX_CLAUSES) return refused(`\`where:\` has more than ${MAX_CLAUSES} clauses`);
    const head = toks[i];
    if (!head || head.kind !== "word") return refused(`\`where:\` expected a field or a flag, found \`${head?.text ?? ""}\` (${VOCABULARY})`);

    // `assigned:[[Jim Fallon]]` and `due:today` — §2.1's spelling, where the
    // colon and the value are stuck to the field.
    let word = head.text.toLowerCase();
    let glued: string | null = null;
    const colon = word.indexOf(":");
    if (colon > 0 && isField(word.slice(0, colon))) {
      glued = head.text.slice(colon + 1);
      word = word.slice(0, colon);
    }

    if (word === TASK_FILTER_NOT) {
      // `not <flag>` (ruling 14) — the one negation there is. What follows
      // `not` is looked up in the closed flag list and nothing else: it can
      // only ever choose which `not_<flag>` boolean to set.
      const target = toks[i + 1];
      if (!target) return refused(`\`where:\` ends with \`${TASK_FILTER_NOT}\` and no flag after it`);
      const negate = target.kind === "word" ? target.text.toLowerCase() : "";
      if (negate === TASK_FILTER_NOT) return refused("`where:` cannot read `not not` — say the flag itself, or `not` once");
      const at = negate.indexOf(":");
      const fieldish = isField(at > 0 ? negate.slice(0, at) : negate) && (at > 0 || !isFlag(negate) || toks[i + 2]?.kind === "op");
      if (fieldish) {
        return refused(`\`where:\` negates only a flag — \`${TASK_FILTER_NOT} ${target.text}\` names a field, and a field is narrowed by its operator (\`carried <= 2\`, \`priority >= p3\`), not by \`${TASK_FILTER_NOT}\``);
      }
      if (!isFlag(negate)) {
        const sql = SQL_SHAPED.test(negate) ? " — `where:` is a closed filter vocabulary, not SQL" : "";
        return refused(`\`where:\` cannot negate \`${target.text}\`${sql} — \`${TASK_FILTER_NOT}\` takes one of the flags: ${TASK_FILTER_FLAGS.join(" ")}`);
      }
      clauses.push({ kind: "flag", flag: negate, negated: true });
      i += 2;
    } else if (glued !== null && isField(word)) {
      const inline = glued !== "" ? { kind: "word" as TokKind, text: glued } : toks[i + 1];
      if (!inline || (inline.kind !== "word" && inline.kind !== "link")) {
        return refused(`\`where:\` expected a value after \`${word}:\``);
      }
      clauses.push({ kind: "field", field: word, op: ":", value: inline.kind === "link" ? `[[${inline.text}]]` : inline.text });
      i += glued !== "" ? 1 : 2;
    } else if (isFlag(word) && !(isField(word) && toks[i + 1]?.kind === "op")) {
      // `carried` is both: alone it is the flag, followed by an operator it
      // is the carry count (`carried >= 3`)
      clauses.push({ kind: "flag", flag: word, negated: false });
      i += 1;
    } else if (isField(word)) {
      const op = toks[i + 1];
      if (!op || op.kind !== "op" || !isOp(op.text)) {
        return refused(`\`where:\` expected one of ${TASK_FILTER_OPS.join(" ")} after \`${word}\`, found \`${op?.text ?? "nothing"}\``);
      }
      const value = toks[i + 2];
      if (!value || (value.kind !== "word" && value.kind !== "link")) {
        return refused(`\`where:\` expected a value after \`${word} ${op.text}\``);
      }
      clauses.push({ kind: "field", field: word, op: op.text, value: value.kind === "link" ? `[[${value.text}]]` : value.text });
      i += 3;
    } else {
      const sql = SQL_SHAPED.test(word) ? " — `where:` is a closed filter vocabulary, not SQL" : "";
      return refused(`\`where:\` does not know \`${head.text}\`${sql} (${VOCABULARY})`);
    }

    const next = toks[i];
    if (!next) break;
    const joiner = next.kind === "word" ? next.text.toLowerCase() : "";
    if (joiner !== "and" && joiner !== "or") {
      return refused(`\`where:\` expected \`and\` or \`or\` between clauses, found \`${next.text}\``);
    }
    if (join && join !== joiner) {
      return refused("`where:` cannot mix `and` with `or` — the vocabulary has no brackets, so one or the other (§6.2)");
    }
    join = joiner;
    i += 1;
    if (i >= toks.length) return refused(`\`where:\` ends with \`${joiner}\` and no clause after it`);
  }

  // A flag and its own negation is no filter: under `and` it is nothing, under
  // `or` it is everything, and neither is what anyone meant to type.
  for (const c of clauses) {
    if (c.kind === "flag" && c.negated && clauses.some((d) => d.kind === "flag" && !d.negated && d.flag === c.flag)) {
      return refused(`\`where:\` asks for \`${c.flag}\` and \`${TASK_FILTER_NOT} ${c.flag}\` together — one or the other`);
    }
  }
  return { ok: true, clauses, join: join ?? "and" };
}

function parseOrder(order: string): { ok: true; terms: TaskOrderTerm[] } | { ok: false; error: string } {
  if (order.length > MAX_WHERE_CHARS) return refused(`\`order:\` is longer than ${MAX_WHERE_CHARS} characters`);
  if (!ALLOWED_CHARS.test(order)) {
    const bad = [...order].find((c) => !ALLOWED_CHARS.test(c)) ?? "";
    return refused(`\`order:\` cannot contain \`${bad}\` — it is a comma list of ${TASK_ORDER_FIELDS.join(" ")}`);
  }
  const terms: TaskOrderTerm[] = [];
  for (const raw of order.split(",")) {
    const part = raw.trim();
    if (part === "") continue;
    const words = part.split(/\s+/);
    const [field = "", dir = "asc", extra] = words;
    if (extra !== undefined) return refused(`\`order:\` cannot read \`${part}\` — a field, optionally followed by \`desc\``);
    const name = field.toLowerCase();
    if (!isField(name)) return refused(`\`order:\` does not know \`${field}\` — the fields are ${TASK_ORDER_FIELDS.join(" ")}`);
    const d = dir.toLowerCase();
    if (d !== "asc" && d !== "desc") return refused(`\`order:\` expected \`asc\` or \`desc\` after \`${name}\`, found \`${dir}\``);
    if (terms.length >= MAX_ORDER_TERMS) return refused(`\`order:\` takes at most ${MAX_ORDER_TERMS} fields`);
    terms.push({ field: name, desc: d === "desc" });
  }
  return { ok: true, terms };
}

// --- the compile --------------------------------------------------------------

/** The text-valued params, so the date slots below can be written to without widening every param to `never`. */
type TextParam = { [K in keyof TaskFilterParams]: TaskFilterParams[K] extends string ? K : never }[keyof TaskFilterParams];

const DATE_PARAMS: Readonly<Record<DateField, { on: TextParam; before: TextParam; after: TextParam }>> = {
  due: { on: "due_on", before: "due_on_or_before", after: "due_on_or_after" },
  do: { on: "do_on", before: "do_on_or_before", after: "do_on_or_after" },
  start: { on: "start_on", before: "start_on_or_before", after: "start_on_or_after" },
  done: { on: "done_on", before: "done_on_or_before", after: "done_on_or_after" },
};

const priorityOf = (value: string): TaskPriority | null => {
  const v = value.toLowerCase();
  return PRIORITY_ALIASES[v] ?? PRIORITY_ALIASES[`p${v}`] ?? null;
};
const sizeOf = (value: string): TaskSize | null => SIZE_ALIASES[value.toLowerCase()] ?? null;
const unlink = (value: string): string => value.replace(/^\[\[(.*)\]\]$/, "$1").replace(/^@/, "").trim();

const SLUG_RE = /^[a-z][a-z0-9_-]{0,39}$/;
const PROJECT_RE = /^[a-z][a-z0-9-]{0,39}$/;
const PATHISH_RE = /^[A-Za-z0-9][A-Za-z0-9 _./-]{0,119}$/;
const SOURCE_RE = /^[a-z][a-z0-9_-]*(:[^\s]{1,160})?$/;

/**
 * Parse `where:`/`order:` and compile them to the bind params of
 * `vault_tasks_query`. Never throws on bad input: a refusal is a value, since
 * every caller has to render it (§6.4 — the template writes a visible note and
 * the file still renders; the app shows the chip as unreadable; the plugin
 * declines to suggest).
 */
export function compileTaskFilter(input: TaskFilterInput = {}, opts: TaskDateOptions = {}): TaskFilterResult {
  const params = taskFilterParams();

  const limit = input.limit ?? DEFAULT_TASK_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) return refused(`\`limit:\` must be a whole number of rows, found \`${String(input.limit)}\``);
  if (limit > TASK_LIMIT_CEILING) return refused(`\`limit:\` is above ${TASK_LIMIT_CEILING} — that is a report, not a list`);
  params.limit = limit;

  const where = parseWhere(input.where ?? "");
  if (!where.ok) return where;
  params.match_any = where.join === "or";

  for (const clause of where.clauses) {
    if (clause.kind === "flag") {
      // a negation sets the flag's own closed `not_` boolean — the only thing
      // `not` can reach (ruling 14)
      params[clause.negated ? notParam(clause.flag) : clause.flag] = true;
      continue;
    }
    const { field, op, value } = clause;
    const eq = op === "=" || op === ":";

    if (isDateField(field)) {
      const date = resolveTaskDate(value, opts);
      if (!date) return refused(`\`where:\` cannot read the date \`${value}\` in \`${field} ${op} ${value}\` — never a guess (§1.4)`);
      const slot = DATE_PARAMS[field];
      if (eq) params[slot.on] = date;
      else if (op === "<=") params[slot.before] = date;
      else if (op === "<") params[slot.before] = addTaskDays(date, -1) ?? date;
      else if (op === ">=") params[slot.after] = date;
      else params[slot.after] = addTaskDays(date, 1) ?? date;
      continue;
    }

    if (field === "priority") {
      const p = priorityOf(value);
      if (!p) return refused(`\`where:\` cannot read the priority \`${value}\` — p1..p4, or ${Object.keys(PRIORITY_ALIASES).slice(4).join(" | ")}`);
      // Numeric bounds: p1 is 1, so "<=" means MORE important, which is how
      // the scale is stored and how `coalesce(priority, 3)` orders it.
      if (eq) {
        params.priority_eq = p;
        continue;
      }
      const bound = op === "<" ? p - 1 : op === ">" ? p + 1 : p;
      // 0 and 5 are not levels, and 0 is this shape's word for "not filtering":
      // a bound that fell off the scale must refuse, never quietly widen.
      if (bound < 1 || bound > 4) return refused(`\`where:\` asks for a priority outside p1..p4 with \`${field} ${op} ${value}\``);
      if (op === "<=" || op === "<") params.priority_max = bound;
      else params.priority_min = bound;
      continue;
    }

    if (field === "size") {
      const s = sizeOf(value);
      if (!s) return refused(`\`where:\` cannot read the size \`${value}\` — ${Object.keys(SIZE_ALIASES).join(" | ")}`);
      if (eq) {
        params.size = s;
        continue;
      }
      const rank = SIZE_RANK[s];
      const bound = op === "<" ? rank - 1 : op === ">" ? rank + 1 : rank;
      if (bound < 1 || bound > 3) return refused(`\`where:\` asks for a size outside s..l with \`${field} ${op} ${value}\``);
      if (op === "<=" || op === "<") params.size_rank_max = bound;
      else params.size_rank_min = bound;
      continue;
    }

    if (field === "carried") {
      // The carry count (ruling 14): whole days, inclusive bounds, 0 = not
      // filtering — so a clause that would land on 0 is refused rather than
      // silently dropped (under `or`, a dropped clause narrows the view).
      if (!CARRY_RE.test(value)) return refused(`\`where:\` cannot read the carry count \`${value}\` in \`${field} ${op} ${value}\` — a whole number of days, like \`carried >= 3\``);
      const n = Number(value);
      const bound = op === "<" ? n - 1 : op === ">" ? n + 1 : n;
      if ((eq || op === "<=" || op === "<") && bound < 1) {
        return refused(`\`where:\` asks for lines never carried with \`${field} ${op} ${value}\` — say \`not carried\``);
      }
      if ((op === ">=" || op === ">") && bound < 1) {
        return refused(`\`where:\` \`${field} ${op} ${value}\` is every line — leave it out`);
      }
      if (eq) params.carried_eq = bound;
      else if (op === "<=" || op === "<") params.carried_max = bound;
      else params.carried_min = bound;
      continue;
    }

    if (!eq) {
      return refused(`\`where:\` compares \`${field}\` only with \`=\` — \`${op}\` orders things, and ${TEXT_FIELDS.join(", ")} are names`);
    }
    const plain = unlink(value);
    switch (field) {
      case "type":
        if (!SLUG_RE.test(plain.toLowerCase())) return refused(`\`where:\` cannot read the type \`${value}\` — a lowercase slug`);
        params.type = plain.toLowerCase();
        break;
      case "assigned":
        if (!PATHISH_RE.test(plain)) return refused(`\`where:\` cannot read the person \`${value}\` — a name or \`[[A Page]]\``);
        params.assigned = plain;
        break;
      case "project":
        if (!PROJECT_RE.test(plain.toLowerCase())) return refused(`\`where:\` cannot read the project \`${value}\` — a slug, as \`projects.id\` spells it`);
        params.project = plain.toLowerCase();
        break;
      case "area":
        if (!PATHISH_RE.test(plain)) return refused(`\`where:\` cannot read the area \`${value}\``);
        params.area_prefix = plain;
        break;
      case "source":
        if (!SOURCE_RE.test(plain)) return refused(`\`where:\` cannot read the source \`${value}\` — \`meeting\`, \`mail:<id>\`, \`agent:<id>\`, \`template:recurring\``);
        params.source_prefix = plain;
        break;
      case "status": {
        const s = plain.toLowerCase();
        if (!(TASK_STATUSES as readonly string[]).includes(s)) return refused(`\`where:\` does not know the status \`${value}\` — ${TASK_STATUSES.join(" | ")}`);
        params.status = s;
        break;
      }
    }
  }

  const order = parseOrder(input.order ?? "");
  if (!order.ok) return order;
  const slots = [["order_1", "order_1_desc"], ["order_2", "order_2_desc"], ["order_3", "order_3_desc"]] as const;
  order.terms.forEach((term, n) => {
    const slot = slots[n];
    if (!slot) return;
    params[slot[0]] = term.field;
    params[slot[1]] = term.desc;
  });

  return { ok: true, params, filter: { clauses: where.clauses, join: where.join, order: order.terms, limit } };
}
