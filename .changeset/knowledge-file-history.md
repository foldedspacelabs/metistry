---
"@foldedspacelabs/metistry-core": minor
"@metistry-apps/console": minor
"@metistry-apps/reconciler": minor
---

**File history (T10-4): `GET /api/knowledge/history`, `GET /api/knowledge/version`,
and the reconciler's `GET /vault/show`.** F-1's two frozen rows are served. History
is a note's commits, newest first, followed across renames — each naming the file
as it was called then, what the commit did to it, and the committer's
`Brain-Source:`/`Metistry-Run:`/`Metistry-Turn:` trailers (T10-1) as provenance.
Version is the note's bytes at one commit, from the bridge's new `GET /vault/show`
(`git cat-file blob`, base64 on the bridge). Both are the owner's alone and notes
only: a protected or non-vault path is refused at the console and again at the
bridge, for either bearer, and a `sha` that is not 7–64 hex characters is refused
at both before it can reach git's argv; a commit not on the vault's branch is
`404`. `GET /vault/log` gains the trailers on every entry and, with a path,
`path` and `change` — additive. Both fixtures are re-recorded from their contract
shape (a superset of it).
