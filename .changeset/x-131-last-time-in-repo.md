---
"@foldedspacelabs/metistry-core": minor
"@metistry-apps/console": patch
---

Last time in this repository, for one caller (X-131; ruled 2026-10-04,
Context Mode Q3). Core gains `recentSessionsForCaller`, a small function over
the named queries `project_for_repo` and `recent_sessions` that the
session-start briefing can call: a session the knowledge fold has read goes to
any agent its grant allows, one still waiting for the fold only to an agent in
the same project as the repository, and every row is copied through a fixed
list of fields so no agent-written text is returned. `recent_sessions` takes an
`unfolded` param (default false — the safe arm) and each row says whether it is
`folded`.
