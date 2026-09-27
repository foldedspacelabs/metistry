// plan-tomorrow — the evening's one machine file (daily-flow-spec §5.1, §7;
// ticket P1-7).
//
// It renders `Templates/Plan.md` — a markdown file in the user's own vault,
// which they edit in Obsidian — into `Journal/Plan/<tomorrow>.md`, written
// through the reconciler's vault bridge as `principal: plan-tomorrow`. That
// is the whole job, and the three rules around it are mechanisms rather than
// intentions:
//
//  1. **No model, anywhere in it** (invariant 4). The ordering is the
//     template's (`order: "priority, due, size"` — a field list), the user's
//     prioritisation RULE is prose included verbatim by `{{ include }}` for
//     the human to read, and `{{ prose }}` renders a refusal note in a
//     template whose output the assistant may not write (§6.3.3). The
//     manifest declares no `engine`, so the runner never even asks.
//  2. **One writer per file, and it never touches a note the user owns**
//     (§5.1, D10). It writes exactly one path. A plan file whose frontmatter
//     `source:` is not this routine's — including a file with no `source:` at
//     all, which since #231 is the user's — is never overwritten. A recurring
//     rule is LISTED as a proposal, never materialised: the engine keys that
//     off the render's `source` (D4), and `refuseMaterialised` below is the
//     belt behind it.
//  3. **One read path into state** (invariant 3). Every row the plan shows
//     comes from a named query through the injected store — `vault_tasks_query`,
//     `vault_tasks_recurring`, `day_work`, `pending_requests` — and this file
//     holds no SQL but its own `runs` bookkeeping.
//
// SCHEDULE (§2.5): `eve_of_working_days` at 23:00, from the manifest — every
// evening whose next day is a working day, after the 21:00 fold. The
// console's runner fires it once, at its time (T3-1), so the clock gates the
// hourly schedule needed — "not before noon", "not before the day end
// Me/profile.md states" — are gone. What stays is the WORKING-EVE GUARD
// below: a run nobody scheduled for an eve (Run Now, Close the Day, an
// owner's own `days:`) still plans only a working day, and records
// `skipped:not_a_working_eve` otherwise. A run the runner fired late — the
// Mac slept through 23:00 and woke at 07:30 — plans the day after its SLOT
// (`ctx.scheduledFor`, in `ctx.timeZone`), which is today, not tomorrow.
//
// AFTER THE FOLD (§2.5, T3-7). The 23:00 run comes two hours after the
// 21:00 Knowledge Fold, so the plan links tonight's `Journal/Fold/<date>.md`
// and lists its `decisions:` frontmatter as a section of its own — read from
// the file's header, never summarised: still model-free.
//
// EARLY, THEN SUPERSEDED (§2.5, §2.13). Close the Day (T2-8) runs this with
// `ctx.closedDay`: the plan renders EARLY for the day after the one closed,
// before there is a fold to link. The 23:00 run then SUPERSEDES that render
// — same path, compare-and-swap on the bytes the early render left — with
// the fold's context. The ledger says which is which: every row this routine
// writes carries `meta.trigger` (`close` | `schedule` | `manual`), and only a
// row that is NOT a close settles a date. So a second close re-renders (the
// owner's own act, every time), the 23:00 run replaces any number of early
// renders, and a second scheduled or manual pass after it stays silent.
//
// THE GUARD, in order, and what each costs:
//
//   already settled for that   → one indexed `runs` read (a close skips it:
//     target date                  closing again is asking again)
//   tomorrow is not a working  → one small vault read (`Me/profile.md`),
//     day                        recorded `not_a_working_eve`, and the
//                                evening goes quiet
//
// DEGRADING HONESTLY (§6.4, §6.6). No `working_days` in `Me/` → nothing is
// written and the run says `no_working_days`, rather than guessing
// Monday-to-Friday (the runner says it first, and does not run this at all
// on a day set it cannot resolve). No calendar bridge, no query store, a
// `where:` the vocabulary refuses — each renders one line and the plan still
// lands.

