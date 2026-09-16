// Executable `action` proposals, and the autonomy table that decides what
// happens when an agent emits one (docs/ops/actions.md; ADOPT 6 of
// docs/research/2026-09-16-taskuary-review.md, accepted 2026-09-16; agent-room
// A3 / plan-refresh OPEN-2, resolved the same day).
//
// This file is DATA. It holds the closed list of things an agent may ask the
// console to do, the zod shape of each one's arguments, and the pure functions
// that turn an agent's stored `autonomy` record into a
// (kind -> allow | propose | deny) table. It executes nothing: execution is
// the console's, through the SAME service call the owner's own click goes
// through (apps/console/src/actions.ts), and nothing here imports the console,
// Postgres or the vault (CLAUDE.md: the dependency arrow points one way).
//
// Two properties are worth stating before the code, because both are load
// bearing and neither is obvious from a type:
//
//   * The enum is CLOSED and it is here. A kind nobody validated is a kind
//     nobody reviewed; the console, the bridge, the CLI and the tests all read
//     this list, so "what may an action do" has exactly one answer.
//   * The level is a CEILING, not a synonym for the table. `effectiveActions`
//     takes the lower of (level ceiling, per-kind entry), which is what makes
//     "auto-execute happens only at act_within_scope" a property of the
//     arithmetic rather than a rule somewhere else that could be forgotten.

import { z } from "zod";

/**
 * Everything an `action` proposal may be. Every one of these is something the
 * console can ALREADY do through an existing service with an existing audit
 * row — the proposal adds a door, never a power. Deliberately absent: sending
 * anything (mail, message), git, shell, and any change to grants or autonomy
 * (invariant 2 — the credential surface is never an agent's to widen).
 */
export const ACTION_KINDS = ["dispatch", "task_update", "comment", "capture"] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

/** What an agent may do with one kind. Ordered least → most: the INDEX is the rank, so comparisons never need a second table. */
export const ACTION_MODES = ["deny", "propose", "allow"] as const;
export type ActionMode = (typeof ACTION_MODES)[number];

/** How much room an agent has, at all (A3). Ordered least → most, same trick. */
export const AUTONOMY_LEVELS = ["observe", "propose", "act_within_scope"] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

/** An absent `level` is `observe`: this axis is opt-in, so nothing an agent can do today changes because the column grew a meaning. */
export const DEFAULT_AUTONOMY_LEVEL: AutonomyLevel = "observe";

export const modeRank = (m: ActionMode): number => ACTION_MODES.indexOf(m);
export const levelRank = (l: AutonomyLevel): number => AUTONOMY_LEVELS.indexOf(l);

// --- argument shapes ----------------------------------------------------------
//
// One schema per kind, strict: an argument nobody named is a refusal, never a
// field that travels into a service call unread.

const workRef = z.number().int().positive();
const text = (max: number) => z.string().trim().min(1).max(max);

/** The task fields an action may patch — the board's own set (apps/console/src/task-routes.ts PATCH_FIELDS; a test pins the two together). */
export const ACTION_TASK_PATCH_FIELDS = ["status", "owner", "project", "title"] as const;
/** The statuses the board's arm accepts. `open` is the unblock; the service decides whether this row may take it. */
export const ACTION_TASK_STATUSES = ["open", "in_progress", "blocked", "closed"] as const;

const taskPatch = z
  .strictObject({
    status: z.enum(ACTION_TASK_STATUSES).optional(),
    owner: z.union([z.string().max(120), z.null()]).optional(),
    project: z.union([z.string().max(120), z.null()]).optional(),
    title: text(500).optional(),
  })
  .refine((p) => Object.keys(p).length > 0, `patch needs at least one of ${ACTION_TASK_PATCH_FIELDS.join(", ")}`);

// A comment names exactly one anchor. `version_id` is required with
// `artifact_id` and refused without it, because the console's own comment
// route requires the version too — an action must not reach a service by a
// shape no human route can produce.
const commentArgs = z
  .strictObject({
    work_id: workRef.optional(),
    artifact_id: z.string().max(64).optional(),
    version_id: z.string().max(64).optional(),
    body: text(20_000),
  })
  .superRefine((a, ctx) => {
    const onWork = a.work_id !== undefined;
    const onArtifact = a.artifact_id !== undefined;
    if (onWork === onArtifact) ctx.addIssue({ code: "custom", message: "name exactly one of work_id (a room on a task) or artifact_id (a version's thread)" });
    if (onArtifact && a.version_id === undefined) ctx.addIssue({ code: "custom", path: ["version_id"], message: "an artifact comment is anchored to a version — version_id is required" });
    if (!onArtifact && a.version_id !== undefined) ctx.addIssue({ code: "custom", path: ["version_id"], message: "version_id belongs to an artifact comment; a room on a task has no versions" });
  });

/**
 * `{kind, args}` as it is stored in `proposals.payload.action` and as the
 * bridge's `propose_action` receives it. A discriminated union so an unknown
 * kind fails on the discriminator with the four that exist named back.
 */
export const actionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("dispatch"), args: z.strictObject({ work_id: workRef, target: text(120), brief: text(100_000) }) }),
  z.strictObject({ kind: z.literal("task_update"), args: z.strictObject({ work_id: workRef, patch: taskPatch }) }),
  z.strictObject({ kind: z.literal("comment"), args: commentArgs }),
  z.strictObject({ kind: z.literal("capture"), args: z.strictObject({ note: text(200_000), filename: z.string().max(200).optional() }) }),
]);

export type Action = z.infer<typeof actionSchema>;

