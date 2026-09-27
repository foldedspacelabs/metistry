// Schedules — the ONE implementation. Two shapes live here, and which one a
// file may hold is the point:
//
//   * THE CLOSED SHAPE (design-build-plan §2.5, frozen by F-4) —
//     `{days, at, tz?}` or `{every: 5m|15m|1h|6h}`. It is the only thing
//     `.metistry/scheduled.yaml` may hold (scheduled.ts), and what product
//     manifests move to (T3-2). Closed means closed: an interval outside the
//     four, a cron string, `8:00`, a UTC offset are each refused at parse,
//     and widening the set is a product change, never a config line.
//   * THE LEGACY CRON SUBSET below — what a product manifest may keep
//     carrying for ONE release (§2.5). `scheduleToSeconds` reads it as an
//     interval; nothing new is written in it.
//
// The next-occurrence function's signature was frozen by F-4
// (`NextOccurrence`); its body, `nextOccurrence`, and the runner's question
// `dueOccurrence` are at the end of this file (T3-1), hand-rolled over
// `Intl` (no dependency, U5).

import { z } from "zod";

// ---- the legacy cron subset (one release) ------------------------------------
//
// The console's runner uses it to decide when a collector is due; the
// watchdog uses it to decide when a collector has been silent too long.
// Deliberately narrow: */N minutes, 0 */N hours, @hourly, @daily, @weekly,
// @monthly. Every shipped manifest must parse (console manifests.test.ts
// gates it: the console crash-looped once on an unparsed schedule).
//
// This is an INTERVAL scheduler, not a calendar one: @weekly is exactly
// 7 * 86400 seconds since the component last ran, not "every Monday". @monthly
// follows the same rule rather than inventing calendar semantics (a real
// "first of the month" would need the last-run timestamp, not just an
// interval) — 30 days, the same approximation every other named interval
// here already makes.

export function scheduleToSeconds(schedule: string): number {
  if (schedule === "@hourly") return 3600;
  if (schedule === "@daily") return 86400;
  if (schedule === "@weekly") return 604800;
  if (schedule === "@monthly") return 2592000; // 30 days — see module doc
  const m = /^\*\/(\d+) \* \* \* \*$/.exec(schedule);
  if (m?.[1]) return Number(m[1]) * 60;
  const h = /^0 \*\/(\d+) \* \* \*$/.exec(schedule); // every N hours
  if (h?.[1]) return Number(h[1]) * 3600;
  throw new Error(`runner cannot schedule "${schedule}" yet — supported: */N minutes, 0 */N hours, @hourly, @daily, @weekly, @monthly`);
}

/** The cron shape a product manifest may still carry for one release — the same pattern `manifest.ts` validates today. */
export const LEGACY_CRON_RE = /^(@(hourly|daily|weekly|monthly)|(\S+\s+){4}\S+)$/;

// ---- the closed shape (§2.5) -------------------------------------------------

/** Weekday tokens, indexed like `Date#getUTCDay()` (0 = Sunday) — the order `routines/plan-tomorrow` already uses. */
export const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/**
 * The two named day sets. Both FOLLOW `Me/profile.md`'s `working_days` rather
 * than copy it: edit the profile and every schedule naming a set moves with
 * it, until the owner sets explicit days on that routine (§2.5). Resolved by
 * `resolveDays` below — the one definition of each.
 */
export const DAY_SETS = ["working_days", "eve_of_working_days"] as const;
export type DaySet = (typeof DAY_SETS)[number];

/** The closed interval set. A new interval is a product change; `30m`, `1d` and every cron string are refused. */
export const EVERY = ["5m", "15m", "1h", "6h"] as const;
export type Every = (typeof EVERY)[number];

/** Each interval in seconds — what an `{every}` schedule adds to its last run. */
export const EVERY_SECONDS: Readonly<Record<Every, number>> = Object.freeze({ "5m": 300, "15m": 900, "1h": 3600, "6h": 21600 });

