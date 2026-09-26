---
"@foldedspacelabs/metistry-core": minor
"@metistry-apps/console": minor
"@metistry-apps/reconciler": minor
---

The Defer door: `POST /api/vault-tasks/:task_key/schedule {do | someday, seen_text, path?}` writes one `do <date>` or one `someday` on one line of the owner's note through the vault bridge as `user`, with the note's hash — the English spelling `formatTaskLine` emits, never a Tasks-plugin glyph (K6). It is the Tick door's discipline throughout: the line found in the note by the walk's own key, `409 stale` with the line as it stands when the text moved or the line was ticked, dropped or already deferred so, refusals before any read for `.metistry/`, dot-directories and `Artifacts/`, and `Idempotency-Key` replays. A line whose day is a `⏳` or a Dataview `scheduled::` is refused rather than given a second day. Core gains `setTaskScheduled` (proved by re-parsing its own output), the `someday` token in the task grammar (`ParsedTaskLine.someday`, `SOMEDAY_TOKEN`) and a `someday` flag in the filter vocabulary; migration `0036_vault_tasks_someday.sql` adds the derived `vault_tasks.someday` column, which the reconciler's walk writes and `vault_tasks_query` filters and flags on.
