---
"@foldedspacelabs/metistry-mcp-brain": minor
"@foldedspacelabs/metistry-core": minor
---

One vocabulary everywhere. Eight nouns (knowledge, capture, request, task,
artifact, project, agent, activity) and one verb set per object, in the UI, the
notifications, the briefs and the tool names. Eleven brain tools were renamed —
`report` → `requests_create`, `tasks_list_ready` + `tasks_mine` → `tasks_list
{filter}`, `tasks_heartbeat` → `tasks_renew`, `artifact_*` → `artifacts_*`,
`crew_dispatch` → `agents_delegate` — and the old spellings keep working for one
release (resolved at call time, recorded in `runs.meta.alias`, not listed by
`tools/list`). In the console, Needs You now reads Approve / Revise / Decline
and project mode reads Auto / Supervised. `docs/product/glossary.md` is the one
page that holds the vocabulary.
