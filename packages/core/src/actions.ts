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

import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

/**
 * Everything an `action` proposal may be. Every one of these is something the
 * console can ALREADY do through an existing service with an existing audit
 * row — the proposal adds a door, never a power. Deliberately absent: sending
 * anything (mail, message), git, shell, and any change to grants or autonomy
 * (invariant 2 — the credential surface is never an agent's to widen).
 *
 * `connection_call` (plan §1.1 Q5, §2.6; T4-9) is the fifth: one tool of one
 * of the owner's connections, set to Ask First, run through the connections
 * pool — the connection service — once the owner approves. Its reach is
 * itself enumerated by the owner's hand (the connection file's `tools:`), and
 * its effective mode is never `allow` (`ACTION_KIND_CEILING`). It is raised by
 * the proxy's `connections_call`, which builds the payload and previews it —
 * never by `propose_action` (`PROPOSABLE_ACTION_KINDS`), so what an Approve
 * runs is the server's payload and never a caller's.
 */
export const ACTION_KINDS = ["dispatch", "task_update", "comment", "capture", "connection_call"] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

/**
 * The kinds `propose_action` raises. `connection_call` is not one: its payload
 * is built and previewed by the connections proxy (`connections_call`), which
 * holds the confirm token that binds an Approve to exactly that payload.
 */
export const PROPOSABLE_ACTION_KINDS = ["dispatch", "task_update", "comment", "capture"] as const satisfies readonly ActionKind[];
export type ProposableActionKind = (typeof PROPOSABLE_ACTION_KINDS)[number];
export const isProposableActionKind = (k: ActionKind): k is ProposableActionKind => (PROPOSABLE_ACTION_KINDS as readonly ActionKind[]).includes(k);

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

// --- connection_call: the preview's confirm token ------------------------------
//
// Preview-then-confirm (CLAUDE.md, Packages; eventkit's shipped mechanism,
// packages/mcp-eventkit/src/index.ts): a call that changes something first
// comes back as a preview and a token, nothing dialled, and runs only when
// the token is presented. The token is 32 random bytes; the server keeps its
// SHA-256 and the SHA-256 of the canonical payload it previewed, never the
// token itself, and redeems it once (mcp-brain's connection-confirm.ts). A
// token that does not match what it previewed, or comes back a second time,
// is refused — nothing runs.

/** A confirm token as minted: 32 random bytes, base64url, no padding. */
export const CONFIRM_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** A fresh confirm token. */
export function mintConfirmToken(): string {
  return randomBytes(32).toString("base64url");
}

/** What the server keeps of a token: its SHA-256, hex. */
export function confirmTokenDigest(token: string): string {
  return createHash("sha256").update(`metistry-confirm\0${token}`).digest("hex");
}

/** JSON with every object's keys sorted — so the same payload always hashes the same, whatever order a caller wrote it in. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** The one payload a confirm token binds: who asked, which connection, which tool, which arguments. */
export interface ConnectionCallPayload {
  principal: string;
  connection: string;
  tool: string;
  args: Record<string, unknown>;
}

/** The SHA-256 of the canonical payload — what a redemption compares, so a token previewed for one call can never run another. */
export function connectionCallDigest(p: ConnectionCallPayload): string {
  return createHash("sha256")
    .update(canonicalJson({ principal: p.principal, connection: p.connection, tool: p.tool, args: p.args }))
    .digest("hex");
}

/** A connection's name as a connection file spells it (core's connectionFileSchema: lowercase kebab). */
const connectionName = z.string().regex(/^[a-z][a-z0-9-]*$/, "a connection name is lowercase kebab-case").max(64);
/** A tool's name as an upstream spells it (connectionFileSchema's `toolName`). */
const upstreamToolName = z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]*$/, "a tool name starts with a letter and uses letters, digits, _ . -").max(128);

const connectionCallArgs = z.strictObject({
  connection: connectionName,
  tool: upstreamToolName,
  args: z.record(z.string(), z.unknown()),
  confirm_token: z.string().regex(CONFIRM_TOKEN_RE, "a confirm token is the one the preview returned"),
});

/**
 * `{kind, args}` as it is stored in `proposals.payload.action` and as the
 * bridge's `propose_action` receives it. A discriminated union so an unknown
 * kind fails on the discriminator with the five that exist named back.
 */
