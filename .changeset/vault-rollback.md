---
"@foldedspacelabs/metistry-core": minor
"@foldedspacelabs/metistry-cli": minor
"@metistry-apps/console": minor
"@metistry-apps/reconciler": minor
---

**Roll back (T10-6): `metistry vault rollback`, `POST /api/vault/rollback` and the
reconciler's `POST /vault/revert`.** History is preserved, always: a rollback is ONE
new commit, made as `user`, that undoes a commit (`git revert`), puts every path back
as it was at a moment (`--to <date>`), or puts one file back (`--file`, before its
last change or `--to` a moment) — computed off the working tree with `merge-tree`
and a scratch index, applied by `merge --ff-only`, never a reset or a force. Undo is
rolling back that commit. A re-walk and the push policy follow.

Every rollback waits for Approve in Needs You. The route (F-1's frozen row, now
served; reach `local`, so a passkey session is `403 local_only`) asks the reconciler
for a preview and raises one request carrying it — the commits it undoes, the files
it puts back; Approve runs the revert pinned to the previewed history and held to
the previewed change set (`409 stale` otherwise). The reconciler refuses the revert
for any principal but `user`, from either bearer. Configuration — every
`.metistry/` path, `CLAUDE.md`, `README.md` — is left as it is and named
(`skipped_config`) unless `include_config`, which a real revert admits only from the
owner-class bearer: `metistry vault rollback --include-config` raises the request,
waits for Approve and makes the change itself (`--request <id>` resumes the wait).
`POST /api/proposals/:id` answers a rollback with `rolled_back`; its decision SELECT
now carries `source` (additive, as T10-5's). `Git` takes an `indexFile` option (a
scratch `GIT_INDEX_FILE`), and the committer a `holdHistory` hold.
