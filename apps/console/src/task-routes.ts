// The console's task-mutation surface (docs/ops/board.md "Drags"; phase 3 of
// docs/research/2026-09-12-hermes-agent-review.md §6c). A thin adapter over
// `TasksService` — "adapters adapt this and add nothing". There is no policy
// here: every refusal below is a `Result` the service produced from the WHERE
// clause of one atomic statement, and this file only turns it into a sentence
// that names what would permit it (R3).
//
// Reached ONLY by the `user` principal (server.ts's management gate runs
// first), so the identity handed to the service is always `user` — never
// anything a body said. That is the whole of the §6c policy table's "allowed
// for" column: a HUMAN may address a card to any crew; no agent surface can
// address one at all, because `tasks_update`'s schema has no `owner` key and
// its status enum has no `open`. The collaboration rule (rule 4, C7,
// `crossKindRefusal`) is therefore enforced here by ABSENCE rather than by a
// check — the shape invariant 9 prefers. If an agent surface ever gains an
// assign verb, `crossKindRefusal(compute, caller, crew)` is the guard it
// needs, and this comment is the reason it is not called yet.
//
// The board offers no drop the service would refuse: `dropsFor()` in the PWA
// derives its targets from the same rules the statements enforce. When the
// two disagree the STATEMENT wins and the card snaps back carrying the
// sentence below.

import type { IncomingMessage, ServerResponse } from "node:http";
import { TasksError, type Result, type Task, type TasksService } from "@foldedspacelabs/metistry-tasks";
import type { ErrorCode } from "@foldedspacelabs/metistry-core";
import { readBody, sendError, sendJson } from "./http-util.js";

/** The one principal that reaches this file. Matches artifacts-routes' USER, and lands in `work.claimed_by` / `history[].agent` as-is. */
const USER = "user";

const PATCH_TASK = /^PATCH \/api\/tasks\/(\d{1,12})$/;
const TASK_OP = /^POST \/api\/tasks\/(\d{1,12})\/(claim|release|renew)$/;
/** The fields PATCH accepts. Anything else is refused BY NAME rather than ignored — a silently dropped field is a lie about what happened. */
const PATCH_FIELDS = ["status", "owner", "project", "title"] as const;
const STATUSES = ["open", "in_progress", "blocked", "closed"] as const;

/**
 * True when the path belongs to this adapter. Used by server.ts's management
 * gate so a non-`user` credential gets a uniform 403 here, exactly as it does
 * on `/api/projects` — never a 404 that would say whether the task exists.
 */
export function isTaskOpRoute(key: string): boolean {
  return PATCH_TASK.test(key) || TASK_OP.test(key);
}

/** Every refusal the service can return, as the sentence that names what would permit it (R3). */
function refusalMessage(r: Extract<Result, { ok: false }>, id: number): string {
  const t: Task | undefined = r.task;
  switch (r.reason) {
    case "not_found":
      return `task ${id} does not exist`;
    case "not_claimable":
      return `task ${id} is kind "${t?.kind ?? "unknown"}" — a row a collector reconciles from its source of truth is never the board's to move; change it at ${t?.external_ref ?? "the source"} and the next collector run brings it back`;
    case "closed":
      return `task ${id} is closed — a closed row takes no further change here; create a follow-up task instead`;
    case "blocked":
      return `task ${id} is blocked — nothing claims a blocked row; unblock it first (PATCH /api/tasks/${id} {"status":"open"}), which is the Needs You drop`;
    case "claimed":
      return `task ${id} is held by ${t?.claimed_by ?? "another agent"}${t?.lease_expires_at ? ` until ${new Date(t.lease_expires_at).toISOString()}` : ""} — the holder releases it (POST /api/tasks/${id}/release), or the lease lapses and it is claimable again`;
    case "dependencies_open":
      return `task ${id} waits on depends_on ${JSON.stringify(t?.depends_on ?? [])} — close those rows first; a dangling id blocks on purpose`;
    case "not_holder":
      return `task ${id} is held by ${t?.claimed_by ?? "nobody"}, not by ${USER} — status and notes belong to the holder, so claim it first (POST /api/tasks/${id}/claim)`;
    case "lease_expired":
      return `the lease on task ${id} has lapsed — claim it again (POST /api/tasks/${id}/claim); an expired lease is never renewed`;
    case "not_blocked":
      return `task ${id} is ${t?.status ?? "not blocked"}, not blocked — status "open" is the unblock and is reachable from blocked only; use POST /api/tasks/${id}/release to hand a claimed row back`;
  }
}

/** A refusal's HTTP code: only "no such row" is a 404; a kind the list does not own is the caller's mistake; everything else is the row's state saying no. */
function refusalCode(reason: Extract<Result, { ok: false }>["reason"]): ErrorCode {
  if (reason === "not_found") return "not_found";
  if (reason === "not_claimable") return "invalid_request";
  return "conflict";
}

type Audit = (kind: string, tool: string, ok: boolean, meta: Record<string, unknown>) => Promise<void>;

