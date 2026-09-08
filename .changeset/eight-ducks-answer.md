---
"@foldedspacelabs/metistry-core": minor
"@foldedspacelabs/metistry-mcp-brain": minor
"@foldedspacelabs/metistry-queries": minor
"@metistry-apps/console": minor
"@metistry-apps/assistant": minor
---

`queries_list` / `queries_run` on mcp-brain — invariant 3's one read path
(named, parameterized queries, never free-form SQL) out to agents. An
agent lists what's available (name, description, param types/defaults)
and runs one, capped at 200 rows with truncation noted. The instance's
own assistant always has it; an external agent needs an explicit
`queries: true` grant (`PUT /api/agents/:id/grants`), a separate axis
from the knowledge tier.

Every mcp-brain tool also now takes an optional `turn_id` (≤ 64 chars,
`[A-Za-z0-9_-]`), recorded on the tool's `runs` row (`meta.turn_id`); the
`activity_feed` query surfaces it so one reply's tool calls group
together. The seed assistant prompt tells it to generate one per reply.

Crews never get `queries_list`/`queries_run` — a named query is not
filtered by a crew's scope/projects the way every other tool group is.
