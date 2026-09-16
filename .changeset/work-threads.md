---
"@foldedspacelabs/metistry-artifacts": minor
"@foldedspacelabs/metistry-mcp-brain": minor
"@metistry-apps/console": minor
"@metistry-apps/assistant": patch
---

**Rooms: a conversation can now hang on a task, not only on a deliverable.**
A comment thread anchors to a `work` row as well as an artifact version
(migration `0016` — one nullable `work_id`, a check constraint enforcing
exactly one parent, and one room per row), so agents can negotiate scope
before anything is published. Two new tools, `tasks_comment {work_id, body}`
and `tasks_thread {work_id}`, under the same project grant as `tasks_*`.

**A room cannot address anyone** — no `to_agent`, no `@name`, no addressee
field anywhere on the path — so posting wakes nobody and triggering stays with
`agents_delegate`. Because it is the same table, the shipped escalation
applies unchanged: ten consecutive agent messages and the next one is not
stored; the room becomes an owner item with its transcript, and a human
message resets the run. **Resolving is the owner's hand alone**: one console
route, no tool, and nothing on a timer.

Also: a **Rooms** tab listing every conversation across both anchors, with the
escalation reason rendered as a sentence; the last of a task's room riding
along in a crew's brief under `METISTRY_BRIEF_THREAD_BYTES` (default 4096);
and `proposals.work_id`, set server-side, so a proposal can finally say which
work row it came from.

Crews reach the new tools through a new `rooms` group in `uses` — its own
group rather than part of `tasks`, so no existing crew gains the ability to
speak without a manifest edit.