/** Validate `{kind, args}`. The error is one line naming the path that failed — never "invalid request". */
export function parseAction(input: unknown): { ok: true; action: Action } | { ok: false; error: string } {
  const parsed = actionSchema.safeParse(input);
  if (parsed.success) return { ok: true, action: parsed.data };
  const issue = parsed.error.issues[0];
  const path = issue?.path.join(".") ?? "";
  const known = `kind must be one of ${ACTION_KINDS.join(" | ")}`;
  if (path === "kind" || path === "") return { ok: false, error: `${known} (docs/ops/actions.md)` };
  return { ok: false, error: `${path}: ${issue?.message ?? "invalid"}` };
}

/** The work row an action is about, when it names one — what `proposals.work_id` is set from, so staleness and the room join for free. */
export function actionWorkId(action: Action): number | undefined {
  if (action.kind === "capture") return undefined;
  if (action.kind === "comment") return action.args.work_id;
  return action.args.work_id;
}

/** One deterministic line for the queue title, the audit row and the alert. No model, no prose. */
export function describeAction(action: Action): string {
  switch (action.kind) {
    case "dispatch":
      return `dispatch task #${action.args.work_id} to target "${action.args.target}"`;
    case "task_update": {
      const fields = Object.entries(action.args.patch).map(([k, v]) => `${k} → ${v === null ? "none" : String(v)}`);
      return `update task #${action.args.work_id}: ${fields.join(", ")}`;
    }
    case "comment":
      return action.args.work_id !== undefined
        ? `comment on the room on task #${action.args.work_id}`
        : `comment on ${action.args.artifact_id} @ ${action.args.version_id}`;
    case "capture":
      return `capture a note${action.args.filename ? ` as ${action.args.filename}` : ""}`;
  }
}

// --- the table ------------------------------------------------------------------

/** The most a level will ever allow. `observe` can do nothing; `act_within_scope` is the only level an `allow` can come out of. */
export const LEVEL_CEILING: Readonly<Record<AutonomyLevel, ActionMode>> = {
  observe: "deny",
  propose: "propose",
  act_within_scope: "allow",
};

/**
 * What each level means with no per-kind entry. `dispatch` is `propose` even
 * at `act_within_scope`: it is the one kind that leaves the machine, and
 * off-machine is a human decision by default (§4.12). The owner can still set
 * it to `allow` by hand — that is a widening, and widenings are recorded.
 */
export const ACTION_DEFAULTS: Readonly<Record<AutonomyLevel, Readonly<Record<ActionKind, ActionMode>>>> = {
  observe: { dispatch: "deny", task_update: "deny", comment: "deny", capture: "deny" },
  propose: { dispatch: "propose", task_update: "propose", comment: "propose", capture: "propose" },
  act_within_scope: { dispatch: "propose", task_update: "allow", comment: "allow", capture: "allow" },
};

/** The two keys of `agents.autonomy` this file owns. The §4.21 narrowing keys live beside them and are none of this file's business. */
export interface ActionAutonomy {
  level?: AutonomyLevel | undefined;
  actions?: Partial<Record<ActionKind, ActionMode>> | undefined;
}

/**
 * The record as a table: every kind, resolved. The level is a CEILING, so an
 * entry above it is clamped rather than honoured — which is what makes
 * "immediate execution happens only at `act_within_scope`" arithmetic instead
 * of a rule that could be forgotten at a second call site.
 */
export function effectiveActions(a: ActionAutonomy | null | undefined): Record<ActionKind, ActionMode> {
  const level = a?.level ?? DEFAULT_AUTONOMY_LEVEL;
  const ceiling = LEVEL_CEILING[level];
  const out = {} as Record<ActionKind, ActionMode>;
  for (const kind of ACTION_KINDS) {
    const asked = a?.actions?.[kind] ?? ACTION_DEFAULTS[level][kind];
    out[kind] = modeRank(asked) <= modeRank(ceiling) ? asked : ceiling;
  }
  return out;
}

/** True when this record admits anything at all — the bridge registers `propose_action` only then (docs/ops/actions.md, discovery). */
export function admitsAnyAction(a: ActionAutonomy | null | undefined): boolean {
  const table = effectiveActions(a);
  return ACTION_KINDS.some((k) => table[k] !== "deny");
}

/**
 * What `next` WIDENS over `prev`: the level rising, and every kind whose
 * effective mode rises. Empty means a narrowing or a no-op, which any caller
 * may do; a non-empty list is the owner's hand or a refusal (agents.ts).
 * Computed on the EFFECTIVE tables, so a change that raises an entry under an
 * unchanged ceiling — and therefore changes nothing — is not called a widening.
 */
export function autonomyWidenings(prev: ActionAutonomy | null | undefined, next: ActionAutonomy | null | undefined): string[] {
  const out: string[] = [];
  const before = prev?.level ?? DEFAULT_AUTONOMY_LEVEL;
  const after = next?.level ?? DEFAULT_AUTONOMY_LEVEL;
  if (levelRank(after) > levelRank(before)) out.push(`level ${before} → ${after}`);
  const wasTable = effectiveActions(prev);
  const nowTable = effectiveActions(next);
  for (const kind of ACTION_KINDS) {
    if (modeRank(nowTable[kind]) > modeRank(wasTable[kind])) out.push(`actions.${kind} ${wasTable[kind]} → ${nowTable[kind]}`);
  }
  return out;
}

// --- manifest side ----------------------------------------------------------------

/** The `actions` block as a crew manifest and the registry's validator both spell it. Written out rather than derived: a table this small should be readable. */
export const actionTableSchema = z.strictObject({
  dispatch: z.enum(ACTION_MODES).optional(),
  task_update: z.enum(ACTION_MODES).optional(),
  comment: z.enum(ACTION_MODES).optional(),
  capture: z.enum(ACTION_MODES).optional(),
});
