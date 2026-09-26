---
"@foldedspacelabs/metistry-core": minor
"@metistry-apps/console": minor
---

The Tick door: `POST /api/vault-tasks/:task_key/check {checked, seen_text, path?}` writes exactly `[x]` and `done <date>` on one line of the owner's note through the vault bridge as `user`, with the note's hash — and Undo (`checked: false`) is the same door, the reverse. The line is found in the note by the reconciler's own key, judged against the text the client rendered (`409 stale` with the line as it stands), and refused before anything is read when its note is not a knowledge note (`.metistry/`, a dot-directory, `Artifacts/`). `Idempotency-Key` replays the first answer. Core gains `setTaskChecked` (the one edit, proved by re-parsing its own output), `taskLinesOf` / `locateTaskLine` (the walk's keying, held to `extractTasks` by a test), `replaceLine`, `taskHashKey` and `TASK_KEY_RE`; the seed gains the `vault_task_by_key` named query (`expose: route`).
