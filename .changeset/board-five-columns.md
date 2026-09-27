---
"@foldedspacelabs/metistry-cli": minor
"@metistry-apps/console": minor
---

The board has five columns (T1-2). `board.yaml`'s `column` is `backlog`,
`assigned`, `in_progress`, `blocked` or `done`, and each label is the word its
value says: Assigned (no longer "Addressed to") and Blocked. **`needs_you` is
now `blocked`** and the `reported` column is gone. A Done card whose crew
reported back carries `reported: true` instead. Each card also gains
`thread_count`, the message count of its room, and `blocked_by`,
`blocked_by_task` and `blocked_by_task_open`, the human todo it waits on,
ported from `day_work`. `board_projects` counts the same five columns.
`board` is now `expose: route`, because `blocked_by_task` is a line of the
owner's own notes. The owner still reads it at `GET /api/q/board`. An agent's
`queries_run` and the capture owner token get the unknown-query answer.