/** `HH:MM`, 24-hour, two digits each: `08:00`, `23:00` — never `8:00` or `8am`. */
export const AT_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export const MAX_AT_TIMES = 48; // limit: fixed — every half hour of a day; anything denser is an `every`

/**
 * An IANA zone name — `America/New_York`, `Etc/UTC`, `UTC` — that this
 * runtime's `Intl` knows. A UTC offset (`+05:00`) is refused although `Intl`
 * accepts one: it has no daylight-saving rules, so `08:00` in it is 08:00 on
 * the owner's clock for only half the year.
 */
export function validTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !/^[A-Z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const WEEKDAY_LIST = WEEKDAYS.join(", ");
const EVERY_LIST = EVERY.join(", ");

/** The one sentence every refusal of a whole schedule says, so a door and a file teach the same shape. */
export const SCHEDULE_SHAPE_REFUSAL =
  `a schedule is {days, at, tz?} or {every: ${EVERY.join("|")}} — a cron string is accepted only in a product manifest, for one release`;

function noRepeats<T>(what: string) {
  return (list: readonly T[], ctx: z.RefinementCtx): void => {
    const seen = new Set<T>();
    list.forEach((v, i) => {
      if (seen.has(v)) ctx.addIssue({ code: "custom", path: [i], message: `${what} names ${String(v)} twice` });
      seen.add(v);
    });
  };
}

/** `every:` — shared by a schedule and a sync's cadence (scheduled.ts), so the closed set is stated once. */
export const everySchema = z.enum(EVERY, {
  error: (iss) => `every must be one of ${EVERY_LIST} — ${JSON.stringify(iss.input)} is not (the set is closed)`,
});

const daysSchema = z.union(
  [
    z.enum(DAY_SETS),
    z.array(z.enum(WEEKDAYS)).min(1, "days lists at least one weekday").superRefine(noRepeats<Weekday>("days")),
  ],
  { error: () => `days must be working_days, eve_of_working_days, or a list of weekdays (${WEEKDAY_LIST})` },
);

const atSchema = z
  .array(
    z.string({ error: () => `at times are quoted HH:MM strings ("08:00")` }).regex(AT_RE, `at times are HH:MM, 24-hour, two-digit hours ("08:00", "23:00")`),
    { error: () => `at is a list of times — at: ["08:00"]` },
  )
  .min(1, "at lists at least one time")
  .max(MAX_AT_TIMES, `at lists at most ${MAX_AT_TIMES} times — anything denser is an every`)
  .superRefine(noRepeats<string>("at"));

const TZ_REFUSAL = "tz must be an IANA zone name this runtime knows (America/New_York, Etc/UTC) — never a UTC offset";
const tzSchema = z.string({ error: () => TZ_REFUSAL }).refine(validTimeZone, TZ_REFUSAL);

/** `{days, at, tz?}` — a time of day on some days. */
export const timeOfDayScheduleSchema = z.object({ days: daysSchema, at: atSchema, tz: tzSchema.optional() }).strict();
/** `{every}` — an interval since the last run. */
export const intervalScheduleSchema = z.object({ every: everySchema }).strict();

export type Days = DaySet | Weekday[];
export type TimeOfDaySchedule = z.output<typeof timeOfDayScheduleSchema>;
export type IntervalSchedule = z.output<typeof intervalScheduleSchema>;
export type Schedule = TimeOfDaySchedule | IntervalSchedule;
/** What a product manifest's `schedule:` may be: the closed shape, or — for one release — a legacy cron string. */
export type ManifestSchedule = Schedule | string;

// ---- validating one of two shapes, with a refusal that names the field -------
//
// `z.union` over two strict objects answers a wrong `every` with "Invalid
// input" and nothing else. These choose the shape by which keys are present
// and forward THAT shape's issues, path and all — so `every: 10m` is refused
// as `…schedule.every: every must be one of 5m, 15m, 1h, 6h`. No transform
// changes a value: what parses is exactly what was written, which is what
// lets a door write back the object it validated.

/** A plain YAML/JSON map — not null, not a list. */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** An issue's message, with a record's bad key reported by what the key rule says rather than zod's "Invalid key in record". */
export function issueMessage(issue: z.core.$ZodIssue): string {
  if (issue.code === "invalid_key" && issue.issues[0]) return issue.issues[0].message;
  return issue.message;
}

/** Parse `v` with `schema` inside a transform, re-raising its issues under the caller's path. Returns `z.NEVER` on failure. */
export function forward<T>(schema: z.ZodType<T>, v: unknown, ctx: z.RefinementCtx): T {
  const r = schema.safeParse(v);
  if (r.success) return r.data;
  for (const issue of r.error.issues) ctx.addIssue({ code: "custom", message: issueMessage(issue), path: issue.path });
  return z.NEVER;
}

const TIME_OF_DAY_KEYS = ["days", "at", "tz"] as const;

function closedSchedule(v: unknown, ctx: z.RefinementCtx): Schedule {
  if (v === undefined) {
    ctx.addIssue({ code: "custom", message: `required — ${SCHEDULE_SHAPE_REFUSAL}` });
    return z.NEVER;
  }
  if (!isPlainObject(v)) {
    ctx.addIssue({ code: "custom", message: SCHEDULE_SHAPE_REFUSAL });
    return z.NEVER;
  }
  const interval = "every" in v;
  if (interval && TIME_OF_DAY_KEYS.some((k) => k in v)) {
    ctx.addIssue({ code: "custom", message: `${SCHEDULE_SHAPE_REFUSAL} — never both` });
    return z.NEVER;
  }
  return interval ? forward(intervalScheduleSchema, v, ctx) : forward(timeOfDayScheduleSchema, v, ctx);
}

/** THE CLOSED SHAPE — what `scheduled.yaml` holds. A cron string is refused here. */
export const scheduleSchema = z.unknown().transform(closedSchedule);

/** A product manifest's `schedule:` — the closed shape, or a legacy cron string for one release (T3-2 adopts it in `manifest.ts`). */
export const manifestScheduleSchema = z.unknown().transform((v, ctx): ManifestSchedule => {
  if (typeof v !== "string") return closedSchedule(v, ctx);
  if (LEGACY_CRON_RE.test(v)) return v;
  ctx.addIssue({
    code: "custom",
    message: `${JSON.stringify(v)} is not a 5-field cron expression or @hourly/@daily/@weekly/@monthly — and ${SCHEDULE_SHAPE_REFUSAL}`,
  });
  return z.NEVER;
});

export function isInterval(s: Schedule): s is IntervalSchedule {
  return "every" in s;
}

export function isLegacyCron(s: ManifestSchedule): s is string {
  return typeof s === "string";
}

/**
 * The weekdays a `days` value names, ascending from Sunday — the ONE
 * definition of each day set:
 *
 *   * a list → itself;
 *   * `working_days` → the profile's working days;
 *   * `eve_of_working_days` → every day whose NEXT day is a working day
 *     (Mon–Fri working → Sun–Thu: Sunday evening plans Monday; Friday
 *     evening does not plan Saturday).
 *
 * `null` when a set is named and the profile does not say which days are
 * working days (absent, or an empty list): §2.5's absent state — the routine
 * writes nothing and says so, and nothing here guesses Monday to Friday.
 */
export function resolveDays(days: Days, workingDays: readonly Weekday[] | undefined): Weekday[] | null {
  if (typeof days !== "string") return WEEKDAYS.filter((d) => days.includes(d));
  if (!workingDays || workingDays.length === 0) return null;
  if (days === "working_days") return WEEKDAYS.filter((d) => workingDays.includes(d));
  return WEEKDAYS.filter((_, i) => workingDays.includes(WEEKDAYS[(i + 1) % WEEKDAYS.length]!));
}

// ---- the next-occurrence function: its signature (F-4) ------------------------

/**
 * The facts in `Me/profile.md` a schedule may FOLLOW — read, never written
 * (§2.5). An absent key is the profile not saying, and nothing fills it in.
 * Reading the file into this shape is T3-4's.
 */
export interface ProfileFacts {
  readonly timezone?: string;
  readonly working_days?: readonly Weekday[];
}

export interface OccurrenceContext {
  readonly profile: ProfileFacts;
  /**
   * The zone used when neither the schedule's `tz` nor the profile's
   * `timezone` names one: the runner's configured zone — `METISTRY_TZ`
   * (`configuredTimeZone`; not `TZ`, which both deployment shapes default to
   * UTC). `null` = nothing configured, and a time-of-day schedule is refused
   * `no_timezone` rather than answered in UTC.
   */
  readonly fallbackTimeZone: string | null;
}

/** Why there is no next occurrence — each a fact the routine records and says (D7's `skipped:<reason>`), never a guess. */
export const OCCURRENCE_REFUSALS = ["no_working_days", "no_timezone", "unknown_timezone"] as const;
export type OccurrenceRefusal = (typeof OCCURRENCE_REFUSALS)[number];

/** `timeZone` is the zone the wall-clock time was read in — `null` for an `{every}` schedule, which has none. */
export type Occurrence =
  | { readonly ok: true; readonly at: Date; readonly timeZone: string | null }
  | { readonly ok: false; readonly reason: OccurrenceRefusal; readonly why: string };

/**
 * **The next-occurrence function — the signature F-4 froze; `nextOccurrence`
 * below (T3-1) is its body.** The contract it implements to:
 *
 * - **Pure.** No clock, no IO, no `process.env`: `after` and `ctx` are all it
 *   knows, so every DST and timezone case is a plain call in a test.
 * - **`{every}`** → `after + EVERY_SECONDS[every]`, `timeZone: null`. `after`
 *   is the last run; what a never-run component does is the runner's call.
 *   Never refused.
 * - **`{days, at, tz?}`** → the earliest instant STRICTLY after `after` whose
 *   wall-clock time, in the zone, is one of `at`, on a local date whose
 *   weekday is in `resolveDays(days, ctx.profile.working_days)`.
 * - **The zone** is the first of `tz`, `ctx.profile.timezone`,
 *   `ctx.fallbackTimeZone` that is present. An unknown one is refused
 *   `unknown_timezone` — never skipped for the next in line, which would be
 *   a guess; none at all is `no_timezone`.
 * - **A day set with no working days in the profile** is refused
 *   `no_working_days` (§2.5's absent state).
 * - **DST** follows Temporal's `compatible` disambiguation: a wall time the
 *   clocks skip runs shifted forward by the gap (02:30 on a night that jumps
 *   02:00→03:00 runs at 03:30); a wall time that happens twice runs at the
 *   earlier. Each (local date, `at`) pair yields at most one occurrence.
 */
export type NextOccurrence = (schedule: Schedule, after: Date, ctx: OccurrenceContext) => Occurrence;

// ---- the next-occurrence function (T3-1) --------------------------------------
//
// Hand-rolled over `Intl` (U5: no date library). Three small pieces:
//
//   * `offsetAt` — a zone's UTC offset at one instant, read off
//     `Intl.DateTimeFormat#formatToParts` (the wall clock there, as if it
//     were UTC, minus the instant);
//   * `wallToInstant` — a wall-clock time in a zone to the instant it names,
//     with Temporal's `compatible` disambiguation (the algorithm of
//     `DisambiguatePossibleEpochNanoseconds`, over milliseconds);
//   * `occurrencesIn` — every (local date, `at`) instant in a span, which the
//     two exported functions take the first or the last of.
//
// Dates are civil arithmetic on "wall clock as UTC" milliseconds: a local
// date's weekday is its UTC weekday, because 2026-09-22 is a Tuesday
// everywhere. Only the step from a wall time to an instant consults a zone.

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
/** limit: fixed — any time-of-day schedule recurs at least weekly, so 8 local days always hold the next slot after any instant (one spare for a zone whose offset moves the date). */
const SCAN_DAYS = 8;

/**
 * One formatter per zone: constructing an `Intl.DateTimeFormat` is the
 * expensive half. Bounded by the zones this runtime knows (`validTimeZone`
 * gates every name that reaches it), so the map cannot grow without limit.
 */
const WALL_CLOCKS = new Map<string, Intl.DateTimeFormat>();

function wallClock(timeZone: string): Intl.DateTimeFormat {
  let f = WALL_CLOCKS.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    WALL_CLOCKS.set(timeZone, f);
  }
  return f;
}

