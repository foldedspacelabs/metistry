// Send to Linear, the first door — `POST /api/trackers/:connection/issues
// {task_key, title?, team?, path?}` (design-build-plan §2.1, T4-25).
//
// From a task line on Today, *Send to Linear* is two doors, one service each:
// this one files the issue through the tracker connection, and
// `POST /api/vault-tasks/:task_key/link {ref, seen_text}` then writes
// `linear:<KEY>` on the line (vault-task-routes.ts). This door writes nothing
// of the owner's: no note, no row. It:
//
//   * **names the task by its key** and reads the line in the note, as the
//     Tick door does (`findLine`: the key's one note, the refusals before any
//     read — `.metistry/`, a dot-directory, `Artifacts/` — and the line found
//     by the walk's own key). The issue's title is the line's text as it
//     stands, or the caller's `title`; nothing else of the note leaves.
//   * **is idempotent by task key**, with no state of its own: the issue's id
//     is derived from the connection, the note and the key
//     (`trackerIssueId`), so a second press — or a retry after a lost answer,
//     or a second client — answers the first issue (`created: false`, `200`)
//     and Linear never holds two (packages/connections `linear-issue.ts`).
//     Two presses racing in this console share one call.
//   * **refuses a line already linked**: a line carrying a `linear:` ref is
//     `409 stale` with the line — its issue exists, and the owner sees which.
//   * **goes through the connection and its capability**: the connection the
//     Linear sync reads (`openSync` — the instance's catalog, read afresh),
//     named in the path, whose provider must declare `create`. Every request
//     goes through core's `guardedFetch` with the connection as grantee: the
//     key is filled at the door for api.linear.app only, never on a URL, and
//     nothing else is reached.
//
// Not an action: `ACTION_KINDS` is untouched, so no proposal can file an
// issue at any autonomy level. Reached only by the `user` principal:
// server.ts's management gate runs first, so an agent bearer and the capture
// owner token get the uniform 403 there.

import type { IncomingMessage, ServerResponse } from "node:http";
import { SECRET_USE_META_KEY, errorEnvelope, statusFor, TASK_KEY_RE, type ErrorCode, type LocatedTaskLine } from "@foldedspacelabs/metistry-core";
import {
  ConnectionRefused,
  LINEAR_MODULE,
  LINEAR_ORIGIN,
  LINEAR_SYNC,
  LinearError,
  TRACKER_CREATE_CAPABILITY,
  createLinearIssue,
  issueTitle,
  linearRef,
  trackerIssueId,
  type CreateIssueResult,
  type SyncOpener,
} from "@foldedspacelabs/metistry-connections";
import type { VaultClient } from "@foldedspacelabs/metistry-artifacts";
import type { QueryStore } from "@foldedspacelabs/metistry-queries";
import { readJson, sendJson } from "./http-util.js";
import { findLine, type Answer, type Audited } from "./vault-task-routes.js";

const TRACKER_ISSUE_ROUTE = /^POST \/api\/trackers\/([^/]+)\/issues$/;
const BODY_FIELDS = ["task_key", "title", "team", "path"];
const CONNECTION_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const TEAM_KEY_RE = /^[A-Z][A-Z0-9]{0,9}$/;
const TITLE_MAX = 10_000; // limit: fixed — what the door will read before `issueTitle` bounds it to Linear's 255

/** True when the request is for this module. Used by server.ts's management gate so a non-`user` credential gets the uniform 403. */
export function isTrackerIssueRoute(key: string): boolean {
  return TRACKER_ISSUE_ROUTE.test(key);
}

type Audit = (kind: string, tool: string, ok: boolean, meta: Record<string, unknown>) => Promise<void>;

