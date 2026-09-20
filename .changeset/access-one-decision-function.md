---
"@foldedspacelabs/metistry-core": minor
"@foldedspacelabs/metistry-mcp-brain": patch
"@metistry-apps/console": patch
---

**One decision function.** P0 and P1 of
`docs/research/2026-09-19-grants-and-access-simplified.md` §4, commissioned
by the owner's "can we simplify the grant/access controls surface and make it
more consistent?" and approved 2026-09-20. **No behaviour change**, held by a
golden test rather than by care: every refusal's `(code, message)` is asserted
byte-identical to `origin/main`.

**P0 — the move.** `canSeeUnder`, `underAreas`, `validKnowledgePath`,
`areaOf`, `SCOPE_REQUIRED` and `scopeRequired` leave
`packages/mcp-brain/src/knowledge.ts`; `canSee`, `grantedScope`,
`OWNER_SCOPE`, `NO_SCOPE`, `filterHits` and `filterPages` leave
`apps/console/src/knowledge-routes.ts`. Both now live in
`packages/core/src/access.ts` and both files re-export them — mcp-brain's with
a `@deprecated` note, for one release. The console's authorization rules were
being served out of one BRIDGE's package (§2.9); a second bridge would have
had to import a sibling bridge to get them.

**P1 — `may(principal, verb, resource): Decision`.** Every door in §1.4 asks
it: `/mcp`'s knowledge, queries, tasks, action and crew tools; the console's
agent 403, its management gate, `GET /api/q/<name>` and `/api/knowledge/*`.
Each check that used to live in a handler is now a case in one table that
returns the same code and the same sentence it returned before — so the file
reads as a catalogue of the five dialects §2.5 found, which is the point:
unifying them is one reviewable diff here instead of fourteen strings in
eleven files.

A refusal carries a closed `reason` (`scope_required`, `tier_required`,
`queries_required`, `role_required`, `autonomy_required`,
`membership_required`, `not_member`, plus `not_exposed` for the route-only
query and `not_knowledge` for a path that is not vault content) and, where a
remedy already existed in prose, a machine-readable `needs`: the area a
`request_access` would name, or the autonomy entry the user would raise. The
wire envelope is unchanged — `error.code` and `expose` are exactly what they
were (invariant 8).

**Storage does not move**: registry rows for external agents, the environment
for the instance's own assistant, the manifest for a crew. `may()` decides and
never writes; every widening still goes through the console's one grants door
and its one audit row (invariant 2), and the `Role × Verb × Resource` table is
CODE in `core`, never loadable from a file (invariant 10).

**Two tests ship with it.** `packages/core/test/access.golden.json` is the
committed catalogue of every `(code, reason, message, needs)` a door can
answer with, each entry carrying the wording it had at `origin/main` and the
`file:line` it was read off. `packages/mcp-brain/test/may-surface.test.ts`
walks all 27 tools × the five roles asserting every pair is decided, that no
tool is usable by nobody, and — by a grep over the package's source — that
`kind ===` / `tier ===` appears in exactly one file, the credential →
principal mapping.

`role: "crew"` exists and nothing produces it yet: `authenticateAgent` still
collapses a crew's row to `external`, which is P2's job. The owner is still
decided by the rules rather than short-circuited (P4). Neither is changed
here.
