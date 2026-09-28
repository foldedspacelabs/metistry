// A pull request, spelled once (plan §2.11, §2.12; ticket T2-13).
//
// Three parts of the product meet over one pull request and must name it the
// same way, and apps never import each other (the dependency arrow):
//
//   * the `github-state` sync (collectors/) mirrors a PR waiting on the
//     owner's review into Needs You;
//   * an agent asks for the same review through `requests_create`
//     (packages/mcp-brain) — the same subject, so the database's one-pending-
//     row-per-subject index (0027) makes the two asks one card;
//   * the owner's PR doors (apps/console) post the review, and settle the
//     card they answered.
//
// So the subject's spelling, the secret the doors post with, the one host
// either side talks to, and the shape of a head SHA live here — data and pure
// functions, no GitHub client (each side holds its own, and only the
// console's may write).

import type { RequestSource } from "./mirrors.js";

/** The only origin either GitHub client reaches: the REST and GraphQL APIs both live here. */
export const GITHUB_API_ORIGIN = "https://api.github.com";

/** `proposals.source.kind` of a pull request's mirror — the source system Needs You's *From* filter names. */
export const GITHUB_SOURCE_KIND = "github";

/** The stored kind of a pull request request (core's type table, §2.12). */
export const PULL_REQUEST_KIND = "pull_request";

/**
 * The secret the owner's PR doors post with (§2.11, §3.4): a fine-grained PAT
 * with pull-request write, stored by the owner as `github_write`. It is the
 * owner's alone — no agent is granted it and no sync reads it; the collector
 * reads with its own read-only token.
 */
export const GITHUB_WRITE_SECRET = "github_write";

/** A review's verdict as a client sends it — the three GitHub has, in the product's spelling. */
export const PR_REVIEW_EVENTS = ["approve", "request_changes", "comment"] as const;
export type PrReviewEvent = (typeof PR_REVIEW_EVENTS)[number];

/** GitHub's own word for each verdict (`POST /repos/{o}/{r}/pulls/{n}/reviews`). */
export const PR_REVIEW_GITHUB_EVENT: Readonly<Record<PrReviewEvent, "APPROVE" | "REQUEST_CHANGES" | "COMMENT">> = {
  approve: "APPROVE",
  request_changes: "REQUEST_CHANGES",
  comment: "COMMENT",
};

/**
 * What a landed review stores on the request it answers (§2.12's answer set):
 * Approve is `allow`, Request Changes is Revise's `accept_with_changes` with
 * the owner's words. A comment is not one of the type's answers — it posts,
 * and the request keeps waiting.
 */
export const PR_REVIEW_DECISION: Readonly<Record<PrReviewEvent, "allow" | "accept_with_changes" | null>> = {
  approve: "allow",
  request_changes: "accept_with_changes",
  comment: null,
};

/**
 * A head SHA as the owner is shown it and as a door checks it: the full 40
 * lowercase hex characters of a commit, never an abbreviation. A short SHA is
 * what a person reads, but a door that accepted eight characters could be
 * made to review a commit someone ground out to share them.
 */
export const HEAD_SHA_RE = /^[0-9a-f]{40}$/;

export const isHeadSha = (v: unknown): v is string => typeof v === "string" && HEAD_SHA_RE.test(v);

/** A GitHub owner (user or organisation) and a repository name, as GitHub allows them. */
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;

/** `owner/name`, or undefined when either half is not one GitHub allows (`.` and `..` are not repository names). */
export function parseGithubRepo(repo: string): { owner: string; name: string } | undefined {
  const slash = repo.indexOf("/");
  if (slash === -1) return undefined;
  const owner = repo.slice(0, slash);
  const name = repo.slice(slash + 1);
  if (!OWNER_RE.test(owner) || !NAME_RE.test(name) || name === "." || name === "..") return undefined;
  return { owner, name };
}

/** The `external_ref` of a PR (and of an issue — one number space): `gh:owner/name#41`. The work row and the mirror both carry it. */
export function githubPullRef(repo: string, number: number): string {
  if (!parseGithubRepo(repo)) throw new TypeError(`${JSON.stringify(repo)} is not a GitHub repository (owner/name)`);
  if (!Number.isSafeInteger(number) || number < 1) throw new TypeError(`${JSON.stringify(number)} is not a pull request number`);
  return `gh:${repo}#${number}`;
}

/** `gh:owner/name#41` → its parts; undefined for anything else. */
export function parseGithubPullRef(ref: string): { repo: string; owner: string; name: string; number: number } | undefined {
  const m = /^gh:([^#\s]+)#([1-9][0-9]{0,9})$/.exec(ref);
  if (!m) return undefined;
  const parts = parseGithubRepo(m[1]!);
  const number = Number(m[2]);
  if (!parts || !Number.isSafeInteger(number)) return undefined;
  return { repo: m[1]!, ...parts, number };
}

/** What a PR's request mirrors: the PR, and who the source names (its author). */
export function githubPullSource(repo: string, number: number, person?: string | null): RequestSource {
  const external_ref = githubPullRef(repo, number);
  return person === undefined ? { kind: GITHUB_SOURCE_KIND, external_ref } : { kind: GITHUB_SOURCE_KIND, external_ref, person };
}