export const actionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("dispatch"), args: z.strictObject({ work_id: workRef, target: text(120), brief: text(100_000) }) }),
  z.strictObject({ kind: z.literal("task_update"), args: z.strictObject({ work_id: workRef, patch: taskPatch }) }),
  z.strictObject({ kind: z.literal("comment"), args: commentArgs }),
  z.strictObject({ kind: z.literal("capture"), args: z.strictObject({ note: text(200_000), filename: z.string().max(200).optional() }) }),
  z.strictObject({ kind: z.literal("connection_call"), args: connectionCallArgs }),
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
  if (action.kind === "capture" || action.kind === "connection_call") return undefined;
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
    case "connection_call":
      return `call ${action.args.tool} on ${action.args.connection}`;
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
 * A kind whose ceiling is its own, whatever the level. `connection_call` is
 * `propose` at every level (plan §1.1 Q5: "its effective mode is never `allow`
 * in its first release"): an Ask First call waits for the owner's Approve,
 * so asking is not a power (the rule `request_access` follows) and even
 * `observe` may ask — while no level, and no per-kind entry, can make one run
 * without the owner. The owner may still set it to `deny` for one agent, and
 * the proxy then refuses that agent's Ask First calls outright.
 */
export const ACTION_KIND_CEILING: Readonly<Partial<Record<ActionKind, ActionMode>>> = { connection_call: "propose" };

/** The most one kind may be at one level: its own ceiling where it has one, else the level's. */
export function ceilingFor(level: AutonomyLevel, kind: ActionKind): ActionMode {
  return ACTION_KIND_CEILING[kind] ?? LEVEL_CEILING[level];
}

/**
 * What each level means with no per-kind entry. `dispatch` is `propose` even
 * at `act_within_scope`: it is the one kind that leaves the machine, and
 * off-machine is a human decision by default (§4.12). The owner can still set
 * it to `allow` by hand — that is a widening, and widenings are recorded.
 * `connection_call` is `propose` everywhere — its own ceiling, above.
 */
export const ACTION_DEFAULTS: Readonly<Record<AutonomyLevel, Readonly<Record<ActionKind, ActionMode>>>> = {
  observe: { dispatch: "deny", task_update: "deny", comment: "deny", capture: "deny", connection_call: "propose" },
  propose: { dispatch: "propose", task_update: "propose", comment: "propose", capture: "propose", connection_call: "propose" },
  act_within_scope: { dispatch: "propose", task_update: "allow", comment: "allow", capture: "allow", connection_call: "propose" },
};

/** The two keys of `agents.autonomy` this file owns. The §4.21 narrowing keys live beside them and are none of this file's business. */
export interface ActionAutonomy {
  level?: AutonomyLevel | undefined;
  actions?: Partial<Record<ActionKind, ActionMode>> | undefined;
}

/** Why one kind's effective mode is what it is (C46/C47). Three surfaces — `metistry agents autonomy`, the console's agent read, and MetistryKit — were each recomputing this from `effectiveActions` alone, which cannot tell them apart. */
export type ActionSource = "set" | "defaulted" | "clamped";

/**
 * One kind, resolved AND explained. `mode` is what `effectiveActions` already
 * returns; `source` is which of the three things happened; `ceiling` is what
 * the level would allow (always present, so a renderer can say "…, ceiling is
 * X" without a second lookup); `asked` is the record's OWN per-kind entry —
 * present exactly when the owner set one, i.e. for `set` and `clamped`, never
 * for `defaulted` — and it is the only source where `asked !== mode`: that
 * mismatch IS "the owner's own setting is being overridden".
 */
export interface EffectiveActionEntry {
  mode: ActionMode;
  source: ActionSource;
  asked?: ActionMode;
  ceiling: ActionMode;
}

/**
 * The record as a table: every kind, resolved and with the reason attached.
 * The level is a CEILING, so an entry above it is clamped rather than
 * honoured — which is what makes "immediate execution happens only at
 * `act_within_scope`" arithmetic instead of a rule that could be forgotten at
 * a second call site. `effectiveActions` is a projection of this (the two
 * cannot drift — a test pins it).
 */
export function effectiveActionsDetailed(a: ActionAutonomy | null | undefined): Record<ActionKind, EffectiveActionEntry> {
  const level = a?.level ?? DEFAULT_AUTONOMY_LEVEL;
  const out = {} as Record<ActionKind, EffectiveActionEntry>;
  for (const kind of ACTION_KINDS) {
    const ceiling = ceilingFor(level, kind);
    const own = a?.actions?.[kind];
    const asked = own ?? ACTION_DEFAULTS[level][kind];
    const clamped = modeRank(asked) > modeRank(ceiling);
    const mode = clamped ? ceiling : asked;
    const source: ActionSource = clamped ? "clamped" : own !== undefined ? "set" : "defaulted";
    out[kind] = { mode, source, ceiling, ...(own !== undefined ? { asked: own } : {}) };
  }
  return out;
}

/**
 * The record as a table: every kind, resolved. The level is a CEILING, so an
 * entry above it is clamped rather than honoured — which is what makes
 * "immediate execution happens only at `act_within_scope`" arithmetic instead
 * of a rule that could be forgotten at a second call site.
 *
 * A projection of `effectiveActionsDetailed` — never a second computation of
 * the same table, so the two cannot drift apart.
 */
export function effectiveActions(a: ActionAutonomy | null | undefined): Record<ActionKind, ActionMode> {
  const detailed = effectiveActionsDetailed(a);
  const out = {} as Record<ActionKind, ActionMode>;
  for (const kind of ACTION_KINDS) out[kind] = detailed[kind].mode;
  return out;
}

/**
 * True when this record admits anything `propose_action` can raise — the
 * bridge registers the tool only then (docs/ops/actions.md, discovery).
 * `connection_call` is not counted: the proxy raises it, not this tool.
 */
export function admitsAnyAction(a: ActionAutonomy | null | undefined): boolean {
  const table = effectiveActions(a);
  return PROPOSABLE_ACTION_KINDS.some((k) => table[k] !== "deny");
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
  connection_call: z.enum(ACTION_MODES).optional(),
});
