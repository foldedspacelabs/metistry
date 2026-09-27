---
"@foldedspacelabs/metistry-core": minor
"@metistry-apps/console": minor
---

**Project grants table (T1-13).** `PUT /api/projects/:slug` takes a `grants`
field — `{tier, areas, queries?}`, migration `0032_project_grants.sql` — a
project's own read grant, validated by the identical `validateGrants` an
agent's own `PUT /api/agents/:id/grants` already uses (external rules: the
bare vault is refused, and every area must be vault CONTENT — `.metistry/`,
`Artifacts/…` and a traversal are refused). Nothing reads the column yet: a
member's effective reach unioning its own grants with its projects', "via
project" provenance, is T4-7.
