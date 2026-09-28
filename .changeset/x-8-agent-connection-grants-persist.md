---
"@metistry-apps/console": patch
---

**An agent's connection grant persists (X-8, ruling 5).** `validateGrants` and
`coerceGrants` used to silently drop a `connections` field on an agent's
grant — the connection names a credential is lent through `/mcp`'s lazy pair
(`connections_list`, `connections_call`, T4-8b) — so a connection the owner
lent through `PUT /api/agents/:id/grants` never actually reached the
credential's principal: `authenticateAgent` handed mcp-brain a grant with no
`connections` key no matter what was written. `connections` is now a third
grant axis, exactly like `queries`: shape-validated on write, kept on read,
carried untouched across an access-request approval (`widenedGrants`) and
across the assistant's own start-time grant merge (`mergeGrantOverrides`), and
dropped only by a write that omits it (a `PUT` replaces the whole grant). A
crew still needs both its manifest's `uses: [connections]` and this grant —
neither alone reaches anything (core's `mayToolset` + `mayConnection`,
unchanged).
