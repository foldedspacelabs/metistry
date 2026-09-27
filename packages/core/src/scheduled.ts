// `.metistry/scheduled.yaml` — the owner's changes to everything recurring
// (design-build-plan §2.5; F-4 freezes this schema). Every scheduled thing is
// a ROUTINE or a SYNC, and its timing and configuration resolve per field
// from three layers, each field showing where its value came from:
//
//   1. the MANIFEST — a product routine or collector, or an extension: the
//      default schedule, the config schema, what it reads and writes;
//   2. `Me/profile.md` — facts about the owner a schedule may FOLLOW
//      (`working_days`, `timezone`); read, never written by Metistry
//      (`profileFacts`, below — T3-4);
//   3. THIS FILE — the owner's changes, written only through the Scheduled
//      doors (T3-3). Reset to Default deletes an entry.
//
// Schema and types only. Loading it and merging the layers is T3-2's, the
// runner that reads it every tick is T3-1's, the doors that write it are
// T3-3's (docs/ops/scheduled.md, "What is not wired yet").
//
// Two properties the doors lean on:
//
//   * NOTHING IS REWRITTEN. No defaults, no transforms that change a value:
//     what parses is exactly what was written, so a door can write back the
//     object it validated and a round trip is the identity.
//   * AN INVALID FILE IS NEVER APPLIED — not half, and not as empty either.
//     compute.yaml can fall back to "no engine"; this file cannot fall back
//     to "no overlay", because the defaults are not a safe state: a routine
//     the owner paused would run again. `value` is null on failure, so no
//     caller can apply it by accident.

import { z } from "zod";
import { isScalar, isSeq, parse as parseYaml, parseDocument, Scalar, type YAMLMap } from "yaml";
import { validAgentAreaGrant } from "./instance-layout.js";
import { AGENT_NAME_RE } from "./instances.js";
import {
  AT_RE,
  WEEKDAYS,
  everySchema,
  forward,
  isPlainObject,
  issueMessage,
  resolveDays,
  scheduleSchema,
  timeOfDayScheduleSchema,
  type ProfileFacts,
  type TimeOfDaySchedule,
  type Weekday,
} from "./schedule.js";

/** Under `.metistry/` — a protected path the console writes (T3-2 adds it to `CALLER_AUTHORITY.console`). */
export const SCHEDULED_FILENAME = "scheduled.yaml";

// ---- where a field's value came from ------------------------------------------

/**
 * The three origins a resolved field can have, one per layer — the words the
 * UI shows beside each field (§2.5), so a client renders the label and never
 * works the layer out for itself.
 */
export const FIELD_ORIGINS = ["default", "profile", "yours"] as const;
export type FieldOrigin = (typeof FIELD_ORIGINS)[number];

export const FIELD_ORIGIN_LABELS: Readonly<Record<FieldOrigin, string>> = Object.freeze({
  default: "default", // the manifest said so
  profile: "from your profile", // Me/profile.md said so — e.g. the days behind `working_days`
  yours: "yours", // scheduled.yaml said so
});

/** A resolved value and the layer it came from. The resolver that produces these is T3-2's (and T3-4's, for the profile). */
export interface Sourced<T> {
  readonly value: T;
  readonly origin: FieldOrigin;
}

// ---- names and keys -------------------------------------------------------------

/** A routine or sync name: `manifest.ts`'s `name` rule, because an override is keyed by the manifest it overrides. */
export const SCHEDULED_NAME_RE = /^[a-z][a-z0-9-]*$/;
/** A config key or a raise-rule key: snake_case, as the manifests declare them (`skip_without_calendar_event`, `review_requested`). */
export const SCHEDULED_KEY_RE = /^[a-z][a-z0-9_]*$/;
/**
 * A connection name — the name of `.metistry/connections/<name>.yaml` (§2.6).
 * F-3 owns that rule and is written in parallel, so this is deliberately NOT
 * exported: when F-3's export lands, this line becomes an import of it.
 */
const CONNECTION_NAME_RE = /^[a-z][a-z0-9-]*$/;

