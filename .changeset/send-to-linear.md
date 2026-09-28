---
"@foldedspacelabs/metistry-core": minor
"@foldedspacelabs/metistry-connections": minor
"@metistry-apps/console": minor
---

**Send to Linear: a task becomes an issue (T4-25).** Two owner doors, one service each. `POST /api/trackers/:connection/issues {task_key, title?, team?, path?}` reads the task's line in its note and files one Linear issue through the connection the Linear sync reads — only while its provider declares `create` (the `linear` type now does), with the key filled at the egress door for `api.linear.app` only. It is idempotent by task key with no state of its own: `createLinearIssue` (connections) creates the issue under an id derived from the connection, the note and the key (`trackerIssueId`), looks that id up first, and looks it up again when a create fails — so a second press, a race or a lost answer answers the first issue (`200`, `created: false`). One fixed mutation (id, team, title); the sync's read door still refuses every mutation. `POST /api/vault-tasks/:task_key/link {ref, seen_text}` writes the ref on the line through core's new `setTaskRef` — one `linear:`/`gh:` ref at the end of the trailing run, proven by re-parse — as `user` with the read's hash, `409 stale` when the text changed or the line already carries a ref of that scheme, `Idempotency-Key` honoured. An opened connection (`SyncHttp`) now carries its provider's `capabilities`.
