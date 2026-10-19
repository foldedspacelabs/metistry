// Raw clone spellings → the one canonical remote (CM-3). The TypeScript
// (`normalizeRepoRemote`, packages/core/test/repo-remote.test.ts) and the
// SQL twin in seed/queries/project_for_repo.yaml (apps/console/test/
// seed-queries.test.ts, which stores the right side and looks the left side
// up) are both held to THIS list, so a spelling added here is tested on both
// sides at once. A plain module, not a test file, so a suite in another
// package can import it without re-registering this one's tests.
export const REMOTE_FIXTURES: [raw: string, canonical: string][] = [
  ["git@github.com:foldedspacelabs/metistry.git", "github.com/foldedspacelabs/metistry"],
  ["git@github.com:foldedspacelabs/metistry", "github.com/foldedspacelabs/metistry"],
  ["Git@GitHub.com:foldedspacelabs/metistry.git", "github.com/foldedspacelabs/metistry"], // an upper-case user and host in the SSH short form
  ["https://github.com/foldedspacelabs/metistry.git", "github.com/foldedspacelabs/metistry"],
  ["https://github.com/foldedspacelabs/metistry/", "github.com/foldedspacelabs/metistry"],
  ["  https://GitHub.com/foldedspacelabs/metistry  ", "github.com/foldedspacelabs/metistry"],
  ["https://user:token@github.com/foldedspacelabs/metistry.git", "github.com/foldedspacelabs/metistry"],
  ["ssh://git@github.com/foldedspacelabs/metistry.git", "github.com/foldedspacelabs/metistry"],
  ["SSH://Git@GitHub.com/foldedspacelabs/metistry.GIT", "github.com/foldedspacelabs/metistry"], // scheme, user, host and `.git` are all case-insensitive
  ["github.com/foldedspacelabs/metistry", "github.com/foldedspacelabs/metistry"], // already canonical
  ["ssh://git@gitlab.example:2222/group/sub/repo.git/", "gitlab.example:2222/group/sub/repo"], // a port survives
  ["git://Example.org/a//b.git", "example.org/a/b"], // doubled slashes inside the path collapse
  ["git@github.com:Org/Repo.GIT", "github.com/Org/Repo"], // host lowercased, path as written
];
