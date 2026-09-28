// A pull request, spelled once (T2-13): the subject the sync, an agent's ask
// and the owner's doors all name, and the head SHA a door checks.
import { describe, expect, it } from "vitest";
import {
  GITHUB_SOURCE_KIND,
  PR_REVIEW_DECISION,
  PR_REVIEW_EVENTS,
  REQUEST_DECISIONS,
  describeRequest,
  githubPullRef,
  githubPullSource,
  isHeadSha,
  parseGithubPullRef,
  parseGithubRepo,
  parseRequestSource,
} from "../src/index.js";

describe("a pull request's subject", () => {
  it("is gh:owner/name#number — the work row's external_ref and the mirror's, one spelling", () => {
    expect(githubPullRef("foldedspacelabs/metistry", 41)).toBe("gh:foldedspacelabs/metistry#41");
    expect(githubPullSource("foldedspacelabs/metistry", 41, "dana")).toEqual({ kind: GITHUB_SOURCE_KIND, external_ref: "gh:foldedspacelabs/metistry#41", person: "dana" });
    expect(githubPullSource("o/r", 1)).toEqual({ kind: "github", external_ref: "gh:o/r#1" });
    // what the database's CHECK accepts (0027)
    expect(parseRequestSource(githubPullSource("o/r", 1, null))).toEqual({ kind: "github", external_ref: "gh:o/r#1", person: null });
  });

  it("refuses a repository or a number GitHub would not have", () => {
    for (const bad of ["", "o", "/r", "o/", "o/r/x", "-o/r", "o/..", "o/.", "o o/r", "o/r#1"]) expect(() => githubPullRef(bad, 1), bad).toThrow(/not a GitHub repository/);
    for (const n of [0, -1, 1.5, Number.NaN]) expect(() => githubPullRef("o/r", n), String(n)).toThrow(/not a pull request number/);
  });

  it("parses back only what it spells", () => {
    expect(parseGithubPullRef("gh:o/r.js#418")).toEqual({ repo: "o/r.js", owner: "o", name: "r.js", number: 418 });
    for (const bad of ["gh:o/r", "gh:o/r#0", "gh:o/r#01", "linear:ABC-1", "gh:o/..#1", " gh:o/r#1"]) expect(parseGithubPullRef(bad), bad).toBeUndefined();
    expect(parseGithubRepo("o/r")).toEqual({ owner: "o", name: "r" });
  });
});

describe("the head a door checks", () => {
  it("is a full 40-character lowercase SHA — never an abbreviation a collision could be ground out for", () => {
    expect(isHeadSha("a".repeat(40))).toBe(true);
    for (const bad of ["adf440c1", "A".repeat(40), "a".repeat(39), "a".repeat(41), "g".repeat(40), 40, null, undefined]) expect(isHeadSha(bad), String(bad)).toBe(false);
  });
});

describe("what a landed review stores", () => {
  it("is §2.12's answer set: Approve is allow, Request Changes is Revise; a comment answers nothing", () => {
    expect(PR_REVIEW_EVENTS).toEqual(["approve", "request_changes", "comment"]);
    expect(PR_REVIEW_DECISION).toEqual({ approve: "allow", request_changes: "accept_with_changes", comment: null });
    for (const d of Object.values(PR_REVIEW_DECISION)) if (d !== null) expect(REQUEST_DECISIONS).toContain(d);
    // …and the table sends both of those through the PR door, never through the request row
    const shape = describeRequest("pull_request");
    expect(shape.primary?.sends).toEqual({ door: "pr_review" });
    expect(shape.revise?.sends).toEqual({ door: "pr_review" });
    expect(shape.decisions).toEqual([]);
  });
});