/** The wall clock in `timeZone` at `instant`, as if it were UTC, in milliseconds (seconds precision — a zone's offset never has finer). */
function wallAt(instant: number, timeZone: string): number {
  const parts = wallClock(timeZone).formatToParts(new Date(instant));
  const get = (t: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === t)?.value ?? "0");
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
}

/** `timeZone`'s offset from UTC at `instant`, in milliseconds (New York in winter: −5 h). */
function offsetAt(instant: number, timeZone: string): number {
  const whole = instant - (((instant % 1000) + 1000) % 1000);
  return wallAt(whole, timeZone) - whole;
}

/** Every instant whose wall clock in `timeZone` is `wall` — none (a gap), one, or two (an overlap), ascending. */
function possibleInstants(wall: number, timeZone: string): number[] {
  const offsets = new Set([offsetAt(wall - DAY_MS, timeZone), offsetAt(wall + DAY_MS, timeZone)]);
  return [...offsets]
    .map((o) => wall - o)
    .filter((i) => offsetAt(i, timeZone) === wall - i)
    .sort((a, b) => a - b);
}

/**
 * A wall-clock time in a zone → the instant it names, Temporal's
 * `compatible` way: a time that happens twice is the EARLIER; a time the
 * clocks skip is shifted forward by the gap (02:30 on a 02:00→03:00 night is
 * 03:30; 02:15 on Lord Howe's 02:00→02:30 night is 02:45).
 */