import {
  DEFAULT_TEMPLATE_MAX_BYTES,
  PROFILE_PATH as CORE_PROFILE_PATH,
  WEEKDAYS,
  TEMPLATE_MISSING,
  TEMPLATE_UNREADABLE,
  addTaskDays,
  calendarDate,
  configuredTimeZone,
  intEnv,
  profileFrontmatter,
  profileWeekdays,
  renderTemplate,
  templateSkip,
  validTimeZone,
  vaultLink,
  type CalendarEvent,
  type CalendarProvider,
  type TemplateQueries,
  type Weekday,
} from "@foldedspacelabs/metistry-core";
import { foldPath } from "../knowledge-fold/run.js";
import type { Db, RoutineCtx } from "../morning-brief/run.js";
import { vaultReader } from "../vault-reader.js";

export const COMPONENT = "plan-tomorrow";
/** §5.1: `Journal/Plan/<date>.md` — machine-owned, one writer, and this is it. */
export const PLAN_DIR = "Journal/Plan";
/** D12: templates live in the vault, where Obsidian can see them and the user edits them. */
export const TEMPLATE_PATH = "Templates/Plan.md";
/** §6.6: the machine-readable half of "how I work". Nothing can guess these, so nothing does. Core's, so every reader names one file. */
export const PROFILE_PATH = CORE_PROFILE_PATH;
/** The `intent.principal` every write carries, and the `source:` the rendered file declares — the string `ownershipRefusal` reads later. */
export const PRINCIPAL = COMPONENT;

const EK_TIMEOUT_MS = 15_000; // limit: fixed — the eventkit bridge is on this Mac; morning-brief gives its own /events call the same 15s
const EK_MAX_DAYS = 31; // limit: fixed — `GET /events` clamps `days` to 31 (packages/mcp-eventkit/src/index.ts); asking for more is asking for a clamp

/**
 * Why a pass wrote nothing. Every one of them is a fact about the install or
 * the day, never a fault: the run is `ok`, the reason is on the row, and
 * `metistry doctor` reads the same table.
 */
export const PLAN_SKIPS = [
  "already_planned", // this target date is settled, whichever way it went
  "no_working_days", // §6.6: Me/ does not say which days you work, and nothing guesses
  "not_a_working_eve", // §2.5: tomorrow is not one of them, so tonight is not the eve of a working day
  "no_vault", // no reconciler bridge: nothing to read the template from, nowhere to write
  TEMPLATE_MISSING, // §6.4: a configuration fact, silent
  TEMPLATE_UNREADABLE, // §6.4: not text, or over the cap — one report request names the file
  "user_owned", // the plan file on disk is not this routine's; §5.1's ownership rule wins
  "would_materialise", // the belt behind D4 (below) — the engine's own rule already forbids it
] as const;
export type PlanSkip = (typeof PLAN_SKIPS)[number];

// --- what the routine is handed ------------------------------------------------

/** `VaultClient`-shaped (`apps/console/src/vault-client.ts`), narrowed to the two verbs this routine has: read, and write with compare-and-swap. No delete, no rename, no list. */
export interface PlanVault {
  read(path: string): Promise<{ content: Buffer; sha256: string } | null>;
  write(
    path: string,
    content: Buffer,
    intent: { principal: string; message: string; group?: string | undefined },
    expectedSha256?: string,
  ): Promise<{ path: string; sha256: string; bytes: number; created: boolean }>;
}

export interface PlanCtx extends RoutineCtx {
  /** The named-query store (`packages/queries`). Invariant 3: the routine has no other read path into state, and absent it renders §6.4's note per directive. */
  queries?: TemplateQueries | undefined;
  /** The vault bridge. Absent → the routine plans nothing and says which variables would fix it. */
  vault?: PlanVault | undefined;
  /** The owner's own person page (`People/…`), for the filter's `assigned_to_me`. The caller's to know; a template can never reach it. */
  me?: string | undefined;
  /** Injected by tests and by the fake-calendar suites; production builds one from `ekUrl`/`ekToken`, or null. */
  calendar?: CalendarProvider | null | undefined;
  /** Injected by tests; production uses the wall clock. */
  now?: Date | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  /**
   * Close the Day (T2-8's `POST /api/today/close {day}`): the `YYYY-MM-DD`
   * just closed. Present, this run is the EARLY render — it plans the day
   * after `closedDay`, whatever the clock says, is never silenced by an
   * earlier render of the same date (closing again re-renders), and records
   * `trigger: "close"`, which the 23:00 run supersedes. Absent: a scheduled
   * run (`scheduledFor`) or one nobody scheduled (Run Now).
   */
  closedDay?: string | undefined;
}

