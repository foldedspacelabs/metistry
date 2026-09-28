// Send to Linear — a task becomes an issue (plan §2.1, §2.6; T4-25).
//
// The service behind `POST /api/trackers/:connection/issues`: given the
// connection a Linear sync reads (`openSyncHttp` — pinned to
// `https://api.linear.app`, the key filled at the egress door for that host
// only, never on a URL), file one issue, **idempotent by task key**, with no
// state of its own:
//
//   * **The issue's id is the task's.** `trackerIssueId` derives a UUID from
//     the connection, the note and the task key, and the issue is created
//     with that id (Linear's `IssueCreateInput.id`). So the same task always
//     names the same issue: before anything is created the id is looked up,
//     and a task already sent answers the issue it made — `created: false`,
//     nothing sent but reads. Two sends racing, or a create whose answer was
//     lost, meet at Linear: the second create is refused there (the id is
//     taken), the id is looked up again, and that issue is the answer. Git
//     stays the record (invariant 1) — once the line is linked it says which
//     issue; until then the id does.
//   * **One fixed mutation.** `ISSUE_CREATE_MUTATION` is the only document
//     this module can change Linear with, and it carries three inputs: the
//     id, the team, the title. No description, no assignee, no label — the
//     task's text is its title and nothing else of the owner's note leaves.
//   * **The team is the owner's.** Named in the request, or the key's user's
//     only team; with several and none named, nothing is created and the
//     answer lists them to choose from (`team_required`).
//
// Pure over a `fetch`: no Postgres, no vault (the dependency arrow). The
// door that calls it, and writes nothing, is the console's
// (`apps/console/src/tracker-issue-route.ts`); linking the line is the other
// door (`POST /api/vault-tasks/:task_key/link`).

import { createHash } from "node:crypto";
import { ConnectionRefused } from "./errors.js";
import { ISSUE_FIELDS, LinearError, issuesById, linearQuery, readIssue, sendLinearDocument, type LinearIssue } from "./linear.js";
import type { SyncHttp } from "./sync.js";

/** The `tracker` capability a provider declares to be filed into (core's CONNECTION_CAPABILITIES). */
export const TRACKER_CREATE_CAPABILITY = "create";

/** The owner's teams — where an issue may be filed. */
export const VIEWER_TEAMS_QUERY = `query MetistryViewerTeams {
  viewer { teams(first: 100) { nodes { id key name } } }
}`;

/** The one document this module changes Linear with (module header). */
export const ISSUE_CREATE_MUTATION = `mutation MetistryIssueCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) { success issue { ${ISSUE_FIELDS} } }
}`;

/** Linear's title bound; a longer task line is clipped, never refused. */
export const ISSUE_TITLE_MAX = 255; // limit: fixed — Linear's own title length

/** A team key as Linear spells it (the `ENG` of `ENG-123`). */
const TEAM_KEY_RE = /^[A-Z][A-Z0-9]{0,9}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * The issue id a task is filed under: a v4-shaped UUID from a SHA-256 over
 * the connection, the note and the task key — so a retry, a second press or a
 * second client names the same issue, and the same words in another note (the
 * same hash key) do not.
 */
