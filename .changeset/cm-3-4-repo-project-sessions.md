---
"@foldedspacelabs/metistry-core": minor
"@metistry-apps/reconciler": minor
"@metistry-apps/console": patch
---

A repository maps to a project page, and the last sessions in it come back
as handles (research 2026-10-04 context-mode review, CM-3 and CM-4; ruled
2026-10-04). `Projects/<Name>.md` takes a `repos:` frontmatter — one git
remote or a list, in any clone spelling — which the reconciler reduces to one
canonical `host/path` (core's new `normalizeRepoRemote`, the Context Mode
Engine's shape) and indexes into the derived `project_repos` table, only from
a page the owner wrote. The named query `project_for_repo {remote}` answers
with the one page that claims a remote, or nothing when none or two do; no
route was added. The reconciler also reads every captured `kind: session`
note under `Inbox/` into the derived `vault_sessions` table (core's new
`parseSessionNote`: date, tool, repo, branch, turns, files, the owner's first
prompt clipped — never the agent's `## Last response`, which has no column),
and `recent_sessions {repo, days}` serves a repository's sessions back once
the knowledge fold has read them, never one an agent credential captured.
Migration `0043_project_repos_and_sessions.sql`, additive and derived in full.