/** Who asked for this render — on every `runs` row this routine writes, as `meta.trigger`. Only a `close` row leaves its date open for the 23:00 run. */
export type PlanTrigger = "close" | "schedule" | "manual";

export const triggerOf = (ctx: PlanCtx): PlanTrigger => (ctx.closedDay !== undefined ? "close" : ctx.scheduledFor !== undefined ? "schedule" : "manual");

// --- Me/profile.md -------------------------------------------------------------

/** A note's leading `---` block — here only to put the degradation note under it (`withNote`); READING it is core's. */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export interface WorkingProfile {
  /** Weekday numbers (0 = Sunday), or null when `Me/` does not say — and null is never filled in with a guess. */
  workingDays: number[] | null;
  /** Minutes past local midnight the working day ends, or null when `working_hours` is absent or unreadable. */
  dayEnd: number | null;
}

/**
 * A note's frontmatter as keys, or null when it has none / is not a mapping.
 * Never throws: an unreadable header is an absent one. Core's reader
 * (`profileFrontmatter`) — the scheduler reads `Me/profile.md` through the
 * same one, so the two cannot disagree about what the profile says.
 */
export function frontmatterOf(text: string | null): Record<string, unknown> | null {
  return profileFrontmatter(text);
}

/**
 * §5.1's ownership question, asked of the bytes already on disk: who wrote
 * this file? A note with NO `source:` is the user's, not ownerless (#231), so
 * the caller treats null as "not mine".
 */
