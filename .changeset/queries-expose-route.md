---
"@foldedspacelabs/metistry-queries": patch
"@metistry-apps/console": patch
---

**One endpoint per necessary operation: the generic door closes over
route-backed queries, and the page list's scope comes from the credential.**
`GET /api/knowledge/pages` filters every row through `canSee` — and
`GET /api/q/knowledge_pages` served the same rows with no filter at all, to
anyone who could reach the generic door. That included the capture owner
token, which is a `403` on `/api/knowledge/*` and has always been admitted on
`/api/q/<name>`: a credential that may not use the scoped route could read the
whole unscoped vault index by name, from any address. A filter with a second
way in is not a filter.

**The close is a manifest field, not a list in a server** (invariant 5).
`packages/queries` gains one optional key on a query manifest — `expose:
generic | route`, defaulting to `generic`, so every query written before this
means exactly what it meant — and `QueryStore.exposure(name)` reads it back.
`knowledge_pages.yaml` declares `expose: route`; `GET /api/q/<name>` asks the
store and refuses anything that is not `generic` with the **unknown-query
refusal, byte for byte**: same code, same status, same absent message, so the
door is not an oracle for which route-only queries a build has. An unknown
value in the field is a load-time `invalid_spec`, never a silent fall back to
the permissive default. The dedicated route still runs the query through the
same `QueryStore` — the door closed, not the read path.

**The scope is now derived from the principal.** The `knowledgeRoutes` call
site passed the constant `OWNER_SCOPE`; it passes `knowledgeScopeOf(auth)` —
session / local owner to the whole vault, a principal carrying grants to
`grantedScope`, anything else to nothing. `grantedScope` reproduces
`mcp-brain`'s `knowledgeScope(principal).canRead` (`tier === "areas" &&
underAreas(path, areas)`, against that package's own `underAreas`) rather than
renaming its fields: that shape's `prefixes` is `null` for tiers `none` and
`index`, meaning "no restriction on the TITLES those tiers browse", and `null`
here means every vault path's CONTENT — the rename would have handed the two
tiers that may not read a page the owner's own scope. Agent bearers keep their
uniform `403` on `/api/knowledge/*` and reach knowledge on `/mcp`, so the
grant path is exercised by tests today; it is real code so that the filter a
narrower console principal needs is not invented at a call site later.
