// The owner's pull request doors (design-build-plan §2.1, §2.11, §2.12;
// ticket T2-13; R6):
//
//   POST /api/github/pulls/:owner/:repo/:number/review                {event, body?, head_sha}
//   POST /api/github/pulls/:owner/:repo/:number/threads/:id/reply     {body, head_sha}
//   POST /api/github/pulls/:owner/:repo/:number/threads/:id/resolve   {head_sha}
//
// A pull request request's answers (§2.12: Approve, Request Changes, Reply)
// are not decisions on the request row: they post to GitHub, as the owner,
// through the owner-only client holding `github_write` (github-write.ts).
//
// **The head SHA shown must match** — enforced here, before anything is
// posted, never asked of a client:
//
//   * `head_sha` is required, and is the full 40-character SHA (core's
//     `isHeadSha`) — a door that reviewed whatever the head is now would
//     review commits the owner never saw. No SHA, nothing is posted.
//   * The door reads the PR (or the thread's PR) from GitHub itself, and a
//     head that is not the one shown — or a PR no longer open — is
//     `409 stale` with the head as it stands, and nothing is posted. A review
//     is also pinned to that commit (`commit_id`), so GitHub refuses it if
//     the PR moves between the check and the post.
//   * A thread must belong to the PR in the path; one that does not is
//     `404`, and nothing is posted.
//
// **What a landed review settles.** Approve and Request Changes are §2.12's
// answers to the request: the waiting `pull_request` request for this PR is
// recorded as the owner's decision (`allow`, or `accept_with_changes` with
// their words — core's `PR_REVIEW_DECISION`), with the review it posted and
// the head it was for, so the GitHub sync does not ask again for that head. A
// comment, a reply or a resolved thread posts and leaves the request waiting.
//
// **C45.** A post GitHub refused, or one that could not be sent, leaves the
// request pending with `payload.error` saying why (door `pr_review`); a stale
// answer is not a failed one and writes nothing on the row — the body says
// what the PR is now, and the client repaints.
//
// Reached only by the owner: server.ts's gate refuses an agent bearer and the
// capture owner token before this runs, and the handler asks `may()` again
// itself (U3). Nothing here is on the MCP mount.

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  GITHUB_SOURCE_KIND,
  GITHUB_WRITE_SECRET,
  PR_REVIEW_DECISION,
  PR_REVIEW_EVENTS,
  PR_REVIEW_GITHUB_EVENT,
  SECRET_USE_META_KEY,
  errorEnvelope,
  githubPullRef,
  isHeadSha,
  may,
  parseGithubRepo,
  statusFor,
  type ErrorCode,
  type PrReviewEvent,
  type Principal,
} from "@foldedspacelabs/metistry-core";
import { readJson, sendError, sendJson, sendRefusal } from "./http-util.js";
import { GithubWriteError, type GithubWriteClient } from "./github-write.js";

/** `POST /api/github/pulls/:owner/:repo/:number/review` and `…/threads/:id/{reply,resolve}` — the route key, method and path. */
export const GITHUB_PULL_ROUTE = /^POST \/api\/github\/pulls\/([^/]+)\/([^/]+)\/([^/]+)\/(?:(review)|threads\/([^/]+)\/(reply|resolve))$/;

export const isGithubPullRoute = (key: string): boolean => GITHUB_PULL_ROUTE.test(key);

/** A review or a reply as GitHub takes it — its own limit. */
const BODY_CHARS = 65_536;
/** A review thread's GraphQL node id (`PRRT_kwDO…`): what the sync collected and the thread doors take. */
const THREAD_ID_RE = /^[A-Za-z0-9_=-]{1,200}$/;
const NUMBER_RE = /^[1-9][0-9]{0,9}$/;

type Audit = (kind: string, tool: string, ok: boolean, meta: Record<string, unknown>) => Promise<void>;