export const MAX_TASK_CHARS = 4000; // limit: fixed — a task is appended to the actor's definition on every run; a longer one is a new actor, not a task

const NAME_REFUSAL = "a routine or sync name is lowercase kebab-case (the manifest's name)";
const nameKey = z.string().regex(SCHEDULED_NAME_RE, NAME_REFUSAL);
const snakeKey = z.string().regex(SCHEDULED_KEY_RE, "a key is lowercase snake_case, as the manifest declares it");

// ---- routines --------------------------------------------------------------------

const configScalar = z.union([z.string(), z.number(), z.boolean()]);
/**
 * A config value: a string, a number, true/false, or a list of those. Which
 * keys a routine takes, and of what kind, is its manifest's `config` schema —
 * checked against the manifest when the overlay loads (T3-2), not here.
 */
const configValue = z.union([configScalar, z.array(configScalar)], {
  error: () => "a config value is a string, a number, true/false, or a list of those",
});

/** `Areas/Finance` or `Journal/Digest/` — a trailing slash names the same prefix (`underAreas` reads them alike). */
function grantable(prefix: string): boolean {
  return validAgentAreaGrant(prefix.endsWith("/") ? prefix.slice(0, -1) : prefix);
}

const grantPath = z
  .string()
  .refine(grantable, "a grant is a TitleCase vault prefix an agent may hold (e.g. Areas/Finance) — never .metistry/, Artifacts/ or a traversal");

/** Per-run grants: given to the actor for that run only (T3-8), on top of its own. */
const grantsSchema = z.object({ read: z.array(grantPath).optional(), write: z.array(grantPath).optional() }).strict();

/** A change to a routine that has a manifest — product, or extension. Every field is optional: each overrides one field and leaves the rest to the layers below. */
export const routineOverrideSchema = z
  .object({
    schedule: scheduleSchema.optional(),
    paused: z.boolean().optional(),
    config: z.record(snakeKey, configValue).optional(),
  })
  .strict();

/**
 * A New Routine — an ASSIGNMENT, no product code (ruling 4): an actor, a task
 * appended to the actor's definition (never replacing it), per-run grants and
 * a schedule. It has no manifest, so it has no default to fall back on — the
 * schedule is required — and no config schema, so it has no `config`.
 */
export const routineAssignmentSchema = z
  .object({
    actor: z.string().regex(AGENT_NAME_RE, "actor is an agent id — lowercase kebab-case, at most 40 characters"),
    task: z
      .string()
      .max(MAX_TASK_CHARS, `a task is at most ${MAX_TASK_CHARS} characters — more than that belongs in the actor's definition`)
      .refine((t) => t.trim().length > 0, "a task says what to do — it cannot be empty"),
    grants: grantsSchema.optional(),
    schedule: scheduleSchema,
    paused: z.boolean().optional(),
  })
  .strict();

export type RoutineOverride = z.output<typeof routineOverrideSchema>;
export type RoutineAssignment = z.output<typeof routineAssignmentSchema>;
export type RoutineEntry = RoutineOverride | RoutineAssignment;
export type ConfigValue = z.output<typeof configValue>;
export type Grants = z.output<typeof grantsSchema>;

/** The keys that make an entry an assignment rather than an override. */
const ASSIGNMENT_KEYS = ["actor", "task", "grants"] as const;

/** One routine entry: an assignment when it names an actor, task or grants; otherwise an override. The refusal names the field either way. */
export const routineEntrySchema = z.unknown().transform((v, ctx): RoutineEntry => {
  if (!isPlainObject(v)) {
    ctx.addIssue({
      code: "custom",
      message: "a routine entry is a map — {schedule, paused, config} to change a routine, or {actor, task, grants, schedule} for a New Routine",
    });
    return z.NEVER;
  }
  if (!ASSIGNMENT_KEYS.some((k) => k in v)) return forward(routineOverrideSchema, v, ctx);
  if ("config" in v) {
    ctx.addIssue({
      code: "custom",
      path: ["config"],
      message: "a New Routine has no config — config is declared by a routine's manifest, and an assignment has none",
    });
    const { config: _config, ...rest } = v;
    forward(routineAssignmentSchema, rest, ctx);
    return z.NEVER;
  }
  return forward(routineAssignmentSchema, v, ctx);
});