function wallToInstant(wall: number, timeZone: string): number {
  const possible = possibleInstants(wall, timeZone);
  if (possible.length > 0) return possible[0]!;
  const before = offsetAt(wall - DAY_MS, timeZone);
  const after = offsetAt(wall + DAY_MS, timeZone);
  const shifted = wall + (after - before);
  const later = possibleInstants(shifted, timeZone);
  return later.length > 0 ? later[later.length - 1]! : shifted - after;
}

/** Midnight of the local date `instant` falls on in `timeZone`, as wall-clock-as-UTC milliseconds. */
function localMidnight(instant: number, timeZone: string): number {
  const wall = wallAt(instant, timeZone);
  return wall - (((wall % DAY_MS) + DAY_MS) % DAY_MS);
}

const atMinutes = (at: string): number => Number(at.slice(0, 2)) * 60 + Number(at.slice(3, 5));

/**
 * Every occurrence in (`from`, `until`], ascending — one per (local date,
 * `at`) pair whose weekday is in `days`. Two pairs can name one instant only
 * where a zone skipped a whole date (Samoa, 2011-12-30); that instant is
 * listed once.
 */
function occurrencesIn(at: readonly string[], days: readonly Weekday[], timeZone: string, from: number, until: number): number[] {
  const out = new Set<number>();
  const minutes = at.map(atMinutes);
  const last = localMidnight(until, timeZone) + DAY_MS;
  for (let day = localMidnight(from, timeZone) - DAY_MS; day <= last; day += DAY_MS) {
    if (!days.includes(WEEKDAYS[new Date(day).getUTCDay()]!)) continue;
    for (const m of minutes) {
      const instant = wallToInstant(day + m * MINUTE_MS, timeZone);
      if (instant > from && instant <= until) out.add(instant);
    }
  }
  return [...out].sort((a, b) => a - b);
}