export interface GithubPullDb {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

export interface GithubPullDeps {
  db: GithubPullDb;
  /** the owner's GitHub client; absent = this console cannot post (503) */
  github?: GithubWriteClient | undefined;
  audit: Audit;
}

const NOT_AVAILABLE = `posting to GitHub needs the owner's ${GITHUB_WRITE_SECRET} client, and this console was started without one (docs/ops/client-api.md, Pull requests)`;

type Action = "review" | "reply" | "resolve";

interface Parsed {
  repo: string;
  number: number;
  action: Action;
  thread: string | null;
  head: string;
  event: PrReviewEvent | null;
  body: string;
}

const FIELDS: Readonly<Record<Action, readonly string[]>> = {
  review: ["event", "body", "head_sha"],
  reply: ["body", "head_sha"],
  resolve: ["head_sha"],
};

/** The path and body, checked whole — or the one sentence that says what is wrong. Nothing is read from GitHub until this passes. */
function parse(key: string, raw: unknown): { ok: true; value: Parsed } | { ok: false; message: string } {
  const m = GITHUB_PULL_ROUTE.exec(key)!;
  let owner: string, name: string, thread: string | null;
  try {
    owner = decodeURIComponent(m[1]!);
    name = decodeURIComponent(m[2]!);
    thread = m[5] !== undefined ? decodeURIComponent(m[5]) : null;
  } catch {
    return { ok: false, message: "the path is not valid percent-encoding" };
  }
  const repo = `${owner}/${name}`;
  if (!parseGithubRepo(repo)) return { ok: false, message: `${JSON.stringify(repo)} is not a GitHub repository (owner/name)` };
  if (!NUMBER_RE.test(m[3]!)) return { ok: false, message: `${JSON.stringify(m[3])} is not a pull request number` };
  if (thread !== null && !THREAD_ID_RE.test(thread)) return { ok: false, message: "the thread id is a review thread's node id, as the request's threads carry it (PRRT_…)" };
  const action: Action = m[4] === "review" ? "review" : (m[6] as "reply" | "resolve");

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, message: `the body is an object: {${FIELDS[action].join(", ")}}` };
  const b = raw as Record<string, unknown>;
  const unknown = Object.keys(b).filter((k) => !FIELDS[action].includes(k));
  if (unknown.length > 0) return { ok: false, message: `unknown field${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")} — the body is {${FIELDS[action].join(", ")}}` };
  // the ticket's own: nothing is posted without the head the owner was shown
  if (b.head_sha === undefined || b.head_sha === null || b.head_sha === "") {
    return { ok: false, message: "head_sha is required — the pull request's head as the owner was shown it (the request's payload.head_sha); nothing is posted to a pull request without it" };
  }
  if (!isHeadSha(b.head_sha)) return { ok: false, message: "head_sha is the full 40-character lowercase commit SHA the owner was shown, never an abbreviation" };

  let event: PrReviewEvent | null = null;
  if (action === "review") {
    if (!(PR_REVIEW_EVENTS as readonly unknown[]).includes(b.event)) return { ok: false, message: `event is one of ${PR_REVIEW_EVENTS.join(" | ")}` };
    event = b.event as PrReviewEvent;
  }
  if (b.body !== undefined && typeof b.body !== "string") return { ok: false, message: "body is a string" };
  const body = typeof b.body === "string" ? b.body : "";
  if (body.length > BODY_CHARS) return { ok: false, message: `body is at most ${BODY_CHARS} characters` };
  const needsWords = action === "reply" || event === "request_changes" || event === "comment";
  if (needsWords && body.trim() === "") return { ok: false, message: action === "reply" ? "a reply needs its words — body is required" : `${event === "comment" ? "a comment" : "Request Changes"} needs its words — body is required` };
  return { ok: true, value: { repo, number: Number(m[3]), action, thread, head: b.head_sha, event, body } };
}

/** The verb a C45 record and the audit name the answer by: §2.12's stored answer where the action has one. */
function verbOf(p: Parsed): string {
  return p.event ? (PR_REVIEW_DECISION[p.event] ?? `review_${p.event}`) : p.action;
}

