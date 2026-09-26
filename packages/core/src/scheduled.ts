// `.metistry/scheduled.yaml` — the owner's changes to everything recurring
// (design-build-plan §2.5; F-4 freezes this schema). Every scheduled thing is
// a ROUTINE or a SYNC, and its timing and configuration resolve per field
// from three layers, each field showing where its value came from:
//
//   1. the MANIFEST — a product routine or collector, or an extension: the
//      default schedule, the config schema, what it reads and writes;
//   2. `Me/profile.md` — facts about the owner a schedule may FOLLOW
//      (`working_days`, `timezone`); read, never written;
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
import { parse as parseYaml } from "yaml";
import { validAgentAreaGrant } from "./instance-layout.js";
import { AGENT_NAME_RE } from "./instances.js";
import { everySchema, forward, isPlainObject, issueMessage, scheduleSchema } from "./schedule.js";

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