export function sourceOf(text: string): string | null {
  const value = frontmatterOf(text)?.["source"];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** `[mon, tue]`, `["Monday"]` or a block sequence — anything YAML admits, as weekday numbers. Null when nothing readable is there. Core's `profileWeekdays`, as numbers. */
export function workingDaysOf(value: unknown): number[] | null {
  return profileWeekdays(value)?.map((d: Weekday) => WEEKDAYS.indexOf(d)) ?? null;
}

/** `"09:00-17:30"` → 1050, the minute the working day ends. Null when it is absent or shaped otherwise — never a guess. */
export function dayEndOf(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const m = /^\s*\d{1,2}:\d{2}\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(value);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

export function parseProfile(text: string | null): WorkingProfile {
  const fields = frontmatterOf(text) ?? {};
  return { workingDays: workingDaysOf(fields["working_days"]), dayEnd: dayEndOf(fields["working_hours"]) };
}

// --- dates ---------------------------------------------------------------------

/**
 * The instance's zone: METISTRY_TZ, and never TZ — both deployment shapes pin
 * the process's TZ to UTC (T3-1), so reading it would plan the wrong
 * "tomorrow" for anyone west of Greenwich after 20:00. UTC only when nothing
 * says otherwise.
 */
export const zoneOf = (env: NodeJS.ProcessEnv): string => configuredTimeZone(env) ?? "UTC";

/** The zone a run dates in: the slot's (the runner's), then `Me/profile.md`'s `timezone` when `Intl` knows it, then `zoneOf`. */
export function runZone(ctx: PlanCtx, profileText: string | null, env: NodeJS.ProcessEnv): string {
  if (ctx.timeZone) return ctx.timeZone;
  const tz = frontmatterOf(profileText)?.["timezone"];
  return validTimeZone(tz) ? tz : zoneOf(env);
}

/** The weekday of a calendar date, as civil arithmetic — no zone, because `2026-09-22` is a Tuesday everywhere. */
export function weekdayOf(date: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
}

/**
 * An instant whose calendar date in `timeZone` is `day` — `now` itself when
 * it already is (a close of today, the ordinary case), else the nearest of
 * noon UTC on that day and twelve hours either side, which covers every
 * zone from −12:00 to +14:00. It is what lets Close the Day of an earlier
 * day plan the day after IT: the template engine resolves "tomorrow" from an
 * instant, not from a date.
 */
export function instantOn(day: string, timeZone: string, now: Date): Date {
  if (calendarDate(now, timeZone) === day) return now;
  const noon = Date.parse(`${day}T12:00:00Z`);
  for (const hours of [0, -12, 12]) {
    const at = new Date(noon + hours * 3_600_000);
    if (calendarDate(at, timeZone) === day) return at;
  }
  return new Date(noon);
}

/** `YYYY-MM-DD` naming a day that exists — `2026-02-31` is not one, though `Date.UTC` would roll it into March. */
export function isCalendarDate(value: unknown): value is string {
  const m = typeof value === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
  if (!m) return false;
  const at = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return at.getUTCFullYear() === Number(m[1]) && at.getUTCMonth() === Number(m[2]) - 1 && at.getUTCDate() === Number(m[3]);
}

/** Whole days from `from` to `to`, both `YYYY-MM-DD`. Null when either is not a date. */
export function daysBetween(from: string, to: string): number | null {
  const at = (s: string): number | null => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
  };
  const a = at(from);
  const b = at(to);
  return a === null || b === null ? null : Math.round((b - a) / 86_400_000);
}

// --- the gate ------------------------------------------------------------------

export interface GateInput {
  /** The day being planned — the day after the slot, in the slot's zone. */
  target: string;
  profile: WorkingProfile;
}

export type GateVerdict = { ok: true } | { ok: false; reason: PlanSkip; why: string };

/**
 * The working-eve guard (§2.5: the schedule says WHEN; this says whether the
 * day planned is one you work — `eve_of_working_days` as a check, for the
 * runs nobody scheduled for an eve), as one pure function — which is what
 * makes "not a working eve" and "no `Me/`" unit-testable without a database,
 * a vault or a clock. With Monday–Friday working days, Sunday to Thursday
 * evenings plan the next day; Friday and Saturday evenings are skipped
 * `not_a_working_eve` (nothing plans Monday on a Friday). There is no clock
 * in it: the runner fires the routine at its time.
 */
export function gate(input: GateInput): GateVerdict {
  const { target, profile } = input;
  if (profile.workingDays === null) {
    return {
      ok: false,
      reason: "no_working_days",
      why: `${PROFILE_PATH} does not say which days you work (\`working_days: [mon, tue, wed, thu, fri]\`) — Metistry discovers that from you and never assumes it, so nothing was written`,
    };
  }
  const weekday = weekdayOf(target);
  if (weekday === null || !profile.workingDays.includes(weekday)) {
    return {
      ok: false,
      reason: "not_a_working_eve",
      why: `tonight is not the eve of a working day: ${target} is not one of your working days (${profile.workingDays.map((d) => WEEKDAYS[d]).join(", ")})`,
    };
  }
  return { ok: true };
}

// --- the seams -----------------------------------------------------------------

/**
 * A vault file as text, or null when the vault does not hold it. A bridge
 * that REFUSES is not "absent": the error propagates, the runner records the
 * failed run and alerts once (docs/ops/automation.md), and the next slot
 * tries again — which is the difference between "Me/ says nothing" and
 * "the vault could not be asked", and it is why the evening is not settled
 * with the wrong reason.
 */
async function readText(vault: PlanVault, path: string): Promise<string | null> {
  const file = await vault.read(path);
  return file === null ? null : file.content.toString("utf8");
}

/**
 * No query store wired: every query-backed directive renders §6.4's "not
 * available" note and the plan still lands. Throwing here rather than
 * returning no rows is deliberate — "the query is not configured" and "the
 * query found nothing" are different sentences, and the file says which.
 */
export const NO_QUERIES: TemplateQueries = {
  async run(name: string): Promise<{ rows: Record<string, unknown>[] }> {
    throw new Error(`no named-query store is wired into ${COMPONENT} (${name})`);
  },
};

/**
 * The eventkit bridge as a `CalendarProvider` for one day. `GET /events?days=N`
 * counts forward from now (§7 asks for `days=2`, which is exactly tomorrow),
 * so the window is computed from the day asked for and the events are filtered
 * back to it in the instance's zone. Unreachable, refusing, or not configured:
 * the engine renders "no calendar — the eventkit bridge is not reachable" and
 * the rest of the plan is unaffected (§6.4).
 */
export function eventkitCalendar(ctx: PlanCtx, timeZone: string, now: Date): CalendarProvider | null {
  const url = ctx.ekUrl;
  const token = ctx.ekToken;
  if (!url || !token) return null;
  const fetchFn = ctx.fetchFn ?? fetch;
  const base = url.replace(/\/+$/, "");
  return {
    async events(day: string): Promise<CalendarEvent[]> {
      const ahead = daysBetween(calendarDate(now, timeZone), day);
      if (ahead === null || ahead < 0) return []; // the bridge only looks forward from now
      const res = await fetchFn(`${base}/events?days=${Math.min(ahead + 1, EK_MAX_DAYS)}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(EK_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`eventkit answered ${res.status}`);
      const body = (await res.json()) as { events?: CalendarEvent[] };
      return (body.events ?? []).filter((e) => sameLocalDay(e.start, day, timeZone));
    },
  };
}

function sameLocalDay(iso: string | undefined, day: string, timeZone: string): boolean {
  if (iso === undefined || iso === "") return false;
  const at = new Date(iso);
  return !Number.isNaN(at.getTime()) && calendarDate(at, timeZone) === day;
}

// --- the file ------------------------------------------------------------------

const MATERIALISED_RE = /^- \[[ x-]\] .*\^mt-[0-9a-z]{8}\s*$/im;

/**
 * D4's belt. The engine already refuses to materialise a recurring instance
 * for any render whose `source` is not the user's own hand — so a `- [ ] … ^mt-…`
 * line in THIS file could only mean that rule had changed under us. Refusing
 * to write is the cheap half of never minting an identity into a file a later
 * walk would index as a task.
 */
export const refuseMaterialised = (markdown: string): boolean => MATERIALISED_RE.test(markdown);

// --- tonight's fold (§2.5, T3-7) -------------------------------------------------

/** The section heading the fold is listed under — the routine's, not the template's, so an edited `Templates/Plan.md` cannot lose it. */
export const FOLD_HEADING = "## Tonight's fold";
const FOLD_MAX_DECISIONS = 20; // limit: fixed — a fold's `decisions:` is a handful of lines; past this the file itself is the place to read them
const FOLD_MAX_CHARS = 240; // limit: fixed — one decision is one line; a longer one is clipped with an ellipsis, and the link has the rest

/**
 * One decision as one inert list line. Model-free and verbatim, except for
 * what would change what the LINE is: newlines collapse (one decision, one
 * line), and a leading `[` is escaped so `[ ] ship it` can never become a
 * `- [ ]` task in a machine file (D4 — the `refuseMaterialised` belt still
 * runs after this). A decision that is not a scalar (a mapping, a list) is
 * not guessed at: it is counted, and the section says how many it skipped.
 */
function decisionLine(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return null;
  const text = String(value).replace(/\s+/g, " ").trim();
  if (text === "") return null;
  const clipped = text.length > FOLD_MAX_CHARS ? `${text.slice(0, FOLD_MAX_CHARS - 1)}…` : text;
  return `- ${clipped.replace(/^\[/, "\\[")}`;
}

export interface FoldSection {
  /** `Journal/Fold/<date>.md`, whether or not it exists. */
  path: string;
  /** Did the file exist to link? */
  linked: boolean;
  /** How many decisions the section lists. */
  decisions: number;
  markdown: string;
}

/**
 * The fold's section for the evening `date`: a link to `Journal/Fold/<date>.md`
 * and its `decisions:` frontmatter as a list. `early` is Close the Day's
 * render, which usually comes before the 21:00 fold — the section says the
 * 23:00 run will add it, rather than that there was none. Never throws on
 * what the file SAYS; a bridge that refuses to read it propagates like every
 * other read (`readText`).
 */
export async function foldSection(vault: PlanVault, date: string, early: boolean): Promise<FoldSection> {
  const path = foldPath(date);
  const text = await readText(vault, path);
  if (text === null) {
    const markdown = early
      ? `${FOLD_HEADING}\n\n_Tonight's fold has not run yet — the 11:00 PM plan replaces this one and links \`${path}\`._\n`
      : `${FOLD_HEADING}\n\n_No fold for ${date} — \`${path}\` does not exist._\n`;
    return { path, linked: false, decisions: 0, markdown };
  }
  const raw = frontmatterOf(text)?.["decisions"];
  const list = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  const lines: string[] = [];
  let unreadable = 0;
  for (const item of list) {
    const line = decisionLine(item);
    if (line === null) unreadable += 1;
    else lines.push(line);
  }
  const shown = lines.slice(0, FOLD_MAX_DECISIONS);
  const notes: string[] = [];
  if (lines.length > shown.length) notes.push(`_…and ${lines.length - shown.length} more in the fold._`);
  if (unreadable > 0) notes.push(`_${unreadable} \`decisions:\` ${unreadable === 1 ? "entry is" : "entries are"} not a line of text — read them in the fold._`);
  const body = shown.length === 0 && unreadable === 0 ? ["_No decisions in its `decisions:` frontmatter._"] : ["Decided:", "", ...shown, ...(notes.length > 0 ? ["", ...notes] : [])];
  return { path, linked: true, decisions: shown.length, markdown: `${FOLD_HEADING}\n\n${vaultLink(path)}\n\n${body.join("\n")}\n` };
}

/**
 * The fold's section, spliced in after the template's body and BEFORE the
 * provenance footer — so the file still ends in the line that names its
 * template (`<!-- rendered by … -->`), which is what `metistry templates
 * check` and the ownership reader expect of a rendered file.
 */
export function withFoldSection(markdown: string, section: string): string {
  const footer = markdown.lastIndexOf("\n<!-- rendered by ");
  if (footer === -1) return `${markdown.replace(/\n*$/, "\n")}\n${section}`;
  const head = markdown.slice(0, footer).replace(/\n*$/, "\n");
  return `${head}\n${section}${markdown.slice(footer)}`;
}

// --- bookkeeping ---------------------------------------------------------------

/**
 * One `runs` row per pass that decides a target date — because it wrote the
 * file or because it decided not to. A row that is NOT Close the Day's
 * (`meta.trigger` is `schedule` or `manual`, or absent on a row from before
 * T3-7) SETTLES the date: a later scheduled or manual pass for it (Run Now,
 * or a late run and its slot) finds it and stays silent. A close row never
 * settles anything — it is the early render the 23:00 run supersedes, and a
 * close that decided NOT to plan (the template was missing at 17:00) must
 * not stop the 23:00 run once it is fixed. A close itself never asks: it
 * always renders. `meta.planned_for` is the discriminator: the runner writes
 * its own `routine_run` row for every run and that one deliberately carries
 * none.
 */
async function settled(db: Db, target: string): Promise<string | null> {
  const { rows } = await db.query(
    `SELECT meta FROM runs
     WHERE component = $1 AND kind = 'routine_run' AND ok AND meta->>'planned_for' = $2
       AND meta->>'trigger' IS DISTINCT FROM 'close'
     ORDER BY ts DESC LIMIT 1`,
    [COMPONENT, target],
  );
  const meta = rows[0]?.meta;
  return typeof meta?.outcome === "string" ? meta.outcome : rows.length > 0 ? "unknown" : null;
}

/**
 * `reason` is `"wrote"` or one of `PLAN_SKIPS` — this routine's own detailed
 * vocabulary, kept verbatim so `no_working_days`, `user_owned` and the rest
 * still name exactly what happened. `meta.outcome` (T1-4) is the vocabulary
 * every routine and the runner share (`acted | silent | skipped:<reason>`),
 * so the activity feed (T1-3) can read one field across every component:
 * `"wrote"` becomes `acted`, every skip becomes `skipped:<reason>` — never
 * `silent`, because a settled date is never nothing (§6.4: even doing
 * nothing is a fact recorded).
 */
async function record(db: Db, target: string, trigger: PlanTrigger, reason: "wrote" | PlanSkip, meta: Record<string, unknown> = {}): Promise<void> {
  const outcome = reason === "wrote" ? "acted" : `skipped:${reason}`;
  await db.query(
    `INSERT INTO runs (component, kind, ok, started_at, finished_at, meta)
     VALUES ($1, 'routine_run', true, now(), now(), $2)`,
    [COMPONENT, JSON.stringify({ planned_for: target, outcome, trigger, ...meta })],
  );
}

/** §6.4's one `report` request for a template that is not readable text or is over the cap — the file is named, because a silent non-render is the failure the user cannot see. */
async function reportUnreadable(db: Db, target: string, maxBytes: number): Promise<void> {
  await db.query(`INSERT INTO proposals (kind, source_agent, trust, payload) VALUES ('report', $1, 'internal', $2)`, [
    COMPONENT,
    JSON.stringify({
      title: `${TEMPLATE_PATH} could not be read — no plan for ${target}`,
      summary: `The template is not readable text, or is larger than METISTRY_TEMPLATE_MAX_BYTES (${maxBytes} bytes). Nothing was written. Open it in Obsidian, or run \`metistry templates check\`.`,
      refs: [TEMPLATE_PATH],
    }),
  ]);
}

// --- the pass ------------------------------------------------------------------

/** One pass. Returns 1 when tomorrow's plan was written, 0 otherwise — every 0 is a fact recorded or the guard doing its job. */
export async function run(db: Db, ctx: PlanCtx = {}): Promise<number> {
  const env = ctx.env ?? process.env;
  const now = ctx.now ?? new Date();
  const trigger = triggerOf(ctx);
  if (ctx.closedDay !== undefined && !isCalendarDate(ctx.closedDay)) {
    // the door validates `{day}` before it gets here; a caller that did not
    // is a bug, and a bug is louder than a plan for the wrong day
    throw new Error(`${COMPONENT}: closedDay must be a YYYY-MM-DD date, got ${JSON.stringify(ctx.closedDay)}`);
  }

  const vault = ctx.vault;
  if (!vault) {
    // Not a row: with no bridge there is no vault, and the runner's preflight
    // has already named METISTRY_RECONCILER_URL / METISTRY_BRIDGE_TOKEN_RECONCILER
    // on this window (manifest `requires.env`).
    console.log(`${COMPONENT}: no vault bridge — nothing to read ${TEMPLATE_PATH} from and nowhere to write ${PLAN_DIR}/`);
    return 0;
  }
  const profileText = await readText(vault, PROFILE_PATH);

  // The evening this plan is FOR: the day Close the Day closed; else the
  // slot, when the runner fired it (late, if the Mac slept); else now — in
  // the slot's zone (the schedule's tz, then Me/profile.md's timezone, then
  // METISTRY_TZ), so "tomorrow" is the same day the schedule meant.
  const timeZone = runZone(ctx, profileText, env);
  const evening = ctx.closedDay !== undefined ? instantOn(ctx.closedDay, timeZone, now) : (ctx.scheduledFor ?? now);
  const today = calendarDate(evening, timeZone);
  const target = addTaskDays(today, 1);
  if (target === null) return 0; // unreachable: `today` is a checked date

  if (trigger !== "close") {
    const already = await settled(db, target);
    if (already !== null) {
      console.log(`${COMPONENT}: ${target} is already settled (${already})`);
      return 0;
    }
  }

  const profile = parseProfile(profileText);
  const verdict = gate({ target, profile });
  if (!verdict.ok) {
    console.log(`${COMPONENT}: ${verdict.why}`);
    await record(db, target, trigger, verdict.reason, { why: verdict.why });
    return 0;
  }

  const maxBytes = intEnv("METISTRY_TEMPLATE_MAX_BYTES", DEFAULT_TEMPLATE_MAX_BYTES, env);
  const templateText = await readText(vault, TEMPLATE_PATH);
  const skip = templateSkip(templateText, maxBytes);
  if (skip !== null || templateText === null) {
    const reason = skip ?? TEMPLATE_MISSING;
    console.log(`${COMPONENT}: ${TEMPLATE_PATH} — ${reason}; nothing written for ${target}`);
    if (reason === TEMPLATE_UNREADABLE) await reportUnreadable(db, target, maxBytes);
    await record(db, target, trigger, reason, { template: TEMPLATE_PATH, max_bytes: maxBytes });
    return 0;
  }

  // Ownership before rendering: a plan file that is not ours costs one read
  // and no work at all (§5.1). `existing.sha256` is also the compare-and-swap
  // value the rewrite carries, so re-running an evening — or the 23:00 run
  // superseding Close the Day's early render — replaces the same file rather
  // than racing it.
  const path = `${PLAN_DIR}/${target}.md`;
  const existing = await vault.read(path);
  const owner = existing === null ? null : sourceOf(existing.content.toString("utf8"));
  if (existing !== null && owner !== PRINCIPAL) {
    const why = `${path} says \`source: ${owner ?? "(none — yours)"}\`, not \`${PRINCIPAL}\` — one writer per file, and this one is not mine`;
    console.log(`${COMPONENT}: ${why}`);
    await record(db, target, trigger, "user_owned", { path, source: owner, why });
    return 0;
  }

  const render = await renderTemplate(templateText, {
    templatePath: TEMPLATE_PATH,
    source: PRINCIPAL,
    queries: ctx.queries ?? NO_QUERIES,
    // undefined = build one from the environment; null = the caller says there
    // is none (and the plan renders §6.4's line instead of a schedule).
    calendar: ctx.calendar === undefined ? eventkitCalendar(ctx, timeZone, now) : ctx.calendar,
    reader: vaultReader(vault),
    ...(ctx.me !== undefined ? { me: ctx.me } : {}),
    // the template's "tomorrow" is the evening's: a late run, or a close of an
    // earlier day, still plans `target`
    now: evening,
    timeZone,
    env,
    renderedAt: now,
    maxBytes,
  });
  if (render.skipped !== undefined) {
    // Unreachable — `templateSkip` above asked the same question of the same
    // bytes — and recorded rather than thrown, because a plan that cannot
    // render is a configuration fact either way (§6.4).
    await record(db, target, trigger, render.skipped, { template: TEMPLATE_PATH });
    return 0;
  }

  // Tonight's fold, spliced in after the template's body — BEFORE the
  // materialise belt, so nothing the fold's header says can mint a task line.
  const fold = await foldSection(vault, today, trigger === "close");
  const markdown = withFoldSection(render.markdown, fold.markdown);
  if (refuseMaterialised(markdown)) {
    const why = `the render produced a task line with a minted \`^mt-\` anchor, which no routine may write (D4) — refusing to write ${path}`;
    console.warn(`${COMPONENT}: ${why}`);
    await record(db, target, trigger, "would_materialise", { path, why });
    return 0;
  }

  const written = await vault.write(
    path,
    Buffer.from(markdown, "utf8"),
    { principal: PRINCIPAL, message: trigger === "close" ? `plan for ${target} (at Close the Day)` : `plan for ${target}` },
    existing?.sha256 ?? "", // "" = must not exist; otherwise compare-and-swap on what we just read
  );
  await record(db, target, trigger, "wrote", {
    path,
    bytes: written.bytes,
    created: written.created,
    template: TEMPLATE_PATH,
    template_warnings: render.warnings.length,
    ...(render.warnings.length > 0 ? { warnings: render.warnings.map((w) => `${TEMPLATE_PATH}:${w.line} ${w.message}`) } : {}),
    truncated: render.truncated,
    fold: fold.path,
    fold_linked: fold.linked,
    fold_decisions: fold.decisions,
  });
  console.log(`${COMPONENT}: wrote ${path} (${written.bytes} bytes${render.warnings.length > 0 ? `, ${render.warnings.length} template warning(s)` : ""}${render.truncated ? ", truncated" : ""}${trigger === "close" ? ", early — the 23:00 run supersedes it" : ""})`);
  return 1;
}