const present = (z: string | null | undefined): z is string => typeof z === "string" && z.trim() !== "";

type Resolved =
  | { readonly ok: true; readonly timeZone: string; readonly days: Weekday[] }
  | { readonly ok: false; readonly reason: OccurrenceRefusal; readonly why: string };

/** The zone and the weekdays a time-of-day schedule runs in — or the refusal that says which fact is missing. */
function resolveTimeOfDay(schedule: TimeOfDaySchedule, ctx: OccurrenceContext): Resolved {
  const [timeZone, from] = present(schedule.tz)
    ? [schedule.tz, "the schedule's tz"]
    : present(ctx.profile.timezone)
      ? [ctx.profile.timezone, "Me/profile.md's timezone"]
      : present(ctx.fallbackTimeZone)
        ? [ctx.fallbackTimeZone, "the runner's zone (METISTRY_TZ)"]
        : [null, null];
  if (timeZone === null) {
    return {
      ok: false,
      reason: "no_timezone",
      why: "no timezone: the schedule has no tz, Me/profile.md has no timezone, and METISTRY_TZ is unset — a time of day is never read in UTC by default",
    };
  }
  if (!validTimeZone(timeZone)) {
    return {
      ok: false,
      reason: "unknown_timezone",
      why: `${from} is ${JSON.stringify(timeZone)}, which is not an IANA zone this runtime knows (America/New_York, Etc/UTC) — nothing falls back to another zone`,
    };
  }
  const days = resolveDays(schedule.days, ctx.profile.working_days);
  if (days === null || days.length === 0) {
    return {
      ok: false,
      reason: "no_working_days",
      why: `the schedule runs on ${schedule.days}, and Me/profile.md does not say which days you work (working_days: [mon, tue, wed, thu, fri]) — nothing guesses them`,
    };
  }
  return { ok: true, timeZone, days };
}