export function isAssignment(entry: RoutineEntry): entry is RoutineAssignment {
  return "actor" in entry;
}

// ---- syncs -------------------------------------------------------------------------

/**
 * A sync: a collector reading one connection, on an interval. Its cadence is
 * `every` from the closed set — a sync has no time of day. `raise` switches
 * the collector manifest's declared Needs You rules on or off (T3-2 checks the
 * names against the manifest). Never in the connection file (§2.6).
 */
export const syncEntrySchema = z
  .object({
    connection: z.string().regex(CONNECTION_NAME_RE, "connection is a connection's name — lowercase kebab-case"),
    every: everySchema.optional(),
    paused: z.boolean().optional(),
    raise: z.record(snakeKey, z.boolean({ error: () => "a raise rule is true or false" })).optional(),
  })
  .strict();

export type SyncEntry = z.output<typeof syncEntrySchema>;

// ---- the file ------------------------------------------------------------------------

/**
 * A map of name → entry. `__proto__` is refused by name rather than left to
 * zod's record, which drops that key without a word — and a dropped entry is
 * a change the owner made that nothing applies.
 */
function namedEntries<T>(entry: z.ZodType<T>) {
  const record = z.record(nameKey, entry);
  return z.unknown().transform((v, ctx): Record<string, T> => {
    if (isPlainObject(v) && Object.hasOwn(v, "__proto__")) ctx.addIssue({ code: "custom", path: ["__proto__"], message: NAME_REFUSAL });
    return forward(record, v, ctx);
  });
}

export const scheduledSchema = z
  .object({
    routines: namedEntries(routineEntrySchema).optional(),
    syncs: namedEntries(syncEntrySchema).optional(),
  })
  .strict();

export type Scheduled = z.output<typeof scheduledSchema>;

/** No changes at all: every routine and sync on its manifest's defaults. What an absent or empty file means. */
export const emptyScheduled: Scheduled = Object.freeze({});

export type ScheduledResult =
  | { readonly ok: true; readonly value: Scheduled; readonly errors: readonly string[] }
  /** `value` is null — an invalid file is never applied, not even as "no changes" (module doc). */
  | { readonly ok: false; readonly value: null; readonly errors: readonly string[] };