export interface TrackerIssueDeps {
  queries: QueryStore;
  /** The reconciler's bridge — the note is read to name the task. Absent → `503`. */
  vault?: VaultClient | undefined;
  /** Opens the connection the Linear sync reads (`instanceSyncOpener`). Absent → `503`: no instance, no connections. */
  openTracker?: SyncOpener | undefined;
  audit: Audit;
  /** Sends in flight, by issue id — two presses racing share one call. */
  inflight: Map<string, Promise<CreateIssueResult>>;
  now?: (() => Date) | undefined;
  timeZone?: string | undefined;
}

const fail = (code: ErrorCode, message: string): Answer => ({ status: statusFor(code), body: errorEnvelope(code, message) });

/** What this door says about the line it read: the facts the Link door will need, and the refs it carries. */
function lineView(path: string, t: LocatedTaskLine) {
  return { path, task_key: t.task_key, anchor: t.parsed.anchor, line_no: t.line_no, text: t.parsed.text, checked: t.parsed.checked, ext_refs: t.parsed.ext_refs };
}

export async function trackerIssueRoute(req: IncomingMessage, res: ServerResponse, key: string, deps: TrackerIssueDeps): Promise<void> {
  const m = TRACKER_ISSUE_ROUTE.exec(key)!;
  let connection: string;
  try {
    connection = decodeURIComponent(m[1]!);
  } catch {
    return sendJson(res, 400, errorEnvelope("invalid_request", "the connection name is not valid percent-encoding"));
  }
  if (!CONNECTION_NAME_RE.test(connection)) return sendJson(res, 400, errorEnvelope("invalid_request", "the connection is named as `metistry connections list` names it (lowercase, digits, dashes)"));

  let body: Record<string, unknown>;
  try {
    const raw = await readJson(req);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return sendJson(res, 400, errorEnvelope("invalid_request", "body must be a JSON object: {task_key, title?, team?}"));
    body = raw as Record<string, unknown>;
  } catch {
    return sendJson(res, 400, errorEnvelope("invalid_request", "request body is not JSON"));
  }
  const unknown = Object.keys(body).filter((k) => !BODY_FIELDS.includes(k));
  if (unknown.length > 0) return sendJson(res, 400, errorEnvelope("invalid_request", `unknown field${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")} — the body is {task_key, title?, team?} and, where a key names two notes, path`));
  if (typeof body.task_key !== "string" || !TASK_KEY_RE.test(body.task_key)) return sendJson(res, 400, errorEnvelope("invalid_request", "task_key is the row's key exactly as GET /api/today returns it — an anchor (`mt-…`) or a hash key (`h:<sha256>:<n>`)"));
  if (body.title !== undefined && body.title !== null && (typeof body.title !== "string" || body.title.length > TITLE_MAX)) return sendJson(res, 400, errorEnvelope("invalid_request", "title, when given, is a string — the issue's title in place of the line's text"));
  if (body.team !== undefined && body.team !== null && (typeof body.team !== "string" || !TEAM_KEY_RE.test(body.team))) return sendJson(res, 400, errorEnvelope("invalid_request", "team, when given, is a Linear team key (ENG) — one the answer listed"));
  if (body.path !== undefined && (typeof body.path !== "string" || body.path === "")) return sendJson(res, 400, errorEnvelope("invalid_request", "path, when given, is the note's vault path as the row names it"));
  const taskKey = body.task_key;
  const wantTitle = typeof body.title === "string" ? body.title : undefined;
  const team = typeof body.team === "string" ? body.team : undefined;
  const wantPath = body.path as string | undefined;

  const answer = await send(connection, taskKey, wantTitle, team, wantPath, deps);
  return sendJson(res, answer.status, answer.body);
}

