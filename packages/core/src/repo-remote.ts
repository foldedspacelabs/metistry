// A git remote, normalised to one identity (research 2026-10-04-context-mode-review
// §6 CM-3). A repository is cloned under many spellings —
// `git@github.com:org/repo.git`, `https://github.com/org/repo`,
// `ssh://git@github.com/org/repo/` — and the owner's project page names it in
// whichever one they copied. This is the one shape both sides are reduced to
// before they are compared: the reconciler stores it (`project_repos`), and
// `seed/queries/project_for_repo.yaml` reduces its `:remote` param to the
// same shape in SQL. The two implementations are held together by
// `apps/console/test/seed-queries.test.ts`, which looks every fixture below
// up through the query after storing it through this function.
//
// The shape is the Context Mode Engine's (`hooks/platform-bridge.mjs`
// `normalizeRemoteUrl`, read 2026-10-04): `host/path`, the scheme and any
// `user@` credential dropped, an SSH `user@host:path` folded to `host/path`,
// a trailing `.git` and trailing slashes removed, and the HOST lowercased
// while the path keeps its case — a path is case-sensitive on some hosts and
// a key that lowercased it would merge repositories a host keeps apart. Two
// guards the Engine does not have: a value that is not plainly a remote
// (whitespace or a control character inside it, no host, no path, longer
// than `REPO_REMOTE_MAX`) is no remote at all, never repaired — the same
// refusal `people_emails` makes of an address it would have to guess at.

/** Longer than any remote a host hands out; a longer value is refused, never cut to fit. */
export const REPO_REMOTE_MAX = 512; // limit: fixed — a sanity bound on one frontmatter scalar, not a policy anyone tunes

/** `user@host:path` — the SSH short form. The host runs to the first `:`; a `/` in it would make this a scheme URL instead. */
const SSH_SHORT_RE = /^[a-z0-9_-]+@([^:/]+):\/*(.+)$/i;
/** `scheme://[user[:pass]@]` — dropped whole; what follows is `host/path`. */
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?/i;

/**
 * One remote in its canonical shape, or null when the value is not plainly a
 * remote. Pure: no filesystem, no network, no guess at what a user meant.
 *
 *   git@github.com:Org/Repo.git      → github.com/Org/Repo
 *   https://GitHub.com/Org/Repo/     → github.com/Org/Repo
 *   ssh://git@gitlab.example:2222/g/r → gitlab.example:2222/g/r
 *   "Org/Repo", "", a URL with a space → null
 */
export function normalizeRepoRemote(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let u = value.trim();
  if (u === "" || u.length > REPO_REMOTE_MAX) return null;
  if (/[\u0000-\u001f\u007f\s]/.test(u)) return null; // a remote has no whitespace or control characters inside it
  const ssh = SSH_SHORT_RE.exec(u);
  u = ssh ? `${ssh[1]}/${ssh[2]}` : u.replace(SCHEME_RE, "");
  u = u.replace(/\.git\/?$/i, "").replace(/\/+$/, "");
  const slash = u.indexOf("/");
  if (slash <= 0) return null; // no host, or no path: `github.com` alone names no repository
  const host = u.slice(0, slash).toLowerCase();
  const path = u.slice(slash + 1).replace(/\/{2,}/g, "/");
  if (path === "" || path.startsWith("/")) return null;
  return `${host}/${path}`;
}
