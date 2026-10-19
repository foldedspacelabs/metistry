---
"@foldedspacelabs/metistry-core": minor
"@metistry-apps/console": minor
---

The session-start briefing (X-128; ruled 2026-10-04, Context Mode Q1–Q3):
`GET /api/briefing?repo=&remote=`, an agent bearer's door. The console
assembles it with no model from named queries alone — the owner's project
page for the repository (X-130), the open tasks in the project, the evening
folds naming it and the owner's recent sessions there (X-131) — under the
caller's grant: a `none` grant gets an empty briefing, `index` gets titles
only, `areas` gets content under its areas and nothing outside them. The
owner's own text appears as text; anything the assistant wrote appears as a
handle (path, title, date, sha256). Every string is sanitized, the block is
labelled reference and addresses nobody, the owner's budget
(`METISTRY_BRIEFING_TOKENS`, default 1,200) bounds it, and one `runs` row
per briefing carries the handles and the hash of what was sent. On by
default for every agent with a read grant; `briefing: false` in an agent's
grants opts it out. Core gains `assembleBriefing` and the `console_briefing`
door; the seed query `briefing_page_handles` is new and route-only.
