// linear: reconcile the Linear issues assigned to the owner into `work`, and
// mirror each newly assigned one into Needs You as a `task` request (plan
// §2.6, §4 Q22; T4-24) — what `github-state` does for GitHub.
//
// Status comes from Linear, never invented (§4.8):
//
//   * every open issue assigned to the key's own user is one `work` row,
//     `external_ref linear:<KEY>`, kind `issue`, with its state, priority and
//     url in `meta` (and `meta.connection`, so two Linear connections never
//     close each other's rows);
//   * an issue that leaves the list — closed, or given to someone else — is
//     looked up once by id, its row closed with what became of it
//     (`meta.closed_reason`: completed · canceled · unassigned · gone), and
//     its request resolved at source (core's `resolveAtSource`) with a
//     receipt naming what became of it (*Completed in Linear*);
//   * with `syncs.linear.raise.assigned` on (the default), an issue with no
//     request yet — or whose last one its source resolved, i.e. it was
//     closed or unassigned and is back — raises one `task` mirror (core's
//     `raiseMirror`: one subject, one row). One the owner answered is not
//     raised again while the assignment lasts.
//
// **What it may reach** is decided by `packages/connections`, not here: the
// collector asks the console's opener for the connection the `linear` sync
// reads, and gets a `fetch` pinned to https://api.linear.app that fills the
// key at the egress door for that host only and follows no redirect
// (`openSyncHttp`). The Linear client sends read queries and nothing else.
// No path of this collector writes a vault file: Add to Today is the owner's
// press, through the capture service (`today.ts`).
//
// Degrades absent: no opener (a console without an instance), or no Linear
// connection yet, is 0 rows and no error. A connection that is there but
// cannot be read (another host, a secret the door refuses, a key Linear
// refuses) fails the run with the reason — redacted, because everything the
// door returns already is.

import { RESOLVED_AT_SOURCE, lastMirror, raiseMirror, resolveAtSource } from "@foldedspacelabs/metistry-core";
import {
  LINEAR_CLOSED_STATE_TYPES,
  LINEAR_MODULE,
  LINEAR_ORIGIN,
  LINEAR_SYNC,
  assignedOpenIssues,
  issuesById,
  linearRef,
  type LinearIssue,
  type SyncOpener,
} from "@foldedspacelabs/metistry-connections";

