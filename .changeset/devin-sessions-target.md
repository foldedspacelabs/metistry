---
"@metistry-apps/console": minor
"@metistry-apps/collectors": minor
---

**`targets/devin-sessions`** — dispatch a brief to a Devin session and get the
answer back as a report to triage. The first `transport: http` compute target,
and the first whose *content* returns rather than only its status.

`POST /api/tasks/:id/dispatch` (passkey session only) gains `purpose` and
`max_acu`. `purpose: "knowledge_research"` is the new brief kind: a question
the assistant cannot answer goes out with a preamble that forbids touching any
repository, and the whole output is a structured answer —
`{answer, sources[], confidence, open_questions[]}`, sent as a Draft-7
`structured_output_schema` so Devin's own `structured_output_required` will not
let the session end without filling it in. The session id becomes the work
row's `external_ref` (`devin:<id>`), and `collectors/devin-sessions` polls
every five minutes: a finished session becomes a `report` proposal
(`source_agent devin`, `trust external`) carrying the answer plus provenance —
session URL, status, confidence, ACUs used against the cap — and closes the
work row; an errored, suspended, timed-out or contract-breaking session files a
report saying exactly that and leaves the row `blocked`. Accepting the proposal
in Needs You is what puts it in the vault, through the existing fold path.
Ruled a collector rather than an in-process timer: a poll is a scheduled pull
with a cost, so it should have a manifest, a `runs` row and a `check()`.

Safe to point at a third party: the shipped `data_policy` has an **empty**
`allow` list, so the product default lets a brief cite nothing from the vault —
widen it per instance in a `METISTRY_TARGETS_DIRS` overlay — and `deny_sources`
is `[comms, devin]`, so Devin's own knowledge is not silently re-exported to
Devin. The budget is Devin's per-session `max_acu_limit` (manifest default 5,
overridable per dispatch), written to the dispatch `runs` row and reconciled
with the ACUs Devin reports. Dispatch stays the owner's action: the route is
the `user` principal only and `agents_delegate` reaches local crews and nothing
else, so the rule that a non-Claude agent is never pushed to by name holds
because there is no tool to break it with.

Configure with `METISTRY_DEVIN_API_KEY` (the same key `devin-knowledge` uses)
plus `METISTRY_DEVIN_ORG_ID`, which is **required** here — a session is a
spend, and the organization it is charged to is not something to infer.
Without either, the target's `check()` is `absent` with the remediation and the
collector degrades absent. `docs/ops/devin.md` ("Dispatch out") has the full
shape, including one thing now verified negative: Devin's v3 API supports **no**
`Idempotency-Key` header, so the guard is the work row's unique `external_ref`.