/** The next occurrence strictly after `after` — the contract is `NextOccurrence`'s, above. Pure: no clock, no IO, no environment. */
export const nextOccurrence: NextOccurrence = (schedule, after, ctx) => {
  if (isInterval(schedule)) return { ok: true, at: new Date(after.getTime() + EVERY_SECONDS[schedule.every] * 1000), timeZone: null };
  const r = resolveTimeOfDay(schedule, ctx);
  if (!r.ok) return r;
  const from = after.getTime();
  const [first] = occurrencesIn(schedule.at, r.days, r.timeZone, from, from + SCAN_DAYS * DAY_MS);
  // Unreachable: `days` is non-empty, so every week holds a slot. Said as a
  // refusal rather than thrown — a pure function the runner calls every tick
  // does not get to take the runner down.
  if (first === undefined) return { ok: false, reason: "no_working_days", why: `no ${schedule.days} slot in the ${SCAN_DAYS} days after ${after.toISOString()}` };
  return { ok: true, at: new Date(first), timeZone: r.timeZone };
};

/**
 * The occurrence a runner OWES at `now`, having last run at `after` — or
 * `null` when it owes none. Pure, like `nextOccurrence`.
 *
 * - **`{every}`** → `after + every`, when that is not later than `now`.
 * - **`{days, at, tz?}`** → the LATEST occurrence in (`after`, `now`]. Slots
 *   missed while the Mac slept are coalesced into ONE run, for the most
 *   recent of them — launchd's own rule for `StartCalendarInterval`. A plan
 *   written on waking is then for the day ahead, not for a day already gone.
 * - Refusals are `nextOccurrence`'s, for the same reasons.
 */