function optionalNote(body: Record<string, unknown>, field: string): string | undefined {
  const v = body[field];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new TasksError("invalid_input", `${field} must be a string`);
  return v;
}

function optionalLease(body: Record<string, unknown>): number | undefined {
  const v = body.lease_seconds;
  if (v === undefined || v === null) return undefined;
  if (!Number.isInteger(v) || (v as number) <= 0) throw new TasksError("invalid_input", "lease_seconds must be a positive integer — omit it to take the service default (900s)");
  return v as number;
}

/** `{status?, owner?, project?, title?}` — validated here, gated in the service. */
function patchBody(raw: unknown): { status?: (typeof STATUSES)[number]; owner?: string | null; project?: string | null; title?: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new TasksError("invalid_input", "request body must be a JSON object");
  const body = raw as Record<string, unknown>;
  const unknown = Object.keys(body).filter((k) => !(PATCH_FIELDS as readonly string[]).includes(k));
  if (unknown.length > 0) throw new TasksError("invalid_input", `unknown field(s) ${unknown.join(", ")} — PATCH takes ${PATCH_FIELDS.join(", ")}`);
  const out: { status?: (typeof STATUSES)[number]; owner?: string | null; project?: string | null; title?: string } = {};
  if ("status" in body) {
    if (typeof body.status !== "string" || !(STATUSES as readonly string[]).includes(body.status)) {
      throw new TasksError("invalid_input", `status must be one of ${STATUSES.join(", ")} — "open" is the unblock (blocked rows only) and the rest need the claim`);
    }
    out.status = body.status as (typeof STATUSES)[number];
  }
  if ("owner" in body) {
    if (body.owner !== null && typeof body.owner !== "string") throw new TasksError("invalid_input", "owner must be a string (a crew or agent name, or \"user\") or null to clear it");
    out.owner = body.owner as string | null;
  }
  if ("project" in body) {
    if (body.project !== null && typeof body.project !== "string") throw new TasksError("invalid_input", "project must be a string (a project slug) or null to take the card out of every project");
    out.project = body.project as string | null;
  }
  if ("title" in body) {
    if (typeof body.title !== "string" || body.title.trim() === "") throw new TasksError("invalid_input", "title must be a non-empty string");
    out.title = body.title;
  }
  if (Object.keys(out).length === 0) throw new TasksError("invalid_input", `PATCH needs at least one of ${PATCH_FIELDS.join(", ")}`);
  return out;
}

/**
 * PATCH /api/tasks/:id · POST /api/tasks/:id/{claim,release,renew}
 *
 * `audit` is server.ts's own — one `runs` row per request, recording the DOOR
 * (component `console`, kind `task_admin`); the service records the OP
 * (component `user`, kind `task_op`) inside the same call. Two rows because
 * they answer two different questions.
 */
export async function taskRoutes(req: IncomingMessage, res: ServerResponse, key: string, tasks: TasksService, audit: Audit): Promise<void> {
  const patch = PATCH_TASK.exec(key);
  const op = TASK_OP.exec(key);
  const id = Number((patch ?? op)![1]);
  const verb = op ? (op[2] as "claim" | "release" | "renew") : "patch";
  try {
    // claim / release / renew take no required field, and a fetch() with no
    // body is the ordinary case — an empty body is `{}`, not a parse error.
    const text = (await readBody(req)).toString("utf8").trim();
    const raw = (text === "" ? {} : JSON.parse(text)) as Record<string, unknown> | null;
    let result: Result;
    let meta: Record<string, unknown> = { task: id, op: verb };
    if (patch) {
      const change = patchBody(raw ?? {});
      meta = { ...meta, fields: Object.keys(change), ...("status" in change ? { status: change.status } : {}), ...("owner" in change ? { owner: change.owner } : {}) };
      result = await tasks.update(id, USER, change);
    } else {
      const body = (raw ?? {}) as Record<string, unknown>;
      const note = optionalNote(body, "note");
      const lease = optionalLease(body);
      if (verb === "claim") result = await tasks.claim(id, USER, lease);
      else if (verb === "release") result = await tasks.release(id, USER, note);
      else result = await tasks.heartbeat(id, USER, lease, note);
      if (note !== undefined) meta = { ...meta, has_note: true };
    }
    await audit("task_admin", verb, result.ok, { ...meta, ...(result.ok ? {} : { refused: result.reason }) });
    if (result.ok) return sendJson(res, 200, { ok: true, task: result.task });
    return sendError(res, refusalCode(result.reason), refusalMessage(result, id));
  } catch (err) {
    if (err instanceof TasksError) {
      await audit("task_admin", verb, false, { task: id, op: verb, refused: err.code });
      // the service's validator already named the field; do not throw that away
      return sendError(res, err.code === "conflict" ? "conflict" : "invalid_request", err.message);
    }
    if (err instanceof SyntaxError) return sendError(res, "invalid_request", "request body is not JSON");
    throw err;
  }
}