export interface Db {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

export interface LinearCtx {
  /** the console's opener (`instanceSyncOpener`); absent = no instance to read a connection from */
  openSync?: SyncOpener | undefined;
}

/** This collector's name — the `source_agent` of every request it raises. */
export const COMPONENT = "linear";
/** `proposals.source.kind` of its mirrors: the source system, which Needs You's *From* filter names. */
export const SOURCE_KIND = "linear";
/** The request kind it raises (§2.12's `task` row). */
export const REQUEST_KIND = "task";
/** `payload.event` — what raised the request, for a client drawing it. */
export const ASSIGNED_EVENT = "linear_assigned";
/**
 * The manifest's `needs_you` defaults, which apply where the owner's
 * `scheduled.yaml` says nothing. A test holds this to `manifest.yaml`, so
 * the two cannot drift.
 */
export const RAISE_DEFAULTS: Readonly<Record<"assigned", boolean>> = { assigned: true };

const EXCERPT_CHARS = 280; // limit: fixed — the request body is an excerpt (§2.12); the issue itself is one click away

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** What `work.meta` records for one issue. Names and labels only — the description stays in Linear. */
export function workMeta(issue: LinearIssue, connection: string): Record<string, unknown> {
  return {
    connection,
    id: issue.id,
    key: issue.key,
    url: issue.url,
    state: issue.state.name,
    state_type: issue.state.type,
    priority: issue.priority,
    priority_label: issue.priorityLabel,
    team: issue.team.key,
  };
}

/** The request a newly assigned issue raises. */
export function assignedPayload(issue: LinearIssue, connection: string): Record<string, unknown> {
  const excerpt = (issue.description ?? "").replace(/\s+/g, " ").trim();
  return {
    title: `${issue.key} · ${issue.title}`,
    body: clip(excerpt || issue.title, EXCERPT_CHARS),
    event: ASSIGNED_EVENT,
    connection,
    key: issue.key,
    url: issue.url,
    state: issue.state.name,
    priority: issue.priorityLabel,
    team: issue.team.name || issue.team.key,
  };
}

/** The receipt a clear writes (core's `resolveAtSource`, T4-23): what became of the issue, in Linear. */
export function clearedReceipt(reason: string): string {
  switch (reason) {
    case "completed":
      return "Completed in Linear";
    case "canceled":
      return "Canceled in Linear";
    case "unassigned":
      return "Assigned to someone else in Linear";
    case "gone":
      return "No longer in Linear";
    default:
      return `Closed in Linear (${reason})`;
  }
}

/** Why an issue left the owner's list, from what Linear says of it now (null: it has not left). */
export function closedReason(now: LinearIssue | undefined): string | null {
  if (!now) return "gone";
  if (LINEAR_CLOSED_STATE_TYPES.includes(now.state.type)) return now.state.type;
  if (!now.assignedToMe) return "unassigned";
  return null;
}

/** One reconcile pass. Returns rows upserted + closed. */
export async function run(db: Db, ctx: LinearCtx = {}): Promise<number> {
  if (!ctx.openSync) return 0; // degrades absent
  const opened = await ctx.openSync({ sync: LINEAR_SYNC, origin: LINEAR_ORIGIN, module: LINEAR_MODULE });
  if (!opened.ok) {
    if (opened.status === "absent") return 0;
    throw new Error(`linear: ${opened.why}`);
  }
  const sync = opened.sync;
  const raiseAssigned = Object.hasOwn(sync.raise, "assigned") ? sync.raise.assigned === true : RAISE_DEFAULTS.assigned;

  const issues = await assignedOpenIssues(sync);
  let touched = 0;
  const refs: string[] = [];
  for (const issue of issues) {
    const ref = linearRef(issue.key);
    refs.push(ref);
    const { rows } = await db.query(
      `INSERT INTO work (title, area, kind, status, external_ref, owner, due, updated_at, meta)
       VALUES ($1, $2, 'issue', 'open', $3, $4, $5, $6, $7)
       ON CONFLICT (external_ref) WHERE external_ref IS NOT NULL DO UPDATE SET
         title = EXCLUDED.title, area = EXCLUDED.area, kind = 'issue', status = 'open', owner = EXCLUDED.owner,
         due = EXCLUDED.due, updated_at = EXCLUDED.updated_at, meta = coalesce(work.meta, '{}'::jsonb) - 'closed_reason' || EXCLUDED.meta
       RETURNING id`,
      [issue.title, issue.team.key, ref, issue.assignee, issue.dueDate, issue.updatedAt, JSON.stringify(workMeta(issue, sync.connection))],
    );
    touched++;
    if (!raiseAssigned) continue;
    const source = { kind: SOURCE_KIND, external_ref: ref, person: issue.creator };
    const last = await lastMirror(db, source);
    if (last && last.decision !== RESOLVED_AT_SOURCE) continue; // waiting, or answered: once per assignment
    await raiseMirror(db, {
      kind: REQUEST_KIND,
      source_agent: COMPONENT,
      trust: "external", // the words are Linear's, not the owner's or the assistant's
      source,
      payload: assignedPayload(issue, sync.connection),
      work_id: rows[0] ? Number(rows[0].id) : null,
    });
  }

  // what this connection tracked and Linear no longer lists as the owner's
  const left = await db.query(
    `SELECT id, external_ref, meta->>'id' AS linear_id FROM work
     WHERE external_ref LIKE 'linear:%' AND status <> 'closed' AND meta->>'connection' = $1 AND NOT (external_ref = ANY($2::text[]))`,
    [sync.connection, refs],
  );
  const leaving = left.rows as { id: number | string; external_ref: string; linear_id: string | null }[];
  if (leaving.length === 0) return touched;
  const ids = leaving.map((r) => r.linear_id).filter((v): v is string => typeof v === "string" && v !== "");
  const now = new Map((ids.length > 0 ? await issuesById(sync, ids) : []).map((i) => [i.id, i]));
  for (const row of leaving) {
    const issue = row.linear_id ? now.get(row.linear_id) : undefined;
    const reason = closedReason(issue);
    if (reason === null) continue; // assigned and open after all (it moved between the two reads): the next pass sees it
    const patch: Record<string, unknown> = { closed_reason: reason, ...(issue ? { state: issue.state.name, state_type: issue.state.type, url: issue.url } : {}) };
    await db.query(`UPDATE work SET status = 'closed', updated_at = now(), meta = coalesce(meta, '{}'::jsonb) || $2::jsonb WHERE id = $1`, [row.id, JSON.stringify(patch)]);
    await resolveAtSource(db, { kind: SOURCE_KIND, external_ref: row.external_ref }, clearedReceipt(reason));
    touched++;
  }
  return touched;
}