export function dueOccurrence(schedule: Schedule, after: Date, now: Date, ctx: OccurrenceContext): Occurrence | null {
  if (isInterval(schedule)) {
    const at = after.getTime() + EVERY_SECONDS[schedule.every] * 1000;
    return at <= now.getTime() ? { ok: true, at: new Date(at), timeZone: null } : null;
  }
  const r = resolveTimeOfDay(schedule, ctx);
  if (!r.ok) return r;
  if (after.getTime() >= now.getTime()) return null;
  // Any schedule recurs within a week, so the last eight days hold the latest
  // slot however long the Mac slept.
  const from = Math.max(after.getTime(), now.getTime() - SCAN_DAYS * DAY_MS);
  const owed = occurrencesIn(schedule.at, r.days, r.timeZone, from, now.getTime());
  const latest = owed[owed.length - 1];
  return latest === undefined ? null : { ok: true, at: new Date(latest), timeZone: r.timeZone };
}

/**
 * The zone the runner reads a time of day in when neither the schedule nor
 * `Me/profile.md` names one: `METISTRY_TZ`, and nothing else. Not `TZ` —
 * both deployment shapes set `TZ` to `UTC` whenever `METISTRY_TZ` is unset
 * (`consoleEnv` in packages/cli/src/deployment.ts, docker-compose.yml), so
 * reading it would be the UTC fallback §2.5 refuses, under another name.
 */
export function configuredTimeZone(env: NodeJS.ProcessEnv): string | null {
  return present(env.METISTRY_TZ) ? env.METISTRY_TZ : null;
}

// ---- saying a schedule, and bounding it -------------------------------------

const ALL_WEEK: readonly Weekday[] = WEEKDAYS;
const DAY_SET_WORDS: Readonly<Record<DaySet, string>> = Object.freeze({
  working_days: "working days",
  eve_of_working_days: "the eve of working days",
});

/** One line for a person — `working days at 07:00`, `every day at 21:00`, `every 5m`, or a legacy cron string as written. */
export function describeSchedule(schedule: ManifestSchedule): string {
  if (isLegacyCron(schedule)) return schedule;
  if (isInterval(schedule)) return `every ${schedule.every}`;
  const days =
    typeof schedule.days === "string"
      ? DAY_SET_WORDS[schedule.days]
      : schedule.days.length === ALL_WEEK.length
        ? "every day"
        : WEEKDAYS.filter((d) => (schedule.days as Weekday[]).includes(d)).join(", ");
  return `${days} at ${schedule.at.join(", ")}${schedule.tz ? ` (${schedule.tz})` : ""}`;
}

/**
 * The longest a schedule can go between two runs, in seconds — the bound a
 * probe measures "silent too long" against (the watchdog, `metistry
 * doctor`). A legacy cron string is its interval; `{every}` is itself. A
 * time of day is the widest gap between two slots of its week, plus an hour
 * for the night the clocks go back; a day set follows a profile this bound
 * has not read, so it is bounded by the week (one working day a week is a
 * profile, too).
 */
export function longestGapSeconds(schedule: ManifestSchedule): number {
  if (isLegacyCron(schedule)) return scheduleToSeconds(schedule);
  if (isInterval(schedule)) return EVERY_SECONDS[schedule.every];
  const WEEK_MINUTES = 7 * 1440;
  if (typeof schedule.days === "string") return WEEK_MINUTES * 60 + 3600;
  const slots = schedule.days
    .flatMap((d) => schedule.at.map((at) => WEEKDAYS.indexOf(d) * 1440 + atMinutes(at)))
    .sort((a, b) => a - b);
  let widest = slots[0]! + WEEK_MINUTES - slots[slots.length - 1]!;
  for (let i = 1; i < slots.length; i++) widest = Math.max(widest, slots[i]! - slots[i - 1]!);
  return widest * 60 + 3600;
}