export async function githubPullRoute(req: IncomingMessage, res: ServerResponse, key: string, deps: GithubPullDeps, principal: Principal): Promise<void> {
  // A code path, not a sentence (U3): whatever server.ts's gate did first,
  // no credential but the owner's posts as the owner.
  const owner = may(principal, "act", { kind: "console", door: "console_management", route: key });
  if (!owner.ok) {
    await deps.audit("github", "pr_review", false, { refused: owner.reason });
    return sendRefusal(res, owner);
  }
  let raw: unknown;
  try {
    raw = await readJson(req);
  } catch {
    return sendError(res, "invalid_request", "the body must be JSON");
  }
  const parsed = parse(key, raw);
  if (!parsed.ok) return sendError(res, "invalid_request", parsed.message);
  const p = parsed.value;
  const tool = p.action === "review" ? "pr_review" : `pr_thread_${p.action}`;
  const where = { repo: p.repo, number: p.number, ...(p.thread ? { thread: p.thread } : {}), ...(p.event ? { event: p.event } : {}) };
  let sent = false;
  const audited = (ok: boolean, meta: Record<string, unknown>) => deps.audit("github", tool, ok, { ...where, ...meta, ...(sent ? { [SECRET_USE_META_KEY]: [GITHUB_WRITE_SECRET] } : {}) });

  const refused = async (code: ErrorCode, message: string) => {
    await recordRefusal(deps.db, p, code, message);
    await audited(false, { error: code });
    return sendError(res, code, message);
  };
  if (!deps.github) return refused("not_available", NOT_AVAILABLE);
  const github = deps.github;

  try {
    if (p.action === "review") {
      const pull = await github.pull(p.repo, p.number);
      sent = true;
      if (pull.state !== "open" || pull.head_sha !== p.head) {
        await audited(false, { stale: true, state: pull.state });
        return stale(res, p, { head_sha: pull.head_sha, state: pull.merged ? "merged" : pull.state });
      }
      const review = await github.review(p.repo, p.number, { commit_id: p.head, event: PR_REVIEW_GITHUB_EVENT[p.event!], body: p.body });
      const settled = await settle(deps.db, p, { id: review.id, url: review.url });
      await audited(true, { review_id: review.id, ...(settled !== null ? { settled } : {}) });
      return sendJson(res, 201, { ok: true, review_id: review.id, url: review.url, head_sha: p.head });
    }

    const thread = await github.thread(p.thread!);
    sent = true;
    if (!thread || thread.repo.toLowerCase() !== p.repo.toLowerCase() || thread.number !== p.number) {
      await audited(false, { error: "not_found" });
      return sendError(res, "not_found", `no review thread ${p.thread} on ${p.repo}#${p.number} — nothing was posted`);
    }
    if (thread.state !== "OPEN" || thread.head_sha !== p.head) {
      await audited(false, { stale: true, state: thread.state.toLowerCase() });
      return stale(res, p, { head_sha: thread.head_sha, state: thread.state.toLowerCase() });
    }
    if (p.action === "reply") {
      const reply = await github.replyToThread(thread.id, p.body);
      await audited(true, { comment_id: reply.comment_id });
      return sendJson(res, 201, { ok: true, comment_id: reply.comment_id, thread_id: thread.id, url: reply.url });
    }
    const r = await github.resolveThread(thread.id);
    await audited(true, { resolved: r.resolved });
    return sendJson(res, 200, { ok: true, thread_id: thread.id, resolved: r.resolved });
  } catch (err) {
    if (err instanceof GithubWriteError) {
      sent = sent || err.sent;
      return refused(err.code, err.message);
    }
    // Threw: the row says `internal` and nothing more; the detail is the log's.
    await recordRefusal(deps.db, p, "internal", "the pull request could not be posted to; the detail is in the console log").catch(() => undefined);
    await audited(false, { error: "internal" }).catch(() => undefined);
    throw err;
  }
}

/** `409 stale`: the PR is not the one the owner was shown. Nothing was posted, and nothing is written on the request (a stale answer is not a failed one). */
function stale(res: ServerResponse, p: Parsed, now: { head_sha: string; state: string }): void {
  const moved = now.state !== "open" ? `${p.repo}#${p.number} is ${now.state}` : `${p.repo}#${p.number} has moved to ${now.head_sha.slice(0, 12)} since the head you were shown (${p.head.slice(0, 12)})`;
  sendJson(res, statusFor("conflict"), { ...errorEnvelope("conflict", `${moved} — nothing was posted; look again at what it is now`), reason: "stale", pull: { repo: p.repo, number: p.number, ...now } });
}

/**
 * A landed Approve or Request Changes answers the PR's waiting request —
 * the owner's decision, with the review it posted and the head it was for
 * (`payload.review.head_sha`, which the sync reads before it asks again).
 * Returns the id it settled, or null (nothing was waiting, or a comment).
 */
async function settle(db: GithubPullDb, p: Parsed, review: { id: number; url: string | null }): Promise<number | null> {
  const decision = p.event ? PR_REVIEW_DECISION[p.event] : null;
  if (decision === null) return null;
  const { rows } = await db.query(
    `UPDATE proposals SET decision = $3, feedback = $4, decided_at = now(), snoozed_until = NULL,
       payload = (payload - 'error') || jsonb_build_object('review', $5::jsonb)
     WHERE decision = 'pending' AND kind = 'pull_request' AND source IS NOT NULL AND source->>'kind' = $1 AND source->>'external_ref' = $2
     RETURNING id`,
    [
      GITHUB_SOURCE_KIND,
      githubPullRef(p.repo, p.number),
      decision,
      p.body.trim() === "" ? null : p.body,
      JSON.stringify({ id: review.id, url: review.url, event: p.event, head_sha: p.head, at: new Date().toISOString() }),
    ],
  );
  return rows[0] ? Number(rows[0].id) : null;
}

/** C45: the waiting request for this PR carries why the post did not happen (pending rows only). */
async function recordRefusal(db: GithubPullDb, p: Parsed, code: ErrorCode, message: string): Promise<void> {
  const error = { code, message, decision: verbOf(p), door: "pr_review", action: p.action, ...(p.event ? { event: p.event } : {}), ...(p.thread ? { thread: p.thread } : {}), at: new Date().toISOString() };
  await db.query(
    `UPDATE proposals SET payload = payload || jsonb_build_object('error', $3::jsonb)
     WHERE decision = 'pending' AND kind = 'pull_request' AND source IS NOT NULL AND source->>'kind' = $1 AND source->>'external_ref' = $2`,
    [GITHUB_SOURCE_KIND, githubPullRef(p.repo, p.number), JSON.stringify(error)],
  );
}
