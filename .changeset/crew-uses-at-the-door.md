---
"@foldedspacelabs/metistry-core": patch
"@foldedspacelabs/metistry-mcp-brain": patch
"@metistry-apps/console": patch
"@metistry-apps/assistant": patch
---

**A crew's toolset is enforced at the door.** P2 of
`docs/research/2026-09-19-grants-and-access-simplified.md` §4, approved
2026-09-20. **One behaviour change, and it is the point of the phase** — read
the next paragraph before you upgrade an install that runs crews.

**What changes for a running crew.** A crew names TOOL GROUPS in its manifest
(`uses:`), and until now that list was applied by the process that dispatched
the run: `apps/assistant/src/tools.ts` filtered `tools/list` and refused an
unlisted call with the text `"mcp__brain__tasks_comment" is not in this run's
tool list`. `/mcp` had never heard of `uses` — `AgentPrincipal` carried no
such field — so the door admitted those calls. Five of the eight groups
(`rooms`, `artifacts`, `tasks`, `capture`, `requests`) had no server-side gate
at all; the only thing holding them was a `Set.has` in another process. Now
the console resolves a crew's `uses` from the manifest it loaded, attaches it
to the principal at authentication, and the door refuses anything outside it
before the tool body runs:

```json
{ "error": { "code": "forbidden",
             "message": "tasks_comment is not in this crew's toolset — writer holds knowledge, requests (`uses:` in its manifest, a protected path in the user's hand: docs/ops/crews.md). Report what you needed instead of retrying." } }
```

One `runs` row on the crew's own id, the uniform envelope, `reason:
not_in_uses` in `may()`'s decision. The runner's client-side list stays as
**defence in depth** — the model is still not offered a tool it cannot use —
but it is no longer the control, and the comment at that filter says so.
CLAUDE.md's rule over all the others is "enforce at the tool, never by
prompting"; a filter in the caller is neither.

**`crew` is a real role.** `agents.kind` has stored three values since Phase 5
(`crews.ts` writes `'crew'`) while the console collapsed anything not
`internal` to `external` at authentication, so a crew reached `/mcp`
indistinguishable from a foreign agent (§2.3). `authenticateAgent` now passes
the row's own kind through, `principalOf` maps it to the `crew` role that
`may()` has had a table for since P1, and three things follow: the toolset
gate above, a `crew` that can no longer reach `request_access` at the door
(it is a never-tool, so it is in no group), and a `source` on the principal
that is the crew's manifest rather than a fourth prose reconstruction of
"your scope is configuration, not a grant".

**Migration `0025_agent_role.sql`** (additive; rollback note in the file): a
CHECK holding `agents.kind` to the three values it already stores, and a
nullable `grant_source` column recording which of the three places a row's
grants came from — `registry` (the owner's hand), `environment` (`.env`,
replaced at every console start), `manifest` (a crew's `scope:`). NULL on
existing rows and read as `registry`. Nothing decides on it: `may()` never
reads it.

**Nothing else moved.** Every other refusal is byte-identical — the golden
catalogue (`packages/core/test/access.golden.json`) asserts it entry by entry,
and the one changed entry carries both what the caller used to say and what
the door says now, so the behaviour change is a reviewable diff rather than a
sentence in a PR. Misuse tests ship with it (invariant 8): a crew bearer
refused a non-`uses` tool at `/mcp` with no client filter in the loop, a crew
whose manifest cannot be read holding NO tools rather than all of them, an
external agent unable to become a crew through a body or a header, and the
CHECK refusing a fourth kind.
