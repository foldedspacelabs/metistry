// A git remote reduced to one identity (CM-3). The SQL twin of this function
// lives in seed/queries/project_for_repo.yaml and is held to these same
// fixtures by apps/console/test/seed-queries.test.ts — edit the two together.
import { describe, expect, it } from "vitest";
import { normalizeRepoRemote, REPO_REMOTE_MAX } from "../src/repo-remote.js";

/** Raw spelling → canonical shape. Exported for the SQL parity test, which stores the right side and looks the left side up. */
export const REMOTE_FIXTURES: [raw: string, canonical: string][] = [
  ["git@github.com:foldedspacelabs/metistry.git", "github.com/foldedspacelabs/metistry"],
  ["git@github.com:foldedspacelabs/metistry", "github.com/foldedspacelabs/metistry"],
  ["https://github.com/foldedspacelabs/metistry.git", "github.com/foldedspacelabs/metistry"],
  ["https://github.com/foldedspacelabs/metistry/", "github.com/foldedspacelabs/metistry"],
  ["  https://GitHub.com/foldedspacelabs/metistry  ", "github.com/foldedspacelabs/metistry"],
  ["https://user:token@github.com/foldedspacelabs/metistry.git", "github.com/foldedspacelabs/metistry"],
  ["ssh://git@github.com/foldedspacelabs/metistry.git", "github.com/foldedspacelabs/metistry"],
  ["ssh://git@gitlab.example:2222/group/sub/repo.git/", "gitlab.example:2222/group/sub/repo"],
  ["git://Example.org/a//b.git", "example.org/a/b"], // doubled slashes inside the path collapse
  ["github.com/foldedspacelabs/metistry", "github.com/foldedspacelabs/metistry"], // already canonical
  ["git@github.com:Org/Repo.GIT", "github.com/Org/Repo"], // host lowercased, path as written
];

describe("normalizeRepoRemote", () => {
  it("folds every clone spelling of one repository to the Engine's host/path shape", () => {
    for (const [raw, canonical] of REMOTE_FIXTURES) expect(normalizeRepoRemote(raw), raw).toBe(canonical);
  });

  it("lowercases the host and keeps the path's case — a path is case-sensitive on some hosts", () => {
    expect(normalizeRepoRemote("https://GitHub.COM/Folded/Metistry")).toBe("github.com/Folded/Metistry");
    expect(normalizeRepoRemote("https://GitHub.COM/Folded/Metistry")).not.toBe(normalizeRepoRemote("https://github.com/folded/metistry"));
  });

  it("is idempotent — a canonical value reduces to itself", () => {
    for (const [, canonical] of REMOTE_FIXTURES) expect(normalizeRepoRemote(canonical)).toBe(canonical);
  });

  it("refuses what is not plainly a remote, never repairs it", () => {
    for (const bad of [
      "",
      "   ",
      "github.com", // no path
      "github.com/", // no path
      "/foldedspacelabs/metistry", // no host
      "https://", // nothing
      "https://github.com", // no path
      "git@github.com:", // no path
      "https://github.com/a b/c", // whitespace inside
      "https://github.com/a\tb/c",
      "https://github.com/a\u0000b/c",
      "https://github.com//a/b", // nothing between host and path is no host/path
      `https://github.com/${"a".repeat(REPO_REMOTE_MAX)}/b`, // over the ceiling, refused rather than cut
    ]) {
      expect(normalizeRepoRemote(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(normalizeRepoRemote(42)).toBeNull();
    expect(normalizeRepoRemote(null)).toBeNull();
    expect(normalizeRepoRemote(["git@github.com:a/b"])).toBeNull();
    expect(normalizeRepoRemote({ url: "git@github.com:a/b" })).toBeNull();
  });
});