/** One line per problem, each naming the field — never a stack. */
function lines(err: z.ZodError): string[] {
  return err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${issueMessage(i)}`);
}

/** Validate a parsed object. */
export function validateScheduled(raw: unknown): ScheduledResult {
  const parsed = scheduledSchema.safeParse(raw ?? {});
  return parsed.success ? { ok: true, value: parsed.data, errors: [] } : { ok: false, value: null, errors: lines(parsed.error) };
}

/** Parse YAML text. A syntax error (a duplicate key included) is an error line, not a throw; an empty file is no changes. */
export function parseScheduled(text: string): ScheduledResult {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    return { ok: false, value: null, errors: [`(root): ${err instanceof Error ? err.message : String(err)}`] };
  }
  if (raw === null || raw === undefined) return { ok: true, value: emptyScheduled, errors: [] };
  return validateScheduled(raw);
}

// ---- Me/profile.md — the facts a schedule follows (T3-4) ---------------------------
//
// `Me/profile.md` keeps facts about the owner — `timezone`, `working_days`,
// `working_hours`, `daily_capacity_min`, `task_size_minutes`, `today_cap` —
// and Metistry only ever READS it (§2.5). These are the readers, in one place,
// so the scheduler, `plan-tomorrow`'s working-day guard and the Scheduled
// view cannot disagree about which days the owner works. A key the owner did
// not write is absent, and nothing fills it in.

/** Where the owner's facts live, vault-relative. `Me/` is the owner's alone (`isUserOwnedPath`): written as `user`, or not at all. */
export const PROFILE_PATH = "Me/profile.md";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** A note's frontmatter as keys, or null when it has none or it is not a mapping. Never throws: an unreadable header is an absent one. */
export function profileFrontmatter(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  const m = FRONTMATTER_RE.exec(text);
  if (!m) return null;
  let parsed: unknown;
  try {
    parsed = parseYaml(m[1] ?? "");
  } catch {
    return null;
  }
  return isPlainObject(parsed) ? parsed : null;
}

/**
 * `[mon, tue]`, `["Monday", "SUN"]`, `"mon, wed"` or a block sequence —
 * anything YAML admits — as weekday tokens, Sunday first. Null when nothing
 * readable is there: an unreadable list is not "every day".
 */
export function profileWeekdays(value: unknown): Weekday[] | null {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : null;
  if (raw === null) return null;
  const days = new Set<string>();
  for (const entry of raw) if (typeof entry === "string") days.add(entry.trim().slice(0, 3).toLowerCase());
  const out = WEEKDAYS.filter((d) => days.has(d));
  return out.length === 0 ? null : out;
}

/**
 * `Me/profile.md` as the two facts a schedule may follow. A timezone that is
 * written but not a zone is passed on as written, so the scheduler refuses it
 * `unknown_timezone` rather than skipping to the next zone in line.
 */
export function profileFacts(text: string | null): ProfileFacts {
  const fm = profileFrontmatter(text) ?? {};
  const tz = fm["timezone"];
  const days = profileWeekdays(fm["working_days"]);
  return {
    ...(tz !== undefined && tz !== null && String(tz).trim() !== "" ? { timezone: String(tz).trim() } : {}),
    ...(days !== null ? { working_days: days } : {}),
  };
}

/** Which days a time-of-day schedule runs on, and where that answer came from — or why there is none. */
export type ResolvedDays =
  | { readonly ok: true; readonly days: Sourced<Weekday[]> }
  | { readonly ok: false; readonly reason: "no_working_days"; readonly why: string };

/**
 * A schedule's days with their origin (§2.5). A day SET (`working_days`,
 * `eve_of_working_days`) follows the profile until the owner sets days on the
 * routine, so its days are *from your profile*; an explicit list is the
 * layer that wrote it (*default* or *yours*). A set with no working days in
 * the profile is refused `no_working_days` — the routine is absent, and
 * nothing guesses Monday to Friday.
 */
export function resolveScheduleDays(schedule: Sourced<TimeOfDaySchedule>, facts: ProfileFacts): ResolvedDays {
  const { days } = schedule.value;
  const resolved = resolveDays(days, facts.working_days);
  if (resolved === null) {
    return { ok: false, reason: "no_working_days", why: `${PROFILE_PATH} does not say which days you work (working_days), so a schedule on ${String(days)} does not run — nothing guesses` };
  }
  return { ok: true, days: { value: resolved, origin: typeof days === "string" ? "profile" : schedule.origin } };
}

// ---- the standup move (§2.5, §4 Q13) -------------------------------------------------
//
// `standup_days` and `standup_time` were profile keys; the owner ruled that
// scheduling lives on routines (ruling 2, K8/K13), so they move to the
// Standup routine's entry here, ONCE. Pure: the console reads the two files,
// asks `planStandupMove`, writes the overlay and raises the proposal
// (apps/console/src/profile-tidy.ts). Nothing here writes `Me/profile.md` —
// that happens only when the owner approves the proposal, as `user`.

/** The Standup routine's name — its manifest (T3-5) and its entry here. */
export const STANDUP_ROUTINE = "standup";
/** The two keys that move. Closed: a later move is a product change with its own proposal. */
export const STANDUP_PROFILE_KEYS = ["standup_days", "standup_time"] as const;
export type StandupProfileKey = (typeof STANDUP_PROFILE_KEYS)[number];
/** §4 Q12, as answered: the Standup runs on working days at 8:00 AM. The time a moved `standup_days` gets when the profile named no `standup_time`. */
export const STANDUP_DEFAULT_AT = "08:00";

/** `"09:15"`, `"9:15"`, `"9:15 am"`, `"1:30 PM"` → `HH:MM`, 24-hour. Null when it is shaped otherwise — never a guess. */
export function profileTime(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = /^\s*(\d{1,2}):(\d{2})\s*([ap]\.?m\.?)?\s*$/i.exec(value);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = Number(m[2]);
  const half = m[3]?.[0]?.toLowerCase();
  if (half !== undefined) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (half === "p" ? 12 : 0);
  }
  const out = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  return AT_RE.test(out) ? out : null;
}

/** What `Me/profile.md` says about the standup, if anything. */
export type StandupKeys =
  | { readonly state: "none" }
  | { readonly state: "unreadable"; readonly keys: readonly StandupProfileKey[]; readonly why: string }
  | { readonly state: "readable"; readonly keys: readonly StandupProfileKey[]; readonly schedule: TimeOfDaySchedule };

const sameDays = (a: readonly Weekday[], b: readonly Weekday[]): boolean => a.length === b.length && a.every((d) => b.includes(d));

/**
 * The standup keys in a profile, read into a schedule. Days the profile
 * gives that ARE its working days become `working_days`, so the routine
 * keeps following the profile; any other list is copied as it stands. An
 * absent `standup_days` is `working_days` and an absent `standup_time` is
 * 8:00 AM (Q12). A key that is present and unreadable moves nothing: the
 * owner's words are never dropped for a default.
 */
export function readStandupKeys(profileText: string | null): StandupKeys {
  const fm = profileFrontmatter(profileText);
  if (fm === null) return { state: "none" };
  const keys = STANDUP_PROFILE_KEYS.filter((k) => Object.hasOwn(fm, k));
  if (keys.length === 0) return { state: "none" };
  const why: string[] = [];
  const listed = Object.hasOwn(fm, "standup_days") ? profileWeekdays(fm["standup_days"]) : undefined;
  if (listed === null) why.push("standup_days is not a list of weekdays ([mon, tue, …])");
  const at = Object.hasOwn(fm, "standup_time") ? profileTime(fm["standup_time"]) : STANDUP_DEFAULT_AT;
  if (at === null) why.push(`standup_time is not a time of day ("09:15")`);
  if (why.length > 0 || listed === null || at === null) return { state: "unreadable", keys, why: why.join("; ") };
  const working = profileWeekdays(fm["working_days"]);
  const days = listed === undefined || (working !== null && sameDays(listed, working)) ? "working_days" : listed;
  const schedule = timeOfDayScheduleSchema.parse({ days, at: [at] });
  return { state: "readable", keys, schedule };
}

/**
 * The profile with `keys` removed from its frontmatter, and nothing else
 * changed — every other byte, comments and line endings included, is the
 * owner's and stays exactly where it was. A top-level key is its line plus
 * the lines that continue it (indented, or a `- ` entry of a block list).
 * Null when a key is not a top-level line of the frontmatter, or when the
 * result does not parse to exactly the old frontmatter minus those keys:
 * a tidy that cannot be proved is not offered.
 */
export function withoutProfileKeys(text: string, keys: readonly string[]): string | null {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const bare = (l: string): string => l.replace(/\r?\n$/, "");
  if (lines.length === 0 || bare(lines[0]!) !== "---") return null;
  const close = lines.findIndex((l, i) => i > 0 && /^---[ \t]*$/.test(bare(l)));
  if (close === -1) return null;
  const before = profileFrontmatter(text);
  if (before === null) return null;

  const drop = new Set<number>();
  const found = new Set<string>();
  for (let i = 1; i < close; i++) {
    const key = keys.find((k) => new RegExp(`^${k}[ \\t]*:`).test(lines[i]!));
    if (key === undefined) continue;
    found.add(key);
    drop.add(i);
    for (let j = i + 1; j < close && /^([ \t]+\S|-([ \t]|$))/.test(bare(lines[j]!)); j++) drop.add(j);
  }
  if (keys.some((k) => !found.has(k))) return null;
  const after = lines.filter((_, i) => !drop.has(i)).join("");

  const expected = Object.fromEntries(Object.entries(before).filter(([k]) => !keys.includes(k)));
  const got = profileFrontmatter(after);
  // a frontmatter emptied of every key parses as null, which is `{}` here
  if (JSON.stringify(got ?? {}) !== JSON.stringify(expected)) return null;
  return after;
}

/**
 * `.metistry/scheduled.yaml` with one routine's schedule set — through the
 * YAML document, so every comment and entry the owner wrote stays. Times are
 * written quoted, as the file's own examples are. Throws on a file that does
 * not parse: an invalid overlay is never rewritten (module doc).
 */
export function withRoutineSchedule(overlayText: string, name: string, schedule: TimeOfDaySchedule): string {
  if (!SCHEDULED_NAME_RE.test(name)) throw new Error(`withRoutineSchedule: ${JSON.stringify(name)} is not a routine name`);
  const doc = parseDocument(overlayText);
  if (doc.errors.length > 0) throw new Error(`withRoutineSchedule: ${doc.errors[0]!.message}`);
  const node = doc.createNode(schedule, { flow: true }) as YAMLMap;
  const at: unknown = node.get("at", true);
  if (isSeq(at)) for (const item of at.items) if (isScalar(item)) item.type = Scalar.QUOTE_DOUBLE;
  doc.setIn(["routines", name, "schedule"], node);
  return doc.toString();
}

/** What moving the standup keys means for these two files. */
export type StandupMove =
  /** The profile has no standup keys: nothing to move, nothing to tidy. */
  | { readonly state: "none" }
  /** A key is there but cannot be read; nothing moves, and doctor says why. */
  | { readonly state: "unreadable"; readonly keys: readonly StandupProfileKey[]; readonly why: string }
  /** `scheduled.yaml` does not validate: it is never rewritten, so the move waits for the owner to fix it. */
  | { readonly state: "overlay_invalid"; readonly keys: readonly StandupProfileKey[]; readonly errors: readonly string[] }
  | {
      readonly state: "move";
      readonly keys: readonly StandupProfileKey[];
      /** What the profile said, as a schedule. */
      readonly schedule: TimeOfDaySchedule;
      /** The overlay to write, or null when the Standup routine already has a schedule of the owner's — theirs wins, and the keys are simply ignored. */
      readonly overlay: string | null;
      /** The profile without the keys — the proposal's "after" — or null when that cannot be proved (`withoutProfileKeys`). */
      readonly tidied: string | null;
    };

/**
 * The whole decision, pure: read the keys, and say what to write where. The
 * caller writes the overlay FIRST and raises the proposal only once that has
 * landed, so no answer to the proposal can lose what the profile said.
 */
export function planStandupMove(profileText: string | null, overlayText: string | null): StandupMove {
  const read = readStandupKeys(profileText);
  if (read.state !== "readable") return read;
  const overlay = parseScheduled(overlayText ?? "");
  if (!overlay.ok) return { state: "overlay_invalid", keys: read.keys, errors: overlay.errors };
  const entry = overlay.value.routines?.[STANDUP_ROUTINE];
  const theirs = entry !== undefined && (isAssignment(entry) || entry.schedule !== undefined);
  let next: string | null = null;
  if (!theirs) {
    next = withRoutineSchedule(overlayText ?? "", STANDUP_ROUTINE, read.schedule);
    const check = parseScheduled(next);
    // the file this writes must be one the schema accepts, carrying exactly this schedule
    if (!check.ok || JSON.stringify(check.value.routines?.[STANDUP_ROUTINE]?.schedule) !== JSON.stringify(read.schedule)) {
      throw new Error(`planStandupMove: the overlay it would write does not validate — ${check.errors.join("; ")}`);
    }
  }
  return { state: "move", keys: read.keys, schedule: read.schedule, overlay: next, tidied: withoutProfileKeys(profileText!, read.keys) };
}
