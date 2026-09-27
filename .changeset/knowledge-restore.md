---
"@foldedspacelabs/metistry-core": minor
"@metistry-apps/console": minor
---

**Restore a file (T10-5): `POST /api/knowledge/restore {path, sha, seen_sha}`.** F-1's
frozen row is served. The door never writes: it raises one Needs You request — an
improvement drawn as a before and after (the note now, the note at `sha`) — and
answers `202` with the request as `GET /api/proposals` serves it, so Knowledge can
show it inline. Only Approve restores: the version's bytes, re-read from the
bridge's `GET /vault/show` and checked against what the request showed, are written
back as `user` — a new commit, *Restore <path> to <date>* — compare-and-swap on the
file as the request showed it. `seen_sha` is the file's content hash as rendered
(`""` for a note that is gone); a file that moved is `409 stale` at the raise and
again at Approve (nothing written, the request still waiting). Notes only — a
protected or non-vault path is refused for the owner too — and the owner's alone:
every other principal is refused in the route, and Approve restores only a request
this console raised whose `source` (`restore:<path>@<sha>`, one per note and
commit) names the same path and commit; a restore-shaped payload on any other row
restores nothing and is never read as a prompt improvement. `POST /api/proposals/:id`
answers with `restored`, and its decision SELECT now carries `source` (additive).