async function send(connection: string, taskKey: string, wantTitle: string | undefined, team: string | undefined, wantPath: string | undefined, deps: TrackerIssueDeps): Promise<Answer> {
  let secrets: string[] = [];
  const audited: Audited = async (ok, outcome, answer) => {
    // the connection, the key, the issue and the outcome — never the path or the text
    const issue = (answer.body as { key?: unknown }).key;
    await deps.audit("tracker", "issue_create", ok, { connection, task_key: taskKey, ...(typeof issue === "string" ? { key: issue } : {}), outcome, ...(secrets.length > 0 ? { [SECRET_USE_META_KEY]: secrets } : {}) });
    return answer;
  };

  // the connection first: nothing is read for a tracker this console cannot reach
  if (!deps.openTracker) return fail("not_available", "no connections in this deployment — METISTRY_INSTANCE_DIR is unset, so there is no tracker to send to (docs/ops/connections.md, Linear)");
  const opened = await deps.openTracker({ sync: LINEAR_SYNC, origin: LINEAR_ORIGIN, module: LINEAR_MODULE });
  if (!opened.ok) return fail("not_available", `no Linear connection to send to: ${opened.why}`);
  const sync = opened.sync;
  if (sync.connection !== connection) return fail("not_found", `no tracker connection ${connection} — Send to Linear files through ${sync.connection}, the connection the Linear sync reads`);
  if (!sync.capabilities.includes(TRACKER_CREATE_CAPABILITY)) {
    return audited(false, "no_capability", fail("forbidden", `connection ${connection}'s provider ${sync.provider} does not declare \`${TRACKER_CREATE_CAPABILITY}\` — it cannot file issues`));
  }

  // the task, as the note has it now (no seen_text: nothing of the note is written here)
  const f = await findLine(taskKey, null, wantPath, deps, audited, lineView, "sending");
  if (!f.ok) return f.answer;
  const { path, line } = f;
  if (line.parsed.recurrence) return audited(false, "rule", fail("invalid_request", "the line is a recurrence rule, which is never itself a task — send the day's instance instead"));
  const linked = line.parsed.ext_refs.find((r) => r.toLowerCase().startsWith("linear:"));
  if (linked) {
    return audited(false, "stale", {
      status: statusFor("conflict"),
      body: { ...errorEnvelope("conflict", `the line already carries ${linked} — its issue exists`), reason: "stale", line: line.line, task: lineView(path, line) },
    });
  }
  const title = issueTitle(wantTitle ?? line.parsed.text);
  if (title === "") return audited(false, "no_title", fail("invalid_request", "the task has no text to title an issue with — send title"));

  const id = trackerIssueId(sync.connection, path, taskKey);
  let result: CreateIssueResult;
  try {
    let running = deps.inflight.get(id);
    if (!running) {
      running = createLinearIssue(sync, { id, title, team });
      deps.inflight.set(id, running);
      running.finally(() => deps.inflight.delete(id)).catch(() => undefined);
    }
    result = await running;
  } catch (err) {
    secrets = sync.secretsUsed();
    if (err instanceof LinearError) {
      if (err.code === "rate_limited") return audited(false, err.code, fail("rate_limited", `${err.message} — nothing was filed; try again shortly`));
      return audited(false, err.code, fail("not_available", `${err.message} — nothing was filed that this door can find; sending again is safe`));
    }
    if (err instanceof ConnectionRefused) return audited(false, err.code, fail("not_available", err.message));
    throw err;
  }
  secrets = sync.secretsUsed();
  if (!result.ok) {
    const why = result.reason === "unknown_team" ? `${team} is not one of your Linear teams` : result.teams.length === 0 ? "your Linear key's user is in no team" : "you are in several Linear teams — send team";
    return audited(false, result.reason, { status: statusFor("invalid_request"), body: { ...errorEnvelope("invalid_request", `${why}; nothing was filed`), reason: result.reason, teams: result.teams } });
  }
  const issue = result.issue;
  return audited(true, result.created ? "created" : "replayed", {
    status: result.created ? 201 : 200,
    body: { ok: true, connection: sync.connection, key: issue.key, ref: linearRef(issue.key), url: issue.url, created: result.created, title: issue.title, task_key: taskKey, path },
  });
}