export function trackerIssueId(connection: string, path: string, taskKey: string): string {
  const h = createHash("sha256").update(`metistry/tracker-issue/v1\0${connection}\0${path}\0${taskKey}`).digest();
  h[6] = (h[6]! & 0x0f) | 0x40;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

/** A task's text as an issue title: one line, no control characters, bounded. Empty stays empty — the caller refuses it. */
export function issueTitle(text: string): string {
  const one = text
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return one.length > ISSUE_TITLE_MAX ? `${one.slice(0, ISSUE_TITLE_MAX - 1)}…` : one;
}

export interface LinearTeam {
  id: string;
  key: string;
  name: string;
}

/** The teams the key's own user is in. */
export async function viewerTeams(sync: Pick<SyncHttp, "fetch" | "headers">): Promise<LinearTeam[]> {
  const data: { viewer?: { teams?: { nodes?: { id?: unknown; key?: unknown; name?: unknown }[] } } } = await linearQuery(sync, VIEWER_TEAMS_QUERY);
  const nodes = data.viewer?.teams?.nodes;
  if (!Array.isArray(nodes)) throw new LinearError("bad_response", "viewer.teams is missing");
  const out: LinearTeam[] = [];
  for (const n of nodes) {
    if (typeof n.id !== "string" || typeof n.key !== "string" || !TEAM_KEY_RE.test(n.key)) throw new LinearError("bad_response", "a team without an id or a key");
    out.push({ id: n.id, key: n.key, name: typeof n.name === "string" ? n.name : "" });
  }
  return out;
}

export interface CreateIssueRequest {
  /** `trackerIssueId(…)` — the task's issue */
  id: string;
  /** the title, as `issueTitle` makes it */
  title: string;
  /** a team key (`ENG`); absent = the owner's only team */
  team?: string | undefined;
}

export type CreateIssueResult =
  | { ok: true; created: boolean; issue: LinearIssue }
  /** nothing was created: no team named and the owner has several (or none), or the named one is not theirs */
  | { ok: false; reason: "team_required" | "unknown_team"; teams: { key: string; name: string }[] };

/** The issue filed under `id`, as Linear has it now — archived ones too — or null. */
async function issueWithId(sync: Pick<SyncHttp, "fetch" | "headers">, id: string): Promise<LinearIssue | null> {
  return (await issuesById(sync, [id])).find((i) => i.id === id) ?? null;
}

/**
 * File the task's issue, or answer the one already filed under its id
 * (module header). Every failure is a `LinearError` or a `ConnectionRefused`
 * — nothing half-done is hidden: a create Linear may have landed is looked up
 * before its failure is believed.
 */
export async function createLinearIssue(sync: Pick<SyncHttp, "fetch" | "headers">, req: CreateIssueRequest): Promise<CreateIssueResult> {
  if (!UUID_RE.test(req.id)) throw new TypeError("id must be trackerIssueId(…) — a v4-shaped UUID");
  if (req.title === "" || req.title.length > ISSUE_TITLE_MAX || /[\u0000-\u001f\u007f]/.test(req.title)) throw new TypeError("title must be issueTitle(…) of the task's text — one line, 1–255 characters");
  if (req.team !== undefined && !TEAM_KEY_RE.test(req.team)) throw new TypeError("team is a Linear team key (ENG)");

  const prior = await issueWithId(sync, req.id);
  if (prior) return { ok: true, created: false, issue: prior };

  const teams = await viewerTeams(sync);
  const listed = teams.map((t) => ({ key: t.key, name: t.name }));
  const team = req.team !== undefined ? teams.find((t) => t.key === req.team) : teams.length === 1 ? teams[0] : undefined;
  if (!team) return { ok: false, reason: req.team !== undefined ? "unknown_team" : "team_required", teams: listed };

  try {
    const data: { issueCreate?: { success?: unknown; issue?: Parameters<typeof readIssue>[0] | null } } = await sendLinearDocument(sync, ISSUE_CREATE_MUTATION, {
      input: { id: req.id, teamId: team.id, title: req.title },
    });
    if (data.issueCreate?.success !== true || !data.issueCreate.issue) throw new LinearError("bad_response", "issueCreate did not succeed");
    const issue = readIssue(data.issueCreate.issue);
    if (issue.id !== req.id) throw new LinearError("bad_response", `issueCreate answered ${issue.key}, which is not the issue asked for`);
    return { ok: true, created: true, issue };
  } catch (err) {
    // A refusal before anything was sent, or one that says the key or the
    // rate was the problem, is believed as it stands. Anything else may have
    // landed — the id is taken, or the answer was lost — so ask Linear.
    if (err instanceof ConnectionRefused) throw err;
    if (err instanceof LinearError && (err.code === "unauthorized" || err.code === "rate_limited")) throw err;
    const landed = await issueWithId(sync, req.id).catch(() => null);
    if (landed) return { ok: true, created: false, issue: landed };
    throw err;
  }
}
