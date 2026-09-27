---
"@foldedspacelabs/metistry-tasks": minor
"@foldedspacelabs/metistry-mcp-brain": minor
"@foldedspacelabs/metistry-core": patch
"@foldedspacelabs/metistry-cli": minor
"@metistry-apps/console": minor
"@metistry-apps/macos": minor
---

A work row says what it is about (T1-1, C85). Migration `0026_work_description.sql` adds `work.description` (nullable text, durable). `TasksService.create` takes `description` and `update` takes it on the board arm, capped at `DESCRIPTION_MAX` (2,000 characters); blank is stored as none, and `Task.description` is `null` when nobody wrote one. `tasks_create` accepts it. `tasks_update` has no `description` key, so an agent sets a description at create and never edits it. The owner edits it with `PATCH /api/tasks/:id {"description": …}`, without a claim; `null` or blank clears it, and it cannot ride with a holder status. Every task route's `task`, the `board` query's rows and MetistryKit's `BoardCard` carry it; `TaskPatch` gains `description` and `TaskPatch.describing(_:)`.
